---
id: pdd-content-020
difficulty: L3
category: pdd-content
subcategory: 评价
tags:
- 拼多多
- 内容
- 设计模式
- 单例
- 策略
- 观察者
- 评价
feynman:
  essence: 设计模式是"前人总结的面向对象设计套路"；内容场景常用单例（服务）、策略（审核规则/排序）、观察者（事件分发）、模板方法（流程钩子）。
  analogy: 设计模式像棋谱——开局套路（模式）让你不必从零想，但要灵活用对场景。
  first_principle: 软件设计有共性需求（创建/解耦/扩展），模式是沉淀的可复用方案。
  key_points:
  - 创建型：单例/工厂/建造者
  - 结构型：适配器/装饰器/代理
  - 行为型：策略/观察者/模板方法/责任链
  - SOLID 原则支撑模式
first_principle:
  problem: 软件有共性设计需求（创建/解耦/扩展），如何沉淀复用？
  axioms:
  - 需求会变（开闭原则）
  - 依赖抽象（依赖倒置）
  - 单一职责
  rebuild: 创建/结构/行为三大类模式。
follow_up:
  - 单例怎么实现？——饿汉/懒汉 DCL/静态内部类/枚举
  - 策略模式怎么消除 if/else？——Map<type, Strategy> + 注入
  - Spring 用了哪些模式？——工厂（BeanFactory）/单例/代理（AOP）/观察者（事件）
memory_points:
  - 创建：单例/工厂/建造者
  - 结构：适配器/装饰器/代理
  - 行为：策略/观察者/责任链
  - 原则：SOLID
---

# 【拼多多内容】设计模式在内容场景的应用？

> JD 依据："系统架构优化"、"Spring"。

## 一、三大类模式

| 类型 | 模式 | 内容场景 |
|------|------|----------|
| 创建型 | 单例/工厂/建造者 | 服务实例/审核器工厂/DTO 构建 |
| 结构型 | 代理/装饰器/适配器 | AOP/日志增强/第三方适配 |
| 行为型 | 策略/观察者/模板方法/责任链 | 排序策略/事件分发/流程钩子/审核链 |

## 二、单例（Spring Bean 默认）

```java
// 饿汉（线程安全）
public class ReviewService {
    private static final ReviewService INSTANCE = new ReviewService();
    private ReviewService() {}
    public static ReviewService getInstance() { return INSTANCE; }
}

// 枚举（最佳，防反射破坏）
public enum ReviewService {
    INSTANCE;
    public void doSomething() {}
}
```

Spring Bean 默认单例（容器保证），不需要自己写。

## 三、策略模式（消除 if/else）

**痛点**：
```java
// 烂代码
if (type.equals("TEXT")) auditText(c);
else if (type.equals("IMAGE")) auditImage(c);
else if (type.equals("VIDEO")) auditVideo(c);
```

**改造**：
```java
public interface AuditStrategy {
    String getType();
    AuditResult audit(Content c);
}

@Component
public class TextAuditStrategy implements AuditStrategy {
    public String getType() { return "TEXT"; }
    public AuditResult audit(Content c) { ... }
}

// 工厂
@Component
public class AuditStrategyFactory {
    @Autowired List<AuditStrategy> strategies;
    private Map<String, AuditStrategy> map;

    @PostConstruct
    public void init() {
        map = strategies.stream()
            .collect(toMap(AuditStrategy::getType, s -> s));
    }

    public AuditStrategy get(String type) {
        return map.get(type);
    }
}

// 使用（无 if/else）
auditFactory.get(content.getType()).audit(content);
```

## 四、观察者模式（事件分发）

```java
// Spring 事件机制
public class ReviewPublishedEvent extends ApplicationEvent {
    private Review review;
    public ReviewPublishedEvent(Review r) { super(r); ... }
}

// 发布
@Autowired ApplicationEventPublisher publisher;
publisher.publishEvent(new ReviewPublishedEvent(review));

// 订阅（多个监听器互不影响）
@EventListener
public void onPublishSyncIndex(ReviewPublishedEvent e) {
    esService.index(e.getReview());
}

@EventListener
@Async   // 异步
public void onPublishNotify(ReviewPublishedEvent e) {
    notifyService.notifyMerchant(e.getReview());
}
```

## 五、模板方法（流程钩子）

