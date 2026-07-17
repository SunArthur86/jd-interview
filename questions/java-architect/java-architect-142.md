---
id: java-architect-142
difficulty: L2
category: java-architect
subcategory: 缓存
title: Binlog 订阅与缓存一致性治理
tags: [Binlog, Canal, Debezium, 缓存一致性, 延迟双删]
related: [java-architect-141, java-architect-026, java-architect-134]
---

# Binlog 订阅与缓存一致性治理

> **场景**：京东商品详情页 QPS 百万级，Redis 缓存命中率必须 > 99%。但商品库 5 万商家随时改价、改库存，缓存不一致会引发超卖或价错投诉。面试官问：缓存一致性怎么保证？为什么不用延迟双删？

## 一、概念层：一致性问题的本质

### 1.1 两种经典的"错"

```
# 错误1：先删缓存后更新DB（并发读回写脏数据）
T1 删 Redis ──→ T2 读 DB(旧) ──→ T2 写 Redis(旧) ──→ T1 更新 DB(新)
结果：缓存是旧值，DB 是新值，永久不一致

# 错误2：先更新DB后删缓存（删缓存失败/延迟）
T1 更新 DB ──→ T1 删 Redis(失败) ──→ 缓存仍是旧值
```

### 1.2 延迟双删为什么不可靠

```java
// 业界广泛流传但坑很深的方案
updateDB(key, value);
deleteCache(key);
Thread.sleep(1000);       // 等并发读完成
deleteCache(key);         // 再删一次
```

问题：
- `sleep` 多久？无法预估，300ms 还是 5s？强依赖业务 RT
- 持有线程 1s，吞吐骤降
- 第二次删失败仍不一致
- 高并发下仍存在读旧值窗口

### 1.3 Binlog 订阅：根治方案

**核心思想**：业务只管写 DB，由独立的 CDC 进程订阅 binlog 异步删缓存。删缓存动作脱离业务事务，可重试、可监控、不阻塞业务。

```
App ─update─→ MySQL ──binlog──→ Canal/Debezium ──→ 删 Redis
                   │                                     ↓ 重试失败队列
                   └── 业务事务立即返回                  ↑ 兜底定时对账
```

## 二、机制层：Binlog → 缓存删除的工作流

### 2.1 Canal 订阅 binlog（轻量方案）

```properties
# canal-instance.properties
canal.instance.master.address=127.0.0.1:3306
canal.instance.dbUsername=canal
canal.instance.filter.regex=trade_product\\.t_sku
canal.instance.tsdb.enable=true                  # 表结构时序存储
canal.instance.network.soTimeout=30000
canal.mq.topic=canal.product.sku
canal.mq.partition=0
canal.mq.partitionHash=.*\\:.*                   # 按主键 hash 分区保证顺序
```

Canal 工作原理：伪装成 MySQL slave → 收到 binlog event → 解析 ROW 模式 → 投递到 Kafka / 直接客户端消费。

### 2.2 Java 客户端消费 Canal 消息删缓存

```java
@Component
@RequiredArgsConstructor
@Slf4j
public class BinlogCacheInvalidator {
    private final StringRedisTemplate redis;
    private final RocketMQTemplate mq;            // 失败重试队列
    private final ConsistencyMonitor monitor;     // 监控埋点

    @KafkaListener(topics = "canal.product.sku", groupId = "cache-invalidator")
    public void onBinlog(String message, Acknowledgment ack) {
        CanalMessage msg = JSON.parseObject(message, CanalMessage.class);
        if (!"t_sku".equals(msg.getTable())) { ack.acknowledge(); return; }

        for (Map<String, String> row : msg.getData()) {
            String skuId = row.get("sku_id");
            String cacheKey = "sku:detail:" + skuId;
            try {
                redis.delete(cacheKey);
                redis.delete("sku:price:" + skuId);    // 多级缓存
                redis.delete("sku:stock:" + skuId);
                monitor.recordInvalidate(skuId, "OK");
            } catch (Exception e) {
                // 失败投递到重试队列，最大重试 5 次后写 DLQ
                mq.syncSend("cache-invalidate-retry", 
                    new RetryTask(cacheKey, System.currentTimeMillis(), 0));
                monitor.recordInvalidate(skuId, "FAIL:" + e.getMessage());
            }
        }
        ack.acknowledge();
    }
}
```

