---
id: java-architect-156
difficulty: L3
category: java-architect
subcategory: 实时计算
title: Flink 状态、Checkpoint 与 Exactly Once
tags: [Flink, Checkpoint, Exactly-Once, State, 两阶段提交]
related: [java-architect-155, java-architect-153, java-architect-137]
---

# Flink 状态、Checkpoint 与 Exactly Once

> **场景**：京东实时交易大盘，用 Flink 消费 Kafka 订单流计算 GMV。要求：Flink 任务重启不能丢数据、不能重复计算、结果秒级一致。面试官问：Flink 的 Exactly-Once 怎么实现？Checkpoint 原理？

## 一、概念层：三个核心概念

### 1.1 State（状态）

Flink 是有状态流处理——算子之间维护中间结果。

| 状态类型 | 说明 | 场景 |
|----------|------|------|
| **ValueState** | 单值 | 每用户的累计消费金额 |
| **ListState** | 列表 | 最近 N 次行为 |
| **MapState** | 映射 | SKU 维度的实时库存 |
| **ReducingState** | 聚合 | 实时 SUM/COUNT |
| **BroadcastState** | 广播 | 规则配置（所有算子共享） |

按作用域：
- **Keyed State**：按 key 分（`keyBy` 后），最常用
- **Operator State**：算子级（如 Kafka source 的 offset）

### 1.2 Checkpoint（检查点）

**Checkpoint = 定期把所有算子的 State 快照到持久化存储（S3/HDFS）**。任务失败后从最近的 Checkpoint 恢复，不丢数据。

### 1.3 Exactly-Once（精确一次）

三种语义：
| 语义 | 含义 | 实现难度 |
|------|------|----------|
| **At-most-once** | 至多一次（可能丢） | 最简单 |
| **At-least-once** | 至少一次（可能重复） | 中等 |
| **Exactly-once** | 精确一次（不丢不重） | 最难 |

**端到端 Exactly-Once** 需要：Source 可重放 + 框架状态一致 + Sink 两阶段提交。

## 二、机制层：Checkpoint 原理

### 2.1 Chandy-Lamport 算法

Flink Checkpoint 基于 Chandy-Lamport 分布式快照算法：

```
1. JobManager 定期向 Source 注入 Checkpoint Barrier（特殊事件）
2. Barrier 随数据流向前传播
3. 算子收到 Barrier 后：
   a. 暂停处理新数据（对齐）
   b. 把当前 State 快照到持久化存储
   c. 把 Barrier 转发给下游
4. 所有算子都完成快照 → Checkpoint 成功
5. JobManager 记录 Checkpoint 元数据
```

```
数据流: ──[d1]──[d2]──[BARRIER]──[d3]──[d4]──[BARRIER]──→
                      ↑ 当前 Checkpoint 的分界线
        Checkpoint N 包含 d1, d2 的处理结果
```

### 2.2 Barrier 对齐

多个上游的算子收到 Barrier 时间可能不同：

```
上游1: ──[d1]──[BARRIER]──[d3]──→
                         ↓ 算子要先等两个上游都到 Barrier
上游2: ──[d2]──[d3]──[BARRIER]──→
```

- **对齐（Aligned）**：等慢的上游，期间缓存快上游的数据。精确但可能阻塞
- **非对齐（Unaligned）**（Flink 1.11+）：不等，把 in-flight 数据也算进 State。反压场景下不阻塞，但 State 更大

### 2.3 State Backend（状态后端）

| 后端 | State 存储 | 特点 |
|------|-----------|------|
| **HashMapStateBackend** | 内存（堆）/ RocksDB | 灵活，小状态用 |
| **EmbeddedRocksDBStateBackend** | RocksDB（磁盘） | 大状态（TB 级）必选 |

```java
StreamExecutionEnvironment env = StreamExecutionEnvironment.getExecutionEnvironment();

// 配置 RocksDB State Backend（生产推荐）
env.setStateBackend(new EmbeddedRocksDBStateBackend());

// Checkpoint 配置
env.enableCheckpointing(60_000);  // 60s 一次
CheckpointConfig config = env.getCheckpointConfig();
config.setCheckpointStorage("s3://flink-checkpoints/jd/");  // 外部存储
config.setMinPauseBetweenCheckpoints(30_000);   // 两次 CP 间隔 30s
config.setCheckpointTimeout(300_000);            // 超时 5min
config.setMaxConcurrentCheckpoints(1);           // 同时只 1 个 CP
config.setTolerableCheckpointFailureNumber(3);   // 允许失败 3 次
config.setExternalizedCheckpointCleanup(
    CheckpointConfig.ExternalizedCheckpointCleanup.RETAIN_ON_CANCELLATION);  // 取消时保留

// 开启非对齐 Checkpoint（反压时用）
config.enableUnalignedCheckpoints();
```

