---
id: ant-risk-017
difficulty: L3
category: ant-risk
subcategory: JVM
tags:
- 蚂蚁
- 风控
- JVM
- OOM
- 内存泄漏
- 排查
feynman:
  essence: OOM 排查的核心是"分类型 + 看堆 + 找支配对象"——先判断是哪种 OOM（heap/metaspace/direct/thread），dump 堆，用 MAT 找支配树最大对象。
  analogy: OOM 像房间挤爆——先看是哪个房间爆（堆/元空间/直接内存），再看是谁占了最大空间（支配对象），最后找出"只进不出"的占用者（泄漏点）。
  first_principle: 内存是有限资源，OOM 是"申请超过可用"。根因分两类——瞬时流量大（申请多）或内存泄漏（不释放）。
  key_points:
  - OOM 类型：Java heap space（堆）/ Metaspace / GC overhead / Direct buffer / Unable to create thread
  - 自动 dump：-XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=
  - MAT 三件套：Dominator Tree（支配树）、Histogram（按类聚合）、Leak Suspects（嫌疑报告）
  - 在线诊断：jmap、arthas、jstack
first_principle:
  problem: 线上服务突然 OOM，如何在不停服的情况下快速定位是哪类 OOM、哪个对象、哪段代码导致？
  axioms:
  - OOM 必有支配对象（占用最大）
  - dump 是现场快照，事后可分析
  - 泄漏的特征是"对象只增不减"
  rebuild: 分类型判断 → dump 堆 → MAT 找支配树根 → 定位代码（看 GC Root 引用链）→ 修复（限流/缓存上限/关闭资源）。
follow_up:
- 内存泄漏和内存溢出区别？——泄漏是"用完没释放"（慢性病），溢出是"申请超过容量"（急性病）。泄漏久了导致溢出
- 怎么在线看大对象？——arthas dashboard + heapdump；jmap -histo:live 看存活对象 Top
- 风控常见 OOM 根因？——Guava Cache 无上限、ThreadLocal 没 remove、大结果集、连接泄漏
memory_points:
- OOM 五类型：heap / Metaspace / GC overhead / Direct buffer / thread
- -XX:+HeapDumpOnOutOfMemoryError 自动 dump 现场
- MAT Dominator Tree 找最大支配对象，Leak Suspects 自动分析
- 在线诊断：arthas（首选）/ jmap / jstack
---

# 【蚂蚁风控】线上服务 OOM 怎么排查？讲一次完整的排查过程

> JD 依据："基础功底扎实" + "性能和稳定性"。OOM 是 Java 服务最严重的线上事故之一。

## 一、表面层：OOM 的 5 种类型

| OOM 信息 | 含义 | 根因 |
|---------|------|------|
| `Java heap space` | 堆内存不够 | 对象太多/大对象/泄漏 |
| `GC overhead limit exceeded` | GC 占用 98% 时间但只回收 2% | 对象无法释放（泄漏） |
| `Metaspace` | 元空间不够 | 动态生成 Class（CGLIB/反射） |
| `Direct buffer memory` | 直接内存不够 | NIO ByteBuffer 未释放 |
| `unable to create new native thread` | 线程数过多 | 线程泄漏/限流不严 |

排查前**先看异常信息**判断类型。

## 二、排查套路（5 步）

### Step 1：保留现场
```bash
# JVM 参数自动 dump（生产必配）
-XX:+HeapDumpOnOutOfMemoryError
-XX:HeapDumpPath=/data/dumps/
-XX:OnOutOfMemoryError="kill -9 %p"  # 可选，OOM 后杀进程避免僵尸
```

### Step 2：在线诊断（不停服）
```bash
# 看堆使用概况
jstat -gcutil <pid> 1000
#  S0    S1    E     O     M    YGC  YGCT  FGC  FGCT
#  0.00  85.0  90.0  99.8  98%  120  2.3   45   18.5  ← O区99.8%，FGC频繁

# 看存活对象 Top
jmap -histo:live <pid> | head -20
#  num     #instances         #bytes  class name
#     1:       5,000,000    400,000,000  [Ljava.lang.Object;   ← 5M 个 Object 数组！
#     2:       4,950,000    118,800,000  java.lang.String
```

**更友好的工具：arthas**（阿里开源，强烈推荐）：
```bash
# 启动 arthas
java -jar arthas-boot.jar <pid>

# 看大盘
dashboard

# 看堆直方图
heapdump --live /tmp/heap.hprof   # 触发一次 GC 后 dump

# 看方法调用（追踪内存分配）
trace com.ant.risk.DecisionService decide
```

