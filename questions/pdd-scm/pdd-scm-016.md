---
id: pdd-scm-016
difficulty: L3
category: pdd-scm
subcategory: Java 并发
tags:
- 拼多多
- 供应链
- 并发
- ConcurrentHashMap
- CAS
feynman:
  essence: JDK 8 的 ConcurrentHashMap 用"CAS+synchronized 桶锁"把锁粒度从 Segment（JDK 7）降到单个桶，读完全无锁（volatile）、写只锁单桶，并发度等于桶数。
  analogy: ConcurrentHashMap 像有几千个独立储物柜的仓库——不同人用不同柜子互不干扰（CAS+synchronized 桶锁），JDK 7 的分段锁是大区分锁（只 16 个区）。
  first_principle: 哈希表不同桶天然独立，把锁粒度细化到桶级，冲突概率从全表降到哈希冲突概率。
  key_points:
  - JDK 8：CAS+synchronized 桶锁，锁粒度=单桶
  - 读无锁（Node val volatile）
  - 链表≥8 且容量≥64 转红黑树
  - 并发扩容：多线程协助迁移
  - CounterCell 分片计数
first_principle:
  problem: 高并发哈希表如何既线程安全又无锁瓶颈？
  axioms:
  - 不同桶逻辑独立
  - 哈希冲突是低概率
  - CAS 适合低竞争，synchronized 适合中高竞争
  rebuild: 桶级锁（CAS+synchronized）+ 读无锁（volatile）+ 并发扩容 + 分片计数。
follow_up:
- 为什么 JDK 8 用 synchronized 而不是 ReentrantLock？——JDK 6 后 synchronized 优化性能不输，内存占用少
- size 为什么不准？——弱一致（CounterCell 分片），但接近准确
- 供应链哪里用？——商品本地缓存、库存实时计数
memory_points:
- JDK 8 CAS+synchronized 桶锁（粒度=单桶）
- 读无锁（volatile），写只锁桶头节点
- 链表≥8 转红黑树
- CounterCell 分片计数避免单点竞争
---

# 【拼多多供应链】ConcurrentHashMap 原理？put 流程？

> JD 依据："Java 基础扎实，理解并发"。

## 一、JDK 7 vs 8

| 维度 | JDK 7（Segment 分段锁） | JDK 8（CAS+桶锁） |
|------|----------------------|------------------|
| 锁粒度 | Segment（默认 16 个） | 单桶 |
| 并发度 | 16 | 桶数（16→扩容翻倍） |
| 数据结构 | Segment + HashEntry 链表 | Node 数组 + 链表/红黑树 |

## 二、JDK 8 put 流程

```
1. 桶空 → CAS 写入头节点（乐观，无锁）
2. 桶头是 ForwardingNode（扩容中）→ 协助迁移
3. 桶非空 → synchronized 锁头节点
   ├─ 链表：遍历更新或尾插
   └─ 红黑树：树插入
4. 链表≥8 且容量≥64 → treeifyBin
5. addCount（CounterCell 分片计数）
```

## 三、读完全无锁

Node 的 val 和 next 是 volatile，读不加锁。扩容时旧表和新表都可见（ForwardingNode 转发）。

## 四、并发扩容（精华）

多线程协助迁移：
```
线程1 发起扩容 → 创建 nextTable（2倍）
   ├─ 线程1 迁移桶 [0, stride)
   ├─ 线程2 put 时发现扩容，迁移 [stride, 2stride)
   └─ ...
迁移完一个桶，旧桶头置 ForwardingNode（hash=MOVED）
```

单线程扩容瓶颈变多核并行。

## 五、供应链应用

**商品本地缓存**：
```java
ConcurrentHashMap<Long, Product> cache = new ConcurrentHashMap<>();
cache.compute(productId, (k, v) -> v == null ? loadFromDb(k) : v);  // 原子 read-modify-write
```

**库存实时计数**（单机）：
```java
ConcurrentHashMap<Long, AtomicLong> stockMap = new ConcurrentHashMap<>();
stockMap.computeIfAbsent(skuId, k -> new AtomicLong(1000))
       .addAndGet(-qty);  // 原子扣减
```

## 六、底层本质

CHM 的演进是**锁粒度从粗到细**：Segment（16）→ 桶（16→扩容翻倍）。把锁拆成 N 把，吞吐理论上 N 倍（前提访问均匀）。

## 常见考点
1. **JDK 8 为什么用 synchronized 而非 ReentrantLock**？——JDK 6+ synchronized 优化后性能接近，内存占用少；桶级锁竞争低，synchronized 足够。
2. **size 准吗**？——弱一致（CounterCell 分片计数），但接近准确。
3. **put 会丢数据吗**？——不会，每次 put 在桶锁内完成。

