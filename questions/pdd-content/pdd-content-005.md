---
id: pdd-content-005
difficulty: L3
category: pdd-content
subcategory: JVM
tags:
- 拼多多
- 内容
- JVM
- OOM
- 内存泄漏
feynman:
  essence: OOM 是"某内存区域用尽"的报错；内容场景常见堆溢出（评价缓存无界）、Metaspace 溢出（CGLIB 动态代理）、Direct 溢出（NIO），需定位+扩容+根治。
  analogy: OOM 像房间塞满——堆是卧室（对象）、Metaspace 是书房（类信息）、Direct 是仓库（堆外），哪间满了都报。
  first_principle: 每个内存区域有上限，无界增长或不释放会导致耗尽。
  key_points:
  - 堆溢出：对象多/泄漏（评价缓存）
  - Metaspace：类元数据（CGLIB 生成类）
  - Direct：NIO 堆外内存
  - 排查：jmap dump + MAT 分析
first_principle:
  problem: 各内存区域有上限，无界增长/不释放会耗尽，如何定位+根治？
  axioms:
  - 内存区域有上限
  - 对象/类需可回收
  - 现场最珍贵（dump）
  rebuild: 监控预警 + dump 现场 + MAT 定位 + 扩容/修复。
follow_up:
  - 怎么定位内存泄漏？——jmap dump + MAT 看 GC Root 引用链
  - OOM 之前能预防吗？——JVM 参数堆+预警（75% 报警）+软引用缓存
  - Direct OOM 怎么排？——看 -XX:MaxDirectMemorySize 和 NIO 客户端配置
memory_points:
  - "堆：java.lang.OutOfMemoryError: Java heap space"
  - Metaspace：Metaspace（CGLIB）
  - Direct：Direct buffer memory（NIO）
  - 排查：jmap dump + MAT
---

# 【拼多多内容】OOM 类型与排查（内容服务实战）？

> JD 依据："稳定性建设"、"监控"。

## 一、常见 OOM 类型

| 报错 | 区域 | 内容场景原因 |
|------|------|--------------|
| Java heap space | 堆 | 评价/Feed 缓存无界、大 List 一次加载 |
| GC overhead | 堆 | GC 跑但回收 <1%，反复 Full GC |
| Metaspace | 元空间 | CGLIB 动态代理类爆炸（AOP/Bean 大量生成） |
| Direct buffer memory | 堆外 | NIO Netty DirectByteBuf 不释放 |
| unable to create new native thread | 进程 | 线程数超限（线程池泄漏） |
| StackOverflow | 栈 | 递归过深（评论树自循环） |

## 二、堆 OOM 排查（评价缓存场景）

**触发**：评价服务堆 OOM
```
java.lang.OutOfMemoryError: Java heap space
```

**步骤**：
```bash
# 1. 加参数（出问题自动 dump）
-XX:+HeapDumpOnOutOfMemoryError
-XX:HeapDumpPath=/data/dump/review.hprof

# 2. 手动 dump（运行中）
jmap -dump:format=b,file=review.hprof <pid>

# 3. MAT 分析
打开 hprof → Histogram（看对象数量 Top）
         → Dominator Tree（看占用最大的引用链）
         → Leak Suspects（自动报告嫌疑）
```

**常见根因**：
- 评价缓存 `Map<Long, Review>` 无淘汰策略 → 换 Caffeine 设 maxSize/expireAfterWrite
- 全量加载评论列表 `reviewDao.findAll()` → 改分页
- ThreadLocal 不 remove → finally 清理

## 三、Metaspace OOM（Spring AOP）

**触发**：每次请求动态生成代理类
```
java.lang.OutOfMemoryError: Metaspace
```

**排查**：`arthas dashboard` 看 Metaspace 增长曲线；`jad` 查生成的代理类。

**常见根因**：
- CGLIB 每次创建代理类（如循环里 `Enhancer.create()`）→ 复用代理
- Groovy 动态脚本编译 → 限制 + 缓存编译结果

**调优**：
```bash
-XX:MetaspaceSize=256m
-XX:MaxMetaspaceSize=512m
```

## 四、Direct OOM（直播网关 NIO）

```
java.lang.OutOfMemoryError: Direct buffer memory
```

