---
id: ant-risk-017
difficulty: L3
category: jd-core
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
