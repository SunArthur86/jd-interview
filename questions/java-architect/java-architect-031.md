---
id: java-architect-031
difficulty: L2
category: java-architect
subcategory: Kafka
tags:
- Java 架构师
- Kafka
- 分区
- 消费
feynman:
  essence: Kafka 把一个 Topic 切成多个 Partition 分布在不同 Broker 上做并行，每个 Partition 又有多副本（Leader/Follower）做高可用。分区是并发单元（决定吞吐上限），副本是可用性单元（决定 RPO/数据零丢失），消费语义（at-most / at-least / exactly-once）是 offset 提交与业务幂等的组合选择。
  analogy: 像 JD 快递分拣中心：Topic 是一类包裹（如"订单事件"），Partition 是 N 条独立传送带（每条单线顺序、多条并行），副本是每条传送带旁录了一份"备份录像"的副手（Leader 挂了副手接管）。消费者组是 N 个分拣员，每人盯一条传送带，offset 就是他在传送带上贴的"已处理到第几件"标签。
  first_principle: 为什么不是"一个 Topic 一份数据存一台机器"？因为单机吞吐和可用性都有上限。分区把写入/消费并行度从 1 提到 N（线性扩展），副本把数据持久性从"单机一崩即丢"提到"多机同时崩才丢"。两者结合，吞吐靠分区、可用性靠副本、一致性靠 ISR+acks 控制。
  key_points:
  - 分区是并行单元：吞吐 ≈ 分区数 × 单分区吞吐，分区数决定消费并行度
  - 副本是可用性单元：Leader 读写，Follower 从 Leader 拉取同步，ISR 集合决定谁能当选
  - 三种消费语义：at-most-once（先提交 offset 再处理）、at-least-once（先处理再提交，默认）、exactly-once（幂等 producer + 事务或业务幂等）
  - acks 控制写入可靠性：acks=0 不等确认、acks=1 Leader 确认、acks=all/all ISR 确认（最安全）
  - rebalance 是消费组动态伸缩机制，但 stop-the-world 期间消费暂停，需用 CooperativeRebalanceStrategy 减少抖动
first_principle:
  problem: 如何在单机吞吐/可用性有物理上限的前提下，把消息系统的吞吐做到 TPS 万级以上、单机故障不丢数据？
  axioms:
  - 一条传送带（单分区）是单线顺序的，吞吐有上限；并行多带（多分区）可线性扩展
  - 单份数据单机宕机即丢；多副本 + 多数派确认才能做到"少数节点全损也不丢"
  - 消息系统本质是"日志"，追加写快、顺序消费快，offset 是位移指针而非消息标识
  rebuild: 把 Topic 横切成 N 个 Partition 分布在多 Broker（并行），每个 Partition 配 R 个副本其中 1 个 Leader（冗余）。生产者写 Leader，Follower 拉取追平，只有追平的副本进 ISR；提交时按 acks 决定要 ISR 中多少个确认。消费者按消费组分配分区，提交 offset 到 __consumer_offsets topic，重平衡时按分区重分配。这套设计让吞吐、可用性、一致性三者参数化（分区数、副本数、acks、min.insync.replicas），架构师按 SLA 拧旋钮。
follow_up:
  - 分区数怎么定？——经验公式：分区数 ≥ 目标吞吐 / 单分区吞吐，且 ≥ 消费者最大并发数。JD 大促下单 topic 通常 100-200 分区。注意分区数只能加不能减，定多了浪费，定少了扩容要重建 topic
  - ISR 缩小意味着什么？——ISR（In-Sync Replicas）是追上 Leader 的副本集合。ISR 缩小说明 Follower 落后，ack=all 时写入被阻塞或丢数据。监控 under_replicated_partitions 必须告警
  - at-least-once 重复怎么解？——offset 提交前宕机会重复消费，必须在消费端做业务幂等（唯一键/状态机/Redis 令牌）。不要幻想 Kafka 给你 exactly-once
  - producer 幂等和事务区别？——幂等（enable.idempotence=true）防单 producer 重试重复；事务（transactional.id）跨分区跨 producer 原子写。消费端 exactly-once 还是要业务幂等
  - rebalance 风暴怎么治？——session.timeout.ms / heartbeat 调大、max.poll.records 调小、用 CooperativeRebalanceStrategy（增量重平衡）、长任务用 pause/resume 避免被踢
