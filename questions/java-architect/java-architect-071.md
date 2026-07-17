---
id: java-architect-071
difficulty: L2
category: java-architect
subcategory: 中台架构
tags:
- Java 架构师
- 数仓
- 湖仓
- 数据闭环
- 中台
feynman:
  essence: 数据闭环是"在线业务产生数据 → 离线数仓分析 → 反哺在线业务"的循环。电商场景：用户浏览下单（在线）→ 数据进数仓分析用户偏好（离线）→ 算法用分析结果做推荐（在线）。核心矛盾是"离线批处理（小时/天级）vs 在线实时（秒级）"，解法是"湖仓一体（Data Lakehouse）+ Lambda/Kappa 架构"——离线数仓做深度分析，实时链路做即时反馈，两者数据统一存储（湖仓）。
  analogy: 像餐厅经营。点餐（在线业务）→ 月底汇总分析"哪道菜热销/哪时段客流大"（离线数仓）→ 据此调整菜单和备货（反哺在线）。如果只顾在线不做分析，盲目经营；只分析不反哺，数据白算。闭环是"业务→数据→洞察→业务优化"的飞轮。
  first_principle: 为什么要有离线数仓（不能只靠在线数据库）？因为在线 DB 为事务优化（增删改查快），不适合复杂分析（亿级数据 GROUP BY/JOIN 慢）。数仓为分析优化（列存/分区/索引），支持大数据复杂查询。两者分工——在线 DB 跑业务，数仓跑分析，结果回流优化业务。
  key_points:
  - 数据闭环：在线业务 → 数据采集 → 数仓分析 → 反哺在线
  - 数仓分层：ODS（原始）→ DWD（明细）→ DWS（汇总）→ ADS（应用）
  - 湖仓一体：数据湖（海量原始）+ 数据仓库（结构化分析），统一存储
  - Lambda 架构：批层（离线）+ 流层（实时）+ 服务层（合并）
  - Kappa 架构：只流处理（流批一体），简化 Lambda
first_principle:
  problem: 在线业务产生海量数据，怎么分析利用反哺业务，形成数据闭环？
  axioms:
  - 在线 DB 不适合复杂分析（事务优化，分析慢）
  - 离线数仓分析深度（复杂查询），但延迟（天级）
  - 实时业务需要秒级反馈（离线不够快）
  - 数据要流动（在线→离线→在线闭环）
  rebuild: 湖仓一体 + 分层架构 + 闭环。数据采集（在线 DB binlog → 数仓 ODS 层）。数仓分层——ODS（原始）→ DWD（明细清洗）→ DWS（主题汇总）→ ADS（应用指标）。湖仓一体——底层 Iceberg/Hudi（数据湖，海量原始 + ACID），上层 Hive/Spark SQL（数仓分析）。反哺——分析结果（用户标签/商品销量）写回在线 Redis/MySQL，供推荐/搜索用。实时链路（Flink）补充离线延迟。
follow_up:
  - 数据怎么从在线到数仓（采集）？——CDC（binlog 采集，如 Canal/Debezium）实时同步，或定时批量抽取（ETL）。
  - 数仓分层怎么设计？——ODS 原始（不加工）→ DWD 明细（清洗去噪）→ DWS 汇总（按主题/时间聚合）→ ADS 应用（直接给报表/模型用）。
  - 湖仓一体和传统数仓区别？——湖仓（Iceberg/Hudi）支持 ACID + 时间旅行 + 流批一体，传统数仓（Hive）只支持批。
  - 实时和离线怎么协同（Lambda）？——批层（离线全量，准）+ 流层（实时增量，快）+ 服务层（合并，对外）。
  - 数据质量怎么保证？——数据治理（完整性/一致性/及时性），DQ 监控（每日跑批校验）。
memory_points:
  - 闭环：在线→采集→数仓→反哺在线
  - 分层：ODS→DWD→DWS→ADS
  - 湖仓一体：Iceberg/Hudi（ACID + 流批一体）
  - Lambda：批+流+服务
  - 反哺：分析结果写回在线存储
