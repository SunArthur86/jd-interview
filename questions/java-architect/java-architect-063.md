---
id: java-architect-063
difficulty: L3
category: java-architect
subcategory: 商品
tags:
- Java 架构师
- 商品中心
- SPU/SKU
- 类目属性
- 扩展性
feynman:
  essence: 商品中心是电商的"数据基座"——所有业务（搜索/推荐/下单/库存/价格）都依赖商品数据。核心挑战是"商品形态多样（手机有内存属性、服装有尺码、生鲜有保质期）vs 系统要统一模型"。解法是"SPU/SKU 两级模型 + 类目属性模板 + 扩展字段"——SPU 是标准化产品单元（iPhone 15），SKU 是最小存货单元（iPhone 15 128G 黑色），属性按类目配置（手机类目有"内存"属性，服装类目有"尺码"）。
  analogy: 像图书馆编目。书是 SPU（《三体》），但每本书有不同版本（精装/平装/签名版）是 SKU。书的不同类目有不同的编目字段——小说有"题材"，教科书有"年级"。图书馆不能为每个类目建一张表（无穷无尽），而是"统一书表 + 类目属性模板"——书的核心字段（书名/作者/ISBN）统一，类目特有字段（小说的题材、教科书的年级）用属性模板扩展。商品中心一样。
  first_principle: 为什么商品不能只用一张表（id/name/price）？因为不同类目的商品属性差异巨大——手机要存内存/CPU/屏幕，服装要存尺码/面料，生鲜要存保质期/产地。单表要么字段爆炸（几百列，大部分空），要么丢失属性（无法存类目特有）。解法是"核心字段统一 + 类目属性动态扩展"——SPU/SKU 表存核心字段（名称/价格/品牌），属性表存类目特有（按类目模板配置）。
  key_points:
  - SPU（标准化产品单元）：iPhone 15，同类商品聚合
  - SKU（最小存货单元）：iPhone 15 128G 黑色，可售卖可库存的最小单位
  - 类目属性模板：每个类目有一组属性（手机有内存/CPU，服装有尺码/面料）
  - 属性扩展：属性表（attribute_id + entity_id + value），动态扩展不修表结构
  - 规格属性 vs 参数属性：规格（内存/颜色）生成 SKU，参数（重量/产地）只展示不生成 SKU
first_principle:
  problem: 亿级商品、千万级类目属性，怎么建模既能统一管理又支持类目差异化？
  axioms:
  - 商品形态多样（每个类目属性不同），单表建模不可行
  - 属性可扩展（运营随时加新属性），不能改表结构（DDL 影响大）
  - SPU 聚合同类（iPhone 15 是一个 SPU），SKU 区分可售（不同配置是不同 SKU）
  - 搜索/筛选依赖属性索引（按内存/价格筛选）
  rebuild: SPU/SKU 两级 + 类目属性模板 + 属性表扩展。SPU 存核心（名称/品牌/类目），SKU 存可售单元（规格+价格+库存）。类目属性模板定义每个类目有哪些属性（动态配置）。属性表存具体值（entity_id + attribute_id + value），EAV 模型（Entity-Attribute-Value）支持无限扩展。规格属性参与 SKU 生成，参数属性仅展示。属性建索引（ES）支持筛选。
follow_up:
  - 属性值怎么存（字符串/数字/多选）？——属性定义数据类型（TEXT/NUMBER/ENUM/MULTI），属性值按类型存储+校验。
  - 类目迁移（商品换类目）属性怎么办？——新旧类目属性不同，需属性映射或清理旧属性补新属性。
  - 多语言商品（中英文）怎么存？——属性值按语言存（value + lang），或主从语言翻译。
  - 商品快照（下单时锁定商品信息）怎么做？——订单存商品快照 JSON（防商品修改影响历史订单）。
  - 亿级商品查询性能？——核心字段 MySQL，属性 ES（支持复杂筛选），详情缓存 Redis。
memory_points:
  - SPU 聚合同类，SKU 最小可售
  - 类目属性模板（动态配置）
  - EAV 模型（Entity-Attribute-Value）扩展属性
  - 规格属性生成 SKU，参数属性仅展示
  - MySQL 核心 + ES 属性 + Redis 缓存
---

# 【Java 后端架构师】商品中心模型、类目属性与扩展性

