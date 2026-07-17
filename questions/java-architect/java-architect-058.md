---
id: java-architect-058
difficulty: L2
category: java-architect
subcategory: 规则引擎
tags:
- Java 架构师
- 价格系统
- 规则引擎
- 版本管理
feynman:
  essence: 价格系统是电商的"命脉"——一分钱的错误就可能导致巨额损失（100 万单 × 10 元差价 = 1000 万损失）。价格系统的核心挑战是"规则组合爆炸"——基础价、促销价、优惠券、满减、会员价、PLUS 价、区域价、时段价……几十种规则叠加，最终成交价怎么算？架构解法是"规则引擎 + 价格版本管理"——规则用 DSL 配置（非硬编码），价格计算可回溯（每一步规则的输入输出都有记录），价格变更版本化（支持回滚和审计）。
  analogy: 像报税计算。你的应纳税额 = 收入 - 起征点 - 专项扣除 - 专项附加扣除。每一项都有规则（起征点 5000/月，子女教育每个子女 1000/月……）。规则可能变（今年政策调整），计算过程要留底（税务局要求可查）。价格系统类似——商品最终价 = 基础价 × 区域系数 - 促销优惠 - 优惠券 - 会员折扣，每一步规则可配置、可审计、可回溯。
  first_principle: 为什么不能在代码里硬编码价格规则？因为规则变化频繁（运营天天调整促销）、规则组合复杂（几十种叠加）、规则要可审计（财务对账、用户投诉要查）。硬编码意味着每次改规则都要发版（慢）、改了不可追溯（审计难）、容易出错（代码 bug 影响所有商品）。解法是"规则引擎"——规则用 DSL（领域专用语言）或配置表表达，引擎解释执行，规则变更不发版，计算过程自动记录。
  key_points:
  - 价格构成：基础价 → 促销价 → 优惠券 → 会员价 → 区域/时段价 → 最终成交价
  - 规则引擎：Drools/Easy Rules/自研 DSL，规则配置化、解释执行
  - 价格版本：每次价格变更生成版本号，支持回滚和审计
  - 价格回溯：记录每一步计算的输入/输出/规则 ID，可追溯
  - 价格一致性：多端（APP/H5/小程序）展示同一价格，靠价格中心统一计算
first_principle:
  problem: 一个商品最终价格由 N 种规则叠加决定，规则频繁变化、组合复杂、要求可审计，怎么设计？
  axioms:
  - 规则变化频繁（运营每天调整），硬编码不可行（发版慢、风险高）
  - 规则组合复杂（促销+券+会员+区域），计算逻辑要清晰可维护
  - 价格错误代价巨大（每单差几分，百万单就是巨额损失）
  - 价格变更必须可审计（财务合规、用户投诉可查）
  rebuild: 规则引擎 + 价格版本管理。规则用 DSL（如 Drools DRL 或自研表达式）表达，存数据库（不发版）。价格引擎按优先级链式执行规则（基础价 → 促销 → 券 → 会员），每步记录输入输出。价格变更生成版本号（price_version），订单表存下单时的价格版本号，支持历史价格回溯。价格中心统一对外（所有端调同一接口），保证一致性。
follow_up:
  - 价格计算很慢怎么办？——缓存。商品维度的最终价缓存（Redis，TTL 5 分钟），规则变更时主动失效。热销商品预计算。
  - 怎么保证不漏算/多算规则？——规则覆盖测试（每个规则有测试用例），计算结果有断言（成交价 >= 成本价，成交价 <= 基础价）。监控 price_anomaly_count（价格异常数）。
  - 价格变更怎么灰度？——先小流量（1% 商品）验证，监控价格波动，无异常后全量。版本号支持一键回滚。
  - 大促时价格规则怎么管理？——大促专用规则集（独立版本），活动开始自动切换，结束自动回切。规则提前配置+预热。
  - 跨系统价格怎么同步？——价格中心是唯一数据源，其他系统（搜索/推荐/详情页）订阅价格变更消息（MQ），异步更新。最终一致。
