---
id: java-architect-021
difficulty: L3
category: java-architect
subcategory: MySQL
tags:
- MySQL
- 索引
- SQL
feynman:
  essence: 索引设计的本质是"为高频查询路径建 B+ 树有序结构，把全表扫描 O(N) 降为树查找 O(logN)"。慢 SQL 诊断的本质是"用 EXPLAIN 看 type/key/rows/Extra 四列，判断索引是否命中、扫描行数是否可控、是否触发额外排序/临时表"。两者结合是数据库性能治理的核心技能。
  analogy: 像图书馆找书。没有索引是"逐架逐本翻"（全表扫描 O(N)）；有索引是"先查目录卡片（B+ 树）定位书架号再直取"（O(logN)）。联合索引是"按"作者+书名"排序的卡片，查"某作者的所有书"只需定位一次（最左前缀），但查"某书名的所有作者"用不上（违背最左前缀）。覆盖索引是"卡片上直接有摘要，不用再去书架取书"（不用回表）。
  first_principle: 为什么用 B+ 树而不是哈希或红黑树？因为数据库索引要支持范围查询（>、<、BETWEEN）和排序（ORDER BY），哈希只支持等值查询，红黑树层级太高（磁盘 IO 多）。B+ 树非叶子节点不存数据，扇出大（千级子节点），3-4 层就能覆盖亿级数据，磁盘 IO 次数少。
  key_points:
  - B+ 树：非叶子节点只存索引，叶子节点存数据+链表，3-4 层覆盖亿级数据
  - 聚簇索引（主键）vs 二级索引：叶子存整行 vs 叶子存主键（需回表）
  - 最左前缀：联合索引 (a,b,c) 可用于 a、a,b、a,b,c，不能跳过 a 直接用 b
  - 覆盖索引：查询字段都在索引里，不用回表（Extra=Using index）
  - 索引失效：函数操作列、隐式类型转换、LIKE '%x'、OR、!=、ORDER BY 非索引列
first_principle:
  problem: 给定一张亿级数据表和一组高频查询，如何设计索引让查询从秒级降到毫秒级？
  axioms:
  - 全表扫描 O(N) 在亿级数据上是秒级，不可接受
  - 索引把查找降到 O(logN)，但索引本身有存储和写入代价
  - 范围查询和排序是 SQL 的常见需求，索引必须支持
  rebuild: 用 B+ 树——非叶子节点只存索引键（扇出大，千级子节点），叶子节点存数据（聚簇）或主键（二级），叶子间用双向链表连接（支持范围查询和排序）。3-4 层 B+ 树（3-4 次 IO）就能覆盖亿级数据。设计原则：高频查询字段建索引；多条件查询建联合索引（按区分度排序，区分度高的放前面）；尽量用覆盖索引避免回表；避免索引失效场景（函数、类型转换、左模糊）。
follow_up:
  - 为什么索引用 B+ 树不用 B 树？——B 树每个节点都存数据，非叶子节点扇出小（几十子节点），层级深（亿级数据要 10+ 层，IO 多）。B+ 树非叶子节点只存索引，扇出大（千级），3-4 层够用；且叶子链表支持范围查询和排序（B 树范围查询要中序遍历多次回溯）
  - 联合索引字段顺序怎么排？——按区分度和查询频率排。区分度高的放前面（快速过滤），等值查询的字段放前面，范围查询的字段放后面（范围查询后的字段用不上索引）。如 (user_id, status, create_time)——user_id 区分度高，status 等值，create_time 范围
  - 回表为什么慢？——二级索引叶子存的是主键，要用主键再去聚簇索引查整行数据（多一次 B+ 树查找）。如果查询字段都在二级索引里（覆盖索引），不用回表。生产尽量用覆盖索引（如 SELECT id, name FROM users WHERE name=?，在 name 上建联合索引 (name, id)）
  - EXPLAIN 的 type 列怎么分级？——从好到差：system > const > eq_ref > ref > range > index > ALL。const/eq_ref 最优（主键/唯一索引等值），ref（普通索引等值），range（范围），index（扫整个索引树），ALL（全表扫描，必须优化）
  - 慢 SQL 怎么定位？——开启 slow_query_log（long_query_time=1s），慢日志记录执行超 1s 的 SQL；用 pt-query-digest 分析慢日志聚合（找出最频繁/最慢的 SQL）；EXPLAIN 分析执行计划；SHOW PROCESSLIST 看当前执行中的 SQL
