---
id: java-architect-145
difficulty: L4
category: java-architect
subcategory: 限流
title: 自适应限流与负载保护怎么做
tags: [自适应限流, BBR, CPU 负载, Resilience4j, 负载保护]
related: [java-architect-144, java-architect-138, java-architect-147]
---

# 自适应限流与负载保护怎么做

> **场景**：京东大促期间流量峰谷波动剧烈，提前配 QPS 阈值要么过松（系统打挂）要么过紧（容量浪费）。面试官问：能不能让系统根据自身负载自动调节？这就是自适应限流。

## 一、概念层：静态限流的痛点

### 1.1 静态阈值的两难

```
固定阈值 5000 QPS：
- 正常时（CPU 30%）：浪费容量
- GC 抖动时（CPU 90%）：5000 QPS 把系统打挂
- 下游慢时（RT 飙升）：5000 QPS 把连接池耗尽
```

**核心问题**：QPS 不能反映系统的真实承受能力。同样 5000 QPS：
- CPU 30%、RT 20ms → 系统很闲
- CPU 80%、RT 200ms → 系统临界
- 下游 RT 500ms → 已经过载

### 1.2 自适应限流的核心思想

**让限流阈值随系统实时负载动态变化**。系统闲就多放，系统忙就少放，不依赖人工配置。

三个信号指标（取其一或组合）：
- **CPU 利用率**：直接反映计算压力
- **Load（系统负载）**：综合反映 CPU + IO 等待
- **RT（响应时间）**：反映队列堆积

## 二、机制层：BBR 算法与变种

### 2.1 BBR 的本质（来自 TCP 拥塞控制）

Google BBR（Bottleneck Bandwidth and Round-trip propagation time）核心思想：**通过探测系统的"拐点"（load 开始非线性增长的位置），把吞吐维持在拐点附近**。

应用到服务限流：
- 拐点前：吞吐随 QPS 线性增长，RT 平稳
- 拐点后：吞吐饱和，RT 急剧上升（队列堆积）
- **目标：让系统工作在拐点附近，最大化吞吐同时 RT 可控**

### 2.2 算法推导

BBR 公式（来自 Tencent WSGI、阿里 Sentinel）：

```
maxQPS  = 窗口内最大吞吐（滑动窗口统计）
minRT    = 窗口内最小 RT（反映无负载时的延迟）

理论阈值 = maxQPS × minRT / 1000  (每 ms 允许的并发数)
当前并发 = 当前 inflight 请求数

if (当前并发 > 理论阈值 && CPU > 阈值) → 拒绝
```

**关键洞察**：`inflight = QPS × RT`（Little's Law），这是系统的实际负载。当 inflight 超过理论拐点，就该拒绝了。

### 2.3 Java 实现（基于 Resilience4j 思路）

```java
public class BBRLimiter {
    // 滑动窗口统计
    private final SlidingWindow window;
    private final AtomicLong inflight = new AtomicLong(0);
    
    // 配置参数
    private final double cpuThreshold;      // CPU 阈值，如 0.7
    private final double beta;              // 安全系数，如 2.0（保守）
    
    public <T> T execute(Supplier<T> action) {
        if (!tryAcquire()) {
            throw new RateLimitException("OVERLOAD");
        }
        long start = System.nanoTime();
        inflight.incrementAndGet();
        try {
            return action.get();
        } finally {
            inflight.decrementAndGet();
            long rtMs = (System.nanoTime() - start) / 1_000_000;
            window.record(rtMs);
        }
    }

    private boolean tryAcquire() {
        double cpu = getCpuUsage();
        double maxQps = window.maxQps();      // 滑动窗口最大 QPS
        double minRt = window.minRt();        // 滑动窗口最小 RT
        double maxInflight = maxQps * minRt / 1000 / beta;  // 安全阈值
        
        // 双重判断：CPU 高 且 inflight 超阈值才拒绝
        if (cpu > cpuThreshold && inflight.get() > maxInflight) {
            return false;
        }
        return true;
    }

    private double getCpuUsage() {
        // 通过 OperatingSystemMXBean 获取
        OperatingSystemMXBean os = ManagementFactory.getOperatingSystemMXBean();
        if (os instanceof com.sun.management.OperatingSystemMXBean) {
            return ((com.sun.management.OperatingSystemMXBean) os).getProcessCpuLoad();
        }
        return 0;
    }
}
```

