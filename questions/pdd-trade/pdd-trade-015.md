---
id: pdd-trade-015
difficulty: L2
category: pdd-trade
subcategory: Java 集合
tags:
- 拼多多
- 交易
- HashMap
- 红黑树
feynman:
  essence: HashMap 是"数组+链表/红黑树"，扰动函数让高位参与桶分布，扩容翻倍用高位 bit 判定迁移，负载因子 0.75 是时空折中。
  analogy: HashMap 像分书架图书馆——书号哈希到书架（桶），同架排链表，链长改二叉（红黑树），架挤加架（扩容）。
  first_principle: 哈希表用空间换时间，O(1) 平均查找；B+ 树矮（IO 少）+ 链表/红黑树兜底冲突。
  key_points:
  - 数组+链表/红黑树（链≥8 且容量≥64 转树）
  - 扰动：(h^(h>>>16)) 让高位参与低位
  - 桶定位：(n-1)&hash（n 是 2 的幂）
  - 扩容翻倍，迁移用高位 bit 判定
first_principle:
  problem: 任意 key 平均 O(1) 查找如何实现？
  axioms:
  - 哈希均匀分散
  - 负载因子影响冲突
  rebuild: 数组桶 + 冲突链表/树 + 自动扩容。
follow_up:
- 为什么容量 2 的幂？——(n-1)&hash 等价取模但快
- JDK 7 并发死循环？——头插法成环，JDK 8 尾插解决但非线程安全
- 负载因子 0.75？——时空折中（泊松分布链长 ≈0.5）
memory_points:
- 数组+链表/红黑树（≥8 转树）
- 扰动函数 + (n-1)&hash
- 扩容翻倍、迁移高位 bit 判定
- 0.75 负载因子时空折中
---

# 【拼多多交易】HashMap 原理？扩容机制？

> JD 依据："JAVA 基础扎实"。

## 一、数据结构

```
table[] (Node 数组，2 的幂)
  ├─[i] → Node → Node → ... → TreeNode（≥8 转红黑树）
```

## 二、哈希与定位

```java
hash = (key.hashCode()) ^ (key.hashCode() >>> 16);  // 扰动
index = (n - 1) & hash;  // n 是 2 的幂，等价取模但快
```

## 三、扩容

触发：size > capacity × 0.75。
- newCap = oldCap << 1（翻倍）
- 迁移：看 hash 高一位 bit（0 原位 / 1 原位+oldCap）

## 四、线程安全

- JDK 7 头插法并发成环 → 死循环
- JDK 8 尾插解决成环但仍非线程安全
- 并发用 ConcurrentHashMap

## 五、底层本质

HashMap 是"空间换时间"经典——O(1) 平均，最坏 O(n)（冲突），红黑树兜底 O(logn)。

## 常见考点
1. **容量为什么 2 的幂**？——(n-1)&hash 等价取模更快。
2. **为什么 0.75**？——泊松分布下链长约 0.5，时空折中。
3. **自定义 key 要重写什么**？——hashCode 和 equals（契约一致）。

## 苏格拉底式面试追问

> 这组追问不背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：HashMap 链表长度到 8 才转红黑树，为什么不是 4 或 16？这个 8 是怎么定的？**

8 是基于泊松分布的统计结论。HashMap 源码注释里给了计算：在负载因子 0.75 下，一个桶有 8 个节点的概率是 0.00000006（千万分之一），正常情况下根本不会触发转树。设 8 是"极端冲突的兜底"——如果真的到 8，说明哈希严重不均（如恶意构造的 key 攻击），这时用红黑树 O(logN) 兜底避免 O(N) 退化。为什么不 4——太敏感，正常冲突就频繁转树（树节点比链表节点大，内存浪费）。为什么不 16——树化阈值太高，极端冲突时还是 O(N) 慢。8 是"足够罕见（不浪费）又足够兜底（防攻击）"的权衡点。还有一个条件是容量 ≥64 才转树，否则优先扩容（小容量时扩容比转树更有效）。

### 第二层：证据与定位

**Q：交易服务有一个接口用 HashMap 缓存商品信息，CPU 偶尔飙到 100%，但没 Full GC，你怎么定位是 HashMap 的问题？**

