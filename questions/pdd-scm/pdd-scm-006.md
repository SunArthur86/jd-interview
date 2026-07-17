---
id: pdd-scm-006
difficulty: L3
category: pdd-scm
subcategory: Redis
tags:
- 拼多多
- 供应链
- Redis
- 缓存
- 缓存一致性
feynman:
  essence: Redis 缓存加速靠"内存读取 + 多级缓存"，一致性靠"Cache Aside（先改 DB 再删缓存）+ 延迟双删 + Canal 订阅 binlog 异步刷新"，解决穿透/击穿/雪崩三大问题。
  analogy: 缓存像仓库的"前台样品柜"——常买的商品放前台（Redis），客户取货快；某样品卖了要及时更新（一致性）；大家同时抢同一个样品要排队（击穿）。
  first_principle: 数据库慢（毫秒级），内存快（纳秒级）；把热数据放内存减少 DB 访问，但引入"数据可能过期"的一致性问题。
  key_points:
  - 多级缓存：Caffeine（本地）→ Redis（分布式）→ MySQL
  - 一致性：Cache Aside（先 DB 后删缓存）+ 延迟双删
  - 三大问题：穿透（布隆过滤）、击穿（互斥锁）、雪崩（TTL 抖动）
  - Canal 订阅 binlog 异步刷缓存
first_principle:
  problem: 高并发下如何让读快（缓存）且和 DB 一致？
  axioms:
  - 缓存命中 > 95% 时 DB 压力小
  - 缓存和 DB 不可能强一致（有更新窗口）
  - 业务通常容忍秒级最终一致
  rebuild: 多级缓存（命中率 95%）+ Cache Aside（先 DB 后删缓存）+ 延迟双删兜底 + Canal 订阅 binlog 最终一致。
follow_up:
- 为什么是删缓存不是更新缓存？——更新缓存有并发覆盖问题；删除是懒加载，下次读再加载
- 延迟双删怎么做？——先删缓存→改 DB→延迟 500ms 再删一次（防读旧值回填）
- Canal 刷缓存的优势？——业务代码无感知，binlog 可靠
memory_points:
- Cache Aside：先改 DB，再删缓存（不是更新）
- 穿透=查不存在（布隆过滤）；击穿=热 key 失效（互斥锁）；雪崩=大量失效（TTL 抖动）
- 多级缓存：Caffeine → Redis → MySQL，命中率 95%+
---

# 【拼多多供应链】Redis 缓存怎么保证和 DB 一致？三大缓存问题怎么解？

> JD 依据："熟悉缓存技术"。供应链的商品详情、库存查询都强依赖缓存。

## 一、多级缓存

```
请求 → Caffeine（本地，纳秒，命中率 50%）→ Redis（分布式，毫秒，命中率 95%）→ MySQL（毫秒-十毫秒）
```

```java
public Product getProduct(long id) {
    Product p = caffeine.getIfPresent(id);      // L1 本地
    if (p != null) return p;
    p = redis.get("product:" + id);              // L2 分布式
    if (p != null) { caffeine.put(id, p); return p; }
    p = mysql.findById(id);                      // L3 DB
    redis.set("product:" + id, p, TTL + random(60));
    caffeine.put(id, p);
    return p;
}
```

## 二、缓存一致性策略

**Cache Aside（最常用）**：先改 DB，再删缓存。
```java
@Transactional
public void updateProduct(Product p) {
    productDao.update(p);
    redis.del("product:" + p.getId());  // 删（不是更新）
}
```

**为什么删不更新**：
- 更新有并发覆盖问题（A 先算出新值，B 改了 DB，A 覆盖回旧值）
- 删除是懒加载，下次读自动加载最新

**延迟双删**（防读旧值回填）：
```java
redis.del(key);          // 先删
db.update(p);
sleep(500);              // 等读旧值的请求完成
redis.del(key);          // 再删一次
```

**Canal 订阅 binlog**（最终一致，业务无感）：
```
MySQL binlog → Canal（伪装从库）→ Kafka → 消费删 Redis
```

## 三、缓存三大问题

| 问题 | 原因 | 解法 |
|------|------|------|
| **穿透** | 查不存在的 key，每次打 DB | 空值缓存 + 布隆过滤器 |
| **击穿** | 热 key 失效瞬间，大量请求打 DB | 互斥锁（只让一个查 DB）+ 永不过期 |
| **雪崩** | 大量 key 同时失效 | TTL 加随机抖动 + 多级缓存 |

**穿透的布隆过滤器**：
```java
BloomFilter<Long> filter = BloomFilter.create(Funnels.longFunnel(), 10_000_000);
if (!filter.mightContain(id)) return null;  // 一定不存在
```

