---
id: pdd-content-010
difficulty: L3
category: pdd-content
subcategory: Redis
tags:
- 拼多多
- 内容
- Redis
- 数据结构
- 分布式锁
- 直播
feynman:
  essence: Redis 数据结构（String/Hash/List/Set/ZSet）覆盖内容场景；分布式锁用 SETNX+expire+Redisson 看门狗，避免直播/评价并发问题。
  analogy: Redis 像百宝箱——String 是抽屉、Hash 是分层盒、ZSet 是带标签的排队牌，分布式锁是"取号机"防止重复。
  first_principle: 内容场景有计数/排行/时间线/去重需求，Redis 数据结构正好契合；并发互斥需要锁。
  key_points:
  - 五大结构：String/Hash/List/Set/ZSet
  - 计数：incrby（点赞）
  - 排行榜：ZSet（热门直播）
  - 时间线：ZSet（Feed）
  - 分布式锁：SETNX+expire+Lua 释放
first_principle:
  problem: 内容场景的计数/排行/时间线/互斥如何高效实现？
  axioms:
  - 计数高频
  - 排行需排序
  - 并发需互斥
  rebuild: Redis 数据结构 + 分布式锁。
follow_up:
  - 分布式锁怎么防死锁？——SET NX EX（原子）+ 业务短+看门狗续期
  - Redlock 是什么？——多节点半数以上获取（争议大）
  - ZSet 怎么实现排行榜？——score=热度/分数，member=ID
memory_points:
  - 五大结构：String/Hash/List/Set/ZSet
  - 计数：incrby
  - 排行：ZSet
  - 锁：SETNX+EX+Lua 释放
---

# 【拼多多内容】Redis 数据结构与分布式锁（直播/评价）？

> JD 依据："分布式/缓存/消息/搜索"、"高并发大流量"。

## 一、五大结构与应用

| 结构 | 特点 | 内容场景 |
|------|------|----------|
| String | K-V | 点赞数 incrby、视频计数、限流计数 |
| Hash | 字段-值 | 评价详情（review:{id} 字段缓存） |
| List | 双向链表 | 消息队列（lpush/rpop） |
| Set | 集合 | 去重（用户点赞过哪些 live_id） |
| ZSet | 有序集合 | 排行榜（热门直播/评价）、Feed 时间线 |

## 二、内容场景实战

**1. 评价点赞计数（String）**：
```java
// 点赞
redis.opsForValue().increment("review:like:" + reviewId);
// 防重复点赞（Set）
redis.opsForSet().add("user:liked:review:" + uid, reviewId.toString());
```

**2. 热门直播榜（ZSet）**：
```java
// 直播间热度变化
redis.opsForZSet().incrementScore("live:hot", liveId, watchCount);
// 取 Top 10
Set<Object> topLives = redis.opsForZSet().reverseRange("live:hot", 0, 9);
```

**3. Feed 时间线（ZSet）**：
```java
// 发布 Feed 推到粉丝收件箱
for (Long fanId : fans) {
    redis.opsForZSet().add("feed:inbox:" + fanId, feedId, createTime);
}
// 拉取 Feed
Set<Object> feedIds = redis.opsForZSet()
    .reverseRangeByScore("feed:inbox:" + uid, minTime, maxTime);
```

**4. 评价详情缓存（Hash）**：
```java
redis.opsForHash().putAll("review:" + id, review.toMap());
// 部分更新（只改状态）
redis.opsForHash().put("review:" + id, "status", "1");
```

**5. 直播间在线用户（HyperLogLog，去重计数）**：
```java
redis.opsForHyperLogLog().add("live:uv:" + liveId, uid);
long uv = redis.opsForHyperLogLog().size("live:uv:" + liveId);   // 误差 0.81%
```

## 三、分布式锁

**朴素实现（有坑）**：
```
SETNX lock:review:1 1     → 抢锁
EXPIRE lock:review:1 30   → 设过期（但两步非原子，崩了死锁）
```

**原子实现**：
```bash
SET lock:review:1 <requestId> NX EX 30   # 原子抢锁+设过期
```

**释放（Lua 保证原子）**：
```lua
if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
else
    return 0
end
```

**Redisson（推荐）**：
```java
RLock lock = redisson.getLock("lock:review:" + id);
try {
    if (lock.tryLock(3, 30, SECONDS)) {   // 等 3s，持 30s
        // 业务
    }
} finally {
    if (lock.isHeldByCurrentThread()) lock.unlock();
}
```

**看门狗机制**：Redisson 默认 30s 锁，每 10s 续期一次，业务没完不释放，避免长任务死锁。

## 四、内容场景锁应用

**1. 评价审核去重**：
```java
RLock lock = redisson.getLock("lock:audit:" + reviewId);
if (lock.tryLock(0, 30, SECONDS)) {
    // 审核逻辑，防多审核员同时审
}
```

**2. 直播间计数预热（防缓存击穿）**：
```java
String key = "live:stat:" + liveId;
if (redis.get(key) == null) {
    RLock lock = redisson.getLock("lock:" + key);
    if (lock.tryLock(1, 10, SECONDS)) {
        try {
            // 重建缓存，防并发击穿
            redis.set(key, loadFromDB(liveId), 5, MINUTES);
        } finally { lock.unlock(); }
    }
}
```

## 五、锁的注意

```
1. 锁一定要设过期（防进程崩死锁）
2. 释放要校验 requestId（防释放别人的锁）
3. 业务执行要短（<过期时间）
4. 高一致场景慎用 Redlock（多数派），主从切换会丢锁
```

## 六、底层本质

Redis 数据结构本质是**"用内存+高效结构匹配内容场景需求"**——计数用 String、排行用 ZSet、去重用 Set/HLL；分布式锁本质是**"SETNX+过期+原子释放+续期"**。

## 常见考点
1. **ZSet 底层是什么**？——跳表（skiplist）+ 字典，跳表支持范围有序。
2. **Redlock 安全吗**？——争议（Martin Kleppmann 批评），主从异步复制会丢锁，强一致用 ZK/etcd。
3. **怎么实现可重入锁**？——Redisson 用 Hash 存 thread + count。
