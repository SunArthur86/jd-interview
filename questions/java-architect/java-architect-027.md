---
id: java-architect-027
difficulty: L3
category: java-architect
subcategory: Redis
tags:
- 缓存
- 热点
- 保护
feynman:
  essence: 缓存三大问题的本质都是"缓存失效后请求穿透到 DB"——穿透是查不存在的数据（缓存永远 miss）、击穿是热点 key 过期瞬间高并发打 DB、雪崩是大量 key 同时过期导致 DB 瞬间高压。防护思路分别：穿透用布隆过滤器（拦截不存在）、击穿用互斥重建（只放一个请求查 DB）、雪崩用 TTL 加随机（分散过期时间）。热点 Key 是单 key 流量集中，用本地缓存和多副本分摊。
  analogy: 像超市的促销。穿透是"有人反复问不存在的商品"（店员白跑仓库）——用"不存在清单"挡住。击穿是"热门商品刚卖完补货瞬间所有人冲仓库"——派一个店员补货其他人等着（互斥重建）。雪崩是"多个商品同时促销结束所有人同时查仓库"——错开促销结束时间（TTL 加随机）。热点 Key 是"所有人都抢一个商品"——多备几份放到不同货架（多副本）。
  first_principle: 为什么缓存会失效？因为 TTL 过期（主动淘汰）、内存满被淘汰（LRU/LFU）、缓存挂了（Redis 宕机）。失效后请求回源 DB，如果并发量大就是 DB 瞬间高压甚至雪崩。防护的核心是"控制回源 DB 的并发量"。
  key_points:
  - 穿透：查不存在的数据，缓存和 DB 都 miss；防护用布隆过滤器或缓存空值
  - 击穿：热点 key 过期瞬间高并发；防护用互斥重建（分布式锁）或逻辑过期
  - 雪崩：大量 key 同时过期；防护用 TTL 加随机偏移、多级缓存
  - 热点 Key：单 key 流量集中打爆单节点；防护用本地缓存、多副本、热点发现
  - 监控：缓存命中率、bigkeys、slowlog、hotkeys
first_principle:
  problem: 缓存失效时如何防止大量请求同时回源 DB 导致雪崩？
  axioms:
  - 缓存失效（TTL/淘汰/宕机）后请求回源 DB
  - 高并发下回源 DB 的请求量可能打爆 DB
  - 不同失效模式（穿透/击穿/雪崩）需要不同防护策略
  rebuild: 按失效模式分别防护。穿透（查不存在）——布隆过滤器在缓存前拦截不存在的 key，或缓存空值（短 TTL）。击穿（热点过期）——互斥重建（只放一个请求查 DB 回填，其他等待）或逻辑过期（缓存永不过期，后台异步刷新）。雪崩（批量过期）——TTL 加随机偏移（如 30min + random(0, 5min)）分散过期时间，加多级缓存（本地缓存兜底）。热点 Key（流量集中）——本地缓存（Caffeine）减少 Redis 访问、热点 key 多副本（key_1/key_2/... 分散到不同节点）、监控发现热点及时治理。
follow_up:
  - 布隆过滤器为什么能防穿透？——布隆过滤器是一个概率数据结构，能判断"某 key 一定不存在"或"可能存在"。查 DB 前先查布隆过滤器，如果"一定不存在"直接返回，不查 DB 不回填缓存。缺点是有误判率（可能存在的 key 实际不存在），需要定期重建
  - 互斥重建会不会阻塞用户？——会，热点 key 过期时第一个请求查 DB（持锁），其他请求等待。等待可以用两种策略：等待拿到新值（用户多等几百毫秒）或返回旧值（如果缓存有逻辑过期标记）。生产用"双重检查"——拿锁后再查一次缓存（可能已被别人回填）
  - 雪崩为什么要加随机 TTL？——如果所有 key 的 TTL 相同（如都是 30 分钟），30 分钟后同时过期，DB 瞬间高压。加随机（如 30min ± 5min）让过期时间分散，避免同时失效
  - 热点 Key 怎么发现？——Redis 4.0+ 用 redis-cli --hotkeys（基于 LFU 统计）；或用 MONITOR 命令（影响性能慎用）；或客户端统计访问频率；或用 Redis 的 OBJECT FREQ 查看 key 访问频率（LFU 模式下）。生产用监控平台聚合统计
  - 缓存挂了（Redis 宕机）怎么办？——全量回源 DB 导致雪崩。防护：服务降级（返回默认值或错误）、限流（保护 DB）、本地缓存兜底（Caffeine）、Redis 集群高可用（见 029 题）。关键是不能让 DB 被打爆
