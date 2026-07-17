---
id: java-architect-061
difficulty: L2
category: java-architect
subcategory: 交易架构
tags:
- Java 架构师
- 结算清分
- 批处理
- 准实时
feynman:
  essence: 结算清分是"谁该给谁多少钱"的计算。用户买商家商品付 100 元，平台抽佣 5 元，实际商家得 95 元——这个"拆分算钱"的过程叫清分（算出应收应付），实际打款给商家叫结算（资金划转）。架构挑战是"数据量大（千万级订单/天）+ 规则复杂（不同类目佣金不同/促销补贴分摊）+ 资金准确（一分不能错）"。解法是"批处理（T+1 全量清分）+ 准实时（分钟级增量，大额即时结算）"分层。
  analogy: 像餐厅结账。一桌客人消费 500 元（用优惠券 -50，实付 450）。餐厅要算：厨房成本 200（食材）、服务员提成 45（10%）、平台抽佣 22.5（5%）、餐厅利润 182.5。这个"500 元怎么分"就是清分。如果餐厅每天打烊后统一算所有桌的账（批处理），就是 T+1 结算。如果每桌结完立刻给服务员提成（准实时），就是实时结算。
  first_principle: 为什么不每笔订单实时结算？因为结算涉及"批量聚合"——商家的佣金是按日汇总计算的（不是每单单独打款，打款有手续费），促销补贴要按活动汇总核销。实时结算会触发海量打款请求（银行接口扛不住+手续费高）。解法是"清分准实时（算钱快，但不打款）+ 结算批处理（聚合后批量打款）"——算和付分离。
  key_points:
  - 清分（算钱）：按规则把订单金额拆分给各方（商家/平台/物流/营销补贴）
  - 结算（付钱）：资金划转，T+1 批量打款给商家
  - 批处理：大数据量跑批（Spark/Flink 批），日终全量清分
  - 准实时：增量清分（Flink 流），大额订单优先结算
  - 分账规则引擎：佣金/补贴/分摊规则配置化
first_principle:
  problem: 千万级订单/天，怎么准确计算各方应收应付，并高效完成资金结算？
  axioms:
  - 数据量大（千万订单/天），逐笔实时计算成本高
  - 规则复杂（佣金按类目/补贴按活动/分摊按比例）
  - 资金必须准确（清分错了结算就错，商家投诉/亏损）
  - 结算批量（打款有手续费，不能每单单独打）
  rebuild: 清分结算分离 + 批准实时分层。清分准实时——订单完成后 Flink 流式计算，增量拆分金额到各方"待结算账户"。结算批处理——日终 Spark 跑批，聚合各商家当日待结算金额，批量打款。分账规则引擎配置化（类目佣金/促销分摊/物流费）。监控清分 RT、结算成功率、资金差异率。
follow_up:
  - 清分规则怎么配置化？——规则引擎（和价格系统类似），规则 DSL 描述佣金/分摊逻辑，配置存 DB，引擎解释执行。
  - 大额订单怎么即时结算？——准实时链路监听大额订单（> 1 万），触发优先清分+即时结算（不等 T+1）。
  - 结算失败（打款失败）怎么处理？——重试（银行接口抖动）+ 人工介入（账户异常）+ 挂账（待处理队列）。
  - 跨境结算怎么做？——汇率换算（实时汇率）+ 跨境支付通道（SWIFT/第三方）+ 合规（外汇申报）。
  - 商家对账怎么支持？——提供商家对账单（每日结算明细），商家可下载核对，差异可申诉。
memory_points:
  - 清分算钱，结算付钱
  - 清分准实时（Flink），结算批处理（Spark/日终）
  - 分账规则：佣金/补贴/分摊，配置化
  - 批量打款（省手续费）
  - 对账：清分结果 vs 结算金额 vs 银行流水
---

# 【Java 后端架构师】结算清分系统的批处理与准实时架构

