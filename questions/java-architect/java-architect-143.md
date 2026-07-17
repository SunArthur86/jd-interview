---
id: java-architect-143
difficulty: L2
category: java-architect
subcategory: 交易架构
title: 热点账户与热点库存的串行化设计
tags: [热点账户, 热点库存, Redis Lua, 串行化, 扣减]
related: [java-architect-026, java-architect-138, java-architect-143]
---

# 热点账户与热点库存的串行化设计

> **场景**：京东 618 大促，茅台秒杀单 SKU 10 万人同时抢 1000 件；某头部商家账户每秒上千笔入账/出账。如果直接打 MySQL，行锁排队会把 DB 打爆。面试官问：热点怎么破？

## 一、概念层：热点是怎么产生的

### 1.1 两种热点

| 类型 | 表现 | 后果 |
|------|------|------|
| **热点库存** | 单 SKU 高并发扣减 | MySQL 行锁排队 → 超时 → 超卖 |
| **热点账户** | 单账户高频出入账 | 行锁等待 → TPS 骤降 → 资金延迟 |

### 1.2 为什么 DB 扛不住

```sql
-- 茅台库存表
UPDATE t_sku_stock SET stock = stock - 1 WHERE sku_id = 1001 AND stock > 0;
```

10 万并发同时执行 → InnoDB 行锁排队 → `lock_wait_timeout`（默认 50s）→ 大量事务回滚 → 应用重试 → 雪崩。

### 1.3 串行化的本质

热点问题本质是**多个事务争抢同一资源**。解法就两条路：
1. **减少争抢**：把一个热点拆成 N 个冷点（分桶）
2. **加速争抢**：把争抢从 DB 上移到 Redis 单线程模型（μs 级 vs ms 级）

## 二、机制层：四种主流方案

### 2.1 方案 A：Redis Lua 原子扣减（小流量）

```lua
-- deduct.lua：库存扣减原子脚本
local key = KEYS[1]
local qty = tonumber(ARGV[1])
local stock = tonumber(redis.call('GET', key) or '0')
if stock < qty then
    return -1  -- 库存不足
end
redis.call('DECRBY', key, qty)
return stock - qty
```

```java
@Service
@RequiredArgsConstructor
public class StockService {
    private final StringRedisTemplate redis;
    private final DefaultRedisScript<Long> deductScript;

    @PostConstruct
    public void init() {
        deductScript.setScriptSource(new ResourceScriptSource(
            new ClassPathResource("lua/deduct.lua")));
        deductScript.setResultType(Long.class);
    }

    public boolean deduct(String skuId, int qty) {
        Long remain = redis.execute(deductScript, 
            Collections.singletonList("stock:" + skuId), String.valueOf(qty));
        if (remain == null || remain < 0) {
            return false;  // 库存不足
        }
        // 异步落 DB（避免 DB 行锁热点）
        mq.asyncSend("stock-sync", new StockSyncMsg(skuId, qty, "deduct"));
        return true;
    }
}
```

**优点**：Redis 单线程保证原子性，QPS 单实例 8-10 万
**缺点**：单 Redis 实例即上限，单点故障即超卖

### 2.2 方案 B：库存分桶（大流量，JD 主流）

把 1000 件茅台拆成 100 桶，每桶 10 件：

```java
public class BucketStockService {
    private static final int BUCKET_COUNT = 100;
    private final RedisTemplate<String, String> redis;
    private final ConsistentHash router;  // 路由用户到固定桶

    public boolean deduct(String skuId, int qty, String userId) {
        // 1. 路由：用户 hash 到一个桶（保证同一用户多次请求落到同一桶）
        int bucket = Math.abs(userId.hashCode()) % BUCKET_COUNT;
        String key = "stock:" + skuId + ":bucket:" + bucket;

        Long remain = redis.execute(deductScript, 
            List.of(key), String.valueOf(qty));
        if (remain != null && remain >= 0) return true;

        // 2. 当前桶不足，尝试迁移到其他桶（重试）
        return migrateAndRetry(skuId, qty, bucket);
    }

    private boolean migrateAndRetry(String skuId, int qty, int excludeBucket) {
        // Lua 原子迁移：从其他桶搬库存到当前桶
        for (int i = 0; i < BUCKET_COUNT; i++) {
            if (i == excludeBucket) continue;
            Long moved = redis.execute(migrateScript,
                List.of("stock:" + skuId + ":bucket:" + i,
                        "stock:" + skuId + ":bucket:" + excludeBucket),
                String.valueOf(qty));
            if (moved != null && moved > 0) return true;
        }
        return false;  // 所有桶都没了
    }
}
```

