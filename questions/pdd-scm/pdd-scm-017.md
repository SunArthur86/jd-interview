---
id: pdd-scm-017
difficulty: L2
category: pdd-scm
subcategory: Java 并发
tags:
- 拼多多
- 供应链
- 线程池
- 池化
- ThreadPoolExecutor
feynman:
  essence: 线程池用"核心线程+队列+非核心线程+拒绝策略"四级兜底应对流量洪峰；阿里规约禁止 Executors，必须 new ThreadPoolExecutor 且队列有界。
  analogy: 线程池像餐厅——正式员工（核心线程）、等位区（队列）、临时工（非核心线程）、超载拒绝（拒绝策略）。
  first_principle: 创建线程成本高（OS 调度+1MB 栈），池化复用；四级水位让流量洪峰优雅降级而非崩溃。
  key_points:
  - 7 参数：core/max/keepAlive/queue/factory/handler/unit
  - 提交顺序：核心 → 队列 → 非核心 → 拒绝（先队列后扩容！）
  - 4 种拒绝：Abort/CallerRuns/Discard/DiscardOldest
  - 禁用 Executors（无界 OOM）
first_principle:
  problem: 高并发下线程创建/销毁成本高，如何复用+削峰+降级？
  axioms:
  - 线程创建有成本
  - 资源有限，过载需降级
  - 排队是最便宜削峰
  rebuild: 核心线程常驻+有界队列+临时扩容+拒绝策略四级水位。
follow_up:
- 线程数怎么设？——CPU 密集 N+1，IO 密集 2N 或 N×(1+等待/计算)
- Executors 为什么禁用？——newFixedThreadPool 队列无界 OOM；newCachedThreadPool 线程数 MAX_VALUE
- 怎么传 TraceId？——装饰 Runnable，submit 时捕获父线程 MDC
memory_points:
- 提交顺序：核心 → 队列 → 非核心 → 拒绝
- 必须有界（队列+线程数）
- 4 种拒绝策略，常用 CallerRuns（反压）
- 线程必须命名（setNameFormat）便于排查
---

# 【拼多多供应链】线程池原理？怎么配置？

> JD 依据："理解并发、高并发系统调优"。

## 一、7 个核心参数

```java
new ThreadPoolExecutor(
    corePoolSize,           // 核心线程数
    maximumPoolSize,        // 最大线程数
    keepAliveTime,          // 非核心空闲存活
    unit,
    workQueue,              // 任务队列（必须有界）
    threadFactory,          // 线程工厂（必须命名）
    rejectedHandler         // 拒绝策略
);
```

## 二、任务提交流程

```
execute(task)
   ↓
当前线程数 < core? → 创建核心线程
   ↓ 否
队列没满? → 入队
   ↓ 否
当前线程数 < max? → 创建非核心线程
   ↓ 否
执行拒绝策略
```

**关键**：先入队再扩容（不是先扩容）！

## 三、4 种拒绝策略

| 策略 | 行为 | 适用 |
|------|------|------|
| AbortPolicy（默认） | 抛异常 | 默认 |
| CallerRunsPolicy | 调用方执行 | 反压（让上游感知压力） |
| DiscardPolicy | 丢弃 | 可丢（日志） |
| DiscardOldestPolicy | 丢最老 | 关心最新 |

## 四、供应链实战配置

```java
ThreadPoolExecutor productPool = new ThreadPoolExecutor(
    64, 128, 60, SECONDS,
    new LinkedBlockingQueue<>(2000),                // 有界！
    new ThreadFactoryBuilder().setNameFormat("product-%d").build(),
    new CallerRunsPolicy()                           // 反压
);
```

**线程数计算**（IO 密集，查 DB/Redis 多）：
```
线程数 ≈ N × (1 + 等待/计算)
8 核机器 IO 密集 → 64 线程
```

## 五、阿里规约禁用 Executors

| Executors 方法 | 坑 |
|----------------|-----|
| newFixedThreadPool | LinkedBlockingQueue 无界 → OOM |
| newCachedThreadPool | 线程数 Integer.MAX_VALUE → OOM |
| newSingleThreadExecutor | 同 Fixed，无界队列 |

必须 new ThreadPoolExecutor + 有界队列 + 有界线程数。

## 六、监控（生产必备）

```java
Gauge.builder("pool.active", pool, ThreadPoolExecutor::getActiveCount).register();
Gauge.builder("pool.queue.size", pool, p -> p.getQueue().size()).register();
// 队列使用率 > 80% 告警扩容
```

## 七、底层本质

池化是"资源租赁市场的做市商"：核心常备覆盖稳态、队列缓冲小波动、临时扩容中波动、拒绝兜底极端波动。每级是上级溢出后的成本递增选项。

## 常见考点
1. **核心线程能回收吗**？——`allowCoreThreadTimeOut(true)` 后可。
2. **submit vs execute**？——execute 无返回值；submit 返回 Future。
3. **怎么传 TraceId**？——装饰 Runnable，submit 时捕获父线程 MDC，run 时设置。
