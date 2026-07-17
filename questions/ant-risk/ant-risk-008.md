---
id: ant-risk-008
difficulty: L3
category: ant-risk
subcategory: MySQL
tags:
- 蚂蚁
- 风控
- MySQL
- 索引
- B+树
- EXPLAIN
feynman:
  essence: InnoDB 用 B+ 树索引，主键索引和数据一体（聚簇），二级索引存主键值（需回表）；最左前缀匹配、覆盖索引、避免回表是优化的核心。
  analogy: B+ 树像一本按拼音排序的字典：根节点是字母大分类（A/B/C...），中间节点是声母/韵母，叶子节点是词条定义。叶子间用链表连，方便范围扫。
  first_principle: 磁盘 IO 是数据库性能瓶颈，B+ 树把"数据有序 + 矮胖（多路）+ 叶子链表"组合，让单次查询 IO 次数 = 树高 ≈ log(1000,n)，亿级数据也只要 3-4 次 IO。
  key_points:
  - InnoDB 聚簇索引：叶子存整行；二级索引叶子存主键
  - B+ 树：非叶子只存索引（多路）、叶子存数据、叶子双向链表
  - 最左前缀：联合索引 (a,b,c) 能用 a / a,b / a,b,c，不能跳过 b 直接用 c
  - 覆盖索引：查询字段都在索引里，免回表
  - EXPLAIN 关注：type、key、rows、Extra（Using index / Using filesort / Using temporary）
first_principle:
  problem: 如何在海量数据（亿级）下让单次点查/范围查的磁盘 IO 次数最小？
  axioms:
  - 磁盘 IO 是瓶颈（毫秒级，比内存纳秒级慢 1 万倍）
  - 单次 IO 能读一页（16KB），树越矮 IO 越少
  - 有序数据支持范围查询
  rebuild: 用 B+ 树——非叶子只存 key（一页能放更多 key，扇出大、树矮）；叶子存数据并双向链表（范围扫 O(1) 下一节点）。聚簇索引让数据按主键有序存储，点查和范围查都只需 log(n) 次 IO。
follow_up:
- 为什么 MySQL 用 B+ 树不用 B 树或红黑树？——B+ 树非叶子不存数据扇出更大（矮），红黑树是二叉树亿级数据树高 30+ 次 IO
- 联合索引 (a,b,c) 哪些查询用不到？——WHERE b=1（跳过 a）、WHERE a=1 AND c=1（中间断）
- 深分页 LIMIT 1000000,10 怎么优化？——子查询 + 主键 join、覆盖索引、游标分页
memory_points:
- 聚簇索引叶子存整行，二级索引叶子存主键值（需回表）
- B+ 树：非叶子只存 key（多路矮胖），叶子存数据 + 双向链表
- 最左前缀匹配 + 全值匹配 + 范围之后失效
- EXPLAIN 三看：type（ref/range 优于 ALL）、rows（扫描行数）、Extra（Using index 最佳）
---

# 【蚂蚁风控】MySQL 索引底层是什么？联合索引最左前缀怎么生效？EXPLAIN 怎么看？

> JD 依据："MySQL"。风控的事务流水、风险事件、用户画像都存 MySQL，索引是 SQL 优化核心。

## 一、表面层：InnoDB 的索引结构

InnoDB 有两种索引：

**聚簇索引（Clustered Index）**：
- 主键索引，**叶子节点存整行数据**
- 一张表只有一个
- 数据物理上按主键有序存储

**二级索引（Secondary Index）**：
- 非主键索引，叶子节点只存**索引列 + 主键**
- 查询需要先查二级索引拿主键，再回表查聚簇索引拿整行（**回表**）

```
聚簇索引（主键 id）              二级索引（user_id）
   [B+ 树]                         [B+ 树]
     ...                            ...
      ▼                              ▼
   ┌────────┐                    ┌─────────────┐
   │ id=100 │                    │ uid=500,    │
   │ 整行   │ ←─── 回表查询 ───  │  主键id=100 │
   └────────┘                    └─────────────┘
```

## 二、B+ 树的三个核心特性

**1. 非叶子节点只存 key**（不存数据）
- 一个 16KB 页能存 1000+ 个 key（指针对应子节点）
- 扇出（fan-out）大 → 树矮

**2. 所有数据在叶子节点**
- 数据查询都到叶子层

**3. 叶子节点双向链表**
- 范围查询 O(1) 顺次扫

