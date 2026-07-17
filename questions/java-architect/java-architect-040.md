---
id: java-architect-040
difficulty: L4
category: java-architect
subcategory: 降级
tags:
- Java 架构师
- 熔断
- 降级
- 隔离
feynman:
  essence: 熔断是"下游故障时主动断开，避免调用堆积拖垮自己"；降级是"故障时返回保底结果而非报错"；隔离舱（Bulkhead）是"按下游/业务分线程池，一个舱进水不沉整船"。三者结合是故障不扩散的核心机制——舱壁隔离防蔓延、熔断器防堆积、降级保用户体验。
  analogy: 像 JD 远洋货轮防沉：船分多个水密舱（Bulkhead，一个舱进水不沉船）；某舱进水时关水密门（熔断，隔离故障）；客舱进水了让乘客去甲板（降级，保命不保舒适）。三者层层防护，单点故障不沉整船。
  first_principle: 分布式系统故障必然发生（网络、依赖、代码 bug），关键不是"防故障"而是"故障不扩散"。调用链路中下游故障会导致调用方线程堆积 → 调用方也挂 → 上游再挂 → 雪崩。熔断/降级/隔离是在故障发生时"主动牺牲局部保全局"。
  key_points:
  - 熔断三态：Closed（正常）/ Open（熔断，快速失败）/ Half-Open（半开，试探恢复）
  - 熔断触发：异常率/慢调用比例超阈值，进入 Open 状态等待恢复
  - 降级：故障时返回保底（默认值、缓存、简化逻辑），用户感知"功能受限"非"系统挂了"
  - 隔离舱：线程池隔离（强隔离，资源耗尽只影响一个池）vs 信号量隔离（轻量，无队列）
  - 三者配合：隔离舱防蔓延 → 熔断防堆积 → 降级保体验
first_principle:
  problem: 分布式系统中下游依赖故障时，如何防止故障沿调用链扩散导致雪崩？
  axioms:
  - 下游故障会导致调用方线程堆积（等响应），调用方资源耗尽也挂
  - 故障沿调用链向上扩散，最终全链路雪崩
  - 与其等"被动崩溃"，不如"主动牺牲局部保全局"
  rebuild: 三层防护。第一层隔离舱（Bulkhead）——按下游/业务分独立线程池，某个下游故障只耗尽自己的池，不占用其他下游资源。第二层熔断器（Circuit Breaker）——下游异常率/慢调用比例超阈值时进入 Open 状态，直接快速失败不再调用（给下游恢复时间，也释放自己线程）。第三层降级（Fallback）——熔断或异常时返回保底结果（缓存、默认值、简化逻辑），用户感知功能受限而非报错。三者配合形成"故障不扩散"的防线。
follow_up:
  - 熔断和限流区别？——限流是"我自己容量有限要拒绝超量"，熔断是"下游有问题我不调用了"。限流保护自己，熔断保护下游也保护自己
  - 熔断恢复机制？——Open 状态等一段时间（如 30s）进 Half-Open，放少量请求试探，成功则 Closed 恢复正常，失败则回 Open 继续等
  - 线程池隔离和信号量隔离怎么选？——线程池隔离强（独立队列、可超时）但开销大（每个池一组线程）；信号量隔离轻（计数器）但无队列无超时。下游慢用线程池，纯内存快调用用信号量
  - 降级返回什么？——默认值（商品详情无库存信息）、缓存（旧数据）、简化逻辑（跳过推荐）。绝不能让用户看到 500，要让用户感知"功能受限"非"系统挂了"
  - 怎么发现该熔断了？——监控下游异常率、慢调用比例、线程池饱和度。Sentinel dashboard 实时看熔断规则触发情况
memory_points:
  - 熔断三态：Closed/Open/Half-Open，Open 快速失败、Half-Open 试探
  - 熔断触发：异常率（>50%）或慢调用比例（>30% RT > 1s）
  - 隔离舱：线程池隔离（强，开销大）vs 信号量隔离（轻，无队列）
  - 降级：返回保底（缓存/默认值/简化），保用户体验
  - 三者配合：隔离防蔓延 → 熔断防堆积 → 降级保体验
