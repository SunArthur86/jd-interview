---
id: pdd-ai-002
difficulty: L3
category: pdd-ai
subcategory: Java 并发
tags:
- 拼多多
- AI 中台
- Java 并发
- AQS
- 锁
- 模型服务
feynman:
  essence: Java 并发的核心是"可见性/原子性/有序性"三性保证，靠 volatile/synchronized/Lock/CAS 实现；模型服务/中台高并发读写共享状态（缓存/计数器/限流）必须懂并发原语。
  analogy: 像多人改一份文件——volatile 是"改完立刻广播"，synchronized 是"独占办公室"，CAS 是"提交时检查没人动过"。
  first_principle: 多线程下共享状态读写会脏读/丢更新/重排序，必须用同步原语保证三性。
  key_points:
  - 三性：可见性（volatile）、原子性（CAS/锁）、有序性（happens-before）
  - volatile：可见性 + 禁重排，不保证复合原子
  - synchronized：JVM 内置锁，锁升级（偏向→轻量→重量）
  - AQS：CLH 队列 + state，ReentrantLock/Semaphore/CountDownLatch 都基于它
  - 并发容器：ConcurrentHashMap/CopyOnWrite/BlockingQueue
first_principle:
  problem: 多线程下如何正确读写共享状态？
  axioms:
  - CPU 多核 + 缓存 → 默认不可见
  - 编译器/CPU 重排序 → 默认无序
  - 复合操作（读改写）默认非原子
  rebuild: 同步原语（volatile/CAS/锁）+ happens-before 语义保证三性。
follow_up:
  - synchronized 和 Lock 区别？——Lock 可中断/超时/公平/多条件，synchronized 是 JVM 内置更轻
  - CAS 有什么问题？——ABA（用版本号 AtomicStampedReference）、自旋开销、只能单变量
  - ConcurrentHashMap 1.8 怎么实现？——CAS + synchronized 锁桶 + 链表转红黑树
memory_points:
  - 三性：可见性/原子性/有序性
  - volatile 保证可见+禁排，不保证 i++
  - AQS：CLH 队列 + state + 独占/共享模式
  - 锁升级：偏向→轻量（自旋）→重量（OS）
---

# 【拼多多 AI 中台】Java 并发三性与同步原语怎么用？

> JD 依据："Java + 微服务、高并发模型服务"。

## 一、三性与 happens-before

```
可见性：一个线程改了，其他线程立刻看到（volatile / synchronized）
原子性：操作不可分割（CAS / synchronized / Lock）
有序性：防止指令重排（volatile / happens-before）

happens-before 规则（前一个操作的结果对后一个可见）：
  - 程序顺序规则（同线程前→后）
  - volatile 写 → 后续 volatile 读
  - 锁释放 → 后续锁获取
  - 线程 start → run
  - 线程终止 → join 返回
```

## 二、volatile 详解

**作用**：保证可见性 + 禁止重排序（内存屏障）。

**坑**：不保证复合原子。
```java
volatile int count = 0;
// count++ 不原子（读-改-写三步）！线程不安全
// 多线程下用 AtomicInteger 或 synchronized
```

**模型服务典型用**：状态标志位（shutdown flag）、DCL 单例。
```java
public class ModelClient {
    private static volatile ModelClient instance;  // volatile 防 DCL 重排
    public static ModelClient get() {
        if (instance == null) {
            synchronized (ModelClient.class) {
                if (instance == null) instance = new ModelClient();
            }
        }
        return instance;
    }
}
```

## 三、synchronized 锁升级

```
无锁 → 偏向锁（一个线程）→ 轻量锁（多线程交替，自旋）→ 重量锁（OS mutex）
```

JDK 6 后 synchronized 优化得很猛，日常首选它（比 ReentrantLock 简单且 JVM 维护）。

## 四、AQS（AbstractQueuedSynchronizer）

```
state（int，volatile）+ CLH 双向等待队列
  - 独占：ReentrantLock（state=重入次数）
  - 共享：Semaphore（state=许可数）/CountDownLatch（state=计数）
  - 公平/非公平：是否检查队列
```

**模型服务用 AQS 衍生工具**：
```java
// 限流：Semaphore 控制并发推理数（保护 GPU）
Semaphore gpuSlots = new Semaphore(8);  // 8 张卡
gpuSlots.acquire();
try { callGpu(); } finally { gpuSlots.release(); }

// 批量推理等齐：CountDownLatch
CountDownLatch latch = new CountDownLatch(N);
for (int i = 0; i < N; i++) pool.submit(() -> { infer(); latch.countDown(); });
latch.await();  // 全部完成
```

## 五、并发容器（中台常用）

| 容器 | 场景 |
|------|------|
| `ConcurrentHashMap` | 缓存/配置/模型路由表 |
| `CopyOnWriteArrayList` | 读多写少（监听器列表） |
| `BlockingQueue` | 生产者-消费者（请求入队推理） |
| `LongAdder` | 高并发计数（限流计数） |

**ConcurrentHashMap 1.8**：`CAS + synchronized 锁单个桶 + 链表 ≥8 转红黑树`，比 1.7 分段锁更细粒度。

## 六、实战：模型路由表的并发安全

```java
// 多线程更新模型版本，读多写少
private final ConcurrentHashMap<String, ModelMeta> ROUTE = new ConcurrentHashMap<>();

// 写：put 自带线程安全
ROUTE.put("llm-chat", new ModelMeta("v2", "endpoint"));

// 读：get 无锁
ModelMeta meta = ROUTE.get("llm-chat");

// 复合操作（check-then-act）用原子方法
ROUTE.computeIfAbsent("llm-chat", k -> loadFromConfig(k));
```

## 七、底层本质

Java 并发的本质是**"对抗 CPU 缓存/重排，保证共享状态正确"**——硬件层靠内存屏障，语言层抽象成 volatile/CAS/锁/AQS。中台高并发场景下，首选无锁（CAS/并发容器），其次 synchronized（简单），最后显式 Lock（需要高级特性）。

## 常见考点

1. **ThreadLocal 怎么用**？——线程私有副本，做 TraceId/用户上下文；用完必须 `remove()` 防内存泄漏（线程池线程复用）。
2. **ConcurrentHashMap 为什么不允许 null**？——`contains` 歧义（key 是否存在 vs value 是 null），且多线程下无法区分。
3. **synchronized 锁字符串常量**？——字符串在常量池共享，可能锁住无关业务，别用字符串当锁。
