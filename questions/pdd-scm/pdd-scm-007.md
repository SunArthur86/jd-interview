---
id: pdd-scm-007
difficulty: L3
category: pdd-scm
subcategory: Redis
tags:
- 拼多多
- 供应链
- 分布式锁
- Redis
- Redlock
feynman:
  essence: 分布式锁解决"跨进程互斥"，Redis 实现（SET NX PX + Lua 释放）轻量高效，集群用 Redlock 防主从切换丢锁；供应链的库存扣减、防止重复下单都依赖它。
  analogy: 分布式锁像多仓共用的"提货单"——A 仓在扣库存时先占住单据（加锁），B 仓看到被占就等，防止超卖。
  first_principle: 单机锁只在 JVM 内有效，跨进程/跨机器需要"共享可见"的锁——Redis/ZK 是天然的共享存储。
  key_points:
  - Redis 锁：SET key value NX PX 30000 + Lua 释放（防误删）
  - value 必须是唯一标识（UUID），释放时验证防误删
  - 看门狗续期（Redisson）防业务超时锁自动释放
  - Redlock：多数派（N/2+1）防主从切换丢锁
first_principle:
  problem: 多机器并发操作同一资源（如库存），如何互斥？
  axioms:
  - 单机锁跨进程无效
  - 需要共享可见的锁状态
  - 网络不可靠（锁可能因宕机/超时失效）
  rebuild: Redis 共享存储 + SET NX PX 原子加锁 + UUID 防误删 + 看门狗续期 + Redlock 防故障切换。
follow_up:
- Redis 锁和 Zookeeper 锁怎么选？——Redis 性能高但 CP 弱（主从切换可能丢锁）；ZK 强一致（CP）但慢。供应链用 Redisson（够用）
- 库存扣减一定要分布式锁吗？——不一定，可以用 Redis 原子 Lua 脚本扣减（DECYBY + 判断）
- 锁过期业务没做完怎么办？——看门狗（Redisson）自动续期，或业务幂等设计
memory_points:
- Redis 锁：SET NX PX（原子）+ Lua 释放（验证 UUID 防误删）
- 看门狗续期防业务超时
- Redlock：多数派防主从切换丢锁
- 锁要带唯一标识（UUID），释放时验证
---

# 【拼多多供应链】分布式锁怎么实现？库存扣减怎么防超卖？

> JD 依据："分布式系统的设计和应用" + "高并发系统的开发和调优"。

## 一、为什么需要分布式锁

单机 `synchronized` 只在 JVM 内有效。跨机器扣库存、防止重复下单等需要"跨进程互斥"。

```
机器A: deduct(sku=1, qty=1)  ─┐
                              ├─ 都读到 stock=1，都扣成功 → 超卖！
机器B: deduct(sku=1, qty=1)  ─┘
```

## 二、Redis 分布式锁实现

**加锁**（原子操作）：
```bash
SET lock:sku:1 <uuid> NX PX 30000
# NX：不存在才设（互斥）
# PX 30000：30 秒过期（防死锁）
# value 用 UUID 标识持有者
```

**释放**（Lua 保证原子：验证+删除）：
```lua
if redis.call("get", KEYS[1]) == ARGV[1] then  -- 验证是自己的锁
    return redis.call("del", KEYS[1])
else
    return 0  -- 不是自己的，不删（防误删）
end
```

**为什么 Lua**：GET + DEL 非原子，可能 A 的锁过期后被 B 获取，A 误删 B 的锁。

## 三、Redisson（生产级实现）

Redisson 封装了看门狗、可重入、Redlock：

```java
RLock lock = redisson.getLock("lock:sku:" + skuId);
try {
    if (lock.tryLock(3, 30, SECONDS)) {  // 等 3s，锁 30s
        deductStock(skuId, qty);
    }
} finally {
    lock.unlock();
}
```

**看门狗**：默认每 10s 续期到 30s，业务不超时锁不丢。

## 四、Redlock（集群容灾）

单主 Redis 主从切换可能丢锁（主加锁后还没同步就挂）。Redlock 在 N（奇数）个独立节点同时加锁，**N/2+1 个成功才算获锁**。

```
5 个独立 Redis → 在 3 个以上加锁成功才算获锁
任一节点挂不影响（3/5 多数派仍可用）
```

## 五、供应链实战：库存扣减

**方案 1：分布式锁**（简单但慢）：
```java
RLock lock = redisson.getLock("lock:sku:" + skuId);
lock.tryLock(1, 10, SECONDS);
try { stockDao.deduct(skuId, qty); }
finally { lock.unlock(); }
```

**方案 2：Redis Lua 原子扣减**（高性能，推荐）：
```lua
local stock = tonumber(redis.call("get", KEYS[1]))
if stock and stock >= tonumber(ARGV[1]) then
    redis.call("decrby", KEYS[1], ARGV[1])
    return 1  -- 成功
end
return 0  -- 库存不足
```
异步把 Redis 库存同步回 DB（对账保证最终一致）。

