---
id: ant-risk-003
difficulty: L2
category: ant-risk
subcategory: Java 并发
tags:
- 蚂蚁
- 风控
- 线程池
- 池化
- ThreadPoolExecutor
feynman:
  essence: 线程池预先创建线程反复利用，用「核心线程数 + 队列 + 最大线程数 + 拒绝策略」四级兜底，应对流量洪峰。
  analogy: 线程池像一家餐厅：核心线程是正式员工（来客就服务），队列是等位区（满了就排队），最大线程是临时工（等位也满了才招），拒绝策略是超过最大承载时的处理（换店/排队失败）。
  first_principle: 创建线程的成本（OS 调度+栈内存）远高于复用。池化把"创建-使用-销毁"变成"借-还"，并用排队削峰。
  key_points:
  - 7 个核心参数：corePoolSize、maximumPoolSize、keepAliveTime、workQueue、threadFactory、rejectedHandler、unit
  - 任务提交 → 核心线程 → 队列 → 非核心线程 → 拒绝
  - 4 种拒绝策略：Abort（抛异常默认）、CallerRuns（调用者执行）、Discard（丢弃）、DiscardOldest（丢最老的）
  - Executors 工厂方法被阿里规约禁止（OOM 风险），必须 new ThreadPoolExecutor
first_principle:
  problem: 面对突发的、不可预测的并发任务，如何既复用线程降低成本，又能在过载时优雅降级而非崩溃？
  axioms:
  - 线程创建有成本（栈 1MB+、OS 调度），复用优于新建
  - 资源（线程、内存）有限，过载必须降级
  - 排队是削峰最便宜的手段
  rebuild: 用"核心线程 + 有界队列 + 临时扩容线程 + 拒绝策略"四级水位，把流量的洪峰转成稳定的处理速率，并在真正过载时按业务可接受的策略降级。
follow_up:
- 线程数怎么设置？——CPU 密集型 N+1，IO 密集型 2N 或 N×(1+等待/计算)；风控是 IO 密集（查 HBase/Redis）所以偏大
- 你用 Executors.newFixedThreadPool 有什么坑？——队列无界 LinkedBlockingQueue，任务堆积 OOM
- 如何优雅关闭线程池？——shutdown()（不接受新任务等已提交完成）+ awaitTermination(超时)，不行再 shutdownNow()
memory_points:
- 提交顺序：核心线程 → 队列 → 非核心线程 → 拒绝（注意是先队列后扩容！）
- 阿里规约：禁用 Executors，必须 new ThreadPoolExecutor 且队列必须有界
- 4 种拒绝策略，风控常用 CallerRuns（让上游感知压力）或自定义降级
- IO 密集型线程数 ≈ N×(1 + 等待时间/计算时间)
---

# 【蚂蚁风控】线程池的工作原理？拒绝策略有哪些？你们风控的线程池是怎么配置的？

> JD 依据："攻克各种高并发技术难关"。线程池是池化思想代表，风控的特征查询、规则匹配都是多线程并行。

## 一、表面层：7 个核心参数

`ThreadPoolExecutor` 的构造函数：
```java
public ThreadPoolExecutor(
    int corePoolSize,                 // 核心线程数（即使空闲也不销毁，除非 allowCoreThreadTimeOut）
    int maximumPoolSize,              // 最大线程数
    long keepAliveTime,               // 非核心线程空闲存活时间
    TimeUnit unit,
    BlockingQueue<Runnable> workQueue,// 任务队列
    ThreadFactory threadFactory,      // 线程工厂（命名、daemon 设置）
    RejectedExecutionHandler handler  // 拒绝策略
) { ... }
```

## 二、机制层：任务提交的完整流程

这是面试官最爱的流程题（一定要背熟顺序）：

```
提交任务 execute(task)
        │
        ▼
 ┌───────────────────┐
 │ 当前线程数 < core? │──是──▶ 创建核心线程执行
 └───────────────────┘
        │否
        ▼
 ┌───────────────────┐
 │  队列没满？       │──是──▶ 入队等待
 └───────────────────┘
        │否
        ▼
 ┌───────────────────┐
 │ 当前线程数 < max? │──是──▶ 创建非核心线程执行
 └───────────────────┘
        │否
        ▼
    执行拒绝策略
```

**关键认知**：是**先塞队列，再扩容线程**，不是先扩容再排队！这是很多人答错的地方。