memory_points:
  - 价格构成链：基础价 → 促销 → 券 → 会员 → 区域/时段 → 成交价
  - 规则引擎：DSL 配置，解释执行，不发版
  - 价格版本：版本号 + 回滚 + 审计
  - 价格回溯：记录每步计算，可追溯
  - 价格中心：统一计算，多端一致
---

# 【Java 后端架构师】价格系统规则引擎与版本管理

> 适用场景：JD 核心业务。一个 iPhone 基础价 5999，PLUS 会员 95 折，满 5000 减 200，用 100 元券，最终成交价多少？答案是 5999 × 0.95 - 200 - 100 = 5399.05。但这只是 4 种规则叠加，实际场景有几十种规则（促销/满减/券/会员/区域/时段/新人/拼购……）。价格系统的核心是"规则引擎 + 版本管理"——规则配置化、计算可回溯、变更可审计。

## 一、概念层：价格系统的核心挑战

**价格构成链**（每一步都是一个规则）：

```
基础价（商品维度，运营维护）
  5999 元
    │
    ▼ 应用"促销规则"（满减/直降/秒杀）
促销价
  5999 - 200（满 5000 减 200）= 5799
    │
    ▼ 应用"优惠券规则"（平台券/店铺券）
券后价
  5799 - 100（100 元券）= 5699
    │
    ▼ 应用"会员规则"（PLUS 95 折，作用在基础价）
会员价
  5699 - 5999 × 0.05 = 5399.05
    │
    ▼ 应用"区域/时段规则"（区域补贴、夜间特价）
区域价
  5399.05 - 50（北京补贴）= 5349.05
    │
    ▼
最终成交价：5349.05 元
```

**为什么需要规则引擎**（三种方案对比）：

| 方案 | 优点 | 缺点 | 适用 |
|------|------|------|------|
| 硬编码（if-else） | 简单直接 | 改规则要发版、不可配置、难审计 | 规则极少变化 |
| 配置表（数据库存规则） | 可配置、不发版 | 表达能力弱（复杂规则难描述） | 规则简单 |
| 规则引擎（Drools/自研 DSL） | 表达力强、可审计、可回溯 | 学习成本、性能开销 | 规则复杂多变（电商价格系统选这个） |

## 二、机制层：规则引擎实现

**价格规则 DSL 设计**（自研，比 Drools 轻）：

```java
/**
 * 价格规则接口：所有规则实现这个接口
 */
public interface PriceRule {
    String getRuleId();           // 规则 ID（唯一标识）
    int getPriority();            // 优先级（小的先执行）
    boolean matches(PriceContext ctx);   // 是否适用（规则条件）
    void apply(PriceContext ctx);        // 应用规则（修改价格）
}

/**
 * 价格上下文：贯穿整个计算链
 */
public class PriceContext {
    private Long skuId;
    private Long userId;
    private BigDecimal basePrice;          // 基础价
    private BigDecimal currentPrice;       // 当前价（每步规则更新）
    private List<PriceStep> steps = new ArrayList<>();  // 计算步骤（回溯用）
    private Map<String, Object> facts;     // 上下文事实（会员等级/区域/优惠券）

    public void recordStep(String ruleId, BigDecimal before, BigDecimal after, String desc) {
        steps.add(new PriceStep(ruleId, before, after, desc));
        this.currentPrice = after;
    }
}

/**
 * 规则示例：满减规则
 */
@Component
public class FullReductionRule implements PriceRule {

    @Autowired private PromotionConfigRepo configRepo;

    @Override
    public String getRuleId() { return "FULL_REDUCTION"; }

    @Override
    public int getPriority() { return 100; }   // 促销规则优先级 100

    @Override
    public boolean matches(PriceContext ctx) {
        FullReductionConfig config = configRepo.findActive(ctx.getSkuId());
        return config != null && ctx.getCurrentPrice().compareTo(config.getThreshold()) >= 0;
    }

    @Override
    public void apply(PriceContext ctx) {
        FullReductionConfig config = configRepo.findActive(ctx.getSkuId());
        BigDecimal before = ctx.getCurrentPrice();
        BigDecimal after = before.subtract(config.getReduction());
        ctx.recordStep(getRuleId(), before, after,
            "满 " + config.getThreshold() + " 减 " + config.getReduction());
    }
}

/**
 * 规则示例：PLUS 会员折扣（作用在基础价）
 */
@Component
public class PlusMemberRule implements PriceRule {

    @Override
    public String getRuleId() { return "PLUS_MEMBER"; }

    @Override
    public int getPriority() { return 200; }   // 会员规则优先级 200

    @Override
    public boolean matches(PriceContext ctx) {
        return "PLUS".equals(ctx.getFacts().get("memberLevel"));
    }

    @Override
    public void apply(PriceContext ctx) {
        BigDecimal before = ctx.getCurrentPrice();
        BigDecimal discount = ctx.getBasePrice().multiply(new BigDecimal("0.05"));  // 基础价 5% 折扣
        BigDecimal after = before.subtract(discount);
        ctx.recordStep(getRuleId(), before, after, "PLUS 会员 95 折");
    }
}
```

