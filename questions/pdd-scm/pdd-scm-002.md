---
id: pdd-scm-002
difficulty: L3
category: pdd-scm
subcategory: JVM
tags:
- 拼多多
- 供应链
- JVM
- OOM
- 内存泄漏
feynman:
  essence: JVM 内存分堆/非堆/直接内存，OOM 按区域分 5 类；排查靠"分类型→dump→MAT 支配树→GC Root 引用链→代码"五步，供应链最常见的 OOM 是大批量商品数据一次性加载。
  analogy: JVM 内存像仓库分区——堆是主仓库（货物/对象），元空间是档案室（类信息），直接内存是装卸区（NIO），线程是叉车。某个区爆仓就是对应 OOM。
  first_principle: 内存是有限资源，OOM = 申请超容量；根因要么瞬时需求大（流量洪峰），要么慢性泄漏（只进不出）。
  key_points:
  - OOM 五类型：heap / Metaspace / GC overhead / Direct buffer / thread
  - 必配：-XX:+HeapDumpOnOutOfMemoryError
  - MAT 三件套：Dominator Tree、Histogram、Leak Suspects
  - 在线诊断：arthas、jmap -histo:live
first_principle:
  problem: 线上 JVM 突然 OOM，如何在不中断服务的情况下定位是哪类 OOM、哪个对象、哪段代码？
  axioms:
  - OOM 必有支配对象（占用最大）
  - dump 是现场快照
  - 泄漏的特征是"对象只增不减"
  rebuild: 分类型 → dump → MAT 找支配树根 → 看 GC Root 引用链 → 定位代码（静态集合/ThreadLocal/未关资源）→ 修复。
follow_up:
- 供应链系统常见 OOM 根因？——批量导出商品 Excel（百万行加载内存）、订单全量同步、缓存无上限
- 怎么在线看大对象？——arthas dashboard + heapdump；jmap -histo:live 看 Top
- 怎么预防？——缓存必须有 LRU/TTL、批量必须有分页、返回集合必须有上限
memory_points:
- OOM 五类型：heap / Metaspace / GC overhead / Direct buffer / thread
- HeapDumpOnOutOfMemoryError 必配
- MAT Dominator Tree 找最大支配对象
- 供应链最大坑：批量导出/同步一次性加载全量数据
---

# 【拼多多供应链】线上 OOM 怎么排查？供应链系统最常见的 OOM 场景？

> JD 依据："JVM 原理和调优经验" + "线上系统稳定性和维护经验"。

## 一、OOM 五类型

| OOM 信息 | 含义 | 典型根因 |
|---------|------|---------|
| `Java heap space` | 堆满 | 大对象/泄漏/批量加载 |
| `GC overhead limit exceeded` | GC 占 98% 时间回收 2% | 泄漏（无法释放） |
| `Metaspace` | 元空间满 | CGLIB/反射动态生成 Class |
| `Direct buffer memory` | 直接内存满 | NIO ByteBuffer 泄漏 |
| `unable to create new native thread` | 线程过多 | 线程池无界/每次 new Thread |

## 二、排查五步法

```
1. 保留现场：-XX:+HeapDumpOnOutOfMemoryError（必配）
2. 在线诊断：jstat -gcutil / arthas dashboard / jmap -histo:live
3. dump + MAT 分析：Dominator Tree 找最大支配对象
4. 看 GC Root 引用链：为什么没被回收（static 字段/ThreadLocal/未关资源）
5. 定位代码修复
```

## 三、供应链典型 OOM 场景

**场景 1：商品批量导出**
```java
// ❌ 一次性把百万商品加载到内存
List<Product> all = productDao.findAll();  // OOM!
writeExcel(all);

// ✅ 流式 + 分页
int page = 0;
while (true) {
    List<Product> batch = productDao.findPage(page++, 1000);
    if (batch.isEmpty()) break;
    writeExcelRow(batch);  // 用 EasyExcel 的 SXSSF 流式写
}
```

**场景 2：订单全量同步**
```java
// ❌ 全量加载订单同步到下游
List<Order> orders = orderDao.findByDateRange(year);  // 千万级 → OOM

// ✅ 游标分页（避免 OFFSET 深分页性能问题）
long lastId = 0;
while (true) {
    List<Order> batch = orderDao.findByIdGreaterThan(lastId, 1000);
    if (batch.isEmpty()) break;
    syncToDownstream(batch);
    lastId = batch.get(batch.size() - 1).getId();
}
```

