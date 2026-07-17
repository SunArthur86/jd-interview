---
id: java-architect-129
difficulty: L3
category: java-architect
subcategory: 微服务
tags:
- Java 架构师
- gRPC
- 流式
- 背压
feynman:
  essence: gRPC 流式接口（Server/Client/Bidi Streaming）让服务端可以持续推、客户端可以持续拉，但当下游消费速度 < 上游生产速度时，缓冲区会无限膨胀直至 OOM。背压（Backpressure）的本质是"让下游的反向压力传给上游"——下游处理慢就让上游慢点发。gRPC 用 HTTP/2 flow control（WINDOW_UPDATE 帧）做传输层背压，应用层用 Reactor/Flowable 的 `request(n)` 机制做语义背压。超时控制要分"流整体超时"和"单消息超时"，流式场景整体超时用 deadline，单消息超时用 per-message timeout。
  analogy: 像水龙头接水池。客户端是水池，服务端是水龙头。如果水池出水口（消费）慢，水龙头还猛灌，水池溢出（OOM）。背压是水池满了通过水管把压力反向传给水龙头，让它自动关小。HTTP/2 flow control 是水管里内置的压力传感器，Reactors 是水池主动喊"再给我 100 升就够了"。
  first_principle: 为什么 gRPC 流式比 REST 更需要背压？REST 是请求-响应模型，每次请求独立，慢了就超时；流式是长连接持续推，单条连接的内存压力随时间累积。如果不做背压，一个慢消费者会把服务端内存吃光。
  key_points:
  - 四种 gRPC 模式：Unary（一元）、Server Streaming、Client Streaming、Bidi Streaming
  - HTTP/2 flow control：每个 stream 有 send/recv window，消费后 WINDOW_UPDATE 补
  - 应用层背压：Reactor 的 limitRate(n)、Flowable 的 request(n)
  - 超时三档：deadline（流整体）、per-RPC timeout、per-message timeout
  - gRPC keepalive 检测假死连接（idle ping、activity ping）
first_principle:
  problem: gRPC 流式接口如何防止慢消费者拖垮服务端，同时保证快速消费者的吞吐？
  axioms:
  - 流式接口的内存压力随消息速率和消费速率的差值线性累积
  - HTTP/2 内置 flow control 可以做传输层背压，但应用层缓冲可能绕过它
  - 慢消费者不能用"断开连接"粗暴处理（业务可能希望降级而非失败）
  rebuild: HTTP/2 flow control 在传输层兜底（窗口耗尽自动暂停发送），应用层用 Reactor 的 `limitRate(100)` 控制向 HTTP/2 写入速率，下游慢则 Reactor backpressure 传到上游。超时用 deadline-on 流（如 30s）配 per-message timeout（如 5s），超过则取消流并清理资源。keepalive ping 检测假死连接，10s idle 关闭释放资源。
follow_up:
  - HTTP/2 flow control 怎么工作？——每个 stream 有发送/接收窗口（默认 65535 字节），发送方扣窗口，接收方消费后 WINDOW_UPDATE 补。窗口耗尽则发送方暂停。WINDOW_UPDATE 太小会导致停-等，建议设大（如 1MB）。
  - Reactor 的 onBackpressureBuffer/Drop/Latest 区别？——Buffer 攒到上限后 OverflowStrategy 决定：DROP 丢最新、LATEST 留最新丢旧、ERROR 抛异常。流式场景一般 DROP 或 LATEST（避免 OOM）。
  - gRPC 怎么实现"流整体超时"？——客户端用 `withDeadlineAfter(30, SECONDS)`，服务端用 `onCancel` 回调清理资源；超时后客户端收到 DEADLINE_EXCEEDED。
  - bidi streaming 怎么处理半连接？——客户端 close write 但还读，服务端检测 `onComplete` 后继续发，最后也 close。Spring gRPC 用 `StreamObserver.onCompleted()` 触发。
  - 大消息体怎么办？——gRPC 默认单消息 4MB 上限（maxInboundMessageSize），大消息建议分片成 streaming 或用 out-of-band（如传 S3 URL）。
