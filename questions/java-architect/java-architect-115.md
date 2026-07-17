---
id: java-architect-115
difficulty: L4
category: java-architect
subcategory: 可观测性
tags:
- Java 架构师
- OpenTelemetry
- 分布式追踪
- W3C TraceContext
feynman:
  essence: OpenTelemetry（OTel）是 CNCF 的可观测性统一标准，三件事——Trace（链路）/Metrics（指标）/Logs（日志）的采集 SDK + 数据格式（OTLP 协议）。本质是解决厂商锁定：应用代码只调 OTel API，数据通过 OTLP 协议发到 Collector，Collector 转发到任意后端（Jaeger/Tempo/SkyWalking/Datadog）。换后端不改应用代码。
  analogy: 像 USB-C 标准——设备（应用）只有 USB-C 接口（OTel API），通过转接头（Collector）连到任意显示器（Jaeger/Tempo/SkyWalking）。换显示器不用换设备。
  first_principle: 分布式追踪的本质是"把一次请求在多个服务间的因果关系重建出来"。OTel 用 trace context（W3C traceparent：traceId-spanId-flags）在服务间传播，每个 span 记录一段处理，通过 parentSpanId 串成树。指标和日志共享 traceId，三支柱可联动下钻。
  key_points:
  - OTel 三支柱：Trace / Metrics / Logs（统一标准）
  - W3C TraceContext（traceparent header）跨服务传播
  - Span = 操作单元（traceId + spanId + parentSpanId 串成树）
  - OTLP 协议（gRPC/HTTP）发到 Collector
  - Collector 做转发/采样/脱敏（应用无感）
  - Java Agent 字节码注入（无侵入采集）
first_principle:
  problem: 微服务架构下一次请求穿过 10+ 服务，出问题怎么定位是哪个服务？
  axioms:
  - 每个服务独立日志，没有统一 ID 无法关联
  - 追踪要重建"调用链"（谁调谁、耗时多少、哪里慢）
  - 不同监控后端（Jaeger/SkyWalking）格式不兼容，厂商锁定
  rebuild: "OTel 定义三件事统一标准。① API：应用调 OTel API 创建 span（traceId/spanId/parentSpanId）。② 传播：W3C TraceContext（traceparent: 00-{traceId}-{spanId}-{flags}）在 HTTP header/gRPC metadata/MQ 消息属性间透传。③ 协议：OTLP 发到 Collector。Collector 做转发/采样/脱敏，推到任意后端。Java 用 Agent 字节码注入（无侵入给 HTTP/JDBC/Redis 加 span），业务代码零改动。"
follow_up:
  - OTel 和 SkyWalking / Jaeger 区别？——OTel 是标准（API+协议），SkyWalking/Jaeger 是后端（存储+UI）。OTel 替代各家私有 SDK，后端可切换
  - "W3C TraceContext 长啥样？——`traceparent: 00-{version}-{traceId-32hex}-{spanId-16hex}-{flags-2hex}`。traceId 全局唯一，spanId 本地唯一，flags 控制采样"
  - 采样策略？——头部采样（TraceIDRatio，按比例，简单但可能漏关键）/尾部采样（Collector 决策，可保留全错误链路，但需缓存全链路）
  - Java Agent 原理？——Instrumentation API 在类加载时改字节码，给 HTTP client/server、JDBC、Kafka 等加 span 创建逻辑。业务代码无感
  - 三支柱怎么联动？——Metrics 告警 → 通过 exemplar 关联 trace → trace 看慢在哪 → traceId 关联 logs 看具体日志
memory_points:
  - OTel 是 CNCF 可观测性统一标准（Trace/Metrics/Logs）
  - W3C TraceContext：traceparent header 跨服务传播
  - Span = traceId + spanId + parentSpanId（串成树）
  - OTLP 协议发到 Collector，Collector 转发任意后端
  - Java Agent 字节码注入（无侵入）
  - 采样：头部（TraceIDRatio）vs 尾部（Collector 决策）
  - 三支柱联动：Metrics → Exemplar → Trace → Logs
---

# 【Java 后端架构师】OpenTelemetry 在 Java 微服务中的落地

> 适用场景：JD 核心技术。订单服务下单链路穿过网关、订单、库存、支付、券、风控 6 个服务，P99 抖动无法定位。架构师必须用 OpenTelemetry 建立统一分布式追踪，让一次请求的调用链可视化，且可切换后端（Jaeger → Tempo）不改代码。

## 一、概念层：OpenTelemetry 的三支柱与传播机制

