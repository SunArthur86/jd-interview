---
id: java-architect-103
difficulty: L2
category: java-architect
subcategory: Java 并发
tags:
- Java 架构师
- Structured Concurrency
- 并发编排
- 取消传播
feynman:
  essence: Structured Concurrency（JEP 505，JDK 24 正式）把"并发任务的生命周期"绑到代码块的词法作用域——StructuredTaskScope 内 fork 的子任务，必须在 scope 关闭前完成（或被取消）。它解决了 CompletableFuture 的"孤儿任务、取消不传播、错误处理散落"三大痛点，让并发编排回到 try-with-resources 的直觉。
  analogy: 像公司项目管理：传统 CompletableFuture 是"开放式工单"（任务发出去就忘了，出错不知道，超时不取消）；StructuredTaskScope 是"项目里程碑"——所有子任务必须在里程碑关闭前完成或被显式取消，没有"游离任务"。
  first_principle: 并发编程的复杂性来自"失控的任务"——子任务超时、异常、孤儿运行，让父任务无法干净退出。StructuredTaskScope 用词法作用域强制"父等子、子随父"，把分散的 Future 链收敛成结构化树。
  key_points:
  - StructuredTaskScope（JDK 21 预览、JDK 24 GA）：fork 子任务 + shutdown 策略
  - ShutdownOnSuccess：第一个成功就取消其他（适用"任何可用"模式）
  - ShutdownOnFailure：任何一个失败就取消其他（适用"全部成功"模式）
  - 取消传播：scope.shutdown() 自动取消所有未完成子任务
  - 与虚拟线程配合：scope 内 fork 默认创建虚拟线程
first_principle:
  problem: CompletableFuture 编排 N 个异步任务时，怎么避免"孤儿任务、取消不传播、错误处理散落"？
  axioms:
  - 任务生命周期应该和代码块（词法作用域）绑定，不能游离
  - 一个任务失败/超时，应该能干净地取消整组兄弟任务
  - 父任务等待子任务是天经地义（结构化并发），不是性能损失
  rebuild: 引入 StructuredTaskScope，把 N 个并发子任务包在 try-with-resources 块里。scope 内 fork 子任务（默认虚拟线程），通过 shutdown 策略（ShutdownOnSuccess / ShutdownOnFailure / 自定义）决定何时取消未完成子任务。scope 关闭时所有子任务必须结束（完成或被取消），保证没有孤儿任务。父任务在 scope.join() 等所有子任务，子任务异常通过 scope 抛给父。
follow_up:
  - StructuredTaskScope 和 ExecutorService 区别？——前者是结构化（scope 关闭前子任务必须结束），后者是开放（submit 后任务游离，Future.cancel 不可靠）。前者强制父子绑定，后者是任务队列
  - ShutdownOnSuccess 和 ShutdownOnFailure 怎么选？——"任何可用"（多机房读）用 Success（最快一个赢，取消其他）；"全部成功"（订单+库存+营销都要成）用 Failure（一个失败全取消）
  - 怎么实现超时？——scope.joinUntil(deadline) 或 scope.orTimeout(duration)，到点 shutdown 取消所有子任务
  - 子任务的异常怎么处理？——ShutdownOnFailure 把异常收集到 scope.throwIfFailed()，父任务统一处理；不会丢失任何一个子任务的异常
  - 能跨线程透传 scope 吗？——不能。scope 是词法作用域绑定，不能像 ThreadLocal 那样透传。子任务继承父的 scope 是 StructuredTaskScope 的核心机制
memory_points:
  - StructuredTaskScope = 词法作用域绑定的并发编排（JEP 505）
  - ShutdownOnSuccess：第一个成功就取消其他（"任何可用"）
  - ShutdownOnFailure：任一失败就取消其他（"全部成功"）
  - 取消传播：scope.shutdown() 自动取消所有未完成子任务
  - 与虚拟线程天生搭配：fork 默认创建虚拟线程
  - 解决 CompletableFuture 三痛点：孤儿任务、取消不传播、错误散落
---

# 【Java 后端架构师】Structured Concurrency 如何简化异步编排

> 适用场景：JD 核心技术。下单链路要并行调用户、库存、营销、风控 4 个服务，用 CompletableFuture 编排：一个超时其他还在跑、一个失败其他异常、错误处理散在 thenApply/exceptionally 里。StructuredTaskScope（JDK 24 GA）让这套编排回到 try-catch 直觉。

