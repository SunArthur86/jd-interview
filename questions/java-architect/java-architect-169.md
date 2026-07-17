---
id: java-architect-169
difficulty: L2
category: java-architect
subcategory: 交易架构
tags:
- Java 架构师
- 售后
- 退款
- 对账
feynman:
  essence: 售后退款链路的本质是"订单状态机的逆向流程 + 资金回流一致性"。逆向流程：申请售后 → 审核 → 退货入库 → 退款，每步有状态机约束防止非法跳转。资金回流是核心难点：原路退回（微信/支付宝）要和支付渠道对接，退款可能失败（渠道超时/账户注销），必须幂等重试 + 对账兜底。
  analogy: 像超市退货——你拿商品和小票到服务台（申请售后），服务员核对（审核），商品退回货架（入库），钱原路退回你的卡（退款）。如果退钱时刷卡机坏了（渠道超时），要登记后续补退（对账兜底）。
  first_principle: 退款是"已完成的支付的反向操作"，但比支付更难——支付是"钱从用户到商家"，退款是"钱从商家退回用户"，需要原路返回（微信退微信、支付宝退支付宝）。退款可能因渠道问题失败，必须幂等重试 + T+1 对账发现差异。
  key_points:
  - 逆向状态机：APPLIED → APPROVED → RETURNING → RETURN_RECEIVED → REFUNDING → REFUNDED
  - 退款渠道：原路退回（微信/支付宝/银行卡）+ 余额退款（退到平台钱包）
  - 幂等：退款单号 + 渠道唯一请求号，防止重复退款
  - 对账：T+1 比对平台退款记录 vs 渠道实际到账，发现差异补偿
  - 部分退款：按子单/商品维度退，金额按比例拆分优惠
first_principle:
  problem: 用户申请退货退款，如何保证售后流程正确流转、退款金额准确、资金原路退回且不重复不遗漏？
  axioms:
  - 退款是支付的反向操作，必须原路退回（支付渠道限制）
  - 退款可能失败（渠道超时/账户注销/额度限制），必须可重试
  - 并发申请可能导致重复退款（用户多次点击），必须幂等
  - 退款金额要扣除已使用的优惠（满减/优惠券按比例退）
  - 平台记账和渠道实际到账可能有延迟，必须对账
  rebuild: 售后单走逆向状态机（APPLIED → APPROVED → RETURN_RECEIVED → REFUNDING → REFUNDED），每步状态机校验。退款走原路退回 + 幂等键（退款单号）防重复。退款失败重试（指数退避），仍失败进对账队列。T+1 对账：平台退款记录 vs 渠道流水，差异自动补偿。
follow_up:
  - 退款金额怎么算？——按比例退。订单原价 100，用了满减 20 实付 80，退一件商品原价 30。退款 = 30 × (80/100) = 24（按实付比例分摊优惠）。
  - 退款渠道怎么选？——优先原路退回（用户支付时用什么渠道退什么）。如果原渠道不可用（账户注销/银行卡失效），退到平台余额。极端情况线下转账。
  - 退款超时怎么处理？——退款请求超时（渠道未响应）不能假设成功也不能假设失败，查单确认（调渠道的退款查询接口）。查单也超时进人工对账。
  - 多笔退款怎么防重复？——幂等键 = 退款单号 + 渠道商户单号。渠道侧基于商户单号去重，同一商户单号只退一次。重试时用相同商户单号。
  - 对账发现差异怎么办？——三类：平台有退款记录渠道没有（可能渠道超时实际没退，补退）、渠道有记录平台没有（异常，排查）、金额不一致（人工核实）。监控 reconcile_diff_rate。
memory_points:
  - 逆向状态机：APPLIED → APPROVED → RETURNING → RETURN_RECEIVED → REFUNDING → REFUNDED
  - 原路退回：微信/支付宝/银行卡，渠道不可用退余额
  - 幂等：退款单号 + 商户单号，防重复退款
  - 对账：T+1 平台 vs 渠道，差异自动补偿
  - 金额：按实付比例分摊优惠（满减/优惠券）
---

# 【Java 后端架构师】售后退款链路的状态机与对账

> 适用场景：JD 核心技术。用户收到商品不满意申请退货退款——但订单可能含多个商品（部分退）、用了满减券（退款金额要扣优惠）、支付用的微信（要原路退回微信）、微信退款可能超时（要查单确认）。架构师要设计的是一条"状态正确流转、金额精确计算、资金一致回流"的售后退款链路。

## 一、概念层：售后逆向状态机