```java
public abstract class ContentPublisher {
    // 模板（定义流程骨架）
    public final void publish(Content c) {
        validate(c);
        audit(c);
        save(c);
        afterPublish(c);   // 钩子，子类实现
    }

    protected abstract void afterPublish(Content c);

    private void validate(Content c) { ... }
    private void audit(Content c) { ... }
    private void save(Content c) { ... }
}

public class ReviewPublisher extends ContentPublisher {
    @Override
    protected void afterPublish(Content c) {
        // 评价特有的后置：通知商家
        merchantService.notify(c);
    }
}
```

## 六、责任链（审核流程）

详见 pdd-content-018（UGC 审核），用责任链组装规则→模型→人工。

## 七、代理（AOP）

```java
// Spring AOP（动态代理）
@Aspect
@Component
public class LogAspect {
    @Around("@annotation(LogAction)")
    public Object log(ProceedingJoinPoint pjp) throws Throwable {
        long start = System.currentTimeMillis();
        Object result = pjp.proceed();
        log.info("{} cost {}ms", pjp.getSignature(), System.currentTimeMillis() - start);
        return result;
    }
}

// 使用
@LogAction
public Review getReview(Long id) { ... }
```

## 八、装饰器（增强不修改）

```java
// 缓存装饰器
public class CachingReviewService implements ReviewService {
    private ReviewService delegate;   // 被装饰对象
    private Cache<Long, Review> cache;

    public Review getReview(Long id) {
        return cache.get(id, k -> delegate.getReview(k));
    }
}
```

## 九、工厂（创建对象）

```java
public class FeedFactory {
    public static Feed create(FeedType type) {
        switch (type) {
            case REVIEW: return new ReviewFeed();
            case LIVE:   return new LiveFeed();
            case VIDEO:  return new VideoFeed();
        }
    }
}
```

## 十、底层本质

设计模式本质是**"前人沉淀的面向对象设计套路"**——核心是 SOLID 原则（开闭/单一职责/依赖倒置），模式是实现手段，不是目的。

## 常见考点
1. **策略+工厂+责任链组合怎么用**？——工厂造策略，责任链串联多个策略。
2. **代理和装饰器区别**？——代理控制访问（权限/远程），装饰器增强功能。
3. **开闭原则怎么落地**？——抽象+扩展点（接口/抽象类），新功能加新类不改老代码。

## 苏格拉底式面试追问

> 这组追问不是背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：审核策略你用策略模式 + 工厂消除 if/else，但有人批评"这是过度设计，就 3 种审核类型（文本/图片/视频）直接 if 不行吗"。你怎么反驳或认同？**

策略模式的价值不是"现在有几个类型"，而是"未来会不会变"。拼多多内容审核现在的 3 种类型（文本/图片/视频）几乎必然会扩展——音频审核（直播 ASR）、链接审核（外链安全）、多模态（图文联合）。如果用 if/else，每加一种类型要改审核入口的代码（违反开闭原则），且测试要回归全部分支。策略模式让"新类型 = 新增一个 Strategy 实现类 + 注册到工厂"，主流程零改动。反驳的依据是"业务确定性"——审核类型扩展是确定会发生的，不是臆想。如果是个一次性的脚本或确定不变的逻辑（如一周有 7 天），if/else 完全 OK，上策略模式才是过度设计。

### 第二层：证据与定位

**Q：线上评价发布事件触发多个监听器（同步 ES + 通知商家 + 推荐召回），但"通知商家"失败了导致整个发布失败。你怎么定位是观察者模式用错了？**

观察者模式（Spring 的 @EventListener）默认是同步的——发布事件后，所有监听器顺序执行，任一监听器抛异常会中断后续监听器并冒泡到发布者。这里的"通知商家失败导致发布失败"就是同步观察者的典型问题：核心业务（评价发布）被非核心的副作用（通知）拖垮。定位：
1. 看监听器是否标了 `@Async`——如果没标，是同步执行。检查"通知商家"监听器的异常是否被 `@TransactionalEventListener` 的阶段影响。
2. 看异常传播——同步监听器的异常会冒泡，`publisher.publishEvent` 抛异常，导致 `@Transactional` 回滚，评价发布也回滚。
3. 解法——非核心副作用必须 `@Async`（异步，独立线程池，失败不影响主流程）+ 失败补偿（重试/死信队列）。

### 第三层：根因深挖