memory_points:
  - 四种模式：Unary/Server Stream/Client Stream/Bidi Stream
  - HTTP/2 flow control + Reactor backpressure 双层背压
  - 超时：deadline-on 流（30s）+ per-message（5s）+ keepalive（10s idle ping）
  - maxInboundMessageSize 默认 4MB，大消息分片或 out-of-band
  - 慢消费者策略：DROP/LATEST/限速，不能 Buffer 无限
---

# 【Java 后端架构师】gRPC 流式接口的背压与超时控制

> 适用场景：JD 核心技术。京东实时风控用 gRPC bidi streaming 推用户行为事件流给下游模型推理服务，单连接每秒 1 万条消息。当模型服务 GC 抖动消费变慢时，风控端缓冲区快速膨胀到 OOM，导致整个风控链路雪崩。背压治理 + 三档超时控制让风控端能在下游慢时自动降速、超时主动断开释放资源。

## 一、概念层

**gRPC 四种调用模式**：

| 模式 | 客户端 | 服务端 | 典型场景 |
|------|--------|--------|---------|
| **Unary** | 1 请求 | 1 响应 | 普通 RPC（替代 REST） |
| **Server Streaming** | 1 请求 | N 响应 | 订阅、推送、大结果分页 |
| **Client Streaming** | N 请求 | 1 响应 | 上传、批量、聚合 |
| **Bidi Streaming** | N 请求 | N 响应 | 聊天、实时事件、协同 |

**为什么流式需要背压**：

```
无背压（OOM 灾难）：
  服务端生产 10000 msg/s ──► 网络缓冲 ──► 客户端消费 1000 msg/s
                                          │
                                          ▼
                            缓冲区每秒积累 9000 msg，10 秒后 OOM

有背压（自动降速）：
  服务端生产 10000 msg/s ──► Reactor.limitRate(1000) ──► 客户端消费 1000 msg/s
                                          │
                                          ▼
                            Reactor 检测下游慢，向上游传 backpressure，生产降到 1000 msg/s
```

## 二、机制层：proto 流式定义

**proto 文件**（必背）：

```protobuf
syntax = "proto3";

package jd.risk;

option java_package = "com.jd.risk.grpc";
option java_multiple_files = true;

service RiskEventService {
  // Server Streaming：客户端订阅，服务端持续推
  rpc SubscribeEvents(SubscribeRequest) returns (stream RiskEvent);

  // Client Streaming：客户端批量上传，服务端聚合返回
  rpc UploadBehaviors(stream UserBehavior) returns (UploadSummary);

  // Bidi Streaming：双向流（实时风控）
  rpc StreamRisk(stream UserBehavior) returns (stream RiskDecision);
}

message SubscribeRequest {
  string user_id = 1;
  repeated string event_types = 2;
}

message RiskEvent {
  string event_id = 1;
  string user_id = 2;
  string event_type = 3;
  int64 timestamp = 4;
  map<string, string> payload = 5;
}

message UserBehavior {
  string user_id = 1;
  string action = 2;
  int64 timestamp = 3;
}

message RiskDecision {
  string user_id = 1;
  bool blocked = 2;
  string reason = 3;
  float risk_score = 4;
}
```

## 三、机制层：背压处理代码

**服务端 Server Streaming + Reactor 背压**：

