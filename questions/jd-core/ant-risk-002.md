---
id: ant-risk-002
difficulty: L3
category: jd-core
subcategory: Java 并发
tags:
- 蚂蚁
- 风控
- 并发
- AQS
- ReentrantLock
- CAS
feynman:
  essence: AQS 用一个 volatile int state + CLH 变种 FIFO 双向队列实现"独占/共享"两种同步语义，所有 JUC 锁都基于它。
  analogy: AQS 像医院的叫号系统：state 是"现在叫到几号"，等待队列是排队的患者名单。独占锁（取号机只有一台）同时只有一个人能用，共享锁（取号机有 N 台）可以让 N 个人同时用。
  first_principle: 如何在多线程下用"一个变量 + 一个队列"统一表达所有同步语义？state 表示资源状态，队列表示等待顺序，CAS 保证 state 修改原子。
  key_points:
  - state（volatile int）+ CLH 变种双向队列 = AQS 两件套
  - 独占模式（ReentrantLock）vs 共享模式（Semaphore/CountDownLatch）
  - 公平锁：先 check 队列是否有前驱，有则入队
  - 非公平锁：先 CAS 抢一次，抢不到再入队（吞吐高，默认）
  - LockSupport.park/unpark 实现线程阻塞与唤醒
first_principle:
  problem: 如何用一个统一框架表达锁、信号量、闭锁、栅栏等所有同步器？
  axioms:
  - 同步的本质是"资源争用"——同一时刻有限个线程能访问
  - 资源可用性可以用一个整数 state 表达
  - 等待线程需要 FIFO 排队避免饥饿
  rebuild: 抽象出 state 字段 + 等待队列 = AbstractQueuedSynchronizer。子类只需重写 tryAcquire/tryRelease（独占）或 tryAcquireShared/tryReleaseShared（共享），即可复用整个排队、阻塞、唤醒机制。
follow_up:
- AQS 的公平锁和非公平锁性能差多少？——非公平锁吞吐高约 20%-40%，因为减少了线程切换
- 为什么 AQS 用 CLH 队列而不用普通队列？——CLH 的前驱节点 cancel 时能快速跳过，且 park/unpark 基于"前驱状态"判断，避免惊群
- ReentrantLock 可重入如何实现？——state 自增，记录 exclusiveOwnerThread，释放时 state 递减到 0
memory_points:
- AQS = volatile state + CLH 变种双向队列 + CAS
- 模板方法模式：AQS 定义骨架（入队/阻塞/唤醒），子类实现 tryAcquire/tryRelease
- 公平锁先排队后抢，非公平锁先抢后排（吞吐换公平）
- park/unpark 比 wait/notify 优势：unpark 可以在 park 之前调用，不丢信号
---

# 【蚂蚁风控】AQS 原理？ReentrantLock 的公平锁和非公平锁是怎么实现的？风控系统里怎么用？

> JD 依据："攻克各种高并发技术难关"。风控的规则引擎、特征服务都是高并发场景，JUC 锁是必考。

## 一、表面层：AQS 是什么

AQS（AbstractQueuedSynchronizer）是 JUC（java.util.concurrent）的核心基类，Doug Lea 设计。`ReentrantLock`、`Semaphore`、`CountDownLatch`、`ReentrantReadWriteLock`、`ThreadPoolExecutor` 的 Worker 都基于它。

它的两个核心字段：
```java
public abstract class AbstractQueuedSynchronizer {
    private volatile int state;              // 同步状态（语义由子类定义）
    private transient volatile Node head;    // CLH 队列头
    private transient volatile Node tail;    // CLH 队列尾
}
```

- **state**：`volatile int`，由子类定义语义
  - `ReentrantLock`：0 = 未锁，>0 = 锁住且可重入次数
  - `Semaphore`：剩余许可数
  - `CountDownLatch`：剩余计数
- **CLH 队列**：一个 FIFO 双向链表，存放等待获取锁的线程封装（Node）

## 二、机制层：CLH 队列入队与阻塞

CLH（Craig, Landin, Hagersten）队列的工作流程：

```
线程1 持有锁     线程2 等待     线程3 等待
   │              │              │
   ▼              ▼              ▼
[head] ←──pred── [Node2] ←──pred── [Node3 = tail]
                   ↑                ↑
                park()           park()
```

**非公平锁获取流程**（`ReentrantLock.NonfairSync`）：
```java
// 1. 先 CAS 抢一次（插队）
final boolean nonfairTryAcquire(int acquires) {
    final Thread current = Thread.currentThread();
    int c = getState();
    if (c == 0) {
        if (compareAndSetState(0, acquires)) {  // CAS 抢锁
            setExclusiveOwnerThread(current);
            return true;
        }
    } else if (current == getExclusiveOwnerThread()) {  // 可重入
        setState(c + acquires);
        return true;
    }
    return false;
}

// 2. 抢不到，acquire 会把它入队并 park
public final void acquire(int arg) {
    if (!tryAcquire(arg) &&
        acquireQueued(addWaiter(Node.EXCLUSIVE), arg))  // 入队
        selfInterrupt();
}
```

**公平锁的区别**（`FairSync`）：`tryAcquire` 多了一个 `hasQueuedPredecessors()` 检查：
```java
protected final boolean tryAcquire(int acquires) {
    if (c == 0) {
        if (!hasQueuedPredecessors() &&           // ← 公平锁的关键：队列里没人等才抢
            compareAndSetState(0, acquires)) {
            setExclusiveOwnerThread(current);
            return true;
        }
    }
    // ...
}
```