**效果**：单 SKU 从 8 万 QPS 提升到 800 万 QPS（100 桶 × 8w）。

### 2.3 方案 C：热点账户余额汇总（高频出入账）

账户问题更复杂：既要扣减，又要保证不超支。JD 钱包方案——**子账户分片 + 异步汇总**：

```sql
-- 主账户表（强一致）
CREATE TABLE t_account (
    account_id BIGINT PRIMARY KEY,
    balance DECIMAL(18,2),           -- 总余额（异步汇总）
    version INT                      -- 乐观锁
);

-- 子账户分片表（高并发写入）
CREATE TABLE t_account_shard (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    account_id BIGINT,
    shard_no INT,                    -- 0-99
    balance DECIMAL(18,2),
    INDEX idx_account_shard(account_id, shard_no)
);
```

```java
// 出账：扣减随机一个子账户
@Transactional
public void debit(Long accountId, BigDecimal amount) {
    int shard = ThreadLocalRandom.current().nextInt(100);
    AccountShard s = shardMapper.selectByLock(accountId, shard);
    if (s.getBalance().compareTo(amount) < 0) {
        throw new BizException("INSUFFICIENT_BALANCE");
    }
    s.setBalance(s.getBalance().subtract(amount));
    shardMapper.update(s);
    // 不立即更新主账户，异步汇总
    mq.asyncSend("account-summarize", new SummarizeMsg(accountId));
}

// 定时汇总（每 10s）：聚合子账户余额到主账户
@Scheduled(fixedDelay = 10_000)
public void summarize() {
    List<Long> dirtyAccounts = accountDirtyRepo.popAll();
    for (Long aid : dirtyAccounts) {
        BigDecimal total = shardMapper.sumBalance(aid);
        accountMapper.updateBalanceWithVersion(aid, total);
    }
}
```

### 2.4 方案 D：异步排队（削峰）

秒杀场景把扣减请求先入队列，后端慢慢消费：

```
用户请求 → Redis Token Bucket 限流 → 写 MQ → 消费者串行扣库存 → 返回结果
```

延迟从 ms 变成 s，但保护了系统。常配合方案 B 使用。

## 三、实战层：选型决策矩阵

| 场景 | QPS | 推荐方案 | 一致性 |
|------|-----|----------|--------|
| 普通商品库存扣减 | < 1w | DB 行锁 + 乐观锁 | 强一致 |
| 热销品库存 | 1w-10w | Redis Lua 原子扣减 | 最终一致（异步落DB） |
| 秒杀品（茅台/iPhone） | > 10w | 分桶 + 异步排队 | 最终一致 |
| 账户余额 | 千级 | 子账户分片 + 汇总 | 最终一致 |
| 资金核心账户 | 百级 | DB 行锁 + 强一致 | 强一致（不可降级） |

### 3.1 落库时机：实时 vs 异步

```java
// 错误：Redis 扣减成功后同步落 DB（仍可能打爆 DB）
@Transactional
public boolean deductBad(String skuId, int qty) {
    redis.execute(deductScript, ...);  // Redis 扣减
    stockMapper.update(skuId, qty);    // 同步落 DB → 行锁热点未解决
    return true;
}

// 正确：异步落 DB，Redis 为准
public boolean deductGood(String skuId, int qty) {
    Long remain = redis.execute(deductScript, ...);
    if (remain < 0) return false;
    // 异步消息落 DB（消费者批量、限速）
    mq.asyncSend("stock-sync", new StockMsg(skuId, qty));
    return true;
}
```

