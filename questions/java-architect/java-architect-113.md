---
id: java-architect-113
difficulty: L2
category: java-architect
subcategory: 可观测性
tags:
- Java 架构师
- 结构化日志
- traceId
- 日志治理
feynman:
  essence: 结构化日志（JSON）+ traceId 关联是分布式排查的"基础设施"——日志不再是给人读的文本，而是给机器查询的结构化数据。一条 traceId 串起网关、订单、库存、支付 N 个服务的日志，秒级定位"用户 A 的订单为什么失败"。治理核心是 traceId 透传（HTTP/MQ/线程池）+ 日志字段标准化 + 采集成本控制。
  analogy: 像医院病历系统：每个病人有唯一病历号（traceId），所有科室（服务）的检查结果都标这个号。医生输入病历号，立刻看到从分诊 → 化验 → CT → 手术的完整记录。没有病历号，医生只能在 N 个科室的纸质病历里翻找。
  first_principle: 分布式系统一个请求经过 N 个服务，每个服务有自己的日志文件。没有 traceId 关联，定位问题要 grep N 个文件、肉眼拼凑。traceId 让日志"自带关联"，输入一个 ID 就能拉出整条链路的所有日志。
  key_points:
  - 结构化日志：JSON 格式（不是文本），字段标准化（timestamp/level/traceId/logger/msg/...）
  - traceId 透传：HTTP（W3C traceparent）、MQ（消息属性）、线程池（TTL）
  - MDC + Logback JSON encoder 自动注入 traceId
  - 采集成本：异步日志 + 按级别（ERROR 全量、DEBUG 关）
  - 工具：logstash-logback-encoder + ELK / Loki
first_principle:
  problem: 分布式系统一个请求经过 N 个服务，怎么让日志能跨服务关联？
  axioms:
  - 文本日志无法机器解析（grep 慢、字段不固定）
  - 跨服务日志关联需要唯一 ID（traceId）
  - traceId 必须自动透传（业务代码无感）
  rebuild: 三层架构。① 日志格式标准化：JSON 结构化，字段统一（timestamp/level/logger/traceId/spanId/msg/业务字段）；② traceId 自动透传：HTTP 用 W3C traceparent 头、MQ 放消息属性、线程池用 TransmittableThreadLocal；③ 采集成本控制：异步日志（不阻塞业务）+ 按级别采集（ERROR 全量、DEBUG 默认关）+ 采样（高频日志）。traceId 通过 MDC 注入到日志，业务代码零侵入。
follow_up:
  - traceId 怎么生成？——Snowflake 或 UUID。推荐 OpenTelemetry 的 traceId（128 位，W3C 标准）
  - 跨消息队列怎么透传？——RocketMQ 放 msg.getUserProperty("traceparent")，消费端解析后注入 MDC
  - 线程池 traceId 怅失怎么办？——用 TransmittableThreadLocal（TTL）替代 InheritableThreadLocal，配合 TtlExecutors.wrap
  - 日志格式怎么标准化？——logstash-logback-encoder 输出 JSON，自定义字段（app/service/env/version）
  - 日志体积大怎么办？——异步日志（AsyncAppender）+ 按级别采集 + 高频日志采样 + 保留期 7-30 天
memory_points:
  - 结构化日志 = JSON + 标准字段（timestamp/level/traceId/logger/msg）
  - traceId 透传：HTTP（W3C traceparent）、MQ（消息属性）、线程池（TTL）
  - MDC + logstash-logback-encoder 自动注入
  - 异步日志（AsyncAppender）+ 按级别采集 + 高频采样
  - ELK / Loki 存储查询
  - 保留期：ERROR 30 天、WARN 14 天、INFO 7 天、DEBUG 关
---

# 【Java 后端架构师】Spring Boot 结构化日志与 trace 关联

> 适用场景：JD 核心技术。下单失败用户投诉，要查"用户 A 在 10:23:45 的订单为什么失败"。订单服务、库存服务、支付服务各几亿行日志，没有 traceId 关联要 grep N 个文件数小时。结构化日志 + traceId 让排查秒级完成。

## 一、概念层：结构化日志的要素

**文本日志 vs 结构化日志**：

