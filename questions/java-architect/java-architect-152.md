---
id: java-architect-152
difficulty: L2
category: java-architect
subcategory: 分库分表
title: TiDB / 分布式数据库的适用场景与代价
tags: [TiDB, NewSQL, 分布式数据库, HTAP, 分库分表]
related: [java-architect-151, java-architect-149, java-architect-150]
---

# TiDB / 分布式数据库的适用场景与代价

> **场景**：京东金融的交易表单库已经 5TB，ShardingSphere 分了 64 库，扩容困难。考虑迁 TiDB。面试官问：分布式数据库什么时候值得用？代价是什么？

## 一、概念层：NewSQL 的定位

### 1.1 三代数据库演进

| 代际 | 代表 | 特点 |
|------|------|------|
| **单机 OLTP** | MySQL/PostgreSQL | ACID 强、扩展性差 |
| **分库分表** | MySQL + ShardingSphere | 横向扩展、跨库事务难、运维复杂 |
| **NoSQL** | MongoDB/Cassandra | 海量扩展、弱事务、最终一致 |
| **NewSQL** | TiDB/CockroachDB/YugabyteDB | ACID + 水平扩展 + SQL 兼容 |

### 1.2 TiDB 的核心承诺

- **MySQL 协议兼容**：Java 应用几乎无感迁移
- **水平扩展**：加节点即扩容，无需 reshard
- **分布式 ACID**：跨节点事务强一致（Percolator 算法）
- **HTAP**：行存（TiKV）+ 列存（TiFlash），OLTP + OLAP 一体

### 1.3 适用 vs 不适用

| 适用场景 | 不适用场景 |
|----------|------------|
| 单表 TB 级 | 单表 < 100GB |
| 持续增长、无法预估容量 | 容量稳定 |
| 跨库聚合查询多（报表） | 简单 CRUD |
| 需要实时分析（HTAP） | 纯 OLTP |
| 运维团队愿意学习新栈 | 团队 MySQL 经验有限 |

## 二、机制层：TiDB 架构

### 2.1 三层架构

```
┌─────────────────────────────────────────────┐
│  TiDB Server（无状态 SQL 层）                 │
│    - 解析 SQL、CBO 优化、执行                 │
│    - 多副本，可水平扩展                        │
│    - MySQL 协议兼容                           │
└───────────────┬─────────────────────────────┘
                │ gRPC
┌───────────────▼─────────────────────────────┐
│  PD (Placement Driver)                       │
│    - 元数据管理（region 分布）                │
│    - 调度（负载均衡、副本迁移）                │
│    - 时间戳分配（TSO，全局时钟）               │
└───────────────┬─────────────────────────────┘
                │
┌───────────────▼─────────────────────────────┐
│  TiKV（分布式 KV 存储，行存）                  │
│    - Raft 多副本（默认 3 副本）                │
│    - Region（96MB 一片）自动分裂/迁移          │
│    - RocksDB 单机存储引擎                     │
└─────────────────────────────────────────────┘
┌─────────────────────────────────────────────┐
│  TiFlash（列存副本，HTAP 分析）                │
│    - 异步复制 TiKV 数据（Raft Learner）        │
│    - 列式存储，OLAP 查询飞快                   │
└─────────────────────────────────────────────┘
```

### 2.2 数据分片：Region

- 表数据按主键范围切成 **Region**（默认 96MB）
- Region 自动分裂（太大）和合并（太小）
- PD 调度 Region 到不同 TiKV 节点，保证负载均衡
- 跨 Region 查询由 TiDB Server 协调

### 2.3 分布式事务：Percolator

```
T1: Prewrite（写.Primary Lock + 写.Secondary Lock + 写数据）
    - 选一个参与节点为 Primary（事务协调者）
    - 其他节点为 Secondary
T2: Commit（删.Primary Lock + 写.Commit Timestamp）
    - Primary 成功 = 事务成功
    - 异步清理 Secondary（或下次读时清理）
```

特点：
- 两阶段提交（2PC）
- 通过 Primary Lock 保证原子性
- Coordinator（TiDB Server）故障时，Secondary 通过查 Primary 决定提交/回滚

### 2.4 HTAP：TiFlash

```
应用写入 ──→ TiDB ──→ TiKV（行存，OLTP）
                      │
                      └─Raft Learner 异步复制──→ TiFlash（列存，OLAP）
                      
OLAP 查询 ──→ TiDB ──→ 路由到 TiFlash（列存查询快）
```

- TiFlash 是 TiKV 的**强一致副本**（Raft Learner + read index）
- TiDB 优化器自动选择：OLTP 查 TiKV，OLAP 查 TiFlash
- 业务无感，一套数据两种查询

## 三、实战层：JD 金融迁移实践

### 3.1 迁移前评估

```sql
-- 1. 单库容量
SELECT 
  table_schema,
  ROUND(SUM(data_length + index_length) / 1024 / 1024 / 1024, 2) AS size_gb
FROM information_schema.tables
GROUP BY table_schema;

-- 2. 慢查询占比
SELECT * FROM mysql.slow_log WHERE query_time > 1 ORDER BY query_time DESC LIMIT 100;

-- 3. 跨库 JOIN 频率（ShardingSphere 无法跨库 JOIN 的痛点）
```

