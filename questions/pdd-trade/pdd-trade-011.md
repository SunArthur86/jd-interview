---
id: pdd-trade-011
difficulty: L2
category: pdd-trade
subcategory: Spring Cloud
tags:
- 拼多多
- 交易
- Feign
- 服务调用
- 负载均衡
feynman:
  essence: Feign 把"远程 HTTP 调用"伪装成"本地方法调用"，底层封装动态代理+负载均衡+熔断+重试，让交易链路（订单→库存→支付）开发像单体。
  analogy: Feign 像快递——你只管把包裹（参数）给快递员（代理），不用关心走哪条路、用什么车。
  first_principle: 远程调用本质是序列化+网络+反序列化，复杂度高；包装成本地调用降低使用成本。
  key_points:
  - 动态代理拦截 + LoadBalancer 选实例 + HTTP 调用
  - 集成 Sentinel（熔断）/ Retryer（重试）
  - RequestInterceptor 传上下文（traceId）
  - fallback 降级
first_principle:
  problem: 微服务间调用如何像本地方法一样简单，底层治理（熔断/重试/负载）透明？
  axioms:
  - 业务不应感知分布式细节
  - 网络不可靠
  - 需要统一治理
  rebuild: 动态代理封装"寻址→负载→调用→失败处理"，业务像调本地。
follow_up:
- Feign 怎么传 TraceId？——RequestInterceptor 塞 header，线程池要装饰
- Feign 超时怎么配？——connectTimeout + readTimeout，按服务细分
- Feign 和 Dubbo 区别？——Feign HTTP 通用；Dubbo TCP 高性能
memory_points:
- Feign = 动态代理 + HTTP + LoadBalancer + Sentinel
- RequestInterceptor 传 traceId
- fallback 降级、Retryer 重试
- Feign 通用 / Dubbo 高性能
---

# 【拼多多交易】Feign 怎么用？服务间调用怎么治理？

> JD 依据："熟悉 RPC/MQ"。

## 一、Feign 使用

```java
@FeignClient(name = "inventory-service", fallback = InventoryFallback.class)
public interface InventoryClient {
    @PostMapping("/deduct")
    Result deduct(@RequestBody DeductReq req);
}

@Autowired InventoryClient client;
Result r = client.deduct(req);  // 像本地方法
```

## 二、底层流程

```
调用 client.deduct()
   ↓ 动态代理拦截
   ↓ 解析注解构造 HTTP 请求
   ↓ LoadBalancer 选实例
   ↓ Sentinel 熔断检查
   ↓ HTTP 调用
   ↓ 失败 → 重试 / 熔断 / fallback
   ↓ 反序列化
```

## 三、上下文传递（TraceId）

```java
@Component
public class TraceInterceptor implements RequestInterceptor {
    public void apply(RequestTemplate t) {
        t.header("X-TraceId", MDC.get("traceId"));
        t.header("X-UID", RequestContext.getUid());
    }
}
```

线程池需装饰（否则 traceId 丢失）。

## 四、治理配置

```yaml
feign:
  sentinel: { enabled: true }
  client:
    config:
      default: { connect-timeout: 1000, read-timeout: 2000 }
      inventory-service: { read-timeout: 50 }  # 严格下游
```

## 五、降级

```java
@Component
public class InventoryFallback implements InventoryClient {
    public Result deduct(DeductReq req) {
        return Result.degrade("库存服务不可用");  // 降级返回
    }
}
```

## 六、底层本质

Feign 是**"位置透明性"**——让远程调用像本地。但分布式八谬误提醒这是"美丽谎言"，必须配超时/重试/熔断/降级。

## 常见考点
1. **Feign 怎么集成 Sentinel**？——`feign.sentinel.enabled=true` + fallback。
2. **Feign 和 Dubbo**？——Feign HTTP 通用可跨语言；Dubbo TCP+二进制高性能。
3. **超时怎么分级**？——总超时 < 用户容忍，各下游独立超时。

## 苏格拉底式面试追问

> 这组追问不背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：Feign 把远程调用封装成"像本地方法"，但分布式八谬误说网络不可靠，这种"伪装成本地"会不会让开发者忘记网络风险？你怎么看这个矛盾？**

