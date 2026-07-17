---
id: java-architect-026
difficulty: L2
category: java-architect
subcategory: Redis
tags:
- Redis
- 缓存
- 一致性
feynman:
  essence: 缓存模式的本质是"用空间换时间——把热点数据放内存加速读取"。Cache-Aside（旁路缓存）是业务代码同时管理缓存和 DB（先查缓存，miss 查 DB 回填）；Read-Through/Write-Through 是缓存层代理 DB 访问；Write-Behind 是异步写 DB。一致性问题的本质是"缓存和 DB 是两个系统，无法原子更新"，兜底靠"延迟双删 + TTL + 订阅 binlog 主动失效"。
  analogy: 像图书馆的"热门书架 + 深度书库"。热门书架（缓存）放借阅多的书（热点数据），深度书库（DB）放所有书。学生借书先查热门书架（Cache 读），没有再去深度书库取并放一本到热门书架（回填）。新书入库时（写），先放深度书库再更新热门书架（一致性）——但这两步非原子，中间有人借可能读到旧版。
  first_principle: 为什么要缓存？因为内存访问比磁盘快 10 万倍（纳秒 vs 毫秒），热点数据放内存能把读延迟从几十毫秒降到亚毫秒。代价是缓存和 DB 一致性维护（两个系统非原子）和内存成本（贵）。
  key_points:
  - Cache-Aside（最常用）：读先查缓存 miss 查 DB 回填；写先更 DB 再删缓存
  - 一致性策略：先更 DB 后删缓存（推荐）、延迟双删、订阅 binlog 主动失效
  - 为什么删缓存而不是更新缓存：避免并发更新导致数据不一致、避免频繁更新无人读的缓存（浪费）
  - 三大问题：穿透（查不存在）、击穿（热点过期）、雪崩（大量过期）—— 见 027 题
  - 缓存淘汰：LRU（最近最少用）、LFU（最不常用）、TTL 过期
first_principle:
  problem: 如何用内存缓存加速读，同时保证缓存与 DB 的一致性？
  axioms:
  - 内存访问比磁盘快 10 万倍，热点数据放内存大幅降延迟
  - 缓存和 DB 是两个系统，无法原子更新（除非分布式事务，代价大）
  - 大部分业务能容忍短暂不一致（最终一致），强一致回源 DB
  rebuild: 用 Cache-Aside 模式——读先查缓存，miss 查 DB 并回填缓存（带 TTL）；写先更新 DB 再删缓存（不是更新缓存）。删缓存而非更新避免并发不一致和资源浪费。一致性兜底：延迟双删（写后删 + 延迟再删防旧值回填）、TTL（最终一致兜底）、订阅 binlog（Canal 监听 DB 变更主动失效缓存）。强一致场景（如资金）绕过缓存直接读 DB。缓存淘汰用 LRU（热点保留）+ TTL（过期兜底）。
follow_up:
  - 为什么写操作删缓存而不是更新缓存？——两个原因。第一，并发更新缓存可能数据不一致（A 先更新 DB 但后更新缓存，B 后更新 DB 但先更新缓存，缓存存了 A 的旧值）。第二，有些缓存更新了没人读（浪费写）。删缓存是惰性的——下次读 miss 时回填最新值，简单且一致
  - 延迟双删是什么？——写操作时先删缓存、再更新 DB、再延迟一段时间（如 500ms）再删一次缓存。第二次删除防止"更新 DB 期间旧数据被其他读请求回填到缓存"。延迟时间要大于一次读请求的耗时（DB 查询 + 缓存回填）
  - Cache-Aside 的不一致窗口多大？——写操作"先更 DB 后删缓存"之间有不一致窗口（DB 新值但缓存旧值），通常毫秒级。如果删缓存失败，不一致持续到 TTL 过期。所以删缓存失败要重试（或订阅 binlog 兜底）
  - 订阅 binlog 失效缓存怎么实现？——用 Canal/Debezium 监听 MySQL binlog，DB 变更时发消息到 MQ，消费方删除对应缓存。优点是业务代码不关心缓存失效（解耦），缺点是引入中间件增加复杂度
  - 多级缓存一致性怎么保证？——本地缓存（Caffeine）+ 分布式缓存（Redis）+ DB。本地缓存一致性最难（多实例各有缓存），用 Redis Pub/Sub 广播失效消息，或订阅 binlog 失效所有实例。见 030 题