**场景 3：商品缓存无上限**
```java
// ❌ 静态 HashMap 缓存商品（永不淘汰）
private static final Map<Long, Product> CACHE = new HashMap<>();
// 拼多多千万级 SKU → 几个 GB → OOM

// ✅ Caffeine 带上限和 TTL
private static final Cache<Long, Product> CACHE = Caffeine.newBuilder()
    .maximumSize(500_000)
    .expireAfterWrite(10, MINUTES)
    .build();
```

## 四、MAT 分析实战

**Leak Suspects 报告**会直接指出嫌疑：
```
800MB 由 com.pdd.scm.ProductCache 占用（堆的 80%）
引用链: ProductCache.map (static) → HashMap$Node[] → ...
```

**Dominator Tree** 看 Retained Heap（支配大小）排序，最大的是罪魁。

**Path To GC Roots**（排除 weak/soft 引用）看为什么没回收——static 字段是最常见的 GC Root。

## 五、预防机制（拼多多经验）

1. **所有缓存必须有上限和 TTL**
2. **所有批量接口必须分页**（单页 ≤ 1000）
3. **所有返回集合必须有 size 上限**（防止下游传超大条件）
4. **监控告警**：堆使用率 > 80% 告警，Full GC 频率 > 1/10min 告警
5. **压测验证**：大促前压测找出内存瓶颈

## 六、底层本质：内存的"申请-释放"契约

OOM = 申请 > 可用。根因两类：
- **瞬时需求大**：扩容/限流/降级
- **慢性泄漏**：找泄漏点修复

Java 自动 GC 不代表不泄漏——**"引用没解除"就是泄漏**。供应链的高频大查询最容易触发，必须有系统性的上限保护。

## 常见考点
1. **怎么区分 OOM 和 Full GC 频繁**？——OOM 是申请失败抛异常；Full GC 频繁是 GC 拼命回收但还没失败。
2. **StackOverflowError 和 OOM 区别**？——栈溢出（递归太深）vs 堆/元空间溢出。
3. **`-XX:+HeapDumpOnOutOfMemoryError` 会停服吗**？——会触发 Full GC dump（停顿几秒到几十秒），生产建议只在 OOM 时触发。

## 苏格拉底式面试追问

> 这组追问不是背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：供应链系统凌晨 3 点触发 OOM 告警，但你登服务器发现进程已经被 -XX:+HeapDumpOnOutOfMemoryError 自动重启了。你第一件事做什么——直接看 dump 还是先恢复服务？**

先恢复服务再查根因。OOM 后 JVM 可能处于半死状态（Full GC 死循环），自动重启是对的。第一件事是确认重启后服务健康——看 `/actuator/health`、看 QPS 是否恢复、看是否有用户报错。同时把 dump 文件（`java_pid{xxx}.hprof`）从生产机拷出来避免被覆盖。根因排查在服务恢复后做，因为 dump 是静态快照，不影响线上。

### 第二层：证据与定位

**Q：你打开 dump 文件，MAT 显示 800MB 被 `ProductCache.map` 占用（堆的 80%）。你怎么确认这就是 OOM 的根因而不是巧合？**

看三组证据：
1. **Dominator Tree 的 Retained Heap 排序**——`ProductCache.map` 的 Retained 是 800MB，第二名只有 50MB，断层式领先，说明它是内存主占用。
2. **Path to GC Roots（exclude weak/soft references）**——看 `map` 为什么没被回收，如果链路是 `ProductCache.map (static) → HashMap$Node[]`，说明是 static 字段持有，GC 永远不回收。
3. **Histogram 看对象增长**——对比昨晚正常时段的 dump，`Product` 对象从 5 万涨到 500 万，说明是"只增不减"的泄漏特征。三条证据吻合，坐实是 ProductCache 无上限导致的 heap OOM。

### 第三层：根因深挖

**Q：ProductCache 为什么会涨到 800MB？代码里明明写了 LRU 淘汰，根因到底在哪？**

看 Caffeine 配置和实际 Key 分布。真实案例的根因有两个：
1. **Key 设计错**：缓存 Key 用 `skuId + 日期`（`1001_20260713`），每天 1000 万 SKU × 日期 = 每天新增 1000 万 Key，`maximumSize=500000` 淘汰根本赶不上新增速度，但 Caffeine 的 W-TinyLFU 策略在"全是新 Key"场景下命中率骤降，淘汰滞后。
2. **Value 对象过大**：`Product` 对象包含完整的属性树（规格/图片 URL 列表/价格历史），单个 1.6KB，500 万就是 8GB。根因不是淘汰策略，是 Value 没有精简——只缓存销售需要的 `skuId + price + stock`，详情走 DB。

**Q：那为什么不直接把 maximumSize 调到 5000 万？**

