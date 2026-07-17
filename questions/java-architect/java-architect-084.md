---
id: java-architect-084
difficulty: L3
category: java-architect
subcategory: MySQL
tags:
- Java 架构师
- 大表
- 归档
- 冷热分层
feynman:
  essence: 大表治理的本质是"把不活跃的历史数据从在线库剥离，让在线表小而快"。核心三步——冷热分层（按时间/状态区分冷热）、归档（冷数据搬到廉价存储）、分区分表（在线表分区/分片降低单表规模）。难点是归档期间数据持续写入，归档操作不能锁在线表影响业务。
  analogy: 像图书馆管理藏书。热门新书（热数据）放前厅随手可取（在线 SSD 库），冷门旧书（冷数据）搬地下书库（归档库/对象存储）。前厅书少（单表小），找书快（查询快）。地下书库容量大、便宜，偶尔有人查（低频访问）。搬书（归档）不能锁门（不锁表），趁夜深（低峰）分批搬。
  first_principle: 大表的痛点是"B+ 树层级深（4 层）、索引膨胀、查询变慢、DDL 锁表久、备份恢复慢、主从延迟"。一个 10 亿行的订单表，二级索引查询要走 4 层 B+ 树 + 回表，延迟从 1ms 涨到 10ms。归档的本质是减少在线表的数据量——热数据（近 3 个月）留在线上，冷数据（3 个月以上）搬走，单表从 10 亿行降到 3000 万行，查询回到 1ms。
  key_points:
  - 冷热判断：按时间（90 天前冷）、按状态（已完结订单冷）、按访问频率（近 30 天无访问冷）
  - 归档方式：mysqldump 导出 + 删除、pt-archiver 小批量迁移、binlog 同步到冷库
  - 分区表：RANGE 分区按时间（partition by range），DROP PARTITION 秒级删分区
  - 冷库选型：TiDB（分析查询）、HBase（海量 KV）、S3/对象存储（原始数据）
  - 归档查询透明化：应用层先查在线表，miss 再查冷库，或走统一查询网关
  - 归档不锁表：小批量（每次 1000 行）、限速、低峰期执行
first_principle:
  problem: 订单表 10 亿行、500G，查询 P99 从 1ms 涨到 50ms，DDL（加字段）锁表 2 小时，备份恢复要 8 小时。如何治理？
  axioms:
  - 大表的性能问题随数据量线性恶化（B+ 树深度、索引扫描行数）
  - 归档不能影响在线业务（不锁表、不占满 IO）
  - 冷数据偶尔要查（用户查半年前订单），不能直接删
  rebuild: 三步——第一，冷热分层（近 90 天热，90 天前冷；或按状态，已完结订单冷）。第二，归档冷数据到冷库（TiDB 做分析、或归档 MySQL 实例）。用 pt-archiver 小批量迁移（每次 1000 行，限速，不锁表）。第三，在线表改分区表（RANGE 分区按月），DROP PARTITION 秒级删历史分区（替代 DELETE 10 亿行的灾难）。应用层查询：先查在线表，miss 走冷库（透明路由）。热表从 10 亿行降到 3000 万行，查询 P99 回到 1ms。
follow_up:
  - 归档时怎么不锁表？——pt-archiver 小批量（每次 1000 行，SELECT + DELETE），走索引、低峰期执行、限速（--max-load 控制）。或用 binlog 同步（不碰在线表，只读 binlog）
  - 分区表 DROP PARTITION 和 DELETE 哪个好？——DROP PARTITION 是 DDL（秒级，删整个分区文件），DELETE 是 DML（逐行删、产生大量 binlog、锁表风险）。10 亿行 DELETE 要几小时且影响在线，DROP PARTITION 秒级完成
  - 冷数据偶尔查怎么办？——应用层先查在线表，miss 走冷库（TiDB/归档 MySQL）。冷库查询慢（100ms）但低频可接受。或统一查询网关自动路由（在线表查不到查冷库）
  - 分区分表怎么选？——分区表（单实例内分区，DROP PARTITION 方便删历史）适合按时间归档场景。分库分表（多实例，ShardingSphere）适合单表数据量超单实例容量场景。两者可组合（先分库分表，每个分片再按时间分区）
  - 归档后索引重建？——大表索引膨胀，归档后 OPTIMIZE TABLE 重建表回收空间（但锁表）。或新建表 + 数据导入 + 改名（在线 DDL）
