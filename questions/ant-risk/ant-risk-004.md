---
id: ant-risk-004
difficulty: L3
category: ant-risk
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

## 苏格拉底式面试追问

> 这组追问不是背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：风控的实时特征缓存你用 ConcurrentHashMap 存 userId → UserRiskProfile，为什么不直接用 Redis？CHM 的本地缓存和 Redis 分布式缓存的选型依据是什么？**

实时风控决策链路 RT 预算 200ms，其中留给特征查询只有 30ms。Redis 单次 get 走网络 1-3ms（P99 可能 10ms+），一个决策要查几十个特征键，即使 pipeline 也要 5-10ms，且 Redis 抖动（主从切换、慢查询）会把 P99 拉到 50ms。CHM 是本地内存纳秒级访问，且 UserRiskProfile 是 Kafka 实时流订阅合并写入，读多写多但单机自治。决策依据不是"哪个好"，是 SLA——本地缓存 P99 <0.1ms，Redis P99 10ms，差 100 倍。所以我们用 CHM 做一级（毫秒以下），Redis 做二级兜底（CHM 未命中或冷启动时回源）。

### 第二层：证据与定位

**Q：风控服务 CPU 飙到 95%，但 QPS 没涨，你怎么确认是 CHM 的桶锁竞争还是别的？**

三组证据定位：
1. `arthas thread -n 5` 看最忙的 5 个线程——如果栈顶停在 `java.util.concurrent.ConcurrentHashMap.putVal` 且状态是 BLOCKED，且多个线程都在等同一个对象 monitor（`- parking to wait for <0x...>` 后面的地址相同），是桶锁竞争。
2. `jstack <pid> | grep -B1 "ConcurrentHashMap" | grep BLOCKED | wc -l`——统计阻塞在 CHM 的线程数，如果占比 >20%，锁定。
3. `arthas dashboard` 看 CPU 占比最高的方法——如果 `putVal` 或 `compute` 在火焰图里占比 >30%，确认是 CHM 写热点。进一步用 `arthas watch com.xxx.FeatureCache merge '{params, returnObj}' '#cost > 1'` 看是哪个 key 被疯狂写入。

### 第三层：根因深挖

**Q：你定位到是某个 key（比如 userId="SHARED_IP_LIST"）的桶锁竞争，几万 QPS 都在写同一个 key。根因是什么？为什么单 key 会这么热？**

根因是"共享热点 key"——所有用户的请求都去更新一个全局的"高风险 IP 列表"特征，几万 QPS 撞到 CHM 的同一个桶（hash 冲突到同一个 Node），synchronized 桶锁变成事实上的全局锁。这不是 CHM 的问题，是数据建模问题——把"用户维度"的特征和"全局维度"的特征混在一张 CHM 里，全局 key 天生是热点。验证方法：dump 一下 CHM 的 key 分布，`arthas ognl '@com.xxx.FeatureCache@profileCache.keySet().stream().collect(...)'` 看哪些 key 的写入频率异常（用 CounterCell 思路分桶计数）。

**Q：根因是热点 key，那为什么不直接把 CHM 换成 Caffeine（更高性能的本地缓存）？**

换 Caffeine 治不了病。Caffeine 用的是 W-TinyLFU 算法 + 异步维护，读路径确实更快，但写热点 key 时它的底层也是 ConcurrentHashMap，写同一个 key 一样要锁。工具换不动架构问题。正确做法是拆热点——把一个全局的 SHARED_IP_LIST key 拆成 N 个分片（SHARED_IP_LIST_0 到 SHARED_IP_LIST_15），写入时按 hash 分到不同桶，读取时合并 N 个分片。这样单 key 的 QPS 从几万降到几千，分散到 16 个桶，桶锁竞争消失。

### 第四层：方案权衡

**Q：你拆了 16 个分片后桶锁竞争降了，但读时要合并 16 个分片（RT 增加），怎么权衡？**

先量化代价。16 个分片读 CHM，单次 get 纳秒级，16 次也就几微秒，相比整个决策链路 30ms 的特征预算可忽略。真正要权衡的是"分片数 N"：N 太小（如 2）竞争还在，N 太大（如 256）内存浪费且合并成本上升。我们按"写入 QPS / 单桶安全 QPS"算——实测单桶 synchronized 在 5000 QPS 内 RT 不受影响，热点 key 写入 50000 QPS，所以 N = 50000/5000 = 10，取 16（2 的幂方便位运算分片）。合并读用 `Stream`/并行或直接 16 次顺序 get，P99 增加 <0.1ms，可接受。

