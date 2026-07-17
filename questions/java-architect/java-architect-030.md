---
id: java-architect-030
difficulty: L4
category: java-architect
subcategory: 缓存
tags:
- 多级缓存
- 本地缓存
- Caffeine
- 缓存一致性
feynman:
  essence: 多级缓存的本质是"用空间换时间，用层级换性能"。L1 本地缓存（Caffeine，应用内存，纳秒级）→ L2 集中式缓存（Redis，毫秒级）→ L3 DB。每层性能差 2-3 个数量级。核心难题是"一致性"——本地缓存各实例独立，更新如何通知所有实例失效？解法有四：TTL 过期（简单但有脏读窗口）、广播失效（Redis Pub/Sub 或 MQ）、binlog 订阅（Canal 监听 DB 变更）、版本号校验（强一致但复杂）。
  analogy: 像图书馆的书籍借阅体系。L1 是"你桌上的书"（最快，但只有你有），L2 是"楼层书架"（同事也能看，慢一点），L3 是"总馆仓库"（最慢最全）。你更新了一本书的内容，怎么保证别人桌上那本旧版也更新？TTL 是"规定书上架 10 分钟必须换新版"（到期前别人可能看旧版）。广播失效是"大喇叭喊一声'书更新了，大家把旧版扔了'"（实时但占带宽）。版本号是"每次看书先核对版本号"（最准但麻烦）。
  first_principle: 为什么需要多级缓存？——本地缓存比 Redis 快 100 倍（纳秒 vs 毫秒），但本地缓存有容量限制（应用内存有限）和一致性难题（多实例独立）。多级缓存用 L1 挡大部分流量（热点 key），L2 兜底（全量数据），L3 数据源。核心权衡是"性能 vs 一致性 vs 复杂度"。
  key_points:
  - L1 Caffeine：W-TinyLFU 算法，命中率比 LRU 高，纳秒级访问
  - L2 Redis：全量缓存，毫秒级，集中式
  - 一致性方案：TTL / 广播失效（Pub-Sub/MQ）/ binlog 订阅 / 版本号
  - 缓存击穿：互斥重建（防并发重建）
  - 热点 key：本地缓存挡流量
first_principle:
  problem: 高并发场景下单靠 Redis 缓存扛不住（网络 IO 瓶颈、热点 key 单点），如何进一步提升性能？
  axioms:
  - 本地内存访问比网络快 100 倍（纳秒 vs 毫秒）
  - 本地缓存容量有限（应用内存 GB 级，Redis 可以 TB 级）
  - 多实例本地缓存相互独立（更新 A 实例，B 实例不知道）
  - 一致性和性能是矛盾的（强一致要同步，慢；弱一致用 TTL/通知，快但有脏读窗口）
  rebuild: 用 L1 本地缓存（Caffeine，挡热点 key 流量，纳秒级）+ L2 Redis（全量数据，毫秒级，集中式）+ L3 DB（数据源）。读流程：L1 → L2 → DB，逐级回种。写流程：更新 DB → 删 L2 → 广播通知所有实例删 L1（或依赖 TTL 自然过期）。一致性方案按业务选：弱一致用 TTL（简单，秒级脏读窗口）；较强一致用广播失效（Redis Pub/Sub 或 MQ 通知所有实例）；强一致用版本号校验（每次读校验 L1 和 L2 的版本号，不一致则更新）。本地缓存用 Caffeine（W-TinyLFU 算法，命中率比 LRU 高 30%+），设短 TTL（如 10s）控制脏读窗口。
follow_up:
  - 本地缓存和分布式缓存什么区别？——本地缓存（Caffeine/Guava Cache）在应用 JVM 内存，纳秒级访问但各实例独立、容量小、重启丢失。分布式缓存（Redis/Memcached）独立部署，毫秒级但集中共享、容量大、持久化。两者互补：本地缓存挡热点，分布式缓存兜底
  - 怎么保证本地缓存一致性？——四种方案：①TTL 短过期（如 10s，脏读窗口小但存在）；②广播失效（Redis Pub/Sub 或 MQ，更新时通知所有实例删本地，近实时）；③binlog 订阅（Canal 监听 DB 变更，发 MQ 通知所有实例，解耦但延迟）；④版本号校验（本地缓存带版本号，读时比对 Redis 版本号，强一致但每次读 Redis 降性能）
  - Caffeine 比 Guava Cache 好在哪？——①W-TinyLFU 算法（结合 LRU+LFU，命中率比 LRU 高 30%+，抗扫描污染）；②异步刷新（afterRefresh 异步执行，不阻塞读）；③性能更高（并发优化，吞吐量高）。新项目用 Caffeine，老项目 Guava Cache 仍可用
  - 广播失效用 Pub/Sub 还是 MQ？——Redis Pub/Sub 简单（Redis 原生），但消息不持久（订阅者不在线就丢）。MQ（Kafka/RocketMQ）可靠（持久化+重试），但引入 MQ 依赖。生产推荐 MQ——保证消息不丢，一致性更可靠。Pub/Sub 适合容忍丢消息的场景（如短 TTL 兜底）
  - 热点 key 怎么用本地缓存扛？——识别热点 key（redis-cli --hotkeys 或监控 QPS TOP N）→ 配置进 Caffeine（本地缓存）→ 请求先查本地（纳秒级）→ miss 才查 Redis。本地缓存挡住大部分流量，Redis QPS 降一个数量级。注意本地缓存 TTL 短（如 5s），防止数据过旧
