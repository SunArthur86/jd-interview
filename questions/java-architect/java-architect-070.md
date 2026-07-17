---
id: java-architect-070
difficulty: L4
category: java-architect
subcategory: 实时计算
tags:
- Java 架构师
- Flink
- 实时计算
- 流处理
- Java 协同
feynman:
  essence: Flink 实时计算是"数据流动时就算"，和 Java 服务的协同是"流处理 + 应用"的组合——Flink 负责重计算（窗口聚合/状态机/CEP 模式识别），Java 服务负责业务逻辑（事务/查询/RPC）。典型场景：Flink 算实时大屏（GMV 秒级更新）、实时风控（异常行为秒级拦截）、实时推荐（用户行为秒级反馈）。核心挑战是"Flink 流处理和 Java 事务的边界——谁做什么，数据怎么流转"。
  analogy: 像工厂流水线。传送带（Flink 流）上产品流过，工位（算子）实时加工（聚合/检测）。但有些复杂工序（精细装配/质量仲裁）要送到独立车间（Java 服务）处理。传送带和车间协同——传送带快速过滤加工，复杂件送车间。Flink + Java 一样——流处理粗加工，复杂业务送 Java 服务。
  first_principle: 为什么 Flink 不能包揽所有逻辑？因为 Flink 擅长"数据流计算"（窗口/聚合/状态），但不擅长"事务/查询/复杂业务逻辑"（这些 Java 服务更合适）。解法是"分工协同"——Flink 做实时计算（算特征/检测异常/聚合指标），结果发 Kafka 或调 Java 服务（业务处理）。两者通过 Kafka/RPC 解耦。
  key_points:
  - Flink 流处理：窗口聚合/状态计算/CEP 模式识别
  - Java 服务协同：Flink 算完发 Kafka，Java 消费处理业务
  - 异步查询：Flink Async I/O 查外部系统（数据库/API），不阻塞流
  - 状态管理：Flink 状态（Keyed State/Operator State），checkpoint 容错
  - Exactly-once：端到端精确一次（Kafka + Flink + Sink 事务）
first_principle:
  problem: 实时业务（大屏/风控/推荐）需要秒级响应，怎么用 Flink 流计算 + Java 服务协同实现？
  axioms:
  - Flink 擅长流计算（窗口/聚合/状态），不擅长事务/复杂业务
  - Java 服务擅长业务逻辑，但不擅长流处理（自己写流处理复杂）
  - 两者通过 Kafka/RPC 解耦协同
  - 实时性要求（秒级端到端延迟）
  rebuild: Flink 流计算 + Kafka 解耦 + Java 服务业务。Flink 消费事件流，实时聚合/检测（窗口算指标、CEP 识别异常模式），结果发 Kafka 或直接调 Java 服务（Async I/O 不阻塞）。Java 服务消费 Kafka 做业务处理（写库/调下游/通知）。端到端 exactly-once（Kafka + Flink checkpoint + 事务 Sink）。监控 end_to_end_latency（端到端延迟，秒级）和 checkpoint_duration（checkpoint 耗时）。
follow_up:
  - Flink 作业怎么和 Spring Boot 应用集成？——Flink 作业独立部署（Flink 集群），通过 Kafka/HTTP 和 Spring Boot 通信。不在 Spring Boot 内跑 Flink（耦合）。
  - Flink 状态怎么持久化（防宕机丢数据）？——Checkpoint（周期性快照状态到 HDFS/S3），故障恢复从 checkpoint。
  - Exactly-once 怎么保证（不重复不丢）？——Source 端（Kafka offset）+ Flink（checkpoint）+ Sink 端（事务写/幂等）三端协同。
  - Flink 作业怎么更新（不停服）？——Savepoint（状态快照）+ 停旧作业 + 从 savepoint 启新作业（状态延续）。
  - 水位线（Watermark）怎么处理乱序事件？——Watermark 标记"时间进度"，晚到的事件（< watermark）丢弃或侧输出。
memory_points:
  - Flink 流计算，Java 服务业务
  - 协同：Kafka 解耦 or Async I/O
  - 状态管理：Keyed State + Checkpoint
  - Exactly-once：Source + Flink + Sink 三端
  - Watermark：处理乱序事件
