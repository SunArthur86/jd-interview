---
id: pdd-content-001
difficulty: L3
category: pdd-content
subcategory: Java 并发
tags:
- 拼多多
- 内容
- Java 并发
- 线程池
- 评价
feynman:
  essence: 线程池用"核心线程+队列+最大线程+拒绝策略"复用线程，避免频繁创建销毁；内容社区评价/Feed 写入用独立池隔离，防止互相拖垮。
  analogy: 线程池像餐厅服务员——常驻几个（核心）、忙了排队（队列）、爆了临时加人（最大线程）、再爆就拒客（拒绝策略）。
  first_principle: 线程创建/销毁昂贵，且线程数过多会导致上下文切换，必须复用+限流。
  key_points:
  - 七参数：corePoolSize/maximumPoolSize/keepAliveTime/workQueue/threadFactory/rejectPolicy
  - 执行顺序：核心→队列→最大→拒绝
  - 拒绝策略：Abort/CallerRuns/Discard/DiscardOldest
  - 业务隔离：评价池/Feed 池/直播池分开
first_principle:
  problem: 高并发下线程创建昂贵且过多线程会拖垮系统，如何复用+限流？
  axioms:
  - 线程创建/销毁有开销
  - 线程数过多上下文切换严重
  - 不同业务隔离防止互相拖累
  rebuild: 线程池复用 + 队列削峰 + 拒绝策略兜底 + 业务隔离。
follow_up:
  - 线程数怎么配？——CPU 密集 N+1，IO 密集 2N（N=CPU 核），结合压测
  - 队列满了怎么办？——CallerRuns 反压上游降速；或降级丢部分非核心任务
  - 线程池怎么监控？——暴露活跃/队列/拒绝数到 Prometheus + 报警
memory_points:
  - 七参数：core/max/keepAlive/queue/factory/reject
  - 执行序：核心→队列→最大→拒绝
  - CallerRuns 反压降速
  - 评价/Feed 池隔离
---

# 【拼多多内容】评价/Feed 写入线程池怎么设计与隔离？

> JD 依据："IO/多线程/网络"、"高并发大流量"。

## 一、为什么用线程池

```
无池：每请求 new Thread → 创建/销毁开销 + 无限增线程 → OOM/上下文切换
有池：复用线程 + 限流（队列+拒绝）+ 可监控
```

## 二、七个核心参数

```java
new ThreadPoolExecutor(
    20,                                  // corePoolSize 核心线程
    100,                                 // maximumPoolSize 最大线程
    60, TimeUnit.SECONDS,                // keepAliveTime 空闲回收
    new LinkedBlockingQueue<>(2000),     // workQueue 任务队列
    new ThreadFactoryBuilder()
        .setNameFormat("review-write-%d").build(),   // 命名便于排查
    new ThreadPoolExecutor.CallerRunsPolicy()         // 拒绝策略
);
```

**执行顺序**（关键）：核心线程满 → 进队列 → 队列满 → 扩到最大线程 → 还满 → 触发拒绝策略。

## 三、四种拒绝策略

| 策略 | 行为 | 适用 |
|------|------|------|
| AbortPolicy | 抛 RejectedExecutionException | 默认，重要任务 |
| CallerRunsPolicy | 让提交者自己跑（反压） | 削峰，降上游速 |
| DiscardPolicy | 静默丢弃 | 可丢的非核心 |
| DiscardOldest | 丢最老的 | 只关心最新 |

## 四、内容社区业务隔离（拼多多特色）

```java
// 评价写入池（持久化到 DB/ES）
@Bean("reviewWriteExecutor")
public ThreadPoolExecutor reviewWrite() {
    return new ThreadPoolExecutor(50, 200, 60, SECONDS,
        new LinkedBlockingQueue<>(5000),
        new ThreadFactoryBuilder().setNameFormat("review-write-%d").build(),
        new ThreadPoolExecutor.CallerRunsPolicy());
}

// Feed 流写入池（推/拉模式扩散）
@Bean("feedWriteExecutor")
public ThreadPoolExecutor feedWrite() {
    return new ThreadPoolExecutor(100, 500, 60, SECONDS,
        new LinkedBlockingQueue<>(10000), ...);
}

// 直播弹幕池（要求低延迟，队列短）
@Bean("danmakuExecutor")
public ThreadPoolExecutor danmaku() {
    return new ThreadPoolExecutor(200, 500, 30, SECONDS,
        new ArrayBlockingQueue<>(500), ...);  // 队列短，丢弃快的
}
```

**隔离原因**：评价写入慢（DB+ES）若和直播弹幕共用池，慢任务会把池占满，弹幕被饿死。

## 五、监控

```java
// 暴露指标到 Prometheus
executor.getActiveCount();
executor.getQueue().size();
executor.getRejectedExecutionCount();  // 拒绝数飙升→告警
```

## 六、底层本质

线程池本质是**"用队列换稳定 + 用拒绝换可控 + 用隔离换互不影响"**——把无限流量的请求规整为有限线程的可控执行。

## 常见考点
1. **线程池大小怎么定**？——CPU 密集 `N+1`，IO 密集 `2N`，最终靠压测调。
2. **为什么用 CallerRuns**？——反压上游降速，比直接拒绝更稳。
3. **怎么动态调参数**？——`executor.setCorePoolSize(n)` 运行时调（美团 DynamicTp 框架）。