### 2.4 滑动窗口实现

```java
public class SlidingWindow {
    private final int windowSize = 60;       // 60 个时间片
    private final long sliceMs = 1000;       // 每片 1s
    private final AtomicReferenceArray<Bucket> buckets = new AtomicReferenceArray<>(windowSize);
    
    public void record(long rtMs) {
        Bucket b = currentBucket();
        b.qps.incrementAndGet();
        b.rtSum.addAndGet(rtMs);
        b.minRt.accumulateAndGet(rtMs, Math::min);
    }
    
    public double maxQps() {
        // 取过去 60s 内 QPS 的 95 分位（剔除极端值）
        return Arrays.stream(buckets.toArray(new Bucket[0]))
            .filter(Objects::nonNull)
            .mapToDouble(b -> b.qps.get())
            .sorted()
            .skip((long)(windowSize * 0.05))
            .limit((long)(windowSize * 0.9))
            .max().orElse(0);
    }
    
    public double minRt() {
        return Arrays.stream(buckets.toArray(new Bucket[0]))
            .filter(Objects::nonNull)
            .mapToLong(b -> b.minRt.get())
            .min().orElse(Long.MAX_VALUE);
    }
}
```

## 三、实战层：JD 大促的负载保护体系

### 3.1 三层自适应体系

```
L1: CPU/Load 自适应（BBR）       — 进程级，毫秒响应
L2: 并发线程数自适应（Semaphore）— 请求级，防线程池打爆
L3: 下游 RT 自适应（Circuit Breaker）— 依赖级，防级联雪崩
```

```java
@Component
@RequiredArgsConstructor
public class AdaptiveGateway {
    private final BBRLimiter bbrLimiter;
    private final Semaphore inflightSemaphore;  // 限制并发
    private final CircuitBreaker downstreamCB;
    
    public Response handle(Request req) {
        // L1: BBR 自适应
        if (!bbrLimiter.tryAcquire()) {
            monitor.recordReject("BBR");
            return Response.overload();
        }
        // L2: 并发控制
        if (!inflightSemaphore.tryAcquire(100, MILLISECONDS)) {
            monitor.recordReject("SEMAPHORE");
            return Response.overload();
        }
        try {
            // L3: 下游熔断
            return downstreamCB.executeSupplier(() -> callDownstream(req));
        } catch (CircuitBreakerOpenException e) {
            return Response.degraded();
        } finally {
            inflightSemaphore.release();
        }
    }
}
```

### 3.2 Sentinel 的自适应限流

阿里 Sentinel 内置自适应算法（`SystemRule`）：

```java
SystemRule rule = new SystemRule();
rule.setHighestCpuUsage(0.8);       // CPU > 80% 触发
rule.setHighestSystemLoad(4.0);     // Load > 4 触发（4 核机器）
rule.setAvgRt(100);                  // 平均 RT > 100ms 触发
rule.setMaxThread(200);              // 并发线程 > 200 触发
rule.setQps(5000);                   // 兜底静态上限

SystemRuleManager.loadRules(Collections.singletonList(rule));
```

Sentinel 的自适应会综合 CPU + Load + RT + 线程数，任一超限触发限流。

### 3.3 GC 抖动期的保护

JVM Full GC 会导致 STW 几百 ms，期间所有请求堆积，GC 完成后瞬间涌入导致雪崩。解法：

```java
public class GCAwareLimiter {
    private volatile long lastGcEnd = 0;
    
    @PostConstruct
    public void init() {
        // 监听 GC 事件
        NotificationEmitter emitter = (NotificationEmitter) 
            ManagementFactory.getGarbageCollectorMXBeans().get(0);
        emitter.addNotificationListener((n, hb) -> {
            if (n.getType().equals(GarbageCollectionNotificationInfo.GARBAGE_COLLECTION_NOTIFICATION)) {
                lastGcEnd = System.currentTimeMillis();
                // GC 后立即收紧限流（保守期 5s）
                conservativeModeUntil = lastGcEnd + 5000;
            }
        }, null);
    }
    
    public boolean tryAcquire() {
        if (System.currentTimeMillis() < conservativeModeUntil) {
            // 保守期：阈值 × 0.5
            return inflight.get() < maxInflight * 0.5;
        }
        return bbrLimiter.tryAcquire();
    }
}
```