> 适用场景：JD 商品基座。京东亿级商品，从手机（内存/CPU/屏幕）到服装（尺码/面料）到生鲜（保质期/产地），属性差异巨大。商品中心要统一管理这些商品，同时支持类目差异化、属性可扩展、搜索可筛选。核心是"SPU/SKU 两级模型 + 类目属性模板 + EAV 扩展"。

## 一、概念层：SPU/SKU 模型

**SPU vs SKU**（核心区分）：

```
SPU（Standard Product Unit，标准化产品单元）
  ├─ iPhone 15（一个 SPU）
  ├─ 核心字段：name/brand/category
  └─ 聚合同类商品（不同配置都是 iPhone 15）

SKU（Stock Keeping Unit，最小存货单元）
  ├─ iPhone 15 128G 黑色（一个 SKU）
  ├─ iPhone 15 128G 白色（另一个 SKU）
  ├─ iPhone 15 256G 黑色（又一个 SKU）
  └─ 可售卖、可库存的最小单位

关系：一个 SPU 有多个 SKU（按规格组合）
       iPhone 15 (SPU)
          │
      ┌───┴───┬───────┬───────┐
   128G黑  128G白  256G黑  256G白   ← 4 个 SKU
   (SKU)  (SKU)  (SKU)  (SKU)
```

**数据模型**（三张核心表）：

```sql
-- SPU 表：商品核心信息
CREATE TABLE t_spu (
    id BIGINT PRIMARY KEY,
    name VARCHAR(256),           -- 商品名（iPhone 15）
    brand_id BIGINT,             -- 品牌
    category_id BIGINT,          -- 类目（手机）
    status TINYINT,              -- 状态（上架/下架）
    created_at DATETIME,
    KEY idx_category (category_id),
    KEY idx_brand (brand_id)
);

-- SKU 表：可售单元（规格组合）
CREATE TABLE t_sku (
    id BIGINT PRIMARY KEY,
    spu_id BIGINT,               -- 所属 SPU
    sku_code VARCHAR(64),        -- SKU 编码（唯一）
    spec_json JSON,              -- 规格组合（{"内存":"128G","颜色":"黑"}）
    price DECIMAL(10,2),         -- 价格
    stock INT,                   -- 库存
    KEY idx_spu (spu_id)
);

-- 属性表（EAV 模型）：动态扩展属性
CREATE TABLE t_product_attribute (
    id BIGINT PRIMARY KEY,
    entity_type VARCHAR(16),     -- 实体类型（SPU/SKU）
    entity_id BIGINT,            -- 实体 ID
    attribute_id BIGINT,         -- 属性 ID（外键属性定义表）
    attribute_value TEXT,        -- 属性值
    KEY idx_entity (entity_type, entity_id),
    KEY idx_attribute (attribute_id, attribute_value)
);

-- 属性定义表：每个类目有哪些属性
CREATE TABLE t_attribute_def (
    id BIGINT PRIMARY KEY,
    category_id BIGINT,          -- 所属类目
    name VARCHAR(64),            -- 属性名（内存/颜色/尺码）
    data_type VARCHAR(16),       -- 类型（TEXT/NUMBER/ENUM/MULTI）
    is_spec BOOLEAN,             -- 是否规格属性（参与 SKU 生成）
    is_searchable BOOLEAN,       -- 是否可搜索（建 ES 索引）
    options_json JSON,           -- 枚举选项（颜色：黑/白/金）
    sort_order INT
);
```

**规格属性 vs 参数属性**：

```
手机类目属性：
┌────────────────────────────────────────────────┐
│ 规格属性（is_spec=true，参与 SKU 生成）         │
│   内存：128G / 256G / 512G                      │
│   颜色：黑 / 白 / 金                             │
│   → 3 内存 × 3 颜色 = 9 个 SKU                 │
├────────────────────────────────────────────────┤
│ 参数属性（is_spec=false，仅展示，不生成 SKU）    │
│   CPU：A17                                      │
│   屏幕：6.1寸                                   │
│   重量：174g                                    │
│   产地：中国                                     │
│   → 展示在详情页，不影响 SKU                    │
└────────────────────────────────────────────────┘
```

## 二、机制层：商品创建与 SKU 生成

**商品领域模型（DDD 充血）**：