### Step 3：dump + MAT 分析

下载 dump 文件到本地，用 **Eclipse MAT** 打开：

**1. Leak Suspects 报告**（自动分析嫌疑）：
```
Problem Suspect 1:
  800MB 由 class "com.ant.risk.FeatureCache" 占用
  占堆的 80%
  引用链: FeatureCache.map → HashMap$Node[] → ...
```

**2. Dominator Tree**（支配树，找最大对象）：
```
Class                                  Retained Heap   Percentage
FeatureCache                           800MB           80%       ← 罪魁
  ├─ HashMap                           790MB
  │    └─ HashMap$Node[]               780MB
  └─ ...
ThreadPoolExecutor                     50MB            5%
```
**Retained Heap** = 对象本身 + 它支配的所有对象大小。

**3. 找 GC Root 引用链**（为什么没被回收）：
右键对象 → Path To GC Roots → exclude weak/soft references：
```
FeatureCache.map
  ↑
FeatureCache (static field)  ← GC Root 是静态字段！
```
**静态字段持有了 Map，Map 只进不出**。

### Step 4：定位代码
根据支配对象类型 + 引用链定位代码：
```java
// 罪魁祸首：风控特征缓存无上限
public class FeatureCache {
    private static final Map<String, Feature> CACHE = new HashMap<>();
    // ↑ 静态 HashMap，无上限、无 TTL、无淘汰

    public static void put(String uid, Feature f) {
        CACHE.put(uid, f);   // 只进不出 → 泄漏
    }
}
```

### Step 5：修复
```java
// 改用有上限的缓存
private static final Map<String, Feature> CACHE = Caffeine.newBuilder()
    .maximumSize(1_000_000)         // 上限 100万
    .expireAfterWrite(10, MINUTES)  // TTL 10 分钟
    .recordStats()                  // 记录命中率
    .build();
```

## 三、常见内存泄漏模式

**1. 静态集合**（最常见）：
```java
private static Map<String, Object> map = new HashMap<>();  // 永不释放
```

**2. ThreadLocal 没 remove**：
```java
ThreadLocal<User> tl = new ThreadLocal<>();
tl.set(user);
// 忘记 tl.remove()，线程池线程复用 → user 对象永不释放
```

**3. 监听器/回调未取消**：
```java
eventBus.register(this);   // 注册了
// 没有 eventBus.unregister(this)
```

**4. 资源未关闭**：
```java
InputStream is = new FileInputStream(...);
// 没 is.close()，文件描述符泄漏
```

**5. 缓存无淘汰策略**：
```java
Cache<Integer, BigData> cache = CacheBuilder.newBuilder().build();  // 无上限
```

## 四、风控常见 OOM 案例集

**案例 1：规则匹配大结果集**
- 现象：决策服务 OOM
- 根因：某用户的"近 90 天交易"有几百万条，规则引擎全量加载到内存
- 修复：分页加载 + 流式处理 + 上限保护

**案例 2：Kafka 消费堆积**
- 现象：特征服务 OOM
- 根因：下游慢，Kafka 消息堆积在内存缓冲区（max.poll.records 太大）
- 修复：减小 max.poll.records、加背压

**案例 3：CGLIB 代理爆 Metaspace**
- 现象：Metaspace OOM
- 根因：每次请求创建新代理 Class（错误用法）
- 修复：缓存代理 Class

**案例 4：线程池爆线程 OOM**
- 现象：unable to create new native thread
- 根因：每个请求 new Thread（无池化）
- 修复：用线程池

## 五、监控预警

**JVM 指标暴露到 Prometheus**：
```
jvm_memory_used_bytes{area="heap"}  > 80% → 告警
jvm_gc_pause_seconds > 1s           → 告警
jvm_threads_live_threads > 1000     → 告警
```

**慢查询/大对象预检**：
- 单次查询结果集 > 1万行 → 告警
- HTTP 响应体 > 10MB → 告警

## 六、底层本质：内存管理的"申请-释放"契约

OOM 的本质是**"申请内存 > 可用内存"**，原因分两类：

**1. 瞬时流量大（合理 OOM）**：
- 解决：扩容、限流、降级

**2. 内存泄漏（病态 OOM）**：
- 解决：找泄漏点、修复

**Java 内存管理的契约**：
- 申请：`new` 创建对象
- 释放：GC 自动（无引用即回收）
- **泄漏 = 引用未解除，GC 无法回收**

