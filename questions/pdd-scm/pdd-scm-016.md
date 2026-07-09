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
