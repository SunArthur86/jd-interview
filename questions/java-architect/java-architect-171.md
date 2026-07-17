---
id: java-architect-171
difficulty: L3
category: java-architect
subcategory: 交易
tags:
- Java 架构师
- 会员权益
- 核销
- 补偿
feynman:
  essence: 会员权益系统的核心是"发放 → 核销 → 过期"的生命周期管理 + 补偿一致性。发放是高并发场景（双 11 全站发券），核销是强一致场景（一张券只能用一次），补偿是故障兜底（发了但用户没收到、核销了但订单失败要回退）。
  analogy: 像景区年卡管理——发卡（发放）、刷卡进园（核销）、卡过期（失效）、卡丢了补办（补偿）。每张卡有唯一编号，刷一次作废一次，不能重复用也不能漏用。
  first_principle: 权益是"有限的稀缺资源"（优惠券有预算、会员有名额），必须精确管理生命周期。并发核销要防重（一张券用两次），发放失败要补偿（用户该拿的没拿到），核销后订单取消要回退（退回券让用户能用）。
  key_points:
  - 生命周期：ISSUED（已发放）→ ACTIVE（生效）→ USED（已核销）/ EXPIRED（已过期）
  - 发放：批量异步发放（MQ 削峰）+ 幂等（防重复发）
  - 核销：乐观锁 + 唯一约束，一张券只能核销一次
  - 补偿：发放失败重发、核销后订单取消回退券
  - 过期：定时任务扫描过期权益，标记 EXPIRED
first_principle:
  problem: 如何在高并发发放（双 11 亿级用户发券）、强一致核销（一券一用）、故障补偿（发/核销异常恢复）下保证会员权益精确管理？
  axioms:
  - 权益是稀缺资源（预算有限），不能多发不能漏发
  - 核销必须幂等（一张券只能用一次，并发请求只成功一个）
  - 发放和核销可能失败（网络/服务故障），必须可补偿
  - 权益有时效（过期失效），必须自动管理
  rebuild: 发放走 MQ 异步削峰 + 幂等键防重。核销走乐观锁（UPDATE WHERE status=ACTIVE AND version=?）+ 数据库唯一约束。核销记录和订单关联，订单取消时反向回退券状态。定时任务扫描过期权益。
follow_up:
  - 双 11 亿级发券怎么扛？——预生成 + MQ 削峰。发券请求进 MQ，消费者批量拉取批量写入（batch insert）。券码预生成（池化），发放时从池取。
  - 券码怎么生成唯一？——雪花算法或预生成池。券码要不可猜测（防遍历），用 UUID 或加密序列。
  - 核销并发怎么防重？——乐观锁 UPDATE WHERE status='ACTIVE' AND version=5，并发只有一个 affected=1。或 Redis 分布式锁（券维度）。
  - 核销后订单取消券怎么退？——核销记录带 orderId，订单取消事件触发反向操作：UPDATE 券 status='ACTIVE'（恢复可用），记录回退日志。
  - 过期券怎么处理？——定时任务（每天凌晨）扫描 expire_time < NOW() AND status='ACTIVE'，批量标记 EXPIRED。通知用户"您的券已过期"。
memory_points:
  - 生命周期：ISSUED → ACTIVE → USED / EXPIRED
  - 发放：MQ 异步 + 幂等键 + 批量写入
  - 核销：乐观锁 UPDATE WHERE status/version + 唯一约束
  - 补偿：发放失败重发、核销后取消回退
  - 过期：定时任务扫描批量标记
---

# 【Java 后端架构师】会员权益系统的发放、核销与补偿

> 适用场景：JD 核心技术。双 11 给所有 PLUS 会员发一张满 300 减 50 券——亿级用户并发领取。用户下单用券后取消订单，券要退回。架构师要设计的是一套"高并发发放、强一致核销、可靠补偿"的权益管理系统。

## 一、概念层：权益生命周期

```
┌────────┐ 发放    ┌────────┐ 核销    ┌────────┐
│CREATED │────────►│ ACTIVE │────────►│ USED   │ (已使用)
│已创建   │         │可用     │         └────────┘
└────────┘         └────┬───┘              ▲
                        │ 过期              │ 订单取消回退
                        ▼                   │
                   ┌──────────┐             │
                   │ EXPIRED  │             │
                   │已过期     │◄────────────┘ (回退为 ACTIVE 或 LOCKED)
                   └──────────┘
```

## 二、机制层：权益数据模型

