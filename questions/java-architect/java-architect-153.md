---
id: java-architect-153
difficulty: L3
category: java-architect
subcategory: 实时计算
title: ClickHouse 在实时分析场景中的架构
tags: [ClickHouse, MergeTree, 列存, 实时分析, OLAP]
related: [java-architect-152, java-architect-141, java-architect-155]
---

# ClickHouse 在实时分析场景中的架构

> **场景**：京东实时大盘——每秒 50 万订单事件、200 万浏览事件，要做秒级 GMV、转化漏斗、用户留存分析。MySQL 扛不住，Hive 延迟小时级。面试官问：ClickHouse 怎么扛这个量？

## 一、概念层：为什么是 ClickHouse

### 1.1 OLAP 场景的特点

| 特点 | OLTP（MySQL） | OLAP（ClickHouse） |
|------|---------------|---------------------|
| 查询类型 | 点查、小范围 | 大范围扫描、聚合 |
| 并发 | 高（万级 QPS） | 低（百级 QPS） |
| 写入 | 频繁单行 | 批量写入 |
| 数据量 | GB-TB | TB-PB |
| 延迟要求 | ms | s（可接受） |
| 索引 | B+Tree（精确查找） | 稀疏索引 + 列存（范围扫描） |

### 1.2 ClickHouse 的核心优势

- **列式存储**：只读需要的列，IO 减少 10-100 倍
- **向量化执行**：SIMD 指令批量处理，CPU 利用率极高
- **稀疏主键索引**：每 8192 行一个索引项，索引极小
- **MergeTree 引擎**：后台合并，支持分区、排序、TTL
- **高压缩比**：列内数据相似，压缩比 5-20 倍

### 1.3 不适合的场景

- 高频小批量写入（必须批量）
- 高并发点查（响应慢）
- 强一致事务（最终一致）
- 频繁 UPDATE/DELETE（异步、有代价）

## 二、机制层：MergeTree 引擎与架构

### 2.1 MergeTree 存储结构

```
表 t_order (partition: 2026-07-13)
├── 20260713_1_1_0/                    # partition_partition_min_max_level
│   ├── order_id.mrk2                  # 稀疏索引（每 8192 行）
│   ├── user_id.mrk2
│   ├── create_time.mrk2
│   ├── order_id.bin                   # 列存数据（LZ4 压缩）
│   ├── user_id.bin
│   ├── amount.bin
│   ├── primary.idx                    # 主键索引
│   └── checksums.txt
├── 20260713_2_2_0/                    # 新写入的 part
└── 20260713_1_2_1/                    # 后台合并后的 part
```

写入流程：
1. 写入一批数据 → 形成 part（一个目录）
2. 后台 merge：多个小 part 合并为大 part
3. 查询时并行扫描所有 part

### 2.2 表引擎选型

```sql
-- 1. MergeTree：基础引擎
CREATE TABLE t_order_mt (
    order_id UInt64,
    user_id UInt64,
    amount Decimal(18,2),
    create_time DateTime
) ENGINE = MergeTree()
PARTITION BY toYYYYMMDD(create_time)
ORDER BY (user_id, create_time)        -- 排序键 = 稀疏索引
SETTINGS index_granularity = 8192;

-- 2. ReplacingMergeTree：按主键去重（订单幂等）
CREATE TABLE t_order_dedup (
    order_id UInt64,
    user_id UInt64,
    amount Decimal(18,2),
    create_time DateTime,
    version UInt64                     -- 版本号，保留最大
) ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMMDD(create_time)
ORDER BY (order_id);                   -- 按 order_id 去重

-- 3. SummingMergeTree：预聚合（按维度求和）
CREATE TABLE t_user_stats (
    user_id UInt64,
    dt Date,
    order_cnt UInt32,
    total_amount Decimal(18,2)
) ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(dt)
ORDER BY (user_id, dt);

-- 4. AggregatingMergeTree + 物化视图：实时聚合
CREATE TABLE t_order_agg (
    dt Date,
    category String,
    order_cnt AggregateFunction(count, UInt64),
    total_amount AggregateFunction(sum, Decimal(18,2))
) ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(dt)
ORDER BY (dt, category);

-- 物化视图：源表写入时自动聚合
CREATE MATERIALIZED VIEW mv_order_agg TO t_order_agg AS
SELECT 
    toDate(create_time) AS dt,
    category,
    countState(order_id) AS order_cnt,
    sumState(amount) AS total_amount
FROM t_order_source
GROUP BY dt, category;
```

