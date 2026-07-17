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

## 苏格拉底式面试追问

> 这组追问不背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：购物车你用 Hash 存（`cart:uid → {skuId: qty}`），为什么不直接用 String 存一个 JSON 字符串？存 JSON 不是更简单吗？**

JSON 字符串每次改数量要"GET 整个 JSON → 反序列化 → 改字段 → 序列化 → SET 回去"，整个购物车读写，且无法原子地改单个 SKU 数量——并发加购时两个请求都 GET 到旧 JSON，各自改后 SET，后写的覆盖前写的（丢失加购）。Hash 的动机是"字段级操作原子"：`HINCRBY cart:uid sku1 1` 直接原子加数量，不读不写整个对象，并发安全。另外 Hash 对内存更友好（ziplist 编码下紧凑存储），且 `HGET cart:uid sku1` 单字段查询不用反序列化整个购物车。JSON 适合"整体读写、不改字段"的场景（如缓存商品详情），购物车是"字段级增删改"，必须用 Hash。

### 第二层：证据与定位

**Q：线上 Redis 内存使用率突然涨了 30%，你怎么定位是哪个 key 撑爆的，而不是凭感觉猜？**

用 Redis 自带的诊断工具，三步：
1. `INFO memory` 看 `used_memory` 和 `used_memory_rss`——确认是数据内存涨了（不是碎片），看 `mem_fragmentation_ratio` 是否 >1.5（碎片高）。
2. `MEMORY USAGE` 估算单 key 大小，或用 `redis-cli --bigkeys` 采样找出最大的几个 key——这会按数据结构分类（最大 String/Hash/ZSet 等）。拼多多常见是某个排行榜 ZSet 元素太多、或某个 Set 去重集合无限增长（如黑名单 Set 没清理）。
3. 针对可疑 key 用 `DEBUG OBJECT key` 看编码（如 ZSet 是 skiplist 还是 ziplist）、`TTL key` 看是否设了过期。如果大 key 没 TTL，就是泄漏。重点找"应该有过期但实际没过期"的 key（如活动结束但排行榜 key 没删）。

### 第三层：根因深挖

**Q：你发现某个 `rank:sales:old_activity` 的 ZSet 占了 2GB（活动已结束但 key 没删），根因是什么？光是手动 DEL 就行吗？**

手动 DEL 是治标且危险（大 key DEL 会阻塞 Redis 几秒）。根因要看为什么没删：
1. 活动下线流程没覆盖 Redis 清理——活动配置删了 DB 记录，但没触发 Redis key 删除。治本是活动下线流程加"清理相关 Redis key"步骤。
2. 大 key 删除要用 `UNLINK`（异步删除）而非 `DEL`（同步阻塞），或用 `ZSCAN` 分批 `ZREM` 逐步清空再删 key，避免阻塞。Redis 4.0+ 的 `lazyfree-lazy-expire` 和 `UNLINK` 是处理大 key 的正确姿势。
3. 预防机制——所有活动类 key 强制设 TTL（哪怕设 30 天也行，至少不会永久占），`SETEX/SET ... EX` 或 ZSet 用 `EXPIRE` 兜底。拼多多这种规模，靠人记得删 key 不可靠，必须 TTL 兜底。

**Q：那为什么不用定时任务扫所有 key 清理过期的，而要靠 Redis 自己的过期机制？**

Redis 自己的过期机制（惰性删除+定期删除）已经足够，自己扫所有 key 是反模式：
1. `KEYS *` 会阻塞 Redis（O(N) 遍历），生产环境禁用。即使用 `SCAN` 也是给 Redis 增加额外负载。
2. Redis 的过期机制是"访问时检查过期则删（惰性）+ 后台定期抽样删（定期）"，对业务透明，不需要业务关心。自己写定时任务反而可能和 Redis 的定期删除冲突，或扫得不如 Redis 高效。
3. 真正要做的是"给 key 设 TTL"和"避免大 key"，而不是"事后扫 key 清理"。过期机制是 Redis 的核心能力，业务侧的错误是"忘了设 TTL"，治本是规范强制所有 key 必须有 TTL（除非明确需要永久，如配置类）。

### 第四层：方案权衡

**Q：你的销量排行榜用 ZSet，但如果某个 SKU 是爆款（销量百万级），score 是个大数字，ZSet 的精度和性能会不会有问题？你怎么权衡？**