memory_points:
  - Cache-Aside（最常用）：读 miss 查 DB 回填；写先更 DB 后删缓存
  - 一致性：先更 DB 后删缓存（推荐）、延迟双删、订阅 binlog
  - 删缓存而非更新（防并发不一致、防浪费）
  - 不一致窗口：删缓存失败靠 TTL + binlog 兜底
  - 强一致场景绕过缓存直读 DB
---

# 【Java 后端架构师】Redis 缓存模式与一致性治理

> 适用场景：JD 核心技术。商品详情页读 QPS 10 万，没有缓存 DB 直接被打爆。缓存和 DB 不一致就是用户看到错误价格。架构师必须能选缓存模式、设计一致性方案、处理删缓存失败——这是高并发读场景的标配。

## 一、概念层：四大缓存模式

**缓存模式对比**（面试必考）：

| 模式 | 读流程 | 写流程 | 一致性 | 适用 |
|------|--------|--------|--------|------|
| **Cache-Aside（旁路）** | 查缓存→miss 查 DB→回填 | 更 DB→删缓存 | 最终一致 | 最常用 |
| **Read-Through** | 缓存层代理读 DB（miss 自动加载） | 同 Cache-Aside | 最终一致 | 缓存封装 |
| **Write-Through** | 同步 | 更缓存→缓存同步更 DB | 强一致 | 写少读多 |
| **Write-Behind（Write-Back）** | 同 Read-Through | 更缓存→异步更 DB | 弱一致 | 写密集 |

**Cache-Aside 详细流程**（画图必考）：

```
读流程：
  Client ──► Cache Hit? ──Yes──► 返回缓存值
               │
               No (miss)
               │
               ▼
            查 DB
               │
               ▼
            回填 Cache（带 TTL）
               │
               ▼
            返回 DB 值

写流程：
  Client ──► 更新 DB
               │
               ▼
            删除 Cache（不是更新！）
               │
               ▼
            返回成功
```

**Cache-Aside 代码**：

```java
@Service
public class ProductService {

    @Autowired
    private RedisTemplate<String, Product> redisTemplate;
    @Autowired
    private ProductMapper productMapper;

    // 读：先缓存后 DB
    public Product getProduct(Long id) {
        String key = "product:" + id;
        Product product = redisTemplate.opsForValue().get(key);
        if (product != null) {
            return product;   // 缓存命中
        }
        // miss，查 DB
        product = productMapper.selectById(id);
        if (product != null) {
            redisTemplate.opsForValue().set(key, product, 30, TimeUnit.MINUTES);  // 回填 + TTL
        }
        return product;
    }

    // 写：先更 DB 后删缓存
    @Transactional
    public void updateProduct(Product product) {
        productMapper.update(product);                    // 1. 更新 DB
        redisTemplate.delete("product:" + product.getId()); // 2. 删除缓存
    }
}
```

## 二、机制层：一致性问题与方案

**为什么有一致性问题**（画图理解）：

```
问题 1：先更缓存后更 DB（错误顺序）
  T1: 更新缓存 product:1 = 新值
  T2: 读取缓存 product:1 = 新值（但 DB 还是旧值！）  ← 不一致
  T1: 更新 DB product = 新值
  ── 缓存有新值 DB 有旧值的窗口，且如果 T1 更新 DB 失败，缓存永久不一致

问题 2：先更 DB 后更缓存（并发不一致）
  T1: 更新 DB product:1 = A（先）
  T2: 更新 DB product:1 = B（后，DB 现在是 B）
  T2: 更新缓存 product:1 = B（先）
  T1: 更新缓存 product:1 = A（后，缓存现在是 A）
  ── DB 是 B 缓存是 A，永久不一致！

正确的方案：先更 DB 后删缓存
  T1: 更新 DB product:1 = 新值
  T1: 删除缓存 product:1
  ── 下次读 miss 查 DB 回填新值，最终一致
```

