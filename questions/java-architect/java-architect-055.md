---
id: java-architect-055
difficulty: L4
category: java-architect
subcategory: 交易
tags:
- Java 架构师
- 交易
- 支付
- 补偿
feynman:
  essence: 支付回调的核心挑战是"网络不可靠下的幂等"——支付网关可能重试回调 N 次（超时重发），商户必须保证 N 次回调只处理一次（不重复扣款/不重复发货）。幂等三要素：幂等键（payment_id）、状态机校验（只有待支付才能变已支付）、去重表（处理记录表保证唯一）。补偿机制是"回调失败后的兜底"——主动查询支付结果、定时对账、人工介入。
  analogy: 像快递签收。快递员（支付网关）可能多次派送同一包裹（回调重试），你必须保证只签收一次（幂等）。如果快递员说已送达但你没收到（回调丢失），你要主动去驿站查（主动查询）。如果驿站记录和你的记录不一致（对账差错），要人工核实。
  first_principle: 为什么支付回调必须幂等？因为网络不可靠——支付网关发回调后，可能没收到 ACK（网络超时），会重试。如果商户不幂等，重试 N 次就重复处理 N 次（重复发货/重复充值）。幂等的本质是"多次调用等价于一次"——用幂等键（payment_id）去重，第二次回调发现已处理直接返回成功。
  key_points:
  - 幂等三要素：幂等键（payment_id）+ 状态机校验 + 去重表
  - 回调处理流程：验签 → 幂等检查 → 业务处理（事务）→ 返回 ACK
  - 支付网关 ACK 语义：返回 SUCCESS 网关停止重试，返回 FAIL 网关重试
  - 主动查询补偿：定时查未 ACK 的支付单，主动调支付网关查询接口
  - 对账兜底：每日和支付网关对账，发现差异人工处理
first_principle:
  problem: 支付网关异步通知支付结果，网络不可靠下如何保证"不遗漏（漏回调导致不发货）+ 不重复（重试导致重复发货）"？
  axioms:
  - 网络不可靠：回调可能丢失（网关发了但商户没收到）或重复（商户处理慢网关超时重试）
  - 支付是资金操作，重复处理（重复发货/重复充值）是资损
  - 回调不可靠时，商户必须主动查询兜底
  rebuild: 幂等+补偿双保险。幂等：回调用 payment_id 去重，去重表（processed_payment）保证唯一处理，状态机校验（只有待支付订单能变已支付）。补偿：定时任务扫"已支付但未 ACK"的订单（超过 5 分钟无回调），主动调支付网关查询接口拿结果，按结果处理。对账兜底：每日 T+1 和支付网关对账文件比对，差异人工核实。
follow_up:
  - 回调和主动查询怎么配合？——回调是"推"（网关主动通知），主动查询是"拉"（商户定时查）。两者互补：回调快但可能丢失，主动查询慢但可靠。订单支付后 5 分钟无回调，触发主动查询兜底。
  - 去重表怎么设计？——表 processed_payment（payment_id PRIMARY KEY, order_id, status, processed_at），处理前 INSERT，主键冲突说明已处理。或用 Redis（SETNX payment_id）。
  - 退款回调怎么处理？——和支付回调同理，用 refund_id 幂等。退款可能部分成功（金额不足），状态机要支持"部分退款"状态。
  - 支付网关重试频率？——通常递增间隔：15s/30s/1min/5min/30min/1h/6h/24h，最多重试 8 次后放弃（需人工介入）。
  - 对账发现差异怎么办？——长款（网关有交易商户无）：可能是回调丢失，主动补单；短款（商户有交易网关无）：可能是伪造回调，冻结订单调查。
memory_points:
  - 幂等三要素：payment_id + 状态机校验 + 去重表
  - 回调流程：验签→幂等检查→业务事务→ACK
  - ACK 语义：SUCCESS 停止重试，FAIL 继续重试
  - 主动查询：定时扫未 ACK 订单，调网关查询接口
  - 对账兜底：T+1 比对，差异人工处理
