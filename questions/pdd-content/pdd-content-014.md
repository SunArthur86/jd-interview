---
id: pdd-content-014
difficulty: L3
category: pdd-content
subcategory: Java 集合
tags:
- 拼多多
- 内容
- Java 集合
- ConcurrentHashMap
- 高并发
feynman:
  essence: 高并发集合（ConcurrentHashMap/CopyOnWriteArrayList/BlockingQueue）用"分段锁/CAS/复制"让多线程安全且高吞吐；内容场景如本地缓存、弹幕队列常用。
  analogy: ConcurrentHashMap 像多柜台银行——把钱箱分多段（JDK8 后是节点级锁），每个柜台独立干活互不打扰。
  first_principle: 普通 HashMap 多线程会死循环/丢数据，需并发安全结构。
  key_points:
  - ConcurrentHashMap：JDK7 分段锁/JDK8 CAS+同步
  - CopyOnWrite：写复制，读无锁
  - BlockingQueue：阻塞队列（生产消费）
  - 区别：synchronized 包装 vs 真并发结构
first_principle:
  problem: 多线程并发访问集合如何安全+高吞吐？
  axioms:
  - 普通集合不安全
  - 全锁降吞吐
  - 读写比例不同
  rebuild: CAS/分段/复制不同策略的并发结构。
follow_up:
  - ConcurrentHashMap 为什么不允许 null？——多线程下 get(null) 有歧义（映射不存在 vs 值就是 null）
  - CopyOnWriteArrayList 适用场景？——读多写少（监听器列表、配置）
  - 怎么选阻塞队列？——有界 LinkedBlockingQueue / SynchronousQueue 直接传递 / PriorityBlockingQueue 优先
memory_points:
  - CHM：JDK8 CAS+synchronized 头节点
  - COW：写时复制
  - BlockingQueue：阻塞
  - 区别：Collections.synchronizedXxx 全锁
---

# 【拼多多内容】高并发集合在内容场景的应用？

> JD 依据："IO/多线程/网络"、"高并发大流量"。

## 一、ConcurrentHashMap

**JDK 7：分段锁**（Segment）
```
ConcurrentHashMap
  ├─ Segment[16]（每个 Segment 一把锁）
  │   └─ HashEntry[]
  并发度 = Segment 数（默认 16）
```

**JDK 8：CAS + synchronized**（节点级锁）
```
桶数组 Node[]
  桶为空 → CAS 插入
  桶非空 → synchronized 锁头节点 → 链表/红黑树插入
  并发度 = 桶数（更细）
```

**扩容**：多线程协助迁移（transfer），每个线程认领一段 stride。

```java
ConcurrentHashMap<Long, Review> cache = new ConcurrentHashMap<>(1024);
cache.put(id, review);             // 安全
Review r = cache.get(id);
```

## 二、CopyOnWriteArrayList

```
读：直接读数组（无锁）
写：复制新数组 → 写完 → 替换引用（volatile）
```

```java
CopyOnWriteArrayList<Listener> listeners = new CopyOnWriteArrayList<>();
// 注册监听（少）
listeners.add(new ReviewListener());
// 通知（多，遍历不锁）
listeners.forEach(Listener::onChange);
```

**适用**：读多写少（监听器/配置/路由表）。
**缺点**：写时复制占内存+实时性弱。

## 三、BlockingQueue

| 实现 | 特点 | 场景 |
|------|------|------|
| ArrayBlockingQueue | 有界数组 | 生产消费（线程池） |
| LinkedBlockingQueue | 链表（默认 Integer.MAX） | 无界/有界生产消费 |
| SynchronousQueue | 直接传递（无容量） | 直接 hand-off |
| PriorityBlockingQueue | 优先级 | 任务调度 |
| DelayQueue | 延时 | 关单/延时任务 |

**内容场景**：
```java
// 直播弹幕队列（有界，背压）
BlockingQueue<Danmaku> queue = new ArrayBlockingQueue<>(1000);
// 主播端生产
queue.put(new Danmaku(...));    // 满了阻塞
// 渲染端消费
while (true) {
    Danmaku d = queue.poll(1, SECONDS);  // 空了等
    if (d != null) render(d);
}
```

## 四、内容场景应用