**为什么删缓存而非更新缓存**：

1. **避免并发不一致**：更新缓存在并发场景下可能"后写先到"导致数据错乱（如上问题 2）。删缓存是幂等的（删多次效果一样），且下次读自动回填最新值。
2. **避免资源浪费**：有些缓存更新了没人读（如写后很久才读），更新操作浪费。删缓存是惰性的——读的时候才回填。
3. **一致性简单**：删缓存 + 下次读回填，天然保证"缓存值 = DB 值"（回填时从 DB 读最新）。

**延迟双删**（解决删缓存后的短暂不一致）：

```java
@Transactional
public void updateProduct(Product product) {
    productMapper.update(product);                       // 1. 更新 DB
    redisTemplate.delete("product:" + product.getId());  // 2. 第一次删缓存
    // 3. 延迟再删（防旧值回填）
    executor.schedule(() -> {
        redisTemplate.delete("product:" + product.getId());
    }, 500, TimeUnit.MILLISECONDS);  // 延迟 > 一次读耗时
}
```

**为什么需要延迟双删**：

```
场景：T1 更新，T2 读
  T1: 更新 DB product:1 = 新值
  T2: 读缓存 miss（已被 T1 第一次删）
  T2: 查 DB ...（但 T1 还没提交事务，T2 读到旧值！）  ← 旧值
  T1: 提交事务
  T1: 第一次删缓存
  T2: 回填缓存 product:1 = 旧值  ← 缓存是旧值！

延迟双删的第二次删除解决这个问题：
  T1: 延迟 500ms 后再删一次缓存 product:1
  ── 把 T2 回填的旧值删掉，下次读重新从 DB 读最新值
```

**订阅 binlog 主动失效**（最终一致兜底）：

```
MySQL binlog → Canal/Debezium → MQ → 缓存失效服务 → 删除 Redis

优点：
  - 业务代码不关心缓存失效（解耦）
  - 保证最终一致（binlog 是 DB 变更的真实记录）
  - 删缓存失败可重试（MQ 重试机制）

缺点：
  - 引入中间件（Canal + MQ），增加复杂度
  - 有延迟（binlog 同步 + MQ 投递，秒级）

适用：对一致性要求高、缓存量大（手动删易漏）
```

```java
// Canal 监听 binlog 失效缓存
@Component
@RocketMQMessageListener(topic = "canal-product-change")
public class CacheInvalidationListener implements RocketMQListener<CanalMessage> {

    @Override
    public void onMessage(CanalMessage msg) {
        if (msg.getTable().equals("product")) {
            for (Map<String, String> row : msg.getData()) {
                String id = row.get("id");
                redisTemplate.delete("product:" + id);   // 失效缓存
            }
        }
    }
}
```

## 三、实战层：一致性方案选型

**一致性方案对比**：

| 方案 | 一致性 | 复杂度 | 延迟 | 适用 |
|------|--------|--------|------|------|
| 先更 DB 后删缓存 | 最终一致 | 低 | 毫秒 | 大部分场景 |
| 延迟双删 | 最终一致 | 中 | +延迟 | 高并发写 |
| 订阅 binlog | 最终一致 | 高 | 秒级 | 强一致需求 |
| 加锁（分布式锁） | 强一致 | 高 | 锁等待 | 极少用（性能差） |
| 绕过缓存直读 DB | 强一致 | 低 | DB 延迟 | 资金/库存 |

**选型建议**：

```java
// 大部分业务：先更 DB 后删缓存 + TTL 兜底
@Transactional
public void update(Product p) {
    productMapper.update(p);
    redisTemplate.delete(key(p.getId()));
}
// 缓存设 TTL（如 30 分钟），即使删缓存失败，TTL 过期后自动一致

// 高并发写：延迟双删
@Transactional
public void updateWithDoubleDelete(Product p) {
    productMapper.update(p);
    redisTemplate.delete(key(p.getId()));
    scheduleDeleteAfter(key(p.getId()), 500);  // 延迟 500ms 再删
}

// 强一致需求（如价格）：订阅 binlog 主动失效 + 短 TTL
// + 关键查询直读 DB（绕过缓存）

// 资金/库存：绕过缓存，直接操作 DB（强一致）
public BigDecimal getBalance(Long userId) {
    return accountMapper.selectBalance(userId);  // 直读 DB，不查缓存
}
```