### 2.3 分布式架构

```
┌─────────────────────────────────────────────┐
│  ClickHouse Client / JDBC                   │
└───────────────┬─────────────────────────────┘
                │
┌───────────────▼─────────────────────────────┐
│  Distributed 表（虚拟表，路由查询）            │
└───┬───────────────────────────┬─────────────┘
    │                           │
┌───▼───────┐               ┌──▼───────────┐
│ Shard 1   │               │  Shard 2     │
│ (本地表)   │               │  (本地表)    │
│ ┌────────┐│               │┌────────┐    │
│ │Replica1││ ◄─ZK 同步──►  ││Replica1│    │
│ │Replica2││               ││Replica2│    │
│ └────────┘│               │└────────┘    │
└───────────┘               └──────────────┘
```

```sql
-- 本地表（每个 shard 上）
CREATE TABLE t_order_local ON CLUSTER cluster_jd (
    order_id UInt64,
    user_id UInt64,
    amount Decimal(18,2),
    create_time DateTime
) ENGINE = ReplicatedMergeTree(
    '/clickhouse/tables/{shard}/t_order_local',  -- ZK 路径
    '{replica}'                                    -- 副本名
)
PARTITION BY toYYYYMMDD(create_time)
ORDER BY (user_id, create_time);

-- 分布式表（虚拟表，查询入口）
CREATE TABLE t_order_dist ON CLUSTER cluster_jd AS t_order_local
ENGINE = Distributed(
    cluster_jd,
    default,
    t_order_local,
    rand()            -- 分片键：随机（或哈希）
);
```

## 三、实战层：JD 实时大盘架构

### 3.1 数据流

```
订单系统 → Kafka → ClickHouse（批量写入）
浏览日志 → Kafka → ClickHouse
                ↓
        物化视图预聚合
                ↓
        BI 报表（秒级延迟）
```

### 3.2 Java 写入（必须批量）

```java
@Service
@RequiredArgsConstructor
public class ClickHouseWriter {
    private final ClickHouseConnection connection;
    
    // 错误：单条插入（极慢）
    public void insertOne(Order order) {
        // INSERT INTO t_order VALUES (...)  -- 千万别这么干
    }
    
    // 正确：批量插入（每批 1-10 万行）
    @Scheduled(fixedDelay = 5000)  // 每 5 秒一批
    public void batchInsert() {
        List<Order> batch = orderBuffer.drain(100_000);
        if (batch.isEmpty()) return;
        
        String sql = "INSERT INTO t_order_dist (order_id, user_id, amount, create_time) VALUES ?";
        try (PreparedStatement ps = connection.prepareStatement(sql)) {
            for (Order o : batch) {
                ps.setLong(1, o.getOrderId());
                ps.setLong(2, o.getUserId());
                ps.setBigDecimal(3, o.getAmount());
                ps.setTimestamp(4, Timestamp.from(o.getCreateTime()));
                ps.addBatch();
            }
            ps.executeBatch();
        }
    }
}
```

或用 ClickHouse JDBC 的批量流式写入：

```java
public void streamInsert(List<Order> orders) throws SQLException {
    String sql = "INSERT INTO t_order_dist (order_id, user_id, amount, create_time)";
    try (ClickHousePreparedStatement ps = 
            (ClickHousePreparedStatement) connection.prepareStatement(sql)) {
        for (Order o : orders) {
            ps.setLong(1, o.getOrderId());
            ps.setLong(2, o.getUserId());
            ps.setBigDecimal(3, o.getAmount());
            ps.setTimestamp(4, Timestamp.from(o.getCreateTime()));
            ps.addBatch();
        }
        ps.executeBatch();
    }
}
```

### 3.3 实时查询示例

