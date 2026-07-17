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

## 苏格拉底式面试追问

> 这组追问不是背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：订单服务下单后要通过 Kafka 通知库存/物流/结算三个下游。为什么用 Kafka 而不是直接 RPC 调用三个服务？**

三个动机：
1. **解耦**——RPC 调用是同步的，订单服务要等三个下游都返回才响应，任意一个慢（物流接口超时）就拖垮下单。Kafka 异步，订单发完消息立即返回，下游各自消费。
2. **削峰**——大促 QPS 暴涨，下游（如结算做复杂对账）处理慢，Kafka 做缓冲，下游按自己的速度消费，不被压垮。
3. **扩展**——新增下游（如风控）只要订阅 topic，不用改订单服务代码。RPC 的话每加一个下游要改订单服务的调用链。
代价是引入最终一致（秒级延迟），但订单场景容忍。

### 第二层：证据与定位

**Q：库存服务反馈"没收到某笔订单的扣减消息"，你怎么定位是生产端没发、Broker 丢了，还是消费端漏消费？**

三段排查：
1. **生产端**——查订单服务的日志，搜 `producer.send(order-created, orderId=xxx)`，确认 send 返回了 `RecordMetadata`（有 offset 和 partition）。如果没日志或抛异常，是生产端没发成功；看 `producer-metrics` 的 `record-error-rate`。
2. **Broker**——`kafka-console-consumer --topic order-created --partition X --offset Y --max-messages 1`，按 orderId 找消息（或按 timestamp `--from-beginning | grep orderId`）。如果 Broker 上没有，是生产端丢了（可能 acks 配置错）；如果有，问题在消费端。
3. **消费端**——看消费者的 `consumer_lag` 和 commit offset。`kafka-consumer-groups --describe --group stock-group`，如果 OFFSET 跳过了这条消息（比如手动 commit 时 `commitSync` 了整批但中间这条处理抛异常被 catch 吞了），就是消费端漏处理。

### 第三层：根因深挖

**Q：你发现消费端的 offset 已经提交，但库存没扣（业务没执行）。根因是什么？**

根因是"处理失败但 offset 仍提交"，典型坑：
1. **异常被吞**——消费循环里 `try { process(record); } catch (Exception e) { log.error(...); }`，`process` 抛异常后 catch 住，循环继续，最后 `commitSync()` 提交了包括失败消息的 offset，消息丢失。
2. **异步处理未等待**——`process` 是异步的（`CompletableFuture.supplyAsync`），主循环没等它完成就 commit，异步任务失败但 offset 已提交。
根因不是 Kafka 的问题，是消费代码的"先 commit 后处理 / 吞异常"模式。正确做法：处理失败不 commit（抛异常让 consumer 重投递）+ 死信队列（DLC）兜底重试上限的消息。

**Q：那为什么不直接关闭自动提交、处理失败就阻塞重试到成功为止？**

阻塞重试会引发"消息毒丸"问题：
1. **毒丸阻塞**——如果某条消息因为脏数据永远处理失败（如 orderId 为 null），无限重试会卡住整个 partition 的消费，后续消息全部积压。
2. **雪崩**——重试时占着消费者线程，新消息消费不动，consumer_lag 暴涨。
正确做法是"有限重试 + 死信"：本地重试 3 次（间隔递增 1s/5s/30s），仍失败就发到 `order-created-dlq` topic，主流程继续消费下一条。死信 topic 有人工/定时任务处理。拼多多订单消费就是这套，DLQ 里的消息每天约 0.01% 量级，值班人工补偿。

### 第四层：方案权衡

**Q：你用本地重试 + DLQ，但有些消息要求严格顺序（同一订单的"创建→支付→发货"必须按序处理），怎么保证？**

顺序消费和并行吞吐是矛盾的。两种方案：
1. **单 partition + key 路由**——把 orderId 作为消息 key，Kafka 保证同 key 进同 partition，partition 内有序。消费者对单 partition 单线程消费，保证顺序。代价是吞吐受限于单 partition（同订单的事件串行，但不同订单可并行）。
2. **用 RocketMQ 的顺序消息**——RocketMQ 原生支持 MessageQueueSelector，按 orderId 选 queue，消费端 `MessageListenerOrderly` 保证单 queue 串行。如果已用 Kafka 就用方案 1。
**注意**：顺序消费 + 重试要小心——某条消息失败阻塞会卡住整个 partition 后续消息。所以顺序场景的重试要"快速失败 + 转 DLQ"，不能死等。