---

# 【Java 后端架构师】离线数仓、湖仓与在线服务的数据闭环

> 适用场景：JD 数据中台。用户每天产生 PB 级行为数据（浏览/点击/下单/支付），这些数据进数仓分析（用户画像/商品热度/销售趋势），分析结果反哺在线业务（推荐/搜索/风控）。核心是"业务→数据→洞察→业务优化"的闭环，技术上靠"湖仓一体 + 分层架构 + 实时补充"。

## 一、概念层：数据闭环全景

**数据闭环四环节**（面试必画）：

```
┌─────────────────────────────────────────────────────────────┐
│                    数据闭环（飞轮）                            │
│                                                               │
│   ┌─────────────┐                                            │
│   │  在线业务     │                                            │
│   │  （交易/搜索/  │                                            │
│   │   推荐）      │                                            │
│   └──────┬──────┘                                            │
│          │ 产生数据（binlog/事件）                              │
│          ▼                                                    │
│   ┌─────────────┐    ETL/流处理     ┌─────────────┐          │
│   │  数据采集     │ ───────────────► │  数仓 ODS    │          │
│   │  （CDC/MQ）   │                  │  （原始层）   │          │
│   └─────────────┘                  └──────┬──────┘          │
│                                            │ 清洗加工          │
│                                            ▼                  │
│                                    ┌─────────────┐          │
│                                    │  数仓 DWD    │          │
│                                    │  （明细层）   │          │
│                                    └──────┬──────┘          │
│                                            │ 聚合汇总          │
│                                            ▼                  │
│                                    ┌─────────────┐          │
│                                    │  数仓 DWS/ADS│          │
│                                    │  （汇总/应用） │          │
│                                    └──────┬──────┘          │
│          ┌───────────────────────────────┘                  │
│          │ 反哺（写回在线存储）                                 │
│          ▼                                                    │
│   ┌─────────────┐                                            │
│   │  在线业务     │ ←（推荐用用户画像/搜索用商品热度）             │
│   │  （优化后）   │                                            │
│   └─────────────┘                                            │
└─────────────────────────────────────────────────────────────┘
```

**数仓分层架构**：

```
┌──────────────────────────────────────────────────────────┐
│ ADS 层（Application Data Service，应用层）                  │
│   - 直接给报表/模型用的指标（日活/GMV/转化率）                │
│   - 高度汇总，宽表（一行一实体，多指标列）                    │
│   例：每日销售报表、用户画像表、商品热度榜                    │
├──────────────────────────────────────────────────────────┤
│ DWS 层（Data Warehouse Summary，汇总层）                    │
│   - 按主题/时间聚合（用户主题/商品主题/订单主题）              │
│   - 轻度汇总（日/周/月粒度）                                 │
│   例：用户日聚合（点击数/下单数/消费额）                      │
├──────────────────────────────────────────────────────────┤
│ DWD 层（Data Warehouse Detail，明细层）                     │
│   - 清洗去噪后的明细数据（标准化/去重/格式化）                 │
│   - 一行一事件（每条订单/每次点击）                          │
│   例：订单明细（标准化金额/时间/状态）                        │
├──────────────────────────────────────────────────────────┤
│ ODS 层（Operational Data Store，原始层）                    │
│   - 从在线 DB 同步的原始数据（不加工）                       │
│   - 保持和在线 DB 一致的结构                                │
│   例：t_order（和业务 DB 同结构）                            │
├──────────────────────────────────────────────────────────┤
│ 数据源（在线 DB）                                            │
│   MySQL（业务库）/ Kafka（事件流）/ 日志（埋点）              │
└──────────────────────────────────────────────────────────┘
```

## 二、机制层：数据采集（在线 → 数仓）

**CDC 采集（binlog 同步）**：