## 四、实战层：缓存淘汰策略

**Redis 淘汰策略**（maxmemory-policy）：

| 策略 | 含义 | 适用 |
|------|------|------|
| **noeviction** | 不淘汰，写报错 | 不能丢数据 |
| **allkeys-lru** | 所有 key 按 LRU 淘汰 | 通用推荐 |
| **volatile-lru** | 设了 TTL 的 key 按 LRU 淘汰 | 混合场景（部分持久） |
| **allkeys-lfu** | 按 LFU（最不常用）淘汰 | 热点明显 |
| **volatile-ttl** | 优先淘汰快过期的 | TTL 敏感 |
| **allkeys-random** | 随机淘汰 | 无差别 |

**淘汰策略选型**：
- 纯缓存场景：`allkeys-lru`（热点保留，冷数据淘汰）
- 缓存 + 持久数据混合：`volatile-lru`（只淘汰设了 TTL 的）
- 热点明显：`allkeys-lfu`（LFU 比 LRU 更精准识别热点）

**Spring Cache + Redis 用法**：

```java
@Service
@CacheConfig(cacheNames = "products")   // 统一配置缓存名
public class ProductService {

    @Cacheable(key = "#id")   // 查缓存，miss 执行方法后回填
    public Product getProduct(Long id) {
        return productMapper.selectById(id);   // miss 时执行
    }

    @CacheEvict(key = "#product.id")   // 方法执行后删缓存
    @Transactional
    public void updateProduct(Product product) {
        productMapper.update(product);
    }

    @CacheEvict(allEntries = true)   // 清空整个缓存名下所有 key
    public void clearCache() { }
}
```

## 五、底层本质：CAP 与缓存一致性

回到第一性：**缓存一致性问题的本质是"缓存和 DB 是两个独立系统，无法原子更新"**。

- **为什么不原子**：要原子更新缓存和 DB 需要分布式事务（两阶段提交），但缓存（Redis）和 DB（MySQL）是不同系统，XA 性能差不可行。所以接受"短暂不一致"（最终一致），用各种策略缩小不一致窗口。
- **先更 DB 后删缓存的正确性**：这种顺序下，最坏情况是"删缓存失败"——缓存还是旧值，但 DB 是新值。靠 TTL 过期或重试删缓存最终一致。而"先删缓存后更 DB"最坏情况是"读请求在删缓存后、更 DB 前查 DB 读到旧值并回填缓存"，导致缓存长期是旧值（直到 TTL 过期）。所以先更 DB 后删缓存更安全。
- **删缓存而非更新的本质**：删是幂等操作（多次删效果一样），更新不是（并发更新顺序敏感）。删把"保证缓存正确"延迟到"下次读时回填"，回填时一定从 DB 读最新值，天然一致。
- **强一致的代价**：要强一致只能绕过缓存（直读 DB）或用分布式锁（读写互斥）。前者失去缓存加速意义，后者性能差。所以缓存场景接受最终一致，强一致需求绕过缓存。

**Cache-Aside 为什么是主流**：它简单（业务代码管理）、解耦（缓存挂了不影响 DB）、灵活（可针对不同场景定制）。Read-Through/Write-Through 要缓存层支持（如 Redis Cluster 的 proxy），通用性差。Write-Behind 异步写 DB 有丢数据风险，极少用。所以生产 90% 用 Cache-Aside。

## 六、AI 架构师加问：5 个 AI 相关问题

1. **AI 推理结果的缓存怎么设计？**
   推理结果（如用户画像、推荐列表）按 user_id 缓存到 Redis，TTL 视更新频率定（如实时推荐 TTL 5 分钟，离线画像 TTL 1 小时）。写时先更 DB（落库）后删缓存。大对象（如 embedding 向量）单独存向量库，Redis 只存元数据和短结果。

