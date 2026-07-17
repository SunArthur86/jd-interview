---
id: java-architect-060
difficulty: L4
category: java-architect
subcategory: 交易架构
tags:
- Java 架构师
- 账户系统
- 复式记账
- 对账
- 资金安全
feynman:
  essence: 账户系统是金融级基础设施——"钱不能多也不能少"。核心是"复式记账（有借必有贷，借贷必相等）+ 流水不可篡改（追加写+哈希链）+ 实时对账（余额=流水汇总）"。账户余额不是直接更新的数字，而是"流水汇总"的结果——每一笔交易记一条流水（借/贷），余额 = 初始余额 + SUM(流水)。这样任何余额都可由流水重算验证，资金可追溯。
  analogy: 像银行存折。存折上不是直接改"余额"，而是每笔交易记一行（日期、存/取、金额），余额是累加的结果。你对账时，把所有存取累加，应该等于余额——对不上就是账错了。账户系统一样——余额不是独立存储的数字，而是流水的汇总。这就是"流水是账本，余额是视图"。
  first_principle: 为什么余额不能直接 UPDATE +1/-1？因为并发更新会丢失（两个事务都读到 100，各扣 50，写回都 50，实际应该是 0）；而且直接改余额无审计痕迹（查不到为什么变了）。解法是"流水追加写"——每笔交易 INSERT 一条流水（不可改），余额由流水汇总。并发用乐观锁或"余额表 + 流水表"分离（流水高并发写，余额低频更新）。
  key_points:
  - 复式记账：每笔交易借方贷方平衡（A 转 B：A 借，B 贷，金额相等）
  - 流水追加写：INSERT only，不可 UPDATE/DELETE，哈希链防篡改
  - 余额一致性：余额表 = SUM(流水)，定时对账修正
  - 并发控制：乐观锁（version）或悲观锁（SELECT FOR UPDATE）
  - 账户冻结/解冻：预占额度（frozen），对应"可用=余额-冻结"
first_principle:
  problem: 账户余额涉及钱，怎么保证高并发下不错账、不丢钱、可审计？
  axioms:
  - 钱不能错（差一分都是 P0 故障）
  - 并发扣款不能丢失更新（两事务并发扣同一账户）
  - 每笔交易必须可追溯（审计/对账/合规）
  - 余额必须随时可由流水重算验证（防数据腐败）
  rebuild: 复式记账 + 流水追加写 + 余额分离。流水表 INSERT only（记录每笔借贷，哈希链防篡改），余额表用乐观锁更新（version 字段）。账户操作走"写流水 + 更余额"两步，事务保证原子。对账定时跑：余额表 vs SUM(流水)，差异告警。冻结额度独立字段（frozen_balance），可用 = balance - frozen。T+1 全量对账（和银行/支付渠道对），实时增量对账（关键账户秒级）。
follow_up:
  - 高并发扣款怎么优化？——余额表分片（按 user_id），避免热点；乐观锁重试；流水异步写（先扣余额后补流水，靠对账兜底）。
  - 账户透支怎么防？——扣款前校验 balance >= amount，可用乐观锁 CAS（UPDATE WHERE balance >= amount）。
  - 怎么做账户冻结？——frozen_balance 字段，冻结时 INCR frozen，解冻 DECR；可用余额 = balance - frozen_balance。
  - 对账发现差异怎么修？——不能直接改余额（破坏审计），要写"调整流水"（adjustment），记原因和审批人，余额由流水重算。
  - 账户系统怎么容灾？——同城双活（主写单机房，只读多机房），跨城灾备（异步复制）。资金数据零丢失（RPO=0）。
memory_points:
  - 复式记账：借贷必相等
  - 流水追加写：INSERT only + 哈希链
  - 余额 = SUM(流水)，对账验证
  - 并发：乐观锁 version 或 CAS（WHERE balance >= amount）
  - 冻结：frozen_balance 字段，可用 = balance - frozen
---

# 【Java 后端架构师】账户余额、流水与对账架构

> 适用场景：JD 资金核心。用户钱包余额、商家收款账户、平台营销账户、供应商结算账户——所有涉及"钱"的账户都要保证"余额准确、流水可查、对账闭环"。这不是普通 CRUD，而是金融级系统：差一分钱都是 P0 故障。核心是"复式记账 + 流水追加写 + 多层对账"。

## 一、概念层：账户系统的金融级要求

**账户模型三要素**：