memory_points:
  - L1 Caffeine（本地）→ L2 Redis（集中）→ L3 DB
  - Caffeine 用 W-TinyLFU（比 LRU 命中率高 30%）
  - 一致性四方案：TTL / 广播（Pub-Sub+MQ）/ binlog（Canal）/ 版本号
  - 读流程：逐级查，miss 回种；写流程：更新 DB→删 Redis→广播删本地
  - 热点 key：本地缓存挡流量，Redis QPS 降一个数量级
---

# 【Java 后端架构师】本地缓存与多级缓存一致性

> 适用场景：JD 核心技术。商品详情页、首页推荐、热点活动——这些高 QPS 场景单靠 Redis 扛不住（网络 IO 瓶颈、热点 key 单分片打满）。多级缓存是性能优化的最后一道防线。架构师必须会设计 L1（本地）+ L2（Redis）+ L3（DB）架构、解决多实例本地缓存一致性、应对缓存击穿/雪崩/热点 key。

## 一、概念层：多级缓存架构

**三级缓存层次**：

| 层级 | 存储 | 访问延迟 | 容量 | 一致性 |
|------|------|----------|------|--------|
| **L1 本地缓存** | Caffeine（JVM 内存） | 纳秒级（1μs 内） | GB 级（受应用内存限） | 弱一致（各实例独立） |
| **L2 分布式缓存** | Redis | 毫秒级（1-5ms） | TB 级（集群扩展） | 强一致（单线程原子） |
| **L3 数据库** | MySQL | 10-100ms | PB 级 | 强一致（ACID） |

**性能数量级**（必背）：

```
L1 Caffeine：     ~100 纳秒（10^-7 秒）
L2 Redis：        ~1 毫秒（10^-3 秒）  ← 比 L1 慢 1 万倍
L3 MySQL：        ~10-100 毫秒         ← 比 L2 慢 10-100 倍
```

**为什么要多级**：

```
单 Redis 的问题：
  - 网络 IO 瓶颈（每次读要走网络，1ms 延迟）
  - 热点 key 单分片打满（如秒杀商品，单 key QPS 10 万+）
  - Redis 故障时全量回源 DB（雪崩）

加 L1 本地缓存的好处：
  - 热点 key 走本地（纳秒级，无网络开销）
  - 降 Redis QPS（本地挡 80%+ 流量）
  - Redis 故障时本地兜底（降级保护）
```

## 二、机制层：Caffeine 本地缓存

**Caffeine 的 W-TinyLFU 算法**（面试加分点）：

```
传统淘汰算法的问题：
  LRU（最近最少使用）：抗扫描污染差（批量扫描会挤掉热点）
  LFU（最少频率使用）：抗突发差（历史热点长期占位，新热点上不来）

W-TinyLFU（Caffeine 的核心创新）：
  W = Window（窗口区，20% 内存，LRU，接住新 key）
  TinyLFU（准入区，Count-Min Sketch 频率统计，决定是否准入）
  Main（主区，80% 内存，SLRU，分为 Protected 80% + Probation 20%）

  流程：
  1. 新 key 进入 Window 区（LRU）
  2. Window 淘汰时进 TinyLFU 准入判断：
     - TinyLFU 用 Count-Min Sketch 统计历史访问频率
     - 新 key 频率 > 被淘汰 key 频率 → 准入 Main 区
     - 否则丢弃（防扫描污染）
  3. Main 区 SLRU：
     - 新进 Probation（缓刑区）
     - 再次访问升 Protected（保护区）
     - Protected 淘汰降 Probation

  效果：命中率比 LRU 高 30%+，同时抗扫描污染和突发流量
```

**Caffeine 基础用法**：

```java
@Configuration
public class CaffeineConfig {

    @Bean
    public Cache<String, Product> productCache() {
        return Caffeine.newBuilder()
            .maximumSize(10_000)                    // 最大缓存条数
            .expireAfterWrite(10, TimeUnit.SECONDS) // 写入后 10 秒过期
            .expireAfterAccess(5, TimeUnit.SECONDS) // 访问后 5 秒过期（可选）
            .refreshAfterWrite(8, TimeUnit.SECONDS) // 写入 8 秒后异步刷新（防过期雪崩）
            .recordStats()                          // 开启统计（命中率等）
            .build();
    }

    // 注解方式（Spring Cache + Caffeine）
    @Cacheable(value = "product", key = "#skuId", sync = true)  // sync 防击穿
    public Product getProduct(Long skuId) {
        return productMapper.selectById(skuId);  // 只在缓存 miss 时执行
    }
}
```

