---
id: ant-risk-005
difficulty: L2
category: jd-core
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