```
┌─────────┐  审核   ┌──────────┐ 用户寄回 ┌──────────────┐ 仓库签收 ┌──────────────┐
│ APPLIED │────────►│ APPROVED │─────────►│ RETURNING    │─────────►│ RETURN_       │
│ 已申请   │         │ 已审核    │          │ 退货中       │          │ RECEIVED      │
└─────────┘         └──────────┘          └──────────────┘          │ 已收货        │
                         │                                           └──────┬───────┘
                         │ 拒绝                                                 │ 发起退款
                         ▼                                                      ▼
                    ┌──────────┐                                         ┌──────────────┐
                    │ REJECTED │                                         │ REFUNDING    │
                    │ 已拒绝    │                                         │ 退款中        │
                    └──────────┘                                         └──────┬───────┘
                                                                                │ 退款成功
                                                                                ▼
                                                                         ┌──────────────┐
                                                                         │ REFUNDED     │
                                                                         │ 已退款        │
                                                                         └──────────────┘
```

## 二、机制层：售后单状态机

```java
@Service
@Slf4j
public class AfterSaleService {

    // 合法状态跳转表
    private static final Map<AfterSaleStatus, Set<AfterSaleStatus>> TRANSITIONS = Map.of(
        APPLIED, Set.of(APPROVED, REJECTED, CANCELLED),
        APPROVED, Set.of(RETURNING),                    // 审核通过进入退货
        RETURNING, Set.of(RETURN_RECEIVED, CANCELLED),  // 用户寄回 → 仓库签收
        RETURN_RECEIVED, Set.of(REFUNDING),             // 签收后退款
        REFUNDING, Set.of(REFUNDED, REFUND_FAILED)      // 退款中 → 成功/失败
    );

    @Transactional
    public void transition(Long afterSaleId, AfterSaleEvent event) {
        AfterSale as = afterSaleRepo.findById(afterSaleId);
        AfterSaleStatus target = resolveTarget(as.getStatus(), event);

        // 状态机校验
        if (!TRANSITIONS.getOrDefault(as.getStatus(), Set.of()).contains(target)) {
            metrics.counter("aftersale.illegal_transition",
                "from", as.getStatus().name(), "to", target.name()).increment();
            throw new IllegalTransitionException(
                "非法跳转: " + as.getStatus() + " → " + target);
        }

        // 乐观锁更新
        int affected = afterSaleRepo.updateStatus(
            afterSaleId, target, as.getStatus(), as.getVersion());
        if (affected == 0) {
            throw new ConcurrentConflictException("并发冲突");
        }

        // 状态变更日志（审计）
        afterSaleLogRepo.save(new AfterSaleLog(afterSaleId, as.getStatus(), target, event));

        // 触发后续动作
        onTransition(as, target);
    }

    private void onTransition(AfterSale as, AfterSaleStatus target) {
        switch (target) {
            case APPROVED -> notifyUser("审核通过，请寄回商品");
            case RETURN_RECEIVED -> refundService.initiateRefund(as);  // 触发退款
            case REFUNDED -> notifyUser("退款已到账");
            case REFUND_FAILED -> retryQueue.enqueue(as);              // 失败重试
        }
    }
}
```

## 三、机制层：退款金额计算

```java
@Service
public class RefundCalculator {

    /**
     * 退款金额：按实付比例分摊优惠
     * 订单 100 元，满减 20 元实付 80 元，退一件商品原价 30 元
     * 退款 = 30 × (80/100) = 24 元
     */
    public BigDecimal calcRefundAmount(Order order, List<OrderItem> refundItems) {
        BigDecimal originalTotal = order.getItems().stream()
            .map(OrderItem::getOriginalPrice)
            .reduce(BigDecimal.ZERO, BigDecimal::add);     // 100

        BigDecimal paidTotal = order.getActualPayAmount();  // 80

        // 退款商品原价合计
        BigDecimal refundOriginal = refundItems.stream()
            .map(i -> i.getOriginalPrice().multiply(BigDecimal.valueOf(i.getQuantity())))
            .reduce(BigDecimal.ZERO, BigDecimal::add);     // 30

        // 按比例分摊
        BigDecimal ratio = paidTotal.divide(originalTotal, 4, RoundingMode.HALF_UP);
        BigDecimal refund = refundOriginal.multiply(ratio)
            .setScale(2, RoundingMode.HALF_UP);            // 24.00

        // 校验：退款总额不能超实付
        if (refund.compareTo(paidTotal) > 0) {
            refund = paidTotal;                              // 全退
        }
        return refund;
    }
}
```

## 四、机制层：退款执行（幂等 + 原路退回）

