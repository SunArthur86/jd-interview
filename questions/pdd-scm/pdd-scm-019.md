---
id: pdd-scm-019
difficulty: L3
category: pdd-scm
subcategory: 商品
tags:
- 拼多多
- 供应链
- 商品
- SPU
- SKU
- 类目
feynman:
  essence: 商品模型分 SPU（标准产品单元，同款）和 SKU（库存单元，具体规格），通过类目+属性描述；拼多多千万级商品靠"类目树+属性模板+SPU/SKU"管理。
  analogy: SPU 是"iPhone 15"（抽象商品），SKU 是"iPhone 15 256G 黑色"（可售卖规格）；类目是"手机数码"（分类树），属性是"颜色/内存"（规格维度）。
  first_principle: 商品本质是"是什么（SPU）+ 卖什么（SKU）"，用类目和属性结构化描述，支持千万级管理。
  key_points:
  - SPU：标准产品单元（iPhone 15），同款共享属性
  - SKU：库存单元（iPhone 15 256G 黑），最小售卖单位
  - 类目树：三级（一级手机→二级智能手机→三级苹果）
  - 属性：关键属性（品牌）+ 销售属性（颜色/内存）+ 普通属性
first_principle:
  problem: 千万级商品如何结构化管理、搜索、售卖？
  axioms:
  - 商品有抽象层级（同款 vs 具体规格）
  - 需要分类（类目）和规格（属性）
  - 最小售卖单位要独立（SKU）
  rebuild: SPU（同款）+ SKU（具体规格）+ 类目树（分类）+ 属性模板（规格）。
follow_up:
- 一个 SPU 多少 SKU？——取决于销售属性组合（2 颜色 × 3 内存 = 6 SKU）
- 拼多多百亿补贴怎么建模？——商品+营销活动独立，活动挂载到 SKU
- 商品上下架怎么做？——SKU 级别状态机（上架/下架/售罄）
memory_points:
- SPU=同款抽象，SKU=具体规格，最小售卖单位
- 类目树（三级）+ 属性模板（关键/销售/普通）
- 销售属性笛卡尔积生成 SKU
- 商品和价格/库存/营销解耦
---

# 【拼多多供应链】商品 SPU/SKU 怎么建模？千万级商品怎么管？

> JD 依据："商品货品领域的研发工作"。

## 一、SPU vs SKU

```
SPU（Standard Product Unit）：标准产品单元
  - "iPhone 15"（同款，抽象）
  - 共享基础属性（品牌=苹果，类目=手机）

SKU（Stock Keeping Unit）：库存单元
  - "iPhone 15 256G 黑色"（具体规格，可售卖）
  - 最小售卖/库存单位
```

**关系**：一个 SPU 对应多个 SKU（销售属性笛卡尔积）。

```
SPU: iPhone 15
销售属性: 颜色(黑/白) × 内存(128G/256G)
  → 4 个 SKU:
    SKU1: 黑+128G
    SKU2: 黑+256G
    SKU3: 白+128G
    SKU4: 白+256G
```

## 二、类目树 + 属性模板

```
类目树（三级）:
  一级: 手机数码
    └ 二级: 手机
        └ 三级: 智能手机

属性模板（每个类目绑定）:
  关键属性: 品牌（必填）、型号
  销售属性: 颜色、内存、版本
  普通属性: 重量、屏幕尺寸
```

## 三、数据库设计

```sql
-- SPU 表
CREATE TABLE spu (
    id BIGINT PRIMARY KEY,
    name VARCHAR,
    category_id BIGINT,           -- 三级类目
    brand_id BIGINT,
    status TINYINT                -- 上架/下架
);

-- SKU 表
CREATE TABLE sku (
    id BIGINT PRIMARY KEY,
    spu_id BIGINT,
    price DECIMAL,
    stock BIGINT,
    attributes JSON               -- {"颜色":"黑","内存":"256G"}
);

-- 类目表（树形，邻接表）
CREATE TABLE category (
    id BIGINT PRIMARY KEY,
    parent_id BIGINT,
    name VARCHAR,
    level TINYINT                 -- 1/2/3
);
```

## 四、拼多多特色

**百亿补贴**：营销活动独立，挂载到 SKU（`activity_sku` 关联表）。
**拼团**：拼团价挂 SKU（多人成团特殊价）。
**千人千面**：商品 + 用户画像 + 实验平台决定展示价。

## 五、商品上下架状态机

```
新建 → 待审核 → 上架 → 售罄/下架
                  ↓
               违规下架
```

SKU 级别状态（某规格下架不影响其他规格）。

## 六、底层本质

商品建模是**"用抽象层级管理规模"**：
- SPU 让同款共享信息（改一处全 SKU 生效）
- SKU 让独立售卖/库存（不同规格不同价）
- 类目让结构化分类（搜索/筛选）
- 属性让规格描述（对比/筛选）

