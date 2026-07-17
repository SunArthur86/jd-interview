---
id: java-architect-059
difficulty: L2
category: java-architect
subcategory: 交易
tags:
- Java 架构师
- 优惠券系统
- 核销
- 防刷
feynman:
  essence: 优惠券系统表面简单（发券、用券），内核复杂——核销链路涉及"券状态机 + 并发防超领/超用 + 防刷 + 对账"。核心矛盾是"营销补贴是有限预算，怎么让真用户拿到、真订单用掉，不被黑产薅光"。架构三板斧：券状态机（待领取/已领取/已使用/已过期，防非法流转）、原子领券（Redis Lua 防超领）、防刷（设备指纹+行为风控+预算熔断）。
  analogy: 像超市发优惠券。门口发 100 元券（限量 1000 张），规则是"满 500 减 100"。问题：怎么防止一个人领 10 张（超领）？怎么防止黄牛领了不用转卖？怎么防止伪造券（伪造二维码）？怎么防止用券后退货套现？超市的做法：一人一张（凭会员卡）、有效期 7 天、券和会员卡绑定（不可转赠）、退货则券作废。优惠券系统的逻辑一样。
  first_principle: 为什么券不能直接在数据库扣减？因为领券/用券是高并发场景（大促发券秒级百万 QPS），DB 扛不住。解法是"Redis 扣减 + DB 异步对账"——领券用 Redis Lua 原子扣减（防超领），异步写 DB；用券时状态机校验 + 乐观锁。防刷的本质是"识别真用户"——用设备指纹、行为序列、账号画像综合判断。
  key_points:
  - 券状态机：待领取(CREATED)→已领取(CLAIMED)→已使用(USED)/已过期(EXPIRED)，非法跳转拦截
  - 防超领：Redis Lua 原子扣减库存 + 用户领取次数限制
  - 防超用：用券时乐观锁（UPDATE WHERE status=CLAIMED AND version=x）
  - 防刷：设备指纹 + 行为风控 + 预算熔断（预算用完停发）
  - 对账：券发放量 = 领取量 = 使用量 + 过期量 + 余额，监控异常
first_principle:
  problem: 营销活动发 100 万张券，预算 1000 万，怎么保证不超发、不被薅、真用户能用？
  axioms:
  - 券库存有限（预算决定），高并发领券 DB 扛不住
  - 黑产会批量领券（薅羊毛），必须识别拦截
  - 券状态流转必须合法（CREATED→CLAIMED→USED），不能跳过或回退
  - 营销效果可度量（领取率、使用率、ROI）
  rebuild: 券状态机 + Redis 原子领券 + 防刷风控 + 对账。领券：Redis Lua 脚本原子（扣库存+记用户领取次数+防超领），成功后异步写 DB 券记录。用券：状态机校验（CLAIMED→USED）+ 乐观锁 + 订单关联。防刷：领券前过风控（设备指纹/行为/账号画像）。预算熔断：实时统计已发券金额，达预算 80% 预警、100% 停发。
follow_up:
  - 券退回怎么处理？——订单取消/退款时，券从 USED 回退到 CLAIMED（状态机反向流转），券有效期顺延或重置。
  - 跨店券怎么核销？——券和订单解耦，券核销记录关联订单 ID，退款时按券核销记录反向退券。
  - 券预算怎么实时统计？——Redis 维护已发券金额（INCRBY），定时和 DB 对账修正。
  - 券过期怎么处理？——定时任务扫描过期券（CLAIMED 且 expire_time < now），批量转 EXPIRED，释放预算（如可循环用）。
  - 怎么做"券中券"（券可叠加）？——券分组（同组互斥，不同组可叠加），核销时校验叠加规则。
memory_points:
  - 券状态机：CREATED→CLAIMED→USED/EXPIRED
  - 防超领：Redis Lua 扣库存 + 用户限领
  - 防超用：乐观锁（WHERE status + version）
  - 防刷：设备指纹 + 风控 + 预算熔断
  - 对账：发放=领取=使用+过期+余额
---

# 【Java 后端架构师】优惠券系统核销链路与防刷设计

