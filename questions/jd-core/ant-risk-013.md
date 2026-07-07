---
id: ant-risk-013
difficulty: L3
category: jd-core
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