**方案 3：DB 乐观锁**（适合低并发）：
```sql
UPDATE stock SET qty = qty - 1 WHERE sku_id = 1 AND qty >= 1;
-- 影响行数=0 说明库存不足
```

## 六、底层本质

分布式锁本质是**"用共享存储的原子性模拟单机锁"**。选择取决于一致性和性能权衡：
- Redis：性能高，AP（主从切换可能丢锁）
- ZK：强一致 CP，但慢
- etcd：Raft 强一致，性能介于二者

供应链选 Redis（Redisson）——性能优先，配合幂等设计兜底。

## 常见考点
1. **Redis 锁为什么用 UUID**？——释放时验证，防止 A 误删 B 的锁（锁过期场景）。
2. **看门狗机制**？——Redisson 默认每 1/3 过期时间续期，业务没做完锁不释放。
3. **Redlock 争议**？——Martin Kleppmann 质疑（时钟漂移、GC pause），Redis 作者反驳；强一致场景用 ZK/etcd。

## 苏格拉底式面试追问

> 这组追问不是背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：库存扣减防超卖，你选了 Redis Lua 原子扣减而不是 Redisson 分布式锁。为什么？分布式锁不是更直观吗？**

因为分布式锁是"串行化"，Lua 是"原子操作"，性能差一个数量级。用 Redisson 锁扣库存：每个请求先 `tryLock`（1 次 RTT）→ 执行业务 → `unlock`（1 次 RTT），同一 SKU 的请求只能串行，QPS 被锁排队压到几百。用 Lua：把"判断库存够不够 + 扣减"写进一段 Lua 脚本，Redis 单线程执行保证原子性，1 次 RTT 搞定，同一 SKU 仍是串行但无锁开销，QPS 能到几万。本质区别是：锁保护的是"临界区里的多步操作"，Lua 把多步合并成单步原子，省掉了锁的获取/释放开销。

### 第二层：证据与定位

**Q：大促时有用户反馈同一笔订单扣了两次库存。你怎么确认是分布式锁/Lua 失效，还是上游重复发请求？**

先分清是"锁内并发"还是"重复请求"：
1. **看幂等层**——订单服务下单时应该带幂等键（`idempotency_key = uid + sku + timestamp_hash`），检查 Redis `SETNX order:lock:{idempotency_key}` 是否生效。如果两次请求的 idempotency_key 相同但都通过了，说明幂等层漏了。
2. **看扣减日志**——库存扣减记录表 `stock_log` 按 `order_id` group by having count>1，如果同一订单两条扣减记录，且时间戳相差 < 50ms，是并发问题（锁/Lua 没生效）；如果相差几分钟，是重试/重复支付问题。
3. **看 Redis Lua 执行**——`redis-cli MONITOR` 抓扣减命令，看同一 order_id 是不是触发了两次 `EVAL`，如果是，说明上游确实重复调用，不是 Lua 失效。

### 第三层：根因深挖

**Q：你确认 Lua 脚本执行了两次（两次 EVAL），但 order_id 相同。根因是 Lua 没做幂等，还是别的？**

根因是 Lua 脚本只做了"库存判断 + 扣减"，没做"订单幂等校验"。Lua 里应该先查 `stock_log` 是否已有该 order_id 的扣减记录：
```lua
-- 幂等校验
if redis.call("SISMEMBER", KEYS[2], ARGV[2]) == 1 then
    return 2  -- 已扣减过，幂等返回
end
local stock = tonumber(redis.call("get", KEYS[1]))
if stock and stock >= tonumber(ARGV[1]) then
    redis.call("decrby", KEYS[1], ARGV[1])
    redis.call("SADD", KEYS[2], ARGV[2])  -- 记录已扣减的 order_id
    return 1
end
return 0
```
KEYS[1] 是库存 key，KEYS[2] 是已扣减订单的 Set，ARGV[2] 是 order_id。根因不是锁/Lua 不原子，而是"原子操作里缺幂等校验"，重复请求照样穿透。

**Q：那为什么不直接在 Java 代码里用 Redisson 分布式锁包住 Lua 调用，双重保险？**

双重保险是过度设计且有害：
1. **性能灾难**——Redisson 锁让同一 SKU 的扣减串行化，QPS 从几万掉到几百，大促直接超时。
2. **锁没解决幂等**——锁只保证"同一时刻一个请求执行"，但两次请求如果错开时间（第一次锁释放后第二次再抢锁），照样各扣一次。锁防并发不防重复。
正确做法是把幂等校验放进 Lua（原子），不要外层套锁。如果担心 Lua 执行慢（几十毫秒）导致排队，可以给热点 SKU 做库存预热分桶（10 个 key 各存 1/10 库存），把单 key 的并发分散。