> 适用场景：JD 营销核心。大促发 100 万张"满 500 减 100"券，预算 1 亿。如果防刷没做好，黑产用 1 万个假账号把券领光，真用户一张领不到，营销预算打水漂。券系统的核心是"核销链路严谨 + 防刷体系完善"——状态机管流转、Redis 防超领、风控防黑产、对账保资金。

## 一、概念层：券系统全景

**券状态机**（核心数据模型）：

```
            创建活动
              │
              ▼
         ┌─────────┐  用户领取
         │ CREATED │ ─────────┐
         │ (待领取) │          │
         └─────────┘          ▼
                        ┌──────────┐  下单使用
                        │ CLAIMED  │ ─────────┐
                        │ (已领取)  │          │
                        └──────────┘          ▼
                         │  │           ┌────────┐
              过期(定时)  │  │ 退券      │  USED  │
                         ▼  ▼           │(已使用)│
                   ┌──────────┐         └────────┘
                   │ EXPIRED  │  退款退券 ↗(USED→CLAIMED)
                   │ (已过期) │
                   └──────────┘

非法跳转拦截：
- CREATED → USED（未领取就用，拦截）
- USED → CLAIMED（非退款场景回退，拦截）
- EXPIRED → 任何状态（过期不可复活，拦截）
```

**核销链路全景**：

```
领券：用户点"领券"
  │
  ├─ 1. 防刷风控检查（设备指纹/行为/账号）
  ├─ 2. Redis Lua 原子：扣券库存 + 记用户领取次数
  ├─ 3. 写券记录到 DB（异步）
  └─ 4. 返回领取成功

用券：用户下单选券
  │
  ├─ 1. 校验券状态（CLAIMED）+ 有效期 + 适用范围
  ├─ 2. 计算优惠金额（满减/折扣/直减）
  ├─ 3. 乐观锁更新券状态（CLAIMED→USED，关联订单）
  └─ 4. 订单支付成功后券核销完成

退券：订单取消/退款
  │
  ├─ 1. 校验券状态（USED）+ 关联订单匹配
  ├─ 2. 状态回退（USED→CLAIMED）
  └─ 3. 券有效期顺延（补偿占用时间）

过期：定时任务
  │
  └─ 扫描 CLAIMED 且过期，转 EXPIRED，释放预算
```

## 二、机制层：防超领（Redis Lua 原子扣减）

**领券 Lua 脚本**：

```java
@Service
public class CouponClaimService {

    @Autowired private RedisTemplate redis;

    private DefaultRedisScript<Long> claimScript;

    @PostConstruct
    public void init() {
        // Lua 脚本：原子完成"检查用户领取次数 + 扣减券库存 + 记录领取"
        String script =
            "local stockKey = KEYS[1] " +              // coupon:stock:{activityId}
            "local userKey = KEYS[2] " +               // coupon:user:{activityId}:{userId}
            "local maxPerUser = tonumber(ARGV[1]) " +  // 每人限领数
            // 1. 检查用户已领次数
            "local claimed = tonumber(redis.call('GET', userKey) or '0') " +
            "if claimed >= maxPerUser then return -1 end " +   // 超限
            // 2. 检查券库存
            "local stock = tonumber(redis.call('GET', stockKey) or '0') " +
            "if stock <= 0 then return 0 end " +              // 售罄
            // 3. 扣库存 + 增用户领取次数
            "redis.call('DECR', stockKey) " +
            "redis.call('INCR', userKey) " +
            "return 1";                                       // 成功
        claimScript = new DefaultRedisScript<>(script, Long.class);
    }

    /**
     * 领券：防超领 + 防超发
     */
    public ClaimResult claim(Long userId, Long activityId) {
        // 1. 防刷风控（领券前）
        FraudResult fraud = antiFraudService.check(userId, activityId);
        if (fraud.isReject()) {
            monitor.record("coupon_fraud_reject", userId);
            return ClaimResult.reject(fraud.getReason());
        }

        // 2. 预算熔断检查
        if (budgetService.isExhausted(activityId)) {
            monitor.record("coupon_budget_exhausted", activityId);
            return ClaimResult.reject("券已抢光");
        }

        // 3. Redis 原子领券
        int maxPerUser = activityRepo.getMaxPerUser(activityId);
        Long result = (Long) redis.execute(claimScript,
            Arrays.asList(
                "coupon:stock:" + activityId,
                "coupon:user:" + activityId + ":" + userId),
            String.valueOf(maxPerUser));

        if (result == 1L) {
            // 4. 异步写 DB（不阻塞领券响应）
            String couponId = generateCouponId();
            mqTemplate.asyncSend("coupon-claim", new ClaimMessage(userId, activityId, couponId));
            monitor.record("coupon_claim_success", activityId, userId);
            return ClaimResult.success(couponId);
        } else if (result == -1L) {
            return ClaimResult.reject("超过限领次数");
        } else {
            return ClaimResult.reject("券已抢光");
        }
    }
}
```