**树高计算**（假设 1 行 = 1KB，一页 16KB 能放 16 行；非叶子页只放索引键+指针，约 1170 个指针）：
- **3 层 B+ 树**：根(1 页) → 中间(1170 页) → 叶子(1170×1170 ≈ 137 万页)，每页 16 行 ≈ **2190 万行**
- **4 层 B+ 树**：1170³ × 16 ≈ **250 亿行**

所以千万级表 3 次 IO、亿级表 4 次 IO 就能找到（每次 IO 对应一层）。

## 三、联合索引与最左前缀

联合索引 `(a, b, c)` 在 B+ 树里按 a、b、c 字典序排列：
```
(1,1,1) (1,1,2) (1,2,1) (2,1,1) (2,2,1) ...
```

**最左前缀匹配规则**：
| 查询条件 | 是否用索引 | 原因 |
|---------|----------|------|
| `WHERE a=1` | ✅ 用到 a | 最左列匹配 |
| `WHERE a=1 AND b=2` | ✅ 用到 a,b | 顺序匹配 |
| `WHERE a=1 AND b=2 AND c=3` | ✅ 全用 | 全匹配 |
| `WHERE b=2` | ❌ 不用 | 缺最左 a |
| `WHERE a=1 AND c=3` | ⚠️ 只用 a | 跳过 b，c 无法用索引 |
| `WHERE a=1 AND b>2 AND c=3` | ⚠️ 用 a,b | b 是范围，c 不再用 |

**口诀**：**全值匹配最左前缀，范围之后索引失效**。

**索引下推（ICP，5.6+）**：`WHERE a=1 AND c=3` 在引擎层就过滤 c，减少回表次数。

## 四、覆盖索引（避免回表）

如果查询字段都在索引里，不用回表：
```sql
-- 索引 (uid, status)
SELECT uid, status FROM risk_event WHERE uid = 500;  -- Using index（覆盖）
SELECT * FROM risk_event WHERE uid = 500;            -- 需要回表（拿其他列）
```

EXPLAIN 看到 `Extra: Using index` 说明覆盖索引生效。

## 五、EXPLAIN 关键字段

```sql
EXPLAIN SELECT * FROM risk_event WHERE uid = 500 AND status = 1;
```

| 字段 | 含义 | 优化目标 |
|------|------|---------|
| **type** | 访问类型 | system > const > eq_ref > **ref** > **range** > index > **ALL**（要避免 ALL） |
| **key** | 实际用的索引 | 是否命中预期 |
| **key_len** | 索引使用长度 | 判断联合索引用了几列 |
| **rows** | 预估扫描行数 | 越小越好 |
| **Extra** | 附加信息 | `Using index` 最佳；`Using filesort`（文件排序）、`Using temporary`（临时表）要警惕 |

**重点关注**：
- `type = ALL` → 全表扫描，必须加索引
- `Using filesort` → 排序没用索引，需优化 ORDER BY
- `Using temporary` → 用了临时表（如 GROUP BY、DISTINCT）

## 六、风控实战：索引优化案例

**场景**：风控事件表 `risk_event(id, uid, merchant_id, amount, status, created_at)`，1 亿行。

**问题 SQL**：
```sql
SELECT * FROM risk_event WHERE uid = 500 AND status = 1 ORDER BY created_at DESC LIMIT 10;
-- EXPLAIN: type=ALL, rows=1亿, Using filesort  → 慢！
```

**优化步骤**：

1. **建联合索引**：`(uid, status, created_at)`
   - uid 高选择性在前
   - status 等值查询
   - created_at 在后做范围/排序

2. **看 EXPLAIN**：
   ```
   type=ref, key=idx_uid_status_created, rows=10, Extra: Using index condition
   ```
   - 用了 3 列索引
   - ORDER BY 用了索引（无需 filesort）
   - 但 SELECT * 仍要回表

3. **进一步优化（覆盖索引）**：
   ```sql
   -- 高频只查这几个字段
   SELECT id, uid, status, created_at FROM risk_event WHERE uid=500 AND status=1 ORDER BY created_at DESC LIMIT 10;
   -- Extra: Using index（完全覆盖）
   ```

4. **深分页优化**（LIMIT 1000000,10）：
   ```sql
   -- ❌ 慢：扫 100万行后丢掉
   SELECT * FROM risk_event WHERE uid=500 ORDER BY created_at LIMIT 1000000,10;

   -- ✅ 子查询 + 主键 join
   SELECT * FROM risk_event e
   INNER JOIN (SELECT id FROM risk_event WHERE uid=500 ORDER BY created_at LIMIT 1000000,10) t
   ON e.id = t.id;
   -- 子查询走覆盖索引，只回表 10 行

   -- ✅ 游标分页（适合连续翻页）
   SELECT * FROM risk_event WHERE uid=500 AND created_at < '上次最后一条' ORDER BY created_at DESC LIMIT 10;
   ```

