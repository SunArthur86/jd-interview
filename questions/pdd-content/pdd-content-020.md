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