memory_points:
  - B+ 树：非叶子只存索引（扇出大），叶子存数据+链表（范围查询）
  - 聚簇索引（主键，叶子存整行）vs 二级索引（叶子存主键，需回表）
  - 最左前缀：(a,b,c) 可用于 a / a,b / a,b,c
  - 覆盖索引：查询字段都在索引里，Extra=Using index，不回表
  - EXPLAIN 关键列：type（访问类型）、key（实际用索引）、rows（扫描行数）、Extra（额外信息）
  - 索引失效：函数、隐式转换、LIKE '%x'、OR、!=
---

# 【Java 后端架构师】MySQL 索引设计与慢 SQL 诊断

> 适用场景：JD 核心技术。订单表亿级数据，一条没命中索引的 SQL 就是全表扫描几秒，拖垮整个 DB 连接池。架构师必须能用 EXPLAIN 看执行计划、设计联合索引、诊断慢 SQL——这是数据库性能的命脉。

## 一、概念层：B+ 树索引结构

**B+ 树结构**（画图必考）：

```
                    ┌───────────────┐
                    │   根节点       │  只存索引键（扇出大）
                    │ [10|30|50|70] │  指向 5 个子节点
                    └───┬───────┬───┘
            ┌───────────┘       └───────────┐
            ▼                               ▼
    ┌───────────────┐               ┌───────────────┐
    │  中间节点       │   ...         │  中间节点       │
    │ [5|10|15|20]  │               │[55|60|65|70]  │
    └───────┬───────┘               └───────┬───────┘
            ▼                               ▼
┌──────────────────────────────────────────────────────┐
│  叶子节点（存数据）+ 双向链表连接                       │
│  [1,2,3,4,5] ↔ [6,7,8,9,10] ↔ [11,...] ↔ ...        │
│   叶子存整行（聚簇索引）或主键值（二级索引）            │
└──────────────────────────────────────────────────────┘

特点：
  1. 非叶子节点只存索引键，扇出大（InnoDB 默认页 16KB，可存 ~1000 个键）
  2. 3-4 层就能覆盖亿级数据（1000^3 = 10 亿）
  3. 叶子节点双向链表，范围查询和排序高效
  4. 等值查询：从根到叶 3-4 次 IO
  5. 范围查询：定位起点，沿链表向后扫描
```

**聚簇索引 vs 二级索引**（必考）：

| 类型 | 叶子存什么 | 数量 | 示例 |
|------|-----------|------|------|
| **聚簇索引** | 整行数据 | 每表 1 个（主键） | PRIMARY KEY (id) |
| **二级索引（辅助索引）** | 主键值 | 每表多个 | INDEX (user_id), UNIQUE (phone) |

**回表过程**（关键概念）：

```
查询：SELECT * FROM orders WHERE user_id = 12345;

1. 在 user_id 二级索引 B+ 树查找 user_id=12345
   → 叶子节点返回主键 id=98765（不存整行）
2. 用 id=98765 去聚簇索引 B+ 树查找
   → 叶子节点返回整行数据（回表）

代价：2 次 B+ 树查找（多一次 IO）
优化：覆盖索引（查询字段都在二级索引里，不用回表）
```

## 二、机制层：联合索引与最左前缀

**联合索引结构**（画图理解）：

```
联合索引 INDEX (a, b, c)

B+ 树叶子节点按 (a, b, c) 排序：
  [(1,1,1), (1,1,2), (1,2,1), (1,2,3), (2,1,1), (2,1,3), (3,1,1), ...]

可以高效查询：
  WHERE a=1              ✓ 用上索引（a 最左前缀）
  WHERE a=1 AND b=2      ✓ 用上索引（a,b 连续）
  WHERE a=1 AND b=2 AND c=3  ✓ 用上索引（a,b,c 全用）
  WHERE a=1 AND c=3      △ 只用 a（c 用不上，b 缺失，c 在 b 后面）
  WHERE b=2              ✗ 用不上索引（违背最左前缀）
  WHERE b=2 AND c=3      ✗ 用不上索引（缺 a）
```