源码佐证（`execute` 方法核心逻辑）：
```java
public void execute(Runnable command) {
    int c = ctl.get();
    if (workerCountOf(c) < corePoolSize) {            // ① 核心线程
        if (addWorker(command, true)) return;
        c = ctl.get();
    }
    if (isRunning(c) && workQueue.offer(command)) {   // ② 入队
        // ... 二次检查
    } else if (!addWorker(command, false)) {          // ③ 非核心线程
        reject(command);                              // ④ 拒绝
    }
}
```

## 三、策略层：4 种拒绝策略

| 策略 | 行为 | 适用场景 |
|------|------|---------|
| **AbortPolicy**（默认） | 抛 `RejectedExecutionException` | 默认；上游必须处理异常 |
| **CallerRunsPolicy** | 让提交任务的线程自己执行 | 反压：让上游感受到压力，自然降速 |
| **DiscardPolicy** | 静默丢弃新任务 | 允许丢（如日志） |
| **DiscardOldestPolicy** | 丢弃队列最老的任务再入队 | 只关心最新（如实时行情） |

**风控的选择**：通常用 **CallerRunsPolicy + 自定义降级**。因为风控的请求是同步链路（用户支付），丢任务会导致风险漏判，让调用方自己执行能让上游 RT 上升触发上游超时降级，比直接抛异常更优雅。

## 四、配置层：线程数怎么算

**经典公式（Brian Goetz）**：
```
线程数 = N_cpu × U_cpu × (1 + 等待时间/计算时间)
      = 核心数 × CPU 利用率 × (1 + W/C)
```

- **CPU 密集型**（纯计算，如风控规则匹配的内存计算）：W/C ≈ 0，线程数 ≈ N+1
- **IO 密集型**（查 HBase/Redis/HTTP）：W/C 较大（等待远超计算），线程数可以是 2N~10N

**风控实战配置**（8 核机器）：
```java
// 风控特征查询（IO 密集，查 Redis/HBase 多次）
ThreadPoolExecutor featurePool = new ThreadPoolExecutor(
    64,                                 // core：8核×8（IO 密集）
    128,                                // max：洪峰扩容
    60L, TimeUnit.SECONDS,
    new LinkedBlockingQueue<>(2000),    // 有界队列
    new ThreadFactoryBuilder().setNameFormat("feat-%d").build(),
    new CallerRunsPolicy()              // 反压
);
// 关键：setNameFormat 必须设，否则线程 dump 时全是 pool-1-thread-X 无法排查
```

## 五、坑点层：阿里规约为什么禁用 Executors

| Executors 方法 | 实际问题 |
|----------------|---------|
| `newFixedThreadPool` | 队列 `LinkedBlockingQueue`（无界），任务堆积 OOM |
| `newSingleThreadExecutor` | 同上，无界队列 |
| `newCachedThreadPool` | 最大线程 `Integer.MAX_VALUE`，创建过多线程 OOM |
| `newScheduledThreadPool` | 队列 `DelayedWorkQueue`（无界） |

**正确姿势**：必须 `new ThreadPoolExecutor(...)`，且队列**有界**、最大线程数**有上限**。

## 六、监控层：风控的线程池必须可观测

线程池要在线上"看得见"，关键暴露指标：
```java
// 自定义监控（接 Prometheus）
Gauge.builder("threadpool.active", pool, ThreadPoolExecutor::getActiveCount).register();
Gauge.builder("threadpool.queue.size", pool, p -> p.getQueue().size()).register();
Gauge.builder("threadpool.rejected", pool, p -> rejectedCounter.get()).register();
```

**告警阈值**：
- 队列使用率 > 80% → 告警扩容
- 拒绝次数 > 0/min → 告警（可能下游慢导致堆积）

## 七、底层本质：池化的经济学

线程池本质是**资源租赁市场的做市商**：
- 线程（资本）有创建/销毁成本（折旧）
- 任务（需求）有突发性（潮汐）
- 池（做市商）用"核心常备 + 队列缓冲 + 弹性扩容 + 限制兜底"匹配供需

**为什么是这个四级结构而不是直接一个大池子**：
- 核心线程常驻：覆盖稳态需求，零创建成本
- 队列缓冲：覆盖小波动，廉价（只是入队）
- 临时扩容：覆盖中波动，按需付创建成本
- 拒绝策略：覆盖极端波动，强制降级防崩溃

每一级都是上一级溢出后的"成本递增"选项——这是分层降级、按需付费的工程哲学。

## 常见考点
1. **核心线程能被回收吗？**——能，`allowCoreThreadTimeOut(true)` 后核心线程也按 keepAliveTime 回收。
2. **submit 和 execute 区别？**——execute 无返回值；submit 返回 Future，可拿结果/异常。
3. **线程池怎么传 MDC/TraceId？**——用装饰器模式包 Runnable，在 submit 时把父线程的 MDC copy 进去，run 完清理。