```sql
CREATE TABLE t_member_benefit (
    id BIGINT PRIMARY KEY,
    benefit_no VARCHAR(32) UNIQUE,        -- 权益编号（唯一，防遍历用 UUID）
    user_id VARCHAR(32),
    benefit_type VARCHAR(20),              -- COUPON / DISCOUNT / GIFT / POINTS
    benefit_config JSON,                   -- 配置（满减门槛/折扣率/赠品 SKU）
    status VARCHAR(20),                    -- CREATED/ACTIVE/USED/EXPIRED/LOCKED
    source VARCHAR(50),                    -- 来源（活动/手动/系统补偿）
    issue_batch_id VARCHAR(32),            -- 发放批次（幂等）
    issued_at DATETIME,
    expire_at DATETIME,
    used_at DATETIME,
    used_order_id VARCHAR(32),             -- 核销时关联的订单
    version INT DEFAULT 0,                 -- 乐观锁
    INDEX idx_user_status (user_id, status),
    INDEX idx_expire (status, expire_at),
    INDEX idx_order (used_order_id)
);

-- 核销记录表（审计 + 防重）
CREATE TABLE t_benefit_usage (
    id BIGINT PRIMARY KEY,
    benefit_no VARCHAR(32),
    order_id VARCHAR(32),
    used_amount DECIMAL(10,2),
    create_time DATETIME,
    UNIQUE KEY uk_benefit (benefit_no),     -- 一张券只能核销一次（DB 硬约束）
    UNIQUE KEY uk_order_benefit (order_id, benefit_no)
);
```

## 三、机制层：高并发发放

```java
@Service
@Slf4j
public class BenefitIssueService {

    private final RedisTemplate<String, String> redis;
    private final BenefitRepo benefitRepo;

    /**
     * 异步发放：MQ 削峰 + 批量写入
     * 双 11 亿级发券的主链路
     */
    @KafkaListener(topics = "benefit.issue", batch = "true")
    @Transactional
    public void batchIssue(List<IssueMessage> messages) {
        // 1. 幂等过滤：同一 batch_id 只处理一次
        String batchId = messages.get(0).getBatchId();
        if (redis.opsForValue().setIfAbsent("issue:batch:" + batchId,
            "1", Duration.ofDays(7)) == false) {
            log.info("批次已处理 batchId={}", batchId);
            return;
        }

        // 2. 预生成券码（池化，从池取避免实时生成瓶颈）
        List<MemberBenefit> benefits = messages.stream()
            .map(msg -> MemberBenefit.builder()
                .benefitNo(benefitNoPool.fetch())       // 从预生成池取
                .userId(msg.getUserId())
                .benefitType(msg.getType())
                .benefitConfig(msg.getConfig())
                .status(ACTIVE)
                .source(msg.getSource())
                .issueBatchId(batchId)
                .issuedAt(now())
                .expireAt(msg.getExpireAt())
                .build())
            .collect(toList());

        // 3. 批量插入（batch insert，一次 500 条）
        batchInsert(benefits, 500);

        // 4. 推送通知（异步）
        eventPublisher.publish(new BenefitIssuedEvent(benefits));

        metrics.counter("benefit.issued", "batch", batchId).increment(benefits.size());
    }
}
```

## 四、机制层：核销（强一致）

```java
@Service
@Slf4j
public class BenefitRedeemService {

    /**
     * 核销：乐观锁 + DB 唯一约束双保险
     */
    @Transactional
    public RedeemResult redeem(String benefitNo, String orderId, BigDecimal amount) {
        // 1. 查券
        MemberBenefit benefit = benefitRepo.findByNo(benefitNo);
        if (benefit == null) {
            throw new BenefitNotFoundException("权益不存在: " + benefitNo);
        }

        // 2. 状态校验
        if (benefit.getStatus() != ACTIVE) {
            metrics.counter("benefit.redeem_fail", "status", benefit.getStatus().name()).increment();
            throw new BenefitNotActiveException("权益状态不可用: " + benefit.getStatus());
        }

        // 3. 时效校验
        if (benefit.getExpireAt().isBefore(now())) {
            throw new BenefitExpiredException("权益已过期");
        }

        // 4. 乐观锁核销（并发只有一个成功）
        int affected = benefitRepo.casUpdate(
            benefitNo, USED, ACTIVE, benefit.getVersion(), orderId);
        if (affected == 0) {
            metrics.counter("benefit.concurrent_conflict").increment();
            throw new ConcurrentRedeemException("并发核销冲突，券已被使用或状态变更");
        }

        // 5. 写核销记录（DB 唯一约束兜底防重）
        try {
            benefitUsageRepo.insert(new BenefitUsage(benefitNo, orderId, amount));
        } catch (DuplicateKeyException e) {
            // 唯一约束触发（理论上乐观锁已拦，这里是极端兜底）
            throw new ConcurrentRedeemException("权益已核销（DB 约束）");
        }

        metrics.counter("benefit.redeemed").increment();
        return RedeemResult.success(benefit, amount);
    }
}
```