C/C++ 程序员要手动 free，忘记就泄漏；Java 程序员要"解除引用"，忘记也泄漏——只是更隐蔽。

**风控的预防措施**：
- 所有缓存必须有上限和 TTL
- 所有 ThreadLocal 必须 try-finally remove
- 所有资源必须 try-with-resources
- 所有集合型返回必须分页

## 常见考点
1. **`-XX:+HeapDumpOnOutOfMemoryError` 会停服吗**？——会触发一次 Full GC 来 dump（停顿几秒到几十秒），生产建议只在 OOM 时触发。
2. **MAT 怎么看是哪段代码**——找支配对象 → 看引用链 → 看 GC Root 类型（static field / Thread / 等）→ 定位代码。
3. **怎么区分 OOM 和 Full GC 频繁**？——OOM 是申请失败抛异常；Full GC 频繁是 GC 拼命回收但还没失败（GC overhead limit 是中间态）。

**代码示例**（带 OOM 保护的查询）：
```java
public List<Event> queryEvents(String uid, int limit) {
    if (limit > 10000) {
        throw new IllegalArgumentException("limit too large");  // 上限保护
    }
    List<Event> events = dao.query(uid, limit);
    if (events.size() > 5000) {
        log.warn("Large result set: uid={}, size={}", uid, events.size());
    }
    return events;
}
```

## 苏格拉底式面试追问

> 这组追问不是背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：风控决策服务堆配了 8G，你却坚持开 `-XX:+HeapDumpOnOutOfMemoryError`。dump 文件 8G 会占满磁盘且 dump 过程停服几秒，为什么一定要开？决策依据是什么？**

因为 OOM 是"必抓现场"的故障——如果不 dump，OOM 重启后现场消失，下次还会 OOM，且无法定位根因。dump 的代价（几秒停顿 + 8G 磁盘）是"一次性"的，但不 dump 的代价是"反复 OOM + 永远查不清"。我们用 `-XX:HeapDumpPath=/data/dumps/` 指向独立挂载的大磁盘（100G），并配 cron 定时清理 7 天前的 dump（避免占满）。8G 堆的 dump 停顿实测 5-10 秒（G1 的 dump 会触发 Full GC），对风控决策服务意味着这几秒请求超时，但服务本来已经 OOM 要重启了，多停 10 秒可接受。决策依据是 ROI——不开 dump 的"反复 OOM 损失"（每次 OOM 影响几分钟、可能多次）远大于开 dump 的"一次性停顿"。核心服务必须开，非核心（如离线任务）可选。

### 第二层：证据与定位

**Q：风控决策服务 OOM 了，但运维说 dump 文件没生成（磁盘上没有 hprof）。你怎么定位 OOM 类型？没有 dump 怎么分析？**

先看 OOM 的异常信息（应用日志里会有 `java.lang.OutOfMemoryError: xxx`），不同信息决定不同排查路径：
1. `Java heap space` 或 `GC overhead limit exceeded`——堆 OOM。没 dump 时，用 jstat 看历史（如果有 JMX/Prometheus 持续采集的 `jvm_memory_used_bytes` 曲线，看堆增长趋势——是缓慢增长（泄漏）还是瞬间飙高（大对象/大结果集））。下次重启前先手动 `jmap -dump:format=b,file=heap.hprof <pid>` 主动 dump（在堆高但还没 OOM 时）。
2. `Metaspace`——元空间 OOM，dump 堆没用（元空间不在堆里）。用 `jcmd <pid> GC.class_stats` 看类统计，或 arthas 的 `classloader` 命令看加载了多少 Class、哪些 ClassLoader 加载最多。常见是 CGLIB/反射动态生成 Class 没复用。
3. `Direct buffer memory`——直接内存 OOM，堆 dump 看不到。用 `jcmd <pid> VM.native_memory` 看本地内存分布，或查 Netty 的 `PooledByteBufAllocator` 指标。
4. `unable to create new native thread`——线程 OOM，`jstack <pid> | wc -l` 看线程数，`jstack` 看是什么线程爆炸（如 Tomcat、Dubbo、自建线程池）。
没 dump 时，事后靠 Prometheus 的历史曲线（堆/元空间/线程数随时间变化）+ 日志推断，比有 dump 难，所以要确保下次能 dump。

### 第三层：根因深挖

