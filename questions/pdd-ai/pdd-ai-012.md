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