---

# 【Java 后端架构师】Flink 实时计算与 Java 服务协同

> 适用场景：JD 实时业务。双 11 实时大屏（GMV 秒级更新）、实时风控（异常行为秒级拦截）、实时推荐（用户点击秒级反馈特征）。这些场景 Flink 流计算（算指标/检测模式）+ Java 服务（业务处理）协同。核心是"流处理和应用的边界划分 + 端到端一致性"。

## 一、概念层：Flink + Java 协同架构

**协同模式三种**：

```
模式 1：Flink 算 + Kafka 解耦 + Java 处理（推荐）
  事件流 → Flink 实时计算 → 结果发 Kafka → Java 服务消费处理

  适用：Flink 和 Java 解耦，各自扩展
  示例：Flink 算实时 GMV → 发 Kafka → Java 大屏服务消费展示

模式 2：Flink Async I/O 直接调 Java 服务（低延迟）
  事件流 → Flink 算子 → Async I/O 调 Java RPC → 继续处理

  适用：Flink 需要查 Java 服务数据（如查用户画像）
  示例：Flink 算风控，每条事件查 Java 用户服务（画像）

模式 3：Flink 算完写存储，Java 服务查（简单）
  事件流 → Flink 算 → 写 Redis/MySQL → Java 服务查

  适用：结果被多服务共享（特征/指标）
  示例：Flink 算实时特征写 Redis，Java 推荐服务查
```

**端到端架构**（实时大屏场景）：

```
订单事件（Kafka）
       │
       ▼
┌──────────────────────────────────────────────┐
│ Flink 作业（实时聚合）                          │
│                                                │
│  - 按类目分组，1 秒窗口 SUM（金额）              │
│  - 全局 SUM（总 GMV）                           │
│  - TopN 热销商品                                │
│                                                │
│  结果发 Kafka（3 个 topic）                     │
└──────────────────────────────────────────────┘
       │
       ├─ gmv-per-second topic
       ├─ top-selling topic
       └─ category-gmv topic
       │
       ▼
┌──────────────────────────────────────────────┐
│ Java 大屏服务（Spring Boot）                    │
│                                                │
│  - 消费 Kafka，WebSocket 推前端                 │
│  - 历史数据查 MySQL                              │
│  - 前端实时刷新（图表）                          │
└──────────────────────────────────────────────┘
```

## 二、机制层：Flink DataStream 实时代码

**实时 GMV 大屏（Flink DataStream）**：