**关键参数**：

```java
Caffeine.newBuilder()
    .maximumSize(10_000)        // 基于数量淘汰（W-TinyLFU）
    // 或基于权重（适合 value 大小不一的场景）
    .maximumWeight(100_000_000) // 100MB
    .weigher((key, value) -> value.toString().length())  // 按 value 字符串长度算权重

    .expireAfterWrite(10, TimeUnit.SECONDS)  // 写后过期（防脏读，推荐）
    .expireAfterAccess(5, TimeUnit.SECONDS)  // 访问后过期（空闲回收，可选）
    .refreshAfterWrite(8, TimeUnit.SECONDS)  // 写后异步刷新（防过期雪崩，需 CacheLoader）

    .recordStats()  // 开启统计（hit rate、eviction count）
```

## 三、机制层：多级缓存读写流程

**读流程（逐级查，miss 回种）**：

```java
@Service
public class ProductService {

    @Autowired
    private Cache<String, Product> localCache;  // Caffeine
    @Autowired
    private RedisTemplate<String, Product> redisTemplate;
    @Autowired
    private ProductMapper productMapper;

    public Product getProduct(Long skuId) {
        String key = "product:" + skuId;

        // L1：本地缓存
        Product product = localCache.getIfPresent(key);
        if (product != null) {
            return product;  // 命中（纳秒级）
        }

        // L2：Redis
        product = redisTemplate.opsForValue().get(key);
        if (product != null) {
            localCache.put(key, product);  // 回种 L1
            return product;  // 命中（毫秒级）
        }

        // L3：DB（加锁防击穿）
        product = getProductFromDBWithLock(skuId, key);
        return product;
    }

    // 互斥重建（防缓存击穿）
    private Product getProductFromDBWithLock(Long skuId, String key) {
        // 双重检查（避免重复查 DB）
        Product product = redisTemplate.opsForValue().get(key);
        if (product != null) {
            localCache.put(key, product);
            return product;
        }

        // 分布式锁（防并发重建）
        RLock lock = redissonClient.getLock("lock:" + key);
        try {
            if (lock.tryLock(3, TimeUnit.SECONDS)) {
                // 再次检查（拿到锁后可能别人已重建）
                product = redisTemplate.opsForValue().get(key);
                if (product != null) {
                    localCache.put(key, product);
                    return product;
                }
                // 查 DB
                product = productMapper.selectById(skuId);
                if (product != null) {
                    // 回种 L2（随机 TTL 防雪崩）
                    int ttl = 300 + ThreadLocalRandom.current().nextInt(60);
                    redisTemplate.opsForValue().set(key, product, ttl, TimeUnit.SECONDS);
                    // 回种 L1
                    localCache.put(key, product);
                }
                return product;
            } else {
                // 没拿到锁，短暂等待后重试读缓存
                Thread.sleep(50);
                return getProduct(skuId);
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new RuntimeException(e);
        } finally {
            if (lock.isHeldByCurrentThread()) lock.unlock();
        }
    }
}
```

**写流程（更新 DB → 删 Redis → 广播删本地）**：

```java
@Service
public class ProductService {

    public void updateProduct(Product product) {
        // 1. 更新 DB
        productMapper.updateById(product);
        String key = "product:" + product.getSkuId();

        // 2. 删 Redis（不是更新，避免并发写覆盖）
        redisTemplate.delete(key);

        // 3. 广播通知所有实例删本地缓存
        cacheBroadcast.publish("cache:invalidate", key);
    }
}
```

## 四、机制层：本地缓存一致性方案

**方案一：TTL 短过期（最简单）**

```java
// Caffeine 设短 TTL，脏读窗口 = TTL
Caffeine.newBuilder()
    .expireAfterWrite(10, TimeUnit.SECONDS)  // 最多脏读 10 秒
    .build();

// 优点：简单，无需通知机制
// 缺点：脏读窗口 = TTL（10 秒内其他实例读到旧数据）
// 适用：一致性要求低的场景（如商品标签、配置）
```

**方案二：广播失效（Redis Pub/Sub）**

```java
// 发布失效消息（更新数据时）
@Component
public class CacheBroadcast {

    @Autowired
    private RedisTemplate<String, String> redisTemplate;

    private static final String CHANNEL = "cache:invalidate";

    public void publish(String key) {
        redisTemplate.convertAndSend(CHANNEL, key);  // 发布到 Pub/Sub 频道
    }
}

// 订阅失效消息（所有应用实例）
@Component
public class CacheSubscriber {

    @Autowired
    private Cache<String, Object> localCache;

    @RedisListener(channel = "cache:invalidate")  // 监听 Pub/Sub
    public void onInvalidate(String key) {
        localCache.invalidate(key);  // 删本地缓存
    }
}
```