memory_points:
  - 分区=并发单元（吞吐），副本=可用单元（RPO），ISR=all+min.insync.replicas=2 是生产标配
  - acks=all + min.insync.replicas=2 + replication.factor=3 是"零丢失又不卡写"的金三角
  - offset 提交三选一：enable.auto.commit=false 手动 commitSync（最稳） / commitAsync（最快可能丢） / 混合
  - 三消费语义：at-most（先提交）、at-least（先处理后提交，必须幂等）、exactly-once（producer 事务 + 隔离级别 read_committed 或业务幂等）
  - 监控四件套：consumer_lag（积压）、under_replicated_partitions（副本落后）、isr_shrink_rate（ISR 抖动）、rebalance_rate（消费者抖动）
---

# 【Java 后端架构师】Kafka 分区、副本与消费语义

> 适用场景：JD 核心技术。下单、库存、营销、风控、履约几乎所有核心链路都跑在 Kafka 上。架构师面试不是问"Kafka 是什么"，而是看你能不能解释分区数为什么定 100、acks=all 会不会卡写、消费积压 1000 万怎么扩、为什么 exactly-once 在跨系统场景是伪命题。

## 一、概念层：分区、副本、消费组三件套

**Topic 物理结构**（这张图必须能现场画）：

```
Topic: order_event   (逻辑概念，跨 Broker)
  │
  ├── Partition 0   ┌─ Leader (Broker 1)  ← Producer 读写入口
  │                 ├─ Follower (Broker 2)  从 Leader fetch 同步
  │                 └─ Follower (Broker 3)
  │
  ├── Partition 1   ┌─ Leader (Broker 2)
  │                 ├─ Follower (Broker 1)
  │                 └─ Follower (Broker 3)
  │
  ├── Partition 2   ┌─ Leader (Broker 3)
  │                 └─ ...
  └── ...           每个分区是一个不可变有序日志，segment 文件存储在 Broker 磁盘
```

**三个核心抽象**：

| 概念 | 作用 | 决定什么 |
|------|------|---------|
| **Partition（分区）** | 并行单元，单分区严格有序 | 吞吐上限、消费并行度上限 |
| **Replica（副本）** | Leader + Follower，Follower 拉 Leader 同步 | 可用性、数据持久性（RPO） |
| **Consumer Group（消费组）** | 一组消费者共同消费一个 topic，分区分配给组内成员 | 消费并发、重平衡 |

**关键公式**（面试加分）：

- 一个消费组内：`消费者数 ≤ 分区数` 才有意义（多出的消费者闲置）
- 消费并行度 = `min(分区数, 消费者实例数)`
- 吞吐 ≈ `分区数 × 单分区写入吞吐`（单分区顺序写盘，约 10-50MB/s）

## 二、机制层：副本同步与 ISR 机制

**ISR（In-Sync Replicas）是 Kafka 一致性的核心**：

```
所有副本 AR (Assigned Replicas) = [B1, B2, B3, B4, B5]
ISR (追得上 Leader 的副本)       = [B1, B2, B3]   ← B4 B5 落后被踢
OSR (Out-of-Sync)                = [B4, B5]
AR = ISR ∪ OSR

Leader 在 ISR 里选举（unclean.leader.election.enable=false 时）
```

**Follower 落后被踢出 ISR 的条件**：
- `replica.lag.time.max.ms`（默认 10s）：Follower 超过这个时间没追上 Leader 即被剔除
- Kafka 0.9+ 已废弃 `replica.lag.max.messages`（条数），因为突发流量会误判

**acks 三档对比**（必背）：