```java
/**
 * Flink 作业：实时 GMV 计算
 * 消费订单流，按秒聚合 GMV，发 Kafka 供大屏展示
 */
public class RealtimeGmvJob {

    public static void main(String[] args) throws Exception {
        StreamExecutionEnvironment env =
            StreamExecutionEnvironment.getExecutionEnvironment();

        // 1. Checkpoint 配置（容错，exactly-once）
        env.enableCheckpointing(60_000);   // 每 60 秒 checkpoint
        env.getCheckpointConfig().setCheckpointingMode(
            CheckpointingMode.EXACTLY_ONCE);
        env.getCheckpointConfig().setCheckpointTimeout(30_000);
        env.getCheckpointConfig().setMinPauseBetweenCheckpoints(30_000);
        env.setStateBackend(new EmbeddedRocksDBStateBackend());

        // 2. 消费订单事件（Kafka Source，offset 在 checkpoint 提交）
        KafkaSource<OrderEvent> source = KafkaSource.<OrderEvent>builder()
            .setBootstrapServers("kafka:9092")
            .setTopics("order-event")
            .setGroupId("gmv-job")
            .setStartingOffsets(OffsetsInitializer.earliest())
            .setValueOnlyDeserializer(new OrderEventSchema())
            .build();

        DataStream<OrderEvent> orders = env.fromSource(
            source, WatermarkStrategy.forBoundedOutOfOrderness(Duration.ofSeconds(5)),
            "order-source");

        // 3. 按秒窗口聚合 GMV（全局 SUM）
        DataStream<GmvResult> perSecondGmv = orders
            .assignTimestampsAndWatermarks(
                WatermarkStrategy.<OrderEvent>forBoundedOutOfOrderness(
                    Duration.ofSeconds(5))
                .withTimestampAssigner((e, t) -> e.getEventTime()))
            .keyBy(e -> "GLOBAL")   // 全局聚合
            .window(TumblingEventTimeWindows.of(Time.seconds(1)))
            .aggregate(new GmvAgg());

        // 4. 发 Kafka（供 Java 大屏服务消费）
        KafkaSink<GmvResult> sink = KafkaSink.<GmvResult>builder()
            .setBootstrapServers("kafka:9092")
            .setRecordSerializer(new GmvResultSerializer("gmv-per-second"))
            .setDeliveryGuarantee(DeliveryGuarantee.EXACTLY_ONCE)   // 精确一次
            .build();

        perSecondGmv.sinkTo(sink);

        // 5. TopN 热销商品（ProcessFunction 状态）
        DataStream<TopNResult> topN = orders
            .keyBy(OrderEvent::getSkuId)
            .window(TumblingEventTimeWindows.of(Time.minutes(1)))
            .aggregate(new SalesCountAgg())
            .keyBy(e -> "ALL")
            .process(new TopNFunction(10));   // 每分钟 Top10

        topN.sinkTo(kafkaSink("top-selling"));

        env.execute("Realtime GMV Job");
    }

    /**
     * GMV 聚合函数：SUM 金额
     */
    static class GmvAgg implements AggregateFunction<
            OrderEvent, BigDecimal, GmvResult> {

        @Override
        public BigDecimal createAccumulator() { return BigDecimal.ZERO; }

        @Override
        public BigDecimal add(OrderEvent order, BigDecimal acc) {
            return acc.add(order.getAmount());
        }

        @Override
        public GmvResult getResult(BigDecimal total) {
            return new GmvResult(total, System.currentTimeMillis());
        }

        @Override
        public BigDecimal merge(BigDecimal a, BigDecimal b) {
            return a.add(b);
        }
    }

    /**
     * TopN 函数：状态存所有 SKU 销量，每分钟输出 Top10
     */
    static class TopNFunction extends KeyedProcessFunction<String,
            SalesCount, TopNResult> {

        private final int topSize;
        private ValueState<Map<Long, Long>> skuSalesState;   // SKU → 销量

        public TopNFunction(int topSize) { this.topSize = topSize; }

        @Override
        public void open(Configuration parameters) {
            skuSalesState = getRuntimeContext().getState(
                new ValueStateDescriptor<>("skuSales", TypeInformation.of(Map.class)));
        }

        @Override
        public void processElement(SalesCount input, Context ctx,
                                    Collector<TopNResult> out) throws Exception {
            Map<Long, Long> map = skuSalesState.value();
            if (map == null) map = new HashMap<>();
            map.merge(input.getSkuId(), input.getCount(), Long::sum);
            skuSalesState.update(map);

            // 注册定时器（每分钟输出一次）
            long nextMinute = ctx.timerService().currentWatermark() /
                60_000 * 60_000 + 60_000;
            ctx.timerService().registerEventTimeTimer(nextMinute);
        }

        @Override
        public void onTimer(long timestamp, OnTimerContext ctx,
                            Collector<TopNResult> out) throws Exception {
            Map<Long, Long> map = skuSalesState.value();
            if (map == null) return;

            // 排序取 TopN
            List<Map.Entry<Long, Long>> sorted = map.entrySet().stream()
                .sorted(Map.Entry.<Long, Long>comparingByValue().reversed())
                .limit(topSize)
                .collect(Collectors.toList());

            out.collect(new TopNResult(timestamp, sorted));

            // 清状态（下个周期重新算）
            skuSalesState.clear();
        }
    }
}
```

## 三、机制层：Flink Async I/O 查 Java 服务

**异步查外部服务（不阻塞流）**：