memory_points:
  - 穿透：查不存在 → 布隆过滤器 / 缓存空值
  - 击穿：热点过期 → 互斥重建 / 逻辑过期
  - 雪崩：批量过期 → TTL 加随机 / 多级缓存
  - 热点 Key：流量集中 → 本地缓存 / 多副本
  - 监控：命中率、bigkeys、slowlog、hotkeys
  - Redis 宕机：降级 + 限流 + 本地缓存兜底
---

# 【Java 后端架构师】缓存穿透、击穿、雪崩与热点 Key

> 适用场景：JD 核心技术。秒杀时一个商品 key 过期就是 DB 被打爆，恶意攻击查不存在的 ID 就是穿透，大促结束大量 key 同时过期就是雪崩。架构师必须能区分这四种问题并给出防护方案——这是缓存高可用的核心。

## 一、概念层：四大问题对比

**缓存四大问题**（面试必考区分）：

| 问题 | 本质 | 触发条件 | 危害 | 防护 |
|------|------|---------|------|------|
| **穿透（Penetration）** | 查不存在的数据 | 恶意攻击/bug 查不存在 ID | 每次都查 DB | 布隆过滤器、缓存空值 |
| **击穿（Breakdown）** | 热点 key 过期瞬间 | 热点 TTL 到了 + 高并发 | 瞬间大量请求打 DB | 互斥重建、逻辑过期 |
| **雪崩（Avalanche）** | 大量 key 同时过期 | TTL 相同 + 集中失效 | DB 瞬间高压 | TTL 加随机、多级缓存 |
| **热点 Key（Hotspot）** | 单 key 流量集中 | 明星八卦/秒杀商品 | 单节点打爆 | 本地缓存、多副本 |

**对比图解**：

```
穿透：查不存在的 key（缓存永远 miss，每次回源 DB）
  Client ──► Cache miss ──► DB miss ──► 不回填（因为不存在）
  ── 每次请求都打到 DB，DB 白白被查

击穿：热点 key 过期瞬间（大量请求同时发现 miss）
  热点 key TTL 到期 ──► 1000 个请求同时 miss ──► 都去查 DB ──► DB 瞬间高压

雪崩：大量 key 同时过期（TTL 集中）
  10000 个 key 同时过期 ──► 10000 个 key 的请求都 miss ──► DB 扛不住

热点 Key：单 key 流量集中（单节点瓶颈）
  明星八卦 key QPS 10 万 ──► 单 Redis 节点 CPU 爆 ──► 该 key 响应慢
```

## 二、机制层：穿透防护

**方案 1：缓存空值**（简单）

```java
public Product getProduct(Long id) {
    String key = "product:" + id;
    Product product = redisTemplate.opsForValue().get(key);
    if (product != null) {
        if (product == NULL_PLACEHOLDER) {
            return null;   // 缓存的空值，说明不存在
        }
        return product;
    }
    product = productMapper.selectById(id);
    if (product != null) {
        redisTemplate.opsForValue().set(key, product, 30, TimeUnit.MINUTES);
    } else {
        // 缓存空值（短 TTL，防止恶意攻击期间一直查 DB）
        redisTemplate.opsForValue().set(key, NULL_PLACEHOLDER, 5, TimeUnit.MINUTES);
    }
    return product;
}
```

