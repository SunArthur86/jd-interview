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

## 苏格拉底式面试追问

> 这组追问不是背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：直播在线人数你用 volatile boolean 做开关，但点赞计数为什么不用 volatile int？既然 volatile 保证可见性，计数不就该安全吗？**

这是 volatile 最容易被误用的地方。volatile 只保证"单次读/单次写"的可见性和有序性，但 `count++` 不是单次操作——它在字节码层是 `getfield`（读）→ `iadd`（加）→ `putfield`（写）三步，中间任何一步都可能被其他线程插入。10 个线程各 `count++` 1000 次，结果可能只有 7000-8000，丢掉的更新发生在"两线程同时读到旧值、各自加 1、各自写回"。直播点赞场景 QPS 能到几万，用 volatile int 会持续丢计数，所以必须用 `AtomicInteger`（CAS）或高并发更优的 `LongAdder`。

### 第二层：证据与定位

**Q：直播在线人数显示对不上（主播端看到 1.2 万，观众端看到 1.1 万），你怎么定位是不是 volatile 的问题？**

先判断这个场景用没用 volatile。如果是 `volatile long onlineCount`，那问题不在 volatile（单写场景可见性 OK），而在"多源统计口径不一致"。排查方向：
1. 看统计链路——在线人数是 Redis `SCARD live:online:{liveId}` 算的，还是 Netty channel 数，还是客户端心跳上报聚合？三路对不上是口径问题不是可见性问题。
2. 如果确实是多线程写同一变量，用 `arthas watch LiveService#getOnlineCount` 看返回值波动，配合 `thread -b` 看是否有竞态。
3. 用 jcstress（JMH 并发测试框架）写个压测用例，复现丢更新。

### 第三层：根因深挖

**Q：单例双重检查锁（DCL）里那个 volatile，具体防的是什么？去掉会怎样？**

防的是 `new ReviewService()` 这一句的指令重排。`new` 在字节码层是三步：1.分配内存 → 2.调用构造器初始化 → 3.把引用赋给 instance。JIT 可能把 2 和 3 重排成 1→3→2。这时如果线程 A 执行到 3（instance 已非 null 但未初始化），线程 B 在第一次 `if (instance == null)` 检查时看到非 null 直接返回，拿到的是一个"半初始化"对象，字段全是 null，调用就 NPE。volatile 在这里插 StoreStore 屏障，禁止 2 和 3 重排。去掉 volatile 在低并发下可能几个月不出问题，但在拼多多评价服务这种启动即高并发的场景，启动期必现。

### 第四层：方案权衡

**Q：直播弹幕计数你用 LongAdder 而不是 AtomicInteger，为什么？AtomicInteger 不够快吗？**

AtomicInteger 在低并发（<1000 QPS）完全够用，但直播弹幕高峰能到几万 QPS 写计数。AtomicInteger 是单点 CAS——所有线程竞争同一个 `value` 字段，高并发下 CAS 失败率高（自旋浪费 CPU），吞吐反而下降。LongAdder 的设计是"分散热点"——内部维护一个 Cell 数组（默认 CPU 核数个），线程哈希到不同 Cell 各自 CAS，`sum()` 时把所有 Cell 和 base 加起来。代价是 `sum()` 不是强一致的瞬时值（遍历 Cell 时可能有人正在写），但计数场景要的就是"最终大致准确"，不要原子性。这是用"弱一致换高吞吐"的典型权衡。

### 第五层：验证与沉淀

**Q：你怎么验证 volatile 真的生效了，而不是靠运气没出问题？**

不能靠线上观测——volatile 的竞态 bug 是概率性的，可能几个月才复现一次。验证要靠两步：
1. 单元层——用 `jcstress`（OpenJDK 的并发压力测试工具）写测试用例，跑百万次迭代，看是否出现非预期结果（如 DCL 拿到半初始化对象）。
2. 字节码层——`javap -v ReviewService.class` 看 instance 字段是否有 `ACC_VOLATILE` 标志；JIT 层用 `-XX:+PrintAssembly`（需 hsdis）看是否插了 `lock addl`（x86 的内存屏障）。
沉淀：团队规约——所有 DCL 单例的 instance 字段必须加 volatile，SonarQube 加规则扫描；直播计数类必须用 LongAdder 或 AtomicLong，禁止裸 volatile 计数。

## 结构化回答




**30 秒电梯演讲：** volatile 像公告板——你改了立刻所有人看见（可见性），且顺序不会乱（禁止重排），但抢着改还是会冲突（不保证原子）。

**展开框架：**
1. **保证** — 保证可见性（刷主存+失效其他缓存）
2. **LoadLoad** — 禁止重排（插入 LoadLoad/StoreStore 屏障）
3. **不保证原子性** — 不保证原子性（i++ 仍不安全）

**收尾：** volatile 和 synchronized 区别？




## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：volatile 关键字原理与直播计数场景？ | 今天聊「volatile 关键字原理与直播计数场景？」。一句话：volatile 用"内存屏障"保证可见性+禁止指令重排，但不保证复合操作原子性；内容场景如直播在线人数、Feed 计… | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：可见性：刷主存+失效缓存 | 核心概念 |
| 1:04 | 能力/参数拆解表 | 要点是：禁止重排：内存屏障 | 能力拆解 |
| 1:56 | 流程图：输入→处理→输出 | 要点是：不保证原子：i++ 要 Atomic | 关键机制 |
| 3:00 | 总结卡 + 下期预告 | 记住这些核心点就够了。下期我们接着聊——volatile 和 synchronized 区别？。 | 收尾 |