```
文本日志（难解析）：
2026-07-13 10:23:45 INFO  OrderService - create order userId=U001 amount=99.5

结构化日志（JSON，机器可解析）：
{"@timestamp":"2026-07-13T10:23:45.123Z","level":"INFO",
 "logger":"com.jd.OrderService","thread":"http-nio-8080-exec-1",
 "traceId":"abc123def456","spanId":"789abc",
 "userId":"U001","amount":99.5,
 "message":"create order"}
```

**结构化日志的核心字段**（这张表面试必问）：

| 字段 | 用途 | 示例 |
|------|------|------|
| `@timestamp` | ISO-8601 时间戳 | 2026-07-13T10:23:45.123Z |
| `level` | 日志级别 | INFO/WARN/ERROR |
| `logger` | logger 名 | com.jd.OrderService |
| `thread` | 线程名 | http-nio-8080-exec-1 / vt-order-123 |
| `traceId` | 链路 ID（W3C） | abc123def456789abc123def456789ab |
| `spanId` | 跨度 ID | 789abcdef123456 |
| `app` | 应用名 | order-service |
| `env` | 环境 | prod / pre / dev |
| `host` | 主机/容器 | order-pod-abc123 |
| `message` | 日志消息 | create order |
| 业务字段 | 自定义 | userId / orderId / amount |

**traceId 透传的三种场景**：

```
1. HTTP 跨服务
   Gateway → Order → Inventory → Payment
   每个 HTTP 请求带 traceparent 头：00-{traceId}-{spanId}-01

2. 消息队列异步
   Producer → MQ → Consumer
   traceId 放消息属性（userProperty），消费端解析注入 MDC

3. 线程池
   主线程 → 子线程
   InheritableThreadLocal 在线程池复用时会丢失，用 TransmittableThreadLocal
```

## 二、机制层：Logback 配置与 traceId 注入

**logback-spring.xml 配置**（生产级）：

```xml
<configuration>
    <!-- 应用信息 -->
    <property name="APP_NAME" value="order-service"/>
    <property name="ENV" value="${spring.profiles.active:-prod}"/>

    <!-- JSON 结构化输出 -->
    <appender name="JSON" class="ch.qos.logback.core.ConsoleAppender">
        <encoder class="net.logstash.logback.encoder.LogstashEncoder">
            <includeMdcKeyName>traceId</includeMdcKeyName>
            <includeMdcKeyName>spanId</includeMdcKeyName>
            <includeMdcKeyName>userId</includeMdcKeyName>
            <includeMdcKeyName>orderId</includeMdcKeyName>
            <customFields>{"app":"${APP_NAME}","env":"${ENV}"}</customFields>
            <fieldNames>
                <timestamp>@timestamp</timestamp>
                <version>[ignore]</version>
                <levelValue>[ignore]</levelValue>
            </fieldNames>
        </encoder>
    </appender>

    <!-- 异步日志（不阻塞业务线程） -->
    <appender name="ASYNC" class="ch.qos.logback.classic.AsyncAppender">
        <queueSize>1024</queueSize>
        <neverBlock>true</neverBlock>      <!-- 队列满丢弃（不阻塞业务） -->
        <discardingThreshold>0</discardingThreshold>
        <includeCallerData>false</includeCallerData>  <!-- 性能：不获取调用栈 -->
        <appender-ref ref="JSON"/>
    </appender>

    <!-- 异步 + 按级别 -->
    <root level="INFO">
        <appender-ref ref="ASYNC"/>
    </root>

    <!-- 业务包级别控制 -->
    <logger name="com.jd" level="INFO"/>
    <logger name="org.springframework" level="WARN"/>
    <logger name="org.hibernate.SQL" level="WARN"/>   <!-- 生产关 SQL 日志 -->
</configuration>
```

**traceId 自动注入（MDC + Filter）**：