```java
/**
 * Flink Async I/O：流处理中异步查 Java 服务
 * 场景：风控作业中查用户画像（Java 服务）
 */
public class RiskControlWithAsyncIO {

    public static void main(String[] args) throws Exception {
        StreamExecutionEnvironment env =
            StreamExecutionEnvironment.getExecutionEnvironment();

        DataStream<TransactionEvent> transactions = env.addSource(
            new FlinkKafkaConsumer<>("transaction",
                new TransactionSchema(), kafkaProps()));

        // Async I/O：每条交易异步查用户画像（Java 服务）
        DataStream<EnrichedTransaction> enriched = AsyncDataStream
            .unorderedWait(
                transactions,
                new UserProfileAsyncFunction(),   // 异步查画像
                100,                              // 超时 100ms
                TimeUnit.MILLISECONDS,
                100);                             // 并发 100

        // 用画像做风控判断
        DataStream<RiskResult> riskResults = enriched
            .keyBy(EnrichedTransaction::getUserId)
            .process(new RiskDetectionFunction());

        riskResults.addSink(new KafkaSink<>());

        env.execute("Risk Control Job");
    }

    /**
     * 异步查用户画像：调 Java 服务的 RPC
     */
    static class UserProfileAsyncFunction extends RichAsyncFunction<
            TransactionEvent, EnrichedTransaction> {

        private transient UserProfileClient client;   // Java 服务 RPC 客户端

        @Override
        public void open(Configuration parameters) {
            client = new UserProfileClient("user-service:8080");
        }

        @Override
        public void asyncInvoke(TransactionEvent input,
                                  ResultFuture<EnrichedTransaction> resultFuture) {
            // 异步调 Java 服务（HTTP/gRPC）
            client.getUserProfileAsync(input.getUserId())
                .thenAccept(profile -> {
                    // 查到画像，组装增强交易
                    EnrichedTransaction enriched = new EnrichedTransaction(
                        input, profile);
                    resultFuture.complete(Collections.singleton(enriched));
                })
                .exceptionally(e -> {
                    // 查失败，超时处理
                    resultFuture.completeExceptionally(e);
                    return null;
                });
        }

        @Override
        public void timeout(TransactionEvent input,
                              ResultFuture<EnrichedTransaction> resultFuture) {
            // 超时降级：用默认画像
            resultFuture.complete(Collections.singleton(
                new EnrichedTransaction(input, UserProfile.defaultProfile())));
        }
    }
}
```

## 四、机制层：Java 服务消费 Flink 结果

**Spring Boot 大屏服务**：

```java
@Service
public class DashboardService {

    @Autowired private SimpMessagingTemplate websocket;   // WebSocket 推送

    /**
     * 消费 Flink 结果（Kafka），WebSocket 推前端
     */
    @KafkaListener(topic = "gmv-per-second")
    public void onGmvUpdate(GmvResult gmv) {
        // 推前端（实时刷新图表）
        websocket.convertAndSend("/topic/gmv", gmv);

        // 持久化（历史查询）
        gmvRepo.save(gmv);

        monitor.record("gmv_realtime", gmv.getGmv());
    }

    @KafkaListener(topic = "top-selling")
    public void onTopNUpdate(TopNResult topN) {
        websocket.convertAndSend("/topic/topn", topN);
    }

    /**
     * 查历史 GMV（前端折线图）
     */
    public List<GmvResult> getHistoryGmv(LocalDateTime from, LocalDateTime to) {
        return gmvRepo.findByTimeBetween(from, to);
    }
}
```

**WebSocket 前端推送**：

```java
@Configuration
@EnableWebSocketMessageBroker
public class WebSocketConfig implements WebSocketMessageBrokerConfigurer {

    @Override
    public void registerStompEndpoints(StompEndpointRegistry registry) {
        registry.addEndpoint("/dashboard").withSockJS();
    }

    @Override
    public void configureMessageBroker(MessageBrokerRegistry registry) {
        registry.enableSimpleBroker("/topic");
    }
}
```

## 五、机制层：端到端 Exactly-Once

**三端协同保证精确一次**：

