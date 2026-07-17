---
id: ant-risk-016
difficulty: L2
category: ant-risk
subcategory: Spring Cloud
tags:
- 蚂蚁
- 风控
- Feign
- RPC
- Dubbo
- 服务调用
feynman:
  essence: Feign/Dubbo 把"远程 HTTP/RPC 调用"伪装成"本地方法调用"，底层封装了注册中心寻址、负载均衡、序列化、重试、熔断。
  analogy: RPC 像快递——你只管把包裹（参数）给快递员（stub），不用关心走哪条路、用什么车。Feign 是声明式（注解接口），Dubbo 是高性能（TCP 长连接）。
  first_principle: 远程调用本质是"序列化+网络传输+反序列化"，复杂度高；把它包装成本地调用降低使用成本，让业务代码不感知分布式。
  key_points:
  - Feign：声明式 HTTP（注解接口），集成 Ribbon/LoadBalancer + Sentinel
  - Dubbo：TCP 长连接 + 自定义协议 + SPI，性能比 HTTP 高
  - 序列化：JSON（通用）、Hessian/Protobuf（高效）
  - 负载均衡：随机、轮询、一致性哈希、最少活跃
  - 集群容错：Failover（重试）、Failfast（快速失败）、Forking（并发调用）
first_principle:
  problem: 在微服务里，业务代码调用其他服务像调用本地方法一样方便，但底层要处理寻址、负载均衡、序列化、网络异常、重试熔断，怎么封装？
  axioms:
  - 业务代码不应感知分布式细节
  - 网络不可靠（延迟、丢包、超时）
  - 需要统一治理（限流、熔断、监控）
  rebuild: 用动态代理把接口调用拦截，封装"寻址→负载均衡→序列化→调用→失败处理"。Feign 走 HTTP 通用，Dubbo 走 TCP 高性能。
follow_up:
- Feign 和 Dubbo 怎么选？——对外（前端/第三方）用 HTTP/Feign 通用；内部服务间高频调用用 Dubbo 高性能
- 序列化怎么选？——跨语言 JSON，Java 内部 Hessian/Kryo（小快）
- Feign 怎么传上下文（TraceId/UID）？——RequestInterceptor 拦截器塞 header
memory_points:
- Feign = 动态代理 + HTTP + 整合 LoadBalancer/Sentinel
- Dubbo = TCP 长连接 + SPI 扩展 + 高性能
- 集群容错：Failover（默认重试）、Failfast、Forking、Broadcast
- 负载均衡：随机（Dubbo 默认）、轮询、一致性哈希、最短响应
---

# 【蚂蚁风控】微服务之间怎么调用？Feign 和 Dubbo 区别？怎么治理？

> JD 依据："Spring Cloud"。风控拆成几十个微服务，服务间调用是核心。

## 一、表面层：服务间调用的方式

| 方式 | 协议 | 性能 | 通用性 | 适用 |
|------|------|------|--------|------|
| RestTemplate | HTTP | 中 | 强 | 简单场景 |
| **Feign** | HTTP | 中 | 强 | Spring Cloud 标配 |
| **Dubbo** | TCP | 高 | Java | 高性能内部调用 |
| gRPC | HTTP/2 + Protobuf | 高 | 跨语言 | 多语言微服务 |

## 二、Feign：声明式 HTTP 客户端

**用法**：
```java
@FeignClient(name = "feature-service", fallback = FeatureFallback.class)
public interface FeatureClient {
    @GetMapping("/feature/{uid}")
    Feature getFeature(@PathVariable("uid") String uid);
}

// 业务代码
@Autowired
FeatureClient featureClient;
Feature f = featureClient.getFeature("500");  // 像本地方法
```

**底层流程**：
```
调用 featureClient.getFeature("500")
    │
    ├─ 动态代理拦截
    │
    ├─ 解析注解 → 构造 HTTP 请求
    │   GET http://feature-service/feature/500
    │
    ├─ LoadBalancer 选实例（feature-service → 10.0.0.5:8080）
    │
    ├─ 发起 HTTP 调用
    │
    ├─ 失败 → Sentinel 熔断/重试
    │
    └─ 反序列化响应 → Feature 对象
```

## 三、Feign 的核心组件

