---
id: ant-risk-016
difficulty: L2
category: jd-core
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
