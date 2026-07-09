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
