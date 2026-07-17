---
id: java-architect-154
difficulty: L2
category: java-architect
subcategory: 中台架构
title: 湖仓一体与 Java 在线业务的数据边界
tags: [湖仓一体, 数据湖, Iceberg, Hudi, 数据边界]
related: [java-architect-153, java-architect-155, java-architect-141]
---

# 湖仓一体与 Java 在线业务的数据边界

> **场景**：京东有在线业务库（MySQL）、实时数仓（ClickHouse）、离线数仓（Hive）。数据散落三套系统，口径不一致、同步复杂。面试官问：湖仓一体（Lakehouse）怎么统一？Java 在线业务和湖仓的数据边界在哪？

## 一、概念层：湖仓一体是什么

### 1.1 数据架构演进

```
阶段1：数据库（单一） 
  → 业务+分析在一起，互相影响

阶段2：数据仓库（OLTP + OLAP 分离）
  → T+1 ETL 同步，离线分析
  → 实时性差、ETL 复杂

阶段3：数据湖（HDFS + 各种格式）
  → 海量原始数据存储
  → 缺事务、缺 schema 管理、质量差（数据沼泽）

阶段4：湖仓一体（Lakehouse）
  → 数据湖的存储成本 + 数据仓库的事务/Schema/BI 能力
  → 代表：Iceberg / Hudi / Delta Lake
```

### 1.2 湖仓一体的核心能力

| 能力 | 说明 |
|------|------|
| **ACID 事务** | 数据湖上的事务保证（Iceberg/Hudi） |
| **Schema 演化** | 加列/改列不影响历史数据 |
| **时间旅行** | 查询历史某个时刻的数据快照 |
| **Upsert/Delete** | 支持 CDC 增量更新（Hudi 强项） |
| **统一存储** | Parquet/ORC 开放格式，避免厂商锁定 |
| **批流一体** | 同一份数据同时支持批和流 |

### 1.3 湖仓 vs 数据仓库 vs 数据湖

| 维度 | 数据仓库 | 数据湖 | 湖仓一体 |
|------|----------|--------|----------|
| 存储 | 专有格式 | 开放格式（Parquet） | 开放格式 |
| 事务 | 强 ACID | 无 | ACID |
| Schema | 强 schema | schema-on-read | 强 schema + 演化 |
| 成本 | 高 | 低 | 低 |
| 实时 | 弱 | 弱 | 强（Hudi/Iceberg 流式） |
| 分析工具 | 厂商绑定 | 生态散 | 开放（Spark/Flink/Trino/Presto） |

## 二、机制层：三大湖仓格式

### 2.1 Apache Iceberg

**特点**：Schema 演化最强、查询规划快、批流一体。

```sql
-- Spark 创建 Iceberg 表
CREATE TABLE iceberg.jddj.t_order (
    order_id BIGINT,
    user_id BIGINT,
    amount DECIMAL(18,2),
    create_time TIMESTAMP,
    category STRING
) USING ICEBERG
PARTITIONED BY (days(create_time), category)
TBLPROPERTIES (
    'format-version' = '2',
    'write.format.default' = 'parquet',
    'write.parquet.compression-codec' = 'zstd'
);

-- 时间旅行
SELECT * FROM iceberg.jddj.t_order VERSION AS OF 12345;
SELECT * FROM iceberg.jddj.t_order TIMESTAMP AS OF '2026-07-13 10:00:00';

-- Schema 演化（加列不影响历史数据）
ALTER TABLE iceberg.jddj.t_order ADD COLUMN risk_level INT;

-- 分区演化（自动）
ALTER TABLE iceberg.jddj.t_order ADD PARTITION FIELD months(create_time);
```

Iceberg 元数据三层结构：
```
metadata file（JSON，记录 schema、分区、快照）
  └── manifest list（Avro，记录 manifest 文件）
        └── manifest（Avro，记录数据文件 + 统计信息）
              └── data files（Parquet）
```

查询时通过 manifest 的统计信息（min/max）跳过无关文件，极快。

### 2.2 Apache Hudi

**特点**：Upsert/Delete 能力最强、CDC 增量同步、流式写入友好。

