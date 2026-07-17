---
id: ant-risk-013
difficulty: L3
category: ant-risk
subcategory: 特征工程
tags:
- 蚂蚁
- 风控
- 特征工程
- 实时计算
- Flink
- Kafka
feynman:
  essence: 特征工程把原始数据加工成模型/规则可用的"数值化标签"，实时计算用流式处理（Flink+Kafka）做毫秒级特征聚合，是智能风控的数据基础。
  analogy: 特征像菜——原始交易、行为、设备数据是食材，特征工程是切配（清洗、加工），实时计算是大火快炒（毫秒出餐），输出给规则引擎（顾客点单即用）。
  first_principle: 风控决策依赖"过去 N 分钟/天/月的统计"，原始数据不能直接用，必须预聚合。流式计算用增量更新（每来一条更新统计）替代批量重算，做到实时。
  key_points:
  - 特征类型：身份特征、行为特征、关系特征、时序特征
  - 离线特征（T+1 Hadoop/Spark）vs 实时特征（Flink 毫秒）
  - 特征平台：特征注册、计算、存储、服务的统一管理
  - 滑动窗口、会话窗口、水位线
  - 状态后端（RocksDB）+ Checkpoint 保证 exactly-once
first_principle:
  problem: 风控决策需要"过去 X 时间窗口的统计特征"（如近 1 小时交易次数），如何在毫秒内拿到？
  axioms:
  - 原始事件流是无限的
  - 决策时刻需要即时的统计
  - 全量重算不可行（数据量大）
  rebuild: 流式计算——每来一条事件就增量更新统计（如近 1 小时交易次数 +1），状态保持在内存/RocksDB，决策时 O(1) 查询。
follow_up:
- Flink 的 Checkpoint 怎么保证 exactly-once？——Chandy-Lamport 算法，barrier 对齐 + 状态快照
- 离线和实时特征不一致怎么办？——用同一份 SQL 逻辑（特征平台），定期对账
- 特征查询 RT 要求？——风控决策是同步链路，特征查询要 <50ms（HBase + Redis 缓存）
memory_points:
- 特征 = 原始数据的数值化标签，规则和模型的输入
- 实时特征（Flink 流式增量）+ 离线特征（Spark 批量）双轨
- 特征平台：统一特征定义、计算、存储、服务（避免重复造轮子）
- 风控特征 RT 要求 <50ms，靠 HBase 存 + Redis 热缓存
---

# 【蚂蚁风控】风控的特征工程怎么做的？实时特征怎么算？

> JD 依据："智能化数据平台"。特征是风控决策的输入，特征平台是智能风控的基础。

## 一、表面层：什么是风控特征

**特征 = 把原始数据加工成模型/规则可用的数值化标签**。

举例（一笔交易事件的特征）：
```
原始数据: {uid: 500, amount: 6000, merchant: M1, time: 22:30, device: dev123}

加工成特征:
  - 用户近 1 小时交易次数: 8
  - 用户近 7 天累计金额: 35000
  - 用户近 30 天登录设备数: 5
  - 商户近 1 小时拒绝率: 0.15
  - 设备关联账号数: 12
  - 与历史交易金额差异: +500%（正常 <100）
```

这些特征喂给规则引擎和模型做决策。

## 二、特征分类

| 类型 | 例子 | 时效 |
|------|------|------|
| **身份特征** | 年龄、地区、注册时长 | 离线（更新慢） |
| **行为特征** | 近 1 小时交易次数、金额 | 实时 |
| **关系特征** | 设备关联账号数、IP 共享数 | 准实时 |
| **时序特征** | 交易频率突变、金额异常 | 实时 |
| **聚合特征** | 同商户/同设备群体统计 | 准实时 |
| **图特征** | 关系网络中心度、社区归属 | 离线（图计算） |

## 三、离线 vs 实时特征

**离线特征**（T+1）：
- 数据源：Hive/HDFS（历史全量）
- 计算：Spark 批处理
- 存储：HBase
- 适合：长期统计（如近 90 天）、图特征

**实时特征**（毫秒）：
- 数据源：Kafka（实时事件流）
- 计算：Flink 流式
- 存储：HBase + Redis（热缓存）
- 适合：短期窗口统计（近 1 小时、近 10 分钟）