```java
@Service
@Slf4j
public class RefundService {

    private final PaymentChannelClient channelClient;    // 支付渠道
    private final RefundRepo refundRepo;

    /**
     * 发起退款：原路退回 + 幂等防重复
     */
    @Transactional
    public void initiateRefund(AfterSale as) {
        // 1. 创建退款单（幂等键 = 售后单号）
        String refundNo = generateRefundNo(as.getId());
        if (refundRepo.existsByRefundNo(refundNo)) {
            log.info("退款单已存在，跳过 refundNo={}", refundNo);
            return;     // 幂等：已创建不重复
        }

        Order order = orderRepo.findById(as.getOrderId());
        BigDecimal amount = refundCalculator.calcRefundAmount(order, as.getRefundItems());

        RefundOrder refund = RefundOrder.builder()
            .refundNo(refundNo)
            .afterSaleId(as.getId())
            .orderId(order.getId())
            .userId(order.getUserId())
            .amount(amount)
            .originalChannel(order.getPayChannel())      // 原支付渠道
            .originalTradeNo(order.getPayTradeNo())      // 原支付流水号
            .status(REFUND_PROCESSING)
            .retryCount(0)
            .build();
        refundRepo.save(refund);

        // 2. 调用渠道退款
        executeRefund(refund);
    }

    private void executeRefund(RefundOrder refund) {
        try {
            // 幂等：商户单号 = refundNo，渠道侧基于此去重
            ChannelRefundRequest req = ChannelRefundRequest.builder()
                .merchantRefundNo(refund.getRefundNo())       // 幂等键
                .originalTradeNo(refund.getOriginalTradeNo())
                .amount(refund.getAmount())
                .channel(refund.getOriginalChannel())         // 原路退回
                .reason("用户申请退款")
                .build();

            ChannelRefundResult result = channelClient.refund(req);

            switch (result.getStatus()) {
                case SUCCESS -> {
                    refund.setStatus(REFUND_SUCCESS);
                    refund.setChannelRefundNo(result.getChannelRefundNo());
                    afterSaleService.transition(refund.getAfterSaleId(), REFUND_OK);
                }
                case PROCESSING -> {
                    // 退款处理中（渠道异步），等待回调或定时查单
                    refund.setStatus(REFUND_PROCESSING);
                    refund.setExpectedCallbackTime(Instant.now().plus(Duration.ofHours(24)));
                }
                case FAILED -> {
                    refund.setStatus(REFUND_FAILED);
                    refund.setFailReason(result.getFailReason());
                    retryQueue.enqueue(refund);              // 进重试队列
                }
            }
            refundRepo.save(refund);

        } catch (TimeoutException e) {
            // 超时不能假设成功也不能假设失败，查单确认
            refund.setStatus(REFUND_UNKNOWN);
            refundRepo.save(refund);
            queryQueue.enqueue(refund);                      // 进查单队列
        }
    }
}
```

## 五、机制层：退款重试与查单

```java
@Service
public class RefundRetryScheduler {

    /**
     * 退款失败重试（指数退避）
     */
    @Scheduled(fixedDelay = 60_000)
    public void retryFailed() {
        List<RefundOrder> failed = refundRepo.findFailedRetryable();
        for (RefundOrder refund : failed) {
            if (refund.getRetryCount() >= MAX_RETRY) {
                refund.setStatus(REFUND_MANUAL_REQUIRED);     // 进人工
                alertService.send("退款重试耗尽需人工: " + refund.getRefundNo());
                continue;
            }
            refund.incrementRetry();
            refund.setNextRetryTime(nextBackoff(refund.getRetryCount()));  // 指数退避
            refundService.executeRefund(refund);
        }
    }

    /**
     * 查单：超时/未知的退款调渠道查询接口确认状态
     */
    @Scheduled(fixedDelay = 30_000)
    public void queryUnknown() {
        List<RefundOrder> unknowns = refundRepo.findUnknownOrProcessing();
        for (RefundOrder refund : unknowns) {
            if (refund.getExpectedCallbackTime() != null
                && refund.getExpectedCallbackTime().isAfter(Instant.now())) {
                continue;   // 还没到查单时间
            }
            ChannelRefundStatus status = channelClient.queryRefund(
                refund.getRefundNo());
            switch (status) {
                case SUCCESS -> markSuccess(refund);
                case FAILED -> markFailed(refund);
                case PROCESSING -> refund.incrementQueryCount();  // 继续等
            }
        }
    }
}
```

## 六、机制层：T+1 对账