## 常见考点
1. **SPU 和 SKU 谁决定价格**？——SKU（不同规格不同价）。
2. **属性怎么存**？——关键属性入表（索引）；销售属性 JSON（灵活）；属性模板按类目绑定。
3. **商品搜索怎么建索引**？——ES（title 分词 + 属性过滤 + 销量排序）。

## 苏格拉底式面试追问

> 这组追问不是背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：拼多多千万级商品，你把销售属性（颜色/内存）存在 SKU 的 JSON 字段里，而不是建独立的 `sku_attribute` 关系表（sku_id + attr_name + attr_value）。为什么？**

因为查询模式不同。商品详情页是"给一个 sku_id 查所有属性"，JSON 字段一次查询取出，O(1)。如果用关系表，要 JOIN 三张表（sku + sku_attr + attribute），千万级数据 JOIN 慢。JSON 的代价是"按属性反查 SKU"难（如"查所有黑色 iPhone"），但这个需求走 ES（属性作为 filter 字段），不走 MySQL。所以 MySQL 用 JSON 存（适合"按 sku 查属性"），ES 存结构化属性（适合"按属性查 sku"），各司其职。关系表适合"属性维度独立查询 + 统计"（如"统计各颜色销量"），但拼多多这种走 ES 聚合更快。

### 第二层：证据与定位

**Q：运营反馈某商品的 SKU 少了（本来 4 个规格，现在只剩 2 个）。你怎么定位是数据被删了、状态机改了，还是缓存没刷新？**

三段排查：
1. **看 MySQL**——`SELECT * FROM sku WHERE spu_id=? AND status='ACTIVE'`，确认 DB 里的 SKU 数量。如果 DB 有 4 个但前端只显示 2 个，是缓存或查询逻辑问题；如果 DB 只有 2 个，是数据被删或状态被改。
2. **看操作日志**——`SELECT * FROM sku_op_log WHERE spu_id=? ORDER BY create_time DESC`，查谁在什么时候改了 status 或删了 SKU。拼多多所有商品变更有操作日志（操作人 + 时间 + 变更前后值），定位到具体操作。
3. **看缓存**——`GET product:sku:list:{spu_id}`，如果 Redis 里是 2 个但 DB 是 4 个，是缓存没刷新（Canal 延迟或 Cache Aside 漏删）。

### 第三层：根因深挖

**Q：DB 里 SKU 确实只剩 2 个（另外 2 个 status 从 ACTIVE 变成 DELETED）。操作日志显示是某次批量下架操作。但运营说没主动下架，根因是什么？**

根因大概率是"批量操作的误触发"。几种可能：
1. **批量下架脚本 bug**——运营下架某类目下"违规商品"时，SQL 写成 `UPDATE sku SET status='DELETED' WHERE spu_id IN (违规SPU列表)`，但 SPU 列表传错（包含了正常 SPU），误删。看脚本的执行参数和 SQL。
2. **状态机非法跳转**——SKU 状态应该是 ACTIVE→INACTIVE（下架）→DELETED（删除），如果代码直接 ACTIVE→DELETED（跳过 INACTIVE），可能是某处逻辑直接硬改 status，绕过状态机。查代码里所有 `setStus(DELETED)` 的调用点。
3. **供应商删除**——如果是供应商入驻商品，供应商取消授权时级联删除 SKU。查供应商操作的 audit log。
定位：看操作日志的"操作人"，如果是"system"（定时任务/脚本），是自动流程的 bug；如果是具体运营账号，是误操作。

**Q：那为什么不禁止物理删除 SKU（只允许逻辑下架），彻底避免误删？**

逻辑下架（status=INACTIVE）是正解，物理删除（DELETE FROM sku）是反模式：
1. **历史订单依赖**——已下单的 SKU 如果被物理删除，历史订单的"商品快照"失去外键引用，订单详情页显示不了商品信息。逻辑下架保留记录，历史订单可查。
2. **数据恢复难**——物理删除后恢复要从 binlog 解析（`mysqlbinlog`），复杂且可能丢；逻辑下架改回 status 即可。
3. **对账需求**——结算对账要追溯"这个 SKU 历史上卖了多少"，物理删除后无从追溯。
所以 SKU 只能逻辑下架（status=INACTIVE 或 DELETED，但记录保留），物理删除必须禁止。Code Review 规则：禁止 `DELETE FROM sku`，只能 `UPDATE status`。

### 第四层：方案权衡

**Q：SKU 的 attributes 用 JSON 存，但运营要按属性筛选商品（"找所有 256G 内存的手机"）。MySQL JSON 查询慢，怎么办？**