2. **让 AI 管理 TTL，AI 接管哪段？**
   AI 分析数据访问模式和更新频率 → 推荐不同 key 的 TTL（热点数据长 TTL，冷数据短 TTL）。AI 还能动态调整 TTL（如大促前延长热点 TTL）。变更走配置中心热更新，不用发版。

3. **怎么用 AI 检测缓存不一致？**
   AI 定期抽样对比缓存值和 DB 值（如随机选 1000 个 key 比对）→ 统计不一致率 → 超阈值告警。AI 还能分析不一致根因（删缓存失败、并发写、TTL 配置不当）→ 推荐修复。

4. **AI 知识库（RAG）的缓存一致性？**
   RAG 的文档更新后要重新 embedding。一致性方案：文档更新（DB）→ 发消息触发重新 embedding → 更新向量库 + 删除旧缓存。检索时可能短暂读到旧向量（最终一致），对 RAG 可接受（知识更新容忍秒级延迟）。

5. **AI 推理结果落 DB 和缓存怎么保证一致？**
   推理服务先写 DB（强一致本地事务）→ 删缓存（延迟双删防旧值回填）。如果推理结果立即被查询（如推理后展示），用延迟双删或订阅 binlog 失效。关键认知：推理结果本身是"近似值"（模型输出），容忍秒级缓存不一致，不需要强一致。

## 七、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"Cache-Aside、先更 DB 后删缓存、延迟双删、binlog 失效、TTL 兜底"**。

- **Cache-Aside**：读 miss 查 DB 回填，写先更 DB 后删缓存（最常用）
- **删缓存而非更新**：防并发不一致、防浪费
- **延迟双删**：写后删 + 延迟 500ms 再删（防旧值回填）
- **订阅 binlog**：Canal 监听 DB 变更主动失效缓存（最终一致兜底）
- **TTL 兜底**：即使删缓存失败，TTL 过期自动一致
- **强一致**：绕过缓存直读 DB（资金/库存）

### 拟人化理解

把缓存想成**图书馆热门书架**。热门书架（缓存）放借阅多的书（热点数据），深度书库（DB）放所有书。学生借书先查热门书架（Cache 读），没有再去深度书库取并放一本到热门书架（回填）。新书入库（写）时，先放深度书库（更 DB）再从热门书架撤掉旧版（删缓存）——为什么撤而不是换新版？因为换新版时可能多人同时换导致错乱（并发不一致），撤掉让下次借的人自己去深度书库取最新版（回填）。延迟双删是"入库后过半小时再检查一遍热门书架有没有旧版"（防旧版被回填）。TTL 是"书架上每本书放一个月自动撤"（过期兜底）。

### 面试现场 60 秒回答

> 缓存模式主流是 Cache-Aside——读先查缓存 miss 查 DB 回填（带 TTL），写先更 DB 后删缓存。为什么删而不是更新？因为更新在并发下可能"后写先到"导致数据错乱，删是幂等的且下次读自动回填最新值。一致性方案：大部分场景用"先更 DB 后删缓存 + TTL 兜底"（简单有效）；高并发写用延迟双删（写后删 + 延迟 500ms 再删防旧值回填）；强一致需求用订阅 binlog 主动失效缓存（Canal 监听 DB 变更删缓存）。资金/库存类强一致场景绕过缓存直读 DB。缓存淘汰用 allkeys-lru（热点保留冷数据淘汰）。缓存和 DB 是两个系统无法原子更新，接受最终一致，用各种策略缩小不一致窗口。

### 反问面试官

> 贵司缓存和 DB 一致性怎么处理（手动删/binlog 订阅）？有没有遇到过缓存不一致导致的事故（如价格错误）？缓存命中率多少？淘汰策略用 LRU 还是 LFU？