```java
/**
 * Canal 采集 MySQL binlog → Kafka → 数仓 ODS
 */
@Component
public class CanalDataSync {

    /**
     * Canal 监听 MySQL binlog，变更发 Kafka
     */
    @KafkaListener(topic = "canal-order")
    public void onOrderChange(CanalMessage msg) {
        if (msg.getType() == CanalMessage.Type.INSERT ||
            msg.getType() == CanalMessage.Type.UPDATE) {

            // 转成数仓格式（ODS 层，保持原始结构）
            OdsOrder ods = new OdsOrder();
            ods.setOrderId(msg.getData().get("id"));
            ods.setUserId(msg.getData().get("user_id"));
            ods.setAmount(msg.getData().get("amount"));
            ods.setOpTime(msg.getData().get("update_time"));
            ods.setDt(LocalDate.now());   // 分区字段（按天分区）
            ods.setOpType(msg.getType().name());   // 操作类型

            // 写数仓 ODS 层（Hive/Iceberg）
            dwdRepo.insertOdsOrder(ods);

            monitor.record("cdc_sync", "order", msg.getType());
        }
    }
}
```

**定时批量抽取（ETL）**：

```java
/**
 * Spark 批量抽取（每日凌晨跑，全量/增量同步）
 */
@Service
public class DailyEtlService {

    @Scheduled(cron = "0 0 2 * * ?")   // 每日凌晨 2 点
    public void dailyExtract() {
        SparkSession spark = SparkSession.builder()
            .appName("Daily ETL")
            .enableHiveSupport()
            .getOrCreate();

        // 1. 从在线 MySQL 抽数到 ODS（增量，按 update_time）
        spark.read()
            .format("jdbc")
            .option("url", "jdbc:mysql://online-db/orders")
            .option("dbtable",
                "(SELECT * FROM t_order WHERE update_time >= '${yesterday}') t")
            .load()
            .write()
            .format("iceberg")   // 湖仓格式
            .mode(SaveMode.Append)
            .insertInto("ods.t_order");

        // 2. ODS → DWD（清洗）
        spark.sql(
            "INSERT OVERWRITE dwd.t_order_dtl " +
            "SELECT id, user_id, CAST(amount AS DECIMAL(10,2)) as amount, " +
            "       status, update_time, dt " +
            "FROM ods.t_order " +
            "WHERE dt = '${yesterday}' " +
            "  AND status IS NOT NULL"   // 清洗：过滤脏数据
        );

        // 3. DWD → DWS（按用户聚合）
        spark.sql(
            "INSERT OVERWRITE dws.t_user_daily " +
            "SELECT user_id, dt, " +
            "       COUNT(1) as order_count, " +
            "       SUM(amount) as total_amount " +
            "FROM dwd.t_order_dtl " +
            "WHERE dt = '${yesterday}' " +
            "GROUP BY user_id, dt"
        );

        // 4. DWS → ADS（应用指标）
        spark.sql(
            "INSERT OVERWRITE ads.t_daily_report " +
            "SELECT dt, SUM(order_count) as total_orders, " +
            "       SUM(total_amount) as gmv " +
            "FROM dws.t_user_daily " +
            "WHERE dt = '${yesterday}' " +
            "GROUP BY dt"
        );

        monitor.record("etl_done", LocalDate.now().minusDays(1));
    }
}
```

## 三、机制层：湖仓一体（Iceberg/Hudi）

**湖仓 vs 传统数仓**：

| 维度 | 传统数仓（Hive） | 湖仓一体（Iceberg/Hudi） |
|------|-----------------|--------------------------|
| ACID | 不支持（并发写冲突） | 支持（事务） |
| 时间旅行 | 不支持 | 支持（查历史版本） |
| 流批一体 | 不支持（只批） | 支持（流式写 + 批读） |
| Schema 演化 | 难（改分区要重刷） | 易（自动合并 schema） |
| 更新删除 | 难（要全表重写） | 易（行级更新） |
| 存储 | HDFS | 对象存储（S3/OSS） |

**Iceberg 表操作**：