异步落 DB 的消费者要做**幂等**（消息可能重投）+ **批量**（提升 DB 吞吐）。

### 3.2 Redis 故障兜底

Redis 挂了怎么办？三级降级：
1. Redis Cluster 自动 failover（秒级）
2. failover 期间请求走 DB 行锁（限流降级）
3. 极端情况（多节点同时挂）→ 关闭秒杀活动

```java
public boolean deductWithFallback(String skuId, int qty) {
    try {
        return redisDeduct(skuId, qty);   // 优先 Redis
    } catch (RedisException e) {
        monitor.alert("REDIS_DOWN");
        return dbDeductWithLock(skuId, qty);  // 降级 DB（限流）
    }
}
```

## 四、底层本质：锁与并发的权衡

### 4.1 First Principle：热点 = 共享资源的争抢

无论 DB 行锁、Redis 单线程、Java synchronized，本质都是**串行化**。差别只在：
- DB 行锁：磁盘 IO + 锁等待，μs-ms 级
- Redis 单线程：内存 + 单线程，ns-μs 级
- 分桶：把"1 个锁"变成"N 个锁"，并行度 N 倍

所以热点优化的核心：**用更快的存储 + 把锁拆得更细**。

### 4.2 为什么 Redis 单线程能扛住热点

Redis 6 的核心命令处理是单线程的，单 key 操作天然原子。`DECRBY` 命令在 Redis 内部就是"读取-判断-修改-返回"四步一气呵成，没有锁竞争。这就是为什么 10 万 QPS 单 SKU 扣减在 Redis 上是稳的。

### 4.3 Feynman 解释

把库存想成银行柜台的现金。
- 直接打 DB：所有人在一个柜台排队，柜员手忙脚乱。
- Redis Lua：开了一个超级快的自动取款机（μs 级），但只有一台。
- 分桶：开了 100 台 ATM，把人群分流到不同机器。
- 异步排队：门口发号牌，进大厅慢慢处理。

## 五、AI 架构师加问

**Q1：分桶后某桶卖完了怎么处理？**
桶间迁移：用 Lua 原子脚本从其他桶搬库存到当前桶。极端情况（所有桶都空了）才返回售罄。迁移要限流，避免"搬空效应"。

**Q2：异步落 DB 消息丢了怎么办？**
Redis 扣减 + MQ 都是 at-least-once，DB 落库消息可能重投，DB 侧用 `deduct_id`（请求唯一 ID）做幂等表。极端情况用 Redis 与 DB 的定时对账修复。

**Q3：子账户分片怎么保证总余额正确？**
汇总任务用 `SUM(balance)` 重算总余额，乐观锁更新主账户。汇总期间冻结该账户的出账（短时间内）。

**Q4：分桶数量怎么定？**
经验值：单 SKU 预估 QPS / 单 Redis QPS（8w）= 桶数。茅台 800 万 QPS → 100 桶。桶太多增加迁移成本，太少不扛量。

**Q5：DB 行锁能否优化？**
可以——把 `UPDATE ... WHERE stock > 0` 改为乐观锁 `UPDATE ... WHERE stock = ? AND version = ?`，减少锁等待时间。但本质还是串行，扛不住 10w+ QPS。

## 六、记忆口诀

```
热点两条路：拆锁、提速。
Redis Lua 原子扣，单实例八万 QPS。
分桶拆锁并行度，秒杀百万轻松扛。
账户分片加汇总，异步落库避热点。
强一致选 DB，最终一致选 Redis；
降级三道防线：Cluster、DB、关活动。
```

## 七、苏格拉底追问