```java
// 服务端：用 Reactor 模式（grpc-reactor）
@Service
public class RiskEventServiceImpl extends RiskEventServiceGrpc.RiskEventServiceImplBase {

    @Autowired private RiskEventFluxService eventFluxService;

    @Override
    public Flux<RiskEvent> subscribeEvents(SubscribeRequest request) {
        // limitRate：向下游每次只请求 100 条，下游消费完才请求下一批
        return eventFluxService.subscribe(request.getUserId())
            .limitRate(100)                              // 背压核心：每次 request(100)
            .onBackpressureLatest()                      // 慢消费者：保留最新，丢旧的
            .timeout(Duration.ofSeconds(5))              // 单消息超时
            .doOnCancel(() -> log.info("Client disconnected"))
            .doOnError(e -> log.error("Stream error", e));
    }
}

// 配置 gRPC server
@Bean
public Server grpcServer() throws IOException {
    return ServerBuilder.forPort(9090)
        .addService(InProcessServerBuilderFactory.forName("risk"))
        .maxInboundMessageSize(16 * 1024 * 1024)         // 单消息上限 16MB
        .keepAliveTime(10, TimeUnit.SECONDS)             // 10s 没活动发 ping
        .keepAliveTimeout(5, TimeUnit.SECONDS)           // ping 5s 没回关闭连接
        .maxConnectionAge(30, TimeUnit.MINUTES)          // 连接最大 30 分钟，强制重连负载均衡
        .maxConnectionAgeGrace(5, TimeUnit.SECONDS)      // 优雅关闭窗口
        .build()
        .start();
}
```

**客户端 Server Streaming 消费**：

```java
// 客户端：用 Flux 消费，背压传到服务端
@Service
public class RiskEventClient {

    @GrpcClient("risk-service")
    private ReactorRiskEventServiceGrpc.ReactorRiskEventServiceStub stub;

    public void consume(String userId) {
        SubscribeRequest req = SubscribeRequest.newBuilder()
            .setUserId(userId)
            .addAllEventTypes(List.of("LOGIN", "PAY"))
            .build();

        stub.withDeadlineAfter(30, TimeUnit.SECONDS)     // 流整体超时 30s
            .subscribeEvents(req)
            .limitRate(50)                                // 客户端背压：每次 request(50)
            .concatMap(this::processEvent)                // 串行处理（避免并发抢资源）
            .doOnNext(e -> metrics.recordProcessed())
            .onBackpressureLatest()                       // 处理慢时保留最新
            .subscribe(
                event -> log.info("Processed {}", event.getEventId()),
                error -> log.error("Stream failed", error),
                () -> log.info("Stream completed")
            );
    }

    private Mono<Void> processEvent(RiskEvent event) {
        return Mono.fromRunnable(() -> {
            // 业务处理
            riskDecisionService.decide(event);
        }).subscribeOn(Schedulers.boundedElastic()).then();
    }
}
```

**Bidi Streaming 双向流背压**（最复杂）：

```java
@Override
public Flux<RiskDecision> streamRisk(Flux<UserBehavior> requestFlux) {
    return requestFlux
        .limitRate(100)                                   // 接收侧背压
        .concatMap(this::evaluate)                        // 风控推理
        .limitRate(100)                                   // 发送侧背压
        .onBackpressureLatest();
}

// 客户端
public Flux<RiskDecision> streamRisk(Flux<UserBehavior> behaviors) {
    return stub.streamRisk(behaviors.limitRate(100))     // 客户端发送也限速
        .limitRate(100);                                   // 接收侧限速
}
```

## 四、机制层：三档超时控制

**超时三档对比**（必背）：

| 超时类型 | 设置方式 | 作用 |
|---------|---------|------|
| **流整体 deadline** | `withDeadlineAfter(30, SECONDS)` | 整个流不超过 30s，超时取消流 |
| **单消息 timeout** | Reactor `.timeout(Duration.ofSeconds(5))` | 5s 没收到下一条消息触发超时 |
| **keepalive** | server `keepAliveTime(10s)` + `keepAliveTimeout(5s)` | 10s 没活动 ping，5s 没回 pong 关连接 |

**为什么需要三档**：
- deadline：防止僵尸流占用连接（如客户端崩溃但 TCP 没断）
- per-message timeout：检测处理卡顿（如某条消息触发了慢查询）
- keepalive：检测网络假死（如 NAT 表过期但 TCP 状态机不知道）