```
Feign
 ├─ Encoder：把参数序列化为请求体（默认 springEncoder → JSON）
 ├─ Decoder：把响应反序列化（默认 jacksonDecoder）
 ├─ Contract：解析注解（SpringMvcContract 支持 @GetMapping 等）
 ├─ Client：执行 HTTP（默认 HttpURLConnection，可换 OkHttp/Apache HttpClient）
 ├─ Interceptor：请求拦截器（加 header、签名、TraceId）
 └─ Logger：日志
```

**RequestInterceptor 应用**（传上下文）：
```java
@Component
public class FeignTraceInterceptor implements RequestInterceptor {
    @Override
    public void apply(RequestTemplate template) {
        template.header("X-TraceId", MDC.get("traceId"));
        template.header("X-UID", RequestContextHolder.getUid());
    }
}
```

## 四、Dubbo：高性能 RPC

**用法**：
```java
@DubboService  // 提供方
public class FeatureServiceImpl implements FeatureService {
    public Feature getFeature(String uid) { ... }
}

@DubboReference  // 消费方
private FeatureService featureService;  // 注入代理
```

**Dubbo 协议**（默认 dubbo 协议）：
```
TCP 长连接 + 自定义二进制协议
报文头(16字节) + 报文体(序列化的 Invocation)
单连接多复用，避免 HTTP 每次握手开销
```

**性能优势**：
- TCP 长连接（复用）
- 二进制协议（比 HTTP 文本省带宽）
- 高效序列化（Hessian2 默认）
- 业务线程池隔离

## 五、Feign vs Dubbo 对比

| 维度 | Feign | Dubbo |
|------|-------|-------|
| 协议 | HTTP/1.1 | TCP（自定义）/ Triple（HTTP/2） |
| 性能 | 中（HTTP 开销） | 高（TCP 长连接 + 二进制） |
| 通用性 | 强（任何 HTTP 服务） | Java 内部 |
| 序列化 | JSON | Hessian2/Protobuf |
| 服务发现 | Nacos/Eureka | Nacos/ZooKeeper |
| 治理 | Sentinel 集成 | 内置（限流、路由） |
| 学习成本 | 低 | 中 |
| Spring Cloud 集成 | 原生 | 通过 spring-cloud-starter-dubbo |

**风控的选择**：
- 对外 API（前端、第三方）：Feign（HTTP 通用）
- 内部高频调用（决策→特征）：Dubbo（高性能）
- 大部分场景：Feign 足够（开发效率优先）

## 六、集群容错策略

**Dubbo 提供**：
| 策略 | 行为 | 适用 |
|------|------|------|
| **Failover**（默认） | 失败重试其他服务器（默认 2 次） | 读、幂等 |
| **Failfast** | 失败立即报错 | 非幂等写（避免重复执行） |
| **Failsafe** | 失败忽略（不报错） | 日志、监控 |
| **Forking** | 并发调用 N 个，最快返回 | 实时性高 |
| **Broadcast** | 调用所有 | 通知所有节点 |

**Feign + Sentinel 的等价**：
- 重试：`feign.Retryer`
- 熔断：Sentinel 的 DegradeSlot
- 降级：fallback 类

## 七、负载均衡策略

| 策略 | 行为 |
|------|------|
| **Random**（Dubbo 默认） | 随机（概率按权重） |
| **RoundRobin** | 轮询 |
| **LeastActive** | 最少活跃调用（最闲的优先） |
| **ConsistentHash** | 一致性哈希（同 key 同实例） |
| **ShortestResponse** | 最短响应时间 |
| **Zone/Cluster aware** | 同机房优先（风控同城路由） |

## 八、风控实战

**场景**：风控决策需要并行查多个下游：
```java
@FeignClient(name = "feature-service")
public interface FeatureClient { ... }

@FeignClient(name = "profile-service")
public interface ProfileClient { ... }

@FeignClient(name = "rule-service")
public interface RuleClient { ... }

// 并行调用（CompletableFuture）
public RiskResult decide(Event e) {
    CompletableFuture<Feature> ff = CompletableFuture.supplyAsync(
        () -> featureClient.get(e.uid), pool);
    CompletableFuture<Profile> fp = CompletableFuture.supplyAsync(
        () -> profileClient.get(e.uid), pool);

    CompletableFuture.allOf(ff, fp).get(100, MS);  // 100ms 超时
    return ruleClient.match(ff.join(), fp.join());
}
```

**关键治理**：
- 每个下游独立熔断（防雪崩）
- 超时分级（特征 <50ms，画像 <100ms，规则 <200ms）
- 降级（熔断时用缓存数据）

## 九、序列化的选择

