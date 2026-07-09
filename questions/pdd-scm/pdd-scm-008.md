---
id: pdd-scm-008
difficulty: L3
category: pdd-scm
subcategory: Kafka
tags:
- 拼多多
- 供应链
- Kafka
- 消息队列
- 消息可靠
feynman:
  essence: Kafka 靠"生产端 acks=all + Broker 多副本 + 消费端手动提交 offset"三段保证消息不丢，靠"幂等生产 + 事务"保证不重，供应链的订单流转、库存变更事件都靠它。
  analogy: Kafka 像快递中转站——寄件人要签收确认（acks=all）、中转站有备份仓（副本）、收件人要签字（手动 offset），三环确认包裹不丢。
  first_principle: 分布式系统网络不可靠，每个环节都可能丢；逐环节确认（生产→存储→消费）+ 去重（幂等）才能保证"不丢不重"。
  key_points:
  - 生产端：acks=all（所有副本确认）、retries、幂等（enable.idempotence）
  - Broker：多副本（replication.factor=3）、min.insync.replicas=2
  - 消费端：手动提交 offset（enable.auto.commit=false）+ 幂等消费
  - 事务：跨 partition 原子写（ Exactly-Once）
first_principle:
  problem: 消息从生产到消费经过多个环节，每个环节都可能失败，如何保证不丢不重？
  axioms:
  - 生产可能失败（网络、超时）
  - Broker 可能宕机
  - 消费可能重复（offset 提交失败重试）
  rebuild: 三段确认（acks=all + 副本 + 手动 offset）+ 幂等去重 + 事务（需要时）。
follow_up:
- 怎么保证消费幂等？——业务唯一键（订单号）去重，Redis/DB 唯一索引
- Kafka 和 RocketMQ 怎么选？——Kafka 吞吐高、生态好；RocketMQ 事务消息原生支持（电商常用）
- 消息积压怎么办？——扩消费者、排查慢消费、临时跳过堆积
memory_points:
- 三段可靠：acks=all + 多副本 + 手动 offset
- 幂等：生产端 enable.idempotence；消费端业务唯一键去重
- min.insync.replicas=2（防数据丢失）
- 消息积压：扩消费者 + 排查慢消费
---

# 【拼多多供应链】Kafka 怎么保证消息不丢不重？

> JD 依据："熟悉 Kafka 等主流组件和框架"。

## 一、消息可靠性三段保证

```
生产者 ──acks=all──▶ Broker（多副本）──手动offset──▶ 消费者
```

### 1. 生产端
```properties
acks=all                          # 所有副本确认才算成功
retries=3                         # 失败重试
enable.idempotence=true           # 幂等（防重试导致重复）
max.in.flight.requests.per.connection=5  # 幂等前提
```

### 2. Broker
```properties
replication.factor=3              # 3 副本
min.insync.replicas=2             # 至少 2 副本同步成功
unclean.leader.election.enable=false  # 禁止未同步副本当 leader
```

### 3. 消费端
```java
// 手动提交（成功处理后才提交）
props.put("enable.auto.commit", "false");

while (true) {
    ConsumerRecords<String, String> records = consumer.poll(Duration.ofMillis(100));
    for (ConsumerRecord<String, String> r : records) {
        process(r.value());  // 业务处理（幂等！）
    }
    consumer.commitSync();  // 手动同步提交
}
```

## 二、幂等消费（防重复）

Kafka 可能重复投递（至少一次语义 at-least-once），消费端必须幂等：

```java
public void process(OrderEvent event) {
    // 业务唯一键去重
    if (!redis.setnx("processed:" + event.getOrderId(), "1", 24, HOURS)) {
        return;  // 已处理过
    }
    orderService.create(event);
}
```

## 三、事务消息（跨 partition 原子）

```java
// 生产者事务（跨多 partition 原子写）
producer.initTransactions();
producer.beginTransaction();
producer.send(new ProducerRecord<>("topic-order", order));
producer.send(new ProducerRecord<>("topic-stock", stockEvent));
producer.commitTransaction();  // 两个 topic 同时成功/失败
```

## 四、供应链 Kafka 应用

**订单事件流**：
```
下单 → topic:order-created
   ├─ 库存服务消费 → 扣库存
   ├─ 物流服务消费 → 生成运单
   └─ 结算服务消费 → 生成对账
```

**幂等保证**：用 orderId 作为幂等键，Redis 去重 24 小时。

**消息积压处理**：
- 扩消费者实例（partition 数 ≥ 消费者数）
- 排查慢消费（DB 慢查询？）
- 临时跳过堆积（堆积消息转储后异步处理）

## 五、底层本质

消息可靠性是"逐环节确认 + 去重"的工程实践：
- **不丢**：acks=all + 多副本 + 手动 offset
- **不重**：幂等生产 + 幂等消费
- **顺序**：单 partition 有序（多 partition 用 key 路由保证同 key 顺序）

## 常见考点
1. **acks=0/1/all 区别**？——0 不等确认（最快可能丢）、1 等 leader（leader 挂丢）、all 等所有同步副本（最安全）。
2. **怎么保证消息顺序**？——单 partition 有序；多 partition 用相同 key 保证同 key 进同 partition。
3. **Kafka 为什么快**？——顺序写磁盘 + 零拷贝（sendfile）+ 批量压缩 + 分区并行。
