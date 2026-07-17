---
id: pdd-trade-014
difficulty: L2
category: pdd-trade
subcategory: Java 并发
tags:
- 拼多多
- 交易
- 线程池
- 池化
feynman:
  essence: 线程池用"核心+队列+非核心+拒绝"四级水位应对流量，阿里规约禁 Executors（无界 OOM），必须 new ThreadPoolExecutor 有界。
  analogy: 餐厅——正式员工（核心）、等位区（队列）、临时工（非核心）、超载拒绝。
  first_principle: 线程创建成本高，池化复用；四级水位让洪峰优雅降级。
  key_points:
  - 7 参数（core/max/keepAlive/queue/factory/handler/unit）
  - 提交顺序：核心→队列→非核心→拒绝（先队列后扩容）
  - 4 种拒绝策略，常用 CallerRuns（反压）
  - 禁 Executors，必须 new + 有界
first_principle:
  problem: 高并发下线程创建销毁成本高，如何复用+削峰+降级？
  axioms:
  - 创建有成本
  - 资源有限
  rebuild: 核心常驻+有界队列+临时扩容+拒绝兜底。
follow_up:
- 线程数怎么设？——CPU 密集 N+1，IO 密集 2N
- 为什么禁 Executors？——newFixed 无界队列 OOM、newCached 线程 MAX OOM
- 怎么传 TraceId？——装饰 Runnable
memory_points:
- 提交顺序：核心→队列→非核心→拒绝
- 必须有界（队列+线程）
- CallerRuns 反压
- 线程命名便于排查
---

# 【拼多多交易】线程池怎么配置？

> JD 依据："理解并发、高并发调优"。

## 一、核心参数与流程

```java
new ThreadPoolExecutor(
    corePoolSize, maximumPoolSize, keepAliveTime, unit,
    workQueue, threadFactory, rejectedHandler
);
```

提交顺序：核心线程 → 队列 → 非核心线程 → 拒绝（**先队列后扩容**）。

## 二、交易实战

```java
ThreadPoolExecutor orderPool = new ThreadPoolExecutor(
    64, 128, 60, SECONDS,
    new LinkedBlockingQueue<>(2000),
    new ThreadFactoryBuilder().setNameFormat("order-%d").build(),
    new CallerRunsPolicy()
);
```

线程数：IO 密集（查 DB/Redis 多）→ 8 核机器 64 线程。

## 三、禁用 Executors

| 方法 | 坑 |
|------|-----|
| newFixedThreadPool | 无界队列 OOM |
| newCachedThreadPool | 线程 MAX OOM |

## 四、监控

```java
Gauge.builder("pool.active", pool, ThreadPoolExecutor::getActiveCount).register();
Gauge.builder("pool.queue.size", pool, p -> p.getQueue().size()).register();
```

队列 > 80% 告警扩容。

## 五、底层本质

池化是"资源租赁做市商"：核心覆盖稳态、队列缓冲、临时扩容、拒绝兜底，每级成本递增。

## 常见考点
1. **核心能回收吗**？——`allowCoreThreadTimeOut(true)`。
2. **submit vs execute**？——submit 返回 Future。
3. **传 TraceId**？——装饰 Runnable 捕获父线程 MDC。

## 苏格拉底式面试追问

> 这组追问不背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：你给订单服务配了 corePoolSize=64、queue=2000、max=128，这个 64 是怎么算出来的？为什么不直接 200 让它跑满？**

64 是基于"线程数 = CPU 核数 × (1 + 等待时间/计算时间)"算的。订单服务是 IO 密集（查 DB/Redis/RPC 占大头），8 核机器，假设等待/计算比 7:1，线程数 = 8 × (1+7) = 64。为什么不直接 200——线程太多反而慢：一是上下文切换开销（CPU 在线程间切换浪费），二是线程多导致 DB 连接竞争（每个线程可能占一个 DB 连接，200 线程要 200 连接，DB 扛不住），三是内存开销（每个线程默认 1MB 栈，200 线程 200MB）。线程数不是越多越好，是"刚好让 CPU 和下游资源饱和"的最优点。64 是稳态，queue 缓冲峰值，max=128 是极端峰值扩容，CallerRuns 反压兜底。

### 第二层：证据与定位

