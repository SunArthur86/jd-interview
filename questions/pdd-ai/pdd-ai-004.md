---
id: pdd-ai-004
difficulty: L3
category: pdd-ai
subcategory: Java 集合
tags:
- 拼多多
- AI 中台
- Java 集合
- HashMap
- ConcurrentHashMap
- 特征存储
feynman:
  essence: HashMap 是"用哈希函数把 key 映射到桶数组"，O(1) 读写；中台存特征/路由表/缓存大量用 Map，必须懂扩容/树化/并发安全。
  analogy: 像图书馆按书名首字母分书架——找书时算首字母直奔书架（哈希），书架满了（扩容）就再开一排，同字母书太多就细分（链表转树）。
  first_principle: 数组是 O(1) 索引但 key 必须是整数；哈希把任意 key 变整数下标，结合链表/红黑树解决冲突。
  key_points:
  - 哈希桶 + 链表/红黑树（≥8 转树，≤6 退链）
  - 扩容：负载因子 0.75，超阈值翻倍重哈希
  - 1.7 头插死循环，1.8 尾插 + 红黑树
  - 线程安全：HashTable（弃）/Collections.sync（包装）/ConcurrentHashMap（推荐）
first_principle:
  problem: 如何用任意 key 快速存取 value？
  axioms:
  - 数组按下标 O(1) 访问
  - 哈希函数把 key 变下标
  - 不同 key 可能哈希冲突
  rebuild: 桶数组 + 哈希函数 + 冲突处理（链表/树）+ 动态扩容。
follow_up:
  - HashMap 链表为什么转红黑树？——冲突长链 O(n) 退化成 O(logn)
  - 扩容为什么翻倍？——保证容量为 2 的幂，位运算代替取模
  - ConcurrentHashMap 1.7 vs 1.8？——1.7 分段锁，1.8 锁桶头 + CAS + 红黑树
memory_points:
  - 桶 + 链表/树（≥8 转树）
  - 负载因子 0.75，2 倍扩容
  - 1.8 尾插 + 红黑树（防退化/死循环）
  - 并发用 ConcurrentHashMap
---

# 【拼多多 AI 中台】HashMap 原理与中台特征存储怎么用？

> JD 依据："Java + NoSQL、特征平台"。

## 一、HashMap 数据结构

```
table[] (Node 数组，长度=2^n)
  ┌─────┐
  │  0  │ → null
  ├─────┤
  │  1  │ → Node(k1,v1) → Node(k2,v2) → null（链表）
  ├─────┤
  │  2  │ → TreeNode（红黑树，链长 ≥8 且容量 ≥64）
  ├─────┤
  │ ... │
  └─────┘
```

**关键参数**：
- 初始容量 16，负载因子 0.75
- 阈值 = 容量 × 负载因子（12）
- 树化阈值：链表 ≥8 且 table 容量 ≥64
- 退树阈值：节点 ≤6

## 二、put 流程

```
1. hash(key) = (h = key.hashCode()) ^ (h >>> 16)  扰动减少冲突
2. 下标 = (n-1) & hash   （n 为 2 的幂时等价于取模）
3. 桶为空 → 直接放
4. 桶非空：
   - key 相等（== 或 equals）→ 覆盖
   - 不等 → 链表尾插（1.8）/构建树
5. 链长 ≥8 且容量 ≥64 → 树化
6. size > 阈值 → 扩容（2 倍 + 重哈希）
```

## 三、扩容机制

```
容量翻倍（16 → 32 → 64）
重哈希：原链表拆成两条（hash & oldCap == 0 留原位，否则放原位+oldCap）
JDK 1.8 优化：高位链/低位链，不用重算每个 hash
```

**为什么是 2 的幂**：`(n-1) & hash` 比 `%` 快（位运算 vs 除法），且扩容时拆链高效。

## 四、线程安全问题

| 问题 | 原因 |
|------|------|
| 1.7 死循环 | 头插 + 扩容并发，链表成环，get 死循环 100% CPU |
| 1.8 数据丢失 | 并发 put 覆盖 |
| size 不准 | 计数非原子 |

**线程安全方案**：
- `Hashtable`：全锁，已弃用
- `Collections.synchronizedMap`：包装锁，性能差
- `ConcurrentHashMap`：推荐，CAS + 锁桶

## 五、ConcurrentHashMap 1.8 实现

```java
// put 简化
final V putVal(K key, V value, boolean onlyIfAbsent) {
    int hash = spread(key.hashCode());
    for (Node<K,V>[] tab = table;;) {
        Node<K,V> f; int n, i, fh;
        if (tab == null || (n = tab.length) == 0)
            tab = initTable();                    // CAS 初始化
        else if ((f = tabAt(tab, i = (n - 1) & hash)) == null) {
            if (casTabAt(tab, i, null, new Node<>(hash, key, value)))
                break;                            // CAS 放空桶（无锁）
        } else if ((fh = f.hash) == MOVED)
            tab = helpTransfer(tab, f);           // 协助扩容
        else {
            synchronized (f) {                    // 锁桶头节点
                // 链表/树插入
            }
        }
    }
    addCount(1L, binCount);                       // 用 LongAdder 思路计数
    return null;
}
```

**关键**：空桶 CAS 无锁、非空桶 synchronized 锁单个桶、size 用分段计数（baseCount + CounterCell[]）。

## 六、中台特征存储实战

**特征平台**：用户/商品实时特征读写，高并发。
```java
// 用户特征缓存（ConcurrentHashMap）
ConcurrentHashMap<String, UserFeature> FEATURE_CACHE = new ConcurrentHashMap<>(1 << 20);

// 读（无锁，亿级 QPS 友好）
UserFeature f = FEATURE_CACHE.get(uid);

// 原子更新（computeIfAbsent/merge/replace）
FEATURE_CACHE.merge(uid, defaultFeat, (old, def) -> old.incr());

// 定期清理（避免内存膨胀）
FEATURE_CACHE.forEach(1000, (k, v) -> {
    if (v.isExpired()) FEATURE_CACHE.remove(k);
});
```

**避坑**：
- 别用 HashMap 做多线程共享缓存
- 大 Map 预设容量 `new HashMap<>(expected/0.75 + 1)` 避免多次扩容
- 千万级 Map 配合 WeakReference/缓存淘汰（Caffeine 更优）

## 七、底层本质

HashMap 本质是**"哈希 + 数组 + 链表/树"**——用哈希函数把任意 key 映射到数组下标，冲突用链表/红黑树解决，负载因子控制扩容时机。中台特征/路由/缓存场景下首选 ConcurrentHashMap，并预设容量、配合淘汰策略避免膨胀。

## 常见考点

1. **HashMap 和 TreeMap 区别**？——HashMap 无序 O(1)，TreeMap 红黑树有序 O(logn)，LinkedHashMap 保留插入/访问顺序。
2. **为什么负载因子是 0.75**？——时间和空间平衡（统计学+泊松分布，冲突概率低且空间利用率高）。
3. **HashMap 能存 null key 吗**？——能（放桶 0），但 ConcurrentHashMap 不能（歧义）。