```
账户（Account）：who
  ├─ account_id（账户 ID）
  ├─ user_id（所属用户/商户）
  ├─ account_type（类型：WALLET/SETTLEMENT/MARKETING）
  ├─ balance（余额）          ← 余额视图，由流水汇总
  ├─ frozen_balance（冻结额）  ← 预占额度
  └─ version（乐观锁版本号）

流水（Ledger）：what happened
  ├─ ledger_id（流水 ID，全局唯一）
  ├─ account_id（账户）
  ├─ direction（方向：DEBIT 借 / CREDIT 贷）
  ├─ amount（金额）
  ├─ business_type（业务类型：RECHARGE/PAY/REFUND/SETTLE）
  ├─ business_id（业务单号，关联订单/支付）
  ├─ prev_hash（前一条流水的哈希，哈希链防篡改）
  └─ curr_hash（本条流水哈希）

对账（Reconciliation）：is it correct
  ├─ 余额表 balance vs SUM(流水) ← 内部对账
  ├─ 平台账 vs 银行/支付渠道账 ← 外部对账
  └─ 差异处理（长款/短款）
```

**复式记账原理**（核心）：

```
用户 A 用钱包余额 100 元买商家 B 的商品：

借（DEBIT）              贷（CREDIT）
───────────────────────────────────
A 钱包账户  100  ──┐
                   ├── 金额相等（借贷平衡）
B 商家结算账户     100

两条流水，金额相等，方向相反。任何时刻：SUM(所有借) = SUM(所有贷)
这保证了"钱不凭空多/少"——总额守恒。
```

**为什么不用单式记账（直接改余额）**：

| 维度 | 单式记账（直接改） | 复式记账（流水汇总） |
|------|---------------------|----------------------|
| 并发 | 丢失更新（两事务并发扣） | 流水 INSERT 无冲突 |
| 审计 | 无痕迹（余额变了不知为何） | 每笔可追溯 |
| 对账 | 无法验证（余额是孤值） | 余额=SUM(流水)可重算 |
| 防错 | 错了难发现 | 借贷不平衡立即发现 |
| 适用 | 简单计数器 | 金融账户（选这个） |

## 二、机制层：账户操作核心代码

**扣款（乐观锁 + 流水追加）**：

```java
@Service
public class AccountService {

    @Autowired private AccountRepository accountRepo;
    @Autowired private LedgerRepository ledgerRepo;

    /**
     * 扣款：写流水 + 扣余额（事务原子）
     */
    @Transactional
    public void debit(Long accountId, BigDecimal amount, String businessType, String businessId) {
        // 1. 查账户（带乐观锁版本号）
        Account account = accountRepo.findById(accountId)
            .orElseThrow(() -> new AccountNotFoundException(accountId));

        // 2. 校验可用余额（余额 - 冻结 >= 扣款额）
        BigDecimal available = account.getBalance().subtract(account.getFrozenBalance());
        if (available.compareTo(amount) < 0) {
            throw new InsufficientBalanceException("余额不足");
        }

        // 3. 写流水（DEBIT 方向，追加写，哈希链）
        String prevHash = ledgerRepo.getLatestHash(accountId);
        Ledger ledger = new Ledger();
        ledger.setAccountId(accountId);
        ledger.setDirection("DEBIT");
        ledger.setAmount(amount);
        ledger.setBusinessType(businessType);
        ledger.setBusinessId(businessId);
        ledger.setPrevHash(prevHash);
        ledger.setCurrHash(computeHash(prevHash, accountId, "DEBIT", amount, businessId));
        ledgerRepo.insert(ledger);   // INSERT only，不可改

        // 4. 乐观锁更新余额
        int updated = accountRepo.debitWithOptimisticLock(
            accountId, amount, account.getVersion());
        if (updated == 0) {
            throw new ConcurrentModifyException("账户并发修改，请重试");
        }

        monitor.record("account_debit", accountId, amount);
    }

    private String computeHash(String... parts) {
        String joined = String.join("|", parts);
        return DigestUtils.sha256Hex(joined);
    }
}
```

**乐观锁扣款 SQL**（关键）：

```sql
-- 乐观锁扣款：balance >= amount 才扣，version 匹配才更新
UPDATE t_account
SET balance = balance - #{amount},
    version = version + 1,
    updated_at = NOW()
WHERE id = #{accountId}
  AND version = #{oldVersion}
  AND balance - frozen_balance >= #{amount};   -- 可用余额校验

-- affected rows = 1 成功，0 = 并发冲突或余额不足
```