**价格引擎（链式执行规则）**：

```java
@Service
public class PriceEngine {

    @Autowired private List<PriceRule> rules;   // Spring 注入所有规则

    /**
     * 计算最终价格
     */
    public PriceResult calculate(PriceRequest request) {
        // 1. 构建上下文
        PriceContext ctx = new PriceContext();
        ctx.setSkuId(request.getSkuId());
        ctx.setUserId(request.getUserId());
        ctx.setBasePrice(getBasePrice(request.getSkuId()));
        ctx.setCurrentPrice(ctx.getBasePrice());
        ctx.setFacts(loadFacts(request));   // 会员等级/区域/已选优惠券

        // 2. 按优先级排序规则
        List<PriceRule> sortedRules = rules.stream()
            .sorted(Comparator.comparingInt(PriceRule::getPriority))
            .collect(Collectors.toList());

        // 3. 链式执行（只执行 matches 返回 true 的规则）
        for (PriceRule rule : sortedRules) {
            if (rule.matches(ctx)) {
                BigDecimal before = ctx.getCurrentPrice();
                rule.apply(ctx);
                log.info("规则 {} 执行：{} -> {}", rule.getRuleId(), before, ctx.getCurrentPrice());
            }
        }

        // 4. 价格校验（防异常）
        validatePrice(ctx);

        // 5. 返回结果（含计算步骤）
        return new PriceResult(ctx.getCurrentPrice(), ctx.getSteps(), priceVersion);
    }

    private void validatePrice(PriceContext ctx) {
        // 成交价不能低于成本价（防 bug 导致亏本）
        BigDecimal cost = getCost(ctx.getSkuId());
        if (ctx.getCurrentPrice().compareTo(cost) < 0) {
            monitor.record("price_below_cost_count", ctx.getSkuId());
            throw new PriceAnomalyException("成交价低于成本价，疑似规则配置错误");
        }
        // 成交价不能高于基础价（防规则叠加错误）
        if (ctx.getCurrentPrice().compareTo(ctx.getBasePrice()) > 0) {
            monitor.record("price_above_base_count", ctx.getSkuId());
            throw new PriceAnomalyException("成交价高于基础价，疑似规则配置错误");
        }
    }
}
```

## 三、机制层：价格版本管理与回溯

**价格版本表设计**：

```sql
-- 价格版本表：每次价格变更生成一个版本
CREATE TABLE t_price_version (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    sku_id BIGINT NOT NULL,
    version_no INT NOT NULL,          -- 版本号（递增）
    base_price DECIMAL(10,2),         -- 基础价快照
    rule_snapshot JSON,               -- 规则配置快照（当时生效的规则）
    effective_from DATETIME,          -- 生效开始时间
    effective_to DATETIME,            -- 生效结束时间（下一版本开始）
    operator VARCHAR(64),             -- 操作人
    reason VARCHAR(256),              -- 变更原因
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_sku_version (sku_id, version_no),
    KEY idx_sku_effective (sku_id, effective_from, effective_to)
);

-- 订单表存价格版本号（下单时锁定版本，后续价格变化不影响已下订单）
ALTER TABLE t_order ADD COLUMN price_version INT;
ALTER TABLE t_order ADD COLUMN price_detail JSON;  -- 价格计算详情（每步规则）

-- 价格变更日志（审计）
CREATE TABLE t_price_change_log (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    sku_id BIGINT,
    from_version INT,
    to_version INT,
    change_type ENUM('BASE_PRICE', 'RULE_ADD', 'RULE_MODIFY', 'RULE_REMOVE'),
    operator VARCHAR(64),
    risk_level ENUM('LOW', 'MEDIUM', 'HIGH'),  -- 风险等级（变动 > 10% 为 HIGH）
    approved_by VARCHAR(64),          -- 审批人（HIGH 风险需审批）
    created_at DATETIME
);
```