**双轨一致性**：用同一份 SQL 在离线和实时算同一特征，定期对账。

## 四、Flink 实时特征计算（核心）

**架构**：
```
交易/登录/行为事件 → Kafka → Flink Job → 特征聚合 → HBase + Redis
                                      ↓
                                  状态后端（RocksDB）保存窗口状态
```

**典型算子**：
```java
DataStream<Event> events = env.addSource(new FlinkKafkaConsumer<>("events", ...));

events
    .keyBy(e -> e.uid)                              // 按用户分组
    .window(SlidingEventTimeWindows.of(             // 滑动窗口
        Time.hours(1),    // 窗口大小 1 小时
        Time.minutes(5))) // 步长 5 分钟
    .aggregate(new CountAggregator())               // 聚合
    .addSink(new HBaseSink("user_feature"));        // 写入
```

**统计近 1 小时交易次数**：
- 滑动窗口大小 1h，步长 5min
- 每来一条事件，对应窗口计数 +1
- 输出 `(uid, hour_window, count)` 到 HBase

**关键概念**：
- **EventTime vs ProcessingTime**：用事件时间（事件本身的时间）保证准确性
- **Watermark**：处理乱序事件（最大延迟容忍）
- **Checkpoint**：周期性状态快照（barrier 对齐），保证 exactly-once

## 五、特征平台（智能风控的核心）

**痛点**：每个算法工程师各算各的特征 → 重复造轮子、口径不一致、上线慢。

**特征平台（Feature Store）**：
```
特征平台
  ├─ 特征注册（命名、定义、版本）
  ├─ 特征计算（离线 Spark + 实时 Flink）
  ├─ 特征存储（离线 Hive + 在线 HBase）
  └─ 特征服务（统一查询接口）
```

**统一特征定义**：
```yaml
feature:
  name: user_trade_count_1h
  type: REAL_TIME
  sql: |
    SELECT uid, COUNT(*) as cnt, window_end
    FROM trades
    GROUP BY uid, HOP(1h, 5min)
  storage: hbase
  ttl: 7d
  owner: risk-team
```

- 算法定义特征，平台负责计算、存储、服务
- 特征复用：多个模型用同一特征
- 一致性：离线和在线用同一份 SQL

**主流方案**：Feast（开源）、自研（蚂蚁的特征中台）。

## 六、风控特征服务的性能要求

风控决策是**同步链路**（用户支付等结果），特征查询必须 <50ms：

**架构**：
```
决策请求 → 特征服务（<50ms RT）
   ├─ Redis 热缓存（10ms 命中率 95%）
   ├─ HBase（30ms 兜底）
   └─ Flink 实时更新（异步）
```

**优化**：
- **批量查询**：一次请求合并多个特征查询（避免多次 RT）
- **本地缓存**：决策服务本地缓存热点用户（Caffeine）
- **预热**：开屏/活跃用户预先加载

## 七、底层本质：流处理的"增量计算"哲学

批处理 vs 流处理的根本差异：
- **批处理**（Spark）：攒一批 → 全量重算
- **流处理**（Flink）：来一条 → 增量更新

**统计"近 1 小时交易次数"**：
- 批：每小时扫全量数据算一次（延迟 1 小时）
- 流：每来一条 +1，过期 -1（延迟毫秒）

流处理的本质是**"用状态保存中间结果"**：
- 状态是过去事件的"压缩"
- 新事件来时更新状态（增量）
- 决策时查状态（O(1)）

**这就是为什么 Flink 适合风控**——风控需要"窗口内统计"，而窗口状态可以被增量维护，避免全量重算。

**和 AI 的关系**：实时特征是 AI 风控模型的基础——模型只能用"特征"做决策，特征质量和实时性决定模型上限。

## 常见考点
1. **Flink 的 Watermark 怎么处理乱序**？——基于事件时间 + Watermark（最大延迟容忍度），早到的处理、晚到的丢或侧输出。
2. **特征平台的离线在线一致性**？——同 SQL 双跑 + 定期对账；Feast 等框架自动保证。
3. **如何处理特征缺失**？——默认值、最近一次有效值、模型可处理缺失（树模型）。