```java
/**
 * Exactly-once 三要素：
 * 1. Source：Kafka offset 在 Flink checkpoint 成功后提交
 * 2. Flink：Checkpoint 持久化状态，故障恢复从 checkpoint
 * 3. Sink：事务写（两阶段提交）或幂等写
 */

// Source：Kafka + checkpoint
KafkaSource<OrderEvent> source = KafkaSource.<OrderEvent>builder()
    .setBootstrapServers("kafka:9092")
    .setTopics("order-event")
    .setGroupId("exactly-once-job")
    .setValueOnlyDeserializer(new OrderEventSchema())
    .build();
// KafkaSource 原生支持 checkpoint（offset 随 checkpoint 提交）

// Flink：checkpoint 配置
env.enableCheckpointing(60_000);
env.getCheckpointConfig().setCheckpointingMode(CheckpointingMode.EXACTLY_ONCE);

// Sink：两阶段提交（KafkaSink 原生支持）
KafkaSink<Result> sink = KafkaSink.<Result>builder()
    .setBootstrapServers("kafka:9092")
    .setRecordSerializer(serializer)
    .setDeliveryGuarantee(DeliveryGuarantee.EXACTLY_ONCE)
    // EXACTLY_ONCE 模式用事务写（两阶段提交）
    .setTransactionalIdPrefix("exactly-once-")
    .build();

// Sink：幂等写（MySQL，主键去重）
public class IdempotentMySQLSink extends RichSinkFunction<Result> {
    @Override
    public void invoke(Result value, Context context) {
        // INSERT ON DUPLICATE KEY UPDATE（幂等，重复执行结果一致）
        jdbcTemplate.update(
            "INSERT INTO t_result (id, value) VALUES (?, ?) " +
            "ON DUPLICATE KEY UPDATE value = VALUES(value)",
            value.getId(), value.getValue());
    }
}
```

## 六、底层本质：Flink + Java 协同的本质是"计算与业务的分层"

回到第一性：**Flink + Java 协同的本质是"流计算层（Flink）和应用层（Java）的职责分层"**。

- **Flink 擅长"数据流计算"**：窗口聚合（时间窗口统计）、状态计算（Keyed State 维护上下文）、CEP（复杂事件模式识别，如"3 次失败登录后 1 次成功"识别暴力破解）、水位线（处理乱序事件）。这些是"数据密集型"计算，Flink 引擎优化（增量聚合/状态后端/checkpoint）。
- **Java 擅长"业务逻辑"**：事务（下单/支付）、复杂查询（多表 JOIN）、RPC（调下游服务）、权限/校验。这些是"逻辑密集型"，Spring Boot 生态成熟。
- **协同的本质是"解耦"**：Flink 和 Java 不耦合（不在同进程），通过 Kafka/RPC 通信。Flink 重启不影响 Java 服务，Java 服务扩容不影响 Flink。各 自演进（Flink 升级 vs Java 应用迭代互不阻塞）。
- **数据流的方向"单向"**：事件 → Flink 算 → 结果发 Kafka → Java 消费处理。这是"管道式"数据流——单向流动，每环节职责明确。避免循环（Flink → Java → Flink）导致复杂度爆炸。

**状态管理的本质是"记忆"**：Flink 状态（Keyed State/Operator State）让流处理"记住历史"——如用户最近 10 次点击、商品累计销量。状态是"流的记忆"，没有状态流处理只能逐条独立算（无上下文）。Checkpoint 把状态持久化（防宕机丢），故障恢复从 checkpoint 续算。这是"有状态流处理"的核心。

**Exactly-once 的本质是"一致性协议"**：端到端精确一次需要三端协同——Source（offset 不重复消费）+ Flink（checkpoint 状态一致）+ Sink（事务/幂等写）。任何一端不保证，整体退化至少一次或至多一次。这是"分布式事务"思想在流处理的应用——两阶段提交（2PC）保证 Source-Flink-Sink 一致。

**Watermark 的本质是"时间推进"**：流处理基于事件时间（事件发生时间），但事件可能乱序到达（网络延迟）。Watermark 标记"时间进度"——"时间 T 的 watermark 表示 T 之前的事件都已到"。窗口在 watermark 到达时触发计算。晚到的事件（< watermark）丢弃或进侧输出。这是"权衡实时性和完整性"——等太久（watermark 慢）延迟高，等太短（watermark 快）漏数据。

## 七、AI 架构师加问：5 个

1. **用 Flink + AI 做实时模型推理（流中调模型），怎么做？**
   Flink 作业内嵌模型推理（Flink ML 或调用 Python 模型服务）。每条事件经模型预测，结果实时输出。如实时风控——每笔交易调欺诈模型评分，超阈值拦截。延迟 < 100ms（模型 GPU 推理 + Flink 流处理）。京东实时风控：Flink + 模型，毫秒级决策。