**OpenTelemetry 是什么**：

```
应用（OTel API + SDK）
   │  OTLP（gRPC/HTTP）
   ▼
OTel Collector（转发/采样/脱敏/批处理）
   │
   ┌──────────┬──────────┬──────────┬──────────┐
   ▼          ▼          ▼          ▼          ▼
Jaeger/Tempo  Prometheus  Loki/ES   SkyWalking  Datadog
（Trace）     （Metrics）  （Logs）   （全栈）    （SaaS）
```

**OTel 三支柱**（这张表面试必问）：

| 支柱 | 数据模型 | 解决问题 | 后端示例 |
|------|---------|---------|---------|
| **Trace** | Span（traceId/spanId/parentSpanId） | 调用链定位 | Jaeger / Tempo / Zipkin |
| **Metrics** | Counter/Gauge/Histogram | 大盘监控 + 告警 | Prometheus / Mimir |
| **Logs** | LogRecord（带 traceId） | 具体日志排查 | Loki / Elasticsearch |

**核心概念：Span 的结构**：

```json
{
  "traceId": "abc123...（32 hex，全局唯一）",
  "spanId": "def456...（16 hex，本地唯一）",
  "parentSpanId": "aaa111...",       // 父 span，串成调用树
  "name": "OrderService.createOrder",
  "kind": "SERVER",                  // SERVER/CLIENT/INTERNAL/PRODUCER/CONSUMER
  "startTime": 1690000000000000000,  // 纳秒时间戳
  "endTime": 1690000000123000000,    // 123ms
  "attributes": {                    // 业务标签（可查询）
    "http.method": "POST",
    "http.url": "/orders",
    "http.status_code": 200,
    "orderId": "ORD12345"
  },
  "events": [                        // 事件（日志点）
    {"name": "cache-miss", "timestamp": "..."}
  ],
  "status": {"code": "OK"}           // OK / ERROR
}
```

**W3C TraceContext 传播**：

```http
# HTTP Header（跨服务传播 traceId）
traceparent: 00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01
             │  │                                  │              │
             │  │ traceId（32 hex）                 │ spanId(16hex)│ flags（01=采样）
             │                                    （父 span）     
             version（00）

tracestate: vendor=value,...    # 厂商扩展（可选）
baggage: userId=123,env=prod    # 业务上下文（跨服务透传）
```

## 二、机制层：Java Agent 无侵入接入

**启动方式（推荐 Java Agent）**：

```bash
# Dockerfile
ENV JAVA_TOOL_OPTIONS="-javaagent:/opt/opentelemetry-agent.jar"

# 启动参数
java -javaagent:opentelemetry-javaagent.jar \
     -Dotel.service.name=order-service \
     -Dotel.exporter.otlp.endpoint=http://otel-collector:4317 \
     -Dotel.exporter.otlp.protocol=grpc \
     -Dotel.traces.exporter=otlp \
     -Dotel.metrics.exporter=otlp \
     -Dotel.logs.exporter=otlp \
     -jar order-service.jar
```

**自动埋点的库（Instrumentation 库，零代码改动）**：

| 库 | 自动采集 |
|----|---------|
| Spring MVC / WebFlux | HTTP server span（method/url/status） |
| HttpClient / OkHttp / RestTemplate | HTTP client span |
| JDBC / HikariCP | DB 查询 span（SQL 摘要） |
| Redis Lettuce / Jedis | Redis 命令 span |
| Kafka Producer / Consumer | MQ 消息 span（PRODUCER/CONSUMER） |
| gRPC | gRPC 调用 span |
| MongoDB / Elasticsearch | NoSQL 查询 span |

**手动埋点（业务关键节点）**：

```java
// 方式 1：@WithSpan 注解（推荐）
@WithSpan(value = "createOrder", kind = SpanKind.INTERNAL)
public Order createOrder(
        @SpanAttribute("orderId") String orderId,
        @SpanAttribute("userId") String userId) {
    // 自动创建 span，参数作为 attribute
    return doCreate(orderId, userId);
}

// 方式 2：手动 API
public Order createOrder(String orderId) {
    Tracer tracer = GlobalOpenTelemetry.getTracer("order-service");
    Span span = tracer.spanBuilder("createOrder")
        .setSpanKind(SpanKind.INTERNAL)
        .setAttribute("orderId", orderId)
        .startSpan();

    try (Scope scope = span.makeCurrent()) {
        Order order = doCreate(orderId);
        span.setStatus(StatusCode.OK);
        return order;
    } catch (Exception e) {
        span.recordException(e);           // 记录异常
        span.setStatus(StatusCode.ERROR, e.getMessage());
        throw e;
    } finally {
        span.end();
    }
}

// 添加事件（日志点）
span.addEvent("cache-miss", Attributes.of(
    AttributeKey.stringKey("key"), "order:" + orderId
));

// 添加 baggage（跨服务透传业务上下文）
Baggage.current().toBuilder()
    .put("userId", userId)
    .put("vipLevel", "gold")
    .build()
    .makeCurrent();
```

