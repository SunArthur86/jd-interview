---
id: ant-risk-004
difficulty: L3
category: jd-core
subcategory: Java 并发
tags:
- 蚂蚁
- 风控
- 并发
- ConcurrentHashMap
- CAS
- 红黑树
feynman:
  essence: ConcurrentHashMap 用"分段锁(JDK7)/CAS+synchronized 桶锁(JDK8+)"把整把大锁拆成桶级小锁，让多线程并发读写不同桶几乎无冲突。
  analogy: ConcurrentHashMap 像一个有多排储物柜的仓库，JDK7 是按"区(Segment)"加锁，JDK8 是按"单个柜子(Node)"加锁——锁粒度越细，并发度越高。
  first_principle: 哈希表里不同桶天然独立，把锁粒度从"整张表"降到"单个桶"，冲突概率从全表并发降到哈希冲突概率，吞吐线性扩展。
  key_points:
  - JDK7：Segment[] + HashEntry[]，默认 16 个 Segment（并发度 16）
  - JDK8：Node[] + CAS+synchronized，锁粒度=单个桶
  - 桶链表长度 ≥8 且数组 ≥64 时转红黑树（查找 O(n)→O(logn)）
  - 并发扩容：多线程协助迁移 transfer
  - size 用 CounterCell 数组分片计数避免单点竞争
first_principle:
  problem: 怎么让一个全局哈希表在高并发下既线程安全又不让锁成为瓶颈？
  axioms:
  - 不同哈希桶逻辑独立，互不影响
  - 哈希冲突是低概率事件（好哈希函数下）
  - CAS 适合低竞争，synchronized 适合中高竞争（JDK6 后优化）
  rebuild: 把锁从"表级"细化到"桶级"——读无锁（volatile），写 CAS+synchronized 单桶；扩容时多线程协助；size 用分片计数。冲突激烈时退化为红黑树保 O(logn)。
follow_up:
- 为什么 JDK8 放弃分段锁？——Segment 占内存，且并发度固定 16 无法扩展；CAS+桶锁并发度=桶数，更细
- put 时桶为空怎么处理？——CAS 写入头节点，失败自旋重试
- size 为什么不准？——统计时可能正在 put，是弱一致；但 CounterCell 分片计数已优化
memory_points:
- JDK7 Segment 分段锁，JDK8 CAS+synchronized 桶锁
- 8→红黑树阈值链表长度，6→退化阈值（避免反复转换抖动）
- 读完全无锁（Node val 用 volatile），写只锁单个桶头节点
- 扩容是并发的：发现扩容中帮迁移，迁移完一起扩 next
---

# 【蚂蚁风控】ConcurrentHashMap 在 JDK7 和 JDK8 的实现差异？put 流程是怎样的？

> JD 依据："高并发数据隔离"。风控的实时特征存储、规则缓存都是高并发读写场景，CHM 是必考。

## 一、表面层：为什么需要 ConcurrentHashMap

| 实现 | 线程安全方式 | 问题 |
|------|------------|------|
| `HashMap` | 不安全 | 并发 put 可能死循环（JDK7 扩容成环）、数据丢失 |
| `Hashtable` | 整表 synchronized | 性能差（一把大锁） |
| `Collections.synchronizedMap` | 包装 + 单锁 | 同上 |
| **ConcurrentHashMap** | 分段/桶级锁 | **高并发优解** |

## 二、JDK7 实现：分段锁（Segment）

```
ConcurrentHashMap
    │
    ├─ Segment[] (默认 16 个，继承 ReentrantLock)
    │      │
    │      └─ HashEntry[] (每个 Segment 内的桶数组)
    │              │
    │              └─ HashEntry 链表
```

- **并发度 = Segment 数**（默认 16，构造时可改但一旦创建不可变）
- **put**：先 hash 定位 Segment（tryLock 抢锁），再 hash 定位 HashEntry 链表头插
- **get**：HashEntry 的 val 是 volatile，无锁读
- **缺点**：Segment 数固定，并发度上限低；Segment 对象占内存

## 三、JDK8 实现：CAS + synchronized 桶锁（重点）

```
ConcurrentHashMap
    │
    └─ Node[] table (桶数组)
           │
           └─ 每个桶头节点用 synchronized 锁定
                  │
                  ├─ Node 链表 (长度<8)
                  └─ TreeBin 红黑树 (长度≥8 且容量≥64)
```

