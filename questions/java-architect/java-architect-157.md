---
id: java-architect-157
difficulty: L2
category: java-architect
subcategory: 中台架构
tags:
- Java 架构师
- 数据质量
- 异常拦截
- 治理
feynman:
  essence: 数据质量平台的核心是把"脏数据进、净数据出"做成一条可量化、可拦截、可回溯的流水线。用规则引擎（Drools/自研 DSL）声明字段约束（非空/枚举/范围/正则/跨表一致），在写入前做同步校验、写入后做异步巡检，异常数据进隔离区（quarantine）人工或规则兜底。本质是用"事前拦截 + 事后对账 + 指标看板"把数据可信度从"靠人盯"变成"靠系统保证"。
  analogy: 像一个机场安检流水线——行李先过 X 光（规则校验），可疑的开箱检查（隔离区），通过的贴标签放行（标记可信），全程录像（数据血缘），最后统计违禁品率（质量看板）。
  first_principle: 数据为什么会有质量问题？因为数据来自多源（人工录入/外部接口/日志采集）、多格式、多时点，每个源头都可能有缺失、错误、重复、延迟。数据质量平台的本质是"在数据流转的关键节点插入校验关卡"，把质量问题拦截在扩散之前，而不是等下游报表算错了才发现。
  key_points:
  - 六大质量维度：完整性（非空）、准确性（值正确）、一致性（跨表/跨系统）、唯一性（无重复）、及时性（延迟可控）、有效性（格式合规）
  - 三层拦截：事前（写入前同步校验，失败拒绝）、事中（Flink 流式实时校验）、事后（离线批量巡检对账）
  - 规则引擎：DQL（Data Quality Language）声明规则，规则可版本化、可灰度、可热更
  - 隔离区机制：异常数据进 quarantine 表，标记 exception_code，不影响主链路
  - 核心指标：data_valid_rate（校验通过率）、quarantine_count（隔离量）、reconcile_diff_rate（对账差异率）
first_principle:
  problem: 海量数据从多源汇入数据中台/业务库，如何系统性拦截脏数据、保证下游消费的数据可信？
  axioms:
  - 脏数据一旦进入下游报表/决策，纠错成本指数级上升（GIGO 原则）
  - 校验规则会随业务演进（新字段、新枚举、新约束），规则必须可配置可热更
  - 强校验（拒绝写入）影响主链路可用性，弱校验（放行但标记）可能漏过脏数据
  - 质量问题不可完全避免，核心是"早发现、快定位、可回滚"
  rebuild: 建三层校验体系——事前用规则引擎在 API/ETL 入口同步校验关键字段，失败拒绝或隔离；事中用 Flink 流式实时监测异常模式（如突增、突降）；事后离线跑对账任务（主数据 vs 副本、业务库 vs 数仓）发现一致性偏差。所有规则版本化管理，所有异常进隔离区并告警，核心指标上看板。
follow_up:
  - 规则引擎选 Drools 还是自研？——简单字段校验（非空/范围）自研注解即可（@NotNull/@Range）；复杂跨表/跨字段逻辑用 Drools 或自研 DSL。JD 实践：字段级用 Hibernate Validator，业务级用自研 DQL（类似 SQL 语法，数据分析师可写）。
  - 隔离区的数据怎么处理？——三类：自动修复（有明确修复规则，如缺失默认值）、人工审核（进工单系统）、退回源头（通知上游修复重推）。隔离超过 24h 未处理升级。
  - 强校验拒绝写入影响主链路怎么办？——关键交易链路用强校验（必须正确），非关键链路用弱校验（标记但放行）。强校验失败要有降级路径（如缓存上次有效值）。
  - 对账怎么做？——T+1 批量对账（主表 count/sum 与下游汇总比对）+ 实时对账（Flink 双流 JOIN 检测差异）。差异超阈值告警，自动触发补偿任务。
  - 怎么量化数据质量？——六维评分卡：每维度 0-100 分，加权汇总成 data_quality_score。日报推送，低于 80 分触发治理任务。
