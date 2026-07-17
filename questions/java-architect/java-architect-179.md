---
id: java-architect-179
difficulty: L2
category: java-architect
subcategory: 定时任务
tags:
- Java 架构师
- 定时任务
- 分片广播
- 抢占锁
- XXL-Job
feynman:
  essence: 大规模定时任务的核心是"分片广播 + 抢占锁"。分片广播（XXL-Job ShardingBroadcast）把任务按 shardingItem 切分到多节点并行执行。抢占锁（Redis 分布式锁）保证同一分片只有一个节点执行，防止重复。
  analogy: 像快递分拣——10000 个包裹分给 10 个工人（分片广播，每人处理 shardingItem % 10 == 自己编号的包裹）。每个包裹只有一个人抢到（分布式锁防重复处理）。
  first_principle: 单机定时任务扛不住亿级数据扫描。必须分片——N 个节点并行，每个处理 1/N。但分片要保证不重复不遗漏（每条数据恰好一个节点处理）。抢占锁防节点故障时其他节点接管（failover）。
  key_points:
  - 分片广播：XXL-Job ShardingBroadcast，shardingItem = hash(数据) % 节点数
  - 抢占锁：Redis 分布式锁（SET NX EX），保证分片原子执行
  - 幂等：任务幂等键（jobId + shardingItem + 批次），防重复执行
  - 失败转移：节点宕机，分片被其他节点抢占接管
  - 流量削峰：大任务分批执行（每批 1000 条），避免 DB 瞬时压力
first_principle:
  problem: 亿级数据的定时任务（如订单超时关闭、积分结算）怎么并行执行不重复不遗漏，还能扛节点故障？
  axioms:
  - 单机扫亿级数据耗时数小时，必须分片并行
  - 多节点并行要保证每条数据恰好处理一次（不重复不遗漏）
  - 节点可能宕机，分片要能被其他节点接管
  - 大任务瞬时打爆 DB，要分批削峰
  rebuild: XXL-Job 分片广播——调度中心下发分片数 N，每个执行器拿到自己的 shardingItem（0 到 N-1），处理 hash(数据 key) % N == shardingItem 的数据。抢占锁（SETNX lock:job:{jobId}:{shardingItem}）保证原子。大任务分批（每批 1000 条 + sleep 100ms 削峰）。幂等键防重复执行。节点宕机锁过期，其他节点抢占接管。
follow_up:
  - 分片策略怎么选？——按数据 hash 分片（均匀）或按业务维度（如按 userId 尾号）。XXL-Job ShardingBroadcast 自动下发分片总数和当前分片号。
  - 怎么保证不重复？——抢占锁 SETNX lock:job:{jobId}:{shardingItem} requestId（UUID）EX 3600。先抢锁再执行，业务层幂等（唯一键约束）兜底。
  - 节点宕机怎么办？——锁有过期时间（1 小时），节点宕机锁自动释放。其他节点下次调度时抢占接管。监控 job_failover_count。
  - 大任务怎么削峰？——分批处理。每批 1000 条，批间 sleep 100ms。或按时间窗口限流（每秒最多 10000 条）。避免 DB 瞬时 QPS 爆。
  - 任务失败怎么重试？——XXL-Job 配置重试次数（3 次）。失败告警（钉钉/邮件）。业务幂等保证重试安全。
memory_points:
  - 分片广播：XXL-Job ShardingBroadcast，shardingItem = hash(key) % N
  - 抢占锁：SETNX lock:job:{jobId}:{shard} requestId EX 3600
  - 幂等键：jobId + shardingItem + 批次号
  - 失败转移：锁过期自动释放，其他节点抢占
  - 流量削峰：分批 1000 条 + sleep 100ms
---

# 【Java 后端架构师】大规模定时任务分片与抢占

> 适用场景：JD 定时任务（订单超时关闭/积分结算/库存对账/优惠券过期）。亿级数据扫描，单机扛不住，必须分片并行。架构师要设计的是"分片广播 + 抢占锁 + 失败转移"的任务调度系统。

## 一、概念层：分片广播架构

```
调度中心（XXL-Job Admin）
    ↓ 下发任务 + 分片总数 N
执行器集群（N 个节点）
    ↓ 每个节点拿到 shardingItem（0 到 N-1）
    ↓ 抢占锁（SETNX）
    ↓ 处理 hash(数据 key) % N == shardingItem 的数据
    ↓ 分批处理（1000 条/批 + sleep）
节点宕机 → 锁过期 → 其他节点抢占接管
```

## 二、机制层：XXL-Job 分片广播