### 2.3 失败重试与兜底对账

```java
@RocketMQMessageListener(topic = "cache-invalidate-retry", 
                         consumerGroup = "retry-group")
public class RetryListener implements RocketMQListener<RetryTask> {
    @Override
    public void onMessage(RetryTask task) {
        if (task.getRetryCount() >= 5) {
            // 写死信表，由对账任务扫描
            dlqRepository.save(task);
            return;
        }
        try { redis.delete(task.getKey()); }
        catch (Exception e) {
            task.incrRetry();
            task.nextDelay();   // 指数退避：1s, 2s, 4s, 8s, 16s
            mq.asyncSend("cache-invalidate-retry", task, task.delayLevel());
        }
    }
}

// 定时对账（每 5 分钟抽样 1000 个热 key）
@Scheduled(fixedDelay = 300_000)
public void reconcile() {
    List<String> hotKeys = hotKeyDetector.sample(1000);
    for (String key : hotKeys) {
        String skuId = extractSkuId(key);
        String cached = redis.opsForValue().get(key);
        Product db = productMapper.selectById(skuId);
        if (cached != null && !match(cached, db)) {
            redis.delete(key);   // 修复
            monitor.recordInconsistency(skuId);
        }
    }
}
```

## 三、实战层：JD 商品详情页的实战演进

### 3.1 演进路径

| 阶段 | 方案 | 痛点 |
|------|------|------|
| V1 | 业务双写（写DB后删Redis） | 删Redis失败导致脏读，对账每天 100+ 单投诉 |
| V2 | 延迟双删 | sleep 1s 拖垮商品页 RT，仍有 0.1% 不一致 |
| V3 | **Binlog 订阅删缓存** | 一致性 99.99%+，但延迟 100-300ms |
| V4 | V3 + 本地缓存兜底 | 强一致读走 DB，缓存只用于读多写少 |

### 3.2 多级缓存与删除顺序

JD 商品详情页四级缓存：本地 Caffeine → Redis Cluster → ES → MySQL。

Binlog 删除必须**按依赖顺序逆向上删**：

```java
public void invalidateChain(String skuId) {
    // 1. 先删 Redis（用户主读路径）
    redis.delete("sku:detail:" + skuId);
    redis.delete("sku:price:" + skuId);
    // 2. 广播删本地缓存（所有实例）
    mq.broadcast("local-cache-evict", skuId);
    // 3. ES 由独立 CDC 流同步（不需手动删）
}
```

本地缓存删除用 **MQ 广播模式**（Redis Pub/Sub 或 RocketMQ BROADCASTING）保证所有实例都收到。

### 3.3 强一致读路径（容许 1-2 处不一致场景）

```java
// 下单扣减库存这类强一致读，绕过缓存直接查 DB
@Transactional
public OrderResult createOrder(Long skuId, int qty) {
    // SELECT ... FOR UPDATE 行锁，绕开缓存
    int stock = skuMapper.selectStockForUpdate(skuId);
    if (stock < qty) throw new BizException("STOCK_INSUFFICIENT");
    skuMapper.deductStock(skuId, qty);
    // 业务事务提交后，binlog 触发缓存删除
    return buildOrder(skuId, qty);
}
```

### 3.4 监控指标

| 指标 | 阈值 | 处置 |
|------|------|------|
| binlog → 缓存删除延迟 P99 | < 500ms | 超过扩容 consumer |
| 删除失败率 | < 0.01% | 触发重试 + 告警 |
| 对账不一致数 | < 10/小时 | 告警 + 人工分析 |
| 缓存命中率 | > 99% | 低则排查过期策略 |

