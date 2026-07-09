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