## 一、概念层：从开放式并发到结构化并发

**CompletableFuture 的三大痛点**（架构师必须能列出）：

| 痛点 | 表现 | 后果 |
|------|------|------|
| **孤儿任务** | `future.cancel(true)` 不可靠（不真正中断），任务继续跑 | 资源泄漏、超时后还在调下游 |
| **取消不传播** | 一个失败，其他兄弟任务不知道 | 已无意义的任务继续占线程 |
| **错误处理散落** | thenApply/thenCompose/exceptionally 链，异常在多个回调里 | 堆栈丢失、错误处理重复或漏掉 |

**Structured Concurrency 的对照解法**：

```
StructuredTaskScope（结构化）              CompletableFuture（开放式）
─────────────────────────                  ─────────────────────────
try (var scope =                            CompletableFuture<User> u =
    new StructuredTaskScope<>()) {              userService.fetch(id);
    var t1 = scope.fork(...);              CompletableFuture<Stock> s =
    var t2 = scope.fork(...);                   stockService.fetch(id);
    scope.join();                           u.thenCombine(s, ...)
     .exceptionally(...)                    .orTimeout(2, SECONDS)
     .whenComplete(...)                     .whenComplete(...)
}                                           // 任务游离，错误散落
// scope 关闭：所有子任务必须结束
```

**关键概念对比**：

| 维度 | ExecutorService / CompletableFuture | StructuredTaskScope |
|------|-------------------------------------|---------------------|
| 任务生命周期 | 游离（submit 后任务独立） | 绑定到 try 块（scope 关闭前必须结束） |
| 取消机制 | Future.cancel（不可靠） | scope.shutdown（强制传播到所有子任务） |
| 错误聚合 | 散在回调里 | scope.throwIfFailed（统一抛） |
| 父子关系 | 弱（Future 链是平的） | 强（父等子、子随父） |
| 默认线程 | 平台线程池 | 虚拟线程（自动） |

## 二、机制层：ShutdownOnSuccess 与 ShutdownOnFailure

**ShutdownOnSuccess：第一个成功就取消其他**（"任何可用"模式）

```java
// 场景：多机房读用户信息，最快返回的赢，其他取消
public User readFromAnyRegion(Long userId) throws Exception {
    try (var scope = new StructuredTaskScope.ShutdownOnSuccess<User>()) {
        scope.fork(() -> userService.fetchFromBJ(userId));   // 北京机房
        scope.fork(() -> userService.fetchFromSH(userId));   // 上海机房
        scope.fork(() -> userService.fetchFromGZ(userId));   // 广州机房
        scope.join();                // 等最快一个成功
        return scope.result();       // 拿到第一个成功的结果
        // 其他还在跑的子任务自动被 cancel（取消传播）
    }
}
// 对比 CompletableFuture：要写复杂的 anyOf + 手动 cancel，且 cancel 不可靠
```

**ShutdownOnFailure：任一失败就取消其他**（"全部成功"模式）

```java
// 场景：下单要同时扣库存、创建订单、发优惠券，任一失败全取消
public Order createOrder(OrderDTO dto) throws Exception {
    try (var scope = new StructuredTaskScope.ShutdownOnFailure()) {
        var stockTask  = scope.fork(() -> stockService.deduct(dto));    // Subtask<Stock>
        var orderTask  = scope.fork(() -> orderRepo.create(dto));       // Subtask<Order>
        var couponTask = scope.fork(() -> couponService.grant(dto));    // Subtask<Coupon>

        scope.join();                 // 等所有子任务结束
        scope.throwIfFailed();        // 任一失败，抛异常并取消其他

        // 全部成功才到这
        return Order.combine(
            orderTask.get(),
            stockTask.get(),
            couponTask.get()
        );
    }
}
// 对比 CompletableFuture：要 allOf + 处理每个 future 的异常，错一个其他继续跑
```

**超时控制**（生产必备）：

```java
public Order createOrder(OrderDTO dto) throws Exception {
    try (var scope = new StructuredTaskScope.ShutdownOnFailure()) {
        var stockTask  = scope.fork(() -> stockService.deduct(dto));
        var orderTask  = scope.fork(() -> orderRepo.create(dto));
        var couponTask = scope.fork(() -> couponService.grant(dto));

        // 方式 1：joinUntil 绝对时间
        scope.joinUntil(Instant.now().plusSeconds(2));

        // 方式 2：自定义 scope 重写 isTimeout
        // public class TimedScope extends ShutdownOnFailure {
        //     private final Instant deadline;
        //     public boolean isTimeout() { return Instant.now().isAfter(deadline); }
        // }

        scope.throwIfFailed();
        return Order.combine(orderTask.get(), stockTask.get(), couponTask.get());
    } catch (TimeoutException e) {
        // 超时：scope 关闭时自动取消所有未完成子任务
        throw new BusinessException("下单超时");
    }
}
```

