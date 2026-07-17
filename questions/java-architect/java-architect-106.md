---
id: java-architect-106
difficulty: L2
category: java-architect
subcategory: Java 集合
tags:
- Java 架构师
- Sequenced Collections
- 集合
- API设计
feynman:
  essence: Sequenced Collections（JEP 431，JDK 21 GA）补齐了 Java 集合 API 30 年的缺口——一套统一的"有顺序集合"接口，提供 addFirst/addLast/getFirst/getLast/reversed 操作。从此不用记 List 用 add(0, x)、Deque 用 addFirst、LinkedHashSet 没办法拿最后一个元素这种碎片化 API。
  analogy: 像图书管理员终于统一了"取书规则"——以前从书架拿第一本，List 用 get(0)、Deque 用 peekFirst、Set 根本没这能力；现在所有"有序集合"统一用 getFirst()，规则一致。
  first_principle: 「有序」是集合的核心维度之一（有序 + 唯一 = Set；有序 + 可重复 = List；FIFO = Deque），但 Java 长期没抽象这个维度。SequencedCollection 把「有序」提为顶层接口，让所有有序集合共享 API。
  key_points:
  - SequencedCollection 接口（JDK 21）：addFirst/addLast/getFirst/getLast/removeFirst/removeLast/reversed
  - SequencedSet extends SequencedCollection（去重版）
  - SequencedMap extends Map（按插入顺序的 Map）
  - 改造老集合：List/Deque/LinkedHashSet/LinkedHashMap 都实现了新接口
  - 工程价值：API 统一、消除"取最后元素要遍历"的痛点
first_principle:
  problem: Java 集合 API 里"取有序集合的首尾元素"为什么这么碎？
  axioms:
  - 「有序」是独立维度，应该有独立接口
  - 取首尾、反转、按顺序遍历是高频操作，应该统一 API
  - 老集合（List/Deque/LinkedHashSet）顺序语义相同但 API 不同
  rebuild: 引入 SequencedCollection（顶层）、SequencedSet（去重）、SequencedMap（键有序），提供 7 个统一方法。让 List、LinkedHashSet、LinkedHashMap、TreeMap、Deque 都实现这些接口，用统一 API 操作。代码不用关心底层是 List 还是 LinkedHashSet，直接 getFirst()。
follow_up:
  - SequencedCollection 和 Iterable 区别？——Iterable 只能正向遍历，SequencedCollection 还能反向遍历（reversed()）、取首尾、增删首尾
  - 老代码要不要重构？——建议改。原来的 list.get(list.size()-1) 改 list.getLast()，可读性提升；deque.peekFirst() 改 deque.getFirst() 语义统一
  - SequencedMap 怎么用？——entrySet() 返回 SequencedSet，firstEntry()/lastEntry()/pollFirstEntry()/pollLastEntry() 直接操作
  - 性能怎么样？——ArrayList.getFirst() 是 O(1)；LinkedList 是 O(1)；TreeSet.getFirst() 是 O(log n)；不退化
  - 和 Kotlin / Scala 集合对比？——Java 21 终于补齐。Kotlin 的 firstOrNull/lastOrNull/reversed 早就有，Java 21 用统一接口实现等价能力
memory_points:
  - SequencedCollection（JDK 21 GA）：统一"有序集合"API
  - 7 个方法：addFirst/addLast/getFirst/getLast/removeFirst/removeLast/reversed
  - SequencedSet：去重有序集合（LinkedHashSet 实现）
  - SequencedMap：键有序的 Map（LinkedHashMap/TreeMap 实现）
  - 老集合都改造了：List/Deque/LinkedHashSet/LinkedHashMap 自动获得新接口
  - reversed() 返回反向视图（不复制）
---

# 【Java 后端架构师】Sequenced Collections 对集合 API 设计的影响

> 适用场景：JD 核心技术。订单缓存用 LinkedHashSet 存最近的 100 个订单 ID，"取最后一个"以前要么转 List、要么用 iterator 遍历到结尾，性能和可读性都差。SequencedCollection（JDK 21）一行 getLast() 搞定。

## 一、概念层：30 年集合 API 的缺口

**Java 集合 API 的"有序"碎片化**（这张表面试必问）：

| 集合类型 | 取第一个 | 取最后一个 | 加到最前 | 反向遍历 |
|---------|---------|----------|---------|---------|
| **List** (ArrayList) | `get(0)` | `get(size()-1)` | `add(0, x)` O(n) | `for (int i=size-1; i>=0; i--)` |
| **Deque** (ArrayDeque) | `peekFirst()` | `peekLast()` | `addFirst(x)` | `descendingIterator()` |
| **LinkedHashSet** | `iterator().next()` | **遍历到结尾**（O(n)！） | 不支持 | 不支持 |
| **LinkedHashMap** | `keySet().iterator().next()` | **遍历到结尾** | 不支持 | 不支持 |