memory_points:
  - 六维度：完整性、准确性、一致性、唯一性、及时性、有效性
  - 三层拦截：事前同步校验（拒绝/隔离）、事中 Flink 实时、事后 T+1 对账
  - 规则引擎：字段级 Hibernate Validator，业务级 Drools/自研 DQL，版本化热更
  - 隔离区：异常数据 quarantine 表 + exception_code，自动修复/人工审核/退回源头
  - 核心指标：data_valid_rate、quarantine_count、reconcile_diff_rate、data_quality_score
---

# 【Java 后端架构师】数据质量平台与异常数据拦截

> 适用场景：JD 核心技术。商品库千万级 SKU、订单日亿级、价格每日变更百万次——脏数据（价格为负、库存为空、SKU 编码重复）一旦漏过，下游推荐/结算/履约全线出错。架构师要设计的是一条"脏数据进不来、漏过的能发现、发现的能修复"的可信数据链路。

## 一、概念层：数据质量六大维度

| 维度 | 定义 | 典型规则 | 违反后果 |
|------|------|---------|---------|
| **完整性** | 字段非空、记录不缺失 | `price IS NOT NULL` | 推荐算不出分、结算报错 |
| **准确性** | 值符合业务真实情况 | `price > 0 AND price < 1000000` | 价格标错（0 元购事故） |
| **一致性** | 跨表/跨系统数据相同 | 主库库存 = ES 索引库存 | 超卖或库存幻觉 |
| **唯一性** | 无重复记录 | `COUNT(DISTINCT sku_id) = COUNT(*)` | SKU 重复导致展示错乱 |
| **及时性** | 数据延迟可控 | `update_time > NOW() - INTERVAL 1 HOUR` | 商品下架了还在推荐 |
| **有效性** | 格式合规 | `sku_id REGEXP '^JD[0-9]{10}$'` | 下游正则解析失败 |

**核心架构原则**：数据质量不是"加几个 if 校验"，而是建一条"规则声明 - 多层拦截 - 隔离修复 - 对账度量"的闭环流水线。

## 二、机制层：规则引擎与三层拦截

### 2.1 字段级校验（Hibernate Validator 注解）

```java
@Data
public class SkuDTO {
    @NotBlank(message = "SKU 编码不能为空")
    @Pattern(regexp = "^JD[0-9]{10}$", message = "SKU 编码格式错误")
    private String skuId;

    @NotNull
    @DecimalMin(value = "0.01", message = "价格必须大于 0")
    @DecimalMax(value = "999999.99", message = "价格超出上限")
    private BigDecimal price;

    @NotNull
    @Min(value = 0, message = "库存不能为负")
    private Integer stock;

    @NotBlank
    @Size(max = 200)
    private String title;

    @NotNull
    private Integer categoryId;
}

// 统一校验入口
@Service
public class SkuValidationService {
    private final Validator validator = Validation.buildDefaultValidatorFactory().getValidator();

    public ValidationResult validate(SkuDTO sku) {
        Set<ConstraintViolation<SkuDTO>> violations = validator.validate(sku);
        if (violations.isEmpty()) return ValidationResult.ok();
        Map<String, String> errors = violations.stream()
            .collect(toMap(
                v -> v.getPropertyPath().toString(),
                ConstraintViolation::getMessage));
        return ValidationResult.fail(errors);
    }
}
```

### 2.2 业务级规则（自研 DQL + Drools）

复杂跨字段/跨表规则用规则引擎。JD 实践：自研 DQL（Data Quality Language），数据分析师可写，编译成 Drools DRL 执行。

```java
// DQL 规则示例（配置化，无需发版）
// RULE "价格与成本约束"
//   WHEN sku.price < sku.cost * 1.1  // 售价不得低于成本 1.1 倍
//   THEN quarantine(sku, "PRICE_BELOW_COST")

// Drools 规则文件（drl）
@Service
public class BusinessRuleEngine {
    private final KieContainer kieContainer;  // 规则容器，支持热更

    public List<RuleViolation> check(SkuDTO sku) {
        KieSession session = kieContainer.newKieSession();
        List<RuleViolation> violations = new ArrayList<>();
        session.setGlobal("violations", violations);
        session.insert(sku);
        session.insert(new MarketContext(LocalDate.now()));  // 促销上下文
        session.fireAllRules();
        session.dispose();
        return violations;
    }
}
```

**规则版本化与灰度**：

