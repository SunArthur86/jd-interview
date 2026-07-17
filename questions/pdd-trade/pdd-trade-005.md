---
id: pdd-trade-005
difficulty: L4
category: pdd-trade
subcategory: 网关设计
tags:
- 拼多多
- 交易
- 网关
- Spring Cloud Gateway
- 限流
feynman:
  essence: 网关是统一入口，负责"路由+鉴权+限流+灰度+日志"，用 Spring Cloud Gateway 编程式配置，支撑拼多多百万 QPS 交易接入。
  analogy: 网关像大厦前台——来访者（请求）先登记（鉴权）、分流（路由）、限流（高峰排队）、记录（日志），统一入口管理。
  first_principle: 微服务拆分后需要统一入口处理横切关注点（鉴权/限流/灰度），避免每个服务重复实现。
  key_points:
  - 核心：路由+过滤器（前置/后置）+限流+熔断
  - 鉴权：JWT/Session 统一校验
  - 灰度：按 UID/版本路由（金丝雀发布）
  - 限流：Sentinel/Redis 令牌桶
first_principle:
  problem: 微服务后每个服务都需鉴权/限流/日志，如何统一？
  axioms:
  - 横切关注点重复
  - 需要统一入口
  - 配置要动态
  rebuild: 网关层统一处理（路由+鉴权+限流+灰度+日志）。
follow_up:
- 网关怎么灰度发布？——按 UID hash 路由到新版本实例（10% 流量）
- 网关挂了怎么办？——多实例 + SLB 兜底
- 网关怎么扛百万 QPS？——无状态+水平扩容+Redis 集中限流
memory_points:
- 网关：路由+鉴权+限流+灰度+日志
- 鉴权统一（JWT/Session）
- 灰度：按 UID/版本路由
- 无状态+水平扩容
---

# 【拼多多交易】网关怎么设计？怎么扛百万 QPS？

> JD 依据："接口网关"。

## 一、网关核心职责

```
请求 → 网关
   ├─ 路由（按路径转发到服务）
   ├─ 鉴权（JWT/Session 校验）
   ├─ 限流（令牌桶，保护后端）
   ├─ 灰度（金丝雀路由）
   ├─ 日志（访问日志/审计）
   └─ 熔断（保护自身）
```

## 二、Spring Cloud Gateway 配置

```yaml
spring:
  cloud:
    gateway:
      routes:
        - id: order-service
          uri: lb://order-service
          predicates: [Path=/api/order/**]
          filters:
            - name: RequestRateLimiter
              args: { redis-rate-limiter.replenishRate: 1000, burstCapacity: 2000 }
            - JwtAuth
            - GrayRelease
```

## 三、鉴权过滤器

```java
@Component
public class JwtAuthFilter implements GlobalFilter {
    public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
        String token = exchange.getRequest().getHeaders().getFirst("Authorization");
        if (!jwtUtil.verify(token)) {
            return unauthorized(exchange);
        }
        return chain.filter(exchange);
    }
}
```

## 四、灰度发布

```java
// 按 UID hash 路由到新版本（10% 流量）
public String route(String uid, String service) {
    if (Math.abs(uid.hashCode()) % 10 == 0) {
        return service + "-canary";  // 金丝雀实例
    }
    return service;  // 稳定版
}
```

## 五、限流

- 单 UID：防刷（每秒 10 次）
- 全局：保护总容量（每秒百万）
- 集群限流：Redis 集中算（避免单机偏差）

## 六、底层本质

网关本质是**"横切关注点的统一收口"**——把鉴权/限流/日志等通用功能从业务服务抽到入口层，让业务服务聚焦业务。

## 常见考点
1. **网关和服务网格区别**？——网关应用层（业务感知），服务网格基础设施层（Sidecar）。
2. **网关怎么扛高 QPS**？——无状态+水平扩容+异步非阻塞（WebFlux）。
3. **灰度怎么实现**？——按 UID/版本/header 路由到不同实例。

## 苏格拉底式面试追问

> 这组追问不背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：鉴权和限流都放在网关，为什么不放在每个业务服务里？业务服务自己校验 token 不是更安全吗？**

