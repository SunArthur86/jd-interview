---
id: pdd-trade-010
difficulty: L3
category: pdd-trade
subcategory: Java 并发
tags:
- 拼多多
- 交易
- 并发
- volatile
- happens-before
- JMM
feynman:
  essence: volatile 用内存屏障保证可见性（写刷主存、读从主存）和有序性（禁止重排），但不保证原子性；happens-before 定义"什么场景能看到对方修改"，是 JMM 的核心契约。
  analogy: volatile 像公开黑板——老师（线程A）写完立即通知所有学生（其他线程），但多人同时改黑板会乱（无原子性）。
  first_principle: 多核 CPU 各有缓存+重排优化，导致线程间"看不见"和"顺序乱"；JMM 用 happens-before 定义可见性语义，volatile 是落地工具。
  key_points:
  - volatile 两语义：可见性 + 有序性（不保证原子性）
  - happens-before 8 大规则
  - 内存屏障：LoadLoad/LoadStore/StoreStore/StoreLoad
  - 单例双重检查必须 volatile
first_principle:
  problem: 多核 CPU 下线程 A 修改的变量何时对线程 B 可见？
  axioms:
  - CPU 有缓存（L1/L2/L3）
  - 编译器/CPU 会重排序
  - 程序员需要明确可见性语义
  rebuild: JMM 定义 happens-before；volatile/synchronized/final 提供建立 happens-before 的工具。
follow_up:
- volatile 和 synchronized 区别？——volatile 只可见性+有序性（轻）；synchronized 还原子性（互斥）
- 单例双重检查为什么 volatile？——防 new 对象的"分配-初始化-赋值"重排
- final 字段可见性？——构造函数返回前对其他线程可见
memory_points:
- volatile = 可见性 + 有序性（禁止重排），不保证原子性
- happens-before 8 规则（程序顺序/监视器/volatile/启动/终止/传递性...）
- 双重检查单例必须 volatile
- 屏障 4 种：LoadLoad/LoadStore/StoreStore/StoreLoad
---

# 【拼多多交易】volatile 原理？happens-before 是什么？

> JD 依据："JAVA 基础扎实，对并发有理解"。

## 一、volatile 两个语义

```java
private volatile boolean stop = false;

// 线程 A
stop = true;  // volatile 写，立即刷主存 + 失效其他 CPU 缓存

// 线程 B
while (!stop) { ... }  // 立即看到 stop=true
```

**不保证原子性**：
```java
volatile int count = 0;
count++;  // 不安全！读+1+写三步
```

## 二、happens-before 八规则

| # | 规则 |
|---|------|
| 1 | 程序顺序（同线程内前→后） |
| 2 | 监视器锁（unlock → 后续 lock） |
| 3 | volatile（写 → 后续读） |
| 4 | 线程启动（start → 线程内） |
| 5 | 线程终止（线程内 → terminate） |
| 6 | 线程中断（interrupt → 检测） |
| 7 | 对象终结（构造完 → finalize） |
| 8 | 传递性（A→B, B→C 则 A→C） |

## 三、内存屏障

volatile 写前 StoreStore、写后 StoreLoad；读后 LoadLoad + LoadStore。

## 四、单例双重检查（经典考题）

```java
public class Singleton {
    private static volatile Singleton instance;  // 必须 volatile

    public static Singleton getInstance() {
        if (instance == null) {
            synchronized (Singleton.class) {
                if (instance == null) {
                    instance = new Singleton();  // 可能重排 1-3-2
                }
            }
        }
        return instance;
    }
}
```

`new Singleton()` 三步：分配内存 → 初始化 → 赋值。CPU 可能重排成 1-3-2，其他线程拿到未初始化对象 → NPE。volatile 禁止重排。

## 五、交易系统应用

**规则热加载**：
```java
private volatile Rules rules;
public void reload(Rules r) { this.rules = r; }       // 写立即对读线程可见
public Result eval(Event e) { return rules.match(e); } // 读最新
```

**停止标志**：
```java
private volatile boolean running = true;
public void run() { while (running) { ... } }
public void shutdown() { running = false; }
```

## 六、底层本质

volatile 是 JMM 给程序员的"可见性/有序性"契约工具——用内存屏障在硬件层落地。JMM 在"程序员便利性（强一致）"和"性能（弱一致）"间平衡，默认弱一致，需时显式强化。

## 常见考点
1. **volatile 能替 synchronized 吗**？——不能，无原子性（i++ 不安全）。
2. **StoreLoad 为什么最贵**？——要等所有 CPU 写刷主存才能读，相当于全屏障。
3. **final 字段 happens-before**？——构造函数完成时对其他线程可见（无需 volatile）。