**价格版本管理服务**：

```java
@Service
public class PriceVersionService {

    /**
     * 发布新价格版本
     */
    @Transactional
    public void publishNewVersion(Long skuId, PriceChangeRequest req, String operator) {
        // 1. 风险评估
        BigDecimal oldPrice = getCurrentPrice(skuId);
        BigDecimal newPrice = calculateNewPrice(skuId, req);
        BigDecimal changeRatio = newPrice.subtract(oldPrice).abs().divide(oldPrice, 4, HALF_UP);

        String riskLevel = changeRatio.compareTo(new BigDecimal("0.1")) > 0 ? "HIGH" :
                          changeRatio.compareTo(new BigDecimal("0.05")) > 0 ? "MEDIUM" : "LOW";

        // 2. HIGH 风险需审批
        if ("HIGH".equals(riskLevel) && req.getApprovedBy() == null) {
            throw new PriceApprovalRequiredException("价格变动 > 10%，需主管审批");
        }

        // 3. 关闭旧版本
        int oldVersion = getCurrentVersion(skuId);
        versionRepo.closeVersion(skuId, oldVersion);

        // 4. 创建新版本
        int newVersion = oldVersion + 1;
        PriceVersion version = new PriceVersion();
        version.setSkuId(skuId);
        version.setVersionNo(newVersion);
        version.setBasePrice(req.getBasePrice());
        version.setRuleSnapshot(JSON.toJSONString(ruleRepo.findActiveRules(skuId)));
        version.setEffectiveFrom(LocalDateTime.now());
        version.setOperator(operator);
        version.setReason(req.getReason());
        versionRepo.save(version);

        // 5. 记录变更日志
        changeLogRepo.log(skuId, oldVersion, newVersion, req.getChangeType(),
            operator, riskLevel, req.getApprovedBy());

        // 6. 失效价格缓存
        redis.delete("price:" + skuId);

        // 7. 发布价格变更事件（其他系统订阅）
        eventBus.publish(new PriceChangedEvent(skuId, newVersion));

        monitor.record("price_change_count", skuId, riskLevel);
    }

    /**
     * 回滚到指定版本
     */
    @Transactional
    public void rollback(Long skuId, int targetVersion) {
        PriceVersion target = versionRepo.findBySkuAndVersion(skuId, targetVersion);
        publishNewVersion(skuId,
            new PriceChangeRequest(target.getBasePrice(),
                JSON.parseObject(target.getRuleSnapshot(), RuleConfig.class),
                "ROLLBACK to v" + targetVersion),
            "SYSTEM");
        monitor.record("price_rollback_count", skuId);
    }

    /**
     * 回溯历史价格（订单用下单时的版本号查当时的规则）
     */
    public PriceDetail reconstructPrice(Long skuId, int versionNo) {
        PriceVersion version = versionRepo.findBySkuAndVersion(skuId, versionNo);
        RuleConfig rules = JSON.parseObject(version.getRuleSnapshot(), RuleConfig.class);
        // 用当时的规则重算，用于审计/对账
        return priceEngine.calculateWithRules(skuId, rules);
    }
}
```

## 四、底层本质：价格系统的本质是"规则的可计算可审计"

回到第一性：**价格系统的本质是"把业务规则从代码中剥离，变成可配置、可计算、可审计的数据"**。