## 三、源码层：park/unpack 唤醒

线程入队后如何阻塞？AQS 用 `LockSupport.park()`：
```java
final boolean acquireQueued(Node node, int arg) {
    for (;;) {  // 自旋
        final Node p = node.predecessor();
        if (p == head && tryAcquire(arg)) {  // 前驱是 head 且抢到锁
            setHead(node);
            return;
        }
        if (shouldParkAfterFailedAcquire(p, node) &&  // 把前驱的 waitStatus 改成 SIGNAL
            parkAndCheckInterrupt())                   // LockSupport.park(this)
            throw new InterruptedException();
    }
}
```

**唤醒链路**：持锁线程 `unlock()` → `tryRelease(1)` 把 state 减到 0 → 唤醒 head 的后继 → 后继线程 `unpark()` 醒来继续自旋抢锁。

**为什么用 park 而不是 wait/notify**：
- `park` 不需要锁，任何线程都能 `unpark`
- `unpark` 可以在 `park` 之前调用（先发"许可"），不会丢失信号；`notify` 必须在 `wait` 之后调用
- `park` 可以响应中断、设置超时

## 四、应用层：风控系统的实战

**场景 1：规则引擎的限流锁**
风控规则引擎加载规则时，需要"读写锁"——加载（写）独占，查询（共享）：
```java
private final ReentrantReadWriteLock rwl = new ReentrantReadWriteLock();

public void reloadRules() {
    rwl.writeLock().lock();
    try {
        rules = ruleCenter.fetch();  // 重新加载规则
    } finally {
        rwl.writeLock().unlock();
    }
}

public RiskResult evaluate(RiskEvent event) {
    rwl.readLock().lock();
    try {
        return rules.match(event);   // 并发查询
    } finally {
        rwl.readLock().unlock();
    }
}
```

**场景 2：信号量限流**
风控对外 API 用 `Semaphore` 做并发限流：
```java
private final Semaphore semaphore = new Semaphore(500);  // 最多 500 并发

public RiskResult invoke(Event event) throws InterruptedException {
    if (!semaphore.tryAcquire(50, TimeUnit.MILLISECONDS)) {
        throw new TooManyRequestsException();  // 快速失败
    }
    try {
        return doInvoke(event);
    } finally {
        semaphore.release();
    }
}
```

**场景 3：启动闭锁**
服务启动时等所有特征源（HBase、Redis、Kafka）就绪：
```java
CountDownLatch ready = new CountDownLatch(3);
featureSource1.init(() -> ready.countDown());
featureSource2.init(() -> ready.countDown());
featureSource3.init(() -> ready.countDown());
ready.await(30, TimeUnit.SECONDS);  // 都就绪才接流量
```

## 五、对比层：synchronized vs ReentrantLock

| 维度 | synchronized | ReentrantLock |
|------|--------------|---------------|
| 实现 | JVM 内置（monitor） | AQS（Java 层） |
| 公平性 | 非公平 | 可选公平/非公平 |
| 可中断 | 不可中断 | `lockInterruptibly()` 可中断 |
| 超时 | 不支持 | `tryLock(timeout)` |
| 多条件 | 一个 wait set | 多个 `Condition` |
| 锁释放 | 自动（出代码块） | 必须 `finally` 手动释放 |
| 性能 | JDK 6+ 偏向锁/轻量级锁优化后接近 | 高并发下略优 |

**JDK 6+ synchronized 的优化**（面试常问）：
- 偏向锁 → 轻量级锁 → 重量级锁（自适应升级）
- 锁消除（逃逸分析发现无竞争直接去掉）
- 锁粗化（循环内的多次锁合并成一次）

## 六、底层本质：CAS + 自旋 + 阻塞的成本曲线

AQS 的设计本质是**用 CAS 的自旋换内核态阻塞**：
- **CAS 自旋**：用户态，速度快，但竞争激烈时 CPU 空转
- **park 阻塞**：内核态切换，慢，但不占 CPU

AQS 的策略：**先 CAS 自旋短时间（在 `acquireQueued` 自旋里前驱是 head 时多试一次），失败再 park**——这是"乐观尝试 + 悲观兜底"的混合策略，对应不同竞争强度的成本最优点：
- 低竞争（单线程）：CAS 直接成功，零阻塞成本
- 中竞争（几个线程）：CAS 自旋几次成功，少量 CPU 开销
- 高竞争（几十线程）：快速 park，避免 CPU 浪费

**这就是为什么 AQS 比 synchronized 在高并发下更有优势**——synchronized 一旦升级到重量级锁就直接 park，而 AQS 有"自旋+park"的自适应混合。

## 常见考点
1. **AQS 为什么是双向队列？**——取消节点时要找前驱接续；唤醒时要找后继；判断 `hasQueuedPredecessors` 要看 head 后是否有节点。
2. **公平锁一定不饿死吗？**——理论上不饿死（FIFO），但 `tryAcquire` 仍 CAS，可能被刚 unlock 的线程的非公平抢占一次（" barging"）。
3. **Condition 是怎么实现的？**——每个 Condition 维护一个独立的等待队列，`await()` 把节点从同步队列传到等待队列，`signal()` 反向传回。