2. **用 AI 预测 Flink 作业负载（弹性扩容），怎么做？**
   AI 根据历史负载（事件量/QPS）+ 业务节奏（大促/日常）预测 Flink 负载，提前扩容。预测准可自动弹性（Kubernetes + Flink Operator）。京东双 11：AI 预测 Flink 负载，自动扩容 5 倍，零人工干预。

3. **用 AI 做异常检测（Flink CEP 升级），怎么做？**
   传统 CEP 靠规则模式（明确规则），AI 学习正常模式识别异常——比 CEP 更灵活（无需定义模式，AI 泛化识别）。但 AI 不可解释（CEP 可解释"命中哪条规则"）。混合——CEP 处理已知异常，AI 发现未知异常。

4. **AI 优化 Flink 作业（自动调参），怎么做？**
   AI 优化 Flink 参数——并行度/窗口大小/状态后端/checkpoint 间隔。AI 学习作业特征（数据量/计算复杂度）推荐最优配置。京东实践：AI 调参，Flink 作业吞吐提升 30%。

5. **用 AI 做 Flink SQL 自动生成（自然语言→SQL），怎么做？**
   业务同学用自然语言描述需求（"统计每秒 GMV 发 Kafka"），AI 生成 Flink SQL/DataStream 代码。降低 Flink 使用门槛（不用学 API）。京东探索：AI 生成 Flink 作业，开发效率提升 5 倍。

## 七、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"Flink 流算 Java 业务、Kafka 解耦协同、状态 + Checkpoint 容错、Exactly-once 三端"**。

- **协同模式**：Flink 算 + Kafka 解耦 + Java 处理（推荐）/ Async I/O 直接调 Java
- **Flink 代码**：DataStream + keyBy + window + aggregate（窗口聚合）/ process（状态计算）
- **状态管理**：Keyed State（用户状态）+ Checkpoint（持久化容错）
- **Exactly-once**：Source（Kafka offset）+ Flink（checkpoint）+ Sink（事务/幂等）三端协同
- **Watermark**：处理乱序事件，标记时间进度
- **Async I/O**：流中异步查 Java 服务（不阻塞流）

### 面试现场 60 秒回答

> Flink + Java 协同的核心是计算与业务分层。Flink 做"数据流计算"——窗口聚合（SUM/COUNT）、状态计算（Keyed State 维护上下文）、CEP（模式识别），这些数据密集型计算 Flink 引擎优化。Java 做"业务逻辑"——事务/查询/RPC/权限，Spring Boot 生态成熟。协同模式三种——第一，Flink 算 + Kafka 解耦 + Java 消费处理（推荐，解耦各自扩展）；第二，Async I/O 直接调 Java 服务（Flink 流中异步查，不阻塞，超时降级）；第三，Flink 写 Redis/MySQL + Java 查（简单，结果共享）。典型 Flink DataStream 作业——KafkaSource 消费事件（offset 随 checkpoint 提交），assignTimestampsAndWatermarks（事件时间 + 乱序容忍），keyBy + window（窗口聚合），aggregate（增量算），KafkaSink 发结果（EXACTLY_ONCE 事务写）。状态管理——Keyed State（每 key 独立状态，如用户购物车）+ Operator State（算子级），Checkpoint 周期快照到 HDFS/S3，故障恢复从 checkpoint 续算。端到端 exactly-once——Source（Kafka offset checkpoint 提交）+ Flink（checkpoint 状态一致）+ Sink（两阶段提交事务/幂等写 ON DUPLICATE KEY），三端协同。Watermark 处理乱序——forBoundedOutOfOrderness(5s) 允许 5 秒乱序，watermark 推进窗口触发。Java 服务消费——@KafkaListener 消费 Flink 结果，WebSocket 推前端实时刷新（大屏场景）。监控 end_to_end_latency（端到端延迟，秒级）、checkpoint_duration（checkpoint 耗时）、checkpoint_failure_rate（失败率）。最关键的是"Flink 算 Java 处理 Kafka 解耦——计算与业务分层"，这是协同架构的本质。

