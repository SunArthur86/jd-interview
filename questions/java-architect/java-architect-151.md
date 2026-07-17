---
id: java-architect-151
difficulty: L2
category: java-architect
subcategory: MySQL
title: PostgreSQL 与 MySQL 在 Java 后端的选型
tags: [PostgreSQL, MySQL, 选型, JSONB, CTE]
related: [java-architect-149, java-architect-150, java-architect-152]
---

# PostgreSQL 与 MySQL 在 Java 后端的选型

> **场景**：京东到家早期用 MySQL，随着业务复杂度提升（复杂分析查询、地理位置搜索、JSON 文档），MySQL 越来越吃力。面试官问：什么时候该选 PostgreSQL？

## 一、概念层：两者的设计哲学差异

### 1.1 设计哲学

| 维度 | MySQL | PostgreSQL |
|------|-------|------------|
| 设计哲学 | 简单、稳定、够用 | 严谨、功能丰富、扩展强 |
| SQL 标准 | 部分（方言多） | 严格遵循 SQL 标准 |
| 存储引擎 | 可插拔（InnoDB/MyISAM） | 单一（高度优化） |
| 复杂查询 | 弱（优化器简单） | 强（CBO + 多种 JOIN 策略） |
| 索引类型 | B+Tree/Hash/Fulltext/RTree | BTree/Hash/GIN/GiST/BRIN/SP-GiST |
| 事务隔离 | RR/RC/串行（实际效果争议） | 完整 ANSI 四级 |
| 复制 | 异步/半同步（主从） | 流复制 + 逻辑复制（细粒度） |
| 扩展性 | 中 | 极强（PostGIS/TimescaleDB/pgvector） |

### 1.2 何时选 PostgreSQL

- **复杂分析查询**：多表 JOIN、CTE 递归、窗口函数
- **地理空间数据**：PostGIS（地图、配送路线）
- **JSON 文档**：JSONB（半结构化数据）
- **全文检索**：内置 tsvector 比 MySQL FULLTEXT 强
- **高并发写入 + 复杂查询混合**：HTAP 场景

### 1.3 何时选 MySQL

- **简单 OLTP**：CRUD 为主，查询不复杂
- **团队熟悉度**：国内生态成熟，运维资源多
- **分库分表**：MySQL + ShardingSphere 方案成熟
- **极致读性能**：MySQL 简单查询响应更快（优化器轻量）

## 二、机制层：PostgreSQL 的核心优势

### 2.1 JSONB：半结构化数据

```sql
-- MySQL 的 JSON 是文本存储，查询要解析
-- PostgreSQL 的 JSONB 是二进制存储，支持 GIN 索引

-- 建表
CREATE TABLE t_product (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(200),
    attributes JSONB
);

-- 插入
INSERT INTO t_product (name, attributes) VALUES
('iPhone 15', '{"color":"黑色","storage":256,"tags":["5G","旗舰"]}');

-- GIN 索引（JSONB 专属，查询飞快）
CREATE INDEX idx_product_attrs ON t_product USING GIN (attributes);

-- 查询：包含某个 tag
SELECT * FROM t_product WHERE attributes @> '{"tags":["5G"]}';
-- 查询：提取字段
SELECT name, attributes->>'color' AS color FROM t_product;
-- 查询：JSONPath
SELECT * FROM t_product WHERE attributes @? '$.tags[*] ? (@ == "旗舰")';
```

**JD 到家场景**：商品属性差异大（生鲜有"产地"、数码有"型号"），用 JSONB 灵活存储，避免 1000 个字段的宽表。

### 2.2 CTE 与递归查询

```sql
-- 京东分类树（多级类目）
CREATE TABLE t_category (
    id BIGINT PRIMARY KEY,
    name VARCHAR(100),
    parent_id BIGINT
);

-- 递归查询"手机通讯"类目下的所有子类目（无限层级）
WITH RECURSIVE category_tree AS (
    -- 锚点：根类目
    SELECT id, name, parent_id, 1 AS level
    FROM t_category WHERE id = 1001  -- 手机通讯
    
    UNION ALL
    
    -- 递归：找子类目
    SELECT c.id, c.name, c.parent_id, ct.level + 1
    FROM t_category c
    JOIN category_tree ct ON c.parent_id = ct.id
)
SELECT * FROM category_tree ORDER BY level, id;
-- MySQL 8 也支持 WITH RECURSIVE，但 PostgreSQL 性能更好
```