**服务端超时配置**：

```java
// 完整服务端配置
Server server = ServerBuilder.forPort(9090)
    .addService(service)
    // 单消息大小限制
    .maxInboundMessageSize(16 * 1024 * 1024)             // 16MB
    // 流控窗口（HTTP/2 flow control）
    .flowControlWindow(1024 * 1024)                       // 1MB 接收窗口
    // keepalive
    .keepAliveTime(10, TimeUnit.SECONDS)                  // 10s idle 发 ping
    .keepAliveTimeout(5, TimeUnit.SECONDS)                // ping 5s 没回关连接
    .permitKeepAliveTime(30, TimeUnit.SECONDS)            // 客户端最短 ping 间隔
    .permitKeepAliveWithoutCalls(true)                    // 允许无 active stream 时 ping
    // 连接生命周期
    .maxConnectionAge(30, TimeUnit.MINUTES)               // 30min 强制断开（负载均衡）
    .maxConnectionAgeGrace(5, TimeUnit.SECONDS)           // 5s 优雅窗口
    .maxConcurrentCallsPerConnection(100)                 // 单连接并发上限
    .build();
```

**客户端超时配置**：

```java
ManagedChannel channel = ManagedChannelBuilder
    .forAddress("risk-service.jd.com", 9090)
    .usePlaintext()                                       // 内网不用 TLS
    .keepAliveTime(10, TimeUnit.SECONDS)
    .keepAliveTimeout(5, TimeUnit.SECONDS)
    .keepAliveWithoutCalls(true)
    .defaultLoadBalancingPolicy("round_robin")
    .maxInboundMessageSize(16 * 1024 * 1024)
    .build();

// 流整体 deadline
ReactorRiskEventServiceGrpc.ReactorRiskEventServiceStub stub =
    ReactorRiskEventServiceGrpc.newStub(channel)
        .withDeadlineAfter(30, TimeUnit.SECONDS)
        .withCompression("gzip");                          // 大消息压缩
```

## 五、实战层/选型：背压策略选型

**Reactor onBackpressureXxx 对比**：

| 策略 | 行为 | 适用 |
|------|------|------|
| `BUFFER` | 无限缓冲（默认） | 不会用，必 OOM |
| `BUFFER(max)` | 缓冲到上限，超了 OverflowStrategy | 突发流量，可容忍丢失 |
| `DROP` | 丢最新到达的 | 慢消费者场景，丢最新无所谓 |
| `LATEST` | 保留最新丢旧的 | 实时监控、行情，关注最新值 |
| `ERROR` | 抛异常 | 强一致场景，宁可失败不可丢 |

**JD 风控实战选型**：
- 实时风控流：`onBackpressureLatest()`（关注最新行为，旧的没意义）
- 行为审计流：`onBackpressureBuffer(100000).onBackpressureDrop()`（缓冲兜底，超了丢，告警）
- 交易事件流：`onBackpressureError()`（强一致，宁可失败不能丢）

**背压策略可视化**：

```
上游 10000 msg/s ──► limitRate(100) ──► Reactor 内部缓冲 100 ──► 下游 1000 msg/s
                          │                      │
                          ▼                      ▼
                  upstream 降到 1000       缓冲永远不超过 100
                  (Reactor 反向 pull)      onBackpressureLatest 保留最新
```

## 六、底层本质：HTTP/2 flow control 与 Reactor 的协作

回到第一性：**gRPC 背压有两层——HTTP/2 传输层 flow control + Reactor 应用层 backpressure**。

- **HTTP/2 flow control**：每个 stream 有发送/接收窗口（默认 65535 字节），发送方扣窗口，接收方消费后 WINDOW_UPDATE 补。窗口耗尽则发送方暂停。这是 TCP 之上的应用层流控，gRPC 框架自动处理。
- **Reactor backpressure**：用 `limitRate(n)` 控制向上游 request 的数量。下游消费慢，Reactor 不向上游 request，上游自然不发——这是 push 转 pull 的语义。
- **两层协作**：HTTP/2 flow control 兜底（窗口耗尽自动停），Reactor 提供语义控制（limitRate、onBackpressureXxx）。如果只依赖 HTTP/2 flow control，发送方会在内存里 buffer 待发数据；Reactor 在 buffer 之前就 throttle。

