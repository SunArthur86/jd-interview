---
id: pdd-content-012
difficulty: L3
category: pdd-content
subcategory: Kafka
tags:
- 拼多多
- 内容
- Kafka
- 事件流
- 评价
- 直播
feynman:
  essence: Kafka 用"分区+副本+消费者组"实现高吞吐解耦；评价/直播事件（发布/点赞/审核）走 Kafka 削峰+异步扩散到下游。
  analogy: Kafka 像快递分拣中心——按地址（分区）分到不同传送带，多个快递员（消费者）各取一类，互不抢活。
  first_principle: 解耦+削峰+扩散，用持久化队列让生产/消费解耦。
  key_points:
  - 分区（Partition）：并行单元
  - 副本（Replica）：高可用
  - 消费者组：组内分区分担
  - 三语义：at most/at least/exactly once
first_principle:
  problem: 多业务模块需要事件通知，如何解耦+削峰+可靠传递？
  axioms:
  - 生产消费速率不同
  - 故障不能丢消息
  - 多下游订阅同一事件
  rebuild: 分区+副本+消费组的持久化队列。
follow_up:
  - 怎么保证不丢？——acks=all + 消费手动提交 + 死信队列
  - 重复消费怎么办？——业务幂等（用 msgId 去重）
  - 怎么保证顺序？——同一 key 进同一分区
memory_points:
  - 分区：并行单元
  - 副本：Leader+Follower
  - 消费者组：组内分区分担
  - 三语义：最多/至少/恰好一次
---

# 【拼多多内容】Kafka 在评价/直播事件流的应用？

> JD 依据："分布式/缓存/消息/搜索"、"评价和行家社区"、"直播"。

## 一、Kafka 核心模型

```
Topic: review-event
  ├─ Partition 0:  [m0][m1][m2]...   每分区有序
  ├─ Partition 1:  [m0][m1]...
  └─ Partition 2:  [m0]...

每个分区：
  Leader（读写） + N 个 Follower（副本）
  ISR（同步副本集）≥ min.insync.replicas 才算 ack

消费者组：
  consumer1 ← Partition 0
  consumer2 ← Partition 1, 2
  组内一分区只给一个消费者（保证组内有序）
```

## 二、三语义

| 语义 | 实现 | 场景 |
|------|------|------|
| At most once | 自动提交+不重试 | 丢可接受（统计） |
| At least once | 手动提交+重试 | 主流（业务幂等） |
| Exactly once | 事务+幂等生产 | 强一致（金融） |

内容场景用 **at least once + 业务幂等**。

## 三、内容场景实战

**1. 评价事件流**：
```
用户提交评价 → 评价服务写 DB → 发 Kafka 事件 review.submitted

下游消费：
  - 审核服务：自动/人工审核
  - 搜索服务：同步 ES 索引
  - 统计服务：商品评分聚合
  - 通知服务：推送给商家
  - 推荐服务：召回素材
```

```java
// 生产
kafkaTemplate.send("review-event", review.getId(), event);

// 消费（幂等）
@KafkaListener(topics = "review-event", groupId = "search-sync")
public void onReview(ReviewEvent e) {
    if (consumeLog.exists(e.getMsgId())) return;   // 幂等
    esService.index(e.getReview());
    consumeLog.mark(e.getMsgId());
}
```

**2. 直播事件流**：
```
开播事件 live.started
  → 推送服务：通知粉丝
  → 统计服务：活跃主播数
  → 推荐服务：进入推荐池
  → 风控服务：内容审核

互动事件（点赞/送礼/弹幕）
  → 实时大屏（Flink 聚合）
  → 排行榜（Redis ZSet）
  → 内容审核（敏感词/视频流）
```

**3. Feed 流扩散（推模式）**：
```
发布 Feed → Kafka feed.published
  → 消费者拉粉丝列表 → 批量写 Redis ZSet（粉丝收件箱）
  → 大 V 走"拉模式"（不扩散，粉丝主动拉）
```

## 四、保证不丢+不重