## 七、索引失效的常见场景

```sql
-- 1. 函数操作列
WHERE DATE(created_at) = '2026-07-07'         -- ❌ 失效
WHERE created_at >= '2026-07-07' AND created_at < '2026-07-08'  -- ✅

-- 2. 隐式类型转换
WHERE phone = 13800138000                     -- ❌ 字段是 varchar 但传 int
WHERE phone = '13800138000'                   -- ✅

-- 3. 前导模糊
WHERE name LIKE '%张'                         -- ❌ 失效
WHERE name LIKE '张%'                         -- ✅

-- 4. OR 两边不全有索引
WHERE uid = 1 OR merchant_id = 2              -- 若 merchant_id 没索引则全表扫

-- 5. !=, <>, NOT IN
WHERE status != 1                             -- 通常全表扫（视数据分布）
```

## 八、底层本质：B+ 树为什么是数据库的最优解

对比其他数据结构：

| 结构 | 亿级数据查询 IO | 范围查询 |
|------|----------------|---------|
| 二叉搜索树 / 红黑树 | log2(1亿) ≈ 27 次 IO | 难 |
| B 树（数据在所有节点） | 3-4 次（但扇出小） | 中（要中序遍历） |
| **B+ 树** | **3-4 次（扇出大）** | **强（叶子链表）** |
| Hash | 1 次 | 不支持范围 |

B+ 树的"非叶子只放 key"设计让扇出从 B 树的几十提升到上千，树高从 4-5 降到 3-4。在亿级数据下，**省一次 IO 就是省几毫秒**，这是 B+ 树相对 B 树的核心优势。

**第一性原理**：把"磁盘 IO 次数 = 树高"作为优化目标，B+ 树用"非节点纯 key 降层高 + 叶子链表支持范围 + 数据按主键聚簇省回表"三件套，把 OLTP 场景的点查和范围查都做到对数级。

## 常见考点
1. **联合索引 (a,b,c)，`WHERE a=1 AND c=3` 用到几列**？——`key_len` 显示只用 a；5.6+ 有 ICP 可在引擎层过滤 c 减回表，但 c 仍不算索引用到。
2. **回表为什么慢**？——多一次 B+ 树查找（聚簇索引），高 QPS 下放大明显。
3. **怎么判断该建什么索引**？——看慢查询日志 → EXPLAIN → 高选择性列在前 → 覆盖高频查询字段。

**代码示例**（用 hint 强制索引）：
```sql
-- 优化器选错索引时强制指定
SELECT * FROM risk_event FORCE INDEX(idx_uid_status) WHERE uid=500 AND status=1;
```

## 苏格拉底式面试追问

> 这组追问不是背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：风控事件表 risk_event 你建了联合索引 (uid, status, created_at)，但为什么 uid 放第一列而不是 status？status 只有 0/1/2 三个值，按它先过滤不是更直接？**

因为索引列顺序的核心是"高选择性在前 + 等值在前 + 范围在后"。uid 是高基数字段（上千万用户），status 是低基数枚举（3 个值）。如果 status 在前，索引第一层按 status 分成 3 组，每组还是几千万行，B+ 树在 status 上的过滤选择性极差（每组分摊 1/3 数据），后续 uid 的定位范围还是很大。uid 在前，B+ 树第一层就能定位到具体用户（几行到几百行），status 只是这个用户的小范围二次过滤。决策依据是 EXPLAIN 的 rows 列——对比 (uid, status, created_at) 和 (status, uid, created_at) 两种索引，前者 rows=20、后者 rows=3300万，差距悬殊。索引顺序不是按"过滤优先级"排，是按"能多大程度缩小扫描范围"排。

### 第二层：证据与定位

**Q：风控的慢查询告警触发，发现一条 `SELECT * FROM risk_event WHERE uid=500 AND status=1 ORDER BY created_at` 耗时 3 秒。你怎么定位是索引没命中还是数据量大？**