```
广播失效的问题：
  - Pub/Sub 消息不持久（订阅者不在线就丢消息）
  - 网络抖动可能漏消息（个别实例没收到广播，本地缓存不更新）

解法：TTL + 广播组合（广播做实时，TTL 兜底）
  Caffeine.expireAfterWrite(30s)  // TTL 30 秒兜底
  + 广播失效                       // 实时通知（秒级生效）
  最坏情况：广播丢失 → 30 秒后 TTL 过期 → 一致
```

**方案三：MQ 可靠广播（推荐）**

```java
// 更新数据时发 MQ 消息（所有实例订阅，保证不丢）
@Service
public class ProductService {

    public void updateProduct(Product product) {
        productMapper.updateById(product);
        redisTemplate.delete("product:" + product.getSkuId());

        // 发 MQ（持久化，保证所有消费者都能收到）
        cacheInvalidationProducer.send(
            new CacheInvalidationMsg("product:" + product.getSkuId()));
    }
}

// 所有实例监听 MQ
@Component
@RocketMQMessageListener(topic = "cache-invalidation")
public class CacheInvalidationConsumer {

    @Autowired
    private Cache<String, Object> localCache;

    @Override
    public void onMessage(CacheInvalidationMsg msg) {
        localCache.invalidate(msg.getKey());
    }
}
```

**方案四：binlog 订阅（解耦）**

```
应用不主动发广播，而是监听 DB binlog：

  应用更新 DB
  → Canal 监听 binlog 变更
  → Canal 发 MQ 消息（表名+主键）
  → 所有应用实例订阅 MQ，删本地缓存 + Redis

优点：
  - 应用无感知（不用写广播代码，解耦）
  - DB 是唯一数据源（binlog 反映所有变更）

缺点：
  - 延迟（binlog → Canal → MQ → 消费，秒级延迟）
  - 架构复杂（引入 Canal）

适用：一致性要求中、想统一缓存失效方案的系统
```

**方案五：版本号校验（强一致）**

```java
// 本地缓存存"数据 + 版本号"
public class CacheEntry<T> {
    private T data;
    private long version;  // 数据版本号
}

public Product getProduct(Long skuId) {
    String key = "product:" + skuId;

    // L1 本地缓存
    CacheEntry<Product> local = localCache.getIfPresent(key);
    if (local != null) {
        // 校验版本号（读 Redis 的版本号，比对）
        Long redisVersion = redisTemplate.opsForValue().get("version:" + key);
        if (redisVersion != null && redisVersion == local.getVersion()) {
            return local.getData();  // 版本一致，用本地
        }
        // 版本不一致，本地过期
        localCache.invalidate(key);
    }
    // ... 继续查 L2、L3
}
```

```
版本号方案的问题：每次读都要查 Redis 版本号（降性能，违背 L1 初衷）
适用：强一致需求（如金融配置），但牺牲部分性能
```

## 五、实战层：多级缓存完整实现

**Spring Boot 多级缓存配置**：

```java
@Configuration
@EnableCaching
public class MultiLevelCacheConfig {

    // L1：Caffeine 本地缓存
    @Bean
    public Cache<String, Object> caffeineCache() {
        return Caffeine.newBuilder()
            .maximumSize(10_000)
            .expireAfterWrite(30, TimeUnit.SECONDS)  // 30 秒 TTL（兜底）
            .recordStats()
            .build();
    }

    // L2：Redis
    @Bean
    public RedisTemplate<String, Object> redisTemplate(
            RedisConnectionFactory factory) {
        RedisTemplate<String, Object> template = new RedisTemplate<>();
        template.setConnectionFactory(factory);
        template.setKeySerializer(new StringRedisSerializer());
        template.setValueSerializer(new GenericJackson2JsonRedisSerializer());
        return template;
    }

    // 自定义多级缓存 Manager
    @Bean
    public CacheManager cacheManager(Cache<String, Object> caffeine,
                                      RedisTemplate<String, Object> redis) {
        return new MultiLevelCacheManager(caffeine, redis);
    }
}

// 多级缓存 Manager
public class MultiLevelCacheManager implements CacheManager {

    private final Cache<String, Object> l1;  // Caffeine
    private final RedisTemplate<String, Object> l2;  // Redis

    @Override
    public Cache getCache(String name) {
        return new MultiLevelCache(name, l1, l2);
    }
}

// 多级缓存实现
public class MultiLevelCache implements Cache {

    @Override
    public ValueWrapper get(Object key) {
        // L1
        Object value = l1.getIfPresent(key);
        if (value != null) return () -> value;
        // L2
        value = l2.opsForValue().get(key);
        if (value != null) {
            l1.put(key, value);  // 回种 L1
            return () -> value;
        }
        return null;  // 都 miss，触发 @Cacheable 的方法执行
    }

    @Override
    public void put(Object key, Object value) {
        l2.opsForValue().set(key, value, 300, TimeUnit.SECONDS);
        l1.put(key, value);
    }

    @Override
    public void evict(Object key) {
        l2.delete(key);       // 删 L2
        l1.invalidate(key);   // 删 L1
        broadcast(key);       // 广播通知其他实例删 L1
    }
}
```

