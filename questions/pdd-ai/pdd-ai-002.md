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

## 苏格拉底式面试追问

> 这组追问不背答案，模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：你们模型路由表用 ConcurrentHashMap 而不是用数据库或配置中心存，为什么？路由变更那么频繁不怕丢一致性吗？**

模型路由表是读多写少的典型场景——线上推理每请求都要查"qwen-72b 当前指向哪个 endpoint"，QPS 百万级，但路由变更一天也就几次（模型上下线、灰度切换）。用 DB 或配置中心每次查都要网络往返，P99 延迟至少 5-10ms，而推理本身才几十毫秒，路由查询不能成瓶颈。ConcurrentHashMap 在 JVM 内内存查询是纳秒级，且 1.8 的实现是 CAS + 锁单个桶，读完全无锁。一致性方面，路由表只存"当前生效的版本指针"，真正的模型元数据（权重、配置）在 MLflow 里，路由表变更走"先写新版本到 MLflow → 再 CAS 更新路由表指针"的两阶段，即使路由表更新到一半也只会指向已就绪的版本。

### 第二层：证据与定位

**Q：线上偶发模型推理返回旧版本结果，持续 30 秒后恢复。你怎么确认是路由表的并发问题还是模型加载问题？**

先看证据链。第一，看路由表变更日志——`ROUTE.computeIfAbsent` 或 `put` 的 timestamp，确认 30 秒内是否有路由切换。第二，看各 Pod 的路由表快照——通过 Arthas 的 `ognl '@com.pdd.ai.RouteTable@ROUTE.toString()'` 在线查看多个 Pod 的路由表内容，如果有的 Pod 还指向 v1、有的指向 v2，说明是"配置推送 + 本地缓存"的最终一致性问题，不是 ConcurrentHashMap 本身的问题。第三，看模型加载日志——如果 v2 的 Triton 模型还在 loading（`ModelInstanceState: LOADING`），路由表已经切过去了，说明是"先切路由后等加载"的顺序 bug。ConcurrentHashMap 本身的线程安全几乎不用怀疑，根因 99% 在业务层的使用方式。

### 第三层：根因深挖

**Q：假设你确认是多个 Pod 路由表不一致——有的 Pod 指向 v1、有的指向 v2，持续 30 秒。这是 ConcurrentHashMap 的问题吗？根因在哪？**

这不是 ConcurrentHashMap 的问题，是配置推送的最终一致性问题。路由表是每个 Pod 内存的副本（从 Nacos 拉取），Nacos 推送配置变更时，各 Pod 的 `NacosConfigListener.onConfig` 触发时机不同——有的 Pod 网络抖动延迟 30 秒才收到推送。根因是"用配置中心推配置到各 Pod 内存"这个模式本身有延迟窗口，不是并发原语的问题。

**Q：那为什么不用一个集中式的路由服务，所有 Pod 都调它查路由，这样不就一致了吗？**

集中式路由服务会成单点瓶颈——百万 QPS 都打到一个路由服务，它自己就要集群化，又回到"各副本路由表如何一致"的问题。而且多一跳网络调用，推理 P99 从 50ms 升到 60ms。正确解法是接受"最终一致"——路由表允许短时间不一致（30 秒内），但保证灰度切换时新旧版本都能服务（v1 不急着下线，等 v2 全量生效后再摘）。如果业务要求强一致（比如金融场景模型版本必须全局一致），用版本号 fencing——每个请求带 `expected_version`，Pod 路由表版本不匹配时拒绝并触发强制刷新。

### 第四层：方案权衡

**Q：你用 computeIfAbsent 做惰性加载路由表，但如果多个线程同时 miss 同一个 key，会不会重复加载？computeIfAbsent 不是原子的吗？**