**Q：你拿到 dump，MAT 的 Dominator Tree 显示 FeatureCache 占了 6G（堆的 75%）。根因是缓存泄漏，但这个缓存用了 Caffeine（有 maximumSize=100万）。为什么还会泄漏？**

Caffeine 的 maximumSize 是"近似上限"（异步维护，可能短暂超），不会无限增长。如果 dump 显示 FeatureCache 有 5000 万条（远超 100 万上限），说明 maximumSize 没生效。几种可能：
1. 配置没生效——可能配置类没加载、或被覆盖。用 arthas ognl `@com.ant.risk.FeatureCache@CACHE` 看 CACHE 对象的实际配置（Caffeine 的 maximumSize 字段），确认值是 100 万还是被覆盖成无上限。
2. Key 不可达但 Value 持引用——Caffeine 按 key 淘汰，但如果 Value 持有 key 的强引用（如 Value 是一个包含 key 的对象图），且这个 Value 被外部 GC Root 持有，Caffeine 淘汰 key 后 Value 仍被外部引用无法回收。看 MAT 的 GC Root 引用链，确认 Feature 对象是被谁持有的。
3. 不是同一个缓存——可能 FeatureCache 有多个实例（如每个租户一个 Caffeine 实例，10000 个租户 × 100 万 = 100 亿），总量爆炸。看 dump 里 Caffeine 实例数。
真实案例常见是第 3 种——多租户场景每租户独立 Caffeine，单实例上限 100 万，但租户数 5000，总上限 50 亿。根因是"缓存隔离粒度太细"，应改为共享缓存（key 加租户前缀）+ 全局上限。

**Q：根因是多租户缓存实例爆炸。那为什么不直接调小单租户的 maximumSize？比如从 100 万调到 1 万？**

调小单租户上限会牺牲命中率。1 万的上限对大租户（百万用户）意味着 99% 未命中，风控决策要回源查 HBase（30ms），RT 从 5ms 涨到 30ms，P99 超标。根因不是"单租户上限大"，是"缓存架构没做全局控制"。正确做法是共享缓存（一个 Caffeine 实例，key = tenantId + uid，全局 maximumSize=500 万），让所有租户竞争同一个池，热点租户（大租户）自然占更多空间（Caffeine 的 W-TinyLFU 是频率敏感的，热 key 留得住），冷租户少占。这样全局上限可控（500 万 × 1KB = 5G），且命中率比"每租户 1 万"高（热的租户能拿到更多空间）。调小单租户上限是局部优化，改架构是全局优化。

### 第四层：方案权衡

**Q：你改成了共享缓存（全局 500 万上限），但业务说大租户抱怨"缓存老 miss"（小租户把空间占了）。怎么权衡大小租户的缓存公平性？**

这是缓存公平性权衡。W-TinyLFU 本身对热的 key 友好（大租户的热用户能留住），但大租户的"温用户"（访问频率中等）可能被小租户的高频垃圾请求挤出。权衡方案是"保留份额 + 共享池"——给每个租户一个"保底配额"（如每租户保底 1 万条，确保基本命中率），超出部分进共享池竞争。Caffeine 不直接支持这个，可以用"多级缓存"模拟——每租户一个小 Caffeine（1 万） + 全局一个大 Caffeine（400 万），查询时先查租户级再查全局。代价是两次查询（但都纳秒级，可忽略）+ 复杂度上升。另一种简化是给大租户单独的缓存实例（Top 100 大租户各一个 Caffeine 100 万），小租户共享一个 400 万的，按租户价值分配资源。风控选了后者——大租户是收入主力，值得独立缓存；小租户共享，miss 率高但单笔影响小。

**Q：为什么不直接换 Redis 做缓存？Redis 内存大（几百 G），不用纠结 500 万还是 1 亿上限，还天然支持租户隔离（key 前缀）。**

Redis 确实容量大，但延迟高。风控决策查缓存的 RT 预算是 5ms（本地 Caffeine 0.1ms），Redis 单次 get 走网络 1-3ms（P99 可能 10ms+），且 Redis 抖动（主从切换、慢查询）会让 P99 飙到 50ms。对 P99 <50ms 的决策链路，Redis 的延迟和抖动不可接受。Caffeine 的本地内存是纳秒级访问、无网络依赖、无抖动。Redis 的角色是"Caffeine 未命中时的二级回源"（替代 HBase），不是 Caffeine 的替代。容量和延迟是两个维度——Caffeine 小而快（热数据）、Redis 大而中（温数据）、HBase 大而慢（冷数据）。三层配合，单层都不够。纠结上限是因为"用有限的本地内存最大化命中率"，Redis 解决不了本地内存的延迟问题。

