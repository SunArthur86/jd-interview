---
id: java-architect-073
difficulty: L2
category: java-architect
subcategory: Spring Cloud
tags:
- Java 架构师
- Dubbo迁移
- Spring Cloud Alibaba
- 治理
feynman:
  essence: Dubbo 到 SCA（Spring Cloud Alibaba）的迁移本质是"通信协议（Dubbo TCP vs HTTP/Feign）+ 注册发现（Zookeeper/Nacos）+ 治理能力（Dubbo SPI vs SCA 生态）"三件事的切换。风险不在框架本身，而在"迁移过程中新老框架并存调用、注册中心数据不一致、治理规则失效"三类问题。
  analogy: 像把一条运行中的老铁路（Dubbo 专线）换成新高铁（SCA），不能停运。先修并行新轨道（双注册），让部分列车试跑新线（灰度），新老车站都能接发（双消费），最后全量切到新线。
  first_principle: 框架迁移的难点是"不停机 + 不丢请求 + 可回滚"。Dubbo 和 SCA 的服务模型不同（Dubbo 私有协议 + 接口级注册，SCA 是 HTTP/Feign + 应用级注册），不能直接替换。必须让新老框架在过渡期并存——同一服务同时注册到 Dubbo 和 Nacos，消费端逐步切到新框架。
  key_points:
  - Dubbo：私有 TCP 协议（默认 dubbo 协议）、接口级注册（每个方法注册到 ZK/Nacos）、SPI 扩展强
  - SCA：HTTP/Feign（或 Dubbo Spring Cloud 两种都行）、应用级注册（Spring Cloud LoadBalancer）、生态广
  - 迁移三大风险：注册中心数据不一致（双注册中心同步）、治理规则失效（超时/重试/限流配置迁移）、新老并存调用混乱
  - 核心策略：双注册双订阅 + 流量灰度 + 回滚开关 + 调用链对账
  - 实际生产：Dubbo 3.x 已与 SCA 融合（Dubbo Spring Cloud），不一定要"非此即彼"
first_principle:
  problem: 数百个 Dubbo 服务、日均亿级调用，如何在不影响业务连续性的前提下迁移到 SCA，且随时可回滚？
  axioms:
  - 迁移期新旧框架必须共存，消费端能同时调用新旧 provider
  - 注册中心是强依赖，切换期间不能丢实例、不能让调用断
  - 治理规则（超时、重试、限流、熔断）必须等价迁移，否则线上行为变化
  rebuild: 分阶段推进——第一阶段双注册（服务同时注册到 ZK 和 Nacos，消费端仍走 Dubbo）；第二阶段灰度消费（新部署的 SCA 消费端开始调 SCA provider，按流量标签灰度）；第三阶段治理规则等价迁移（Dubbo 的 timeout/retries 转成 SCA 的 Feign 配置或 Sentinel 规则）；第四阶段下线 Dubbo（注册中心摘除 Dubbo 实例）。全程用 traceId 对账，发现调用失败率上升立即回滚。
follow_up:
  - 为什么不直接用 Dubbo 3.x 而要迁 SCA？——Dubbo 3.x 已支持应用级注册和 Triple 协议（HTTP/2），与 SCA 生态融合。如果只是想升级，Dubbo 2→3 比迁 SCA 成本低。但如果要统一到 Spring Cloud 生态（Feign/Gateway/Sentinel/Nacos），才需要迁 SCA
  - 双注册期间调用会串吗？——会。消费端如果同时订阅 Dubbo 和 SCA 注册中心，可能一会调 Dubbo provider 一会调 SCA provider。要确保新老 provider 行为一致（同一份代码两种协议暴露），或用流量标签隔离
  - 治理规则怎么等价迁移？——Dubbo 的 timeout=1000 retries=2 对应 Feign 的 client config（connectTimeout/readTimeout）+ Sentinel 重试规则。要逐条对照，不能遗漏（漏了可能线上超时行为变化导致雪崩）
  - 注册中心怎么平滑切换？——如果用 Nacos，Dubbo 3.x 原生支持 Nacos 注册，可以先把 Dubbo 注册中心从 ZK 切到 Nacos（配置改一下），再考虑框架迁移。注册中心先行，降低风险
  - 迁移过程中怎么对账？——按 traceId 统计调用成功率，对比迁移前后的 rpc_success_rate。灰度实例的 service_error_rate 不能高于基线，否则立即回滚