- **可配置**：规则用 DSL/配置表表达，运营自助修改，不发版。这是"业务与代码解耦"——价格规则是业务（频繁变化），价格引擎是代码（稳定）。解耦后业务变化不影响代码稳定性。
- **可计算**：规则引擎解释执行规则，输入（基础价/会员等级/优惠券）确定时输出（成交价）确定。这是"计算的确定性"——同样的输入永远得到同样的输出，保证一致性。
- **可审计**：每一步计算记录（规则 ID+输入+输出+版本号），任何一笔订单的价格都能回溯"为什么是这个价"。这是"可解释性"——用户投诉/财务对账时能解释清楚。
- **可回滚**：价格变更版本化，发现错误一键回滚到上个版本。这是"可逆性"——降低变更风险。

**版本化的本质是"给价格打时间快照"**：商品价格随时间变化（今天促销、明天恢复），订单在下单那一刻锁定价格版本号。即使后续价格变化，已下订单的价格不变（按当时版本计算）。这解决了"价格随时间变化"和"订单价格固定"的矛盾——订单是价格的"时间切片"。

**规则引擎 vs 硬编码的本质区别**：硬编码是"规则在代码里"（开发者控制），规则引擎是"规则在数据里"（业务方控制）。前者改规则要发版（天级），后者改规则即时生效（秒级）。电商场景规则变化频繁（每天调整促销），必须用规则引擎。代价是性能开销（解释执行比编译执行慢）和学习成本（DSL 需要学习）。但对于"规则多变"的场景，这个代价值得。

## 五、AI 架构师加问：5 个

1. **用 AI 预测最优价格，怎么做？**
   AI 用历史销量+价格+竞品价格+季节因素训练模型（如 XGBoost/LSTM），预测"价格-销量"曲线，找利润最大化的价格点。但这是"定价建议"（AI 推荐），不是"自动定价"——最终价格由运营确认。京东"智能定价"系统：AI 推荐 + 运营审核 + A/B 测试验证。

2. **AI 自动检测价格异常（规则配置错误），怎么做？**
   AI 学习历史价格的分布（每个 SKU 的合理价格区间），实时检测偏离——如某 SKU 突然降价 50%（可能规则配错），AI 报警拦截。用异常检测模型（孤立森林/3-sigma）。京东实践：价格变更自动 AI 评审，异常变更（变动 > 20% 或低于成本）自动拦截待人工确认。

3. **AI 辅助生成价格规则，怎么做？**
   运营用自然语言描述需求（"618 期间 PLUS 会员买 iPhone 减 500"），AI 解析成规则 DSL（自动填充字段、校验合法性）。降低运营配置规则的门槛（不用学 DSL 语法）。AI 还能推荐相似规则（"你配置了 iPhone 的规则，要不要也给 Android 手机配一个？"）。

4. **AI 做个性化定价（千人千面），有什么风险？**
   个性化定价（不同用户不同价）有法律和道德风险——"大数据杀熟"被多国禁止。京东的做法是"个性化优惠"而非"个性化基础价"——基础价统一，但优惠券/补贴可以个性化（新人券、老用户回馈）。AI 用于"发什么券"而非"定什么价"。

5. **AI 实时监控价格一致性（多端同价），怎么做？**
   AI 爬虫定时检查 APP/H5/小程序/第三方平台的价格是否一致，发现不一致（如小程序比 APP 便宜 10 元）报警。可能原因：缓存未失效、消息延迟、第三方同步失败。AI 定位根因并触发修复。

## 六、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"规则引擎链式执行、版本管理可回溯、价格校验防异常、价格中心统一算"**。

- **价格构成链**：基础价 → 促销 → 券 → 会员 → 区域/时段 → 成交价
- **规则引擎**：PriceRule 接口（priority + matches + apply），链式执行，每步记录
- **版本管理**：版本号 + 规则快照 + 生效时间，支持回滚和审计
- **价格校验**：成交价 >= 成本价，成交价 <= 基础价（防规则 bug）
- **价格中心**：统一计算接口，多端一致，订单存版本号锁定价格

### 面试现场 60 秒回答