**Collector 配置（接收 + 处理 + 转发）**：

```yaml
# otel-collector-config.yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch:                              # 批处理（减少请求次数）
    timeout: 5s
    send_batch_size: 1000
  memory_limiter:                     # 内存限流（防 OOM）
    check_interval: 1s
    limit_mib: 512
  attributes:                         # 脱敏（删敏感字段）
    actions:
      - key: http.request.header.authorization
        action: delete
  resource:                           # 加全局标签
    attributes:
      - key: deployment.environment
        value: prod
        action: upsert
  tail_sampling:                      # 尾部采样
    policies:
      - name: errors                  # 保留所有错误链路
        type: status_code
        status_code:
          status_codes: [ERROR]
      - name: slow                    # 保留慢请求（> 1s）
        type: latency
        latency:
          threshold_ms: 1000
      - name: random                  # 10% 随机采样
        type: probabilistic
        probabilistic:
          sampling_percentage: 10

exporters:
  otlp/jaeger:                        # Trace 发 Jaeger
    endpoint: jaeger:4317
    tls:
      insecure: true
  prometheusremotewrite:              # Metrics 发 Prometheus
    endpoint: http://mimir:9009/api/v1/push
  loki:                               # Logs 发 Loki
    endpoint: http://loki:3100/loki/api/v1/push

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, attributes, resource, tail_sampling, batch]
      exporters: [otlp/jaeger]
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, resource, batch]
      exporters: [prometheusremotewrite]
    logs:
      receivers: [otlp]
      processors: [memory_limiter, attributes, batch]
      exporters: [loki]
```

## 三、实战层：下单链路追踪

**链路传播（HTTP → Service → MQ）**：

```
[网关] traceId=A, spanId=1
   │ traceparent: 00-A-1-01
   ▼
[订单服务] traceId=A, spanId=2, parentSpanId=1
   │ HTTP 调用库存
   │ traceparent: 00-A-3-01（生成新 spanId=3）
   ▼
[库存服务] traceId=A, spanId=4, parentSpanId=3
   │ Kafka 发消息
   │ traceparent 注入 Kafka header
   ▼
[券消费者] traceId=A, spanId=5, parentSpanId=（Kafka producer span）
```

**异步上下文传播（关键陷阱）**：

```java
// 陷阱：线程池丢上下文
ExecutorService executor = Executors.newFixedThreadPool(10);
executor.submit(() -> {
    // 这里 traceId 丢了！新线程没有上下文
    orderService.process(orderId);
});

// 正确：用 ContextWrapper 传播
ExecutorService executor = Context.taskWrapping(Executors.newFixedThreadPool(10));
// 或虚拟线程（JDK 21+）自动传播 StructuredTaskScope

// 虚拟线程 + OTel（推荐）
try (var scope = new StructuredTaskScope.ShutdownOnFailure()) {
    var inventory = scope.fork(() -> inventoryService.check(orderId));
    var coupon = scope.fork(() -> couponService.apply(orderId));
    scope.join().throwIfFailed();
    // 子任务自动继承父 traceId
}
```

**MQ 消息传播（Kafka）**：

```java
// Producer（OTel 自动注入 traceparent 到 header）
kafkaTemplate.send("order-events", orderEvent);
// 实际消息 header 包含：traceparent: 00-{traceId}-{spanId}-01

// Consumer（OTel 自动从 header 提取 traceId，创建 CONSUMER span）
@KafkaListener(topics = "order-events")
public void consume(OrderEvent event) {
    // 自动有 traceId，和 Producer 是一条链路
    processEvent(event);
}
```

**慢请求定位（从大盘到根因）**：