**优点**：简单。**缺点**：空值占内存（恶意攻击大量不存在 ID 会污染缓存），TTL 短（数据可能变存在）。

**方案 2：布隆过滤器**（推荐）

```java
@Service
public class ProductService {

    private BloomFilter<Long> productBloomFilter;   // 启动时初始化

    @PostConstruct
    public void init() {
        // 把所有存在的 product ID 加到布隆过滤器
        List<Long> allIds = productMapper.selectAllIds();
        productBloomFilter = BloomFilter.create(
            Funnels.longFunnel(), allIds.size(), 0.01);   // 误判率 1%
        allIds.forEach(productBloomFilter::put);
    }

    public Product getProduct(Long id) {
        // 1. 布隆过滤器先过滤
        if (!productBloomFilter.mightContain(id)) {
            return null;   // 一定不存在，直接返回，不查 DB 不查缓存
        }
        // 2. 正常查缓存
        String key = "product:" + id;
        Product product = redisTemplate.opsForValue().get(key);
        if (product != null) return product;
        // 3. 查 DB
        product = productMapper.selectById(id);
        if (product != null) {
            redisTemplate.opsForValue().set(key, product, 30, TimeUnit.MINUTES);
        }
        return product;
    }

    // 新增商品时加入布隆过滤器
    public void addProduct(Product product) {
        productMapper.insert(product);
        productBloomFilter.put(product.getId());
    }
}
```

**布隆过滤器原理**（画图理解）：

```
布隆过滤器 = bit 数组 + 多个哈希函数

添加 key：
  对 key 做 k 次哈希，得到 k 个位置，bit 数组对应位置置 1

查询 key：
  对 key 做 k 次哈希，检查 k 个位置：
    - 全是 1 → "可能存在"（有误判率，其他 key 可能也把这些位置置 1 了）
    - 任一为 0 → "一定不存在"（不存在就不会置 1）

特点：
  - 空间效率高（100 万元素只需 ~1MB）
  - 查询快（k 次哈希）
  - 有误判率（说"可能存在"实际可能不存在）
  - 不能删除（删除会影响其他 key）
  - 适合"过滤不存在的 key"场景
```

## 三、机制层：击穿防护

**方案 1：互斥重建**（推荐）

```java
public Product getProduct(Long id) {
    String key = "product:" + id;
    Product product = redisTemplate.opsForValue().get(key);
    if (product != null) return product;

    // 缓存 miss，尝试获取锁（只有一个请求查 DB）
    String lockKey = "lock:" + id;
    try {
        boolean locked = redisTemplate.opsForValue()
            .setIfAbsent(lockKey, "1", 10, TimeUnit.SECONDS);
        if (locked) {
            try {
                // 双重检查（可能已被别人回填）
                product = redisTemplate.opsForValue().get(key);
                if (product != null) return product;

                // 查 DB 回填
                product = productMapper.selectById(id);
                if (product != null) {
                    redisTemplate.opsForValue().set(key, product, 30, TimeUnit.MINUTES);
                }
                return product;
            } finally {
                redisTemplate.delete(lockKey);   // 释放锁
            }
        } else {
            // 没拿到锁，短暂等待后重试（读缓存）
            Thread.sleep(50);
            return getProduct(id);   // 递归重试
        }
    } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
        return null;
    }
}
```

**方案 2：逻辑过期**（不阻塞用户）