## 六、实战层：热点 key 处理

**热点 key 识别**：

```bash
# Redis 4.0+ 热点 key 发现
redis-cli --hotkeys   # 需开启 maxmemory-policy = allkeys-lfu

# OBJECT FREQ 查看频率（LFU 编码时）
redis-cli OBJECT FREQ product:1001

# 监控连接 QPS（找热点）
redis-cli info clients | grep connected_clients
redis-cli info stats | grep instantaneous_ops_per_sec

# 业务层统计（埋点 TOP N）
# 应用层统计 key 访问频率，定期上报监控系统
```

**热点 key 多副本分散**（单 key 压力大时）：

```java
// 把热点 key 拆成多个副本（key:1, key:2, ...），分散到不同 Redis 分片
public class HotKeyService {

    private static final int REPLICA_COUNT = 10;

    public Product getHotProduct(Long skuId) {
        int replicaIndex = ThreadLocalRandom.current().nextInt(REPLICA_COUNT);
        String key = "product:" + skuId + ":" + replicaIndex;

        Product product = redisTemplate.opsForValue().get(key);
        if (product == null) {
            product = productMapper.selectById(skuId);
            redisTemplate.opsForValue().set(key, product, 60, TimeUnit.SECONDS);
        }
        return product;
    }

    // 更新时删所有副本
    public void updateHotProduct(Product product) {
        productMapper.updateById(product);
        for (int i = 0; i < REPLICA_COUNT; i++) {
            redisTemplate.delete("product:" + product.getSkuId() + ":" + i);
        }
        broadcast("product:" + product.getSkuId());  // 广播删本地
    }
}
```

**热点 key 走本地缓存**：

```java
// 热点 key 识别后，加入本地缓存白名单
@Cacheable(value = "hotProduct", key = "#skuId")  // 走 Caffeine（本地）
public Product getHotProduct(Long skuId) {
    return getProductFromRedis(skuId);  // 只在本地 miss 时查 Redis
}

// 效果：本地缓存挡 90% 流量，Redis QPS 从 10 万降到 1 万
```

## 七、底层本质：多级缓存的一致性边界

回到第一性：**多级缓存本质是"用一致性换性能"**。

- **为什么本地缓存有一致性问题**：每个应用实例的本地缓存独立（JVM 内存隔离），实例 A 更新了数据，实例 B 的本地缓存不知道，读到旧数据。这是"数据分散存储在多个节点"的固有难题。
- **为什么不能强一致**：强一致要同步通知所有实例（2PC），网络开销大，违背本地缓存"快"的初衷。多级缓存选弱一致——容忍短暂脏读（秒级），用 TTL 兜底。
- **一致性和性能的权衡**：
  - TTL 短（如 5s）：一致性好（脏读窗口小），但命中率低（频繁过期回源 Redis）。
  - TTL 长（如 5min）：命中率高，但脏读窗口大。
  - 广播失效：实时性好（秒级生效），但占带宽（每次更新广播）。
  - binlog 订阅：解耦（应用无感知），但延迟（Canal → MQ → 消费，秒级）。
- **工程实践**：大部分场景用 TTL（30s）+ 广播失效（MQ）组合——广播做实时，TTL 兜底。强一致需求（如价格、库存）不用本地缓存，直接 Redis 或 DB。

## 八、AI 架构师加问：5 个 AI 相关问题

1. **AI 推理结果用多级缓存怎么设计？**
   L1 本地缓存（Caffeine）存高频 prompt 的结果（纳秒级），L2 Redis 存全量 prompt 结果（毫秒级）。相似 prompt（embedding 相似度 >0.95）可复用缓存（用 embedding hash 做 key）。TTL 根据模型更新频率设。

2. **怎么用 AI 预测热点 key 提前预热？**
   AI 分析历史访问模式（如促销活动前某商品访问量激增）→ 预测未来热点 → 提前加载到本地缓存和 Redis。AI 还能识别"突发热点"（如社交媒体引爆某商品）→ 触发实时预热。

