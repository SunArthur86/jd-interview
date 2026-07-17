---
id: java-architect-009
difficulty: L3
category: java-architect
subcategory: Java 并发
tags:
- 并发容器
- 热点
- 计数
feynman:
  essence: LongAdder 和 ConcurrentHashMap 的共同本质是"用空间换并发度"——把一个热点变量拆成多个 Cell/Segment，让不同线程操作不同分区，最后汇总。热点不再阻塞，并发度从 1（单点 CAS）提升到 N（分区数）。
  analogy: 像超市收银：AtomicLong 是"一个收银台"——所有人排队 CAS，高峰期拥堵；LongAdder 是"开 N 个收银台"——每个线程去自己的收银台结账，最后把所有收银台金额加总。ConcurrentHashMap 是"商品分到 N 个货架"，每个货架独立锁，不互相阻塞。
  first_principle: 单点热点（AtomicLong 的 value）在高并发下 CAS 冲突率高——N 个线程同时改一个变量，只有一个成功，其他重试烧 CPU。把热点分区后，N 个线程分散到 N 个分区，冲突率从接近 100% 降到 1/N。
  key_points:
  - LongAdder：Cell[] 分区 + base，sum 时累加，写多读少场景吊打 AtomicLong
  - ConcurrentHashMap JDK 8：Node 数组 + CAS + synchronized（锁桶头），废弃分段锁
  - 计数选型：低并发 AtomicLong，高并发 LongAdder；需要精确值用 LongAdder.sum()
  - size() 在并发下是弱一致性的（估算值）
  - computeIfAbsent 是原子操作，替代"先 get 再 put"
first_principle:
  problem: 高并发下一个共享变量成为热点，CAS 冲突率居高不下，怎么消除热点？
  axioms:
  - 热点的根因是"多写一"——多个线程竞争修改同一个存储位置
  - 如果让不同线程改不同位置，热点就消失了
  - 最终值 = 所有分区值之和（读时聚合，写时分散）
  rebuild: LongAdder 把单个 long 拆成 Cell[]（默认大小 = CPU 核数的最近 2 的幂），每个线程通过 hash 落到某个 Cell，只对自己的 Cell 做 CAS（几乎无冲突）。读时 sum 遍历所有 Cell 累加。ConcurrentHashMap 同理——JDK 7 用 Segment 分段锁，JDK 8 演进为锁桶头（Node 数组每个槽独立锁）。核心思想都是"分区消除热点"。
follow_up:
  - LongAdder.sum() 精确吗？——不精确，遍历 Cell 期间可能有新写入，是弱一致估算。但对计数场景够用
  - CHM JDK 7 和 8 区别？——7 用 Segment（16 段，每段一个 ReentrantLock），并发度固定 16；8 用 Node 数组 + 桶头 synchronized + CAS，并发度 = 桶数，更细粒度
  - computeIfAbsent 性能问题？——JDK 8 有死循环 bug（嵌套 computeIfAbsent），JDK 9 修复；且 lambda 阻塞会锁住整个桶
  - 为什么 CHM 不允许 null key/value？——并发下 null 有歧义（是没这个 key 还是 value 就是 null），强制非 null 避免二义性
  - 热点 key 怎么处理？——一个 key 被高频访问导致单桶锁竞争，要用 ConcurrentHashMap + 细分 key 或 Caffeine 缓存
memory_points:
  - LongAdder = Cell[] 分区 + base，写散列到 Cell，读 sum 聚合
  - CHM JDK 8 = Node 数组 + 桶头 synchronized + CAS（链表→红黑树阈值 8）
  - 计数选型：低并发 AtomicLong，高并发 LongAdder
  - computeIfAbsent 原子替代 get-then-put，但避免嵌套和长 lambda
  - size() 是弱一致性估算，精确计数用 LongAdder.sum 或加版本号
---

# 【Java 后端架构师】LongAdder、ConcurrentHashMap 与热点计数

