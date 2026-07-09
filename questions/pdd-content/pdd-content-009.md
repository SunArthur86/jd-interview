---
id: pdd-content-009
difficulty: L4
category: pdd-content
subcategory: Redis
tags:
- 拼多多
- 内容
- Redis
- 缓存一致性
- 评价
- Feed
feynman:
  essence: 缓存一致性用"Cache Aside（先写库再删缓存）+ 延时双删 + 最终一致（消息补偿）"破解并发下的脏数据；内容场景评价/Feed 频繁更新需特别注意。
  analogy: 缓存像便签纸——DB 是账本，便签是抄录，改账本要扔掉旧便签（删缓存），不然读到旧值。
  first_principle: 缓存是 DB 的副本，并发读写会产生"副本与账本不一致"，需删/更新策略+补偿。
  key_points:
  - Cache Aside：写库→删缓存（最常用）
  - 延时双删：写库→删缓存→延时再删
  - 最终一致：canal 监听 binlog + 消息补偿
  - 强一致：串行化/2PC（代价大）
first_principle:
  problem: 缓存是 DB 副本，并发下会出现脏读，如何保证一致？
  axioms:
  - 缓存为提速存在
  - 并发下读写有窗口
  - 强一致代价大
  rebuild: Cache Aside + 延时双删 + 异步补偿。
follow_up:
  - 为什么是删缓存不是更新缓存？——更新可能并发覆盖；删是惰性下次读再建
  - 延时双删多久合适？——读业务耗时（一次 DB 查询+业务），通常 1s
  - canal 同步怎么保证不丢？——binlog ACK + 幂等消费
memory_points:
  - Cache Aside：写库→删缓存
  - 延时双删：写库→删→延时再删
  - 最终一致：canal binlog + 消息
  - 强一致代价大，慎用
---

# 【拼多多内容】Redis 缓存一致性方案（评价/Feed）？

> JD 依据："稳定性建设"、"监控"。

## 一、不一致的根因

```
并发场景 1（先更新库再更新缓存）：
  T1 更新库 A=1
  T2 更新库 A=2
  T2 更新缓存 A=2
  T1 更新缓存 A=1   ← 库=2 缓存=1，脏！

并发场景 2（先删缓存再更新库）：
  T1 删缓存
  T2 读缓存未命中→读 DB（旧值 A=1）→ 写缓存 A=1
  T1 更新库 A=2   ← 库=2 缓存=1，脏！
```

## 二、主流策略：Cache Aside（旁路缓存）

```
写：先更新 DB → 再删缓存
读：查缓存未命中 → 查 DB → 写缓存
```

```java
@Transactional
public void updateReview(Review r) {
    reviewDao.update(r);
    redis.del("review:" + r.getId());    // 删缓存
}
```

**为什么删而不是更新**：删是幂等的；更新可能并发覆盖，删让下次读惰性重建。

**仍有问题**（极少）：
```
T1 读 DB（旧值）
T2 更新 DB
T2 删缓存
T1 写缓存（旧值）   ← 脏！
```
触发条件苛刻（T1 读 DB 必须比 T2 写+删慢得多，且无并发写），实际概率低。

## 三、延时双删（更稳）

```
T1 写 DB
T1 删缓存
T1 sleep 1s（等并发读完成）
T1 再删一次缓存
```

```java
public void updateReview(Review r) {
    reviewDao.update(r);
    redis.del(key);
    executor.schedule(() -> redis.del(key), 1, SECONDS);   // 延时再删
}
```

## 四、最终一致：canal 监听 binlog

```
DB → canal（伪装 slave）→ MQ → 消费者删缓存
```

```java
@KafkaListener(topics = "review-binlog")
public void onBinlog(BinlogEvent e) {
    if (e.getType() == UPDATE || e.getType() == DELETE) {
        redis.del("review:" + e.getId());
        // 同步更新 ES
        esService.update(e.toReview());
    }
}
```

**优点**：业务代码不感知缓存；DB 一致性由 binlog 保证。

## 五、内容场景实战

**评价缓存**：
```
评价页数据结构（Hash）：
  key = review:product:{productId}:page:1
  field = reviewId    value = {uid, content, score, ...}

更新策略：
  1. 用户改评价 → 写 DB → 删缓存
  2. canal 监听 binlog → 异步删缓存 + 更新 ES（搜索）
  3. 删除延时双删兜底（防并发读脏）
```

**Feed 流缓存**：
```
Feed 时间线：
  key = feed:user:{uid}
  type = ZSet   score=create_time   member=feed_id
  
更新策略：
  发布 Feed → 写 DB → canal 触发"推到粉丝收件箱"→ 异步
  读 Feed → ZSet 直接拿（避免扫全表）
```

**热点商品评价**（爆款）：
```
- 多级缓存：Caffeine（本地）+ Redis（分布式）
- 缓存预热：商品上架/活动前预热
- 失效：用户改/审核通过/新增 → 删 product:{id}:page:* + 异步重建
```

## 六、强一致（慎用）

如果必须强一致（如金融级）：
- 串行化：读写都加分布式锁（吞吐差）
- 2PC：DB 和缓存参与两阶段提交（复杂）

内容场景**不要**用强一致，最终一致足够。

## 七、底层本质

缓存一致本质是**"副本与原数据的一致性"**——Cache Aside 是基础（删优于更新），延时双删防并发窗口，canal binlog 做最终一致兜底。

## 常见考点
1. **缓存击穿/穿透/雪崩**？——击穿（互斥锁重建）/穿透（布隆+空值）/雪崩（随机 TTL）。
2. **怎么保证缓存高可用**？——Redis Cluster（主从+分片）+ Sentinel 哨兵。
3. **缓存预热怎么做**？——活动前批量灌入（脚本/任务）+ 灰度放量。