**原因**：Netty DirectByteBuf 用完未 release（引用计数泄漏）。

**排查**：
```bash
-XX:MaxDirectMemorySize=1g   # 限制
# Netty 内存泄漏检测
-Dio.netty.leakDetection.level=PARANOID
```

**修复**：检查 ByteBuf release；用 `SimpleLeakAwareByteBuf` 定位泄漏点。

## 五、预防与监控

```java
// 缓存用 Caffeine（带淘汰）
Cache<Long, Review> cache = Caffeine.newBuilder()
    .maximumSize(100_000)
    .expireAfterWrite(10, MINUTES)
    .recordStats()
    .build();

// 监控（暴露到 Prometheus）
MemoryMXBean m = ManagementFactory.getMemoryMXBean();
m.getHeapMemoryUsage().getUsed();   // 实时堆使用
```

**报警**：堆使用 >75% 预警，>85% 严重。

## 六、底层本质

OOM 本质是**"某内存区域无界增长耗尽"**——预防靠淘汰策略+监控，定位靠 dump 现场，根治靠找 GC Root 引用链。

## 常见考点
1. **内存泄漏 vs 内存溢出**？——泄漏是对象不释放（堆慢慢长），溢出是瞬间撑爆。
2. **WeakReference/SoftReference 区别**？——Weak 下次 GC 必回收，Soft 内存不足才回收（适合缓存）。
3. **怎么在线排查**？——arthas（dashboard/heapdump/jad）或 jmap + MAT。

## 苏格拉底式面试追问

> 这组追问不是背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：内容服务 OOM 之前，你为什么强调"保留现场"比"赶紧重启恢复"更重要？**

OOM 的复现成本极高——内存泄漏是"慢累积"过程，可能跑几天才爆一次，重启后现场全没，下次还得等几天。而保留现场（HeapDump）的成本只是一次 dump（8G 堆约 30s STW + 几 GB 磁盘），换的是"能定位根因彻底解决"的机会。生产实践是 `-XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/data/dump/`——OOM 发生时 JVM 自动 dump 再退出，相当于"黑匣子"。如果不配这个参数，OOM 重启后等于每次都从零开始猜，永远治标不治本。拼多多评价/Feed 这种高频写入服务，OOM 复现窗口短（流量大累积快），现场更珍贵。

### 第二层：证据与定位

**Q：评价服务堆 OOM，dump 文件 6GB，你怎么在 6GB 里找到"是谁泄漏的"，而不是淹没在对象里？**

直接看 Histogram 会看到几百万个对象，没用。正确的定位链路：
1. MAT 打开 → 先看 "Leak Suspects" 报告（MAT 自动分析嫌疑），它会给 Top 级别的 GC Root 引用链。
2. 看 "Dominator Tree"（支配树）——按" retained size"（保留大小，即这个对象被回收能释放多少）排序，Top1 往往就是元凶。如果 Top1 是 `ConcurrentHashMap$Node` 占了 4GB，说明有个 Map 在无限增长。
3. 右键 → "Path to GC Roots" → "exclude weak/soft references"——看这个 Map 是被谁持有的，比如 `ReviewCache.map`（评价缓存）就是泄漏点。
4. 如果是 ThreadLocal 泄漏，看 `ThreadLocal$ThreadLocalMap` 的 value，再追溯是哪个线程（线程名在 `Thread` 对象里）。

### 第三层：根因深挖

**Q：你定位到是评价缓存 `Map<Long, Review>` 泄漏（无限增长）。但代码里有淘汰逻辑，为什么还泄漏？**

常见根因三类：
1. **淘汰逻辑没生效**——比如用 `ConcurrentHashMap` 配合一个定时清理任务，但定时任务挂了（线程池 shutdown 了没重启），缓存只进不出。
2. **Key 设计问题**——Key 用的是 `reviewId`，但 reviewId 是自增的，每条新评价都是新 Key，缓存存了全量历史评价。淘汰应该基于"访问时间"（LRU）而不是"数量上限"。
3. **reviewId 永不变但内容变**——缓存的是 Review 对象的引用，业务每次更新 Review 直接改对象字段，缓存"看似没涨"但对象内部引用了大 List（图片列表/评论树）。
根治：换 Caffeine（`maximumSize(100_000).expireAfterWrite(10, MINUTES)`），它内置 W-TinyLFU 淘汰策略，既能限数量又能淘汰冷数据。

