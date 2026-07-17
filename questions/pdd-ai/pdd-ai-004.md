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

## 苏格拉底式面试追问

> 这组追问不背答案，模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：你们特征平台的用户特征缓存为什么用 ConcurrentHashMap 而不是用 Caffeine？Caffeine 有 W-TinyLFU 淘汰策略，命中率更高，不是更合适吗？**

因为特征缓存的 key 是用户 ID（uid），数量是可控的——活跃用户就那么几千万，每个 UserFeature 对象几 KB，总量几十 GB，要么全放 Redis（分布式），要么本地缓存只放"热点用户"。ConcurrentHashMap 用在这里是做"全量路由表的内存版本"，key 集合是封闭的（当前在用的特征定义），不会无限增长，不需要淘汰策略。Caffeine 的优势在"key 集合开放 + 内存有限需要淘汰"的场景，比如缓存最近 1 小时的推理结果——prompt 哈希是无限的，必须淘汰。选型看 key 集合是否封闭：封闭用 ConcurrentHashMap（语义清晰，无淘汰副作用），开放用 Caffeine。

### 第二层：证据与定位

**Q：线上特征查询服务的 P99 从 1ms 飙到 50ms，你怎么确认是 ConcurrentHashMap 的问题，而不是 Redis 或 HBase 慢？**

分层排查。第一，看 `jstack` 和 `jstat`——如果线程大量时间在 `BLOCKED` 状态且锁的是 ConcurrentHashMap 的桶头节点（`java.util.concurrent.ConcurrentHashMap$Node`），说明桶冲突严重。第二，看本地缓存命中率——`cache_hit_ratio` 如果还是 95%+，说明请求确实命中了 ConcurrentHashMap，不是回源到 Redis 慢。第三，`jmap -histo <pid> | head -20` 看 ConcurrentHashMap 的 Node 数组长度和链表/树化情况——如果某个桶的链表长度 > 8 还没树化（因为 table 容量 < 64），get 退化成 O(n)。第四，用 Arthas 的 `watch` 命令监控 `ConcurrentHashMap.get` 的耗时分布：`watch com.pdd.FeatureCache get '{params, returnObj, #cost}' -x 2 -n 100`，如果某些 key 的 cost > 10ms，就是桶冲突。

### 第三层：根因深挖

**Q：你定位到是某个桶链表长度 50（没树化），导致 get 慢。为什么没树化？HashMap 不是链表长度 ≥8 就树化吗？**

树化有两个条件：链表长度 ≥8 **且 table 容量 ≥64**。如果初始化时没预设容量，HashMap 默认初始容量 16，大量 key 哈希到同一个桶时，链表先涨到 8，触发 treeify，但 treeify 方法里会检查 `if (tab == null || (n = tab.length) < MIN_TREEIFY_CAPACITY=64)`，如果容量 < 64，会先 resize（扩容到 32）而不是树化。我们踩过这个坑——特征缓存初始化时 `new ConcurrentHashMap<>()`（默认 16），结果几千万 uid 哈希进去，虽然最终会扩容，但在扩容前某些桶链表已经 50 长了。根因是没预设容量。

**Q：那为什么不直接 new ConcurrentHashMap<>(10000000)？预设一千万容量不就解决了吗？**

预设容量是对的，但不能填 10000000。HashMap 的容量必须是 2 的幂，传 10000000 会被 `tableSizeFor` 向上取整到 16777216（2^24），每个桶一个 Node 头指针（16 字节），光 table 数组就占 256MB——而且大部分桶是空的（几千万 key 分散到 16M 桶，负载因子 0.75，实际填不满）。正确做法是按 `expectedSize / 0.75 + 1` 算，比如预期 1000 万 key，传 `13333333`，最终容量 16777216，刚好。或者更简单——用 Guava 的 `Maps.newHashMapWithExpectedSize(10000000)`，它帮你算好。核心是预设容量要匹配实际 key 数量，不能拍脑袋填大数字。

### 第四层：方案权衡

**Q：你预设了容量，链表冲突解决了。但如果特征缓存将来要支持"过期淘汰"（比如用户注销后特征失效），ConcurrentHashMap 做不到，是不是该换 Caffeine？**

