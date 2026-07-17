---
id: pdd-ai-012
difficulty: L3
category: pdd-ai
subcategory: Kafka
tags:
- 拼多多
- AI 中台
- Kafka
- 消息队列
- 事件驱动
feynman:
  essence: Kafka 是"高吞吐分布式消息队列"，生产者写 topic，消费者订阅；中台用它做事件驱动、削峰、解耦（用户行为/特征计算/模型事件）。
  analogy: 像电视台广播——节目（消息）发到频道（topic），观众（消费者）随时订阅看，录制（持久化）后还能回放。
  first_principle: 服务间直接调用会耦合且不能扛突发流量，引入中间队列解耦 + 削峰 + 异步。
  key_points:
  - 三角色：Producer / Broker（topic+partition） / Consumer Group
  - 高吞吐：顺序写 + 零拷贝 + 批量 + 分区并行
  - 消费组：同组内分区分担，不同组独立消费
  - 可靠性：副本 + ACK + 幂等/事务
  - 有序性：单分区内有序
first_principle:
  problem: 怎么在高并发下解耦服务、削峰填谷、可靠传递事件？
  axioms:
  - 服务直接耦合不利扩展
  - 流量有突发
  - 消息不能丢
  rebuild: Kafka（分区并行 + 副本 + 消费组 + 顺序写高性能）。
follow_up:
  - 怎么保证消息不丢？——Producer acks=all + 副本 + Consumer 手动提交 offset
  - 怎么保证消息有序？——同 key 进同分区（分区有序），全局有序单分区（牺牲并行）
  - 怎么处理重复消息？——幂等消费（业务唯一键去重）
memory_points:
  - 三角色：Producer/Broker/Consumer
  - 高吞吐：顺序写+零拷贝+批量
  - 消费组分区分担
  - 可靠：acks=all + 副本 + 幂等
---

# 【拼多多 AI 中台】Kafka 怎么用？消息队列怎么保证可靠性？

> JD 依据："MQ + 微服务、特征平台、实验平台"。

## 一、Kafka 架构

```
Producer ──┐
           ▼
┌─────────────────────────────────────┐
│ Broker 集群                          │
│  ┌─────────────────────────┐        │
│  │ topic: user_behavior    │        │
│  │   partition 0 [leader]  │←副本1  │
│  │   partition 1 [leader]  │←副本2  │
│  │   partition 2 [leader]  │←副本3  │
│  └─────────────────────────┘        │
└──────────┬──────────────────────────┘
           │
┌──────────▼──────────────────────────┐
│ Consumer Group                      │
│  consumer1 ← partition 0            │
│  consumer2 ← partition 1            │
│  consumer3 ← partition 2            │
└─────────────────────────────────────┘
```

## 二、为什么快

| 技术 | 说明 |
|------|------|
| **顺序写磁盘** | 追加写，磁盘顺序 IO 接近内存 |
| **零拷贝（sendfile）** | 内核态直接到网卡，避免 user space 拷贝 |
| **批量** | Producer 批量发送，Broker 批量写 |
| **分区并行** | 多分区并行读写，水平扩展 |
| **PageCache** | 利用 OS 缓存，读命中率高 |

单机每秒百万消息（顺序写 SSD）。

## 三、关键概念

- **Topic**：消息主题，逻辑分类
- **Partition**：分区，物理存储单位，并行单位
- **Offset**：分区内消息偏移量，消费位置
- **Replica**：副本（Leader + Follower）
- **Consumer Group**：消费组，组内分区分担，组间独立
- **ISR**（In-Sync Replicas）：和 Leader 同步的副本集合

## 四、可靠性保证

### 1. 生产端不丢
```java
Properties props = new Properties();
props.put("acks", "all");              // 所有 ISR 确认才算成功
props.put("retries", Integer.MAX_VALUE);
props.put("max.in.flight.requests.per.connection", "5");
props.put("enable.idempotence", "true");  // 幂等（避免重试重复）
// 事务（多分区原子写）
props.put("transactional.id", "order-tx");
```

### 2. Broker 不丢
- 副本机制（replication.factor=3，min.insync.replicas=2）
- ISR 同步后才算写入成功
- unclean.leader.election.enable=false（禁止非 ISR 副本当 Leader）

### 3. 消费端不丢
```java
props.put("enable.auto.commit", "false");   // 手动提交
// 业务处理完再提交 offset
consumer.subscribe(Collections.singletonList("topic"));
for (ConsumerRecord<String, String> rec : consumer.poll(Duration.ofMillis(100))) {
    process(rec);                            // 业务
    consumer.commitSync();                   // 手动提交
}
```