## 九、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不全部用缓存，还要 DB？ | 用成本说话：内存比磁盘贵 100 倍，全量数据放内存成本不可接受。缓存只放热点（20% 数据承载 80% 访问），DB 存全量。且缓存易失（重启丢），DB 持久化是数据源头 |
| 证据追问 | 缓存和 DB 不一致你怎么发现？ | 定期抽样对比（随机选 key 比对缓存值和 DB 值）；监控缓存命中率（骤降可能不一致）；用户反馈（看到旧数据）；对账系统（关键数据校验） |
| 边界追问 | Cache-Aside 能保证强一致吗？ | 不能。本质是两个系统无法原子更新。要强一致只能绕过缓存直读 DB，或用分布式锁读写互斥（性能差）。缓存场景接受最终一致，强一致需求绕过缓存 |
| 反例追问 | 什么场景不该用缓存？ | 强一致需求（资金/库存，绕过缓存）；数据访问无热点（全随机访问，缓存命中率低无收益）；写多读少（缓存频繁失效）；数据量小（直查 DB 够快） |
| 风险追问 | 缓存上线后最大风险？ | 主动点出：缓存与 DB 不一致（用户感知异常）、缓存穿透/击穿/雪崩（见 027 题）、缓存数据过期导致 DB 瞬间高压、Redis 宕机导致全量回源、热点 key 单点瓶颈 |
| 验证追问 | 怎么证明缓存设计合理？ | 缓存命中率（应 > 80%）；缓存与 DB 不一致率（应 < 0.01%）；缓存响应延迟 P99（应 < 1ms）；DB 回源率（应低）；压测验证高并发下一致性 |
| 沉淀追问 | 团队缓存治理规范，沉淀什么？ | 缓存 key 命名规范（业务:实体:ID）、TTL 设置规范（按数据类型）、一致性方案 SOP（Cache-Aside/延迟双删/binlog）、缓存监控大盘（命中率/内存/淘汰）、缓存穿透防护规范 |

### 现场对话示例

**面试官**：写操作为什么删缓存而不是更新缓存？

**候选人**：两个原因。第一，并发更新缓存可能数据不一致。假设两个写请求 T1 和 T2，T1 先更新 DB（值 A）但后更新缓存，T2 后更新 DB（值 B）但先更新缓存。执行顺序：T1 更 DB=A → T2 更 DB=B → T2 更缓存=B → T1 更缓存=A。结果 DB 是 B 缓存是 A，永久不一致。如果改成删缓存，删除是幂等的（删多次一样），且下次读自动从 DB 读最新值回填，天然一致。第二，更新缓存可能浪费。如果一个数据写了但很久没人读，更新缓存的开销就是浪费（写了个没人看的值）。删缓存是惰性的——读的时候才回填。所以删缓存既避免并发不一致又避免浪费，是最佳实践。

**面试官**：先更 DB 后删缓存，如果删缓存失败怎么办？

**候选人**：删缓存失败会导致缓存一直是旧值（直到 TTL 过期）。兜底方案三层。第一层，重试——删缓存失败时重试几次（如 Redis 短暂网络抖动）。第二层，TTL 兜底——缓存设了 TTL（如 30 分钟），即使删失败，TTL 过期后缓存自动失效，下次读重新从 DB 读最新值。这是最终一致的保证。第三层，订阅 binlog——用 Canal 监听 DB binlog，DB 变更时主动删缓存，不依赖业务代码的删操作。即使业务代码删失败，binlog 订阅会兜底删。所以生产实践是"先更 DB 后删缓存 + 重试 + TTL + binlog 兜底"，多重保障。如果还担心，可以加监控——定期抽样对比缓存值和 DB 值，不一致率超阈值告警人工介入。

**面试官**：延迟双删的延迟时间怎么定？

**候选人**：延迟时间要大于"一次读请求的耗时"。原因：延迟双删是为了防止"读请求在 DB 更新期间读到旧值并回填缓存"。具体场景：T1 更新 DB（事务未提交），T2 读缓存 miss，T2 查 DB 读到旧值（T1 未提交），T1 提交，T1 删缓存，T2 回填旧值到缓存。延迟双删的第二次删除要把 T2 回填的旧值删掉。延迟时间必须大于 T2 的完整耗时（从查 DB 到回填缓存），否则第二次删了之后 T2 才回填，旧值又进缓存了。一次读请求耗时通常包括：DB 查询（几毫秒）+ 网络往返（几毫秒）+ 缓存回填（几毫秒），总共 10-50 毫秒。所以延迟设 200-500 毫秒比较安全（留足余量）。如果读请求涉及复杂查询（如多表 JOIN），耗时可能上百毫秒，延迟要相应加大。另外延迟双删可以用异步线程或延迟队列实现，不阻塞写请求返回。