| 格式 | 体积 | 速度 | 跨语言 |
|------|------|------|--------|
| JSON | 大 | 慢 | 强 |
| Hessian2 | 小 | 快 | Java |
| Kryo | 很小 | 很快 | Java |
| Protobuf | 小 | 快 | 强 |
| Avro | 小 | 快 | 强 |

**风控选择**：
- Feign：JSON（通用，可调试）
- Dubbo：Hessian2（默认，平衡）
- 大流量场景：Protobuf/Kryo

## 十、底层本质：RPC 的"位置透明"哲学

RPC 的核心思想是**位置透明性**：
- 让"调用本地方法"和"调用远程方法"代码一致
- 业务代码不感知"远程"

但分布式系统的 8 大谬误提醒我们这是"美丽的谎言"：
1. 网络可靠（不可靠）
2. 延迟为零（不为零）
3. 带宽无限（有限）
4. 网络安全（不安全）
5. 拓扑不变（会变）
6. 管理员只有一个（多个）
7. 传输成本为零（有成本）
8. 网络同构（不同构）

**所以 Feign/Dubbo 都要配套**：
- 超时（应对延迟）
- 重试（应对不可靠）
- 熔断（应对故障）
- 降级（应对不可用）

**这是工程实用主义**——RPC 让开发简单，但要"假装本地"的同时记住"它其实是远程"。

## 常见考点
1. **Feign 怎么集成本地拦截器**？——RequestInterceptor 接口，注册为 Bean 自动生效。
2. **Dubbo 的 SPI 和 Java SPI 区别**？——Dubbo SPI 支持依赖注入、自适应扩展（@Adaptive）、Wrapper（AOP）；Java SPI 一次性加载所有实现。
3. **怎么调试 Feign 调用**？——`logging.level.xx.FeatureClient=DEBUG` 看完整请求响应；用 OpenTelemetry tracing。

**代码示例**（Feign + Sentinel 配置）：
```yaml
feign:
  sentinel:
    enabled: true
  client:
    config:
      default:
        connect-timeout: 1000
        read-timeout: 2000
        logger-level: BASIC
      feature-service:  # 针对特定服务
        read-timeout: 50  # 特征调用更短超时
```

## 苏格拉底式面试追问

> 这组追问不是背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：风控决策调用特征服务你用了 Feign（HTTP），而决策调用规则服务用 Dubbo（TCP）。为什么同一个链路里混用两种 RPC？统一用一种不行吗？**

统一用一种当然行，但我们混用是基于"调用频率 + 性能要求"的差异。决策调用规则服务是"高频 + 低延迟"（每次决策都调、要求 <20ms），Dubbo 的 TCP 长连接 + Hessian2 二进制序列化比 Feign 的 HTTP + JSON 快 3-5 倍（省去 HTTP 头解析、TCP 握手、JSON 序列化开销），对核心链路值得。决策调用特征服务是"中频 + 中延迟"（每次决策调但要求 <50ms，Feign 能满足），且特征服务还要对外（给其他业务系统）调用，HTTP/JSON 通用性好。混用的代价是两套技术栈（学习成本 + 运维成本），但风控团队对两者都熟，且性能收益明确。决策依据是压测——同一次决策调用，Dubbo RT 5ms、Feign RT 15ms，核心链路（规则匹配）省 10ms 值得用 Dubbo，非核心（特征查询）Feign 够用。

### 第二层：证据与定位

**Q：风控决策调用规则服务的 Dubbo 调用突然 RT 飙升，偶发超时。你怎么确认是 Dubbo 框架问题、网络问题、还是规则服务本身慢？**

三段式定位：
1. 看 Dubbo 的调用指标——Dubbo Admin 或 APM 里看 `dubbo.invoke.latency`（调用 RT）和 `dubbo.provider.invoke.latency`（提供方处理 RT）。如果 invoke.latency 高但 provider.latency 正常，差值在网络/序列化（Dubbo 框架或网络）；如果两者都高，是规则服务处理慢。
2. 看 Dubbo 的线程池——`dubbo.threadpool.active` 和 `dubbo.threadpool.queue.size`。如果线程池满了（active=200 顶到 max），调用排队导致 RT 高，根因可能是规则服务处理慢导致线程堆积，或并发太高。用 `arthas thread -n 5` 看规则服务的线程在做什么。
3. 看网络——`ping rule-service-ip` 看网络延迟，`tcpdump -i eth0 port 20880 -w dubbo.pcap` 抓包分析 Dubbo 协议的握手和传输时间。如果 TCP 重传率高（`netstat -s | grep retransmit`），是网络质量问题（如跨机房、网络抖动）。