**1. 本地缓存（ConcurrentHashMap + Caffeine）**：
```java
// 评价列表本地缓存（一级）
ConcurrentHashMap<Long, List<Review>> localCache = new ConcurrentHashMap<>();
List<Review> reviews = localCache.computeIfAbsent(productId,
    pid -> reviewDao.findByProductId(pid));
```

**2. 监听器管理（CopyOnWriteArrayList）**：
```java
// 评价事件分发，遍历多添加少
CopyOnWriteArrayList<ReviewListener> listeners;
listeners.forEach(l -> l.onEvent(event));
```

**3. 直播弹幕/送礼队列（BlockingQueue）**：
```java
// 每个直播间一个队列
Map<Long, BlockingQueue<Danmaku>> liveQueues = new ConcurrentHashMap<>();
```

**4. 在线用户去重（ConcurrentHashMap.computeIfAbsent）**：
```java
// 同一用户在同一直播间只算一次
onlineMap.computeIfAbsent(liveId, k -> ConcurrentHashMap.newKeySet())
         .add(uid);
```

## 五、对比 synchronizedXxx

```java
// 旧方案（全锁）
Map<String, String> m = Collections.synchronizedMap(new HashMap<>());
//   ↑ 所有方法 synchronized，串行

// 新方案（真并发）
ConcurrentHashMap<String, String> cm = new ConcurrentHashMap<>();
//   ↑ 锁粒度细（桶），高吞吐
```

## 六、底层本质

并发集合本质是**"用细粒度锁/CAS/复制替代全锁"**——ConcurrentHashMap 节点锁、CopyOnWrite 写复制、BlockingQueue 阻塞协调，匹配不同读写场景。

## 常见考点
1. **ConcurrentHashMap size 怎么算**？——JDK8 用 baseCount + CounterCell 数组分散计数（减少竞争）。
2. **HashMap 多线程死循环**？——JDK7 头插法形成环；JDK8 改尾插法但仍会丢数据。
3. **putIfAbsent vs computeIfAbsent**？——前者只判断有无；后者带函数计算，原子。

## 苏格拉底式面试追问

> 这组追问不是背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：评价本地缓存你用 ConcurrentHashMap 而不是 HashMap + synchronized，JDK8 的 ConcurrentHashMap 到底快在哪？**

HashMap 多线程下会丢数据（并发 put 覆盖）甚至死循环（JDK7 扩容头插法成环），synchronized 包装是"全表锁"——所有操作串行，并发度=1。JDK8 ConcurrentHashMap 的革新是把锁粒度从"Segment（JDK7 的 16 段）"细化到"桶头节点（Node）"——put 时只 synchronized 锁当前 hash 桶的头节点，不同桶的操作完全并行。假设 map 有 1024 个桶，理论并发度是 1024（实际受 CPU 核数限制）。内容场景评价缓存高并发读写（评价页 QPS 几千），CHM 比 synchronizedMap 吞吐高 10 倍以上。本质是用"细粒度锁"换"高并发"。

### 第二层：证据与定位

**Q：直播在线用户用 `ConcurrentHashMap.newKeySet()` 去重，但你发现同一 uid 偶尔出现两次，怎么定位是 CHM 的 bug 还是用法错？**

CHM 本身经过千锤百炼，几乎不会丢去重。问题在用法：
1. 看 add 调用——`Set.add(uid)` 返回 boolean 表示是否新增，如果代码没用返回值判断，重复 add 不会报错（Set 语义就是幂等），但如果有"新增时发欢迎弹幕"逻辑，重复 add 会发两次。检查是否在 add 前先 remove（如用户重连），remove 和 add 的窗口期可能并发。
2. 看 uid 的 hashCode/equals——如果 uid 是自定义对象且 hashCode 实现错了（如用可变字段算 hash），同一 uid 的 hashCode 变化导致落在不同桶，Set 认为是两个不同对象。String/Long 不存在这问题，自定义类要查。
3. 看是否有多个 Set 实例——如果误 new 了两个 Set（如每次请求 new），自然去重失效。

### 第三层：根因深挖

**Q：ConcurrentHashMap 用 computeIfAbsent 做"缓存未命中则加载"，但你发现加载函数被执行了多次（缓存击穿）。根因是什么？**