```java
// 缓存值带逻辑过期时间（不设 Redis TTL，永不过期）
public class ProductCacheValue {
    private Product product;
    private long logicalExpireTime;   // 逻辑过期时间
}

public Product getProduct(Long id) {
    String key = "product:" + id;
    ProductCacheValue value = redisTemplate.opsForValue().get(key);

    if (value == null) {
        return null;   // 不存在（理论上预热过不会 null）
    }

    // 未逻辑过期，直接返回
    if (value.getLogicalExpireTime() > System.currentTimeMillis()) {
        return value.getProduct();
    }

    // 已逻辑过期，尝试异步刷新
    String lockKey = "lock:" + id;
    boolean locked = redisTemplate.opsForValue()
        .setIfAbsent(lockKey, "1", 10, TimeUnit.SECONDS);
    if (locked) {
        // 异步刷新（不阻塞当前请求）
        executor.submit(() -> {
            try {
                Product fresh = productMapper.selectById(id);
                ProductCacheValue newValue = new ProductCacheValue(fresh,
                    System.currentTimeMillis() + 30 * 60 * 1000);
                redisTemplate.opsForValue().set(key, newValue);
            } finally {
                redisTemplate.delete(lockKey);
            }
        });
    }
    // 返回旧值（虽然过期但还能用）
    return value.getProduct();
}
```

## 四、机制层：雪崩防护

**方案 1：TTL 加随机偏移**（最简单）

```java
// 错误：所有 key 同样 TTL，集中过期
redisTemplate.opsForValue().set(key, value, 30, TimeUnit.MINUTES);

// 正确：TTL 加随机，分散过期
int baseTTL = 30 * 60;   // 30 分钟（秒）
int randomTTL = ThreadLocalRandom.current().nextInt(300);   // 0-5 分钟随机
redisTemplate.opsForValue().set(key, value, baseTTL + randomTTL, TimeUnit.SECONDS);
// 过期时间分散在 30-35 分钟之间，避免同时失效
```

**方案 2：多级缓存**（本地缓存兜底）

```java
@Service
public class ProductService {
    // 本地缓存（Caffeine）+ 分布式缓存（Redis）+ DB
    private Cache<Long, Product> localCache = Caffeine.newBuilder()
        .maximumSize(10_000)
        .expireAfterWrite(5, TimeUnit.MINUTES)
        .build();

    public Product getProduct(Long id) {
        // 1. 本地缓存（最快）
        Product product = localCache.getIfPresent(id);
        if (product != null) return product;

        // 2. Redis 缓存
        product = redisTemplate.opsForValue().get("product:" + id);
        if (product != null) {
            localCache.put(id, product);   // 回填本地
            return product;
        }

        // 3. DB
        product = productMapper.selectById(id);
        if (product != null) {
            redisTemplate.opsForValue().set("product:" + id, product,
                30 * 60 + ThreadLocalRandom.current().nextInt(300), TimeUnit.SECONDS);
            localCache.put(id, product);
        }
        return product;
    }
}
// 即使 Redis 大量 key 过期（雪崩），本地缓存还能扛住，不回源 DB
```

**方案 3：Redis 高可用**（防宕机型雪崩）

```
Redis 宕机导致全量回源 DB 是最严重的雪崩。防护：
  - Redis 集群高可用（主从 + 哨兵/Cluster，见 029 题）
  - 服务降级（Redis 挂时返回默认值或降级数据）
  - 限流（Redis 挂时限流保护 DB）
  - 本地缓存兜底（即使 Redis 挂，本地还有缓存）
  - 多活（异地 Redis 独立部署）
```

## 五、实战层：热点 Key 治理

**热点 Key 的危害**：单 key 流量集中（如 QPS 10 万），打到单个 Redis 节点，该节点 CPU 爆，响应慢，但其他节点闲着。

**热点 Key 发现**：

```bash
# Redis 4.0+ 发现热点 key（基于 LFU 访问频率）
redis-cli --hotkeys
# 输出访问频率最高的 key

# 查看单个 key 的访问频率（需 LFU 模式）
OBJECT FREQ product:12345

# 慢查询日志（热点 key 可能因为慢查询被识别）
SLOWLOG GET 10

# 统计 bigkeys（大 key 往往也是热点）
redis-cli --bigkeys

# INFO stats 看缓存命中
INFO stats
# keyspace_hits / (keyspace_hits + keyspace_misses) = 命中率
```