**异步消费写 DB**：

```java
@Component
@RocketMQMessageListener(topic = "coupon-claim", consumerGroup = "coupon-consumer")
public class CouponClaimConsumer implements RocketMQListener<ClaimMessage> {

    @Autowired private CouponRepository couponRepo;

    @Override
    @Transactional
    public void onMessage(ClaimMessage msg) {
        // 幂等检查（防重复消费）
        if (couponRepo.existsById(msg.getCouponId())) {
            return;
        }
        // 写券记录（状态 CLAIMED）
        Coupon coupon = new Coupon();
        coupon.setId(msg.getCouponId());
        coupon.setUserId(msg.getUserId());
        coupon.setActivityId(msg.getActivityId());
        coupon.setStatus("CLAIMED");
        coupon.setExpireTime(calculateExpireTime());
        couponRepo.save(coupon);

        // 预算统计（Redis INCRBY 已发券金额）
        redis.opsForValue().increment("coupon:budget:used:" + msg.getActivityId(),
            coupon.getFaceValue());
    }
}
```

## 三、机制层：用券核销（状态机+乐观锁）

**用券核销服务**：

```java
@Service
public class CouponRedeemService {

    @Autowired private CouponRepository couponRepo;

    /**
     * 核销券：下单时调用
     */
    @Transactional
    public RedeemResult redeem(String couponId, Long orderId, BigDecimal orderAmount) {
        // 1. 查券
        Coupon coupon = couponRepo.findById(couponId)
            .orElseThrow(() -> new CouponNotFoundException(couponId));

        // 2. 状态机校验（必须是 CLAIMED）
        if (!"CLAIMED".equals(coupon.getStatus())) {
            monitor.record("coupon_illegal_state", couponId, coupon.getStatus());
            throw new IllegalCouponStatusException("券状态异常：" + coupon.getStatus());
        }

        // 3. 有效期校验
        if (coupon.getExpireTime().isBefore(LocalDateTime.now())) {
            throw new CouponExpiredException("券已过期");
        }

        // 4. 适用范围校验（满减门槛/商品范围/店铺范围）
        BigDecimal discount = calculateDiscount(coupon, orderAmount);
        if (discount.compareTo(BigDecimal.ZERO) <= 0) {
            throw new CouponNotApplicableException("券不满足使用条件");
        }

        // 5. 乐观锁核销（CLAIMED→USED，防并发双花）
        int updated = couponRepo.redeemWithOptimisticLock(
            couponId, orderId, "USED",
            coupon.getVersion());   // 旧 version
        if (updated == 0) {
            monitor.record("coupon_concurrent_redeem", couponId);
            throw new ConcurrentRedeemException("券已被使用或状态变更");
        }

        monitor.record("coupon_redeem_success", couponId, discount);
        return RedeemResult.success(discount);
    }
}
```

**乐观锁 SQL**（防并发双花）：

```sql
-- 乐观锁核销：只有 status=CLAIMED 且 version 匹配才能更新
UPDATE t_coupon
SET status = 'USED',
    used_order_id = #{orderId},
    used_time = NOW(),
    version = version + 1
WHERE id = #{couponId}
  AND status = 'CLAIMED'        -- 状态机校验
  AND version = #{oldVersion};  -- 乐观锁

-- affected rows = 1 表示核销成功，0 表示并发冲突或状态已变
```

**退券（订单取消/退款）**：

