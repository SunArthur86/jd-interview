---
id: ant-risk-005
difficulty: L2
category: ant-risk
subcategory: Java 集合
tags:
- 蚂蚁
- 风控
- HashMap
- 红黑树
- 扩容
feynman:
  essence: HashMap 用"哈希函数定位桶 + 链表/红黑树处理冲突 + 阈值触发扩容"，把平均查找从 O(1) 到 O(logn) 之间动态平衡。
  analogy: HashMap 像一个分书架的图书馆：书号哈希到某个书架（桶），同架的排成链表，链太长就改成二叉查找（红黑树），架太挤就再加一排架子（扩容）。
  first_principle: 哈希表的本质是"用空间换时间"——预分配数组让平均查找 O(1)，但需要应对冲突（链表/树）和扩容（保持低负载因子）两个成本。
  key_points:
  - 默认初始容量 16，负载因子 0.75，阈值 = 容量×负载因子
  - 桶下标 = (n-1) & hash（位运算替代取模，前提 n 是 2 的幂）
  - 链表长度 ≥8 且容量 ≥64 转红黑树；≤6 退化链表
  - 扩容翻倍，JDK8 用"高位bit判定"决定迁移到原位 or 原位+oldCap
  - 扰动函数：(h ^ (h>>>16)) 让高位也参与低位运算，减少冲突
first_principle:
  problem: 给定有限内存，如何让任意 key 的平均查找/插入复杂度趋近 O(1)？
  axioms:
  - 哈希函数能将 key 均匀分散到 [0, n)
  - 负载因子（元素数/桶数）越高冲突越剧烈
  - 数组随机访问 O(1)，链表/树查找 O(k)
  rebuild: 用数组（桶）+ 冲突链表（或红黑树兜底）+ 自动扩容（保持负载因子），让查询 = O(1) 哈希 + O(短) 链表遍历 ≈ O(1)。
follow_up:
- 为什么容量必须是 2 的幂？——让 (n-1)&hash 等价于 hash%n 且更快；扩容时迁移也只可能去原位或原位+oldCap
- JDK7 多线程 HashMap 死循环怎么来的？——扩容用头插法，并发下链表成环，get 时死循环；JDK8 改尾插解决了成环但仍非线程安全
- 负载因子为什么是 0.75？——时间和空间折中：低了浪费空间，高了冲突多；泊松分布下 0.75 让平均链长 ≈ 0.5
memory_points:
- 容量 16 / 负载 0.75 / 阈值 12（16×0.75）触发扩容到 32
- 桶定位：(n-1) & hash，n 必须是 2 的幂
- 扰动函数：高 16 位异或低 16 位，让高位影响桶分布
- 扩容翻倍迁移：原位 or 原位+oldCap（用 hash 的高一位判定）
---

# 【蚂蚁风控】HashMap 的底层原理？扩容机制？为什么初始容量要预估？

> JD 依据："基础功底扎实"。HashMap 是 Java 工程师的"内功"，风控的特征聚合、规则匹配都用。

## 一、表面层：HashMap 的数据结构

JDK8 的 HashMap 是 **数组 + 链表 + 红黑树**：

```
table[] (Node 数组，长度始终是 2 的幂)
  │
  ├─[0] → null
  ├─[1] → Node → Node → Node        (链表，长度<8)
  ├─[2] → null
  ├─[3] → TreeNode (红黑树，长度≥8 且容量≥64)
  ...
  └─[n-1] → Node
```

**Node 结构**：
```java
class Node<K,V> {
    final int hash;
    final K key;
    V value;
    Node<K,V> next;
}
```

## 二、哈希层：扰动函数与桶定位

**扰动函数**（让高位参与运算）：
```java
static final int hash(Object key) {
    int h;
    return (key == null) ? 0 : (h = key.hashCode()) ^ (h >>> 16);
}
```
- 把高 16 位异或到低 16 位
- 目的：在桶下标用 `(n-1) & hash` 时（n 较小时只有低位参与），让高位也影响桶分布，减少冲突

**桶下标**：`(n - 1) & hash`
- n 是 2 的幂 → n-1 的二进制全是 1（如 16-1=1111）
- 位与等价于 `hash % n`，但快得多

## 三、put 流程（JDK8）

```java
public V put(K key, V value) {
    int hash = hash(key);
    int i = (n - 1) & hash;        // 桶下标
    Node<K,V> f = table[i];

    // ① 桶空：直接放
    if (f == null) table[i] = newNode(hash, key, value, null);
    // ② 桶非空
    else {
        // 头节点 key 相等：覆盖
        // 否则：链表尾插 / 红黑树插入
        // 链表长度 ≥8：treeifyBin（容量<64 时先扩容，≥64 才转树）
    }
    if (++size > threshold) resize();  // 超阈值扩容
}
```

