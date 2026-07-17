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

## 苏格拉底式面试追问

> 这组追问不是背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：评价表你建了 `(product_id, create_time)` 联合索引而不是单列 `product_id`，为什么不省那点空间直接建单列？**

拼多多评价页的核心查询是 `WHERE product_id = ? ORDER BY create_time DESC LIMIT 10`。如果只有单列 `product_id` 索引，MySQL 走索引找到该商品所有评价的 id（可能几万条），回表取 `create_time`，再在内存排序（filesort），取 Top 10——商品评价多时 filesort 慢。联合索引 `(product_id, create_time)` 让索引本身就是按 `create_time` 有序的（B+ 树叶子链表），MySQL 直接从 `product_id` 对应的叶子段倒序取前 10 个 id 回表，零排序。省的不是"空间"，是"排序 + 大量回表"。

### 第二层：证据与定位

**Q：线上评价列表查询偶发慢（P99 从 20ms 涨到 800ms），你怎么确认是索引退化还是别的？**

用 EXPLAIN + 慢查询日志交叉验证：
1. 慢查询日志（`slow_query_log=ON, long_query_time=0.05`）——grep 出这条查询，看扫描行数 `Rows_examined`，如果从几十涨到几万，说明索引没生效走了全表或大范围扫。
2. EXPLAIN 这条 SQL——看 `type` 是 `ref`（索引命中）还是 `ALL`（全表）；`key` 是 `idx_pid_time` 还是 NULL；`Extra` 有没有 `Using filesort`（排序）或 `Using temporary`（临时表）。
3. 看是否是"参数变化导致索引失效"——比如某个查询传了 `product_id + 0 = 100`（隐式类型转换）或 `WHERE product_id = '100'`（字符串），这会让索引失效。

### 第三层：根因深挖

**Q：EXPLAIN 显示 `type=ref, key=idx_pid_time` 索引命中了，但 `rows=50000`（扫描 5 万行），为什么命中索引还扫这么多？**

索引命中≠扫描少。"命中"只代表 MySQL 用了这个索引定位，但具体扫多少叶子取决于过滤条件的选择性。根因深挖：
1. 这个商品是爆款——有 5 万条评价，索引 `product_id=100` 定位到这段叶子，确实就是 5 万条，索引没错，是数据量大。
2. 查询没加 `status` 过滤——这 5 万条里包含待审/下架的，业务只要 `status=1` 的，如果索引没把 `status` 纳入，就要扫 5 万行回表过滤。
3. 深翻页——`LIMIT 100000, 10` 即使有索引，也要先扫前 100010 行。
根治：建 `(product_id, status, create_time)` 三列索引（status 等值在前，create_time 范围/排序在后），让有效评价段直接定位；深翻页改游标分页（`WHERE create_time < ? ORDER BY create_time DESC LIMIT 10`）。

### 第四层：方案权衡

**Q：你为了优化查询给评价表加了 5 个索引，DBA 说写入会变慢。你怎么权衡加索引的收益和代价？**

每个二级索引都要在写入（INSERT/UPDATE/DELETE）时同步维护 B+ 树，索引越多写入越慢。量化权衡：
1. 算写入代价——评价表日均写入假设 100 万条，每加一个索引，单条 INSERT 多 1-2 次 B+ 树页修改（可能触发页分裂）。5 个索引意味着每条写入 5-10 次额外页操作，写入 P99 从 5ms 涨到 20ms。
2. 算查询收益——用 `pt-index-usage` 或 `sys.schema_unused_indexes` 看每个索引的使用频率。如果某个索引一周查询 <100 次但每天写入 100 万次，删掉。
3. 合并索引——`(product_id, create_time)` 和 `(product_id, status)` 可以合并成 `(product_id, status, create_time)`，一个索引服务多个查询。
4. 拆表——把"写入重"的字段（审核状态、操作人）和"查询重"的字段（内容、评分）垂直拆表，减少单表索引数。

### 第五层：验证与沉淀

**Q：你把评价翻页从 LIMIT offset 改成游标分页，怎么验证改对了没漏数据、没重复？**

游标分页的坑是"边界数据变动"——翻页期间有新评价上架，create_time 会插入到游标位置。验证：
1. 数据完整性——压测造 10 万条评价，用两种分页方式各翻完，对比拿到的 id 集合是否相等（顺序可不同，集合必相等）。
2. 重复检测——翻页过程中模拟插入新数据，看是否会因为 create_time 相同（毫秒级冲突）导致同一条出现在两页。解决：游标用 `(create_time, id)` 复合比较，`WHERE create_time < ? OR (create_time = ? AND id < ?)`。
3. 性能——EXPLAIN 新查询，`rows` 应稳定在 10-20（LIMIT 大小 + 少量过滤），不随页数增长。
沉淀：禁止 `LIMIT offset`（offset >10000 走游标或 ES）；索引设计规范——联合索引遵循"等值-范围-排序"顺序；上线前 EXPLAIN 走查列入 review checklist。

## 结构化回答




**30 秒电梯演讲：** 索引像字典目录——B+ 树是目录的目录（多叉树），叶子串成链表方便翻页。

**展开框架：**
1. **B+ 树** — 非叶存索引，叶子存数据+链表
2. **联合索引** — (a,b,c) 最左前缀
3. **覆盖索引** — 查询字段全在索引

**收尾：** 为什么用 B+ 树不用 B 树/红黑树？




## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：MySQL 索引与评价查询优化？ | 今天聊「MySQL 索引与评价查询优化？」。一句话：MySQL 索引用 B+ 树（多叉+叶子链表）让范围查询 O(log N)；内容场景如评价按 (商品ID,创建时间) … | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：B+ 树：非叶索引+叶子数据+链表 | 核心概念 |
| 1:04 | 能力/参数拆解表 | 要点是：联合索引最左前缀 | 能力拆解 |
| 1:56 | 流程图：输入→处理→输出 | 要点是：覆盖索引不回表 | 关键机制 |
| 3:00 | 总结卡 + 下期预告 | 记住这些核心点就够了。下期我们接着聊——为什么用 B+ 树不用 B 树/红黑树？。 | 收尾 |
