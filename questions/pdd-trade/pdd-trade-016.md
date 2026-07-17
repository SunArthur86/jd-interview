---
id: pdd-trade-016
difficulty: L3
category: pdd-trade
subcategory: Java 并发
tags:
- 拼多多
- 交易
- AQS
- ReentrantLock
- CAS
feynman:
  essence: AQS 用 volatile state + CLH 变种双向队列实现独占/共享同步，是 ReentrantLock/Semaphore/CountDownLatch 的公共基类。
  analogy: AQS 像医院叫号——state 是"叫到几号"，队列是排队患者；独占锁（取号机 1 台）一人用，共享锁（N 台）N 人用。
  first_principle: 用一个变量+一个队列统一表达所有同步语义。
  key_points:
  - state（volatile）+ CLH 变种双向队列
  - 独占（ReentrantLock）/共享（Semaphore）
  - 公平（先排队）/非公平（先抢再排）
  - park/unpark 阻塞唤醒
first_principle:
  problem: 如何用一个框架统一表达锁/信号量/闭锁？
  axioms:
  - 资源可用性用 state 表达
  - 等待需 FIFO
  rebuild: state + 队列 + 模板方法（子类实现 tryAcquire/tryRelease）。
follow_up:
- AQS 为什么双向队列？——取消找前驱、唤醒找后继
- 可重入怎么实现？——state 自增+记录 owner
- park 比 wait/notify 优势？——unpark 可先于 park（不丢信号）
memory_points:
- AQS = volatile state + CLH 变种双向队列
- 独占（ReentrantLock）/共享（Semaphore/CountDownLatch）
- 公平先排后抢，非公平先抢后排
- park/unpark 比 wait/notify 优（unpark 可先发）
---

# 【拼多多交易】AQS 原理？ReentrantLock 的公平/非公平？

> JD 依据："理解并发"。

## 一、AQS 核心

```java
volatile int state;       // 同步状态
Node head, tail;          // CLH 变种双向队列
```

- state 语义由子类定（ReentrantLock: 重入次数；Semaphore: 许可数）
- 队列存等待线程

## 二、非公平锁获取

```java
final boolean nonfairTryAcquire(int acquires) {
    int c = getState();
    if (c == 0) {
        if (compareAndSetState(0, acquires)) { setExclusiveOwnerThread(current); return true; }
    } else if (current == getExclusiveOwnerThread()) { setState(c + acquires); return true; }  // 可重入
    return false;
}
```

## 三、公平锁区别

多 `hasQueuedPredecessors()`（队列有前驱则不抢）。

## 四、交易应用

```java
ReentrantReadWriteLock rwl = new ReentrantReadWriteLock();
// 商品查询（读共享）
rwl.readLock().lock(); try { return query(); } finally { rwl.readLock().unlock(); }
// 规则重载（写独占）
rwl.writeLock().lock(); try { reload(); } finally { rwl.writeLock().unlock(); }
```

## 五、底层本质

AQS 是"模板方法+同步队列"——骨架（入队/阻塞/唤醒）复用，子类定语义。锁粒度+CAS 自旋+park 混合应对不同竞争。

## 常见考点
1. **CLH 为什么变种双向**？——取消节点找前驱接续、唤醒找后继。
2. **公平一定不饿死吗**？——理论 FIFO 不饿死，但 tryAcquire 仍 CAS 可能被刚 unlock 线程抢一次。
3. **Condition 实现**？——每个 Condition 独立等待队列，await 把节点从同步队列传到等待队列。

## 苏格拉底式面试追问

> 这组追问不背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：ReentrantLock 默认是非公平锁，为什么默认非公平？公平锁听起来更"正义"，为什么不默认公平？**

非公平锁的吞吐更高。公平锁要求"先到先得"，每次 acquire 前检查 `hasQueuedPredecessors()`（队列有人等就不能抢），这意味着线程释放锁后要唤醒队列首部线程，涉及上下文切换（park/unpark），而唤醒期间锁空闲。非公平锁允许"新来的线程直接 CAS 抢锁"，如果抢到了就省去一次队列唤醒，减少上下文切换。代价是"可能饿死某个线程"（一直被新来的抢），但在通用业务场景，线程到达是随机的，饿死概率低，而吞吐提升明显（实测非公平比公平高 10%-30%）。默认非公平是"吞吐优先"，公平只在"必须严格 FIFO"（如资源配额）时显式指定。