**最左前缀原理**：B+ 树按联合索引字段顺序排序。先按 a 排，a 相同按 b 排，b 相同按 c 排。所以查询必须从 a 开始才能利用有序性。跳过 a 直接查 b，B+ 树里 b 不是整体有序的（只在每个 a 分组内有序）。

**联合索引设计原则**：

```sql
-- 订单表常见查询：
-- 1. 查某用户的订单：WHERE user_id = ? ORDER BY create_time DESC
-- 2. 查某用户某状态订单：WHERE user_id = ? AND status = ?
-- 3. 查某时间段订单：WHERE create_time BETWEEN ? AND ?

-- 联合索引设计（按区分度 + 查询频率）：
CREATE INDEX idx_user_status_time ON orders(user_id, status, create_time);
-- user_id 区分度高（放前面，快速过滤）
-- status 等值查询（放中间）
-- create_time 范围/排序（放最后，范围查询后的字段用不上索引）

-- 反例（错误顺序）：
CREATE INDEX idx_bad ON orders(create_time, status, user_id);
-- create_time 区分度低（一天内大量订单），放前面过滤效果差
-- 且按 create_time 排序后，user_id 不再有序，查 user_id 用不上索引
```

**覆盖索引**（性能优化利器）：

```sql
-- 查询 1：需要回表
SELECT * FROM orders WHERE user_id = 12345;
-- Extra: NULL（表示需要回表取整行）

-- 查询 2：覆盖索引，不用回表
SELECT id, user_id, status FROM orders WHERE user_id = 12345;
-- 联合索引 (user_id, status) 叶子存的是 (user_id, status, id)
-- id 是主键，所有二级索引都隐含包含主键
-- 所以查询字段都在索引里，不用回表
-- Extra: Using index（覆盖索引标志）

-- 优化：把高频查询字段加入联合索引，形成覆盖索引
CREATE INDEX idx_user_cover ON orders(user_id, status, create_time, amount);
-- 这样 SELECT user_id, status, create_time, amount 也不用回表
```

## 三、实战层：EXPLAIN 执行计划解读

**EXPLAIN 关键列**（面试必背）：

```sql
EXPLAIN SELECT * FROM orders WHERE user_id = 12345 AND status = 'PAID';

+----+-------------+--------+------------+------+---------------+-----------+---------+-------+------+----------+-------+
| id | select_type | table  | partitions | type | possible_keys | key       | key_len | ref   | rows | filtered | Extra |
+----+-------------+--------+------------+------+---------------+-----------+---------+-------+------+----------+-------+
|  1 | SIMPLE      | orders | NULL       | ref  | idx_user      | idx_user  | 8       | const |  100 |    10.00 | NULL  |
+----+-------------+--------+------------+------+---------------+-----------+---------+-------+------+----------+-------+
```

| 列 | 含义 | 关注点 |
|----|------|--------|
| **type** | 访问类型（性能关键） | 从 system > const > eq_ref > ref > range > index > ALL，至少要 range |
| **key** | 实际使用的索引 | NULL 说明没走索引（全表扫描） |
| **key_len** | 索引使用长度 | 判断联合索引用了几个字段 |
| **rows** | 预估扫描行数 | 越小越好（应接近结果集） |
| **Extra** | 额外信息 | Using index（覆盖）、Using filesort（额外排序）、Using temporary（临时表） |

**type 列性能排序**（必背）：

| type | 含义 | 性能 | 示例 |
|------|------|------|------|
| **system** | 表只有一行 | 最优 | 系统表 |
| **const** | 主键/唯一索引等值 | 极快 | WHERE id = 1 |
| **eq_ref** | join 用主键/唯一索引 | 极快 | JOIN ON a.id = b.id |
| **ref** | 普通索引等值 | 快 | WHERE user_id = 1 |
| **range** | 索引范围扫描 | 中 | WHERE id BETWEEN 1 AND 100 |
| **index** | 扫整个索引树 | 慢 | 无 WHERE 的索引列 |
| **ALL** | 全表扫描 | 最差 | 无索引的 WHERE |

**Extra 列关注点**：