memory_points:
  - 迁移四阶段：双注册 → 灰度消费 → 治理规则等价迁移 → 下线 Dubbo
  - 三大风险：注册中心数据不一致、治理规则失效、新老并存调用混乱
  - 优先考虑 Dubbo 3.x（应用级注册 + Triple 协议 + SCA 融合），不一定非迁 SCA
  - 治理规则逐条对照迁移（Dubbo timeout/retries → Feign/Sentinel）
  - 用 traceId + service_error_rate + rpc_p99 做迁移期对账
---

# 【Java 后端架构师】Dubbo 到 Spring Cloud Alibaba 的迁移治理

> 适用场景：JD 核心技术。老系统基于 Dubbo 2.x + Zookeeper，日均亿级 RPC 调用，要迁到 Spring Cloud Alibaba（Nacos + Feign + Sentinel + Seata）。架构师必须设计不停机迁移方案、处理双注册并存、等价迁移治理规则、保证可回滚。

## 一、概念层：Dubbo vs SCA 的本质差异

**框架对比**（面试必答）：

| 维度 | Dubbo 2.x | Spring Cloud Alibaba |
|------|-----------|---------------------|
| **通信协议** | Dubbo TCP（默认）/ HTTP | HTTP/REST（Feign）或 Dubbo 协议（Dubbo Spring Cloud） |
| **注册中心** | Zookeeper / Nacos | Nacos |
| **注册粒度** | 接口级（每个接口注册） | 应用级（每个应用实例注册） |
| **负载均衡** | 内置（Random/RoundRobin/LeastActive） | Spring Cloud LoadBalancer（Ribbon 已废弃） |
| **服务调用** | @DubboReference（RPC 代理） | @FeignClient（HTTP 客户端） |
| **熔断限流** | Dubbo SPI 接 Sentinel | Sentinel 原生集成 |
| **配置中心** | 独立（Apollo/ZK） | Nacos Config |
| **分布式事务** | Seata | Seata |
| **网关** | Dubbo 网关 | Spring Cloud Gateway |

**关键认知：Dubbo 3.x 已与 SCA 融合**

```
Dubbo 2.x：私有协议 + 接口级注册 + ZK
    ↓ 升级（推荐）
Dubbo 3.x：应用级注册 + Triple 协议（HTTP/2）+ Nacos
    ↓ 与 SCA 共存
Dubbo Spring Cloud：Dubbo 协议 + Spring Cloud 治理生态

结论：迁移前先评估是"升级 Dubbo 3.x"还是"全量迁 SCA"
      纯框架迁移成本高，Dubbo 3.x 可能更划算
```

## 二、机制层：双注册双订阅的迁移架构

**迁移期并存架构**（核心，画图必考）：

```
                    ┌─────────────────────────────┐
                    │        服务消费方             │
                    │  ┌────────────┐ ┌─────────┐ │
                    │  │Dubbo 消费端 │ │SCA 消费端│ │
                    │  │@DubboRef   │ │@FeignClient│
                    │  └─────┬──────┘ └────┬────┘ │
                    └────────┼─────────────┼──────┘
                             │             │
              ┌──────────────┼─────────────┼──────────────┐
              │              │             │              │
              ▼              ▼             ▼              ▼
        ┌──────────┐   ┌──────────┐  ┌──────────┐  ┌──────────┐
        │Zookeeper │   │  Nacos   │  │Zookeeper │  │  Nacos   │
        │(Dubbo注册)│   │(SCA注册) │  │(Dubbo注册)│  │(SCA注册) │
        └──────────┘   └──────────┘  └──────────┘  └──────────┘
              │              │             │              │
              └──────┬───────┘             └──────┬───────┘
                     │                            │
                     ▼                            ▼
              ┌──────────────────┐      ┌──────────────────┐
              │  服务提供方 A      │      │  服务提供方 B      │
              │ (同时暴露 Dubbo   │      │ (同时暴露 Dubbo   │
              │  + REST 接口)     │      │  + REST 接口)     │
              └──────────────────┘      └──────────────────┘
```