## 三、实战层：端到端 Exactly-Once

### 3.1 Source：Kafka 可重放

```java
// Kafka Source 默认支持 Exactly-Once（offset 作为 State 保存）
KafkaSource<String> source = KafkaSource.<String>builder()
    .setBootstrapServers("kafka.jd.local:9092")
    .setTopics("order-events")
    .setGroupId("gmv-calculator")
    .setStartingOffsets(OffsetsInitializer.earliest())
    .setValueOnlyDeserializer(new SimpleStringSchema())
    .build();
```

### 3.2 算子：状态计算

```java
public class GmvAggregator extends KeyedProcessFunction<String, OrderEvent, Result> {
    private transient ValueState<BigDecimal> gmvState;
    
    @Override
    public void open(Configuration parameters) {
        ValueStateDescriptor<BigDecimal> descriptor = new ValueStateDescriptor<>(
            "gmv", Types.BIG_DEC);
        // TTL（可选）：状态 1 天过期
        StateTtlConfig ttl = StateTtlConfig.newBuilder(Time.days(1))
            .setUpdateType(StateTtlConfig.UpdateType.OnCreateAndWrite)
            .cleanupInRocksdbCompactFilter(1000)
            .build();
        descriptor.enableTimeToLive(ttl);
        gmvState = getRuntimeContext().getState(descriptor);
    }
    
    @Override
    public void processElement(OrderEvent order, Context ctx, Collector<Result> out) 
            throws Exception {
        BigDecimal current = gmvState.value();
        if (current == null) current = BigDecimal.ZERO;
        current = current.add(order.getAmount());
        gmvState.update(current);
        
        out.collect(new Result(order.getCategory(), current));
    }
}
```

### 3.3 Sink：两阶段提交（2PC）

**这是端到端 Exactly-Once 的关键**——Sink 必须支持两阶段提交：

```java
// Kafka Sink（Flink 内置两阶段提交）
KafkaSink<String> sink = KafkaSink.<String>builder()
    .setBootstrapServers("kafka.jd.local:9092")
    .setRecordSerializer(new SimpleStringSchema("gmv-result"))
    .setDeliveryGuarantee(DeliveryGuarantee.EXACTLY_ONCE)  // 关键！
    .setTransactionalIdPrefix("gmv-tx-")                    // 事务 ID 前缀
    .build();
```

**自定义两阶段提交 Sink**（写 MySQL/Redis）：

```java
public class TwoPhaseCommitSink extends TwoPhaseCommitSinkFunction<Result, 
        Connection, Void> {
    
    public TwoPhaseCommitSink() {
        super(new KryoSerializer<>(Connection.class, env.getConfig()), 
              VoidSerializer.INSTANCE);
    }
    
    // 阶段1：开启事务，预提交
    @Override
    protected Connection beginTransaction() throws Exception {
        Connection conn = DriverManager.getConnection(
            "jdbc:mysql://mysql.jd.local/gmv", "user", "pwd");
        conn.setAutoCommit(false);  // 关键：手动提交
        return conn;
    }
    
    // 阶段1：执行业务（数据写入但不提交）
    @Override
    protected void invoke(Connection tx, Result value, Context context) 
            throws Exception {
        try (PreparedStatement ps = tx.prepareStatement(
                "INSERT INTO t_gmv_result (category, amount, window_end) " +
                "VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE amount = VALUES(amount)")) {
            ps.setString(1, value.getCategory());
            ps.setBigDecimal(2, value.getAmount());
            ps.setLong(3, value.getWindowEnd());
            ps.executeUpdate();
        }
    }
    
    // 阶段2：预提交（Checkpoint 完成时调用）
    @Override
    protected void preCommit(Connection tx) throws Exception {
        // 可选：做一些预检查
    }
    
    // 阶段2：正式提交（JobManager 确认所有算子 Checkpoint 成功后调用）
    @Override
    protected void commit(Connection tx) {
        try {
            tx.commit();  // 真正提交事务
            tx.close();
        } catch (Exception e) {
            throw new RuntimeException("Commit failed", e);
        }
    }
    
    // 回滚（Checkpoint 失败时调用）
    @Override
    protected void abort(Connection tx) {
        try {
            tx.rollback();
            tx.close();
        } catch (Exception e) {
            log.error("Rollback failed", e);
        }
    }
}
```

### 3.4 完整 Exactly-Once 任务

