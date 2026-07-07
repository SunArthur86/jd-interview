---
id: ant-risk-008
difficulty: L3
category: jd-core
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