**put 流程**（源码级）：
```java
final V putVal(K key, V value, boolean onlyIfAbsent) {
    int hash = spread(key.hashCode());
    for (Node<K,V>[] tab = table;;) {
        Node<K,V> f; int n, i, fh;
        // ① 桶为空：CAS 写入头节点
        if ((f = tabAt(tab, i = (n - 1) & hash)) == null) {
            if (casTabAt(tab, i, null, new Node<>(hash, key, value, null)))
                break;
        }
        // ② 桶头是 ForwardingNode（扩容中）：协助扩容
        else if ((fh = f.hash) == MOVED)
            tab = helpTransfer(tab, f);
        // ③ 桶非空：synchronized 锁头节点，链表/树中 put
        else {
            synchronized (f) {
                if (tabAt(tab, i) == f) {       // 二次检查防并发修改
                    if (fh >= 0) {               // 链表
                        // 遍历链表，存在则更新，不存在尾插
                    } else {                     // TreeBin 红黑树
                        // 红黑树插入
                    }
                }
            }
            if (binCount >= TREEIFY_THRESHOLD - 1)
                treeifyBin(tab, i);              // 链表长度≥8 转树
            break;
        }
    }
    addCount(1L, binCount);                       // CounterCell 分片计数
    return null;
}
```

**get 流程**（无锁）：
- Node 的 val 和 next 是 volatile，读不需要加锁
- 扩容时旧表和新表都可见（ForwardingNode 转发到新表）

## 四、关键设计：红黑树退化

链表过长（哈希冲突严重）会退化成红黑树：
- **链表 → 树**：长度 ≥ 8 **且** 数组容量 ≥ 64（否则先扩容）
- **树 → 链表**：长度 ≤ 6

**为什么是 8**：泊松分布下，桶内节点数 ≥ 8 的概率约 0.00000006，几乎不会发生；发生说明哈希函数差，转树兜底性能。

## 五、并发扩容：多线程协助

JDK8 的精华：扩容是**多线程协作**的。

```
线程1 发起扩容 → 创建 nextTable(2倍)
   │
   ├─ 线程1 迁移桶 [0, stride)
   ├─ 线程2 put 时发现扩容，迁移桶 [stride, 2*stride)
   └─ 线程3 get 时发现扩容，迁移桶 [2*stride, 3*stride)
   ...
迁移完一个桶就把旧桶头节点置为 ForwardingNode（hash=MOVED）
```

每个线程领一段（stride，最小 16）桶迁移，迁移完 CAS 推进 transferIndex。这让单线程的扩容瓶颈变成多核并行。

## 六、size 的弱一致性

JDK8 用 `CounterCell[]`（仿 LongAdder）分片计数：
- put 时 CAS 选一个 Cell +1（避免单 baseCount 竞争）
- size = baseCount + Σ Cell.value

仍是**弱一致**（统计瞬间有 put 进行中），但接近准确且不阻塞。

## 七、风控实战

**场景：实时特征存储**
风控每个用户有一份风险特征（几百个字段），高并发读写：
```java
// 全局缓存：userId → 用户风险画像
private final ConcurrentHashMap<String, UserRiskProfile> profileCache = new ConcurrentHashMap<>();

// 多线程并发刷新（来自 Kafka 实时特征流）
profileCache.compute(userId, (k, old) -> mergeProfile(old, newFeatures));
// compute 是原子的（桶锁内执行 lambda），避免 read-modify-write 竞争
```

**避坑：不要用 size 判等**
```java
// ❌ 错：size 是弱一致，且每次扫所有 Cell
if (map.size() < threshold) map.put(k, v);  // 检查和使用之间有 TOCTOU

// ✅ 对：用 AtomicLong 单独计数
AtomicLong counter = new AtomicLong();
if (counter.incrementAndGet() <= threshold) map.put(k, v);
```

## 八、底层本质：锁粒度优化

CHM 的演进本质是**锁粒度从粗到细**：
- JDK7 Segment 锁：粒度 = 段（16 段，并发度 16）
- JDK8 桶锁：粒度 = 单桶（并发度 = 桶数，默认 16，扩容后翻倍）

这背后是"冲突概率随锁粒度减小而指数下降"——把一把锁拆成 N 把，理论上吞吐能 N 倍（前提是访问均匀）。

**为什么不直接用 HashMap + synchronized 全表锁**：因为 JDK7 之后 synchronized 升级到重量级锁的开销大（用户态→内核态），而 CHM 让 99% 的写操作只锁单桶，99% 的桶无竞争，相当于无锁。

## 常见考点
1. **JDK8 为什么用 synchronized 而不是 ReentrantLock**？——JDK6 后 synchronized 优化（偏向/轻量级锁）性能不输 ReentrantLock，且内存占用少（少一个 AQS 对象）；锁粒度细到桶级后竞争低，synchronized 足够。
2. **computeIfAbsent 死锁**？——JDK9 之前 computeIfAbsent 在 lambda 内再操作同一个 map 会自死锁（递归持锁）。
3. **并发 put 会丢数据吗**？——不会，每次 put 在桶锁内完成，二次检查防 ABA。

**代码示例**（compute 的原子性价值）：
```java
// ❌ 非原子，并发下可能覆盖
UserRiskProfile old = map.get(uid);
map.put(uid, merge(old, delta));

// ✅ 原子的 compute
map.compute(uid, (k, old) -> merge(old, delta));
```