> 适用场景：JD 核心技术。大促实时累计 GMV、单接口 QPS 计数、热点商品库存——这些场景下 AtomicLong 和 HashMap 会成为瓶颈。架构师必须懂分区消除热点的原理，才能在高并发计数和热点读写上做对选型。

## 一、概念层：热点问题与分区思想

**热点问题的本质**：

```
AtomicLong 的 value 是单点热点：
  线程1 ──CAS──► value  ◄──CAS── 线程2
  线程3 ──CAS──► value  ◄──CAS── 线程4
  4 个线程同时 CAS，只有 1 个成功，3 个重试 → 冲突率 75%

LongAdder 分区消除热点：
  线程1 ──CAS──► Cell[0]   线程3 ──CAS──► Cell[1]
  线程2 ──CAS──► Cell[0]   线程4 ──CAS──► Cell[2]
  4 个线程分散到不同 Cell，几乎零冲突 → 读时 sum(Cell[]) + base
```

**三种计数器对比**：

| 计数器 | 原理 | 写并发度 | 读开销 | 适用 |
|--------|------|---------|--------|------|
| `long` + synchronized | 单点 + 锁 | 1（串行） | 低 | 低并发 |
| `AtomicLong` | 单点 CAS | 1（CAS 重试） | 低 | 中低并发 |
| `LongAdder` | Cell[] 分区 CAS | N（CPU 核数） | 中（sum 遍历） | 高并发写多读少 |
| `LongAccumulator` | 同 LongAdder + 自定义函数 | N | 中 | 高并发非加法（max/min） |

**性能对比**（8 核 CPU，1000 线程各加 100 万次）：

- AtomicLong：约 8 秒（CAS 冲突重试多）
- LongAdder：约 0.8 秒（10 倍提升）
- synchronized：约 15 秒（最慢）

## 二、机制层：LongAdder 的 Cell 分区

**LongAdder 结构**（简化）：

```java
class LongAdder extends Striped64 {
    transient volatile long base;        // 无竞争时直接 CAS 这里
    transient volatile Cell[] cells;     // 有竞争时的分区数组
}

@Contended   // 消除伪共享（padding 隔离缓存行）
static final class Cell {
    volatile long value;
    final boolean cas(long cmp, long val) { ... }
}
```

**add() 工作流程**：

```
add(1)
    │
    ▼
1. cells == null？── 是 ──► CAS base，成功就返回
    │ 否（曾发生过竞争）
    ▼
2. hash 算出 Cell 索引，CAS cells[i]
    │ 成功 ──► 返回
    │ 失败（该 Cell 也竞争）
    ▼
3. 扩容 cells 数组（2 倍，上限 = CPU 核数的最近 2 的幂），rehash 重试
```

**关键设计点**：

1. **Cell 用 @Contended 注解**：每个 Cell 独占缓存行（padding 填充），避免多 Cell 共享缓存行导致的伪共享（false sharing）。
2. **懒初始化**：cells 数组首次有竞争时才创建，无竞争场景退化为 AtomicLong（CAS base）零开销。
3. **动态扩容**：Cell 竞争激烈时数组翻倍，直到 CPU 核数上限。

**sum() 的弱一致性**：

```java
public long sum() {
    Cell[] as = cells; long sum = base;
    if (as != null) {
        for (Cell a : as) if (a != null) sum += a.value;
    }
    return sum;
}
```

遍历期间其他线程可能修改 Cell，返回的是"某时刻的快照"，不是精确值。对计数场景（如 QPS、累计 GMV）够用。

## 三、机制层：ConcurrentHashMap JDK 8 的演进

**JDK 7（Segment 分段锁）**：

```
ConcurrentHashMap
├── Segment[16]（每个 Segment 是一个 ReentrantLock + HashEntry 数组）
│   └── Segment[0]: [HashEntry, HashEntry, ...]
│   └── Segment[1]: [HashEntry, HashEntry, ...]
│   ...
并发度 = 16（固定）
```

**JDK 8（Node 数组 + 桶头锁）**：