**背压传到上游的本质**：传统 push 模型（如 Kafka consumer）消费速度靠 max.poll.records 等参数控制；Reactor 用 `request(n)` 让下游主动告诉上游"再给我 n 个"，把控制权交给下游。这种 pull-based 模型让背压精准传递。

**为什么不用断开连接粗暴处理**：流式场景下，慢消费者断开会导致业务中断（如风控订阅断开）。背压让慢消费者继续在但降速，业务可以降级（如风控降级为只看高风险事件）。这是"柔性"治理。

## 七、AI 架构师加问：5 个

1. **LLM 流式推理（如 chat completion）用 gRPC bidi 还是 SSE？**
   LLM 流式输出用 SSE/HTTP streaming 更通用（浏览器支持、CDN 友好）；内部推理引擎间（router → inference）用 gRPC bidi（多路复用、背压、低延迟）。两者职责不同。

2. **LLM 推理慢，背压怎么传到 token 生成器？**
   客户端 SSE 消费慢 → TCP receive buffer 满 → 服务端 socket write 阻塞 → gRPC/SSE 框架检测到 backpressure → Reactor `limitRate` 暂停向 vLLM 拉 token。整条链路天然背压传导。

3. **Agent 调 gRPC 流式接口，超时怎么设？**
   Agent 一般有"思考超时"和"工具调用超时"两档。gRPC 流整体 deadline 设为工具调用超时（如 60s），per-message timeout 设为单 token 响应超时（如 5s）。Agent 框架（如 LangGraph）的 timeout 必须覆盖 gRPC deadline。

4. **用 LLM 自动诊断 gRPC 流式 OOM？**
   LLM 读 heap dump + gRPC metric（pending streams、message size、flow control window），识别模式（如"100 个 client 慢消费导致 buffer 膨胀"），推荐调参（maxInboundMessageSize 调小、limitRate 调小、maxConnectionAge 调短）。

5. **LLM Agent 调 gRPC 用 streaming 还是 unary？**
   优先 unary（简单、易调试）。只有需要持续推送（如 Agent 订阅事件流）才用 streaming。Agent 工具调用通常是一次性 RPC，streaming 反而复杂化（Agent 要管理 stream 生命周期）。

## 八、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"四种模式、双层背压、三档超时"**。

- **四种模式**：Unary / Server Stream / Client Stream / Bidi Stream
- **双层背压**：HTTP/2 flow control（传输层）+ Reactor limitRate（应用层）
- **三档超时**：deadline（流整体 30s）+ per-message timeout（5s）+ keepalive（10s idle ping）
- **onBackpressureXxx**：DROP/LATEST/ERROR，按业务选
- **maxInboundMessageSize** 默认 4MB，大消息分片

### 拟人化理解

把 gRPC 流式想成**水管输水**。客户端是水池，服务端是水龙头。Unary 是接一杯水（一次性），Server Streaming 是水龙头持续灌（订阅），Bidi 是双向水管（聊天）。HTTP/2 flow control 是水管内置的压力传感器（窗口耗尽自动关阀），Reactor limitRate 是水池主动喊"给我 100 升就够了"。三档超时：deadline 是"30 秒必须灌完"，per-message 是"5 秒没下滴水断水"，keepalive 是"10 秒没动静 ping 一下确认水管没破"。

### 面试现场 60 秒回答