MySQL 和 ES 分工：
1. **MySQL JSON 适合"按 sku_id 取详情"**——`SELECT attributes->>'$.memory' FROM sku WHERE id=1`，单条查询快（有主键索引），适合商品详情页。
2. **ES 适合"按属性反查"**——把 SKU 的 attributes 拆成 ES 的字段（`memory: 256G` 作为 keyword），筛选时 `filter: {term: {memory: "256G"}}`，ES 倒排索引毫秒级。Canal 监听 SKU 表变更同步到 ES，保证一致。
3. **千万别用 MySQL JSON 函数筛选**——`SELECT * FROM sku WHERE attributes->>'$.memory'='256G'`，千万级数据全表扫，秒级超时。
所以策略：写入 MySQL（JSON）+ Canal 同步 ES（结构化字段），查询按场景路由（详情走 MySQL，筛选走 ES）。

**Q：为什么不直接用 MongoDB 存 SKU 属性，它原生支持灵活文档结构和属性索引？**

MongoDB 适合"属性 schema 频繁变 + 文档查询"场景，但供应链用 MySQL + ES 更优：
1. **事务需求**——SKU 的上下架、库存扣减要和订单/库存事务（MySQL ACID），MongoDB 的事务（4.0+ 多文档事务）性能不如 MySQL。
2. **生态**——MySQL 的运维工具（备份、监控、DBA 经验）成熟，MongoDB 在电商供应链的生态不如 MySQL。
3. **ES 已满足搜索**——属性筛选和搜索走 ES 就够，MongoDB 的文档查询优势用不上。
所以 MySQL（主存储，事务）+ ES（搜索，筛选）是电商标配，MongoDB 适合"日志/内容"场景（如商品评价的富文本），不是 SKU 主数据。

### 第五层：验证与沉淀

**Q：你怎么证明 SPU/SKU 建模正确、千万级商品的数据一致性没问题？**

对账验证：
1. **SPU-SKU 一致性**——每天跑 `SELECT s.id, COUNT(sku.id) FROM spu s LEFT JOIN sku sku ON sku.spu_id=s.id GROUP BY s.id HAVING COUNT(sku.id)=0`，找出"有 SPU 但没有 SKU"的脏数据（正常 SPU 至少有 1 个 SKU），人工修复。
2. **类目树完整性**——遍历类目树，检查每个三级类目是否绑定了属性模板，每个 SPU 的 category_id 是否有效（类目没被删）。
3. **价格一致性**——`SELECT sku.price FROM sku` vs ES 里的 `price` 字段，Canal 同步有延迟但不应该长期不一致，差值 > 0.01% 告警。

**Q：怎么让团队的商品数据操作规范（不误删、不脏数据）？**

沉淀规范：
1. **商品操作 SDK**——封装 `ProductService.update/delete/online/offline`，禁止业务方裸写 SQL 改 SKU 表，SDK 内置状态机校验（非法跳转抛异常）+ 操作日志记录。
2. **Code Review 规则**——禁止 `DELETE FROM spu/sku`（物理删除），所有状态变走 SDK 的状态机方法；批量操作必须 review SQL 的 WHERE 条件（防全表）。
3. **审批流**——批量下架/删除操作走审批流（运营提交→主管审批→执行），防止单人误操作。关键操作（如改价）双人复核。

## 结构化回答

**30 秒电梯演讲：** 千万级商品如何结构化管理、搜索、售卖？简单说就是——商品模型分 SPU（标准产品单元，同款）和 SKU（库存单元，具体规格），通过类目+属性描述；拼多多千万级商品靠"类目树+属性模板+SPU/SKU"管理。

**展开框架：**
1. **SPU** — SPU：标准产品单元（iPhone 15），同款共享属性
2. **SKU** — SKU：库存单元（iPhone 15 256G 黑），最小售卖单位
3. **类目树** — 类目树：三级（一级手机→二级智能手机→三级苹果）

**收尾：** 您看这块要不要再展开聊聊？

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：商品 SPU/SKU 怎么建模？千万级商品怎么管？ | 今天聊「商品 SPU/SKU 怎么建模？千万级商品怎么管？」。一句话：商品模型分 SPU（标准产品单元，同款）和 SKU（库存单元 | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：SPU：标准产品单元（iPhone 15），同款共享属性 | 核心概念 |
| 1:04 | 能力/参数拆解表 | 要点是：SKU：库存单元（iPhone 15 256G 黑），最小售卖单位 | 能力拆解 |
| 1:56 | 流程图：输入→处理→输出 | 要点是：类目树：三级（一级手机→二级智能手机→三级苹果） | 关键机制 |
| 3:00 | 总结卡 + 下期预告 | 记住核心要点就够了。下期见。 | 收尾 |