```
1. Metrics 告警：订单 P99 从 200ms 涨到 800ms
2. Exemplar 关联：点 Metrics 上的 exemplar → 跳到具体 trace
3. Trace 查看：调用树显示
   ┌─ gateway (10ms)
   ├─ order-service.createOrder (800ms)        ← 慢在这
   │   ├─ jdbc SELECT inventory (5ms)
   │   ├─ http POST coupon-service (780ms)     ← 罪魁！
   │   │   └─ jdbc SELECT coupon (770ms)       ← 缺索引
   │   └─ kafka send (5ms)
4. Logs 关联：通过 traceId 查 coupon-service 日志
   → 看到 "SELECT * FROM coupon WHERE code=? AND status=1" 慢
5. 根因：coupon 表缺 (code, status) 联合索引，加索引 → P99 恢复
```

## 四、底层本质：为什么是 OTel

回到第一性：**为什么不是各家私有 SDK（SkyWalking / Jaeger client / Zipkin client）？**

- **厂商锁定问题**：用 SkyWalking client 后想换 Jaeger，要改所有服务的代码。OTel 是 CNCF 标准，换后端只改 Collector 配置，应用零改动。
- **三支柱统一**：Trace/Metrics/Logs 三个 SDK 合一，共享 traceId/resource，三支柱可联动（点 Metrics 跳 Trace，点 Trace 看 Logs）。
- **W3C TraceContext 标准化**：traceparent 是 W3C 标准，跨语言（Java/Go/Python/Node）跨服务（HTTP/gRPC/MQ）统一格式。不是 OTel 私有，Brave（Zipkin）也支持。

**尾部采样 vs 头部采样的本质**：
- **头部采样（TraceIDRatio）**：入口决定是否采样。简单、资源省。但随机决定，可能漏掉关键错误链路（采样率 10%，10% 错误链路被采，90% 漏）。
- **尾部采样（Collector 决策）**：全链路完成后，Collector 看结果决定。可"保留所有错误链路 + 保留慢请求 + 10% 随机"。代价是 Collector 要缓存全链路（内存大）。
- **生产实践**：TraceIDRatio=100%（全采），Collector 尾部采样降负载。或头部 10% + Collector 尾部补全错误链路。

**Java Agent 字节码注入的本质**：
- `Instrumentation` API（`premain`/`agentmain`）在类加载时拦截，改字节码。
- OTel Agent 给 `HttpURLConnection.connect()` 前后插入 `span.start()`/`span.end()`。
- 业务代码零改动——这就是"无侵入"。代价是启动慢 1-2 秒（类加载时改字节码）。

**为什么 OTel 没有存储/UI**：
- OTel 定位是"采集 + 协议标准"，不做存储和 UI（避免和后端厂商竞争）。
- 存储和 UI 交给后端（Jaeger/Tempo/SkyWalking）。
- 这样后端厂商才会支持 OTel 协议（不会被 OTel 干掉）。

## 五、AI 架构师加问：5 个

1. **AI 推理链路的 trace 怎么设计？**
   每个 AI 调用一个 span：LLM 调用（model/version/prompt_tokens）、RAG 检索（vector_db/query）、tool_call（tool_name/duration）。串联成"用户提问 → 检索 → LLM → tool → LLM → 回答"。attribute 记录 tokens/latency/cost，便于分析单次推理成本和瓶颈。

2. **AI 能自动分析 trace 找异常吗？**
   AI 学习历史 trace 模式（正常调用树结构、耗时分布），检测异常：① 调用树结构异常（多了个意外的下游）；② 单 span 耗时突增（比历史 P99 慢 5 倍）；③ 错误率突升（某服务开始报错）。AI 给异常 trace 打标 + 关联可能根因（哪个 span 异常 + 可能原因）。

3. **大模型 RAG 链路的 trace 关键 span？**
   `embed_query`（query 向量化）→ `vector_search`（向量检索，记录 top_k/score）→ `rerank`（重排）→ `prompt_build`（组装 prompt，记录 context 长度）→ `llm_call`（LLM 推理，记录 tokens/latency）→ `response_parse`。每个 span 的 attribute 有 token 数、score、context 长度，定位"是检索质量差还是 LLM 慢"。

4. **AI Agent 多轮对话的 trace 怎么组织？**
   顶层 span：conversation_turn（一轮对话）。子 span：think（LLM 推理）→ action（tool_call）→ observation（执行结果）→ think（下一轮）→ ... → answer。用 parentSpanId 串成树，attribute 记录 iteration_count（防止死循环）、tool_call_chain。跨轮的对话用 conversationId 关联（baggage 透传）。

