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

## 苏格拉底式面试追问

> 这组追问不是背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：供应链商品列表查询慢，你想加索引。但商品表 1 亿行、已经有 8 个索引了，再加索引你要权衡什么？**

加索引不是免费的，要权衡三点：
1. **写放大**——商品价格/库存频繁更新，每加一个索引，UPDATE 都要多维护一棵 B+ 树。8 个索引意味着一次 UPDATE 写 9 次（1 主键 + 8 二级），大促时写入 QPS 会被拖垮。
2. **索引冗余**——如果已有 `(category_id, sales)` 联合索引，再加 `(category_id)` 单列索引就是冗余（最左前缀已覆盖），白占空间。
3. **空间成本**——1 亿行 × 一个索引约 2-4GB，SSD 成本和 buffer pool 命中率都会受影响。所以要先确认这个慢查询是不是高频，低频查询宁可走 ES 不在 MySQL 加索引。

### 第二层：证据与定位

**Q：运营反馈商品列表翻页越来越慢，第二页就超时。你怎么确认是索引没命中还是别的？**

用 EXPLAIN + 慢查询日志交叉定位：
1. **EXPLAIN 看访问路径**——`EXPLAIN SELECT * FROM product WHERE category_id=100 ORDER BY sales DESC LIMIT 10,10;`，重点看：
   - `type=ALL` → 全表扫，索引没命中。
   - `key=NULL` → 压根没用索引。
   - `rows` 如果是 1 亿 → 扫了全表。
   - `Extra=Using filesort` → 没用索引的有序性，内存里重排。
2. **慢查询日志**——开 `slow_query_log=ON`、`long_query_time=0.5`，看这条 SQL 的 `Rows_examined`，如果等于全表行数说明索引失效。
3. **重点看 ORDER BY**——如果 `WHERE category_id=100` 命中了但 `ORDER BY sales` 走 filesort，说明缺 `(category_id, sales)` 联合索引，`category_id` 单列索引救不了排序。

### 第三层：根因深挖

**Q：EXPLAIN 显示 type=ALL 全表扫，但你确认有 (category_id, sales) 联合索引。为什么没命中？**

根因大概率是 SQL 写法破坏了索引。三种常见坑：
1. **隐式类型转换**——`category_id` 是 `int`，但 SQL 写成 `WHERE category_id='100'`（字符串），MySQL 给列加了 `CAST()` 函数，索引失效。看 EXPLAIN 的 `key=NULL` 基本就是这问题。
2. **函数操作列**——`WHERE DATE(created_at)='2026-07-07'`，对列套函数，B+ 树没法用。要改成 `WHERE created_at >= '2026-07-07' AND created_at < '2026-07-08'`。
3. **OR 条件**——`WHERE category_id=100 OR status=1`，如果 `status` 没索引，整个查询放弃索引走全表。拆成 `UNION` 两段分别走索引。
定位根因：把 SQL 里所有条件逐个去掉跑 EXPLAIN，去掉哪个后 `type` 从 ALL 变 ref，哪个就是元凶。

**Q：那为什么不能用 FORCE INDEX 强制走 (category_id, sales) 索引？**

`FORCE INDEX` 能临时解决，但是反模式：
1. **数据分布变化后失效**——今天 category_id=100 有 10 万行，索引高效；明天某个类目涨到 5000 万行，强制走索引可能比全表扫还慢（回表次数爆炸），MySQL 的优化器判断反而更准。
2. **掩盖根因**——真正的问题是 SQL 写法（类型转换/函数），强制索引治标不治本，换个查询条件又失效。
3. **维护负担**——FORCE INDEX 写死在 SQL 里，DBA 调索引时要改代码。正确做法是修复 SQL 写法（去掉函数/类型转换），让优化器自然选择。

### 第四层：方案权衡

**Q：深分页 LIMIT 1000000,10 你用游标分页优化了。但运营要在后台"跳转到第 10 万页"，游标分页做不到随机跳页，怎么办？**