| acks | 含义 | 延迟 | 可靠性 | 适用 |
|------|------|------|--------|------|
| `0` | 发出去就算成功，不等确认 | 最低 | 最低（Leader 当机即丢） | 日志、监控指标、可丢 |
| `1` | Leader 写入即返回成功 | 中 | 中（Leader 当机且未同步到 Follower 时丢） | 一般业务 |
| `all`/`-1` | 等所有 ISR 副本确认 | 最高 | 最高（ISR 全损才丢） | 资金、订单、强一致 |

**金三角配置**（生产必加）：

```properties
# Producer 端
acks=all
enable.idempotence=true          # 防重试重复，自动把 acks 升 all
retries=2147483647               # Integer.MAX，无限重试
max.in.flight.requests.per.connection=5   # 幂等模式下必须 ≤5

# Topic 端
min.insync.replicas=2            # ISR 至少 2 个才允许写入，否则报 NotEnoughReplicas
replication.factor=3             # 3 副本，允许 1 个宕机仍能选主且能写
unclean.leader.election.enable=false  # 禁止落后副本当选，避免数据回退丢消息
```

`min.insync.replicas=2 + replication.factor=3` 的数学含义：**允许 1 个副本宕机，仍能 acks=all 写入**。如果 2 个宕机，ISR 只剩 1 < 2，写入直接拒绝（宁可不写也不丢）。

## 三、机制层：消费 offset 与三种消费语义

**offset 存储**：Kafka 0.9+ offset 存在内部 topic `__consumer_offsets`（key = group.id + topic + partition，value = offset），不再依赖 ZooKeeper。

**三种消费语义**（面试官最爱的层层追问）：

| 语义 | 实现方式 | 重复/丢失 | 适用场景 |
|------|---------|----------|---------|
| **at-most-once** | 先提交 offset 再处理 | 可能丢，不会重 | 监控指标、日志采集 |
| **at-least-once**（默认） | 先处理再提交 offset | 可能重，不会丢 | 99% 业务，需配幂等 |
| **exactly-once** | producer 事务 + read_committed，或业务幂等 | 不重不丢 | 资金、对账 |

**手动提交 offset 的两种姿势**：

```java
// 推荐姿势：处理 + 手动同步提交（最稳但慢）
props.put("enable.auto.commit", "false");   // 关闭自动提交

KafkaConsumer<String, String> consumer = new KafkaConsumer<>(props);
consumer.subscribe(Arrays.asList("order_event"));

while (running) {
    ConsumerRecords<String, String> records = consumer.poll(Duration.ofMillis(500));
    for (ConsumerRecord<String, String> r : records) {
        process(r);   // 业务处理（必须幂等！）
    }
    consumer.commitSync();   // 同步提交，阻塞直到成功
}

// 异步提交（高吞吐但失败可能丢 offset）
consumer.commitAsync((offsets, exception) -> {
    if (exception != null) {
        log.warn("Commit failed for {}: {}", offsets, exception.getMessage());
    }
});
```

**消费组 rebalance 流程**（必懂，否则积压排查抓瞎）：

```
1. 消费者加入组 → 选 GroupCoordinator（Broker 端）
2. 选 Leader 消费者执行 Assignor 分配分区
   RangeAssignor（默认）/ RoundRobin / StickyAssignor / CooperativeStickyAssignor
3. 分配结果下发，所有消费者进入 rebalance
   stop-the-world：所有消费暂停！这是积压的常见原因
4. CooperativeRebalanceStrategy（2.4+）：只重分配变更的分区，不动其他分区
```

**生产者幂等代码**（避免重试重复）：

```java
props.put("enable.idempotence", "true");    // 关键！
// 幂等原理：producer 拿到 PID + sequence number，broker 端按 (PID, partition, seq) 去重
// 自动设置 acks=all, retries=Integer.MAX, max.in.flight ≤ 5
```

## 四、实战层：分区数设计 + 消费积压治理

**分区数设计公式**：

```
分区数 = max(
    ceil(目标吞吐 / 单分区吞吐),       // 单分区顺序写约 10-50MB/s
    消费者最大并发数,                  // 一个分区只能给一个消费者
    ceil(峰值 QPS / 单消费者 QPS)
)
```

