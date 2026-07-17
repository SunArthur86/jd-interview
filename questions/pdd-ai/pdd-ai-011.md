---
id: pdd-ai-011
difficulty: L3
category: pdd-ai
subcategory: Redis
tags:
- 拼多多
- AI 中台
- Redis
- 缓存
- 特征
feynman:
  essence: Redis 是"内存级 KV 存储"，模型推理结果/特征/限流计数都靠它低延迟；中台要懂 5 种数据结构、持久化、集群、热点 key/大 key 治理。
  analogy: 像办公桌抽屉——常用文件（热点数据）放手边（Redis 内存），秒拿；不常用的归档（DB），慢但便宜。
  first_principle: 内存比磁盘快 100 倍，热数据放内存能极大降延迟、减 DB 压力。
  key_points:
  - 5 种结构：String/Hash/List/Set/ZSet + 扩展（Bitmap/HyperLogLog/Stream）
  - 持久化：RDB（快照）/AOF（日志）/混合
  - 集群：主从/哨兵/Cluster（分片）
  - 缓存模式：Cache Aside / Write Through / Write Behind
  - 治理：热点 key/大 key/穿透/击穿/雪崩
first_principle:
  problem: 怎么用内存存储既快又稳地服务高并发读写？
  axioms:
  - 内存快但贵且易失
  - 单机有上限
  - 缓存会有一致性问题
  rebuild: Redis（内存 KV + 持久化 + 集群 + 缓存策略 + 治理）。
follow_up:
  - Redis 为什么快？——单线程避免锁 + 内存 + epoll 多路复用 + 高效数据结构
  - 缓存和 DB 一致性怎么保证？——Cache Aside（先 DB 后删缓存）+ 双删 + 订阅 binlog
  - 大 key 怎么治理？——拆分（Hash 分桶）+ 监控（memory usage）+ 异步删除（UNLINK）
memory_points:
  - 5 结构：String/Hash/List/Set/ZSet
  - 持久化：RDB 快照/AOF 日志
  - 集群：主从/哨兵/Cluster
  - 三大问题：穿透/击穿/雪崩
---

# 【拼多多 AI 中台】Redis 高级用法与中台缓存怎么设计？

> JD 依据："缓存、Java + NoSQL"。

## 一、5 种核心数据结构

| 类型 | 场景 | 示例 |
|------|------|------|
| **String** | 计数/简单缓存 | `SET token:user123 "v2"` |
| **Hash** | 对象存储 | `HSET user:123 name "张三" age 28` |
| **List** | 队列/最近 N 个 | `LPUSH feeds msg001` |
| **Set** | 去重/标签 | `SADD tags:商品 1 数码 手机` |
| **ZSet** | 排行榜/TopN | `ZADD rank 100 user1 90 user2` |

**扩展**：
- **Bitmap**：用户签到（一年 365 位）、活跃统计（亿级用户用 12MB）
- **HyperLogLog**：UV 去重计数（误差 0.81%，固定 12KB）
- **Stream**：消息队列（替代 Kafka 轻量场景）
- **Geo**：附近的人/店（基于 GeoHash）

## 二、中台典型用法

### 1. 特征缓存（Hash）
```
key:   feat:user:123
field: click_cnt_1h / cart_cnt / ...
value: 实时特征值
TTL:   2h
```

### 2. 模型推理结果缓存
```java
// 缓存 LLM 推理（同样 prompt 直接返回，省 GPU）
String cacheKey = "llm:" + DigestUtils.md5Hex(prompt);
String cached = redis.get(cacheKey);
if (cached != null) return cached;          // 命中省一次推理

String result = llmClient.chat(prompt);
redis.setex(cacheKey, 3600, result);        // 缓存 1 小时
```