**Provider 端：同时暴露 Dubbo 和 REST 接口**：

```java
// 1. Dubbo 接口定义
public interface OrderRpcService {
    OrderDTO getOrder(Long orderId);
}

// 2. Dubbo 实现（@DubboService 暴露 Dubbo 协议）
@DubboService(timeout = 1000, retries = 2)
@Service
public class OrderRpcServiceImpl implements OrderRpcService {
    @Override
    public OrderDTO getOrder(Long orderId) {
        return orderService.getById(orderId);
    }
}

// 3. REST Controller（暴露 HTTP 给 SCA 消费端）
@RestController
@RequestMapping("/api/v1/orders")
public class OrderController {

    @Autowired
    private OrderService orderService;   // 共用同一个 service 实现

    @GetMapping("/{orderId}")
    public OrderDTO getOrder(@PathVariable Long orderId) {
        return orderService.getById(orderId);   // 行为与 Dubbo 一致
    }
}

// 4. 双注册中心配置（application.yml）
dubbo:
  registry:
    address: nacos://nacos:8848    # Dubbo 注册到 Nacos
  protocol:
    name: dubbo
    port: 20880
spring:
  cloud:
    nacos:
      discovery:
        server-addr: nacos:8848    # SCA 应用也注册到 Nacos
```

**Consumer 端：按流量标签灰度切换**：

```java
// 旧消费端：Dubbo 调用
@DubboReference(timeout = 1000, retries = 2)
private OrderRpcService orderRpcService;

// 新消费端：Feign 调用
@FeignClient(name = "order-service")
public interface OrderFeignClient {
    @GetMapping("/api/v1/orders/{orderId}")
    OrderDTO getOrder(@PathVariable Long orderId);
}

// 灰度开关：按配置决定走 Dubbo 还是 Feign
@Service
public class OrderConsumer {

    @DubboReference
    private OrderRpcService dubboClient;        // Dubbo 路径

    @Autowired
    private OrderFeignClient feignClient;       // Feign 路径

    @Value("${migration.use.feign:false}")     // 配置中心控制，灰度开关
    private boolean useFeign;

    public OrderDTO getOrder(Long orderId) {
        return useFeign ? feignClient.getOrder(orderId)
                        : dubboClient.getOrder(orderId);
        // 灰度期间按租户/地域/流量标签动态切换 useFeign
    }
}
```

## 三、机制层：治理规则等价迁移

**Dubbo 治理规则 → SCA 配置对照表**（逐条迁移，不能遗漏）：

| Dubbo 配置 | SCA 等价配置 | 迁移注意 |
|------------|-------------|---------|
| `@DubboService(timeout=1000)` | `feign.client.config.default.readTimeout=1000` | 超时必须一致，否则雪崩行为变化 |
| `retries=2` | Feign 重试或 Sentinel | Feign 默认不重试（GET 才重试），要显式配 |
| `loadbalance=roundrobin` | `spring.cloud.loadbalancer.config.round-robin` | 负载策略要对齐 |
| Dubbo Sentinel 规则 | SCA Sentinel 规则（@SentinelResource） | 规则 ID 要对应到新接口 |
| `@DubboReference(mock="return null")` | Feign fallback | 降级行为等价 |
| Dubbo Filter | Spring Interceptor / Filter | traceId、鉴权等横切逻辑迁移 |

**Feign 配置等价迁移示例**：

```java
// 迁移前的 Dubbo 配置
@DubboReference(timeout = 1000, retries = 2, mock = "return null",
                loadbalance = "roundrobin")
private OrderRpcService orderRpcService;

// 迁移后的 Feign 等价配置
@FeignClient(name = "order-service",
             fallback = OrderFeignFallback.class,
             configuration = FeignConfig.class)
public interface OrderFeignClient {
    @GetMapping("/api/v1/orders/{id}")
    OrderDTO getOrder(@PathVariable Long id);
}

// Feign 超时配置（等价 Dubbo timeout=1000）
@Configuration
public class FeignConfig {
    @Bean
    public Request.Options options() {
        return new Request.Options(
            1000,   // connectTimeout
            1000,   // readTimeout（等价 Dubbo timeout）
            true);  // followRedirects
    }
}

// Feign 降级（等价 Dubbo mock="return null"）
@Component
public class OrderFeignFallback implements OrderFeignClient {
    @Override
    public OrderDTO getOrder(Long id) {
        return null;   // 降级返回 null
    }
}

// Sentinel 限流（等价 Dubbo Sentinel 规则）
@SentinelResource(value = "getOrder",
                  blockHandler = "blockHandler",
                  fallback = "fallback")
public OrderDTO getOrder(Long id) { /* ... */ }
```