**JD 大促订单 topic 实例**：
- 峰值 50 万 QPS，单消费者 5000 QPS → 至少 100 分区
- 留 50% 余量 → 150 分区
- 注意：**分区数只能加不能减**，定多了浪费（每个分区一个目录、一组索引），定少了要重建 topic 重导数据

**消费积压 1000 万的应急链路**：

```bash
# 1. 看积压
kafka-consumer-groups.sh --bootstrap-server <broker> \
    --describe --group order_consumer_group
# 输出看 CURRENT-OFFSET、LOG-END-OFFSET、LAG 列

# 2. 诊断
#   - LAG 集中在某分区 → 分区倾斜（key 分布不均，热点 key）
#   - LAG 全部均匀上升 → 消费速度跟不上，扩消费者（前提：分区数够）
#   - 消费者频繁重平衡 → 看 session.timeout、max.poll.interval.ms 是否过短

# 3. 应急动作
#   - 扩消费者实例（最多 = 分区数）
#   - 临时加分区（仅能加不能减，新分区无历史数据）
#   - 慢消费路径降级（异步落库改批量落库、跳过非核心字段处理）
```

**生产配置完整示例**（JD 风格资金 topic）：

```java
// Producer
Properties p = new Properties();
p.put("bootstrap.servers", "broker1:9092,broker2:9092");
p.put("acks", "all");
p.put("enable.idempotence", "true");
p.put("retries", "2147483647");
p.put("max.in.flight.requests.per.connection", "5");
p.put("compression.type", "lz4");          // 压缩，省带宽省存储
p.put("linger.ms", "10");                  // 攒批 10ms，吞吐换延迟
p.put("batch.size", "65536");              // 64KB 批次

// Consumer
Properties c = new Properties();
c.put("group.id", "order_consumer_group");
c.put("enable.auto.commit", "false");
c.put("max.poll.records", "500");
c.put("max.poll.interval.ms", "300000");   // 5min，避免长任务被踢
c.put("session.timeout.ms", "30000");
c.put("isolation.level", "read_committed"); // 配 producer 事务，读已提交
```

## 五、实战层：exactly-once 的真实落地

**Kafka 原生 exactly-once**（Kafka Streams 或 Kafka-to-Kafka 场景）：

```java
// Producer 事务
p.put("transactional.id", "order-tx-" + instanceId);  // 必须稳定唯一
KafkaProducer<String, String> producer = new KafkaProducer<>(p);
producer.initTransactions();   // 注册到 coordinator，回收旧事务

try {
    producer.beginTransaction();
    producer.send(new ProducerRecord<>("topic-out", k, v));
    // 同时提交消费 offset（与发送原子）
    producer.sendOffsetsToTransaction(offsets, "consumer-group-id");
    producer.commitTransaction();
} catch (Exception e) {
    producer.abortTransaction();
}
```

**跨系统（Kafka → MySQL）的 exactly-once 是伪命题**：Kafka 事务管不到 MySQL，落地必须用业务幂等。三种幂等方案：
1. 唯一键约束（msg_id 唯一索引，重复插入失败）
2. 状态机（订单状态只能往前走，重复消息触发幂等校验跳过）
3. Redis 令牌（msg_id SETNX EX，过期清理由消费日志兜底）

## 六、底层本质：为什么是分区+ISR 这套设计

回到第一性：**单机吞吐和单机可用性都有物理上限**。

**为什么分区能扩吞吐**：因为消息是追加日志，单分区严格顺序写盘（顺序 IO 是随机 IO 的 10-100 倍）。把一个 topic 切成 N 分区，每个分区独立顺序写、独立消费，吞吐随分区数线性扩展。代价：跨分区无序（只有分区内有序）。

**为什么 ISR 而不是多数派（Raft/Paxos）**：Kafka 用 ISR 是性能取舍——ISR 是 Leader 推（实际是 Follower pull）的同步复制，写入路径只需 Leader + ISR 副本确认，不涉及 quorum 协商，吞吐比 Raft 高。代价是脑裂风险（unclean.leader.election 丢数据），所以生产必须 `unclean.leader.election.enable=false`。