```java
/**
 * Iceberg 湖仓：支持 ACID + 流批一体
 */
@Service
public class LakehouseService {

    /**
     * 流式写 Iceberg（Flink 实时写）
     */
    public void streamWrite() {
        // Flink 作业：Kafka 事件流 → Iceberg 表（实时入湖）
        StreamExecutionEnvironment env =
            StreamExecutionEnvironment.getExecutionEnvironment();

        DataStream<OrderEvent> orders = env.addSource(
            new FlinkKafkaConsumer<>("order", new OrderSchema(), kafkaProps()));

        // 流式写 Iceberg（支持 ACID，精确一次）
        orders.addSink(
            FlinkSink.forRowData(orders)
                .table(icebergTable("ods.t_order"))
                .append()   // 追加写
                .build());

        env.execute("Stream to Iceberg");
    }

    /**
     * 批量读 Iceberg（Spark 分析）
     */
    public void batchRead() {
        SparkSession spark = SparkSession.builder()
            .appName("Lakehouse Analysis")
            .config("spark.sql.catalog.iceberg",
                "org.apache.iceberg.spark.SparkCatalog")
            .getOrCreate();

        // 查历史版本（时间旅行）
        spark.sql(
            "SELECT * FROM iceberg.ods.t_order " +
            "VERSION AS OF '2026-07-01 00:00:00'"   // 查 7 月 1 日的数据快照
        ).show();

        // 行级更新（ACID）
        spark.sql(
            "UPDATE iceberg.ods.t_order " +
            "SET status = 'CANCELLED' " +
            "WHERE order_id = 12345"
        );
    }

    /**
     * Schema 演化（加字段，不重刷数据）
     */
    public void evolveSchema() {
        spark.sql("ALTER TABLE iceberg.ods.t_order " +
            "ADD COLUMNS (new_field STRING)");
        // 新字段自动生效，历史数据该字段为 null（不重刷）
    }
}
```

## 四、机制层：反哺在线（数仓 → 在线）

**分析结果写回在线存储**：

```java
/**
 * 数仓分析结果 → 写回 Redis/MySQL，供在线服务用
 */
@Service
public class DataFeedbackService {

    @Scheduled(cron = "0 0 6 * * ?")   // 每日 6 点（数仓跑完后）
    public void feedbackToOnline() {
        // 1. 用户画像（数仓算的）写回 Redis（推荐/搜索用）
        List<UserProfile> profiles = adsRepo.getUserProfiles(yesterday());
        for (UserProfile profile : profiles) {
            redis.opsForValue().set(
                "user_profile:" + profile.getUserId(),
                JSON.toJSONString(profile),
                Duration.ofDays(7));   // TTL 7 天
        }

        // 2. 商品热度榜写回 MySQL（搜索排序用）
        List<ProductHot> hotProducts = adsRepo.getProductHotRanking(yesterday());
        hotProductRepo.batchUpsert(hotProducts);

        // 3. 异常用户名单写回风控（风控拦截用）
        List<Long> abnormalUsers = adsRepo.getAbnormalUsers(yesterday());
        for (Long userId : abnormalUsers) {
            redis.opsForSet().add("risk:abnormal_users", userId.toString());
        }

        monitor.record("data_feedback", "user_profile", profiles.size());
        monitor.record("data_feedback", "product_hot", hotProducts.size());
    }
}
```

**在线服务使用反哺数据**：

```java
/**
 * 推荐服务用数仓算的用户画像
 */
@Service
public class RecommendService {

    public List<Product> recommend(Long userId) {
        // 从 Redis 取数仓算的画像（反哺数据）
        String profileJson = redis.opsForValue()
            .get("user_profile:" + userId);
        UserProfile profile = profileJson != null ?
            JSON.parseObject(profileJson, UserProfile.class) :
            UserProfile.defaultProfile();   // 缺失用默认

        // 根据画像推荐（偏好品类/价格区间）
        return productSearch.searchByPreference(
            profile.getPreferredCategories(),
            profile.getPriceRange());
    }
}
```

## 五、机制层：Lambda 架构（批+流+服务）

**Lambda 架构全景**：