**复式记账转账**（A 转 B）：

```java
@Service
public class TransferService {

    /**
     * 转账：A 借 + B 贷，原子事务
     */
    @Transactional
    public void transfer(Long fromAccount, Long toAccount, BigDecimal amount, String businessId) {
        try {
            // 1. A 扣款（DEBIT）
            accountService.debit(fromAccount, amount, "TRANSFER_OUT", businessId);
            // 2. B 加款（CREDIT）
            accountService.credit(toAccount, amount, "TRANSFER_IN", businessId);
            // 事务提交，两步要么都成功要么都失败（原子）
        } catch (Exception e) {
            // 自动回滚（@Transactional），A 不会扣了 B 没加
            throw e;
        }
    }
}
```

**账户冻结/解冻**（下单预占额度）：

```java
@Service
public class AccountFreezeService {

    /**
     * 冻结：不扣余额，增加 frozen_balance（可用 = balance - frozen 减少）
     */
    @Transactional
    public void freeze(Long accountId, BigDecimal amount, String businessId) {
        Account account = accountRepo.findByIdForUpdate(accountId);  // 悲观锁
        BigDecimal available = account.getBalance().subtract(account.getFrozenBalance());
        if (available.compareTo(amount) < 0) {
            throw new InsufficientBalanceException("可用余额不足");
        }

        // 写冻结流水
        ledgerRepo.insert(buildLedger(accountId, "FREEZE", amount, businessId));

        // 增加冻结额
        accountRepo.addFrozen(accountId, amount);
    }

    /**
     * 解冻并扣款（支付成功：冻结额转实扣）
     */
    @Transactional
    public void freezeAndDeduct(Long accountId, BigDecimal amount, String businessId) {
        // 1. 释放冻结
        accountRepo.reduceFrozen(accountId, amount);
        // 2. 实扣余额
        accountRepo.debit(accountId, amount);
        // 3. 写扣款流水
        ledgerRepo.insert(buildLedger(accountId, "DEBIT", amount, businessId));
    }

    /**
     * 解冻（订单取消：冻结额释放回可用）
     */
    @Transactional
    public void unfreeze(Long accountId, BigDecimal amount, String businessId) {
        accountRepo.reduceFrozen(accountId, amount);
        ledgerRepo.insert(buildLedger(accountId, "UNFREEZE", amount, businessId));
    }
}
```

## 三、机制层：流水哈希链防篡改

**哈希链设计**（审计级防篡改）：

```java
/**
 * 流水哈希链：每条流水的 hash 依赖前一条的 hash
 * 篡改任意一条，后续所有 hash 都不匹配，立即发现
 */
@Component
public class LedgerHashChain {

    /**
     * 写流水时计算哈希
     */
    public String computeHash(Ledger ledger, String prevHash) {
        String content = String.join("|",
            prevHash,
            ledger.getAccountId().toString(),
            ledger.getDirection(),
            ledger.getAmount().toString(),
            ledger.getBusinessId(),
            ledger.getCreatedAt().toString()
        );
        return DigestUtils.sha256Hex(content);
    }

    /**
     * 验证哈希链完整性（对账时跑）
     */
    public HashChainVerifyResult verifyChain(Long accountId) {
        List<Ledger> ledgers = ledgerRepo.findByAccountIdOrderByTime(accountId);
        String prevHash = "GENESIS";

        for (Ledger ledger : ledgers) {
            String expected = computeHash(ledger, prevHash);
            if (!expected.equals(ledger.getCurrHash())) {
                // 哈希不匹配——流水被篡改！
                monitor.record("ledger_tamper_detected", accountId, ledger.getId());
                return HashChainVerifyResult.tampered(ledger.getId());
            }
            prevHash = ledger.getCurrHash();
        }
        return HashChainVerifyResult.ok();
    }
}
```

## 四、机制层：多层对账体系

**对账架构**（三层）：