调大只是延缓。5000 万 Key × 1.6KB = 80GB，单机堆根本放不下，而且大促时 SKU 数会继续涨，调到 1 亿照样爆。治本有两步：一是精简 Value（只存必要字段，从 1.6KB 降到 200B），二是换存储——千万级 SKU 的全量缓存本就不该堆在 JVM 里，应该放 Redis（`HSET product:{skuId} price stock`），JVM 只用 Caffeine 做本地热点缓存（top 10 万 SKU）。

### 第四层：方案权衡

**Q：你把全量缓存迁到 Redis 了，但业务反馈热点商品查询延迟从 1ms 涨到 8ms（Redis RTT），怎么办？**

这是典型的"内存换延迟"权衡。解法是两级缓存：
1. **L1 Caffeine 本地缓存**：只放 top 1 万热点 SKU（按销量排序），TTL 5 分钟，命中率监控 > 60%。热点查询走本地（0.1ms），长尾走 Redis（8ms）。
2. **布隆过滤器防穿透**：查询前先过 Bloom Filter（Caffeine 支持 `Caffeine.newBuilder().build()` + Guava BloomFilter），不存在的 SKU 直接返回，不打 Redis。

**Q：为什么不直接给 JVM 加内存到 64GB，把缓存全放本地？**

三个问题：
1. **GC 灾难**——64GB 堆用 G1，Mixed GC 停顿会到秒级（Region 多、标记慢），库存扣减这种低延迟链路直接超时。
2. **多实例不一致**——4 台机器各缓存一份，商品价格更新后要广播失效，一致性难保证。
3. **成本**——64GB 内存机器比 8GB + Redis 贵得多，且 Redis 是共享的，4 台机器共享一个 Redis 集群比分摊内存更划算。所以大缓存必须走 Redis，JVM 只放极少量热点。

### 第五层：验证与沉淀

**Q：你修复上线后，怎么证明 OOM 真的不再发生了，而不是这几天的流量刚好低？**

三个验证手段：
1. **对比验证**：上线前后各观察 7 天，看 `jvm.memory.heap.used` 指标——修复后堆使用率稳定在 30-40%（之前是涨到 95% 触发 OOM）。
2. **压力验证**：主动跑全量商品导出压测（之前就是这场景触发的），连续跑 2 小时，堆不超 50%，`GC overhead` 为 0。
3. **归一化**：把 `heap_used / sku_count` 算成"每 SKU 内存占用"，修复后稳定在 200B（精简后的 Value 大小），而修复前是线性增长（泄漏特征）。

**Q：怎么让团队以后不踩缓存 OOM 的坑？**

沉淀三条硬规范：
1. **Code Review 检查项**：所有 `Cache`/`Map` 声明必须有 `maximumSize`，否则 CR 不通过；SonarQube 加规则扫描无界集合。
2. **缓存准入清单**：新增缓存必须登记（Key 设计、Value 大小预估、预估容量、淘汰策略），架构师 review。
3. **监控告警**：每个 Caffeine 实例上报 `cache.size` 和 `estimatedSize()`，超阈值（如 80% maximumSize）告警，提前发现增长异常。

## 结构化回答

**30 秒电梯演讲：** 线上 JVM 突然 OOM，如何在不中断服务的情况下定位是哪类 OOM、哪个对象、哪段代码？简单说就是——JVM 内存分堆/非堆/直接内存，OOM 按区域分 5 类；排查靠"分类型→dump→MAT 支配树→GC Root 引用链→代码"五步。

**展开框架：**
1. **OOM 五类型** — OOM 五类型：heap / Metaspace / GC overhead / Direct buffer / thread
2. **必配** — 必配：-XX:+HeapDumpOnOutOfMemoryError
3. **MAT 三件套** — MAT 三件套：Dominator Tree、Histogram、Leak Suspects

**收尾：** 您看这块要不要再展开聊聊？

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：线上 OOM 怎么排查？供应链系统最常见的 OOM 场景？ | 今天聊「线上 OOM 怎么排查？供应链系统最常见的 OOM 场景？」。一句话：JVM 内存分堆/非堆/直接内存，OOM 按区域分 5 类；排查靠"分类型→dump→MAT 支配树→GC Root … | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：OOM 五类型：heap / Metaspace / GC overhead / Direct buffer / thread | 核心概念 |
| 1:04 | 能力/参数拆解表 | 要点是：必配：-XX:+HeapDumpOnOutOfMemoryError | 能力拆解 |
| 1:56 | 流程图：输入→处理→输出 | 要点是：MAT 三件套：Dominator Tree、Histogram、Leak Suspects | 关键机制 |
| 3:00 | 总结卡 + 下期预告 | 记住核心要点就够了。下期见。 | 收尾 |