## 四、扩容机制（精华）

**触发时机**：`size > capacity × loadFactor`（默认 > 容量×0.75）

**扩容动作**：
1. 创建新数组，容量翻倍（`newCap = oldCap << 1`）
2. 把旧数组每个桶的元素迁移到新数组

**JDK8 的高效迁移**（精华）：
对每个桶，元素的桶下标只有两种可能：
- **原位**：`newHash & (newCap-1)` 高位 bit = 0 → 还在原下标
- **原位 + oldCap**：高位 bit = 1 → 下标 = 原下标 + 旧容量

判定方法：`if ((e.hash & oldCap) == 0) 原位 else 原位+oldCap`

```java
// 把一条链按"高位bit"拆成两条，分别放原位和原位+oldCap
Node<K,V> loHead = null, hiHead = null;
for (Node<K,V> e = oldBucket; e != null; e = e.next) {
    if ((e.hash & oldCap) == 0) {
        // 低位链（还在原位）
    } else {
        // 高位链（去原位+oldCap）
    }
}
```

对比 JDK7 的 `rehash`（每个元素重新算 hash），JDK8 只看一个 bit，O(n) 不变但常数小。

## 五、JDK7 并发死循环（必考）

JDK7 扩容用**头插法**，多线程下会形成环：
```
线程A: 迁移节点1，next 指向节点2
线程B: 同时迁移，头插节点2 → 节点1 → 节点2 (环!)
```
后续 get 遍历到环 → 死循环 → CPU 100%。

**JDK8 改尾插解决了成环**，但仍**非线程安全**（多线程 put 可能丢数据、size 不准）。并发必须用 `ConcurrentHashMap`。

## 六、初始容量预估（实战要点）

HashMap 第一次 put 时才初始化数组（默认 16）。如果预先知道要放 N 个元素，应该：
```java
// 想放 1000 个元素，不希望触发扩容
int cap = (int) (1000 / 0.75) + 1;   // 1334
Map<String, String> map = new HashMap<>(cap);  // 自动向上取最近的 2 的幂 = 2048
```

**风控场景**：聚合 10 万用户的特征，预估容量可避免 4-5 次扩容（每次 O(n) 迁移）。

## 七、负载因子为什么是 0.75

- 太小（如 0.5）：空间浪费（一半桶空），但冲突少
- 太大（如 1.0）：空间省，但冲突多（链表长）
- 0.75 是**时间-空间折中**，且让平均链长约 0.5（泊松分布）

源码注释：在负载因子 0.75 下，桶内节点数 ≥8 的概率是 0.00000006（泊松分布 λ=0.5），所以红黑树退化几乎不发生。

## 八、底层本质：哈希表的"空间-时间"权衡

哈希表是计算机科学里"空间换时间"的最经典案例：
- **空间**：预分配数组，负载因子 < 1 意味着总有空桶
- **时间**：O(1) 哈希定位 + O(短) 冲突处理 ≈ O(1) 平均

但这个 O(1) 是**期望值**，最坏 O(n)（所有 key 冲突）。JDK8 加红黑树把最坏从 O(n) 降到 O(logn)，是"用一点空间换最坏性能保底"。

**和 ConcurrentHashMap 的关系**：HashMap 加锁 → Hashtable（全表锁）→ CHM 分段锁 → CHM 桶锁，是"在 O(1) 基础上叠加并发度优化"的演进。

## 常见考点
1. **HashMap 和 Hashtable 区别**？——HashMap 非线程安全、允许 null key/value、默认容量 16；Hashtable 线程安全（全表锁）、不允许 null、默认 11。
2. **hashCode 相等一定 equals 吗**？——不一定（哈希冲突）。HashMap 用 hashCode 定位桶，equals 判定 key 是否相等。
3. **自定义对象做 key 要注意什么**？——必须同时重写 hashCode 和 equals，且"equals 相等的对象 hashCode 必须相等"（契约）。

**代码示例**（自定义 key 的契约）：
```java
class UserId {
    final long id;
    public boolean equals(Object o) { return o instanceof UserId && ((UserId)o).id == id; }
    public int hashCode() { return Long.hashCode(id); }  // 必须和 equals 一致
}
```

## 苏格拉底式面试追问

> 这组追问不是背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：风控的特征聚合里你用 HashMap 预聚合 10 万用户的特征，初始容量你设了 262144（2^18）。为什么不直接 new HashMap<>() 让它自己扩容？预估容量的依据是什么？**