## 三、实战层：CompletableFuture 重构案例

**重构前：CompletableFuture 编排（混乱）**

```java
// 反例：错误散落、取消不传播、超时处理复杂
public OrderResult createOrder_legacy(OrderDTO dto) {
    CompletableFuture<Stock> stockFuture =
        CompletableFuture.supplyAsync(() -> stockService.deduct(dto), executor)
                         .orTimeout(2, TimeUnit.SECONDS);
    CompletableFuture<Order> orderFuture =
        CompletableFuture.supplyAsync(() -> orderRepo.create(dto), executor)
                         .orTimeout(2, TimeUnit.SECONDS);
    CompletableFuture<Coupon> couponFuture =
        CompletableFuture.supplyAsync(() -> couponService.grant(dto), executor)
                         .orTimeout(2, TimeUnit.SECONDS);

    try {
        return CompletableFuture.allOf(stockFuture, orderFuture, couponFuture)
            .thenApply(v -> new OrderResult(
                orderFuture.get(),
                stockFuture.get(),
                couponFuture.get()
            ))
            .exceptionally(ex -> {
                // 问题 1：异常混在一个回调，不知道是哪个失败
                // 问题 2：失败时其他 future 可能还在跑（取消不传播）
                // 问题 3：future.cancel(true) 不可靠，下游还在被调
                log.error("order failed", ex);
                throw new RuntimeException(ex);
            })
            .get(2, TimeUnit.SECONDS);
    } catch (Exception e) {
        // 问题 4：手动 cancel，但很多 IO 不响应 interrupt
        stockFuture.cancel(true);
        orderFuture.cancel(true);
        couponFuture.cancel(true);
        throw new BusinessException(e);
    }
}
```

**重构后：StructuredTaskScope（清晰）**

```java
public OrderResult createOrder(OrderDTO dto) throws Exception {
    try (var scope = new StructuredTaskScope.ShutdownOnFailure(
            "order-create", Thread.ofVirtual().factory())) {
        var stockTask  = scope.fork(() -> stockService.deduct(dto));
        var orderTask  = scope.fork(() -> orderRepo.create(dto));
        var couponTask = scope.fork(() -> couponService.grant(dto));

        scope.joinUntil(Instant.now().plusSeconds(2));   // 整体超时
        scope.throwIfFailed(ex -> new BusinessException("下单失败", ex));

        return new OrderResult(orderTask.get(), stockTask.get(), couponTask.get());
    }
    // scope 关闭时自动取消所有未完成子任务（取消传播）
}
```

**自定义 ShutdownOnSuccess：选最快的 + 失败容忍**

```java
// 场景：3 个机房读用户，只要 1 个成功就返回，但所有失败也要记录
public class QuorumScope<T> extends StructuredTaskScope.ShutdownOnSuccess<T> {
    private final List<Throwable> errors = Collections.synchronizedList(new ArrayList<>());

    @Override
    protected void handleComplete(Subtask<? extends T> subtask) {
        if (subtask.state() == Subtask.State.FAILED) {
            errors.add(subtask.exception());   // 收集所有失败
        }
        super.handleComplete(subtask);
        if (subtask.state() == Subtask.State.SUCCESS) {
            shutdown();   // 任一成功就取消其他
        }
    }

    public List<Throwable> getErrors() { return List.copyOf(errors); }
}

// 使用
try (var scope = new QuorumScope<User>()) {
    scope.fork(() -> userService.fetchFromBJ(id));
    scope.fork(() -> userService.fetchFromSH(id));
    scope.fork(() -> userService.fetchFromGZ(id));
    scope.join();
    if (scope.getErrors().size() == 3) {
        throw new ServiceException("所有机房都失败: " + scope.getErrors());
    }
    return scope.result();
}
```

## 四、底层本质：为什么"词法作用域"是关键

回到第一性：**为什么 StructuredTaskScope 用 try-with-resources 而不是返回 Future？**