```
                    数据源（事件/DB）
                          │
              ┌───────────┴───────────┐
              │                       │
              ▼                       ▼
    ┌─────────────────┐     ┌─────────────────┐
    │ 批层（Batch）    │     │ 流层（Speed）    │
    │                  │     │                  │
    │ Hadoop/Spark     │     │ Flink/Storm      │
    │ 全量数据          │     │ 实时增量          │
    │ 深度分析（准）     │     │ 快速计算（快）    │
    │ 延迟：小时/天      │     │ 延迟：秒          │
    └─────────────────┘     └─────────────────┘
              │                       │
              └───────────┬───────────┘
                          │
                          ▼
                ┌─────────────────┐
                │ 服务层（Serving） │
                │                  │
                │ 合并批+流结果      │
                │ 对外查询          │
                │ 例：实时 GMV =     │
                │   昨日批 + 今日流   │
                └─────────────────┘
```

**服务层合并逻辑**：

```java
/**
 * 服务层：合并批层（昨日全量）+ 流层（今日增量）
 */
@Service
public class GmvService {

    public BigDecimal getTodayGmv() {
        // 批层：昨日 GMV（数仓算的，Hive 查）
        BigDecimal yesterdayGmv = hiveRepo.getYesterdayGmv();

        // 流层：今日增量 GMV（Flink 实时算的，Redis 查）
        BigDecimal todayIncrement = redis.opsForValue()
            .get("gmv:today:increment");

        // 合并：昨日 + 今日增量 = 当前累计
        return yesterdayGmv.add(new BigDecimal(todayIncrement));
    }
}
```

## 六、底层本质：数据闭环的本质是"数据驱动业务优化"

回到第一性：**数据闭环的本质是"用数据洞察优化业务，形成飞轮效应"**。

- **数据驱动决策**：不靠拍脑袋（"我觉得用户喜欢 X"），靠数据（"分析显示 70% 用户点击 X"）。数仓分析提供客观数据，降低决策风险。这是"数据化运营"——从经验驱动到数据驱动。
- **飞轮效应**：业务产生数据 → 数据分析洞察 → 洞察优化业务 → 优化后产生更多数据 → 更好分析。正向循环，越转越快。京东"数据飞轮"：用户行为数据 → 推荐优化 → 转化率提升 → 更多交易 → 更多数据。
- **实时 vs 离线的互补**：离线数仓深度分析（复杂模型/长周期趋势），但延迟（天级）；实时链路快速反馈（秒级），但浅（简单聚合）。Lambda 架构两者结合——批层准（深度），流层快（实时），服务层合并。
- **湖仓一体的本质是"统一存储"**：传统数据湖（原始数据）+ 数据仓库（结构化分析）是两套系统，数据搬来搬去。湖仓一体（Iceberg/Hudi）统一——一个存储既支持海量原始（湖特性），又支持 ACID 分析（仓特性）。减少数据搬运，降低成本。

**分层的本质是"关注点分离"**：ODS（原始，不加工，可追溯）、DWD（清洗，标准化）、DWS（汇总，按主题）、ADS（应用，直接用）。每层职责明确——ODS 保证数据不丢（原始保留），DWD 保证数据干净（清洗），DWS 保证数据好用（聚合），ADS 保证数据可消费（应用指标）。下游只依赖上游的结果（不依赖过程），解耦每层独立演进。

**反哺的本质是"数据变现"**：数仓分析结果如果不反哺在线，就是"数据死库存"（算完没用）。反哺是让数据"用起来"——用户画像驱动推荐、商品热度驱动搜索、风控名单驱动拦截。这是"数据资产化"——数据从"记录"变成"生产资料"。

## 七、AI 架构师加问：5 个

1. **用 AI 自动生成数仓 ETL（自然语言→SQL），怎么做？**
   业务用自然语言描述（"算每日各品类 GMV"），AI 生成 ETL SQL（ODS→DWD→DWS→ADS 全链路）。降低数据开发门槛（不用写 SQL）。京东 DataGPT：AI 生成数仓作业，开发效率提升 5 倍。