> 我们实时风控用 gRPC bidi streaming 推用户行为事件流。背压两层——HTTP/2 flow control 在传输层兜底（窗口耗尽自动暂停），应用层用 Reactor `limitRate(100)` 控制 pull 节奏，下游慢消费时 Reactor 不向上游 request，上游自然停推。慢消费者策略按业务选：实时风控用 onBackpressureLatest（关注最新行为），审计流用 Buffer+Drop（缓冲兜底），交易流用 ERROR（不能丢）。超时三档：流整体 deadline 30s（防僵尸流）+ 单消息 timeout 5s（检测卡顿）+ keepalive 10s idle ping（防假死）。maxConnectionAge 30min 强制重连做负载均衡。这套组合让我们扛住了下游 GC 抖动场景，OOM 再没出现过。

### 反问面试官

> 贵司 gRPC 用哪种模式最多？有没有流式场景？下游慢消费怎么处理？keepalive 配置怎么定的？

## 九、苏格拉底式面试追问（7 层表格 + 现场对话）

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么用 gRPC 流式而不是 REST 轮询？ | 用资源消耗说话：REST 轮询 1000 QPS = 1000 次连接建立 + HTTP 头开销；gRPC 流式 1 个长连接持续推，吞吐 10 倍 + 延迟 1/10。LLM token 流式输出场景尤其明显 |
| 证据追问 | 怎么证明背压生效？ | pending_messages 指标应稳定在 limitRate 上限附近；flow_control_window 不持续缩小（说明客户端在消费）；服务端堆内存不持续增长；下游慢时上游生产速率自动下降 |
| 边界追问 | HTTP/2 flow control 和 Reactor 哪个先触发？ | Reactor 先触发——它在内存 buffer 之前 throttle；HTTP/2 flow control 是兜底，保护 socket buffer。如果绕过 Reactor 直接写 socket，会绕过应用层背压 |
| 反例追问 | 什么场景不用 gRPC 流式？ | 浏览器直连（用 SSE/WebSocket 更通用）、CDN 缓存场景（gRPC 不缓存）、跨语言生态差（Python/PHP gRPC 库不如 Java/Go 成熟） |
| 风险追问 | gRPC 流式最大风险？ | 主动点出：OOM（无背压缓冲膨胀）、僵尸流（无 deadline 占连接）、慢消费者拖垮服务端（无超时）、调试困难（流式 trace 工具不成熟） |
| 验证追问 | 怎么验证三档超时有效？ | 故障演练：注入慢消费者，观察 pending_messages 是否被 limitRate 控制；kill client 模拟崩溃，观察 deadline 是否触发清理；iptables 模拟网络假死，观察 keepalive 是否关闭连接 |
| 沉淀追问 | 团队 gRPC 治理沉淀什么？ | 默认参数模板（maxInboundMessageSize、keepalive、maxConnectionAge）、Reactor 背压策略 SOP、deadline 三档标准、gRPC 监控大盘（pending_streams/flow_window/message_latency） |

### 现场对话示例

**面试官**：bidi streaming 怎么处理"客户端突然断开"？

**候选人**：分两层。传输层，TCP RST/FIN 会触发 gRPC 框架的 `onCancel` 回调，服务端 stream 自动 close。应用层，Reactor 的 `doOnCancel` 钩子可以清理资源（关闭数据库连接、释放锁、记录 metric）。但有个坑——如果客户端是 OOM 崩溃，TCP 可能不立即 RST（处于半连接状态），这时靠 keepalive ping 检测：10s 没活动 ping 一次，5s 没回 pong 判定连接死，服务端主动关闭。所以 keepalive 是兜底。我们的实操：每个 bidi stream 都注册 `doOnCancel` 资源清理 + 流整体 deadline 30s + keepalive，三层保护，确保不会有僵尸流。

**面试官**：Reactor 的 limitRate 是怎么实现背压的？

**候选人**：limitRate(n) 内部是一个 prefetch + 补充机制。下游每次 request(k)，limitRate 拦截后向真正上游 request(2*k)（默认 prefetch 比例 100%），但下游只看到 k 个。下游消费完 k 个再 request 下一个 k。这就实现了"下游主动 pull 上游"的语义。如果下游不 request（处理慢），上游永远等不到 demand，自然不生产。这是 Reactor 把 push 模型转 pull 模型的核心机制。limitRate(100) 意思是"每批向下游推 100 个，下游消费完再推下一批"。