---

# 【Java 后端架构师】交易系统支付回调与幂等补偿

> 适用场景：JD 核心技术。京东支付每天千万笔交易，支付网关（微信/支付宝/京东金融）异步回调通知支付结果。网络抖动下回调可能丢失或重复——丢失导致用户付了钱不发货（投诉），重复导致重复发货（资损）。幂等+补偿是支付链路的生命线。

## 一、概念层：支付回调的可靠性挑战

**回调的不确定状态**（面试必答）：

```
支付网关 ──回调──► 商户系统
    │
    │ 可能出现 3 种情况：
    │
    ├─ 1. 正常：商户收到 + 处理成功 + 返回 ACK → 网关停止重试
    │
    ├─ 2. 丢失：回调网络丢失（商户没收到）→ 网关重试，但如果一直丢失，商户永远不知道
    │
    └─ 3. 重复：商户收到但处理慢（超时），网关没收到 ACK → 网关重试 → 商户收到重复回调

应对策略：
  情况 1：正常处理
  情况 2：主动查询补偿（定时查未回调的订单）
  情况 3：幂等处理（重复回调只处理一次）
```

## 二、机制层：幂等回调处理

**幂等回调完整代码**：

```java
@RestController
@RequestMapping("/callback/payment")
public class PaymentCallbackController {

    @Autowired private PaymentCallbackService callbackService;
    @Autowired private SignatureVerifier signatureVerifier;

    @PostMapping("/notify")
    public String notify(HttpServletRequest request) {
        try {
            // 1. 验签（防伪造回调）
            String body = readBody(request);
            String signature = request.getHeader("X-Signature");
            if (!signatureVerifier.verify(body, signature)) {
                monitor.record("callback_signature_fail");
                return "FAIL";   // 验签失败返回 FAIL，网关会重试（但伪造者没有真签名，重试也没用）
            }

            // 2. 解析回调数据
            PaymentNotify notify = JSON.parseObject(body, PaymentNotify.class);

            // 3. 幂等处理
            CallbackResult result = callbackService.handle(notify);

            // 4. 返回 ACK
            if (result.isSuccess()) {
                return "SUCCESS";   // 网关收到 SUCCESS 停止重试
            } else {
                return "FAIL";      // 网关收到 FAIL 会重试
            }
        } catch (Exception e) {
            log.error("支付回调处理异常", e);
            return "FAIL";   // 异常返回 FAIL，网关重试（下次可能成功）
        }
    }
}

@Service
public class PaymentCallbackService {

    @Autowired private OrderService orderService;
    @Autowired private ProcessedPaymentRepo processedRepo;

    @Transactional
    public CallbackResult handle(PaymentNotify notify) {
        String paymentId = notify.getPaymentId();   // 幂等键
        Long orderId = notify.getOrderId();
        PaymentStatus paymentStatus = notify.getStatus();

        // 1. 幂等检查：查去重表，是否已处理过该 paymentId
        Optional<ProcessedPayment> existing = processedRepo.findById(paymentId);
        if (existing.isPresent()) {
            // 已处理过，直接返回成功（幂等）
            log.info("重复回调，幂等返回: paymentId={}", paymentId);
            return CallbackResult.success("已处理");
        }

        // 2. 状态机校验：订单当前状态
        Order order = orderService.findById(orderId);
        if (order.getStatus() == OrderStatus.PAID) {
            // 订单已是已支付（可能通过主动查询先处理了），记录去重表
            processedRepo.save(new ProcessedPayment(paymentId, orderId, "DUPLICATE"));
            return CallbackResult.success("订单已支付");
        }
        if (order.getStatus() != OrderStatus.WAIT_PAY) {
            // 订单非待支付（可能已取消），不能变已支付
            log.warn("订单状态非待支付，忽略支付回调: orderId={}, status={}",
                orderId, order.getStatus());
            // 触发退款（用户付了钱但订单已取消）
            eventPublisher.publish(new RefundNeededEvent(orderId, paymentId, notify.getAmount()));
            processedRepo.save(new ProcessedPayment(paymentId, orderId, "REFUND_NEEDED"));
            return CallbackResult.success("已触发退款");
        }

        // 3. 业务处理：变更订单状态（乐观锁）
        try {
            orderService.markAsPaid(orderId, paymentId);
        } catch (ConcurrentStateConflictException e) {
            // 并发冲突：其他请求（如主动查询）先改了状态
            log.info("并发冲突，其他请求已处理: orderId={}", orderId);
            return CallbackResult.success("并发处理");
        }

        // 4. 记录去重表（保证幂等）
        processedRepo.save(new ProcessedPayment(paymentId, orderId, "PROCESSED"));

        // 5. 发领域事件（触发发货、加积分等）
        eventPublisher.publish(new OrderPaidEvent(orderId, notify.getAmount()));

        return CallbackResult.success("处理成功");
    }
}
```

