---
id: pdd-content-006
difficulty: L3
category: pdd-content
subcategory: MySQL
tags:
- 拼多多
- 内容
- MySQL
- 索引
- B+ 树
- 评价
feynman:
  essence: MySQL 索引用 B+ 树（多叉+叶子链表）让范围查询 O(log N)；内容场景如评价按 (商品ID,创建时间) 建联合索引，遵循最左前缀。
  analogy: 索引像字典目录——B+ 树是目录的目录（多叉树），叶子串成链表方便翻页。
  first_principle: 全表扫描 O(N) 太慢，需有序数据结构把查询降为 O(log N)。
  key_points:
  - B+ 树：非叶存索引，叶子存数据+链表
  - 联合索引：(a,b,c) 最左前缀
  - 覆盖索引：查询字段全在索引
  - 回表：二级索引→主键→数据
first_principle:
  problem: 全表扫描 O(N) 慢，如何用数据结构加速查询？
  axioms:
  - 查询要快（<log N）
  - 磁盘 IO 是瓶颈（页为单位）
  - 范围查询常见
  rebuild: B+ 树（多叉降高度+叶子链表支持范围）。
follow_up:
  - 为什么用 B+ 树不用 B 树/红黑树？——B+ 树多叉矮（IO 少），叶子链表支持范围
  - 索引失效场景？——函数运算/类型不一致/最左前缀缺/范围后字段失效/like '%x'
  - 联合索引顺序怎么定？——区分度高+常用过滤条件+等值在前范围在后
memory_points:
  - B+ 树：非叶索引+叶子数据+链表
  - 联合索引最左前缀
  - 覆盖索引不回表
  - 回表：二级→主键→数据
---

# 【拼多多内容】MySQL 索引与评价查询优化？

> JD 依据："稳定性建设"、"和算法同学挖掘业务问题"。

## 一、B+ 树结构

```
              [30 | 60]                    非叶节点（只存索引）
             /    |    \
       [10|20] [40|50] [70|80]            非叶节点
        /  \    /  \    /  \
  → [10|20|30]→[40|50|60]→[70|80|90]→    叶子（存数据+双向链表）
```

**为什么 B+ 树**：
- 多叉（每个节点几百个孩子）→ 树矮（3 层存千万级）→ IO 少
- 叶子链表 → 范围查询 O(1) 翻页
- 非叶不存数据 → 单页放更多索引

对比：
- B 树：非叶也存数据，叶没链表
- 红黑树：二叉，太高，不适合磁盘

## 二、聚簇索引 vs 二级索引

**聚簇索引（InnoDB 主键）**：叶子存整行数据
**二级索引**：叶子存主键值，需回表

```
SELECT * FROM review WHERE product_id = 100;

二级索引 idx_product_id(product_id) 叶子存 (product_id=100, id=5)
  → 回表：用 id=5 去聚簇索引取整行
```

## 三、联合索引与最左前缀

```sql
-- 建索引
ALTER TABLE review ADD INDEX idx_pid_time_score(product_id, create_time, score);

-- 命中索引
SELECT * FROM review WHERE product_id = 100;                                 -- 命中
SELECT * FROM review WHERE product_id = 100 AND create_time > '2026-01-01';  -- 命中
SELECT * FROM review WHERE product_id = 100 AND create_time > ? AND score > 4;  -- 命中（范围后字段失效）

-- 不命中
SELECT * FROM review WHERE create_time > '2026-01-01';  -- 缺最左 product_id
SELECT * FROM review WHERE product_id + 1 = 101;        -- 字段运算
SELECT * FROM review WHERE product_id = 100 ORDER BY create_time DESC LIMIT 10;  -- 命中且有序
```

**最左前缀原则**：从最左开始匹配，遇到范围（>/</between/like '%x'）停止。

## 四、覆盖索引（不回表）

```sql
-- 查询字段全在索引里，不需要回表
SELECT product_id, create_time, score FROM review
WHERE product_id = 100 ORDER BY create_time DESC;
```

## 五、内容场景实战

**评价列表查询**（拼多多评价页）：
```sql
-- 建表
CREATE TABLE review (
  id BIGINT PRIMARY KEY,
  product_id BIGINT NOT NULL,
  uid BIGINT NOT NULL,
  score TINYINT,
  content TEXT,
  create_time DATETIME,
  is_anonymous TINYINT,
  status TINYINT,            -- 0待审 1通过 2拒绝
  INDEX idx_pid_time(product_id, create_time),     -- 列表查询
  INDEX idx_uid_time(uid, create_time),            -- 我的评价
  INDEX idx_status_create(status, create_time)     -- 审核队列
);
```

**首页评价翻页**：
```sql
-- 延迟关联优化深翻页
SELECT r.* FROM review r
INNER JOIN (
  SELECT id FROM review WHERE product_id = 100
  ORDER BY create_time DESC LIMIT 100000, 10       -- 先走索引取 id
) t ON r.id = t.id;                                -- 再回表
```

## 六、索引失效排查

```sql
EXPLAIN SELECT * FROM review WHERE product_id = 100;
-- type=ref key=idx_pid_time rows=10 Extra=Using index   命中
-- type=ALL rows=10000000                                全表扫描！
```

常见失效：
- 字段运算 `product_id + 1 = 100`
- 类型不一致 `product_id = '100'`（字符串数字）
- 最左前缀缺失
- 范围后字段失效
- `like '%100'`
- `OR` 两侧没都建索引

## 七、底层本质

索引本质是**"用 B+ 树把全表扫描 O(N) 降为 O(log N)"**——多叉降高度少 IO，叶子链表支持范围，覆盖索引免回表。

## 常见考点
1. **为什么不用 Hash 索引**？——Hash 不支持范围/排序/最左前缀，等值查询才快。
2. **索引建多了有什么坏处**？——写入慢（要更新索引）+ 占空间。
3. **EXPLAIN 重点看什么**？——type（access type）、key（实际用的索引）、rows（扫描行数）、Extra。