**注册中心平滑切换**（ZK → Nacos）：

```yaml
# 第一阶段：Dubbo 注册中心从 ZK 切到 Nacos（不改框架，先迁注册中心）
dubbo:
  registry:
    # address: zookeeper://zk:2181    # 旧
    address: nacos://nacos:8848        # 新，Dubbo 3.x 原生支持 Nacos

# 第二阶段：双注册中心并存（过渡期，防止 Nacos 故障）
dubbo:
  registry:
    address: zookeeper://zk:2181;nacos://nacos:8848   # 分号分隔多注册中心

# 第三阶段：摘除 ZK
dubbo:
  registry:
    address: nacos://nacos:8848
```

## 四、实战层：迁移四阶段执行方案

```
阶段一：双注册（1-2 周）
  ├─ Provider 同时暴露 Dubbo + REST 接口
  ├─ 同时注册到 ZK 和 Nacos
  ├─ 消费端仍全部走 Dubbo
  └─ 监控：nacos_instance_count、zk_instance_count 一致

阶段二：灰度消费（2-4 周）
  ├─ 新部署的消费端用 Feign 调用
  ├─ 按 1% → 10% → 50% → 100% 灰度
  ├─ 对比 Dubbo 调用和 Feign 调用的 service_error_rate、rpc_p99
  └─ 灰度实例失败率不得高于 Dubbo 基线

阶段三：治理规则迁移（并行）
  ├─ Dubbo timeout/retries/fallback 逐条迁移到 Feign/Sentinel
  ├─ 每条规则上线后对比调用链行为（traceId 串联看超时/重试是否一致）
  └─ 漏迁会导致雪崩（如漏迁 timeout，Feign 默认超时 60s 比 Dubbo 长）

阶段四：下线 Dubbo（2-4 周）
  ├─ 确认所有消费端已切 Feign（dubbo_invoke_count 趋零）
  ├─ Provider 摘除 @DubboService，只保留 REST
  ├─ 摘除 ZK 注册（Dubbo 不再注册）
  └─ 下线 ZK 集群（节省资源）
```

**迁移期监控对账**（关键指标）：

```yaml
# Prometheus 告警：迁移期失败率上升立即回滚
groups:
  - name: migration
    rules:
      - alert: FeignErrorRateHigh
        expr: |
          rate(http_client_requests_seconds_count{app="order-consumer",status=~"5.."}[5m])
          / rate(http_client_requests_seconds_count{app="order-consumer"}[5m]) > 0.01
        for: 2m
        annotations:
          summary: "Feign 调用失败率 > 1%，检查治理规则是否等价迁移"
      - alert: DubboInvokeCountDrop
        expr: rate(dubbo_consumer_invoke_total[5m]) < 100
        for: 10m
        annotations:
          summary: "Dubbo 调用量骤降，确认是否已全量切 Feign"
```

## 五、底层本质：为什么迁移风险高

回到第一性：**RPC 框架是分布式系统的"神经系统"，迁移等于换神经**。

- **注册中心是强依赖**：所有服务发现依赖注册中心。迁移期间两个注册中心（ZK + Nacos）数据必须一致，任何一个丢实例都会导致调用失败（消费端调到已下线的实例）。Dubbo 的接口级注册和 SCA 的应用级注册粒度不同，双注册要保证映射正确。
- **治理规则是行为契约**：Dubbo 的 timeout=1000 retries=2 是消费端的隐式契约。迁到 SCA 后如果漏配，Feign 默认超时是 60s（connectTimeout=10s，readTimeout=60s），一个慢依赖会让线程池耗尽引发雪崩。每条治理规则必须等价迁移并验证。
- **协议差异带来行为差异**：Dubbo TCP 是长连接（消费端缓存连接），Feign HTTP 每次建连（或用连接池）。连接管理、超时语义、序列化方式都不同，可能导致性能波动（如 Feign 连接池耗尽）。
- **过渡期并存是最脆弱的**：双注册双订阅期间，任何一个消费端配置错误（该走 Dubbo 却走了 Feign，或反之），都可能调到错误版本的服务。必须用流量标签严格隔离。