```java
/**
 * SPU 聚合根
 */
public class Spu {
    private Long id;
    private String name;
    private Long brandId;
    private Long categoryId;
    private List<Attribute> attributes;     // 参数属性
    private List<Sku> skus;                 // 规格组合生成的 SKU
    private SpuStatus status;

    /**
     * 创建 SKU：根据规格属性笛卡尔积
     */
    public void generateSkus(List<SpecAttribute> specs) {
        // 笛卡尔积：内存(128G,256G) × 颜色(黑,白) = 4 个 SKU
        List<Map<String, String>> combinations = cartesianProduct(specs);

        this.skus = combinations.stream()
            .map(spec -> new Sku(this.id, spec, calculatePrice(spec)))
            .collect(Collectors.toList());
    }

    /**
     * 上架：校验完整性
     */
    public void publish() {
        // 校验：必须有至少一个 SKU
        if (skus.isEmpty()) {
            throw new SpuPublishException("SPU 必须有 SKU");
        }
        // 校验：必须有标题/图片/价格
        validateRequired();
        this.status = SpuStatus.PUBLISHED;
    }
}

/**
 * SKU 实体
 */
public class Sku {
    private Long id;
    private Long spuId;
    private Map<String, String> spec;    // 规格组合（内存:128G, 颜色:黑）
    private BigDecimal price;
    private int stock;

    /**
     * 扣库存
     */
    public void deductStock(int amount) {
        if (stock < amount) {
            throw new InsufficientStockException("库存不足");
        }
        this.stock -= amount;
    }
}
```

**商品创建服务**：

```java
@Service
public class ProductCreateService {

    @Autowired private SpuRepository spuRepo;
    @Autowired private AttributeRepository attrRepo;

    /**
     * 创建商品：SPU + 属性 + SKU
     */
    @Transactional
    public Long createProduct(ProductCreateRequest req) {
        // 1. 创建 SPU
        Spu spu = new Spu();
        spu.setName(req.getName());
        spu.setBrandId(req.getBrandId());
        spu.setCategoryId(req.getCategoryId());
        spuRepo.save(spu);

        // 2. 保存参数属性（非规格）
        for (AttributeRequest attr : req.getParams()) {
            Attribute attribute = new Attribute();
            attribute.setEntityType("SPU");
            attribute.setEntityId(spu.getId());
            attribute.setAttributeId(attr.getId());
            attribute.setValue(attr.getValue());
            attrRepo.save(attribute);
        }

        // 3. 生成 SKU（规格笛卡尔积）
        spu.generateSkus(req.getSpecs());
        skuRepo.saveAll(spu.getSkus());

        // 4. 同步到 ES（属性可搜索）
        esService.indexProduct(spu);

        // 5. 失效缓存
        redis.delete("category:products:" + spu.getCategoryId());

        return spu.getId();
    }
}
```

## 三、机制层：类目属性模板管理

**类目属性模板**：

```java
/**
 * 类目管理：配置每个类目的属性模板
 */
@Service
public class CategoryService {

    /**
     * 创建类目时配置属性模板
     */
    @Transactional
    public void createCategoryWithTemplate(CategoryCreateRequest req) {
        // 1. 创建类目
        Category category = new Category(req.getName(), req.getParentId());
        categoryRepo.save(category);

        // 2. 配置属性模板（手机类目有：内存/颜色/CPU/屏幕...）
        for (AttributeTemplate attr : req.getAttributes()) {
            AttributeDef def = new AttributeDef();
            def.setCategoryId(category.getId());
            def.setName(attr.getName());
            def.setDataType(attr.getDataType());       // TEXT/NUMBER/ENUM
            def.setIsSpec(attr.isSpec());              // 规格 or 参数
            def.setIsSearchable(attr.isSearchable());  // 是否可搜索
            def.setOptionsJson(JSON.toJSONString(attr.getOptions()));
            attributeDefRepo.save(def);
        }
    }

    /**
     * 查类目属性模板（商家发布商品时用）
     */
    public List<AttributeDef> getTemplate(Long categoryId) {
        return attributeDefRepo.findByCategoryId(categoryId);
    }

    /**
     * 新增属性（运营加新属性，不改表结构）
     */
    @Transactional
    public void addAttribute(Long categoryId, AttributeDef def) {
        def.setCategoryId(categoryId);
        attributeDefRepo.save(def);
        // 注意：不需要 ALTER TABLE，EAV 模型天然支持扩展
    }
}
```