**代码示例**（带 TraceId 的线程池装饰）：
```java
public class TraceIdRunnable implements Runnable {
    private final Runnable delegate;
    private final String traceId;
    public TraceIdRunnable(Runnable r) {
        this.delegate = r;
        this.traceId = MDC.get("traceId");
    }
    public void run() {
        try {
            MDC.put("traceId", traceId);
            delegate.run();
        } finally {
            MDC.clear();
        }
    }
}
// 使用：pool.submit(new TraceIdRunnable(() -> queryFeature(uid)));
```

## 苏格拉底式面试追问

> 这组追问不是背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：风控特征查询线程池你配的是 core=64、max=128、queue=2000，为什么 core 不直接配 128 一步到位？为什么要留一个弹性扩容的中间层？**

不是为了省线程，是为了省"线程切换成本"。core 常驻意味着即使空闲也占栈内存（64 线程 × 1MB = 64MB）+ OS 调度开销。稳态 QPS 下 64 个线程足够（实测 RT < 50ms），洪峰时队列先吸收 2000 个任务的波动（入队成本是纳秒级，远低于创建线程的微秒级），队列满了才扩容到 128——这层弹性只为"突发几十秒"存在，60 秒 keepAlive 后自动收缩。如果 core=128，等于常驻支付洪峰成本。决策依据是看 Prometheus 的 `threadpool.active` 指标稳态分布：长期 P50=40、P95=60，所以 core=64 留余量，max=128 扛洪峰。

### 第二层：证据与定位

**Q：风控决策服务 RT 突然从 50ms 飙到 3 秒，但 CPU 只有 30%，你怎么确认是线程池打满还是下游 HBase 慢？**

两组证据交叉验证：
1. 看线程池指标——Prometheus 拉 `threadpool.queue.size`、`threadpool.active`、`threadpool.rejected`。如果 active=128（顶到 max）、queue.size=2000（顶到队列上限）、rejected 在涨，说明是线程池饱和，不是下游慢。如果 active 才 20、queue 为空，但 RT 还是 3 秒，那是下游慢（线程都在等 HBase 的 get 返回）。
2. 看 jstack 线程状态——`jstack <pid> | grep "feat-" -A1 | grep WAITING | wc -l` 统计 feat 线程的 WAITING 数。如果大量线程卡在 `at java.net.SocketInputStream.socketRead0` 上，是下游网络/DB 慢；如果卡在 `at java.util.concurrent.LinkedBlockingQueue.take`，是线程池在等任务（说明任务不来，是上游限流了）。

### 第三层：根因深挖

**Q：你确认是线程池饱和，active=128、queue 满、rejected 每秒 500 次。但 QPS 没涨，为什么会突然饱和？**

根因不是流量涨，是单任务执行时间变长了。线程池吞吐 = 线程数 / 单任务耗时，线程数没变（128），但单任务耗时从 50ms 涨到 2 秒，理论吞吐从 2560 QPS 掉到 64 QPS。要看是谁拖慢了单任务。用 arthas 的 trace 命令：`trace com.xxx.FeatureService queryFeature '#cost>500'`——找出 queryFeature 内部耗时 >500ms 的子调用。真实案例是 Redis 集群某个分片主从切换，Jedis 的连接池在重连，单次 get 从 1ms 涨到 800ms（带重试），把整个线程池拖垮。

**Q：根因是下游 RT 变长，那为什么不直接扩线程数到 512 应对？**

扩线程数治标不治本，且可能雪崩。线程数到 512，8 核机器的 CPU 上下文切换开销会指数级上升（`vmstat` 的 cs 列从 1 万飙到 20 万），每个线程的实际执行时间反而变短，吞吐不升反降。更糟的是 512 个线程同时打到已经慢的 Redis，相当于放大 4 倍压力，Redis 直接打挂，整个链路雪崩。正确做法是熔断 + 降级：当 Redis get 的 RT > 100ms 时（用 Sentinel 或 Resilience4j 熔断），快速失败走本地缓存的降级值，单任务耗时从 800ms 降到 1ms，线程池立刻恢复。

### 第四层：方案权衡

**Q：你用 CallerRunsPolicy 做反压，但调用方是 Tomcat 的 HTTP 线程，被反压住会导致整个 Web 容器线程耗尽。怎么权衡？**