> 适用场景：JD 资金中台。用户买商家一台 iPhone 付 5999，但这 5999 不是全给商家——平台抽佣 2%（119.98）、物流费 20、营销补贴分摊 100（平台承担）、商家实得 5759.02。算清楚"5999 怎么分"是清分，把钱打给商家是结算。千万级订单/天，清分要准、结算要稳、对账要闭环。

## 一、概念层：清分结算全景

**清分 vs 结算**（核心区分）：

```
订单完成（用户确认收货）
       │
       ▼
┌──────────────────────────────────────────────┐
│ 清分（算钱）：按规则拆分订单金额到各方           │
│                                                │
│   订单 5999 元                                 │
│      ├─ 平台佣金 119.98（2%）                   │
│      ├─ 物流费 20                               │
│      ├─ 营销补贴分摊 100（平台承担）             │
│      └─ 商家应得 5759.02                        │
│                                                │
│   结果：各方的"应收应付"账目（还没真打款）        │
└──────────────────────────────────────────────┘
       │ 写入"待结算"账户
       ▼
┌──────────────────────────────────────────────┐
│ 结算（付钱）：T+1 批量打款                      │
│                                                │
│   聚合商家 A 当日所有订单应得：                  │
│     订单1: 5759.02                             │
│     订单2: 3000                                │
│     订单3: 1500                                │
│     合计: 10259.02                             │
│                                                │
│   批量打款 10259.02 到商家 A 银行账户            │
└──────────────────────────────────────────────┘
```

**为什么清分和结算分离**：

| 维度 | 清分（算） | 结算（付） |
|------|-----------|-----------|
| 时机 | 订单完成后即可（准实时） | T+1 批量（日终） |
| 频率 | 每笔订单算一次 | 每商家每日聚合一次 |
| 依赖 | 订单数据 + 规则 | 银行接口 |
| 成本 | 计算成本（低） | 打款手续费（高，所以批量） |
| 失败影响 | 算错可重算 | 打错钱难追回（高风险） |

**批处理 vs 准实时分层**：

```
准实时清分（Flink 流）              批处理结算（Spark/日终）
┌────────────────────┐            ┌────────────────────┐
│ 订单完成事件 → MQ   │            │ 每日凌晨 1 点触发    │
│        ↓            │            │        ↓            │
│ Flink 消费订单      │            │ 聚合各商家待结算额   │
│ 实时清分算钱        │            │ 批量调银行打款接口   │
│ 写"待结算"账户      │            │ 更新结算状态        │
│        ↓            │            │ 生成结算单          │
│ 延迟 < 1 分钟       │            │ 延迟 T+1            │
└────────────────────┘            └────────────────────┘
适用于：所有订单（准实时算钱）       适用于：批量打款（省手续费）
```

## 二、机制层：清分规则引擎

**分账规则模型**：

```java
/**
 * 分账规则：描述订单金额怎么拆分
 */
public interface SettlementRule {
    String getRuleId();
    int getPriority();
    boolean matches(SettlementContext ctx);
    SplitResult split(SettlementContext ctx);
}

/**
 * 佣金规则：按类目抽佣
 */
@Component
public class CommissionRule implements SettlementRule {

    @Autowired private CategoryConfigRepo categoryConfig;

    @Override
    public String getRuleId() { return "COMMISSION"; }

    @Override
    public int getPriority() { return 10; }

    @Override
    public boolean matches(SettlementContext ctx) {
        return ctx.getOrderAmount().compareTo(BigDecimal.ZERO) > 0;
    }

    @Override
    public SplitResult split(SettlementContext ctx) {
        // 按商品类目查佣金率
        BigDecimal rate = categoryConfig.getCommissionRate(ctx.getCategoryId());
        BigDecimal commission = ctx.getOrderAmount().multiply(rate)
            .setScale(2, HALF_UP);
        return SplitResult.builder()
            .accountType("PLATFORM_INCOME")
            .amount(commission)
            .description("类目佣金 " + rate.multiply(new BigDecimal("100")) + "%")
            .build();
    }
}

/**
 * 营销补贴分摊规则：促销补贴平台承担
 */
@Component
public class MarketingSubsidyRule implements SettlementRule {

    @Override
    public String getRuleId() { return "MARKETING_SUBSIDY"; }

    @Override
    public int getPriority() { return 20; }

    @Override
    public boolean matches(SettlementContext ctx) {
        return ctx.getSubsidyAmount().compareTo(BigDecimal.ZERO) > 0;
    }

    @Override
    public SplitResult split(SettlementContext ctx) {
        return SplitResult.builder()
            .accountType("MARKETING_SUBSIDY")  // 平台营销账户出
            .amount(ctx.getSubsidyAmount())
            .description("促销补贴平台承担")
            .build();
    }
}
```

