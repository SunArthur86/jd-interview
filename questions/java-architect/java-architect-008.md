---
id: java-architect-008
difficulty: L2
category: java-architect
subcategory: Java 并发
tags:
- 锁
- AQS
- 并发
feynman:
  essence: 锁升级的本质是"用最小开销拿到锁"——无竞争用 CAS（偏向锁/轻量级锁），短竞争自旋等待（轻量级锁），长竞争才进入内核挂起（重量级锁）。AQS 则是 JUC 锁的"脚手架"：用 state 变量 + CLH 等待队列，让 ReentrantLock/Semaphore/CountDownLatch 共享同一套框架。
  analogy: 锁升级像停车场管理：偏向锁是"专属车位写你名字，没竞争直接停"；轻量级锁是"车位没锁但有人抢，先原地等几秒（自旋）"；重量级锁是"排队拿号，保安（操作系统）叫号进"。AQS 是停车场的"号牌系统"——state 是剩余车位数，CLH 队列是等号的车队。
  first_principle: 为什么锁要升级？因为加锁场景竞争强度不同——99% 时间无竞争（用 CAS 足够），少数有竞争（自旋），极少激烈竞争（内核挂起）。固定用一种锁要么浪费（无竞争也走内核）要么不抗（激烈竞争还自旋烧 CPU）。升级机制按实际竞争强度动态选择最优策略。
  key_points:
  - synchronized 锁升级：无锁→偏向锁→轻量级锁（自旋）→重量级锁（monitor）
  - Mark Word：对象头里记录锁状态、线程 ID、HashCode
  - AQS 核心：state（同步状态）+ CLH 双向队列（等待线程）
  - 独占模式（ReentrantLock）vs 共享模式（Semaphore/CountDownLatch）
  - 公平锁（FIFO）vs 非公平锁（抢占，默认）
first_principle:
  problem: 如何让加锁在不同竞争强度下都接近最优开销？
  axioms:
  - 大多数锁实际无竞争（偏向锁的统计基础）
  - 短暂竞争可用自旋等待（避免内核切换开销）
  - 激烈竞争必须挂起线程（自旋空耗 CPU 没意义）
  rebuild: 用 Mark Word 记录锁状态，运行时按竞争强度动态升级：无竞争→偏向锁（CAS 写线程 ID）；有竞争但短→轻量级锁（CAS + 自旋）；竞争激烈→重量级锁（OS mutex 挂起）。升级不可降级（偏向锁可批量撤销）。这套自适应机制让 synchronized 在各场景都接近手工调优的 ReentrantLock。
follow_up:
  - 偏向锁为什么 JDK 15 默认弃用？——偏向锁撤销成本高（要 safepoint），现代应用多线程竞争普遍，偏向锁收益不抵开销；且维护成本大（影响其他特性）
  - synchronized 和 ReentrantLock 怎么选？——简单同步用 synchronized（JVM 优化好、自动释放）；需要公平锁、可中断、tryLock、多 Condition 用 ReentrantLock
  - AQS 的 state 怎么用？——ReentrantLock 用 state 表示重入次数；Semaphore 用 state 表示剩余许可；CountDownLatch 用 state 表示剩余计数
  - CLH 队列为什么是双向的？——取消节点要唤醒前驱的后继，需要前向指针；MCS 是单向但只能从队首唤醒
  - 公平锁和非公平锁区别？——公平锁严格 FIFO（先到先得），非公平锁新线程先 tryAcquire 抢一次（插队），减少上下文切换提升吞吐
memory_points:
  - synchronized 锁升级：无锁→偏向→轻量（自旋）→重量（monitor），不可降级
  - Mark Word 存锁状态（2bit）+ 线程 ID + HashCode
  - AQS = volatile state + CLH 双向队列 + 独占/共享两种模式
  - 非公平锁默认：新线程先抢，提升吞吐；公平锁严格 FIFO
  - 临界区优化三原则：缩小范围、读写分离、无锁化（CAS/ThreadLocal/分区）
---

# 【Java 后端架构师】锁升级、AQS 与高并发临界区优化

> 适用场景：JD 核心技术。秒杀场景下一个商品库存扣减，10 万并发抢同一把锁——串行化就崩。架构师必须懂锁升级机制才能选对工具（synchronized vs ReentrantLock vs 无锁），必须懂 AQS 才能读 JUC 源码定位死锁。

