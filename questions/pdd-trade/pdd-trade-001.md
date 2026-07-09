---
id: pdd-trade-001
difficulty: L3
category: pdd-trade
subcategory: 订单
tags:
- 拼多多
- 交易
- 订单
- 状态机
feynman:
  essence: 订单状态机用"状态+事件+转移规则"保证订单流转合法（不可逆向/不可跳跃），是交易系统的核心骨架；拼多多订单还要处理拼团/预售等复杂态。
  analogy: 订单状态机像棋局规则——棋子（订单）只能按规则走（状态转移），不能乱走（待支付直接跳已完成）。
  first_principle: 订单涉及资金/库存/物流，状态变更必须有序可控，否则资金错乱。
  key_points:
  - 核心状态：待支付/已支付/已发货/已完成/已取消/退款中
  - 状态转移表：定义合法转移（非法抛异常）
  - 事件驱动：支付事件→已支付、发货事件→已发货
  - 拼团态：待成团→已成团/未成团退款
first_principle:
  problem: 订单涉及多方（支付/库存/物流），状态如何保证有序不乱？
  axioms:
  - 状态变更需有序（不可逆向）
  - 资金相关不能错
  - 不同业务（普通/拼团/预售）状态不同
  rebuild: 状态机（状态+事件+转移表）+ 事件驱动 + 业务扩展态。
follow_up:
- 拼团订单状态怎么设计？——待支付→待成团→已成团（继续）/未成团（退款）
- 状态机怎么实现？——枚举+转移表+Spring StateMachine
- 状态变更和 DB 怎么一致？——同事务更新状态+发领域事件
memory_points:
- 核心态：待支付/已支付/已发货/已完成/已取消/退款中
- 状态转移表定义合法转移
- 事件驱动（支付事件/发货事件）
- 拼团/预售扩展态
---

# 【拼多多交易】订单状态机怎么设计？

> JD 依据："交易系统技术升级改造"。

## 一、核心状态机

```
        ┌─────────┐  支付   ┌─────────┐  发货  ┌─────────┐  确认  ┌────────┐
        │ 待支付  │ ──────▶ │ 已支付  │──────▶│ 已发货  │──────▶│ 已完成 │
        └────┬────┘         └────┬────┘        └─────────┘        └────────┘
             │ 取消               │ 退款
             ▼                    ▼
        ┌─────────┐         ┌─────────┐
        │ 已取消  │         │ 退款中  │
        └─────────┘         └─────────┘
```

**状态转移表**（合法转移白名单）：
```java
Map<Status, Set<Status>> TRANSITIONS = Map.of(
    PENDING_PAY, Set.of(PAID, CANCELLED),
    PAID, Set.of(SHIPPED, REFUNDING),
    SHIPPED, Set.of(COMPLETED, REFUNDING),
    REFUNDING, Set.of(REFUNDED, REJECTED)
);

public void transit(Order order, Status target) {
    if (!TRANSITIONS.get(order.status).contains(target))
        throw new IllegalStateTransitionException();
    order.status = target;
}
```

## 二、拼多多扩展态

**拼团订单**：
```
待支付 → 待成团（N 人未满）→ 已成团（继续发货流程）
                          → 未成团（超时退款）
```

**预售订单**：
```
待支付定金 → 待支付尾款 → 已支付全款 → 发货
```

## 三、事件驱动

```java
public class Order extends AggregateRoot {
    public void pay() {
        transit(this, PAID);
        DomainEvents.publish(new OrderPaidEvent(id));  // 触发库存扣减/通知
    }
    public void ship() {
        transit(this, SHIPPED);
        DomainEvents.publish(new OrderShippedEvent(id));
    }
}
```

## 四、状态变更一致性

状态变更 + 业务 + 事件同事务：
```java
@Transactional
public void pay(Long orderId) {
    orderDao.updateStatus(orderId, PAID);
    outboxDao.insert(new Outbox("OrderPaid", payload));  // 同事务
}
```

## 五、底层本质

订单状态机本质是**"用规则约束保证流程合法"**——资金相关不允许状态错乱。状态机是交易系统的骨架，所有业务（支付/库存/物流）围绕状态流转。

## 常见考点
1. **状态机怎么防并发**？——DB 乐观锁（version 字段）或 `UPDATE ... WHERE status=原状态`。
2. **拼团成团怎么判定**？——定时扫描超时团 + 实时计数满团触发。
3. **状态机和领域事件**？——状态变更发事件，下游订阅做后续（发货/通知/结算）。
