---
id: pdd-trade-012
difficulty: L4
category: pdd-trade
subcategory: 分库分表
tags:
- 拼多多
- 交易
- 分库分表
- 亿级订单
- ShardingSphere
feynman:
  essence: 亿级订单用"按买家维度（uid）分库分表+按卖家维度异构（ES/HBase）+ 冷热分离"支撑，单库千万级、全局亿级。
  analogy: 分库分表像把大字典拆成多本——按买家拆（每买家历史订单在一起），卖家视角另出索引（异构）。
  first_principle: 单库千万级 B+ 树 3 层高效，亿级必须分；订单按 uid 查最频繁，按 uid 分。
  key_points:
  - 分片键：uid（买家查询最频繁）
  - 异构：卖家视角存 ES/HBase（跨买家查）
  - 冷热分离：热订单 MySQL，冷归档 HBase
  - 全局 ID：雪花算法
first_principle:
  problem: 亿级订单如何高效按买家/卖家/时间多维度查询？
  axioms:
  - 单库千万级最优
  - 买家查自己订单最频繁
  - 卖家查跨买家订单少但需支持
  rebuild: uid 分库分表（买家视角）+ ES/HBase 异构（卖家视角）+ 冷热分离。
follow_up:
- 卖家查订单怎么办？——uid 分片后跨片，异构到 ES（sellerId 索引）
- 历史订单怎么处理？——1 年内热数据 MySQL，更老归档 HBase
- 全局订单 ID 怎么生成？——雪花算法（时间+机器+序号）
memory_points:
- 分片键 uid（买家视角最频繁）
- 卖家异构 ES/HBase
- 冷热分离（热 MySQL/冷 HBase）
- 全局 ID 雪花算法
---

# 【拼多多交易】亿级订单怎么分库分表？

> JD 依据："大规模业务系统"。

## 一、分片策略

```
分片键: uid（买家）
库数: 16（ds0..ds15）
表数: 每库 16 张（order_0..order_15）
路由: hash(uid) % 16 → 库; hash(uid) / 16 % 16 → 表

容量: 16 库 × 16 表 × 千万 = 25 亿订单
```

```yaml
shardingsphere:
  tables:
    orders:
      actualDataNodes: ds${0..15}.orders_${0..15}
      databaseStrategy: { hash: { column: uid } }
      keyGenerator: { type: SNOWFLAKE, column: id }
```

## 二、异构（卖家视角）

uid 分片后，卖家查自己订单要跨所有分片，性能差。**异构到 ES**：

```
订单写入 → MySQL（uid 分片）+ binlog → Canal → Kafka → ES（sellerId 索引）
卖家查询 → ES（按 sellerId 过滤）
```

## 三、冷热分离

```
热订单（近 1 年）: MySQL（分库分表）
冷订单（1 年前）: HBase（归档）

查询: 先查 MySQL，没有再查 HBase（透明路由）
```

## 四、全局订单 ID（雪花）

```
| 1 bit | 41 bit 时间 | 10 bit 机器 | 12 bit 序号 |
```
- 全局唯一、有序（按时间）
- 不依赖 DB

## 五、跨库难题

- **跨库 JOIN**：业务组装（多查内存 join）/冗余字段/ES
- **聚合统计**：异步汇总表 / 数仓离线
- **分布式事务**：本地消息表/TCC

## 六、底层本质

分库分表本质是**"用一致性换扩展性"**——单库 ACID 强但扩展差，分库后失去跨库事务/JOIN，换线性扩展。

## 常见考点
1. **为什么按 uid 不按订单 id 分**？——买家查自己订单最高频，uid 分片同买家订单在一起。
2. **卖家怎么查**？——异构 ES（sellerId 索引），牺牲一致换查询性能。
3. **分片键能改吗**？——极难（停服迁移/双写灰度），选错代价大。