## 一、概念层：synchronized 的锁升级机制

**Java 对象头（Mark Word）布局（64 位 JVM）**：

```
┌─────────────────────────────────────────────────────────────┐
│                    64 bit Mark Word                          │
├──────────────┬──────────────────────────────────────────────┤
│ 锁状态(2bit) │              内容（其余 bit）                  │
├──────────────┼──────────────────────────────────────────────┤
│ 无锁 (01)    │ HashCode(31) + 分代年龄(4) + 0(偏向位)         │
│ 偏向锁(01)   │ 线程ID(54) + epoch(2) + 分代年龄(4) + 1(偏向位)│
│ 轻量级(00)   │ 指向栈中锁记录指针(62)                        │
│ 重量级(10)   │ 指向 ObjectMonitor 指针(62)                   │
│ GC 标记(11)  │ -                                            │
└──────────────┴──────────────────────────────────────────────┘
```

**锁升级流程**：

```
新对象（无锁 01）
    │ 首次有线程进入同步块
    ▼
偏向锁（01，记录线程 ID）── 线程 ID 匹配直接进入（无 CAS）
    │ 第二个线程来竞争
    ▼
轻量级锁（00）── CAS 抢锁，没抢到自旋等待（不挂起）
    │ 自旋超过阈值（默认 10 次）或多个线程竞争
    ▼
重量级锁（10）── OS mutex 互斥量，未抢到线程进入 ObjectMonitor 队列挂起
```

**关键点**（面试必答）：

- **偏向锁**：无竞争时，记录线程 ID，同线程再次进入直接放行，零开销。JDK 15 默认弃用（收益不抵撤销成本）。
- **轻量级锁**：短竞争时 CAS + 自旋，避免内核切换。适合"持有时间短、竞争不激烈"。
- **重量级锁**：长竞争时 OS mutex 挂起线程，避免自旋烧 CPU。`-XX:PreBlockSpin` 控制自旋次数（自适应自旋 JDK 6 引入）。

**升级不可逆**（除偏向锁批量撤销）：一旦升到重量级，即使后续无竞争也不会降回轻量级。

## 二、机制层：AQS 框架与 CLH 队列

**AQS（AbstractQueuedSynchronizer）核心结构**：

```java
public abstract class AbstractQueuedSynchronizer {
    private volatile int state;        // 同步状态（CAS 修改）
    private transient volatile Node head;  // CLH 队列头
    private transient volatile Node tail;  // CLH 队列尾

    static final class Node {
        volatile int waitStatus;       // CANCELLED/SIGNAL/CONDITION/PROPAGATE
        volatile Node prev;            // 前驱（双向链表）
        volatile Node next;            // 后继
        volatile Thread thread;        // 等待线程
    }
}
```

**state 的不同语义**（AQS 的复用精髓）：

| 同步器 | state 语义 | 用法 |
|--------|-----------|------|
| ReentrantLock | 重入次数 | 每次重入 +1，释放 -1 |
| Semaphore | 剩余许可数 | acquire -1，release +1 |
| CountDownLatch | 剩余计数 | countDown -1，到 0 唤醒所有 |
| ReentrantReadWriteLock | 高 16 位读 / 低 16 位写 | 读共享、写独占 |

**CLH 队列工作流程**（ReentrantLock 非公平锁）：

```
线程 tryAcquire（CAS 抢 state）
    │ 成功 ──► 拿到锁
    │ 失败
    ▼
addWaiter：包装成 Node 加入 CLH 队列尾（CAS 入队）
    │
    ▼
acquireQueued：自旋检查前驱是否 head
    │ 前驱是 head 且 tryAcquire 成功 ──► 出队，拿到锁
    │ 否则
    ▼
park 阻塞（LockSupport.park），等前驱唤醒（unpark）
```

**独占 vs 共享模式**：

```java
// 独占（ReentrantLock）：同一时刻一个线程持有
tryAcquire / tryRelease
// 共享（Semaphore/CountDownLatch）：多个线程同时持有
tryAcquireShared / tryReleaseShared
// 读写锁：读共享、写独占（state 高低位拆分）
```

**公平锁 vs 非公平锁**（ReentrantLock 构造参数）：