### 第四层：方案权衡

**Q：你的 Lua 扣减是 Redis 单点权威，但 Redis 宕机了怎么办？库存数据会不会丢？**

Redis 宕机的风险是"已扣减的数据没同步到 DB"。兜底链路：
1. **AOF + 每秒刷盘**——Redis 配 `appendfsync everysec`，宕机最多丢 1 秒数据。配合 AOF 重写，恢复后库存基本准确。
2. **异步对账补偿**——Lua 扣减成功后，异步把扣减记录写 DB（`stock_log` 表）。Redis 挂了从 DB 恢复：`stock = DB 初始库存 - Σ(stock_log 扣减记录)`，定时任务每分钟对账 Redis 和 DB，偏差 > 阈值告警。
3. **Redis 主从 + Sentinel**——主挂自动切从，从库有近实时副本（异步复制可能丢少量）。强一致场景用 Redis Cluster + `WAIT` 命令（等 N 个副本确认）。

**Q：为什么不用 DB 的乐观锁（UPDATE stock SET qty=qty-1 WHERE sku_id=? AND qty>=1）做扣减？它不也能防超卖吗**

DB 乐观锁能防超卖，但扛不住大促并发：
1. **行锁串行**——`UPDATE ... WHERE sku_id=1` 会对该行加行锁，1000 并发扣同一 SKU，999 个等行锁，QPS 最多几百。Redis 单线程也是串行，但在内存里，快 100 倍。
2. **失败重试成本**——乐观锁失败（影响行数=0）要重试，高并发下大量重试把 DB 打爆。
3. **DB 连接池瓶颈**——每个扣减占一个 DB 连接，连接池（如 50）打满后请求排队。
所以策略是：热点 SKU 走 Redis Lua（高性能），冷门 SKU 或对账走 DB（强一致）。Redis 是性能层，DB 是兜底层，不是二选一。

### 第五层：验证与沉淀

**Q：你怎么证明防超卖方案真的生效、线上没有超卖事故？**

三个验证手段：
1. **超卖计数器**——扣减时如果 `stock < 0`，`INCR oversell_count:{date}`，每天看这个指标必须 = 0。大促后跑全量对账 `SELECT SUM(qty) FROM stock_log WHERE sku_id=X` 对比 DB 库存，偏差 = 0。
2. **混沌演练**——故意在压测环境造并发扣减（1000 线程同时扣同一 SKU 库存 1），最终库存必须是 0 而不是 -xx；再演练 Redis 宕机（kill -9），看对账补偿能否恢复。
3. **幂等验证**——用相同 order_id 重放扣减请求 100 次，`stock_log` 里该 order_id 只有一条记录。

**Q：怎么让团队写扣减代码时不再踩超卖坑？**

沉淀三道防线：
1. **扣减 SDK**——封装 `StockClient.deduct(skuId, qty, orderId)`，内部强制走 Lua（含幂等校验），业务方调 SDK 不能绕过去手写 SQL。
2. **Code Review 规则**——任何直接 `UPDATE stock SET qty=qty-?` 的 SQL 必须 review，必须有 `qty>=?` 条件 + 幂等键。
3. **大盘监控**——`stock_deduct_fail_rate`（扣减失败率，含库存不足 + 幂等冲突）、`oversell_count`、`redis_db_diff`（Redis 与 DB 库存差），任一异常飞书告警值班。

## 结构化回答

**30 秒电梯演讲：** 多机器并发操作同一资源（如库存），如何互斥？简单说就是——分布式锁解决"跨进程互斥"，Redis 实现（SET NX PX + Lua 释放）轻量高效，集群用 Redlock 防主从切换丢锁；供应链的库存扣减、防止重复下单都依赖它。

**展开框架：**
1. **Redis 锁** — Redis 锁：SET key value NX PX 30000 + Lua 释放（防误删）
2. **value 必须是唯一标** — value 必须是唯一标识（UUID），释放时验证防误删
3. **看门狗续期** — 看门狗续期（Redisson）防业务超时锁自动释放

**收尾：** 您看这块要不要再展开聊聊？

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：分布式锁怎么实现？库存扣减怎么防超卖？ | 今天聊「分布式锁怎么实现？库存扣减怎么防超卖？」。一句话：分布式锁解决"跨进程互斥"，Redis 实现（SET NX PX + Lua 释放）轻量高效 | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：Redis 锁：SET key value NX PX 30000 + Lua 释放（防误删） | 核心概念 |
| 1:04 | 能力/参数拆解表 | 要点是：value 必须是唯一标识（UUID），释放时验证防误删 | 能力拆解 |
| 1:56 | 流程图：输入→处理→输出 | 要点是：看门狗续期（Redisson）防业务超时锁自动释放 | 关键机制 |
| 3:00 | 总结卡 + 下期预告 | 记住核心要点就够了。下期见。 | 收尾 |