```java
@Repository
@RequiredArgsConstructor
public class RealtimeDashboardRepository {
    private final JdbcTemplate jdbc;
    
    // 实时 GMV（秒级）
    public BigDecimal realtimeGMV(LocalDate date) {
        return jdbc.queryForObject("""
            SELECT sum(amount) FROM t_order_dist 
            WHERE create_time >= ? AND create_time < ?
            """, BigDecimal.class, 
            date.atStartOfDay(), date.plusDays(1).atStartOfDay());
    }
    
    // 转化漏斗（用户行为路径分析）
    public List<FunnelStat> conversionFunnel(LocalDate date) {
        return jdbc.query("""
            SELECT 
                windowFunnel(1800)(create_time, 
                    event_type='view', event_type='cart', event_type='order'
                ) AS step
            FROM t_event_dist
            WHERE dt = ?
            GROUP BY user_id
            """, 
            (rs, i) -> new FunnelStat(rs.getInt("step")),
            date);
    }
    
    // 留存分析（7 日留存）
    public List<RetentionStat> retention(LocalDate cohortDate) {
        return jdbc.query("""
            SELECT 
                dateDiff('day', first_day, active_day) AS day_offset,
                count() AS user_cnt
            FROM (
                SELECT user_id,
                    min(dt) AS first_day,
                    dt AS active_day
                FROM t_user_active
                WHERE dt >= ?
                GROUP BY user_id, dt
            ) HAVING day_offset <= 7
            """, 
            (rs, i) -> new RetentionStat(rs.getInt("day_offset"), rs.getLong("user_cnt")),
            cohortDate);
    }
}
```

### 3.4 关键调优

```sql
-- 1. 分区设计：按天分区（查询常用维度）
PARTITION BY toYYYYMMDD(create_time)

-- 2. 排序键：高频过滤字段在前
ORDER BY (user_id, create_time)

-- 3. 稀疏索引粒度（默认 8192）
SETTINGS index_granularity = 8192

-- 4. TTL 自动清理过期数据
ALTER TABLE t_order MODIFY TTL create_time + INTERVAL 90 DAY;

-- 5. 压缩（LZ4 默认，ZSTD 更高压缩）
ALTER TABLE t_order MODIFY SETTING compress_codec = 'ZSTD';

-- 6. 跳数索引（数据跳过）
ALTER TABLE t_order ADD INDEX idx_amount amount TYPE minmax GRANULARITY 4;
ALTER TABLE t_order ADD INDEX idx_user user_id TYPE set(0) GRANULARITY 4;
```

## 四、底层本质：为什么列存快

### 4.1 First Principle：OLAP 是"列扫描"，OLTP 是"行查找"

OLAP 查询："统计昨天的总金额" → 只需要 `amount` 一列。
- 行存（MySQL）：读所有列的数据块，过滤出昨天的，浪费 IO
- 列存（ClickHouse）：只读 `create_time` 和 `amount` 两列，IO 减少 N 倍

加上向量化（SIMD 批量处理）+ 压缩（减少 IO）+ 稀疏索引（跳过无关数据块），ClickHouse 在 OLAP 上比 MySQL 快 100-1000 倍。

### 4.2 为什么不擅长更新删除

ClickHouse 的设计假设：**数据追加为主，更新删除少**。
- UPDATE/DELETE 是异步的 `ALTER ... UPDATE`（重写整个 part）
- 不支持事务
- 频繁更新会导致 part 爆炸

所以 ClickHouse 适合"日志型"数据（订单事件、浏览日志），不适合"状态型"数据（用户余额、库存）。

### 4.3 Feynman 解释

把数据想象成图书馆。
- 行存：每本书按"书号"排列，找一本书快（OLTP 点查）
- 列存：所有书的"书名"放一起、"作者"放一起、"价格"放一起
- OLAP 查询"统计所有书的价格总和"：列存只需翻"价格"那一摞，行存要把所有书都翻一遍

所以列存适合"统计"，行存适合"查找"。

## 五、AI 架构师加问

**Q1：ClickHouse 写入延迟多少？**
批量写入 1-10 万行/批，延迟 1-5 秒（含 part 形成）。实时性要求高的场景（< 1s）用 ClickHouse 的 Kafka 引擎或 MaterializedView 流式写入。

**Q2：ReplacingMergeTree 真的能去重吗？**
后台 merge 时才去重，查询时可能仍有重复。必须用 `SELECT FINAL` 或在查询层 `GROUP BY` 兜底。

**Q3：ClickHouse 高并发查询扛得住吗？**
单机 QPS 约 100（大查询），不是 OLTP。高并发报表要加缓存（Redis）或预聚合（物化视图）。

**Q4：物化视图什么时候刷新？**
同步刷新——源表写入时立即触发。所以物化视图会拖慢源表写入，慎用过多物化视图。

**Q5：ClickHouse vs Doris vs Druid 怎么选？**
- ClickHouse：单表查询极快，JOIN 弱，运维复杂
- Doris（StarRocks）：JOIN 强，运维友好，国产生态
- Druid：实时入库强，查询能力弱
- JD 实践：核心实时分析用 ClickHouse，新业务用 StarRocks

