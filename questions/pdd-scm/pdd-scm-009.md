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

## 苏格拉底式面试追问

> 这组追问不是背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：供应链的实时 GMV 大盘，你用 Flink 而不是每小时跑一个离线 Spark 任务聚合。Flink 的成本（要维护状态后端、Checkpoint）值在哪？**

值在"决策时效"。供应链大促时，销量异动要在分钟级发现（某类目突然爆单要紧急补货），离线 Spark 每小时跑一次，发现问题已是 1 小时后，错过补货窗口。Flink 的实时聚合让大盘每秒更新，运营能在 5 分钟内响应。成本是确实要维护 Flink 集群（如 20 台机器）+ HDFS Checkpoint 存储，但相比"补货不及时导致的缺货损失"，ROI 划算。只有实时性要求低的场景（如 T+1 报表）才用离线。

### 第二层：证据与定位

**Q：实时 GMV 大盘突然归零（昨天还有数据）。你怎么定位是 Flink 任务挂了、Kafka 没数据，还是 Sink 写不进去？**

三段排查：
1. **Flink 任务状态**——Flink WebUI 看 job 状态，如果 `FAILED` 或 `RESTARTING`，任务挂了（看异常日志，常见是 OOM 或 Checkpoint 超时）。看 `numRecordsIn` 指标，如果 = 0，说明没消费数据。
2. **Kafka 数据源**——`kafka-console-consumer --topic order-events --from-beginning | tail`，看是否有新消息。`consumer_lag` 如果 > 0 说明 Kafka 有数据但 Flink 消费不动（反压或卡住）。
3. **Sink 写入**——看 `numRecordsOut`，如果 in 有数据但 out = 0，是 Sink 端写不进去（如大盘的 Redis/MySQL 连接满了）。看 Sink 算子的 `backPressure` 指标，如果高，是下游写慢导致反压。

### 第三层：根因深挖

**Q：Flink 任务每 10 分钟重启一次，日志显示 Checkpoint 超时（checkpoint expired before completing）。根因是什么？**

根因是 Checkpoint 做不完，常见三个原因：
1. **状态太大**——百万 SKU 的窗口状态（如近 1 小时销量）在 RocksDB 里涨到几十 GB，每次 Checkpoint 要把全量状态写到 HDFS，60s 内做不完。解法是开**增量 Checkpoint**（RocksDBStateBackend 支持，只传增量的 SST 文件）。
2. **反压**——下游 Sink 写得慢，barrier 随数据流被反压阻塞，barrier 对齐耗时。看 WebUI 的 `backPressure`，如果有算子 > 50%，就是反压。解法是优化 Sink（批量写、加并发）或加`setMinPauseBetweenCheckpoints`。
3. **对齐等待**——多上游算子 barrier 到达时间差大，等齐耗尽超时。改用 `AT_LEAST_ONCE`（不对齐，牺牲 exactly-once）或 `unalignedCheckpoint`（非对齐 Checkpoint，Flink 1.11+）。
定位：看 WebUI Checkpoint 的 `Duration` 详情，哪个算子的 `align` 时间长就是瓶颈。

**Q：那为什么不直接把 Checkpoint 间隔调大（从 60s 调到 5 分钟），让它有更多时间做完？**

调大间隔治标不治本，且有害：
1. **故障恢复丢更多数据**——Checkpoint 间隔越大，恢复时回退的数据越多。60s 间隔最多丢 1 分钟数据，5 分钟间隔丢 5 分钟，大促时 5 分钟的订单数据丢失不可接受。
2. **掩盖根因**——状态膨胀或反压是设计问题，调大间隔只是延缓 Checkpoint 失败，状态继续涨最终还是会超时。
3. **背压不解决**——下游写慢是 Sink 性能问题，调大 Checkpoint 不会让 Sink 变快。
正确做法是定位根因（增量 Checkpoint、优化 Sink、消除反压），间隔保持 60s-2min。

### 第四层：方案权衡

**Q：实时库存预警，库存低于阈值要报警。你用 Flink 监听库存变更事件触发预警，但库存变更频繁（每秒上万次），Flink 会不会成为瓶颈？**