```java
@Service
public class CouponRefundService {

    /**
     * 退券：订单退款时调用
     */
    @Transactional
    public void refund(String couponId, Long orderId) {
        Coupon coupon = couponRepo.findById(couponId).orElseThrow();

        // 1. 校验状态（必须 USED）+ 订单关联
        if (!"USED".equals(coupon.getStatus())) {
            throw new IllegalCouponStatusException("非已使用状态不可退");
        }
        if (!orderId.equals(coupon.getUsedOrderId())) {
            throw new CouponOrderMismatchException("券和订单不匹配");
        }

        // 2. 状态回退（USED→CLAIMED）
        int updated = couponRepo.refundWithOptimisticLock(
            couponId, "CLAIMED", coupon.getVersion());
        if (updated == 0) {
            throw new ConcurrentRefundException("退券并发冲突");
        }

        // 3. 有效期补偿（顺延 24 小时，补偿占用时间）
        couponRepo.extendExpireTime(couponId, Duration.ofHours(24));

        monitor.record("coupon_refund", couponId);
    }
}
```

## 四、机制层：防刷体系

**防刷风控规则链**：

```java
@Service
public class CouponAntiFraud {

    public FraudResult check(Long userId, Long activityId) {
        // 规则 1：新账号拦截（注册 < 3 天）
        if (userRepo.getAccountAgeDays(userId) < 3) {
            return FraudResult.reject("新账号不可领券");
        }

        // 规则 2：设备指纹聚集（同设备多账号 = 黄牛）
        String deviceFingerprint = deviceService.getFingerprint(userId);
        List<Long> accountsOnDevice = deviceService.findAccounts(deviceFingerprint);
        if (accountsOnDevice.size() > 5) {
            monitor.record("device_cluster_fraud", deviceFingerprint);
            return FraudResult.reject("设备异常");
        }

        // 规则 3：行为异常（高频领券 = 机器人）
        int claimCountToday = claimHistoryRepo.countToday(userId);
        if (claimCountToday > 10) {
            return FraudResult.challenge("需要验证码");
        }

        // 规则 4：领券不用（历史领取但使用率 < 20%）
        double useHistoryRate = useHistoryService.calcUseRate(userId);
        if (useHistoryRate < 0.2 && useHistoryService.getTotalClaimed(userId) > 20) {
            return FraudResult.reject("领取使用率异常");
        }

        // 规则 5：IP 频次（同 IP 短时高频）
        int ipClaimCount = ipStatService.countRecent(getClientIp(), Duration.ofMinutes(10));
        if (ipClaimCount > 50) {
            return FraudResult.challenge("IP 频次异常，需短信验证");
        }

        return FraudResult.pass();
    }
}
```

**预算熔断**（防预算超支）：

```java
@Service
public class BudgetService {

    /**
     * 预算熔断：实时统计已发券金额，达阈值停发
     */
    public boolean isExhausted(Long activityId) {
        BigDecimal used = getCurrentUsed(activityId);
        BigDecimal total = activityRepo.getBudget(activityId);

        BigDecimal ratio = used.divide(total, 4, HALF_UP);

        // 80% 预警
        if (ratio.compareTo(new BigDecimal("0.8")) >= 0) {
            monitor.record("coupon_budget_warning", activityId, ratio);
        }

        // 100% 熔断
        return ratio.compareTo(BigDecimal.ONE) >= 0;
    }

    private BigDecimal getCurrentUsed(Long activityId) {
        // 从 Redis 读实时已发券金额（领券时 INCRBY）
        String val = (String) redis.opsForValue().get("coupon:budget:used:" + activityId);
        return val != null ? new BigDecimal(val) : BigDecimal.ZERO;
    }
}
```

## 五、底层本质：券系统的本质是"有限预算的公平分配"

回到第一性：**券系统的本质是"把有限的营销预算公平分配给真实用户，最大化营销 ROI"**。

- **有限预算**：券不是无限发的，预算是 1 亿就是 1 亿。超发意味着亏钱，少发意味着营销效果不够。所以必须精确控制发放量（Redis 原子扣减）和实时预算统计（熔断）。
- **公平分配**：每人限领 N 张（防一人薅光）、新账号限制（防黄牛批量注册）、设备指纹（防同设备多账号）。公平的目的是让更多真用户拿到券，营销覆盖面广。
- **真实用户**：防刷的本质是"识别真用户"——用行为序列、账号画像、设备指纹综合判断。黑产的破绽是"批量、高频、不消费"——领了不用（转卖）或领了立刻用最低金额套现。
- **ROI 最大化**：券是要花钱的（补贴），必须带来增量（新用户/新订单）。监控领取率、使用率、ROI（券带来的增量 GMV / 券成本），ROI 低的券停止投放。