**Q：模板方法模式你定义了 publish() 的骨架（validate→audit→save→afterPublish），但子类 ReviewPublisher 和 LivePublisher 的 afterPublish 逻辑差异巨大（评价是通知商家，直播是推流启动）。这算模板方法还是滥用？**

模板方法的前提是"子类的差异点是局部的、可插拔的"。如果 afterPublish 的差异已经大到"一个是发消息、一个是启动流媒体"，说明这两个子类的共性不足以共享一个模板，硬套模板方法会导致父类定义的"钩子"失去语义一致性。判断标准：模板方法里的每一步应该在所有子类中语义相同（如 afterPublish 在所有子类都是"发布后置处理"），只是实现不同。如果连语义都不同（通知 vs 推流），应该拆成两个独立的流程类，共享的是更底层的工具方法（如 save 的落库逻辑）而非业务骨架。滥用模板方法的代价是"父类为了迁就子类不断加 if/else"，反而比不用模式更糟。

### 第四层：方案权衡

**Q：审核流程你用责任链（规则→模型→人工），但人工审核可能要"退回模型重审"（人审觉得模型漏了某维度）。责任链是单向的，怎么支持回退？**

经典责任链是单向的（A→B→C），不支持回退。支持回退的权衡方案：
1. **状态机替代责任链**——审核流程本质是状态流转（待审→机审中→人审中→通过/拒绝→重审），用状态机（如 Spring StateMachine）更合适，状态间定义转移条件，支持任意跳转（人审可触发"退回机审"状态）。
2. **责任链 + 重试标记**——保持责任链，但审核结果带"nextStage"字段，人审退回时设 `nextStage=MODEL`，调度器根据该字段重新投递到模型阶段。这本质是在责任链外加了个调度器。
3. **事件驱动**——每个审核步骤完成后发事件（`ModelAudited`/`HumanAudited`），调度器根据事件决定下一步。最灵活但最复杂。
评价审核场景推荐状态机——审核流程相对稳定（就几个状态），状态机能清晰表达"退回重审"等复杂流转，且可视化（状态图），比责任链 + 补丁更可维护。

### 第五层：验证与沉淀

**Q：策略模式 + 工厂上线后，新审核类型怎么验证"加新类不影响老类"（开闭原则真的落地了）？**

开闭原则的验证靠"变更影响分析"：
1. 加新审核类型（如 AudioAuditStrategy）时，确认老代码零改动——`git diff` 看本次提交只新增了 AudioAuditStrategy 类，AuditStrategyFactory 因用 `@Autowired List<AuditStrategy>` 自动收集（不用改），审核入口（`auditFactory.get(type).audit()`）也不用改。如果改了老代码，说明抽象有泄漏。
2. 单测回归——加新类型后跑全量单测，所有老类型的测试应全绿（无回归）。
3. 编译时检查——策略模式用 Spring 注入 `List<AuditStrategy>`，新加的 Bean 自动被发现，无需注册代码。如果发现新类型没被调用，检查是否漏了 `@Component`。
沉淀：策略模式必须配工厂 + 自动收集（`@Autowired List<Interface>`），禁止手动 switch 注册；模板方法/责任链的设计 review 重点看"是否真的复用骨架"；观察者的副作用监听器必须 `@Async` + 独立线程池 + 失败补偿。

## 结构化回答




**30 秒电梯演讲：** 设计模式像棋谱——开局套路（模式）让你不必从零想，但要灵活用对场景。

**展开框架：**
1. **创建型** — 单例/工厂/建造者
2. **结构型** — 适配器/装饰器/代理
3. **行为型** — 策略/观察者/模板方法/责任链

**收尾：** 单例怎么实现？




## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：设计模式在内容场景的应用？ | 今天聊「设计模式在内容场景的应用？」。一句话：设计模式是"前人总结的面向对象设计套路"；内容场景常用单例（服务）、策略（审核规则/排序）、观察者（事件分发）、模板方… | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：创建：单例/工厂/建造者 | 核心概念 |
| 1:04 | 能力/参数拆解表 | 要点是：结构：适配器/装饰器/代理 | 能力拆解 |
| 1:56 | 流程图：输入→处理→输出 | 要点是：行为：策略/观察者/责任链 | 关键机制 |
| 3:00 | 总结卡 + 下期预告 | 记住这些核心点就够了。下期我们接着聊——单例怎么实现？。 | 收尾 |