```sql
-- Using index：覆盖索引，不用回表（好）
EXPLAIN SELECT id, user_id FROM orders WHERE user_id = 1;
-- Extra: Using index

-- Using filesort：额外排序（需优化，特别是数据量大时）
EXPLAIN SELECT * FROM orders WHERE user_id = 1 ORDER BY update_time;
-- Extra: Using filesort（update_time 不在索引里，需额外排序）
-- 优化：把 update_time 加入联合索引

-- Using temporary：临时表（需优化）
EXPLAIN SELECT status, COUNT(*) FROM orders GROUP BY status;
-- Extra: Using temporary; Using filesort
-- 优化：status 建索引

-- Using where：用 WHERE 过滤（正常，但说明索引过滤不够）
EXPLAIN SELECT * FROM orders WHERE user_id = 1 AND amount > 100;
-- Extra: Using where（amount 不在索引，索引过滤后还要回表用 where）
```

## 四、实战层：慢 SQL 诊断与优化

**诊断流程**（画图必考）：

```bash
# 1. 开启慢查询日志
SET GLOBAL slow_query_log = ON;
SET GLOBAL long_query_time = 1;          # 超过 1s 记录
SET GLOBAL slow_query_log_file = '/var/log/mysql/slow.log';

# 2. 查看慢查询配置
SHOW VARIABLES LIKE 'slow_query%';
SHOW VARIABLES LIKE 'long_query_time';

# 3. 用 pt-query-digest 分析慢日志（聚合相同 SQL）
pt-query-digest /var/log/mysql/slow.log
# 输出：按总耗时/调用次数/单次耗时排序的 SQL 清单
# 找出"最频繁的慢 SQL"（调用次数多）和"最慢的 SQL"（单次耗时长）

# 4. EXPLAIN 分析执行计划
EXPLAIN SELECT ...;

# 5. 查看当前执行中的 SQL（实时诊断）
SHOW FULL PROCESSLIST;
# 关注 Time 列（执行时长），耗时长的可能是慢 SQL
# 用 KILL <id> 终止异常 SQL

# 6. 查看锁等待（如果是锁导致的慢）
SELECT * FROM information_schema.innodb_lock_waits;
SELECT * FROM information_schema.innodb_trx WHERE TIME_TO_SEC(TIMEDIFF(NOW(), trx_started)) > 5;
```

**索引失效场景**（面试必考清单）：

```sql
-- 1. 函数操作索引列（失效）
SELECT * FROM orders WHERE DATE(create_time) = '2026-07-13';  -- 失效
-- 优化：WHERE create_time >= '2026-07-13' AND create_time < '2026-07-14'

-- 2. 隐式类型转换（失效）
SELECT * FROM orders WHERE user_id = '12345';  -- user_id 是 BIGINT，传字符串隐式转换失效
-- 优化：WHERE user_id = 12345（传数字）

-- 3. LIKE 左模糊（失效）
SELECT * FROM orders WHERE order_no LIKE '%1234';   -- 失效（左模糊）
SELECT * FROM orders WHERE order_no LIKE '1234%';   -- 有效（右模糊）

-- 4. OR 连接非索引列（失效）
SELECT * FROM orders WHERE user_id = 1 OR order_no = 'X123';
-- 如果 order_no 没索引，整个查询失效
-- 优化：order_no 建索引，或拆成 UNION

-- 5. != 或 <> （失效，走全表扫描）
SELECT * FROM orders WHERE status != 'PAID';   -- 失效
-- 优化：改用 IN 列举，或接受全表扫描（如果大部分数据符合）

-- 6. 计算（失效）
SELECT * FROM orders WHERE user_id + 1 = 12346;   -- 失效
-- 优化：WHERE user_id = 12345

-- 7. IS NOT NULL（可能失效，取决于 NULL 比例）
SELECT * FROM orders WHERE remark IS NOT NULL;
```

**真实优化案例**：