```
┌─────────────────────────────────────────────────────────────┐
│ 第 1 层：内部对账（实时/分钟级）                              │
│   余额表 balance vs SUM(流水 amount)                         │
│   差异 → 告警 + 写调整流水修正                                │
│   目的：防数据腐败（DB bug/并发问题）                         │
├─────────────────────────────────────────────────────────────┤
│ 第 2 层：外部对账（T+1 批量）                                 │
│   平台账 vs 银行/支付宝/微信账                                │
│   下载渠道账单 → 比对流水 → 长款/短款处理                     │
│   目的：防渠道通信问题（掉单/重复）                           │
├─────────────────────────────────────────────────────────────┤
│ 第 3 层：总分账（日终）                                       │
│   所有账户余额 SUM vs 总账控制账户                            │
│   目的：防系统性错误（整体资金守恒验证）                      │
└─────────────────────────────────────────────────────────────┘
```

**内部对账代码**：

```java
@Service
public class InternalReconcileService {

    /**
     * 单账户对账：余额表 vs 流水汇总
     */
    public ReconcileResult reconcileAccount(Long accountId) {
        // 1. 余额表的余额
        Account account = accountRepo.findById(accountId);
        BigDecimal balanceFromAccount = account.getBalance();

        // 2. 流水汇总（DEBIT 减，CREDIT 加）
        BigDecimal balanceFromLedger = ledgerRepo.sumByAccountId(accountId);

        // 3. 比对
        if (balanceFromAccount.compareTo(balanceFromLedger) != 0) {
            BigDecimal diff = balanceFromAccount.subtract(balanceFromLedger);
            monitor.record("balance_mismatch", accountId, diff);

            // 写调整流水修正（不能直接改余额，要留痕）
            writeAdjustment(accountId, diff, "对账差异修正");

            // 告警人工复核
            alertService.send("账户余额不一致", accountId, diff);
            return ReconcileResult.mismatch(diff);
        }
        return ReconcileResult.ok();
    }

    /**
     * 定时全量对账（凌晨跑批）
     */
    @Scheduled(cron = "0 0 2 * * ?")   // 每天凌晨 2 点
    public void fullReconcile() {
        List<Long> accountIds = accountRepo.findAllActiveAccountIds();
        int mismatchCount = 0;
        for (Long accountId : accountIds) {
            ReconcileResult result = reconcileAccount(accountId);
            if (result.isMismatch()) mismatchCount++;
        }
        monitor.record("reconcile_mismatch_rate",
            (double) mismatchCount / accountIds.size());
    }
}
```

**外部对账（和支付渠道）**：

```java
@Service
public class ChannelReconcileService {

    /**
     * T+1 对账：下载渠道账单，比对平台流水
     */
    @Scheduled(cron = "0 0 6 * * ?")   // 每天早上 6 点对昨日账
    public void reconcileWithChannel() {
        // 1. 下载渠道账单（支付宝/微信/银行）
        List<ChannelRecord> channelRecords = channelClient.downloadBill(yesterday());

        // 2. 查平台昨日流水
        List<Ledger> platformLedgers = ledgerRepo.findByDate(yesterday());

        // 3. 双向比对
        ReconcileResult result = bidirectionalMatch(channelRecords, platformLedgers);

        // 4. 处理差异
        for (Record missing : result.getPlatformMissing()) {
            // 长款：渠道有平台无——补单（渠道扣了款但平台没记）
            handleLongPayment(missing);
        }
        for (Record missing : result.getChannelMissing()) {
            // 短款：平台有渠道无——挂账待查（平台记了但渠道没成功）
            handleShortPayment(missing);
        }

        monitor.record("reconcile_long_count", result.getPlatformMissing().size());
        monitor.record("reconcile_short_count", result.getChannelMissing().size());
    }
}
```

## 五、底层本质：账户系统的本质是"资金守恒与可验证"

回到第一性：**账户系统的本质是"保证资金守恒（钱不凭空多/少）且任何时刻可验证（余额可由流水重算）"**。

- **资金守恒**：复式记账保证"借方总额=贷方总额"，钱只是在不同账户间流转，总额不变。这是物理定律级的约束——像能量守恒。任何单边记账（只记一方）都可能"钱凭空消失/出现"，复式记账从结构上杜绝。
- **可验证性**：余额不是独立存储的"数"，而是流水的"汇总视图"。任何时候余额表 = SUM(流水) 必须成立。这像"账本和存折对账"——存折（流水）是原始记录，余额是累加结果，两者必须一致。不一致说明数据出错（DB 损坏/并发 bug/篡改）。
- **不可篡改**：流水追加写（INSERT only，不可 UPDATE/DELETE），加哈希链（每条依赖前一条）。篡改任意一条流水，后续哈希全不匹配，立即发现。这是"审计级数据完整性"——像区块链的思路，用密码学保证不可改。
- **可对账**：三层对账（内部余额 vs 流水、平台 vs 渠道、总分账）形成闭环。任何错误都能被发现和修正（通过写调整流水，不是直接改余额）。

