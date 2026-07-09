---
id: pdd-scm-018
difficulty: L2
category: pdd-scm
subcategory: 商品
tags:
- 拼多多
- 供应链
- 设计模式
- 策略模式
- 观察者模式
feynman:
  essence: 设计模式是前人总结的"面向对象套路"——策略模式消除 if-else、工厂封装创建、观察者解耦联动、责任链串行处理；供应链的促销策略、订单状态变更通知都用得上。
  analogy: 设计模式像武功招式——不用也能打（写代码），但用对了事半功倍（可维护、可扩展）。
  first_principle: 复杂业务里反复出现的结构问题，沉淀成模式；模式让代码"对扩展开放、对修改封闭"（OCP）。
  key_points:
  - 策略模式：消除促销 if-else（满减/打折/直降各一个策略）
  - 工厂模式：封装对象创建（支付方式工厂）
  - 观察者：订单状态变更通知多下游
  - 责任链：风控/鉴权/限流层层过滤
  - 模板方法：下单流程骨架固定，步骤可覆写
first_principle:
  problem: 业务规则多变（促销类型、支付方式），如何让代码易扩展不污染主流程？
  axioms:
  - 新增类型不应改老代码（OCP）
  - 频繁 if-else 是坏味道
  - 变化点要封装
  rebuild: 策略模式封装变化（每类型一个 Strategy）+ 工厂创建 + 观察者解耦。
follow_up:
- 用过哪些设计模式？——供应链的促销（策略）、订单状态（状态模式）、仓储流程（责任链）
- 过度设计怎么避免？——简单 CRUD 不用模式，等第三次重复再抽象（Rule of Three）
- DDD 和设计模式关系？——DDD 战术设计大量用模式（聚合=工厂+策略+观察者）
memory_points:
- 策略消除 if-else、工厂封装创建、观察者解耦、责任链串行
- OCP 原则：对扩展开放，对修改封闭
- Rule of Three：第三次重复才抽象
---

# 【拼多多供应链】设计模式在供应链怎么用？

> JD 依据："应用软件设计原则、设计模式"。

## 一、策略模式（促销规则）

```java
// ❌ 坏味道：大量 if-else
if (type == FULL_REDUCTION) calcFullReduction();
else if (type == DISCOUNT) calcDiscount();
else if (type == DIRECT_DOWN) calcDirectDown();

// ✅ 策略模式
interface PromotionStrategy { BigDecimal calc(Order order); }
class FullReductionStrategy implements PromotionStrategy { ... }
class DiscountStrategy implements PromotionStrategy { ... }

// 用 Map 注入
Map<PromoType, PromotionStrategy> strategies;
strategies.get(order.getPromoType()).calc(order);
```

新增促销类型只加策略类，不改主逻辑。

## 二、工厂模式（支付方式）

```java
interface PaymentFactory {
    Payment create(PayType type);  // 微信/支付宝/银行卡
}
```

## 三、观察者模式（订单状态通知）

```java
// 订单状态变更 → 通知库存/物流/积分
public class Order extends AggregateRoot {
    public void pay() {
        status = PAID;
        DomainEvents.publish(new OrderPaidEvent(this));  // 观察者订阅
    }
}
@EventHandler
public void onOrderPaid(OrderPaidEvent e) {
    stockService.deduct(e.items);
    pointsService.add(e.userId, e.amount);
}
```

## 四、责任链模式（风控过滤）

```java
// 请求层层过滤：黑名单 → 频控 → 风控 → 业务
chain.add(new BlacklistHandler())
     .add(new RateLimitHandler())
     .add(new RiskHandler())
     .add(new BusinessHandler());
chain.process(request);
```

## 五、模板方法（下单流程）

```java
abstract class OrderTemplate {
    void create() {              // 骨架固定
        validate();
        calculatePrice();
        deductStock();
        save();
        notify();
    }
    abstract void calculatePrice();  // 子类覆写（普通/预售/拼团）
}
```

## 六、状态模式（订单状态机）

```java
// 待支付 → 已支付 → 已发货 → 已完成 / 已取消
interface OrderState { void next(Order o); }
class PaidState implements OrderState { public void next(Order o) { o.setState(new ShippedState()); } }
```

## 七、底层本质

设计模式本质是**"封装变化"**：
- 策略封装"算法变化"
- 工厂封装"创建变化"
- 观察者封装"联动变化"
- 责任链封装"处理顺序变化"

**SOLID 原则的落地工具**——让代码对扩展开放、对修改封闭。

## 常见考点
1. **单例模式怎么写**？——双重检查（volatile + synchronized）或静态内部类（类加载保证）。
2. **策略模式和状态模式区别**？——策略由客户端选；状态由对象内部状态决定，自动切换。
3. **过度设计**？——简单 CRUD 不用模式；Rule of Three（三次重复才抽象）。