- **词法作用域 = 可见的生命周期**：当你看到 `try (var scope = ...) { ... }` 时，肉眼就能看到这个 scope 的所有 fork 都在块内，scope 关闭后没有游离任务。CompletableFuture 的链式调用跨多个方法、跨多个回调，肉眼看不到任务边界。
- **强制父等子**：scope.join() 在 try 块内必须被调用（否则编译器会警告或抛 IllegalState），保证父任务不会在子任务还在跑时退出。这避免了"父方法 return 了但后台还有任务跑"的资源泄漏。
- **取消传播的根因**：scope 是任务树的根，shutdown 时遍历所有未完成子任务调用 interrupt。子任务内部如果用虚拟线程 + 友好的 IO（NIO/HttpClient），interrupt 会立即生效（不像 CompletableFuture 的 cancel 经常不响应）。

**与虚拟线程的天生搭配**：

```java
// StructuredTaskScope 内 fork 默认用虚拟线程
try (var scope = new StructuredTaskScope.ShutdownOnFailure()) {
    // 这 1000 个 fork 是 1000 个虚拟线程，carrier 只有 CPU 核数个
    for (int i = 0; i < 1000; i++) {
        scope.fork(() -> fetchItem(i));
    }
    scope.join();
}
// 没有线程池打满的担忧（虚拟线程轻量），又拿到了结构化编排的清晰
```

**注意：JDK 版本演进**：
- JDK 21：StructuredTaskScope 预览（JEP 453，需 `--enable-preview`）
- JDK 22/23：API 微调（JEP 462/480，仍预览）
- JDK 24：正式 GA（JEP 505，API 稳定，Subtask 替代 Future）
- JDK 25：进一步完善（JEP 505 增强的 shutdown 策略）

## 五、AI 架构师加问：5 个

1. **AI Agent 调用多个工具（LLM + RAG + Search + DB），用 StructuredTaskScope 编排怎么设计？**
   一个 Agent 会话起一个虚拟线程，每个 tool_call 用 scope.fork 起子任务，超时 30s。ShutdownOnFailure：任一工具失败抛给 Agent，Agent 决定降级还是重试。ShutdownOnSuccess：并行查多个数据源（向量库 + 关键词 + 知识图谱），最快返回的赢，其他取消。Agent 拿到结果后用 LLM 合成最终答案。

2. **AI 怎么自动把 CompletableFuture 代码重构成 StructuredTaskScope？**
   AI 解析 CompletableFuture 链：识别 allOf（→ ShutdownOnFailure）、anyOf（→ ShutdownOnSuccess）、thenApply（→ scope.fork + lambda）。难点是异常处理重构（exceptionally → throwIfFailed）和超时合并（每个 future.orTimeout → scope.joinUntil）。建议 AI 出 diff 人工 review，因为语义不完全等价（取消可靠性变了）。

3. **AI 推理服务并行调多个 GPU，StructuredTaskScope 适用吗？**
   适用。每个 GPU 推理是一个 fork（虚拟线程内部包平台线程池跑 CUDA）。ShutdownOnSuccess：3 个 GPU 跑同一模型冗余推理，最快返回的赢（容错）；ShutdownOnFailure：流水线推理（预处理 + 推理 + 后处理），任一阶段失败取消整条流水线。

4. **StructuredTaskScope 配合 LLM streaming（流式输出）怎么用？**
   流式输出场景下，scope 的"join 等所有完成"语义需要扩展——流式 token 应该边产生边返回，不是等全部生成完。解法：用 SynchronousQueue 或 Flux 把子任务的中间结果流式传给父，scope 只控制"何时取消整组"，不阻塞流式。或者用自定义 scope 重写 handleComplete 在每个子任务产出 token 时回调。

5. **AI Copilot 帮业务写 StructuredTaskScope 代码，最容易翻车在哪？**
   三个点：① ShutdownOnFailure 调用 throwIfFailed 前必须 join（否则未完成任务抛 NPE）；② 子任务 lambda 内的 checked exception 必须包装成 RuntimeException 或 throw（Subtask.get 抛）；③ scope 内 fork 的子任务不能再 fork 子 scope（嵌套限制）。AI 生成要 lint 这些规则。

## 六、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"两个 shutdown 策略、取消传播、虚拟线程搭配、JDK 24 GA"**。