**热点 Key 防护**：

**方案 1：本地缓存**（最有效）

```java
// 热点 key 多读本地缓存，减少 Redis 访问
private Cache<String, Product> hotKeyCache = Caffeine.newBuilder()
    .maximumSize(100)              // 只缓存热点（少量）
    .expireAfterWrite(10, TimeUnit.SECONDS)   // 短 TTL（保证不太旧）
    .build();

public Product getHotProduct(Long id) {
    String key = "product:" + id;
    // 先查本地（10 秒 TTL，热点 key 大概率命中）
    Product product = hotKeyCache.getIfPresent(key);
    if (product != null) return product;
    // 本地 miss 再查 Redis
    product = redisTemplate.opsForValue().get(key);
    if (product != null) {
        hotKeyCache.put(key, product);
    }
    return product;
}
```

**方案 2：多副本分散**（把热点 key 复制多份到不同节点）

```java
// 热点 key 写入时复制多份
public void setHotKey(String key, String value) {
    for (int i = 0; i < 10; i++) {
        redisTemplate.opsForValue().set(key + ":" + i, value, 30, TimeUnit.MINUTES);
    }
}

// 读取时随机选一个副本（分散到不同节点）
public String getHotKey(String key) {
    int replica = ThreadLocalRandom.current().nextInt(10);
    return redisTemplate.opsForValue().get(key + ":" + replica);
}
// 10 个副本分散到 10 个节点，单节点压力降 1/10
```

**方案 3：读写分离 + 集群**（见 029 题）

## 六、底层本质：回源并发控制

回到第一性：**缓存四大问题的本质都是"缓存失效后请求回源 DB，高并发导致 DB 过载"**。

- **穿透的本质**：不存在的数据每次都 miss，相当于"无缓存的直查 DB"。防护是"在缓存前加一层过滤"（布隆过滤器），把不存在的 key 挡在 DB 外。
- **击穿的本质**：热点 key 失效瞬间，大量并发请求同时发现 miss 并回源 DB。防护是"互斥"——只放一个请求查 DB，其他等待或返回旧值。
- **雪崩的本质**：大量 key 同时失效（TTL 集中或 Redis 宕机），回源请求量超过 DB 承受。防护是"分散失效时间"（TTL 加随机）和"多级兜底"（本地缓存）。
- **热点 Key 的本质**：流量集中在单 key 单节点，不是 DB 问题而是 Redis 单节点瓶颈。防护是"把单点变成多点"——本地缓存（每实例一份）或多副本（Redis 多节点各一份）。
- **统一思路**：控制回源 DB 的并发量。穿透减少无效回源，击穿串行化回源，雪崩错峰回源，热点减少回源（本地缓存）。核心是"让 DB 的压力可控"。

## 七、AI 架构师加问：5 个 AI 相关问题

1. **AI 推理结果的热点 key 怎么处理？**
   某些热门用户（如 KOL）的推理结果被高频查询，形成热点。用本地缓存（Caffeine）缓存热门用户结果（短 TTL 10 秒），减少 Redis 访问。或者按用户分片到不同 Redis 节点（避免单点）。

2. **让 AI 预测缓存雪崩，怎么设计？**
   AI 分析 key 的 TTL 分布 → 识别"同时过期的 key 群" → 预警并推荐"给这批 key 加随机 TTL"。AI 还能监控命中率趋势（命中率骤降可能是雪崩前兆）。

3. **AI 怎么自动发现热点 key？**
   AI 分析 Redis 访问日志（或客户端统计）→ 聚合 key 的访问频率 → 识别"QPS 超阈值的 key" → 自动触发本地缓存或多副本。AI 还能预测热点（如某商品即将上秒杀，提前缓存预热）。