**生产端不丢**：
```java
Properties p = new Properties();
p.put("acks", "all");                       // 主+所有 ISR 写入
p.put("retries", Integer.MAX_VALUE);        // 网络异常重试
p.put("max.in.flight.requests.per.connection", 5);  // 幂等生产防重排
p.put("enable.idempotence", true);
```

**Broker 配置**：
```
min.insync.replicas = 2   // 至少 2 副本同步
unclean.leader.election.enable = false   // 不允许落后副本当 Leader
```

**消费端不丢+幂等**：
```java
@KafkaListener(topics = "review-event")
public void consume(ReviewEvent e, Acknowledgment ack) {
    try {
        process(e);                          // 业务（含幂等）
        ack.acknowledge();                   // 手动提交
    } catch (Exception ex) {
        // 不 ack，下次重投
        deadLetter.send(e);                  // 多次失败进死信
    }
}
```

## 五、顺序保证

```
同一业务 key（reviewId/uid）→ 同一分区 → 分区内有序
```

```java
kafkaTemplate.send("review-event", reviewId, event);   // 用 reviewId 作 key
```

## 六、积压处理

```
发现积压：
  1. 加消费者（≤ 分区数）
  2. 扩分区（影响顺序，谨慎）
  3. 临时跳过历史（先恢复实时）
  4. 死信队列（毒消息隔离）
```

## 七、底层本质

Kafka 本质是**"用分区+副本+消费组的持久化队列实现解耦+削峰+可靠传递"**——分区并行、副本高可用、消费组分担、幂等+ack 保不丢。

## 常见考点
1. **怎么保证顺序消费**？——同 key 进同分区（分区内有序）。
2. **Kafka 高吞吐原因**？——顺序写盘+零拷贝（sendfile）+批量压缩+分区并行。
3. **怎么实现 exactly once**？——事务（事务 ID 跨会话）+ 幂等生产+消费端幂等。

## 苏格拉底式面试追问

> 这组追问不是背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：评价事件流你选 at-least-once + 业务幂等，而不是 exactly-once。Kafka 不是支持 exactly-once 吗？为什么不用？**

Kafka 的 exactly-once 是"事务（transactional producer）+ 幂等生产（idempotent producer）+ 隔离级别（read_committed）"，但它保证的只是"Kafka 内部的 exactly-once"——即消息从 source topic 到 sink topic 不重不丢（Kafka Streams 场景）。一旦消费端要写外部系统（MySQL/ES/Redis），Kafka 的事务管不到，还是得靠业务幂等。拼多多评价场景是"消费 review-event 写 ES + DB"，这是"Kafka → 外部系统"，exactly-once 事务帮不上。而且开事务的代价是吞吐降 20%+（事务协调 + 两阶段提交），得不偿失。所以用 at-least-once + 消费端用 msgId 去重（幂等），既保证不丢又不重复执行，是工业最优解。

### 第二层：证据与定位

**Q：审核服务消费 review-event 滞后，你发现 Kafka 积压了 100 万条，怎么定位是消费慢还是生产突增？**

看生产消费速率对比：
1. `kafka-consumer-groups.sh --describe --group audit-service`——看每个分区的 `LAG`（积压量）和 `LOG-END-OFFSET`（最新位点）。如果 LAG 在涨，说明消费速度 < 生产速度。
2. 看 Broker 的 `kafka-producer-metrics`——`record-send-rate` 是生产速率，对比消费端的 `records-consumed-rate`。如果生产涨了 3 倍（如评价高峰），是生产突增；如果消费速率没变但生产正常，是消费变慢。
3. 消费侧——看消费者 JVM 的 GC、线程池、下游（NLP 服务）延迟。常见根因是 NLP 模型推理从 50ms 涨到 500ms，消费者单线程吞吐跟不上。

### 第三层：根因深挖

**Q：评价事件"同一条评价被审核了两次"，你确认消费端有幂等（msgId 去重），为什么还重复？**

