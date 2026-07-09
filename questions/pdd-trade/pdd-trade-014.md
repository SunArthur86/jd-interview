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