**Q：为什么不直接用 LongAdder 那种 Cell 思路，把热点 key 的 value 内部做分片，而不是 key 分片？**

因为 value 不是计数器。LongAdder 分片有效是因为它的语义是"累加"，最终 sum 即可。但 UserRiskProfile 是一个复杂对象（IP 列表、设备列表、交易历史），不是可交换的数值，"分片后再合并"语义上要定义 merge 逻辑且不保证强一致（分片间可能读到不同时刻的值）。key 分片则每个分片是完整独立的 value，读时合并 16 个独立快照语义清晰。对于纯计数场景（如请求计数）我们确实用 LongAdder，但结构化数据用 key 分片。

### 第五层：验证与沉淀

**Q：你怎么证明热点 key 拆分后桶锁竞争真的消除，CPU 真的降了？**

上线前后双指标对比：
1. CPU 对比——Prometheus 拉 `process_cpu_usage`，分片前 P95=95%、分片后 P95=60%，且 QPS 没变（用 `feature_query_qps` 归一化），CPU/QPS 比值下降 35%，证明是竞争减少省下的 CPU（不是流量降）。
2. 锁等待对比——arthas 在峰值时段 `profiler start` 采样 60 秒，`profiler stop --format flame` 生成火焰图，对比分片前后 `putVal → synchronized` 的 CPU 采样占比（从 35% 降到 3%），直接看到锁等待消失。同时 `arthas thread --state BLOCKED` 看 BLOCKED 线程数峰值从 50 降到 2。

**Q：怎么让团队以后不再把全局热点 key 塞进 CHM？**

沉淀成机制：
1. Code Review 规则——所有 CHM 的 key 必须是"实体维度"（userId、deviceId、orderId），全局/共享维度的 key 必须用独立的单线程更新结构（如 AtomicReference + 定时刷新），不能进高并发 CHM。
2. 静态扫描——写一个 SpotBugs 插件，扫描 `@SharedGlobal` 注解的字段是否被用作 CHM 的 key，命中即告警。
3. 运行时监控——给 CHM 加一个 wrapper，统计每个 key 的 put 频率（用 sampled counter，只采 1% 避免性能损耗），任何 key 的 QPS > 全表平均 QPS 的 10 倍即告警"疑似热点 key"。
4. 故障复盘——把这次"SHARED_IP_LIST 单 key 几万 QPS → 桶锁竞争 → CPU 95%"的火焰图和 arthas 截图存入知识库，作为"数据建模要区分实体维度和全局维度"的典型案例。


## 结构化回答

**30 秒电梯演讲：** 聊到ConcurrentHashMap 在 JDK7 和 J，我的理解是——ConcurrentHashMap 用"分段锁(JDK7)/CAS+synchronized 桶锁(JDK8+)"把整把大锁拆成桶级小锁，让多线程并发读写不同桶几乎无冲突。打个比方，ConcurrentHashMap 像一个有多排储物柜的仓库，JDK7 是按"区(Segment)"加锁，JDK8 是按"单个柜子(Node)"加锁——锁粒度越细，并发度越高。

**展开框架：**
1. **JDK7** — Segment[] + HashEntry[]，默认 16 个 Segment（并发度 16）
2. **JDK8** — Node[] + CAS+synchronized，锁粒度=单个桶
3. **桶链表长度 ≥8 且数组 ≥64 时** — 桶链表长度 ≥8 且数组 ≥64 时转红黑树（查找 O(n)→O(logn)）

**收尾：** 这块我在项目里也踩过坑——想深入的话，可以接着聊：为什么 JDK8 放弃分段锁？您更想看哪个方向？

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡 | "ConcurrentHashMap 在 JDK7 和——这道题面试官到底想考什么？我用 30 秒给你讲透。" | 开场钩子 |
| 0:15 | CAS 原理图 | 先说核心：ConcurrentHashMap 用"分段锁(JDK7)/CAS+synchronized 桶锁(JDK8+)"把整把大锁拆成桶级小锁，让多线程并发读写不同桶几乎无冲突。 | 核心定义 |
| 0:40 | ConcurrentHashMap 结构图 | Node[] + CAS+synchronized，锁粒度=单个桶。 | JDK8 |
| 1:05 | HashMap 数组+链表图 | 桶链表长度 ≥8 且数组 ≥64 时转红黑树（查找 O(n)→O(logn)）。 | 桶链表长度 ≥8 且数组 ≥64 时 |
| 2:30 | 总结卡 | 一句话记忆：JDK7 Segment 分段锁，JDK8 CAS+synchronized 桶锁。 下期可以接着聊：为什么 JDK8 放弃分段锁。 | 收尾总结 |