**清分引擎（链式执行规则）**：

```java
@Service
public class SettlementEngine {

    @Autowired private List<SettlementRule> rules;

    /**
     * 清分：把订单金额拆分给各方
     */
    public SettlementResult settle(Order order) {
        SettlementContext ctx = buildContext(order);
        List<SplitResult> splits = new ArrayList<>();
        BigDecimal totalSplit = BigDecimal.ZERO;

        // 按优先级执行规则
        List<SettlementRule> sortedRules = rules.stream()
            .sorted(Comparator.comparingInt(SettlementRule::getPriority))
            .collect(Collectors.toList());

        for (SettlementRule rule : sortedRules) {
            if (rule.matches(ctx)) {
                SplitResult split = rule.split(ctx);
                splits.add(split);
                totalSplit = totalSplit.add(split.getAmount());
            }
        }

        // 商家应得 = 订单金额 - 其他各方分账
        BigDecimal merchantAmount = order.getAmount().subtract(totalSplit);
        splits.add(SplitResult.builder()
            .accountType("MERCHANT")
            .accountId(order.getMerchantId())
            .amount(merchantAmount)
            .description("商家应得")
            .build());

        // 校验：各方分账之和 = 订单金额（资金守恒）
        BigDecimal total = splits.stream()
            .map(SplitResult::getAmount)
            .reduce(BigDecimal.ZERO, BigDecimal::add);
        if (total.compareTo(order.getAmount()) != 0) {
            monitor.record("settle_split_mismatch", order.getId(), total);
            throw new SettlementMismatchException("清分金额不守恒");
        }

        return new SettlementResult(order.getId(), splits);
    }
}
```

## 三、机制层：准实时清分（Flink）

**Flink 流式清分**：

```java
/**
 * Flink 作业：消费订单完成事件，实时清分
 */
public class RealtimeSettlementJob {

    public static void main(String[] args) throws Exception {
        StreamExecutionEnvironment env = StreamExecutionEnvironment.getExecutionEnvironment();

        // 1. 消费订单完成事件（Kafka）
        DataStream<OrderEvent> orders = env.addSource(
            new FlinkKafkaConsumer<>("order-completed",
                new OrderEventSchema(), kafkaProps()));

        // 2. 清分计算（每条订单算一次）
        DataStream<SettlementResult> settlements = orders
            .keyBy(OrderEvent::getOrderId)
            .process(new SettlementFunction());

        // 3. 写入"待结算"账户（账户系统）
        settlements.addSink(new AccountSink());

        // 4. 大额订单触发即时结算
        settlements
            .filter(s -> s.getMerchantAmount().compareTo(THRESHOLD) > 0)
            .addSink(new InstantSettlementSink());  // 大额立即结算

        env.execute("Realtime Settlement");
    }
}

/**
 * 清分函数：调用清分引擎
 */
class SettlementFunction extends KeyedProcessFunction<String, OrderEvent, SettlementResult> {

    private transient SettlementEngine engine;

    @Override
    public void open(Configuration parameters) {
        engine = SpringContext.getBean(SettlementEngine.class);
    }

    @Override
    public void processElement(OrderEvent order, Context ctx,
                                Collector<SettlementResult> out) throws Exception {
        try {
            SettlementResult result = engine.settle(order);
            out.collect(result);
            monitor.record("realtime_settle_success", order.getOrderId());
        } catch (Exception e) {
            monitor.record("realtime_settle_failed", order.getOrderId());
            // 失败进重试队列
            ctx.output(retryTag, order);
        }
    }
}
```