### 3. 限流（滑动窗口 + ZSet）
```java
// 用户每分钟最多 10 次
String key = "rate:" + uid;
long now = System.currentTimeMillis();
redis.zadd(key, now, now + "");             // score=时间
redis.zremrangeByScore(key, 0, now - 60000);// 删 1 分钟前
if (redis.zcard(key) > 10) throw new RateLimitException();
```

### 4. 排行榜（ZSet）
```
ZADD sales_rank 1000 商品A 800 商品B 500 商品C
ZREVRANGE sales_rank 0 9 WITHSCORES  → Top 10
```

### 5. 分布式锁
```java
String token = UUID.randomUUID().toString();
boolean ok = redis.set("lock:order:" + id, token, "NX", "EX", 30);
try {
    if (!ok) throw new ConcurrentException();
    // 业务
} finally {
    // Lua 保证"判断+删除"原子
    String lua = "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end";
    redis.eval(lua, Collections.singletonList(key), Collections.singletonList(token));
}
```

## 三、持久化

| 方式 | 机制 | 优点 | 缺点 |
|------|------|------|------|
| **RDB** | 定时全量快照 | 恢复快、文件小 | 可能丢最近几分钟 |
| **AOF** | 追加命令日志 | 丢得少（fsync 策略） | 文件大、恢复慢 |
| **混合** | RDB + AOF 增量 | 兼顾（4.0+） | 配置复杂 |

生产建议：RDB 做基线 + AOF（everysec）做增量，恢复时先 RDB 再 replay AOF。

## 四、集群模式

```
主从：1 主 N 从，读写分离，主挂需手动切
哨兵：主从 + Sentinel 自动故障转移（适合小规模）
Cluster：分片（16384 槽位）+ 多主多从，水平扩展（推荐大规模）
```

**Cluster 关键**：
- 16384 槽，CRC16(key) % 16384 路由
- 每个节点负责一部分槽
- 节点间 Gossip 协议
- 客户端缓存槽映射（MOVED 重定向更新）

## 五、缓存模式

| 模式 | 流程 | 适用 |
|------|------|------|
| **Cache Aside**（推荐） | 读：先缓存，miss 查 DB 回写；写：更新 DB + 删缓存 | 通用 |
| **Read/Write Through** | 业务只操作缓存，缓存层同步 DB | 缓存层封装复杂 |
| **Write Behind** | 写只入缓存，异步刷 DB | 写多读少（容忍丢失） |

**Cache Aside 一致性**：
```
写：UPDATE DB → DEL cache（不更新缓存，避免并发覆盖）
为什么删不更新？——多个写并发时更新可能乱序；删是幂等的
兜底：双删（写前删 + 写后延迟删）+ 订阅 binlog 异步删
```

## 六、缓存三大问题

| 问题 | 现象 | 解决 |
|------|------|------|
| **穿透**（查不存在的） | 大量请求查不存在的 key，缓存永不命中 | 布隆过滤器 / 缓存空值（短 TTL） |
| **击穿**（热点 key 过期） | 瞬间大量请求打 DB | 互斥锁重建 / 热点永不过期（异步刷新） |
| **雪崩**（大量同时过期） | 缓存集体失效，DB 被打挂 | TTL 加随机抖动 / 多级缓存 / 限流降级 |

## 七、热点 key / 大 key 治理

**热点 key**（如爆款商品）：
- 本地缓存（Caffeine）扛读
- 多副本（key:1, key:2 ... 随机读）
- 读写分离 + 多从分摊

**大 key**（如百万元素的 Hash）：
- 拆分（按 hash 分桶：`user:123:0`, `:1`, ...）
- 监控 `MEMORY USAGE key`
- 异步删除 `UNLINK`（不阻塞主线程）

## 八、底层本质

Redis 本质是**"内存 + 单线程 + 多路复用 + 高效数据结构"**——内存快是根本，单线程避免锁竞争和上下文切换，epoll 实现高并发，SDS/skiplist/intset 等数据结构让各种操作高效。AI 中台用它做特征/缓存/限流/锁，是"低延迟数据底座"。

