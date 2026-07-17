---
id: java-architect-146
difficulty: L2
category: java-architect
subcategory: 降级
title: 降级预案如何从静态开关演进到策略平台
tags: [降级, 策略平台, 熔断, Sentinel, 兜底]
related: [java-architect-145, java-architect-138, java-architect-147]
---

# 降级预案如何从静态开关演进到策略平台

> **场景**：京东大促期间某个推荐服务挂了，需要立刻把它降级，否则影响首页加载。早期每个开关散在配置文件里，找半天、改半天。面试官问：降级体系怎么演进到平台化？

## 一、概念层：降级要解决什么

### 1.1 降级 vs 熔断 vs 限流

| 机制 | 触发 | 目的 | 主体 |
|------|------|------|------|
| **限流** | QPS 超阈值 | 控制入口流量 | 自己保护自己 |
| **熔断** | 下游失败率/RT 异常 | 防止级联雪崩 | 调用方保护自己 |
| **降级** | 主动/被动触发 | 牺牲非核心保核心 | 业务有损选择 |

三者关系：限流是"少进"，熔断是"断开坏依赖"，降级是"主动牺牲"。

### 1.2 降级的三种类型

| 类型 | 触发方式 | 例子 |
|------|----------|------|
| **手动降级** | 运维人工开关 | 大促关闭某个推荐位 |
| **自动降级** | 熔断/超时触发 | 下游超时返回缓存数据 |
| **预案降级** | 策略平台编排 | CPU > 80% 自动降级非核心 |

## 二、机制层：演进四个阶段

### 2.1 阶段一：硬编码开关（早期）

```java
// 散落各处的开关，改一次要发版
public class RecommendService {
    private static final boolean ENABLE_RECOMMEND = true;  // 改一次发一次版
    
    public List<Item> recommend(String userId) {
        if (!ENABLE_RECOMMEND) return Collections.emptyList();
        return doRecommend(userId);
    }
}
```

**问题**：发版慢、改一处动全身、无法分级。

### 2.2 阶段二：配置中心动态开关

```java
// 接入 Apollo/Nacos 配置中心，动态生效
@Service
public class RecommendService {
    @Value("${recommend.enabled:true}")
    private boolean enabled;
    
    @ApolloConfigChangeListener
    public void onChange(ConfigChangeEvent event) {
        if (event.isChanged("recommend.enabled")) {
            this.enabled = Boolean.parseBoolean(event.getChange("recommend.enabled").getNewValue());
        }
    }
    
    public List<Item> recommend(String userId) {
        if (!enabled) return Collections.emptyList();
        return doRecommend(userId);
    }
}
```

**改进**：动态生效、无需发版
**痛点**：
- 开关散落各项目，无统一视图
- 不知道哪些开关被改了、影响什么
- 没有审批、审计、回滚

### 2.3 阶段三：注解化 + AOP 统一管理

```java
// 自定义注解 + 切面
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
public @interface Degradable {
    String key();                  // 开关 key
    String fallback() default "";  // 兜底方法
    Level level() default Level.NORMAL;
}

@Service
public class RecommendService {
    @Degradable(key = "recommend.homepage", fallback = "cachedRecommend", level = Level.LOW)
    public List<Item> recommend(String userId) {
        return doRecommend(userId);  // 调用下游
    }
    
    public List<Item> cachedRecommend(String userId) {
        // 兜底：返回缓存或默认推荐
        return cache.get("recommend:default:" + userId, 
            () -> DEFAULT_RECOMMEND);
    }
}
```