```java
// Flink 写入 Hudi（CDC 同步 MySQL）
StreamExecutionEnvironment env = StreamExecutionEnvironment.getExecutionEnvironment();
env.enableCheckpointing(60_000);  // 60s checkpoint

Map<String, String> hudiOptions = new HashMap<>();
hudiOptions.put(FlinkOptions.PATH, "hdfs:///warehouse/hudi/t_order");
hudiOptions.put(FlinkOptions.TABLE_TYPE, "MERGE_ON_READ");  // MoR 适合频繁更新
hudiOptions.put(FlinkOptions.RECORD_KEY_FIELD, "order_id");
hudiOptions.put(FlinkOptions.PRECOMBINE_FIELD, "update_time");
hudiOptions.put(FlinkOptions.PARTITION_PATH_FIELD, "dt");

DataStream<RowData> cdcStream = MySqlSource.<RowData>builder()
    .hostname("mysql.jd.local").port(3306)
    .databaseList("trade_order").tableList("trade_order.t_order")
    .deserializer(new JsonDebeziumDeserializationSchema())
    .build();

cdcStream.addSink(new HudiSink(hudiOptions));
env.execute("mysql-to-hudi");
```

Hudi 两种表类型：
- **CoW（Copy on Write）**：写入时合并，读性能好，写慢
- **MoR（Merge on Read）**：增量写 log，读时合并，写快读稍慢

### 2.3 Delta Lake（Databricks）

**特点**：Spark 原生集成最深、事务日志简单。

```sql
-- Delta 表（Spark SQL）
CREATE TABLE delta.jddj.t_order (...)
USING DELTA
PARTITIONED BY (dt STRING)
LOCATION 'hdfs:///warehouse/delta/t_order';

-- 流批一体写入
INSERT INTO delta.jddj.t_order SELECT * FROM temp_view;

-- MERGE（Upsert）
MERGE INTO delta.jddj.t_order t
USING temp_updates u
ON t.order_id = u.order_id
WHEN MATCHED THEN UPDATE SET *
WHEN NOT MATCHED THEN INSERT *;

-- 时间旅行
DESCRIBE HISTORY delta.jddj.t_order;
SELECT * FROM delta.jddj.t_order VERSION AS OF 5;
```

### 2.4 三者选型

| 维度 | Iceberg | Hudi | Delta |
|------|---------|------|-------|
| Schema 演化 | 最强 | 强 | 强 |
| Upsert/CDC | 弱 | 最强 | 强 |
| 流式写入 | 中 | 最强 | 强 |
| 引擎兼容 | Spark/Flink/Trino/Athena | Spark/Flink | Spark 最深 |
| 国内生态 | 字节/腾讯推 | 阿里推 | Databricks |
| JD 选用 | 主推（新业务） | 老业务 | 少 |

## 三、实战层：Java 业务与湖仓的数据边界

### 3.1 数据边界划分原则

```
┌─────────────────────────────────────────────┐
│  在线业务库（MySQL/TiDB）                     │
│    - 当前态数据（订单、用户、库存）             │
│    - 强一致、低延迟、高并发                    │
│    - Java 应用直接读写                        │
└───────────────┬─────────────────────────────┘
                │ CDC（Debezium/Canal）
┌───────────────▼─────────────────────────────┐
│  实时数仓（ClickHouse / Hudi MoR）            │
│    - 秒级延迟的实时分析                        │
│    - 大盘、报表、实时推荐                      │
│    - Java 应用只读，不写                       │
└───────────────┬─────────────────────────────┘
                │ 批量同步（Spark/Flink）
┌───────────────▼─────────────────────────────┐
│  离线湖仓（Iceberg on S3/HDFS）               │
│    - 全量历史数据（PB 级）                     │
│    - 离线分析、机器学习、数据回溯               │
│    - Java 应用不直接访问，通过 Spark/Trino      │
└─────────────────────────────────────────────┘
```

**边界原则**：
1. **Java 在线业务只写 MySQL/TiDB**，不写湖仓
2. **湖仓数据通过 CDC/批量同步流入**，单向
3. **Java 实时查询走 ClickHouse 或 Hudi MoR**（只读）
4. **离线分析走 Spark/Trino 查 Iceberg**，不走 Java 应用

### 3.2 Java 应用对接湖仓（只读分析）

```java
// 方式1：JDBC 连 Trino（查 Iceberg/Hudi）
@Bean
@ConfigurationProperties(prefix = "spring.datasource.trino")
public DataSource trinoDataSource() {
    return DataSourceBuilder.create()
        .type(HikariDataSource.class)
        .build();
    // url: jdbc:trino://trino-coordinator.jd.local:8080/iceberg/jddj
}

@Repository
@RequiredArgsConstructor
public class AnalyticsRepository {
    private final JdbcTemplate trinoJdbc;  // 通过 Trino 查 Iceberg
    
    public List<CategorySales> categorySalesLast30Days() {
        return trinoJdbc.query("""
            SELECT category, sum(amount) AS total
            FROM iceberg.jddj.t_order
            WHERE create_time >= current_date - interval '30' day
            GROUP BY category ORDER BY total DESC
            """, 
            (rs, i) -> new CategorySales(rs.getString("category"), 
                                         rs.getBigDecimal("total")));
    }
}

// 方式2：Spark Submit 提交离线任务（非实时）
// Java 应用通过 API 触发 Spark 任务，不直接查
```

