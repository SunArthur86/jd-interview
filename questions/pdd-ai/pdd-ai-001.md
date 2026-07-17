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

## 苏格拉底式面试追问

> 这组追问不背答案，模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：你们 AI 中台的在线推理线程池为什么把核心线程数设到 64 而不是按 CPU 核数 N+1 来配？这样配不怕线程过多抢 CPU 吗？**

因为在线推理的线程主要在做"等 GPU"——请求通过 gRPC 打给 Triton/vLLM，线程 99% 时间阻塞在 `Future.get()` 上，真正占 CPU 的计算极少。这是典型的 IO 密集场景，按 N+1 配（比如 32 核机器给 33 线程）会让 GPU 大量时间闲置在"没有请求可拼 batch"。64 是按 GPU 卡数 × 每卡期望并发 batch 算的：8 卡 × 8 并发 = 64，保证 vLLM 的 Continuous Batching 队列始终有请求可攒。CPU 抢占不严重，因为线程都在 park，`pool_active_ratio` 实测只有 15% 左右。

### 第二层：证据与定位

**Q：你说线程都在等 GPU，怎么证明不是 CPU 成了瓶颈？线上 P99 飙到 2 秒，你怎么排除线程池的问题？**

看三组指标交叉验证。第一，`jstack <pid> | grep -A1 "llm-online" | awk '{print $1}' | sort | uniq -c`——看线程状态分布，如果 80% 以上是 WAITING/TIMED_WAITING（park 在 `Future.get` 上），说明不是 CPU 跑满了，是在等下游。第二，看 `pool_active_ratio`（活跃线程/最大线程）和 `queue_wait_ms_p99`（任务从入队到开始执行的 P99 等待），如果 active_ratio 才 20% 但 queue_wait_ms_p99 已经 800ms，说明不是线程不够，是下游 GPU 慢导致线程被占用。第三，看 `rejected_tasks` 计数，如果没触发拒绝策略（CallerRunsPolicy），说明队列没满，瓶颈不在线程池容量，要往下查 Triton 那边的 `inference_queue_size` 和 `batch_latency_p99`。

### 第三层：根因深挖

**Q：假设你定位到是 `queue_wait_ms_p99` 持续 500ms，但 GPU 利用率才 40%，队列却堆了 1800 个任务。这是什么原因？不是 GPU 不够忙吗？**

这是典型的"GPU 在等 batch 攒够"和"线程池在等 GPU 返回"的双向等待。vLLM 的 Continuous Batching 有个 `max_num_batched_tokens`（比如 8192）和 `max_num_seqs`（比如 256），当队列里都是长 prompt 请求（比如 4000 token），一个请求就快占满一个 batch 的 token 预算，导致 vLLM 一次只能处理 2 个请求，剩下 1800 个在队列里等。GPU 利用率 40% 是因为 batch 没攒满（算力没吃满），不是 GPU 空闲。根因是请求长度分布不均——长 prompt 把 batch 槽位撑爆了。

**Q：那为什么不直接把线程池核心数从 64 调到 256？队列里任务多，加线程不就能更快消化？**

加线程没用，因为瓶颈不在"线程数不够"，而在"下游 batch 容量不够"。线程加到 256 只会让更多线程同时 park 在 vLLM 的 gRPC 调用上，vLLM 那边的队列只会更长，`queue_wait_ms_p99` 反而上升（队列先进先出，排得更长）。治本是在 vLLM 侧调 `max_num_batched_tokens`（8192→16384）或开启 Chunked Prefill（把长 prompt 切块和 Decode 交错），让 GPU 能同时处理更多请求。线程池这边反而该减——长 prompt 场景下线程数 64 够了，多了是浪费。

### 第四层：方案权衡

**Q：你把 max_num_batched_tokens 调到 16384，GPU 利用率上去了，但 TTFT（首 token 延迟）从 500ms 飙到 1.5 秒。业务说客服场景首 token 必须快，你怎么权衡？**

