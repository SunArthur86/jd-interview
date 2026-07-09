---
id: pdd-scm-009
difficulty: L3
category: pdd-scm
subcategory: 实时计算
tags:
- 拼多多
- 供应链
- Flink
- 实时计算
- 流处理
feynman:
  essence: Flink 用"流式增量计算 + 状态后端 + Checkpoint"实现毫秒级实时统计，供应链的实时销量榜、库存预警、大促监控都靠它。
  analogy: 批处理像定期盘点（攒一批算），Flink 像流水线（来一个算一个），用"仓库账本（状态）"记住累计值，账本定期快照（Checkpoint）防丢。
  first_principle: 实时统计需要"过去 N 分钟的累计"，全量重算不可行；流处理用状态保存中间结果，每来一条增量更新，查询时 O(1)。
  key_points:
  - 流式 vs 批式：来一条算一条 vs 攒一批算
  - 状态后端（RocksDB）保存窗口累计
  - Checkpoint（Chandy-Lamport）保证 exactly-once
  - Watermark 处理乱序事件
first_principle:
  problem: 实时业务（销量榜、库存预警）需要毫秒级统计窗口数据，批量重算延迟太高，如何实现？
  axioms:
  - 数据流是无限的
  - 决策需要即时统计
  - 全量重算成本高
  rebuild: 流式计算——每条事件增量更新状态（窗口累计），Checkpoint 定期快照保证 exactly-once，决策时查状态 O(1)。
follow_up:
- Flink 的 Checkpoint 怎么保证 exactly-once？——Chandy-Lamport，barrier 对齐 + 状态快照
- 供应链实时场景？——实时 GMV 大盘、库存低于阈值预警、热销商品榜
- Flink 和 Spark Streaming 区别？——Flink 真流式（毫秒），Spark 微批（秒级）
memory_points:
- Flink = 流式 + 状态 + Checkpoint
- Checkpoint：Chandy-Lamport 算法（barrier 对齐 + 状态快照）
- Watermark：处理乱序（最大延迟容忍）
- 状态后端：RocksDB（大状态，可增量）
---

# 【拼多多供应链】Flink 怎么做实时计算？供应链的实时场景？

> JD 依据："熟悉 flink 等"。

## 一、Flink 核心概念

**流式处理**：来一条算一条（毫秒延迟），对比 Spark Streaming 的微批（秒级）。

**三大核心**：
1. **状态**：保存累计结果（如近 1 小时销量）
2. **Checkpoint**：周期性状态快照，保证 exactly-once
3. **Watermark**：处理乱序事件（最大延迟容忍）

## 二、供应链实时场景

**场景 1：实时 GMV 大盘**
```java
orderStream
    .keyBy(e -> e.getCategory())              // 按类目分组
    .window(TumblingEventTimeWindows.of(Time.minutes(1)))  // 1 分钟窗口
    .aggregate(new SumAggregator("amount"))   // 累加金额
    .addSink(new DashboardSink());            // 写大盘
```

**场景 2：库存预警**
```java
stockEventStream
    .filter(e -> e.getStock() < e.getThreshold())  // 库存低于阈值
    .addSink(new AlertSink());                     // 报警
```

**场景 3：热销商品榜（Top N）**
```java
orderStream
    .keyBy(e -> e.getSkuId())
    .window(SlidingEventTimeWindows.of(Time.hours(1), Time.minutes(5)))
    .aggregate(new CountAggregator())
    .keyBy(w -> "all")
    .process(new TopNFunction(10))  // 每窗口 Top 10
    .addSink(new HotListSink());
```

## 三、Checkpoint 保证 exactly-once

**Chandy-Lamport 算法**：
```
1. JobManager 周期性向 Source 注入 barrier
2. barrier 随数据流向下游
3. 算子收到所有上游 barrier 后对齐 → 状态快照
4. 全部算子完成 → Checkpoint 成功
5. 故障时从最近 Checkpoint 恢复
```

**配置**：
```java
env.enableCheckpointing(60000);                    // 60s 一次
env.getCheckpointConfig().setMinPauseBetweenCheckpoints(30000);
env.getCheckpointConfig().setCheckpointTimeout(600000);
env.setStateBackend(new RocksDBStateBackend("hdfs:///checkpoints"));  // 大状态
```

## 四、Watermark 处理乱序

事件可能因网络延迟乱序到达。Watermark = "当前最大事件时间 - 最大延迟容忍"。

```java
watermarkStrategy = WatermarkStrategy
    .<OrderEvent>forBoundedOutOfOrderness(Duration.ofSeconds(5))  // 允许 5s 乱序
    .withTimestampAssigner((e, t) -> e.getEventTime());

orderStream.assignTimestampsAndWatermarks(watermarkStrategy)
    .window(TumblingEventTimeWindows.of(Time.minutes(1)))
    ...
```

晚于 Watermark 的事件被丢弃或走侧输出。

## 五、状态后端

| 后端 | 特点 | 适用 |
|------|------|------|
| HashMapStateBackend | 内存，快 | 小状态 |
| RocksDBStateBackend | 磁盘（RocksDB），可增量 | 大状态（GB-TB） |

供应链的状态通常较大（百万 SKU 的累计），用 RocksDB。

## 六、底层本质：流处理的"增量计算"哲学

**批 vs 流的根本差异**：
- 批：攒一批全量重算（延迟高，简单）
- 流：来一条增量更新状态（延迟低，需状态管理）

状态是"过去的压缩"，查询时 O(1)。这是实时计算能毫秒响应的本质。

## 常见考点
1. **Flink exactly-once 怎么保证**？——Checkpoint（barrier 对齐）+ 幂等 sink（如 MySQL upsert）。
2. **Watermark 作用**？——处理乱序，Watermark = 最大事件时间 - 延迟容忍，晚于 Watermark 的丢弃。
3. **Flink vs Spark Streaming**？——Flink 真流（毫秒）、Spark 微批（秒）；Flink 状态管理强，Spark 生态全。
