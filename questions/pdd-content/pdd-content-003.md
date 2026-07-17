---
id: pdd-content-003
difficulty: L4
category: pdd-content
subcategory: Java 并发
tags:
- 拼多多
- 内容
- Java 并发
- AQS
- 锁
- ReentrantLock
feynman:
  essence: AQS 用"state 变量 + CLH FIFO 双向队列 + CAS"实现同步器框架；ReentrantLock/Semaphore/CountDownLatch 都基于它，是 JUC 的基石。
  analogy: AQS 像银行叫号——state 是柜台状态（忙/闲），CLH 队列是排队人群，CAS 是抢号（没人占就进）。
  first_principle: 多线程争抢共享资源需"原子改状态 + 公平排队"，AQS 用 volatile state + CAS + 双向队列抽象这套。
  key_points:
  - state（volatile int）+ CAS 改状态
  - CLH 队列（双向链表）存等待线程
  - 独占/共享两种模式
  - 模板方法：tryAcquire/tryRelease 由子类实现
first_principle:
  problem: 多线程争抢资源，如何统一抽象"原子改状态+排队"？
  axioms:
  - 资源状态是单一变量
  - 抢占需原子（CAS）
  - 抢不到要公平排队
  rebuild: volatile state + CAS + CLH 队列 + 模板方法（子类实现语义）。
follow_up:
  - ReentrantLock 怎么实现可重入？——state 计数，同线程每次 +1，释放 -1
  - 公平 vs 非公平？——公平先到先得（看队列），非公平直接抢（吞吐高）
  - Semaphore 怎么用 AQS？——state 是许可数，acquire -1 release +1
memory_points:
  - 核心：state + CLH + CAS
  - 独占（ReentrantLock）/共享（Semaphore）
  - 模板方法：tryAcquire 留给子类
  - ReentrantLock 用 state 计数可重入
---

# 【拼多多内容】AQS 原理与内容场景应用？

> JD 依据："IO/多线程/网络"。

## 一、AQS 是什么

AbstractQueuedSynchronizer——JUC 同步器框架。ReentrantLock / Semaphore / CountDownLatch / ReentrantReadWriteLock 都基于它。

## 二、核心三件套

**1. state（volatile int）**
```java
private volatile int state;   // 0=空闲 >0=占用；语义由子类定义
// CAS 修改保证原子
compareAndSetState(0, 1);
```

**2. CLH 队列**（双向链表，存等待线程）
```
head → Node(线程A) ↔ Node(线程B) ↔ Node(线程C) ← tail
        (已获取)      (park 等待)    (park 等待)
```

**3. 模板方法**（子类实现语义）
```java
// AQS 提供（流程已固化）
public final void acquire(int arg) {
    if (!tryAcquire(arg) &&                 // 子类实现
        acquireQueued(addWaiter(Node), arg))
        Thread.currentThread().interrupt();
}

// 子类实现（怎么抢/怎么释放）
protected boolean tryAcquire(int arg) { throw new UnsupportedOperationException(); }
```

## 三、独占模式（ReentrantLock）

```java
// 非公平锁的 tryAcquire
final boolean nonfairTryAcquire(int acquires) {
    Thread current = Thread.currentThread();
    int c = getState();
    if (c == 0) {                           // 空闲
        if (compareAndSetState(0, acquires)) {  // CAS 抢
            setExclusiveOwnerThread(current);
            return true;
        }
    } else if (current == getExclusiveOwnerThread()) {  // 重入
        setState(c + acquires);             // 计数 +1
        return true;
    }
    return false;
}
```

**可重入原理**：state 计数，同线程每次 +1，释放 -1，到 0 才真正释放锁。

## 四、共享模式（Semaphore / CountDownLatch）

```java
// Semaphore.acquire → tryAcquireShared
protected int tryAcquireShared(int acquires) {
    for (;;) {
        int available = getState();         // 许可数
        int remaining = available - acquires;
        if (remaining < 0 || compareAndSetState(available, remaining))
            return remaining;               // <0 排队
    }
}
```