**余额表 vs 流水表分离的本质**：流水表是"高并发写"（每笔交易 INSERT），余额表是"低频读"（查询余额）。如果每次查余额都 SUM(流水)，性能差（流水可能百万条）。所以余额表做"物化视图"——实时维护余额，查询 O(1)。代价是余额表和流水表可能短暂不一致（并发/延迟），靠对账兜底。这是"读写分离 + 最终一致"的取舍——用对账换性能。

**冻结额的本质是"预占"**：下单时不能立刻扣余额（用户可能取消），但要把额度"占住"防止超额下单。冻结额（frozen_balance）就是这个"预占"——可用余额 = balance - frozen。下单冻结、支付成功转实扣、取消解冻。这解决了"下单到支付的时间差内如何防止超额"的问题。

## 六、AI 架构师加问：5 个

1. **用 AI 检测异常账户操作（洗钱/套现），怎么做？**
   AI 学习正常账户的交易模式（频率/金额/对手方），用异常检测识别偏离——如某账户突然大额转出（可能被盗）、频繁小额转入再集中转出（洗钱）、与黑名单账户交互。AI 用图神经网络分析账户关系网，识别团伙作案。京东金融实践：AI 风控每天拦截万级异常交易，准确率 98%+。

2. **用 AI 预测账户流动性（余额够不够兑付），怎么做？**
   AI 根据历史提现/消费模式预测未来 N 天的资金需求，提前准备备付金。预测偏低有兑付风险（用户提现失败），偏高资金闲置（成本）。AI 用时序模型（LSTM/Prophet）预测，准确率 90%+ 时用于备付金调度。

3. **AI 自动处理对账差异，怎么做？**
   对账差异（长款/短款）传统要人工判断处理。AI 学习历史差异处理案例，自动分类——"渠道延迟"类（自动等待重对）、"重复记账"类（自动冲正）、"真实差错"类（人工复核）。AI 处理 80% 的常见差异，20% 复杂的人工兜底。

4. **用 AI 做账户画像（信用评分），怎么做？**
   AI 根据账户历史（余额稳定性/流水规律/还款记录）算信用分，用于授信（花呗/白条）、提额。但这是金融级决策，AI 只是辅助——最终授信需人工审核+合规校验。京东白条：AI 评分 + 规则引擎 + 人工审核，三层决策。

5. **AI 检测账户系统异常（DB 性能/数据倾斜），怎么做？**
   AI 监控账户系统的指标（QPS/RT/错误率/数据分布），用异常检测识别偏离——如某账户突然成热点（被刷）、某分片数据量异常（分片不均）。AI 定位根因并触发自动处理（热点账户迁移、分片 rebalance）。

## 七、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"复式记账借贷平、流水追加哈希链、余额等于流水和、三层对账保资金"**。

- **复式记账**：每笔交易借方贷方平衡（A 转 B：A 借 B 贷，金额相等）
- **流水追加写**：INSERT only + 哈希链（prev_hash → curr_hash）防篡改
- **余额一致性**：余额表 = SUM(流水)，实时对账验证
- **并发控制**：乐观锁（version + WHERE balance >= amount）或悲观锁（FOR UPDATE）
- **冻结预占**：frozen_balance 字段，可用 = balance - frozen
- **三层对账**：内部（余额 vs 流水）+ 外部（平台 vs 渠道）+ 总分账

### 面试现场 60 秒回答