**面试官**：HTTP/2 flow control 窗口耗尽会怎样？

**候选人**：发送方收到零窗口后暂停发送，等接收方 WINDOW_UPDATE 帧补充窗口才能继续。如果接收方一直不补（处理慢），发送方永远停。这看起来像背压，但有坑——发送方在暂停期间会把待发消息 buffer 在内存里（应用层 buffer），如果消息持续产生，应用层 buffer 还是会 OOM。所以 HTTP/2 flow control 只保护 socket buffer，保护不了应用层 buffer。必须配合 Reactor limitRate 在应用层就 throttle，不让消息进入"等待发送"队列。这两层协作才完整。

## 常见考点

1. **gRPC 和 Thrift/Dubbo 区别？**——gRPC 用 HTTP/2 + proto（多路复用、流式、跨语言）；Thrift 是 TCP + binary（更轻但生态弱）；Dubbo 是 Java 生态（功能丰富但跨语言弱）。JD 内部用 gRPC + Dubbo 共存。
2. **gRPC 拦截器（Interceptor）能做什么？**——鉴权、tracing、metric、限流、重试。Client 和 Server 各一套，类似 Servlet Filter。
3. **proto3 和 proto2 区别？**——proto3 移除 required、移除 default value 显式设置、新增 map 类型、原生 JSON 支持。proto3 更简洁但失去一些约束。
4. **gRPC 怎么做服务发现？**——gRPC 内置 NameResolver（DNS、xDS），生产用 Consul/Nacos 自定义 Resolver；负载均衡用 round_robin / pick_first，或 xDS 做 Envoy 控制。
5. **gRPC 错误码有哪些？**——gRPC 用 status code（OK、CANCELLED、DEADLINE_EXCEEDED、UNAVAILABLE...），自定义错误用 `Status.withDescription` + RichError 模式。

## 结构化回答

**30 秒电梯演讲：** gRPC 流式接口（Server/Client/Bidi Streaming）让服务端可以持续推、客户端可以持续拉，但当下游消费速度 < 上游生产速度时，缓冲区会无限膨胀直至 OOM。背压（Backpressure）的本质是让下游的反向压力传给上游——下游处理慢就让上游慢点发。gRPC 用 HTTP/2 flow control（WINDOW_UPDATE 帧）做传输层背压，应用层用 Reactor/Flowable 的 `request(n)` 机制做语义背压。超时控制要分流整体超时和单消息超时，流式场景整体超时用 deadline，单消息超时用 per-message timeout

**展开框架：**
1. **四种 gRPC 模式** — Unary（一元）、Server Streaming、Client Streaming、Bidi Streaming
2. **HTTP/2 flow control** — 每个 stream 有 send/recv window，消费后 WINDOW_UPDATE 补
3. **应用层背压** — Reactor 的 limitRate(n)、Flowable 的 request(n)

**收尾：** 以上是我的整体思路。您想继续深入聊——HTTP/2 flow control 怎么工作？


## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：gRPC 流式接口的背压与超时控制 | "这题核心是——gRPC 流式接口（Server/Client/Bidi Streaming）让服务端可以持续推、客……" | 开场钩子 |
| 0:15 | 像水龙头接水池类比图 | "打个比方：像水龙头接水池。" | 核心类比 |
| 0:40 | 四种 gRPC 模式示意/对比图 | "Unary（一元）、Server Streaming、Client Streaming、Bidi Streaming" | 四种 gRPC 模式要点 |
| 1:05 | HTTP/2 flow示意/对比图 | "每个 stream 有 send/recv window，消费后 WINDOW_UPDATE 补" | HTTP/2 flow要点 |
| 1:55 | 总结卡 | "记住：四种模式。下期见。" | 收尾 |