**去重表设计**：

```sql
CREATE TABLE t_processed_payment (
    payment_id VARCHAR(64) PRIMARY KEY,    -- 支付单号（幂等键）
    order_id BIGINT NOT NULL,
    channel VARCHAR(20),                    -- 支付渠道（WECHAT/ALIPAY/JD）
    amount DECIMAL(18,2),
    status VARCHAR(20),                     -- PROCESSED / DUPLICATE / REFUND_NEEDED
    processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_order (order_id)
);
-- 主键保证：同一 payment_id 只能 INSERT 一次，重复 INSERT 报主键冲突
```

## 三、机制层：主动查询补偿

**定时任务扫未回调订单**：

```java
@Component
public class PaymentQueryScheduler {

    @Autowired private OrderService orderService;
    @Autowired private PaymentGatewayClient gatewayClient;
    @Autowired private PaymentCallbackService callbackService;

    // 每 1 分钟扫描"支付超时但未收到回调"的订单
    @Scheduled(fixedDelay = 60_000)
    public void queryUnnotifiedOrders() {
        // 查询：已支付（用户跳转支付页）但 5 分钟内未回调的订单
        List<Order> pending = orderService.findPaidButNotNotified(
            Instant.now().minus(5, ChronoUnit.MINUTES),
            100   // 每批 100 个
        );

        for (Order order : pending) {
            try {
                // 主动调支付网关查询接口
                PaymentQueryResult result = gatewayClient.queryPayment(order.getPaymentId());

                if (result.isSuccess()) {
                    // 支付成功，模拟回调处理
                    PaymentNotify notify = new PaymentNotify(
                        order.getPaymentId(), order.getId(),
                        PaymentStatus.SUCCESS, result.getAmount()
                    );
                    callbackService.handle(notify);
                    monitor.record("callback_query_compensate", order.getId());
                } else if (result.isFailed()) {
                    // 支付失败，关闭订单
                    orderService.closeOrder(order.getId(), "支付失败");
                }
                // PENDING 状态：继续等待（下次定时任务再查）
            } catch (Exception e) {
                log.error("主动查询失败: orderId={}", order.getId(), e);
            }
        }
    }
}
```

**支付网关重试策略**（理解网关行为）：

```java
// 支付网关（如微信支付）的重试机制
// 商户必须理解这个策略，才能设计补偿

// 微信支付回调重试策略（参考）：
// 第 1 次：立即
// 第 2 次：15s 后
// 第 3 次：30s 后
// 第 4 次：1min 后
// 第 5 次：5min 后
// 第 6 次：30min 后
// 第 7 次：1h 后
// 第 8 次：6h 后
// 最多 8 次，总跨度约 8 小时

// 商户的 ACK 语义：
// 返回 "SUCCESS" 或 200：网关认为通知成功，停止重试
// 返回 "FAIL" 或非 200：网关认为通知失败，按策略重试
// 返回超时（5s 内无响应）：网关认为通知失败，重试

// 所以商户必须在 5s 内处理完回调并返回，超时会被重试
// 如果处理慢（如扣库存耗时长），先返回 SUCCESS 再异步处理（有风险，推荐先处理再 ACK）
```

