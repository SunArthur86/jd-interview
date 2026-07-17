---
id: java-architect-037
difficulty: L2
category: java-architect
subcategory: 可观测性
tags:
- Java 架构师
- 可观测性
- Tracing
- 指标
feynman:
  essence: 可观测性三件套是"指标（Metrics，聚合数字）+ 日志（Logs，离散事件）+ 链路（Traces，请求路径）"，三者通过 traceId/exemplar 串联。指标看"有没有问题"、日志看"发生了什么"、链路看"在哪里、为什么"。
  analogy: 像 JD 医院急诊：指标是"体温/血压/心率"监护仪（每秒一个数字，异常报警）、日志是"病历"（每件事件的详细记录）、链路是"病人就诊路径"（从分诊→化验→CT→医生的完整调用链）。三者结合才能诊断病因。
  first_principle: 分布式系统一个请求要经过 N 个服务，单看一个服务的日志/指标无法定位问题。需要跨服务的关联视图——traceId 串联整条链路，exemplar 串联指标和链路，结构化日志串联日志和 traceId。三者各有所长，缺一不可。
  key_points:
  - Metrics：聚合数字（QPS、P99、错误率），低成本高频采集，适合告警
  - Logs：离散事件（结构化 JSON），高保真但高成本，适合排查
  - Traces：请求路径（span 树），跨服务关联，适合定位瓶颈
  - traceId/exemplar 是三者串联的纽带
  - 三者采集成本差异大：指标 KB 级、日志 MB 级、链路 KB 级（采样）
first_principle:
  problem: 分布式系统一个请求经过 N 个服务，如何用最小成本做到"出了问题能定位到根因"？
  axioms:
  - 单服务视角不够（问题可能在上下游）
  - 全量采集太贵（日志/链路 PB 级存储）
  - 不同信号有不同擅长：指标适合告警、日志适合排查、链路适合定位
  rebuild: 三件套分工——Metrics 做聚合数字（QPS/P99/错误率），低成本全量采集，用于大盘监控和告警；Logs 做结构化事件（JSON 带 traceId），按需采样或全量，用于排查具体问题；Traces 做请求路径（span 树），按采样率采集（如 1%），用于定位瓶颈服务。三者通过 traceId 关联，形成"指标报警 → 链路定位服务 → 日志看详情"的排查链路。
follow_up:
  - 三件套采样率怎么定？——Metrics 全量（聚合数据成本低）、Traces 采样（1%-10%，全量太贵）、Logs 按级别（ERROR 全量、WARN 采样、DEBUG 关）。可动态调整（异常时临时全量）
  - traceId 怎么跨服务透传？——HTTP 用 traceparent/tracestate 头（W3C 标准）、消息队列放消息属性、线程池用 TTL（TransmittableThreadLocal）透传
  - OpenTelemetry 和 SkyWalking 区别？——OpenTelemetry 是 CNCF 标准（厂商中立），SkyWalking 是 Apache 项目（APM 平台）。OpenTelemetry 是采集标准，SkyWalking 是后端实现之一
  - 日志和指标冲突吗？——不冲突，互补。指标是从日志/事件聚合而来（如错误率从错误日志数算）。可观测性建设成熟后，日志、指标、链路统一采集（OpenTelemetry）
  - 排查一个问题用哪件套？——先看指标定位"有没有问题 + 影响面"、再看链路定位"在哪个服务"、最后看日志定位"具体什么错"
memory_points:
  - Metrics 看有没有问题（聚合数字、告警）
  - Logs 看发生了什么（结构化、带 traceId）
  - Traces 看在哪里为什么（span 树、跨服务）
  - traceId 串联三件套，exemplar 串联指标和链路
  - 采集成本：Metrics 全量、Traces 采样 1%-10%、Logs 按级别
---

# 【Java 后端架构师】日志、指标、链路追踪三件套怎么建设

> 适用场景：JD 核心技术。大促期间一个下单请求经过网关、订单、库存、营销、支付、风控等 10+ 服务，出问题时光看单服务日志无法定位。架构师必须能设计三件套采集方案、用 traceId 串联、用指标告警、用链路定位瓶颈。