**属性值类型校验**：

```java
/**
 * 属性值按类型校验和存储
 */
public class AttributeValidator {

    public void validate(AttributeDef def, String value) {
        switch (def.getDataType()) {
            case "NUMBER":
                if (!NumberUtils.isCreatable(value)) {
                    throw new AttributeValidateException("属性 " + def.getName() + " 必须是数字");
                }
                break;
            case "ENUM":
                List<String> options = JSON.parseArray(def.getOptionsJson(), String.class);
                if (!options.contains(value)) {
                    throw new AttributeValidateException("属性值不在选项内");
                }
                break;
            case "MULTI":
                // 多选，值是逗号分隔
                List<String> values = Arrays.asList(value.split(","));
                List<String> validOptions = JSON.parseArray(def.getOptionsJson(), String.class);
                for (String v : values) {
                    if (!validOptions.contains(v)) {
                        throw new AttributeValidateException("属性值 " + v + " 无效");
                    }
                }
                break;
        }
    }
}
```

## 四、机制层：搜索与筛选（ES 属性索引）

**商品同步到 ES**（支持按属性筛选）：

```java
@Service
public class ProductEsService {

    /**
     * 商品索引到 ES（扁平化属性，支持筛选）
     */
    public void indexProduct(Spu spu) {
        Map<String, Object> doc = new HashMap<>();
        doc.put("spuId", spu.getId());
        doc.put("name", spu.getName());
        doc.put("brandId", spu.getBrandId());
        doc.put("categoryId", spu.getCategoryId());

        // 扁平化属性（属性表 → ES 字段）
        List<Attribute> attrs = attrRepo.findByEntity("SPU", spu.getId());
        for (Attribute attr : attrs) {
            AttributeDef def = attrDefRepo.findById(attr.getAttributeId());
            doc.put("attr_" + def.getName(), attr.getValue());
        }

        // SKU 信息（价格区间）
        List<Sku> skus = skuRepo.findBySpuId(spu.getId());
        doc.put("priceMin", skus.stream().mapToDouble(s -> s.getPrice().doubleValue()).min());
        doc.put("priceMax", skus.stream().mapToDouble(s -> s.getPrice().doubleValue()).max());

        esClient.index("product", spu.getId().toString(), doc);
    }

    /**
     * 搜索：按属性筛选
     * 如：手机 AND 内存=256G AND 价格<8000
     */
    public SearchResult search(SearchQuery query) {
        BoolQueryBuilder bool = QueryBuilders.boolQuery();

        // 类目过滤
        bool.filter(QueryBuilders.termQuery("categoryId", query.getCategoryId()));

        // 属性筛选
        for (Map.Entry<String, String> filter : query.getAttrFilters().entrySet()) {
            bool.filter(QueryBuilders.termQuery("attr_" + filter.getKey(), filter.getValue()));
        }

        // 价格区间
        bool.filter(QueryBuilders.rangeQuery("priceMin")
            .lte(query.getMaxPrice()));

        SearchRequest request = SearchRequest.of(s -> s
            .index("product")
            .query(bool)
            .from(query.getFrom())
            .size(query.getSize()));

        return parseResult(esClient.search(request));
    }
}
```

## 五、底层本质：商品中心的本质是"统一模型 + 差异化扩展"

回到第一性：**商品中心的本质是"用统一模型管理亿级商品，同时支持类目差异化属性"**。

- **统一模型**：所有商品共享核心字段（SPU 的 name/brand/category，SKU 的 price/stock）。这是"共性抽象"——所有商品都有名字、价格、库存，这些是稳定的。统一模型让通用逻辑（搜索/下单/库存）可以跨类目复用。
- **差异化扩展**：每个类目有特有属性（手机的内存、服装的尺码）。EAV 模型（Entity-Attribute-Value）让属性动态扩展——加属性只加数据（INSERT），不改表结构（ALTER）。这是"个性扩展"——不同类目有不同属性，且随时可加。
- **规格 vs 参数分离**：规格属性（内存/颜色）参与 SKU 生成（决定可售单元），参数属性（CPU/产地）只展示。这分离了"影响库存的属性"和"不影响库存的属性"——SKU 是可售卖的最小单位，规格相同的商品共享库存，规格不同的独立库存。
- **搜索索引扁平化**：EAV 模型查询慢（JOIN 多表），搜索把属性扁平化到 ES（attr_内存=256G 直接做字段）。这是"读优化"——写入时 EAV（灵活），读取时扁平（快速筛选）。