**状态机的本质是"约束券的合法流转"**：券有生命周期（创建→领取→使用→过期），状态机保证只能按合法路径流转。这防止了非法操作——比如未领取就用（CREATED→USED 跳过领取）、用过的券再用（USED→USED）、过期券复活（EXPIRED→CLAIMED）。每个状态转换都有业务含义（领取=锁定给用户，使用=核销，退券=订单退款回退）。状态机是"业务规则的形式化"——把"券怎么用"的规则变成代码可校验的约束。

**防超领的本质是"原子性"**：高并发下，10 万人同时领 1 万张券，如果"检查库存"和"扣减库存"是两个操作，可能 10 万人都检查到有库存，然后都扣减，结果超发。Redis Lua 脚本把两者合并成一个原子操作（Redis 单线程保证不被中断），从根本上杜绝超领。这是"把临界区缩小到一个 Redis 命令"的并发控制思想。

**防刷的本质是"成本不对称博弈"**：黑产薅券的成本极低（脚本批量注册账号），收益高（券可转卖套现）。防刷要让黑产的成本 > 收益——设备指纹识别增加注册成本，行为风控增加操作成本，预算熔断限制单次攻击收益。当黑产的边际成本 > 边际收益，他们会放弃。

## 六、AI 架构师加问：5 个

1. **用 AI 识别黑产薅券，怎么做？**
   AI 用图神经网络（GNN）分析账号关系——同设备/同 IP/同收货地址的账号构成"社区"，异常社区（百账号一设备）判定为黑产团伙。比规则引擎（单点判断）更准——黑产会绕过单点规则（换 IP/换设备），但难绕过关系图谱。京东实践：AI 黑产识别准确率 95%+，每天拦截百万级薅券请求。

2. **AI 预测用户领券后的使用概率，怎么做？**
   AI 用用户画像（历史消费/领券使用率/品类偏好）预测"领这张券后会不会用"。对"大概率不用"的用户不优先发券（券给更可能用的人），提高券使用率（ROI）。但这是"优先级"不是"歧视"——每个用户都能领，只是高概率用户优先。

3. **AI 动态调整券面额，怎么做？**
   AI 根据用户价格敏感度动态发券——价格敏感的用户发大额券（促成转化），不敏感的发小额（省预算）。但这是"个性化补贴"有"杀熟"嫌疑，需产品确认合规。京东做法：新用户大额券（拉新），老用户按消费习惯发品类券（复购）。

4. **AI 预测券预算消耗速度，提前预警，怎么做？**
   AI 根据领券速度曲线预测"按当前速度，预算何时耗尽"。如果预测耗尽时间早于活动结束，建议运营加预算或收紧领取门槛。避免活动中途券发完，后半程用户领不到。

5. **AI 检测"券套现"（用券买低价商品再退货套现），怎么做？**
   AI 监控"领券→下单→退货"的异常模式——正常用户退货率低，黑产套现退货率高。AI 学习正常用户的券使用模式，异常模式（高退货率+券金额接近订单金额）标记为套现，拒绝退券或冻结账号。

## 七、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"状态机管流转、Redis 防超领、乐观锁防双花、风控防薅券、对账保资金"**。

- **券状态机**：CREATED→CLAIMED→USED/EXPIRED，退券 USED→CLAIMED
- **防超领**：Redis Lua（检查用户领取次数+扣库存，原子）
- **防超用**：乐观锁 UPDATE WHERE status=CLAIMED AND version=x
- **防刷四件套**：新账号拦截 + 设备指纹 + 行为风控 + 预算熔断
- **对账**：发放量 = 领取量 = 使用量 + 过期量 + 余额

### 面试现场 60 秒回答

