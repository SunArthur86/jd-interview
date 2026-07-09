---
id: pdd-ai-001
difficulty: L3
category: pdd-ai
subcategory: Java 并发
tags:
- 拼多多
- AI 中台
- Java 并发
- 线程池
- 模型服务
feynman:
  essence: 线程池是"预先建好一批线程复用"，避免请求来了才建线程（建线程贵），是模型服务/中台高并发的标配。
  analogy: 像出租车公司养一批车待命——客人（请求）来了直接派车，不用临时买车（建线程），用完还回车队复用。
  first_principle: 线程创建/销毁成本高（OS 调度 + 内存），高并发下"请求即建"会拖垮系统，必须池化复用。
  key_points:
  - 七参数：corePoolSize/maxPoolSize/queue/keepAlive/threadFactory/rejectHandler
  - 任务流程：核心线程 → 队列 → 非核心线程 → 拒绝策略
  - 四种拒绝策略：AbortPolicy/CallerRunsPolicy/DiscardOldest/Discard
  - 中台实践：模型推理线程池要 CPU/IO 分离、隔离、有界队列
first_principle:
  problem: 高并发下如何复用线程、控制资源、避免雪崩？
  axioms:
  - 线程创建/销毁有 OS 级成本
  - 线程数过多会抢占 CPU/内存，过少会排队
  - 资源必须有限可控
  rebuild: 线程池（预建复用 + 有界队列 + 拒绝策略 + 动态调参）。
follow_up:
  - 线程池怎么设置线程数？——CPU 密集 N+1，IO 密集 2N 或 N*(1+等待/计算)
  - 队列满了怎么办？——拒绝策略（业务关键用 CallerRuns 反压，非关键丢弃）
  - 怎么动态调整参数？——美团的动态线程池（配置中心 + setCorePoolSize 实时生效）
memory_points:
  - 七参数：core/max/queue/keepAlive/factory/reject
  - 流程：核心→队列→非核心→拒绝
  - CPU 密集 N+1，IO 密集 2N
  - 模型服务要隔离（在线/离线分开）
---

# 【拼多多 AI 中台】线程池怎么设计？模型服务场景怎么用？

> JD 依据："Java + 微服务、模型服务、规则中台"。

## 一、线程池七参数与任务流程

```
任务提交
   │
   ▼
核心线程未满？───是──▶ 创建核心线程执行
   │否
   ▼
队列未满？──────是──▶ 入队等待
   │否
   ▼
非核心线程未满？─是──▶ 创建非核心线程执行
   │否
   ▼
执行拒绝策略
```

**JDK 四种拒绝策略**：
- `AbortPolicy`（默认）：抛 `RejectedExecutionException`
- `CallerRunsPolicy`：由提交线程自己跑（反压）
- `DiscardOldestPolicy`：丢最早任务
- `DiscardPolicy`：默默丢

## 二、模型服务场景（拼多多 AI 中台）

**痛点**：LLM 推理单请求耗时长（秒级）、GPU 资源贵、请求突发大。

**池化设计**：
```java
// 在线推理（低延迟，IO 密集：请求 GPU）
ThreadPoolExecutor onlinePool = new ThreadPoolExecutor(
    64, 128,                    // 核 64（=GPU 卡数×batch），max 128
    60, TimeUnit.SECONDS,
    new LinkedBlockingQueue<>(2000),  // 有界队列防 OOM
    new NamedThreadFactory("llm-online"),
    new CallerRunsPolicy()      // 满了反压，不丢请求
);

// 离线任务（吞吐，CPU 密集：后处理/特征）
ThreadPoolExecutor offlinePool = new ThreadPoolExecutor(
    Runtime.getRuntime().availableProcessors() + 1,
    200, 60, TimeUnit.SECONDS,
    new LinkedBlockingQueue<>(500),
    new NamedThreadFactory("llm-offline"),
    new AbortPolicy()
);
```

**关键点**：
1. **在线/离线隔离**：避免离线大任务饿死在线请求。
2. **有界队列**：无界队列（如 `Executors.newFixedThreadPool` 默认 LinkedBlockingQueue 无限）会 OOM。
3. **CPU/IO 分离**：调用 GPU 是 IO 等待，线程数要大；后处理是 CPU，线程数 = N+1。
4. **监控**：队列长度、活跃线程、拒绝次数上报到 Prometheus。

## 三、动态线程池（中台标配）

中台场景流量波动大，靠静态参数扛不住。美团方案：
```java
// 配置中心监听
@NacosConfigListener(dataId = "llm-pool.json")
public void onConfig(PoolConfig cfg) {
    onlinePool.setCorePoolSize(cfg.core);     // 运行时生效
    onlinePool.setMaximumPoolSize(cfg.max);
}
```
配合监控自动扩缩（队列积压 > 阈值 → 加核心线程）。

## 四、避坑：Executors 三个坑

| 方法 | 坑 |
|------|-----|
| `newFixedThreadPool` | 队列无界 → OOM |
| `newSingleThreadExecutor` | 队列无界 → OOM |
| `newCachedThreadPool` | 线程数无界（Integer.MAX）→ 创建过多线程 OOM |

**阿里规约**：禁止用 Executors，必须用 `ThreadPoolExecutor` 显式指定参数。

## 五、底层本质

线程池本质是**"资源有限 + 复用 + 流控"**——预建一批线程复用省去建销成本，用有界队列 + 拒绝策略做背压，是高并发系统的"流量阀门"。模型服务场景下，线程池要和 GPU 调度、批次调度配合，不能孤立设计。

## 常见考点

1. **核心线程能预热吗**？——`prestartAllCoreThreads()` 提前创建，避免冷启动延迟。
2. **线程池怎么传 MDC/TraceId**？——用装饰器（`TaskDecorator`）在 submit 时拷贝上下文。
3. **线程池和 ForkJoin/CompletableFuture 区别**？——线程池适合独立任务；FJ 适合分治任务；CF 是异步编排（底层默认 ForkJoinPool）。