### 3.3 反向回流（湖仓 → 在线库）

某些场景需要把湖仓计算的结果回写到在线库（如用户标签）：

```java
// 湖仓计算结果 → Kafka → Java 应用消费写 Redis/MySQL
@KafkaListener(topics = "user-label-update")
public void onLabelUpdate(UserLabel label) {
    redis.opsForValue().set("user:label:" + label.getUserId(), 
                            label.getLabelsJson());
    // 同步写 MySQL（供强一致查询）
    userLabelMapper.upsert(label);
}
```

**原则**：湖仓 → 在线库只走异步通道（Kafka），绝不让 Java 应用同步查湖仓（延迟太高）。

### 3.4 数据一致性治理

```sql
-- 数据对账：在线库 vs 湖仓
-- 在线库
SELECT date(create_time) AS dt, count(*) AS cnt, sum(amount) AS amt
FROM t_order WHERE create_time >= '2026-07-13' AND create_time < '2026-07-14'
GROUP BY date(create_time);

-- 湖仓（Iceberg）
SELECT date(create_time) AS dt, count(*) AS cnt, sum(amount) AS amt
FROM iceberg.jddj.t_order WHERE create_time >= '2026-07-13' AND create_time < '2026-07-14'
GROUP BY date(create_time);

-- 差异超阈值（0.01%）告警
```

JD 实践：T+1 自动对账，差异 > 0.01% 触发告警 + 人工排查。

## 四、底层本质：为什么需要湖仓一体

### 4.1 First Principle：一份数据，多种用途

传统架构痛点：
- 在线库（MySQL）→ ETL → 数仓（Hive）：T+1 延迟
- 实时数仓（ClickHouse）→ 独立存储：数据冗余
- 数据湖（HDFS）→ 无 schema 无事务：数据沼泽

湖仓一体的核心：**一份开放格式（Parquet + Iceberg）的数据，同时支持批处理（Spark）、流处理（Flink）、即席查询（Trino）、机器学习**。避免数据冗余、口径不一致。

### 4.2 Java 在线业务的边界

Java 在线业务的核心诉求：**低延迟、高并发、强一致**。
- 读写：MySQL/TiDB（ms 级）
- 实时读：ClickHouse / Redis（ms-秒级）
- 离线读：Spark/Trino 查湖仓（秒-分钟级）

**湖仓不是为在线业务设计的**——它的查询延迟（秒级）和并发能力（百级 QPS）不满足在线业务要求。Java 应用对接湖仓只做**离线分析、批量回流**，不做实时交易。

### 4.3 Feynman 解释

把数据想象成"图书馆藏书"。
- 在线库（MySQL）：放在前台的"常用书架"，随手取用（快）
- 实时数仓（ClickHouse）：放在隔壁的"参考资料室"，查资料快但不能改
- 湖仓（Iceberg on S3）：放在地下室的"档案库"，海量、全量、可追溯
- 湖仓一体：把档案库升级成"智能档案库"——有目录、有索引、有版本、能多人查

边界：前台业务员（Java 应用）只在前台工作，不去地下室翻档案；需要档案时让管理员（Spark/Flink）去取。

## 五、AI 架构师加问

**Q1：为什么 Java 应用不直接查湖仓？**
延迟和并发不匹配。湖仓查询秒级，在线业务要求 ms 级；湖仓并发百级，在线业务要求万级。中间需要 Redis/ClickHouse 缓冲。

**Q2：Iceberg 和 Hudi 选哪个？**
- 写多读少、CDC 增量同步多 → Hudi（Upsert 强）
- Schema 频繁演化、多引擎查询 → Iceberg（兼容性好）
- 已经深度用 Spark → Delta

**Q3：湖仓能替代实时数仓（ClickHouse）吗？**
部分场景可以（Hudi MoR + Presto），但极致实时性能（秒级大盘、高并发）仍需 ClickHouse。湖仓偏"准实时"（分钟级）。

**Q4：数据回流怎么保证一致性？**
CDC 全链路（MySQL→Kafka→Hudi→Kafka→MySQL），每段都有幂等 + 对账。T+1 对账差异 < 0.01%。