3. **让 AI 管理缓存 TTL，怎么设计？**
   AI 监控数据变更频率（如某 key 每小时变一次 vs 每天变一次）→ 动态调 TTL（频繁变更的短 TTL，稳定的短 TTL）。AI 还能预测访问模式（如夜间低峰 TTL 拉长）→ 优化命中率。但 AI 不直接改 TTL（风险高），给推荐由规则引擎执行。

4. **怎么用 AI 检测缓存异常？**
   AI 分析缓存命中率（突降可能 miss 风暴）、响应延迟（突增可能缓存失效回源 DB）、local cache 大小（突增可能内存泄漏）。AI 还能识别"低效缓存"（命中率低的 key 占大量空间，建议调优）。

5. **AI Agent 调用外部 API，怎么用多级缓存降成本？**
   AI Agent 调用付费 API（如天气、汇率），结果缓存到 L1（本地）+ L2（Redis）。相同请求复用缓存（如同一城市天气 10 分钟内复用）。相似请求模糊匹配（如"北京天气"和"BJ 天气"复用）。大幅降 API 调用成本。

## 九、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"L1 Caffeine、L2 Redis、一致性四方案、热点 key 本地挡"**。

- **三级**：L1 Caffeine（纳秒）→ L2 Redis（毫秒）→ L3 DB
- **Caffeine**：W-TinyLFU 算法，命中率比 LRU 高 30%
- **一致性**：TTL（简单）/ 广播（Pub-Sub+MQ）/ binlog（Canal）/ 版本号（强一致）
- **读**：逐级查，miss 回种（加锁防击穿）
- **写**：更新 DB → 删 Redis → 广播删本地
- **热点 key**：本地缓存挡流量，Redis QPS 降一个数量级

### 拟人化理解

把多级缓存想成**图书馆借阅体系**。L1 是"你桌上摊开的书"（最快但只有你有），L2 是"楼层书架"（同事也能看，慢一点），L3 是"总馆仓库"（最慢最全）。更新一本书怎么保证别人桌上旧版也更新？TTL 是"规定书上架 10 分钟必须换新版"（到期前别人可能看旧版，脏读窗口=TTL）。广播失效是"大喇叭喊'书更新了，大家把旧版扔了'"（实时但占带宽，漏喊就没更新）。版本号是"每次看书先核对版本号"（最准但每次都要核对，麻烦）。binlog 订阅是"仓库管理员发现书更新，自动通知所有楼层"（解耦但延迟）。生产实践：大喇叭（MQ 广播）做实时 + 规定 30 分钟必须换版（TTL 兜底），即使大喇叭漏了，30 分钟后也会自然更新。

### 面试现场 60 秒回答

> 多级缓存是 L1 本地缓存（Caffeine，纳秒级，JVM 内存）+ L2 Redis（毫秒级，集中式）+ L3 DB。L1 用 Caffeine 的 W-TinyLFU 算法（比 LRU 命中率高 30%，抗扫描污染）。读流程逐级查（L1→L2→L3），miss 时回种（DB 查到后回种 L2 和 L1）。写流程更新 DB → 删 Redis → 广播通知所有实例删本地缓存。一致性是核心难题——本地缓存各实例独立，更新怎么通知所有实例失效。四种方案：①TTL 短过期（最简单，脏读窗口=TTL）；②广播失效（Redis Pub/Sub 或 MQ，近实时）；③binlog 订阅（Canal 监听 DB，解耦）；④版本号校验（强一致但每次读 Redis 降性能）。生产推荐 TTL（30s）+ MQ 广播组合——广播做实时，TTL 兜底。热点 key 用本地缓存挡流量（Redis QPS 降一个数量级），或用多副本分散（key 拆 10 份分散到不同分片）。缓存击穿用互斥重建（分布式锁 + 双重检查），雪崩用随机 TTL。

### 反问面试官

> 贵司用多级缓存吗？L1 用 Caffeine 还是别的？本地缓存一致性怎么解决的（TTL/广播/binlog）？有没有监控缓存命中率、有没有做过缓存优化？