是的，需求变了就该换。ConcurrentHashMap 是"永久持有"语义，不支持 TTL 或基于容量的淘汰。如果业务要"用户 30 天不活跃就清理特征"，加 TTL 有两种做法：第一，给每个 value 包一层 `Entry(expireAt)`，然后起一个定时线程扫全表清理——但扫描千万级 Map 每 5 分钟一次，CPU 和 GC 压力大。第二，直接换 Caffeine，`Caffeine.newBuilder().expireAfterAccess(30, TimeUnit.DAYS).maximumSize(10_000_000).build()`，W-TinyLFU 自动淘汰，读写时异步清理过期项，性能几乎无损。换的成本是迁移工作量，但收益是语义匹配 + 维护成本低。技术选型要跟着需求走，不能"因为现在能用就不换"。

**Q：为什么不直接全放 Redis？本地缓存（Caffeine/CHM）和 Redis 两层缓存，一致性怎么保证？**

两层缓存是为了延迟和成本。Redis P99 1ms，本地缓存 P99 0.01ms——特征查询 QPS 百万级，全打 Redis 要几百个 Redis 实例，成本高且 Redis 也扛不住。本地缓存扛 95% 热点读，Redis 承担 5% 的 miss 回源和跨实例一致性。一致性方案：写特征时"先更新 DB → 删 Redis → 发 Kafka 广播 → 各 Pod 收到广播删本地缓存"，读时"本地 miss → 查 Redis → 回填本地"。短时间内（广播延迟几秒）可能读到旧值，但特征场景容忍秒级不一致（用户画像晚几秒更新无所谓）。如果是强一致场景（比如风控实时特征），就别用本地缓存，直接 Redis。

### 第五层：验证与沉淀

**Q：你怎么证明"预设容量"真的解决了桶冲突问题？**

上线前后对比三个指标。第一，`ConcurrentHashMap` 的桶链表长度分布——通过 `jmap -histo` 或 Java Mission Control（JMC）看 Map 内部结构，上线前链表 P99 长度 30+，上线后应该 < 3。第二，`get` 操作的 P99 耗时——用 Micrometer 的 `Timer` 埋点 `feature_cache_get_ms`，上线前 P99 50ms，上线后应该 < 0.1ms。第三，cache_hit_ratio 不变（都是 95%+），证明链表变短不是因为 key 变少了，是真的分散均匀了。第四，跑 JMH benchmark——离线用 `@Benchmark` 测百万次 get 的吞吐，预设容量前后对比，量化提升。

**Q：怎么让团队避免再踩"不预设容量"的坑？**

沉淀两条规范。第一，Code Review 检查项——"所有 `new HashMap/ConcurrentHashMap` 是否预设容量，预设值是否按 `expectedSize / 0.75 + 1` 算"，未达标 review 不过；或强制用 `Maps.newHashMapWithExpectedSize()`/`MapUtil.newHashMapWithExpectedSize()`。第二，加 `cache_get_ms_p99` 监控告警——所有 Map 缓存的 get 耗时埋点到 Prometheus，`p99 > 1ms` 告警（正常纳秒级，超毫秒一定有问题），及早发现桶冲突。第三，把"HashMap 初始容量 = 预期 key 数 / 0.75 + 1"写进 Java 编码规范，新人入职必读。

## 结构化回答



**30 秒电梯演讲：** 像图书馆按书名首字母分书架——找书时算首字母直奔书架（哈希），书架满了（扩容）就再开一排，同字母书太多就细分（链表转树）。

**展开框架：**
1. **哈希桶 + 链表** — 哈希桶 + 链表/红黑树（≥8 转树，≤6 退链）
2. **扩容** — 负载因子 0.75，超阈值翻倍重哈希
3. **1.7 头插死循环** — 1.8 尾插 + 红黑树

**收尾：** HashMap 链表为什么转红黑树？



## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：HashMap 原理与中台特征存储怎么用？ | 今天聊「HashMap 原理与中台特征存储怎么用？」。一句话：HashMap 是"用哈希函数把 key 映射到桶数组"，O(1) 读写；中台存特征/路由表/缓存大量用 Map | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：桶 + 链表/树（≥8 转树） | 核心概念 |
| 1:04 | 能力/参数拆解表 | 要点是：负载因子 0.75，2 倍扩容 | 能力拆解 |
| 1:56 | 流程图：输入→处理→输出 | 要点是：1.8 尾插 + 红黑树（防退化/死循环） | 关键机制 |
| 3:00 | 总结卡 + 下期预告 | 记住这些核心点就够了。下期我们接着聊——HashMap 链表为什么转红黑树？。 | 收尾 |