---

# 【Java 后端架构师】熔断降级与故障隔离舱设计

> 适用场景：JD 核心技术。下单链路依赖库存/营销/支付/推荐/评论等多个下游，任一下游故障都可能拖垮整个下单链路（线程堆积雪崩）。架构师必须能用隔离舱 + 熔断 + 降级构建"故障不扩散"的防线，保证核心链路在部分依赖故障时仍可用。

## 一、概念层：熔断 / 降级 / 隔离舱分工

**三者解决不同问题**（面试常被混为一谈）：

| 机制 | 解决什么 | 触发时机 | 效果 |
|------|---------|---------|------|
| **隔离舱（Bulkhead）** | 故障蔓延 | 始终生效（预防） | 某下游故障只耗尽自己的池 |
| **熔断（Circuit Breaker）** | 故障堆积 | 异常率/慢调用超阈值 | 快速失败，释放线程，给下游恢复 |
| **降级（Fallback）** | 用户体验 | 熔断或异常时 | 返回保底，用户感知功能受限 |

**三者配合的故障场景**：

```
场景：营销服务故障（响应慢 5s）

无防护：
  下单服务调营销 → 等待 5s → 线程堆积 → 下单服务线程池满
  → 下单服务也挂 → 上游（网关）也挂 → 雪崩

有防护（隔离舱 + 熔断 + 降级）：
  1. 隔离舱：营销调用走独立线程池（20 线程），不占用下单主线程池
     → 营销慢只耗尽营销池，下单主流程不阻塞

  2. 熔断：营销异常率 > 50%（超时算异常）触发熔断，进入 Open
     → 直接快速失败（不再等 5s），营销池线程释放

  3. 降级：熔断后走 fallback，返回"优惠券信息暂时不可用"
     → 用户能下单（核心功能保住），只是看不到优惠券（非核心功能降级）
```

## 二、机制层：熔断器状态机

**熔断三态**（必背状态机）：

```
                  异常率/慢调用超阈值
   Closed ─────────────────────────> Open
   (正常)                            (熔断，快速失败)
     ^                                  │
     │ 成功                             │ 等待 timeWindow（30s）
     │                                  ▼
     └───────────────── Half-Open <─────┘
                         (半开，放少量请求试探)
                         │
                    ┌────┴────┐
                  成功        失败
                    │         │
                 Closed    回 Open
```

**熔断触发条件**（两种主流策略）：

```
策略 1：异常比例（ERROR_RATIO）
  当请求数 ≥ minRequestAmount（如 20）时
  异常率 = 异常请求数 / 总请求数
  异常率 > threshold（如 50%）→ 触发熔断

策略 2：慢调用比例（SLOW_REQUEST_RATIO）
  慢调用定义：RT > maxRt（如 1s）
  当请求数 ≥ minRequestAmount 时
  慢调用比例 > threshold（如 30%）→ 触发熔断

生产推荐：两者结合（异常比例 + 慢调用比例，任一触发即熔断）
```

**Sentinel 熔断规则配置**：

```java
// 异常比例熔断
DegradeRule rule1 = new DegradeRule("MarketingService.getCoupon");
rule1.setGrade(RuleConstant.DEGRADE_GRADE_EXCEPTION_RATIO);
rule1.setCount(0.5);               // 异常率 > 50%
rule1.setTimeWindow(30);            // 熔断 30s
rule1.setMinRequestAmount(20);      // 至少 20 请求才统计
rule1.setStatIntervalMs(10000);     // 10s 统计窗口

// 慢调用比例熔断
DegradeRule rule2 = new DegradeRule("MarketingService.getCoupon");
rule2.setGrade(RuleConstant.DEGRADE_GRADE_RT);
rule2.setCount(1000);              // 慢调用定义：RT > 1s
rule2.setSlowRatioThreshold(0.3);  // 慢调用比例 > 30%
rule2.setTimeWindow(30);
rule2.setMinRequestAmount(20);

DegradeRuleManager.loadRules(Arrays.asList(rule1, rule2));
```

