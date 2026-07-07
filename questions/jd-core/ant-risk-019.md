---
id: ant-risk-019
difficulty: L3
category: jd-core
subcategory: Java 并发
tags:
- 蚂蚁
- 风控
- 并发
- volatile
- happens-before
- 内存模型
feynman:
  essence: volatile 用"内存屏障"保证可见性（写立即对其他线程可见）和有序性（禁止指令重排），但不保证原子性；happens-before 是 JMM 定义的"先于"关系，决定何时能看到对方操作。
  analogy: volatile 像公开黑板——老师（线程A）写完立即通知所有学生（其他线程），学生看到的是最新内容，但多人同时改黑板会乱（无原子性）。
  first_principle: 多核 CPU 每核有缓存+指令重排优化，导致线程间"看不见"和"顺序乱"。JMM 用 happens-before 定义"什么场景能看到对方的修改"，volatile/synchronized/final 是落地工具。
  key_points:
  - volatile 两语义：可见性（写刷主存、读从主存）+ 有序性（禁止重排）
  - volatile 不保证原子性（i++ 仍不安全）
  - happens-before 8 大规则
  - 内存屏障：LoadLoad / LoadStore / StoreStore / StoreLoad
  - 单例模式的双重检查锁必须 volatile
first_principle:
  problem: 多核 CPU 下，线程 A 修改的变量什么时候对线程 B 可见？什么顺序？
  axioms:
  - CPU 有缓存（L1/L2/L3），各自线程看到不同副本
  - 编译器/CPU 会重排序优化（单线程语义不变，多线程可能错）
  - 程序员需要明确的"可见性"和"有序性"语义
  rebuild: JMM 定义 happens-before 关系——如果 A happens-before B，那么 A 的修改对 B 可见且有序。volatile/synchronized/final 提供建立 happens-before 的语言级工具。
follow_up:
- volatile 和 synchronized 区别？——volatile 只保证可见性有序性（轻）；synchronized 还保证原子性（互斥）
- 单例双重检查为什么 volatile？——防止 new 对象的"分配-初始化-赋值"重排，导致别的线程拿到未初始化对象
- final 字段的可见性？——final 在构造函数返回前对所有线程可见（构造期间对其他线程不可见）
memory_points:
- volatile = 可见性 + 有序性（禁止重排），不保证原子性
- happens-before 8 大规则：程序顺序、监视器锁、volatile、线程启动、终止、中断、对象传递、传递性
- 双重检查单例的 instance 必须 volatile（防 new 对象重排）
- 内存屏障 4 种：LoadLoad/LoadStore/StoreStore/StoreLoad
---

# 【蚂蚁风控】volatile 原理？happens-before 是什么？单例双重检查为什么 volatile？

> JD 依据："基础功底扎实"。JMM（Java 内存模型）是 Java 高级程序员的内功。

## 一、表面层：volatile 的两个语义

```java
private volatile boolean stop = false;

// 线程A
while (!stop) { ... }
stop = true;  // ← volatile 写

// 线程B
while (!stop) { ... }  // 立即看到 stop=true
```

**volatile 提供**：
1. **可见性**：写立即对其他线程可见（刷主存 + 失效其他 CPU 缓存行）
2. **有序性**：禁止指令重排序（前后语句不能跨越）

**volatile 不保证原子性**：
```java
volatile int count = 0;
count++;  // 不安全！= 读+1+写 三步，可能丢更新
```

## 二、为什么需要 volatile

**问题 1：缓存导致不可见**
```
CPU1 缓存: stop=false
CPU2 缓存: stop=false

线程A（CPU1）: stop = true → 只改了 CPU1 缓存
线程B（CPU2）: while(!stop) → 读 CPU2 缓存仍是 false → 死循环
```