### 第三层：根因深挖

**Q：你发现是 Dubbo 线程池满了（active=200），但规则服务的 CPU 才 40%。根因是什么？为什么线程池满但 CPU 不高？**

线程池满 + CPU 不高 = 线程都在"等"（IO 或锁）。看 `arthas thread` 里 Dubbo 线程的状态，如果大量线程卡在 `WAITING` 或 `BLOCKED`，根因有两种：
1. 等 IO——规则服务在调用下游（如查 Redis/HBase）时阻塞，Dubbo 线程都在等下游响应。CPU 不高（等时不占 CPU），但线程被占满。看 jstack 里线程栈是否停在 `SocketRead` 或 `Redis.get`。
2. 等锁——规则服务内部有锁竞争（如规则引擎的读写锁），Dubbo 线程排队等锁。看 jstack 是否大量线程停在 `synchronized` 或 `ReentrantLock`。
真实案例常见是第 1 种——规则服务同步调 Redis，Redis 抖动（主从切换）导致单次 get 从 1ms 涨到 500ms，Dubbo 的 200 个线程全在等 Redis，新请求排队超时。根因不是规则服务慢，是它的下游 Redis 慢，但表现为 Dubbo 线程池满。

**Q：根因是规则服务等 Redis 慢。那为什么规则服务的 Dubbo 线程池不配大一点？200 个不够就配 500 个。**

配大线程池治标不治本，且可能雪崩。线程数从 200 到 500，规则服务的内存（每线程 1MB 栈）增加 300MB，且如果 Redis 还是慢，500 个线程照样等满，只是延迟了饱和时间。更糟的是 500 个线程同时打到慢的 Redis，相当于放大 2.5 倍压力，Redis 可能直接被打挂，整个链路雪崩。正确做法是熔断 + 降级——当 Redis RT > 100ms 时（Sentinel 慢调用比例熔断），规则服务快速失败走降级（用缓存规则或默认决策），Dubbo 线程快速释放，不堆积。线程池大小按"稳态 QPS × 单次处理 RT"算——稳态 10000 QPS × 5ms = 50 个线程足够，配 200 是给峰值留余量，不该靠堆线程应对下游故障。

### 第四层：方案权衡

**Q：你加了熔断降级解决线程池满的问题。但业务方说"规则服务降级返回默认决策，会导致风控准确率下降"。"怎么权衡可用性和准确率？**

这是风控的核心权衡。先量化降级的影响：降级期间返回默认决策（如 PASS 或 REVIEW），哪些交易受影响？降级频率多高？如果熔断每天触发 1 次、每次 10 秒、影响 1000 笔交易，且默认决策是 REVIEW（人工审核）而非 PASS（放行），那准确率影响可控（人工兜底）。如果默认决策是 PASS（漏判风险），不可接受。权衡方案是分级降级——熔断时不返回固定默认值，而是返回"最近一次缓存的风险分 + 保守阈值调整"。比如缓存的风险分是 70 分（正常阈值 60 分拦截），降级时把阈值调到 50 分（更严格），用缓存的分 + 更严的阈值做近似决策，准确率比"返回固定默认"高。代价是降级逻辑复杂（要维护缓存 + 动态阈值），但准确率是风控的生命线，值得。SLA 约定：降级期间准确率不低于正常的 80%，达不到就要优化降级策略。

**Q：为什么不直接把规则服务从 Dubbo 换成 Feign + 异步（CompletableFuture + 响应式），非阻塞就不会线程池满了？**

异步非阻塞（如 WebFlux + Feign reactive）确实不会因等 IO 导致线程池满（少量 EventLoop 线程处理高并发）。但风控决策链路是同步语义——用户支付时等风控结果，整个链路是"请求-响应"模式。改成异步要重构整个链路（从 controller 到 service 到 RPC 全异步），且 Dubbo 的同步 API（`featureService.get(uid)` 返回值）改异步（返回 CompletableFuture）后，业务代码复杂度上升（回调地狱或 thenApply 链）。更关键的是，异步非阻塞解决的是"线程等 IO 的效率"，但不解决"下游故障导致的服务不可用"——Redis 挂了，异步照样拿不到数据，还是要熔断降级。异步是性能优化（高并发下省线程），熔断降级是容错（故障下保命），两者正交。我们优先解决容错（熔断降级），异步作为未来性能优化的备选（当 QPS 涨到单机扛不住时再考虑）。