**Q：为什么不直接用 Kafka 事务（transactional.id）保证跨 topic 的原子性，而要用本地消息表 + MQ？**

Kafka 事务和本地消息表解决不同问题：
1. **Kafka 事务**——只保证"Kafka 内部多 partition 的原子写"（要么都成功要么都失败），管不到 MySQL。如果业务是"写 MySQL + 发 Kafka"，Kafka 事务管不了 MySQL，MySQL 提交了 Kafka 回滚，数据不一致。
2. **本地消息表**——把"业务数据 + 待发消息"写在同一个 MySQL 事务（outbox 表），本地事务保证原子。定时任务扫 outbox 发 Kafka，发成功删除。这是"跨系统最终一致"的标准解法。
所以下单扣库存场景必须用本地消息表（MySQL + Kafka 跨系统），Kafka 事务只适合纯 Kafka 链路（如流处理 sink 到多 topic）。

### 第五层：验证与沉淀

**Q：你怎么证明 Kafka 链路的消息不丢不重真的生效？**

四个监控指标：
1. **生产端**——`producer.record-error-rate` = 0、`record-retry-rate` < 阈值，JMX 采集。
2. **Broker**——`under-replicated-partitions` = 0（ISR 副本都健康）、`offline-partitions` = 0。
3. **消费端**——`consumer_lag` 稳定不暴涨（< 1000），`commit-offset` 和 `log-end-offset` 差距可控。
4. **业务对账**——每天跑对账：`count(订单表) = count(库存扣减记录) = count(Kafka topic 消息)`，三者相等证明没丢没重。拼多多每天凌晨跑这道对账，差异 > 0.001% 告警。

**Q：怎么让团队的 Kafka 消费代码不踩"吞异常 / 毒丸 / 重复消费"的坑？**

沉淀消费框架：
1. **统一消费模板**——封装 `SafeKafkaConsumer`，内置"本地重试 3 次 + DLQ + 幂等校验 + 手动 commit"，业务方只实现 `process()` 方法，不能自己写消费循环。
2. **幂等 SDK**——`@Idempotent(key = "orderId", ttl = 86400)` 注解，自动 Redis SETNX 去重，业务方加注解即生效。
3. **Code Review 规则**——任何 `consumer.poll` 后的 for 循环必须有 try-catch 转 DLQ 逻辑，裸 `commitSync()` 不允许；SonarQube 扫 `catch (Exception` 后无 throw 的吞异常代码报 critical。

## 结构化回答

**30 秒电梯演讲：** 消息从生产到消费经过多个环节，每个环节都可能失败，如何保证不丢不重？简单说就是——Kafka 靠"生产端 acks=all + Broker 多副本 + 消费端手动提交 offset"三段保证消息不丢，靠"幂等生产 + 事务"保证不重。

**展开框架：**
1. **生产端** — 生产端：acks=all（所有副本确认）、retries、幂等（enable.idempotence）
2. **Broker** — Broker：多副本（replication.factor=3）、min.insync.replicas=2
3. **消费端** — 消费端：手动提交 offset（enable.auto.commit=false）+ 幂等消费

**收尾：** 您看这块要不要再展开聊聊？

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：Kafka 怎么保证消息不丢不重？ | 今天聊「Kafka 怎么保证消息不丢不重？」。一句话：Kafka 靠"生产端 acks=all + Broker 多副本 + 消费端手动提交 offset"三段保证消息不丢… | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：生产端：acks=all（所有副本确认）、retries、幂等（enable.idempotence） | 核心概念 |
| 1:04 | 能力/参数拆解表 | 要点是：Broker：多副本（replication.factor=3）、min.insync.replicas=2 | 能力拆解 |
| 1:56 | 流程图：输入→处理→输出 | 要点是：消费端：手动提交 offset（enable.auto.commit=false）+ 幂等消费 | 关键机制 |
| 3:00 | 总结卡 + 下期预告 | 记住核心要点就够了。下期见。 | 收尾 |