> 账户系统是金融级基础设施，核心是"复式记账 + 流水追加写 + 三层对账"。复式记账——每笔交易借方贷方平衡，A 转 B 就是 A 借 100、B 贷 100，保证资金守恒（钱不凭空多/少）。流水表 INSERT only（不可改不可删），加哈希链（每条 curr_hash 依赖前一条 prev_hash），篡改任意一条后续哈希全不匹配，审计级防篡改。余额表是流水的物化视图——balance = SUM(流水)，查询 O(1)，但靠对账保证一致。并发扣款用乐观锁——UPDATE WHERE id AND version=旧 AND balance-frozen >= amount，affected=1 成功，0 重试。账户冻结——frozen_balance 字段，下单时 INCR frozen（预占额度），支付成功转实扣（DECR frozen + DECR balance），取消则 DECR frozen（释放）。三层对账——内部（余额表 vs SUM 流水，分钟级，防数据腐败）、外部（平台 vs 支付渠道账单，T+1，防掉单/重复）、总分账（所有账户余额 SUM vs 控制账户，日终，防系统性错误）。对账发现差异不能直接改余额（破坏审计），要写调整流水（adjustment）留痕。监控 balance_mismatch（余额不一致数，应为 0）、ledger_tamper_detected（流水篡改数，应为 0）、reconcile_diff_count（对账差异数）。最关键的是"资金守恒且任何时刻可由流水重算验证"——这是账户系统区别于普通增删改的本质。

## 八、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不直接 UPDATE balance = balance - amount（要乐观锁+流水）？ | 直接 UPDATE 有两个问题：丢失更新（并发两事务都读到 100，各扣 50，写回 50，实际应 0）；无审计（余额变了不知为何）。乐观锁防并发，流水记审计。用 balance_mismatch（余额不一致数，应 0）和 lost_update_count（丢失更新数，应 0）量化 |
| 证据追问 | 怎么证明账户系统资金准确（一分不差）？ | 三层对账全通过 + 哈希链验证完整 + 压测（万并发扣同一账户，断言余额=初始-总扣）+ 外部审计（第三方审计账目）。监控 balance_mismatch（0）、reconcile_diff_count（0）、hash_chain_broken（0） |
| 边界追问 | 复式记账能处理所有场景吗？ | 不能。单边记账场景（如利息计算、手续费）要先确定对应账户。跨币种（外币转账）涉及汇率，需要"汇兑损益"账户平衡。复杂金融产品（期权/期货）需多账户联动 |
| 反例追问 | 什么场景不需要复式记账（单式够用）？ | 非资金场景——积分、虚拟币、库存。这些"丢了能补"（不是真钱），单式记账够用。但涉及真钱的账户必须复式 |
| 风险追问 | 账户系统最大风险？ | 主动点出：余额不一致（数据腐败/并发 bug）、资金丢失（掉单/重复扣）、流水篡改（内鬼/黑客）、对账遗漏（差异未发现累积）。靠哈希链+三层对账+实时告警组合防护 |
| 验证追问 | 怎么验证冻结/解冻正确？ | 不变式：可用余额 = balance - frozen >= 0（永不透支）；冻结总额 = 所有未支付订单冻结和；解冻和实扣金额匹配。监控 negative_available_count（可用为负数，应 0） |
| 沉淀追问 | 账户系统沉淀什么？ | 复式记账框架、流水哈希链工具、三层对账平台、账户监控大盘（余额一致性/流水完整性/对账差异率/并发冲突率） |

### 现场对话示例

**面试官**：高并发场景（双 11 万级 QPS 扣同一商户账户），乐观锁冲突率高怎么办？

**候选人**：乐观锁冲突率高时退化为"热点账户"问题。三层解法。第一层，账户分片——把一个商户账户拆成 N 个子账户（如 merchant:1234:0 到 merchant:1234:9），扣款随机选子账户，单子账户 QPS 降到 1/10。查总余额时 SUM 所有子账户。第二层，异步累积——高并发扣款先写流水（INSERT 无冲突），余额表异步批量更新（每秒汇总流水更新一次余额）。代价是余额有秒级延迟，但对账兜底（实时对账会发现差异并修正）。第三层，内存缓冲——热账户余额缓存到本地（Caffeine），扣款先在内存扣（无锁，超快），异步刷 DB。极端情况内存和 DB 不一致，靠"内存预扣 + DB 兜底 + 对账修正"保证最终一致。京东双 11 的实践：TOP 商户账户分片 100 个 + 内存缓冲，单商户支撑 10 万 QPS 扣款，乐观锁冲突率 < 0.1%。

**面试官**：对账发现"平台余额 1000，流水汇总 950，差 50"，怎么处理？

