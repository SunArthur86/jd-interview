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