```java
// 规则表（数据库存储，支持版本和灰度）
CREATE TABLE t_dq_rule (
    id BIGINT PRIMARY KEY,
    rule_name VARCHAR(100),
    rule_type VARCHAR(20),          -- FIELD / BUSINESS / CROSS_TABLE
    rule_dql TEXT,                  -- DQL 表达式
    severity VARCHAR(10),           -- BLOCK(拦截) / WARN(告警) / QUARANTINE(隔离)
    version INT,
    gray_percent INT,               -- 灰度比例 0-100
    enabled TINYINT,
    INDEX idx_type_version (rule_type, version)
);
```

### 2.3 三层拦截链路

```java
@Service
@Slf4j
public class DataQualityGateway {

    private final SkuValidationService fieldValidator;
    private final BusinessRuleEngine ruleEngine;
    private final QuarantineRepository quarantineRepo;
    private final MeterRegistry metrics;

    /**
     * 事前拦截：同步校验，在写入主库前执行
     * 返回 false 表示拒绝写入
     */
    public QualityResult preCheck(SkuDTO sku, String source) {
        // 第一层：字段级校验（Hibernate Validator）
        ValidationResult fieldResult = fieldValidator.validate(sku);
        if (fieldResult.hasErrors()) {
            metrics.counter("dq.field_violation", "source", source).increment();
            return handleViolation(sku, fieldResult.getErrors(), Severity.BLOCK);
        }

        // 第二层：业务规则校验（Drools）
        List<RuleViolation> ruleViolations = ruleEngine.check(sku);
        if (!ruleViolations.isEmpty()) {
            RuleViolation v = ruleViolations.get(0);
            metrics.counter("dq.rule_violation", "rule", v.getRuleName()).increment();
            return handleViolation(sku, v.getErrors(), v.getSeverity());
        }

        return QualityResult.pass();
    }

    private QualityResult handleViolation(SkuDTO sku, Map<String,String> errors, Severity sev) {
        switch (sev) {
            case BLOCK:                            // 强拦截：拒绝写入
                throw new DataQualityBlockException(errors.toString());
            case QUARANTINE:                        // 隔离：进隔离区
                quarantineRepo.save(buildQuarantine(sku, errors));
                metrics.gauge("dq.quarantine_count", quarantineRepo.countPending());
                return QualityResult.quarantined();
            case WARN:                              // 告警：放行但告警
                log.warn("数据质量告警 sku={} errors={}", sku.getSkuId(), errors);
                return QualityResult.warn(errors);
            default:
                return QualityResult.pass();
        }
    }
}
```

### 2.4 隔离区机制

```sql
CREATE TABLE t_data_quarantine (
    id BIGINT PRIMARY KEY,
    entity_type VARCHAR(20),           -- SKU / ORDER / PRICE
    entity_id VARCHAR(32),
    entity_snapshot JSON,              -- 原始数据快照
    exception_code VARCHAR(50),        -- 违反的规则
    exception_detail TEXT,
    source VARCHAR(50),                -- 数据来源
    status VARCHAR(20),                -- PENDING / AUTO_FIXED / MANUAL_FIXED / REJECTED
    handler VARCHAR(50),               -- 处理人
    handle_time DATETIME,
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_status_create (status, create_time),
    INDEX idx_entity (entity_type, entity_id)
) COMMENT='数据质量隔离区';
```

```java
// 隔离数据自动修复策略
@Service
public class QuarantineAutoFixer {

    @Scheduled(fixedDelay = 60_000)
    public void autoFix() {
        List<QuarantineRecord> pendings = quarantineRepo.findPending();
        for (QuarantineRecord r : pendings) {
            FixStrategy strategy = strategyFactory.get(r.getExceptionCode());
            if (strategy != null && strategy.canAutoFix(r)) {
                SkuDTO fixed = strategy.fix(r);
                try {
                    dataQualityGateway.preCheck(fixed, "AUTO_FIX");
                    skuRepo.upsert(fixed);
                    quarantineRepo.markFixed(r.getId(), "AUTO_FIX");
                } catch (Exception e) {
                    quarantineRepo.escalate(r.getId());  // 升级人工
                }
            } else {
                quarantineRepo.escalate(r.getId());      // 24h 未处理升级
            }
        }
    }
}
```

