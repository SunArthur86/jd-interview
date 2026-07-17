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

## 苏格拉底式面试追问

> 这组追问不是背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：评价点赞计数你用 String（incrby）+ Set（防重），为什么不直接用一个 Hash 存"点赞数 + 点赞用户列表"？**

Hash 存用户列表会膨胀——一个热门评价可能被几十万人点赞，把几十万 uid 塞进一个 Hash field，单 key 几十 MB，Redis 操作（HGETALL）会阻塞。拆成两个 key 是"读写分离 + 数据结构适配"：`review:like:{id}`（String，incrby 极快，O(1)）负责计数读；`user:liked:review:{uid}`（Set，SISMEMBER O(1)）负责防重判断。更深一步，热门评价的点赞用户用 Set 也撑不住（百万级），改用 Bitmap（`uid` 作为 bit 偏移）或 HyperLogLog（允许 0.81% 误差），空间从 MB 降到 KB。本质是"按数据规模和访问模式选数据结构"，而不是图省事用一个结构。

### 第二层：证据与定位

**Q：热门直播榜（ZSet）突然取不到数据了，`ZREVRANGE live:hot 0 9` 返回空，你怎么定位是 key 丢了还是过期了？**

ZSet 返回空有两种可能：key 不存在，或 key 存在但没 member。排查：
1. `redis-cli EXISTS live:hot`——如果返回 0，key 不存在。再看 `TTL live:hot`（如果设了过期，可能已过期）。同时看 `OBJECT FREQ live:hot`（如果开了 LFU，可能被淘汰）。
2. `redis-cli ZCARD live:hot`——如果 key 存在但 ZCARD=0，说明 member 被清空（如误执行了 `ZREMRANGEBYRANK`）。
3. 看数据写入——`live:hot` 的 score 是 `watchCount`，如果直播热度统计任务（Flink/定时任务）挂了，没人 `ZADD`，旧数据过期后就空了。
4. 看是否大 key 被拆——如果直播数到百万级，单 ZSet 几 GB 触发了拆分（按分片），查询的 key 名变了。

### 第三层：根因深挖

**Q：你用 Redisson 分布式锁做"评价审核去重"，但偶尔两个审核员同时审了同一条评价。根因可能是什么？**

分布式锁失效的常见根因：
1. **锁过期但业务没完**——`tryLock(0, 30, SECONDS)` 设了 30s 过期，但审核调 NLP 服务超时（40s），锁已释放，第二个审核员拿到锁。看门狗（watchdog）默认 30s 续期，但如果业务线程阻塞在 IO（如 NLP 调用），看门狗线程也续不上（Redisson 的续期是 Netty EventLoop，被阻塞会丢续期）。
2. **解锁解了别人的锁**——没用 Lua 校验 requestId，A 的锁过期后 B 拿到，A 业务完了解锁，把 B 的锁解了。必须用 Lua（`if get == requestId then del`）。
3. **Redis 主从切换丢锁**——主库加锁成功还没同步到从库就宕机，哨兵提升从库为主，新主没这个锁，B 也能加锁成功。强一致场景要用 Redlock（多节点多数派）。

### 第四层：方案权衡

**Q：评价审核去重的本质是"幂等"，你用分布式锁，为什么不用唯一索引（DB）或 Redis SETNX + 状态机？三者权衡是什么？**

三种幂等方案的权衡：
1. **分布式锁**——性能中等（一次 Redis 往返），适合"防并发执行"（如审核去重，防止两个审核员同时点）。缺点是锁有失效风险，且不保证"只执行一次"（锁过期后可能重复）。
2. **唯一索引（DB）**——`UNIQUE KEY (review_id, audit_op)`，插入冲突即重复。强一致，但依赖 DB，写压力大。适合"必须只执行一次"（如扣款）。
3. **SETNX + 状态机**——`SETNX audit:lock:{reviewId} 1 EX 300`，配合评价 status 字段（0 待审→1 通过/2 拒绝），审核前 `UPDATE review SET status=1 WHERE id=? AND status=0`，affected rows=0 说明已被审。适合"状态流转幂等"。
评价审核场景推荐第三种——status 字段是业务已有数据，UPDATE 的 WHERE 条件天然幂等，不需要额外分布式锁，且 DB 的行锁保证原子性。锁留给"纯并发控制无状态"场景。

### 第五层：验证与沉淀

**Q：你怎么验证分布式锁在看门狗续期失效时不会出问题？**

看门狗失效是边角 case，要主动测：
1. 故障注入——在业务代码里 `Thread.sleep(35s)`（超过默认 30s 锁过期），模拟长任务，第二个线程尝试加锁，验证是否能拿到锁（不应该拿到，除非看门狗挂了）。
2. 看门狗健康度——监控 Redisson 的 `watchdog` 续期成功率，`renewalFailed` 告警；监控锁的"实际持有时间"vs"配置持有时间"，差距大说明续期异常。
3. Redis 侧——监控 `lock:audit:*` 的 key 生命周期，`redis-cli MONITOR`（测试环境）看续期的 `PEXPIRE` 命令频率。
沉淀：业务执行时间 >锁过期时间的 1/2 必须用看门狗（Redisson 默认开）；锁 key 必须带 requestId（UUID）用 Lua 解锁；审核幂等首选 DB 唯一索引/状态机，锁是补充。

## 结构化回答


**30 秒电梯演讲：** Redis 像百宝箱——String 是抽屉、Hash 是分层盒、ZSet 是带标签的排队牌，分布式锁是"取号机"防止重复。

**展开框架：**
1. **五大结构** — String/Hash/List/Set/ZSet
2. **计数：inc** — incrby（点赞）
3. **排行榜** — ZSet（热门直播）

**收尾：** 分布式锁怎么防死锁？


## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：Redis 数据结构与分布式锁（直播/评价）？ | 今天聊「Redis 数据结构与分布式锁（直播/评价）？」。一句话：Redis 数据结构（String/Hash/List/Set/ZSet）覆盖内容场景；分布式锁用 SETNX+exp… | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：五大结构：String/Hash/List/Set/ZSet | 核心概念 |
| 1:04 | 能力/参数拆解表 | 要点是：计数：incrby | 能力拆解 |
| 1:56 | 流程图：输入→处理→输出 | 要点是：排行：ZSet | 关键机制 |
| 3:00 | 总结卡 + 下期预告 | 记住这些核心点就够了。下期我们接着聊——分布式锁怎么防死锁？。 | 收尾 |