**EAV 模型的本质是"列转行"**：传统表是"一行一个商品，每属性一列"（列爆炸），EAV 是"一行一个属性值"（entity_id + attribute_id + value）。列转行后，加属性只是加数据行（INSERT），不需要加列（ALTER TABLE）。代价是查询要 JOIN（一个商品多个属性行），但 ES 扁平化解决了查询性能。这是"写时灵活，读时优化"的设计哲学。

**SPU/SKU 两级的本质是"抽象层次"**：SPU 是"商品概念"（iPhone 15），SKU 是"具体可售物"（iPhone 15 128G 黑）。用户搜索看 SPU（iPhone 15），下单买 SKU（具体配置）。两级模型让"展示"（SPU 聚合）和"交易"（SKU 精确）分离——展示用 SPU（列表简洁），交易用 SKU（库存价格精确）。

## 六、AI 架构师加问：5 个

1. **AI 自动补全商品属性，怎么做？**
   AI 根据商品标题/图片/同类商品预测缺失属性——如标题"iPhone 15 Pro Max 256G 钛金属"，AI 提取"内存:256G、颜色:钛金属、型号:Pro Max"。降低商家填属性的负担（不用手填每项）。京东实践：AI 补全准确率 90%+，商家只需确认。

2. **AI 自动分类目（商品归目），怎么做？**
   新商品上架时 AI 根据标题/图片/描述预测类目——"Apple iPhone 15"归"手机>智能手机"。用分类模型（BERT/ResNet）。AI 预测 + 商家确认，避免错归类目（影响搜索/筛选）。

3. **AI 生成商品标题/卖点文案，怎么做？**
   AI 根据商品属性（内存/CPU/特色）生成营销文案——"iPhone 15 Pro Max，A17 仿生芯片，钛金属设计，极致性能"。AI 生成 + 商家编辑，提升商品吸引力。

4. **AI 检测商品信息质量（属性完整度/图片质量），怎么做？**
   AI 评分商品质量——属性越完整、图片越多、描述越详细，质量分越高。低质量商品（属性缺失/图片模糊）降权（搜索靠后），引导商家完善。京东实践：高质量商品转化率高 3 倍。

5. **AI 做"以图搜商品"（拍照搜同款），怎么做？**
   AI 用图像特征（CNN 提取）索引商品图片，用户拍照上传，AI 匹配相似图片找同款。这要求商品图片预处理建索引（图像 Embedding）。京东"拍照搜"功能：准确率 85%+，秒级返回。

## 七、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"SPU 聚合同类、SKU 最小可售、类目属性模板、EAV 动态扩展"**。

- **SPU**：iPhone 15，核心字段（name/brand/category）统一
- **SKU**：iPhone 15 128G 黑，规格组合生成，可售可库存
- **类目属性模板**：每个类目配置属性集（手机有内存/服装有尺码）
- **EAV 模型**：entity_id + attribute_id + value，加属性不改表
- **规格 vs 参数**：规格生成 SKU（内存/颜色），参数仅展示（CPU/产地）
- **存储分层**：MySQL 核心 + ES 属性（筛选）+ Redis 缓存

### 面试现场 60 秒回答

> 商品中心核心是 SPU/SKU 两级模型 + 类目属性模板 + EAV 扩展。SPU（标准化产品单元）聚合同类商品——iPhone 15 是一个 SPU，核心字段（name/brand/category）统一管理。SKU（最小存货单元）是可售卖的最小单位——iPhone 15 128G 黑色是一个 SKU，按规格组合生成。规格属性（内存/颜色，is_spec=true）参与 SKU 生成（笛卡尔积），参数属性（CPU/产地，is_spec=false）仅展示。类目属性模板——每个类目配置有哪些属性（手机有内存/CPU，服装有尺码/面料），模板存 t_attribute_def 表。EAV 模型（Entity-Attribute-Value）——属性值存 t_product_attribute（entity_id + attribute_id + value），加属性只加数据不改表结构（ALTER 影响大）。属性校验按数据类型（TEXT/NUMBER/ENUM/MULTI）。存储分层——核心字段 MySQL（SPU/SKU 表），属性 ES（扁平化字段 attr_内存=256G 支持筛选），详情 Redis 缓存。搜索按属性筛选（手机 AND 内存=256G AND 价格<8000），ES term query + range query。商品创建——DDD 充血模型，Spu 聚合根 generateSkus() 方法做笛卡尔积，publish() 校验完整性。监控 attribute_completeness（属性完整度，应 > 90%）、category_coverage（类目覆盖率）、search_latency（搜索延迟，应 < 100ms）。最关键的是"统一核心 + 差异扩展"——共性抽象到 SPU/SKU，个性用 EAV 灵活扩展。

