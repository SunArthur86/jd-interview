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