## 苏格拉底式面试追问

> 这组追问不是背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：供应链商品本地缓存你用 ConcurrentHashMap 而不是 Caffeine。Caffeine 有 W-TinyLFU 淘汰策略和异步刷新，CHM 什么都没有，为什么选 CHM？**

因为 CHM 是"可控的底层数据结构"，Caffeine 是"带策略的缓存框架"。选 CHM 的场景是"不需要淘汰策略的短期持有"——比如单次请求上下文缓存（`RequestId → Context`，请求结束就清）、或者配合外部控制生命周期的场景（如自己实现定时刷新）。Caffeine 适合"长期缓存 + 需要淘汰 + TTL"。供应链的商品本地缓存其实应该用 Caffeine（有 maximumSize 和 TTL 需求），用 CHM 是历史遗留或简单场景。如果是千万级 SKU 缓存，必须 Caffeine（CHM 无上限会 OOM，见 002 题）。

### 第二层：证据与定位

**Q：线上商品缓存（CHM 实现）大促时 CPU 飙到 90%，jstack 发现大量线程卡在 `computeIfAbsent`。你怎么定位是 CHM 扩容还是桶锁竞争？**

看 jstack 堆栈和 CHM 内部状态：
1. **看堆栈位置**——如果卡在 `transfer` 方法（扩容迁移），是并发扩容，线程在协助迁移桶；如果卡在 `synchronized` 的 `Node` 桶锁，是桶锁竞争（大量线程 hash 到同一桶）。
2. **看扩容状态**——`size()` 如果从平时的几万突然涨到几百万（大促缓存暴涨），CHM 会触发扩容（`tryPresize`），扩容期间多线程协助迁移，CPU 飙高是扩容开销。
3. **看哈希冲突**——如果大量 key 的 hash 值相同（hash 函数差或 key 分布集中），同一桶链表很长，synchronized 锁头节点时多个线程排队。`arthas watch java.util.concurrent.ConcurrentHashMap size '{params, returnObj}'` 或打印 CHM 的桶分布看冲突。

### 第三层：根因深挖

**Q：jstack 显示卡在桶锁（synchronized Node），桶的链表有 2000 个节点。为什么链表这么长没转红黑树？**

CHM 转红黑树有两个条件：链表长度 ≥ 8 **且** table 容量 ≥ 64。如果容量 < 64，`treeifyBin` 会先扩容而不是转树。根因可能是：
1. **容量未达 64**——CHM 初始容量默认 16，如果没指定初始容量且 key 数量增长慢，容量一直 < 64，链表≥8 也不转树，只能靠扩容。查 `table.length`，如果 < 64 就是这个原因。
2. **hash 碰撞极端**——2000 个节点在同一桶，不是正常 hash 分布（正常 Poisson 分布下 8 个节点概率 0.00000006）。根因是 key 的 hashCode 实现差（如 `Long.hashCode` 对某段 id 区间碰撞）或 key 集中（如所有商品 key 都以某前缀开头，hash 到同桶）。
解法：指定足够初始容量（`new ConcurrentHashMap<>(预期大小 / 0.75 + 1)`）避免频繁扩容；如果 hash 碰撞极端，换 key 策略（加扰动 `hash ^= (hash >>> 16)`）。

**Q：那为什么不直接用 Caffeine 替换 CHM，它内部也用 ConcurrentHashMap 但有淘汰策略，链表不会涨到 2000？**

Caffeine 确实能解决（有 maximumSize 淘汰，缓存大小可控），但如果根因是"key 的 hash 碰撞极端"，换 Caffeine 也不彻底——Caffeine 底层还是 CHM，hash 碰撞照样链表长。治本要分两步：
1. **修 hash 碰撞**——调查 key 的 hashCode 实现，如果是自定义 key，确保 hashCode 分散；如果是 Long 类型 id 集中在某段（如自增 id 1-10000），CHM 的 `spread` 函数（`(h ^ (h >>> 16)) & HASH_BITS`）应该能打散，除非有 bug。
2. **加上限淘汰**——换 Caffeine 或给 CHM 加手动淘汰（`if (cache.size() > 500000) cache.clear()`），从规模上控制。
两者结合，hash 修好 + 上限淘汰，链表不会长。

### 第四层：方案权衡

**Q：大促时 CHM 扩容导致 CPU 飙高，你设了足够初始容量避免扩容。但扩容是 CHM 的正常机制，彻底避免会不会有问题？**