## 常见考点

1. **缓存穿透/击穿/雪崩区别？**——穿透是查不存在的数据（缓存和 DB 都没有），击穿是热点 key 过期瞬间大量请求打 DB，雪崩是大量 key 同时过期导致 DB 瞬间高压。防护见 027 题（布隆过滤器、互斥重建、TTL 加随机）。
2. **Read-Through 和 Cache-Aside 区别？**——Cache-Aside 是业务代码管理缓存（查缓存 miss 查 DB 回填，都由业务代码写）。Read-Through 是缓存层代理 DB 访问（业务只查缓存，miss 时缓存层自动从 DB 加载）。Read-Through 封装更好但需要缓存层支持（如 Redis Cluster proxy 或 Spring Cache 抽象）。
3. **Write-Behind（Write-Back）是什么？**——异步写 DB。写请求只更新缓存，缓存异步批量刷到 DB。优点是写性能极高（不等 DB），缺点是一致性弱（缓存挂了丢数据）。适合写密集且容忍丢数据的场景（如日志、计数）。
4. **缓存预热怎么做？**——系统启动或大促前，提前把热点数据加载到缓存。方案：脚本批量查询 DB 回填 Redis；或在低峰期定时预热。避免上线瞬间缓存空导致 DB 瞬间高压（冷启动问题）。


## 结构化回答

**30 秒电梯演讲：** 聊到Redis 缓存模式与一致性治理，我的理解是——缓存模式的本质是"用空间换时间——把热点数据放内存加速读取"。Cache-Aside（旁路缓存）是业务代码同时管理缓存和 DB（先查缓存，miss 查 DB 回填）；Read-Through/Write-Through 是缓存层代理 DB 访问；Write-Behind 是异步写 DB。一致性问题的本质是"缓存和 DB 是两个系统，无法原子更新"，兜底靠"延迟双删 + TTL + 订阅 binlog 主动失效"。打个比方，像图书馆的"热门书架 + 深度书库"。热门书架（缓存）放借阅多的书（热点数据），深度书库（DB）放所有书。学生借书先查热门书架（Cache 读），没有再去深度书库取并放一本到热门书架（回填）。新书入库时（写），先放深度书库再更新热门书架（一致性）——但这两步非原子，中间有人借可能读到旧版。

**展开框架：**
1. **Cache-Aside（最常用）** — 读先查缓存 miss 查 DB 回填；写先更 DB 再删缓存
2. **一致性策略** — 先更 DB 后删缓存（推荐）、延迟双删、订阅 binlog 主动失效
3. **为什么删缓存而不是更新缓存** — 避免并发更新导致数据不一致、避免频繁更新无人读的缓存（浪费）

**收尾：** 这块我在项目里也踩过坑——想深入的话，可以接着聊：为什么写操作删缓存而不是更新缓存？您更想看哪个方向？

## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡 | "Redis 缓存模式与一致性治理——这道题面试官到底想考什么？我用 30 秒给你讲透。" | 开场钩子 |
| 0:15 | 多级缓存架构图 | 先说核心：缓存模式的本质是"用空间换时间——把热点数据放内存加速读取"。Cache-Aside（旁路缓存）是业务代码同时管理缓存和 DB（先查缓存，miss 查 DB 回填）；Read-。 | 核心定义 |
| 0:30 | Redis 数据结构图 | 先更 DB 后删缓存（推荐）、延迟双删、订阅 binlog 主动失效。 | 一致性策略 |
| 1:30 | 总结卡 | 一句话记忆：Cache-Aside（最常用）：读 miss 查 DB 回填；写先更 DB 后删缓存。 下期可以接着聊：为什么写操作删缓存而不是更新缓存。 | 收尾总结 |