## 三、机制层：隔离舱（Bulkhead）

**线程池隔离 vs 信号量隔离**（必背对比）：

| 维度 | 线程池隔离 | 信号量隔离 |
|------|-----------|-----------|
| **原理** | 每个下游独立线程池 | 计数器限制并发 |
| **队列** | 有（可排队） | 无（超过直接拒） |
| **超时** | 支持（线程可 interrupt） | 不支持（无法中断） |
| **异步** | 支持（Future） | 不支持 |
| **开销** | 大（每个池一组线程） | 小（计数器） |
| **适用** | 下游慢调用（DB、外部 API） | 内部快调用（内存操作） |

**线程池隔离代码**（Resilience4j Bulkhead）：

```java
@Configuration
public class BulkheadConfig {

    @Bean
    public BulkheadRegistry bulkheadRegistry() {
        BulkheadConfig marketingConfig = BulkheadConfig.custom()
            .maxConcurrentCalls(20)          // 最大并发 20
            .maxWaitDuration(Duration.ofMillis(500))  // 等待获取许可最多 500ms
            .build();

        BulkheadConfig inventoryConfig = BulkheadConfig.custom()
            .maxConcurrentCalls(50)          // 库存更重要，配多
            .maxWaitDuration(Duration.ofMillis(100))
            .build();

        return BulkheadRegistry.of(
            Map.of("marketing", marketingConfig, "inventory", inventoryConfig));
    }

    @Bean
    public ThreadPoolBulkheadRegistry threadPoolBulkheadRegistry() {
        ThreadPoolBulkheadConfig marketingConfig = ThreadPoolBulkheadConfig.custom()
            .maxThreadPoolSize(20)
            .coreThreadPoolSize(10)
            .queueCapacity(100)
            .keepAliveDuration(Duration.ofSeconds(20))
            .build();

        return ThreadPoolBulkheadRegistry.of(
            Map.of("marketing", marketingConfig));
    }
}

@Service
public class OrderService {

    @Resource MarketingService marketingService;

    // 线程池隔离：营销调用走独立线程池
    @Bulkhead(name = "marketing", type = Bulkhead.Type.THREADPOOL)
    @CircuitBreaker(name = "marketing", fallbackMethod = "getCouponFallback")
    public CompletableFuture<Coupon> getCouponAsync(Long userId) {
        return CompletableFuture.supplyAsync(() -> marketingService.getCoupon(userId));
    }

    // 降级方法
    public CompletableFuture<Coupon> getCouponFallback(Long userId, Exception e) {
        return CompletableFuture.completedFuture(Coupon.empty());   // 返回空券
    }
}
```

**信号量隔离代码**：

```java
// Sentinel 信号量隔离（线程数限流）
FlowRule rule = new FlowRule("MarketingService.getCoupon");
rule.setGrade(RuleConstant.FLOW_GRADE_THREAD);   // 线程数（信号量）
rule.setCount(20);   // 最多 20 并发
```

## 四、机制层：降级策略

**降级返回什么**（分场景）：

| 场景 | 降级策略 | 用户感知 |
|------|---------|---------|
| **商品详情 - 评论列表** | 返回空列表 | "暂无评论" |
| **商品详情 - 推荐商品** | 返回静态推荐（兜底配置） | 看到默认推荐 |
| **下单 - 优惠券查询** | 返回"不可用"提示 | 知道券暂时不可用，可继续下单 |
| **下单 - 库存校验** | **不能降级**（核心） | 必须真实校验，否则超卖 |
| **搜索 - 个性化排序** | 返回通用排序 | 搜索结果不个性化但可用 |
| **支付 - 风控** | **不能降级**（合规） | 风控必须执行，降级有合规风险 |

**关键原则**：核心链路不能降级（库存、支付、风控），非核心可降级（推荐、评论、统计）。降级是"牺牲非核心保核心"，不是"什么都降级"。

**降级代码实现**：