## 八、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不直接在 Java 服务里用 Stream API 算（要 Flink）？ | Java Stream 是单机内存流（伪流），Flink 是分布式流处理引擎——状态管理/checkpoint/窗口/CEP/水位线/精确一次，这些 Java 自己实现复杂。用 flink_job_rt（作业延迟）和 state_recovery_time（状态恢复时间）量化，Flink 秒级恢复 vs Java 自研小时级 |
| 证据追问 | 怎么证明 Flink 作业稳定（不丢数据）？ | Exactly-once 端到端（Source+Flink+Sink 三端）+ Checkpoint 监控（成功率 > 99.9%）+ 数据对账（Flink 结果 vs 离线重算）。监控 checkpoint_success_rate（> 99.9%）和 data_loss_count（数据丢失数，应 0） |
| 边界追问 | Flink 能处理所有实时场景吗？ | 不能。超低延迟（< 10ms）用 Java 内存计算（Flink 有框架开销）；超复杂业务逻辑（多表事务）用 Java 服务；Flink 适合"数据流聚合/检测"，不适合"事务/复杂查询" |
| 反例追问 | 什么场景不需要 Flink（Java 够用）？ | 低频计算（定时任务，Spark 批够）；简单实时（Redis INCR 算计数）；单机数据量小（Java 内存算）。Flink 适合"分布式 + 高吞吐 + 状态复杂"场景 |
| 风险追问 | Flink 作业最大风险？ | 主动点出：状态丢失（checkpoint 失败 + 宕机）、数据倾斜（热点 key 聚合慢）、背压（下游慢导致积压）、作业升级丢状态（savepoint 漏配）。靠 checkpoint 多副本 + key 分散 + 背压监控 + savepoint 升级 |
| 验证追问 | 怎么验证 Exactly-once 真的精确一次？ | 注入测试（故障注入后查数据是否重复/丢失）+ 端到端计数（Source 消费数 vs Sink 写入数，应相等）+ 对账（Flink 结果 vs 下游存储）。监控 duplicate_count（重复数，应 0）和 lost_count（丢失数，应 0） |
| 沉淀追问 | Flink + Java 协同沉淀什么？ | Flink 作业模板（DataStream/SQL）、状态管理规范、Checkpoint/Savepoint 运维工具、Exactly-once 验证框架、监控大盘（延迟/吞吐/checkpoint/背压） |

### 现场对话示例

**面试官**：Flink 作业运行中要升级（改聚合逻辑），怎么不停服不丢状态？

**候选人**：用 Savepoint。第一步，触发 Savepoint——Flink savepoint 命令把当前状态快照到 HDFS（含所有 Keyed State/Operator State）。作业继续运行（savepoint 是在线快照，不阻断）。第二步，停旧作业——优雅停止（drain，处理完 inflight 数据再停）。第三步，启新作业——从 savepoint 恢复（flink run -s hdfs://savepoint-path），新作业加载旧状态继续算。关键点——状态兼容（新作业的算子状态 schema 要和旧的一致，否则状态恢复失败）。如果改了算子（如加了新算子），需用 UID 指定（保证状态匹配）。京东实践：Flink 作业每周升级（迭代算法/修 bug），savepoint 升级秒级中断（用户无感）。监控 savepoint_duration（快照耗时）和 recovery_time（恢复时间）。极端情况状态不兼容（大改）——用"双跑"（新作业从空白起跑，积累状态后切流量）。

**面试官**：Flink 作业状态越来越大（TB 级），checkpoint 慢（分钟级），怎么办？

**候选人**：大状态是 Flink 运维难题。优化措施——第一，状态后端选 RocksDB（增量 checkpoint，不是全量，只快照变化部分）。RocksDB 把状态存磁盘（不是内存），支持超大状态。第二，状态 TTL（过期清理）——如用户行为状态保留 7 天，过期自动清理（减少累积）。第三，状态分片——大 key 拆小 key（如 user 行为按天分，不是全部存一起），checkpoint 并行度提高。第四，增量 checkpoint——配置 RocksDB incremental checkpoint，只快照变化部分（不是全量 TB）。第五，本地 RocksDB + 远程 HDFS——本地快速读写，HDFS 持久化。京东双 11：Flink 状态 PB 级，RocksDB + 增量 checkpoint，checkpoint < 1 分钟。监控 state_size（状态大小）和 checkpoint_duration（耗时，应 < checkpoint 间隔）。极端情况 checkpoint 超时——降频（从 60 秒改 5 分钟）或清理旧状态（强制 TTL）。