| 层级 | 问题 | 关键答案 |
|------|------|----------|
| L1 表象 | 热点库存直接打 DB 会怎样？ | 行锁排队 → 超时 → 雪崩 |
| L2 机制 | Redis Lua 为什么原子？ | 单线程模型，脚本内多命令不可被打断 |
| L3 边界 | Redis 扣减成功了但 MQ 投递失败怎么办？ | 重试 + DB 幂等 + 定时对账 |
| L4 权衡 | 分桶 vs 异步排队怎么选？ | 分桶用于"必须立即返回结果"；排队用于"可接受延迟" |
| L5 反例 | 分桶后某用户连续两次请求路由到同一桶，扣减冲突？ | 不会，Lua 原子；但同一用户多次抢同一桶的概率较高时，用 user_id+随机扰动 |
| L6 极限 | 单 SKU 1 亿 QPS 怎么办？ | 多机房分流 + 每机房独立库存池 + 总控中心动态调拨 |
| L7 系统 | 资金账户能否用分片？ | 不能（监管要求强一致），资金核心走 DB 行锁，外围营销账户可分片 |

**对话还原**：
> 面试官：茅台秒杀库存怎么设计？
> 我：DB 直接扛不住。我们 Redis Cluster 扣减 + 100 桶分片，单 SKU 抗 800 万 QPS。扣减成功后 MQ 异步落 DB，DB 侧用 deduct_id 幂等。
> 面试官：分桶后某个桶没库存了怎么办？
> 我：Lua 原子迁移脚本，从其他桶搬。搬的时候限流，避免连锁搬空。
> 面试官：Redis 挂了？
> 我：Cluster 自动 failover；failover 期间限流降级到 DB；极端关活动。
> 面试官：账户余额也是这套？
> 我：资金账户不能分片，监管要强一致。营销账户可以，子账户分片 + 10s 汇总。两套并行。

## 八、常见考点

1. **为什么不能业务事务里同步扣 Redis + DB** —— DB 行锁热点未解决
2. **Redis Lua 原子性原理** —— 单线程模型
3. **分桶 + 桶间迁移** —— 秒杀标配
4. **异步落库 + 幂等** —— at-least-once 必考
5. **子账户分片 + 汇总** —— 账户热点方案
6. **强一致 vs 最终一致选型** —— 资金强一致，营销最终一致
7. **降级三道防线** —— Cluster、DB 限流、关活动
8. **DB 行锁优化** —— 乐观锁减少等待，但本质串行

## 结构化回答




**30 秒电梯演讲：** 热点问题本质是"多事务争抢同一资源"，解法就两条路——把一个热点拆成 N 个冷点（分桶拆锁），或把争抢从 DB 上移到 Redis 单线程模型（提速 μs 级）。JD 茅台秒杀单 SKU 扛 800 万 QPS 靠的就是"Redis Lua 原子扣减 + 100 桶分桶 + MQ 异步落库"这套组合拳。

**展开框架：**
1. **Redis Lua 原子扣减** — 单线程模型保证"读-判-改-返"四步原子，单实例 8-10 万 QPS；扣减成功后 MQ 异步落 DB，DB 侧用 deduct_id 幂等，避免 DB 行锁热点
2. **库存分桶拆锁** — 把 1 把锁拆成 N 把锁（100 桶），用户 hash 路由到固定桶，并行度提升 N 倍；桶空时用 Lua 原子脚本做桶间迁移，单 SKU 从 8 万 QPS 提升到 800 万 QPS
3. **账户分片汇总 + 降级兜底** — 资金账户走 DB 行锁强一致（监管要求），营销账户用子账户分片 + 定时汇总；Redis 故障三级降级：Cluster failover → DB 限流 → 关闭秒杀活动

**收尾：** 选型一句话——强一致选 DB（资金核心），最终一致选 Redis（营销/秒杀库存），您想深入哪一段？





## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：热点账户与热点库存的串行化设计 | "这题一句话：京东 618 大促，茅台秒杀单 SKU 10 万人同时抢 1000 件。" | 开场钩子 |
| 0:15 | 为什么不能业务事务里同步扣示意/对比图 | "为什么不能业务事务里同步扣 Redis + DB —— DB 行锁热点未解决" | 为什么不能业务事务里同步扣要点 |
| 0:40 | Redis Lua 原子性原理示意/对比图 | "Redis Lua 原子性原理 —— 单线程模型" | Redis Lua 原子性原理要点 |
| 1:25 | 总结卡 | "记住：为什么不能业务事务里同步扣。下期见。" | 收尾 |
