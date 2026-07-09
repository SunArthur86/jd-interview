---
id: pdd-scm-022
difficulty: L4
category: pdd-scm
subcategory: 商品
tags:
- 拼多多
- 供应链
- 商品中心
- 系统设计
- 架构
feynman:
  essence: 商品中心是供应链的"主数据"中心，支撑千万 SPU、亿 SKU 的存储/查询/搜索/同步，靠"分库分表+ES 搜索+多级缓存+Canal 同步"支撑高并发读写。
  analogy: 商品中心像大型超市的"商品档案室"——每个商品有档案（MySQL）、有搜索索引（ES）、有热销展示（缓存），上下游（订单/库存）都来查。
  first_principle: 商品是高频读、低频写，用"写 MySQL + 读缓存 + 搜 ES"分工。
  key_points:
  - 写：MySQL 分库分表（按 spu_id hash）
  - 读：Caffeine + Redis 多级缓存（命中率 98%）
  - 搜：ES（Canal 同步，支持全文+聚合）
  - 同步：binlog → Canal → Kafka → 下游（订单/推荐/广告）
first_principle:
  problem: 千万商品如何同时支撑高并发读、全文搜索、多下游同步？
  axioms:
  - 读远多于写
  - 关系型不适合全文搜
  - 下游需要实时同步
  rebuild: MySQL（主存）+ 多级缓存（读）+ ES（搜索）+ Canal（同步下游）。
follow_up:
- 商品改价怎么实时生效？——MySQL 改 → Canal → Redis 删 + ES 更新 + 下游通知
- 缓存一致性？——Cache Aside（先 DB 后删缓存）+ 延迟双删
- 商品下架怎么防超卖？——下架事件即时同步 ES 和缓存，下单时校验状态
memory_points:
- 写 MySQL（分库分表）+ 读多级缓存（Caffeine+Redis）+ 搜 ES
- Canal 订阅 binlog 同步 ES 和下游
- 缓存命中率 98%+
- 商品是"主数据"，所有业务线共享
---

# 【拼多多供应链】设计商品中心（千万 SPU、亿 SKU）

> JD 依据："商品货品领域研发"。

## 一、整体架构

```
写请求 → MySQL（分库分表，按 spu_id hash）
              ↓ binlog
         Canal → Kafka
              ├→ ES（搜索索引）
              ├→ Redis（删缓存）
              └→ 下游（推荐/广告/订单）

读请求 → Caffeine（本地）→ Redis（分布式）→ MySQL
搜请求 → ES（全文+聚合）
```

## 二、存储设计

**MySQL 分库分表**：
```yaml
ShardingSphere:
  tables:
    spu:
      actualDataNodes: ds${0..15}.spu_${0..15}
      databaseStrategy: { hash: { column: id } }
      tableStrategy: { hash: { column: id } }
    sku:
      actualDataNodes: ds${0..31}.sku_${0..31}   # SKU 更多，分更细
```

**ES 索引**：
```json
{
  "title": { "type": "text", "analyzer": "ik_max_word" },
  "category_id": { "type": "keyword" },
  "price": { "type": "double" },
  "sales": { "type": "long" },
  "attributes": { "type": "nested" }
}
```

## 三、读写分离

**读（高频）**：多级缓存命中率 98%。
**写（低频）**：MySQL 主库，Canal 异步同步。

**缓存一致性**：Cache Aside + Canal 兜底。

## 四、商品同步下游

```
商品变更 → binlog → Canal → Kafka
   ├→ 推荐服务（更新推荐池）
   ├→ 广告服务（更新广告库存）
   ├→ 搜索服务（ES 索引）
   └→ 订单服务（缓存商品信息）
```

## 五、底层本质

商品中心是**"主数据管理"**——CRUD 基础上叠加缓存、搜索、同步三层能力。核心矛盾是"读多写少"和"多下游同步"，解法是读写分离（缓存）+ 异步同步（Canal）。

## 常见考点
1. **商品改价怎么秒级生效**？——binlog → Canal → 删 Redis + 更 ES + 通知下游，秒级。
2. **SKU 价格怎么存**？——SKU 表独立 price 字段（不同规格不同价）。
3. **千万商品 ES 索引多大**？——单文档 1KB × 千万 = 10GB，分 5 分片每片 2GB。