```java
// 非公平锁（默认）——新线程直接 tryAcquire 抢一次
final boolean nonfairTryAcquire(int acquires) {
    if (compareAndSetState(0, acquires)) return true;  // 插队！
    ...
}
// 公平锁——先检查队列是否有前驱
final boolean fairTryAcquire(int acquires) {
    if (hasQueuedPredecessors()) return false;  // 有人排队，不抢
    if (compareAndSetState(0, acquires)) return true;
    ...
}
```

非公平锁吞吐更高（减少上下文切换），公平锁避免饥饿但慢。生产默认非公平。

## 三、实战层：synchronized vs ReentrantLock 与死锁排查

**synchronized（JDK 6+ 优化后）**：

```java
public synchronized void lock1() { ... }          // 方法级（锁 this）
public void lock2() {
    synchronized(this) { ... }                     // 块级
    synchronized(Stock.class) { ... }              // 类级
}
// 优点：JVM 自动优化（锁升级）、自动释放、字节码简单
// 缺点：不可中断、不可超时、不可尝试获取、单 Condition
```

**ReentrantLock**：

```java
private final ReentrantLock lock = new ReentrantLock();  // 默认非公平

public void op() throws InterruptedException {
    if (lock.tryLock(3, SECONDS)) {                // 可超时
        try { ... }
        finally { lock.unlock(); }                  // 必须手动释放
    }
    // lock.lockInterruptibly();  可中断
}
```

**选型决策**：

| 需求 | 选择 |
|------|------|
| 简单同步、无特殊需求 | synchronized |
| 需要公平锁 | ReentrantLock(fair) |
| 需要 tryLock/超时/可中断 | ReentrantLock |
| 需要多 Condition（生产消费分组唤醒） | ReentrantLock + Condition |
| 读多写少 | ReentrantReadWriteLock 或 StampedLock |

**死锁排查命令**（必背）：

```bash
# 1. 找 Java 进程
jps

# 2. dump 线程栈
jstack <pid>
# 输出会标注 "Found 1 deadlock"
# 找 "Found java.lang.Thread.State: BLOCKED" 的线程，看它在等哪个锁

# 3. JDWP / Arthas 在线诊断
arthas: thread -b            # 找阻塞其他线程最多的线程（死锁元凶）
arthas: thread <id>          # 看具体线程栈

# 4. JFR 录制分析锁竞争
jcmd <pid> JFR.start settings=profile duration=60s filename=lock.jfr
jfr print --events jdk.JavaMonitorEnter lock.jfr  # 看锁等待事件
```

**死锁代码示例（4 个必要条件）**：

```java
// 经典：A 持有 lock1 等 lock2，B 持有 lock2 等 lock1
Thread t1 = new Thread(() -> {
    synchronized(lock1) { synchronized(lock2) { ... } }
});
Thread t2 = new Thread(() -> {
    synchronized(lock2) { synchronized(lock1) { ... } }
});
// 互斥、持有并等待、不可剥夺、循环等待 → 死锁
```

## 四、实战层：高并发临界区优化三策略

**策略 1：缩小临界区范围**——只锁真正需要同步的代码：

```java
// 反面：整段业务加锁，临界区过大
public void pay(Order order) {
    synchronized(this) {
        validate(order);      // 耗时，不需要锁
        compute(order);       // 耗时，不需要锁
        account.debit();      // 需要锁
        notify();             // 不需要锁
    }
}
// 正面：只锁真正需要的部分
public void pay(Order order) {
    validate(order);
    compute(order);
    synchronized(account) { account.debit(); }   // 临界区最小化
    notify();
}
```

**策略 2：锁分离（读写锁/分段锁）**：

```java
// 读写锁：读多写少场景
private final ReentrantReadWriteLock rwLock = new ReentrantReadWriteLock();
public Data read() {
    rwLock.readLock().lock();
    try { return data; } finally { rwLock.readLock().unlock(); }
}
public void write(Data d) {
    rwLock.writeLock().lock();
    try { data = d; } finally { rwLock.writeLock().unlock(); }
}

// 分段锁：ConcurrentHashMap 早期设计
private final Object[] locks = new Object[16];
public void update(String key) {
    synchronized(locks[key.hashCode() % 16]) { ... }  // 锁粒度变小
}
```