```sql
-- 问题 SQL（慢，3 秒）
SELECT * FROM orders
WHERE user_id = 12345
  AND status = 'PAID'
  AND create_time > '2026-07-01'
ORDER BY create_time DESC
LIMIT 20;

-- EXPLAIN 结果：
-- type: ALL（全表扫描）
-- key: NULL（没走索引）
-- rows: 1 亿（扫描全表）
-- Extra: Using where; Using filesort（额外排序）

-- 诊断：
-- 1. user_id 没有索引 → 全表扫描
-- 2. ORDER BY create_time → filesort（额外排序）

-- 优化 1：建联合索引
CREATE INDEX idx_user_status_time ON orders(user_id, status, create_time);
-- user_id 等值（区分度高）
-- status 等值
-- create_time 范围 + 排序（索引有序，天然支持 ORDER BY）

-- 优化后 EXPLAIN：
-- type: ref（走了索引）
-- key: idx_user_status_time
-- rows: 50（只扫 50 行）
-- Extra: Using index condition（索引下推，无 filesort）

-- 优化 2：覆盖索引（如果只需要部分字段）
SELECT id, user_id, status, create_time, amount FROM orders WHERE ...;
-- 联合索引加 amount：CREATE INDEX idx_cover ON orders(user_id, status, create_time, amount);
-- Extra: Using index（覆盖，不回表）

-- 效果：3 秒 → 10 毫秒
```

**分页优化（深分页问题）**：

```sql
-- 问题：LIMIT 1000000, 20（深分页，扫描 100 万行）
SELECT * FROM orders ORDER BY create_time DESC LIMIT 1000000, 20;
-- 即使有索引，也要扫描 100 万行才能取后 20 行

-- 优化 1：延迟关联（先查主键再 JOIN）
SELECT o.* FROM orders o
INNER JOIN (
    SELECT id FROM orders ORDER BY create_time DESC LIMIT 1000000, 20
) t ON o.id = t.id;
-- 子查询走覆盖索引（SELECT id 只用主键），快

-- 优化 2：游标分页（记住上一页最后一个值）
SELECT * FROM orders
WHERE create_time < '上一页最后一条的时间'
ORDER BY create_time DESC LIMIT 20;
-- 不用 OFFSET，直接定位，O(1)

-- 优化 3：限制最大页数（产品妥协）
-- 超过 1000 页不允许翻（用户也不会翻那么深）
```

## 五、底层本质：为什么是 B+ 树和回表

回到第一性：**索引结构的本质是"为高频查询路径建有序结构，用空间换时间"**。

- **为什么是 B+ 树**：数据库索引要支持等值查询、范围查询、排序三种操作。哈希只支持等值（不支持范围）；红黑树/二叉树层级深（亿级数据 30+ 层，每层一次 IO）；B 树非叶子节点也存数据（扇出小，层级深）。B+ 树非叶子节点只存索引键（扇出大，千级子节点），3-4 层覆盖亿级数据（3-4 次 IO），叶子节点双向链表支持范围查询和排序。这是磁盘 IO 和查询能力的最优平衡。
- **为什么有回表**：聚簇索引（主键）的叶子存整行数据，每表只能有一个。二级索引的叶子只存主键值（不存整行），查询时如果需要的字段不在二级索引里，要用主键去聚簇索引查（回表）。回表的代价是多一次 B+ 树查找（3-4 次 IO）。覆盖索引（查询字段都在二级索引里）避免回表，性能提升明显。
- **最左前缀的本质**：B+ 树按联合索引字段顺序排序。先按 a 排，a 相同按 b 排。所以查询必须从最左字段开始才能利用有序性。跳过 a 直接查 b，B+ 树里 b 不是全局有序的（只在每个 a 分组内有序），无法用二分查找。这是排序规则的数学结果。
- **索引的代价**：索引加速查询但有代价——存储空间（每个索引一棵 B+ 树）、写入放大（INSERT/UPDATE/DELETE 要维护所有索引树）。所以索引不是越多越好，只对高频查询建。一般单表索引不超过 5-6 个。

## 六、AI 架构师加问：5 个 AI 相关问题

1. **让 AI 自动优化慢 SQL，AI 接管哪段？**
   AI 分析慢日志 + EXPLAIN 执行计划 → 识别问题（全表扫描、filesort、索引缺失）→ 推荐索引/重写 SQL。AI 输出建议（CREATE INDEX 语句、优化后的 SQL），人工 review 后执行。AI 不能直接建索引（生产索引变更有锁风险，要走审批）。

2. **AI 推理结果存 MySQL，索引怎么设计？**
   推理结果表常用查询：按 user_id 查最新结果、按 model_version 查。索引设计：(user_id, model_version, create_time)。如果存大字段（embedding 向量），不要放 MySQL（用向量数据库如 Milvus），MySQL 只存元数据和短结果。