```java
@Component
public class TraceIdFilter extends OncePerRequestFilter {
    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse resp,
                                    FilterChain chain) throws ServletException, IOException {
        // 1. 从 W3C traceparent 头解析（或生成新 traceId）
        String traceparent = req.getHeader("traceparent");
        String traceId, spanId;
        if (traceparent != null) {
            // 格式：00-{traceId}-{spanId}-flags
            String[] parts = traceparent.split("-");
            traceId = parts[1];
            spanId = parts[2];
        } else {
            traceId = generateTraceId();    // 128 位 hex
            spanId = generateSpanId();      // 64 位 hex
        }

        // 2. 注入 MDC（logback 自动输出到日志）
        MDC.put("traceId", traceId);
        MDC.put("spanId", spanId);

        // 3. 响应头也带（方便客户端关联）
        resp.setHeader("traceId", traceId);

        try {
            chain.doFilter(req, resp);
        } finally {
            MDC.clear();    // 必须 clear，防止线程池复用泄漏
        }
    }
}
```

**OpenTelemetry 自动注入（推荐，零侵入）**：

```yaml
# application.yml
spring:
  application:
    name: order-service

# OpenTelemetry Java Agent 自动注入 traceId 到 MDC
# 启动参数：-javaagent:opentelemetry-javaagent.jar
# 自动处理：HTTP / MQ / 线程池 的 traceId 透传
```

**线程池 traceId 透传（TTL）**：

```java
// 反例：线程池 + InheritableThreadLocal 会丢
private static InheritableThreadLocal<String> traceId = new InheritableThreadLocal<>();
// 主线程 set，子线程创建时复制；但线程池复用线程时不会重新复制，复用上一次的值（错乱）

// 修复：TransmittableThreadLocal
private static TransmittableThreadLocal<String> traceId = new TransmittableThreadLocal<>();

// 配合 TtlExecutors 包装线程池
ExecutorService executor = TtlExecutors.getTtlExecutorService(
    Executors.newFixedThreadPool(10)
);
// 子任务自动继承主线程的 traceId

// 或使用 Spring 的 ThreadPoolTaskExecutor 配 TTL
@Configuration
public class ExecutorConfig {
    @Bean
    public TaskExecutor taskExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(10);
        executor.setTaskDecorator(new TtlTaskDecorator<>());   // TTL 包装
        return executor;
    }
}
```

## 三、实战层：跨服务日志关联

**消息队列 traceId 透传**：

```java
// Producer 端
@Component
public class OrderEventProducer {
    public void send(OrderEvent event) {
        Message msg = new Message("order-topic", JSON.toJSONBytes(event));
        // 注入 traceId 到消息属性
        msg.putUserProperty("traceparent",
            "00-" + MDC.get("traceId") + "-" + MDC.get("spanId") + "-01");
        producer.send(msg);
    }
}

// Consumer 端
@Component
public class OrderEventConsumer {
    @RocketMQMessageListener(topic = "order-topic")
    public void onMessage(Message msg) {
        // 解析 traceId 注入 MDC
        String traceparent = msg.getUserProperty("traceparent");
        if (traceparent != null) {
            String[] parts = traceparent.split("-");
            MDC.put("traceId", parts[1]);
            MDC.put("spanId", parts[2]);
        }
        try {
            process(msg);
        } finally {
            MDC.clear();
        }
    }
}
```

**业务日志带业务字段**：

```java
@Service
public class OrderService {
    private static final Logger log = LoggerFactory.getLogger(OrderService.class);

    public Order createOrder(OrderDTO dto) {
        MDC.put("userId", dto.getUserId());
        MDC.put("orderId", dto.getOrderId());

        log.info("create order amount={}", dto.getAmount());
        // 输出 JSON：
        // {"traceId":"abc123","userId":"U001","orderId":"ORD001",
        //  "message":"create order amount=99.5",...}

        try {
            Order order = doCreate(dto);
            log.info("order created");      // 自动带 traceId/userId/orderId
            return order;
        } catch (Exception e) {
            log.error("create order failed", e);   // 异常堆栈 + traceId
            throw e;
        } finally {
            MDC.remove("userId");
            MDC.remove("orderId");
        }
    }
}
```

**ELK / Loki 查询**：

```bash
# Kibana 查询：找特定 traceId 的所有日志
# 进入 Kibana → Discover，查询栏：
traceId: "abc123def456789abc123def456789ab"

# 输出：N 个服务的所有日志按时间排序，traceId 串联
# 1. 2026-07-13 10:23:45.123 gateway    traceId=abc123 received request
# 2. 2026-07-13 10:23:45.125 order      traceId=abc123 create order
# 3. 2026-07-13 10:23:45.130 inventory  traceId=abc123 deduct stock
# 4. 2026-07-13 10:23:45.150 payment    traceId=abc123 ERROR payment timeout
# 5. 2026-07-13 10:23:45.151 order      traceId=abc123 order failed
```