**痛点**：
- 同样是"有序"，不同集合 API 完全不同
- LinkedHashSet 拿最后一个元素要遍历整个集合（O(n)）
- 反向遍历每种集合写法不同

**SequencedCollection 的统一 API**（JDK 21 GA）：

| 方法 | 含义 | List | Deque | LinkedHashSet |
|------|------|------|-------|---------------|
| `getFirst()` | 取第一个（不删） | O(1) | O(1) | O(1) |
| `getLast()` | 取最后一个（不删） | O(1) | O(1) | O(1) |
| `addFirst(e)` | 加到最前 | O(n) | O(1) | O(1) |
| `addLast(e)` | 加到末尾 | O(1) | O(1) | O(1) |
| `removeFirst()` | 删第一个 | O(n) | O(1) | O(1) |
| `removeLast()` | 删最后一个 | O(1) | O(1) | O(1) |
| `reversed()` | 反向视图（不复制） | View | View | View |

## 二、机制层：三个新接口

**接口继承关系**（架构师必须能画）：

```
                    SequencedCollection<E>
                    (addFirst/addLast/getFirst/getLast/...)
                       /            \
                      /              \
       SequencedSet<E>           SequencedMap<K,V>.SequencedEntrySet
       (无重复)                  (key/value/entry 都是 SequencedSet)
```

**SequencedCollection（顶层接口）**：

```java
public interface SequencedCollection<E> extends Collection<E> {
    SequencedCollection<E> reversed();           // 反向视图
    default void addFirst(E e) { throw new UnsupportedOperationException(); }
    default void addLast(E e) { add(e); }
    default E getFirst() { return iterator().next(); }       // 默认实现
    default E getLast() {
        var it = iterator();
        E last = null;
        while (it.hasNext()) last = it.next();              // 默认遍历
        return last;
    }
    default E removeFirst() { ... }
    default E removeLast() { ... }
}
```

**关键设计**：default 方法兜底（遍历实现），子类按数据结构优化（如 LinkedHashSet 重写 getLast 为 O(1)）。

**SequencedSet（去重有序集合）**：

```java
public interface SequencedSet<E> extends SequencedCollection<E>, Set<E> {
    SequencedSet<E> reversed();   // 协变返回
}
```

**SequencedMap（键有序的 Map）**：

```java
public interface SequencedMap<K, V> extends Map<K, V> {
    SequencedMap<K, V> reversed();
    default V putFirst(K, V) { ... }
    default V putLast(K, V) { ... }
    default Entry<K, V> firstEntry() { ... }
    default Entry<K, V> lastEntry() { ... }
    default Entry<K, V> pollFirstEntry() { ... }
    default Entry<K, V> pollLastEntry() { ... }
    SequencedSet<K> sequencedKeySet();
    SequencedCollection<V> sequencedValues();
    SequencedSet<Entry<K, V>> sequencedEntrySet();
}
```

## 三、实战层：典型场景与重构

**场景 1：取最近 N 个订单 ID（LinkedHashSet）**

```java
// 老代码：遍历拿最后一个（O(n)）
LinkedHashSet<Long> recentOrders = ...;
Long last = recentOrders.stream()
    .reduce((first, second) -> second)
    .orElse(null);                    // 3 行 + O(n)

// 新代码（JDK 21）：SequencedSet.getFirst/getLast（O(1)）
LinkedHashSet<Long> recentOrders = ...;
Long first = recentOrders.getFirst();  // O(1)
Long last = recentOrders.getLast();    // O(1)！
```

**场景 2：LRU 缓存（LinkedHashMap + accessOrder）**

```java
// LRU 缓存：最近访问的在末尾，淘汰第一个
LinkedHashMap<K, V> lru = new LinkedHashMap<>(16, 0.75f, true);
lru.putFirst(k, v);                    // 加到最前
lru.putLast(k, v);                     // 加到末尾
var eldest = lru.firstEntry();         // 取最老（淘汰候选）
lru.pollFirstEntry();                  // 删除并返回最老

// 反向遍历（从最新到最旧）
for (var entry : lru.reversed().sequencedEntrySet()) {
    System.out.println(entry.getKey() + " last accessed at " + entry.getValue());
}
```