**击穿的互斥锁**：
```java
Product p = redis.get(key);
if (p == null) {
    if (redis.setnx("lock:" + key, "1", 3, SECONDS)) {  // 抢锁
        try { p = mysql.findById(id); redis.set(key, p); }
        finally { redis.del("lock:" + key); }
    } else {
        Thread.sleep(50); return getProduct(id);  // 重试
    }
}
```

## 四、供应链缓存实战

**商品详情**：Caffeine（5min）+ Redis（30min）+ MySQL，命中率 98%。
**库存**：Redis 实时扣减 + 异步同步 DB（见库存扣减题）。
**类目树**：Redis 全量缓存（改动少），变更时 binlog 触发刷新。

## 五、底层本质

缓存本质是**"用空间换时间，用最终一致换性能"**。多级缓存是分层的空间换时间；Cache Aside 是接受秒级不一致换高并发。

## 常见考点
1. **缓存和 DB 谁先操作**？——Cache Aside 先 DB 后删缓存（先删缓存再 DB 会短暂不一致）。
2. **分布式缓存和本地缓存怎么协同**？——本地缓存 TTL 短（分钟级），Redis 长（小时级）；本地缓存适合读多写少且接受短暂不一致。
3. **布隆过滤器能删除吗**？——标准布隆不能（计数布隆可以但更复杂）。

## 苏格拉底式面试追问

> 这组追问不是背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：供应链商品详情用了 Caffeine + Redis 双层缓存，但库存数据你却只放 Redis 不放 Caffeine。为什么不也给库存加本地缓存？**

因为库存是"写多 + 强一致"场景，本地缓存会放大不一致。商品详情是"读多写少 + 容忍秒级不一致"，Caffeine 缓存 5 分钟没问题。但库存每次下单都要扣减，如果放 Caffeine：
1. **多实例不一致**——4 台机器各自的 Caffeine 库存值不同步，A 扣了 B 不知道，超卖。
2. **失效不及时**——Caffeine 通知其他实例失效要靠消息广播（如 Redis Pub/Sub），延迟 + 复杂度高，不如直接走 Redis 单点。
所以库存只在 Redis（单点权威源），Caffeine 只缓存"读多写少"的商品/类目信息。

### 第二层：证据与定位

**Q：用户反馈刚改了商品价格，但 APP 上还是旧价格（缓存没更新）。你怎么确认是 Cache Aside 没生效还是 binlog 同步延迟？**

三步排查：
1. **看 DB**——`SELECT price FROM product WHERE id=1001`，确认 DB 已是新价格（改成功了）。
2. **看 Redis**——`GET product:1001`，如果还是旧值，说明缓存删失败或没删。看应用日志搜 `DEL product:1001`，确认删除动作是否执行 + 返回值。
3. **看 Canal**——如果应用层 Cache Aside 正常，检查 Canal 链路。`Canal` 的 metrics（`canal.instance.transaction.delay`）看延迟，如果 delay > 10s，说明 binlog 消费堆积，binlog→Kafka→消费删缓存的链路滞后。
4. **看 Caffeine**——APP 走的是网关，网关背后是应用实例的 Caffeine。如果 Redis 已更新但 Caffeine 没失效（没收到广播），就是本地缓存的问题，`recordStats()` 看命中率，手动 `invalidateAll()` 验证。

### 第三层：根因深挖

**Q：你确认 Redis 的 DEL 执行成功了（返回 1），但 1 秒后 GET 又返回旧值。根因是什么？**

经典的"缓存读旧值回填"问题，根因是"删缓存 + 改 DB"之间的读请求：
```
时刻 T1: 线程A DEL product:1001        (缓存空)
时刻 T2: 线程B GET product:1001 → miss → 查 DB 拿到旧值 99
时刻 T3: 线程A UPDATE DB SET price=199  (DB 新值)
时刻 T4: 线程B SET product:1001 = 99    (旧值回填到缓存!)
```
线程 B 在 T2 读到了 DB 的旧值（因为线程 A 还没提交），T4 又把这个旧值写回缓存，导致缓存长期是旧值。根因是"先删缓存后改 DB"的窗口期被并发读回填。解法是延迟双删——T1 先删、T3 改 DB、T5（延迟 500ms 后）再删一次，把 B 回填的旧值清掉。

**Q：那为什么不直接用"先改 DB 再删缓存"的顺序，不就没有这个问题了？**

"先 DB 后删缓存"也有并发问题，只是窗口更小：
```
T1: 线程A GET cache → miss → 读 DB 拿旧值 99
T2: 线程B UPDATE DB SET price=199
T3: 线程B DEL cache
T4: 线程A SET cache = 99  (旧值回填!)
```
同样会被线程 A 的延迟写回填。两种顺序都有问题，但"先 DB 后删缓存"的窗口极小（要求线程 A 的读 DB 比 线程 B 的写 DB 更早开始却更晚写缓存，概率极低），所以业界默认用"先 DB 后删缓存 + 延迟双删"兜底。完全杜绝要用版本号（写缓存带 DB 的 `version`，旧版本不允许覆盖新版本）或 TTL（最终过期兜底）。