### 第二层：证据与定位

**Q：交易服务有个接口用 ReentrantLock 保护下单逻辑，线上偶发"下单卡住不返回"，你怎么定位是锁死锁，还是业务逻辑慢？**

按锁的持有情况排查。三步：
1. `jstack <pid>` 抓栈——找卡住的线程，看它的栈是否在 `AbstractQueensSynchronizer.acquire` 或 `park`。如果是，看它等的是哪把锁（栈会显示 `waiting to lock <0x...>`），再找"谁持有这把锁"（jstack 会标 `locked <0x...>` 的线程）。
2. 看持锁线程在干嘛——如果持锁线程在执行正常业务（栈在业务方法里），是业务慢（如下单逻辑里调了慢 RPC），优化业务或加超时。如果持锁线程也卡住（如在等另一把锁），是死锁，jstack 会直接提示 `Found Java-level deadlock`。
3. 如果不是死锁但锁持有时间长——看持锁线程是否在做"不该在锁内做的事"，如锁内调远程 RPC（应该锁内只做内存操作，RPC 挪到锁外）、或锁内做了大循环。本质是减小锁粒度（临界区）。

### 第三层：根因深挖

**Q：你 jstack 发现是死锁——线程 A 持锁 1 等锁 2，线程 B 持锁 2 等锁 1，根因是什么？光是把某把锁去掉就行吗？**

去掉锁可能导致竞态。根因是"锁顺序不一致"——两个代码路径以不同顺序获取多把锁。治本：
1. 全局锁顺序约定——所有需要获取多把锁的代码，必须按全局统一的顺序（如按锁的 id/hash 升序）获取。这样任何线程获取锁的顺序一致，不会成环。
2. 用 `tryLock(timeout)` 替代 `lock()`——获取不到就超时回退，不死等。ReentrantLock 支持 `tryLock(3, SECONDS)`，配合失败重试，避免死锁。
3. 减少锁的嵌套——能用一把大锁就别用两把小锁嵌套（虽然大锁粒度粗性能差，但不会死锁）。或者用更高层的抽象（如 `CompletableFuture` 编排，避免显式多锁）。根因是"多锁无序获取"，治本是"有序或避免嵌套"。

**Q：那为什么不直接用 synchronized（JVM 内置锁），它不是自带死锁检测吗？**

synchronized 没有"死锁检测"，它一样会死锁（两个 synchronized 块嵌套）。synchronized 的优势是"简单 + JVM 优化好"（偏向锁/轻量级锁/重量级锁自适应），但它的劣势是：不可中断（死锁了无法中断，只能重启）、不可超时（`synchronized` 没有 timeout 概念）、不可非公平/公平选择。ReentrantLock 的优势是 `tryLock(timeout)` 能"尝试获取+超时"，死锁时能优雅退出而非死等。拼多多交易这种高并发场景，用 ReentrantLock 的 `tryLock` 是防死锁的关键能力。如果场景简单（单锁、无嵌套），synchronized 够用且更轻；复杂场景（多锁、需超时、需公平）用 ReentrantLock。不是谁替代谁，是看需求。

### 第四层：方案权衡

**Q：你用 ReentrantReadWriteLock 保护"商品查询（读）+规则重载（写）"，但写锁饥饿（读多写少时写锁等很久），你怎么权衡？**

读写锁的经典问题：读多写少时，读锁频繁释放又立即被其他读线程获取，写锁（要等所有读释放）可能长期等不到。权衡方案：
1. 公平读写锁——`new ReentrantReadWriteLock(true)` 公平模式，写锁按 FIFO 排队，不会饿死。代价是吞吐下降（每次读也要看队列）。
2. 读多写少的场景用"写时复制"——如 `CopyOnWriteArrayList`，读完全无锁，写时复制新数组。适合"读远多于写且写可忍受复制开销"。
3. 或用 `StampedLock`——JDK 8 引入，支持"乐观读"（先乐观读不加锁，读完检查是否被写改，改了再升级悲观读），读性能比 ReentrantReadWriteLock 高。代价是 API 复杂、不支持重入。规则热加载（读极多写极少）用 StampedLock 更合适。权衡是"读写锁通用但可能饿写 / StampedLock 高性能但复杂"，按读写比和性能要求选。