3. **怎么用 AI 预测索引膨胀？**
   AI 分析索引使用率（Handler_read_key 增长 vs 索引大小增长）→ 识别低使用率索引（建了但很少查）→ 推荐删除。AI 还能监控索引碎片（INDEX_SIZE / DATA_SIZE 比值异常）→ 推荐重建索引（OPTIMIZE TABLE）。

4. **AI 生成的 SQL 怎么保证质量？**
   AI 生成 SQL 后强制 EXPLAIN 检查执行计划——type 不能是 ALL、rows 不能超阈值、不能有 filesort。对高风险 SQL（如全表扫描）拒绝执行或告警。AI 还要遵守索引规范（WHERE 字段必须有索引、禁止 SELECT *）。

5. **向量检索和 MySQL 索引什么关系？**
   MySQL 的 B+ 树索引不支持向量相似度检索（余弦/欧氏距离），只能做精确匹配。向量检索要用专用索引（HNSW、IVF）在向量数据库（Milvus/Pinecone）。混合查询（元数据过滤 + 向量召回）通常先 MySQL 精确过滤再向量检索，或用支持两者的数据库（如 pgvector）。

## 七、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"B+ 树结构、聚簇二级、最左前缀、覆盖索引、EXPLAIN 四列"**。

- **B+ 树**：非叶子只存索引（扇出大），叶子存数据+链表（范围查询）
- **聚簇（主键）vs 二级**：叶子存整行 vs 叶子存主键（需回表）
- **最左前缀**：(a,b,c) 用于 a / a,b / a,b,c，跳过 a 用不上
- **覆盖索引**：查询字段都在索引里，Using index，不回表
- **EXPLAIN**：type（访问类型）、key（实际索引）、rows（扫描行数）、Extra（额外信息）
- **索引失效**：函数、类型转换、LIKE '%x'、OR、!=、计算

### 拟人化理解

把索引想成**图书馆目录卡片**。没有索引是"逐架逐本翻"（全表扫描，亿级数据要几分钟）；有索引是"先查卡片定位书架号再直取"（B+ 树查找，3-4 次 IO 到毫秒）。聚簇索引是"卡片号就是书架号，卡片直接指向书"（主键，存整行）；二级索引是"卡片记录书名但指向书架号，找到书架号还要再去找书"（回表）。联合索引是"按作者+书名排序的卡片，查某作者所有书只需定位一次"（最左前缀）。覆盖索引是"卡片上直接有摘要，看完摘要就走不用去书架"（不回表）。索引失效是"卡片按拼音排序，你按笔画查（函数转换）就用不上"。

### 面试现场 60 秒回答

> MySQL 索引底层是 B+ 树——非叶子节点只存索引键（扇出大，千级子节点），叶子节点存数据+双向链表（支持范围查询和排序），3-4 层覆盖亿级数据。聚簇索引（主键）叶子存整行，二级索引叶子存主键值（查询非索引字段需回表）。联合索引遵循最左前缀——(a,b,c) 可用于 a / a,b / a,b,c，跳过 a 用不上。覆盖索引（查询字段都在索引里）避免回表，Extra 显示 Using index。EXPLAIN 看 type（访问类型，至少 range）、key（实际索引）、rows（扫描行数）、Extra（Using index/filesort/temporary）。索引失效场景：函数操作列、隐式类型转换、LIKE 左模糊、OR 连接非索引列。慢 SQL 诊断：开启 slow_query_log，用 pt-query-digest 聚合，EXPLAIN 分析，建合适索引。

### 反问面试官

> 贵司核心表（如订单表）数据量多大？有没有遇到过慢 SQL 导致的事故（如连接池耗尽）？索引治理是 DBA 统一管还是业务自己管？有没有用 AI 辅助慢 SQL 诊断？如果有，我会聊 EXPLAIN 自动分析和索引推荐。