```java
/**
 * 分片广播任务：订单超时关闭
 * 亿级订单分片到多节点并行处理
 */
@Component
@Slf4j
public class OrderTimeoutJob {

    @XxlJob("orderTimeoutHandler")
    public void execute() {
        // 1. 获取分片信息（XXL-Job 下发）
        int shardIndex = XxlJobHelper.getShardIndex();    // 当前分片号 0~N-1
        int shardTotal = XxlJobHelper.getShardTotal();    // 分片总数 N

        log.info("订单超时任务执行: shard={}/{}", shardIndex, shardTotal);

        // 2. 抢占锁（防其他节点重复执行同一分片，做 failover 时关键）
        String lockKey = "lock:job:orderTimeout:" + shardIndex;
        String requestId = UUID.randomUUID().toString();
        Boolean locked = redis.opsForValue().setIfAbsent(lockKey,
            requestId, Duration.ofHours(1));
        if (!Boolean.TRUE.equals(locked)) {
            log.info("分片 {} 已被其他节点占用，跳过", shardIndex);
            return;
        }

        try {
            // 3. 分片处理：查 shardingItem == hash(orderId) % N 的订单
            processShard(shardIndex, shardTotal);
        } finally {
            // 4. 释放锁（Lua 保证原子）
            releaseLock(lockKey, requestId);
        }
    }

    /**
     * 分片处理：分批扫描 + 流量削峰
     */
    private void processShard(int shardIndex, int shardTotal) {
        int batchSize = 1000;
        long lastId = 0;

        while (true) {
            // 查未处理数据：hash(orderId) % shardTotal == shardIndex
            // 实现：用 orderId % shardTotal（数值型直接 mod）
            List<Order> orders = orderRepo.findTimeoutOrders(
                shardIndex, shardTotal, lastId, batchSize);

            if (orders.isEmpty()) break;

            for (Order order : orders) {
                try {
                    closeOrder(order);
                } catch (Exception e) {
                    log.error("关闭订单失败: orderId={}", order.getId(), e);
                    // 不中断，继续处理下一条
                }
                lastId = order.getId();
            }

            // 流量削峰：批间 sleep
            sleep(100);

            // 上报进度
            XxlJobHelper.log("已处理 {} 条", lastId);
        }

        metrics.gauge("job.orderTimeout.shard." + shardIndex,
            lastId);
    }

    /**
     * 关闭订单（幂等）
     */
    private void closeOrder(Order order) {
        // 幂等检查：只处理待支付状态
        if (order.getStatus() != OrderStatus.PENDING) return;

        // UPDATE WHERE status=PENDING（乐观锁，CAS）
        int updated = orderRepo.updateStatus(order.getId(),
            OrderStatus.PENDING, OrderStatus.CLOSED);
        if (updated > 0) {
            // 回滚库存、释放优惠券
            inventoryService.rollback(order.getId());
            couponService.release(order.getId());
        }
    }
}
```

## 三、机制层：SQL 分片查询

```sql
-- 分片查询：hash(orderId) % N == shardIndex
-- MySQL 用 mod 函数，或应用层 filter

-- 方案1：SQL mod（简单，但 mod 计算可能不走索引）
SELECT * FROM orders
WHERE status = 'PENDING'
  AND timeout_time < NOW()
  AND MOD(id, #{shardTotal}) = #{shardIndex}
  AND id > #{lastId}
ORDER BY id
LIMIT #{batchSize};

-- 方案2：分桶字段（预先存 shard_bucket 列，建联合索引）
-- 建表时加 shard_bucket 列（= id % 100），建索引 (shard_bucket, status, id)
SELECT * FROM orders
WHERE shard_bucket = #{shardIndex}
  AND status = 'PENDING'
  AND timeout_time < NOW()
  AND id > #{lastId}
ORDER BY id
LIMIT #{batchSize};
-- shard_bucket 字段走索引，查询高效
```

## 四、机制层：抢占锁与失败转移

```java
/**
 * 抢占锁：保证分片原子执行 + 失败转移
 */
@Component
@Slf4j
public class JobLockService {

    private final RedisTemplate<String, String> redis;
    private final ScheduledExecutorService watchdog;

    /**
     * 抢占锁 + 看门狗续期（防任务执行超过锁过期时间）
     */
    public boolean tryLock(String lockKey, String requestId,
                           Duration expireTime, Runnable task) {
        // 1. SETNX 抢锁
        Boolean locked = redis.opsForValue().setIfAbsent(lockKey,
            requestId, expireTime);
        if (!Boolean.TRUE.equals(locked)) return false;

        // 2. 看门狗：定时续期（防业务执行超过过期时间）
        ScheduledFuture<?> renewer = watchdog.scheduleAtFixedRate(() -> {
            // Lua：仅当 requestId 匹配时续期
            String lua = "if redis.call('get',KEYS[1])==ARGV[1] "
                + "then return redis.call('expire',KEYS[1],ARGV[2]) "
                + "else return 0 end";
            redis.execute(new DefaultRedisScript<>(lua, Long.class),
                Collections.singletonList(lockKey),
                requestId, String.valueOf(expireTime.getSeconds()));
        }, expireTime.toMillis() / 3, expireTime.toMillis() / 3,
            TimeUnit.MILLISECONDS);

        try {
            task.run();
        } finally {
            renewer.cancel(false);
            releaseLock(lockKey, requestId);
        }
        return true;
    }

    /**
     * 释放锁（Lua 保证原子：只有持有者能释放）
     */
    private void releaseLock(String lockKey, String requestId) {
        String lua = "if redis.call('get',KEYS[1])==ARGV[1] "
            + "then return redis.call('del',KEYS[1]) "
            + "else return 0 end";
        redis.execute(new DefaultRedisScript<>(lua, Long.class),
            Collections.singletonList(lockKey), requestId);
    }
}
```