> 价格系统核心是"规则引擎 + 版本管理"。价格由多种规则叠加决定——基础价、促销、优惠券、会员折扣、区域补贴，每一步都是一个规则。我用自研规则引擎——每个规则实现 PriceRule 接口（getPriority + matches + apply），引擎按优先级链式执行，每步记录输入输出（PriceStep），整个计算可回溯。规则用 DSL 配置（存数据库），运营自助修改不发版。版本管理——每次价格变更生成版本号（version_no），规则配置快照存 JSON，订单表存下单时的版本号，价格变化不影响已下订单。价格校验兜底——成交价不能低于成本价、不能高于基础价，防规则 bug 导致亏本或标价错误。风险分级——价格变动 > 10% 需主管审批。价格中心统一对外（所有端调同一接口），保证 APP/H5/小程序同价。监控 price_anomaly_count（价格异常数）、price_below_cost_count（低于成本价数）、price_change_count（价格变更数）。最关键的是"规则可配置、计算可回溯、变更可审计"——这是价格系统区别于普通 CRUD 的本质。

## 七、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不直接用 Drools，要自研规则引擎？ | Drools 重量级（学习成本高、启动慢、运维复杂），电商价格规则中等复杂度，自研轻量 DSL 更合适。用 rule_engine_rt_p99（规则引擎执行延迟，自研 < 5ms vs Drools 20ms+）和 config_lead_time（规则配置到生效时间，自研秒级）量化 |
| 证据追问 | 怎么证明价格计算正确（不漏算不多算）？ | 规则覆盖测试（每规则有测试用例）+ 价格校验断言（成交价在 [成本价, 基础价] 区间）+ 对账（每日抽样订单重算，比对差异）。监控 price_recalc_diff（重算差异，应为 0）、price_anomaly_count（价格异常数，应为 0） |
| 边界追问 | 规则引擎能处理所有价格场景吗？ | 不能。极复杂的场景（如"买 A 送 B，B 的价格按 A 的折扣算"）用 DSL 难表达，需要硬编码或组合优惠引擎。另外性能敏感场景（详情页 QPS 10 万）不实时算，用缓存最终价 |
| 反例追问 | 什么场景不需要版本管理（直接覆盖）？ | 内部系统（无审计要求）、价格极少变化（年度调价）。但电商面向用户和财务，必须版本化（合规要求） |
| 风险追问 | 价格系统最大的风险？ | 主动点出：规则 bug 导致价格异常（亏本或标错价）、缓存不一致（多端不同价）、规则配置错误（运营配错满减金额）。靠价格校验断言 + AI 异常检测 + 多端对账兜底 |
| 验证追问 | 怎么验证价格变更安全？ | 灰度发布（先 1% 商品）+ 监控价格波动 + 对账（变更前后抽样比对）+ 回滚预案（一键回滚到上个版本）。HIGH 风险变更需主管审批 |
| 沉淀追问 | 价格系统沉淀什么？ | 规则引擎框架（PriceRule 接口）、规则 DSL 库（常用规则模板）、版本管理工具（回滚/审计/回溯）、价格监控大盘（异常率/变更次数/计算 RT） |

### 现场对话示例

**面试官**：用户投诉"昨天买的 5000，今天看变 4500 了"，怎么处理？

**候选人**：这是价格变更的正常场景，但用户体验差。第一步，查订单的价格版本号——订单表存了 price_version，用版本号查当时的规则，确认下单时确实是 5000（不是 bug）。第二步，判断是否"保价"——京东有"价格保护"政策，下单后 N 天内降价补差价。如果订单在保价期内，自动退差价（500 元退款）。第三步，如果不在保价期，客服解释政策（价格随市场波动）。系统层面，价格变更要有"保价检查"——变更时扫描近 N 天的订单，自动触发差价退款（不用用户申请）。监控 price_protection_count（保价退款数）和 price_complaint_count（价格投诉数）。另外价格变更要"软通知"用户——降价时给近期购买用户推消息"您购买的商品已降价，可申请保价"，变被动投诉为主动服务。

**面试官**：大促时几百个促销规则同时生效，价格计算很慢（RT > 100ms），怎么办？