## 四、底层本质：为什么结构化 + traceId 是基础

回到第一性：**为什么不用文本日志 + grep，要搞结构化 + traceId？**

- **文本日志的痛点**：
  - grep 慢（PB 级日志要扫全量）
  - 字段不固定（不同开发写法不同，如"userId=U001" vs "uid: U001"）
  - 跨服务关联难（一个 traceId 散在 N 个文件）
  - 无法聚合分析（如"过去 1 小时 ERROR 日志按错误类型分组"）

- **结构化日志的收益**：
  - ES/Loki 倒排索引，按字段秒级查询
  - 字段标准化（traceId/userId/orderId 都是 key）
  - 聚合分析（按 level/errorType/service 分组统计）
  - 机器友好（AI 分析、自动化告警）

- **traceId 的本质**：把"跨服务请求"这个分布式概念映射到日志——同一 traceId 的所有日志都属于同一请求。这是分布式排查的"病历号"。

**日志采集成本控制**（架构师必须懂）：

```
万 QPS 服务 × 平均每请求 10 条日志 = 10 万条/秒
1 天 = 86 亿条日志，平均 500B/条 = 4TB/天

成本控制：
  ① 异步日志（不阻塞业务，AsyncAppender）
  ② 按级别采集（ERROR 全量、WARN 全量、INFO 采样、DEBUG 关）
  ③ 高频日志采样（如访问日志 1% 采集）
  ④ 保留期分层（ERROR 30 天、INFO 7 天、DEBUG 1 天）
  ⑤ 冷热分离（7 天内热数据 ES，7-30 天冷数据 S3）
  ⑥ 字段裁剪（去掉 logger 全名、thread 名等冗余）
```

**traceId 在线程池下丢失的根因**：
- `InheritableThreadLocal` 在线程**创建时**复制父线程值
- 线程池**复用线程**，创建时已过，复用时不会重新复制
- 主线程后续 set 的值，子线程拿不到（拿到的是线程创建时的快照）
- `TransmittableThreadLocal` 在任务**提交时**复制 + 任务结束清理，解决复用问题

## 五、AI 架构师加问：5 个

1. **AI 日志分析怎么发现异常？**
   AI 学习历史日志模式（正常基线），实时检测异常：错误突增、新错误类型、异常堆栈、特定 traceId 的失败模式。比规则告警更智能（发现未知模式），但有误报。监控 false_positive_rate，过高回退到规则告警。结构化日志让 AI 解析准确（字段固定），文本日志 AI 也要先解析。

2. **AI Agent 调用工具的日志怎么关联 traceId？**
   每个 tool_call 生成子 span（含 tool_name、参数、耗时、结果），traceId 贯穿整个 Agent 会话。AI Agent 框架（如 LangChain4j）通过 MDC 自动透传 traceId 到工具调用日志。可观测性看板能看到"用户问题 → AI 推理 → 工具调用 → 结果回写"全链路，定位慢工具或失败工具。

3. **大模型推理服务的日志要记录什么？**
   必须字段：traceId（关联请求）、model_version（哪个模型）、prompt_tokens、completion_tokens、latency、cache_hit。可选：prompt 摘要（不含敏感数据）、tool_calls 列表、finish_reason。注意：日志中不记录完整 prompt（可能含 PII），脱敏后记录。

4. **AI 自动生成日志埋点怎么设计？**
   AI 分析代码识别"关键业务点"（如下单、支付、状态变更），自动加 log.info() 埋点 + 业务字段 MDC 注入。规则：每个 public 方法至少一条 INFO 日志、异常路径 ERROR 日志带堆栈、关键决策点（如风控判定）记录输入输出。AI 出 diff 人工 review，避免过度埋点（性能影响）。

5. **怎么用 AI 做 traceId 关联的故障定位？**
   AI 接收告警 + traceId，自动用 traceId 查询 ELK 拉相关日志，分析日志模式（哪个服务、哪个方法、什么错误）。结合历史故障库 RAG，输出"这个 traceId 的失败模式像 XX 事故，建议检查 YY"。AI 不直接改代码，但给定位方向，节省人工 grep 时间。