**代码示例**（Redis 特征查询优化）：
```java
// 用 Pipeline 批量查询多个特征
Jedis jedis = pool.getResource();
Pipeline pipe = jedis.pipelined();
Response<String> f1 = pipe.hget("feat:" + uid, "trade_cnt_1h");
Response<String> f2 = pipe.hget("feat:" + uid, "amount_sum_7d");
Response<String> f3 = pipe.hget("feat:" + uid, "device_cnt_30d");
pipe.sync();
// 3 次查询合并成 1 次 RTT
```

## 苏格拉底式面试追问

> 这组追问不是背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：风控的实时特征你用 Flink 滑动窗口（1h 窗口、5min 步长），而不是用 Redis 的 ZSET 自己维护时间序列。Flink 的价值在哪？决策依据是什么？**

Redis 的 ZSET 能做"近 1 小时交易次数"（ZADD 时间戳为 score，ZCOUNT 算区间），但有两个瓶颈。一是计算位置——每次决策时在 Redis 现算（ZCOUNT + ZREMRANGEBYSCORE 清理），QPS 万级时 Redis CPU 飙升，且窗口逻辑分散在多个业务代码里维护成本高。二是状态管理——滑动窗口要维护"未过期的所有事件"，1 小时窗口内某大用户可能有几万条交易，ZSET 全量存内存成本高。Flink 把计算从"查询时现算"前移到"事件来时增量算"——每来一条事件，Flink 的窗口聚合器更新一个计数值（状态只存聚合结果不存明细），决策时只查一个数值（O(1)）。决策依据是 TCO——Flink 集群 20 台机器算所有用户的特征，Redis 方案要给每个大用户存明细、QPS 压力大，成本和性能都不如 Flink。Flink 还提供 watermark 处理乱序、checkpoint 保证 exactly-once，这些 Redis 自己实现成本极高。

### 第二层：证据与定位

**Q：风控决策时查实时特征发现 trade_cnt_1h=0，但用户明明刚交易了 5 次。你怎么定位是 Flink 没算出来还是特征服务查询的问题？**

三段式定位（沿数据流逆流而上）：
1. 先查 HBase（特征最终存储）——`hbase shell: get 'user_feature', 'uid_500', {COLUMN => 'cf:trade_cnt_1h'}`，看值是否为 0。如果 HBase 是 0，是 Flink 没写入；如果 HBase 有值（如 5）但查询返回 0，是特征服务或缓存问题。
2. 如果 HBase 是 0，查 Flink——看 Flink Job 的 metrics：`numRecordsIn`（消费了多少 Kafka 消息）、`numRecordsOut`（输出了多少特征）。如果 In 在涨但 Out 不涨，是 Flink 算子卡住（如 keyBy 后某 key 数据倾斜、或算子抛异常进死锁）。看 Flink WebUI 的 backpressure 指标，如果某算子 backpressure=100%，是下游慢导致上游堆积。同时看 watermark 是否推进（如果 watermark 卡在几小时前，事件时间窗口不触发，特征不更新）。
3. 如果 Flink In 不涨，查 Kafka——`kafka-consumer-groups.sh --describe --group risk-flink` 看 lag。如果 lag 几百万，是 Flink 消费跟不上（消费速度 < 生产速度），特征延迟。

### 第三层：根因深挖

**Q：你发现 Flink 的 watermark 卡在 2 小时前，导致 1h 窗口不触发。根因是什么？为什么 watermark 不推进？**

Watermark 是 Flink 事件时间的"逻辑时钟"，卡住说明有"迟到很久的事件"在拖。根因看两点：
1. Kafka 分区不均——如果某个 Kafka 分区没数据（生产者没往那个分区写），基于"所有分区最小 watermark"的策略下，watermark 被这个空闲分区卡住。这是 Flink 的已知坑（空闲源问题）。看 Flink WebUI 的 Source 算子各分区 watermark，如果某分区 watermark 是 Long.MIN_VALUE 或远低于其他，是空闲分区。解法是 `WatermarkStrategy.forBoundedOutOfOrderness` 配 `withIdleness(Duration.ofMinutes(5))`，标记空闲分区。
2. 真实迟到事件——如果数据源（如 App 上报）有大量延迟上报的事件（事件时间戳是 2 小时前），且 watermark 策略 `forBoundedOutOfOrderness(Duration.ofMinutes(10))` 允许 10 分钟乱序，但实际乱序 2 小时，watermark 会被这些事件拉低。看 Source 的 `currentOutputWatermark` 和事件时间分布，如果大量事件时间戳 < watermark，是数据源问题。解法是调大 allowed lateness 或在 Source 前过滤明显迟到的事件。