```java
@Service
public class RefundReconciliation {

    /**
     * T+1 对账：平台退款记录 vs 渠道实际流水
     */
    @Scheduled(cron = "0 0 3 * * ?")
    public void reconcile() {
        LocalDate yesterday = LocalDate.now().minusDays(1);

        // 1. 拉渠道退款流水
        List<ChannelRefundRecord> channelRecords = channelClient.downloadRefunds(yesterday);
        Map<String, ChannelRefundRecord> channelMap = channelRecords.stream()
            .collect(toMap(ChannelRefundRecord::getMerchantRefundNo, r -> r));

        // 2. 拉平台退款记录
        List<RefundOrder> platformRecords = refundRepo.findByDate(yesterday);

        // 3. 逐笔比对
        for (RefundOrder platform : platformRecords) {
            ChannelRefundRecord channel = channelMap.get(platform.getRefundNo());

            if (channel == null) {
                // 平台有记录，渠道没有：可能退款请求超时实际没退，补退
                if (platform.getStatus() == REFUND_SUCCESS) {
                    log.error("虚假退款！平台标记成功但渠道无记录: {}", platform.getRefundNo());
                    platform.setStatus(REFUND_FAILED);
                    refundService.executeRefund(platform);   // 补退
                    metrics.counter("reconcile.false_success").increment();
                }
            } else {
                // 金额校验
                if (platform.getAmount().compareTo(channel.getAmount()) != 0) {
                    log.error("退款金额不一致 platform={} channel={}",
                        platform.getAmount(), channel.getAmount());
                    alertService.send("退款金额差异: " + platform.getRefundNo());
                    metrics.counter("reconcile.amount_diff").increment();
                }
                // 状态校验
                if (platform.getStatus() != mapStatus(channel.getStatus())) {
                    platform.setStatus(mapStatus(channel.getStatus()));  // 以渠道为准
                }
            }
        }

        // 4. 反向检查：渠道有但平台没有的退款（异常）
        for (ChannelRefundRecord channel : channelRecords) {
            if (!refundRepo.existsByRefundNo(channel.getMerchantRefundNo())) {
                log.error("渠道有退款但平台无记录: {}", channel.getMerchantRefundNo());
                alertService.send("未知退款: " + channel.getMerchantRefundNo());
            }
        }

        metrics.gauge("reconcile.diff_rate", diffCount / total);
    }
}
```

## 七、底层本质：退款是"支付的逆操作但更难"

支付和退款的对比如下：

| 维度 | 支付 | 退款 |
|------|------|------|
| 方向 | 用户 → 商家 | 商家 → 用户 |
| 发起方 | 用户主动 | 系统发起 |
| 渠道约束 | 用户选渠道 | 必须原路退回 |
| 失败处理 | 失败就重试 | 失败要幂等重试 + 查单 |
| 对账 | 平台 vs 渠道收款 | 平台 vs 渠道退款 |

退款更难的核心原因：**原路退回约束 + 异步性**。支付时用户选了微信，退款必须退到当时的微信账户；但微信退款是异步的（可能几秒到几小时），期间状态不确定（超时不能假设成功也不能假设失败）。所以退款必须有"查单"机制兜底（调渠道查询接口确认实际状态），不能纯靠回调。

**幂等的本质**：用户可能多次点击"申请退款"，系统可能重试。幂等键（退款单号 / 商户单号）保证渠道侧只退一次。这是分布式系统"至少一次语义 + 幂等"的标准模式。

**对账的本质**：平台记账（退款成功）和渠道实际到账可能有延迟或差异（网络/系统故障）。T+1 对账是最终兜底——发现"平台说退了但渠道实际没退"（虚假退款，用户投诉）或"渠道退了但平台没记录"（资金泄漏）。监控 reconcile_diff_rate 趋近 0。

## 八、AI 工程化深挖

1. **用 AI 预测退款欺诈怎么做？**
   分析用户行为特征（退款频率、退款金额分布、账号年龄、收货地址变化），训练风险模型识别"羊毛党"（高频小额退款套利）。高风险退款人工审核，低风险自动通过。监控 fraud_detection_precision。

2. **LLM 辅助售后客服怎么做？**
   LLM 理解用户的售后诉求（"商品破损了想退"），自动填写售后单（商品 ID、问题描述、退款金额），查询售后政策判断合理性。但创建售后单和发起退款走确定性代码，LLM 只做理解和辅助填写。

3. **退款异常怎么智能归因？**
   退款失败有多种原因（渠道超时/账户注销/额度不足/风控拦截）。LLM 分析错误码 + 历史模式，推荐处理策略（超时→重试、注销→退余额、风控→人工）。归因结果存知识库辅助后续自动化。

