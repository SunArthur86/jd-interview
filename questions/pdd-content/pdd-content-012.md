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