ZSet 的 score 是 double 类型，百万级销量在 double 精度内没问题，但性能上要注意：
1. 单 ZSet 元素过多（如百万 SKU 在一个排行榜）——`ZREVRANGE` 取 Top N 是 O(logN+M)，没问题；但 `ZADD` 每次都是 O(logN)，N 大时略慢。如果排行榜只关心 Top 100，不需要全量 SKU 在一个 ZSet，可以按类目分（`rank:sales:category:phone`），单 ZSet 元素控制在万级。
2. 爆款 SKU 的 score 更新频率高（每秒销量+1 几千次），`ZINCRBY` 是 O(logN)，单 key 高频写入会让该 key 所在 slot 热点。权衡方案是"排行榜异步聚合"——销量变化先在本地计数器累加，每 10 秒批量 `ZINCRBY` 到 ZSet，把高频写降频。
3. 精度问题——如果 score 用"销量"区分，两个爆款销量相同会按 member 字典序排。如果要精确区分先后，score 可以用"销量×1000 + 时间戳尾数"编码。权衡是"实时精确"vs"聚合高效"，看业务需求。

**Q：为什么不用 Sorted Set + 关系型数据库（MySQL ORDER BY）做排行榜，而要用 Redis ZSet？**

MySQL `ORDER BY sales LIMIT 10` 在千万级 SKU 表上每次执行要全表扫描+排序，即使有索引也是秒级，扛不住排行榜的高频访问（每秒几万次查 Top 10）。Redis ZSet 的跳表让 `ZREVRANGE 0 9` 是 O(logN+10)，亚毫秒级，且数据在内存。权衡是"实时性"——Redis 排行榜是"准实时"（销量变化要 ZINCRBY 更新，有秒级延迟），MySQL 如果实时查是最准的但慢。排行榜场景容忍秒级延迟、要求高频查询，Redis ZSet 是正确选择。只有"低频访问且要绝对准确"的排行（如年度财报排行）才用 MySQL。

### 第五层：验证与沉淀

**Q：你怎么验证购物车的并发安全？比如用户同时点"加购"和"改数量"，会不会丢数据？**

必须有并发测试。写一个压测脚本：同一用户的购物车，并发发起 100 次 `HINCRBY cart:uid sku1 1`，断言最终 `HGET cart:uid sku1` == 100（一次不少）。再测"加购+删除并发"——一边 `HINCRBY` 一边 `HDEL`，断言不会出现"删了又复活"或"加的数量丢失"。Redis 单线程模型保证每条命令原子，但业务逻辑如果是"GET → 改 → SET"多步操作就不安全，必须用 Hash 的字段级原子命令（HINCRBY/HSET）或 Lua 脚本封装多步。生产监控购物车的 `cart_op_conflict_count`（并发冲突数，理想为 0）。

**Q：Redis 数据结构选型怎么沉淀成团队规范，避免新人乱用（比如该用 Hash 的用了 String）？**

沉淀成编码规范 + Code Review 检查项：
1. Redis Key 设计规范——明确每个业务的 key 命名、数据结构、TTL。如"购物车必须用 Hash 且 key 格式 `cart:{uid}`，TTL 30 天"。新人按规范来，不用自己想。
2. Code Review checklist——所有 Redis 操作 review 时检查：数据结构是否合适（对象用 Hash 不用 String+JSON）、是否设 TTL、是否用原子命令（不用 GET-改-SET）、大 key 风险（ZSet/Set 元素上限）。拼多多这种规模，一个选型错误（如用 String 存千万级 Set）就是几 GB 内存浪费。
3. Redis 操作 SDK 封装——禁止业务直接调 `redisTemplate`，必须走封装层（自动加 key 前缀、强制 TTL、大 key 检测告警），从工具层防住误用。

## 结构化回答


**30 秒电梯演讲：** Redis 像多功能瑞士军刀——每个数据结构是一种工具，String 是刀片、Hash 是剪刀、ZSet 是尺子，按场景选合适工具。

**展开框架：**
1. **String** — 缓存、计数器（incr）、分布式锁
2. **Hash** — 对象存储（用户信息）
3. **List** — List：队列、最新列表

**收尾：** 购物车怎么实现？


## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：Redis 数据结构在交易系统的应用？ | 今天聊「Redis 数据结构在交易系统的应用？」。一句话：Redis 丰富数据结构支撑交易各种场景 | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：String：缓存、计数器（incr）、分布式锁 | 核心概念 |
| 1:00 | 能力/参数拆解表 | 要点是：Hash：对象存储（用户信息） | 能力拆解 |
| 2:00 | 总结卡 + 下期预告 | 记住核心要点就够了。下期见。 | 收尾 |