## 四、底层本质：CAP 与最终一致

### 4.1 First Principle：缓存一致性不可能在业务事务内 100% 解决

DB 和 Redis 是两个独立存储，**业务事务无法跨存储**（除非用 2PC/Seata，但代价巨大）。所以任何在业务代码内"先 DB 后缓存"或反之，都有微小不一致窗口。

Binlog 订阅把"删缓存"变成一个**可重试、可监控、可对账的独立子系统**，把"必然存在的不一致窗口"压到 100-500ms，并通过重试 + 对账保证最终一致。

### 4.2 为什么是"删"而不是"更新"缓存

- **删**（lazy load）：下次读时回源 DB 并回填，并发安全
- **更新**（write-through）：binlog 推送的值可能与 DB 二次写并发，导致旧值覆盖新值

经典坑：A 写 v1 → binlog 推 v1 → B 写 v2 → A 收到 binlog 把缓存刷成 v1（晚到）→ 缓存是 v1 而 DB 是 v2。

所以 **删 > 更新**，是缓存一致性的第一铁律。

### 4.3 Feynman 解释

把缓存想象成"公告栏"，DB 是"原始档案"。
- 双写：每次改档案还要撕掉公告栏的旧通知，手忙脚乱还会撕错。
- Binlog 订阅：派一个"档案变更监听员"，每次档案改了他就负责撕公告栏。监听员是单独的人，撕错了可以重撕，不影响档案管理员工作。

## 五、AI 架构师加问

**Q1：Binlog 订阅删缓存有 100ms 延迟，这期间读到的是旧值，怎么办？**
方案：
- 业务上容忍（如商品详情页价签容忍 100ms 漂移）
- 强一致路径绕过缓存（如结算页价格实时查 DB）
- 用 Redis 5.0+ 的 `WAIT numreplicas timeout` 强同步（牺牲性能）

**Q2：删 Redis 失败，binlog 已经 ack 了，怎么补救？**
重试队列 + 死信表 + 定时对账三件套。死信表里的 key 由对账任务定期扫描重删。

**Q3：缓存删除和 binlog 顺序一致吗？**
单分区内有序（Canal 按主键 hash 分区），所以同一 skuId 的多次变更按 DB 提交顺序到达消费者。但**跨分区的不同 skuId 不保证全局顺序**，业务无影响。

**Q4：Canal 和 Debezium 在缓存一致性场景怎么选？**
- Canal：阿里系，仅 MySQL，部署简单，JD 内有运维积累 → 商品、订单场景
- Debezium：多 DB，Schema Registry 强，适合数据中台 → 数仓、ES 同步
- 同一公司可并存，按业务线选

**Q5：Redis Cluster 大批量删 key（如批量改价）会导致热点吗？**
会。解决方案：
- 用 `UNLINK`（异步删除）替代 `DEL`
- 用 `SCAN + DEL` 分批避免阻塞
- 大 key（如 Hash 10w 字段）用 `HSCAN + HDEL`

## 六、记忆口诀

```
缓存一致性，业务内难解；binlog 订阅，根治脏读劫。
Canal/Debezium，订阅 ROW 日志；删而非更新，并发最安全。
失败有重试，死信加对账；强一致绕缓存，下单直接 DB 查。
延迟 100-500ms，业务可容忍；JD 商品百万 QPS，四架马车保命中率。
```

## 七、苏格拉底追问