```
ConcurrentHashMap
├── Node[] table（默认 16 槽）
│   ├── table[0]: null 或 Node 链表（链表长度 ≥8 转红黑树）
│   ├── table[1]: Node → Node → Node（synchronized 锁这个桶的头节点）
│   ...
并发度 = table 长度（随扩容增长）
```

**put() 工作流程**（JDK 8）：

```
put(key, value)
    │
    ▼
1. hash key 找桶
    │
    ▼
2. 桶为空？── 是 ──► CAS 设置头节点（无锁）
    │ 否
    ▼
3. synchronized 锁桶头节点
    │
    ▼
4. 遍历链表/红黑树，更新或插入
    │ 链表长度 ≥ 8 且 table ≥ 64 ──► 转红黑树（treeify）
    │
    ▼
5. 检查是否扩容（元素数 > 0.75 × capacity）
```

**关键演进点**：

- **从分段锁到桶头锁**：并发度从固定 16 变为 table 长度（可扩容），更细粒度。
- **CAS + synchronized 混合**：空桶用 CAS（无锁），非空桶用 synchronized（JDK 6+ 优化后开销小）。
- **链表→红黑树**：链表长度 ≥ 8 且 table ≥ 64 转红黑树，最坏查询从 O(n) 降到 O(log n)，防哈希碰撞攻击。

**get() 完全无锁**：

```java
public V get(Object key) {
    Node[] tab; int h; Node e;
    if ((tab = table) != null && (e = tab[h = hash(key)]) != null) {
        // volatile 读 + 链表遍历，不加锁
        ...
    }
    return null;
}
```

Node 的 val 和 next 是 volatile，保证可见性。get 不加锁，读多写少场景性能极高。

## 四、实战层：原子操作与热点 key 处理

**computeIfAbsent 原子操作**（替代 get-then-put）：

```java
// 反面：非原子，多线程会重复创建
ConcurrentHashMap<String, User> cache = new ConcurrentHashMap<>();
if (!cache.containsKey(key)) {
    cache.put(key, loadFromDb(key));   // 多线程同时进来，重复查 DB
}

// 正面：computeIfAbsent 原子
cache.computeIfAbsent(key, k -> loadFromDb(k));   // 桶级别原子
// 注意：lambda 内不要做长耗时操作（会锁住整个桶），不要嵌套 computeIfAbsent（JDK 8 死循环 bug）
```

**热点 key 优化**（高阶）：

```java
// 问题：某个 key（如"首页推荐"）被高频访问，computeIfAbsent 锁桶头，所有访问串行
// 方案 1：加 Caffeine 缓存（读多写少）
cache = Caffeine.newBuilder().maximumSize(10_000).build();
cache.get(key, k -> loadFromDb(k));   // Caffeine 内部优化，不阻塞

// 方案 2：细分 key（如按用户分桶）
String bucketKey = "recommend:" + (userId % 16);
cache.computeIfAbsent(bucketKey, k -> loadRecommends(userId));
// 16 个桶分散热点

// 方案 3：单飞（singleflight）——多个相同请求合并为一个 DB 查询
// Guava 13+ 不直接提供，可用 Caffeine + AsyncLoadingCache 实现
```

**LongAdder 实时计数**：

```java
// 实时 QPS 计数
LongAdder requestCounter = new LongAdder();

public void handle() {
    requestCounter.increment();
    ...
}

// 定时采集（每秒 sum 并清零）
@Scheduled(fixedRate = 1000)
public void collectQps() {
    long qps = requestCounter.sumThenReset();   // 原子 sum 并清零
    metrics.gauge("qps", qps);
}
```

**生产案例**：风控规则计数，原用 AtomicLong，QPS 5 万时 CPU 70% 在 CAS 重试。换 LongAdder，CPU 降到 15%，吞吐提升 4 倍。

## 五、底层本质：为什么分区能消除热点

回到第一性：**热点 = 多写一，分区 = 多写多**。

AtomicLong 的 value 是单一存储位置，N 个线程 CAS 时，硬件层面的缓存行被反复失效（MESI 协议），CPU 缓存失效导致主存访问，延迟飙升。这是**缓存一致性协议的瓶颈**。