## 常见考点

1. **Redis 6 多线程是什么**？——网络 IO 多线程，命令执行仍单线程（避免数据竞争）。
2. **怎么实现延迟队列**？——ZSet（score=到期时间）+ 定时扫描，或 Redis 5.0+ Stream。
3. **集群为什么是 16384 槽**？——心跳包小（2KB），节点数 < 1000 足够，CRC16 实现简单。

## 苏格拉底式面试追问

> 这组追问不背答案，模拟面试宫层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：你们用 Redis 缓存模型推理结果。但模型推理 200ms，Redis GET 1ms，缓存命中省的是这 200ms。问题是——同一个用户的推荐结果缓存 5 分钟，这 5 分钟内模型不更新，推荐不就"不新鲜"了吗？为什么不用户每次都实时算？**

实时算的代价是"GPU 成本爆炸"。推荐场景日均 1 亿次请求，每次实时推理 200ms × 1 亿 = 2000 万秒 GPU 时间，需要几百张 H100，成本不可承受。缓存 5 分钟的核心价值是"命中率 > 80% 时，GPU 只需处理 20% 的实时请求"，成本降 5 倍。新鲜度的 trade-off：推荐结果 5 分钟不更新，用户感知很弱（人不会在 5 分钟内重复看同一推荐页且期望变化）；但商品库存、价格这类强实时数据不能缓存（要查 DB）。决策标准：**数据更新频率 vs 用户敏感度**——推荐/画像/特征缓存（5 分钟可接受），库存/价格/支付状态不缓存（强实时）。缓存不是"为了快"而是"为了省 GPU 时省得值得"。

### 第二层：证据与定位

**Q：缓存命中率从上线时的 85% 慢慢降到 60%。你排查发现是"key 没设 TTL 或设太长"。但你怎么定位是 TTL 问题还是 key 设计问题？**

分两个方向排查。第一，**看 key 的 TTL 分布**——用 `redis-cli --bigkeys` 和 `MEMORY STATS` 看内存里 key 的 TTL 分布，如果 40% 的 key TTL=-1（永不过期）或 TTL=86400（24 小时），说明 TTL 设太长，旧数据占着内存、新请求 miss。正确 TTL 应该是"业务可接受的 staleness"（推荐 5 分钟=300 秒）。第二，**看 cache_miss 的 query 分布**——用 `MONITOR`（测试环境）或 Redis SLOWLOG + 业务日志统计 miss 的 key pattern，如果发现 `rec:user:{uid}` 的 miss 率是 90% 而 `rec:hot_items` 的 miss 率是 10%，说明用户级 key 太分散（每个 uid 一个 key，命中率低），应该改成"热门商品列表"这种聚合 key（命中率高）。根因判断：如果 miss 的 key 是"合理的业务 key"（用户 ID），是 TTL 太短或缓存容量不够（要加内存）；如果 miss 的 key 是"碎片化 key"（每次都不同），是 key 设计问题（要聚合）。

### 第三层：根因深挖

**Q：你发现线上有个大 key（model_result:hot_sku）占用 500MB，是一个 Hash 存了 100 万个 SKU 的推荐分数。每次 HGET 一个 SKU 要读 500MB？这会不会拖慢 Redis？**

大 key 的危害是"单命令阻塞"。第一，Redis 单线程执行命令，`HGET model_result:hot_sku sku123` 虽然只返回一个字段，但 Hash 底层是 hashtable，单字段查询是 O(1)，不会读 500MB——所以 HGET 本身快。问题在其他操作：`HGETALL`（返回 500MB，阻塞 Redis 数秒）、`DEL model_result:hot_sku`（删除 500MB 的 hashtable，阻塞 1-2 秒，期间所有其他请求排队）。第二，更隐蔽的是"过期触发"——如果这个大 key 设了 TTL，过期时 Redis 4.0 之前是同步删除（阻塞），4.0+ 是异步删除（`lazyfree-lazy-expire yes`），但默认配置可能没开。第三，**网络传输**——即使 HGET 单字段快，但如果业务误用了 `HGETALL`，500MB 的响应会占满网络带宽。排查：用 `redis-cli --bigkeys` 找大 key，用 `MEMORY USAGE model_result:hot_sku` 看精确大小，用 `OBJECT ENCODING` 看 encoding（hashtable 说明没优化）。