## 五、消息有序性

**分区有序**：
```java
// 同 key 进同分区（保证同用户消息有序）
ProducerRecord<String, String> rec = new ProducerRecord<>(
    "orders", userId, orderEvent);     // key=userId
producer.send(rec);
```

**全局有序**：单分区（牺牲并行，仅小流量场景）。

## 六、中台典型场景

### 1. 用户行为流（特征计算）
```
App 点击 → Kafka（user_behavior）→ Flink 实时聚合 → Redis（实时特征）
                                  → Hive（离线分析）
```

### 2. 模型推理事件（实验平台）
```
推理请求 → 记录特征+预测 → Kafka（inference_log）→ Flink 算指标 → 实验平台
```

### 3. 训练样本回流（特征日志）
```
推理时落特征快照 → Kafka（feature_log）→ 落 HDFS → 训练样本库
```

### 4. 系统解耦（模型上下线）
```
模型注册中心发布事件 → Kafka（model_events）→ 推理网关订阅 → 自动加载/卸载模型
```

### 5. 削峰（大促活动）
```
瞬时高并发请求 → 写 Kafka → 消费端按 GPU 容量平滑消费 → 避免雪崩
```

## 七、消费者设计

### 1. 分区分配
- Range（默认）：按区间分
- RoundRobin：轮询
- Sticky：尽量保持原分配（减少 rebalance 抖动）
- CooperativeSticky：增量 rebalance（KIP-429，减少抖动）

### 2. Rebalance 问题
消费者加入/退出会触发 rebalance，期间消费暂停。优化：
- 静态成员（group.instance.id）避免 rebalance
- 心跳/会话超时调大
- 减少业务长阻塞

### 3. 消费幂等
```java
// 业务唯一键去重
public void consume(OrderEvent event) {
    if (redis.setnx("consumed:" + event.getEventId(), "1", 86400) == 0) {
        return;  // 已消费
    }
    process(event);
}
```

## 八、底层本质

Kafka 本质是**"分区 + 副本 + 顺序写 + 零拷贝"**——分区提供并行扩展能力，副本保证可靠，顺序写和零拷贝提供高吞吐。AI 中台用它做事件驱动、削峰、解耦、特征/日志回流，是"异步数据骨干"。

## 常见考点

1. **Kafka 和 RocketMQ 区别**？——RocketMQ 支持事务消息/定时/重试内置，Kafka 高吞吐更胜；电商订单用 RocketMQ，数据流用 Kafka。
2. **怎么提高消费速度**？——加分区 + 加消费者 + 批量消费 + 异步处理。
3. **积压怎么处理**？——临时加消费者（分区允许范围内）/ 跳过堆积消费 / 扩分区（注意破坏有序）。

## 苏格拉底式面试追问

> 这组追问不背答案，模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：你们用 Kafka 传"用户行为事件"（点击/曝光/加购）到 Flink 算实时特征。但 Flink 也可以直接监听用户端的 HTTP 请求（用埋点 SDK 直推 Flink），为什么要中间加一层 Kafka？**

Kafka 在这里是"削峰 + 解耦 + 容错"。第一，**削峰**——大促时用户行为 QPS 从 10 万飙到 100 万，Flink 直接消费扛不住（反压会丢数据），Kafka 作为缓冲，Flink 按自己的速度消费，多余的消息在 Kafka 里排队（不丢）。第二，**解耦**——埋点 SDK 不需要知道 Flink 在哪、有几个实例，只管往 Kafka 写；Flink 扩缩容时 SDK 无感。第三，**容错/回放**——Flink 作业挂了重启，可以从 Kafka 的 last committed offset 重新消费，不丢数据；如果发现特征算错了，可以从 7 天前的 offset 重新算（Kafka retention 7 天）。没有 Kafka，Flink 直连 SDK 就是"紧耦合 + 无缓冲 + 无回放"，任何故障都丢数据。Kafka 是"数据管道的标配缓冲层"。

### 第二层：证据与定位

**Q：Flink 消费 Kafka 时发现 consumer_lag 从 1 万涨到 500 万（持续 1 小时）。你怎么定位是 Producer 生产太快还是 Consumer 消费太慢？**