```java
@Service
public class ProductService {

    @Resource RecommendService recommendService;
    @Resource CommentService commentService;

    // 推荐降级：返回静态推荐
    @SentinelResource(value = "getRecommendations",
        fallback = "getRecommendationsFallback")
    public List<Product> getRecommendations(Long productId) {
        return recommendService.recommend(productId);
    }
    public List<Product> getRecommendationsFallback(Long productId, Throwable t) {
        log.warn("recommend degraded for {}: {}", productId, t.getMessage());
        return staticRecommendConfig.getDefaultRecommend();   // 静态兜底
    }

    // 评论降级：返回空
    @SentinelResource(value = "getComments",
        fallback = "getCommentsFallback")
    public List<Comment> getComments(Long productId) {
        return commentService.list(productId);
    }
    public List<Comment> getCommentsFallback(Long productId, Throwable t) {
        return Collections.emptyList();   // 空列表
    }
}
```

**手动降级开关**（运维可控）：

```java
@RestController
public class DegradationController {

    // 通过配置中心动态切换降级开关
    @NacosValue(value = "${degradation.recommend:false}", autoRefreshed = true)
    private boolean recommendDegraded;

    public List<Product> getRecommendations(Long productId) {
        if (recommendDegraded) {
            return staticRecommendConfig.getDefaultRecommend();   // 手动降级
        }
        return recommendService.recommend(productId);
    }
}
```

## 五、实战层：下单链路完整防护设计

**JD 下单链路隔离舱设计**：

```
下单服务（OrderService）
├── 主线程池（200 线程）── 核心下单流程（不可降级）
│     ├── DB 写订单（本地，快）
│     └── 库存校验（独立线程池 100，核心，不熔断不降级）
│
├── 营销线程池（20 线程）── 非核心
│     └── 优惠券查询（熔断 30s + 降级返回空券）
│
├── 推荐线程池（20 线程）── 非核心
│     └── 商品推荐（熔断 30s + 降级返回静态）
│
├── 评论线程池（10 线程）── 非核心
│     └── 评论列表（熔断 30s + 降级返回空）
│
└── 风控线程池（50 线程）── 核心（合规）
      └── 风控校验（不降级，但可熔断保护自己不挂）
```

**故障演练验证**（架构师必须能讲）：

```
演练 1：营销服务故障（kill 营销服务）
  预期：营销线程池熔断，下单流程继续（优惠券降级为空）
  验证：下单成功率 > 99%、营销调用快速失败、用户看到"券不可用"

演练 2：库存服务慢（注入 5s 延迟）
  预期：库存调用熔断（慢调用比例 > 30%），下单失败（核心不能降级）
  验证：下单返回"系统繁忙"而非超时等待、库存恢复后自动恢复

演练 3：DB 慢（慢 SQL）
  预期：主线程池饱和，触发限流（非熔断，限流保护容量）
  验证：限流触发率上升、已接收请求正常处理、DB 恢复后容量恢复
```

**监控指标**（必采）：

```
熔断相关：
  - circuit_breaker_state（Closed/Open/Half-Open，按服务）
  - circuit_breaker_open_count（熔断触发次数）
  - fallback_count（降级触发次数）
  - circuit_breaker_recovery_time（恢复耗时）

线程池相关：
  - thread_pool_active_count（活跃线程）
  - thread_pool_queue_size（队列积压）
  - thread_pool_reject_count（拒绝数，线程池满）

下游调用：
  - downstream_error_rate（下游异常率）
  - downstream_latency_p99（下游 P99 延迟）
  - timeout_count（超时次数）
```

## 六、底层本质：为什么是隔离舱 + 熔断 + 降级三层

回到第一性：**分布式系统故障必然发生，关键是不扩散**。

**为什么需要隔离舱**：共享线程池的问题——所有下游调用共用一个池，某个下游慢（等响应）会耗尽线程，导致其他健康下游也无法调用。隔离舱把每个下游分到独立池，某池耗尽只影响该下游，不蔓延。这是"分而治之"在资源管理的体现——物理隔离比逻辑优先级更可靠。

**为什么需要熔断**：隔离舱解决了蔓延，但没解决堆积。即使下游独立线程池，下游持续故障时池里线程都在等响应，新请求进队列还是慢。熔断器在检测到下游故障（异常率高、慢调用多）时主动 Open，直接快速失败不再调用——给下游恢复时间，也释放自己线程。本质是"承认下游暂时不可用，与其浪费资源等待不如快速失败"。