因为默认初始容量 16，放 10 万元素会触发约 13 次扩容（16→32→...→131072→262144），每次扩容都是 O(n) 的 rehash——把所有元素重新定位到新桶。13 次扩容累计迁移上百万元素次，在风控的实时聚合链路（每分钟跑一次）里会产生明显的 GC 压力和 STW。预估容量的依据是"目标元素数 / 负载因子 + 1"：100000/0.75 = 133333，HashMap 构造函数会向上取 2 的幂 = 262144，一次到位零扩容。代价是预占 262144 × 4字节（引用）= 1MB 桶数组，对 8G 堆微不足道。

### 第二层：证据与定位

**Q：你怎么证明"默认扩容"真的拖慢了聚合任务？你怎么观测到扩容的代价？**

两组证据：
1. JFR（Java Flight Recorder）采样——`jcmd <pid> JFR.start duration=60s filename=agg.jfr`，用 JDK Mission Control 打开，看 "Memory Allocation" 里 `java.util.HashMap$Node[]` 的分配大小。如果聚合任务每分钟产生 1G+ 的 HashMap 桶数组分配（16→32→...→262144 各一次），且GC 日志（`-Xlog:gc*`）显示每次扩容后紧跟着一次 Young GC，扩容代价实锤。
2. arthas trace——`trace com.xxx.FeatureAggregator aggregate '#cost>100'`，看 aggregate 方法内部的耗时，如果 `HashMap.resize` 占了 30%+，直接定位。更细可以用 `trace java.util.HashMap resize` 看 resize 单次耗时（10 万元素一次 resize 约 10-30ms，13 次累计 200ms+）。

### 第三层：根因深挖

**Q：你预估了容量，但线上还是出现 CPU 偶发飙高，jstack 发现卡在 HashMap.get 上。容量已经够大为什么 get 还会慢？**

容量够不代表没冲突。get 慢有两种根因：
1. 看卡住的栈是否在 `TreeNode.find`——如果桶里是红黑树，说明某个桶链表已经长到 8 转树了。但容量 262144 放 10 万元素，平均每桶 0.4 个元素，转树概率极低。如果真的转树，要查 hashCode 分布——用 arthas ognl 看这个 map 的桶分布：`ognl '@com.xxx.FeatureAggregator@map' -x 1` dump 出来，统计非空桶的链表长度分布。如果某几个桶链长 100+，说明 key 的 hashCode 实现有问题（大量冲突）。
2. 看 key 的 hashCode 实现——风控的 key 是 UserId（long id），`Long.hashCode(id)` 是 `(int)(id ^ (id>>>32))`，如果 id 是自增的连续值，低位变化但高位不变，在桶下标 `(n-1) & hash`（低位运算）时容易扎堆。根因可能是 hashCode 实现没做好分散。

**Q：根因是 hashCode 实现差导致冲突，那为什么不直接换一个哈希函数？为什么 HashMap 的扰动函数没有解决？**

HashMap 的扰动函数 `(h ^ (h>>>16))` 只把高 16 位异或到低 16 位，对 Long 的 hashCode 来说，它处理的是 `int` 的 32 位，Long 的 hashCode 已经是 `(int)(id ^ (id>>>32))` 把高低位混合过了，但混合后的低位仍然偏向"连续值"。换哈希函数（如用 MurmurHash3 或给 id 乘一个质数再取 hashCode）确实能改善，但 HashMap 的扰动函数设计假设了"用户给的 hashCode 是合理分散的"，它做的是兜底而非根治。更稳妥的做法是在构造 key 时就保证 hashCode 质量——比如用 String key（String 的 hashCode 是 31 倍累加，对数字字符串分散性好），或给 UserId 加一层 hash 散列。

### 第四层：方案权衡

**Q：你换了哈希函数冲突降了，但业务说换 key 结构成本高。有没有不换 key 的方案？为什么不用 TreeMap 或跳表？**

有更轻的方案：换 LinkedHashMap 或调负载因子。但要看根因——如果是少数热点桶冲突（10 万元素里只有 100 个扎堆），换数据结构是过度设计，不如直接给冲突的桶接受 O(k) 查找。TreeMap 是红黑树，所有操作 O(logn)，但要求 key 可比较，且常数比 HashMap 大（每次比较开销 vs 哈希一次），对 10 万元素的平均查找 HashMap 是 O(1) 纳秒级，TreeMap 是 O(logn) 微秒级，整体更慢。跳表（ConcurrentSkipListMap）同理。所以权衡是：如果冲突只在少数桶，接受它（即使转树也是 O(log8)≈3 次比较）；如果全表性冲突（哈希函数系统性差），才考虑换哈希或换结构。