LongAdder 的 Cell[] 把写分散：
- 不同 Cell 落在不同缓存行（@Contended 保证），不互相失效。
- 每个线程固定写自己的 Cell（hash 后基本稳定），缓存命中率高。
- 冲突率从接近 100%（单点）降到 1/N（N 个 Cell）。

**代价**：
- 内存：N 个 Cell 占 N × 8 字节 + padding（每个 Cell 实际占 ~128 字节）。
- 读开销：sum 遍历 N 个 Cell，比单次读 AtomicLong 慢。所以 LongAdder 适合"写多读少"。

ConcurrentHashMap 的演进同理：JDK 7 的 Segment 是粗粒度分区（16 段），JDK 8 的桶头锁是细粒度分区（table 长度，随扩容增长）。粒度越细，热点越分散，并发度越高。

这套"分区消除热点"的思想延伸到分布式系统就是分库分表（按 user_id 分片）、热点账户拆分（按子账户分散写），是高并发设计的普适范式。

## 六、AI 架构师加问：5 个 AI 相关问题

1. **AI 推理服务的请求计数用什么？**
   高 QPS（万级）用 LongAdder，低 QPS（千以下）AtomicLong 够；监控指标采集用 Micrometer 的 DistributionSummary（内部基于 HdrHistogram，分桶统计）。

2. **让 AI 排查热点，AI 接管哪段？**
   AI 解析 JFR 的 `jdk.JavaMonitorWait` 找锁等待热点；解析火焰图找 CAS 自旋占比高的方法；推荐改 AtomicLong→LongAdder 或加 Caffeine 缓存。改代码人工 review。

3. **AI 模型参数缓存的并发设计？**
   模型权重读多写极少用 Caffeine（read-through）；特征向量高频更新用 ConcurrentHashMap + computeIfAbsent；实时特征计数用 LongAdder。AI 服务要做热点 key 监控（某 user 的推荐被高频刷）。

4. **AI Agent 调用计费怎么并发计数？**
   每次 tool_call 用 LongAdder 累加 token；按用户分账用 ConcurrentHashMap<userId, LongAdder>；定时 sum 落库，避免每请求写 DB。

5. **怎么用 AI 预测热点 key？**
   历史访问日志训练，预测未来 N 分钟的 hot key；提前预热到 Caffeine；对预测的热点 key 自动细分（加 hash 后缀）。监控预测准确率，过低回退到 LRU 缓存。

## 七、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"分区消除热点、LongAdder Cell、CHM 桶头锁、computeIfAbsent 原子、size 弱一致"**。

- **分区消除热点**：多写一变多写多，CAS 冲突率 1/N
- **LongAdder**：Cell[] + base，@Contended 防伪共享，sum 弱一致
- **CHM JDK 8**：Node 数组 + 桶头 synchronized + CAS，链表 ≥8 转红黑树
- **computeIfAbsent**：原子替代 get-then-put，但避免嵌套和长 lambda
- **size() 弱一致**：估算值，精确计数用 LongAdder.sum 或加版本号

### 拟人化理解

把计数想成**超市收银**。AtomicLong 是一个收银台——所有人排队 CAS，高峰拥堵。LongAdder 是开 N 个收银台——每人去自己的台结账，最后加总。ConcurrentHashMap 是商品分到 N 个货架，每货架独立管理不互锁。size() 是"派人数货架上商品总数"，数的过程中可能有人补货，所以是估算。

### 面试现场 60 秒回答

> LongAdder 和 CHM 都用分区消除热点。LongAdder 把单个 long 拆成 Cell[]，每线程 CAS 自己的 Cell（@Contended 隔离缓存行防伪共享），读时 sum 遍历——弱一致但写性能吊打 AtomicLong 10 倍。CHM JDK 8 废弃分段锁，改用 Node 数组 + 桶头 synchronized + 空桶 CAS，链表长度 ≥8 转 O(log n) 红黑树。get 完全无锁（volatile 读）。computeIfAbsent 是原子替代 get-then-put，但避免嵌套（JDK 8 死循环 bug）和长 lambda（锁住整个桶）。热点 key 用 Caffeine 或细分 key（按 hash 分桶）。生产场景：实时 GMV、QPS 计数用 LongAdder，缓存用 Caffeine + ConcurrentHashMap。

