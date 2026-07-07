---
id: ant-risk-003
difficulty: L2
category: jd-core
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