**Q：订单线程池的队列堆积到 2000（满了），拒绝策略 CallerRuns 触发，但下单 P99 飙到 5 秒，你怎么定位是线程池配置小，还是下单逻辑变慢了？**

看活跃线程数和单任务耗时。三步：
1. 看 `pool.activeCount`——如果 activeCount 一直是 64（核心打满）但没到 max=128，说明队列满了但非核心线程没扩容（这是正常的，ThreadPoolExecutor 先队列后扩容）。如果 activeCount 到了 128，说明已扩容到极限还扛不住。
2. 看单任务耗时——`pool.completedTaskCount / 运行时间` 算吞吐，或用 APM 看单次下单的 trace 耗时分布。如果单任务从 50ms 飙到 500ms，是下单逻辑慢了（如 DB 慢查询、下游 RPC 超时），线程池只是背锅——再大的池子也救不了慢任务。
3. 区分"任务太多"vs"任务太慢"——如果单任务耗时正常（50ms）但队列满，是 QPS 涨了（流量峰值），要扩容或限流；如果单任务变慢，要优化任务本身。重点是别一看到队列满就调大池子，先看是"供给（流量）增加"还是"处理（单任务）变慢"。

### 第三层：根因深挖

**Q：你定位到是单任务变慢（下单调库存的 RPC 从 20ms 飙到 300ms），根因是库存服务慢，但订单线程池也跟着堆积了，根因链条是什么？光是催库存服务优化就行？**

根因链条是"下游慢 → 订单任务阻塞在线程池 → 线程池被占满 → 新任务排队 → P99 飙高"。这暴露了订单线程池的"隔离性"问题：库存慢把订单线程全占了，导致连不依赖库存的操作（如查订单详情）也排不上队。治本：
1. 线程池隔离——不同下游用不同线程池（库存线程池、支付线程池、查询线程池），库存慢不拖垮查询。这是舱壁模式（Bulkhead）。
2. 调用方加超时——库存 RPC 必须有 readTimeout（如 200ms），超时快速失败而不是无限等待，保护订单线程不被长期占用。
3. 库存服务慢的根因要单独查（可能是它自己的线程池/DB/依赖问题）。但即使库存慢，订单服务要能"快速失败保住自己"，而不是被拖垮。线程池隔离 + 超时是调用方的自我保护。

**Q：那为什么不直接把队列改成无界（LinkedBlockingQueue 无容量），任务就不会被拒绝了？**

无界队列是 OOM 定时炸弹。队列无界意味着任务无限堆积，每个任务对象占内存，队列几百万任务时堆直接爆。阿里规约禁 `Executors.newFixedThreadPool` 就是因为它用无界队列。更隐蔽的问题是"无界队列让 max 线程数失效"——ThreadPoolExecutor 先队列后扩容，队列永远不满就永远不扩容到 max，线程池退化成固定 corePoolSize，抗峰值能力消失。有界队列 + max 扩容 + CallerRuns 拒绝才是正确的水位设计：稳态用 core、缓冲用 queue、峰值扩 max、极限反压（CallerRuns 让调用方线程自己跑，天然限流）。无界队列是"看似不拒绝实则 OOM"，更危险。

### 第四层：方案权衡

**Q：你用 CallerRunsPolicy 作为拒绝策略，但调用方线程（如 Tomcat 线程）自己跑任务会阻塞 Tomcat 线程，影响其他请求，你怎么权衡？**

CallerRunsPolicy 的动机恰恰是"反压"——当线程池满，让调用方自己跑任务，调用方变慢，自然少发新请求，形成背压保护系统不被压垮。权衡：
1. 反压是特性不是 bug——Tomcat 线程被占用，该请求变慢，但系统整体不会因线程池 OOM 而崩。比 AbortPolicy（抛异常）更优雅（用户等几秒而不是直接失败）。
2. 如果不想影响 Tomcat 其他请求，用线程池隔离——下单用独立线程池，CallerRuns 时阻塞的是下单请求的 Tomcat 线程，不影响查订单的 Tomcat 线程。
3. 更主动的做法是"队列将满时提前限流"——监控 `queue.size() > 80% * capacity` 触发限流（返回"系统繁忙"），而不是等到满了才 CallerRuns。本质是"用限流替代被动反压"，体验更可控（主动拒绝 vs 被动阻塞）。