**问题 2：重排导致顺序错**
```java
// 单例初始化
instance = new Singleton();
// 实际是三步：
//   1. 分配内存
//   2. 初始化对象
//   3. instance 指向内存
// CPU 可能重排成 1-3-2，其他线程在 3 之后、2 之前读到 instance ≠ null 但对象未初始化！
```

## 三、happens-before 八大规则

JMM 用 happens-before 定义"何时一个操作的结果对另一操作可见"：

| # | 规则 | 含义 |
|---|------|------|
| 1 | 程序顺序规则 | 同一线程内，前面的操作 happens-before 后面的 |
| 2 | 监视器锁规则 | unlock happens-before 后续 lock |
| 3 | volatile 规则 | volatile 写 happens-before 后续 volatile 读 |
| 4 | 线程启动规则 | Thread.start() happens-before 线程内任何操作 |
| 5 | 线程终止规则 | 线程所有操作 happens-before Thread.terminate() |
| 6 | 线程中断规则 | Thread.interrupt() happens-before 被中断线程检测到中断 |
| 7 | 对象终结规则 | 构造函数执行完 happens-before finalizer |
| 8 | **传递性** | A happens-before B，B happens-before C → A happens-before C |

**核心思想**：happens-before 不是说"时间上先发生"，而是"前一个操作的结果对后一个可见"。

## 四、内存屏障（volatile 的实现）

CPU 层面有 4 种屏障：

| 屏障 | 作用 |
|------|------|
| **LoadLoad** | Load1; LoadLoad; Load2 → Load1 必须先完成 |
| **StoreStore** | Store1; StoreStore; Store2 → Store1 必须先刷主存 |
| **LoadStore** | Load1; LoadStore; Store2 → Load1 必须先完成 |
| **StoreLoad** | Store1; StoreLoad; Load2 → Store1 全局可见后才能 Load2（最强，开销最大） |

**volatile 写之前插入 StoreStore 屏障，之后插入 StoreLoad 屏障**：
```
[普通写]
StoreStore 屏障  ← 防止上面的普通写和下面的 volatile 写重排
[volatile 写]
StoreLoad 屏障   ← 防止下面的读和上面的 volatile 写重排（最重要）
```

**volatile 读之后插入 LoadLoad + LoadStore 屏障**：
```
[volatile 读]
LoadLoad 屏障    ← 防止下面的读和上面的 volatile 读重排
LoadStore 屏障   ← 防止下面的写和上面的 volatile 读重排
```

## 五、单例双重检查（经典考题）

```java
public class Singleton {
    private static Singleton instance;  // ❌ 必须 volatile

    public static Singleton getInstance() {
        if (instance == null) {                    // 第一次检查（无锁）
            synchronized (Singleton.class) {
                if (instance == null) {            // 第二次检查（加锁）
                    instance = new Singleton();    // ← 这里出问题
                }
            }
        }
        return instance;
    }
}
```

**问题**：`instance = new Singleton()` 实际是三步：
1. 分配内存
2. 调用构造函数初始化
3. 把内存地址赋给 instance

**JVM/CPU 可能重排成 1-3-2**：
```
线程A 进入同步块，执行 1-3（instance 已指向内存但未初始化）
线程B 第一次检查 instance != null，直接返回
线程B 用未初始化的对象 → NPE
```

**修复**：`private static volatile Singleton instance;`
- volatile 的 StoreStore 屏障保证"普通写"（构造函数赋值）先于"volatile 写"（instance 赋值）
- 即禁止 1-3-2 重排

**最佳实践**（更简单）：用静态内部类（利用类加载机制）：
```java
public class Singleton {
    private static class Holder {
        static final Singleton INSTANCE = new Singleton();
    }
    public static Singleton getInstance() {
        return Holder.INSTANCE;  // 触发 Holder 类加载（线程安全）
    }
}
```

## 六、volatile 的应用场景

**适合**：
- 状态标志位（`boolean stop`）
- 单次发布的引用（`volatile Config config`，一次性赋值后只读）
- DCL 单例