`computeIfAbsent` 本身是原子的（锁住桶头节点），同一 key 不会重复执行加载函数。但有个坑：如果加载函数（`loadFromConfig`）里又对同一个 Map 操作（比如递归 put 其他 key），会死锁或栈溢出——因为 computeIfAbsent 持有的是桶锁，递归操作如果命中同一个桶就死锁。另外，如果加载函数很慢（比如从远程拉配置要 2 秒），会阻塞同一桶的其他线程的 `get` 操作（1.8 里 get 大部分情况无锁，但桶正在 resize 时会阻塞）。所以 computeIfAbsent 的加载函数必须快（本地缓存命中或预热好的数据），慢操作要放到启动阶段或异步刷新。

**Q：为什么不用 Caffeine 替代 ConcurrentHashMap？Caffeine 也有并发安全 + 自动过期淘汰，不是更省心吗？**

路由表不需要过期淘汰——路由变更是事件驱动的（模型上下线主动推），不是时间驱动的。用 Caffeine 反而引入 TTL 误淘汰的风险（路由缓存过期了但新配置还没推过来，导致短暂的推理失败）。ConcurrentHashMap 是"永久持有 + 主动更新"的语义，更贴合路由表场景。Caffeine 适合"特征缓存"这种会膨胀需要淘汰的场景。选型不是哪个更高级，是哪个语义更匹配业务。

### 第五层：验证与沉淀

**Q：你怎么证明路由表的并发安全真的没问题？线上没报错不代表没隐患。**

三步验证。第一，离线压测——用 JCStress（Java Concurrency Stress tests）框架对 `computeIfAbsent` + `get` + `put` 混合操作跑百万次，断言"最终路由表内容和串行执行一致"，这是 ConcurrentHashMap 的契约测试。第二，线上混沌——故意在路由表变更时（Nacos 推送瞬间）灌大流量，观察是否有请求路由到不存在的版本（404）或旧版本（返回旧结果），统计 `route_mismatch_count`。第三，对账监控——每分钟抽样 100 个请求，把本地路由表版本和 MLflow 里的"权威版本"比对，`version_skew_seconds > 60` 告警。

**Q：怎么让团队避免再踩 computeIfAbsent 的坑？**

沉淀成代码规范。第一，`computeIfAbsent` 的加载函数禁止做远程调用或递归操作 Map——只能用预加载的本地数据。第二，路由表变更统一走 `replace(key, oldVal, newVal)` 的 CAS 模式，不用裸 `put`，避免 ABA 问题（两个线程同时改，后者覆盖前者）。第三，所有共享 Map 的使用要在 Code Review 时确认"读多写少还是读写均衡"、"是否需要淘汰"、"加载函数快不快"，对照选型表（ConcurrentHashMap / Caffeine / Redis）做决策，不能随手 new。

## 结构化回答

**30 秒电梯演讲：** 多线程下如何正确读写共享状态？简单说就是——Java 并发的核心是"可见性/原子性/有序性"三性保证，靠 volatile/synchronized/Lock/CAS 实现；模型服务/中台高并发读写共享状态（缓存/计数器/…。volatile 保证可见+禁排，不保证 i++；AQS：CLH 队列 + state + 独占/共享模式。

**展开框架：**
1. **三性** — 三性：可见性/原子性/有序性
2. **volatile 保证可** — volatile 保证可见+禁排，不保证 i++
3. **AQS** — AQS：CLH 队列 + state + 独占/共享模式

**收尾：** 您想继续往深里聊吗——比如「synchronized 和 Lock 区别？」

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：Java 并发三性与同步原语怎么用？ | 今天聊「Java 并发三性与同步原语怎么用？」。一句话：Java 并发的核心是"可见性/原子性/有序性"三性保证，靠 volatile/synchronized/Lock/C… | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：三性：可见性/原子性/有序性 | 核心概念 |
| 1:04 | 能力/参数拆解表 | 要点是：volatile 保证可见+禁排，不保证 i++ | 能力拆解 |
| 1:56 | 流程图：输入→处理→输出 | 要点是：AQS：CLH 队列 + state + 独占/共享模式 | 关键机制 |
| 3:00 | 总结卡 + 下期预告 | 记住这些核心点就够了。下期我们接着聊——synchronized 和 Lock 区别？。 | 收尾 |