**Q：为什么不直接用 SynchronousQueue（不缓冲，直接交给线程），这样任务不堆积，响应更快？**

SynchronousQueue 没有 buffer，任务必须立即交给一个线程，否则扩容新线程或拒绝。这适合"任务必须快速处理、不能缓冲"的场景（如 RPC 调用），但代价是 maxPoolSize 必须很大（否则峰值时大量拒绝）。`Executors.newCachedThreadPool` 就用 SynchronousQueue + max=Integer.MAX_VALUE，结果是峰值时无限创建线程导致 OOM。交易下单用 LinkedBlockingQueue(2000) 的权衡是"用队列缓冲削峰 + 有界线程防爆"——下单允许短暂排队（用户可接受 1-2 秒等待），换取线程数可控。SynchronousQueue 适合"低延迟、不缓冲"的纯计算任务，不适合"允许短暂排队、要削峰"的业务请求。

### 第五层：验证与沉淀

**Q：你怎么验证线程池配置能扛住大促峰值，而不是"平时够用，大促就崩"？**

必须压测验证 + 容量规划：
1. 压测——用预估的大促峰值 QPS 压下单接口，观察 `pool.activeCount`、`queue.size`、`reject_count`、单任务 P99。如果 reject_count=0 且 P99 满足 SLA，配置够。如果 reject 或 P99 飙高，要扩容（加 core/max）或优化任务。
2. 容量模型——记录"QPS / activeCount / 单任务耗时"的关系，建立模型（如 1 万 QPS 需要 corePoolSize=64），下次大促按预估 QPS 算配置。压测数据沉淀成容量基线。
3. 压测要覆盖"下游变慢"场景——人为让库存 RPC 慢 500ms，验证线程池隔离和超时是否生效，订单服务不被拖垮。光压正常场景没意义，要压故障场景。

**Q：线程池配置怎么沉淀成规范，避免新人乱用（如无界队列、Executors）？**

靠规约 + 工具：
1. 阿里规约禁 Executors——CI 用 PMD/Checkstyle 规则扫描，发现 `Executors.newFixed/newCached` 直接编译失败，强制 `new ThreadPoolExecutor`。
2. 线程池工厂 SDK——封装 `ThreadPoolBuilder`，强制要求传入有界队列、命名（`nameFormat` 便于 jstack 排查）、拒绝策略（默认 CallerRuns）、监控埋点。业务侧用 builder 而非裸 new，减少误配。
3. 线程池动态调参——接入配置中心（如美团动态线程池方案），corePoolSize/maxPoolSize/queue 容量可运行时调整不重启。大促前动态扩容，平时缩容。把线程池从"静态配置"变成"动态治理"。
4. 监控大盘——所有线程池的 active/queue/reject 指标接入大盘，异常自动告警。拼多多几千个线程池，靠人盯不现实，必须监控兜底。

## 结构化回答

**30 秒电梯演讲：** 高并发下线程创建销毁成本高，如何复用+削峰+降级？简单说就是——线程池用"核心+队列+非核心+拒绝"四级水位应对流量，阿里规约禁 Executors（无界 OOM），必须 new ThreadPoolExecutor 有界。

**展开框架：**
1. **7 参数c** — 7 参数（core/max/keepAlive/queue/factory/handler/unit）
2. **提交顺序** — 提交顺序：核心→队列→非核心→拒绝（先队列后扩容）
3. **4 种拒绝策略** — 4 种拒绝策略，常用 CallerRuns（反压）

**收尾：** 您看这块要不要再展开聊聊？

## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：线程池怎么配置？ | 今天聊「线程池怎么配置？」。一句话：线程池用"核心+队列+非核心+拒绝"四级水位应对流量，阿里规约禁 Executors（无界 OOM） | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：7 参数（core/max/keepAlive/queue/factory/handler/unit） | 核心概念 |
| 1:00 | 能力/参数拆解表 | 要点是：提交顺序：核心→队列→非核心→拒绝（先队列后扩容） | 能力拆解 |
| 2:00 | 总结卡 + 下期预告 | 记住核心要点就够了。下期见。 | 收尾 |
