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