memory_points:
  - 冷热判断：时间（90 天）、状态（已完结）、访问频率（30 天无访问）
  - 归档工具：pt-archiver（小批量不锁表）、mysqldump、binlog 同步
  - 分区表：RANGE 按时间，DROP PARTITION 秒级删历史
  - 冷库选型：TiDB（分析）、HBase（KV）、S3（原始）
  - 查询路由：在线表 miss 走冷库，应用层透明
  - 不锁表：每次 1000 行、限速、低峰期
---

# 【Java 后端架构师】大表治理、冷热分层与归档

> 适用场景：JD 核心技术。订单表 10 亿行、500G，查询 P99 从 1ms 涨到 50ms，加字段锁表 2 小时，备份恢复 8 小时。架构师必须设计冷热分层、归档冷数据、分区表治理，让在线表小而快。

## 一、概念层：大表的病与药

**大表性能恶化曲线**（面试必画）：

```
单表行数        B+树深度    查询P99     DDL耗时      备份恢复
─────────────────────────────────────────────────────────────
1000万          3层         1ms         1分钟        10分钟
5000万          3层         3ms         10分钟       1小时
1亿            4层         10ms        30分钟       3小时
5亿            4层         30ms        2小时        6小时
10亿（现状）    4层         50ms        4小时        8小时  ← 痛点
50亿            5层         200ms       不可行       不可行
```

**冷热分层策略矩阵**：

| 判断维度 | 热数据 | 冷数据 | 归档数据 |
|---------|-------|-------|---------|
| 时间 | 近 90 天 | 90 天-1 年 | 1 年以上 |
| 状态 | 进行中（待支付/已下单） | 已完结（已完成/已取消） | - |
| 访问频率 | 近 30 天有访问 | 30 天无访问 | 1 年无访问 |
| 存储 | 在线 MySQL（SSD） | 冷库 TiDB/归档 MySQL | 对象存储 S3/冷备 |
| 查询延迟 | 1ms | 100ms | 秒级 |

## 二、机制层：分区表治理（DROP PARTITION 替代 DELETE）

**分区表 DDL**（按月 RANGE 分区）：

```sql
-- 订单表按月分区（RANGE on create_time）
CREATE TABLE orders (
    id BIGINT,
    order_no VARCHAR(32) NOT NULL,
    user_id BIGINT NOT NULL,
    amount DECIMAL(10,2),
    status TINYINT,           -- 0待支付 1已支付 2已完成 3已取消
    create_time DATETIME NOT NULL,
    -- 分区键必须是主键的一部分，所以主键改为 (id, create_time)
    PRIMARY KEY (id, create_time),
    UNIQUE KEY uk_order_no (order_no),
    KEY idx_user_time (user_id, create_time)
) ENGINE=InnoDB
PARTITION BY RANGE (TO_DAYS(create_time)) (
    PARTITION p202401 VALUES LESS THAN (TO_DAYS('2024-02-01')),
    PARTITION p202402 VALUES LESS THAN (TO_DAYS('2024-03-01')),
    PARTITION p202403 VALUES LESS THAN (TO_DAYS('2024-04-01')),
    -- ... 每月一个分区
    PARTITION p202606 VALUES LESS THAN (TO_DAYS('2026-07-01')),
    PARTITION p202607 VALUES LESS THAN (TO_DAYS('2026-08-01')),
    PARTITION p_future VALUES LESS THAN MAXVALUE   -- 兜底分区
);
```

**秒级删历史分区**（替代 DELETE 灾难）：