## 四、机制层：对账兜底

**T+1 对账系统**：

```java
@Component
public class PaymentReconciliationJob {

    // 每天凌晨 2 点跑对账
    @Scheduled(cron = "0 0 2 * * ?")
    public void reconcile() {
        LocalDate date = LocalDate.now().minusDays(1);   // 昨天的数据

        // 1. 下载支付网关的对账文件
        List<GatewayRecord> gatewayRecords = downloadGatewayFile(date);
        // 字段：payment_id, amount, status, time

        // 2. 查询本系统的交易记录
        List<LocalRecord> localRecords = localTxnRepo.findByDate(date);

        // 3. 双向比对
        ReconcileResult result = new ReconcileResult();

        // 3.1 网关有、本地无（长款）：可能是回调丢失
        for (GatewayRecord g : gatewayRecords) {
            boolean found = localRecords.stream()
                .anyMatch(l -> l.getPaymentId().equals(g.getPaymentId()));
            if (!found) {
                result.addLongPayment(g);   // 长款：网关收钱了但本地没记录
                // 补单处理
                handleMissingPayment(g);
            }
        }

        // 3.2 本地有、网关无（短款）：可能是伪造回调
        for (LocalRecord l : localRecords) {
            boolean found = gatewayRecords.stream()
                .anyMatch(g -> g.getPaymentId().equals(l.getPaymentId()));
            if (!found) {
                result.addShortPayment(l);  // 短款：本地记录了但网关没交易
                // 冻结订单调查（可能是伪造回调）
                investigateSuspiciousPayment(l);
            }
        }

        // 3.3 金额不一致
        // 比对每笔的金额，不一致告警

        // 4. 生成对账报告
        reportService.generateReconcileReport(date, result);
        if (result.hasDiscrepancy()) {
            alertService.send("对账差异: " + result.summary());
        }
    }

    private void handleMissingPayment(GatewayRecord g) {
        // 长款处理：网关收钱了但本地没记录（回调丢失）
        // 1. 查订单是否存在
        Order order = orderService.findById(g.getOrderId());
        if (order == null) {
            // 订单不存在，可能是测试数据，记录待查
            log.warn("网关有交易但订单不存在: {}", g);
            return;
        }
        // 2. 订单存在但未支付，补单
        if (order.getStatus() == OrderStatus.WAIT_PAY) {
            orderService.markAsPaid(order.getId(), g.getPaymentId());
            log.info("对账补单: orderId={}", order.getId());
        }
    }
}
```

## 五、底层本质：幂等的本质是"副作用去重"

回到第一性：**幂等的本质是"多次调用产生的副作用等价于一次"**。

- **天然幂等操作**：查询（SELECT）、读取——多次调用结果一样。
- **非幂等操作**：创建订单（INSERT）——多次调用创建多个订单。
- **幂等化**：用唯一键（payment_id）约束——第二次 INSERT 主键冲突，等价于"已创建"。

**支付回调幂等的关键是"识别重复"**：支付网关的每次回调都带 payment_id（唯一支付单号）。商户用 payment_id 作为幂等键——第一次收到时处理（INSERT 去重表 + 变更状态），后续重复收到时查去重表发现已处理，直接返回成功。这样 N 次回调只产生一次副作用（一次状态变更），等价于一次。

**为什么不能只靠状态机校验做幂等**？因为状态机校验是"基于当前状态判断"，但并发下可能有间隙——请求 A 和 B 几乎同时到达，都查到 WAIT_PAY，都尝试更新。去重表用 INSERT 主键冲突保证原子性——只有一个 INSERT 成功，另一个主键冲突。这是"数据库约束 > 应用层判断"的典型实践。