## 一、概念层：三件套的分工与互补

**三种信号的对比**（这张表面试必问）：

| 信号 | 数据形式 | 采集成本 | 擅长 | 不擅长 |
|------|---------|---------|------|--------|
| **Metrics（指标）** | 聚合数字（QPS、P99、错误率） | 低（KB/秒） | 大盘监控、告警、趋势分析 | 具体事件、根因 |
| **Logs（日志）** | 离散事件（结构化 JSON） | 高（MB/请求） | 详细排查、审计、合规 | 实时聚合、跨服务关联 |
| **Traces（链路）** | 请求路径（span 树） | 中（KB/请求，采样） | 跨服务定位、瓶颈分析 | 全量数据（采样丢失） |

**排查路径**（三件套配合）：

```
1. 指标告警："order_service error_rate > 5%"
        │
        ▼
2. 链路定位："看异常请求的 trace，发现卡在 inventory_service 的 DB 调用 800ms"
        │
        ▼
3. 日志详情："查 inventory_service 的 ERROR 日志，DB 连接池满"
        │
        ▼
4. 根因："连接池配置太小（max=50），峰值不够用"
```

**三者关联机制**：

```
Metrics ──exemplar──> Traces
  (QPS 突增点带 exemplar 引用具体 trace)
Logs ──traceId──> Traces
  (每条日志带 traceId，可查整条链路)
Traces ──spanId──> Logs
  (每个 span 带 spanId，可查该 span 的日志)
```

## 二、机制层：Metrics 指标建设

**Prometheus 四种指标类型**（必背）：

| 类型 | 用途 | 例子 |
|------|------|------|
| **Counter（计数器）** | 单调递增 | http_requests_total（总请求数） |
| **Gauge（仪表）** | 可增可减 | jvm_threads_alive（当前线程数） |
| **Histogram（直方图）** | 分桶统计分布 | http_request_duration_seconds（P99 延迟） |
| **Summary（摘要）** | 客户端算分位 | http_request_duration_seconds{quantile="0.99"} |

**为什么 Histogram 比 Summary 好**：Histogram 在服务端（Prometheus）聚合分位，多个实例可合并算 P99；Summary 在客户端算分位，跨实例无法合并。生产用 Histogram。

**Spring Boot + Micrometer + Prometheus 代码**：

```java
// application.yml
management:
  endpoints:
    web:
      exposure:
        include: health,info,prometheus,metrics
  metrics:
    tags:
      application: order_service   # 全局标签
    distribution:
      percentiles-histogram:
        http.server.requests: true   # 启用 Histogram
      slo:
        http.server.requests: 50ms, 100ms, 200ms, 500ms, 1s, 2s   # SLO 分桶

// 自定义业务指标
@Service
public class OrderService {

    final Counter orderCounter;
    final Timer orderTimer;
    final Gauge inventoryGauge;

    public OrderService(MeterRegistry registry) {
        this.orderCounter = Counter.builder("order.created.total")
            .tag("type", "normal")
            .description("Orders created")
            .register(registry);

        this.orderTimer = Timer.builder("order.create.duration")
            .publishPercentiles(0.5, 0.95, 0.99)
            .register(registry);

        this.inventoryGauge = Gauge.builder("inventory.level", () -> getInventory())
            .register(registry);
    }

    public Order createOrder(OrderDTO dto) {
        return orderTimer.record(() -> {
            Order order = doCreate(dto);
            orderCounter.increment();
            return order;
        });
    }
}
```

**Prometheus 抓取配置**：

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'order_service'
    metrics_path: '/actuator/prometheus'
    static_configs:
      - targets: ['order-1:8080', 'order-2:8080']
    scrape_interval: 15s     # 抓取间隔

  - job_name: 'inventory_service'
    metrics_path: '/actuator/prometheus'
    static_configs:
      - targets: ['inventory:8080']