**实际建议：Dubbo 3.x 可能比迁 SCA 更划算**。Dubbo 3.x 已支持应用级注册（与 SCA 一致）、Triple 协议（HTTP/2）、原生 Nacos 集成。如果目标是升级到 Spring Cloud 生态治理，Dubbo Spring Cloud（Dubbo 协议 + SCA 治理）是平滑路径，不必放弃 Dubbo 协议。

## 六、AI 架构师加问：5 个

1. **AI 能不能自动分析 Dubbo 代码生成等价的 Feign 配置？**
   能做辅助。AI 扫描 @DubboReference 注解，生成 @FeignClient + FeignConfig 代码骨架。但治理规则（timeout/retries/fallback）的等价性要人工逐条核对——AI 可能漏迁 retries 导致雪崩。AI 生成的配置必须经 diff 工具和压测验证。

2. **迁移期间用 AI 监控调用异常怎么设计？**
   AI 分析 trace 数据，对比 Dubbo 调用和 Feign 调用的耗时分布、错误类型。发现 Feign 路径 P99 显著高于 Dubbo（如治理规则漏迁导致超时变长），AI 报警并给出假设（"疑似 readTimeout 未配置"）。但修复动作（改配置）需人工确认。

3. **Dubbo 和 SCA 的治理规则能统一管理吗？**
   能，用 Sentinel 作为统一治理平面（Dubbo 和 SCA 都接 Sentinel）。规则用 API 维度配置，Dubbo 和 Feign 调用同一服务时命中同一规则。这样治理规则不用迁移，只要把 Dubbo 和 SCA 都接 Sentinel 即可。

4. **AI Agent 能自动完成迁移的灰度切流吗？**
   不建议全自动。AI 能做流量分析（当前灰度比例、失败率、P99）、推荐灰度节奏（"建议从 10% 提到 30%"），但切流动作（改配置中心开关）必须人工确认。一次错误的切流（如 10% 直接跳 100%）可能全量故障。

5. **迁移完成后用 AI 做代码清理怎么控风险？**
   AI 扫描残留的 Dubbo 代码（@DubboReference、dubbo 配置），生成清理 PR。但要确认 dubbo_invoke_count 趋零（监控证明无调用）才能删。AI 可能误删还在用的代码（如某些内部 RPC 没迁完），要人工 review + 灰度删除。

## 七、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"四阶段、双注册、治理等价、回滚开关"**。

- **四阶段**：双注册 → 灰度消费 → 治理规则迁移 → 下线 Dubbo
- **双注册**：Provider 同时暴露 Dubbo+REST，注册到 ZK+Nacos
- **治理等价**：Dubbo timeout/retries/fallback 逐条迁到 Feign/Sentinel，不能漏
- **灰度**：消费端按 1%→10%→100% 切 Feign，对比 service_error_rate
- **回滚**：配置开关秒级切回 Dubbo，迁移期全程对账

### 拟人化理解

把迁移想成**铁路换轨**。老铁路是 Dubbo 专线（专用协议、专用信号系统 ZK），新高铁是 SCA（标准轨道 HTTP、统一调度 Nacos）。不能停运，先修并行新轨道（双注册），让部分列车试跑新线（灰度消费），新老信号系统都能接发（双订阅），最后全量切新线（下线 Dubbo）。最危险的是过渡期——信号系统不一致（治理规则漏迁）会让列车相撞（雪崩）。

### 面试现场 60 秒回答

> 迁移核心是"不停机、不丢请求、可回滚"。分四阶段：第一阶段双注册，Provider 同时暴露 Dubbo 和 REST 接口，注册到 ZK 和 Nacos，消费端仍走 Dubbo。第二阶段灰度消费，新部署的消费端用 Feign 调用，按 1%→100% 灰度，对比 service_error_rate 和 rpc_p99。第三阶段治理规则等价迁移，Dubbo 的 timeout/retries/fallback 逐条迁到 Feign 配置或 Sentinel，漏迁会导致雪崩（如 Feign 默认超时 60s）。第四阶段确认 dubbo_invoke_count 趋零后摘除 Dubbo。但要先评估是不是该用 Dubbo 3.x——它已支持应用级注册、Triple 协议、Nacos 集成，升级比全量迁 SCA 成本低很多。治理用 Sentinel 统一管理（Dubbo 和 SCA 都接），规则不用迁。