### 第五层：验证与沉淀

**Q：你修复了缓存泄漏，怎么证明 OOM 不会再发生？怎么验证内存稳定（不泄漏）？**

内存稳定性验证（持续观察 + 压测）：
1. 堆内存趋势——上线后用 Prometheus 看 `jvm_memory_used_bytes{area="heap"}` 的 7 天曲线。正常应该是"锯齿状"（GC 回收后下降、分配后上升），老年代占用稳定（不单调增长）。如果老年代单调增长（每次 GC 后基线缓慢上升），仍有泄漏。用 `jstat -gcutil <pid> 60000` 每分钟采样，看 OU（老年代使用率）趋势。
2. 压测验证——用 JMeter 压 2 倍峰值 QPS 持续 2 小时，观察堆内存是否稳定（波动但不超过 70%）。如果 2 小时后堆持续增长到 OOM，是泄漏（压测加速暴露）。
3. 缓存命中率——Caffeine 的 `cache.hit.rate` 应稳定（如 85%+），如果命中率持续下降（从 90% 降到 50%），可能是缓存被挤出（配额问题）或 key 分布变化。

**Q：怎么让团队所有缓存都安全、不再泄漏？**

沉淀成规范和工具：
1. 缓存使用规范——禁止裸用 HashMap/ConcurrentHashMap 做缓存（必须用 Caffeine/Guava Cache 且必须配 maximumSize + expireAfterWrite）。Code Review 强制检查，ArchUnit 写规则测试。
2. 缓存注册制——所有缓存实例必须注册到一个 CacheManager（统一配额、统一监控），禁止各模块自己 new Caffeine。CacheManager 统计总缓存大小，超全局阈值告警。
3. 监控基线——每个缓存的 size、hit rate、eviction count 上报 Prometheus。size 接近 maximumSize 告警（配额不足）、hit rate 低于阈值告警（缓存效果差）、eviction rate 飙升告警（可能被异常流量冲）。
4. ThreadLocal/resource 规范——所有 ThreadLocal 必须 try-finally remove（SpotBugs 检测）、所有 IO 必须 try-with-resources、所有监听器注册必须有对应 unregister。
5. 故障复盘——把这次"多租户缓存实例爆炸 → 6G 泄漏 → OOM"的 MAT Dominator Tree 截图、缓存架构改进存知识库，作为"缓存必须全局配额"的案例。


## 结构化回答

**30 秒电梯演讲：** 聊到线上服务 OOM 怎么排查？讲一次完整的排查过程，我的理解是——OOM 排查的核心是"分类型 + 看堆 + 找支配对象"——先判断是哪种 OOM（heap/metaspace/direct/thread），dump 堆，用 MAT 找支配树最大对象。打个比方，OOM 像房间挤爆——先看是哪个房间爆（堆/元空间/直接内存），再看是谁占了最大空间（支配对象），最后找出"只进不出"的占用者（泄漏点）。

**展开框架：**
1. **OOM 类型** — Java heap space（堆）/ Metaspace / GC overhead / Direct buffer / Unable to create thread
2. **自动 dump** — -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=
3. **MAT 三件套** — Dominator Tree（支配树）、Histogram（按类聚合）、Leak Suspects（嫌疑报告）

**收尾：** 这块我在项目里也踩过坑——想深入的话，可以接着聊：内存泄漏和内存溢出区别？您更想看哪个方向？

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡 | "线上服务 OOM 怎么排查？讲一次完整的排查过程——这道题面试官到底想考什么？我用 30 秒给你讲透。" | 开场钩子 |
| 0:15 | JVM 内存分代图 | 先说核心：OOM 排查的核心是"分类型 + 看堆 + 找支配对象"——先判断是哪种 OOM（heap/metaspace/direct/thread），dump 堆，用 MAT 找支配树。 | 核心定义 |
| 0:40 | 内存结构示意图 | -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=。 | 自动 dump |
| 1:05 | 概念结构示意图 | Dominator Tree（支配树）、Histogram（按类聚合）、Leak Suspects（嫌疑报告）。 | MAT 三件套 |
| 2:30 | 总结卡 | 一句话记忆：OOM 五类型：heap / Metaspace / GC overhead / Direct buffer / thread。 下期可以接着聊：内存泄漏和内存溢出区别。 | 收尾总结 |