## 八、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不给所有字段建索引？ | 用代价说话：索引加速查询但有写入代价（INSERT/UPDATE/DELETE 要维护所有索引树）、存储代价（每索引一棵 B+ 树）。给所有字段建索引会让写入性能暴跌（每次写要更新 N 棵树）。一般单表索引不超过 5-6 个，只对高频查询建 |
| 证据追问 | 你说这条 SQL 慢，怎么证明是索引问题？ | EXPLAIN 看 type（ALL 说明没走索引）、key（NULL 说明没走索引）、rows（扫描行数大）、Extra（filesort/temporary 说明额外开销）。用 SHOW PROCESSLIST 看执行状态。对比加索引前后的执行计划和耗时 |
| 边界追问 | 索引能解决所有 SQL 性能问题吗？ | 不能。解决不了数据量过大（要分库分表）、锁竞争（要优化事务）、连接数过多（要连接池治理）、硬件瓶颈（要扩容）。索引只解决"查找效率"，数据量到了百亿级再好的索引也扛不住，要分库分表 |
| 反例追问 | 什么场景不该建索引？ | 小表（几百行，全表扫描比走索引快，因为索引还要回表）、区分度低的字段（如 status 只有 0/1，建索引过滤效果差）、频繁更新的字段（索引维护代价高）、低频查询字段（建了不用浪费空间） |
| 风险追问 | 索引上线后最大风险？ | 主动点出：索引过多导致写入慢、建索引过程锁表（大表建索引要 pt-online-schema-change 无锁变更）、索引选错（优化器选错索引导致更慢，要用 FORCE INDEX 强制）、索引膨胀（废弃索引不删除） |
| 验证追问 | 怎么证明索引优化真的生效？ | EXPLAIN 前后对比（type 从 ALL 变 ref、rows 从百万变几十）；压测前后 P99 对比；线上监控慢日志（慢 SQL 数量下降）；关注 Handler_read_key（索引读取次数）vs Handler_read_rnd_next（随机读次数）比值 |
| 沉淀追问 | 团队索引治理规范，沉淀什么？ | 索引命名规范（idx_字段 / uk_字段）、索引评审流程（新索引 DBA 审核）、定期索引体检（低使用率索引清理）、慢 SQL 监控大盘、SQL 上线 EXPLAIN 检查（CI 流水线强制） |

### 现场对话示例

**面试官**：联合索引 (a, b, c)，查询 WHERE a=1 AND c=3 能用上几个字段？

**候选人**：只能用上 a，c 用不上。这是最左前缀原则决定的——B+ 树按 (a, b, c) 联合排序，先按 a 排，a 相同按 b 排，b 相同按 c 排。查询 WHERE a=1 AND c=3，先用 a=1 定位（a 有序，二分查找高效）。但跳过了 b，c 在每个 b 分组内才有序，跨 b 分组 c 不是整体有序的，所以 c=3 这个条件用不上索引二分，只能"在 a=1 的所有数据里逐行过滤 c=3"（这叫索引下推 ICP，MySQL 5.6+ 优化，减少回表次数但 c 不算索引用于查找）。如果要 c 也能用索引，查询应该是 WHERE a=1 AND b=? AND c=3（b 不能跳）。或者调整索引顺序为 (a, c, b)，但这样要评估其他查询的影响。

**面试官**：LIKE '%1234' 为什么用不上索引？

**候选人**：因为 B+ 树是按字符串前缀排序的。LIKE '1234%'（右模糊）可以用索引——定位到 '1234' 开头的第一个叶子节点，沿链表向后扫描直到不再以 '1234' 开头。但 LIKE '%1234'（左模糊）要找的是"以 1234 结尾"的字符串，B+ 树是按前缀排序的，"以 1234 结尾"的字符串在 B+ 树里分散在各处（如 'abc1234'、'xyz1234' 排序位置完全不同），无法用二分定位，只能全表扫描。同理 LIKE '%1234%' 也用不上索引。优化方案：如果必须左模糊，用全文索引（FULLTEXT）或 Elasticsearch（倒排索引支持任意位置匹配）。或者业务上避免左模糊（如让用户输入前缀而非后缀）。

**面试官**：深分页 LIMIT 1000000, 20 为什么慢，怎么优化？

**候选人**：LIMIT 1000000, 20 的执行过程是"扫描前 1000020 行，丢弃前 100 万行，返回后 20 行"。即使有索引，也要沿着索引叶子链表扫描 100 万次（每行一次 IO），非常慢。三种优化方案。第一，延迟关联——子查询 SELECT id 只走覆盖索引（主键在二级索引叶子就有，不回表），快速拿到 20 个主键，再 JOIN 取整行。这样子查询 O(索引扫描) 比 O(回表) 快。第二，游标分页——记住上一页最后一条的 create_time，下一页 WHERE create_time < '上一页最后值' ORDER BY create_time DESC LIMIT 20，直接用索引定位，不用 OFFSET 扫描。第三，产品妥协——限制最大页数（如超过 1000 页不让翻），用户实际不会翻那么深。生产首选游标分页，但要求排序字段唯一且连续（不能有重复值，否则会漏数据或重复）。