**Q：根因是 Kafka 空闲分区卡 watermark。那为什么不直接用 ProcessingTime（处理时间）替代 EventTime？就不存在 watermark 问题了。**

ProcessingTime 确实没 watermark 问题，但它会"丢精度"。风控特征要求"近 1 小时交易次数"——EventTime 按事件发生时间算（用户 22:00 交易的事件就算进 22:00 的窗口），ProcessingTime 按 Flink 处理时间算（事件 22:00 发生但 22:30 才被 Flink 处理，就算进 22:30 的窗口）。如果 Flink 消费有延迟（Kafka lag），ProcessingTime 会把"过去的事件"算进"现在的窗口"，特征失真。风控场景下，一笔欺诈交易如果因网络延迟晚到 5 分钟，EventTime 仍能正确归入发生时刻的窗口，ProcessingTime 会错误归入处理时刻的窗口。精度损失对风控是硬伤（误判漏判），所以必须用 EventTime + watermark，并解决空闲分区问题（withIdleness）。

### 第四层：方案权衡

**Q：你解决了 watermark 问题，特征实时性恢复了。但业务说 Flink checkpoint 导致状态后端（RocksDB）偶尔几秒级停顿，特征查询超时。怎么权衡 exactly-once 和延迟？**

checkpoint 的代价是"barrier 对齐 + 状态快照"，大状态下 checkpoint 可能耗时几秒，期间算子可能 backpressure。权衡方案是分级：
1. 对强一致要求的特征（如交易计数，用于扣款决策），保留 exactly-once（aligned checkpoint），接受偶发延迟，用 HBase + Redis 缓存兜底（决策查 Redis 不直接等 Flink）。
2. 对弱一致要求的特征（如"近 1 小时登录次数"用于风险打分，差一两次无碍），用 unaligned checkpoint（Flink 1.11+）或降低 checkpoint 频率（从 1 分钟到 5 分钟），减少停顿。
3. 状态分拆——把大状态（如全量用户窗口）拆成多个 Flink Job（按 uid hash 分），单 Job 状态小、checkpoint 快。
关键认知：风控特征查询走的是 HBase/Redis（Flink 的输出），不是直接查 Flink 状态。Flink checkpoint 停顿只影响"特征更新延迟"（Flink 写入 HBase 变慢），不影响"特征查询"（HBase/Redis 独立服务）。所以即使 Flink 停顿 5 秒，特征查询 RT 不受影响，只是特征值滞后 5 秒更新——这对"近 1 小时窗口"特征可接受。

**Q：为什么不直接用 Spark Structured Streaming 或 Kafka Streams 替代 Flink？它们也支持流处理。**

Kafka Streams 是轻量（嵌入应用），但它的状态后端不如 Flink 的 RocksDB 能支撑大状态（TB 级），且 exactly-once 依赖 Kafka 事务（所有源和汇都得是 Kafka）。风控特征要从 Kafka 算、写 HBase/Redis（非 Kafka），Kafka Streams 的 exactly-once 不适用。Spark Structured Streaming 是微批（默认 100ms 一批），延迟比 Flink 的纯流（毫秒）高一个量级，风控特征要求毫秒级更新，Spark 的秒级微批不够。Flink 的纯流 + 大状态 + exactly-once（含非 Kafka 源汇）组合是风控实时特征的最佳匹配。选型依据是延迟要求和状态规模——风控两者都要求高，Flink 是唯一选择。

### 第五层：验证与沉淀

**Q：你怎么验证实时特征的质量（准确性 + 实时性）？怎么知道 Flink 算的特征和离线 Spark 算的一致？**

