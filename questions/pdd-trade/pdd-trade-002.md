---
id: pdd-trade-002
difficulty: L4
category: pdd-trade
subcategory: 交易架构
tags:
- 拼多多
- 交易
- 支付
- 对账
- 分布式事务
feynman:
  essence: 支付系统核心是"资金安全+高可用+强一致"，用"支付编排+异步清结算+幂等+对账兜底"保证每分钱可追溯，是交易链路最严苛的环节。
  analogy: 支付系统像银行柜台——收款要准（强一致）、记账要清（对账）、不能关门（高可用）、每笔可查（审计）。
  first_principle: 资金不允许错，必须强一致（支付成功）+ 最终一致（清结算）+ 全量对账兜底。
  key_points:
  - 支付编排：下单→支付→回调→清分→结算
  - 幂等：支付回调必须幂等（防重复扣款）
  - 异步清结算：支付成功后异步分账（商家/平台）
  - 对账：T+1 与第三方支付机构对账
first_principle:
  problem: 高并发支付如何保证资金绝对安全（不超付/不漏付/不重复扣）？
  axioms:
  - 资金不允许错
  - 第三方支付机构异步回调
  - 清结算复杂（多商家/分账）
  rebuild: 支付编排（强一致）+ 幂等回调 + 异步清结算 + T+1 对账兜底。
follow_up:
- 支付回调怎么幂等？——支付流水号唯一索引，已处理直接返回成功
- 分布式事务怎么保证？——本地消息表 + 第三方对账兜底
- 拼多多支付架构？——聚合支付（微信/支付宝/银行卡）+ 自有钱包
memory_points:
- 支付编排：下单→支付→回调→清分→结算
- 幂等：支付流水号唯一 + 状态机校验
- 异步清结算（支付成功后分账）
- T+1 对账（与第三方支付机构）
---

# 【拼多多交易】支付系统怎么设计？怎么保证资金安全？

> JD 依据："交易系统核心功能开发"。

## 一、支付全流程

```
下单 → 生成支付单 → 调第三方支付 → 异步回调 → 更新订单 → 清分 → 结算
                                         ↓
                                    幂等处理（防重复）
```

## 二、支付编排

```java
public PayResult pay(PayReq req) {
    // 1. 幂等校验（防重复支付）
    if (payOrderDao.exists(req.getOutTradeNo())) {
        return payOrderDao.getByOutTradeNo(req.getOutTradeNo()).toResult();
    }
    // 2. 创建支付单
    PayOrder order = createPayOrder(req);
    // 3. 调第三方（微信/支付宝）
    ThirdPayResult third = thirdPayService.unifiedOrder(order);
    // 4. 返回支付参数（前端拉起支付）
    return PayResult.of(third.getPayUrl());
}
```

## 三、回调幂等（关键）

第三方支付机构可能多次回调同一笔支付：
```java
public void onNotify(PayNotify notify) {
    // 唯一索引保证幂等
    PayOrder order = payOrderDao.lockByTradeNo(notify.getTradeNo());
    if (order.status == PAID) return;  // 已处理，幂等返回

    order.status = PAID;
    outboxDao.insert(new Outbox("PaySuccessEvent", order));  // 同事务
}
```

## 四、异步清结算

支付成功后异步分账（拼多多平台/商家/服务商）：
```
PaySuccessEvent → 清分服务
   ├─ 商家账户 += 商品金额 - 佣金
   ├─ 平台账户 += 佣金
   └─ 服务商账户 += 分润
```

## 五、T+1 对账

```
拼多多支付流水 vs 微信/支付宝账单
   ↓ 比对
一致 → 平账
差异（长款/短款）→ 人工核查
```

## 六、底层本质

支付系统本质是**"资金流的强一致管理"**：
- 强一致：支付成功/失败明确（不能中间态）
- 幂等：重复回调不重复扣
- 对账：多源交叉验证兜底

这是金融级系统的最高要求——容错不容灾（宁可降级不可错账）。

## 常见考点
1. **支付回调为什么可能重复**？——网络重试、第三方兜底重发，必须幂等。
2. **支付和订单怎么一致**？——本地消息表（支付成功事件同事务）+ 订单订阅。
3. **对账差异怎么处理**？——自动调账规则（已知类型）+ 人工核查（复杂）。