**候选人**：三层优化。第一层，规则预筛选——不是所有规则都 matches，根据上下文预过滤（如用户没券就不执行券规则）。matches 方法要轻（只判断条件，不查 DB），重逻辑放 apply。第二层，缓存——商品维度的最终价缓存 Redis（TTL 5 分钟），规则变更时主动失效。热销商品（TOP 1000）预计算，详情页直接读缓存不算。第三层，并行计算——如果规则间无依赖（如促销和会员独立），用 CompletableFuture 并行执行。但大多数规则有依赖（券后价才能算会员价），串行为主。极端情况用"计算集群"——把价格计算独立成服务，横向扩展。京东双 11 的实践：规则引擎 RT 从 100ms 优化到 5ms（预筛选 + 缓存 + 热点预计算），QPS 支撑 10 万。

**面试官**：同一商品在不同端（APP/H5/小程序）价格不一致，怎么排查？

**候选人**：先定位根因。可能原因：缓存不一致（各端缓存独立，失效不同步）、CDN 缓存（静态页缓存了旧价格）、客户端本地缓存（APP 缓存未刷新）、第三方平台同步延迟。排查步骤：第一步，调价格中心接口（绕过缓存）确认"源价格"是否一致——如果一致，是缓存问题；不一致，是价格中心 bug。第二步，查各端缓存——Redis 里 APP/H5/小程序的价格 key 是否一致。第三步，查 CDN 缓存——curl 直接回源看价格。第四步，查客户端——让用户提供截图和网络请求（看返回的价格 JSON）。修复：价格中心是唯一数据源，价格变更发 MQ，所有端订阅变更消息主动失效缓存。监控 price_consistency_check（多端价格一致性检查，定时跑批比对），不一致率应 < 0.01%。京东的实践：价格中心接口加"价格指纹"（hash），各端缓存带指纹，指纹不一致强制刷新。

## 常见考点

1. **规则引擎和策略模式有什么区别？**——策略模式是代码层面的（编译时确定策略），规则引擎是数据层面的（运行时配置规则）。策略模式改策略要改代码，规则引擎改规则只改配置。
2. **价格计算为什么要记录每一步？**——审计（财务对账）、客服（用户投诉解释）、回溯（历史订单重现）、调试（规则 bug 定位）。没有记录就是黑盒，出问题无法排查。
3. **价格变更怎么保证零停机？**——版本化管理 + 灰度发布 + 缓存失效 + MQ 通知。变更时不停服，旧版本继续服务（effective_to 时间），新版本到点自动切换。
4. **怎么防止"价格穿透"（规则叠加后价格异常低）？**——价格校验断言（成交价 >= 成本价）+ 规则互斥（某些规则不能叠加，如秒杀价不能再券）+ 风险审批（变动 > 10% 需审批）。

## 结构化回答

**30 秒电梯演讲：** 价格系统是电商的命脉——一分钱的错误就可能导致巨额损失（100 万单 × 10 元差价 = 1000 万损失）。价格系统的核心挑战是规则组合爆炸——基础价、促销价、优惠券、满减、会员价、PLUS 价、区域价、时段价……几十种规则叠加，最终成交价怎么算？架构解法是规则引擎 + 价格版本管理——规则用 DSL 配置（非硬编码），价格计算可回溯（每一步规则的输入输出都有记录），价格变更版本化（支持回滚和审计）

**展开框架：**
1. **价格构成** — 基础价 → 促销价 → 优惠券 → 会员价 → 区域/时段价 → 最终成交价
2. **规则引擎** — Drools/Easy Rules/自研 DSL，规则配置化、解释执行
3. **价格版本** — 每次价格变更生成版本号，支持回滚和审计

**收尾：** 以上是我的整体思路。您想继续深入聊——价格计算很慢怎么办？


## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：价格系统规则引擎与版本管理 | "这题一句话：价格系统是电商的命脉——一分钱的错误就可能导致巨额损失（100 万单 × 10 元差价 = 1000 万损失）。" | 开场钩子 |
| 0:15 | 价格构成示意/对比图 | "基础价 → 促销价 → 优惠券 → 会员价 → 区域/时段价 → 最终成交价" | 价格构成要点 |
| 0:40 | 规则引擎示意/对比图 | "Drools/Easy Rules/自研 DSL，规则配置化、解释执行" | 规则引擎要点 |
| 1:25 | 总结卡 | "记住：价格构成链。下期见。" | 收尾 |