## 十、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不用纯 Redis，要加本地缓存？ | 用性能说话：Redis 是毫秒级（网络 IO），本地缓存是纳秒级（快 1 万倍）。热点 key 场景单 Redis 扛不住（单分片 QPS 打满）。本地缓存挡 80%+ 流量，Redis 降一个数量级。Redis 故障时本地兜底（降级保护） |
| 证据追问 | 怎么知道多级缓存效果好？ | 用监控数据说话：L1 命中率（Caffeine.stats()，应 >80%）、L2 命中率（Redis INFO stats）、DB QPS（应降 90%+）、接口 P99 延迟（应降 10 倍）。压测对比纯 Redis vs 多级缓存的 QPS 和延迟 |
| 边界追问 | 本地缓存能保证数据一致吗？ | 不能保证强一致。本地缓存各实例独立，更新有传播延迟。最坏情况：广播丢失 → TTL 过期前读到旧数据（脏读窗口=TTL）。要强一致用版本号校验（降性能）或不用本地缓存直接 Redis |
| 反例追问 | 什么场景不该用本地缓存？ | 强一致需求（价格、库存，脏读不可接受）、数据频繁变更（本地缓存频繁失效，不如直查 Redis）、多实例共享频繁（本地缓存独立反而增加不一致风险）、内存紧张（Caffeine 占 JVM 内存） |
| 风险追问 | 多级缓存上线最大风险？ | 主动点出：一致性（广播丢失导致脏读）、内存泄漏（Caffeine 配置不当占满 JVM）、雪崩（本地缓存同时过期回源 Redis 打爆）、击穿（热点 key 过期瞬间并发重建）。要理解每个风险的触发条件和应对 |
| 验证追问 | 怎么验证多级缓存有效？ | 监控 L1/L2/DB 各层 QPS（应逐层递减）、命中率（L1 应 >80%）、P99 延迟（应 <1ms）。混沌工程：kill Redis 验证本地缓存兜底、压测验证高并发不回源 DB |
| 沉淀追问 | 缓存治理规范，沉淀什么？ | 缓存使用 SOP（什么数据进 L1/L2/L3）、TTL 规范（按业务一致性需求定）、一致性方案选型（TTL/广播/binlog 的适用场景）、监控大盘（命中率/QPS/延迟）、热点 key 处理预案（本地缓存/多副本） |

### 现场对话示例

**面试官**：多级缓存的一致性怎么保证？

**候选人**：这是多级缓存的核心难题。本地缓存各实例独立——实例 A 更新了数据，实例 B 的本地缓存不知道，会读到旧数据。解法有四种。第一，TTL 短过期——Caffeine 设短 TTL（如 10 秒），脏读窗口最多 10 秒。最简单，但脏读窗口存在。第二，广播失效——更新数据时发广播（Redis Pub/Sub 或 MQ），所有实例收到后删本地缓存。近实时（秒级生效），但 Pub/Sub 消息不持久（订阅者不在线就丢）。第三，binlog 订阅——Canal 监听 DB binlog 变更，发 MQ 通知所有实例。解耦（应用无感知），但延迟（Canal→MQ→消费，秒级）。第四，版本号校验——本地缓存带版本号，读时比对 Redis 版本号，不一致则更新。强一致但每次读 Redis 降性能（违背本地缓存初衷）。生产实践推荐 TTL + MQ 广播组合——MQ 广播做实时（保证消息不丢），TTL 兜底（即使广播丢失，TTL 到期也一致）。比如 TTL 设 30 秒，广播秒级生效，最坏情况广播全丢，30 秒后 TTL 过期也一致。强一致需求（如价格、库存）不用本地缓存，直接查 Redis 或 DB，避免一致性问题。

**面试官**：Caffeine 的 W-TinyLFU 比 LRU 好在哪？

**候选人**：W-TinyLFU 解决了 LRU 的两个痛点。第一，抗扫描污染——LRU 遇到批量扫描（如一次性遍历所有商品），扫描数据会挤掉热点 key，导致命中率骤降。W-TinyLFU 用 TinyLFU 准入区（Count-Min Sketch 频率统计），新 key 进来时先判断频率，低频 key 直接丢弃（不进主缓存），保护热点 key 不被扫描数据挤掉。第二，抗突发——传统 LFU（最少频率）的问题是新热点上来慢（历史高频 key 长期占位）。W-TinyLFU 的 Window 区（20% 内存，LRU）接住新 key，给新热点机会。如果新热点持续被访问，频率上升，TinyLFU 会让它进入主缓存。结构上 W-TinyLFU 分三部分：Window（20%，LRU，接新 key）→ TinyLFU（准入判断，Count-Min Sketch）→ Main（80%，SLRU，分 Protected 80% 和 Probation 20%）。效果：在 Arc、Search、Loop 等基准测试中，命中率比 LRU 高 30% 以上，特别是扫描和突发流量场景。新项目用 Caffeine（W-TinyLFU），老项目 Guava Cache 仍可用但建议迁移。

**面试官**：缓存击穿怎么处理？

**候选人**：缓存击穿是"热点 key 过期瞬间，大量并发请求同时回源 DB"。比如商品详情页的爆款商品，缓存过期那一瞬间，几万请求同时查 DB，DB 瞬间被打爆。解法是互斥重建（Mutex）。流程：请求发现缓存 miss → 抢分布式锁（Redisson tryLock）→ 只有一个请求查 DB 重建缓存 → 其他请求等待（或短暂 sleep 后重试读缓存）→ 重建完成后释放锁 → 后续请求直接读缓存。关键细节：双重检查（拿到锁后先再查一次缓存，可能别人已经重建好了，避免重复查 DB）、锁超时（防持有者宕机死锁）、降级策略（等不到锁的请求返回旧数据或默认值）。Caffeine 原生支持：get(key, mapping) 方法内置 sync 锁，同一个 key 只有一个线程查 DB。Spring 的 @Cacheable(sync=true) 也是这个原理。另一个解法是"永不过期"——缓存不设 TTL（逻辑过期），后台异步刷新。适合极热 key（如首页推荐），但要管理刷新时机（定时任务或访问时触发）。生产推荐互斥重建（通用、简单），永不过期用于极热 key（如秒杀商品）。