## 四、机制层：批处理结算（Spark/日终）

**批量结算服务**：

```java
@Service
public class BatchSettlementService {

    /**
     * T+1 批量结算：每日凌晨跑批
     */
    @Scheduled(cron = "0 0 1 * * ?")   // 每日凌晨 1 点
    public void dailySettlement() {
        LocalDate settleDate = LocalDate.now().minusDays(1);   // 结算昨天

        // 1. 聚合各商家昨日待结算金额
        List<MerchantSettlement> settlements = settlementRepo
            .aggregateByMerchant(settleDate);

        // 2. 批量调银行打款接口
        for (MerchantSettlement s : settlements) {
            try {
                // 幂等检查（防重复打款）
                if (settlementRepo.isSettled(s.getMerchantId(), settleDate)) {
                    continue;
                }

                // 调银行打款
                PaymentResult result = bankClient.transfer(
                    s.getMerchantBankAccount(),
                    s.getTotalAmount(),
                    s.getSettlementId());

                if (result.isSuccess()) {
                    // 更新结算状态
                    settlementRepo.markSettled(s.getMerchantId(),
                        settleDate, result.getBankTxnId());
                    monitor.record("settle_success", s.getMerchantId(),
                        s.getTotalAmount());
                } else {
                    // 打款失败：挂账待处理
                    settlementRepo.markFailed(s.getMerchantId(),
                        settleDate, result.getErrorMsg());
                    monitor.record("settle_failed", s.getMerchantId(),
                        result.getErrorMsg());
                    alertService.send("结算打款失败", s);
                }
            } catch (Exception e) {
                log.error("结算异常 merchant={}", s.getMerchantId(), e);
                settlementRepo.markFailed(s.getMerchantId(), settleDate,
                    e.getMessage());
            }
        }

        // 3. 生成结算日报
        generateDailyReport(settleDate);
    }

    /**
     * 聚合 SQL（按商家汇总待结算金额）
     */
    // SELECT merchant_id,
    //        SUM(merchant_amount) as total_amount,
    //        COUNT(*) as order_count
    // FROM t_settlement_detail
    // WHERE settle_date = #{date} AND status = 'PENDING'
    // GROUP BY merchant_id
}
```

**结算失败重试**：

```java
@Service
public class SettlementRetryService {

    /**
     * 每 10 分钟重试失败的结算
     */
    @Scheduled(fixedDelay = 10 * 60 * 1000)
    public void retryFailedSettlements() {
        List<MerchantSettlement> failed = settlementRepo
            .findFailedForRetry();

        for (MerchantSettlement s : failed) {
            if (s.getRetryCount() >= 3) {
                // 重试 3 次仍失败，转人工
                settlementRepo.markManualRequired(s);
                alertService.send("结算需人工处理", s);
                continue;
            }
            // 重试打款
            retrySettlement(s);
        }
    }
}
```

## 五、底层本质：清分结算的本质是"资金分配的准确与高效"

回到第一性：**清分结算的本质是"把交易金额按规则准确分配给各方，并高效完成资金划转"**。

- **准确性**：清分算错一分钱，结算就打错一分，商家投诉/平台亏损。所以清分有"资金守恒"校验（各方分账之和 = 订单金额），结算有"幂等"防重复打款。这是金融级准确——容错率零。
- **高效性**：千万级订单/天，逐笔实时结算是灾难（银行接口扛不住+手续费高）。批处理聚合后批量打款——每商家一次打款，手续费省千倍。这是"聚合换效率"的工程智慧。
- **规则化**：清分规则复杂（佣金按类目、补贴按活动、分摊按比例），且频繁变化（运营调佣金率）。规则配置化（规则引擎）让运营自助修改，不发版。这是"业务与代码解耦"。
- **可追溯**：每笔清分有明细（订单→各方分账），每笔结算有记录（商家→金额→银行流水）。商家可查对账单，差异可申诉。这是"可审计性"——金融系统的合规要求。