双轨对账验证准确性和实时性：
1. 离线在线一致性对账——每天跑一个对账任务，取同一时间窗口（如昨天 10:00-11:00）的某特征（trade_cnt_1h），分别从离线 Spark 结果（Hive）和实时 Flink 结果（HBase）取值，按 uid 对比。统计"差异 >1% 的 uid 占比"应 <0.1%。常见差异来源是 watermark 丢事件（迟到事件在实时被丢、离线全量包含），通过调 allowed lateness 缩小差异。
2. 实时性指标——Flink 暴露 `currentOutputWatermark`，对比当前处理时间，差值应 <5 分钟（窗口触发延迟 + watermark 容忍）。同时监控 Kafka consumer lag，lag >10 万告警（消费跟不上）。
3. 端到端延迟埋点——在事件源头打时间戳（event_time），在特征写入 HBase 时算 `now - event_time`，上报 Prometheus，P99 应 <1 分钟（事件发生到特征可用）。

**Q：怎么让团队的特征开发规范、不踩实时计算的坑？**

沉淀成规范和平台：
1. 特征平台统一收口——所有特征必须通过特征平台注册（定义 SQL、类型、TTL），平台自动生成 Flink Job 和离线 Spark Job，保证离线在线一致。禁止各团队自己写 Flink Job。
2. SQL 化配置——特征定义用 SQL（Flink SQL 或平台 DSL），不用 DataStream API，降低复杂度和出错率。平台校验 SQL（必须有 watermark、必须有 keyBy、必须设 idle timeout）。
3. 监控基线——每个 Flink Job 暴露 numRecordsIn/Out、watermark、checkpoint 时长、consumer lag，Grafana 看板 + 告警（lag >10 万、checkpoint 失败、watermark 停滞 >10 分钟）。
4. 对账常态化——每天自动跑离线在线对账，差异 >阈值自动告警，特征 owner 必须复盘。
5. 故障复盘——把这次"Kafka 空闲分区卡 watermark → 1h 窗口不触发 → 特征为 0 → 决策漏判"的 Flink WebUI 截图、watermark 曲线、withIdleness 解法存知识库，作为"EventTime 必须处理空闲源"的案例。


## 结构化回答

**30 秒电梯演讲：** 聊到风控的特征工程怎么做的？实时特征怎么算，我的理解是——特征工程把原始数据加工成模型/规则可用的"数值化标签"，实时计算用流式处理（Flink+Kafka）做毫秒级特征聚合，是智能风控的数据基础。打个比方，特征像菜——原始交易、行为、设备数据是食材，特征工程是切配（清洗、加工），实时计算是大火快炒（毫秒出餐），输出给规则引擎（顾客点单即用）。

**展开框架：**
1. **特征类型** — 身份特征、行为特征、关系特征、时序特征
2. **离线特征（T+1 Hadoop/Spark）** — 离线特征（T+1 Hadoop/Spark）vs 实时特征（Flink 毫秒）
3. **特征平台** — 特征注册、计算、存储、服务的统一管理

**收尾：** 这块我在项目里也踩过坑——想深入的话，可以接着聊：Flink 的 Checkpoint 怎么保证 exactly-once？您更想看哪个方向？

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡 | "风控的特征工程怎么做的？实时特征怎么算——这道题面试官到底想考什么？我用 30 秒给你讲透。" | 开场钩子 |
| 0:15 | Kafka 架构图 | 先说核心：特征工程把原始数据加工成模型/规则可用的"数值化标签"，实时计算用流式处理（Flink+Kafka）做毫秒级特征聚合，是智能风控的数据基础。 | 核心定义 |
| 0:40 | 特征工程流程图 | 离线特征（T+1 Hadoop/Spark）vs 实时特征（Flink 毫秒）。 | 离线特征（T+1 Hadoop/Spark） |
| 1:05 | 概念结构示意图 | 特征注册、计算、存储、服务的统一管理。 | 特征平台 |
| 2:30 | 总结卡 | 一句话记忆：特征 = 原始数据的数值化标签，规则和模型的输入。 下期可以接着聊：Flink 的 Checkpoint 怎么保证 exactly-once。 | 收尾总结 |
