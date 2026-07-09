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