### 第五层：验证与沉淀

**Q：你怎么验证 Feign/Dubbo 的超时、重试、熔断配置都合理、不会因配置不当导致雪崩或误杀？**

配置审查 + 故障注入验证：
1. 超时配置审查——列出所有 Feign/Dubbo 调用的超时配置（connect-timeout、read-timeout），与下游的 SLA（P99 RT）对比。规则是"调用方超时 > 下游 P999 RT × 1.5"（留余量），如下游 P999=30ms，超时应配 50ms 以上。超时 < 下游 P999 会导致正常请求被误杀。输出超时配置审查报告，不合理的修正。
2. 重试审查——检查所有重试配置的重试次数和"重试条件"。关键规则：非幂等操作（如扣款）禁止重试（用 Failfast），幂等操作（如查询）可重试但重试次数 ≤2，重试间隔要设（避免立即重试打到同一个挂的实例）。`feign.Retryer.Default(100, 1000, 3)` 是初始 100ms、最大 1s、最多 3 次。
3. 故障注入验证——对每个下游注入延迟（ChaosBlade），验证熔断器在预期时间触发（如 RT > 100ms 比例 > 50% 时 5 秒内 OPEN）、降级 fallback 正确返回、恢复后熔断器 CLOSED。任何"该熔断没熔断"或"不该熔断误触发"都是配置问题。

**Q：怎么让团队的 RPC 调用治理规范化、不踩坑？**

沉淀成规范和工具：
1. RPC 配置模板——按调用类型给模板：核心读（Dubbo，超时 50ms，Failover 2 次）、核心写（Dubbo，超时 100ms，Failfast 不重试）、对外 API（Feign，超时 2s）。超出模板需架构评审。
2. 强制熔断——所有 @FeignClient / @DubboReference 必须配 fallback 和 Sentinel 规则，否则 CR 不通过。用 ArchUnit 写架构规则测试强制。
3. 超时监控——每个 RPC 调用的 RT 分位上报 Prometheus，P99 超过超时配置的 80% 告警（说明快超时了，下游在变慢）。
4. 重试风暴防护——禁止全局重试 >3 次，禁止对非幂等接口配重试。Dubbo 的 retries 和 Feign 的 Retryer 配置 CI 校验。
5. 故障复盘——把这次"Dubbo 线程池满 + Redis 抖动 → 雪崩"的 jstack 截图、线程池曲线、熔断配置存知识库，作为"RPC 调用必须配熔断 + 下游故障不能拖死线程池"的案例。


## 结构化回答

**30 秒电梯演讲：** 聊到微服务之间怎么调用，我的理解是——Feign/Dubbo 把"远程 HTTP/RPC 调用"伪装成"本地方法调用"，底层封装了注册中心寻址、负载均衡、序列化、重试、熔断。打个比方，RPC 像快递——你只管把包裹（参数）给快递员（stub），不用关心走哪条路、用什么车。Feign 是声明式（注解接口），Dubbo 是高性能（TCP 长连接）。

**展开框架：**
1. **Feign** — 声明式 HTTP（注解接口），集成 Ribbon/LoadBalancer + Sentinel
2. **Dubbo** — TCP 长连接 + 自定义协议 + SPI，性能比 HTTP 高
3. **序列化** — JSON（通用）、Hessian/Protobuf（高效）

**收尾：** 这块我在项目里也踩过坑——想深入的话，可以接着聊：Feign 和 Dubbo 怎么选？您更想看哪个方向？

## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡 | "微服务之间怎么调用——这道题面试官到底想考什么？我用 30 秒给你讲透。" | 开场钩子 |
| 0:15 | Spring Bean 生命周期图 | 先说核心：Feign/Dubbo 把"远程 HTTP/RPC 调用"伪装成"本地方法调用"，底层封装了注册中心寻址、负载均衡、序列化、重试、熔断。 | 核心定义 |
| 0:30 | RPC 调用流程图 | TCP 长连接 + 自定义协议 + SPI，性能比 HTTP 高。 | Dubbo |
| 1:30 | 总结卡 | 一句话记忆：Feign = 动态代理 + HTTP + 整合 LoadBalancer/Sentinel。 下期可以接着聊：Feign 和 Dubbo 怎么选。 | 收尾总结 |