4. **恶意攻击查不存在 ID，AI 能识别吗？**
   AI 分析访问模式 → 识别"大量查不存在的 ID"（穿透攻击特征）→ 自动启用布隆过滤器或限制该 IP/user 的查询频率。AI 还能识别攻击模式（随机 ID / 顺序 ID / 特定模式）。

5. **AI 推理服务挂了，缓存怎么兜底？**
   推理服务挂时，返回缓存的旧推理结果（即使过期）+ 降级到规则引擎。缓存设逻辑过期（永不过期，后台异步刷新），即使推理服务挂，旧结果还能服务。配合限流保护后端不被打爆。

## 八、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"穿透布隆、击穿互斥、雪崩随机、热点本地"**。

- **穿透**：查不存在 → 布隆过滤器拦截、缓存空值
- **击穿**：热点过期 → 互斥重建（分布式锁只放一个查 DB）、逻辑过期（后台异步刷新）
- **雪崩**：批量过期 → TTL 加随机偏移、多级缓存（本地兜底）
- **热点 Key**：流量集中 → 本地缓存（Caffeine）、多副本（分散到多节点）
- **监控**：hotkeys、bigkeys、slowlog、命中率

### 拟人化理解

把缓存防护想成**超市促销管理**。穿透是"有人反复问不存在的商品"——用"不存在清单"挡住（布隆过滤器）。击穿是"热门商品刚卖完补货瞬间所有人冲仓库"——派一个店员补货其他人排队等（互斥重建）。雪崩是"多个商品同时促销结束所有人同时查仓库"——错开促销结束时间（TTL 加随机）。热点 Key 是"所有人都抢一个商品"——多备几份放到不同货架（多副本）或在收银台缓存一份（本地缓存）。统一思路是"控制冲仓库的人数"（控制回源 DB 并发）。

### 面试现场 60 秒回答

> 缓存四大问题区分：穿透是查不存在的数据（每次 miss 查 DB），防护用布隆过滤器（过滤不存在）或缓存空值；击穿是热点 key 过期瞬间高并发打 DB，防护用互斥重建（分布式锁只放一个请求查 DB，其他等待）或逻辑过期（缓存永不过期后台异步刷新）；雪崩是大量 key 同时过期，防护用 TTL 加随机偏移（30min ± 5min 分散过期）和多级缓存（本地缓存兜底）；热点 Key 是单 key 流量集中打爆单节点，防护用本地缓存（Caffeine 减少访问 Redis）和多副本（key 复制多份到不同节点）。统一思路是控制回源 DB 的并发量——穿透减少无效回源，击穿串行化回源，雪崩错峰回源，热点减少回源。监控用 redis-cli --hotkeys 发现热点，--bigkeys 发现大 key，SLOWLOG 看慢查询，INFO stats 看命中率。

### 反问面试官

> 贵司有没有遇到过缓存击穿/雪崩事故？热 key 治理用本地缓存还是多副本？布隆过滤器是自建还是用 RedisBloom 模块？缓存命中率监控阈值多少告警？