怀疑 HashMap 退化成 O(N) 查找。三步：
1. `jstack <pid>` 抓栈——看 CPU 高时线程在干嘛。如果大量线程卡在 `HashMap.getNode` 或 `HashMap.getTable`，且栈深度有循环（链表遍历），大概率是某个桶链表过长。
2. 用 `jmap -histo <pid>` 看对象——如果 `HashMap$Node` 对象异常多（如几百万），说明 Map 很大或冲突严重。
3. 如果怀疑是哈希攻击（恶意 key 都落同桶），看 key 的分布——`HashMap` 的 key 如果是用户可控的字符串（如商品名），攻击者构造 hash 相同的字符串让它们都落一个桶，那个桶链表/树退化成 O(N)，CPU 飙高。JDK 8 的红黑树兜底让最坏从 O(N) 变 O(logN)，但如果 key 的类没实现 Comparable，树退化为 TreeNode 链表遍历（还是 O(N)）。

### 第三层：根因深挖

**Q：你发现是 HashMap 的 key 是用户传的字符串，被构造了哈希冲突（同一个桶几千个 entry），根因是什么？光是换成 TreeMap 就行吗？**

换 TreeMap 不解决问题（TreeMap 要 key 实现 Comparable，字符串的 Comparable 是字典序，不能防哈希攻击）。根因和治本：
1. 如果是缓存场景，换 ConcurrentHashMap 没用（还是 HashMap 的哈希逻辑）——治本是对用户输入做规范化/限流，不让单 key 的 Map 无限增长。
2. 如果是"用户可控 key 进 HashMap"，JDK 9 引入了 `TreeBin` 的 Comparable 优化——如果 key 实现 Comparable，红黑树按比较排序，即使哈希冲突也是 O(logN)。所以确保 key 的类实现 Comparable。
3. 真正的治本是"限制 Map 大小"——如果缓存商品信息，应该用有界缓存（Caffeine maximumSize），而不是无界 HashMap。根因是用错了数据结构（HashMap 当缓存，无界增长 + 哈希冲突），换成"有界缓存 + 合理 key"才对。

**Q：那为什么不直接用 ConcurrentHashMap 代替 HashMap，既线程安全又防冲突？**

ConcurrentHashMap 解决的是"线程安全"，不是"哈希冲突"。它内部还是哈希表，用户构造的冲突 key 照样落同桶，只是加了 synchronized/CAS 保证并发写不坏数据结构。用 ConcurrentHashMap 防冲突是误解。真正的场景区分：
1. 单线程或线程封闭（如方法内局部变量）——HashMap 够，不需要 ConcurrentHashMap 的开销。
2. 多线程共享读写——必须 ConcurrentHashMap（HashMap 并发写可能丢数据、JDK7 死循环、JDK8 数据覆盖）。
3. 哈希冲突攻击——要靠 key 实现 Comparable（树优化）或限制 Map 大小，和线程安全无关。选 Map 要看"并发性""冲突风险""边界控制"三个维度，不是简单替换。

### 第四层：方案权衡

**Q：负载因子 0.75 是时空折中，但如果交易服务内存紧张，能不能调到 0.5 省空间？或者调到 1.0 提高利用率？**

可以调，但要懂代价：
1. 调到 0.5——更早扩容（size > capacity × 0.5 就扩），空间浪费多（一半桶空着），但冲突概率低（链表短，查找快）。适合"内存充裕、追求查找性能"。
2. 调到 1.0——更晚扩容（size 满了才扩），空间利用率高，但冲突概率高（平均每个桶 1 个节点，但方差大，有些桶多个）。适合"内存紧张、容忍查找慢一点"。
3. 0.75 是泊松分布下"链表平均长度 0.5、空间利用 75%"的甜点。拼多多交易服务一般用默认 0.75——内存不是瓶颈（几 MB 的 Map 相比 16G 堆微不足道），不值得为省那点空间牺牲查找性能。除非是超大 Map（如缓存百万级 entry），才考虑调。多数业务场景，默认 0.75 最好。

