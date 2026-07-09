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