2. **用 AI 做数据质量检测（自动发现脏数据），怎么做？**
   AI 学习正常数据分布（字段值范围/分布/关联），检测偏离——如某订单金额为负（异常）、用户年龄 200（不合理）。AI 用异常检测自动标记脏数据，触发清洗。京东数据治理：AI DQ 检测，脏数据率降 80%。

3. **用 AI 做智能报表（自动洞察），怎么做？**
   AI 分析数据自动发现洞察——"某品类 GMV 同比降 30%，主因是退货率上升"。比人看报表更快发现异常。京东智能报表：AI 每日推送数据洞察，运营效率提升。

4. **AI 预测数据量增长（容量规划），怎么做？**
   AI 根据业务增长趋势预测未来数据量（PB 级），提前扩容数仓存储/计算。预测偏低存储不够（作业失败），偏高浪费。京东实践：AI 预测数据量，存储成本优化 20%。

5. **用 AI 做数据血缘分析（字段级追踪），怎么做？**
   AI 分析 SQL/ETL 作业，自动构建数据血缘（某 ADS 字段从哪些 ODS 字段算来）。用于影响分析（改某字段影响哪些下游）。京东数据治理：AI 血缘分析，字段级追踪准确率 95%+。

## 七、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"闭环飞轮在线→数仓→反哺、分层 ODS DWD DWS ADS、湖仓一体 Iceberg ACID、Lambda 批流合并"**。

- **数据闭环**：在线业务 → 采集（CDC/ETL）→ 数仓分析 → 反哺在线（写回 Redis/MySQL）
- **数仓分层**：ODS（原始）→ DWD（明细清洗）→ DWS（主题汇总）→ ADS（应用指标）
- **湖仓一体**：Iceberg/Hudi（ACID + 时间旅行 + 流批一体 + Schema 演化）
- **Lambda 架构**：批层（Hive/Spark，准）+ 流层（Flink，快）+ 服务层（合并）
- **反哺**：数仓分析结果写回在线存储，供推荐/搜索/风控用

### 面试现场 60 秒回答

> 数据闭环核心是"在线业务 → 数仓分析 → 反哺在线"的飞轮。在线业务（交易/搜索/推荐）产生数据（binlog/事件），通过 CDC（Canal 监听 binlog）或 ETL（Spark 定时抽取）同步到数仓 ODS 层（原始不加工）。数仓分层——ODS（原始）→ DWD（明细，清洗去噪标准化）→ DWS（按主题聚合，用户/商品/订单主题）→ ADS（应用指标，直接给报表/模型）。每层用 Spark SQL 加工（INSERT OVERWRITE），按天分区（dt 字段）。湖仓一体——用 Iceberg/Hudi 替代传统 Hive，支持 ACID（并发写不冲突）、时间旅行（查历史版本）、流批一体（Flink 流写 + Spark 批读）、Schema 演化（加字段不重刷）。反哺——数仓算的分析结果（用户画像/商品热度/风控名单）写回在线 Redis/MySQL，供在线服务用（推荐查用户画像、搜索查商品热度、风控查异常名单）。每日定时任务（凌晨 ETL，6 点反哺）。Lambda 架构——批层（Hive/Spark 全量，准但慢）+ 流层（Flink 增量，快但浅）+ 服务层（合并，实时 GMV = 昨日批 + 今日流）。数据质量——DQ 监控（每日跑批校验完整性/一致性/及时性）。监控 etl_duration（ETL 耗时）、data_freshness（数据新鲜度，反哺延迟）、data_quality_score（质量分）。最关键的是"数据闭环飞轮——数据驱动业务优化"，这是数据中台的核心价值。