## 五、机制层：幂等控制

```java
/**
 * 幂等：防止任务重复执行造成副作用
 */
@Component
public class JobIdempotentService {

    /**
     * 幂等键：jobId + shardingItem + 批次
     * 记录已执行的批次，重试时跳过
     */
    public boolean isProcessed(String jobId, int shardIndex,
                                long batchId) {
        String key = "job:idempotent:" + jobId + ":" + shardIndex;
        // 用 Set 记录已处理批次
        return redis.opsForSet().isMember(key, String.valueOf(batchId));
    }

    public void markProcessed(String jobId, int shardIndex, long batchId) {
        String key = "job:idempotent:" + jobId + ":" + shardIndex;
        redis.opsForSet().add(key, String.valueOf(batchId));
        redis.expire(key, Duration.ofDays(7));     // 7 天过期
    }
}
```

## 六、底层本质：分片与抢占的本质

**分片的本质**：把大任务切分成 N 个小任务并行执行。关键是怎么切——按 hash(数据 key) % N 切分，保证每条数据恰好被一个分片处理（不重复不遗漏）。hash 要均匀（否则数据倾斜，某分片过载）。数值型 ID 直接 mod（简单），字符串型用 MurmurHash。

**抢占锁的本质**：多节点并行时，同一分片可能被多节点竞争（failover 场景）。抢占锁保证只有一个执行——SETNX 抢锁成功的执行，失败的跳过。锁有过期时间（1 小时），节点宕机锁自动释放，下次调度其他节点抢到锁接管。这是**租约（lease）**模式——锁不是永久的，是带 TTL 的租约。

**看门狗续期的本质**：任务执行可能超过锁过期时间（亿级数据扫几小时）。锁过期了但任务没完成，其他节点会抢锁重复执行。看门狗定时续期（每 TTL/3 续一次），保证任务执行期间锁不过期。业务结束才释放。这是 Redisson 的 watchdog 机制。

**流量削峰的本质**：大任务一次性查百万条数据打爆 DB。分批（每批 1000 条 + sleep 100ms）把瞬时 QPS 降到可控（10000 QPS → 1000 QPS）。用 cursor（lastId）翻页避免 offset 深分页性能问题。

**幂等的本质**：任务可能重试（XXL-Job 配置 3 次重试）或 failover 后重复执行。幂等键（jobId + shardingItem + 批次）记录已处理的，重试跳过。业务层也要幂等（UPDATE WHERE status=PENDING 的 CAS）。

## 七、AI 工程化深挖

1. **怎么用 AI 预测任务执行时间？** 历史数据量 + 执行时间训练模型，预测本次任务耗时。超阈值的提前扩容或拆分。监控 prediction_accuracy。

2. **怎么用 AI 智能分片？** 传统 hash 分片可能不均（数据倾斜）。AI 分析数据分布，动态调整分片边界让各分片负载均衡。或按业务维度（如热门商品单独分片）。

3. **怎么用 LLM 生成任务执行报告？** 任务执行后 LLM 总结"本次处理 100 万订单，关闭 5 万，失败 100（原因：库存不足）"。比日志更易读。

4. **怎么用 AI 异常检测任务？** 分析任务执行时长/QPS/失败率，异常检测模型发现"今天任务比平时慢 3 倍"自动告警。LLM 分析根因（"慢查询是因为索引缺失"）。

5. **怎么用 AI 智能调度时间？** 分析任务历史执行时间 + 系统负载，AI 推荐最佳调度时间（避开高峰）。如订单关闭任务推到凌晨 2 点（负载低）。

## 八、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"分片、抢占、幂等、削峰"** 四个词。