**策略 3：无锁化（CAS / ThreadLocal / 分区）**：

```java
// CAS 无锁计数
AtomicLong counter = new AtomicLong();
counter.incrementAndGet();   // CAS 自旋，无锁

// ThreadLocal 线程本地（无共享）
private static final ThreadLocal<SimpleDateFormat> DF =
    ThreadLocal.withInitial(() -> new SimpleDateFormat("yyyy-MM-dd"));
// 每线程一个实例，完全无竞争

// 分区计数（LongAdder 思路）—— 见 009 题
```

## 五、底层本质：为什么锁能升级且不可降级

回到第一性：**锁的开销由竞争强度决定，竞争强度由运行时统计决定**。

- 无竞争：用 CAS 记录线程 ID，零内核开销（偏向锁）。
- 短竞争：CAS + 自旋，避免内核切换（轻量级锁）。
- 长竞争：OS mutex 挂起，避免自旋烧 CPU（重量级锁）。

**为什么不可降级？** 因为降级要重新评估竞争强度，引入额外开销；且升级是基于"历史出现激烈竞争"的判断，悲观假设未来仍会竞争。JDK 6+ 的自适应自旋部分缓解（自旋次数根据历史成功率动态调整）。

AQS 的第一性：**所有同步器（锁、信号量、闭锁）本质都是"state 变量 + 等待队列"**。state 编码不同语义（重入次数/许可数/计数），队列统一管理等待线程。这套抽象让 ReentrantLock、Semaphore、CountDownLatch、ReentrantReadWriteLock 共享 90% 代码，是"框架思维"在 JUC 的典范。

## 六、AI 架构师加问：5 个 AI 相关问题

1. **AI 推理服务的锁怎么设计？**
   模型权重加载用读写锁（多请求读、零星写更新）；模型推理本身无共享状态（每请求独立），不需要锁；缓存用 ConcurrentHashMap + computeIfAbsent 原子操作。

2. **让 AI 排查死锁，AI 接管哪段？**
   AI 解析 jstack 输出，识别 BLOCKED 线程 + 锁等待环（deadlock detection）；给出修复建议（调整锁顺序、缩小临界区、用 tryLock 超时）；改代码必须人工 review，死锁往往涉及业务逻辑设计。

3. **AI Agent 多步骤任务怎么避免死锁？**
   单 Agent 内避免嵌套锁；多 Agent 协作用消息队列解耦（无共享锁）；必须加锁时用 tryLock + 超时，超时降级而不是死等；监控线程 BLOCKED 时间。

4. **AI 用 CompletableFuture 编排，锁怎么配合？**
   异步链路里慎用 synchronized（持有锁的线程切换后，其他线程拿不到锁）；优先用 CAS（AtomicXxx）或 ConcurrentHashMap 的原子方法；必须用锁时用 ReentrantLock（可超时、可中断）。

5. **AI 模型训练参数更新的锁？**
   分布式训练用参数服务器（PS）架构，gradient 聚合用 AllReduce（无锁 ring 通信）；单机多 GPU 用 NCCL（NVIDIA 集合通信库）；Java 侧的模型参数更新用 AtomicReference 或 CopyOnWrite（读多写少）。

## 七、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"锁四级、Mark Word、AQS 三件套、公平非公平、临界区三策略"**。

- **锁四级**：无锁→偏向→轻量（自旋）→重量（monitor），不可降级
- **Mark Word**：对象头存锁状态 + 线程 ID + HashCode
- **AQS 三件套**：volatile state + CLH 双向队列 + 独占/共享模式
- **公平 vs 非公平**：公平严格 FIFO，非公平新线程插队提升吞吐
- **临界区三策略**：缩小范围、读写分离、无锁化（CAS/ThreadLocal/分区）

### 拟人化理解

把锁升级想成**停车场**。偏向锁是"专属车位写你名字，你直接停"；轻量级锁是"车位没锁但有人抢，原地等几秒（自旋）"；重量级锁是"排队拿号，保安叫号进（OS 挂起）"。AQS 是停车场的"号牌系统"——state 是剩余车位数，CLH 队列是排队等号的车队。升级后不降级，因为"既然堵过，悲观假设还会堵"。

### 面试现场 60 秒回答