看两个指标的趋势对比。第一，**Producer 写入速率 vs Consumer 消费速率**——Kafka Metrics 里 `kafka.server:type=BrokerTopicMetrics:MessagesInPerSec`（Broker 入队速率）vs `kafka.consumer:type=FetchLagMetrics`（消费 lag）。如果 Producer 从 10 万/s 涨到 100 万/s（大促流量），Consumer 还是 10 万/s，根因是 Consumer 处理慢（Flink 算特征耗时）。第二，**如果是 Consumer 慢，进一步定位**——看 Flink 的 `numRecordsInPerSec`（实际消费速率）和 `backpressure`（反压情况），如果 backpressure > 0.8 说明 Flink 算子链里有瓶颈（可能是算特征的 UDF 太慢或 RocksDB 状态访问慢）。第三，**如果是分区不均**——看每个 partition 的 lag 分布，如果 partition-0 的 lag 是 400 万（其他 partition 才 10 万），是分区倾斜（key hash 不均，热门 key 全进 partition-0）。具体定位命令：`kafka-consumer-groups.sh --describe --group flink-feature-group` 看每个 partition 的 CURRENT-OFFSET、LOG-END-OFFSET、LAG。

### 第三层：根因深挖

**Q：你发现 Consumer 慢是因为"算特征的 UDF 耗时高"（单条 5ms）。但这个 UDF 要查 Redis 拿用户画像。为什么每条消息都查 Redis？不能批量查吗？**

逐条查 Redis 是经典的"N+1 查询"。第一，**问题量化**——10 万条/s × 5ms/条 = 单线程扛不住，必须多线程，但 Redis 连接数有限（单实例 < 10000 连接）。第二，**批量查优化**——用 `MGET` 或 Pipeline 批量查 Redis，积攒 100 条消息，一次 `MGET user:1 user:2 ... user:100`（1ms 拿回 100 个画像），单条均摊 0.01ms，吞吐提升 500 倍。第三，**异步查优化**——用异步 Pipeline（发送不等返回），Flink 算子用 `AsyncFunction` 异步查 Redis，单线程能并发 100 个请求，吞吐提升 100 倍。第四，**本地缓存**——用户画像 5 分钟才更新一次，用 Caffeine 本地缓存（命中率 80%），80% 的请求不查 Redis。优化路径：本地缓存（挡 80%）→ Redis 批量查（挡剩余 20%）→ 逐条查（不用）。

**Q：那为什么不把用户画像也放进 Kafka，Flink 直接消费？省了 Redis 这一层。**

不行，用户画像和用户行为是"不同生命周期的数据"。第一，**用户画像是状态，用户行为是事件**——画像是"当前快照"（用户当前的兴趣标签），每 5 分钟更新一次；行为是"流式事件"（每次点击），实时产生。把画像放进 Kafka 意味着每个用户每隔几秒就有一条画像更新（即使没变化），数据冗余 + Kafka 存储浪费。第二，**查询模式不同**——Flink 处理行为时需要"查当前画像"（随机读），Kafka 是"追加日志"（顺序读），不支持高效的随机查。Redis 是 KV 存储，`GET user:123` 是 O(1)，正适合。第三，**一致性**——画像是多源聚合（行为+订单+浏览），聚合逻辑复杂（需要 reduce/join），适合在"特征服务"里算好存 Redis，而不是把原始数据塞 Kafka 让消费者自己算。Kafka 适合"事件流"，Redis 适合"状态查"，各司其职。

### 第四层：方案权衡

**Q：你们 Kafka 设了 acks=all，但这样 Producer 写入延迟从 1ms 涨到 10ms（等所有 ISR 副本确认）。特征场景能容忍少量丢数据（0.01%），能不能用 acks=1 换性能？**

acks 的选择要看"数据价值"。**acks=all**：等所有 ISR 副本确认才返回，延迟高（10ms）但不丢（leader 挂了副本有数据）。**acks=1**：leader 写入就返回，延迟低（1ms）但 leader 挂了且未同步到副本时丢数据。**acks=0**：发了就返回不等确认，延迟最低但可能丢。特征场景的分析：第一，**单条特征数据价值低**——用户一次点击算一个特征，丢 0.01% 的点击事件，对特征分布的影响可忽略（特征是统计聚合的，单条不影响整体）。第二，**但下游影响要评估**——如果这个 Kafka topic 还被"订单归因"消费（点击数据关联订单计算转化率），丢 0.01% 的点击会导致转化率统计偏差（漏算转化）。第三，**生产选择**——纯特征统计用 `acks=1`（性能优先，可接受极小丢失），涉及交易/计费的数据用 `acks=all`（不丢）。更重要的优化是**批量发送**（`linger.ms=5` + `batch.size=16384`），5ms 内攒批，单批 acks=all 的均摊延迟降到 2ms，兼顾性能和不丢。