### 3.4 关键监控指标

| 指标 | 含义 | 处置 |
|------|------|------|
| `bbr_reject_ratio` | BBR 拒绝率 | > 10% 持续 1min → 扩容 |
| `cpu_usage_p99` | CPU P99 | > 80% 触发自适应 |
| `rt_p99` | RT P99 | 突增 5x → 下游异常 |
| `inflight_count` | inflight 请求数 | 接近 maxInflight → 临界 |
| `gc_pause_ms` | GC 暂停时间 | > 500ms → 优化 JVM |

## 四、底层本质：为什么自适应比静态好

### 4.1 First Principle：系统的"承载力"是动态的

静态阈值假设"系统能力固定"，但实际上：
- 不同时段 GC 频率不同（堆占用变化）
- 下游依赖 RT 在波动（缓存命中率、连接池状态）
- 数据大小不同（同一接口查 10 条 vs 1w 条）
- 部署环境变化（容器邻居吵闹 noisy neighbor）

所以**没有"一个 QPS 阈值适配所有时刻"**。自适应的本质是"用系统真实信号（CPU/RT/inflight）替代人工拍脑袋"。

### 4.2 BBR vs 静态阈值的核心差异

```
静态：    if (qps > 5000) reject
BBR：     if (inflight > maxQps × minRt × beta && cpu > 0.8) reject
```

差异：
- 静态看 QPS（输入），BBR 看 inflight（系统压力）
- 静态固定，BBR 随系统状态滑动
- 静态对突发无感，BBR 通过 minRt 捕捉拐点

### 4.3 Feynman 解释

把系统想象成高速公路。
- 静态限流：每分钟只放 100 辆车，不管路况。
- 自适应限流：监控车速和拥堵——车少就多放，车多堵了就少放。
- BBR 拐点：当车速开始明显下降（RT 上升），说明到承载力极限了，自动收紧。
- GC 抖动：相当于修路临时封道，封道期间彻底停流，开放后慢慢恢复。

## 五、AI 架构师加问

**Q1：BBR 在冷启动时如何工作？**
冷启动阶段 `maxQps` 和 `minRt` 还没采集到，用一个保守的初始值（如 100 QPS），等窗口数据充足（30s）后切换到 BBR 模式。

**Q2：下游 RT 突然从 20ms 飙到 500ms，BBR 会怎样？**
`minRt` 是滑动窗口最小值，仍保持 20ms（不会随坏 RT 上升），所以 `maxInflight` 仍小。但当前 inflight = QPS × 500ms 会剧增，超过 maxInflight → 拒绝。这就是 BBR 对下游变慢的自适应保护。

**Q3：CPU 采集有延迟（OS 反馈慢），怎么办？**
- 用 `OperatingSystemMXBean.getProcessCpuLoad()` 配合滑动平均
- 或采集 Load（1min 平均）+ CPU 实时，综合判断
- JD 实践：CPU + 线程数 + RT 三重信号，任一超限即限流

**Q4：自适应限流会"误杀"正常请求吗？**
会。`beta`（安全系数）越大越保守，越容易误杀但越安全。一般 2.0 起步，根据 SLA 调整。可用 A/B 测试：5% 流量 beta=1.5、95% beta=2.0，观察拒绝率。

**Q5：多机部署时每台自适应独立，总 QPS 不可控怎么办？**
自适应主要用于"自我保护"，不是"全局配额"。全局配额用分布式限流（见 144 题）。两者并存：自适应防雪崩、分布式防超卖/超配额。

## 六、记忆口诀