### 反问面试官

> 贵司是 Dubbo 2.x 还是 3.x？迁移目标是全量 SCA 还是 Dubbo Spring Cloud 共存？注册中心是 ZK 还是已上 Nacos？这决定我聊迁移路径还是升级路径。

## 八、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么一定要迁 SCA，不能继续用 Dubbo？ | 先反问目标：是为了统一 Spring Cloud 生态（Feign/Gateway/Sentinel 原生集成）？还是 Dubbo 2.x 有维护风险？如果只是升级，Dubbo 3.x 更划算（应用级注册 + Triple + Nacos）。SCA 迁移成本高，要证明收益覆盖成本 |
| 证据追问 | 你怎么证明迁移后行为没变？ | traceId 对账：同一请求在 Dubbo 和 Feign 路径的耗时、错误码对比。核心指标：service_error_rate（Feign 不高于 Dubbo 基线）、rpc_p99（Feign 不显著高于 Dubbo）、retries_count（重试次数一致） |
| 边界追问 | 迁移期间能保证 100% 不出问题吗？ | 不能。注册中心抖动、治理规则漏迁、协议差异都可能导致局部失败。兜底是灰度 + 回滚开关（配置中心秒级切回 Dubbo）。迁移期 service_error_rate 设阈值（如 +0.5%），超阈值自动告警人工介入 |
| 反例追问 | 什么情况不该迁 SCA？ | Dubbo 2.x 运行稳定无维护压力、团队无 SCA 经验、调用链全是内部 Dubbo（无外部 REST 需求）、QPS 低到协议差异无感。这时迁是过度设计，先升级 Dubbo 3.x |
| 风险追问 | 迁移期最大风险？ | 治理规则漏迁导致雪崩。Dubbo timeout=1s，Feign 漏配 readTimeout 默认 60s，一个慢依赖线程池耗尽全站雪崩。上线前用 diff 工具逐条对比治理规则，压测验证 Feign 超时行为与 Dubbo 一致 |
| 验证追问 | 怎么证明治理规则等价迁移了？ | 每条规则上线后，注入故障（如给下游加延迟），看 Feign 是否在 timeout 内快速失败（与 Dubbo 一致）、retries 是否符合预期、fallback 是否触发。用 Chaos Engineering 验证 |
| 沉淀追问 | 团队迁移规范沉淀什么？ | 迁移 checklist（双注册验证、治理规则对照表、灰度节奏）、Provider 双暴露代码模板、FeignConfig 等价配置模板、Sentinel 统一治理接入文档、迁移期监控大盘（dubbo_invoke_count + feign_invoke_count 对比） |

### 现场对话示例

**面试官**：Dubbo 迁 SCA，治理规则怎么保证不漏？

**候选人**：逐条对照迁移。先把 Dubbo 所有的治理配置梳理出来——@DubboService/@DubboReference 上的 timeout、retries、loadbalance、mock，还有外置的 Sentinel 规则、Dubbo Filter（traceId、鉴权）。然后逐条对应到 SCA：timeout 对应 Feign 的 Request.Options（readTimeout），retries 对应 Feign 重试策略或 Sentinel，mock 对应 Feign fallback，Filter 对应 Spring Interceptor。最关键是 Feign 默认 readTimeout 是 60s（比 Dubbo 长 60 倍），如果漏配，一个慢依赖直接把 Feign 线程池打满雪崩。上线前用自动化 diff 工具对比两边规则数量和参数，再压测注入延迟验证超时行为一致。

**面试官**：双注册期间消费端会不会混乱？

**候选人**：会，要隔离。双注册是 Provider 同时注册到 ZK 和 Nacos，但消费端不能同时订阅两个注册中心（否则负载均衡混乱）。方案是消费端按版本部署——旧消费端只订阅 ZK 走 Dubbo，新消费端只订阅 Nacos 走 Feign。用流量标签（如 version=v1 走 Dubbo、version=v2 走 Feign）在网关层路由，保证同一用户只走一条路径。灰度期间监控两条路径的 service_error_rate，新路径不高于旧路径才放量。