**Q：为什么不直接用 RocketMQ 替代 Kafka？RocketMQ 支持事务消息、延迟消息、重试内置，功能比 Kafka 全。电商场景不是更适合 RocketMQ 吗？**

两者适用场景不同。**RocketMQ 的优势**：事务消息（订单创建+扣库存的分布式事务）、延迟消息（30 分钟未支付自动取消订单）、消费重试内置（失败自动重试 N 次）、消息轨迹（每条消息的全链路追踪）——这些是电商交易场景的刚需。**Kafka 的优势**：极致吞吐（单 Broker 100 万/s vs RocketMQ 10 万/s）、生态丰富（Flink/Spark/Connect 原生支持）、流处理标准（Kafka Streams/ksqlDB）、大数据场景成熟（日志/行为/特征传输）。**拼多多实践**：交易/订单/支付用 RocketMQ（事务消息 + 可靠性），数据/特征/日志用 Kafka（高吞吐 + 流处理）。两者并存，不是替代关系。选型标准：**要事务/延迟消息选 RocketMQ，要高吞吐/流处理选 Kafka**。强行用 Kafka 做事务消息（要自己实现两阶段提交）或用 RocketMQ 做日志收集（吞吐不够），都是选型错误。

### 第五层：验证与沉淀

**Q：你怎么证明"批量查 Redis"的优化真的提升了消费吞吐，而不只是 Kafka lag 自然消化了？**

控制变量对比。第一，**离线压测**——固定 Kafka 写入速率（50 万/s），对比优化前后 Consumer 的 `numRecordsInPerSec`：逐条查 Redis 是 10 万/s，批量查是 45 万/s，异步+批量是 80 万/s。消除流量变量（Kafka 写入固定）。第二，**线上灰度**——新旧 Consumer 各部署一套，订阅同一个 topic 的不同 consumer group（或 same group 不同 partition），同时段对比消费速率，优化版速率是原版的 5 倍。第三，**consumer_lag 趋势**——优化前 lag 持续增长（消费赶不上生产），优化后 lag 稳定下降到 < 1 万（消费快于生产）。三个指标一致，证明是优化生效而非巧合。

**Q：Kafka 集群长期运营怎么避免"消息积压"反复出现？**

三件事沉淀。第一，**容量规划**——按峰值 Producer 速率的 2 倍规划 Consumer 处理能力（大促流量翻倍时 Consumer 能跟上），监控 `consumer_lag / max_lag_threshold`，超过 10 万告警。第二，**分区数预留**——Kafka 分区数决定了 Consumer 并行度（一个分区只能被一个 Consumer 消费），预留足够分区（按峰值 QPS / 单 Consumer 处理能力算，比如 100 万 QPS / 5 万单消费者 = 20 分区，预留 32 分区）。分区数后期增加会破坏 key 有序性，必须前期规划好。第三，**消费者弹性扩缩**——K8s 部署 Consumer，监控 lag 自动扩缩（HPA，lag > 10 万时扩到 2 倍实例），大促前手动预扩。把 Kafka 当成"需要持续监控吞吐匹配"的管道，Producer 和 Consumer 的速率匹配是长期治理目标。

## 结构化回答


**30 秒电梯演讲：** 像电视台广播——节目（消息）发到频道（topic），观众（消费者）随时订阅看，录制（持久化）后还能回放。

**展开框架：**
1. **三角色** — Producer / Broker（topic+partition） / Consumer Group
2. **高吞吐** — 顺序写 + 零拷贝 + 批量 + 分区并行
3. **消费组** — 同组内分区分担，不同组独立消费

**收尾：** 怎么保证消息不丢？


## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：Kafka 怎么用？消息队列怎么保证可靠性？ | 今天聊「Kafka 怎么用？消息队列怎么保证可靠性？」。一句话：Kafka 是"高吞吐分布式消息队列"，生产者写 topic | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：三角色：Producer/Broker/Consumer | 核心概念 |
| 1:04 | 能力/参数拆解表 | 要点是：高吞吐：顺序写+零拷贝+批量 | 能力拆解 |
| 1:56 | 流程图：输入→处理→输出 | 要点是：消费组分区分担 | 关键机制 |
| 3:00 | 总结卡 + 下期预告 | 记住这些核心点就够了。下期我们接着聊——怎么保证消息不丢？。 | 收尾 |