### 2.3 窗口函数（分析查询）

```sql
-- 每个用户最近 3 笔订单（PostgreSQL 的窗口函数 + 数组聚合极强）
SELECT DISTINCT user_id,
    ARRAY_AGG(order_id ORDER BY create_time DESC) FILTER (WHERE rn <= 3) AS recent_orders
FROM (
    SELECT user_id, order_id, create_time,
        ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY create_time DESC) AS rn
    FROM t_order
) t WHERE rn <= 3
GROUP BY user_id;
```

### 2.4 PostGIS：地理空间

```sql
-- JD 到家：3 公里内可配送的门店
CREATE TABLE t_store (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(100),
    location GEOGRAPHY(POINT, 4326)  -- WGS84 坐标
);

CREATE INDEX idx_store_location ON t_store USING GIST(location);

-- 用户位置
SELECT * FROM t_store 
WHERE ST_DWithin(location, ST_MakePoint(116.404, 39.915)::geography, 3000)  -- 3km
ORDER BY ST_Distance(location, ST_MakePoint(116.404, 39.915)::geography);
```

MySQL 8 虽然也有空间索引，但功能远不如 PostGIS 完整。

### 2.5 MVCC 与事务

PostgreSQL 的 MVCC 实现：
- 每行有 `xmin`（创建事务 ID）和 `xmax`（删除事务 ID）
- 读不阻塞写，写不阻塞读
- 真正的 Serializable（SSI 算法），不是 MySQL 那种"伪串行化"
- 代价：需要 VACUUM 清理旧版本（类似 GC）

## 三、实战层：Java 后端集成

### 3.1 JDBC 配置

```yaml
spring:
  datasource:
    url: jdbc:postgresql://pg-cluster.jd.local:5432/jddj_product
    username: app
    password: ********
    driver-class-name: org.postgresql.Driver
    hikari:
      maximum-pool-size: 20
      connection-test-query: SELECT 1
```

### 3.2 JPA/MyBatis 对接 JSONB

```java
// JPA 自定义类型
@TypeDef(name = "jsonb", typeClass = JsonBinaryType.class)
@Entity
@Table(name = "t_product")
public class Product {
    @Id
    @GeneratedValue(strategy = IDENTITY)
    private Long id;
    
    private String name;
    
    @Type(type = "jsonb")
    @Column(columnDefinition = "jsonb")
    private ProductAttributes attributes;  // Java POJO 自动序列化
}

// MyBatis TypeHandler
@MappedTypes(ProductAttributes.class)
public class JsonbTypeHandler extends BaseTypeHandler<ProductAttributes> {
    private static final ObjectMapper MAPPER = new ObjectMapper();
    
    @Override
    public void setNonNullParameter(PreparedStatement ps, int i, 
            ProductAttributes param, JdbcType jdbcType) throws SQLException {
        PGobject pgObject = new PGobject();
        pgObject.setType("jsonb");
        pgObject.setValue(MAPPER.writeValueAsString(param));
        ps.setObject(i, pgObject);
    }
    
    @Override
    public ProductAttributes getNullableResult(ResultSet rs, String columnName)
            throws SQLException {
        String json = rs.getString(columnName);
        return json == null ? null : MAPPER.readValue(json, ProductAttributes.class);
    }
}
```

### 3.3 复杂查询的 JPA 实现

```java
// 递归 CTE 用原生 SQL
@Repository
public interface CategoryRepository extends JpaRepository<Category, Long> {
    @Query(value = """
        WITH RECURSIVE category_tree AS (
            SELECT id, name, parent_id, 1 AS level 
            FROM t_category WHERE id = :rootId
            UNION ALL
            SELECT c.id, c.name, c.parent_id, ct.level + 1
            FROM t_category c JOIN category_tree ct ON c.parent_id = ct.id
        )
        SELECT * FROM category_tree ORDER BY level, id
        """, nativeQuery = true)
    List<Category> findCategoryTree(@Param("rootId") Long rootId);
}
```