**补偿机制的本质是"不信任回调"**：回调可能丢失（网络问题），所以商户不能只等回调。主动查询是"拉模式"兜底——定时查支付网关拿结果，即使回调全丢，主动查询也能发现支付结果。对账是"批量校验"兜底——每天全量比对，发现遗漏的交易。三层防护：回调（推）+ 主动查询（拉）+ 对账（校验），保证"不遗漏"。

## 六、AI 架构师加问：5 个

1. **用 AI 预测回调异常，怎么做？**
   AI 分析历史回调数据——每个支付渠道的回调延迟分布、丢失率、重试频率。某渠道回调延迟突增时，AI 预警"可能回调积压"，提前缩短主动查询间隔。

2. **AI 辅助对账差错归因，怎么做？**
   AI 分析对账差异类型——长款（回调丢失）/短款（伪造回调）/金额不一致（币种/手续费）。AI 匹配历史相似案例，推荐处理方案（补单/冻结/退款）。但资金操作人工确认。

3. **AI Agent 处理支付回调，怎么保证安全？**
   Agent 不能直接处理回调（资金操作）。Agent 做"归因分析"——分析回调异常原因（渠道问题/系统 bug/攻击），推荐处理方案。真正的资金操作（退款/补单）走确定性代码+人工审批。

4. **支付系统接入 RAG，知识库放什么？**
   支付渠道文档（回调协议/重试策略/API 规范）、历史差错案例库（怎么处理的）、对账规则。AI 查询"微信支付回调格式"时 RAG 返回文档+示例。

5. **用 AI 检测伪造回调，怎么做？**
   AI 分析回调来源——IP（是否支付网关官方 IP）、签名（验签）、行为模式（异常时间/异常金额）。合法回调的来源固定，异常来源告警。结合风控规则（金额突增/频率异常）综合判断。

## 七、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"幂等三要素、回调四步走、主动查询兜底、对账发现差异"**。

- **幂等三要素**：payment_id 幂等键 + 状态机校验 + 去重表（INSERT 主键冲突）
- **回调四步**：验签 → 幂等检查（查去重表）→ 业务处理（乐观锁状态变更）→ 返回 ACK
- **ACK 语义**：SUCCESS 停止重试，FAIL 继续重试
- **主动查询**：定时扫 5 分钟未回调订单，调网关查询接口补单
- **对账兜底**：T+1 比对网关文件，长款补单/短款冻结

### 面试现场 60 秒回答

> 支付回调的核心是幂等——支付网关可能重试回调 N 次（超时重发），商户必须保证 N 次只处理一次。幂等三要素：payment_id 作为幂等键，去重表（processed_payment）INSERT 主键冲突保证唯一，状态机校验（只有待支付订单能变已支付）。回调处理四步：验签（防伪造）→ 幂等检查（查去重表，已处理直接返回 SUCCESS）→ 业务处理（乐观锁变更订单状态 + 发 OrderPaidEvent）→ 返回 SUCCESS ACK。ACK 语义：返回 SUCCESS 网关停止重试，返回 FAIL 网关按递增间隔重试（15s/30s/1min...最多 8 次）。回调可能丢失（网络问题），所以有主动查询补偿——定时任务扫 5 分钟未回调的订单，调支付网关查询接口拿结果补单。对账兜底：T+1 下载网关对账文件，双向比对——长款（网关有本地无）补单，短款（本地有网关无）冻结调查。最容易翻车的是"回调返回 SUCCESS 但业务处理失败"——要么先处理再 ACK（处理慢会超时），要么用 Outbox 保证最终一致。