### 第四层：方案权衡

**Q：热 key（某爆款商品详情）缓存击穿了，你用 setnx 互斥锁重建。但大促时 1000 个请求同时 miss，互斥锁会不会成为瓶颈？**

会。互斥锁的问题是"一个重建，其余 sleep 重试"——999 个请求 sleep 50ms 重试，既浪费线程又叠加延迟。更优方案：
1. **永不过期 + 异步刷新**——热 key 不设 TTL（逻辑过期），后台定时任务主动刷新（如每 5 分钟刷新 top 1000 热点 key），读请求永远命中缓存不 miss。适合商品详情这种"热 key 可枚举"的场景。
2. **分级锁**——不是全局一把锁，而是按 key hash 分 64 把锁，不同 key 各自重建互不阻塞。
3. **预热**——大促前把 top 1 万 SKU 的缓存提前 load 好（`redis-cli --pipe` 批量 SET），击穿从源头避免。

**Q：为什么不用 Redis 的 SETNX 分布式锁（Redlock）来保护缓存重建？**

杀鸡用牛刀。缓存重建只需要"同一进程内串行化重建"（JVM 内的 synchronized 按 key 分段就够），上 Redlock 要 5 次 Redis 节点往返，延迟翻倍。而且 Redlock 解决的是"多实例互斥"，缓存重建这个场景就算多实例各自重建一次（每个 JVM 各查一次 DB），代价是 DB 多扛几次查询，远比 Redlock 的复杂度和延迟代价低。所以缓存击穿用单机互斥锁或"永不过期"就够，不需要分布式锁。

### 第五层：验证与沉淀

**Q：你怎么证明缓存一致性方案真的生效、没有大规模脏数据？**

三个监控指标：
1. **缓存命中率**——Caffeine `cache.hitRate()` + Redis `info stats` 的 `keyspace_hits/(hits+misses)`，正常 > 95%。如果骤降到 80%，说明缓存失效异常或 key 设计有问题。
2. **不一致检测**——定时任务（每 10 分钟）抽样 100 个 key，对比 Redis 值和 DB 值，统计 `inconsistency_count`。如果 > 0，告警人工介入。拼多多就是用这个"对账巡检"发现延迟双删漏配的服务。
3. **Canal 延迟监控**——`canal_instance_delay` 指标，delay > 5s 告警，防止 binlog 积压导致缓存长时间过期。

**Q：怎么让团队写缓存代码时遵循一致性规范而不是各写各的？**

沉淀缓存 SDK + 规范：
1. **缓存注解**——封装 `@CacheAside(key="product:{id}", ttl=1800, doubleDelete=true)`，业务方只加注解，框架自动实现"DB 后删 + 延迟双删 + 互斥重建"，杜绝手写漏环节。
2. **缓存规范文档**——明确"读多写少用 Caffeine+Redis，写多用 Redis-only，强一致用 Redis+DB 同事务（不用缓存）"，按场景给模板代码。
3. **Code Review checklist**——所有 `redis.set/del` 调用必须说明一致性策略，裸写缓存代码 CR 不通过。

## 结构化回答

**30 秒电梯演讲：** 高并发下如何让读快（缓存）且和 DB 一致？简单说就是——Redis 缓存加速靠"内存读取 + 多级缓存"，一致性靠"Cache Aside（先改 DB 再删缓存）+ 延迟双删 + Canal 订阅 binlog 异步刷新"。

**展开框架：**
1. **多级缓存** — 多级缓存：Caffeine（本地）→ Redis（分布式）→ MySQL
2. **一致性** — 一致性：Cache Aside（先 DB 后删缓存）+ 延迟双删
3. **三大问题** — 三大问题：穿透（布隆过滤）、击穿（互斥锁）、雪崩（TTL 抖动）

**收尾：** 您看这块要不要再展开聊聊？

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：Redis 缓存怎么保证和 DB 一致？三大缓存问题怎么解？ | 今天聊「Redis 缓存怎么保证和 DB 一致？三大缓存问题怎么解？」。一句话：Redis 缓存加速靠"内存读取 + 多级缓存"，一致性靠"Cache Aside（先改 DB 再删缓存）+ 延迟双删… | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：多级缓存：Caffeine（本地）→ Redis（分布式）→ MySQL | 核心概念 |
| 1:04 | 能力/参数拆解表 | 要点是：一致性：Cache Aside（先 DB 后删缓存）+ 延迟双删 | 能力拆解 |
| 1:56 | 流程图：输入→处理→输出 | 要点是：三大问题：穿透（布隆过滤）、击穿（互斥锁）、雪崩（TTL 抖动） | 关键机制 |
| 3:00 | 总结卡 + 下期预告 | 记住核心要点就够了。下期见。 | 收尾 |