```java
@Aspect
@Component
public class DegradableAspect {
    @Autowired private DegradeConfigCenter configCenter;
    
    @Around("@annotation(degradable)")
    public Object around(ProceedingJoinPoint pjp, Degradable degradable) throws Throwable {
        if (configCenter.isDegraded(degradable.key())) {
            monitor.recordDegrade(degradable.key(), "MANUAL");
            return invokeFallback(pjp, degradable.fallback());
        }
        try {
            return pjp.proceed();
        } catch (Exception e) {
            if (degradable.level() == Level.LOW) {
                // 非核心：异常自动降级
                monitor.recordDegrade(degradable.key(), "AUTO:" + e.getClass());
                return invokeFallback(pjp, degradable.fallback());
            }
            throw e;
        }
    }
    
    private Object invokeFallback(ProceedingJoinPoint pjp, String methodName) throws Exception {
        Object target = pjp.getTarget();
        Method m = target.getClass().getMethod(methodName, 
            ((MethodSignature)pjp.getSignature()).getParameterTypes());
        return m.invoke(target, pjp.getArgs());
    }
}
```

### 2.4 阶段四：策略平台（生产级）

JD 降级策略平台的核心抽象：

```yaml
# degrade-strategy.yaml —— 一条策略 = 触发条件 + 降级动作
strategies:
  - id: recommend-homepage-degrade
    target: recommend.homepage
    triggers:
      - type: manual           # 手动
        enabled: false
      - type: circuit_break    # 熔断自动
        condition: "fail_rate > 50% in 10s"
      - type: resource         # 资源指标
        condition: "cpu > 80% && qps > 5000"
      - type: time_window      # 时间窗
        condition: "between 00:00-06:00"
    actions:
      - type: return_fallback
        fallback: "cachedRecommend"
      - type: notify
        channels: [dingtalk, sms]
    priority: 50               # 优先级，高的先生效
    rollback_after: 300s       # 5 分钟自动回滚
    approvers: [tech_lead, ops_on_duty]
```

```java
@Service
public class DegradeStrategyEngine {
    private final DegradeConfigLoader loader;
    private final MetricCollector metrics;
    
    public boolean shouldDegrade(String target, RequestContext ctx) {
        List<DegradeStrategy> strategies = loader.getStrategies(target);
        for (DegradeStrategy s : strategies) {  // 按 priority 排序
            for (Trigger t : s.getTriggers()) {
                if (t.evaluate(ctx, metrics)) {
                    s.recordTrigger(t.getType());
                    s.scheduleRollback();  // 定时回滚
                    return true;
                }
            }
        }
        return false;
    }
}
```

## 三、实战层：JD 降级平台的核心能力

### 3.1 降级分级（业务影响优先级）

| 级别 | 说明 | 例子 | 允许降级 |
|------|------|------|----------|
| P0 核心交易 | 不可降级 | 下单、支付、扣库存 | ❌ 只能扩容 |
| P1 重要业务 | 异常时降级 | 购物车、优惠券 | ✅ 降级到兜底 |
| P2 辅助功能 | 主动可关 | 推荐、评论、猜你喜欢 | ✅ 可全关 |
| P3 营销活动 | 大促关闭 | 满减活动、抽奖 | ✅ 大促关 |

### 3.2 多种兜底策略

```java
public class FallbackStrategies {
    // 1. 返回缓存
    public Object cacheFallback(String key) {
        return redis.get(key) != null ? redis.get(key) : null;
    }
    
    // 2. 返回默认值
    public Object defaultFallback() {
        return DEFAULT_ITEMS;  // 默认推荐列表
    }
    
    // 3. 返回简化结果（去掉非核心字段）
    public Object simplifiedFallback(Request req) {
        Item item = new Item();
        item.setId(req.getItemId());
        item.setName(req.getItemName());
        // 跳过评论、推荐、相关商品等非核心字段
        return item;
    }
    
    // 4. 异步化（同步转 MQ）
    public Object asyncFallback(Request req) {
        mq.send("delay-process", req);   // 转异步
        return Response.accepted("已受理，稍后处理");
    }
    
    // 5. Mock 数据（仅限非关键场景）
    public Object mockFallback() {
        return MOCK_RECOMMEND;
    }
}
```