## 三、实战层：事后对账与质量看板

### 3.1 T+1 离线对账（一致性维度核心）

```java
@Service
public class ReconciliationJob {

    /**
     * 对账：主库 vs ES 索引（库存一致性）
     * 差异超阈值告警并触发补偿
     */
    @Scheduled(cron = "0 0 2 * * ?")   // 每天凌晨 2 点
    public void reconcileStock() {
        long total = skuRepo.count();
        long diff = 0;
        int pageSize = 5000;
        for (int offset = 0; offset < total; offset += pageSize) {
            List<SkuDTO> dbBatch = skuRepo.findBatch(offset, pageSize);
            Map<String, Integer> esStock = esClient.mgetStock(
                dbBatch.stream().map(SkuDTO::getSkuId).collect(toList()));
            for (SkuDTO sku : dbBatch) {
                Integer esVal = esStock.get(sku.getSkuId());
                if (esVal == null || !esVal.equals(sku.getStock())) {
                    diff++;
                    // 自动补偿：把主库值同步到 ES
                    esClient.updateStock(sku.getSkuId(), sku.getStock());
                    metrics.counter("dq.reconcile_diff", "type", "STOCK").increment();
                }
            }
        }
        double diffRate = (double) diff / total;
        metrics.gauge("dq.reconcile_diff_rate", diffRate);
        if (diffRate > 0.001) {   // 差异率超 0.1% 告警
            alertService.send("库存对账差异率 " + df.format(diffRate * 100) + "%");
        }
    }
}
```

### 3.2 实时流式校验（及时性 + 异常模式检测）

```java
// Flink 流式：监测价格突增突降（疑似标错）
// 数据流：CDC binlog -> Kafka -> Flink -> 告警
public class PriceAnomalyDetector extends KeyedProcessFunction<String, PriceChange, Alert> {

    @Override
    public void processElement(PriceChange change, Context ctx, Collector<Alert> out) {
        PriceState state = getState(change.getSkuId());
        double prevPrice = state.getLastPrice();
        double ratio = change.getNewPrice() / prevPrice;
        // 价格变动超过 5 倍（涨或跌）判定为异常
        if (ratio > 5.0 || ratio < 0.2) {
            out.collect(new Alert("PRICE_ANOMALY",
                change.getSkuId() + " 价格从 " + prevPrice + " 变为 " + change.getNewPrice()));
        }
        state.update(change.getNewPrice());
    }
}
```

### 3.3 数据质量评分看板

```java
// 六维评分，加权汇总
public class DataQualityScoreCalculator {
    public QualityScore calculate(String domain) {
        return QualityScore.builder()
            .completeness(calcCompleteness(domain))     // 非空率
            .accuracy(calcAccuracy(domain))             // 规则通过率
            .consistency(1 - reconcileDiffRate(domain)) // 1 - 对账差异率
            .uniqueness(calcUniqueness(domain))         // 去重率
            .timeliness(calcTimeliness(domain))         // 新鲜度达标率
            .validity(calcValidity(domain))             // 格式合规率
            .build()
            .weightedScore(                             // 加权
                w(0.25), w(0.25), w(0.20), w(0.10), w(0.10), w(0.10));
    }
}
// data_quality_score < 80 触发治理任务工单
```

## 四、底层本质：拦截强度 vs 可用性的权衡

数据质量的核心矛盾是"强拦截 vs 高可用"。强校验（BLOCK）能保证脏数据进不来，但一旦规则配错（误判合法数据为脏），会阻断正常业务写入。解法是**按链路重要性分级**：

- **核心交易链路**（下单、支付）：强校验，但规则必须充分测试，失败有降级路径
- **数据中台/数仓 ETL**：中等校验，隔离可疑数据但不阻断整批
- **日志/监控数据**：弱校验，标记异常但不拒绝

**对账是最后的兜底**：即使事前拦截漏过脏数据，T+1 对账能发现一致性偏差并自动补偿。这是"防御纵深"思想在数据领域的应用——不依赖单点拦截。

## 五、AI 工程化深挖

1. **用 AI 自动发现数据质量规则怎么做？**
   AI 扫描历史数据学习字段分布（price 字段 95% 在 1-9999 元），自动生成候选规则（price BETWEEN 0.01 AND 99999）。异常值（price=999999）标记为疑似规则违反。规则经数据分析师确认后入库，避免 AI 生成的规则误判正常边缘值。