放在业务服务里有两个问题：一是重复——几十个服务都要写一遍 JWT 校验、Redis 查 Session、频次统计，改一次鉴权逻辑要发几十个服务，维护成本高；二是后端不可信——如果某个新服务忘了加鉴权过滤器，接口直接裸奔，安全漏洞。网关统一收口的动机是"横切关注点单一职责"——业务服务只管业务，鉴权/限流这些通用能力由网关统一实现、统一升级、统一审计。当然，敏感操作（如支付确认）业务服务内部会再校验一次（纵深防御），但入口层的统一收口是第一道防线。

### 第二层：证据与定位

**Q：网关的 P99 延迟从 5ms 飙到 200ms，你怎么定位是限流过滤器慢了，还是后端服务慢了，还是网关自己有问题？**

看网关各阶段的耗时拆解。Spring Cloud Gateway 开 `spring.cloud.gateway.httpserver.debug`，每个 filter 的耗时进 metrics。三步：
1. 看网关的 `gateway_filter_duration`（按 filter 维度的 P99）——如果 `RequestRateLimiter`（Redis 限流）从 1ms 飙到 100ms，是 Redis 慢了（查 `redis-cli --latency` 和 Redis 的 `slowlog get`）。
2. 看 `route_duration` 和 `downstream_response_duration`——如果 downstream 占了 190ms，是后端服务慢，网关只是背锅，查后端的 APM。
3. 看网关 JVM 的 GC——`jstat -gcutil` 如果 Full GC 频繁，是网关自身内存问题（比如把请求体全读到堆里）。关键是区分"网关自己慢"（filter/GC）和"后端慢"（downstream RT），别一上来就怪后端。

### 第三层：根因深挖

**Q：你定位到是 Redis 集群限流变慢了（每次令牌桶计算要查 Redis），根因是什么？光是把 Redis 换成本地限流就行吗？**

换本地限流是错的——集群限流的意义就是"全局限流"，本地限流每台网关各自算，100 台网关就是 100 倍的限流阈值，等于没限。根因要看 Redis 为什么慢：
1. `redis-cli --latency` 和 `INFO clients`——是不是连接数打满（`maxclients`）、或单实例 QPS 到瓶颈（10 万+）。
2. `SLOWLOG GET 10`——看有没有 `KEYS *` 这种阻塞命令，或限流 key 没设 TTL 导致大 key。
3. 如果是 Redis 单点瓶颈，治本是限流 key 分片（按 UID hash 分到不同 Redis 节点），或用本地+全局两级限流——本地令牌桶挡第一波（95% 请求本地判定），超阈的才查全局 Redis，把 Redis QPS 降两个数量级。

**Q：那为什么不直接用 Sentinel 的集群限流，而要自己用 Redis 令牌桶？**

Sentinel 集群限流确实能用，但它有自己的 Token Server 集群，运维成本高（要单独部署和维护 Token Server 的高可用）。Redis 令牌桶的优势是复用现有 Redis 集群（拼多多本来就有大规模 Redis），不增加新组件。且 Redis 的 Lua 脚本能保证"取令牌"原子（判断+扣减一次完成），Sentinel 的集群限流在 Token Server 单点切换时会有短暂误差。权衡：如果团队已用 Sentinel 全套（熔断/降级/限流），用 Sentinel 集群限流统一；如果只是网关限流且 Redis 已就绪，Redis 令牌桶更轻。没有绝对优劣，看整体技术栈。

### 第四层：方案权衡

**Q：你的灰度是按 UID hash % 10 == 0 路由到 canary，但如果 canary 实例有 bug 导致这批用户体验差，你怎么权衡"快速发现"和"影响可控"？**

灰度的核心是"小流量+可观测+可快速回滚"。权衡方案：
1. 灰度比例分档——先 1%（hash%100==0）跑 30 分钟，指标（错误率/RT/业务失败率）正常再升 10%、50%、100%。每档都有明确的"通过条件"和"自动回滚条件"（如错误率 >1% 自动回滚）。
2. 灰度用户可识别——让 canary 流量的响应头带 `X-Canary: true`，前端能提示用户"您在内测版本"，反馈更快。
3. 灰度维度可切换——除了 UID hash，还能按"内部员工 UID"灰度（dogfood），内部用户先踩坑，比随机 UID 更可控。影响可控的本质是"灰度比例可控 + 异常自动回滚"，不是一灰度就 10%。