### 3.3 降级演练（预案可执行性验证）

定期（每月）执行降级演练：
- 主动触发 P2/P3 降级
- 验证兜底数据正确性
- 监控用户体验（RT、错误率）
- 验证回滚流程

```java
// JD 演练平台调度
@Scheduled(cron = "0 0 2 1 * ?")  // 每月 1 日 2 点
public void drill() {
    List<DegradeStrategy> strategies = loader.getDrillableStrategies();
    for (DegradeStrategy s : strategies) {
        try {
            s.trigger("DRILL");
            Thread.sleep(60_000);  // 观察 1 分钟
            metrics.checkUserImpact(s.getTarget());
        } finally {
            s.rollback();
            metrics.recordDrillResult(s);
        }
    }
}
```

### 3.4 监控大盘

| 指标 | 含义 |
|------|------|
| `degrade_active_count` | 当前生效的降级数 |
| `degrade_trigger_count` | 触发次数（按类型） |
| `degrade_fallback_latency` | 兜底 RT |
| `degrade_user_impact_rate` | 降级后用户报错率 |
| `degrade_rollback_success_rate` | 回滚成功率 |

## 四、底层本质：业务连续性的设计哲学

### 4.1 First Principle：核心业务不能有"单点失败"

降级本质是**业务连续性管理（BCM）**：当部分系统失效时，核心业务仍能继续。

设计原则：
- **核心依赖必须可降级**：依赖的下游挂了，核心流程能跑
- **降级必须比正常慢/差但不能错**：兜底数据要正确，不能返回错误结果
- **降级要有回滚机制**：手动/自动回滚，不能永久降级

### 4.2 为什么演进到平台

散落各项目的开关有三个根本问题：
1. **可观测性差**：不知道全公司有多少降级、谁开了谁关了
2. **协同性差**：故障时运维要找开发、开发要发版，错过黄金 5 分钟
3. **演练性差**：没法批量验证预案是否还有效

平台化的核心价值：**统一视图、一键触发、自动回滚、可演练**。

### 4.3 Feynman 解释

把系统想象成一家餐厅。
- 静态开关：每个菜品的备菜流程写死，临时改要重新印菜单。
- 配置中心：菜单改成电子屏，后厨能动态改，但每个厨师改自己的，没有统一调度。
- 平台：有个"运营中心"，知道哪些菜可以临时下架（如招牌菜还在、配菜没了用替代品），还能根据客流自动调整（人多时只卖招牌）。

## 五、AI 架构师加问

**Q1：P0 核心业务能不能降级？**
不能降级，但可以"过载保护"。如下单接口 P0，不能用兜底数据。但可以用限流 + 排队，保证系统不死，部分用户排队等待。

**Q2：降级兜底数据怎么保证正确？**
- 缓存兜底：必须有 TTL 和版本校验，不能用旧缓存冒充新数据
- 默认值兜底：必须明确"这是默认值"标记，避免误导
- 异步兜底：必须告知用户"已受理稍后处理"

**Q3：自动降级会不会"过度反应"？**
会。所以自动降级必须：
- 多信号触发（不仅看失败率，还要看 RT、QPS）
- 设置最小观察窗口（如 10s 内持续满足条件才触发）
- 自动回滚（5-10 分钟后尝试恢复正常）

**Q4：降级和熔断的关系？**
熔断是自动降级的一种实现。当下游失败率高，熔断器打开，自动走 fallback——这就是熔断触发的降级。Sentinel 的 `DegradeRule` 同时支持熔断和降级。

**Q5：跨服务降级怎么协调？**
- 优先本地降级（同服务内）
- 跨服务用"降级链路编排"：A 降级触发 B 也降级
- JD 实践：链路追踪（Trace）标识降级请求，下游识别后走简化路径

## 六、记忆口诀