**批处理 vs 准实时的本质是"延迟与效率的取舍"**：准实时清分延迟低（< 1 分钟算出应得），但结算如果也实时（每笔订单单独打款），手续费高+银行接口压力大。批处理结算延迟高（T+1 打款），但聚合后高效（一次打款结算千万订单）。分层后——清分准实时（快速算出应得，商家可查预期收益），结算批处理（高效打款），兼顾时效和成本。大额订单例外（即时结算，提升大商家体验）。

**资金守恒校验的本质是"防系统性错误"**：清分结果各方分账之和必须等于订单金额。这个不变式（invariant）保证钱不凭空多/少。如果校验失败（规则 bug 或计算错误），立即拦截不让写入——宁可延迟结算也不能算错账。这是"防御式编程"——用不变式捕获系统性 bug。

## 六、AI 架构师加问：5 个

1. **AI 预测商家结算资金需求，优化打款时机，怎么做？**
   AI 根据商家历史结算模式（周期/金额/资金周转）预测"何时打款对商家最有利"。如供应链商家需要资金备货，AI 建议提前结算（T+0 而非 T+1）。但这是"建议"，需商家授权。京东金融实践：AI 预测结算资金需求，提供"秒到账"服务（付费提前结算）。

2. **AI 检测异常结算（商家薅羊毛/虚假交易），怎么做？**
   AI 监控清分结果异常——如某商家单日应得金额突增 10 倍（可能刷单套现）、佣金率异常低（可能配置错误）、退款率异常高（可能虚假交易）。AI 用异常检测识别，异常结算挂起人工审核。京东风控：AI 拦截万级异常结算/天。

3. **AI 优化清分规则（动态佣金），怎么做？**
   AI 根据商品品类利润率、市场竞争、商家等级动态调佣金——高利润品类佣金高，新商家优惠佣金。但这是"商业策略"，AI 只推荐，运营确认。京东实践：AI 推荐佣金方案，A/B 测试验证，验证后生效。

4. **AI 自动处理结算失败（银行退汇/账户异常），怎么做？**
   AI 学习历史结算失败处理案例，自动分类——"账户名不匹配"类（查工商数据修正）、"账户冻结"类（联系商家）、"银行限额"类（拆分打款）。AI 处理 70% 常见失败，30% 复杂的人工兜底。

5. **AI 预测结算系统的容量（双 11 清分峰值），怎么做？**
   AI 根据历史订单峰值、营销活动强度预测结算系统的负载（清分 QPS/结算笔数），提前扩容 Flink/Spark 集群。预测偏低系统崩（清分延迟），偏高资源浪费。京东双 11：AI 预测清分峰值，Flink 集群弹性扩容 3 倍。

## 七、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"清分算钱准实时、结算付钱批处理、规则引擎配置化、资金守恒校验"**。

- **清分（算）**：订单完成后 Flink 准实时算，按规则拆分给各方
- **结算（付）**：日终 Spark 批量聚合，批量打款给商家（省手续费）
- **分账规则**：佣金/补贴/分摊，规则引擎配置化
- **资金守恒**：各方分账之和 = 订单金额，校验拦截
- **幂等防重**：结算唯一键（merchant + date），防重复打款
- **对账闭环**：清分结果 vs 结算金额 vs 银行流水

### 面试现场 60 秒回答