**Q：那为什么不用 Redis Cluster 把这个大 key 分散到多个节点？Cluster 不是自动分片吗？**

Redis Cluster 的分片是"按 key 分"，不是"按 key 内部字段分"。`model_result:hot_sku` 这个 key 整体 hash 到一个 slot（CRC16），整个 Hash 存在单个节点上，Cluster 不会把它拆开。所以大 key 在 Cluster 下依然是单节点的大 key，问题没解决。解法是**业务层拆分**：把 `model_result:hot_sku`（100 万字段）拆成 `model_result:hot_sku:bucket_0` 到 `model_result:hot_sku:bucket_99`（每个 1 万字段），写入时 `bucket = hash(sku_id) % 100`，读取时先算 bucket 再 HGET。这样：第一，单 key 从 500MB 降到 5MB；第二，这些 key 会分散到不同 slot（hash 不同），Cluster 能负载均衡；第三，删除时删 100 个小 key（异步并行），不阻塞。这种"分桶"是 Redis 大 key 治理的标准模式（类似 HashMap 的 bucket）。

### 第四层：方案权衡

**Q：缓存击穿（热点 key 过期瞬间大量请求打到 DB）你们怎么处理？用互斥锁（SETNX）还是逻辑过期？**

互斥锁更简单可控，逻辑过期适合"极致性能"场景。**互斥锁方案**：key 过期时，第一个请求 `SETNX lock:hot_key`（设 10 秒过期防死锁），拿到锁的去查 DB 重建缓存，没拿到锁的 sleep 50ms 重试（或返回旧值）。优点是实现简单（一行 SETNX）、数据新鲜（重建后就是最新）；缺点是第一个请求慢（DB 查询 200ms），且如果持锁线程挂了要等锁过期。**逻辑过期方案**：缓存永不过期（不设 TTL），但在 value 里存 `expire_time` 字段，读时判断是否逻辑过期，过期了异步重建（另起线程），当前请求返回旧值。优点是"永不阻塞"（用户感知不到重建）；缺点是数据有 staleness（重建完成前返回旧值）、逻辑复杂（异步重建要保证一致性）。生产选择：**热点 key（top-100 SKU）用逻辑过期**（不能阻塞，异步重建）、**普通 key 用互斥锁 + TTL**（新鲜度优先）。不要用"缓存预热"（启动时全量加载），太重且更新不及时。

**Q：为什么不直接用 Redis 的布隆过滤器解决缓存穿透（查询不存在的 key）？布隆过滤器不是专门干这个的吗？**

布隆过滤器解决"查不存在的 key"（穿透），但不是所有穿透都适合用布隆过滤器。第一，**适用场景**——key 集合相对固定（比如"所有合法的 user_id"），提前把 user_id 全量灌入布隆过滤器，请求来了先过布隆过滤器（不存在的一定不存在，直接返回，不打 Redis/DB）。第二，**不适用场景**——key 集合动态变化（比如"新增的 SKU"），布隆过滤器要实时更新，而 Redis 的布隆过滤器（RedisBloom 模块）的删除是难题（标准布隆过滤器不支持删除，Counting Bloom Filter 才行），新增 SKU 要定期 rebuild。第三，**误判代价**——布隆过滤器有假阳性（说不存在的准，说存在的可能误判），如果误判率高（10%），那 10% 的"不存在 key"还是会打到 DB。生产选择：合法 ID 集合固定用布隆过滤器（用户/商品 ID），动态 key 用"空值缓存"（查 DB 没找到就缓存 `null`，TTL 60 秒，防止重复查）。两者结合：布隆过滤器挡"明显非法"的，空值缓存挡"合法但不存在"的。