这是吞吐和延迟的经典权衡。`max_num_batched_tokens` 调大让更多请求拼 batch，吞吐上去了，但每个请求要等 batch 攒满才开算，TTFT 就升了。解法是分层：第一，按请求类型分池——客服对话（短 prompt、要快）走 `online-fast` 池，配小 batch（4096）+ 高优先级；长文档摘要（长 prompt、可慢）走 `offline` 池，配大 batch（16384）+ 低优先级。第二，在 vLLM 侧用优先级队列（vLLM 0.6+ 支持），客服请求优先调度。第三，对客服请求开 Prefix Caching（system prompt 固定，KV 命中后 TTFT 能降到 200ms 以内）。

**Q：为什么不直接给客服场景独占 GPU 集群？资源隔离不是更彻底吗？**

独占集群是过度隔离。客服 QPS 白天高夜里低，独占意味着夜里 GPU 利用率 5%，而 GPU 是按小时计费的（H100 30+/小时），成本扛不住。分池 + 优先级队列能在同一集群内实现"软隔离"——客服请求优先调度，长任务填空，整体 GPU 利用率 80%+。只有当客服 SLO 被长任务反复挤兑且调参无效时，才考虑物理隔离（比如客服独占 2 台 H100 机器，其余共享）。

### 第五层：验证与沉淀

**Q：你怎么证明这次线程池 + vLLM 参数调整真的有效，而不是大促前流量本来就低？**

上线前采 1 周基线：`queue_wait_ms_p99`、`rejected_tasks`、`model_latency_p95`、`ttft_p95`、GPU 利用率，按小时分桶存。上线后同样采 1 周。做两个对比：第一，时间对比——取上线前后同一时段（比如工作日 10-12 点高峰）的指标对比，消除昼夜波动。第二，流量归一化——把 `queue_wait_ms_p99` 除以 QPS（wait/QPS），如果上线后 wait/QPS 显著下降且 GPU 利用率上升，证明是参数效果不是流量因素。第三，A/B 实验——网关按 uid 哈希分 50% 走新参数、50% 走旧参数，同时段对比，最严谨。

**Q：怎么让团队以后不踩同样的坑？**

沉淀三件事。第一，线程池配置进配置中心（Nacos），core/max/queue 容量可热更新，不用发版；每次变更记录 before/after 指标到 wiki。第二，加监控告警——`queue_wait_ms_p99 > 1000ms` 持续 3 分钟告警，`rejected_tasks/min > 0` 告警，`pool_active_ratio > 80%` 告警（说明线程不够或下游慢）。第三，把"线程池参数要和 vLLM 的 batch 参数联动调"写进团队的 LLM 上线 checklist——单独调线程池不看下游 batch 容量是常见误区。

## 结构化回答

**30 秒电梯演讲：** 高并发下如何复用线程、控制资源、避免雪崩？简单说就是——线程池是"预先建好一批线程复用"，避免请求来了才建线程（建线程贵），是模型服务/中台高并发的标配。流程：核心→队列→非核心→拒绝；CPU 密集 N+1，IO 密集 2N。

**展开框架：**
1. **七参数** — 七参数：core/max/queue/keepAlive/factory/reject
2. **流程** — 流程：核心→队列→非核心→拒绝
3. **CPU 密集 N+1** — CPU 密集 N+1，IO 密集 2N

**收尾：** 您想继续往深里聊吗——比如「线程池怎么设置线程数？」

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：线程池怎么设计？模型服务场景怎么用？ | 今天聊「线程池怎么设计？模型服务场景怎么用？」。一句话：线程池是"预先建好一批线程复用"，避免请求来了才建线程（建线程贵），是模型服务/中台高并发的标配。 | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：七参数：core/max/queue/keepAlive/factory/reject | 核心概念 |
| 1:04 | 流程图：箭头串联各环节 | 要点是：流程：核心→队列→非核心→拒绝 | 能力拆解 |
| 1:56 | 流程图：输入→处理→输出 | 要点是：CPU 密集 N+1，IO 密集 2N | 关键机制 |
| 3:00 | 总结卡 + 下期预告 | 记住这些核心点就够了。下期我们接着聊——线程池怎么设置线程数？。 | 收尾 |