## 八、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不全部用主动查询，还要回调？ | 用延迟说话：主动查询是定时任务（分钟级延迟），回调是实时（秒级）。用户支付后希望立即看到"支付成功"，回调能在 1-3 秒内触发，主动查询要等下一个周期。用 callback_latency（回调延迟）和 query_compensate_count（主动查询补单数）量化，补单率应 < 1% |
| 证据追问 | 怎么证明幂等有效？ | 测试：同一 payment_id 的回调重复发 N 次，订单状态只变一次，发货只发一次；生产监控：duplicate_callback_count（重复回调数，应 > 0 但业务无影响）、reconcile_discrepancy_count（对账差异数，应趋近 0） |
| 边界追问 | 幂等能防所有异常吗？ | 不能。防不了"金额错误"（回调金额和订单金额不匹配）、防不了"订单已取消但用户付了钱"（需触发退款）、防不了"支付网关故障"（需人工介入）。这些靠业务校验+对账+人工兜底 |
| 反例追问 | 去重表会不会成为瓶颈？ | 会。亿级交易下去重表膨胀。解法：按时间分区（按月分表），历史数据归档（超 6 个月的移到冷存储）；或用 Redis 做短期去重（TTL 24h），DB 做长期去重。payment_id 查询走主键索引，性能 OK |
| 风险追问 | 支付回调最大的风险？ | 主动点出：伪造回调（验签被绕过）、回调丢失（网络故障导致用户付钱不发货）、重复处理（幂等失效导致重复发货）、回调处理慢导致 ACK 超时（网关疯狂重试）、对账差异未及时发现（资金损失） |
| 验证追问 | 怎么验证回调处理正确？ | 自动化测试：正常回调（状态变更+发货）、重复回调（幂等返回）、异常状态回调（已取消订单触发退款）、并发回调（乐观锁只有一个成功）。混沌测试：mock 网关延迟/丢包/乱序，验证补偿机制 |
| 沉淀追问 | 支付系统沉淀什么？ | 统一回调框架（验签+幂等+ACK 模板）、多渠道适配层（微信/支付宝/京东金融统一接口）、对账系统（自动比对+差异告警）、主动查询补偿框架、回调监控大盘（延迟/重复率/补单率） |

### 现场对话示例

**面试官**：回调处理慢（扣库存耗时长），导致 ACK 超时，网关疯狂重试，怎么办？

**候选人**：两种策略，看业务容忍度。第一种，同步处理+快速 ACK——优化处理逻辑，保证 5 秒内完成（ACK 超时阈值）。扣库存如果跨服务调用慢，用 Redis 原子扣减（Lua 脚本，<5ms）替代 DB 操作，DB 操作异步化（先 ACK 再异步落库）。风险是 ACK 后异步处理失败（数据不一致），要靠对账兜底。第二种，先 ACK 再异步处理——收到回调立即返回 SUCCESS（网关不重试），然后把回调数据放 MQ，异步消费处理。风险更大——如果 MQ 丢消息，这笔支付就丢了（用户付钱不发货）。解法是 Outbox 模式——ACK 前把回调数据写本地表（同事务），异步任务扫表处理，保证不丢。京东支付用第一种——核心链路优化到 2 秒内完成（Redis 扣库存 + 异步发券 + 异步加积分），2 秒内 ACK，网关不重试。扣库存是核心（放同步），发券/积分是副作用（异步）。如果确实超时被重试，幂等保证不重复处理。

**面试官**：对账发现"本地有订单但网关无交易"（短款），怎么处理？

**候选人**：短款是危险信号——本地记录了支付成功，但支付网关没有这笔交易。可能原因：回调被伪造（攻击者发假回调）、本地系统 bug（错误标记为已支付）、时间差（网关对账文件还没生成）。处理步骤：第一步，冻结该订单——停止发货/退款，防止资损扩大。第二步，核实——查回调原始日志（验签是否通过、来源 IP 是否合法）、调网关查询接口（实时查这笔 paymentId 在网关的状态）。第三步，分类处理——如果是伪造回调（验签失败但被错误放行），这是安全事件，报警+全面排查。如果是系统 bug（乐观锁失效错误标记已支付），修复 bug + 数据回滚。如果是时间差（网关延迟出账），等下一个对账周期自动消除。第四步，告警——短款率超阈值（如 > 0.01%）触发 P0 告警，CTO 介入。京东支付每天对账，短款率监控在 0.001% 以下，发现短款立即冻结+人工核实，绝不让"伪造支付"成功提货。

**面试官**：用户付了钱，但订单因为超时被自动取消了（支付回调晚到），怎么处理？