## 八、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不能直接在线上 DB 跑分析（要数仓）？ | 在线 DB 事务优化（行存/小查询），分析慢（亿级 GROUP BY/JOIN 卡）；数仓分析优化（列存/分区/索引），支持大查询。用 analytics_rt（分析延迟，DB 分钟级 vs 数仓秒级）和 db_load_impact（DB 负载影响）量化 |
| 证据追问 | 怎么证明数仓数据准（和在线一致）？ | 对账——数仓 ODS vs 在线 DB，记录数/金额一致；数据质量监控（DQ，每日校验）；监控 etl_data_loss（ETL 丢数据，应 0）和 ods_db_diff（ODS vs DB 差异，应 < 0.01%） |
| 边界追问 | 离线数仓能替代实时吗？ | 不能。离线延迟天级（凌晨跑批），实时业务（大屏/风控）要秒级，离线不够快。靠实时链路（Flink）补充。Lambda 架构（批+流）兼顾 |
| 反例追问 | 什么场景不需要数仓（在线够用）？ | 小数据量（创业初期，数据少在线分析够）；简单统计（计数/求和，Redis INCR）；无分析需求（纯事务系统）。但电商/互联网必须数仓 |
| 风险追问 | 数据闭环最大风险？ | 主动点出：数据丢失（ETL 故障）、数据延迟（数仓跑批慢，反哺不及时）、数据质量差（脏数据进数仓）、反哺不一致（数仓和在线不一致）。靠 CDC 可靠 + 监控 + DQ + 对账 |
| 验证追问 | 怎么验证数据闭环有效（反哺提升业务）？ | A/B 测试（用反哺数据 vs 不用，比业务指标）+ 长期监控（推荐 CTR/搜索 CVR 是否提升）。监控 recommendation_ctr（推荐点击率，反哺后应升）和 search_cvr（搜索转化率） |
| 沉淀追问 | 数据闭环沉淀什么？ | 数仓分层模板、ETL 调度平台、湖仓一体方案、反哺框架、DQ 监控、数据血缘、数据中台监控大盘（ETL 耗时/数据新鲜度/质量分/反哺延迟） |

### 现场对话示例

**面试官**：数仓的 ETL 凌晨 2 点跑，但早上 8 点业务要用反哺数据，如果 ETL 没跑完怎么办？

**候选人**：ETL 超时是常见问题。三层保障。第一层，监控告警——ETL 每阶段（ODS→DWD→DWS→ADS）有 SLA（如 ODS 3 点完、DWD 5 点完、ADS 7 点完），超 SLA 告警 DBA 介入。第二层，降级——反哺服务读 ADS 时，如果当天数据没好，用昨天的（T-2，延迟一天），保证业务有数据用（虽不是最新）。监控反哺数据版本（dt 字段），业务感知延迟。第三层，优化 ETL——Spark 作业调优（增加并行度/数据倾斜处理/分区裁剪），压缩 ETL 时间。京东实践：PB 级数据 ETL 从 8 小时优化到 3 小时（Spark 调优 + 增量抽取 + 列存）。监控 etl_duration（耗时）和 etl_sla_breach（超 SLA 次数）。极端情况 ETL 跑失败——重跑（幂等，INSERT OVERWRITE 覆盖）+ 告警业务（当天数据延迟）。

**面试官**：用户行为数据量太大（每日 PB 级），数仓存储成本高，怎么优化？

**候选人**：存储成本是数仓运营关键。优化措施——第一，分区裁剪——按时间分区（dt 字段），查询只扫必要分区（查昨天的数据只扫昨天分区，不全扫）。第二，列存格式——Parquet/ORC（列存，只读用到的列，压缩比高），比行存省 70% 空间。第三，冷热分层——热数据（近 30 天）存 SSD（查询快），冷数据（30 天前）归档 HDD/OSS（便宜）。第四，数据生命周期——ODS 原始保留 90 天（够回溯），DWD 保留 1 年，DWS/ADS 长期保留（汇总小）。过期数据自动清理。第五，采样存储——超大数据（日志）采样存（如 10% 采样），够分析趋势。京东实践：PB 级数仓存储成本降 60%（分区+列存+冷热+生命周期）。监控 storage_cost（存储成本）和 query_rt_p99（查询延迟，冷数据可慢）。