## 八、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不每类目一张表（手机表/服装表）？ | 类目成千上万，每类目一张表不可维护（DDL 爆炸、跨类目查询难、新类目要建表）。EAV 模型统一存储，类目差异用属性模板配置。用 table_count（表数量，EAV 3 张 vs 每类目表 1000+）和 cross_category_query_rt（跨类目查询延迟）量化 |
| 证据追问 | 怎么证明商品模型支持亿级商品？ | 压测（亿级商品查询 RT、搜索筛选延迟）+ 容量规划（MySQL 分库分表、ES 分片）+ 索引设计（类目索引/品牌索引/属性索引）。监控 product_query_p99（查询延迟，< 50ms）和 search_filter_latency（筛选延迟，< 100ms） |
| 边界追问 | EAV 模型能处理所有属性场景吗？ | 不能。极复杂属性（如"套装商品"含多个 SKU 组合）用专用表；全文检索（商品描述）用 ES 全文字段；多媒体（图片/视频）用对象存储（OSS）。EAV 处理结构化属性，非结构化数据用其他方案 |
| 反例追问 | 什么场景不需要 SPU/SKU 两级（单级够用）？ | 无规格商品（虚拟商品/数字内容，如会员卡），只有一级（直接 SKU，无 SPU 聚合）。但实物商品大多需要两级 |
| 风险追问 | 商品中心最大风险？ | 主动点出：类目迁移风险（商品换类目，属性不匹配）、属性扩展失控（属性膨胀难管理）、缓存一致性（多端不同步）、搜索索引延迟（ES 落后 MySQL）。靠类目迁移工具 + 属性治理 + 消息同步 + 索引一致性校验 |
| 验证追问 | 怎么验证商品数据一致（MySQL vs ES vs 缓存）？ | 定时跑批比对（MySQL 商品 vs ES 索引，差异修复）；增量消息同步（MySQL 变更发 MQ，ES/缓存订阅）；监控 index_lag（索引延迟，< 1 秒）和 consistency_diff（一致性差异，0） |
| 沉淀追问 | 商品中心沉淀什么？ | SPU/SKU 框架、类目属性模板管理、EAV 存储引擎、商品搜索引擎（ES 集成）、商品同步中间件（MySQL→ES→Redis）、商品监控大盘（完整度/搜索延迟/一致性） |

### 现场对话示例

**面试官**：商品属性非常多（某类目有 50 个属性），详情页加载很慢（要查 50 个属性值），怎么办？

**候选人**：三层优化。第一层，缓存——商品详情整体缓存 Redis（TTL 30 分钟），属性变更主动失效。热销商品（TOP 1000）预加载缓存。第二层，异步加载——核心属性（标题/价格/图片）同步加载（快），详情属性（参数表）异步加载（懒加载）。用户看到核心信息快，详情展开时再加载参数。第三层，存储优化——属性值聚合存储（JSON 一次性查全部属性，避免 50 次 JOIN）。具体实现——SPU 表加 attrs_json 字段（缓存所有属性值的 JSON），查询时一次读出（无需 JOIN 属性表）。写入时同步更新 attrs_json（保持一致）。ES 索引也扁平化（每个属性一个字段）。京东的实践：详情页加载从 500ms 优化到 50ms（缓存 + 异步 + JSON 聚合），50 个属性秒级展示。监控 detail_page_load_p99（详情页延迟，< 100ms）。

**面试官**：商家把商品从"手机"类目迁移到"智能设备"类目，属性不同，怎么处理？