用 EXPLAIN 看三个字段：
1. `type`——如果是 ALL（全表扫），说明索引没命中，可能 uid 字段类型不匹配（如传了 int 但字段是 varchar，隐式转换导致索引失效），或优化器选了别的索引。`SHOW INDEX FROM risk_event` 确认 idx_uid_status_created 存在。
2. `rows`——如果 rows=1000万，说明索引命中了但扫描行数巨大。可能是 uid=500 这个用户的 status=1 事件有几千万条（大客户），索引命中但数据本身就多。
3. `Extra`——如果出现 `Using filesort`，说明 ORDER BY created_at 没走索引排序（可能联合索引顺序不对，created_at 不在最后）；如果出现 `Using index condition` 但没 `Using index`，说明走了索引但要回表，rows 大时回表代价高。
再开 `slow_query_log` 看这条 SQL 的 `Rows_examined`（实际扫描行数），如果 Rows_examined=1000万 但只返回 10 行，是索引过滤性不够；如果 Rows_examined=10 但耗时 3 秒，是回表或锁等待问题（`SHOW ENGINE INNODB STATUS` 看是否有锁）。

### 第三层：根因深挖

**Q：你发现是 uid=500 这个大商户（百万级事件）的查询慢，索引命中但扫描行数大。根因是什么？光加索引解决不了？**

根因是数据倾斜——联合索引对大商户的过滤性不够。uid=500 有 100 万条事件，status=1 过滤后还有 50 万条，ORDER BY created_at 虽然走索引但 LIMIT 10 后仍要回表 10 次（每次 B+ 树查找聚簇索引）。真正的慢点可能是回表——50 万行按 created_at 有序，但只取 10 行，理论上回表 10 次应该快。要看 `Rows_examined` 的实际值——如果是 10 但耗时 3 秒，是回表时大量 buffer pool miss（大商户的数据不在缓存，每次回表都是磁盘 IO），`SHOW STATUS LIKE 'Innodb_buffer_pool_read_requests'` 对比 `Innodb_pages_read` 可以看到磁盘读比例。根因是"大商户的冷数据 + 回表随机 IO"。

**Q：根因是大商户冷数据回表，那为什么不直接把 status 和 created_at 也做成聚簇索引的一部分？或者按 uid 分表？**

聚簇索引一张表只能一个（主键），不能把 uid+status+created_at 都做聚簇。但可以把高频查询字段塞进二级索引实现覆盖索引避免回表——建 `(uid, status, created_at, amount, merchant_id)` 把 SELECT 用到的字段都加入索引，Extra 变成 `Using index`，完全不走聚簇索引。代价是索引变大（每行从 12 字节变 50 字节）、写入变慢（索引维护成本）。至于按 uid 分表，对大商户（uid=500 单独一张表）确实能解决，但分表破坏了"全局按 uid 查询"的便利性（查不同用户要路由不同表）。实务做法是分级——中小用户走单表 + 覆盖索引，Top 100 大商户单独归档到历史表（如 risk_event_archive_uid500），主表只保留最近 3 个月。这样大商户的扫描行数从 100 万降到几千。

### 第四层：方案权衡

**Q：你用了覆盖索引 + 大商户归档，但业务说大商户的查询还要带 amount 范围过滤（WHERE amount > 1000），覆盖索引要不要把 amount 也加进去？加进去索引太大怎么办？**

要看 amount 的过滤频率和选择性。如果 80% 的查询都带 amount 范围，且 amount 选择性高（金额分布分散），值得加——但放在 created_at 之后（范围字段放最后），索引变成 `(uid, status, created_at, amount)`，EXPLAIN 能看到 key_len 增加且 rows 进一步降低。如果 amount 只在 20% 查询出现，加进去会让所有查询的索引变大（即使不用 amount 列也要扫过它），得不偿失。权衡方案是建两个索引——`(uid, status, created_at)` 主力索引覆盖 80% 查询，`(uid, status, amount)` 辅助索引覆盖带 amount 的查询。代价是两个索引的写入和维护成本翻倍，但对 1 亿行写多读多的风控事件表，两个索引的写入开销（每次 insert 维护两棵 B+ 树）实测增加 <15%，可接受。

**Q：为什么不直接用 TiDB 这种分布式数据库，原生支持水平扩展，省去分表归档的复杂度？**

TiDB 确实解决了大表水平扩展，但有代价。TiDB 的点查 RT 比 MySQL 高 2-3 倍（TiDB 的 KV 层走网络 + Raft 多副本），风控事件表的核心查询是按 uid 点查 + 小范围扫，对 RT 敏感（要求 <20ms），TiDB 的 RT 可能在 30-50ms，吃掉决策链路的预算。TiDB 适合"大表 + 分析型查询"（如报表、聚合），不适合"大表 + 高频点查"。我们用的是"MySQL 主力（点查快）+ HBase 归档（历史大表）+ 离线数仓分析（TiDB/Spark）"的分层架构，各取所长。只有当单表超过 10 亿且查询模式偏分析时，才考虑 TiDB 替代 MySQL。当前 1 亿 + MySQL + 分层归档已经够用。