**场景 3：双端任务队列（Deque / ArrayDeque）**

```java
// 老代码：API 碎片化
Deque<Task> queue = new ArrayDeque<>();
queue.addFirst(task);
queue.peekLast();
queue.removeLast();

// 新代码（JDK 21）：API 统一
Deque<Task> queue = new ArrayDeque<>();
queue.addFirst(task);
queue.getLast();
queue.removeLast();
// Deque 也实现了 SequencedCollection，API 和 List 一致
```

**场景 4：反向遍历（reversed 视图）**

```java
List<Integer> nums = List.of(1, 2, 3, 4, 5);

// 老代码：手写倒序
for (int i = nums.size() - 1; i >= 0; i--) {
    System.out.println(nums.get(i));
}

// 新代码：reversed() 返回视图
nums.reversed().forEach(System.out::println);
// reversed() 不复制数据，是视图（O(1)），适合不可变 List
```

**重构决策**：

| 老代码 | 新代码（JDK 21） | 何时重构 |
|--------|------------------|---------|
| `list.get(list.size() - 1)` | `list.getLast()` | 可读性提升，立即改 |
| `deque.peekFirst()` | `deque.getFirst()` | 语义统一，立即改 |
| `LinkedHashSet.stream().reduce((a, b) -> b)` | `set.getLast()` | 性能 + 可读性，立即改 |
| `for (int i = size - 1; i >= 0; i--)` | `reversed().forEach(...)` | 可读性，立即改 |
| `LinkedHashMap.entrySet().iterator().next()` | `map.firstEntry()` | 可读性，立即改 |

## 四、底层本质：为什么 30 年才补齐

回到第一性：**为什么 Java 集合 API 的"有序"维度迟到 JDK 21？**

- **历史包袱**：JDK 1.2（1998 年）设计 Collection Framework 时，"有序"被认为是 List/Deque 的实现细节，没有抽象为顶层接口。Set 默认无序（HashSet），TreeSet 是"排序"不是"插入序"，LinkedHashSet 是后加的补丁。
- **接口冻结**：Collection 接口被广泛依赖，加新方法（default 方法 JDK 8 才有）会破坏二进制兼容。直到 default 方法的出现，才能向后兼容地扩展接口。
- **API 设计原则**：JDK 设计者长期认为"接口应该最小化"，"取首尾"是 List/Deque 的细节。但实际项目里 LinkedHashSet 取最后一个的需求很普遍（LRU、最近列表），导致各种 hack 写法。

**SequencedCollection 的设计哲学**：
- **新增接口而非修改老接口**：通过让 List/Deque/LinkedHashSet 实现 SequencedCollection，向后兼容。
- **default 方法兜底**：保证所有实现都能用（即使 O(n)），子类按数据结构优化。
- **reversed() 返回视图而非复制**：性能保证（不复制底层数组）。

**性能优化的关键**：

```java
// LinkedHashSet 老代码取最后一个：O(n) 遍历
E last = null;
for (E e : set) last = e;
return last;

// JDK 21 LinkedHashSet.getLast() 内部：直接拿 tail 节点 O(1)
// （LinkedHashSet 内部是 LinkedHashMap，维护 head/tail 指针）
```

**协变返回类型**（covariant return）：

```java
// SequencedSet.reversed() 返回 SequencedSet，不是 SequencedCollection
// （协变：子类可以返回更具体的类型）
LinkedHashSet<Integer> set = ...;
LinkedHashSet<Integer> reversed = set.reversed();   // 类型不变
```

## 五、AI 架构师加问：5 个

1. **AI 代码生成推荐用 SequencedCollection 还是具体类型？**
   AI 应该按场景推荐：需要 LRU/LIFO/FIFO 用具体类型（LinkedHashMap/ArrayDeque/LinkedList）；只需要"有序集合"参数类型用 SequencedCollection（最通用）。SequencedCollection 作为方法参数类型最灵活（接受 List/Set/Deque），返回类型按场景定。

2. **AI 推理服务的"最近 N 条对话"用 SequencedSet 还是 SequencedMap？**
   只需要 ID 集合用 SequencedSet（LinkedHashSet）；需要 ID → 数据映射用 SequencedMap（LinkedHashMap + accessOrder）。后者更适合 LRU 缓存（访问时自动移到末尾，淘汰首部）。

3. **AI Copilot 怎么帮业务重构到 SequencedCollection？**
   静态规则：扫描 `list.get(list.size() - 1)` → `list.getLast()`、`for(int i=size-1;i>=0;i--)` → `reversed().forEach`、`stream().reduce((a,b)->b)` → `getLast()`。AI 出 diff 人工 review，跑测试验证。