## 五、内容场景应用

**评价提交限流（Semaphore）**：
```java
Semaphore permits = new Semaphore(100);   // 最多 100 并发写
public void submitReview(Review r) {
    if (!permits.tryAcquire(1, SECONDS)) throw new BusyException();
    try {
        reviewService.save(r);
    } finally {
        permits.release();
    }
}
```

**直播开播等待（CountDownLatch）**：
```java
CountDownLatch ready = new CountDownLatch(3);  // 等 3 个依赖服务就绪
// 依赖服务各 ready.countDown()
ready.await(5, SECONDS);   // 主播开播前等所有就绪
```

**评价去重锁（ReentrantReadWriteLock）**：
```java
ReentrantReadWriteLock rwLock = new ReentrantReadWriteLock();
// 读多写少：读读不互斥，读写/写写互斥
rwLock.readLock().lock();   // 读评价列表
rwLock.writeLock().lock();  // 新增评价
```

## 六、公平 vs 非公平

| | 公平锁 | 非公平锁 |
|---|---|---|
| 抢法 | 看队列，先到先得 | 直接 CAS 抢 |
| 优点 | 不饿死 | 吞吐高 |
| 缺点 | 上下文切换多 | 可能饿死 |

默认非公平（吞吐优先）。

## 七、底层本质

AQS 本质是**"把同步语义抽象为 state + 队列 + CAS"**——子类只需定义 tryAcquire/tryRelease 的语义，框架负责排队与阻塞。

## 常见考点
1. **AQS 为什么用双向队列**？——前驱取消时能找前前驱，方便唤醒。
2. **Condition 怎么实现**？——单独等待队列，await 释放锁+park，signal 移到同步队列。
3. **ReentrantLock 和 synchronized 区别**？——前者可中断/可超时/可公平，后者 JVM 原生（升级到重量级锁走 monitor）。

## 苏格拉底式面试追问

> 这组追问不是背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：评价提交限流你用 Semaphore(tryAcquire) 而不是令牌桶或 Sentinel，为什么？Semaphore 的限流粒度和它们有什么不同？**

Semaphore 是"并发数限流"（同时允许 100 个请求在跑），令牌桶/漏桶是"QPS 限流"（每秒允许 N 个请求）。评价提交是重操作（写 DB + ES + 触发审核），单次耗时 100-300ms，瓶颈是"同时占用的资源数"（DB 连接、ES 连接、审核线程）而不是 QPS。用令牌桶限 QPS=1000，但如果每个请求 300ms，瞬时并发会到 300，DB 连接池直接打爆。Semaphore 直接限制"同时在跑的评价写入 = 100"，精准保护下游资源。两者本质区别：QPS 限流不感知请求耗时，并发数限流天然适配耗时差异大的场景。

### 第二层：证据与定位

**Q：评价提交报"服务繁忙"（tryAcquire 返回 false），但 DB 负载很低，你怎么判断 Semaphore 配置是否合理？**

先看 Semaphore 的占用时序。`tryAcquire` 失败说明 100 个许可都被占了，但 DB 负载低说明许可被占着没干活。排查：
1. 看 `Semaphore.getQueueLength()`——如果排队长度持续 >50，说明 acquire 后 release 太慢。
2. `arthas trace ReviewService#submitReview` 看持锁区间耗时——常见根因是 acquire 后包了太多逻辑（如审核同步调用 NLP 服务），把持锁时间从 50ms 拉到 2s，100 个许可只能扛 50 QPS。
3. 看是否有许可泄漏——业务异常但 `finally` 里没 release，许可永远拿不回来，最终所有许可耗尽。

### 第三层：根因深挖

**Q：ReentrantLock 默认是非公平锁，为什么？公平锁不是更"道德"吗？**