```sql
-- 灾难做法：DELETE 10 亿行（锁表几小时、binlog 爆炸）
DELETE FROM orders WHERE create_time < '2024-01-01';
-- 产生几十 G binlog、主从延迟、锁表风险

-- 正确做法：DROP PARTITION 秒级完成（直接删分区文件）
ALTER TABLE orders DROP PARTITION p202401;
ALTER TABLE orders DROP PARTITION p202402;
-- 每个 DROP 秒级完成，不产生 binlog（DDL），不影响在线

-- 新增分区（提前建好，避免数据进 p_future）
ALTER TABLE orders ADD PARTITION (
    PARTITION p202608 VALUES LESS THAN (TO_DAYS('2026-09-01'))
);
```

**分区裁剪（Partition Pruning）**——查询只扫相关分区：

```sql
-- 带 create_time 的查询，只扫 1 个分区（几百万行，快）
SELECT * FROM orders
WHERE user_id = 123 AND create_time >= '2026-07-01'
  AND create_time < '2026-08-01';
-- 只扫 p202607 分区，不扫全部 10 亿行

-- 不带 create_time 的查询（全分区扫描，慢）
SELECT * FROM orders WHERE user_id = 123;
-- 扫所有分区，10 亿行，慢。必须带时间条件
```

## 三、机制层：pt-archiver 归档冷数据（不锁表）

**pt-archiver 归档命令**（小批量迁移不锁表）：

```bash
# 从在线 MySQL 归档冷数据到冷库（TiDB 或归档 MySQL）
pt-archiver \
  --source h=online-mysql,D=order_db,t=orders,u=admin,p=xxx \
  --dest h=cold-tidb,D=order_archive,t=orders,u=admin,p=xxx \
  --where "create_time < '2025-01-01'" \
  --no-delete \                              # 先搬不删（双写期）
  --limit 1000 \                             # 每次搬 1000 行
  --commit-each \                            # 每批提交
  --progress 10000 \                         # 每 1 万行打印进度
  --statistics \                             # 结束打印统计
  --max-load Threads_running=50 \            # 负载保护（超过 50 活跃连接暂停）
  --check-interval 1 \                       # 每秒检查负载
  --retries 3                                # 失败重试 3 次

# 验证归档完成后，再批量删除（小批量 DELETE）
pt-archiver \
  --source h=online-mysql,D=order_db,t=orders,u=admin,p=xxx \
  --where "create_time < '2025-01-01'" \
  --purge \                                  # 只删不搬（已验证搬完）
  --limit 1000 \
  --commit-each \
  --max-load Threads_running=50
```

**pt-archiver 工作原理**：

```
1. SELECT * FROM orders WHERE create_time < '2025-01-01' LIMIT 1000;
2. 逐行 INSERT 到冷库（--dest）
3. DELETE FROM orders WHERE id IN (...) LIMIT 1000;
4. 检查负载（Threads_running < 50 才继续）
5. 循环直到搬完

关键：每次只处理 1000 行，不锁整表。负载高时自动暂停。
      1 亿行约需几小时（限速），但全程不锁表、不影响业务。
```

**Java 归档任务调度**（集成 pt-archiver 或 SDK）：

```java
@Component
@Slf4j
public class ArchiveJob {

    @Autowired private JdbcTemplate onlineJdbc;
    @Autowired private JdbcTemplate coldJdbc;
    @Autowired private ArchiveConfig config;

    private long lastId = 0;

    @XxlJob("archiveColdOrders")
    @SchedulerLock(name = "archive", lockAtMostFor = "6h")
    public void archiveColdOrders() throws InterruptedException {
        LocalDate threshold = LocalDate.now().minusDays(config.getHotDays());  // 90 天前
        int totalArchived = 0;

        while (true) {
            // 1. 查一批冷数据（按 id 增量，避免深翻页）
            List<Order> batch = onlineJdbc.query(
                "SELECT * FROM orders WHERE create_time < ? AND id > ? " +
                "ORDER BY id LIMIT 1000",
                new BeanPropertyRowMapper<>(Order.class),
                threshold, lastId);

            if (batch.isEmpty()) break;

            // 2. 批量写入冷库
            coldJdbc.batchUpdate(
                "INSERT IGNORE INTO orders (id, order_no, user_id, amount, status, create_time) " +
                "VALUES (?, ?, ?, ?, ?, ?)",
                batchParams(batch));

            // 3. 删除在线表（验证冷库写入成功后）
            List<Long> ids = batch.stream().map(Order::getId).toList();
            onlineJdbc.batchUpdate("DELETE FROM orders WHERE id = ?",
                ids.stream().map(id -> new Object[]{id}).toList());

            totalArchived += batch.size();
            lastId = batch.get(batch.size() - 1).getId();

            // 4. 负载检查（在线库活跃连接高则暂停）
            int threadsRunning = getThreadsRunning();
            if (threadsRunning > config.getMaxLoad()) {
                log.info("负载高暂停 {}s", config.getPauseSeconds());
                Thread.sleep(config.getPauseSeconds() * 1000L);
            }
        }
        log.info("归档完成 {} 行", totalArchived);
    }
}
```

