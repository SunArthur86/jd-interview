---
id: pdd-scm-005
difficulty: L3
category: pdd-scm
subcategory: MySQL
tags:
- 拼多多
- 供应链
- MySQL
- 索引
- SQL 优化
feynman:
  essence: MySQL InnoDB 索引是 B+ 树，聚簇索引叶子存整行、二级索引叶子存主键需回表；优化靠"最左前缀匹配 + 覆盖索引避免回表 + EXPLAIN 看 type/key_len/Extra"。
  analogy: B+ 树像按拼音排序的多层字典——根节点是大分类，叶子是词条定义且按顺序链表连。索引优化就是让查询走最短路径（少 IO、少回表）。
  first_principle: 磁盘 IO 是数据库瓶颈，B+ 树用"矮胖（多路）+ 叶子链表"把单次查询 IO 数 = 树高 ≈ log(1000, n)，亿级数据也只要 3-4 次 IO。
  key_points:
  - 聚簇索引（主键，叶子存整行）vs 二级索引（叶子存主键，需回表）
  - 最左前缀：联合索引 (a,b,c) 能用 a / a,b / a,b,c，不能跳过 b 用 c
  - "覆盖索引：查询字段都在索引里，免回表（Extra: Using index）"
  - "EXPLAIN：type（ref/range 优于 ALL）、key_len、rows、Extra"
first_principle:
  problem: 亿级数据下单次查询如何用最少磁盘 IO 完成？
  axioms:
  - 磁盘 IO 慢（比内存慢万倍）
  - 一页 16KB，树越矮 IO 越少
  - 有序数据支持范围扫
  rebuild: B+ 树（非叶子只存 key 扇出大、叶子存数据+链表）+ 聚簇（主键有序存）+ 覆盖索引（免回表）。
follow_up:
- 联合索引 (a,b,c)，WHERE a=1 AND c=3 用几列？——只用 a；5.6+ 有 ICP 可在引擎层过滤 c
- 深分页 LIMIT 1000000,10 怎么优化？——子查询+主键 join、游标分页
- 供应链常见 SQL 优化？——商品列表（按类目+销量排）、订单查询（按 uid+时间）
memory_points:
- 聚簇索引叶子存整行，二级索引叶子存主键（需回表）
- 最左前缀 + 全值匹配 + 范围之后失效
- EXPLAIN 三看：type、rows、Extra（Using index 最佳）
- 深分页用游标（WHERE id > last_id）
---

# 【拼多多供应链】MySQL 索引怎么优化？EXPLAIN 怎么看？

> JD 依据："熟悉 MySQL、Redis 等主流存储引擎的原理，具备性能调优能力"。

## 一、InnoDB 索引结构

**聚簇索引**（主键索引）：叶子节点存整行数据，一张表一个。
**二级索引**（非主键索引）：叶子节点只存"索引列+主键"，查询需回表。

B+ 树特性：
- 非叶子节点只存 key（扇出大，树矮）
- 所有数据在叶子节点
- 叶子节点双向链表（支持范围扫）
- 3 层 B+ 树可存约 2000 万行（1170²×16）

## 二、联合索引与最左前缀

联合索引 `(a, b, c)` 按 a→b→c 字典序排列：
| 查询 | 用索引 | 原因 |
|------|--------|------|
| `WHERE a=1` | ✅ a | 最左 |
| `WHERE a=1 AND b=2 AND c=3` | ✅ 全用 | 全匹配 |
| `WHERE b=2` | ❌ | 缺最左 a |
| `WHERE a=1 AND c=3` | ⚠️ 只 a | 跳过 b |
| `WHERE a=1 AND b>2 AND c=3` | ⚠️ a,b | b 范围后 c 失效 |

**口诀**：全值匹配最左前缀，范围之后索引失效。

## 三、EXPLAIN 关键字段

```sql
EXPLAIN SELECT * FROM product WHERE category_id=100 ORDER BY sales DESC LIMIT 10;
```

| 字段 | 含义 | 目标 |
|------|------|------|
| type | 访问类型 | ref/range 优于 ALL（全表扫） |
| key | 实际用的索引 | 命中预期 |
| key_len | 索引使用长度 | 判断联合索引用了几列 |
| rows | 预估扫描行数 | 越小越好 |
| Extra | 附加信息 | Using index 最佳；Using filesort 要优化 |

## 四、供应链 SQL 优化案例

**场景**：商品列表查询（按类目+销量排序），商品表 1 亿行。

```sql
-- ❌ 慢：全表扫 + filesort
SELECT * FROM product WHERE category_id=100 ORDER BY sales DESC LIMIT 10;
-- EXPLAIN: type=ALL, rows=1亿, Using filesort

-- ✅ 建联合索引 (category_id, sales)
-- EXPLAIN: type=ref, key_len=4, rows=10, Using index condition
```

**深分页优化**：
```sql
-- ❌ 慢：扫 100 万行后丢掉
SELECT * FROM product WHERE category_id=100 ORDER BY sales LIMIT 1000000,10;

-- ✅ 游标分页（连续翻页）
SELECT * FROM product WHERE category_id=100 AND sales < 上次最后值 ORDER BY sales DESC LIMIT 10;
```

## 五、索引失效场景

```sql
WHERE DATE(created_at)='2026-07-07'      -- 函数操作列失效
WHERE phone = 13800138000                 -- 隐式类型转换（字段是 varchar）
WHERE name LIKE '%拼'                     -- 前导模糊失效
WHERE status != 1                         -- 不等于通常全表扫
```

## 六、底层本质

B+ 树是数据库最优解：矮（IO 少）+ 叶子链表（范围扫）+ 聚簇（省回表）。优化就是让查询走最短路径——少 IO（用索引）、少回表（覆盖索引）、少排序（索引有序）。

## 常见考点
1. **回表为什么慢**？——多一次 B+ 树查找（聚簇索引），高 QPS 下放大明显。
2. **覆盖索引**？——查询字段都在索引里，`Extra: Using index`，免回表。
3. **怎么判断建什么索引**？——慢查询日志 → EXPLAIN → 高选择性列在前 → 覆盖高频查询。