### 第五层：验证与沉淀

**Q：你怎么证明覆盖索引和归档优化真的让大商户查询变快？怎么量化"变快"？**

三组指标对比（上线前后各 1 周）：
1. 慢查询日志统计——开启 `slow_query_log` 并设 `long_query_time=0.1`（100ms），统计大商户（uid in Top100）的慢查询数量。优化前每天 5000 条慢查询（>1s），优化后 <50 条（>100ms），改善 100 倍。
2. EXPLAIN rows 对比——同一 SQL 优化前 `rows=1000000`、优化后 `rows=15`，扫描行数从百万级降到十级，直接证明索引命中 + 归档生效。
3. RT 分位——APM 里这条 SQL 的 P99 从 3 秒降到 15ms、P999 从 8 秒降到 50ms。同时看 buffer pool 命中率 `Innodb_buffer_pool_read_requests / (read_requests + pages_read)`，从 92% 提到 99%，证明回表随机 IO 减少（大商户热数据进缓存）。

**Q：怎么让团队所有 SQL 都做好索引优化、不引入慢查询？**

沉淀成机制：
1. SQL 上线审核——所有新 SQL 必须附 EXPLAIN 结果，type 必须 ≤ range、rows < 10000、无 Using filesort/temporary，否则 DBA 拒绝上线。用 `pt-query-advisor` 或自研 SQL linter 在 CI 强制校验。
2. 慢查询告警——线上 `long_query_time=0.5`，慢查询每 10 分钟聚合告警，每条慢查询自动 EXPLAIN 并归因（索引失效？回表多？锁等待？）发到群里。
3. 索引规范文档——联合索引顺序原则（高选择性前、等值前、范围后）、覆盖索引优先、避免 SELECT *，写成团队必读手册，新人入职 DBA 培训。
4. 定期索引优化——每月跑一次 `pt-index-usage` 分析冗余索引（从未使用的索引）和缺失索引（慢查询但没索引），输出索引优化报告。
5. 故障复盘——把这次"大商户 100 万行回表 + 冷数据 buffer pool miss → 3 秒慢查询"的 EXPLAIN 截图、buffer pool 命中率曲线、归档前后对比存知识库。


## 结构化回答

**30 秒电梯演讲：** 聊到MySQL 索引底层是什么，我的理解是——InnoDB 用 B+ 树索引，主键索引和数据一体（聚簇），二级索引存主键值（需回表）；最左前缀匹配、覆盖索引、避免回表是优化的核心。打个比方，B+ 树像一本按拼音排序的字典：根节点是字母大分类（A/B/C...），中间节点是声母/韵母，叶子节点是词条定义。叶子间用链表连，方便范围扫。

**展开框架：**
1. **InnoDB 聚簇索引** — 叶子存整行；二级索引叶子存主键
2. **B+ 树** — 非叶子只存索引（多路）、叶子存数据、叶子双向链表
3. **最左前缀** — 联合索引 (a,b,c) 能用 a / a,b / a,b,c，不能跳过 b 直接用 c

**收尾：** 这块我在项目里也踩过坑——想深入的话，可以接着聊：为什么 MySQL 用 B+ 树不用 B 树或红黑树？您更想看哪个方向？

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡 | "MySQL 索引底层是什么——这道题面试官到底想考什么？我用 30 秒给你讲透。" | 开场钩子 |
| 0:15 | SQL EXPLAIN 截图 | 先说核心：InnoDB 用 B+ 树索引，主键索引和数据一体（聚簇），二级索引存主键值（需回表）；最左前缀匹配、覆盖索引、避免回表是优化的核心。 | 核心定义 |
| 0:40 | B+ 树索引结构图 | 非叶子只存索引（多路）、叶子存数据、叶子双向链表。 | B+ 树 |
| 1:05 | 概念结构示意图 | 联合索引 (a,b,c) 能用 a / a,b / a,b,c，不能跳过 b 直接用 c。 | 最左前缀 |
| 2:30 | 总结卡 | 一句话记忆：聚簇索引叶子存整行，二级索引叶子存主键值（需回表）。 下期可以接着聊：为什么 MySQL 用 B+ 树不用 B 树或红黑树。 | 收尾总结 |