5. **AI 怎么做 trace 异常归因？**
   AI 分析异常 trace：① 找出耗时占比 > 50% 的 span（瓶颈定位）；② 对比正常 trace 的相同路径（这个 span 比正常慢 X 倍）；③ 关联该 span 服务的其他信号（同时段 GC、CPU、DB 慢查询）；④ 输出归因报告："coupon-service.jdbc SELECT 慢，因 coupon 表缺索引，建议加 (code,status) 联合索引"。

## 六、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"三支柱、W3C、Span 树、Agent、采样、三联动"**。

- **三支柱**：Trace（调用链）/Metrics（指标）/Logs（日志）
- **W3C TraceContext**：traceparent header（traceId-spanId-flags）跨服务传播
- **Span 树**：traceId（全局）+ spanId（本地）+ parentSpanId（父）串成调用树
- **Agent**：Java Agent 字节码注入（Instrumentation API），无侵入给 HTTP/JDBC/MQ 加 span
- **采样**：头部（TraceIDRatio 比例）/尾部（Collector 看结果，保留错误链路）
- **三联动**：Metrics → Exemplar → Trace → traceId 关联 Logs

### 拟人化理解

把 OTel 想成**快递追踪系统的统一接口**。寄一个包裹（一次请求）经过多个中转站（服务），每个中转站扫一次条码（创建 span），条码上有单号（traceId）和中转站编号（spanId）。W3C TraceContext 就是条码格式标准——所有快递公司（语言/服务）用同样的条码。OTel Collector 是快递分拣中心，可以决定哪些包裹详细记录（采样）、转给哪个目的地（后端）。换目的地（后端）不用改寄件人（应用代码）。

### 面试现场 60 秒回答

> OpenTelemetry 是 CNCF 的可观测性统一标准，三支柱：Trace（链路）/Metrics（指标）/Logs（日志）。核心是 W3C TraceContext——traceparent header（traceId-spanId-flags）跨服务传播，每个 span 记录一段处理，通过 parentSpanId 串成调用树。Java 用 Agent 字节码注入（Instrumentation API），无侵入给 HTTP/JDBC/Kafka 加 span，业务代码零改动。数据通过 OTLP 协议发到 Collector，Collector 做采样/脱敏/转发到任意后端（Jaeger/Tempo/SkyWalking），换后端不改应用代码。采样策略：头部（TraceIDRatio 按比例）简单但可能漏关键错误，尾部（Collector 看结果，保留所有错误 + 慢请求 + 随机）更智能。三支柱联动：Metrics 告警 → Exemplar 关联 trace → trace 看慢在哪 → traceId 关联 logs 看具体日志。

### 反问面试官

> 贵司追踪后端是 Jaeger/Tempo/SkyWalking 还是自研？全量采集还是采样？这决定我聊 Collector 尾部采样还是 Agent 头部采样。

## 七、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 已经有日志和指标，为什么还要 Trace？ | 指标告诉你"有问题"（P99 高），日志告诉你"具体什么错"，Trace 告诉你"问题在哪条链路、哪个服务、哪一步"。没有 Trace 无法定位分布式问题 |
| 证据追问 | 怎么证明 OTel 接入有效？ | ① 核心服务 100% 接入；② 调用链完整率 > 95%（trace 跨服务不中断）；③ MTTR 从小时级降到分钟级；④ Exemplar 关联率（Metrics 可下钻 Trace）> 80% |
| 边界追问 | OTel 能解决所有可观测性问题吗？ | 不能。JVM 问题要 dump + JFR；网络问题要抓包；性能热点要 profile；业务逻辑要看代码。OTel 主要解决"分布式链路定位 + 三支柱联动" |
| 反例追问 | 什么场景不要上 OTel？ | 单体应用（日志足够）、内部工具、研发阶段。OTel 有性能开销（Agent 1-3% CPU）+ 存储成本（后端存储），ROI 低不要上 |
| 风险追问 | OTel 最大风险？ | ① 上下文传播断（线程池/MQ 没传播 traceId，链路断）；② 采样配置不当（采太少漏关键错误）；③ 敏感信息泄露（trace 里带 token/密码）。治法：Context.taskWrapping、尾部采样保留错误、attributes 脱敏 |
| 验证追问 | 怎么验证 trace 完整？ | ① 入口和最终服务 traceId 一致；② 每个下游调用都有对应 CLIENT 和 SERVER span；③ 错误链路 100% 保留（尾部采样验证）；④ Exemplar 能跳转 trace |
| 沉淀追问 | 团队规范沉淀什么？ | ① 接入 SOP（Agent + 配置）；② Span 命名规范（service.action）；③ 业务关键 span 手动埋点清单；④ 采样策略（错误全采 + 慢请求 + 10% 随机）；⑤ 脱敏规则 |