### 第四层：方案权衡

**Q：你给评价缓存加了 Caffeine 上限，但业务说"缓存命中率从 90% 掉到 70%，热门商品评价读慢了"。你怎么办？**

这是典型的"用空间换命中率"冲突。分层解：
1. 先量化——命中率 90%→70% 时，评价查询 P99 从 5ms 涨到多少？如果只涨到 20ms，用户无感，可接受（换来了不 OOM）。
2. 如果确实影响，调 Caffeine 参数——`maximumSize` 从 10 万调到 50 万（评估内存预算：50 万 × 2KB/Review ≈ 1GB，堆够就加），命中率能回到 85%。
3. 加多级缓存——Caffeine（本地，挡热点）+ Redis（分布式，挡全量）。Caffeine 只存 Top 1 万热门商品的评价（用 Caffeine 的 `maximumSize` + 手动预热），Redis 存全量 + TTL。
4. 用 W-TinyLFU 优势——Caffeine 默认就是 W-TinyLFU，它对"突发访问 + 长尾"的命中率比传统 LRU 高 30%，所以同样的容量，Caffeine 比 Guava Cache 命中率高。

### 第五层：验证与沉淀

**Q：Metaspace OOM 你只把 MaxMetaspaceSize 从 256m 调到 512m，怎么确认是"真需要这么多"还是"泄漏没解决只是延缓"？**

Metaspace OOM 八成是动态类生成泄漏（CGLIB/Groovy/反射），调大只是延缓。验证是否真解决：
1. 看 Metaspace 增长曲线——`arthas dashboard` 或 Prometheus 的 `jvm_memory_used_bytes{area="nonheap"}` 看 Metaspace 占用。如果调到 512m 后曲线仍在单调上涨（几天从 300m 涨到 500m），说明泄漏还在，只是没到阈值，迟早再 OOM。
2. 看类数量——`arthas classloader` 或 `jmap -clstats`，看加载的类总数是否单调增。正常服务稳定后类数应该持平（几万），如果持续涨到几十万，是动态代理类没复用。
3. 定位泄漏源——`arthas jad` 反编译生成的代理类看命名（`$$EnhancerByCGLIB$$` / `_$$_javassist`），再 grep 代码找 `Enhancer.create()` 或 `Proxy.newProxyInstance()` 在循环里被调用的地方。
沉淀：所有 `Map` 缓存必须用 Caffeine 并设 `maximumSize`（Sonar 规则）；Metaspace 监控阈值（占用 >80% 告警）；动态代理类必须复用（封装工厂缓存 Enhancer 实例）。

## 结构化回答

**30 秒电梯演讲：** 各内存区域有上限，无界增长/不释放会耗尽，如何定位+根治？简单说就是——OOM 是"某内存区域用尽"的报错；内容场景常见堆溢出（评价缓存无界）、Metaspace 溢出（CGLIB 动态代理）、Direct 溢出（NIO），需定位+扩容+根治。Metaspace：Metaspace（CGLIB）；Direct：Direct buffer memory（NIO）。

**展开框架：**
1. **堆：java.lang.** — 堆：java.lang.OutOfMemoryError: Java heap space
2. **Metaspace** — Metaspace：Metaspace（CGLIB）
3. **Direct** — Direct：Direct buffer memory（NIO）

**收尾：** 您想继续往深里聊吗——比如「怎么定位内存泄漏？」

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：OOM 类型与排查（内容服务实战）？ | 今天聊「OOM 类型与排查（内容服务实战）？」。一句话：OOM 是"某内存区域用尽"的报错；内容场景常见堆溢出（评价缓存无界）、Metaspace 溢出（CGLIB 动态代理… | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：堆：java.lang.OutOfMemoryError: Java heap space | 核心概念 |
| 1:04 | 能力/参数拆解表 | 要点是：Metaspace：Metaspace（CGLIB） | 能力拆解 |
| 1:56 | 流程图：输入→处理→输出 | 要点是：Direct：Direct buffer memory（NIO） | 关键机制 |
| 3:00 | 总结卡 + 下期预告 | 记住这些核心点就够了。下期我们接着聊——怎么定位内存泄漏？。 | 收尾 |