- **ShutdownOnSuccess**：第一个成功就取消其他（"任何可用"）
- **ShutdownOnFailure**：任一失败就取消其他（"全部成功"）
- **取消传播**：scope.shutdown() 自动取消所有未完成子任务
- **超时**：scope.joinUntil(deadline) 到点 shutdown
- **虚拟线程**：scope.fork 默认创建虚拟线程（轻量、海量并发）
- **版本**：JDK 21/22/23 预览，JDK 24（JEP 505）GA

### 拟人化理解

把 StructuredTaskScope 想成**项目里程碑管理**。传统 ExecutorService 是"开放式工单"——你发出去任务就忘了，任务游离运行，超时也不知道取消。StructuredTaskScope 是"里程碑"——所有子任务必须在里程碑关闭前完成或被取消，没有游离任务。ShutdownOnSuccess 是"第一个交活就收工"（其他兄弟可以下班）；ShutdownOnFailure 是"一个出错全停"（避免无意义的工作）。

### 面试现场 60 秒回答

> Structured Concurrency（JDK 24 JEP 505 GA）解决了 CompletableFuture 的孤儿任务、取消不传播、错误处理散落三大痛点。核心是 StructuredTaskScope 把并发任务的生命周期绑到 try-with-resources 的词法作用域——scope 关闭前所有 fork 的子任务必须结束。两个内置策略：ShutdownOnSuccess 用于"任何可用"（多机房读最快赢），ShutdownOnFailure 用于"全部成功"（任一失败全取消）。取消传播是核心：scope.shutdown() 自动取消所有未完成子任务，不像 CompletableFuture.cancel 那么不可靠。配合虚拟线程（scope.fork 默认创建 VT）拿海量并发 + 结构化清晰。落地：先把下单链路（扣库存+创建订单+发券）从 CompletableFuture allOf 重构成 ShutdownOnFailure，超时用 joinUntil。

### 反问面试官

> 贵司 JDK 版本是 21 还是 24+？异步编排主要用什么（CompletableFuture / Reactor / 自研）？如果是 JDK 21 没法直接用 GA 版本，我会聊预览特性 + 过渡方案；如果是 JDK 24+ 可以直接聊生产落地。

## 七、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 已经用 CompletableFuture 了，为什么还要 StructuredTaskScope？ | 三痛点：cancel 不可靠导致下游继续被调、错误散在多个回调里、孤儿任务无法干净退出。StructuredTaskScope 用词法作用域强制"父等子"，scope.shutdown 真正取消。证明：重构后下单链路超时后下游调用量降为 0（CompletableFuture 还有 30% 流量） |
| 证据追问 | 怎么证明 Structured Concurrency 比 CompletableFuture 好？ | 监控对比：超时后的下游 QPS（应降为 0）、错误聚合的完整性（无遗漏）、代码行数（少 40%）和可读性（review 时间降）。压测：取消后资源占用（线程/连接）下降速度 |
| 边界追问 | StructuredTaskScope 能完全替代 CompletableFuture 吗？ | 不能。流式（stream）处理 CompletableFuture 更擅长（thenApply 链）；纯 CPU 任务用 ExecutorService 直接 submit 更简单；跨系统异步消息（Kafka）不能用 scope（生命周期跨进程）。Structured 适合"一次同步调用的并发编排" |
| 反例追问 | 什么场景不要用 Structured Concurrency？ | 长生命周期任务（如后台 worker，不在请求 scope 内）、跨进程异步（消息队列解耦）、流式处理（Reactor/Flux 更擅长）、JDK 21 预览期生产不敢用 |
| 风险追问 | 用 StructuredTaskScope 最大风险？ | ① JDK 版本（21 是预览，生产要 --enable-preview 有兼容风险）；② 子任务 lambda 内的 checked exception 处理（要 throw 或包装）；③ 嵌套 scope 限制（子任务不能再 fork scope）。治法：评估 JDK 24 GA、Code Review 模板、单元测试覆盖 |
| 验证追问 | 怎么证明重构后没引入新问题？ | 单元测试：成功 / 部分失败 / 全部失败 / 超时 四种场景对比 CompletableFuture；压测：吞吐不退化（虚拟线程应该更好）；线上灰度：10% 流量看 P99、错误率、超时率 |
| 沉淀追问 | 团队推广 Structured Concurrency 沉淀什么？ | ShutdownOnSuccess/Failure 使用 SOP（场景对应）、scope 模板代码（超时、错误聚合、日志）、CompletableFuture → StructuredTaskScope 重构 checklist、JDK 版本升级路线（21 预览 → 24 GA） |

### 现场对话示例

**面试官**：CompletableFuture 用得好好的，为什么搞 StructuredTaskScope？