### 现场对话示例

**面试官**：OTel 和 SkyWalking 区别？要替换吗？

**候选人**：OTel 是标准（API + OTLP 协议 + 三支柱），SkyWalking 是后端（存储 + UI + 告警）。OTel 不是要替代 SkyWalking，而是替代各家私有 SDK。SkyWalking 8+ 已支持 OTLP 协议接收——可以用 OTel Agent 采集 + SkyWalking 后端存储。迁移路径：Agent 换 OTel（统一），后端保留 SkyWalking（保护存储投资）。新项目直接 OTel + Tempo/Jaeger。

**面试官**：Java Agent 原理？对性能影响多大？

**候选人**：Java Agent 用 Instrumentation API，在 JVM 启动时（premain）或运行时（agentmain）拦截类加载。OTel Agent 给目标类（如 HttpURLConnection）字节码插入 span 创建逻辑。性能开销：① 启动慢 1-2 秒（类加载时改字节码）；② 运行时 1-3% CPU（每个 span 创建/序列化）；③ 内存增加（span 缓存）。可以通过采样降负载。生产实测 5000 QPS 服务开销 < 3% CPU。

**面试官**：异步场景（线程池/MQ）traceId 怎么不断？

**候选人**：三个陷阱。① 线程池：用 `Context.taskWrapping(executor)` 包装，子任务自动继承上下文。② 虚拟线程：JDK 21+ 自动传播（StructuredTaskScope）。③ MQ：OTel 自动把 traceparent 注入 Kafka header（Producer）和提取（Consumer），无需手动。如果用原生 Thread 不包装，traceId 会丢——这是最常见的链路断原因。

## 常见考点

1. **OpenTelemetry 是什么？**——CNCF 可观测性统一标准（Trace/Metrics/Logs），解决厂商锁定。应用调 OTel API，OTLP 协议发 Collector，转发任意后端。
2. **W3C TraceContext？**——traceparent: 00-{traceId-32hex}-{spanId-16hex}-{flags}，跨服务传播 traceId。
3. **Java Agent 原理？**——Instrumentation API 字节码注入，类加载时给 HTTP/JDBC/MQ 加 span，业务无感。
4. **头部采样 vs 尾部采样？**——头部（TraceIDRatio 入口按比例，简单可能漏错误）；尾部（Collector 看结果，保留错误+慢请求，需缓存全链路）。
5. **三支柱联动？**——Metrics → Exemplar → Trace（看链路）→ traceId 关联 Logs（看日志）。告警到根因一条线下钻。

## 结构化回答

**30 秒电梯演讲：** OpenTelemetry（OTel）是 CNCF 的可观测性统一标准，三件事——Trace（链路）/Metrics（指标）/Logs（日志）的采集 SDK + 数据格式（OTLP 协议）。本质是解决厂商锁定：应用代码只调 OTel API，数据通过 OTLP 协议发到 Collector，Collector 转发到任意后端（Jaeger/Tempo/SkyWalking/Datadog）。换后端不改应用代码

**展开框架：**
1. **OTel 三支柱** — Trace / Metrics / Logs（统一标准）
2. **W3C TraceCon** — W3C TraceContext（traceparent header）跨服务传播
3. **Span = 操作单元** — Span = 操作单元（traceId + spanId + parentSpanId 串成树）

**收尾：** 以上是我的整体思路。您想继续深入聊——OTel 和 SkyWalking / Jaeger 区别？


## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：OpenTelemetry 在 Java 微服务 | "这题核心是——OpenTelemetry（OTel）是 CNCF 的可观测性统一标准，三件事——Trace（链路）……" | 开场钩子 |
| 0:15 | 像 USB-C 标准——设备（应用）只有 USB类比图 | "打个比方：像 USB-C 标准——设备（应用）只有 USB。" | 核心类比 |
| 0:40 | OTel 三支柱示意/对比图 | "Trace / Metrics / Logs（统一标准）" | OTel 三支柱要点 |
| 1:05 | W3C TraceCon示意/对比图 | "W3C TraceContext（traceparent header）跨服务传播" | W3C TraceCon要点 |
| 1:30 | Span = 操作单元示意/对比图 | "Span = 操作单元（traceId + spanId + parentSpanId 串成树）" | Span = 操作单元要点 |
| 1:55 | 总结卡 | "记住：OTel 是 CNCF 可观。下期见。" | 收尾 |
