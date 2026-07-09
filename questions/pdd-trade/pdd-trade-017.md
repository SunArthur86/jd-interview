---
id: pdd-trade-017
difficulty: L2
category: pdd-trade
subcategory: 订单
tags:
- 拼多多
- 交易
- 设计模式
- 策略
- 观察者
feynman:
  essence: 交易系统常用设计模式——策略（支付方式/促销）、状态（订单状态机）、观察者（事件通知）、责任链（风控/鉴权）、模板方法（下单流程）。
  analogy: 设计模式像武功招式，用对事半功倍（OCP 对扩展开放对修改封闭）。
  first_principle: 业务多变，模式封装变化让代码易扩展。
  key_points:
  - 策略：消除促销/支付 if-else
  - 状态：订单状态机
  - 观察者：事件解耦下游
  - 责任链：风控/鉴权层层过滤
first_principle:
  problem: 业务规则多变（促销/支付），如何易扩展不污染主流程？
  rebuild: 模式封装变化点（OCP）。
follow_up:
- 过度设计？——Rule of Three（三次重复才抽象）
- DDD 和模式关系？——DDD 战术大量用模式
- 状态和策略区别？——状态自动切换，策略客户端选
memory_points:
- 策略消除 if-else、状态状态机、观察者解耦、责任链串行
- OCP：对扩展开放对修改封闭
- Rule of Three
---

# 【拼多多交易】交易系统怎么用设计模式？

> JD 依据："软件设计原则、设计模式"。

## 一、策略模式（促销）

```java
interface PromoStrategy { BigDecimal calc(Order o); }
// 满减/打折/直降各一实现，Map 注入消除 if-else
strategies.get(order.promoType).calc(order);
```

## 二、状态模式（订单状态机）

```java
interface OrderState { void next(Order o); }
class PaidState implements OrderState { public void next(Order o) { o.setState(new ShippedState()); } }
```

## 三、观察者（事件通知）

```java
order.pay();  // 发布 OrderPaidEvent
@EventHandler void on(OrderPaidEvent e) { stock.deduct(); points.add(); }
```

## 四、责任链（风控过滤）

```java
chain.add(new BlacklistHandler()).add(new RateLimitHandler()).add(new RiskHandler());
```

## 五、模板方法（下单流程）

```java
abstract class OrderTemplate {
    void create() { validate(); calcPrice(); deductStock(); save(); notify(); }
    abstract void calcPrice();  // 普通/拼团/预售覆写
}
```

## 六、底层本质

模式封装变化——策略封装算法变化、工厂封装创建、观察者封装联动。SOLID 落地工具。

## 常见考点
1. **单例怎么写**？——双重检查（volatile+synchronized）或静态内部类。
2. **策略 vs 状态**？——策略客户端选；状态对象内部自动切换。
3. **过度设计**？——简单 CRUD 不用，Rule of Three。