## 六、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"JSON 结构化、traceId 透传、MDC 注入、异步采集、按级别"**。

- **格式**：JSON 结构化（不是文本），字段标准化（timestamp/level/traceId/logger/msg）
- **traceId 透传**：HTTP（W3C traceparent）、MQ（消息属性）、线程池（TTL）
- **MDC 注入**：logstash-logback-encoder 自动把 MDC 输出到 JSON
- **异步**：AsyncAppender 不阻塞业务，neverBlock 队列满丢弃
- **按级别**：ERROR/WARN 全量，INFO 采样，DEBUG 关
- **成本**：万 QPS 服务 4TB/天日志，按级别 + 采样 + 保留期控制

### 拟人化理解

把结构化日志想成**医院病历系统**。每个病人有唯一病历号（traceId），所有科室（服务）的检查结果都标这个号。医生（排查者）输入病历号，立刻看到从分诊 → 化验 → CT → 手术的完整记录（traceId 串联的日志）。没有病历号，医生只能在 N 个科室的纸质病历（文本日志）里翻找，效率极低。

### 面试现场 60 秒回答

> 结构化日志 + traceId 关联是分布式排查的基础设施。日志输出 JSON 格式（不是文本），字段标准化（timestamp/level/logger/traceId/spanId/业务字段）。traceId 通过 MDC 注入，logstash-logback-encoder 自动输出到 JSON。透传三种场景：HTTP 用 W3C traceparent 头、MQ 放消息属性、线程池用 TransmittableThreadLocal（InheritableThreadLocal 在线程池复用时会丢）。采集用异步日志（AsyncAppender + neverBlock）不阻塞业务，按级别采集（ERROR 全量、DEBUG 关）。成本控制：万 QPS 服务 4TB/天日志，按级别 + 采样 + 保留期（ERROR 30 天、INFO 7 天）。排查时 ELK 按 traceId 查询秒级拉出整条链路。

### 反问面试官

> 贵司日志栈是 ELK 还是 Loki？traceId 是自研还是 OpenTelemetry？日志保留期多久？这决定我聊结构化日志治理还是 OpenTelemetry 落地。

## 七、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 已经有 Prometheus 告警了，为什么还要结构化日志？ | Prometheus 是聚合指标（QPS/P99），无个体事件。日志是离散事件（具体哪个用户、什么参数、什么异常）。告警告诉你"错误率 5%"，日志告诉你"是哪个 traceId、什么错误"。两者互补 |
| 证据追问 | 怎么证明 traceId 真的跨服务串联了？ | 入口注入 traceId，依次经过 A→B→C 服务，用 ELK 查这个 traceId 应该看到 N 个服务的日志。日志带服务名字段（app=order-service），按时间排序看完整链路 |
| 边界追问 | 结构化日志能解决所有排查吗？ | 不能。业务逻辑 bug（如计算错误）看代码；JVM 层问题（OOM、GC）要 dump；网络问题要抓包；性能问题要 profile。日志主要解决"事件追溯" |
| 反例追问 | 什么场景不上结构化日志？ | 单体应用（日志在一个文件）、极小规模（< 100 QPS）、成本敏感（结构化比文本贵 20%）、CLI 工具（人类读）。大多数生产服务都该上 |
| 风险追问 | 日志治理最大风险？ | ① 采集影响业务（同步日志阻塞、AsyncAppender 队列满）；② 成本失控（PB 级存储）；③ 敏感数据泄漏（日志含密码、PII）。治法：异步 + 按级别 + 脱敏 + 保留期 |
| 验证追问 | 怎么证明日志系统真的能用？ | 定期故障演练（注入错误），看能否在日志系统定位根因；统计 MTTR（平均定位时间），应 < 10 分钟；traceId 完整率（> 99% 的请求有 traceId） |
| 沉淀追问 | 团队日志规范沉淀什么？ | 日志字段标准（必填字段清单）、traceId 透传 SOP（HTTP/MQ/线程池）、Logback 模板、按级别采集策略、敏感字段脱敏清单、ELK 查询模板 |

### 现场对话示例