确实有这个风险——开发者写 `client.deduct(req)` 时可能以为是本地调用，忘了它会超时、会失败、会重试。但 Feign 的设计动机不是"骗开发者"，而是"把治理能力下沉到框架层"。正确使用 Feign 的前提是：每调用都显式配置超时/重试/熔断/降级，fallback 是必填不是可选。矛盾的解法是"封装 + 约束"——框架封装复杂性，但强制要求配置治理策略（如 Code Review 检查所有 `@FeignClient` 必须有 fallback 和超时配置）。如果团队里有人写 Feign 不配超时不写 fallback，那是规范没落地，不是 Feign 的错。本质是"透明化治理"而非"隐藏风险"。

### 第二层：证据与定位

**Q：订单服务调库存服务（Feign）突然 P99 从 50ms 飙到 5s，你怎么定位是 Feign 配置问题，还是库存服务本身慢？**

按调用链逐层看。三步：
1. 看 Feign 客户端的 metrics（`feign_client_duration`）——如果 `connect_time` 正常（<10ms）但 `read_time` 飙到 4.9s，是库存服务处理慢（HTTP 连上了但响应慢），看库存服务的 APM。
2. 如果 `connect_time` 也飙高（几百 ms），是连接池打满或实例不可达——看 LoadBalancer 选的实例是否健康、HTTP 连接池（`maxConnections`）是否耗尽（`jstack` 看是否阻塞在 `PoolEntry` 获取）。
3. 看 Sentinel 的 `circuit_breaker_state`——如果熔断器是 OPEN 状态，所有请求走 fallback，P99 飙高可能是 fallback 逻辑本身慢（如 fallback 去查 DB）。还要看是否触发了重试——`retry_count` 如果从 0 飙到 3，说明每次请求重试 3 次才成功/失败，放大了耗时。重点是区分"下游慢""连接层慢""重试放大"。

### 第三层：根因深挖

**Q：你定位到是 Feign 的重试把耗时放大了——库存服务偶发超时，Feign 重试 3 次导致 P99 飙高。根因是什么？光是把重试关掉就行吗？**

关闭重试是治标。根因是"重试策略和下游特性不匹配"：
1. 库存服务是"扣减类"写操作，重试可能导致重复扣减（虽然下游幂等，但重试本身就放大了下游压力）。写操作重试要极其谨慎——要么不重试（失败直接返回，业务层决定重试），要么只在"明确非幂等错误"（如连接超时，请求没发出去）重试，不在"读超时"（请求发出去了但响应慢，可能已经成功）重试。
2. 正确的重试配置：`Retryer` 只对 `SocketTimeoutException`/`ConnectException` 重试，不对业务异常重试；重试次数 1 次（不是 3 次）；重试间隔指数退避（避免下游刚恢复又被重试打挂）。
3. 治本要结合 Sentinel——重试和熔断配合，如果下游错误率超阈值，先熔断（快速失败）而不是重试（加重下游负担）。根因是"把重试当万能药"，实际重试只在"偶发网络抖动"场景有效，下游真故障时重试只会雪崩。

**Q：那为什么不直接把所有 Feign 调用的重试都关掉，失败就让 fallback 兜底？**

不能一刀切。读操作（如查商品详情）可以重试——偶发超时重试一次可能成功，提升可用性，且读幂等天然安全。写操作（如扣库存、扣款）重试危险——重试可能触发重复扣，必须靠下游幂等兜底，但即使幂等，重试也放大下游压力。正确策略是"按操作语义分类配置"：读操作开 1 次重试（指数退避）+ fallback；写操作默认不重试，靠业务层根据错误类型决定是否重试（如连接失败可重试，业务失败不重试）。一刀切关闭会让读操作的可用性下降（偶发超时直接失败），一刀切全开会让写操作的资损风险上升。

### 第四层：方案权衡

**Q：你的 fallback 是返回 `Result.degrade("库存服务不可用")`，但如果订单链路里库存降级了，订单可能创建成功但没扣库存（超卖），你怎么权衡"可用性"和"正确性"？**

库存降级是高危场景，不能简单返回成功。权衡方案是"按业务语义分级降级"：
1. 强依赖不可降级——库存扣减是下单的强依赖，库存服务挂了应该让下单失败（抛异常而非降级成功），宁可让用户重试也不能超卖。fallback 应该返回失败（`Result.fail`）触发订单创建回滚。
2. 弱依赖可降级——如下单后通知风控、加积分，这些可以降级（返回默认值，异步补偿），不影响主流程。
3. 区分的关键是"降级后业务是否正确"——库存降级会导致超卖（错误），积分降级只是延迟到账（可接受）。规范上要给每个 Feign 调用标注"强依赖/弱依赖"，强依赖的 fallback 必须返回失败，弱依赖的 fallback 才能返回默认值。Pdd-trade 这种交易系统，强依赖降级=资损，宁可不可用也不能错。