**面试官**：实时链路（Flink）和离线数仓（Spark）算的结果不一致（同指标不同值），怎么办？

**候选人**：这是流批一致性问题（和 065/069 题类似）。第一步，定位差异——抽样同 entity 同时间点，比对 Flink 值（实时 Redis）和 Spark 值（数仓 ADS），找差异点。第二步，根因分析——常见原因：时间窗口边界（Flink 含边界，Spark 不含）、数据延迟（Flink 处理迟到的，Spark 批时已截止）、去重逻辑不同（Flink 状态去重，Spark DISTINCT）。第三步，统一口径——用统一 DSL 生成 Flink 和 Spark 作业（同特征定义，见 065 题），从源头保证一致。第四步，对账兜底——定期跑批对账（流值 vs 批值），差异率监控（< 1%），超阈值告警。第五步，Lambda 架构处理——服务层合并时以批层为准（批更准），流层补增量。即"实时用流值（快但可能不准），准实时用批值（准但慢）"，根据场景选。京东实践：流批一致率 99%+（DSL 统一 + 对账），关键指标（GMV/DAU）以批为准（合规要求）。监控 stream_batch_diff_rate（流批差异率）和 consistency_check（一致性校验通过率）。

## 常见考点

1. **数据中台和业务中台的区别？**——业务中台是"能力复用"（订单/支付/搜索服务化），数据中台是"数据复用"（数据采集/治理/服务化）。业务中台对外提供业务能力，数据中台对外提供数据能力（报表/画像/指标 API）。
2. **OLTP 和 OLAP 区别？**——OLTP（在线事务处理，行存，增删改查快，业务库 MySQL），OLAP（在线分析处理，列存，聚合分析快，数仓 Hive/ClickHouse）。两者分工，数据从 OLTP 同步到 OLAP 分析。
3. **数仓建模（维度建模）？**——星型模型（事实表 + 维度表，事实表存度量如金额/数量，维度表存描述如时间/用户/商品）。比三范式（3NF）更适合分析（JOIN 少，查询快）。
4. **实时数仓（Flink + Kafka）vs 离线数仓（Spark + Hive）？**——实时数仓延迟秒级（实时大屏/风控），但状态有限（短窗口）；离线数仓延迟天级（深度分析/模型训练），但全量准确。两者互补，Lambda 架构结合。

## 结构化回答

**30 秒电梯演讲：** 数据闭环是在线业务产生数据 → 离线数仓分析 → 反哺在线业务的循环。电商场景：用户浏览下单（在线）→ 数据进数仓分析用户偏好（离线）→ 算法用分析结果做推荐（在线）。核心矛盾是离线批处理（小时/天级）vs 在线实时（秒级），解法是湖仓一体（Data Lakehouse）+ Lambda/Kappa 架构——离线数仓做深度分析，实时链路做即时反馈，两者数据统一存储（湖仓）

**展开框架：**
1. **数据闭环** — 在线业务 → 数据采集 → 数仓分析 → 反哺在线
2. **数仓分层** — ODS（原始）→ DWD（明细）→ DWS（汇总）→ ADS（应用）
3. **湖仓一体** — 数据湖（海量原始）+ 数据仓库（结构化分析），统一存储

**收尾：** 以上是我的整体思路。您想继续深入聊——数据怎么从在线到数仓（采集）？


## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：离线数仓、湖仓与在线服务的数据闭环 | "这题一句话：数据闭环是在线业务产生数据 → 离线数仓分析 → 反哺在线业务的循环。" | 开场钩子 |
| 0:15 | 数据闭环示意/对比图 | "在线业务 → 数据采集 → 数仓分析 → 反哺在线" | 数据闭环要点 |
| 0:40 | 数仓分层示意/对比图 | "ODS（原始）→ DWD（明细）→ DWS（汇总）→ ADS（应用）" | 数仓分层要点 |
| 1:25 | 总结卡 | "记住：闭环。下期见。" | 收尾 |