**候选人**：CompletableFuture 有三个痛点。第一，cancel 不可靠——超时后 future.cancel(true) 调用了，但下游 HTTP 请求不响应 interrupt，还在继续打下游。第二，错误散落——一个 allOf 链路里 3 个子任务，异常在 exceptionally 里混在一起，不知道是哪个失败的。第三，孤儿任务——主方法 return 了，后台还有 task 在跑，资源泄漏。StructuredTaskScope 用 try-with-resources 绑定生命周期：scope 关闭前所有 fork 必须结束（完成或被取消），shutdown 自动取消传播，throwIfFailed 统一抛异常。重构后下单链路超时后下游 QPS 真的降为 0，错误聚合完整。

**面试官**：取消传播怎么保证可靠？

**候选人**：两个条件。第一，子任务用虚拟线程（scope.fork 默认创建 VT），虚拟线程对 interrupt 友好。第二，子任务内部的 IO 用虚拟线程友好的 API（NIO、java.net.http.HttpClient、JDBC 8.0.33+），这些 API 响应 interrupt。如果子任务里有 synchronized 阻塞或 native IO，取消不可靠（pinning 也影响取消）。所以 StructuredTaskScope + 虚拟线程 + 友好 IO 是组合拳，缺一不可。

**面试官**：ShutdownOnSuccess 和 ShutdownOnFailure 同时要怎么办？比如"全部成功，但如果 1 个超过 500ms 就用最快的"？

**候选人**：用自定义 scope。继承 ShutdownOnFailure，重写 handleComplete：① 子任务成功就记录；② 失败就 shutdown（取消其他）；③ 超过 500ms 阈值就 shutdown（用 joinUntil 控制）。或者拆两层 scope：外层 ShutdownOnFailure 保证全部成功，内层 ShutdownOnSuccess 在 500ms 后选最快。复杂场景下自定义 scope 是正解，StructuredTaskScope 设计就是鼓励子类化。

## 常见考点

1. **StructuredTaskScope 是什么？**——JDK 24（JEP 505）GA 的结构化并发 API，把并发任务生命周期绑到 try-with-resources 词法作用域。子任务必须 scope 关闭前结束。
2. **ShutdownOnSuccess 和 ShutdownOnFailure 区别？**——前者第一个成功就取消其他（"任何可用"，多机房读）；后者任一失败就取消其他（"全部成功"，下单链路）。
3. **取消传播怎么实现？**——scope.shutdown() 遍历所有未完成子任务调用 interrupt，配合虚拟线程 + 友好 IO（NIO/HttpClient）才能真正取消。
4. **怎么实现超时？**——scope.joinUntil(Instant deadline) 或自定义 scope 重写 isTimeout，到点 shutdown 取消所有子任务。
5. **JDK 版本要求？**——21/22/23 预览（需 --enable-preview），24（JEP 505）GA。生产建议 JDK 24+ 直接用 GA 版本。

## 结构化回答

**30 秒电梯演讲：** Structured Concurrency（JEP 505，JDK 24 正式）把并发任务的生命周期绑到代码块的词法作用域——StructuredTaskScope 内 fork 的子任务，必须在 scope 关闭前完成（或被取消）。它解决了 CompletableFuture 的孤儿任务、取消不传播、错误处理散落三大痛点，让并发编排回到 try-with-resources 的直觉

**展开框架：**
1. **StructuredTa** — StructuredTaskScope（JDK 21 预览、JDK 24 GA）：fork 子任务 + shutdown 策略
2. **ShutdownOnSuccess** — 第一个成功就取消其他（适用"任何可用"模式）
3. **取消传播** — scope.shutdown() 自动取消所有未完成子任务

**收尾：** 以上是我的整体思路。您想继续深入聊——StructuredTaskScope 和 ExecutorService 区别？


## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：Structured Concurrency 如 | "这题核心是——Structured Concurrency（JEP 505，JDK 24 正式）把并发任务的生命……" | 开场钩子 |
| 0:15 | StructuredTa示意/对比图 | "StructuredTaskScope（JDK 21 预览、JDK 24 GA）：fork 子任务 + shutdown 策略" | StructuredTa要点 |
| 0:40 | ShutdownOnSucces示意/对比图 | "第一个成功就取消其他（适用任何可用模式）" | ShutdownOnSucces要点 |
| 1:25 | 总结卡 | "记住：StructuredTask。下期见。" | 收尾 |