**Q：为什么不直接把 HashMap 换成 ConcurrentHashMap？至少线程安全。**

因为这里是单线程聚合（一个聚合任务线程内用），没有并发访问。换成 CHM 会多 CAS 和 volatile 读的开销（即使无竞争，CHM 的 tabAt 用 Unsafe 的 volatile 语义比 HashMap 的普通数组读慢约 3-5 倍）。用错了工具反而降性能。CHM 的价值在并发场景，单线程场景 HashMap 是最快的。工具选择要先回答"有没有并发"，不能盲目追求"更高级"的容器。

### 第五层：验证与沉淀

**Q：你怎么证明换了哈希函数后冲突真的降了？怎么量化"冲突率"？**

定义并测量"桶链长分布"作为冲突率指标：
1. 写一个诊断工具——在非生产环境，用真实 10 万 userId 构造 HashMap，然后反射读取 table 数组，统计每个非空桶的链表长度，输出直方图：`[1]: 60000, [2]: 5000, [3-7]: 200, [8+]: 5`。换哈希前如果 [8+] 有 1000 个桶（即 1000 个桶链长超 8），换哈希后降到 <10 个，冲突显著改善。
2. 线上用 arthas 在低峰期 `ognl '@com.xxx.FeatureAggregator@map' -x 2 --hashCode` 采一次真实 map 的桶分布（注意 ognl 会持锁，必须在低峰），对比桶链长的 P99——从改善前的 P99=8（转树边界）降到改善后的 P99=2。
3. 同时看 `TreeNode.find` 在火焰图里的占比——改善后应该从 5% 降到 <0.1%。

**Q：怎么让团队所有 HashMap 使用都做好容量预估和 key 设计？**

沉淀成规范和工具：
1. Code Review 规则——凡是已知元素数的 HashMap（如 `new HashMap<>()` 后立刻循环 put），必须用 `HashMap.newHashMap(expectedSize)`（JDK 19+）或手动算 `(int)(n/0.75)+1` 预估容量；size 未知的小 Map 才允许默认。
2. 自定义 key 规范——任何做 HashMap key 的自定义类，hashCode 实现必须做单元测试：用 10 万个连续 id 构造 Map，断言最长桶链 < 5。CI 强制跑。
3. 运行时诊断——给核心 Map 加一个"桶分布"的定期采样（每 10 分钟 dump 一次桶链长直方图上报 Prometheus），`hashmap_max_bucket_depth` 指标告警阈值 8。
4. 故障复盘——把这次"Long.hashCode 连续 id 冲突 → get 慢 → CPU 飙高"的桶分布直方图和 jstack 截图存知识库，作为"key 设计要考虑 hashCode 分布"的案例。


## 结构化回答

**30 秒电梯演讲：** 聊到HashMap 的底层原理？扩容机制？为什么初始容量要预估，我的理解是——HashMap 用"哈希函数定位桶 + 链表/红黑树处理冲突 + 阈值触发扩容"，把平均查找从 O(1) 到 O(logn) 之间动态平衡。打个比方，HashMap 像一个分书架的图书馆：书号哈希到某个书架（桶），同架的排成链表，链太长就改成二叉查找（红黑树），架太挤就再加一排架子（扩容）。

**展开框架：**
1. **默认初始容量 16** — 默认初始容量 16，负载因子 0.75，阈值 = 容量×负载因子
2. **桶下标 = (n-1)** — 桶下标 = (n-1) & hash（位运算替代取模，前提 n 是 2 的幂）
3. **链表长度 ≥8 且容量 ≥64 转红黑树** — 链表长度 ≥8 且容量 ≥64 转红黑树；≤6 退化链表

**收尾：** 这块我在项目里也踩过坑——想深入的话，可以接着聊：为什么容量必须是 2 的幂？您更想看哪个方向？

## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡 | "HashMap 的底层原理——这道题面试官到底想考什么？我用 30 秒给你讲透。" | 开场钩子 |
| 0:15 | HashMap 数组+链表图 | 先说核心：HashMap 用"哈希函数定位桶 + 链表/红黑树处理冲突 + 阈值触发扩容"，把平均查找从 O(1) 到 O(logn) 之间动态平衡。 | 核心定义 |
| 0:30 | 概念结构示意图 | 桶下标 = (n-1) & hash（位运算替代取模，前提 n 是 2 的幂）。 | 桶下标 = (n-1) |
| 1:30 | 总结卡 | 一句话记忆：容量 16 / 负载 0.75 / 阈值 12（16×0.75）触发扩容到 32。 下期可以接着聊：为什么容量必须是 2 的幂。 | 收尾总结 |