**面试官**：traceId 怎么跨消息队列透传？

**候选人**：RocketMQ 用消息属性（userProperty）传 traceparent。Producer 发消息前从 MDC 取 traceId/spanId 拼成 W3C traceparent 格式（00-{traceId}-{spanId}-01），放 msg.putUserProperty("traceparent", ...)。Consumer 收到消息后解析 userProperty，把 traceId/spanId 注入 MDC，业务代码日志自动带。消费结束 MDC.clear() 清理（防止线程复用泄漏）。OpenTelemetry SDK 自动做这套，业务零侵入。

**面试官**：线程池的 traceId 怎么处理？

**候选人**：默认的 InheritableThreadLocal 在线程池复用时会丢——它在线程**创建时**复制父线程值，但线程池复用线程不重新复制。主线程后续 set 的值子线程拿不到。解法用 TransmittableThreadLocal（TTL），它在线程**任务提交时**复制 + 任务结束清理。配合 TtlExecutors.getTtlExecutorService 包装线程池，子任务自动继承主线程 traceId。或者 Spring 的 ThreadPoolTaskExecutor 配 TtlTaskDecorator。

**面试官**：日志怎么控制成本？

**候选人**：四个手段。第一，异步日志（AsyncAppender）不阻塞业务。第二，按级别采集——ERROR/WARN 全量（关键问题排查），INFO 采样或全量看业务需求，DEBUG 默认关（动态开）。第三，高频日志采样，如访问日志每 100 条采 1 条。第四，保留期分层——ERROR 30 天、WARN 14 天、INFO 7 天、DEBUG 1 天，超期自动归档到 S3 或删除。监控日志采集量，异常增长告警（可能是某服务 DEBUG 没关）。

## 常见考点

1. **结构化日志是什么？**——JSON 格式（不是文本），字段标准化（timestamp/level/traceId/logger/msg），机器可解析。用 logstash-logback-encoder 输出。
2. **traceId 怎么跨服务透传？**——HTTP 用 W3C traceparent 头（00-{traceId}-{spanId}-flags），MQ 放消息属性（userProperty），线程池用 TransmittableThreadLocal。
3. **MDC 是什么？**——Mapped Diagnostic Context，线程本地的 Map。logback 自动把 MDC 内容输出到日志字段（traceId/spanId/业务字段）。
4. **日志采集怎么不阻塞业务？**——AsyncAppender 异步写（业务线程只入队，IO 线程写盘）+ neverBlock 队列满丢弃（不阻塞业务）。
5. **日志成本怎么控制？**——按级别采集（ERROR 全量、DEBUG 关）+ 高频采样 + 保留期分层（ERROR 30 天、INFO 7 天）+ 冷热分离。

## 结构化回答

**30 秒电梯演讲：** 结构化日志（JSON）+ traceId 关联是分布式排查的基础设施——日志不再是给人读的文本，而是给机器查询的结构化数据。一条 traceId 串起网关、订单、库存、支付 N 个服务的日志，秒级定位用户 A 的订单为什么失败。治理核心是 traceId 透传（HTTP/MQ/线程池）+ 日志字段标准化 + 采集成本控制

**展开框架：**
1. **结构化日志** — JSON 格式（不是文本），字段标准化（timestamp/level/traceId/logger/msg/...）
2. **traceId 透传** — HTTP（W3C traceparent）、MQ（消息属性）、线程池（TTL）
3. **MDC + Logbac** — MDC + Logback JSON encoder 自动注入 traceId

**收尾：** 以上是我的整体思路。您想继续深入聊——traceId 怎么生成？


## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：Spring Boot 结构化日志与 trace | "这题核心是——结构化日志（JSON）+ traceId 关联是分布式排查的基础设施——日志不再是给人读的文本，……" | 开场钩子 |
| 0:15 | 结构化日志示意/对比图 | "JSON 格式（不是文本），字段标准化（timestamp/level/traceId/logger/msg/...）" | 结构化日志要点 |
| 0:40 | traceId 透传示意/对比图 | "HTTP（W3C traceparent）、MQ（消息属性）、线程池（TTL）" | traceId 透传要点 |
| 1:25 | 总结卡 | "记住：结构化日志 = JSON +。下期见。" | 收尾 |
