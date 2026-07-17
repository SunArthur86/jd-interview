---
id: java-architect-007
difficulty: L2
category: java-architect
subcategory: Java 并发
tags:
- 异步
- CompletableFuture
- 治理
feynman:
  essence: CompletableFuture 的本质是把"回调地狱"变成"可编排的异步数据流"。它不是 Future 的简单升级，而是用 CompletionStage 接口把"任务完成后的动作"建模成链式图——串行、并行、组合、异常处理都变成声明式 API。
  analogy: 像 Excel 公式链：A1 是原始数据，B1=A1×2，C1=B1+10。CompletableFuture 就是异步版的 Excel——supplyAsync 起 A1，thenApply 是 B1，thenCombine 是把两个 sheet 的结果合到 C1。哪个单元格慢了，下游自动等，不用你写 wait/notify。
  first_principle: 为什么需要 CompletableFuture？因为 Future.get() 是阻塞的——编排"取 A、取 B、合并"必须手动起线程 + Future.get() 阻塞，代码丑且易错。CompletableFuture 用回调链 + CompletionStage 图，把"等待"变成"事件驱动"，让线程不被阻塞在 get() 上。
  key_points:
  - 创建：supplyAsync/ runAsync（默认 ForkJoinPool.commonPool）
  - 转换：thenApply（同步）、thenApplyAsync（异步切线程）
  - 组合：thenCombine（两 CF 合并）、allOf/anyOf（多 CF 聚合）
  - 异常：exceptionally（恢复）、handle（恢复+继续）、whenComplete（观察副作用）
  - 治理三要素：必须显式传线程池、必须设超时、必须有异常兜底
first_principle:
  problem: 如何在不阻塞线程的前提下，编排"取数据 A、取数据 B、合并、再调下游"这种依赖图？
  axioms:
  - Future.get() 阻塞线程，编排 N 个依赖要 N 次阻塞，浪费线程
  - 回调能避免阻塞，但嵌套回调（回调地狱）不可读、不可维护
  - 任务的依赖关系可以建模成 DAG（有向无环图）
  rebuild: CompletableFuture 把每个异步任务建模为图节点，依赖关系为边。任务完成时触发回调，回调内部又创建新节点，形成链/树/DAG。线程不被 get() 阻塞，由内部线程池驱动回调执行。API（thenApply/thenCombine/allOf）是 DAG 构造器，程序员声明式描述依赖，运行时调度执行。
follow_up:
  - 为什么默认 ForkJoinPool.commonPool 不能用？——它是全局共享，所有未指定线程池的 CompletableFuture 都用它，一个慢任务拖垮全局；线程数 = CPU-1，IO 任务严重不够
  - thenApply 和 thenApplyAsync 区别？——thenApply 用上游完成时的线程执行回调（可能调用方线程）；thenApplyAsync 强制切到指定线程池
  - orTimeout/d completeTimeout 怎么用？——JDK 9+ 提供，CF 超时自动异常结束，避免下游永久等待
  - allOf 返回的 CF 怎么拿结果？——allOf 只返回 CompletableFuture<Void>，要自己收集；或用 Stream + Stream.toList
  - 异步链路怎么 traceId 透传？——默认不透传（线程切换丢 MDC），要自定义线程池 wrap Runnable 复制 MDC
memory_points:
  - CompletableFuture 是异步 DAG 构造器，不是 Future 升级版
  - 三大治理：显式线程池（禁用 commonPool）、必须设超时、必须异常兜底
  - thenApply 同步 / thenApplyAsync 异步 / thenCompose 扁平化
  - allOf 全成功 / anyOf 任一成功（容错用 anyOf + 超时）
  - traceId 透传要 wrap 线程池复制 MDC，否则链路追踪断
---

# 【Java 后端架构师】CompletableFuture 编排与异步链路治理

> 适用场景：JD 核心技术。商品详情页要并发取商品、价格、库存、评价、推荐——串行 500ms，并发 100ms。CompletableFuture 是编排这种扇出扇入依赖图的标准工具，但治理不到位就是线上链路追踪断裂、超时雪崩的源头。

## 一、概念层：CompletableFuture 的 API 分类

**四大类 API**（面试要能报全）：

| 类别 | 代表方法 | 语义 |
|------|---------|------|
| **创建** | `supplyAsync`/`runAsync` | 异步起任务，supply 有返回值 |
| **转换** | `thenApply`/`thenCompose` | 拿上游结果转换，compose 扁平化（避免 CF<CF<T>>） |
| **组合** | `thenCombine`/`allOf`/`anyOf` | 多 CF 合并/聚合 |
| **消费/异常** | `thenAccept`/`whenComplete`/`exceptionally`/`handle` | 消费结果、观察副作用、异常恢复 |