### 第五层：验证与沉淀

**Q：你怎么证明缓存优化（TTL 调整 + 大 key 拆分）真的提升了系统性能？**

三个指标对比。第一，**cache_hit_ratio**——Prometheus 监控 Redis 的 `hit_rate`（`keyspace_hits / (keyspace_hits + keyspace_misses)`），优化前 60%，优化后目标 85%。第二，**backend_qps_reduction**——对比 DB/推理服务的 QPS，优化前 DB QPS 5 万/s（缓存 miss 后查 DB），优化后降到 1.5 万/s（hit ratio 提升后 70% 的 miss 消除）。第三，**latency_p99**——对比端到端 P99 延迟，缓存命中时 1ms（Redis），miss 时 200ms（DB/模型），hit ratio 从 60% 到 85%，P99 应从 200ms（经常 miss）降到 50ms（多数命中）。A/B 验证：新旧缓存策略各部署一套，同时段对比 hit ratio 和 P99，连续 1 周稳定提升才算成功。

**Q：Redis 集群运维怎么沉淀，避免每次出问题都手忙脚乱？**

三件事标准化。第一，**监控告警**——Redis Exporter 采集核心指标：`connected_clients`（连接数，> 10000 告警）、`used_memory_rss / maxmemory`（内存使用率，> 80% 告警）、`rejected_connections`（拒绝连接数，> 0 告警）、`instantaneous_ops_per_sec`（QPS，突增 2 倍告警可能热 key）、`keyspace_misses / total`（miss 率，> 30% 告警）。第二，**大 key / 热 key 定期巡检**——每天凌晨跑 `redis-cli --bigkeys` 和热 key 检测（Redis 6.0+ 的 `--hotkeys`），发现 > 10MB 的 key 自动告警 + 通知拆分。第三，**故障预案**——Redis 主节点挂了自动切哨兵（`failover` 时间 < 30 秒），但要做好"切换时写入丢失"的预案（AOF + everysec 配置，最多丢 1 秒数据），业务侧"降级到本地缓存"（Caffeine）兜底。把 Redis 当成"需要持续治理的基础设施"，而不是"设好就不管"。

## 结构化回答

**30 秒电梯演讲：** 怎么用内存存储既快又稳地服务高并发读写？简单说就是——Redis 是"内存级 KV 存储"，模型推理结果/特征/限流计数都靠它低延迟；中台要懂 5 种数据结构、持久化、集群、热点 key/大 key 治理。持久化：RDB 快照/AOF 日志；集群：主从/哨兵/Cluster。

**展开框架：**
1. **5 结构** — 5 结构：String/Hash/List/Set/ZSet
2. **持久化** — 持久化：RDB 快照/AOF 日志
3. **集群** — 集群：主从/哨兵/Cluster

**收尾：** 您想继续往深里聊吗——比如「Redis 为什么快？」

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：Redis 高级用法与中台缓存怎么设计？ | 今天聊「Redis 高级用法与中台缓存怎么设计？」。一句话：Redis 是"内存级 KV 存储"，模型推理结果/特征/限流计数都靠它低延迟；中台要懂 5 种数据结构、持久化、集群… | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：5 结构：String/Hash/List/Set/ZSet | 核心概念 |
| 1:04 | 能力/参数拆解表 | 要点是：持久化：RDB 快照/AOF 日志 | 能力拆解 |
| 1:56 | 流程图：输入→处理→输出 | 要点是：集群：主从/哨兵/Cluster | 关键机制 |
| 3:00 | 总结卡 + 下期预告 | 记住这些核心点就够了。下期我们接着聊——Redis 为什么快？。 | 收尾 |