> 券系统核心是"核销链路严谨 + 防刷体系完善"。券状态机四状态——CREATED（待领取）、CLAIMED（已领取）、USED（已使用）、EXPIRED（已过期），状态转换有约束（CREATED→CLAIMED→USED 合法，跳过领取直接用是非法）。防超领——领券用 Redis Lua 脚本，原子完成"检查用户已领次数 + 扣减券库存"，Redis 单线程保证不超领，成功后异步写 DB。防超用（防并发双花）——用券时乐观锁 UPDATE WHERE status=CLAIMED AND version=旧值，affected rows=1 才核销成功，0 表示并发冲突。退券——订单退款时 USED→CLAIMED 状态回退，券有效期顺延补偿。防刷四件套——新账号拦截（注册 < 3 天）、设备指纹聚集识别（同设备多账号=黄牛）、行为风控（高频领券需验证码）、预算熔断（达 100% 停发）。对账——发放量 = 领取量 = 使用量 + 过期量 + 余额，每日跑批，监控 coupon_anomaly_count（异常数）、coupon_fraud_reject（防刷拦截数）、coupon_concurrent_redeem（并发双花数，应为 0）。最关键的是"有限预算公平分配给真用户，最大化 ROI"——这是券系统区别于普通 CRUD 的本质。

## 八、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不直接用 DB 扣减券库存（要 Redis）？ | 高并发领券场景（大促秒级万级 QPS），DB 扛不住。Redis 单线程 10 万 QPS，Lua 脚本原子防超领。用 claim_qps（领券 QPS）和 oversell_count（超领数，应为 0）量化，oversell_count > 0 是 P0 故障 |
| 证据追问 | 怎么证明券系统没有资金漏洞？ | 对账——发放量=领取量=使用量+过期量+余额，每日跑批，差异为 0；监控 coupon_anomaly_count（异常数）、concurrent_redeem_count（并发双花数，应为 0）；压测——模拟万并发领同一券，断言只成功 N 张 |
| 边界追问 | 券能完全防薅吗？ | 不能。黑产持续进化（绕过设备指纹/养号），防刷是动态博弈。目标是提高黑产成本至不划算，不是绝对杜绝。靠 AI 图谱识别 + 规则持续迭代 |
| 反例追问 | 什么场景券不用 Redis（DB 够用）？ | 低频领券（B 端券/内部券），QPS < 100，DB 直接扛。但 C 端营销券必须 Redis |
| 风险追问 | 券系统最大风险？ | 主动点出：超发（预算超支）、超领（一人薅光）、双花（一券多用）、套现（买低价退货）。靠 Redis 原子+乐观锁+风控+对账组合防护 |
| 验证追问 | 怎么验证防刷有效？ | 黑产样本回放（已知黑产账号，验证是否被拦截）；AB 测试（开/关风控对比薅券率）；监控 fraud_reject_rate（拦截率）和 false_positive_rate（误杀率，应 < 5%） |
| 沉淀追问 | 券系统沉淀什么？ | 券状态机框架、Lua 领券脚本、防刷规则引擎、对账工具、券监控大盘（领取率/使用率/ROI/防刷拦截率） |

### 现场对话示例

**面试官**：领券时 Redis 扣减成功，但异步写 DB 失败（比如 DB 挂了），怎么办？

**候选人**：这是"Redis 成功 DB 失败"的一致性问题。解法是"消息可靠投递 + 重试 + 对账补偿"。第一步，异步写 DB 用 MQ（RocketMQ 事务消息）——MQ 保证消息不丢（持久化），消费方重试保证最终写入。第二步，重试失败的消息进死信队列，告警人工处理。第三步，兜底对账——定时任务对比 Redis 已扣减数和 DB 券记录数，差异 > 0 时补写 DB（用 Redis 的领取记录重建券记录）。极端情况 Redis 和 DB 都异常——Redis 主从切换保证可用，DB 主从切换，整体降级方案是"暂停领券"（保护性，宁可拒绝也不超发）。京东的实践：领券链路 Redis 成功率 99.99%，DB 异步写入成功率 99.999%（MQ 重试），对账每日跑批修正差异（差异率 < 0.001%）。用户侧——如果领券成功但 DB 没记录，用户看不到券，客服可凭 Redis 记录补发。

**面试官**：用户领了券不用（过期了），预算怎么回收？