**为什么 offset 存在 topic 而不是 ZK**：高并发下 offset 更新是写多读少，ZK 不适合高频写。把 offset 存成一个 compact topic `__consumer_offsets`，用 Kafka 自己的能力（顺序写、副本、压缩），每个 group+partition 一个 key，最新 value 保留。

**exactly-once 的本质**：分布式系统里"恰好一次"是观察者视角——底层一定是 at-least-once + 幂等。Kafka 事务只是把"发消息 + 提交 offset"做成原子，跨 Kafka 边界（写 DB、调外部 API）就必须业务幂等。

## 七、AI 架构师加问：5 个 AI 相关问题

1. **AI 推理服务的请求/响应流式场景用 Kafka 合适吗？**
   不合适。Kafka 是日志流（持久、回溯、多消费），AI 流式推理要的是低延迟双向 RPC，用 gRPC streaming / WebSocket / SSE。Kafka 适合 AI 的特征日志、训练样本回流、推理结果审计这类持久流。

2. **大模型 RAG 的向量库更新能用 Kafka Outbox 模式吗？**
   可以。业务库变更 → Outbox 表 → Kafka → 向量 embedding 计算 → 写入 Milvus/Pinecone。这套保证业务库和向量库最终一致，单消息幂等靠 doc_id。监控 embedding_lag 看同步延迟。

3. **怎么用 AI 自动诊断消费积压根因？**
   AI 接 kafka-consumer-groups.sh --describe 输出 + traceId 链路 + 消费者 GC 日志，分类根因（分区倾斜、消费者慢查询、rebalance 风暴、上游突增）。AI 出建议（扩消费者、加分区、调 max.poll.interval），人工确认后执行。

4. **AI Agent 调用 Kafka 工具如何控制风险？**
   只读命令（describe、lag 查询）免审批；写命令（create topic、alter partition、delete topic）必须人工审批 + 审计日志 + dry-run 预演。删除 topic 是高危操作，强制二次确认 + 模糊匹配拦截（防止误删带前缀的所有 topic）。

5. **训练数据回流如何保证不污染生产 Kafka？**
   不要让训练回流量打到生产 topic。用影子 topic（mirror topic）+ 独立消费组采集，回流管道只读不写生产 topic。监控回流量突增，避免反向打挂生产集群。

## 八、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"分区=并发、副本=可用、ISR=一致、acks=all 三件套、at-least+幂等"**。

- **分区**：吞吐靠分区数，消费并行 = min(分区数, 消费者数)，分区只加不减
- **副本**：replication.factor=3，1 Leader + 2 Follower，Follower 拉 Leader 同步
- **ISR**：追得上的副本集合，ISR 缩小要告警（under_replicated_partitions）
- **金三角**：acks=all + min.insync.replicas=2 + unclean.leader.election.enable=false
- **at-least-once + 业务幂等**是 99% 场景的标准答案，exactly-once 跨系统是伪命题

### 拟人化理解

把 Kafka 想象成 **JD 分拣中心**。Topic 是一类包裹（订单事件），Partition 是 N 条独立传送带（每条单线顺序、多条并行，吞吐靠加带），副本是每条传送带旁的副手（Leader 挂了副手接管，可用性靠副手数量）。消费者组是 N 个分拣员，每人盯一条带（一个分区只能给一个人），offset 是他贴的"已处理到第几件"标签。rebalance 是临时换班（换班时传送带暂停，所以要尽量减少）。

### 面试现场 60 秒回答

> Kafka 用分区换并行、用副本换可用、用 ISR+acks 换一致。分区数我按目标吞吐 ÷ 单分区吞吐算，留 50% 余量，注意只能加不能减。副本三件套：replication.factor=3 + min.insync.replicas=2 + acks=all，允许 1 个副本宕机仍能 ack=all 写入，2 个宕机宁可拒写也不丢。消费端默认 at-least-once，先处理再 commitSync，业务侧用唯一键或状态机幂等。exactly-once 跨 Kafka 边界就是伪命题，Kafka 事务只能保证 Kafka 内原子，写 MySQL 必须业务幂等。生产监控四件套：consumer_lag、under_replicated_partitions、isr_shrink_rate、rebalance_rate。