公平锁（FairSync）要求"先到先得"——每次 acquire 前先检查 CLH 队列有没有前驱，有就排队。这带来两个代价：1.每次 acquire 要做 `hasQueuedPredecessors()` 检查，多一次 CAS 开销；2.线程切换频繁——新来的线程即使有空闲许可也不能直接拿，必须排队等队头唤醒，而唤醒要走 OS 的 park/unpark，有微秒级开销。非公平锁允许"插队"——新线程直接 CAS 抢，抢不到再排队，刚释放锁的线程大概率能立刻重入（缓存热），减少线程切换。实测非公平锁吞吐比公平锁高 5-10%。代价是非公平锁理论上可能饿死某个线程，但实际业务流量有自然波动，饿死概率极低。内容场景优先吞吐，所以默认非公平。

### 第四层：方案权衡

**Q：评价审核去重你用 ReentrantReadWriteLock，但审核高峰时读评价列表的请求被写锁阻塞，用户刷不出评价列表。你怎么权衡？**

读写锁的痛点是"写锁饥饿"——读锁可并发，但只要有一个写锁在等，后续读锁都要让位（防止写饿死），高峰时写多读也多，读会被阻塞。权衡方案：
1. 短期——读写锁改 StampedLock（JDK 8+），它支持"乐观读"——先乐观读不加锁，读完后校验 stamp 是否被写改变，没变直接用，变了再升级悲观读。90% 场景读不会被写阻塞。
2. 中期——评价列表走 Redis 缓存 + Caffeine 本地缓存，审核写只更新缓存（删 key），不走读写锁。
3. 根本——审核和读列表本就不该共享一把锁，用 CQRS：写走 MySQL 主库 + canal 同步，读走 ES/Redis，读写物理隔离，连锁都不需要。

### 第五层：验证与沉淀

**Q：你把评价限流从 Semaphore(100) 改成基于 Sentinel 的 QPS+并发数双重限流，怎么验证新方案不漏不误？**

两个维度验证：
1. 准确性——压测造 2000 QPS，对比实际通过的评价写入数 vs Sentinel 统计的通过数，误差应 <1%；同时验证限流触发时 Sentinel Dashboard 的拒绝数和日志里的 `BlockException` 数一致。
2. 平滑性——压测 10 分钟，看 DB 连接池 `active` 是否稳定在阈值内（如 <80），评价提交 P99 是否平稳（不出现限流导致的突发抖动）。
沉淀：所有限流（Semaphore/Sentinel）配置接入 Apollo 动态配置，支持运行时调整不重启；Semaphore 使用必须配 `finally release`，Sonar 扫描 `acquire` 后必须紧跟 try-finally，否则 review 不过；CLH 队列长度 >100 告警，提前预警持锁过慢。

## 结构化回答

**30 秒电梯演讲：** 多线程争抢资源，如何统一抽象"原子改状态+排队"？简单说就是——AQS 用"state 变量 + CLH FIFO 双向队列 + CAS"实现同步器框架；ReentrantLock/Semaphore/CountDownLatch 都基于它，…。独占（ReentrantLock）/共享（Semaphore）；模板方法：tryAcquire 留给子类。

**展开框架：**
1. **核心** — 核心：state + CLH + CAS
2. **独占Ree** — 独占（ReentrantLock）/共享（Semaphore）
3. **模板方法** — 模板方法：tryAcquire 留给子类

**收尾：** 您想继续往深里聊吗——比如「ReentrantLock 怎么实现可重入？」

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：AQS 原理与内容场景应用？ | 今天聊「AQS 原理与内容场景应用？」。一句话：AQS 用"state 变量 + CLH FIFO 双向队列 + CAS"实现同步器框架；ReentrantLock/… | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：核心：state + CLH + CAS | 核心概念 |
| 0:51 | 能力/参数拆解表 | 要点是：独占（ReentrantLock）/共享（Semaphore） | 能力拆解 |
| 1:30 | 流程图：输入→处理→输出 | 要点是：模板方法：tryAcquire 留给子类 | 关键机制 |
| 2:09 | 代码片段 + 注释高亮 | 要点是：ReentrantLock 用 state 计数可重入 | 实战要点 |
| 3:00 | 总结卡 + 下期预告 | 记住这些核心点就够了。下期我们接着聊——ReentrantLock 怎么实现可重入？。 | 收尾 |