```
静态阈值两难全，自适应看负载信号。
BBR 找拐点，inflight × minRt × beta。
CPU + RT + 线程数，三信号任一超限。
GC 抖动要保护，保守期降一半阈值。
Sentinel SystemRule，开箱即用最方便。
自适应主自保，分布式管配额，双层并行更稳。
```

## 七、苏格拉底追问

| 层级 | 问题 | 关键答案 |
|------|------|----------|
| L1 表象 | 静态 QPS 阈值有什么问题？ | 不能反映系统真实承载力，GC/下游慢时会被打挂 |
| L2 机制 | BBR 用什么指标？ | inflight（在飞请求数）、maxQps、minRt、CPU |
| L3 边界 | BBR 冷启动怎么办？ | 保守初始值 100 QPS，窗口数据充足后切换 |
| L4 权衡 | 自适应 vs 分布式限流？ | 自适应主自保（进程级），分布式管配额（全局），并存 |
| L5 反例 | BBR 误杀正常请求？ | beta 安全系数调节，A/B 测试找最佳值 |
| L6 极限 | GC 停顿 1s，BBR 还有效吗？ | GC 期间无请求，inflight=0 不触发；GC 后瞬间涌入要保守期 |
| L7 系统 | 容器 noisy neighbor 影响 CPU 采集？ | 用 cgroup-aware 的 CPU 统计，或看 Load（系统级） |

**对话还原**：
> 面试官：你们大促怎么防止过载？
> 我：三层——L1 BBR 自适应（基于 inflight + CPU），L2 信号量控制并发，L3 下游熔断。核心是 BBR：通过 maxQps × minRt × beta 算出安全 inflight 阈值，超了就限。
> 面试官：BBR 冷启动呢？
> 我：前 30s 用保守值 100 QPS，窗口数据齐了再切 BBR。
> 面试官：GC 期间怎么办？
> 我：监听 GC 事件，GC 后 5s 内是保守期，阈值降一半，避免 GC 完成瞬间雪崩。
> 面试官：和分布式限流冲突吗？
> 我：不冲突。自适应是自保（防雪崩），分布式是配额（防超卖）。请求先过分布式配额，再到自适应自保。

## 八、常见考点

1. **静态限流的痛点** —— GC/下游慢时不敏感
2. **BBR 算法核心** —— inflight = maxQps × minRt / beta，必考
3. **三个信号指标** —— CPU、Load、RT
4. **Sentinel SystemRule** —— 开箱即用方案
5. **GC 抖动保护** —— 保守期降阈值
6. **自适应 vs 分布式** —— 自保 vs 配额，并存
7. **冷启动处理** —— 保守值 + 窗口预热
8. **误杀控制** —— beta 系数 + A/B 测试

## 结构化回答

**30 秒电梯演讲：** 京东大促期间流量峰谷波动剧烈，提前配 QPS 阈值要么过松（系统打挂）要么过紧（容量浪费）

**展开框架：**
1. **静态限流的痛点** — 静态限流的痛点 —— GC/下游慢时不敏感
2. **BBR 算法核心** — BBR 算法核心 —— inflight = maxQps × minRt / beta，必考
3. **三个信号指标** — 三个信号指标 —— CPU、Load、RT

**收尾：** 以上是我的整体思路。您想继续深入聊——静态 QPS 阈值有什么问题？


## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：自适应限流与负载保护怎么做 | "这题一句话：京东大促期间流量峰谷波动剧烈，提前配 QPS 阈值要么过松（系统打挂）要么过紧（容量浪费）。" | 开场钩子 |
| 0:15 | 静态限流的痛点示意/对比图 | "静态限流的痛点 —— GC/下游慢时不敏感" | 静态限流的痛点要点 |
| 0:40 | BBR 算法核心示意/对比图 | "BBR 算法核心 —— inflight = maxQps × minRt / beta，必考" | BBR 算法核心要点 |
| 1:05 | 三个信号指标示意/对比图 | "三个信号指标 —— CPU、Load、RT" | 三个信号指标要点 |
| 1:30 | 要点 4 详解 | "这部分看正文对比表和代码示例。" | 要点 4 |
| 1:55 | 总结卡 | "记住：静态限流的痛点。下期见。" | 收尾 |