### 3.4 连接池与性能调优

```ini
# postgresql.conf 关键参数
max_connections = 200                    # 最大连接数
shared_buffers = 4GB                     # 共享缓存（25% 内存）
effective_cache_size = 12GB              # OS 缓存预估（75% 内存）
work_mem = 64MB                          # 单查询排序内存
maintenance_work_mem = 512MB             # VACUUM/索引构建
random_page_cost = 1.1                   # SSD 调低（默认 4 是机械盘）
checkpoint_completion_target = 0.9
wal_buffers = 16MB
max_wal_size = 2GB                       # WAL 上限
```

```sql
-- 自动 VACUUM 调优（避免表膨胀）
ALTER TABLE t_order SET (
    autovacuum_vacuum_scale_factor = 0.05,    -- 5% 行变更就 VACUUM
    autovacuum_analyze_scale_factor = 0.02
);
```

## 四、底层本质：两者的设计取舍

### 4.1 First Principle：MySQL 重简单稳定，PostgreSQL 重功能完整

MySQL 早期为"Web 应用"设计——简单查询、高并发、容易部署。优化器简单（基于规则为主），复杂 JOIN 容易选错索引。

PostgreSQL 是学术派——严格遵循 SQL 标准、CBO 优化器成熟、支持复杂查询。代价是学习曲线陡、运维复杂（VACUUM、扩展管理）。

### 4.2 复制模型的差异

- **MySQL**：基于 binlog 的主从复制，简单但粒度粗（库/表级）
- **PostgreSQL**：流复制（物理）+ 逻辑复制（行级，可订阅单表）

逻辑复制让 PostgreSQL 可以做精细化的数据同步——如只同步订单表到分析库，不影响其他表。

### 4.3 Feynman 解释

MySQL 像一辆"皮卡"——结实、好开、配件到处都有，但只能拉货（简单查询），跑不了山路（复杂分析）。
PostgreSQL 像一辆"越野车"——功能多（GIS/JSON/全文检索/CTE）、能爬山，但油耗高（运维复杂）、配件少（生态不如 MySQL）。

业务选型：物流配送选越野车（PostgreSQL + PostGIS），简单电商选皮卡（MySQL + ShardingSphere）。

## 五、AI 架构师加问

**Q1：PostgreSQL 的 VACUUM 是什么？为什么需要？**
PostgreSQL 的 MVCC 用"多版本"实现，更新/删除后旧版本不立即清除（用于并发读）。VACUUM 清理旧版本、回收空间。配置 autovacuum 自动执行，否则表会膨胀。

**Q2：PostgreSQL 和 MySQL 的 JSON 哪个强？**
PostgreSQL 的 JSONB 是二进制存储 + GIN 索引，查询性能远超 MySQL 的 JSON（文本解析）。复杂 JSON 查询必须选 PostgreSQL。

**Q3：PostgreSQL 怎么做分库分表？**
- Citus（微软开源扩展）：原生分布式 PostgreSQL
- pg-partman：表分区（按时间/范围）
- JD 实践：单库足够大时（TB 级）才考虑 Citus，否则单库 + 读写分离

**Q4：PostgreSQL 的高可用怎么做？**
- Patroni（Zalando 开源）：基于 etcd/ZooKeeper 的自动 failover
- 流复制 + keepalived/VIP
- JD 到家：Patroni + etcd + HAProxy，故障切换 < 30s

**Q5：MySQL 迁移 PostgreSQL 怎么做？**
- 工具：pgloader（自动迁移 schema + 数据）
- SQL 方言适配：MySQL 的 `AUTO_INCREMENT` → PG 的 `SERIAL`，`LIMIT x,y` → `LIMIT y OFFSET x`
- 风险：复杂 JOIN 性能可能不同，需重新调优

## 六、记忆口诀