**面试官**：如果 Nacos 挂了怎么办？

**候选人**：Nacos 是 SCA 的强依赖，挂了消费端拿不到实例。三层兜底：第一，消费端本地缓存实例列表（Spring Cloud LoadBalancer 有缓存，Nacos 客户端也有本地快照文件），Nacos 挂了短时间能用缓存。第二，Nacos 集群高可用（至少 3 节点，跨 AZ）。第三，Nacos 挂了切回 Dubbo + ZK（回滚开关，配置中心秒级切 useFeign=false）。迁移期间 ZK 不能先下，作为兜底注册中心，等 Nacos 稳定运行 1-2 个月再下 ZK。

## 常见考点

1. **Dubbo 和 Feign 区别？**——Dubbo 是 RPC（私有 TCP 协议、接口级注册、长连接、低延迟），Feign 是 HTTP 客户端（REST、应用级注册、每次建连或连接池、生态广）。内部高性能用 Dubbo，对外或生态丰富用 Feign。
2. **为什么 Dubbo 3.x 可能比迁 SCA 好？**——Dubbo 3.x 已支持应用级注册（与 SCA 一致）、Triple 协议（HTTP/2）、原生 Nacos 集成、与 Spring Cloud 生态融合（Dubbo Spring Cloud）。升级比全量迁移成本低，且能复用 Dubbo 成熟治理能力。
3. **迁移期双注册怎么做？**——Provider 同时暴露 Dubbo（@DubboService）和 REST（@RestController），注册到 ZK 和 Nacos。消费端按版本部署，旧版走 Dubbo+ZK，新版走 Feign+Nacos，网关用流量标签隔离。
4. **治理规则漏迁会怎样？**——最典型是 timeout。Dubbo 默认 1s，Feign 默认 60s。漏配会让慢依赖耗尽线程池引发雪崩。每条规则要逐条对照迁移 + 压测验证。
5. **注册中心怎么平滑切换？**——先 Dubbo 注册中心从 ZK 切 Nacos（Dubbo 3.x 原生支持），再框架迁移。注册中心先行降低风险。过渡期可双注册中心（分号分隔），最后摘除 ZK。

## 结构化回答

**30 秒电梯演讲：** Dubbo 到 SCA（Spring Cloud Alibaba）的迁移本质是通信协议（Dubbo TCP vs HTTP/Feign）+ 注册发现（Zookeeper/Nacos）+ 治理能力（Dubbo SPI vs SCA 生态）三件事的切换。风险不在框架本身，而在迁移过程中新老框架并存调用、注册中心数据不一致、治理规则失效三类问题

**展开框架：**
1. **Dubbo** — 私有 TCP 协议（默认 dubbo 协议）、接口级注册（每个方法注册到 ZK/Nacos）、SPI 扩展强
2. **SCA** — HTTP/Feign（或 Dubbo Spring Cloud 两种都行）、应用级注册（Spring Cloud LoadBalancer）、生态广
3. **迁移三大风险** — 注册中心数据不一致（双注册中心同步）、治理规则失效（超时/重试/限流配置迁移）、新老并存调用混乱

**收尾：** 以上是我的整体思路。您想继续深入聊——为什么不直接用 Dubbo 3.x 而要迁 SCA？


## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：Dubbo 到 Spring Cloud Ali | "这题核心是——Dubbo 到 SCA（Spring Cloud Alibaba）的迁移本质是通信协议（Dubbo……" | 开场钩子 |
| 0:15 | Dubbo示意/对比图 | "私有 TCP 协议（默认 dubbo 协议）、接口级注册（每个方法注册到 ZK/Nacos）、SPI 扩展强" | Dubbo要点 |
| 0:40 | SCA示意/对比图 | "HTTP/Feign（或 Dubbo Spring Cloud 两种都行）、应用级注册（Spring Cloud LoadBalancer）、生态广" | SCA要点 |
| 1:25 | 总结卡 | "记住：迁移四阶段。下期见。" | 收尾 |