### 3.2 数据迁移（DM + Lightning）

```yaml
# DM（Data Migration）配置：MySQL → TiDB 实时同步
---
source-id: "mysql-source-1"
enable-gtid: true
from:
  host: mysql-master.jd.local
  port: 3306
  user: dm
  password: ********

task:
  name: migrate-trade-order
  task-mode: all          # 全量 + 增量
  target-database:
    host: tidb.jd.local
    port: 4000
    user: root
  mysql-instances:
    - source-id: mysql-source-1
      block-allow-list: trade-only      # 白名单
  block-allow-list:
    trade-only:
      do-dbs: ["trade_order"]
```

全量阶段用 TiDB Lightning（物理导入，速度快）：

```bash
tiup tidb-lightning \
  --tidb-host=tidb.jd.local --tidb-port=4000 \
  --tidb-user=root --tidb-password=******** \
  --pd-urls=pd.jd.local:2379 \
  --sorted-kv-dir=/tmp/sorted-kv \
  --data-source-dir=/backup/mysql-dump
```

### 3.3 Java 应用适配

```yaml
# 仅改 URL 和驱动，几乎无感
spring:
  datasource:
    url: jdbc:mysql://tidb.jd.local:4000/trade_order?useSSL=false  # TiDB 兼容 MySQL 协议
    driver-class-name: com.mysql.cj.jdbc.Driver
    hikari:
      maximum-pool-size: 50
```

```java
// HINT 强制走 TiFlash（OLAP 查询）
@Query(value = """
    SELECT /*+ read_from_storage(tiflash[t_order]) */ 
        DATE(create_time) AS dt, 
        COUNT(*) AS order_cnt,
        SUM(amount) AS total_amount
    FROM t_order 
    WHERE create_time >= :startDate 
    GROUP BY DATE(create_time)
    """, nativeQuery = true)
List<DailyStats> findDailyStats(@Param("startDate") LocalDate startDate);
```

### 3.4 关键调优

```sql
-- TiDB 参数
SET GLOBAL tidb_init_chunk_size = 64;
SET GLOBAL tidb_max_chunk_size = 1024;
SET GLOBAL tidb_index_serial_scan_concurrency = 4;

-- 统计信息（CBO 必需）
ANALYZE TABLE t_order WITH 256 BUCKETS;  -- 手动统计
-- 或自动统计
SET GLOBAL tidb_auto_analyze_ratio = 0.2;  -- 20% 变更触发
```

## 四、底层本质：分布式数据库的代价

### 4.1 First Principle：分布式 = 一致性 + 延迟的权衡

TiDB 的 ACID 是用**延迟换的**：
- 单机 MySQL 写入：1 次 fsync，1-2ms
- TiDB 写入：1 次 PD 取时间戳（网络 RTT）+ 2PC（多次网络 RTT）+ 多副本 Raft（多次网络 RTT），通常 10-20ms

**所以 TiDB 的单条写入延迟必然高于单机 MySQL**。适合高吞吐、对单条延迟不敏感的场景；不适合要求亚毫秒级延迟的核心交易。

### 4.2 TSO 的瓶颈

全局时钟（TSO）由单点 PD 提供。每次事务都要向 PD 取时间戳，PD 成为潜在瓶颈。优化：
- PD 批量发时间戳（一次发一批）
- PD 集群多副本（Raft）

极端高并发下，TSO 仍是 TiDB 的天花板。

### 4.3 代价清单

| 代价 | 表现 |
|------|------|
| 写延迟 | 比单机 MySQL 高 3-5 倍（10-20ms） |
| 资源开销 | 3 副本，存储成本 3 倍 |
| 运维复杂 | 多组件（TiDB/PD/TiKV/TiFlash） |
| 事务限制 | 大事务有限制（默认 100MB） |
| 学习曲线 | 监控/调优/故障排查都不同 |

### 4.4 Feynman 解释

单机 MySQL 像一家小店——老板自己记账，快但容量有限。
分库分表像开 64 家分店——每家自己记账，但要汇总时报表痛苦（跨库 JOIN）。
TiDB 像一家全国连锁——总部（PD）统一编号，各分店（TiKV）记账但实时同步到总部，总部保证一致性。代价是每笔账要走两次流程（2PC），慢一点但能无限扩张。

## 五、AI 架构师加问

**Q1：TiDB 和 ShardingSphere 怎么选？**
- 数据量 < 5TB、查询简单 → ShardingSphere + MySQL（成本低、运维熟）
- 数据量 > 5TB、跨库聚合多、需要 HTAP → TiDB（运维贵但省心）
- JD 金融选 TiDB：交易表 5TB+，分库 64 个已到极限，跨库报表痛苦

**Q2：TiDB 的事务延迟为什么高？**
2PC + Raft + TSO 取时间戳，至少 3 次网络 RTT。优化：缩短网络（同机房）、批量提交、本地缓存 TSO。