## 四、机制层：冷热查询透明路由

**应用层冷热路由**（先查在线表，miss 查冷库）：

```java
@Service
@Slf4j
public class OrderQueryService {

    @Autowired private OrderMapper onlineMapper;   // 在线 MySQL
    @Autowired private OrderMapper coldMapper;     // 冷库 TiDB
    @Autowired private OrderCacheService cache;

    public Order findById(Long orderId) {
        // 1. 先查缓存
        Order cached = cache.get(orderId);
        if (cached != null) return cached;

        // 2. 查在线表（热数据）
        Order order = onlineMapper.findById(orderId);
        if (order != null) {
            cache.set(order);
            return order;
        }

        // 3. 在线表 miss，查冷库（冷数据）
        order = coldMapper.findById(orderId);
        if (order != null) {
            log.debug("命中冷库 orderId={}", orderId);
            cache.set(order);
        }
        return order;
    }

    // 用户查历史订单列表（按时间范围）
    public List<Order> queryByUserAndTime(Long userId, LocalDate start, LocalDate end) {
        LocalDate now = LocalDate.now();
        LocalDate hotThreshold = now.minusDays(90);

        if (start.isAfter(hotThreshold)) {
            // 全在热区，只查在线表
            return onlineMapper.queryByUserAndTime(userId, start, end);
        } else if (end.isBefore(hotThreshold)) {
            // 全在冷区，只查冷库
            return coldMapper.queryByUserAndTime(userId, start, end);
        } else {
            // 跨冷热，两个库都查合并
            List<Order> hot = onlineMapper.queryByUserAndTime(userId, hotThreshold, end);
            List<Order> cold = coldMapper.queryByUserAndTime(userId, start, hotThreshold);
            return Stream.concat(hot.stream(), cold.stream()).toList();
        }
    }
}
```

## 五、底层本质：为什么大表会慢，归档为什么能治

回到第一性：**大表慢的根因是 B+ 树层级深 + 索引膨胀 + 缓冲池命中率下降**。

- **B+ 树深度**：InnoDB 的 B+ 树叶子节点存数据，每页 16KB。主键索引三层 B+ 树能存约 2000 万行（每层 1000+ 分支），四层能存 200 亿行。但四层意味着每次查询多一次磁盘 IO（第三层非叶节点可能不在缓冲池）。10 亿行表查询要走 3-4 层，深翻页（LIMIT 1000000, 20）要扫上百万行。
- **二级索引膨胀**：二级索引（idx_user_time）也是 B+ 树。10 亿行的二级索引几 G 到几十 G，无法全放缓冲池（buffer pool）。查询二级索引时如果非叶节点不在缓冲池，触发磁盘 IO，延迟从亚毫秒涨到几毫秒。归档后单表 3000 万行，二级索引几百 M，全放缓冲池，查询稳定 1ms。
- **DDL 锁表**：加字段（ALTER TABLE ADD COLUMN）要重建表（COPY 算法）或 In-place。10 亿行重建表要几小时，期间 Metadata Lock 阻塞所有写。归档后 3000 万行 DDL 几分钟完成。或用 gh-ost/pt-online-schema-change 在线 DDL（建影子表 + binlog 同步 + 改名），但大表依然慢。
- **DELETE 不释放空间**：DELETE 10 亿行只是标记删除（InnoDB MVCC），物理空间不立即释放（碎片化）。要 OPTIMIZE TABLE 重建表才回收（锁表）。DROP PARTITION 直接删分区文件，秒级释放空间。
- **备份恢复**：mysqldump 备份 500G 要几小时，恢复更慢（逐条 INSERT）。xtrabackup 物理备份快但也要拷贝所有数据文件。归档后在线表 50G，备份恢复 10 分钟。
- **归档的本质**：减少在线表的数据量，让 B+ 树浅（3 层）、索引小（全缓冲池）、DDL 快（分钟级）、备份快。代价是冷数据查询要走冷库（100ms 延迟），但冷数据访问低频（用户偶尔查半年前订单），可接受。