设大初始容量（如预期峰值大小 / 0.75）能避免扩容，代价是"常驻内存占用高"——平时流量低时 CHM 占用几 GB 内存（空桶数组）。权衡：
1. **大促场景值得**——大促前一次性分配大数组（如 64GB 堆 × 1/4 = 16GB 给 CHM），避免大促时扩容卡顿。平时内存浪费可接受（大促机器本来就要多备）。
2. **配合弹性**——非大促时缩减 CHM 容量（重建小容量实例），大促前扩容。但这需要业务配合，复杂。
3. **替代方案**——用 Caffeine（maximumSize 固定，内部异步扩容对主线程影响小），彻底避免 CHM 的扩容 STW。供应链热点缓存推荐 Caffeine，CHM 适合"容量可控、不需要淘汰"的场景。

**Q：为什么不直接用 Collections.synchronizedMap 或 Hashtable，它们也是线程安全的 Map？**

性能差一个数量级：
1. **锁粒度粗**——`synchronizedMap` 锁整个 Map 对象，所有读写都串行；Hashtable 也是锁整个 this。CHM 锁单个桶，不同桶完全并行，并发度 = 桶数。
2. **读阻塞**——`synchronizedMap` 读也要锁（`synchronized(mutex)`），写时读阻塞。CHM 读完全无锁（volatile），读写不互相阻塞。
3. **并发扩容**——CHM 多线程协助迁移，`synchronizedMap` 扩容单线程。
所以高并发场景 CHM 是唯一选择，`synchronizedMap`/Hashtable 只适合极低并发（QPS < 100）的兼容场景。

### 第五层：验证与沉淀

**Q：你怎么证明 CHM 的使用没有性能瓶颈（桶锁竞争、扩容开销）？**

两个监控：
1. **桶分布监控**——定期采样 CHM 的桶链表长度分布（通过反射读 `table` 数组的 `Node.next` 链长度），统计 `max_bucket_size` 和 `avg_bucket_size`。max > 64 说明 hash 碰撞严重或没转树，要修 hash 或扩容。
2. **扩容频率**——`size()` 增长趋势，如果频繁翻倍（16→32→64→128），是初始容量设小了。监控 `transfer` 方法在 jstack 里的出现频率，> 1% 时间花在 transfer 说明扩容是瓶颈。

**Q：怎么让团队规范使用并发集合（CHM/Caffeine/AtomicXxx），而不是误用 HashMap/Hashtable？**

沉淀规范：
1. **Code Review 规则**——所有共享的 Map/List 必须用并发版本（CHM/CopyOnWriteArrayList），裸 `HashMap` 在多线程场景 CR 不通过。静态分析（SpotBugs）扫"HashMap 在多线程访问"报 high。
2. **缓存选型指南**——明确"需淘汰/TTL 用 Caffeine，不需淘汰用 CHM，单次请求上下文用 HashMap，全局共享禁用 HashMap"。文档给每种场景的示例代码。
3. **初始容量规范**——CHM 创建必须指定初始容量（`new ConcurrentHashMap<>(expectedSize / 3 * 4 + 1)`），禁止裸 `new ConcurrentHashMap<>()`（默认 16 容量易扩容），CR 检查。

## 结构化回答

**30 秒电梯演讲：** 高并发哈希表如何既线程安全又无锁瓶颈？简单说就是——JDK 8 的 ConcurrentHashMap 用"CAS+synchronized 桶锁"把锁粒度从 Segment（JDK 7）降到单个桶，读完全无锁（volatile）…。

**展开框架：**
1. **JDK 8** — JDK 8：CAS+synchronized 桶锁，锁粒度=单桶
2. **读无锁No** — 读无锁（Node val volatile）
3. **链表≥8 且** — 链表≥8 且容量≥64 转红黑树

**收尾：** 您看这块要不要再展开聊聊？

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：ConcurrentHashMap 原理？put 流程？ | 今天聊「ConcurrentHashMap 原理？put 流程？」。一句话：JDK 8 的 ConcurrentHashMap 用"CAS+synchronized 桶锁"把锁粒度从 Segme… | 开场钩子 |
| 0:12 | 代码片段 + 关键行高亮 | 要点是：JDK 8：CAS+synchronized 桶锁，锁粒度=单桶 | 核心概念 |
| 1:04 | 能力/参数拆解表 | 要点是：读无锁（Node val volatile） | 能力拆解 |
| 1:56 | 流程图：输入→处理→输出 | 要点是：链表≥8 且容量≥64 转红黑树 | 关键机制 |
| 3:00 | 总结卡 + 下期预告 | 记住核心要点就够了。下期见。 | 收尾 |