## 常见考点

1. **MySQL 为什么用 B+ 树不用 B 树/红黑树/哈希？**——B+ 树非叶子节点只存索引（扇出大），3-4 层覆盖亿级数据（IO 少）；B 树非叶子也存数据（扇出小，层级深）；红黑树是二叉树（亿级数据 30+ 层，IO 多）；哈希只支持等值查询不支持范围/排序。B+ 树叶子链表还支持范围查询和排序。
2. **索引下推（ICP）是什么？**——MySQL 5.6+ 优化。联合索引 (a,b,c)，查询 WHERE a=1 AND c=3，没 ICP 时先按 a=1 取出所有数据回表，再用 c=3 过滤；有 ICP 时在存储引擎层直接用 a=1 AND c=3 过滤（虽然 c 不用于查找但用于过滤），减少回表次数。Extra 显示 Using index condition。
3. **回表和覆盖索引区别？**——回表是二级索引叶子只存主键，查整行要用主键去聚簇索引再查一次。覆盖索引是查询字段都在二级索引里（含主键），不用回表。生产尽量用覆盖索引（把高频查询字段加入联合索引）。
4. **怎么判断索引该建几个字段？**——按查询条件和区分度。等值查询且区分度高的字段放前面（如 user_id），范围查询的字段放最后（如 create_time）。key_len 列能看出联合索引用了几个字段（每个字段占用的字节数之和）。一般 3-4 个字段够用，太多字段索引树变大、写入代价高。


## 结构化回答

**30 秒电梯演讲：** 聊到MySQL 索引设计与慢 SQL 诊断，我的理解是——索引设计的本质是"为高频查询路径建 B+ 树有序结构，把全表扫描 O(N) 降为树查找 O(logN)"。慢 SQL 诊断的本质是"用 EXPLAIN 看 type/key/rows/Extra 四列，判断索引是否命中、扫描行数是否可控、是否触发额外排序/临时表"。两者结合是数据库性能治理的核心技能。打个比方，像图书馆找书。没有索引是"逐架逐本翻"（全表扫描 O(N)）；有索引是"先查目录卡片（B+ 树）定位书架号再直取"（O(logN)）。联合索引是"按"作者+书名"排序的卡片，查"某作者的所有书"只需定位一次（最左前缀），但查"某书名的所有作者"用不上（违背最左前缀）。覆盖索引是"卡片上直接有摘要，不用再去书架取书"（不用回表）。

**展开框架：**
1. **B+ 树** — 非叶子节点只存索引，叶子节点存数据+链表，3-4 层覆盖亿级数据
2. **聚簇索引（主键）vs 二级索引** — 叶子存整行 vs 叶子存主键（需回表）
3. **最左前缀** — 联合索引 (a,b,c) 可用于 a、a,b、a,b,c，不能跳过 a 直接用 b

**收尾：** 这块我在项目里也踩过坑——想深入的话，可以接着聊：为什么索引用 B+ 树不用 B 树？您更想看哪个方向？

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡 | "MySQL 索引设计与慢 SQL 诊断——这道题面试官到底想考什么？我用 30 秒给你讲透。" | 开场钩子 |
| 0:15 | SQL EXPLAIN 截图 | 先说核心：索引设计的本质是"为高频查询路径建 B+ 树有序结构，把全表扫描 O(N) 降为树查找 O(logN)"。慢 SQL 诊断的本质是"用 EXPLAIN 看 type/key/r。 | 核心定义 |
| 0:40 | B+ 树索引结构图 | 叶子存整行 vs 叶子存主键（需回表）。 | 聚簇索引（主键）vs 二级索引 |
| 1:05 | 概念结构示意图 | 联合索引 (a,b,c) 可用于 a、a,b、a,b,c，不能跳过 a 直接用 b。 | 最左前缀 |
| 2:30 | 总结卡 | 一句话记忆：B+ 树：非叶子只存索引（扇出大），叶子存数据+链表（范围查询）。 下期可以接着聊：为什么索引用 B+ 树不用 B 树。 | 收尾总结 |