**为什么用分区表而不是直接 DELETE**：DELETE 是 DML，逐行标记删除，产生大量 binlog（主从同步压力）、锁持有久（长事务）、空间不释放。DROP PARTITION 是 DDL，直接删分区文件（.ibd 文件），秒级完成、无 binlog、空间立即释放。按月分区还能做分区裁剪（查询只扫相关分区）。

**为什么用 pt-archiver 而不是批量 DELETE**：批量 DELETE FROM WHERE create_time < ... 会锁大量行、产生海量 binlog、可能撑爆 undo log。pt-archiver 小批量（每次 1000 行 SELECT + DELETE）、限速（--max-load 负载保护）、支持迁移到冷库（--dest）。全程不锁表、可控、可监控。

## 六、AI 架构师加问：5 个

1. **AI 自动判断冷热数据？**
   能辅助。AI 分析表的访问日志（哪些行近 30 天被查过），自动标注冷热。比固定时间规则（90 天前冷）更准——有些老数据频繁被查（如爆款商品的历史订单），不该归档。但归档决策（何时归档、归档到哪）需人工确认。

2. **AI 预测大表何时需要治理？**
   AI 根据表的增长速率、查询延迟趋势、索引大小预测"几个月后会慢"。提前预警做归档。但预测依赖历史趋势，突发增长（大促）可能误判。

3. **AI 生成归档 SQL？**
   AI 能根据表结构生成 pt-archiver 命令、分区表 DDL、冷热路由代码。但归档策略（按时间还是状态、归档到 TiDB 还是 S3）要结合业务，AI 只能提建议。

4. **AI 查询冷数据自动加速？**
   AI 能预加载高频冷数据到缓存（用户可能查的订单提前预热）。比统一缓存策略更精准。但冷数据访问低频，预热 ROI 低。

5. **向量检索场景的大表怎么治理？**
   向量库（Milvus/Qdrant）也有数据量增长问题。冷向量（低频查询的 embedding）归档到廉价存储。难点是向量索引重建贵（IVF/HNSW 增删后索引退化），归档要配合索引重建。AI 能识别冷向量（近 30 天未被召回的）。

## 七、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"三步治、三工具、三原则"**。

- **三步治**：冷热分层（判断标准）→ 归档冷数据（搬到冷库）→ 分区表治理（在线表变小）
- **三工具**：pt-archiver（小批量不锁表迁移）、DROP PARTITION（秒级删分区）、冷热路由（先查在线 miss 查冷库）
- **三原则**：不锁表（小批量 + 限速）、可回查（冷库保留）、低峰期执行

### 拟人化理解

把大表想成**图书馆**。藏书 10 亿本（10 亿行）找书慢（查询慢）。治理：热门新书（热数据）放前厅（在线库 SSD），冷门旧书（冷数据）搬地下书库（冷库 TiDB）。前厅书少（单表小）找书快。搬书（归档）不能锁门（不锁表），每次搬一筐（小批量 1000 行）、趁夜深（低峰）、人多时暂停（限速）。地下书库偶尔有人查（冷数据低频），查时去地下取（冷热路由）。

### 面试现场 60 秒回答