## 常见考点

1. **Caffeine 和 Guava Cache 区别？**——Caffeine 是 Guava Cache 作者的新作，算法升级（W-TinyLFU vs LRU，命中率高 30%+）、性能更高（并发优化）、异步刷新。新项目用 Caffeine，Spring Boot 2.0+ 默认推荐 Caffeine。
2. **本地缓存的内存怎么控制？**——Caffeine 用 maximumSize（条数）或 maximumWeight（权重，按 value 大小）。监控 JVM 内存（Caffeine 占用部分堆），避免 OOM。大 value（如 MB 级）慎用本地缓存，用 Redis。
3. **多级缓存降级策略？**——Redis 故障时本地缓存兜底（虽然数据旧但有响应）；DB 故障时返回降级数据（如默认推荐、缓存旧数据）。用 Hystrix/Sentinel 做熔断，Redis 连续失败 N 次切降级。
4. **缓存预热怎么做？**——系统启动时加载热点 key 到缓存（@PostConstruct 或 ApplicationRunner）；定时任务定期刷新（如每 5 分钟）；促销活动前手动触发预热（管理后台接口）。避免启动瞬间大量请求打 DB。
5. **多级缓存的监控指标？**——L1 命中率（Caffeine.stats()）、L2 命中率（Redis INFO）、DB QPS、接口 P99 延迟、local cache 内存占用、缓存大小（条数）。监控要分层（L1/L2/DB 各自指标），定位问题（命中率低调 TTL/容量）。


## 结构化回答

**30 秒电梯演讲：** 聊到本地缓存与多级缓存一致性，我的理解是——多级缓存的本质是"用空间换时间，用层级换性能"。L1 本地缓存（Caffeine，应用内存，纳秒级）→ L2 集中式缓存（Redis，毫秒级）→ L3 DB。每层性能差 2-3 个数量级。核心难题是"一致性"——本地缓存各实例独立，更新如何通知所有实例失效？解法有四：TTL 过期（简单但有脏读窗口）、广播失效（Redis Pub/Sub 或 MQ）、binlog 订阅（Canal 监听 DB 变更）、版本号校验（强一致但复杂）。打个比方，像图书馆的书籍借阅体系。L1 是"你桌上的书"（最快，但只有你有），L2 是"楼层书架"（同事也能看，慢一点），L3 是"总馆仓库"（最慢最全）。你更新了一本书的内容，怎么保证别人桌上那本旧版也更新？TTL 是"规定书上架 10 分钟必须换新版"（到期前别人可能看旧版）。广播失效是"大喇叭喊一声'书更新了，大家把旧版扔了'"（实时但占带宽）。版本号是"每次看书先核对版本号"（最准但麻烦）。

**展开框架：**
1. **L1 Caffeine** — W-TinyLFU 算法，命中率比 LRU 高，纳秒级访问
2. **L2 Redis** — 全量缓存，毫秒级，集中式
3. **一致性方案** — TTL / 广播失效（Pub-Sub/MQ）/ binlog 订阅 / 版本号

**收尾：** 这块我在项目里也踩过坑——想深入的话，可以接着聊：本地缓存和分布式缓存什么区别？您更想看哪个方向？

## 视频脚本

> 预计时长：4 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡 | "本地缓存与多级缓存一致性——这道题面试官到底想考什么？我用 30 秒给你讲透。" | 开场钩子 |
| 0:15 | 多级缓存架构图 | 先说核心：多级缓存的本质是"用空间换时间，用层级换性能"。L1 本地缓存（Caffeine，应用内存，纳秒级）→ L2 集中式缓存（Redis，毫秒级）→ L3 DB。每层性能差 2-3。 | 核心定义 |
| 0:50 | Redis 数据结构图 | 全量缓存，毫秒级，集中式。 | L2 Redis |
| 1:20 | 一致性协议对比表 | TTL / 广播失效（Pub-Sub/MQ）/ binlog 订阅 / 版本号。 | 一致性方案 |
| 1:50 | 概念结构示意图 | 互斥重建（防并发重建）。 | 缓存击穿 |
| 3:30 | 总结卡 | 一句话记忆：L1 Caffeine（本地）→ L2 Redis（集中）→ L3 DB。 下期可以接着聊：本地缓存和分布式缓存什么区别。 | 收尾总结 |