**Q：为什么不用蓝绿发布，而是金丝雀灰度？蓝绿不是更简单吗（切流量就行）？**

蓝绿是"两套完整环境，切 50% 或 100%"，问题是没有中间态——一旦切 50% 发现 bug，已经有半数用户受影响。金丝雀能从 1% 起步，影响面小得多。且蓝绿要求双倍资源（两套完整环境常驻），成本高；金丝雀的 canary 实例可以只有几台（1% 容量），资源省。拼多多这种量级，蓝绿的双倍成本是天文数字。金丝雀的唯一代价是路由逻辑复杂（要按规则分流），但网关本就该支持这个能力。只有"数据库 schema 变更不兼容"这种必须一刀切的场景，才考虑蓝绿。

### 第五层：验证与沉淀

**Q：你怎么验证网关的限流真的在阈值处生效，而不是"配置了但没起作用"？**

必须有压测验证，不能等线上故障。两步：
1. 线下压测——对单个接口施压，从 800 QPS 加到 1200 QPS（阈值 1000），看 `rate_limited_count`（429 响应数）在 1000 QPS 后线性增长，且后端实际接收 QPS 稳定在 1000。如果后端 QPS 也跟着涨，说明限流没生效（配置写错或 filter 顺序问题）。
2. 线上引流压测——大促前用影子流量回放，验证集群限流在多台网关下总量精确（100 台网关合计 1000 QPS，而不是每台 1000 合计 10 万）。集群限流的精度（误差 <5%）要靠 Redis Lua 原子性保证，本地限流做不到。

**Q：网关作为单点入口，怎么沉淀机制防止"网关挂全站挂"？**

网关自身的可用性是生命线，沉淀三件事：
1. 网关无状态化——所有配置（路由/限流规则）走配置中心（Nacos/Apollo）动态下发，任何网关实例挂了，SLB 摘除后其他实例接管，无状态丢失。
2. 多可用区部署——网关实例分布在同城多 AZ，单 AZ 故障自动切。SLB 本身也要跨 AZ 主备。
3. 降级预案——网关依赖的 Redis（限流）/配置中心挂了怎么办？要有本地兜底（限流降级为本地令牌桶、配置用本地缓存副本），确保网关不会因依赖挂而全站不可用。网关的 SLA 必须高于任何后端服务，否则就是单点。

## 结构化回答

**30 秒电梯演讲：** 微服务后每个服务都需鉴权/限流/日志，如何统一？简单说就是——网关是统一入口，负责"路由+鉴权+限流+灰度+日志"，用 Spring Cloud Gateway 编程式配置，支撑拼多多百万 QPS 交易接入。

**展开框架：**
1. **核心** — 核心：路由+过滤器（前置/后置）+限流+熔断
2. **鉴权** — 鉴权：JWT/Session 统一校验
3. **灰度** — 灰度：按 UID/版本路由（金丝雀发布）

**收尾：** 您看这块要不要再展开聊聊？

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：网关怎么设计？怎么扛百万 QPS？ | 今天聊「网关怎么设计？怎么扛百万 QPS？」。一句话：网关是统一入口，负责"路由+鉴权+限流+灰度+日志" | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：核心：路由+过滤器（前置/后置）+限流+熔断 | 核心概念 |
| 0:51 | 能力/参数拆解表 | 要点是：鉴权：JWT/Session 统一校验 | 能力拆解 |
| 1:30 | 流程图：输入→处理→输出 | 要点是：灰度：按 UID/版本路由（金丝雀发布） | 关键机制 |
| 2:09 | 代码片段 + 注释高亮 | 要点是：限流：Sentinel/Redis 令牌桶 | 实战要点 |
| 3:00 | 总结卡 + 下期预告 | 记住核心要点就够了。下期见。 | 收尾 |