> 大表治理三步。第一步冷热分层——按时间（90 天前冷）、状态（已完结冷）、访问频率（30 天无访问冷）判断。第二步归档冷数据到冷库——用 pt-archiver 小批量迁移（每次 1000 行，--max-load 负载保护，不锁表），搬到 TiDB（分析查询）或归档 MySQL。归档先搬后删（验证冷库有数据再删在线）。第三步在线表改分区表——RANGE 按月分区，DROP PARTITION 秒级删历史分区（替代 DELETE 10 亿行的灾难，DELETE 产生海量 binlog 锁表，DROP 直接删分区文件秒级无 binlog）。查询走分区裁剪（带时间条件只扫相关分区）。应用层冷热路由——先查在线表，miss 查冷库，跨冷热范围两边查合并。效果：热表从 10 亿行降到 3000 万行，查询 P99 从 50ms 回到 1ms，DDL 从 4 小时降到几分钟，备份从 8 小时降到 10 分钟。关键：归档全程不锁表（小批量 + 限速 + 低峰期），冷数据可查（冷库保留 + 透明路由）。

### 反问面试官

> 贵司最大的表多少行、什么存储？有没有分区表？冷数据访问频率多高？这决定我用分区表治理还是分库分表，冷库选 TiDB 还是归档 MySQL。

## 八、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不直接分库分表，要搞归档？ | 分库分表解决"单实例容量上限"（10TB+），归档解决"单表数据量大导致慢"（10 亿行）。如果单实例容量够（500G），只是单表慢，归档即可（成本低）。如果容量不够（10TB），才分库分表。两者可组合（分库分表 + 每分片归档）。归档是更轻量的方案 |
| 证据追问 | 怎么证明归档有效？ | 对比归档前后：单表行数（10 亿→3000 万）、查询 P99（50ms→1ms）、二级索引大小（50G→2G）、DDL 耗时（4 小时→5 分钟）、备份耗时（8 小时→10 分钟）、buffer pool 命中率（95%→99.9%）。监控 MySQL 的 Innodb_rows_read、Slow_queries |
| 边界追问 | 归档能保证在线表一直小吗？ | 不能，业务持续写入。归档是持续过程（每天归档 90 天前的数据）。配合分区表 DROP PARTITION 自动化（每月定时删 N 个月前的分区）。热表稳定在近 90 天数据量 |
| 反例追问 | 什么场景不适合归档？ | 数据频繁跨时间查询（如年度报表查全年，冷热路由频繁走冷库，冷库压力大）。冷数据访问频繁（如电商爆款的历史订单天天被查）。这类要重新定义冷热（按访问频率而非时间），或接受全量在在线库（加内存、优化索引） |
| 风险追问 | 归档最大风险？ | ① 归档期间 DELETE 失败导致数据不一致（先搬后删、验证再删）；② 冷库不可用时冷数据查不到（冷库高可用 + 降级提示）；③ 分区表查询不带分区键导致全分区扫描（代码 review + 慢查询监控）；④ DROP PARTITION 误删活跃分区（权限管控 + 双人确认） |
| 验证追问 | 怎么验证归档数据完整？ | 归档前后 count 对比（在线 + 冷库 = 原始总数）、checksum 抽样校验、冷热路由命中率（冷库查询比例符合预期）。归档任务记录搬了多少行、删了多少行，对账 |
| 沉淀追问 | 团队大表治理规范？ | 分区表规范（按月 RANGE、提前建分区、定时 DROP）、归档 SOP（pt-archiver 命令模板 + 负载阈值 + 低峰窗口）、冷库查询路由 SDK、大表监控大盘（行数/索引大小/查询延迟/DDL 耗时告警） |

### 现场对话示例

**面试官**：10 亿行的表，DELETE 历史数据为什么不行？

**候选人**：DELETE 是 DML，三个灾难。第一，逐行标记删除，产生海量 binlog（10 亿行可能几十 G binlog），主从同步延迟几小时，从库查到的是旧数据。第二，锁——DELETE 持有行锁时间长（长事务），并发写入被阻塞甚至死锁。第三，空间不释放——InnoDB 的 DELETE 只标记删除（MVCC），物理空间不回收，表碎片化严重，查查询依然慢（扫空页）。要 OPTIMIZE TABLE 重建表才回收（又锁表几小时）。正确做法是分区表 DROP PARTITION——DDL 直接删分区文件（.ibd），秒级完成、无 binlog（DDL 不产生 row binlog）、空间立即释放。