**不适合**：
- 计数器（用 AtomicInteger）
- 复合操作（读-改-写）

**风控的例子**：
```java
public class RiskEngine {
    private volatile Rules rules;  // 规则热更新

    public void reloadRules(Rules newRules) {
        this.rules = newRules;  // volatile 写，其他线程立即看到
    }

    public Result evaluate(Event e) {
        Rules r = this.rules;   // volatile 读，看到最新
        return r.match(e);
    }
}
```

## 七、对比：volatile vs synchronized vs Atomic*

| 维度 | volatile | synchronized | Atomic* |
|------|----------|--------------|---------|
| 原子性 | ✗ | ✓ | ✓ |
| 可见性 | ✓ | ✓ | ✓ |
| 有序性 | ✓ | ✓ | ✓ |
| 阻塞 | 不阻塞 | 阻塞 | 不阻塞（CAS） |
| 性能 | 最快 | 最慢 | 中 |
| 适用 | 标志/单发布 | 复合操作 | 单变量计数 |

**选择**：
- 单标志位 → volatile
- 单变量自增 → AtomicInteger
- 多变量复合 → synchronized 或 Lock

## 八、底层本质：JMM 的"程序员-编译器-CPU"契约

计算机内存模型的层次：
```
程序员期望（强一致）
    ↑
    │ JMM 定义契约（happens-before）
    ↓
Java 编译器（优化重排）
    ↓
JIT 编译器（更激进重排）
    ↓
CPU 内存模型（弱一致，每种 CPU 不同：x86 强、ARM 弱）
    ↓
缓存一致性协议（MESI）
```

**JMM 的角色**：
- 程序员用 volatile/synchronized 等"高级语义"表达"我要的可见性/有序性"
- JMM 翻译成对应的内存屏障
- 编译器/CPU 遵守屏障约定

**这是软件契约的胜利**：
- 不用了解每种 CPU 的具体内存模型
- 用统一语义写跨平台并发代码

**JMM 的核心权衡**：在"程序员的便利性（强一致）"和"性能（弱一致）"之间找平衡——默认弱一致（高性能），需要时显式强化（volatile/synchronized）。

## 九、风控的并发实战

**场景：实时规则热加载**
```java
public class RuleEngine {
    // volatile 保证 reloadRules 写入对所有 evaluate 线程可见
    private volatile CompiledRuleSet ruleSet;

    public void reloadRules(String dsl) {
        CompiledRuleSet newSet = compile(dsl);  // 在局部变量里编译（耗时）
        this.ruleSet = newSet;                  // volatile 写（瞬间切换）
    }

    public Result evaluate(Event e) {
        CompiledRuleSet rs = this.ruleSet;       // volatile 读
        return rs.match(e);
    }
}
```

**为什么这样设计**：
- 规则编译耗时（不能加锁影响读）
- 用 volatile 让"读"无锁（高并发）、"写"原子可见
- 整体规则集的切换是原子的（指针替换）

## 常见考点
1. **volatile 能不能替代 synchronized**？——不能。volatile 无原子性；i++ 仍需 synchronized 或 AtomicInteger。
2. **为什么 StoreLoad 屏障最贵**？——它要等所有 CPU 的写都刷主存才能继续读，相当于"全屏障"。
3. **final 字段的 happens-before**？——final 字段在构造函数完成时对其他线程立即可见（无需 volatile），但构造期间不可见。

**代码示例**（用 AtomicIntegerFieldUpdater 优化 volatile）：
```java
public class Counter {
    private volatile int count;  // 必须 volatile
    private static final AtomicIntegerFieldUpdater<Counter> U =
        AtomicIntegerFieldUpdater.newUpdater(Counter.class, "count");

    public void inc() { U.incrementAndGet(this); }
}
// 适合字段多的类，避免每个字段都用 AtomicInteger 占用对象头
```