| 层级 | 问题 | 关键答案 |
|------|------|----------|
| L1 表象 | 为什么不直接业务双写？ | 删缓存可能失败，业务事务无法回滚外部存储 |
| L2 机制 | Canal 如何订阅 binlog？ | 伪装成 MySQL slave，收 binlog event，解析 ROW 模式 |
| L3 边界 | binlog 延迟 100ms，期间读到旧值算 bug 吗？ | 业务定义：商品详情页可容忍，结算页不可容忍（绕 DB） |
| L4 权衡 | Cache Aside vs Write Through？ | Cache Aside（删缓存）并发安全；Write Through 易出现旧值覆盖新值 |
| L5 反例 | Redis 删了但读 DB 时 DB 主从切换读到旧值？ | 强一致读走主库，或用 `WAIT numreplicas` 同步复制 |
| L6 极限 | 全表批量更新（10w SKU），binlog 风暴怎么办？ | 限流消费 + 分批删 + 业务侧提前预热避免雪崩 |
| L7 系统 | 多机房缓存一致性？ | 同城双写 binlog 互订阅，或基于 OTTER 跨机房同步 |

**对话还原**：
> 面试官：你们商品缓存一致性怎么做？
> 我：早期延迟双删，问题多。现在用 Canal 订阅 binlog 删 Redis，延迟 200ms P99。失败走 RocketMQ 重试队列，5 次后写死信表，对账任务每 5 分钟抽样热 key 修复。
> 面试官：延迟双删为什么不行？
> 我：sleep 时间无法预估，持有线程吞吐骤降，且第二次删失败仍不一致。本质问题是"在业务事务里做缓存管理"是反模式。
> 面试官：为什么删而不是更新？
> 我：删是 lazy load，下次读回源；更新会与并发写冲突，导致旧值覆盖新值。这是经典反模式。
> 面试官：如何监控一致性？
> 我：三个指标——binlog 删除延迟 P99、删除失败率、对账不一致数。前两个实时告警，第三个每 5 分钟抽样。

## 八、常见考点

1. **先 DB 后删 vs 先删后 DB**：前者更安全（删缓存失败可重试，业务可双删兜底）
2. **延迟双删的缺陷**：sleep 不可控、吞吐骤降、二次删失败仍不一致 —— 高频考点
3. **删 vs 更新缓存**：删并发安全，更新会脏写 —— 几乎必考
4. **Canal 工作原理**：伪装 slave、订阅 binlog、解析 ROW —— 必考
5. **失败兜底三件套**：重试队列 + 死信表 + 定时对账
6. **强一致读绕过缓存**：下单/支付场景直接查 DB（行锁）
7. **跨机房一致性**：OTTER / 同城 binlog 双向同步
8. **大 key 删除**：UNLINK、HSCAN+HDEL，避免阻塞 Redis 主线程

## 结构化回答

**30 秒电梯演讲：** 京东商品详情页 QPS 百万级，Redis 缓存命中率必须 > 99%。但商品库 5 万商家随时改价、改库存，缓存不一致会引发超卖或价错投诉

**展开框架：**
1. **先 DB 后删 vs 先删后 DB** — 前者更安全（删缓存失败可重试，业务可双删兜底）
2. **延迟双删的缺陷** — sleep 不可控、吞吐骤降、二次删失败仍不一致 —— 高频考点
3. **删 vs 更新缓存** — 删并发安全，更新会脏写 —— 几乎必考

**收尾：** 以上是我的整体思路。您想继续深入聊——为什么不直接业务双写？


## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：Binlog 订阅与缓存一致性治理 | "这题一句话：京东商品详情页 QPS 百万级，Redis 缓存命中率必须 > 99%。" | 开场钩子 |
| 0:15 | 先 DB 后删 vs 先删后示意/对比图 | "前者更安全（删缓存失败可重试，业务可双删兜底）" | 先 DB 后删 vs 先删后要点 |
| 0:40 | 延迟双删的缺陷示意/对比图 | "sleep 不可控、吞吐骤降、二次删失败仍不一致 —— 高频考点" | 延迟双删的缺陷要点 |
| 1:25 | 总结卡 | "记住：先 DB 后删 vs 先删后。下期见。" | 收尾 |