4. **SequencedCollection 和 Reactor / RxJava 的反向流式怎么对比？**
   不同抽象。SequencedCollection 是集合的反向视图（reversed()），Reactor 的 Flux 是异步流的反向（不直接支持，要 collect 再 reversed）。SequencedCollection 适合内存集合的小数据，Reactor 适合流式大数据。互补不冲突。

5. **大模型推理的 token 缓存（LLM KV-cache）用 SequencedMap 合适吗？**
   看具体需求。如果按"最近最少使用"淘汰，用 LinkedHashMap + accessOrder=true（自动维护 LRU 顺序），pollFirstEntry() 淘汰最老。如果按"插入顺序"（FIFO），LinkedHashMap 不开 accessOrder。SequencedMap 的 firstEntry/pollFirstEntry 让淘汰逻辑更清晰。

## 六、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"统一 7 方法、3 个接口、reversed 是视图、JDK 21 GA"**。

- **7 方法**：addFirst/addLast/getFirst/getLast/removeFirst/removeLast/reversed
- **3 接口**：SequencedCollection（顶层）、SequencedSet（去重）、SequencedMap（键有序）
- **reversed() 是视图**：O(1) 不复制，反向遍历不耗额外内存
- **老集合都改造**：List/Deque/LinkedHashSet/LinkedHashMap 自动获得新接口
- **性能**：LinkedHashSet.getLast() 从 O(n) 降到 O(1)
- **版本**：JDK 21（JEP 431）GA

### 拟人化理解

把 SequencedCollection 想成**图书管理员统一了取书规则**。以前从书架拿第一本：List 用 `get(0)`、Deque 用 `peekFirst()`、Set 根本没法拿（只能从头翻到尾）。现在所有"有序书架"统一 `getFirst()`、`getLast()`、`reversed()`（反向看书架），规则一致。书架本身（ArrayList/LinkedHashSet）没变，只是管理员操作规则统一了。

### 面试现场 60 秒回答

> SequencedCollection（JDK 21 JEP 431 GA）补齐了 Java 集合 30 年的缺口——把"有序"提为顶层接口，统一 7 个方法：getFirst/getLast/addFirst/addLast/removeFirst/removeLast/reversed。3 个新接口：SequencedCollection（顶层）、SequencedSet（去重，LinkedHashSet 实现）、SequencedMap（键有序，LinkedHashMap/TreeMap 实现）。最大工程价值是 LinkedHashSet 取最后一个从 O(n) 遍历降到 O(1)。reversed() 返回视图不复制，反向遍历零成本。老集合都改造了（List/Deque 自动实现新接口），建议重构：list.get(size-1) → getLast()、for 倒序循环 → reversed().forEach()。

### 反问面试官

> 贵司 JDK 版本是 21+？业务里 LinkedHashSet / LinkedHashMap 用得多吗（LRU、最近列表场景）？这决定我聊 SequencedCollection 工程价值还是先聊 JDK 21 升级。

## 七、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 已经能取首尾了（get(0)/get(size-1)），为什么搞新接口？ | API 碎片化 + 性能问题。LinkedHashSet 取最后一个要 O(n) 遍历，List 用 size()-1 容易算错。统一接口让代码不关心底层是 List 还是 Set。证明：重构后 LinkedHashSet.getLast() 性能提升 N 倍（N = 集合大小） |
| 证据追问 | 怎么证明 SequencedCollection 真的有价值？ | 代码可读性（getLast vs get(size-1)）、性能（LinkedHashSet getLast 从 O(n) 到 O(1)）、API 一致性（同一个方法操作 List/Set/Deque） |
| 边界追问 | SequencedCollection 适合所有集合吗？ | 不适合。HashSet/HashMap 无序不能实现（语义不符）；并发集合（ConcurrentHashMap）有序版本要特殊处理；TreeSet 是"排序序"不是"插入序"，要小心 |
| 反例追问 | 什么场景不该用 SequencedCollection？ | 无序集合（HashSet）、并发高（用 ConcurrentLinkedDeque）、性能极敏感（默认方法有微弱开销，JIT 优化后可忽略）、JDK < 21 |
| 风险追问 | 老代码重构最大风险？ | 兼容性：SequencedCollection 是 JDK 21 才有，老 JDK 编译错。行为差异：ArrayList.addFirst 是 O(n)（不是 O(1)），高频调用性能问题。治法：评估 JDK 21+、避免 ArrayList.addFirst 热路径 |
| 验证追问 | 怎么证明重构后没引入新问题？ | 单元测试覆盖（取首尾、增删、反向遍历）；性能压测（特别是 LinkedHashSet.getLast 对比 O(n)）；线上灰度：业务指标对比 |
| 沉淀追问 | 团队推广沉淀什么？ | SequencedCollection 使用 SOP（场景对应类型）、老 API → 新 API 重构 checklist、性能注意事项（ArrayList.addFirst O(n)）、JDK 21 升级指南 |