**Q：为什么不用一个 ReentrantLock 保护读写都行，简单直接？**

单个 ReentrantLock 会让"读读互斥"——多个查询商品请求串行化，并发度大降。读写锁的意义就是"读读共享、读写/写写互斥"，读多场景吞吐提升明显（N 个读线程并发 vs 串行）。拼多多商品查询 QPS 几十万，如果用 ReentrantLock 串行化，P99 飙到秒级。读写锁把"读读"放开，只锁"读写"和"写写"，是读多场景的标准解。只有"读写都少"或"读写都频繁且写占比高"时，读写锁的优势消失（写多时退化），这时普通锁或 StampedLock 更合适。选锁要看读写比例和并发要求。

### 第五层：验证与沉淀

**Q：你怎么验证锁逻辑没有死锁和竞态？这种并发 bug 平时测不出来。**

并发 bug 要靠专门的方法发现：
1. 并发压力测试——用 JCStress 或 CountDownLatch 让多线程同时到达临界区，重复百万次，断言"共享状态正确"（如计数器最终值 = 预期、无数据丢失）。`pdd_trade_counter_race` 这种测试能抓出"忘了加锁"的竞态。
2. 死锁检测——开 `ThreadMXBean.findDeadlockedThreads()` 定期检测，或用 APM 工具（Arthas 的 `thread -b` 找阻塞源头）。压测时故意制造"多线程争抢同一资源"，看是否死锁。
3. Code Review 锁规范——review 检查"锁是否配对（lock/ununlock 在 finally）""多锁是否有序""锁内是否有长操作（RPC/IO）"。工具如 SpotBugs/FindBugs 能检测"锁未释放""锁顺序"等模式。

**Q：AQS 是 JUC 的基石，但业务侧用对锁很难，怎么沉淀团队规范？**

靠"优先用高层工具"的规范：
1. 优先用 JUC 高层工具——能用 `ConcurrentHashMap` 就别自己加锁保护 HashMap；能用 `AtomicInteger` 就别用 `synchronized` 保护 int；能用 `CountDownLatch/CyclicBarrier` 就别自己 wait/notify。高层工具内部正确用 AQS，业务侧不易错。
2. 锁的规范——必须 `try { lock(); ... } finally { unlock(); }`（防忘释放）、锁命名（便于 jstack 排查）、锁内禁止 RPC/IO（减小临界区）。CI 用 Checkstyle 检查 `lock()` 后必须有 `finally unlock()`。
3. 显式锁的最后手段——只在"JUC 高层工具满足不了"（如自定义同步器、复杂条件等待）时才用 ReentrantLock/AQS。大多数业务场景，ConcurrentHashMap + Atomic + BlockingQueue 足够，不需要裸用锁。

## 结构化回答

**30 秒电梯演讲：** 如何用一个框架统一表达锁/信号量/闭锁？简单说就是——AQS 用 volatile state + CLH 变种双向队列实现独占/共享同步，是 ReentrantLock/Semaphore/CountDownLatch 的公共基类。

**展开框架：**
1. **state** — state（volatile）+ CLH 变种双向队列
2. **独占Ree** — 独占（ReentrantLock）/共享（Semaphore）
3. **公平先排队** — 公平（先排队）/非公平（先抢再排）

**收尾：** 您看这块要不要再展开聊聊？

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：AQS 原理？ReentrantLock 的公平/非公平？ | 今天聊「AQS 原理？ReentrantLock 的公平/非公平？」。一句话：AQS 用 volatile state + CLH 变种双向队列实现独占/共享同步，是 ReentrantLock/… | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：state（volatile）+ CLH 变种双向队列 | 核心概念 |
| 1:04 | 能力/参数拆解表 | 要点是：独占（ReentrantLock）/共享（Semaphore） | 能力拆解 |
| 1:56 | 流程图：输入→处理→输出 | 要点是：公平（先排队）/非公平（先抢再排） | 关键机制 |
| 3:00 | 总结卡 + 下期预告 | 记住核心要点就够了。下期见。 | 收尾 |