**同步 vs 异步变体**（关键区分）：

| 方法 | 执行线程 |
|------|---------|
| `thenApply(fn)` | 用上游完成时的线程（可能是调用方线程，可能阻塞调用方） |
| `thenApplyAsync(fn)` | 强制切到 ForkJoinPool.commonPool |
| `thenApplyAsync(fn, executor)` | 切到指定线程池（**生产推荐**） |

**完整商品详情页编排示例**：

```java
// 4 个独立数据源并发取，最后合并
CompletableFuture<Product> productFuture =
    CompletableFuture.supplyAsync(() -> productService.get(id), ioPool);
CompletableFuture<Price> priceFuture =
    CompletableFuture.supplyAsync(() -> priceService.get(id), ioPool);
CompletableFuture<Stock> stockFuture =
    CompletableFuture.supplyAsync(() -> stockService.get(id), ioPool);
CompletableFuture<List<Review>> reviewFuture =
    CompletableFuture.supplyAsync(() -> reviewService.list(id), ioPool)
                     .orTimeout(200, MILLISECONDS);   // 单链路超时

CompletableFuture<PageVO> all = CompletableFuture.allOf(
        productFuture, priceFuture, stockFuture, reviewFuture)
    .thenApplyAsync(v -> {
        // allOf 完成后合并（4 个都成功才到这里）
        return new PageVO(productFuture.join(), priceFuture.join(),
                stockFuture.join(), reviewFuture.join());
    }, computePool)
    .orTimeout(300, MILLISECONDS)              // 总超时
    .exceptionally(ex -> PageVO.degraded());   // 兜底降级

PageVO page = all.join();   // 入口处阻塞（业务接口必须返回）
```

关键点：4 个数据源并发，总耗时 ≈ max(各链路) 而非 sum；任一超时或异常，整条链降级。

## 二、机制层：CompletionStage 图与线程切换

**CompletableFuture 的内部结构**（简化）：

```
CompletableFuture
├── result          // 结果或异常（未完成时为 null）
└── stack           // 依赖此 CF 的回调链（Completion 链表）
       │
       ▼
   当 complete() 被调用时
   遍历 stack，依次触发回调
```

**线程切换规则**（面试常考）：

1. `complete()` 由谁调用，回调默认就由谁触发（除非 `xxAsync`）。
2. `supplyAsync` 任务由 commonPool（默认）或指定 executor 执行，完成后触发下游回调。
3. `thenApply(fn)` 的 fn 用上游完成线程执行——可能是异步线程，也可能是调用方线程（如果上游已提前完成）。

**陷阱**：

```java
CompletableFuture.supplyAsync(() -> 1, ioPool)
    .thenApply(x -> x + heavyCompute())   // 在 ioPool 线程做重计算！
// 正确：thenApplyAsync(x -> heavyCompute(), computePool)
```

**thenApply vs thenCompose（必答）**：

```java
// thenApply：返回值被包装
CompletableFuture<CompletableFuture<Integer>> wrong =
    cf.thenApply(x -> asyncCall(x));      // 嵌套 CF<CF<Integer>>

// thenCompose：扁平化
CompletableFuture<Integer> right =
    cf.thenCompose(x -> asyncCall(x));    // 直接 CF<Integer>
```

类似 Stream.flatMap 的语义。

## 三、实战层：异步链路治理三要素

**治理 1：必须显式传线程池（禁用 commonPool）**

```java
// 反面：用默认 commonPool
CompletableFuture.supplyAsync(() -> dbCall(id));   // 全局共享，慢任务拖垮
// commonPool 线程数 = CPU-1，IO 任务不够用

// 正面：按业务指定独立线程池
private static final Executor IO_POOL = new ThreadPoolExecutor(
    50, 100, 60, SECONDS, new ArrayBlockingQueue<>(500),
    new ThreadFactoryBuilder().setNameFormat("io-async-%d").build(),
    new ThreadPoolExecutor.CallerRunsPolicy());

CompletableFuture.supplyAsync(() -> dbCall(id), IO_POOL);
```

**治理 2：必须设超时（JDK 9+）**

```java
CompletableFuture.supplyAsync(this::call, IO_POOL)
    .orTimeout(200, MILLISECONDS)              // 总超时 200ms
    .completeOnTimeout(defaultValue, 200, MILLISECONDS)  // 或超时给默认值
    .exceptionally(ex -> {
        if (ex instanceof TimeoutException) {
            metrics.counter("async.timeout").increment();
            return fallback();
        }
        throw new RuntimeException(ex);
    });
```