4. **怎么用 AI 优化退款时效？**
   传统退款要等退货入库后才发起。AI 预测退货商品的可二次销售概率（商品状态/品类/历史退货质量），高概率的可以"极速退款"（收到退货单号即退款，不等入库），低概率走标准流程。监控 refund_speedup_rate 和 fraud_rate 平衡。

5. **售后链路怎么做 trace？**
   每个售后单生成 traceId，贯穿：申请 → 审核 → 退货物流 → 入库 → 退款 → 渠道回调。用户问"我的退款到哪了"时，查 trace 展示全链路节点和当前状态。渠道回调要带 traceId 关联。

## 九、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"逆向状态机、比例退款、原路幂等、T+1 对账"** 四个词。

- **逆向状态机**：APPLIED → APPROVED → RETURNING → RETURN_RECEIVED → REFUNDING → REFUNDED
- **比例退款**：按实付比例分摊优惠（满减/优惠券），退款 = 商品原价 × (实付/原价)
- **原路幂等**：原渠道退回 + 商户单号幂等，防重复退款
- **T+1 对账**：平台记录 vs 渠道流水，虚假退款补退、金额差异告警

### 面试现场 60 秒回答

> 售后退款我设计逆向状态机：APPLIED → APPROVED → RETURNING → RETURN_RECEIVED → REFUNDING → REFUNDED，每步状态机校验防非法跳转，乐观锁防并发冲突，状态变更日志审计。退款金额按实付比例分摊优惠——订单原价 100 满减 20 实付 80，退 30 元商品则退 30×(80/100)=24 元。退款执行原路退回（微信付的退微信），幂等键 = 退款单号 + 商户单号防重复，渠道侧基于商户单号去重。退款可能超时（渠道异步），超时不能假设成功也不能假设失败，进查单队列调渠道查询接口确认。失败重试指数退避，重试耗尽进人工。T+1 对账：平台退款记录 vs 渠道实际流水，三类差异——平台有渠道没有（虚假退款补退）、渠道有平台没有（异常排查）、金额不一致（人工核实）。监控 reconcile_diff_rate 趋近 0、refund_success_rate、avg_refund_time。

## 常见考点

1. **退款为什么必须原路退回？**——支付渠道约束。微信支付的钱在微信体系，退到支付宝需要跨渠道清算（成本高且有合规风险）。所以优先原路退，原渠道不可用（账户注销）退平台余额。
2. **退款幂等怎么实现？**——商户单号（refundNo）作为幂等键，渠道侧基于此去重。同一商户单号多次请求渠道只退一次。重试时用相同商户单号。
3. **退款超时怎么办？**——不能假设成功（可能实际没退）也不能假设失败（可能退了只是回调延迟）。调渠道查询接口确认实际状态。查单也超时进人工。
4. **部分退款优惠怎么分摊？**——按实付比例。订单 100 满减 20 实付 80，退一件原价 30 的商品，退款 = 30 × (80/100) = 24。不能按原价退 30（否则退款总额可能超实付）。

## 结构化回答

**30 秒电梯演讲：** 售后退款链路的本质是订单状态机的逆向流程 + 资金回流一致性。逆向流程：申请售后 → 审核 → 退货入库 → 退款，每步有状态机约束防止非法跳转。资金回流是核心难点：原路退回（微信/支付宝）要和支付渠道对接，退款可能失败（渠道超时/账户注销），必须幂等重试 + 对账兜底

**展开框架：**
1. **逆向状态机** — APPLIED → APPROVED → RETURNING → RETURN_RECEIVED → REFUNDING → REFUNDED
2. **退款渠道** — 原路退回（微信/支付宝/银行卡）+ 余额退款（退到平台钱包）
3. **幂等** — 退款单号 + 渠道唯一请求号，防止重复退款

**收尾：** 以上是我的整体思路。您想继续深入聊——退款金额怎么算？


## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：售后退款链路的状态机与对账 | "这题一句话：售后退款链路的本质是订单状态机的逆向流程 + 资金回流一致性。" | 开场钩子 |
| 0:15 | 逆向状态机示意/对比图 | "APPLIED → APPROVED → RETURNING → RETURN_RECEIVED → REFUNDING → REFUNDED" | 逆向状态机要点 |
| 0:40 | 退款渠道示意/对比图 | "原路退回（微信/支付宝/银行卡）+ 余额退款（退到平台钱包）" | 退款渠道要点 |
| 1:25 | 总结卡 | "记住：逆向状态机。下期见。" | 收尾 |
