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

## 苏格拉底式面试追问

> 这组追问不是背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：供应链的促销规则（满减/打折/直降/满件减），你用策略模式重构了原来的 if-else。重构的动机是什么？只是代码好看吗？**

不只是好看，是"业务可扩展性"。原来的 if-else 结构，每次新增促销类型要改 `calculatePrice` 方法（违反 OCP 开闭原则），而且促销规则互相组合（满减+打折叠加）时 if-else 嵌套成地狱。策略模式的动机：
1. **新增促销不改老代码**——新加"拼团价"只需写 `GroupBuyStrategy` 实现，注入 Map，主逻辑零改动。
2. **组合用装饰器或责任链**——多个促销叠加时，用装饰器（`new DiscountDecorator(new FullReductionStrategy())`）或责任链串行计算，避免嵌套 if。
3. **可测试**——每个策略独立单测，不用构造整个订单上下文测 if-else 分支。
代价是类变多（每种促销一个类），但相比"改一处影响全局"的 if-else，可维护性更好。

### 第二层：证据与定位

**Q：上线策略模式后，某个促销订单价格算错了（满减没生效）。你怎么定位是哪个策略类的问题？**

三步定位：
1. **看日志的策略选择**——在 `strategies.get(order.getPromoType())` 处打日志 `log.info("使用策略: {} for order: {}", strategy.getClass().getSimpleName(), orderId)`，确认调用了正确的策略类（如 `FullReductionStrategy` 而不是 `DiscountStrategy`）。
2. **看策略内部计算**——arthas `watch FullReductionStrategy calc '{params, returnObj}'` 看输入参数（order.amount）和输出（discounted price），确认逻辑对不对。
3. **看促销配置**——满减规则（如满 100 减 20）存在 DB 或配置中心，确认 order.amount 是否达到阈值（如 99 元不满 100 不触发）。根因可能是"满减阈值的边界判断写错（>= 写成 >）"或"order.amount 没算运费/优惠券"。

### 第三层：根因深挖

**Q：策略模式的策略类越来越多（20 种促销），维护困难。有的策略只差一行代码却要复制一个类。根因是模式用错了还是别的？**

根因是"过度细分 + 缺少参数化"。策略模式的前提是"算法本质不同"（满减和打折的计算逻辑完全不同），但如果多个策略只是"参数不同"（满 100 减 20 vs 满 200 减 50），不应该写两个类，应该用一个参数化的策略：
```java
class FullReductionStrategy implements PromotionStrategy {
    private BigDecimal threshold;  // 满 100
    private BigDecimal reduction;  // 减 20
    // 一个类，参数从配置读取
}
```
20 种促销里，真正"算法不同"的可能只有 5 类（满减/打折/直降/满件减/组合），每类参数化后从配置生成实例，类数控制在 5-10 个。如果还是 20 个类，说明把"配置差异"误当成了"算法差异"，是抽象不到位。

**Q：那为什么不直接用规则引擎（如 Drools、QLExpress），把促销规则配置化，彻底不写 Java 代码？**

规则引擎适合"规则频繁变且由业务方维护"的场景，但有代价：
1. **学习曲线**——Drools 的 DRL 语法、QLExpress 脚本，业务方和研发都要学，门槛高。
2. **调试困难**——规则引擎的执行是黑盒（规则匹配→执行），出了价格错误，很难定位是哪条规则命中了，不像 Java 代码能断点。
3. **性能开销**——规则引擎的规则匹配（如 Drools 的 RETE 算法）比直接 Java 方法调用慢，高并发场景有延迟。
所以策略是：规则少（< 20 类）且稳定 → 策略模式 + 参数化；规则极多（> 100 条）且频繁由运营改 → 规则引擎。供应链促销一般 5-10 类，用策略模式足够，规则引擎是过度设计。

### 第四层：方案权衡

**Q：订单状态变更（待支付→已支付→已发货）你用了观察者模式通知库存/物流/积分。但观察者是异步的（领域事件 + MQ），如果某个观察者（积分服务）挂了，订单状态变更算成功还是失败？**