> 结算清分系统核心是"清分算钱、结算付钱"分离。清分——订单完成后按规则把金额拆分给各方（平台佣金、物流费、营销补贴、商家应得），用 Flink 流式准实时计算（延迟 < 1 分钟），结果写入各方"待结算"账户。结算——日终 Spark 跑批，聚合各商家当日待结算金额，批量调银行接口打款（聚合省手续费）。分账规则用规则引擎配置化（CommissionRule/MarketingSubsidyRule 等），运营改佣金率不发版。资金守恒校验——各方分账之和必须等于订单金额，不守恒立即拦截（防规则 bug）。结算幂等——唯一键（merchant_id + settle_date），防重复打款。结算失败重试——重试 3 次仍失败转人工。大额订单特殊处理——准实时链路监听大额（> 1 万），触发即时结算（不等 T+1）。对账闭环——清分结果 vs 结算金额 vs 银行流水，三层核对。监控 settle_split_mismatch（清分不守恒数，应 0）、settle_failed_count（结算失败数）、settle_retry_count（重试数）。最关键的是"算准钱、批打款、对清账"——这是清分结算区别于普通批处理的金融本质。

## 八、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不实时结算（每笔订单完成立刻打款）？ | 实时结算问题：银行接口压力（千万笔/天打爆）、手续费高（每笔 0.5 元，千万笔 = 500 万）、聚合优惠（银行批量打款手续费低）。用 settle_latency（结算延迟，T+1 可接受）和 fee_cost（手续费成本，批量省 90%）量化 |
| 证据追问 | 怎么证明清分结算准确（钱没算错打错）？ | 资金守恒校验（分账和=订单额，0 异常）+ 结算幂等（不重复打款）+ 三方对账（清分vs结算vs银行）+ 商家对账单（商家核对）。监控 settle_split_mismatch（0）、double_settle_count（重复打款，0）、bank_diff_count（银行差异，0） |
| 边界追问 | 批处理结算能覆盖所有场景吗？ | 不能。大额订单需即时结算（供应链资金周转）、跨境结算需合规审核（不能全自动）。这些走特殊链路（准实时+人工审核） |
| 反例追问 | 什么场景不需要清分（直接全额给商家）？ | 自营商品（JD 自营，无第三方商家，不抽佣）、零佣金平台（C2C 免佣金拉新）。但分账（物流费/补贴）仍需算 |
| 风险追问 | 清分结算最大风险？ | 主动点出：清分算错（规则 bug/数据异常）、结算打错（账户错误/重复打款）、结算失败积压（银行接口抖动）、对账遗漏（差异未发现）。靠资金守恒+幂等+重试+对账组合防护 |
| 验证追问 | 怎么验证清分规则正确？ | 规则测试用例（每规则有断言）+ 压测（千万订单清分，验证 RT 和准确率）+ 灰度（新规则先 1% 订单验证）+ 对账（清分结果 vs 手工算的预期）。监控 rule_coverage（规则覆盖率）和 settle_accuracy（清分准确率，应 100%） |
| 沉淀追问 | 清分结算沉淀什么？ | 分账规则引擎（SettlementRule 接口）、清分框架（Flink 流式）、批量结算平台（Spark 跑批）、对账工具、结算监控大盘（清分 RT/结算成功率/资金差异率/失败重试率） |

### 现场对话示例

**面试官**：双 11 期间订单量暴增 10 倍，Flink 清分作业延迟积压（从 1 分钟到 30 分钟），怎么办？

**候选人**：三层应急。第一层，扩容——Flink TaskManager 横向扩容（增加并发度），Kafka 分区数匹配（消费者并行）。京东双 11 Flink 集群弹性扩容 3-5 倍。第二层，降级——非关键清分（小金额订单）延迟到夜间批处理补算，优先保证大额订单准实时清分。第三层，背压控制——如果 Kafka 积压严重，前端限流（限制订单完成速率），保护清分系统不崩。长期优化：清分逻辑下推到数据库（SQL 算分账，减少 Flink 计算量）、规则缓存（规则不每次查 DB）、异步写账户（先算后写，写异步）。监控 settle_lag（清分延迟）和 kafka_lag（消息积压），超阈值告警。极端情况清分彻底崩——启动兜底批处理（Spark 全量重算昨日订单），保证 T+1 结算不受影响。

**面试官**：清分时发现"订单金额 100，但分账之和 101"（多了 1 元），怎么处理？