```
MySQL 简单稳，PG 功能全。
JSON 看 JSONB，GIS 选 PostGIS。
CTE 递归树，窗口函数强分析。
MySQL 主从 binlog，PG 流复制加逻辑。
JD 电商选 MySQL，到家配送选 PG。
复杂查询用 PG，简单 CRUD 用 MySQL。
```

## 七、苏格拉底追问

| 层级 | 问题 | 关键答案 |
|------|------|----------|
| L1 表象 | PG 比 MySQL 强在哪？ | 复杂查询、JSONB、GIS、CTE、严格 SQL 标准 |
| L2 机制 | PG 的 MVCC 怎么实现？ | xmin/xmax 事务 ID，多版本，需 VACUUM |
| L3 边界 | PG 的 VACUUM 不做会怎样？ | 表膨胀（dead tuples 堆积）、查询变慢 |
| L4 权衡 | 为什么不全用 PG？ | 运维复杂、生态弱、团队熟悉度、分库分表方案少 |
| L5 反例 | PG 单表写入性能比 MySQL 差吗？ | 高并发简单写，MySQL 更快（轻量优化器） |
| L6 极限 | PG 10 亿行表怎么做分析？ | BRIN 索引 + 分区 + 只读副本 + Citus 横向扩展 |
| L7 系统 | JD 多业务线混用 PG + MySQL 怎么管理？ | 按业务线选型，DBA 平台统一监控，跨库用 CDC 同步 |

**对话还原**：
> 面试官：你们到家为什么用 PostgreSQL？
> 我：业务需要 GIS（门店距离计算）、JSONB（商品属性灵活）、CTE（类目树递归）。MySQL 这些都弱。
> 面试官：PG 怎么部署？
> 我：Patroni + etcd 自动 failover，流复制主从 + 只读副本。故障切换 < 30s。
> 面试官：VACUUM 怎么管？
> 我：autovacuum 开启，热表调低 scale_factor（5% 就 VACUUM）。大表用 pg-repack 在线清理。
> 面试官：和 MySQL 怎么共存？
> 我：核心电商用 MySQL（ShardingSphere 分库分表），到家本地生活用 PG。两边用 CDC 互相同步到数仓。

## 八、常见考点

1. **PG vs MySQL 设计哲学** —— 简单稳定 vs 功能完整
2. **JSONB + GIN 索引** —— PG 杀手锏，必考
3. **PostGIS 地理空间** —— 配送/地图场景
4. **CTE 递归查询** —— 树形结构
5. **MVCC 与 VACUUM** —— PG 特有，必考
6. **复制模型差异** —— MySQL binlog vs PG 流复制 + 逻辑复制
7. **高可用方案** —— Patroni（PG）vs MHA/Orchestrator（MySQL）
8. **选型决策** —— OLTP 简单选 MySQL，复杂/HTAP 选 PG

## 结构化回答

**30 秒电梯演讲：** 京东到家早期用 MySQL，随着业务复杂度提升（复杂分析查询、地理位置搜索、JSON 文档），MySQL 越来越吃力

**展开框架：**
1. **PG vs MySQL 设计哲学** — PG vs MySQL 设计哲学 —— 简单稳定 vs 功能完整
2. **JSONB + GIN 索引** — JSONB + GIN 索引 —— PG 杀手锏，必考
3. **PostGIS 地理空间** — PostGIS 地理空间 —— 配送/地图场景

**收尾：** 以上是我的整体思路。您想继续深入聊——PG 比 MySQL 强在哪？


## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：PostgreSQL 与 MySQL 在 Jav | "这题一句话：京东到家早期用 MySQL，随着业务复杂度提升（复杂分析查询、地理位置搜索、JSON 文档），MySQL 越来越吃力。" | 开场钩子 |
| 0:15 | PG vs MySQL 设计哲学示意/对比图 | "PG vs MySQL 设计哲学 —— 简单稳定 vs 功能完整" | PG vs MySQL 设计哲学要点 |
| 0:40 | JSONB + GIN 索引示意/对比图 | "JSONB + GIN 索引 —— PG 杀手锏，必考" | JSONB + GIN 索引要点 |
| 1:25 | 总结卡 | "记住：PG vs MySQL 设计。下期见。" | 收尾 |