这是反压的副作用。CallerRuns 让 Tomcat 线程同步执行任务，如果任务 2 秒，Tomcat 线程就占 2 秒，默认 200 个 Tomcat 线程很快耗尽，新请求进不来。权衡方案：自定义拒绝策略，不真的让调用方执行，而是写到另一个"降级缓冲队列"（比如 Redis 或 Disruptor），异步消费，同时返回一个降级结果（用缓存的特征值或默认风险分）。代价是这批请求的特征精度降低，但保住了 Web 容器不挂。风控场景可接受——漏判一笔的风险可以用事后离线复核兜底，但容器挂了所有交易都过不去。

**Q：为什么不用 MQ（Kafka）做异步削峰代替线程池队列？那样反压更彻底。**

因为风控是同步决策链路——用户点支付，等风控返回放行/拦截，整个 RT 必须在 200ms 内。MQ 异步意味着用户那边要长轮询或 SSE 等结果，体验差且链路复杂。线程池队列是"进程内、内存级"的削峰，延迟在毫秒级；MQ 是"跨网络、持久化"的削峰，延迟至少百毫秒。只有非实时场景（如离线特征计算、异步审核）才用 MQ。实时风控决策必须线程池 + 同步返回。

### 第五层：验证与沉淀

**Q：你加了熔断降级后，怎么验证它真的在下游抖动时生效，而不是形同虚设？**

主动故障注入 + 指标观察：
1. 在预发环境用 ChaosBlade 注入 Redis 延迟（`blade create redis delay --time 300 --cmd get`），把 get 延迟打到 300ms。
2. 观察 Prometheus：熔断器状态从 CLOSED 转到 OPEN 的时间（应 < 5 秒）、`threadpool.active` 应该从顶到 128 快速回落到 60 以下（因为任务快速失败）、`feature.fallback.count`（降级计数）应该飙升。
3. 压测同 QPS 下，RT P99 应稳定在 80ms 以下（降级值秒回），而不是跟着 Redis 的 300ms 涨。如果熔断期间 RT 还是涨，说明熔断配置阈值不对或降级路径没走通。

**Q：怎么让团队所有线程池都避免这次踩坑？**

沉淀成机制而非个人经验：
1. 线程池统一收口——禁止业务代码自己 new ThreadPoolExecutor，提供一个 `ThreadPoolFactory` 工具类，强制要求传入监控（自动注册 active/queue/rejected 到 Prometheus），否则创建失败。
2. 配置模板——按业务类型给模板：CPU 密集型（core=N+1, queue=有界 1000）、IO 密集型（core=2N~8N, queue=有界 2000），超出范围需要架构评审。
3. 告警基线——所有线程池的 `rejected/min > 0` 必须告警；`queue.size / queue.capacity > 0.8` 告警扩容或排查下游。
4. 故障复盘——把这次"Redis 抖动 → 单任务 RT 涨 → 线程池饱和 → 呼叫方被反压"的完整链路 + arthas trace 截图 + Prometheus 截图写进知识库，作为"池化资源必须配熔断"的标准案例。


## 结构化回答

**30 秒电梯演讲：** 聊到线程池的工作原理，我的理解是——线程池预先创建线程反复利用，用「核心线程数 + 队列 + 最大线程数 + 拒绝策略」四级兜底，应对流量洪峰。打个比方，线程池像一家餐厅：核心线程是正式员工（来客就服务），队列是等位区（满了就排队），最大线程是临时工（等位也满了才招），拒绝策略是超过最大承载时的处理（换店/排队失败）。

**展开框架：**
1. **7 个核心参数** — corePoolSize、maximumPoolSize、keepAliveTime、workQueue、threadFactory、rejectedHandler、unit
2. **任务提交** — 核心线程 → 队列 → 非核心线程 → 拒绝
3. **4 种拒绝策略** — Abort（抛异常默认）、CallerRuns（调用者执行）、Discard（丢弃）、DiscardOldest（丢最老的）

**收尾：** 这块我在项目里也踩过坑——想深入的话，可以接着聊：线程数怎么设置？您更想看哪个方向？

## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡 | "线程池的工作原理——这道题面试官到底想考什么？我用 30 秒给你讲透。" | 开场钩子 |
| 0:15 | 线程池工作流程图 | 先说核心：线程池预先创建线程反复利用，用「核心线程数 + 队列 + 最大线程数 + 拒绝策略」四级兜底，应对流量洪峰。 | 核心定义 |
| 0:30 | 概念结构示意图 | 核心线程 → 队列 → 非核心线程 → 拒绝。 | 任务提交 |
| 1:30 | 总结卡 | 一句话记忆：提交顺序：核心线程 → 队列 → 非核心线程 → 拒绝（注意是先队列后扩容！）。 下期可以接着聊：线程数怎么设置。 | 收尾总结 |