**为什么需要降级**：熔断后直接返回错误用户体验差（看到 500）。降级是"熔断或异常时返回保底结果"，让用户感知"功能受限"而非"系统挂了"。推荐返回静态、评论返回空、券返回不可用提示——核心功能（下单）继续可用，非核心功能优雅降级。

**三层的关系**：隔离舱是"预防"（始终生效，防蔓延），熔断是"响应"（故障时主动断开，防堆积），降级是"兜底"（断开后保体验）。三者层层递进，缺一不可。只有隔离舱没有熔断，故障下游持续拖累（线程一直等）；只有熔断没有降级，用户看到错误（体验差）；只有降级没有隔离，故障蔓延其他下游（雪崩）。

**核心 vs 非核心的区分**：降级必须区分核心和非核心。库存、支付、风控是核心（不能降级，降了超卖/资损/合规风险），推荐、评论、统计是非核心（可降级，牺牲体验保核心）。架构师的工作是梳理链路，明确每个依赖的优先级，配置差异化的熔断降级策略。

## 七、AI 架构师加问：5 个 AI 相关问题

1. **AI 推理服务的熔断怎么设计？**
   AI 推理慢且贵，熔断更激进。异常率 > 20%（默认模型可能 50%）或 P99 > 3s 触发熔断。降级返回小模型结果或缓存结果。按模型分池（大模型独立池、小模型独立池），大模型熔断不影响小模型。

2. **让 AI 自动决策熔断恢复，AI 接管哪段？**
   AI 监控下游健康指标（错误率、RT、容量），动态调整熔断 timeWindow（故障短则快速试探恢复、故障长则延长等待）。AI 出建议（"下游已恢复，可 Half-Open"），人工确认或自动执行。监控误恢复率（Half-Open 失败次数）。

3. **AI Agent 多工具调用的隔离舱怎么设计？**
   每个 tool_call 独立线程池（按工具类型分配——DB 工具 50 并发、HTTP 工具 20 并发、AI 推理工具 10 并发）。某工具故障熔断，Agent 继续用其他工具完成任务（部分能力降级）。监控每个工具的熔断状态。

4. **AI 推理失败的降级策略？**
   分级降级：①大模型失败 → 降级小模型（质量降但可用）；②小模型也失败 → 返回缓存结果（上次成功响应）；③缓存也无 → 返回默认回复（"服务繁忙"）。绝不能让用户看到 500，要让用户感知"AI 暂时降级"。

5. **AI 服务故障如何防雪崩？**
   隔离舱（按用户/模型分池，某用户刷量不影响他人）+ 熔断（异常率阈值激进）+ 降级（缓存兜底）+ 限流（用户配额）。监控 fallback_rate（降级率，过高说明 AI 服务不稳）和 circuit_breaker_open_count。

## 八、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"三态熔断、隔离舱分池、降级保核心、三者配合防雪崩"**。

- **熔断三态**：Closed 正常 / Open 快速失败 / Half-Open 试探恢复
- **触发**：异常率 > 50% 或慢调用比例 > 30%
- **隔离舱**：线程池隔离（强，下游慢用）vs 信号量隔离（轻，快调用用）
- **降级**：返回保底（缓存/默认值/空），核心链路不降级（库存/支付/风控）
- **三者配合**：隔离防蔓延 → 熔断防堆积 → 降级保体验

### 拟人化理解

把服务治理想成 **JD 远洋货轮防沉**。隔离舱是船的水密舱（舱室分隔，一个进水不沉船）——按下游/业务分独立线程池。熔断器是水密门（某舱进水关门，隔离故障）——异常率高时快速失败不再调用。降级是"客舱进水让乘客去甲板"（保命不保舒适）——返回保底结果，用户感知功能受限而非报错。三者层层防护：水密舱防蔓延、水密门防堆积、救生艇保体验。核心舱（轮机室=下单核心）不能进水（不降级），非核心舱（餐厅=推荐评论）可暂时封闭（降级）。