JDK 8 没 orTimeout，要用 `allOf(...).get(timeout, unit)` 在入口阻塞拿结果（抛 TimeoutException）。

**治理 3：必须有异常兜底**

```java
.exceptionally(ex -> {
    log.error("链路失败", ex);
    metrics.counter("async.fail").increment();
    return PageVO.degraded();   // 降级返回，不让异常向上抛
});
// 或用 handle（拿到结果和异常，更灵活）
.handle((result, ex) -> ex != null ? fallback() : result);
```

**traceId 透传（高阶，生产必做）**：

CompletableFuture 线程切换会丢失 MDC，链路追踪断。要 wrap 线程池：

```java
public static Executor wrap(Executor delegate) {
    return r -> {
        Map<String, String> context = MDC.getCopyOfContextMap();
        delegate.execute(() -> {
            Map<String, String> prev = MDC.getCopyOfContextMap();
            if (context != null) MDC.setContextMap(context);
            try { r.run(); }
            finally {
                if (prev != null) MDC.setContextMap(prev);
                else MDC.clear();
            }
        });
    };
}
// 用 wrap(IO_POOL) 替代原线程池，traceId 自动透传
```

## 四、实战层：常见编排模式

| 模式 | 代码 | 场景 |
|------|------|------|
| **扇出扇入** | `allOf(f1, f2, f3).thenApply(merge)` | 多数据源合并（商品页） |
| **竞速容错** | `anyOf(primary, secondary).orTimeout(100ms)` | 主备双读，谁快用谁 |
| **串行链** | `cf.thenCompose(a -> step2(a)).thenCompose(b -> step3(b))` | 流程编排 |
| **重试** | `cf.exceptionally(ex -> retry())` 或 Resilience4j | 失败重试 |
| **降级** | `cf.exceptionally(ex -> fallback())` | 异常兜底 |

**竞速容错示例**（读主从 DB）：

```java
CompletableFuture<Data> primary = supplyAsync(() -> dbPrimary.get(id), IO_POOL);
CompletableFuture<Data> secondary = supplyAsync(() -> dbSecondary.get(id), IO_POOL);
CompletableFuture<Data> result = CompletableFuture.anyOf(primary, secondary)
    .orTimeout(100, MILLISECONDS)
    .thenApply(o -> (Data) o)
    .exceptionally(ex -> Data.empty());
// 谁先成功用谁，100ms 都没成功就降级
```

## 五、底层本质：为什么是 DAG 而不是回调

回到第一性：**为什么 CompletableFuture 比手写回调 + Future 好？**

因为依赖关系是 DAG（有向无环图），用图建模天然适合：

- 手写回调：每个依赖要嵌套 lambda，3 层就成回调地狱，难以阅读、难以加超时、难以异常处理。
- Future.get() 阻塞：编排 N 个依赖要起 N 个线程 + N 次 get() 阻塞，浪费线程。
- CompletableFuture：每个任务是节点，thenXxx 构造边，运行时按拓扑序触发回调。线程不阻塞在 get()，由线程池驱动回调。声明式描述依赖，运行时调度执行。

本质上 CompletableFuture 是个**轻量级异步任务编排框架**，介于"手写 Future"和"完整响应式框架（Reactor/RxJava）"之间。它不解决背压（流量过载保护），不解决数据流变换（map/filter），只解决"任务依赖图"——这恰好是后端业务编排最常见的场景。

它的边界：不适合流式数据处理（用 Reactor），不适合需要背压的场景（生产者消费者速率不匹配），不适合复杂的错误传播策略。这些场景上 Reactor/RxJava。

## 六、AI 架构师加问：5 个 AI 相关问题

1. **AI Agent 多步骤编排用 CompletableFuture 还是 Reactor？**
   步骤确定、无中间流用 CompletableFuture（简单）；步骤动态、需要中间数据流（如 RAG 检索→重排→生成）用 Reactor。AI Agent 一般用 LangChain4j 这类框架，内部已抽象编排。

2. **AI 推理流式输出怎么和 CompletableFuture 配合？**
   流式（LLM token 流）不适合 CompletableFuture（它是单值完成），要用 Reactor Flux 或 JDK 21 Flow.Publisher；CompletableFuture 只适合"推理完成返回最终结果"。