**Q：为什么不用 TreeMap（红黑树）直接代替 HashMap，不就没有"链表退化"问题了吗？**

TreeMap 是 O(logN) 查找，HashMap 是 O(1) 平均，差距大。TreeMap 的优势是"有序"（能按 key 范围查询、有序遍历），HashMap 无序。如果业务需要"按 key 排序"或"范围查询"（如按价格范围找商品），用 TreeMap；如果是"按 key 精确查找"（如按 skuId 查商品），HashMap 的 O(1) 远优于 TreeMap 的 O(logN)。在百万级 entry 的 Map 里，O(1) 是几十纳秒，O(logN) 是几百纳秒，差 10 倍。而且 HashMap 的链表退化只在"哈希冲突极端严重"时发生，正常使用 99.99% 是 O(1)。为了 0.01% 的退化风险用 TreeMap，把 99.99% 的场景变慢，不划算。

### 第五层：验证与沉淀

**Q：你怎么验证 HashMap 的自定义 key 实现是正确的（hashCode/equals 契约）？这个 bug 很隐蔽。**

自定义 key 的 hashCode/equals 契约错误会导致"put 进去 get 出来是 null"（最隐蔽的 bug）。验证：
1. 单元测试——对自定义 key 类，测试 `new Key(a,b).hashCode() == new Key(a,b).hashCode()`（相等对象 hash 相等）、`k1.equals(k2)` 对称/传递。put 到 HashMap 后 get 能取回。
2. 不可变性检查——如果 key 的字段参与 hashCode 但对象被修改（如 key.age 从 10 改成 20），hash 变了，get 找不到。测试要覆盖"key 不可变"，自定义 key 必须用 final 字段。
3. 工具——Lombok 的 `@EqualsAndHashCode` 自动生成（但要确保用到的字段一致）、或 IDEA 的 hashCode/equals 模板。CI 可用 EqualsVerifier 库自动校验 equals/hashCode 契约（对称、传递、一致）。

**Q：HashMap 的坑（并发不安全、key 契约、哈希冲突）怎么沉淀成团队规范？**

靠规约 + 工具：
1. 阿里规约——多线程共享 Map 必须用 ConcurrentHashMap，CI 扫描"共享 HashMap 字段"告警。方法内局部 HashMap 可以（线程封闭）。
2. 自定义 key 规范——当 HashMap key 的类必须重写 hashCode+equals，且字段 final（不可变）。CI 用 EqualsVerifier 校验。或优先用 record（JDK 14+，自动不可变 + hashCode/equals）。
3. 缓存禁用 HashMap——业务缓存用 Caffeine（有界、并发安全、淘汰策略），禁止裸 HashMap 当缓存。CI 扫描"类成员 HashMap 字段长期存活"（通常是缓存误用）告警。
4. 培训——HashMap 的并发问题和 key 契约是 Java 基础面试必考，团队要建立"用对集合类"的意识，而不是随手 new HashMap。

## 结构化回答

**30 秒电梯演讲：** 任意 key 平均 O(1) 查找如何实现？简单说就是——HashMap 是"数组+链表/红黑树"，扰动函数让高位参与桶分布，扩容翻倍用高位 bit 判定迁移，负载因子 0.75 是时空折中。

**展开框架：**
1. **数组+链表/** — 数组+链表/红黑树（链≥8 且容量≥64 转树）
2. **扰动** — 扰动：(h^(h>>>16)) 让高位参与低位
3. **桶定位** — 桶定位：(n-1)&hash（n 是 2 的幂）

**收尾：** 您看这块要不要再展开聊聊？

## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：HashMap 原理？扩容机制？ | 今天聊「HashMap 原理？扩容机制？」。一句话：HashMap 是"数组+链表/红黑树"，扰动函数让高位参与桶分布 | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：数组+链表/红黑树（链≥8 且容量≥64 转树） | 核心概念 |
| 1:00 | 能力/参数拆解表 | 要点是：扰动：(h^(h>>>16)) 让高位参与低位 | 能力拆解 |
| 2:00 | 总结卡 + 下期预告 | 记住核心要点就够了。下期见。 | 收尾 |