## 九、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么缓存会有这么多问题，不用缓存行不行？ | 用收益说话：缓存把读延迟从几十毫秒降到亚毫秒，DB 压力降 90%。不用缓存 DB 扛不住高并发读。问题确实存在，但相比不用缓存的性能损失，防护代价是值得的 |
| 证据追问 | 怎么知道发生了击穿/雪崩？ | 监控缓存命中率骤降（正常 80%+，骤降到 50% 可能击穿）；DB QPS 飙升（回源多）；DB CPU 飙高；慢查询增多。redis-cli --hotkeys 发现热点 key 过期时间集中 |
| 边界追问 | 防护方案能完全避免问题吗？ | 不能。布隆过滤器有误判率（少量不存在 key 漏过），互斥重建有短暂等待（用户感知延迟），TTL 随机只是降低概率（仍可能小范围集中）。防护是"降低概率和影响"，不是"绝对避免" |
| 反例追问 | 什么场景不需要这些防护？ | 低并发场景（QPS 几百，击穿/雪崩概率低）、数据无热点（全随机访问，命中率低缓存意义不大）、强一致场景（绕过缓存直读 DB） |
| 风险追问 | 防护方案本身的风险？ | 主动点出：布隆过滤器误判（漏过不存在 key）、互斥重建死锁（锁不释放）、本地缓存不一致（多实例各有缓存）、降级返回错误值影响业务 |
| 验证追问 | 怎么证明防护有效？ | 压测模拟热点 key 过期（验证互斥重建只放一个请求）；混沌工程 kill Redis（验证降级和兜底）；监控回源率（应低）；演练验证雪崩场景下的 DB 压力可控 |
| 沉淀追问 | 团队缓存防护规范，沉淀什么？ | TTL 设置规范（加随机）、热点 key 发现与治理 SOP、布隆过滤器使用规范、降级预案（Redis 挂时）、缓存监控大盘（命中率/回源率/热点） |

### 现场对话示例

**面试官**：穿透和击穿有什么区别？

**候选人**：穿透是查不存在的数据，缓存和 DB 都没有，每次请求都打到 DB。比如恶意攻击查 id=-1 或 id=99999999（不存在的 ID），缓存 miss 查 DB 也 miss，不回填（因为不存在），下次查还是 miss 又查 DB。击穿是查存在的热点数据，但恰好缓存过期了。比如秒杀商品的 key TTL 到了，瞬间几千个用户查询，都发现缓存 miss，都去查 DB，DB 瞬间高压。区别在于：穿透是"数据本身不存在"（无解的直接查 DB），击穿是"数据存在但缓存刚好失效"（短暂的）。防护也不同——穿透用布隆过滤器（拦截不存在的 key），击穿用互斥重建（串行化回源）。简单记忆：穿透是"不存在的 key 反复查"，击穿是"热点 key 失效瞬间集中查"。

**面试官**：互斥重建时拿不到锁的请求怎么办？

**候选人**：两种策略。第一种，等待重试——拿不到锁的请求 sleep 短暂时间（如 50ms）后递归重试（再次查缓存，可能已被持锁请求回填）。优点是用户拿到的是新值，缺点是有延迟（用户多等几百毫秒）。第二种，返回旧值——如果缓存有"逻辑过期"机制（不设 Redis TTL，值里带逻辑过期时间），拿不到锁的请求返回旧值（虽然逻辑过期但还能用），同时异步触发刷新。优点是用户不等待，缺点是返回的可能是旧值。生产实践：大部分场景用等待重试（几百毫秒用户可接受），对延迟敏感的场景用逻辑过期返回旧值。还有一个细节是"双重检查"——拿锁后再查一次缓存，因为可能持锁请求已经回填了，就不用再查 DB 了。这能减少不必要的 DB 查询。

**面试官**：热点 key 多副本方案，怎么保证多副本一致性？

**候选人**：多副本一致性是个挑战。写操作要同时更新所有副本（如 key:0 到 key:9），如果部分更新失败会出现不一致。处理方案：第一，写操作用 pipeline 批量更新所有副本（减少网络往返），失败的副本靠 TTL 过期最终一致（读时发现 miss 会回源主 key 或 DB 回填）。第二，副本 TTL 设短（如 5 分钟），即使某个副本没更新到，TTL 过期后重新从主 key 同步。第三，读操作随机选副本，某个副本 miss 时回源主 key（或 DB）。所以多副本是"最终一致"——短时间内部分副本可能是旧值，但 TTL 过期后收敛。对于强一致需求（如价格），不用多副本，用本地缓存（Caffeine，每实例独立，TTL 短到 10 秒）替代。多副本适合"容忍短暂不一致、流量极大"的热点场景。

## 常见考点