2. **AI 自动修复隔离数据怎么保证不修错？**
   AI 只对"有明确修复规则"的低风险场景介入（如缺失默认值填充）。修复前做 dry-run，修复后重新跑校验。高风险修复（改价格、改库存）必须人工确认。监控 auto_fix_acceptance_rate（AI 修复被采纳率），低于阈值回退到全人工。

3. **怎么用 LLM 做数据质量的自然语言查询？**
   用户问"昨天哪些类目的数据质量最差"，LLM 翻译成 SQL 查 dq_score 表。但 LLM 生成的 SQL 必须走白名单（只读账号、限定表），防止注入。结果用图表展示并附置信度。

4. **数据血缘怎么辅助质量追溯？**
   记录每个字段的来源（source system）、变换链路（ETL pipeline）、消费方。一旦发现质量问题，沿血缘回溯到根因源头（是上游接口传错了，还是 ETL 算错了），并通知下游受影响方。血缘用图数据库（Neo4j）存储。

5. **RAG 知识库的数据质量怎么保证？**
   RAG 是数据质量的高阶场景：文档切片的完整性、embedding 的新鲜度、引用的准确性都要校验。建 dq_rag 专属规则：chunk 长度分布、index_freshness_seconds、answer_citation_rate。回答前对检索文档跑一次质量校验，隔离过期或损坏的 chunk。

## 六、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"六维度、三层拦截、隔离区、对账兜底"** 四个词。

- **六维度**：完整性、准确性、一致性、唯一性、及时性、有效性
- **三层拦截**：事前同步校验（字段 Validator + 业务 Drools）、事中 Flink 实时、事后 T+1 对账
- **隔离区**：quarantine 表 + exception_code，自动修复/人工审核/退回源头
- **对账兜底**：主库 vs ES/数仓，diff_rate > 0.1% 告警并补偿

### 面试现场 60 秒回答

> 数据质量平台我按六维度（完整性/准确性/一致性/唯一性/及时性/有效性）建三层拦截。事前用 Hibernate Validator 做字段校验，复杂业务规则用 Drools（配置化、版本化、可灰度），严重性分 BLOCK（拒绝）/QUARANTINE（隔离）/WARN（告警）三档。脏数据进 quarantine 表，走自动修复（低风险）或人工审核（高风险）。事中用 Flink 流式监测异常模式（价格突增 5 倍告警）。事后 T+1 跑对账（主库 vs ES 索引库存），diff_rate > 0.1% 触发补偿。核心指标 data_valid_rate（校验通过率）、quarantine_count（隔离量）、reconcile_diff_rate（对账差异率）、data_quality_score（六维加权评分），低于 80 分触发治理工单。最容易翻车的是强校验误判合法数据阻断主链路——所以规则要灰度，BLOCK 只用在核心链路且有降级路径。

## 七、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不直接让上游保证数据质量，要建中台校验？ | 上游多且不可控（外部接口/人工录入），中台是最后防线。但中台发现质量问题要回流上游（退回+告警），形成闭环。用 upstream_defect_rate 衡量上游质量 |
| 证据追问 | 怎么证明数据质量平台有效？ | 对比上线前后：quarantine_count 应该下降（上游被规则倒逼改善）、reconcile_diff_rate 应该趋近 0、下游报表错误工单数下降 |
| 边界追问 | 数据质量平台解决不了什么？ | 解决不了业务规则错误（规则本身写错）、解决不了实时性要求 < 秒级的强一致（对账是 T+1）、解决不了数据语义错误（值合法但含义错） |
| 反例追问 | 什么场景不上数据质量平台？ | 数据量小（< 万级）人工抽检足够、原型验证阶段、数据只写不读的临时表。这些过度设计 |
| 风险追问 | 强校验 BLOCK 阻断主链路怎么办？ | 规则充分测试 + 灰度发布（先 WARN 跑一周看误判率）+ 降级开关（规则异常时临时降级为 WARN）+ 监控 dq_false_block_rate（误拦截率） |
| 验证追问 | 怎么验证校验规则正确？ | 规则测试集：正例（合法数据必须 pass）+ 反例（脏数据必须 fail）。每次规则变更跑回归测试。线上采样人工复核 dq_false_block_rate |
| 沉淀追问 | 团队数据质量规范沉淀什么？ | 字段约束注解规范、Drools 规则模板、quarantine 处理 SOP、六维评分看板、对账任务模板、Code Review 检查项（必查字段校验） |