```java
public class RealtimeGmvJob {
    public static void main(String[] args) throws Exception {
        StreamExecutionEnvironment env = StreamExecutionEnvironment.getExecutionEnvironment();
        
        // 1. Checkpoint 配置（Exactly-Once 基础）
        env.enableCheckpointing(60_000, CheckpointingMode.EXACTLY_ONCE);
        env.setStateBackend(new EmbeddedRocksDBStateBackend());
        env.getCheckpointConfig().setCheckpointStorage("s3://flink-cp/jd/");
        env.getCheckpointConfig().setMinPauseBetweenCheckpoints(30_000);
        
        // 2. Kafka Source（可重放）
        DataStream<OrderEvent> orders = env.fromSource(
            KafkaSource.<OrderEvent>builder()
                .setBootstrapServers("kafka.jd.local:9092")
                .setTopics("order-events")
                .setValueOnlyDeserializer(new OrderEventDeserializer())
                .build(),
            WatermarkStrategy.forBoundedOutOfOrderness(Duration.ofSeconds(5)),
            "order-source"
        );
        
        // 3. 过滤 + KeyBy + 聚合
        DataStream<Result> gmv = orders
            .filter(e -> "PAID".equals(e.getStatus()))
            .keyBy(OrderEvent::getCategory)
            .window(TumblingEventTimeWindows.of(Time.minutes(1)))
            .aggregate(new GmvAggregator());
        
        // 4. 两阶段提交 Sink（端到端 Exactly-Once）
        gmv.addSink(new TwoPhaseCommitSink());
        
        env.execute("realtime-gmv-exactly-once");
    }
}
```

### 3.5 故障恢复

```
1. 任务失败（如 TaskManager OOM）
2. JobManager 检测失败，从最近成功的 Checkpoint 重启
3. Source 从 Checkpoint 记录的 Kafka offset 开始重新消费
4. 算子从 Checkpoint 的 State 恢复
5. Sink 重新执行未完成的事务
6. 数据"看起来"像没失败过（Exactly-Once）
```

```bash
# 从指定 Checkpoint 恢复
flink run -s s3://flink-cp/jd/chk-1234 --allowNonRestoredState -p job.jar
```

## 四、底层本质：为什么 Exactly-Once 难

### 4.1 First Principle：分布式状态一致性 = 快照 + 重放

Exactly-Once 的本质是**让"失败 + 恢复"等价于"没有失败"**。

实现方式：
1. **快照（Checkpoint）**：定期保存所有状态
2. **重放（Replay）**：从快照点重新处理
3. **幂等/事务（Sink）**：重放的结果不重复

关键洞察：**快照必须是"一致性快照"**——所有算子的状态对应同一时刻的数据流位置。Chandy-Lamport 用 Barrier 实现了这一点。

### 4.2 为什么 Sink 必须 2PC

假设 Sink 直接 write-through：
1. Checkpoint N 完成
2. Sink 写入数据 D
3. 任务失败
4. 从 Checkpoint N 恢复
5. 重新处理数据 D → **D 被写入两次**

两阶段提交解决：
1. Checkpoint N 开始
2. Sink 预写 D（事务开启，未提交）
3. Checkpoint N 完成 → Sink 提交
4. 如果失败 → Sink 回滚（D 不会被提交）

### 4.3 Feynman 解释

把 Flink 任务想象成"流水线工人组装产品"。
- State：每个工人手上的半成品
- Checkpoint：每隔 1 分钟，所有工人同时把手上的半成品拍照存档
- Barrier：拍照信号（传到每个工人）
- 失败恢复：从上次照片重做，所有工人恢复到照片时的状态
- Source 重放：原料从上次照片时的位置重新上料
- Sink 两阶段提交：成品先暂存（不发货），拍照确认后才发货；如果失败就销毁暂存的成品

整个流水线"看起来"像没失败过——这就是 Exactly-Once。

## 五、AI 架构师加问

**Q1：Checkpoint 间隔设多少？**
- 实时性要求高：30s-1min
- 状态大（TB）：2-5min（避免 Checkpoint 占用太多资源）
- 反压时：开启非对齐 Checkpoint，避免对齐阻塞

**Q2：Checkpoint 失败怎么办？**
- 默认任务失败重启（从上一个成功 CP）
- `tolerableCheckpointFailureNumber=3`：允许 3 次失败不重启
- 持续失败要排查（反压？状态太大？网络？）

**Q3：RocksDB State 性能怎么样？**
- 比 HashMap 慢（磁盘 IO），但支持 TB 级状态
- 用 SSD、增加 RocksDB 内存缓存、调 block size 可优化
- 增量 Checkpoint（只传变化部分）大幅减少 IO

**Q4：Flink 的 Exactly-Once 和 Kafka 的 Exactly-Once 什么关系？**
- Kafka EOS：生产端幂等 + 事务（跨 Partition 原子）
- Flink EOS：框架级（Source 重放 + Checkpoint + Sink 2PC）
- 端到端 EOS：Flink 消费 Kafka（Source 可重放）+ Flink 写 Kafka（Sink 两阶段提交 Kafka 事务）