**面试官**：Flink 算的结果发 Kafka，但下游 Java 服务消费慢导致 Kafka 积压，怎么办？

**候选人**：这是"生产快消费慢"的背压问题。三层解决。第一层，Java 服务扩容——增加消费者实例（consumer group 多实例并行），匹配 Flink 生产速度。注意 Kafka 分区数 >= 消费者数（否则有消费者空闲）。第二层，Flink 限流（背压传导）——Flink 检测到 Sink（Kafka）慢，自动降低处理速度（背压），避免积压恶化。但背压会导致 Flink 延迟升高（实时性降低）。第三层，异步处理——Java 服务收到消息后异步处理（写线程池），不阻塞消费（消费速度跟上 Flink）。极端情况——Java 服务处理不过来（业务逻辑慢），消息进死信队列（待后续处理），保证 Kafka 不积压。京东双 11：Flink 百万 QPS，Java 服务 50 实例消费，分区 100，无积压。监控 kafka_lag（积压量，应 < 阈值）和 consumer_lag_p99（消费者延迟）。

## 常见考点

1. **Flink 和 Spark 区别？**——Flink 真流处理（逐条，毫秒延迟），Spark 微批（批模拟流，秒级延迟）。Flink 状态管理强（Keyed State/Operator State），Spark 状态弱。实时选 Flink，近实时/批选 Spark。
2. **Flink 的窗口类型？**——Tumbling（翻滚，不重叠）、Sliding（滑动，重叠）、Session（会话，活动间隙）、Global（全局）。实时特征/大屏用 Tumbling 或 Sliding。
3. **Flink CEP（复杂事件处理）？**——模式识别，如"3 次失败登录后 1 次成功"识别暴力破解。CEP 用 Pattern API 定义模式，流中匹配触发。适用于风控/异常检测。
4. **Flink SQL 和 DataStream 区别？**——SQL 声明式（写 SQL，简单），DataStream API 编程式（写 Java/Scala，灵活）。SQL 适合简单聚合（开发快），DataStream 适合复杂逻辑（状态/CEP）。可混用（SQL 调 UDF）。

## 结构化回答

**30 秒电梯演讲：** Flink 实时计算是数据流动时就算，和 Java 服务的协同是流处理 + 应用的组合——Flink 负责重计算（窗口聚合/状态机/CEP 模式识别），Java 服务负责业务逻辑（事务/查询/RPC）。典型场景：Flink 算实时大屏（GMV 秒级更新）、实时风控（异常行为秒级拦截）、实时推荐（用户行为秒级反馈）。核心挑战是Flink 流处理和 Java 事务的边界——谁做什么，数据怎么流转

**展开框架：**
1. **Flink 流处理** — 窗口聚合/状态计算/CEP 模式识别
2. **Java 服务协同** — Flink 算完发 Kafka，Java 消费处理业务
3. **异步查询** — Flink Async I/O 查外部系统（数据库/API），不阻塞流

**收尾：** 以上是我的整体思路。您想继续深入聊——Flink 作业怎么和 Spring Boot 应用集成？


## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：Flink 实时计算与 Java 服务协同 | "这题核心是——Flink 实时计算是数据流动时就算，和 Java 服务的协同是流处理 + 应用的组合——F……" | 开场钩子 |
| 0:15 | 像工厂流水线类比图 | "打个比方：像工厂流水线。" | 核心类比 |
| 0:40 | Flink 流处理示意/对比图 | "窗口聚合/状态计算/CEP 模式识别" | Flink 流处理要点 |
| 1:05 | Java 服务协同示意/对比图 | "Flink 算完发 Kafka，Java 消费处理业务" | Java 服务协同要点 |
| 1:30 | 异步查询示意/对比图 | "Flink Async I/O 查外部系统（数据库/API），不阻塞流" | 异步查询要点 |
| 1:55 | 总结卡 | "记住：Flink 流计算。下期见。" | 收尾 |