## 苏格拉底式面试追问

> 这组追问不背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：你说 volatile 保证可见性但不保证原子性，那为什么 JVM 设计者不给 volatile 加上原子性？这样不就不用 synchronized 了吗？**

因为原子性是要付出"互斥"代价的。`count++` 要原子，必须保证"读-改-写"三步整体不被其他线程打断，这本质上就是加锁——要么 synchronized（JVM 隐式锁），要么 CAS（CPU 的 lock cmpxchg 指令）。如果 volatile 自带原子性，那它每次写都要做 CAS 或锁，性能退化成 synchronized 级别，volatile 的"轻量"优势就没了。JVM 的设计哲学是"按需付费"——你只要可见性（volatile），就给你最便宜的内存屏障；你要原子性（synchronized/Atomic），才付互斥的代价。把两者绑在一起等于强迫所有场景都付重代价，违背"弱一致默认、强一致显式"的权衡原则。

### 第二层：证据与定位

**Q：交易系统的规则热加载用了 `volatile Rules rules`，线上发现规则更新后部分线程还在用老规则，你怎么定位是 volatile 没生效，还是别的问题？**

volatile 在标准 JVM 上不会"没生效"（这是 JMM 保证），所以大概率是使用方式问题。三步定位：
1. 看 `reload()` 是不是真的替换了整个对象引用——`this.rules = newRules` 是对的；如果代码是 `this.rules.update(newFields)`（改老对象的字段），那 volatile 只保证"看到 rules 引用"，不保证"看到 rules 内部字段的新值"（字段没 volatile）。这是经典的" volatile 引用不等于 volatile 字段"陷阱。
2. 看读线程是不是缓存了局部引用——如果代码是 `Rules r = this.rules; while(true) { r.match(e); }`，把 rules 存成局部变量，后续永远读局部变量，reload 换了 this.rules 也看不到。必须每次都 `this.rules.match(e)`。
3. 看 JIT 是否把 `rules` 当成"循环不变量"优化掉了（没 volatile 时可能）。`-XX:+PrintCompilation` 看方法是否被 JIT 编译，或用 JCStress 做并发正确性测试。99% 是用法 bug，不是 volatile 失效。

### 第三层：根因深挖

**Q：你查到是 `this.rules.update(newFields)` 这种"改字段不换引用"的写法导致可见性问题，根因是什么？光是改成"换新对象"就行吗？**

治本是改成不可变对象（immutable）——每次规则变更 new 一个新 Rules 对象整体替换，而不是 in-place 改字段。这叫"Copy-on-Write"模式，配合 volatile 引用保证可见性。根因是"可变对象 + volatile 引用"只能保证引用可见性，不能保证对象内部状态可见性。如果 Rules 必须可变（如运行时累加统计），那每个字段也得 volatile，或者用 AtomicReference + 不可变快照。更本质的解法是让 Rules 设计成不可变（构建好就不改，改就换新实例），这样 volatile 引用就够，不用管内部字段。这是设计哲学——并发安全的对象优先设计成不可变。

**Q：那为什么不直接用 synchronized 保护 rules 的读写，而要用 volatile + 不可变对象？**

synchronized 能用，但在"读多写少"场景（规则热加载是典型的读多写少——每秒几万次读、几小时一次写）下性能差：每次读 rules 都要加锁，几万次锁竞争开销大。volatile + 不可变对象的优势是"读不加锁"——volatile 读只比普通读多一点屏障开销（亚纳秒级），写时 new 新对象（写少所以 new 开销可接受）。synchronized 适合"读写都频繁且要原子复合操作"的场景。规则热加载这种"读高频、写低频、读的是整体快照"的场景，volatile + COW 是最优解。用 synchronized 是"能用但不够好"，不是错。

### 第四层：方案权衡

**Q：你的停止标志用 `volatile boolean running`，但如果 `while(running)` 里的业务逻辑是阻塞的（如 `queue.take()`），`running=false` 后线程还是停不下来，你怎么权衡？**

