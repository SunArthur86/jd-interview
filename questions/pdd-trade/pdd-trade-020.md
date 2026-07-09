---
id: pdd-trade-020
difficulty: L4
category: pdd-trade
subcategory: 交易架构
tags:
- 拼多多
- 交易
- 全链路
- 架构
- 微服务
feynman:
  essence: 交易全链路是"用户下单→风控→订单→库存→支付→履约→结算"的端到端数据流，每个环节都是独立微服务，靠幂等+分布式事务+异步事件保证最终一致。
  analogy: 交易全链路像快递物流——揽件（下单）→安检（风控）→分拣（订单）→库房（库存）→收款（支付）→配送（履约）→对账（结算），每站各司其职，凭证流转。
  first_principle: 一笔交易涉及资金/库存/物流多方，必须分阶段、可回滚、最终一致，不能一锤子。
  key_points:
  - 全链路七段：下单→风控→创单→库存→支付→履约→结算
  - 幂等贯穿全程（每步带 traceId+幂等键）
  - 分布式事务用 TCC/Saga/本地消息表
  - 异步解耦用 Kafka 事件驱动
  - 全链路压测+灰度+多活
first_principle:
  problem: 一笔交易跨越多个域（订单/库存/支付/履约），如何保证数据一致、可扩展、可容灾？
  axioms:
  - 资金相关不能错（强一致）
  - 各域独立演进（解耦）
  - 故障要可恢复（最终一致）
  rebuild: 分域微服务 + 幂等接口 + 分布式事务（TCC/Saga）+ 事件总线 + 全链路可观测。
follow_up:
  - 下单到支付中间挂了怎么办？——订单待支付态，超时关单+回库存（MQ 延时队列）
  - 分布式事务怎么选型？——TCC（资金强一致）/Saga（长流程）/本地消息表（最终一致）
  - 全链路怎么追踪？——SkyWalking/Pinpoint，traceId 全链路透传
memory_points:
  - 七段：下单→风控→创单→库存→支付→履约→结算
  - 幂等：traceId+幂等键贯穿
  - 分布式事务：TCC/Saga/本地消息表
  - 事件驱动：Kafka 解耦下游
---

# 【拼多多交易】交易全链路架构怎么设计？

> JD 依据："交易系统技术升级改造"、"基础电商业务架构"。

## 一、全链路七段

```
用户 → [商品/购物车] → [下单] → [风控] → [创单] → [库存] → [支付] → [履约] → [结算]
       └─ 商品中心 ─┘  └ 交易 ┘ └ 风控 ┘ └ 订单 ┘ └ 库存 ┘ └ 支付 ┘ └ 物流 ┘ └ 财务 ┘
```

| 阶段 | 服务 | 关键操作 | 一致性 |
|------|------|----------|--------|
| 下单 | 交易 | 校验/锁价/算优惠 | 最终一致 |
| 风控 | 风控 | 反作弊/限购 | 强一致（拦截） |
| 创单 | 订单 | 生成订单号/状态机 | 强一致 |
| 库存 | 库存 | 扣减/预占 | 强一致 |
| 支付 | 支付 | 路由/回调 | 强一致 |
| 履约 | 物流 | 发货/配送 | 最终一致 |
| 结算 | 财务 | 对账/分账 | 最终一致 |

## 二、下单核心链路（创单+扣库存+锁价）

```java
@Transactional
public CreateOrderResp createOrder(CreateOrderReq req) {
    // 1. 幂等校验（防止重复下单）
    if (orderDao.existsByRequestId(req.getRequestId())) {
        return orderDao.getByRequestId(req.getRequestId());
    }
    // 2. 风控前置
    riskService.check(req.getUid(), req.getSkuList());
    // 3. 锁价（商品价格快照，防下单中变价）
    PriceSnapshot price = priceService.lock(req.getSkuList());
    // 4. 扣库存（TCC Try，预占）
    inventoryService.deduct(req.getSkuList());
    // 5. 创单（状态机：待支付）
    Order order = orderService.create(req, price);
    // 6. 发领域事件（异步通知履约/营销/积分）
    eventBus.publish(new OrderCreatedEvent(order));
    // 7. 延时关单（30 分钟未支付自动取消）
    mqSender.sendDelayed("order-close", order.getId(), 30, MINUTES);
    return resp(order);
}
```

## 三、分布式事务选型

```
资金强一致（扣库存+创单）：TCC
  Try   → 预占库存 + 生成待支付订单
  Confirm → 支付成功后确认扣减
  Cancel → 支付超时/取消时回滚库存

长流程（履约+物流）：Saga
  正向：创单→发货→配送→签收
  补偿：签收失败→拦截配送→召回

最终一致（积分/营销）：本地消息表
  创单事务同表写 Outbox → 定时投递 Kafka → 下游幂等消费
```

## 四、异步事件驱动

```java
// 订单服务发事件
@Transactional
public void paySuccess(Long orderId) {
    orderDao.updateStatus(orderId, PAID);
    outboxDao.insert(new Outbox("OrderPaid", payload));  // 同事务保证不丢
}
// Kafka 投递器扫描 outbox 推到 MQ
// 下游幂等消费
@KafkaListener(topics = "OrderPaid")
public void onPaid(OrderPaidEvent e) {
    if (consumeLog.isConsumed(e.getId())) return;  // 幂等
    fulfillmentService.ship(e.getOrderId());
}
```

## 五、拼多多特色（拼团/百亿补贴）

- **拼团**：下单→待成团→（满员）已成团→走支付；超时未成团→自动退款
- **百亿补贴**：补贴金额独立账本，结算时财务单独对账
- **多端（小程序/App/H5）**：统一网关+不同端 SDK

## 六、底层本质

交易全链路本质是**"把一笔交易分解为有序的强一致+最终一致阶段"**——资金相关强一致（TCC/Saga），业务辅助最终一致（MQ），用幂等保证重试安全，用状态机保证流程合法。

## 常见考点
1. **下单到支付挂了怎么办**？——订单待支付态+延时 MQ 超时关单+TCC Cancel 回库存。
2. **库存超卖怎么防**？——Redis 预扣 + DB 乐观锁 `WHERE stock>=n` + 分桶。
3. **全链路压测怎么做**？——影子库表+压测标识透传+全链路 mock 外部依赖。