### 面试现场 60 秒回答

> 三层防护。第一层隔离舱——按下游/业务分独立线程池，营销/推荐/评论各 20 线程，下单核心 200 线程，某下游故障只耗尽自己的池不蔓延。第二层熔断器——下游异常率 > 50% 或慢调用比例 > 30% 触发 Open，快速失败 30s 给下游恢复，之后 Half-Open 放少量请求试探。第三层降级——熔断或异常时返回保底（推荐返回静态、评论返回空、券返回不可用），核心链路（库存、支付、风控）不降级。三者配合：隔离防蔓延 → 熔断防堆积 → 降级保体验。故障演练验证——kill 营销服务，预期下单成功率仍 > 99%（券降级为空）。

### 反问面试官

> 贵司核心链路有故障演练机制吗？下游依赖的熔断降级是手写还是用 Sentinel/Resilience4j？降级开关是配置中心动态切换吗？这决定我治理方案怎么落地。

## 九、苏格拉底式面试追问

每一问先回答"为什么"，再"怎么做"，最后"如何证明"。

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不直接扩容下游，要熔断？ | 扩容有延迟（分钟级），故障当下下游已挂扩容来不及；熔断是毫秒级响应保自己；某些故障（代码 bug、DB 主从切换）扩容无用。熔断是即时保护，扩容是容量规划 |
| 证据追问 | 怎么证明熔断阈值定的合理？ | 故障演练（kill 下游看是否触发熔断）、监控熔断触发频率（正常低，过高说明阈值过低误杀）、Half-Open 恢复成功率（应 > 80%，过低说明 timeWindow 太短）、雪崩次数（应 0） |
| 边界追问 | 熔断能解决所有下游故障吗？ | 不能。核心链路故障（库存挂了）熔断了用户还是不能下单；数据一致性问题（脏数据）熔断无效；下游完全不可用熔断只是快速失败。熔断是"故障不扩散"，不是"故障消除" |
| 反例追问 | 什么场景不熔断？ | 核心链路（库存、支付）不熔断——熔断了用户也不能用，不如直接报错；内部低频调用（管理后台）；试验性服务。熔断适合"非核心依赖故障时保核心" |
| 风险追问 | 降级最大的风险？ | 误降级（核心链路被降级导致超卖/资损/合规风险）、降级逻辑有 bug（兜底数据错误）、降级开关忘记恢复（长期降级隐藏故障）。治法：核心/非核心严格区分、降级逻辑测试、降级时长监控告警 |
| 验证追问 | 怎么证明防护真的生效了？ | 故障演练（kill 每个下游，看是否隔离舱+熔断+降级三层防护）、压测超量（看是否限流而非雪崩）、监控雪崩次数（应 0）、MTTR（平均恢复时间应 < 5 分钟） |
| 沉淀追问 | 团队防护规范沉淀什么？ | 下游依赖优先级清单（核心/重要/非核心）、隔离舱线程池配置模板、熔断规则（按下游类型）、降级策略对照表、故障演练 SOP、circuit_breaker_open_count 告警 |

### 现场对话示例

**面试官**：熔断和限流有什么区别？

**候选人**：限流是"我自己容量有限，超量请求拒绝"，保护自己不被打挂。熔断是"下游有问题我不调用了"，保护自己也给下游恢复时间。限流的触发是"自己的 QPS 超阈值"，熔断的触发是"下游异常率或慢调用比例超阈值"。场景上：限流应对正常峰值流量（大促），熔断应对下游故障（依赖挂了）。工具上：限流用令牌桶/漏桶算法，熔断用状态机（Closed/Open/Half-Open）。两者经常配合——先限流防超量，再熔断防下游故障。

**面试官**：线程池隔离和信号量隔离怎么选？

**候选人**：看下游调用特征。下游慢（DB、外部 API、AI 推理）用线程池隔离——独立线程池有队列可排队、支持超时（线程可 interrupt）、支持异步（Future）。强隔离，某下游耗尽自己的池不影响其他。开销大（每个池一组线程，默认 10-50 个 × N 个池 = 几百线程）。下游快（内存操作、本地缓存）用信号量隔离——就是个计数器限制并发，无队列无超时无法中断，但开销极小。选型：DB/HTTP/AI 用线程池，纯内存调用用信号量。