> synchronized 锁升级：无锁→偏向锁（记线程 ID，无竞争零开销）→轻量级锁（CAS+自旋，短竞争）→重量级锁（OS mutex 挂起，长竞争），不可降级。JDK 15 偏向锁默认弃用。AQS 是 JUC 锁的脚手架，核心是 volatile state + CLH 双向队列，state 在 ReentrantLock 是重入次数、Semaphore 是许可数、CountDownLatch 是计数。ReentrantLock 分公平（严格 FIFO）和非公平（默认，新线程插队提升吞吐）。临界区优化三策略：缩小范围、读写锁/分段锁分离、CAS/ThreadLocal 无锁化。死锁排查用 jstack 找 BLOCKED 线程和锁等待环。

### 反问面试官

> 贵司场景是读多写少（用读写锁）还是激烈写竞争（考虑无锁化）？是简单同步（synchronized 够）还是需要超时/中断/多 Condition（ReentrantLock）？这决定我选哪种锁。

## 八、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不全部用 CAS 无锁，还要锁？ | CAS 适合简单原子操作（计数）；复杂临界区（多步业务逻辑）CAS 化代码复杂难维护；且 CAS 自旋在激烈竞争下烧 CPU。锁在复杂逻辑场景更清晰可维护 |
| 证据追问 | 你怎么知道锁竞争激烈？ | jstack 看 BLOCKED 线程数；JFR 的 `jdk.JavaMonitorEnter` 看锁等待时长分布；arthas `thread -b` 找阻塞源；监控 RT 抖动（锁等待导致 P99 飙升） |
| 边界追问 | synchronized 优化后还有必要用 ReentrantLock 吗？ | 有。需要公平锁、tryLock 超时、lockInterruptibly 中断、多 Condition 唤醒分组时，synchronized 做不到。简单同步 synchronized 更省心 |
| 反例追问 | 什么时候不该加锁？ | 临界区极短且是计数（用 AtomicXxx）；数据线程本地（用 ThreadLocal）；读多写少（用读写锁或 CopyOnWrite）；可用无锁数据结构（ConcurrentHashMap 分段） |
| 风险追问 | 锁升级上线后最大风险？ | 主动点出：死锁（多锁顺序不一致）、锁泄漏（unlock 在 finally 外）、活锁（tryLock 自旋互相谦让）、重量级锁竞争导致上下文切换飙升。要有 jstack 监控 + tryLock 超时 + 固定锁顺序 |
| 验证追问 | 怎么证明锁优化生效？ | jstack BLOCKED 线程数下降；RT P99 改善（锁等待减少）；JFR 锁等待事件 P99 下降；吞吐（QPS）上升；CPU 利用率更均衡（不再单核打满） |
| 沉淀追问 | 团队防锁问题，沉淀什么？ | 锁顺序规范（按对象 id 排序加锁防死锁）、tryLock + 超时模板、Code Review 检查 unlock 在 finally、jstack/jfr 排查 SOP、锁竞争监控大盘 |

### 现场对话示例

**面试官**：synchronized 锁升级详细讲讲？

**候选人**：四级。新对象是无锁态，Mark Word 是 01，存 HashCode 和分代年龄。第一个线程进入同步块，升级为偏向锁，Mark Word 记录这个线程 ID（CAS），下次同线程进入直接匹配 ID 放行，零开销。第二个线程来竞争，偏向锁撤销升级为轻量级锁，Mark Word 指向栈中锁记录，CAS 抢锁，没抢到的自旋等待（不挂起）。如果自旋超过阈值（自适应，默认约 10 次）或多个线程同时竞争，升级为重量级锁，Mark Word 指向 ObjectMonitor，没抢到的线程进入 ObjectMonitor 的 EntryList 被 OS 挂起。升级不可逆，因为悲观假设既然堵过还会堵。JDK 15 偏向锁默认弃用，因为撤销成本高（要 safepoint）且现代应用多线程普遍。

**面试官**：AQS 的 state 怎么实现不同语义？