**Q5：反压时 Checkpoint 会失败吗？**
会。对齐 Checkpoint 在反压时会阻塞更久，可能超时。解决：
- 开启非对齐 Checkpoint（不等待对齐）
- 增大 Checkpoint 超时
- 解决反压根因（下游慢？数据倾斜？）

## 六、记忆口诀

```
Flink 三件套：State、Checkpoint、Exactly-Once。
State 五类型：Value/List/Map/Reducing/Broadcast。
Checkpoint Chandy-Lamport，Barrier 对齐快照。
RocksDB 存大状态，增量 CP 省 IO。
端到端 EOS 三要素：Source 可重放、Checkpoint、Sink 2PC。
两阶段提交：beginTransaction → invoke → preCommit → commit/abort。
```

## 七、苏格拉底追问

| 层级 | 问题 | 关键答案 |
|------|------|----------|
| L1 表象 | Checkpoint 是什么？ | 定期把所有算子 State 快照到外部存储 |
| L2 机制 | Barrier 怎么实现快照？ | Chandy-Lamport 算法，Barrier 随数据流传播 |
| L3 边界 | 对齐 vs 非对齐 Checkpoint？ | 对齐等慢上游可能阻塞；非对齐不阻塞但 State 大 |
| L4 权衡 | HashMap vs RocksDB State？ | 前者快但受堆内存限制；后者慢但支持 TB 级 |
| L5 反例 | Sink 不用 2PC 会怎样？ | 失败重启后数据被写两次（At-least-once） |
| L6 极限 | TB 级状态 Checkpoint 慢？ | 增量 Checkpoint + RocksDB + S3 分层 |
| L7 系统 | JD 实时数仓 Flink 部署？ | K8s + Flink K8s Operator + S3 Checkpoint |

**对话还原**：
> 面试官：Flink 怎么保证不丢不重？
> 我：三层——Checkpoint 保存状态，Source 可重放（Kafka offset 在 State 里），Sink 两阶段提交（事务保证不重复）。
> 面试官：Checkpoint 原理？
> 我：Chandy-Lamport 算法。JobManager 定期注入 Barrier，算子收到 Barrier 后快照 State 并转发。所有算子完成 = Checkpoint 成功。
> 面试官：Sink 两阶段提交怎么写？
> 我：继承 TwoPhaseCommitSinkFunction，实现 beginTransaction/invoke/preCommit/commit/abort。beginTransaction 开启 DB 事务，invoke 预写，commit 在 CP 成功后真正提交。
> 面试官：反压时 Checkpoint 超时？
> 我：开非对齐 Checkpoint，不等待 Barrier 对齐。代价是 State 变大（含 in-flight 数据）。
> 面试官：状态 TB 级怎么办？
> 我：RocksDB State Backend + 增量 Checkpoint（只传变化）。我们最大单任务状态 3TB，增量 CP 约 30s。

## 八、常见考点

1. **State 五种类型** —— Value/List/Map/Reducing/Broadcast
2. **Checkpoint 原理** —— Chandy-Lamport + Barrier，必考
3. **对齐 vs 非对齐** —— 反压场景的关键
4. **State Backend 选型** —— HashMap（小）/ RocksDB（大）
5. **端到端 Exactly-Once 三要素** —— Source 重放 + CP + Sink 2PC
6. **TwoPhaseCommitSinkFunction** —— 必会实现
7. **故障恢复** —— 从 Checkpoint 重启
8. **Checkpoint 参数调优** —— 间隔、超时、并发数

## 结构化回答

**30 秒电梯演讲：** 京东实时交易大盘，用 Flink 消费 Kafka 订单流计算 GMV。要求：Flink 任务重启不能丢数据、不能重复计算、结果秒级一致

**展开框架：**
1. **State 五种类型** — State 五种类型 —— Value/List/Map/Reducing/Broadcast
2. **Checkpoint 原理** — Checkpoint 原理 —— Chandy-Lamport + Barrier，必考
3. **对齐 vs 非对齐** — 对齐 vs 非对齐 —— 反压场景的关键

**收尾：** 以上是我的整体思路。您想继续深入聊——Checkpoint 是什么？


## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：Flink 状态、Checkpoint 与 Ex | "这题一句话：京东实时交易大盘，用 Flink 消费 Kafka 订单流计算 GMV。" | 开场钩子 |
| 0:15 | State 五种类型示意/对比图 | "State 五种类型 —— Value/List/Map/Reducing/Broadcast" | State 五种类型要点 |
| 0:40 | Checkpoint 原理示意/对比图 | "Checkpoint 原理 —— Chandy-Lamport + Barrier，必考" | Checkpoint 原理要点 |
| 1:05 | 对齐 vs 非对齐示意/对比图 | "对齐 vs 非对齐 —— 反压场景的关键" | 对齐 vs 非对齐要点 |
| 1:55 | 总结卡 | "记住：State 五种类型。下期见。" | 收尾 |