### 反问面试官

> 贵司是写多读少（计数场景，用 LongAdder）还是读写均衡（缓存场景，用 CHM + Caffeine）？有没有热点 key 问题（如秒杀商品）？这决定我选哪个并发容器和是否需要细分 key。

## 八、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不直接 synchronized 或 AtomicLong，要 LongAdder？ | 用数据说话：8 核 1000 线程，AtomicLong 8 秒（CAS 冲突重试），LongAdder 0.8 秒。高并发下单点 CAS 是瓶颈，分区消除热点是根本解 |
| 证据追问 | 你怎么知道 AtomicLong 成了瓶颈？ | JFR 的 CAS 自旋占比（火焰图看 compareAndSwap）；async-profiler 看 CPU cache-miss 高（缓存行失效）；压测对比 AtomicLong vs LongAdder 的吞吐和 CPU |
| 边界追问 | LongAdder 能替代所有 AtomicLong 吗？ | 不能。LongAdder 读开销大（sum 遍历），读多写少场景 AtomicLong 更优；LongAdder 不支持 compareAndSet（无单点精确值）；需要原子条件判断（如"当前值=5 才更新"）必须 AtomicLong |
| 反例追问 | 什么时候 LongAdder 反而差？ | 低并发（< 100 线程）：Cell 数组的内存开销和 sum 遍历不划算，AtomicLong 更简单；需要精确值（如序列号生成）：sum 弱一致不行 |
| 风险追问 | CHM 用错最大风险？ | 主动点出：computeIfAbsent 嵌套死循环（JDK 8）、lambda 阻塞锁整桶、size() 弱一致导致对账偏差、clear() 不是原子的（put 同时 clear 可能丢数据）；扩容期间性能抖动 |
| 验证追问 | 怎么证明换 LongAdder 真的变好？ | 压测对比吞吐（应提升数倍）；JFR 看 CAS 自旋时间下降；CPU 利用率下降（从重试烧 CPU 变为实际工作）；线上看计数准确率（与实际对账偏差应 < 0.1%） |
| 沉淀追问 | 团队并发容器规范，沉淀什么？ | 计数选型表（并发度阈值选 AtomicLong/LongAdder）、禁用手写 HashMap 多线程、computeIfAbsent 注意事项、size 弱一致的对账补偿机制、热点 key 监控告警 |

### 现场对话示例

**面试官**：LongAdder 为什么比 AtomicLong 快？

**候选人**：核心是分区消除热点。AtomicLong 是单点 value，N 个线程同时 CAS 一个变量，硬件层面缓存行被反复失效（MESI 协议），CPU 缓存命中失败导致主存访问，冲突率高时大量重试烧 CPU。LongAdder 把单个 long 拆成 Cell[]，每线程通过 hash 落到自己的 Cell 做 CAS，不同 Cell 在不同缓存行（@Contended 隔离），互不干扰，冲突率从接近 100% 降到 1/N。读时 sum 遍历所有 Cell 累加，所以写快读慢，适合计数场景。8 核实测 AtomicLong 8 秒，LongAdder 0.8 秒，10 倍差距。

**面试官**：CHM JDK 7 到 8 改了什么？

**候选人**：JDK 7 是 Segment 分段锁，固定 16 段，每段一个 ReentrantLock + HashEntry 数组，并发度最高 16。JDK 8 废弃分段锁，改用 Node 数组 + 桶头 synchronized + 空桶 CAS。并发度从固定 16 变成 table 长度（随扩容增长，可达几万），粒度更细。空桶用 CAS 无锁设置，非空桶 synchronized 锁桶头（JDK 6+ synchronized 优化后开销小）。另外链表长度 ≥8 转 O(log n) 红黑树，防哈希碰撞攻击。get 完全无锁（volatile 读 val 和 next），读多写少性能极高。

