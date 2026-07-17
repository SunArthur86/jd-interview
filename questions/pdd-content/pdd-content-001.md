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

## 苏格拉底式面试追问

> 这组追问不是背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：评价写入和 Feed 流写入为什么要用两个独立线程池，而不是共用一个大池？共用不是更省资源吗？**

省资源只是表象。共用池的致命问题是"慢任务饿死快任务"——评价写入要走 DB + ES 同步，单条 P99 在 200ms 以上；Feed 写入要做推/拉扩散到粉丝收件箱，是轻量 Redis 操作。共用池时一旦评价写入把核心线程占满，Feed 写入会被堆进队列，最终 Feed 出现在用户主页的延迟从 ms 级涨到秒级。独立池的本质是用"资源隔离"换"故障隔离"，符合拼多多"评价和 Feed 是两条独立业务链路"的诉求。

### 第二层：证据与定位

**Q：线上评价服务 P99 从 80ms 涨到 1.2s，你怎么确认是线程池问题，而不是 DB 慢或网络抖动？**

三路证据交叉验证：
1. 看 Prometheus 上 `review_write_executor_active_threads` 是否长期顶在 `corePoolSize=50`，且 `queue_size` 在 4000+（接近 5000 上限）——线程池打满的典型特征。
2. 看 `review_write_executor_rejected_count` 是否在飙升——CallerRunsPolicy 触发意味着提交线程（Tomcat 工作线程）被拉去干活，反压到上游。
3. 看 DB 侧 `review_insert_p99` 和 `es_bulk_p99` 是否正常——如果 DB/ES 都正常但应用线程池打满，问题在池容量或下游连接数，不是 DB。

### 第三层：根因深挖

**Q：你发现线程池打满了，但 QPS 没涨。根因可能是什么？**

QPS 没涨但池打满，说明单任务执行时间变长了（吞吐 = 并发数 / 单任务耗时）。按这个思路追：
1. `arthas trace ReviewWriteExecutor#submit` 看每步耗时——是 `reviewDao.insert` 变慢（DB 锁等待/索引退化）还是 `esService.bulkIndex` 变慢（ES refresh 间隔被调大或磁盘 IO 打满）。
2. 看评价池用的 HikariCP 连接池 `active_connections` 是否顶在 `maximumPoolSize`——如果是，说明是 DB 连接不够，任务都在等连接。
3. 看是否有大对象——某次评价带 9 张图，图片处理（压缩/审核）卡在 IO，把单个任务从 50ms 拉到 2s。

### 第四层：方案权衡

**Q：评价池队列满了用 CallerRunsPolicy 反压，但 Tomcat 线程被占用会导致整个服务响应变慢。你怎么权衡？**

CallerRunsPolicy 是"用应用自身线程兜底"，确实会反伤 Tomcat。权衡方案分层：
1. 先量化——CallerRuns 触发率（`rejected / submitted`）如果只有 0.1%，影响可忽略；如果到 5%，必须处理。
2. 短期——把评价池 `maximumPoolSize` 从 200 扩到 400，或队列从 5000 扩到 10000，给突发流量缓冲。
3. 中期——评价写入本来就是非核心链路（用户提交后可异步），改用 `DiscardOldest` + Kafka 兜底：丢弃队列最老的任务但写一条 Kafka，下游补偿重试。
4. 根本——评价写入改全异步（用户提交即返回，写 Kafka，消费者落库），彻底解耦 Tomcat 线程。

### 第五层：验证与沉淀

**Q：你把评价池从 core=50 扩到 core=100，怎么证明扩容有效而不是流量自然回落？**

上线前采 1 周基线（`active_threads`、`queue_size`、`rejected_count`、评价提交 P99），上线后采 1 周。关键看两个归一化指标：
1. `queue_size / qps`（单位请求的排队深度）——如果显著下降，说明扩容有效。
2. 评价提交 P99 在相同 QPS 分位下的对比——按 QPS 分桶（如 1000/2000/3000 QPS）对比 P99，消除流量波动。
沉淀：把线程池七参数 + 拒绝数告警阈值（`rejected_count > 100/min` 告警）写入团队 JVM/线程池模板，Code Review 强制检查所有 `ThreadPoolExecutor` 必须命名 + 暴露监控指标。

## 结构化回答

**30 秒电梯演讲：** 高并发下线程创建昂贵且过多线程会拖垮系统，如何复用+限流？简单说就是——线程池用"核心线程+队列+最大线程+拒绝策略"复用线程，避免频繁创建销毁；内容社区评价/Feed 写入用独立池隔离，防止互相拖垮。执行序：核心→队列→最大→拒绝；CallerRuns 反压降速。

**展开框架：**
1. **七参数** — 七参数：core/max/keepAlive/queue/factory/reject
2. **执行序** — 执行序：核心→队列→最大→拒绝
3. **Caller** — CallerRuns 反压降速

**收尾：** 您想继续往深里聊吗——比如「线程数怎么配？」

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：评价/Feed 写入线程池怎么设计与隔离？ | 今天聊「评价/Feed 写入线程池怎么设计与隔离？」。一句话：线程池用"核心线程+队列+最大线程+拒绝策略"复用线程，避免频繁创建销毁；内容社区评价/Feed 写入用独立池隔离 | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：七参数：core/max/keepAlive/queue/factory/reject | 核心概念 |
| 1:04 | 能力/参数拆解表 | 要点是：执行序：核心→队列→最大→拒绝 | 能力拆解 |
| 1:56 | 流程图：输入→处理→输出 | 要点是：CallerRuns 反压降速 | 关键机制 |
| 3:00 | 总结卡 + 下期预告 | 记住这些核心点就够了。下期我们接着聊——线程数怎么配？。 | 收尾 |