**候选人**：这是资金守恒校验失败，立即拦截。第一步，不写入"待结算"账户（防止错误数据流转），该订单进"清分异常"队列。第二步，定位根因——可能是规则 bug（某规则多算了）、数据异常（订单金额字段错误）、精度问题（BigDecimal scale 设置不当）。第三步，查该订单的清分明细（每步规则的输入输出），找出哪一步多了 1 元。第四步，修复后重算（fix rule → 重清分）。第五步，如果批量订单都差（规则系统性 bug），暂停清分作业，修规则后全量重跑。第六步，告警——单订单异常 P2，批量异常 P0（可能影响 T+1 结算）。监控 settle_split_mismatch（清分不守恒数）必须为 0，任何非零都是 P0。京东的实践：清分有单元测试覆盖每条规则（断言分账之和=订单额），生产有实时校验（不守恒拦截），双保险。

**面试官**：商家投诉"昨天卖了 10 万的货，结算只有 8 万"，怎么排查？

**候选人**：第一步，查商家对账单——拉出该商家昨日所有订单的清分明细（每单分账详情），让商家核对哪一笔有异议。第二步，核对清分结果和结算金额——清分算出商家应得 10 万，但结算只打 8 万，差 2 万。可能原因：部分订单未结算（状态还是 PENDING）、结算打款失败（银行退汇）、聚合 SQL 漏算（某些订单没进聚合）。第三步，查每笔订单的结算状态——找出"应结算但未结算"的订单。第四步，查银行打款流水——确认实际打款金额和清分应得是否一致。第五步，修复——漏结算的补结算（幂等，不会重复打款），打款失败的重试。第六步，补偿——向商家解释并道歉，必要时补偿（如结算延迟利息）。监控 merchant_complaint_count（商家投诉数）和 settle_diff_count（结算差异数），差异率应 < 0.01%。京东的实践：商家对账单实时可查（APP/PC），差异申诉 SLA 24 小时响应。

## 常见考点

1. **清分和结算的区别？**——清分是"算"（拆分金额到各方），结算是"付"（资金划转）。清分准实时，结算批处理。清分错了可重算，结算错了难追回。
2. **结算为什么 T+1 而不是 T+0？**——T+1 留时间给清分跑全量（防止准实时遗漏）+ 对账（和银行核对）+ 异常处理。T+0 风险高（算错就打错了）。但大额/VIP 商家可 T+0（特殊链路）。
3. **分账规则怎么测试？**——每条规则有单元测试（断言分账结果）+ 集成测试（多规则组合）+ 压测（千万订单验证性能）+ 灰度（新规则小流量验证）。
4. **跨境结算和境内结算区别？**——跨境需汇率换算（实时汇率）+ 跨境支付通道（SWIFT/第三方）+ 合规（外汇申报/反洗钱）+ 时效慢（3-5 天 vs T+1）。

## 结构化回答



**30 秒电梯演讲：** 像餐厅结账。一桌客人消费 500 元（用优惠券 -50，实付 450）。餐厅要算：厨房成本 200（食材）、服务员提成 45（10%）、平台抽佣 22.5（5%）、餐厅利润 182.5。这个"500 元怎么分"就是清分。如果餐厅每天打...

**展开框架：**
1. **清分（算钱）** — 按规则把订单金额拆分给各方（商家/平台/物流/营销补贴）
2. **结算（付钱）** — 资金划转，T+1 批量打款给商家
3. **批处理** — 大数据量跑批（Spark/Flink 批），日终全量清分

**收尾：** 清分规则怎么配置化？




## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：结算清分系统的批处理与准实时架构 | "这题一句话：结算清分是谁该给谁多少钱的计算。" | 开场钩子 |
| 0:15 | 清分（算钱）示意/对比图 | "按规则把订单金额拆分给各方（商家/平台/物流/营销补贴）" | 清分（算钱）要点 |
| 0:40 | 结算（付钱）示意/对比图 | "资金划转，T+1 批量打款给商家" | 结算（付钱）要点 |
| 1:25 | 总结卡 | "记住：清分算钱。下期见。" | 收尾 |