3. **AI 并发调多个工具（function calling），怎么编排？**
   用 `allOf` 扇出并发调工具，thenApply 合并结果给 LLM 决策。每个工具独立线程池 + 超时 + 异常兜底，避免一个工具卡死整个 Agent。

4. **AI 链路怎么追踪 traceId？**
   线程切换丢 MDC，要 wrap 线程池复制上下文（前述代码）；或用 OpenTelemetry 的 ContextStorage 自动透传。AI 调用记录 tool_call_id + traceId，便于回放和归因。

5. **怎么防 AI 编排的 CompletableFuture 链雪崩？**
   每个异步任务必须有超时（orTimeout）、异常兜底（exceptionally）、独立线程池（隔离）、熔断（Resilience4j）。AI 调用本身慢且不稳定，不治理就是故障源。监控每链路 P99 和失败率。

## 七、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"四类 API、同步异步区别、治理三要素、编排五模式、traceId 透传"**。

- **四类 API**：创建/转换/组合/异常
- **同步异步**：thenApply 用上游线程，thenApplyAsync 切线程池
- **治理三要素**：显式线程池（禁 commonPool）、必须超时、异常兜底
- **五模式**：扇出扇入、竞速容错、串行链、重试、降级
- **traceId**：wrap 线程池复制 MDC

### 拟人化理解

把 CompletableFuture 想成**异步版 Excel**。A1 是 supplyAsync 的原始数据，B1=thenApply(A1) 是公式引用 A1，C1=thenCombine(B1,D1) 合并两个单元格。哪个单元格慢了下游自动等，你不用写 wait/notify。治理三要素就是"指定谁来算（线程池）、多久算不完报警（超时）、算错了给默认值（兜底）"。

### 面试现场 60 秒回答

> CompletableFuture 是异步 DAG 编排工具，API 分创建、转换、组合、异常四类。thenApply 同步用上游线程，thenApplyAsync 切指定线程池。生产治理三要素：必须显式传线程池禁用 commonPool（全局共享、CPU-1 线程数不够）、必须设 orTimeout（JDK 9+）避免下游永久等待、必须有 exceptionally 兜底降级。编排模式有 allOf 扇出扇入、anyOf 竞速容错、thenCompose 串行链。线程切换会丢 MDC，要 wrap 线程池复制 traceId 上下文保持链路追踪完整。它的边界是不支持背压和流式数据，那些场景上 Reactor。

### 反问面试官

> 贵司业务是同步接口异步编排（如商品详情页扇出取数），还是需要流式处理（如实时数据流）？前者我用 CompletableFuture 足够，后者我会评估 Reactor 或 JDK 21 虚拟线程。

## 八、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不用 Future.get + 多线程，要 CompletableFuture？ | 用成本说话：Future.get 阻塞线程，编排 4 个依赖要 4 次阻塞、4 个线程；CompletableFuture 回调驱动不阻塞，1 个请求线程能编排无数依赖 |
| 证据追问 | 你怎么证明异步化真的快了？ | 压测对比串行 vs 并发的 P99（应从 sum 降到 max）；trace 看各链路耗时分布；监控线程池活跃度（应 60-80% 不打满）；失败率不应上升（治理到位的话） |
| 边界追问 | CompletableFuture 能解决所有异步问题吗？ | 不能：流式数据用 Reactor Flux、背压用响应式、CPU 密集用 ForkJoinPool、需要顺序保证用队列。它是单值任务编排，不是万能异步框架 |
| 反例追问 | 什么时候不该用 CompletableFuture？ | 单一同步任务（直接调用更简单）、需要复杂错误传播策略（Reactor 更强）、流式输出（用 Flow/Flux）、CPU 密集计算（直接用线程池） |
| 风险追问 | 异步化上线后最大风险？ | 主动点出：默认 commonPool 拖垮全局、未设超时导致下游卡死雪崩、异常未兜底向上抛 500、traceId 断裂排查困难、线程池用错（IO 用 CPU 池）。要有治理三要素 + 监控 |
| 验证追问 | 怎么证明异步编排没问题？ | 单测覆盖正常/超时/异常三条路径；压测看 P99 和失败率；线上看 trace 各链路耗时 + 链路完整（traceId 不应断）；观察 1 周异常率不应高于同步版本 |
| 沉淀追问 | 团队异步规范，沉淀什么？ | 禁用 commonPool（必须传 executor）、必须 orTimeout、必须 exceptionally、线程池 wrap 透传 MDC、监控大盘（每链路 P99/失败率/超时数）、降级策略 SOP |

### 现场对话示例

**面试官**：你说 commonPool 不能用，为什么？

