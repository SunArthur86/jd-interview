---
id: pdd-content-002
difficulty: L3
category: pdd-content
subcategory: Java 并发
tags:
- 拼多多
- 内容
- Java 并发
- volatile
- JMM
feynman:
  essence: volatile 用"内存屏障"保证可见性+禁止指令重排，但不保证复合操作原子性；内容场景如直播在线人数、Feed 计数常用 volatile 做标志位。
  analogy: volatile 像公告板——你改了立刻所有人看见（可见性），且顺序不会乱（禁止重排），但抢着改还是会冲突（不保证原子）。
  first_principle: 多核 CPU 各自有缓存+指令重排，导致共享变量不可见/乱序，需内存屏障约束。
  key_points:
  - 保证可见性（刷主存+失效其他缓存）
  - 禁止重排（插入 LoadLoad/StoreStore 屏障）
  - 不保证原子性（i++ 仍不安全）
  - JMM：happens-before + 主存/工作内存
first_principle:
  problem: 多核 CPU 缓存+重排导致共享变量不可见/乱序，如何约束？
  axioms:
  - CPU 有多级缓存
  - 编译器/CPU 会重排指令优化
  - 单读单写不需要锁
  rebuild: 内存屏障（volatile）保证可见+有序，复合原子用 Atomic。
follow_up:
  - volatile 和 synchronized 区别？——volatile 轻量（不阻塞），只保证可见/有序；synchronized 保证原子+可见
  - i++ 加 volatile 安全吗？——不安全，要用 AtomicInteger
  - 单例的 volatile 有什么用？——防止 new 对象重排（分配→赋值→初始化乱序）
memory_points:
  - 可见性：刷主存+失效缓存
  - 禁止重排：内存屏障
  - 不保证原子：i++ 要 Atomic
  - 单例双重锁必备
---

# 【拼多多内容】volatile 关键字原理与直播计数场景？

> JD 依据："IO/多线程/网络"。

## 一、JMM（Java Memory Model）

```
线程 A                       线程 B
工作内存（副本）              工作内存（副本）
    ↕                            ↕
   主存（共享变量 flag）
```

问题：A 改了 flag，B 可能读到旧值（缓存未刷新）；指令可能被重排。

## 二、volatile 的两大保证

**1. 可见性**：写后立刻刷主存+失效其他线程的副本
```
CPU 层：store buffer → store 屏障 → 刷主存 → 其他 CPU 通过 MESI 协议失效缓存
```

**2. 禁止重排**：插内存屏障
```
volatile 写前：StoreStore（前面普通写先落）
volatile 写后：StoreLoad（与后续读/写隔离）
volatile 读后：LoadLoad + LoadStore
```

## 三、不保证原子性

```java
volatile int count = 0;
// 10 个线程各 count++ 1000 次
// 结果不是 10000！因为 count++ = 读+加+写三步
```

**解法**：用 `AtomicInteger`（CAS）或 `synchronized`。

## 四、内容场景应用

**直播在线人数（标志位）**：
```java
private volatile boolean liveRunning = true;

// 直播主循环
while (liveRunning) {
    processDanmaku();
}
// 关播时另一线程置 false，立刻可见
public void stop() { liveRunning = false; }
```

**Feed 计数（高频）用 LongAdder**：
```java
LongAdder views = new LongAdder();   // 比 AtomicLong 高并发更优
views.increment();
views.sum();
```

**单例（防重排）**：
```java
private static volatile ReviewService instance;
public static ReviewService get() {
    if (instance == null) {
        synchronized (ReviewService.class) {
            if (instance == null) {
                instance = new ReviewService();  // volatile 防重排
                // new 实际：1.分配 2.初始化 3.赋值
                // 无 volatile 可能 1→3→2，其他线程拿到未初始化对象
            }
        }
    }
    return instance;
}
```

## 五、底层本质

volatile 本质是**"用内存屏障约束 CPU 缓存与重排"**——轻量级同步，适合单读单写场景；复合操作仍要锁或 CAS。

## 常见考点
1. **volatile 和 synchronized 怎么选**？——只标志位用 volatile，复合原子用 synchronized。
2. **CAS 是什么**？——Compare And Swap，无锁原子操作，ABA 问题用版本号。
3. **happens-before 是什么**——JMM 定义的偏序关系，保证前操作对后可见。