**候选人**：类目迁移是高风险操作（属性不匹配）。第一步，预检——新类目属性模板 vs 商品现有属性，找出"新类目有但商品没有的属性"（必填的要补）和"商品有但新类目没有的属性"（会丢失）。第二步，属性映射——运营配置类目间的属性映射（手机的"内存"→智能设备的"存储"），自动迁移可映射的属性。第三步，补填——商家补填新类目必填属性（不补不能迁移）。第四步，清理——旧类目独有属性归档（不删除，保留历史）。第五步，生效——更新商品的 category_id + 重新索引 ES（新类目的搜索筛选）。第六步，回滚预案——迁移有问题可回退（保留旧属性快照）。监控 category_migration_failed（迁移失败数）。京东的实践：类目迁移需运营审核（防乱迁移影响搜索），属性映射表维护（常见类目间映射预配置），迁移工具有预检+预览（商家看到影响再确认）。

**面试官**：亿级商品搜索，用户筛选"手机+内存256G+价格5000-8000+品牌Apple"，性能怎么样？

**候选人**：ES 应对这种多维筛选很快。索引设计——每个属性是 ES 字段（attr_内存: keyword 类型支持精确匹配，price: long 支持范围查询，brandId: keyword）。查询——bool query 组合（filter term attr_内存=256G AND filter range price 5000-8000 AND filter term brandId=Apple AND filter term categoryId=手机）。filter 不打分（只过滤，快），全用 filter 走倒排索引，秒级返回。优化点——第一，分片策略（按类目分片，手机类目查一个分片，不全扫）；第二，缓存（高频筛选条件缓存结果，如"iPhone 256G"的查询缓存）；第三，预热（热门筛选条件预计算，如双 11 热门机型）。京东实践：亿级商品多维筛选 RT < 100ms（ES 集群 10+ 节点，分片合理），监控 search_p99（搜索延迟）和 search_qps（搜索 QPS，双 11 峰值 10 万+）。

## 常见考点

1. **SPU 和 SKU 的区别？**——SPU 是标准化产品单元（iPhone 15，概念），SKU 是最小存货单元（iPhone 15 128G 黑，具体可售）。SPU 聚合同类，SKU 区分可售。
2. **EAV 模型的优缺点？**——优点：扩展性强（加属性不改表），灵活（不同实体属性不同）。缺点：查询 JOIN 多（慢），数据校验难（值是 TEXT，类型靠应用层校验）。读优化用 ES 扁平化。
3. **商品快照怎么做（订单存商品信息）？**——下单时把商品的关键信息（名称/价格/图片/规格）序列化成 JSON 存订单表。即使商品后续修改/下架，历史订单展示原样。
4. **怎么做虚拟商品（无需物流）？**——virtual_product 表（卡密/激活码），下单后发卡密不发物流。SKU 类型区分（实物/虚拟/服务），交易链路按类型分流。

## 结构化回答

**30 秒电梯演讲：** 商品中心是电商的数据基座——所有业务（搜索/推荐/下单/库存/价格）都依赖商品数据。核心挑战是商品形态多样（手机有内存属性、服装有尺码、生鲜有保质期）vs 系统要统一模型。解法是SPU/SKU 两级模型 + 类目属性模板 + 扩展字段——SPU 是标准化产品单元（iPhone 15），SKU 是最小存货单元（iPhone 15 128G 黑色），属性按类目配置（手机类目有内存属性，服装类目有尺码）

**展开框架：**
1. **SPU（标准化产品单元）** — iPhone 15，同类商品聚合
2. **SKU（最小存货单元）** — iPhone 15 128G 黑色，可售卖可库存的最小单位
3. **类目属性模板** — 每个类目有一组属性（手机有内存/CPU，服装有尺码/面料）

**收尾：** 以上是我的整体思路。您想继续深入聊——属性值怎么存（字符串/数字/多选）？


## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：商品中心模型、类目属性与扩展性 | "这题一句话：商品中心是电商的数据基座——所有业务（搜索/推荐/下单/库存/价格）都依赖商品数据。" | 开场钩子 |
| 0:15 | 像图书馆编目类比图 | "打个比方：像图书馆编目。" | 核心类比 |
| 0:40 | SPU（标准化产品单元）示意/对比图 | "iPhone 15，同类商品聚合" | SPU（标准化产品单元）要点 |
| 1:05 | SKU（最小存货单元）示意/对比图 | "iPhone 15 128G 黑色，可售卖可库存的最小单位" | SKU（最小存货单元）要点 |
| 1:55 | 总结卡 | "记住：SPU 聚合同类。下期见。" | 收尾 |