### 反问面试官

> 贵司核心 topic 的 acks 是 all 还是 1？分区数怎么定的？消费积压上限是多少触发告警？这决定我要不要重做幂等设计、要不要上 CooperativeRebalanceStrategy。

## 九、苏格拉底式面试追问

每一问先回答"为什么"，再"怎么做"，最后"如何证明"。

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 你为什么定 100 分区而不是 50？ | 用吞吐公式：峰值 50 万 QPS ÷ 单消费者 5000 = 100，留 50% 余量到 150。分区只加不减，多定不如少定（多定每个分区一个目录、一组索引，浪费）。证明：压测单分区写入 30MB/s，100 分区 = 3GB/s 远超需求 |
| 证据追问 | 怎么证明消费积压是热点 key 而非消费者慢？ | kafka-consumer-groups.sh --describe 看 LAG 列分布——若 100 个分区只有 3 个积压，是分区倾斜（热点 key 如大商家）；若全部均匀上升，是消费者跟不上。配合按 key 维度的 produce QPS 看分布 |
| 边界追问 | acks=all 是不是一定零丢？ | 不是。min.insync.replicas=2 时若 ISR 只剩 1 个，写入直接被拒（NotEnoughReplicasException），此时是"不写"而非"丢"。真正零丢要配 unclean.leader.election.enable=false + 业务幂等兜底。acks=all 也救不了磁盘静默损坏 |
| 反例追问 | 什么场景你不选 acks=all？ | 监控指标、日志采集、用户行为埋点这类可丢场景，acks=1 或 acks=0 换吞吐。资金/订单/库存才上 acks=all。强行全场景 all 是过度设计，会拖慢整体 P99 |
| 风险追问 | 上 acks=all 后最大新风险？ | 写延迟翻倍（等 ISR 多数派确认），高峰期写入 P99 抖动；min.insync.replicas=2 触发时写入被拒导致业务超时。要监控 produce_latency_p99 和 NotEnoughReplicas 异常率，给峰值留 ISR 余量 |
| 验证追问 | 怎么证明换 acks=all 没丢消息？ | 持续灌入带 seq 的测试消息，消费端统计缺失 seq 数（应 = 0）；故障演练杀 Leader 节点期间灌消息，恢复后对比 send 端成功数与消费端收到数；对账用业务流水号日切对齐 |
| 沉淀追问 | 团队 Kafka 规范沉淀什么？ | topic 命名规范（业务_事件_版本）、分区数/副本数默认值模板、acks/幂等/retries 标准配置、消费者参数模板、监控大盘（consumer_lag / under_replicated_partitions / isr_shrink / rebalance）、积压应急预案 SOP |

### 现场对话示例

**面试官**：你说 acks=all 一定零丢吗？

**候选人**：不能说零丢，准确说是"在 ISR 全损前不丢"。acks=all 是等所有 ISR 副本确认，配 min.insync.replicas=2 表示 ISR 至少 2 个才允许写。如果 ISR 缩到 1 个，写入被拒（NotEnoughReplicasException），此时是"拒写"不是"丢"。真正风险点在 unclean.leader.election：如果允许落后副本当选 Leader，会丢已确认的消息。所以生产必须 unclean.leader.election.enable=false。即便如此，磁盘静默损坏、机房整体故障还是救不了，业务侧必须做幂等和对账兜底。

**面试官**：消费者经常 rebalance 怎么治？

**候选人**：先定位根因。session.timeout.ms 过短（心跳超时被踢）、max.poll.interval.ms 过短（处理慢被踢）、消费者实例频繁发布（容器重启）。治法：session.timeout.ms 调 30s、max.poll.interval.ms 调 5min、max.poll.records 调小（少拉快处理）、用 CooperativeStickyAssignor（增量重平衡只动变更分区）。发布用优雅停机，poll 循环检测 shutdown hook 调 consumer.close() 主动退组，避免被动等 session 超时。监控 rebalance_count_per_min。