### 现场对话示例

**面试官**：你说规则用 Drools 配置化，但规则改错了线上崩了怎么办？

**候选人**：规则走版本化和灰度。新规则先以 WARN 模式灰度 10% 流量跑一周，看 dq_false_block_rate（误拦截率）和 quarantine 增量。误拦截率 < 0.01% 才升到 QUARANTINE/BLOCK 全量。规则表带 version 和 gray_percent 字段，可秒级回滚到上一版本。极端情况有全局降级开关——所有 BLOCK 临时降为 WARN，保证主链路可用。

**面试官**：对账发现 ES 和主库库存不一致，怎么处理？

**候选人**：先看不一致的规模和方向。如果 ES 比 DB 少（消费者看到库存偏低，保守），自动补偿把 DB 值同步到 ES 即可。如果 ES 比 DB 多（可能超卖），不能直接覆盖 ES（可能正在下单），要先冻结相关 SKU 的下单，确认无在途订单后再同步，同步后解冻。所有补偿记录到 reconcile_log 表，可审计。diff_rate > 1% 不自动补偿，告警人工介入排查根因（是同步链路断了还是数据被恶意篡改）。

## 常见考点

1. **数据质量六维度怎么记？**——完整性（非空）、准确性（值对）、一致性（跨系统同）、唯一性（不重复）、及时性（延迟可控）、有效性（格式合规）。口诀"完准一唯及有"。
2. **强校验和弱校验怎么选？**——核心交易链路用强校验（BLOCK 拒绝），但有降级路径；非核心用弱校验（WARN/QUARANTINE）。判断依据是"脏数据漏过的业务损失"vs"误拦截的可用性损失"。
3. **对账为什么是 T+1 不是实时？**——实时对账成本高（双流 JOIN），T+1 批量对账覆盖大部分场景。资金级强一致用实时对账（Flink 双流），一般数据用 T+1。
4. **数据血缘有什么用？**——质量追溯（发现问题回溯根因）、影响分析（源头改动评估下游影响）、合规审计（GDPR 数据删除要追溯所有副本）。

## 结构化回答

**30 秒电梯演讲：** 数据质量平台的核心是把脏数据进、净数据出做成一条可量化、可拦截、可回溯的流水线。用规则引擎（Drools/自研 DSL）声明字段约束（非空/枚举/范围/正则/跨表一致），在写入前做同步校验、写入后做异步巡检，异常数据进隔离区（quarantine）人工或规则兜底。本质是用事前拦截 + 事后对账 + 指标看板把数据可信度从靠人盯变成靠系统保证

**展开框架：**
1. **六大质量维度** — 完整性（非空）、准确性（值正确）、一致性（跨表/跨系统）、唯一性（无重复）、及时性（延迟可控）、有效性（格式合规）
2. **三层拦截** — 事前（写入前同步校验，失败拒绝）、事中（Flink 流式实时校验）、事后（离线批量巡检对账）
3. **规则引擎** — DQL（Data Quality Language）声明规则，规则可版本化、可灰度、可热更

**收尾：** 以上是我的整体思路。您想继续深入聊——规则引擎选 Drools 还是自研？


## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：数据质量平台与异常数据拦截 | "这题一句话：数据质量平台的核心是把脏数据进、净数据出做成一条可量化、可拦截、可回溯的流水线。" | 开场钩子 |
| 0:15 | 六大质量维度示意/对比图 | "完整性（非空）、准确性（值正确）、一致性（跨表/跨系统）、唯一性（无重复）、及时性（延迟可控）、有效性（格式合规）" | 六大质量维度要点 |
| 0:40 | 三层拦截示意/对比图 | "事前（写入前同步校验，失败拒绝）、事中（Flink 流式实时校验）、事后（离线批量巡检对账）" | 三层拦截要点 |
| 1:25 | 总结卡 | "记住：六维度。下期见。" | 收尾 |