```

**关键业务指标（RED/USE 黄金信号）**：

```
RED（服务视角）：
  Rate：requests_per_second（QPS）
  Errors：error_rate（错误率）
  Duration：latency_p99（P99 延迟）

USE（资源视角）：
  Utilization：cpu_usage、memory_usage、disk_usage
  Saturation：thread_pool_active、db_connection_active
  Errors：gc_count、oom_count
```

## 三、机制层：Traces 链路追踪

**OpenTelemetry 标准化**（必懂，CNDC 标准）：

```java
// OpenTelemetry SDK 配置
@Resource OTel otel;

public void placeOrder(OrderDTO dto) {
    Span span = otel.tracer("order_service").spanBuilder("placeOrder")
        .setSpanKind(SpanKind.INTERNAL)
        .setAttribute("order.userId", dto.getUserId())
        .setAttribute("order.amount", dto.getAmount().toString())
        .startSpan();

    try (Scope scope = span.makeCurrent()) {
        // 业务逻辑
        Order order = createOrder(dto);
        deductInventory(order);    // 内部调用，自动产生子 span
        notifyMarketing(order);    // HTTP 调用，自动透传 traceId
        span.setStatus(StatusCode.OK);
    } catch (Exception e) {
        span.recordException(e);
        span.setStatus(StatusCode.ERROR, e.getMessage());
        throw e;
    } finally {
        span.end();
    }
}
```

**Span 树结构**：

```
Trace (traceId = abc123)
└── Span: placeOrder (service=order, duration=350ms)
    ├── Span: createOrder (service=order, duration=50ms, db.insert)
    ├── Span: deductInventory (service=inventory, duration=80ms)
    │   └── Span: db.update (duration=60ms, sql=UPDATE inventory)
    └── Span: notifyMarketing (service=marketing, duration=200ms)
        └── Span: http.post (duration=180ms, url=/marketing/notify)
```

**traceId 跨服务透传**（W3C Trace Context 标准）：

```http
# HTTP 请求头（W3C traceparent 格式）
GET /marketing/notify HTTP/1.1
traceparent: 00-abc123-def456-01
# 格式：version-traceid-parentid-flags
#       00    -abc123 -def456 -01

# 消息队列（RocketMQ 消息属性）
msg.putUserProperty("traceparent", "00-abc123-def456-01");

# 线程池透传（TransmittableThreadLocal）
ExecutorService executor = TtlExecutors.getTtlExecutorService(originalExecutor);
```

**采样策略**（控制成本关键）：

```java
// OpenTelemetry 采样配置
Sampler sampler = Sampler.traceIdRatioBased(0.01);   // 1% 采样
// 或自定义采样（错误必采、慢请求必采）
Sampler sampler = Sampler.parentBased(new CustomSampler());

// 自定义采样器：错误和慢请求全采，正常采样 1%
public class CustomSampler implements Sampler {
    public SamplingResult shouldSample(...) {
        if (isError || duration > 500) return recordAndSample();
        return traceIdRatioBased(0.01).shouldSample(...);
    }
}
```

## 四、机制层：Logs 结构化日志

**结构化日志模板**（JSON 格式，带 traceId）：

```java
// logback-spring.xml 配置 JSON 输出
<configuration>
    <appender name="JSON" class="ch.qos.logback.core.ConsoleAppender">
        <encoder class="net.logstash.logback.encoder.LogstashEncoder">
            <includeMdcKeyName>traceId</includeMdcKeyName>
            <includeMdcKeyName>spanId</includeMdcKeyName>
            <customFields>{"app":"order_service"}</customFields>
        </encoder>
    </appender>
</configuration>