### 现场对话示例

**面试官**：SequencedCollection 不就是加几个方法吗，有什么大不了的？

**候选人**：不是加方法，是补齐 30 年的接口设计缺口。Java 集合 API 长期有"有序"维度但没抽象——List 用 get(0)、Deque 用 peekFirst()、LinkedHashSet 取最后一个要 O(n) 遍历。SequencedCollection 把"有序"提为顶层接口，所有有序集合（List/Deque/LinkedHashSet/LinkedHashMap）共享 7 个方法，代码不关心底层实现。最大价值是性能优化：LinkedHashSet.getLast() 内部直接拿 tail 指针 O(1)，老代码 stream().reduce((a,b)->b) 是 O(n) 遍历。

**面试官**：reversed() 是复制一份吗？内存翻倍？

**候选人**：不复制。reversed() 返回一个视图（View），底层还是原集合的数据，只是 iterator 反向遍历。O(1) 时间和空间。对 List，视图是 RandomAccess（保持随机访问性能）；对 Set，视图是不可变的。这是 API 设计的优雅——反向遍历零成本。

**面试官**：那 ArrayList.addFirst 不是 O(n) 吗？性能问题怎么办？

**候选人**：对，ArrayList.addFirst 是 O(n)（数组拷贝），这是数据结构本质决定的。如果业务高频 addFirst，应该用 ArrayDeque（O(1)）或 LinkedList（O(1)）。SequencedCollection 的价值是统一 API，性能取决于底层实现。生产建议：高频 addFirst 用 ArrayDeque（也实现了 SequencedCollection），低频用 ArrayList 没问题。代码不变（都是 addFirst），换数据结构即可。

## 常见考点

1. **SequencedCollection 是什么？**——JDK 21（JEP 431）GA 的新接口，统一"有序集合"的 7 个方法：getFirst/getLast/addFirst/addLast/removeFirst/removeLast/reversed。
2. **3 个新接口？**——SequencedCollection（顶层）、SequencedSet（去重，LinkedHashSet 实现）、SequencedMap（键有序，LinkedHashMap/TreeMap 实现）。
3. **reversed() 是复制吗？**——不是。返回视图，O(1) 时间和空间，反向遍历零成本。
4. **LinkedHashSet 取最后一个有什么变化？**——JDK 21 之前要 O(n) 遍历（stream().reduce((a,b)->b)），现在 getLast() O(1)（内部拿 tail 指针）。
5. **性能注意事项？**——ArrayList.addFirst 是 O(n)（数组拷贝），高频场景用 ArrayDeque 或 LinkedList（都实现了 SequencedCollection）。

## 结构化回答

**30 秒电梯演讲：** Sequenced Collections（JEP 431，JDK 21 GA）补齐了 Java 集合 API 30 年的缺口——一套统一的有顺序集合接口，提供 addFirst/addLast/getFirst/getLast/reversed 操作。从此不用记 List 用 add(0, x)、Deque 用 addFirst、LinkedHashSet 没办法拿最后一个元素这种碎片化 API

**展开框架：**
1. **SequencedCol** — SequencedCollection 接口（JDK 21）：addFirst/addLast/getFirst/getLast/removeFirst/r……
2. **SequencedSet** — SequencedSet extends SequencedCollection（去重版）
3. **SequencedMap** — SequencedMap extends Map（按插入顺序的 Map）

**收尾：** 以上是我的整体思路。您想继续深入聊——SequencedCollection 和 Iterable 区别？


## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：Sequenced Collections 对集 | "这题核心是——Sequenced Collections（JEP 431，JDK 21 GA）补齐了 Java 集……" | 开场钩子 |
| 0:15 | SequencedCol示意/对比图 | "SequencedCollection 接口（JDK 21）：addFirst/addLast/getFirst/getLast/removeFirst/r……" | SequencedCol要点 |
| 0:40 | SequencedSet示意/对比图 | "SequencedSet extends SequencedCollection（去重版）" | SequencedSet要点 |
| 1:25 | 总结卡 | "记住：SequencedColle。下期见。" | 收尾 |
