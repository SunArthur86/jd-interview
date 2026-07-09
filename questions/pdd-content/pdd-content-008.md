---
id: pdd-content-008
difficulty: L4
category: pdd-content
subcategory: 分库分表
tags:
- 拼多多
- 内容
- MySQL
- 分库分表
- 评价
- ShardingSphere
feynman:
  essence: 分库分表把单表数据水平拆到多库多表，破解单库容量/QPS 瓶颈；评价/Feed 等高写入场景按 product_id/uid 分片，配合 ShardingSphere 路由。
  analogy: 分库分表像超市分流收银——一个收银台（单表）排队太长，开多个收银台（分片）按商品类别（分片键）分流。
  first_principle: 单库容量/QPS 有物理上限（约 1000 万行/单表 5K QPS），需水平拆分。
  key_points:
  - 垂直拆：按字段/业务分库（评价库/直播库）
  - 水平拆：按分片键（product_id/uid）拆表
  - 分片策略：range/hash/一致性 hash
  - 难点：跨片查询/分布式事务/扩容
first_principle:
  problem: 单库容量与 QPS 有上限，如何水平拆解？
  axioms:
  - 单表过亿/单库 QPS 过万就吃力
  - 数据有天然分片键（product_id/uid）
  - 跨片查询很贵
  rebuild: 垂直分库 + 水平分表（分片键路由）+ 中间件。
follow_up:
  - 分片键怎么选？——高频查询字段（评价用 product_id，Feed 用 uid）
  - 跨片查询怎么办？——尽量带分片键；或建异构索引（ES）
  - 扩容怎么平滑？——一致性 hash 或 2 倍法+双写灰度
memory_points:
  - 垂直：按业务/字段分库
  - 水平：按分片键分表
  - 中间件：ShardingSphere
  - 难点：跨片/事务/扩容
---

# 【拼多多内容】评价库分库分表方案？

> JD 依据："稳定性建设"、"高并发大流量大数据量"。

## 一、为什么分库分表

```
单表瓶颈：
  - 行数 >1000 万：B+ 树变高，查询慢
  - 单库 QPS >5000：磁盘 IO/CPU 吃满
  - 单库故障影响全业务
分库分表解决：
  - 容量：水平拆开，单表可控
  - QPS：分摊到多库
  - 故障：分片隔离
```

## 二、拆分方式

**垂直拆分**：
- 垂直分库：按业务（评价库、直播库、Feed 库）
- 垂直分表：按字段热度（review 基础表 + review_content 大字段表）

**水平拆分**（按分片键）：
```
review 表 → review_0, review_1, ..., review_15（16 张表，4 库×4 表）
分片键：product_id % 16 → 路由到对应表
```

## 三、分片策略

| 策略 | 做法 | 优缺点 |
|------|------|--------|
| Range | 按区间（时间/ID 段） | 易扩容，但热点 |
| Hash | `product_id % N` | 均匀，扩容痛 |
| 一致性 Hash | 节点环 | 扩容迁移少 |
| 雪花算法 | 自带分片信息 | ID 即路由 |

**评价场景**：按 `product_id` Hash 分 16 表（4 库 4 表）
**Feed 场景**：按 `uid` Hash（同一用户的 Feed 在同一分片，写入高效）

## 四、ShardingSphere 配置

```yaml
spring:
  shardingsphere:
    datasource:
      names: ds0,ds1,ds2,ds3
      ds0: { type: HikariDataSource, ... }
      ...
    rules:
      sharding:
        tables:
          review:
            actualDataNodes: ds${0..3}.review_${0..3}    # 4 库 4 表
            databaseStrategy:
              standard:
                shardingColumn: product_id
                shardingAlgorithmName: review_db_mod
            tableStrategy:
              standard:
                shardingColumn: product_id
                shardingAlgorithmName: review_table_mod
        shardingAlgorithms:
          review_db_mod:
            type: MOD
            props: { sharding-count: 4 }
          review_table_mod:
            type: MOD
            props: { sharding-count: 4 }
        keyGenerators:
          snowflake:
            type: SNOWFLAKE
            props: { worker-id: 1 }
```

## 五、难点与解法

**1. 跨片查询**：
```sql
-- 不带分片键：广播到所有分片合并（贵）
SELECT * FROM review WHERE uid = 123;          -- product_id 不在
-- 解法：建异构索引（uid → product_id 映射入 ES/HBase）
```

**2. 分页**：
```
LIMIT 100000, 10 跨片：每个分片取 100010 行→合并→取 10 行
解法：禁止深翻页；或游标（last_id）
```

**3. 分布式事务**：
- 弱一致：本地消息表 + 异步补偿
- 强一致：Seata AT/TCC

**4. 扩容（4 库 → 8 库）**：
- 双写新老库（按新规则）→ 数据同步 → 切流量 → 下老库
- 或一致性 hash 减少迁移量

**5. 全局 ID**：雪花算法（worker + 时间戳 + 序列）

## 六、内容场景实战

```
评价库分片（拼多多）：
  分片键：product_id
  分片数：64 库 × 4 表 = 256 张表
  单表数据：~500 万（可控）
  查询：商品评价页（带 product_id，直接路由）
  
Feed 库分片：
  分片键：uid
  查询：用户主页 Feed（带 uid，直接路由）

直播库分片：
  分片键：live_id
  查询：直播间详情/弹幕历史
```

## 七、底层本质

分库分表本质是**"用分片键把数据水平拆开破解容量/QPS 瓶颈"**——核心是选好分片键，难点是跨片/事务/扩容，往往配合异构索引（ES/HBase）补足。

## 常见考点
1. **分片键选错了怎么办**？——异构索引（双写 ES）+ 异步同步。
2. **怎么不停机扩容**？——双写新老库+数据回填+灰度切流+下线老库。
3. **ShardingSphere 和 MyCat 区别**？——前者客户端/中间件双模式（更轻量），后者是中间件。