// 业务代码（MDC 自动注入 traceId）
@Slf4j
@Service
public class OrderService {
    public Order createOrder(OrderDTO dto) {
        MDC.put("orderId", dto.getOrderId());   // 业务字段
        log.info("create order userId={} amount={}", dto.getUserId(), dto.getAmount());
        // 输出 JSON：
        // {"timestamp":"...","level":"INFO","logger":"...","traceId":"abc123",
        //  "spanId":"def456","orderId":"ORD001","message":"create order userId=U001 amount=99.5"}
    }
}
```

**日志级别策略**：

| 级别 | 采集 | 适用 |
|------|------|------|
| ERROR | 全量 | 业务异常、系统错误（必须告警） |
| WARN | 全量 | 可恢复异常、降级触发（关注） |
| INFO | 全量 | 关键业务事件（订单创建、支付成功） |
| DEBUG | 默认关、动态开 | 调试用（通过开关临时启用） |
| TRACE | 几乎不开 | 极细粒度（性能开销大） |

**日志成本控制**（生产必备）：

```java
// 1. 异步日志（不阻塞业务线程）
<appender name="ASYNC" class="ch.qos.logback.classic.AsyncAppender">
    <queueSize>1024</queueSize>
    <neverBlock>true</neverBlock>      <!-- 队列满丢弃（不阻塞业务） -->
    <appender-ref ref="JSON" />
</appender>

// 2. 日志采样（高频日志按比例采集）
@LogSampled(rate = 0.01)   // 1% 采样
public void logAccess(Request req) {
    log.info("access {}", req.getPath());
}

// 3. 动态日志级别（运行时调整，不改代码）
// 通过 Spring Boot Actuator /loggers 端点动态调整
curl -X POST http://app:8080/actuator/loggers/com.jd.order \
  -H "Content-Type: application/json" \
  -d '{"configuredLevel":"DEBUG"}'
```

## 五、实战层：可观测性建设全栈架构

**JD 风格可观测性架构**：

```
应用层（Java 服务）
  ├── Micrometer（采集 Metrics）──> Prometheus ──> Grafana 大盘
  ├── OpenTelemetry SDK（采集 Traces）──> OT Collector ──> Jaeger/SkyWalking
  └── Logback JSON（采集 Logs）──> Filebeat ──> Kafka ──> ES ──> Kibana

串联机制：
  traceId 贯穿三层（日志带 traceId、链路有 traceId、指标通过 exemplar 关联 traceId）
```

**Grafana 大盘配置**（RED 黄金信号）：

```
Row 1：业务概览
  - QPS（rate(http_server_requests_seconds_count[1m])）
  - 错误率（rate(http_server_requests_seconds_count{status=~"5.."}[1m]) / rate(http_server_requests_seconds_count[1m])）
  - P99 延迟（histogram_quantile(0.99, rate(http_server_requests_seconds_bucket[1m]))）

Row 2：JVM 监控
  - 堆内存使用（jvm_memory_used_bytes{area="heap"}）
  - GC 次数（rate(jvm_gc_pause_seconds_count[1m])）
  - 线程数（jvm_threads_live_threads）

Row 3：资源饱和度
  - DB 连接池（hikaricp_connections_active / hikaricp_connections_max）
  - 线程池（executor_active_threads）
  - 下游调用 RT（http_client_requests_seconds）
```

**告警规则**（Prometheus AlertManager）：

```yaml
groups:
  - name: order_service
    rules:
      - alert: HighErrorRate
        expr: |
          rate(http_server_requests_seconds_count{app="order_service",status=~"5.."}[5m])
          / rate(http_server_requests_seconds_count{app="order_service"}[5m]) > 0.05
        for: 2m
        labels: { severity: critical }
        annotations:
          summary: "Order service error rate > 5%"
          description: "Current rate: {{ $value }}"

      - alert: HighLatencyP99
        expr: |
          histogram_quantile(0.99, rate(http_server_requests_seconds_bucket{app="order_service"}[5m])) > 0.5
        for: 5m
        labels: { severity: warning }
