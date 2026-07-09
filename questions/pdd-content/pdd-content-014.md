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