**候选人**：state 是 volatile int，不同同步器赋不同语义。ReentrantLock 用它表示重入次数，每次 lock 用 CAS +1，unlock -1，到 0 释放。Semaphore 用它表示剩余许可，acquire CAS -1，release +1。CountDownLatch 用它表示剩余计数，countDown -1，到 0 唤醒所有等待线程。ReentrantReadWriteLock 巧妙地用高 16 位表示读锁持有数、低 16 位表示写锁重入数，一个 int 编码两种锁。这就是 AQS 的复用精髓——同一套框架，state 编码不同业务语义。

**面试官**：死锁怎么排查？

**候选人**：先 jps 找 pid，jstack <pid> dump 线程栈，输出会标 "Found N deadlock"，找到 BLOCKED 线程看它在等哪个锁、谁持有。或用 arthas 的 `thread -b` 一键找阻塞源。修复方向：统一锁顺序（所有代码按对象 id 排序加锁）、用 tryLock + 超时（超时回退而不是死等）、缩小临界区、用并发容器替代手写锁。我还会上线 JFR 持续采集 `jdk.JavaMonitorEnter` 事件，监控锁等待 P99，超阈值告警提前发现。

## 常见考点

1. **synchronized 和 ReentrantLock 区别？**——synchronized 是关键字（JVM 层、自动释放、单 Condition、不可中断）；ReentrantLock 是类（API 层、手动 unlock、多 Condition、可中断可超时 tryLock）。JDK 6+ synchronized 性能已接近 ReentrantLock。
2. **公平锁为什么慢？**——每次 acquire 要检查 `hasQueuedPredecessors()`（队列是否有前驱），多一次判断；且严格 FIFO 导致更多上下文切换。非公平锁新线程直接抢，抢到了省去排队和切换开销。
3. **什么是锁消除和锁粗化？**——锁消除（JIT）：逃逸分析判定锁对象无竞争（如 StringBuffer 局部变量），JIT 消除 synchronized。锁粗化：相邻的多个 synchronized 块合并成一个，减少加锁解锁开销。
4. **StampedLock 是什么？**——JDK 8 引入，支持乐观读（tryOptimisticRead 无锁读，读时校验 stamp 是否失效），读多写少场景性能优于 ReentrantReadWriteLock。缺点是不可重入、不支持 Condition。


## 结构化回答

**30 秒电梯演讲：** 聊到锁升级、AQS 与高并发临界区优化，我的理解是——锁升级的本质是"用最小开销拿到锁"——无竞争用 CAS（偏向锁/轻量级锁），短竞争自旋等待（轻量级锁），长竞争才进入内核挂起（重量级锁）。AQS 则是 JUC 锁的"脚手架"：用 state 变量 + CLH 等待队列，让 ReentrantLock/Semaphore/CountDownLatch 共享同一套框架。打个比方，锁升级像停车场管理：偏向锁是"专属车位写你名字，没竞争直接停"；轻量级锁是"车位没锁但有人抢，先原地等几秒（自旋）"；重量级锁是"排队拿号，保安（操作系统）叫号进"。AQS 是停车场的"号牌系统"——state 是剩余车位数，CLH 队列是等号的车队。

**展开框架：**
1. **synchronized 锁升级** — 无锁→偏向锁→轻量级锁（自旋）→重量级锁（monitor）
2. **Mark Word** — 对象头里记录锁状态、线程 ID、HashCode
3. **AQS 核心** — state（同步状态）+ CLH 双向队列（等待线程）

**收尾：** 这块我在项目里也踩过坑——想深入的话，可以接着聊：偏向锁为什么 JDK 15 默认弃用？您更想看哪个方向？

## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡 | "锁升级、AQS 与高并发临界区优化——这道题面试官到底想考什么？我用 30 秒给你讲透。" | 开场钩子 |
| 0:15 | AQS 队列结构图 | 先说核心：锁升级的本质是"用最小开销拿到锁"——无竞争用 CAS（偏向锁/轻量级锁），短竞争自旋等待（轻量级锁），长竞争才进入内核挂起（重量级锁）。AQS 则是 JUC 锁的"脚手架"：。 | 核心定义 |
| 0:30 | 锁状态转换图 | 对象头里记录锁状态、线程 ID、HashCode。 | Mark Word |
| 1:30 | 总结卡 | 一句话记忆：synchronized 锁升级：无锁→偏向→轻量（自旋）→重量（monitor），不可降级。 下期可以接着聊：偏向锁为什么 JDK 15 默认弃用。 | 收尾总结 |