**面试官**：哪些场景不能降级？

**候选人**：核心链路不能降级。第一，库存校验——降级了不校验就超卖，资损。第二，支付——降级了不扣款就发货，资损。第三，风控——降级了不做风控有合规风险（被监管罚）。第四，权限校验——降级了越权访问，安全风险。这些场景故障时应该"快速失败报错"（让用户知道系统繁忙）而非"降级继续"（牺牲正确性）。降级只适合非核心链路（推荐、评论、统计），牺牲体验保核心。

## 常见考点

1. **熔断三态？**——Closed 正常 / Open 快速失败 / Half-Open 试探恢复。触发：异常率或慢调用比例超阈值，等 timeWindow 后 Half-Open 试探。
2. **隔离舱两种？**——线程池隔离（强，独立队列+超时+异步，下游慢用）vs 信号量隔离（轻，计数器，快调用用）。
3. **降级返回什么？**——缓存、默认值、空列表、简化逻辑。核心链路（库存/支付/风控）不降级。
4. **熔断和限流区别？**——限流保护自己（超量拒绝），熔断保护下游也保护自己（下游故障时断开）。限流应对峰值，熔断应对故障。
5. **三者配合？**——隔离舱防蔓延（始终生效）→ 熔断防堆积（故障时断开）→ 降级保体验（断开后返回保底）。层层递进缺一不可。


## 结构化回答

**30 秒电梯演讲：** 聊到熔断降级与故障隔离舱设计，我的理解是——熔断是"下游故障时主动断开，避免调用堆积拖垮自己"；降级是"故障时返回保底结果而非报错"；隔离舱（Bulkhead）是"按下游/业务分线程池，一个舱进水不沉整船"。三者结合是故障不扩散的核心机制——舱壁隔离防蔓延、熔断器防堆积、降级保用户体验。打个比方，像 JD 远洋货轮防沉：船分多个水密舱（Bulkhead，一个舱进水不沉船）；某舱进水时关水密门（熔断，隔离故障）；客舱进水了让乘客去甲板（降级，保命不保舒适）。三者层层防护，单点故障不沉整船。

**展开框架：**
1. **熔断三态** — Closed（正常）/ Open（熔断，快速失败）/ Half-Open（半开，试探恢复）
2. **熔断触发** — 异常率/慢调用比例超阈值，进入 Open 状态等待恢复
3. **降级** — 故障时返回保底（默认值、缓存、简化逻辑），用户感知"功能受限"非"系统挂了"

**收尾：** 这块我在项目里也踩过坑——想深入的话，可以接着聊：熔断和限流区别？您更想看哪个方向？

## 视频脚本

> 预计时长：4 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡 | "熔断降级与故障隔离舱设计——这道题面试官到底想考什么？我用 30 秒给你讲透。" | 开场钩子 |
| 0:15 | 熔断降级状态机图 | 先说核心：熔断是"下游故障时主动断开，避免调用堆积拖垮自己"；降级是"故障时返回保底结果而非报错"；隔离舱（Bulkhead）是"按下游/业务分线程池，一个舱进水不沉整船"。三者结合是故。 | 核心定义 |
| 0:50 | 概念结构示意图 | 异常率/慢调用比例超阈值，进入 Open 状态等待恢复。 | 熔断触发 |
| 1:20 | 流程图 | 故障时返回保底（默认值、缓存、简化逻辑），用户感知"功能受限"非"系统挂了"。 | 降级 |
| 1:50 | 代码示例截图 | 线程池隔离（强隔离，资源耗尽只影响一个池）vs 信号量隔离（轻量，无队列）。 | 隔离舱 |
| 3:30 | 总结卡 | 一句话记忆：熔断三态：Closed/Open/Half-Open，Open 快速失败、Half-Open 试探。 下期可以接着聊：熔断和限流区别。 | 收尾总结 |