**候选人**：过期券的预算回收分两种情况。第一种，活动还在进行（预算可循环用）——券过期释放预算，可发给其他用户。实现：过期定时任务把 CLAIMED→EXPIRED，同时 Redis 预算已用金额扣减对应面值（INCRBY -100），库存加回（INCR）。这样预算"流转"给新领取的用户。第二种，活动已结束——过期券的预算不回收（活动结束不再发新券），但对账时要统计"过期券金额"作为营销成本核算（实际花了多少 vs 计划预算）。监控 coupon_expire_rate（过期率）——过期率高说明券发给了不合适的用户（不用），需优化发券策略（精准发给可能用的用户）。京东的实践：券过期率控制在 30% 以内（目标使用率 70%+），过期率高的活动复盘优化人群定向。

**面试官**：券和订单是不同系统，用券时订单还没创建（订单 ID 没有），怎么关联？

**候选人**：券核销分两阶段。第一阶段，下单预占券（订单创建时）——订单系统调券系统"预占"券（CLAIMED→LOCKED 中间状态），券系统返回预占号（lockId），订单带着 lockId 创建。如果订单创建失败，券系统超时（10 分钟）自动释放 LOCKED→CLAIMED。第二阶段，支付成功确认核销（订单支付时）——支付回调触发券系统把 LOCKED→USED，写入实际订单 ID。这样券和订单通过 lockId 解耦，订单创建失败不影响券（超时释放），支付成功才真正核销。状态机变成 CREATED→CLAIMED→LOCKED→USED（多一个 LOCKED 预占态）。监控 coupon_lock_timeout（预占超时释放数）——超时多说明用户下单不支付，需优化（如支付倒计时提醒）。京东的实践：券预占 10 分钟超时，支付成功率 85%+，预占超时释放的券快速回流给其他用户。

## 常见考点

1. **券和积分的区别？**——券有面值和门槛（营销补贴，要花钱），积分是返利（消费后给，可抵扣）。券核销即扣减预算，积分核销是积分池扣减。
2. **券为什么不能转让？**——防套现（转卖给黄牛）+ 营销定向（券是发给特定用户的补贴）。转让会让营销预算流向非目标用户，ROI 不可控。
3. **券核销和订单的事务怎么保证？**——券核销和订单创建在同一分布式事务（Seata）或消息最终一致。券预占（LOCKED）和订单创建可跨系统异步。
4. **怎么设计券的适用范围（满减/商品/店铺）？**——规则引擎（和价格系统类似），券配置适用条件，核销时校验。复杂规则用 DSL，简单规则用配置表。

## 结构化回答

**30 秒电梯演讲：** 优惠券系统表面简单（发券、用券），内核复杂——核销链路涉及券状态机 + 并发防超领/超用 + 防刷 + 对账。核心矛盾是营销补贴是有限预算，怎么让真用户拿到、真订单用掉，不被黑产薅光。架构三板斧：券状态机（待领取/已领取/已使用/已过期，防非法流转）、原子领券（Redis Lua 防超领）、防刷（设备指纹+行为风控+预算熔断）

**展开框架：**
1. **券状态机** — 待领取(CREATED)→已领取(CLAIMED)→已使用(USED)/已过期(EXPIRED)，非法跳转拦截
2. **防超领** — Redis Lua 原子扣减库存 + 用户领取次数限制
3. **防超用** — 用券时乐观锁（UPDATE WHERE status=CLAIMED AND version=x）

**收尾：** 以上是我的整体思路。您想继续深入聊——券退回怎么处理？


## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：优惠券系统核销链路与防刷设计 | "这题一句话：优惠券系统表面简单（发券、用券），内核复杂——核销链路涉及券状态机 + 并发防超领/超用 + 防刷 + 对账。" | 开场钩子 |
| 0:15 | 券状态机示意/对比图 | "待领取(CREATED)→已领取(CLAIMED)→已使用(USED)/已过期(EXPIRED)，非法跳转拦截" | 券状态机要点 |
| 0:40 | 防超领示意/对比图 | "Redis Lua 原子扣减库存 + 用户领取次数限制" | 防超领要点 |
| 1:25 | 总结卡 | "记住：券状态机。下期见。" | 收尾 |