**Q3：TiDB 适合高并发写入吗？**
适合。水平扩展，加 TiKV 节点即扩容。但单条延迟高于 MySQL，适合"高吞吐、可接受 10ms 延迟"的场景。

**Q4：TiFlash 真的能替代数仓吗？**
部分场景可以。TiFlash 列存查询 OLAP 性能接近 ClickHouse（同等数据量）。但极致分析性能（百亿行聚合）仍不如专用 OLAP。JD 用 TiFlash 做实时报表，离线分析仍走 ClickHouse。

**Q5：TiDB 大事务（如百万行更新）怎么做？**
- 默认事务大小限制 100MB
- 大事务拆分：分批 1 万行提交
- 用 TiDB Lightning 做大批量导入（绕过事务）

## 六、记忆口诀

```
NewSQL 三承诺：水平扩展、ACID、SQL兼容。
TiDB 三层：SQL层 TiDB、调度 PD、存储 TiKV。
事务 Percolator 两阶段，Primary Lock 保原子。
HTAP 行存加列存，TiFlash 异步副本查得快。
写延迟比单机高，三倍存储是代价。
数据量过五 T 考虑上，简单 CRUD 不必迁。
```

## 七、苏格拉底追问

| 层级 | 问题 | 关键答案 |
|------|------|----------|
| L1 表象 | TiDB 比 MySQL 强在哪？ | 水平扩展、分布式 ACID、HTAP |
| L2 机制 | TiDB 怎么分片？ | Region（96MB）按主键范围切，PD 调度 |
| L3 边界 | TiDB 写延迟为什么高？ | 2PC + Raft + TSO，3 次以上网络 RTT |
| L4 权衡 | TiDB vs ShardingSphere？ | 前者自动扩缩容但延迟高；后者成本低但运维复杂 |
| L5 反例 | TiDB 适合超低延迟交易？ | 不适合，单条写入 10-20ms，核心交易仍用单机 MySQL |
| L6 极限 | 100TB 数据怎么做？ | 加 TiKV 节点扩容 + TiFlash 做 OLAP + 热数据本地缓存 |
| L7 系统 | JD 多业务线 TiDB + MySQL 共存？ | 核心交易 MySQL、金融大表 TiDB、分析 ClickHouse |

**对话还原**：
> 面试官：你们为什么选 TiDB？
> 我：交易表 5TB，ShardingSphere 分 64 库到极限，跨库报表痛苦。TiDB 自动分片 + HTAP 解决两个问题。
> 面试官：迁移成本？
> 我：DM 全量 + 增量同步，双写灰度，验证后切量。应用几乎无感（MySQL 协议兼容）。
> 面试官：写延迟比 MySQL 高吗？
> 我：高 3-5 倍，10-20ms。但金融交易对延迟不像电商那么敏感，可接受。
> 面试官：TiFlash 真的替代数仓？
> 我：实时报表替代了，但离线百亿行分析还是 ClickHouse。TiFlash 适合中等数据量 + 实时。
> 面试官：TSO 单点瓶颈？
> 我：PD 批量发时间戳 + 集群多副本。我们 3 PD 节点，目前 5w TPS 没到瓶颈。

## 八、常见考点

1. **TiDB 三层架构** —— TiDB/PD/TiKV/TiFlash
2. **Region 自动分片** —— 96MB 切片
3. **Percolator 事务模型** —— 2PC + Primary Lock
4. **HTAP 行存 + 列存** —— TiFlash 异步副本
5. **写延迟代价** —— 比单机 MySQL 高 3-5 倍
6. **TiDB vs ShardingSphere** —— 自动化 vs 成本
7. **迁移方案** —— DM + Lightning + 双写灰度
8. **适用边界** —— TB 级 + HTAP 用 TiDB，简单 OLTP 用 MySQL

## 结构化回答

**30 秒电梯演讲：** 京东金融的交易表单库已经 5TB，ShardingSphere 分了 64 库，扩容困难。考虑迁 TiDB

**展开框架：**
1. **TiDB 三层架构** — TiDB 三层架构 —— TiDB/PD/TiKV/TiFlash
2. **Region 自动分片** — Region 自动分片 —— 96MB 切片
3. **Percolator 事务模型** — Percolator 事务模型 —— 2PC + Primary Lock

**收尾：** 以上是我的整体思路。您想继续深入聊——TiDB 比 MySQL 强在哪？


## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：TiDB / 分布式数据库的适用场景与代价 | "这题一句话：京东金融的交易表单库已经 5TB，ShardingSphere 分了 64 库，扩容困难。" | 开场钩子 |
| 0:15 | TiDB 三层架构示意/对比图 | "TiDB 三层架构 —— TiDB/PD/TiKV/TiFlash" | TiDB 三层架构要点 |
| 0:40 | Region 自动分片示意/对比图 | "Region 自动分片 —— 96MB 切片" | Region 自动分片要点 |
| 1:25 | 总结卡 | "记住：TiDB 三层架构。下期见。" | 收尾 |