**面试官**：computeIfAbsent 有什么坑？

**候选人**：三个坑。第一，JDK 8 嵌套 computeIfAbsent 会死循环（递归修改同一桶），JDK 9 修复，规则是 lambda 内不能对同一个 map 做 computeIfAbsent。第二，lambda 阻塞会锁住整个桶——如果 lambda 里查 DB 慢，所有访问这个桶的线程都卡住，要用 Caffeine 的 AsyncLoadingCache 或预加载。第三，lambda 必须非 null 返回（返回 null 不插入），语义和 put 不同。生产我会优先用 Caffeine 的 cache.get(key, loader) 替代裸 CHM 的 computeIfAbsent。

## 常见考点

1. **LongAdder.sum() 精确吗？**——不精确，遍历 Cell 期间可能有写入，返回快照值。对 QPS/GMV 计数够用，对精确序列号生成要用 AtomicLong 或加版本号。
2. **CHM 的 size() 准吗？**——弱一致估算。CHM 维护 baseCount + CounterCell[]（类似 LongAdder），size 累加，期间可能有并发修改，所以是估算值。
3. **为什么 CHM 不允许 null？**——并发下 null 有歧义：map.get(key) 返回 null，可能是没这个 key，也可能是 value 就是 null。单线程 HashMap 能用 containsKey 区分，并发下两次调用结果可能不一致，所以 CHM 强制非 null 消除二义性。
4. **CopyOnWriteArrayList 适合什么场景？**——读多写极少（如配置表、监听器列表）。写时复制整个数组（O(n) 开销），读完全无锁。写频繁场景性能崩，用 ConcurrentLinkedQueue 替代。


## 结构化回答

**30 秒电梯演讲：** 聊到LongAdder，我的理解是——LongAdder 和 ConcurrentHashMap 的共同本质是"用空间换并发度"——把一个热点变量拆成多个 Cell/Segment，让不同线程操作不同分区，最后汇总。热点不再阻塞，并发度从 1（单点 CAS）提升到 N（分区数）。打个比方，像超市收银：AtomicLong 是"一个收银台"——所有人排队 CAS，高峰期拥堵；LongAdder 是"开 N 个收银台"——每个线程去自己的收银台结账，最后把所有收银台金额加总。ConcurrentHashMap 是"商品分到 N 个货架"，每个货架独立锁，不互相阻塞。

**展开框架：**
1. **LongAdder** — Cell[] 分区 + base，sum 时累加，写多读少场景吊打 AtomicLong
2. **ConcurrentHashMap JDK 8** — Node 数组 + CAS + synchronized（锁桶头），废弃分段锁
3. **计数选型** — 低并发 AtomicLong，高并发 LongAdder；需要精确值用 LongAdder.sum()

**收尾：** 这块我在项目里也踩过坑——想深入的话，可以接着聊：LongAdder.sum() 精确吗？您更想看哪个方向？

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡 | "LongAdder——这道题面试官到底想考什么？我用 30 秒给你讲透。" | 开场钩子 |
| 0:15 | 概念结构示意图 | 先说核心：LongAdder 和 ConcurrentHashMap 的共同本质是"用空间换并发度"——把一个热点变量拆成多个 Cell/Segment，让不同线程操作不同分区，最后汇总。 | 核心定义 |
| 0:40 | ConcurrentHashMap 结构图 | Node 数组 + CAS + synchronized（锁桶头），废弃分段锁。 | ConcurrentHashMap JD |
| 1:05 | 流程图 | 低并发 AtomicLong，高并发 LongAdder；需要精确值用 LongAdder.sum()。 | 计数选型 |
| 2:30 | 总结卡 | 一句话记忆：LongAdder = Cell[] 分区 + base，写散列到 Cell，读 sum 聚合。 下期可以接着聊：LongAdder.sum() 精确吗。 | 收尾总结 |