**Q5：JD 的湖仓技术栈？**
- 存储：S3（对象存储，成本低）
- 表格式：Iceberg（新业务）/ Hudi（老业务）
- 计算：Spark（批）、Flink（流）、Trino（即席）
- 元数据：Hive Metastore 兼容

## 六、记忆口诀

```
湖仓一体：开放格式 + ACID + Schema + 批流。
Iceberg 演化强，Hudi Upsert 强，Delta Spark 深。
Java 在线只读不写湖仓，边界划清不越线。
在线 MySQL，实时 ClickHouse，离线 Iceberg。
CDC 单向流，回流走 Kafka，T+1 对账保一致。
一份存多种用途，避免数据沼泽和冗余。
```

## 七、苏格拉底追问

| 层级 | 问题 | 关键答案 |
|------|------|----------|
| L1 表象 | 湖仓一体和数据湖什么区别？ | 加了 ACID + Schema + 事务，不是"沼泽" |
| L2 机制 | Iceberg 怎么实现时间旅行？ | 快照（snapshot）+ manifest 记录每次变更 |
| L3 边界 | Java 应用为什么不直接查湖仓？ | 延迟秒级、并发百级，不满足在线 ms 级要求 |
| L4 权衡 | Iceberg vs Hudi？ | 前者查询/演化强；后者 Upsert/CDC 强 |
| L5 反例 | 湖仓完全替代实时数仓？ | 不行，极致实时（秒级大盘）仍需 ClickHouse |
| L6 极限 | PB 级湖仓查询怎么加速？ | 分区 + 排序 + 跳数索引 + 物化视图 + Trino 协调器 |
| L7 系统 | JD 多业务线数据怎么统一？ | 统一入湖（Iceberg），各业务通过 Trino/Spark 查询 |

**对话还原**：
> 面试官：你们湖仓怎么搭的？
> 我：S3 + Iceberg + Spark/Flink/Trino。MySQL CDC 同步入湖，Java 应用不直接查，走 ClickHouse 实时层或 Trino 离线分析。
> 面试官：为什么不用 Hive？
> 我：Hive 无事务、无 Upsert、Schema 演化差。Iceberg 有 ACID 和时间旅行，更适合。
> 面试官：Java 应用和湖仓的边界？
> 我：Java 只写 MySQL，湖仓数据单向流入。回流走 Kafka 异步。Java 实时查 ClickHouse，离线通过 Trino API 触发。
> 面试官：一致性怎么保证？
> 我：CDC 全链路幂等，T+1 自动对账，差异 > 0.01% 告警。
> 面试官：Iceberg 和 Hudi？
> 我：新业务用 Iceberg（查询强），老 CDC 业务用 Hudi（Upsert 强）。

## 八、常见考点

1. **湖仓一体定义** —— 数据湖 + 仓库能力（ACID/Schema/BI）
2. **三大格式对比** —— Iceberg/Hudi/Delta 各有强项
3. **Java 业务边界** —— 在线只读写 MySQL，湖仓单向流入
4. **CDC 全链路** —— MySQL→Kafka→Hudi→Kafka→应用
5. **时间旅行** —— Iceberg snapshot 机制
6. **Schema 演化** —— 加列不影响历史数据
7. **批流一体** —— 同一份数据支持批和流
8. **数据对账** —— T+1 差异 < 0.01%

## 结构化回答

**30 秒电梯演讲：** 京东有在线业务库（MySQL）、实时数仓（ClickHouse）、离线数仓（Hive）。数据散落三套系统，口径不一致、同步复杂

**展开框架：**
1. **湖仓一体定义** — 湖仓一体定义 —— 数据湖 + 仓库能力（ACID/Schema/BI）
2. **三大格式对比** — 三大格式对比 —— Iceberg/Hudi/Delta 各有强项
3. **Java 业务边界** — Java 业务边界 —— 在线只读写 MySQL，湖仓单向流入

**收尾：** 以上是我的整体思路。您想继续深入聊——湖仓一体和数据湖什么区别？


## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：湖仓一体与 Java 在线业务的数据边界 | "这题一句话：京东有在线业务库（MySQL）、实时数仓（ClickHouse）、离线数仓（Hive）。" | 开场钩子 |
| 0:15 | 湖仓一体定义示意/对比图 | "湖仓一体定义 —— 数据湖 + 仓库能力（ACID/Schema/BI）" | 湖仓一体定义要点 |
| 0:40 | 三大格式对比示意/对比图 | "三大格式对比 —— Iceberg/Hudi/Delta 各有强项" | 三大格式对比要点 |
| 1:25 | 总结卡 | "记住：湖仓一体定义。下期见。" | 收尾 |