1. **布隆过滤器为什么不能删除？**——布隆过滤器的 bit 位可能被多个 key 共享（不同 key 哈希到同一位置）。删除一个 key 把对应位置 0 会影响其他 key（它们也依赖这个位置）。所以标准布隆过滤器不支持删除。变体 Counting Bloom Filter（用计数器代替 bit）支持删除，但空间开销大。
2. **缓存预热怎么做？**——系统启动或大促前，提前把热点数据加载到缓存。脚本批量查 DB 回填 Redis，避免上线瞬间缓存空导致 DB 瞬间高压。秒杀场景提前预热商品 key，秒杀时直接命中缓存不回源。
3. **Redis MONITOR 命令能监控热点吗？**——能，MONITOR 实时输出所有命令。但它严重影响 Redis 性能（每条命令都输出），生产慎用。推荐用 redis-cli --hotkeys（基于 LFU 统计，性能影响小）或客户端统计访问频率。
4. **缓存降级怎么做？**——Redis 挂时，应用降级返回默认值或降级数据，不回源 DB。降级策略：返回空列表（如商品列表）、返回静态数据（如默认推荐）、返回缓存快照（本地缓存的旧数据）。配合限流（Redis 挂时限流保护 DB）。降级要预设场景和开关（动态开关见 020 题）。


## 结构化回答

**30 秒电梯演讲：** 聊到缓存穿透、击穿、雪崩与热点 Key，我的理解是——缓存三大问题的本质都是"缓存失效后请求穿透到 DB"——穿透是查不存在的数据（缓存永远 miss）、击穿是热点 key 过期瞬间高并发打 DB、雪崩是大量 key 同时过期导致 DB 瞬间高压。防护思路分别：穿透用布隆过滤器（拦截不存在）、击穿用互斥重建（只放一个请求查 DB）、雪崩用 TTL 加随机（分散过期时间）。热点 Key 是单 key 流量集中，用本地缓存和多副本分摊。打个比方，像超市的促销。穿透是"有人反复问不存在的商品"（店员白跑仓库）——用"不存在清单"挡住。击穿是"热门商品刚卖完补货瞬间所有人冲仓库"——派一个店员补货其他人等着（互斥重建）。雪崩是"多个商品同时促销结束所有人同时查仓库"——错开促销结束时间（TTL 加随机）。热点 Key 是"所有人都抢一个商品"——多备几份放到不同货架（多副本）。

**展开框架：**
1. **穿透** — 查不存在的数据，缓存和 DB 都 miss；防护用布隆过滤器或缓存空值
2. **击穿** — 热点 key 过期瞬间高并发；防护用互斥重建（分布式锁）或逻辑过期
3. **雪崩** — 大量 key 同时过期；防护用 TTL 加随机偏移、多级缓存

**收尾：** 这块我在项目里也踩过坑——想深入的话，可以接着聊：布隆过滤器为什么能防穿透？您更想看哪个方向？

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡 | "缓存穿透、击穿、雪崩与热点 Key——这道题面试官到底想考什么？我用 30 秒给你讲透。" | 开场钩子 |
| 0:15 | 多级缓存架构图 | 先说核心：缓存三大问题的本质都是"缓存失效后请求穿透到 DB"——穿透是查不存在的数据（缓存永远 miss）、击穿是热点 key 过期瞬间高并发打 DB、雪崩是大量 key 同时过期导致。 | 核心定义 |
| 0:40 | Redis 数据结构图 | 热点 key 过期瞬间高并发；防护用互斥重建（分布式锁）或逻辑过期。 | 击穿 |
| 1:05 | 概念结构示意图 | 大量 key 同时过期；防护用 TTL 加随机偏移、多级缓存。 | 雪崩 |
| 2:30 | 总结卡 | 一句话记忆：穿透：查不存在 → 布隆过滤器 / 缓存空值。 下期可以接着聊：布隆过滤器为什么能防穿透。 | 收尾总结 |