这是观察者模式 + 最终一致的权衡。订单状态变更（已支付）是主事务，观察者（通知积分）是异步事件。主事务（订单状态改 PAID + 写 outbox）成功就算"订单已支付"，积分服务挂了不影响订单状态——积分事件在 outbox 里，积分服务恢复后消费补上。这就是"核心链路和非核心链路解耦"——订单是核心（必须成功），积分是非核心（可延迟、可补偿）。代价是积分有延迟（秒级），但用户不感知（积分晚几秒到账不影响体验）。

**Q：为什么不把积分发放放进订单支付的事务里（同事务），保证强一致？**

三个问题：
1. **耦合**——积分服务挂了，订单也支付不了（事务回滚），用户体验差（明明付了钱却显示未支付）。
2. **性能**——订单事务变长（多一次积分服务的 RPC + DB），扣减锁持有时间变长，并发降低。
3. **扩展性差**——以后要加"支付后发优惠券""支付后通知客服"，都塞进订单事务，事务越来越臃肿。
观察者模式的价值就是"主流程只关心自己的核心逻辑，副作用异步解耦"。积分、优惠券、通知都是副作用，用事件 + 最终一致，主流程轻量高效。强一致只在"核心数据强相关"时用（如订单+订单项同事务），副作用一律异步。

### 第五层：验证与沉淀

**Q：你怎么证明策略模式重构后，促销计算的正确性没退化（没引入价格算错的 bug）？**

对账验证：
1. **灰度对比**——重构版本和旧版本并行跑（shadow 流量），同一订单用两套逻辑算价格，对比结果。如果完全一致，重构无 bug；如果有差异，人工 review 每个差异点。拼多多重构促销引擎时就用这种"双跑对账"，跑了 1 周无差异才全量。
2. **价格对账**——每天跑 `order.expected_price`（订单创建时的预期价）和 `order.actual_price`（实际支付价）的对比，差值 = 0 正常；> 0 说明价格计算有 bug，告警人工查。
3. **单测覆盖**——每个策略类必须有单测覆盖边界值（如满减的阈值边界 99/100/101 元），覆盖率 > 90% 才上线。

**Q：怎么让团队避免"过度设计"或"该用模式不用"？**

沉淀设计规范：
1. **Rule of Three**——代码重复出现 3 次才抽象成模式，前 2 次先 copy，避免过早抽象错方向。
2. **设计模式 cheat sheet**——团队维护一份"什么场景用什么模式"的对照表（促销=策略、状态变更=状态/观察者、层层过滤=责任链），PR review 时对照，防止乱用。
3. **重构评审**——引入设计模式的重构必须经过架构师 review，说明"解决了什么扩展问题""抽象的代价（类数增加）是否值得"，防止为模式而模式。

## 结构化回答

**30 秒电梯演讲：** 业务规则多变（促销类型、支付方式），如何让代码易扩展不污染主流程？简单说就是——设计模式是前人总结的"面向对象套路"——策略模式消除 if-else、工厂封装创建、观察者解耦联动、责任链串行处理；供应链的促销策略、订单状态变更通知都用得上。

**展开框架：**
1. **策略模式** — 策略模式：消除促销 if-else（满减/打折/直降各一个策略）
2. **工厂模式** — 工厂模式：封装对象创建（支付方式工厂）
3. **观察者** — 观察者：订单状态变更通知多下游

**收尾：** 您看这块要不要再展开聊聊？

## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：设计模式在供应链怎么用？ | 今天聊「设计模式在供应链怎么用？」。一句话：设计模式是前人总结的"面向对象套路" | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：策略模式：消除促销 if-else（满减/打折/直降各一个策略） | 核心概念 |
| 1:00 | 能力/参数拆解表 | 要点是：工厂模式：封装对象创建（支付方式工厂） | 能力拆解 |
| 2:00 | 总结卡 + 下期预告 | 记住核心要点就够了。下期见。 | 收尾 |