**候选人**：这是高频场景——用户跳转支付后磨蹭了一会儿，订单超时自动取消（定时任务把 WAIT_PAY 改成 CANCELLED），然后用户才完成支付，回调到达。处理逻辑：回调处理时检查订单状态，如果已是 CANCELLED，不能改回 PAID（状态机不允许），但要给用户退款——因为用户确实付了钱。代码层面：PaymentCallbackService.handle() 里，如果 order.getStatus() == CANCELLED，发布 RefundNeededEvent，触发退款流程。退款也是异步+幂等的（refund_id 去重）。用户侧：App 推送"订单已超时取消，您的付款将在 3 个工作日内原路退回"。同时，产品优化——支付页面前订单超时不立即取消，而是延长"支付宽限期"（如订单超时后再给 5 分钟支付窗口，期间不取消）。京东的实践：订单超时时间 30 分钟，超时后先进入"超时待取消"状态（不立即释放库存），再过 5 分钟（支付宽限期）无支付才真正取消并释放库存。这样回调晚到 5 分钟内还能正常处理，减少"已取消但已付款"的情况。

## 常见考点

1. **幂等和去重什么关系？**——去重是手段（用唯一键识别重复），幂等是目标（多次调用等价于一次）。去重表/Redis SETNX 都是实现幂等的手段。
2. **回调验签为什么重要？**——防伪造回调。攻击者可能伪造支付成功回调（跳过支付直接发货）。验签（HMAC-SHA256 或 RSA）保证回调来自合法支付网关。
3. **支付回调为什么要 5 秒内响应？**——支付网关的 ACK 超时阈值（微信/支付宝通常 5 秒）。超时网关认为通知失败，会重试。重试增加系统负载，且重复回调要幂等处理。
4. **退款回调怎么处理？**——和支付回调同理，用 refund_id 幂等。退款可能部分退款（金额小于原支付），状态机要支持"部分退款"状态。退款回调晚到时，订单可能已完成，要支持"已完成→退款中"的逆向跳转。

## 结构化回答

**30 秒电梯演讲：** 支付回调的核心挑战是网络不可靠下的幂等——支付网关可能重试回调 N 次（超时重发），商户必须保证 N 次回调只处理一次（不重复扣款/不重复发货）。幂等三要素：幂等键（payment_id）、状态机校验（只有待支付才能变已支付）、去重表（处理记录表保证唯一）。补偿机制是回调失败后的兜底——主动查询支付结果、定时对账、人工介入

**展开框架：**
1. **幂等三要素** — 幂等键（payment_id）+ 状态机校验 + 去重表
2. **回调处理流程** — 验签 → 幂等检查 → 业务处理（事务）→ 返回 ACK
3. **支付网关 ACK 语义** — 返回 SUCCESS 网关停止重试，返回 FAIL 网关重试

**收尾：** 以上是我的整体思路。您想继续深入聊——回调和主动查询怎么配合？


## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：交易系统支付回调与幂等补偿 | "这题核心是——支付回调的核心挑战是网络不可靠下的幂等——支付网关可能重试回调 N 次（超时重发），商户必须保证……" | 开场钩子 |
| 0:15 | 像快递签收。快递员（支付网关）可能多次派送同类比图 | "打个比方：像快递签收。快递员（支付网关）可能多次派送同。" | 核心类比 |
| 0:40 | 幂等三要素示意/对比图 | "幂等键（payment_id）+ 状态机校验 + 去重表" | 幂等三要素要点 |
| 1:05 | 回调处理流程示意/对比图 | "验签 → 幂等检查 → 业务处理（事务）→ 返回 ACK" | 回调处理流程要点 |
| 1:30 | 支付网关 ACK 语义示意/对比图 | "返回 SUCCESS 网关停止重试，返回 FAIL 网关重试" | 支付网关 ACK 语义要点 |
| 1:55 | 总结卡 | "记住：幂等三要素。下期见。" | 收尾 |
