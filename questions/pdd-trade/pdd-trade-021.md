---
id: pdd-trade-021
difficulty: L4
category: pdd-trade
subcategory: 交易架构
tags:
- 拼多多
- 交易
- 订单中心
- 分库分表
- CQRS
feynman:
  essence: 订单中心是"订单数据的单一真相源"——接单/状态/履约/财务一体化，用分库分表扛亿级订单、用 CQRS 分离读写、用 Outbox 保证事件可靠。
  analogy: 订单中心像"医院病历室"——所有就诊记录（订单）按身份证（用户）归档，分诊（分库）、电子化（CQRS）、备份（多活），各科室（业务）随时查阅。
  first_principle: 订单是交易的核心数据资产，需要统一存储/查询/分析，单库扛不住规模，需分库分表+读写分离。
  key_points:
  - 分库分表：order_id 路由（一致性 hash）+ 用户维度查询（基因法）
  - CQRS：写 MySQL（事务），读 ES/HBase（多维度查询）
  - 状态机 + 领域事件驱动下游
  - 冷热分离：热表（近 3 月）+ 冷存（HBase/OSS）
first_principle:
  problem: 亿级订单如何高效存储、多维查询、长期归档？
  axioms:
  - 单库容量/QPS 上限
  - 多维度查询（按 UID/商户/时间/状态）
  - 历史订单冷数据占大头
  rebuild: 分库分表（写）+ ES/HBase（多维读）+ 冷热分离归档。
follow_up:
  - 按 UID 查和按商户查怎么都支持？——基因法分片（UID 路由信息嵌入 order_id）+ 二级索引
  - 订单数据怎么归档？——3 月前转 HBase/OSS，热表只留近期
  - 订单号怎么生成？——雪花算法+基因（UID 后几位嵌入），保证按 UID 反查
memory_points:
  - 分库分表：order_id 路由（基因法）
  - CQRS：MySQL 写、ES/HBase 读
  - 状态机+领域事件驱动下游
  - 冷热分离：热 MySQL + 冷 HBase
---

# 【拼多多交易】订单中心怎么设计？

> JD 依据："订单/用户业务"、"交易系统技术升级"。

## 一、整体架构

```
             ┌─ 创单 → MySQL（分库分表，写）
交易网关 ───→ ├─ 查询 → ES（多维查）/ HBase（明细）
             ├─ 状态机驱动 → Kafka 事件
             └─ 冷热分离 → 归档到 HBase/OSS
```

## 二、分库分表（核心）

**分片键**：`order_id`（一致性 hash 路由到库表）

**基因法**（让 order_id 含 UID 信息，支持按 UID 反查）：
```java
// 生成 order_id：时间戳 + UID 后 4 位（基因）+ 序列号
long orderId = (timestamp << 20) | (uid & 0xFFFF) << 4 | seq;
// 按 UID 查：从 order_id 提取基因反推库表（或扫全表+二级索引）
```

**分片策略**：
```
库数：64 库 × 64 表 = 4096 分片
单分片：≈ 2500 万订单（亿级 / 4096）
扩容：2 倍扩容法，分片位预留
```

## 三、CQRS（读写分离）

```java
// 写：MySQL（事务一致性）
@Transactional
public void create(Order o) {
    orderDao.insert(o);
    outboxDao.insert(new Outbox("OrderCreated", o));  // 同事务事件
}

// 同步：Binlog/Canal → ES（多维查询）
// 读：ES（按 UID/状态/时间/商户任意维度）
public Page<Order> search(OrderQuery q) {
    return esOrderDao.search(q);  // 聚合/分页/模糊
}
```

## 四、订单状态机 + 领域事件

```
待支付 → 已支付 → 已发货 → 已完成
   ↓       ↓        ↓
 已取消  退款中    退款中

状态变更同事务发 Outbox → Kafka → 下游订阅
  履约：发货
  营销：发券/积分
  财务：分账
```

## 五、冷热数据分离

| 数据 | 存储 | 查询频次 |
|------|------|----------|
| 近 3 月 | MySQL 热库 | 高（用户/客服） |
| 3 月-2 年 | HBase | 中（客服/对账） |
| 2 年+ | OSS + 索引 | 低（合规/审计） |

归档任务：每天凌晨 T+1 把"已完结 90 天"订单迁到 HBase，MySQL 删除。

## 六、底层本质

订单中心本质是**"用分片+读写分离+冷热分层应对规模增长"**——分库分表扛写、ES 扛多维读、HBase 扛冷存，用 Outbox 保证事件可靠。

## 常见考点
1. **基因法怎么实现**？——UID 后几位嵌入 order_id，分片路由时用基因定位。
2. **ES 数据怎么和 MySQL 一致**？——Binlog/Canal 增量同步 + 定时全量对账。
3. **订单归档怎么不停服**？——双写过渡期 + 灰度切读 + 验证一致后下线旧库。