**Q：为什么不直接用同步重试 + 熔断，而要写 fallback 降级逻辑？熔断打开不就自动失败了？**

熔断打开后"自动失败"是抛异常，如果不写 fallback，异常会向上传播导致订单服务整体报错——用户看到的是 500 错误页。fallback 的作用是"把失败转成业务可处理的响应"——比如返回"系统繁忙请稍后"（用户友好）、或返回降级数据（如缓存的旧库存）、或触发业务补偿。熔断是"保护机制"（快速失败不拖垮系统），fallback 是"业务兜底"（失败后怎么办）。两者是配合关系：熔断决定"何时失败"，fallback 决定"失败后返回什么"。没有 fallback 的熔断只是"快速报错"，用户体验更差（瞬间全失败而非部分降级）。

### 第五层：验证与沉淀

**Q：你怎么验证 Feign 的超时和重试配置在各种网络异常下都正确，而不是"平时没事，网络抖动就乱"？**

必须做故障注入测试：
1. 注入下游延迟——用 TC（Traffic Control）或 Chaos 工具让库存服务响应延迟 3 秒（超过 readTimeout 2 秒），验证 Feign 在 2 秒后超时（不是 3 秒才返回）、超时后是否按配置重试/熔断。`timeout_count` 应该增加，`downstream_actual_rt` 应该 <2 秒。
2. 注入下游不可达——kill 库存服务实例，验证 Feign 是否快速失败（connectTimeout 内）、是否触发 fallback、LoadBalancer 是否摘除不健康实例。
3. 注入部分失败——让 50% 请求返回 500，验证 Sentinel 熔断在错误率超阈值（如 50%）时打开，打开后请求走 fallback。每个场景断言 Feign 的行为符合配置，而不是"感觉对了"。

**Q：Feign 调用的治理（超时/重试/熔断/降级）怎么沉淀成团队规范，避免每个开发者自己乱配？**

靠统一配置 + 强制规范：
1. 全局默认配置——Feign 的 `default` 配置（connectTimeout/readTimeout/Retryer/fallback）在公共 starter 里统一设定，业务侧不写就走默认（安全的基线值）。
2. 按服务分级模板——把下游服务分等级（A 级强依赖如库存、B 级弱依赖如积分），每级有标准配置模板（A 级：严格超时+不重试+失败 fallback；B 级：宽松超时+1 次重试+降级 fallback）。业务接入新下游时按模板选，不自创。
3. CI 校验——扫描所有 `@FeignClient`，检查是否有 fallback、超时是否在合理范围（如不能 >5 秒），不合规 CI 挂掉。拼多多有几千个 Feign 调用，靠规范和工具兜底，不靠每个开发者自觉。

## 结构化回答

**30 秒电梯演讲：** 微服务间调用如何像本地方法一样简单，底层治理（熔断/重试/负载）透明？简单说就是——Feign 把"远程 HTTP 调用"伪装成"本地方法调用"，底层封装动态代理+负载均衡+熔断+重试，让交易链路（订单→库存→支付）开发像单体。

**展开框架：**
1. **动态代理拦截** — 动态代理拦截 + LoadBalancer 选实例 + HTTP 调用
2. **集成 Sen** — 集成 Sentinel（熔断）/ Retryer（重试）
3. **Reques** — RequestInterceptor 传上下文（traceId）

**收尾：** 您看这块要不要再展开聊聊？

## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：Feign 怎么用？服务间调用怎么治理？ | 今天聊「Feign 怎么用？服务间调用怎么治理？」。一句话：Feign 把"远程 HTTP 调用"伪装成"本地方法调用"，底层封装动态代理+负载均衡+熔断+重试 | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：动态代理拦截 + LoadBalancer 选实例 + HTTP 调用 | 核心概念 |
| 1:00 | 能力/参数拆解表 | 要点是：集成 Sentinel（熔断）/ Retryer（重试） | 能力拆解 |
| 2:00 | 总结卡 + 下期预告 | 记住核心要点就够了。下期见。 | 收尾 |
