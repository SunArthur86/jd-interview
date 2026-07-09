---
id: pdd-trade-009
difficulty: L2
category: pdd-trade
subcategory: Redis
tags:
- 拼多多
- 交易
- Redis
- 数据结构
- 分布式锁
feynman:
  essence: Redis 丰富数据结构支撑交易各种场景——String（缓存/计数器）、Hash（用户信息）、ZSet（排行榜）、Set（去重/标签）、Stream（消息）。
  analogy: Redis 像多功能瑞士军刀——每个数据结构是一种工具，String 是刀片、Hash 是剪刀、ZSet 是尺子，按场景选合适工具。
  first_principle: 不同业务场景有不同数据访问模式，Redis 用专门数据结构让每种模式都高效。
  key_points:
  - String：缓存、计数器（incr）、分布式锁
  - Hash：对象存储（用户信息）
  - List：队列、最新列表
  - Set：去重、标签、共同好友
  - ZSet：排行榜、延时队列
first_principle:
  problem: 不同业务场景（计数/排行/去重/对象）如何用最合适的数据结构高效处理？
  axioms:
  - 不同场景访问模式不同
  - 专门数据结构比通用更高效
  - Redis 内存数据库要省内存
  rebuild: 5 种数据结构按场景选——String 计数/Hash 对象/Set 去重/ZSet 排行/List 队列。
follow_up:
- "购物车怎么实现？——Hash（uid → {skuId: qty}）"
- 商品排行榜？——ZSet（score=销量，member=skuId）
- UV 统计？——HyperLogLog（千万级 UV，误差 0.81%）
memory_points:
- String 计数/缓存/锁、Hash 对象、Set 去重、ZSet 排行、List 队列
- 购物车 Hash、排行榜 ZSet、UV HyperLogLog
- 布隆过滤器防穿透
- 分布式锁 SET NX PX + UUID
---

# 【拼多多交易】Redis 数据结构在交易系统的应用？

> JD 依据："熟悉缓存技术"。

## 一、5 种数据结构与场景

| 结构 | 场景 | 命令 |
|------|------|------|
| String | 缓存/计数器/锁 | SET/GET/INCR |
| Hash | 对象（用户/购物车） | HSET/HGET/HGETALL |
| List | 队列/最新列表 | LPUSH/RPOP |
| Set | 去重/标签/共同好友 | SADD/SISMEMBER |
| ZSet | 排行榜/延时队列 | ZADD/ZRANGE |

## 二、交易场景实战

**购物车（Hash）**：
```
HSET cart:uid500 sku1 2        # 加购
HSET cart:uid500 sku2 1
HGETALL cart:uid500             # 取购物车
HINCRBY cart:uid500 sku1 1     # 改数量
```

**销量排行榜（ZSet）**：
```
ZINCRBY rank:sales 1 sku123     # 销量+1
ZREVRANGE rank:sales 0 9        # Top 10 热销
```

**UV 统计（HyperLogLog）**：
```
PFADD uv:20260707 uid500
PFCOUNT uv:20260707             # 去重计数（误差 0.81%）
```

**分布式锁（String）**：
```
SET lock:order:1 <uuid> NX PX 30000
```

**点赞去重（Set）**：
```
SADD like:sku123 uid500
SISMEMBER like:sku123 uid500    # 是否点赞过
```

## 三、特殊结构

- **HyperLogLog**：UV 去重计数（12KB 存千万 UV）
- **Bitmap**：签到（1 位表示一天）
- **Stream**：消息队列（5.0+）
- **Geo**：附近的人/店

## 四、底层本质

Redis 数据结构本质是**"为不同访问模式优化"**：
- 计数用 String O(1)
- 排行用 ZSet（跳表）O(logN)
- 去重用 Set O(1)

选对数据结构 = 性能最优。

## 常见考点
1. **ZSet 底层**？——跳表（skiplist）+ 哈希表，支持有序+O(logN)。
2. **HyperLogLog 原理**？——概率计数，12KB 估千万 UV，误差 0.81%。
3. **购物车为什么用 Hash**？——O(1) 增删改查单商品，HGETALL 取全部。