随机跳页和性能是矛盾的。三种方案权衡：
1. **游标分页（推荐）**——`WHERE sales < last_sales ORDER BY sales DESC LIMIT 10`，只能"下一页"不能跳页，但 O(10) 超快。适合 C 端用户连续浏览。
2. **子查询 + 主键 join**——`SELECT * FROM product t, (SELECT id FROM product WHERE category_id=100 ORDER BY sales LIMIT 1000000,10) tmp WHERE t.id=tmp.id`。子查询走覆盖索引（只扫 id 不回表），再 join 取全行。能把 10 秒降到 1 秒，适合后台随机跳页。
3. **限制最大页数**——产品层面，后台列表最多翻 1000 页（LIMIT 1000*10=10000），超过的让运营用搜索条件（按 SKU/名称）精确查。拼多多运营后台就是这么做，"跳转到第 10 万页"本身就是伪需求。

**Q：为什么不直接加 ES 做商品列表查询，彻底绕开 MySQL 深分页？**

ES 适合"多条件筛选 + 全文搜索"（按类目+价格区间+关键词），但纯"按类目+销量排序分页"用 MySQL 联合索引更快——ES 的深分页（`from + size`）同样有性能问题（`from=1000000` 会触发 cluster 级协调，默认 max_result_window=10000）。而且 ES 数据要同步（Canal→ES），有一致性窗口。所以策略是：C 端搜索走 ES（复杂筛选），后台简单列表走 MySQL（联合索引 + 游标），各取所长。不盲目 ES 化。

### 第五层：验证与沉淀

**Q：你加了 (category_id, sales) 索引，怎么证明查询真的快了、没有引入新的写放大问题？**

两组指标对比验证：
1. **读性能**——EXPLAIN 前后对比：`type` 从 ALL→ref、`rows` 从 1 亿→10、`Extra` 从 Using filesort→Using index。APM 里这条 SQL 的平均耗时从 8 秒降到 5ms，慢查询计数（`slow_query_count`）归零。
2. **写性能**——监控 `mysql_com_update` 耗时 P99，加索引前后对比。如果 UPDATE 从 2ms 涨到 5ms（多维护一棵索引树），且大促写入 QPS 够用，可接受；如果写入 QPS 掉了 30%，说明索引拖累严重，要么砍掉低频索引，要么把写入分库。

**Q：怎么让团队避免线上慢 SQL 上线？**

三道闸门：
1. **SQL 审核平台**——DBA 用 Yearning/Archery，所有上线 SQL 必须 EXPLAIN 通过（type≤range、rows<10000、无 filesort）才能执行。
2. **慢查询告警**——`pt-query-digest` 每小时扫慢查询日志，新增慢 SQL 自动飞书告警 + 指派负责人。
3. **压测卡点**——新 SQL 必须在压测环境跑 EXPLAIN，`rows` 超阈值的强制要求优化或走 ES，不优化不让上线。

## 结构化回答

**30 秒电梯演讲：** 亿级数据下单次查询如何用最少磁盘 IO 完成？简单说就是——MySQL InnoDB 索引是 B+ 树，聚簇索引叶子存整行、二级索引叶子存主键需回表；优化靠"最左前缀匹配 + 覆盖索引避免回表 + EXPLAIN 看 type/key_l…。

**展开框架：**
1. **聚簇索引主键** — 聚簇索引（主键，叶子存整行）vs 二级索引（叶子存主键，需回表）
2. **最左前缀** — 最左前缀：联合索引 (a,b,c) 能用 a / a,b / a,b,c，不能跳过 b 用 c
3. **覆盖索引** — 覆盖索引：查询字段都在索引里，免回表（Extra: Using index）

**收尾：** 您看这块要不要再展开聊聊？

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：MySQL 索引怎么优化？EXPLAIN 怎么看？ | 今天聊「MySQL 索引怎么优化？EXPLAIN 怎么看？」。一句话：MySQL InnoDB 索引是 B+ 树，聚簇索引叶子存整行、二级索引叶子存主键需回表；优化靠"最左前缀匹配 + 覆… | 开场钩子 |
| 0:12 | 对比表：左右两栏差异 | 要点是：聚簇索引（主键，叶子存整行）vs 二级索引（叶子存主键，需回表） | 核心概念 |
| 1:04 | 能力/参数拆解表 | 要点是：最左前缀：联合索引 (a,b,c) 能用 a / a,b / a,b,c，不能跳过 b 用 c | 能力拆解 |
| 1:56 | 流程图：输入→处理→输出 | 要点是：覆盖索引：查询字段都在索引里，免回表（Extra: Using index） | 关键机制 |
| 3:00 | 总结卡 + 下期预告 | 记住核心要点就够了。下期见。 | 收尾 |