幂等失效的常见根因：
1. **msgId 不唯一**——如果用 `reviewId` 做 msgId，但同一条评价有"提交""编辑""上下架"多个事件，msgId 相同但语义不同，去重把合法的第二次审核也拦了。msgId 应该是 `reviewId + eventType + version`。
2. **去重存储过期**——如果用 Redis SETNX 做幂等，TTL 设太短（如 1 小时），消息延迟超过 TTL 后重投，去重已失效。内容场景 TTL 至少 7 天。
3. **消费者重启位点回退**——消费者处理完但 ACK 失败（如网络抖动），重启后从上次 committed offset 重新消费。如果"处理 + ACK"不是原子的（先处理业务后 ACK），重复消费不可避免。
根治：幂等去重用唯一业务键（`reviewId + auditOp + timestamp`）+ 长 TTL（7 天）+ ACK 在业务处理成功后（手动提交）。

### 第四层：方案权衡

**Q：评价事件要保证顺序（同一评价的状态变更有序），你用 reviewId 做 key 进同分区。但这样会导致热点（爆款评价的事件全堆一个分区），怎么权衡顺序和吞吐？**

这是 Kafka 分区设计的经典矛盾——"顺序性要求同 key 同分区"与"负载均衡要求均匀分布"冲突。权衡方案：
1. **评估热点严重度**——99% 的评价事件量均匀，只有 Top 100 爆款商品的评论高频。如果热点分区消费滞后但其他分区空闲，是热点问题。
2. **消费端并发优化**——单分区内多线程消费会破坏顺序，但可以"按 reviewId 二次分流"：消费者拉到消息后按 reviewId hash 到内存队列（N 个），每个队列单线程处理。这样分区内不同评价并行，同一评价仍有序。
3. **业务层容忍**——评价状态变更（待审→通过/拒绝）是单调的，即使乱序到达（先收到"通过"再收到"待审"），用版本号/时间戳判断丢弃过期事件即可，不强制严格顺序。

### 第五层：验证与沉淀

**Q：你把评价事件的 ACK 改成手动提交，怎么验证不丢消息（ACK 失败时消息能重投）？**

不丢消息的验证靠故障注入：
1. 消费端处理完业务后、ACK 前，主动 `throw RuntimeException`——模拟 ACK 失败。重启消费者，验证消息被重投且重新处理（结合幂等不会重复执行副作用）。
2. 生产端——构造 `acks=all` 场景，杀掉一个 ISR 副本，验证消息仍能写入（因为 min.insync.replicas=2 仍满足）；杀掉两个，验证生产端阻塞（因为不满足 ISR），不丢。
3. 端到端——压测发 100 万条评价事件，对比生产端"已发送数"vs 消费端"已处理数"，差值应为 0（或仅死信队列的数量）。
沉淀：所有消费者必须手动 ACK（禁止 enable.auto.commit）；死信队列必须有监控（堆积 >1000 告警）；幂等去重 TTL ≥ 消息最大重投间隔（通常 7 天）。

## 结构化回答




**30 秒电梯演讲：** Kafka 像快递分拣中心——按地址（分区）分到不同传送带，多个快递员（消费者）各取一类，互不抢活。

**展开框架：**
1. **Partition** — 分区（Partition）：并行单元
2. **Replica** — 副本（Replica）：高可用
3. **消费者组** — 组内分区分担

**收尾：** 怎么保证不丢？




## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：Kafka 在评价/直播事件流的应用？ | 今天聊「Kafka 在评价/直播事件流的应用？」。一句话：Kafka 用"分区+副本+消费者组"实现高吞吐解耦；评价/直播事件（发布/点赞/审核）走 Kafka 削峰+异步扩散… | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：分区：并行单元 | 核心概念 |
| 1:04 | 能力/参数拆解表 | 要点是：副本：Leader+Follower | 能力拆解 |
| 1:56 | 流程图：输入→处理→输出 | 要点是：消费者组：组内分区分担 | 关键机制 |
| 3:00 | 总结卡 + 下期预告 | 记住这些核心点就够了。下期我们接着聊——怎么保证不丢？。 | 收尾 |