- **分片**：XXL-Job ShardingBroadcast，shardIndex = hash(key) % shardTotal
- **抢占**：SETNX lock:job:{jobId}:{shard} requestId EX 3600，看门狗续期
- **幂等**：幂等键（jobId + shard + batch）+ 业务 CAS（UPDATE WHERE status）
- **削峰**：分批 1000 条 + sleep 100ms + cursor 翻页

### 面试现场 60 秒回答

> 大规模定时任务我用 XXL-Job 分片广播 + 抢占锁。调度中心下发分片总数 N，每个执行器拿到自己的 shardIndex（0 到 N-1），处理 hash(orderId) % N == shardIndex 的数据——分片保证每条数据恰好一个节点处理。SQL 用 MOD(id, N) = shardIndex 或预存 shard_bucket 列建索引。抢占锁 SETNX lock:job:{jobId}:{shard} requestId EX 3600——抢锁成功才执行，失败跳过。看门狗定时续期（每 TTL/3 续一次）防任务执行超过锁过期。幂等两层：任务层幂等键（jobId + shard + batch，Redis Set 记录，7 天过期）+ 业务层 CAS（UPDATE WHERE status=PENDING，乐观锁）。失败转移：节点宕机锁过期自动释放，下次调度其他节点抢占接管。流量削峰：分批处理每批 1000 条，批间 sleep 100ms，cursor（lastId）翻页避免 offset 深分页。XXL-Job 配置重试 3 次失败告警。监控 job_duration、job_failover_count、shard_balance。亿级订单超时关闭：10 节点分片，每节点处理 1000 万，约 30 分钟完成。

## 九、苏格拉底追问

| 追问 | 证据/答案 |
|------|-----------|
| 分片为什么用 hash 不用范围？ | hash 均匀分布避免倾斜。范围分片可能导致热点（如最新 ID 都在一个分片）。 |
| 抢占锁为什么用 SETNX 不用 ZK？ | Redis SETNX 性能高（10 万 QPS），ZK 强一致但慢。定时任务容忍极小概率重复（业务幂等兜底）。 |
| 任务执行超过锁过期怎么办？ | 看门狗定时续期（每 TTL/3 续一次），业务结束才释放。类似 Redisson watchdog。 |
| failover 后数据怎么不丢？ | 分片按 hash 切分，节点宕机后该分片未被处理的数据下次调度时被其他节点接管。cursor（lastId）支持断点续传。 |
| 大任务打爆 DB 怎么办？ | 分批 1000 条 + sleep 100ms。cursor 翻页避免 offset 深分页。或读写分离（查从库）。 |

## 十、常见考点

1. **分片怎么实现？**——XXL-Job ShardingBroadcast。shardIndex = XxlJobHelper.getShardIndex()，shardTotal = getShardTotal()。SQL：MOD(id, shardTotal) = shardIndex 或预存 shard_bucket 列。
2. **抢占锁怎么保证不重复？**——SETNX lock:job:{jobId}:{shard} requestId EX 3600。抢锁成功执行失败跳过。看门狗续期防超时。Lua 释放保证只有持有者能释放。
3. **节点宕机怎么办？**——锁有过期时间（1 小时）自动释放。下次调度其他节点抢占接管。这是租约（lease）模式。
4. **幂等怎么做？**——两层：任务层幂等键（jobId + shard + batch，Redis Set）+ 业务层 CAS（UPDATE WHERE status=PENDING）。重试安全。
5. **大任务怎么削峰？**——分批 1000 条 + sleep 100ms。cursor（lastId）翻页避免 offset 深分页性能问题。或读写分离查从库。

## 结构化回答

**30 秒电梯演讲：** 大规模定时任务的核心是分片广播 + 抢占锁。分片广播（XXL-Job ShardingBroadcast）把任务按 shardingItem 切分到多节点并行执行。抢占锁（Redis 分布式锁）保证同一分片只有一个节点执行，防止重复

**展开框架：**
1. **分片广播** — XXL-Job ShardingBroadcast，shardingItem = hash(数据) % 节点数
2. **抢占锁** — Redis 分布式锁（SET NX EX），保证分片原子执行
3. **幂等** — 任务幂等键（jobId + shardingItem + 批次），防重复执行

**收尾：** 以上是我的整体思路。您想继续深入聊——分片策略怎么选？


## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：大规模定时任务分片与抢占 | "这题一句话：大规模定时任务的核心是分片广播 + 抢占锁。" | 开场钩子 |
| 0:15 | 分片广播示意/对比图 | "XXL-Job ShardingBroadcast，shardingItem = hash(数据) % 节点数" | 分片广播要点 |
| 0:40 | 抢占锁示意/对比图 | "Redis 分布式锁（SET NX EX），保证分片原子执行" | 抢占锁要点 |
| 1:25 | 总结卡 | "记住：分片广播。下期见。" | 收尾 |