**面试官**：exactly-once 怎么实现？

**候选人**：分两种。Kafka 内部（Streams 或 Kafka-to-Kafka）用 producer 事务：transactional.id + beginTransaction + send + sendOffsetsToTransaction + commitTransaction，消费端 isolation.level=read_committed。跨系统（Kafka → MySQL）exactly-once 是伪命题，因为 Kafka 事务管不到 MySQL。落地必须业务幂等：msg_id 唯一键约束、订单状态机、Redis SETNX 令牌。我会优先 at-least-once + 业务幂等，简单可靠，Kafka 事务只在流式管道内部用。

## 常见考点

1. **分区数怎么定？**——按吞吐和消费并行度：分区数 ≥ 目标吞吐 ÷ 单分区吞吐，且 ≥ 消费者最大并发数。注意只能加不能减，留余量但不浪费。
2. **ISR 是什么？**——In-Sync Replicas，追得上 Leader 的副本集合。ISR 缩小 = 副本落后 = 风险信号，监控 under_replicated_partitions 告警。
3. **acks=all 一定不丢吗？**——ISR 全损前不丢；min.insync.replicas 触发时是拒写。配 unclean.leader.election.enable=false 防脑裂丢数据，业务侧仍需幂等兜底。
4. **消费者 rebalance 怎么减少？**——session.timeout / max.poll.interval 调合理、用 CooperativeStickyAssignor、优雅停机主动退组、监控 rebalance_rate。
5. **exactly-once 跨系统怎么实现？**——伪命题。Kafka 事务只管 Kafka 内，跨 MySQL 必须业务幂等（唯一键/状态机/Redis 令牌）+ at-least-once。


## 结构化回答

**30 秒电梯演讲：** 聊到Kafka 分区、副本与消费语义，我的理解是——Kafka 把一个 Topic 切成多个 Partition 分布在不同 Broker 上做并行，每个 Partition 又有多副本（Leader/Follower）做高可用。分区是并发单元（决定吞吐上限），副本是可用性单元（决定 RPO/数据零丢失），消费语义（at-most / at-least / exactly-once）是 offset 提交与业务幂等的组合选择。打个比方，像 JD 快递分拣中心：Topic 是一类包裹（如"订单事件"），Partition 是 N 条独立传送带（每条单线顺序、多条并行），副本是每条传送带旁录了一份"备份录像"的副手（Leader 挂了副手接管）。消费者组是 N 个分拣员，每人盯一条传送带，offset 就是他在传送带上贴的"已处理到第几件"标签。

**展开框架：**
1. **分区是并行单元** — 吞吐 ≈ 分区数 × 单分区吞吐，分区数决定消费并行度
2. **副本是可用性单元** — Leader 读写，Follower 从 Leader 拉取同步，ISR 集合决定谁能当选
3. **三种消费语义** — at-most-once（先提交 offset 再处理）、at-least-once（先处理再提交，默认）、exactly-once（幂等 producer + 事务或业务幂等）

**收尾：** 这块我在项目里也踩过坑——想深入的话，可以接着聊：分区数怎么定？您更想看哪个方向？

## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡 | "Kafka 分区、副本与消费语义——这道题面试官到底想考什么？我用 30 秒给你讲透。" | 开场钩子 |
| 0:15 | Kafka 架构图 | 先说核心：Kafka 把一个 Topic 切成多个 Partition 分布在不同 Broker 上做并行，每个 Partition 又有多副本（Leader/Follower）做高可用。 | 核心定义 |
| 0:30 | 高可用架构图 | Leader 读写，Follower 从 Leader 拉取同步，ISR 集合决定谁能当选。 | 副本是可用性单元 |
| 1:30 | 总结卡 | 一句话记忆：分区=并发单元（吞吐），副本=可用单元（RPO），ISR=all+min.insync.replicas=2 是生产标配。 下期可以接着聊：分区数怎么定。 | 收尾总结 |