```

## 六、底层本质：为什么是三件套而非一个统一系统

回到第一性：**三种信号的本质是"聚合 vs 离散 vs 关联"三种数据形态**。

**为什么 Metrics 必须独立**：指标是聚合数字（QPS = 1秒请求总数），体积小（KB/秒）、采集便宜、适合时序数据库（Prometheus）。如果把每个请求都存为日志再聚合算 QPS，存储和计算成本爆炸（万级 QPS × 86400 秒 = 8亿条日志/天）。Metrics 的本质是"用聚合换成本"——丢掉个体信息保留统计特征。

**为什么 Logs 不能用 Metrics 替代**：指标告诉你"错误率 5%"，但不告诉你"具体哪个用户、什么参数、什么异常堆栈"。日志是离散事件的高保真记录，排查具体问题必须看日志。代价是体积大（MB/请求），所以不能全量长期保存（一般保留 7-30 天）。

**为什么 Traces 不能用 Logs 替代**：每个服务都有自己的日志，跨服务关联靠 traceId 手动 grep 又慢又容易断。Traces 把整条链路（span 树）预先关联好，一个请求经过哪些服务、每个服务耗时多少，一目了然。代价是采集成本（span 数据 KB/请求），所以必须采样（一般 1%-10%）。

**串联是关键**：单独看任何一个信号都是"盲人摸象"。traceId 是串联三件套的纽带——指标通过 exemplar 引用具体 trace（"这个 P99 突增点的具体 trace 是哪个"），日志带 traceId（"这条错误日志属于哪个请求"），链路的 span 带 spanId（"这个 span 对应哪些日志"）。三者结合才能"指标报警 → 链路定位 → 日志看详情"。

**采集成本的取舍**：Metrics 全量（便宜）、Logs 按级别（ERROR/WARN 全量，DEBUG 关）、Traces 采样（1%-10%，异常必采）。这套取舍让总成本可控，又能保证关键问题可排查。

## 七、AI 架构师加问：5 个 AI 相关问题

1. **AI 推理服务的可观测性怎么建设？**
   Metrics 采集推理 QPS、延迟（P99 GPU 推理耗时）、GPU 利用率、显存占用、模型版本。Traces 记录请求经过预处理 → 推理 → 后处理的全链路。Logs 记录推理失败的具体输入和模型版本。新增指标：tokens_per_second（吞吐）、cost_per_request（成本）。

2. **让 AI 自动归因线上故障，AI 接管哪段？**
   AI 解析告警 + 关联 trace + 分析日志，分类根因（DB 慢、下游超时、GC 抖动、代码 bug）。AI 出归因报告（根因假设 + 证据链 + 建议），人工确认后执行。AI 不直接改代码或配置，但可以推荐修复 PR。

3. **AI Agent 工具调用如何用 traceId 串联？**
   每次 tool_call 生成子 span（tool_name、参数、耗时、结果），traceId 贯穿整个 Agent 会话。可观测性看板能看到"用户问题 → AI 推理 → 工具调用 → 结果回写"全链路，定位慢工具或失败工具。

4. **AI RAG 系统的可观测性怎么设计？**
   Metrics：retrieval_recall@k（召回率）、generation_latency（生成延迟）、token_cost（成本）。Traces：查询 → embedding → 向量检索 → LLM 生成全链路。Logs：检索的 doc 列表、LLM 的 prompt 和 response（用于调试幻觉）。

5. **AI 日志分析如何发现异常？**
   AI 分析历史日志模式（正常基线），实时检测异常模式（错误突增、新错误类型、异常堆栈）。比规则告警更智能（能发现未知异常模式），但有误报。监控 AI 的 false_positive_rate，过高回退到规则告警。

## 八、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"Metrics 看有没有、Logs 看发生了什么、Traces 看在哪里、traceId 串联"**。

- **Metrics**：聚合数字（QPS/P99/错误率），Prometheus + Grafana，全量采集低成本
- **Logs**：结构化 JSON 带 traceId，ELK 栈，ERROR 全量 DEBUG 关
- **Traces**：span 树跨服务，OpenTelemetry + Jaeger，采样 1%-10%
- **串联**：traceId 贯穿三层，exemplar 关联指标和链路
- **排查路径**：指标告警 → 链路定位服务 → 日志看详情

### 拟人化理解

把可观测性想成 **JD 医院急诊系统**。指标是监护仪（体温/血压/心率，每秒一个数字，异常报警）——便宜、连续、用于发现"有没有问题"。日志是病历（每件事件的详细记录）——详细但贵，用于"具体发生了什么"。链路是就诊路径（分诊→化验→CT→医生，完整流程）——跨科室关联，用于"在哪个环节卡住"。traceId 是病人身份证号，三个系统用同一 ID 串联。

### 面试现场 60 秒回答

> 可观测性三件套分工：Metrics 聚合数字（QPS/P99/错误率）做大盘监控和告警，Prometheus + Grafana 全量采集成本低；Logs 结构化 JSON 带 traceId 做详细排查，ELK 栈 ERROR 全量 DEBUG 关；Traces span 树跨服务定位瓶颈，OpenTelemetry + Jaeger 采样 1%-10%。三者通过 traceId 串联，形成"指标告警 → 链路定位 → 日志详情"排查链路。traceId 跨服务透传用 W3C traceparent 头，跨线程用 TransmittableThreadLocal。采集成本权衡：Metrics 全量、Logs 按级别、Traces 采样（异常必采）。

### 反问面试官

> 贵司可观测性是自建还是用云服务？三件套是否统一采集（OpenTelemetry）还是各自独立？Traces 采样率多少？这决定我建设方案的侧重点。

## 九、苏格拉底式面试追问

每一问先回答"为什么"，再"怎么做"，最后"如何证明"。

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不只用日志，要搞三件套？ | 日志跨服务关联难（grep traceId 慢且易断）、无聚合视图（算 QPS 要扫所有日志）、采集成本高（全量日志 PB 级）。Metrics 低成本聚合告警、Traces 跨服务定位，分工互补。证明：只用日志排查一个问题要 grep N 个服务 + 手动算延迟分布，三件套秒级定位 |
| 证据追问 | 怎么证明 traceId 真的跨服务串联了？ | 在入口注入 traceId，依次经过 A→B→C 服务，用 Jaeger 看是否一棵 span 树。日志按 traceId 过滤，应该看到 N 个服务的日志都属于同一 traceId |
| 边界追问 | 三件套能解决所有排查问题吗？ | 不能。业务逻辑 bug（如计算错误）要看代码；JVM 层问题（OOM、GC）要 dump 分析；网络问题要抓包。三件套主要解决"性能和链路"问题，逻辑问题靠测试和 code review |
| 反例追问 | 什么场景不上 Traces？ | 内部简单服务（< 3 个调用）、成本敏感（Traces 采集和存储贵）、实时性要求极高的场景（采样会丢数据）。强链路追踪需求才上 |
| 风险追问 | 可观测性建设的最大风险？ | ① 采集本身影响业务性能（日志同步写阻塞、SDK 自身开销）；② 成本失控（Traces 全量 PB 级存储）；③ 数据不一致（traceId 没透传、时钟不同步）。治法：异步日志、采样控制、NTP 时钟同步 |
| 验证追问 | 怎么证明三件套真的能用？ | 定期故障演练（注入延迟、杀服务），看能否在三件套中定位根因；统计线上问题的平均定位时间（MTTR），应 < 10 分钟；告警准确率（误报率 < 5%） |
| 沉淀追问 | 团队可观测性规范沉淀什么？ | 指标命名规范（service_method_status）、必采指标清单（RED + USE）、日志结构化 JSON 模板、traceId 透传规范、Grafana 大盘模板、告警阈值 SOP |

### 现场对话示例

**面试官**：traceId 怎么跨服务透传？

**候选人**：用 W3C Trace Context 标准。HTTP 请求在 header 里带 traceparent（格式：version-traceid-spanid-flags），下游服务的 OpenTelemetry SDK 自动解析并继承 traceId，产生子 span。跨消息队列（如 RocketMQ）把 traceparent 放消息属性（userProperty），消费端解析后继承。跨线程（线程池）用 TransmittableThreadLocal（TTL）透传 MDC，避免 InheritableThreadLocal 在线程池复用时丢失。整套机制由 OpenTelemetry SDK 自动完成，业务代码无感知。

**面试官**：日志和链路冲突吗？

**候选人**：不冲突，互补。日志记录业务事件（"订单创建成功 orderId=123"），链路记录调用路径（"placeOrder → createOrder → db.insert"）。两者通过 traceId 关联——每条日志带 traceId（MDC 注入），每个 span 有 spanId。排查时先看链路定位卡在哪个服务，再用 traceId 查该服务的日志看具体错误。OpenTelemetry 推荐日志和链路统一采集，日志 SDK 自动注入 traceId/spanId 到 MDC，无需业务代码处理。

**面试官**：Traces 采样率怎么定？

**候选人**：权衡成本和可观测性。一般 1%-10% 采样——正常流量采样足够看到性能趋势，异常流量必须全采。用 parentBased 采样：根 span 采样率决定整条 trace 是否采，避免半截 trace。更精细的用自定义采样器——错误必采（status=ERROR 的 trace 全采）、慢请求必采（duration > 500ms 全采）、正常流量 1% 采样。这样既控制成本又保证关键问题不丢。采样率可通过配置中心动态调整，故障期间临时提到 100% 采样。

## 常见考点

1. **三种信号区别？**——Metrics 聚合数字（QPS/P99，低成本全量）、Logs 离散事件（结构化 JSON，高成本按级别）、Traces 请求路径（span 树，采样）。三者通过 traceId 串联。
2. **traceId 怎么跨服务透传？**——HTTP 用 W3C traceparent 头、消息队列放消息属性、线程池用 TransmittableThreadLocal。OpenTelemetry SDK 自动处理。
3. **采样率怎么定？**——正常流量 1%-10% 采样，错误和慢请求必采。parentBased 保证 trace 完整。可动态调整，故障期间临时全采。
4. **OpenTelemetry 是什么？**——CNCF 可观测性标准（厂商中立），统一采集 Metrics/Logs/Traces。后端可对接 Prometheus/Jaeger/任何厂商。
5. **日志成本怎么控制？**——异步日志（AsyncAppender 不阻塞业务）、按级别采集（ERROR 全量 DEBUG 关）、动态日志级别（Actuator 运行时调整）、日志采样（高频日志按比例）。


## 结构化回答

**30 秒电梯演讲：** 聊到日志、指标、链路追踪三件套怎么建设，我的理解是——可观测性三件套是"指标（Metrics，聚合数字）+ 日志（Logs，离散事件）+ 链路（Traces，请求路径）"，三者通过 traceId/exemplar 串联。指标看"有没有问题"、日志看"发生了什么"、链路看"在哪里、为什么"。打个比方，像 JD 医院急诊：指标是"体温/血压/心率"监护仪（每秒一个数字，异常报警）、日志是"病历"（每件事件的详细记录）、链路是"病人就诊路径"（从分诊→化验→CT→医生的完整调用链）。三者结合才能诊断病因。

**展开框架：**
1. **Metrics** — 聚合数字（QPS、P99、错误率），低成本高频采集，适合告警
2. **Logs** — 离散事件（结构化 JSON），高保真但高成本，适合排查
3. **Traces** — 请求路径（span 树），跨服务关联，适合定位瓶颈

**收尾：** 这块我在项目里也踩过坑——想深入的话，可以接着聊：三件套采样率怎么定？您更想看哪个方向？

## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡 | "日志、指标、链路追踪三件套怎么建设——这道题面试官到底想考什么？我用 30 秒给你讲透。" | 开场钩子 |
| 0:15 | 分布式链路追踪图 | 先说核心：可观测性三件套是"指标（Metrics，聚合数字）+ 日志（Logs，离散事件）+ 链路（Traces，请求路径）"，三者通过 traceId/exemplar 串联。指标看"。 | 核心定义 |
| 0:30 | 概念结构示意图 | 离散事件（结构化 JSON），高保真但高成本，适合排查。 | Logs |
| 1:30 | 总结卡 | 一句话记忆：Metrics 看有没有问题（聚合数字、告警）。 下期可以接着聊：三件套采样率怎么定。 | 收尾总结 |