## 六、记忆口诀

```
列存向量化稀疏索引，OLAP 快百倍。
MergeTree 分区排序，物化视图预聚合。
批量写入必须万行起，单条插性能崩。
ReplacingMergeTree 去重，查询 FINAL 兜底。
分布式表路由查询，副本 ZK 同步。
JD 实时大盘，秒级 GMV 靠它扛。
```

## 七、苏格拉底追问

| 层级 | 问题 | 关键答案 |
|------|------|----------|
| L1 表象 | ClickHouse 为什么快？ | 列存 + 向量化 + 稀疏索引 + 高压缩 |
| L2 机制 | MergeTree 怎么工作？ | 写入成 part，后台 merge，查询并行扫描 |
| L3 边界 | ClickHouse 适合点查吗？ | 不适合，稀疏索引点查慢；高并发点查用 MySQL/Redis |
| L4 权衡 | ClickHouse vs MySQL？ | 前者 OLAP 扫描聚合快；后者 OLTP 点查事务强 |
| L5 反例 | 频繁 UPDATE 会怎样？ | part 爆炸、merge 跟不上、查询变慢 |
| L6 极限 | PB 级数据怎么查？ | 冷热分层（TTL + S3）+ 预聚合 + 分片 |
| L7 系统 | JD 实时数仓架构？ | Kafka → ClickHouse（明细）→ 物化视图（聚合）→ BI |

**对话还原**：
> 面试官：实时大盘怎么做？
> 我：Kafka 订阅订单事件，批量写入 ClickHouse 分布式表。物化视图按天按类目预聚合。BI 查询秒级返回。
> 面试官：QPS 多少？
> 我：写入 50w events/s（分片 10 节点）。查询并发 100 左右，每个查询 1-5s。
> 面试官：为什么不直接查 MySQL？
> 我：MySQL 扛不住大表聚合。我们订单表百亿行，ClickHouse 聚合秒级，MySQL 要分钟级。
> 面试官：物化视图拖慢写入吗？
> 我：会。我们只在核心指标用物化视图（GMV、订单数），非核心指标直接查明细表。
> 面试官：和 StarRocks 比？
> 我：ClickHouse 单表快但 JOIN 弱。我们新业务在转 StarRocks，多表 JOIN 更友好。

## 八、常见考点

1. **列存 vs 行存** —— OLAP vs OLTP 的根本差异
2. **MergeTree 引擎** —— 必考，要会建表
3. **稀疏索引** —— 每 8192 行一个索引项
4. **物化视图预聚合** —— 实时报表核心
5. **批量写入** —— 单条写入是反模式
6. **ReplacingMergeTree 去重** —— 查询需 FINAL
7. **分布式表 + 副本** —— Distributed + ReplicatedMergeTree
8. **ClickHouse vs Doris/Druid** —— 选型对比

## 结构化回答

**30 秒电梯演讲：** 京东实时大盘——每秒 50 万订单事件、200 万浏览事件，要做秒级 GMV、转化漏斗、用户留存分析。MySQL 扛不住，Hive 延迟小时级

**展开框架：**
1. **列存 vs 行存** — 列存 vs 行存 —— OLAP vs OLTP 的根本差异
2. **MergeTree 引擎** — MergeTree 引擎 —— 必考，要会建表
3. **稀疏索引** — 稀疏索引 —— 每 8192 行一个索引项

**收尾：** 以上是我的整体思路。您想继续深入聊——ClickHouse 为什么快？


## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：ClickHouse 在实时分析场景中的架构 | "这题一句话：京东实时大盘——每秒 50 万订单事件、200 万浏览事件，要做秒级 GMV、转化漏斗、用户留存分析。" | 开场钩子 |
| 0:15 | 列存 vs 行存示意/对比图 | "列存 vs 行存 —— OLAP vs OLTP 的根本差异" | 列存 vs 行存要点 |
| 0:40 | MergeTree 引擎示意/对比图 | "MergeTree 引擎 —— 必考，要会建表" | MergeTree 引擎要点 |
| 1:05 | 稀疏索引示意/对比图 | "稀疏索引 —— 每 8192 行一个索引项" | 稀疏索引要点 |
| 1:55 | 总结卡 | "记住：列存 vs 行存。下期见。" | 收尾 |