**候选人**：因为它是 ForkJoinPool 全局共享实例，所有未指定线程池的 CompletableFuture 都用它。三个问题：第一，线程数 = CPU-1，IO 密集任务严重不够用，任务排队；第二，全局共享，一个业务的慢任务拖垮所有其他业务的异步调用；第三，ForkJoinPool 设计目标是 CPU 密集（work-stealing），不适合 IO 密集的阻塞任务。生产必须自定义独立线程池，按业务隔离，IO 用大池、CPU 用小池。

**面试官**：那线程切换丢失 traceId 怎么解决？

**候选人**：CompletableFuture 线程切换默认不复制 MDC，导致链路追踪断裂。解法是 wrap 线程池——在提交 Runnable 时捕获当前 MDC，执行前恢复、执行后清理。我会写一个 `ContextAwareExecutor` 包装类，所有异步线程池都过它一层。或者用 OpenTelemetry 的 ContextStorage 机制自动透传，但框架支持要确认。

**面试官**：超时怎么实现？JDK 8 没有 orTimeout。

**候选人**：JDK 9+ 有 `orTimeout(duration, unit)` 和 `completeOnTimeout(value, duration, unit)`，底层用 DelayedExecutor。JDK 8 要手动：用 `cf.get(timeout, unit)` 在入口阻塞，抛 TimeoutException 后 cancel；或者起一个 ScheduledExecutorService 定时检查 cf 是否完成，超时就 cf.completeExceptionally(new TimeoutException())。生产建议升 JDK 17 用原生 API，或封装一个超时工具类。

## 常见考点

1. **thenApply 和 thenCompose 区别？**——thenApply 的函数返回普通值，结果被包成 CF（嵌套）；thenCompose 的函数返回 CF，结果扁平化（不嵌套）。类似 map vs flatMap。
2. **allOf 和 anyOf 区别？**——allOf 等所有 CF 完成（全成功或任一异常），返回 `CompletableFuture<Void>`；anyOf 等任一 CF 完成，返回 `CompletableFuture<Object>`。allOf 用于扇入聚合，anyOf 用于竞速容错。
3. **CompletableFuture 怎么取消？**——`cf.cancel(true)` 标记完成（异常完成 CancellationException），但**不会中断正在执行的任务**（因为是回调驱动，没有线程可中断）。要真正取消底层任务，要在 Runnable 内部响应中断标志。
4. **为什么 thenApply 可能阻塞调用方线程？**——如果上游 CF 已提前完成，thenApply 的函数会在调用方线程（调用 thenApply 的那个线程）同步执行。要避免用 thenApplyAsync 强制切线程。


## 结构化回答

**30 秒电梯演讲：** 聊到CompletableFuture 编排与异步链路治理，我的理解是——CompletableFuture 的本质是把"回调地狱"变成"可编排的异步数据流"。它不是 Future 的简单升级，而是用 CompletionStage 接口把"任务完成后的动作"建模成链式图——串行、并行、组合、异常处理都变成声明式 API。打个比方，像 Excel 公式链：A1 是原始数据，B1=A1×2，C1=B1+10。CompletableFuture 就是异步版的 Excel——supplyAsync 起 A1，thenApply 是 B1，thenCombine 是把两个 sheet 的结果合到 C1。哪个单元格慢了，下游自动等，不用你写 wait/notify。

**展开框架：**
1. **创建** — supplyAsync/ runAsync（默认 ForkJoinPool.commonPool）
2. **转换** — thenApply（同步）、thenApplyAsync（异步切线程）
3. **组合** — thenCombine（两 CF 合并）、allOf/anyOf（多 CF 聚合）

**收尾：** 这块我在项目里也踩过坑——想深入的话，可以接着聊：为什么默认 ForkJoinPool.commonPool 不能用？您更想看哪个方向？

## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡 | "CompletableFuture 编排与异步链路治理——这道题面试官到底想考什么？我用 30 秒给你讲透。" | 开场钩子 |
| 0:15 | Agent 编排链路图 | 先说核心：CompletableFuture 的本质是把"回调地狱"变成"可编排的异步数据流"。它不是 Future 的简单升级，而是用 CompletionStage 接口把"任务完成。 | 核心定义 |
| 0:30 | Future 任务编排图 | thenApply（同步）、thenApplyAsync（异步切线程）。 | 转换 |
| 1:30 | 总结卡 | 一句话记忆：CompletableFuture 是异步 DAG 构造器，不是 Future 升级版。 下期可以接着聊：为什么默认 ForkJoinPool.commonPool 不能用。 | 收尾总结 |