```
降级演进四阶段：硬编码、配置中心、AOP注解、策略平台。
P0 不降只限，P1 兜底返回，P2 可关，P3 大促停。
兜底五策略：缓存、默认、简化、异步、Mock。
自动降级要观察窗，5 分钟自动回滚。
演练月月做，平台统一调，故障黄金五分钟保命。
```

## 七、苏格拉底追问

| 层级 | 问题 | 关键答案 |
|------|------|----------|
| L1 表象 | 静态开关有什么问题？ | 发版慢、无统一视图、无法回滚 |
| L2 机制 | 注解 + AOP 如何工作？ | 切面拦截 @Degradable，查配置中心决定是否走兜底 |
| L3 边界 | P0 业务能降级吗？ | 不能降级，只能限流排队，保核心不死 |
| L4 权衡 | 自动降级 vs 手动降级？ | 自动快但可能过度；手动准但慢；核心用自动+人工复核 |
| L5 反例 | 兜底缓存是脏数据怎么办？ | 必须有 TTL 和版本，标记"缓存兜底"避免误导 |
| L6 极限 | 全链路降级怎么协调？ | Trace 标识降级请求，下游识别后走简化路径 |
| L7 系统 | 多机房降级一致性？ | 策略平台全局唯一配置源，各机房定时同步 |

**对话还原**：
> 面试官：你们降级怎么做的？
> 我：从配置中心演进了策略平台。一条策略 = 触发条件（手动/熔断/资源/时间）+ 动作（兜底/通知）+ 自动回滚。按 P0-P3 分级，P0 只能限流不能降级。
> 面试官：兜底数据怎么保证正确？
> 我：缓存兜底有 TTL + 版本；默认值标记"默认"；异步化告知"已受理"。绝不用脏数据冒充。
> 面试官：自动降级会不会过度反应？
> 我：会。所以设最小观察窗口 10s，持续满足才触发；5 分钟自动回滚，恢复正常后保持。
> 面试官：演练频率？
> 我：每月一次，主动触发 P2/P3 验证兜底正确性和回滚流程。

## 八、常见考点

1. **降级 vs 熔断 vs 限流** —— 三个机制目的不同
2. **四级降级分级** —— P0 不降、P3 可关
3. **五种兜底策略** —— 缓存/默认/简化/异步/Mock
4. **注解 + AOP 实现** —— 统一拦截 + 配置中心
5. **自动降级的风险** —— 过度反应 + 最小观察窗 + 自动回滚
6. **演练机制** —— 定期验证预案可执行性
7. **跨服务降级协调** —— Trace 标识 + 链路编排
8. **核心业务保护** —— P0 限流排队不降级

## 结构化回答

**30 秒电梯演讲：** 京东大促期间某个推荐服务挂了，需要立刻把它降级，否则影响首页加载。早期每个开关散在配置文件里，找半天、改半天

**展开框架：**
1. **降级 vs 熔断 vs 限流** — 降级 vs 熔断 vs 限流 —— 三个机制目的不同
2. **四级降级分级** — 四级降级分级 —— P0 不降、P3 可关
3. **五种兜底策略** — 五种兜底策略 —— 缓存/默认/简化/异步/Mock

**收尾：** 以上是我的整体思路。您想继续深入聊——静态开关有什么问题？


## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：降级预案如何从静态开关演进到策略平台 | "这题一句话：京东大促期间某个推荐服务挂了，需要立刻把它降级，否则影响首页加载。" | 开场钩子 |
| 0:15 | 降级 vs 熔断 vs 限流示意/对比图 | "降级 vs 熔断 vs 限流 —— 三个机制目的不同" | 降级 vs 熔断 vs 限流要点 |
| 0:40 | 四级降级分级示意/对比图 | "四级降级分级 —— P0 不降、P3 可关" | 四级降级分级要点 |
| 1:25 | 总结卡 | "记住：降级 vs 熔断 vs 限流。下期见。" | 收尾 |