这是 volatile 停止标志的经典盲区——volatile 只保证"看到 false"，但不保证"立即响应"。如果线程阻塞在 `queue.take()`，根本不会去检查 running。权衡方案：
1. 用可中断的阻塞——`queue.poll(timeout)` 而不是 `queue.take()`（无超时阻塞），poll 超时返回后检查 running，最多延迟一个 timeout 周期。
2. 中断唤醒——shutdown 时除了 `running=false`，还要 `thread.interrupt()`，让阻塞的 `take()/sleep()/wait()` 抛 `InterruptedException` 唤醒。但要注意中断异常的处理（捕获后重新设置中断状态或退出）。
3. 毒丸对象——往队列放一个特殊"结束信号"对象，消费者拿到后主动退出。这是更优雅的协作式停止。本质是"停止标志要配合可唤醒的阻塞机制"，单独的 volatile 搞不定阻塞线程。

**Q：为什么不直接用 `Thread.stop()` 强制停？**

`Thread.stop()` 已被废弃，因为它直接释放所有锁（Monitor），会导致被保护的数据处于不一致状态——比如线程正写到一半的订单对象，stop 后锁释放，其他线程拿到半成品订单，数据错乱。正确的停止是"协作式"——设置标志位让线程自己优雅退出（`running=false` + 中断唤醒），保证线程能在安全点退出（事务提交完、资源释放完）。`Thread.stop()` 是"谋杀"，协作式是"劝退"。Java 从设计上就放弃了强制停止，volatile + interrupt 是官方推荐。这种权衡是"可控退出"vs"立即但危险"，必然选可控。

### 第五层：验证与沉淀

**Q：你怎么验证 volatile 的可见性真的生效？这种"可能在某些 CPU/某些时刻失效"的并发 bug 怎么测出来？**

普通的单元测试测不出并发 bug（跑一万次可能只失败一次），必须用专门的并发测试工具：
1. JCStress（JVM 并发压力测试工具）——写一个测试类，让线程 A 写 volatile 变量、线程 B 读，JCStress 会跑数百万次迭代 + 不同线程调度组合，统计"读到新值/读到旧值/读到中间态"的次数。如果 volatile 正确，应该 0 次"读到中间态"。这是验证 JMM 语义的标准工具。
2. 生产压测 + 断言——规则热加载的场景，压测中频繁触发 reload，同时检查"读到的规则版本"和"最新规则版本"是否一致（允许短暂不一致但不应该长时间不一致）。`stale_read_count`（读到过期版本的次数）应该是 0 或极低。
3. 代码静态扫描——CI 扫描所有 `volatile` 引用，如果代码有"改字段不换引用"（如 `volatileObj.setX()`）的模式，直接告警，因为这是典型的 volatile 误用。

**Q：并发编程的坑（volatile/synchronized/可见性）怎么沉淀成团队不踩坑？**

靠规范 + 工具 + 培训：
1. 并发工具类优先——规范"禁止裸用 synchronized/volatile，优先用 JUC 工具类（AtomicXxx/CountDownLatch/CompletableFuture/ConcurrentHashMap）"，这些工具内部正确处理了可见性和原子性，业务侧不易错。
2. 单例规范——禁止手写双重检查单例，统一用枚举单例或 `Initialization-on-demand holder`（静态内部类），从根源避免 volatile 误用。
3. 并发 Code Review 必检项——review checklist 含"共享变量是否可见性正确""是否有竞态""阻塞是否能响应中断"，所有并发相关改动必须资深 review。并发 bug 一旦上线极难复现，预防远比调试重要。

## 结构化回答

**30 秒电梯演讲：** 多核 CPU 下线程 A 修改的变量何时对线程 B 可见？简单说就是——volatile 用内存屏障保证可见性（写刷主存、读从主存）和有序性（禁止重排），但不保证原子性；happens-before 定义"什么场景能看到对方修改"。

**展开框架：**
1. **volatile 两语义** — volatile 两语义：可见性 + 有序性（不保证原子性）
2. **happen** — happens-before 8 大规则
3. **内存屏障** — 内存屏障：LoadLoad/LoadStore/StoreStore/StoreLoad

**收尾：** 您看这块要不要再展开聊聊？

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：volatile 原理？happens-before 是什么？ | 今天聊「volatile 原理？happens-before 是什么？」。一句话：volatile 用内存屏障保证可见性（写刷主存、读从主存）和有序性（禁止重排），但不保证原子性；happens-be… | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：volatile 两语义：可见性 + 有序性（不保证原子性） | 核心概念 |
| 1:04 | 能力/参数拆解表 | 要点是：happens-before 8 大规则 | 能力拆解 |
| 1:56 | 流程图：输入→处理→输出 | 要点是：内存屏障：LoadLoad/LoadStore/StoreStore/StoreLoad | 关键机制 |
| 3:00 | 总结卡 + 下期预告 | 记住核心要点就够了。下期见。 | 收尾 |