## 五、机制层：补偿与回退

### 5.1 发放失败补偿

```java
@Service
public class IssueCompensator {

    /**
     * 发放失败重试（消费 MQ 失败的场景）
     */
    @Scheduled(fixedDelay = 5 * 60_000)
    public void retryFailedIssue() {
        List<IssueFailure> failures = issueFailureRepo.findRetryable();
        for (IssueFailure f : failures) {
            if (f.getRetryCount() >= MAX_RETRY) {
                f.setStatus(MANUAL_REQUIRED);
                alertService.send("发放失败需人工: " + f.getBatchId());
                continue;
            }
            // 重新投递到发放队列
            kafka.send("benefit.issue", f.toMessage());
            f.incrementRetry();
        }
    }
}
```

### 5.2 核销后订单取消的回退

```java
@Service
public class BenefitRollbackService {

    /**
     * 订单取消：退回已核销的权益
     */
    @EventListener
    @Async
    public void onOrderCancelled(OrderCancelledEvent event) {
        String orderId = event.getOrderId();
        List<BenefitUsage> usages = benefitUsageRepo.findByOrderId(orderId);

        for (BenefitUsage usage : usages) {
            // 检查是否在回退窗口内（如订单取消后 24 小时内可退券，超时券已过期不退）
            MemberBenefit benefit = benefitRepo.findByNo(usage.getBenefitNo());
            if (benefit.getExpireAt().isBefore(now())) {
                log.info("券已过期不退回: {}", benefit.getBenefitNo());
                continue;
            }

            // 状态回退：USED → ACTIVE
            int affected = benefitRepo.casUpdate(
                benefit.getBenefitNo(), ACTIVE, USED,
                benefit.getVersion(), null);
            if (affected == 0) {
                log.error("回退失败 benefit={}", benefit.getBenefitNo());
                continue;
            }

            // 删除核销记录
            benefitUsageRepo.delete(usage);

            metrics.counter("benefit.rollback").increment();
            notifyUser("您的权益 " + benefit.getBenefitNo() + " 已退回");
        }
    }
}
```

## 六、机制层：过期管理

```java
@Service
public class BenefitExpireScheduler {

    /**
     * 每天凌晨扫描过期权益
     */
    @Scheduled(cron = "0 0 2 * * ?")
    public void expireBenefits() {
        int pageSize = 5000;
        long offset = 0;
        while (true) {
            List<MemberBenefit> expiring = benefitRepo.findExpiring(offset, pageSize);
            if (expiring.isEmpty()) break;

            // 批量更新状态
            List<String> nos = expiring.stream()
                .map(MemberBenefit::getBenefitNo).collect(toList());
            benefitRepo.batchUpdateStatus(nos, EXPIRED);

            // 通知用户（异步，避免阻塞）
            eventPublisher.publish(new BenefitExpiredEvent(expiring));

            offset += pageSize;
            metrics.counter("benefit.expired").increment(expiring.size());
        }
    }
}
```

## 七、底层本质：权益是"有限稀缺资源的精确管理"

权益管理和库存管理同构——都是"有限资源的并发分配"。但权益更复杂：

1. **生命周期更长**：库存是瞬时（下单锁定），权益是天/月级（发到过期）。
2. **状态更多**：库存只有"有/无"，权益有 CREATED/ACTIVE/USED/EXPIRED/LOCKED 多态。
3. **需要回退**：库存下单取消回退，权益核销后订单取消也要回退（券还能用）。

**核销幂等的本质**：一张券只能用一次。乐观锁（CAS）保证并发下一个成功，DB 唯一约束兜底（即使乐观锁失效，DB 层 `UNIQUE KEY uk_benefit` 保证物理上一券一记录）。这是"应用层 + 数据库层"双层防御。

**补偿的本质**：分布式系统默认会失败。发放可能失败（MQ 丢失）、核销可能失败（DB 超时）、订单可能取消（券要退）。每个环节都要有补偿：发放失败重试、核销失败回滚、订单取消退券。所有操作幂等，重试无副作用。

## 八、AI 工程化深挖

1. **用 AI 个性化发放权益怎么做？**
   分析用户画像（购买力/活跃度/品类偏好），AI 推荐该发什么券（满减 vs 折扣 vs 品类券）。高价值用户给大额券，低活跃用户给唤醒券。但要有预算控制，AI 只做推荐，预算扣减走确定性逻辑。

2. **怎么用 AI 预测券核销率？**
   历史数据训练模型，预测每张券被核销的概率（基于用户行为/券面额/品类/有效期）。低核销率的券自动延长有效期或推送提醒。监控 redeem_prediction_accuracy。