会。每条库存变更都过 Flink 是过度设计——大多数库存变更是正常的（从 1000 扣到 999），不需要预警。优化方案：
1. **Flink 只处理异常**——把库存判断前置到 Redis Lua（扣减时如果 `stock < threshold` 就发预警事件到 Kafka），Flink 只消费预警事件（量级从 10 万/秒降到 100/秒），大幅减负。
2. **阈值状态用 Flink**——如果阈值是动态的（如"近 7 天日均销量的 20%"），Flink 维护滚动窗口算日均，定时（每 5 分钟）把"SKU→阈值"写回 Redis，Lua 扣减时读 Redis 阈值判断。Flink 做聚合，Redis 做实时判断，分工。

**Q：为什么不直接用 MySQL 触发器或定时任务查库存做预警，而要引入 Flink？**

MySQL 方案的三个问题：
1. **定时任务延迟高**——每 5 分钟扫一次 `SELECT * FROM stock WHERE qty < threshold`，千万 SKU 全表扫慢，且 5 分钟延迟内可能已经超卖。
2. **触发器影响写入**——MySQL 触发器在每次 UPDATE 时执行，大促写入 QPS 高，触发器拖慢扣减。
3. **阈值动态计算难**——"近 7 天日均销量的 20%"要跨天聚合，MySQL 做窗口聚合性能差。
Flink 的优势是流式增量计算 + 状态管理，适合"基于历史数据算动态阈值"。但简单场景（固定阈值 + 不要求秒级）用 Redis Lua 扣减时判断就够，不一定非要 Flink。按场景选工具。

### 第五层：验证与沉淀

**Q：你怎么证明 Flink 的 exactly-once 真的生效、故障恢复后数据不丢不重？**

两个验证：
1. **故障注入测试**——手动 kill Flink TaskManager，让任务从 Checkpoint 恢复。恢复后对比"恢复点的 GMV 值"和"业务侧对账值"（`SELECT SUM(amount) FROM orders WHERE create_time < 恢复时刻`），两者相等证明没丢没重。
2. **幂等 Sink 验证**——Sink 用 MySQL upsert（`INSERT ... ON DUPLICATE KEY UPDATE`），即使 Flink 重放同一批数据，upsert 保证结果幂等。监控 `flink_records_sent - mysql_rows_affected` 的差值，正常 = 0（重放不影响最终值）。

**Q：怎么让团队写 Flink 任务时不踩"状态膨胀 / 反压 / Checkpoint 失败"的坑？**

沉淀规范：
1. **Flink 任务模板**——封装好 Checkpoint 配置（60s 间隔、RocksDB 增量、unaligned）、Watermark 策略、Metric 上报，业务方只写算子逻辑。
2. **状态大小告警**——`flink_state_size` 指标接 Prometheus，单任务状态 > 50GB 告警，review 是否该清理（设 TTL `StateTtlConfig` 让过期状态自动清理）。
3. **反压巡检**——每天扫描所有 job 的 `backPressure` 指标，> 50% 的任务自动建工单优化 Sink（批量写、加并发、拆分算子）。

## 结构化回答

**30 秒电梯演讲：** 实时业务（销量榜、库存预警）需要毫秒级统计窗口数据，批量重算延迟太高，如何实现？简单说就是——Flink 用"流式增量计算 + 状态后端 + Checkpoint"实现毫秒级实时统计，供应链的实时销量榜、库存预警、大促监控都靠它。

**展开框架：**
1. **流式 vs 批式** — 流式 vs 批式：来一条算一条 vs 攒一批算
2. **状态后端R** — 状态后端（RocksDB）保存窗口累计
3. **Checkp** — Checkpoint（Chandy-Lamport）保证 exactly-once

**收尾：** 您看这块要不要再展开聊聊？

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：Flink 怎么做实时计算？供应链的实时场景？ | 今天聊「Flink 怎么做实时计算？供应链的实时场景？」。一句话：Flink 用"流式增量计算 + 状态后端 + Checkpoint"实现毫秒级实时统计，供应链的实时销量榜、库存预警… | 开场钩子 |
| 0:12 | 对比表：左右两栏差异 | 要点是：流式 vs 批式：来一条算一条 vs 攒一批算 | 核心概念 |
| 1:04 | 能力/参数拆解表 | 要点是：状态后端（RocksDB）保存窗口累计 | 能力拆解 |
| 1:56 | 流程图：输入→处理→输出 | 要点是：Checkpoint（Chandy-Lamport）保证 exactly-once | 关键机制 |
| 3:00 | 总结卡 + 下期预告 | 记住核心要点就够了。下期见。 | 收尾 |