JDK 8 的 computeIfAbsent 有个已知问题：如果加载函数内部又对同一个 map 操作（如递归 put），会死锁或行为异常。但更常见的"多次执行"根因：
1. **加载函数耗时长 + 高并发**——computeIfAbsent 在 JDK 8 下，多个线程同时 miss 同一个 key 时，只有一个线程执行加载函数（锁桶头），其他线程阻塞等待。但如果 map 正在扩容（resize），阻塞的线程可能重试，极端情况下加载函数被执行多次。JDK 9 修复了部分场景。
2. **key 的 hashCode 冲突**——不同 key 算出相同桶位，锁的是同一个头节点，互相阻塞。如果加载函数慢，其他 key 的请求也卡住。
3. **加载函数抛异常**——computeIfAbsent 中加载函数抛异常会回滚（不缓存），下次请求再次 miss 再次加载。
根治：热点 key 用"Future 缓存"——第一次 miss 时 put 一个 Future，其他线程拿 Future 等待，加载完成替换成真实值。或用 Caffeine（内置 LoadingCache + 单次加载保证）。

### 第四层：方案权衡

**Q：直播弹幕队列你选 ArrayBlockingQueue 而不是 LinkedBlockingQueue，为什么？两者不都是阻塞队列吗？**

两者性能特征差异大：
1. **ArrayBlockingQueue**——底层定长数组，put/take 用同一把 ReentrantLock（有界，公平）。优点是有界（天然背压，满了阻塞生产者），内存预分配无 GC 压力。缺点是锁竞争（put 和 take 互斥）。
2. **LinkedBlockingQueue**——底层链表，put/take 用两把锁（可并行），默认无界（Integer.MAX_VALUE）。优点是吞吐高（put/take 不互斥）。缺点是无界（满了 OOM，除非显式传容量）。
直播弹幕场景选 ArrayBlockingQueue 的原因：弹幕是"宁可丢也不可拖垮"的场景，必须有界（1000 条），满了用 `offer`（非阻塞，满了丢弃旧弹幕）。LinkedBlockingQueue 虽然也能传容量，但链表节点每次 put 创建新 Node 对象，弹幕高频时 GC 压力大。Array 用预分配数组，零 GC。

### 第五层：验证与沉淀

**Q：你怎么验证 ConcurrentHashMap 在高并发下真的没丢数据、没重复？**

并发正确性验证靠工具：
1. **jcstress**（JDK 并发压力测试框架）——写测试：N 个线程各 put 1000 个不同 key，跑完断言 `map.size() == N * 1000`。如果用 HashMap 这个测试会失败（丢 key），CHM 应该通过。
2. **JMH 吞吐对比**——对比 CHM vs synchronizedMap vs Collections.synchronizedMap 在不同线程数下的 ops/s，CHM 应随线程数线性增长（直到 CPU 瓶颈），synchronizedMap 应持平或下降。
3. **线上巡检**——本地缓存（CHM）定时对账，对比 CHM 的 entry 数 vs 数据源（如 Redis）的 key 数，差异大告警（可能是 CHM 的淘汰逻辑或并发问题）。
沉淀：所有共享 Map 必须用 CHM（Sonar 禁止 new HashMap 在多线程上下文）；热点 key 缓存用 Caffeine 不手写 computeIfAbsent；阻塞队列必须有界（禁止无界 LinkedBlockingQueue）。

## 结构化回答


**30 秒电梯演讲：** ConcurrentHashMap 像多柜台银行——把钱箱分多段（JDK8 后是节点级锁），每个柜台独立干活互不打扰。

**展开框架：**
1. **ConcurrentHas…** — JDK7 分段锁/JDK8 CAS+同步
2. **CopyOnWrite** — CopyOnWrite：写复制，读无锁
3. **BlockingQueue** — 阻塞队列（生产消费）

**收尾：** ConcurrentHashMap 为什么不允许 null？


## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：高并发集合在内容场景的应用？ | 今天聊「高并发集合在内容场景的应用？」。一句话：高并发集合（ConcurrentHashMap/CopyOnWriteArrayList/BlockingQueue）… | 开场钩子 |
| 0:12 | 代码片段 + 关键行高亮 | 要点是：CHM：JDK8 CAS+synchronized 头节点 | 核心概念 |
| 1:04 | 能力/参数拆解表 | 要点是：COW：写时复制 | 能力拆解 |
| 1:56 | 流程图：输入→处理→输出 | 要点是：BlockingQueue：阻塞 | 关键机制 |
| 3:00 | 总结卡 + 下期预告 | 记住这些核心点就够了。下期我们接着聊——ConcurrentHashMap 为什么不允许 null？。 | 收尾 |