3. **权益反欺诈怎么做？**
   羊毛党批量领券（批量注册 + 自动化脚本）。AI 分析领取行为（注册时间聚集/IP 聚集/设备指纹）识别羊毛党，限制领取或要求验证。监控 fraud_issue_rate。

4. **LLM 辅助运营创建发券活动怎么做？**
   运营描述"给 7 天没登录的用户发一张满 100 减 20 的唤醒券，有效期 3 天，预算 50 万"。LLM 翻译成发放配置（人群包 + 券配置 + 预算）。人工 review 后生效。

5. **权益系统怎么做 trace？**
   每张券生成 traceId（= benefitNo），贯穿发放 → 核销 → 回退 → 过期全链路。用户问"我的券为什么不能用"时，查 trace 看券当前状态和历史流转。

## 九、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"发放削峰、核销乐观锁、回退退券、过期扫描"** 四个词。

- **发放削峰**：MQ 异步 + 批量 insert + 幂等键（batch_id）
- **核销**：乐观锁 CAS（UPDATE WHERE status=ACTIVE AND version=?）+ DB 唯一约束兜底
- **回退退券**：订单取消 → USED 回退 ACTIVE + 删核销记录，过期券不退
- **过期扫描**：定时任务批量标记 EXPIRED + 通知用户

### 面试现场 60 秒回答

> 权益系统生命周期是 CREATED → ACTIVE → USED/EXPIRED。双 11 亿级发放用 MQ 削峰——发券请求进 Kafka，消费者批量拉取批量 insert（500 条/批），券码从预生成池取避免实时生成瓶颈，幂等键 batch_id 防重复发放。核销走强一致——乐观锁 CAS（UPDATE SET status=USED, version=version+1 WHERE benefit_no=? AND status=ACTIVE AND version=旧），并发只有一个 affected=1 成功，DB 层 t_benefit_usage 的 UNIQUE KEY uk_benefit 兜底保证物理上一券一记录。订单取消回退：监听 OrderCancelledEvent，把 USED 的券回退为 ACTIVE（检查未过期），删核销记录，通知用户。发放失败重试（MQ 消费失败进重试队列，3 次后人工）。过期管理定时任务每天凌晨扫描 expire_at < NOW() AND status=ACTIVE 批量标记 EXPIRED。核销记录关联 orderId 方便回退和对账。核心指标 issue_success_rate、redeem_concurrent_conflict_rate、rollback_success_rate。

## 常见考点

1. **双 11 亿级发券怎么扛？**——MQ 削峰 + 批量 insert + 券码预生成池。不用同步发放（DB 扛不住）。消费端批量拉、批量写，吞吐 10 万+/秒。
2. **核销并发怎么防重？**——乐观锁 CAS（应用层）+ DB 唯一约束（数据库层）双保险。即使乐观锁失效，UNIQUE KEY 保证物理防重。
3. **券核销后订单取消怎么退？**——监听订单取消事件，券状态 USED → ACTIVE，删核销记录。但要检查券是否过期（过期不退）。
4. **券码怎么生成唯一且不可遍历？**——预生成池（雪花算法/UUID）+ 加密签名。不用自增 ID（可遍历，安全风险）。

## 结构化回答

**30 秒电梯演讲：** 会员权益系统的核心是发放 → 核销 → 过期的生命周期管理 + 补偿一致性。发放是高并发场景（双 11 全站发券），核销是强一致场景（一张券只能用一次），补偿是故障兜底（发了但用户没收到、核销了但订单失败要回退）

**展开框架：**
1. **生命周期** — ISSUED（已发放）→ ACTIVE（生效）→ USED（已核销）/ EXPIRED（已过期）
2. **发放** — 批量异步发放（MQ 削峰）+ 幂等（防重复发）
3. **核销** — 乐观锁 + 唯一约束，一张券只能核销一次

**收尾：** 以上是我的整体思路。您想继续深入聊——双 11 亿级发券怎么扛？


## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：会员权益系统的发放、核销与补偿 | "这题一句话：会员权益系统的核心是发放 → 核销 → 过期的生命周期管理 + 补偿一致性。" | 开场钩子 |
| 0:15 | 像景区年卡管理——发卡（发放）、刷卡进园（核销）类比图 | "打个比方：像景区年卡管理——发卡（发放）、刷卡进园（核销）。" | 核心类比 |
| 0:40 | 生命周期示意/对比图 | "ISSUED（已发放）→ ACTIVE（生效）→ USED（已核销）/ EXPIRED（已过期）" | 生命周期要点 |
| 1:05 | 发放示意/对比图 | "批量异步发放（MQ 削峰）+ 幂等（防重复发）" | 发放要点 |
| 1:55 | 总结卡 | "记住：生命周期。下期见。" | 收尾 |
