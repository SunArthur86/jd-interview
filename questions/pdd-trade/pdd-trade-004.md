---
id: pdd-trade-004
difficulty: L3
category: pdd-trade
subcategory: 分布式事务
tags:
- 拼多多
- 交易
- 分布式事务
- Seata
- TCC
- 本地消息表
feynman:
  essence: 交易跨服务（订单+库存+支付+积分）需分布式事务，用"本地消息表（最终一致）+ TCC（强一致核心场景）+ Seata（框架）"组合，强一致太慢用柔性事务。
  analogy: 强一致像签三方合同同时盖章（贵慢），柔性事务像各签各的+事后对账（快但短暂不一致）。
  first_principle: 跨服务事务无法单库 ACID，CAP 下要么牺牲可用（XA）要么牺牲强一致（柔性）。
  key_points:
  - 本地消息表：业务+消息同事务，定时投递 MQ，下游幂等
  - TCC：Try-Confirm-Cancel，强一致，业务侵入大
  - Seata：AT 模式（自动生成回滚 SQL）/ TCC / Saga
  - 交易用：本地消息表（最终一致）+ TCC（核心扣款）
first_principle:
  problem: 下单跨订单/库存/支付/积分多服务，如何保证最终一致？
  axioms:
  - 单库 ACID 不跨服务
  - XA 太慢
  - 业务可容忍秒级最终一致
  rebuild: 本地消息表（异步通知）+ TCC（核心扣款强一致）+ 幂等消费。
follow_up:
- TCC 三阶段怎么实现？——Try 预留资源、Confirm 确认、Cancel 回滚
- 本地消息表和事务消息区别？——本地消息表自建；RocketMQ 事务消息原生支持
- 下单全链路怎么一致？——订单+库存（TCC 扣减）+ 积分（本地消息表异步）
memory_points:
- 本地消息表：业务+消息同事务，定时投递
- TCC：Try/Confirm/Cancel（强一致，业务侵入大）
- Seata AT 模式：自动回滚 SQL
- 交易组合：核心 TCC + 非核心消息表
---

# 【拼多多交易】分布式事务怎么解决？下单跨服务怎么一致？

> JD 依据："分布式事务框架和原理"。

## 一、方案对比

| 方案 | 一致性 | 性能 | 适用 |
|------|--------|------|------|
| XA（2PC） | 强 | 差 | 传统金融（少用） |
| TCC | 强 | 中 | 核心扣款 |
| Saga | 最终 | 好 | 长流程 |
| 本地消息表 | 最终 | 好 | 异步通知 |

## 二、下单全链路一致性

```
订单服务 createOrder()
   ├─ 订单 DB（订单表 + 消息表，同事务）
   ├─ ↓ MQ
   ├─ 库存服务：TCC 扣减（Try 冻结→Confirm 扣减/Cancel 解冻）
   ├─ 支付服务：生成支付单
   └─ 积分服务：异步加积分（本地消息表）
```

## 三、TCC 实战（扣款）

```java
// Try：冻结额度
@TwoPhaseBusinessAction(name = "deduct")
public boolean tryDeduct(BusinessActionContext ctx, long uid, long amount) {
    accountDao.freeze(uid, amount);  // 冻结
    return true;
}
// Confirm：扣减冻结
public boolean confirmDeduct(BusinessActionContext ctx) {
    accountDao.deductFrozen(ctx.getActionContext("uid"), ctx.getActionContext("amount"));
    return true;
}
// Cancel：解冻
public boolean cancelDeduct(BusinessActionContext ctx) {
    accountDao.unfreeze(ctx.getActionContext("uid"), ctx.getActionContext("amount"));
    return true;
}
```

## 四、本地消息表

```java
@Transactional
public void createOrder(OrderReq req) {
    orderDao.insert(order);
    outboxDao.insert(new Outbox("OrderCreated", toJson(order)));  // 同事务
}
// 定时扫 outbox 投递 MQ
```

## 五、Seata AT 模式（自动补偿）

```java
@GlobalTransactional
public void createOrder(OrderReq req) {
    orderService.create(req);       // 订单库
    storageService.deduct(req);     // 库存库
    // Seata 自动生成回滚 SQL，任一失败全局回滚
}
```

## 六、底层本质

分布式事务本质是 **CAP 取舍**：
- 强一致（XA）：锁久，牺牲可用
- 最终一致（柔性）：异步，牺牲一致性窗口

交易选混合：核心扣款 TCC（强一致）+ 非核心本地消息表（最终一致）。

## 常见考点
1. **TCC 和 2PC 区别**？——2PC 资源层（DB 锁）；TCC 业务层（业务实现三阶段）。
2. **Seata AT 怎么自动回滚**？——解析 SQL 生成 before/after image，失败时用 image 反向回滚。
3. **幂等为什么必须**？——柔性事务可能重试，消费端必须幂等（业务唯一键）。