**候选人**：这是"余额表多 50"。第一步，不能直接改余额表（破坏审计），要查根因。可能原因：并发 bug（余额更新了但流水没写）、DB 数据腐败、历史迁移错误。第二步，查该账户近期所有操作日志，定位差异时间点（从什么时候开始差 50）。第三步，写"调整流水"修正——INSERT 一条 DEBIT 50 的流水，类型"ADJUSTMENT"，备注"对账差异修正，原因 XXX，审批人 YYY"。这样余额表（1000）和新流水汇总（950+50=1000）一致，且留有审计痕迹。第四步，如果是系统性 bug（多个账户都有类似差异），要修代码 + 全量对账修正。第五步，告警升级——单账户差异人工处理，批量差异 P0 告警（可能系统级故障）。监控 reconcile_diff_count（对账差异数）和 balance_mismatch_rate（不一致率，应 < 0.001%）。京东的实践：对账差异率 < 0.0001%（百万分之一），差异都有人工复核闭环。

**面试官**：流水哈希链被篡改（内鬼改了流水金额），怎么发现和恢复？

**候选人**：哈希链的设计就是防这个。内鬼改了第 N 条流水的金额，第 N 条的 curr_hash 会变（因为内容变了），但第 N+1 条的 prevHash 还是旧的（指向原来的 N 的 hash），computeHash(N+1) 用新的 prevHash 算出的 currHash 和存储的不匹配——发现篡改。具体步骤：对账时跑 verifyChain(accountId)，遍历所有流水，逐条验证 curr_hash == computeHash(prev_hash, content)。发现不匹配的，定位到具体被改的流水 ID。恢复：从备份恢复（T+1 全量备份 + binlog 增量），或从对端系统（如支付渠道）重建流水。预防：流水库独立权限（开发者不能直接改）、DB 审计日志（记录所有 DML 操作）、哈希链定时验证（每小时跑）。极端情况内鬼同时改了流水和哈希——这需要"外部锚定"，如把哈希定期写到独立系统（区块链/独立审计库），内鬼难同时改两个系统。京东金融的实践：流水表 DBA 无写权限（只有应用能 INSERT），哈希链每小时验证，篡改告警秒级响应。

## 常见考点

1. **账户系统和订单系统的区别？**——订单是"交易记录"（买了什么），账户是"资金状态"（有多少钱）。订单影响账户（下单扣余额），但两者解耦（订单系统调账户接口，不直接改账户）。
2. **复式记账和区块链的关系？**——区块链是"分布式复式记账"——每个交易借方贷方平衡（UTXO 模型），且哈希链防篡改。账户系统的复式记账是中心化的，区块链是去中心化的。
3. **账户余额为什么用 BigDecimal 不用 double？**——double 有精度丢失（0.1+0.2≠0.3），金融场景必须精确。BigDecimal 任意精度，适合金额计算。
4. **怎么做账户的"日终结算"？**——日终跑批：冻结所有交易 → 跑全量对账 → 计算利息/手续费 → 生成日报表 → 解冻。结算期间账户只读不可交易。

## 结构化回答

**30 秒电梯演讲：** 账户系统是金融级基础设施——钱不能多也不能少。核心是复式记账（有借必有贷，借贷必相等）+ 流水不可篡改（追加写+哈希链）+ 实时对账（余额=流水汇总）。账户余额不是直接更新的数字，而是流水汇总的结果——每一笔交易记一条流水（借/贷），余额 = 初始余额 + SUM(流水)。这样任何余额都可由流水重算验证，资金可追溯

**展开框架：**
1. **复式记账** — 每笔交易借方贷方平衡（A 转 B：A 借，B 贷，金额相等）
2. **流水追加写** — INSERT only，不可 UPDATE/DELETE，哈希链防篡改
3. **余额一致性** — 余额表 = SUM(流水)，定时对账修正

**收尾：** 以上是我的整体思路。您想继续深入聊——高并发扣款怎么优化？


## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：账户余额、流水与对账架构 | "这题一句话：账户系统是金融级基础设施——钱不能多也不能少。" | 开场钩子 |
| 0:15 | 像银行存折。存折上不是直接改余额，而是每类比图 | "打个比方：像银行存折。存折上不是直接改余额，而是每。" | 核心类比 |
| 0:40 | 复式记账示意/对比图 | "每笔交易借方贷方平衡（A 转 B：A 借，B 贷，金额相等）" | 复式记账要点 |
| 1:05 | 流水追加写示意/对比图 | "INSERT only，不可 UPDATE/DELETE，哈希链防篡改" | 流水追加写要点 |
| 1:30 | 余额一致性示意/对比图 | "余额表 = SUM(流水)，定时对账修正" | 余额一致性要点 |
| 1:55 | 总结卡 | "记住：复式记账。下期见。" | 收尾 |