**面试官**：pt-archiver 怎么保证不锁表？

**候选人**：三个机制。第一，小批量——每次 SELECT + DELETE 1000 行（--limit 1000），行锁持有时间短（毫秒级），不阻塞并发写。第二，限速——--max-load Threads_running=50，每秒检查在线库的活跃连接数，超过 50 就暂停（sleep），等负载降下来再继续。业务高峰自动让路。第三，低峰执行——归档任务在凌晨 2-6 点跑（XxlJob 定时），避开高峰。这三个组合，1 亿行归档约 3-5 小时，全程不锁表、业务无感。极端情况（负载持续高），暂停归档等下个低峰窗口。

**面试官**：冷数据用户要查怎么办？

**候选人**：冷热透明路由。应用层 OrderQueryService 先查在线表（热数据），miss 再查冷库（冷数据）。用户无感——查近 1 个月订单走在线表（1ms），查半年前订单走冷库（100ms，用户可接受）。跨冷热范围的查询（查近 1 年）两边都查合并结果。冷库选 TiDB（分析查询快、容量大）或归档 MySQL（同协议无感）。关键是冷数据访问低频（用户偶尔查历史订单），冷库延迟 100ms 可接受。如果冷数据高频访问（如爆款历史订单天天被查），重新定义冷热（按访问频率而非时间），热数据范围调大（180 天）。

## 常见考点

1. **大表为什么慢？**——B+ 树深（4 层多一次磁盘 IO）、二级索引膨胀（缓冲池装不下）、深翻页（LIMIT 1000000 扫百万行）、DDL 重建表久、备份恢复慢。归档减数据量解决。
2. **分区表怎么治大表？**——RANGE 按时间分区，DROP PARTITION 秒级删历史（替代 DELETE 灾难）。查询带时间条件走分区裁剪（只扫相关分区）。主键必须含分区键。
3. **pt-archiver 怎么不锁表？**——小批量（每次 1000 行 SELECT+DELETE）、限速（--max-load 负载保护暂停）、低峰期执行。1 亿行几小时，全程不锁。
4. **冷热数据怎么判断？**——时间（90 天前冷）、状态（已完结冷）、访问频率（30 天无访问冷）。三者结合，不同业务冷热标准不同（金融可能 7 天热，内容可能 1 年热）。
5. **冷数据查询怎么透明？**——应用层冷热路由（先查在线表 miss 查冷库）、统一查询网关自动路由、跨冷热范围两边查合并。冷库延迟 100ms 但低频可接受。

## 结构化回答

**30 秒电梯演讲：** 大表治理的本质是把不活跃的历史数据从在线库剥离，让在线表小而快。核心三步——冷热分层（按时间/状态区分冷热）、归档（冷数据搬到廉价存储）、分区分表（在线表分区/分片降低单表规模）。难点是归档期间数据持续写入，归档操作不能锁在线表影响业务

**展开框架：**
1. **冷热判断** — 按时间（90 天前冷）、按状态（已完结订单冷）、按访问频率（近 30 天无访问冷）
2. **归档方式** — mysqldump 导出 + 删除、pt-archiver 小批量迁移、binlog 同步到冷库
3. **分区表** — RANGE 分区按时间（partition by range），DROP PARTITION 秒级删分区

**收尾：** 以上是我的整体思路。您想继续深入聊——归档时怎么不锁表？


## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：大表治理、冷热分层与归档 | "这题一句话：大表治理的本质是把不活跃的历史数据从在线库剥离，让在线表小而快。" | 开场钩子 |
| 0:15 | 像图书馆管理藏书类比图 | "打个比方：像图书馆管理藏书。" | 核心类比 |
| 0:40 | 冷热判断示意/对比图 | "按时间（90 天前冷）、按状态（已完结订单冷）、按访问频率（近 30 天无访问冷）" | 冷热判断要点 |
| 1:05 | 归档方式示意/对比图 | "mysqldump 导出 + 删除、pt-archiver 小批量迁移、binlog 同步到冷库" | 归档方式要点 |
| 1:55 | 总结卡 | "记住：冷热判断。下期见。" | 收尾 |
