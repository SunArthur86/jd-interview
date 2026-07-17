---
id: java-architect-109
difficulty: L2
category: java-architect
subcategory: JVM
tags:
- Java 架构师
- JFR
- 性能画像
- 诊断
feynman:
  essence: JFR（Java Flight Recorder，JDK 11+ 开源）是 JVM 内置的低开销持续性能画像——生产环境一直开（< 1% 开销），事件流式写入环形缓冲区，事故时 dump 最近 1 小时数据。它把 GC、内存、锁、IO、CPU、虚拟线程等画像合一，是"不重启 JVM 排查问题"的杀手锏。
  analogy: 像飞机黑匣子：平时一直录（飞行数据、机舱对话），出事故时取出来回放。JFR 录 JVM 的"飞行数据"（GC、锁、IO、内存），事故时 dump 最近 1 小时回放，不用复现。
  first_principle: JVM 性能问题的复现成本高（线上环境、生产数据、特殊流量），等"重启后开监控"常常问题已消失。JFR 让监控在生产常态化运行（< 1% 开销），事件存环形缓冲区（自动滚动），事后回放——把"事故后无法复现"变成"事故后必有数据"。
  key_points:
  - JFR（JDK 11+ 开源）：JVM 内置，< 1% 开销，生产常开
  - jcmd JFR.start / JFR.dump / JFR.stop 在线控制
  - 事件类型：GC、内存、锁、IO、CPU、虚拟线程、对象分配
  - 两种模式：continuous（生产常驻，maxage/maxsize 滚动）+ profiling（短期压测）
  - 工具：jfr print（命令行）、JMC（GUI）、Grafana（JFR datasource）
first_principle:
  problem: JVM 性能问题怎么"不重启、不加大开销"地持续观测？
  axioms:
  - 重启会丢失现场（问题不再复现）
  - 传统监控（jstack/jmap）是侵入性的（STW 或开销大）
  - 性能问题需要"事件流"（什么时间发生什么），不是"快照"
  rebuild: JFR 在 JVM 内部持续记录事件（GC、对象分配、锁竞争、IO、方法采样），事件按类型分到不同缓冲区，线程本地缓冲 → 全局缓冲 → 磁盘。开销 < 1%（HotSpot 高度优化），生产常驻。事故时 jcmd JFR.dump 取最近 N 小时数据，离线分析。从"事故后无法复现"变成"事故后必有数据"。
follow_up:
  - JFR 和 async-profiler 区别？——JFR 是 JVM 内置（事件驱动，含锁/IO/对象分配），async-profiler 是外部工具（采样为主，火焰图好）。两者互补：JFR 全景画像常驻，async-profiler 深度采样按需
  - JFR 开销真的小吗？——JDK 11+ 开源后实测 < 1%（OpenJDK 文档承诺 < 1%）。开 settings=profile 时 1-3%（更详细事件）
  - 怎么看 JFR 数据？——jfr print（命令行，简单查询）、JDK Mission Control（GUI，深度分析）、Grafana JFR datasource（看板）、自定义解析（jfr tools 库）
  - 事件阈值怎么定？——duration threshold（如 jdk.VirtualThreadPinned 默认 20ms）控制记录哪些事件。生产建议默认 settings，需要深度排查用 settings=profile
  - 持续画像和按需画像区别？——continuous（maxage=1h maxsize=512m，常驻滚动）适合生产；profiling（duration=60s，详细事件）适合压测。两者可叠加
memory_points:
  - JFR（JDK 11+ 开源）：JVM 内置，< 1% 开销，生产常开
  - jcmd JFR.start/dump/stop 在线控制
  - continuous（生产常驻，maxage/maxsize 滚动）+ profiling（短期压测）
  - 事件类型：GC、内存、锁、IO、CPU、虚拟线程、对象分配
  - jdk.VirtualThreadPinned / jdk.GCPhasePause / jdk.ObjectAllocationSample
  - 工具：jfr print（CLI）、JMC（GUI）、Grafana（看板）
---

# 【Java 后端架构师】JFR 在线诊断与持续性能画像

> 适用场景：JD 核心技术。订单服务大促期间偶发 P99 抖动，但等运维 jstack / jmap 时问题已消失。JFR 让生产环境持续画像（< 1% 开销），事故时 jcmd JFR.dump 取最近 1 小时数据回放，定位 GC、锁、IO、对象分配的真实瓶颈。

## 一、概念层：JFR 是什么、为什么生产常开

**JFR 的核心特性**（这张表面试必问）：

| 特性 | 说明 |
|------|------|
| **JVM 内置** | JDK 11+ 开源（Oracle JDK 11 之前是商业特性） |
| **低开销** | < 1%（continuous 模式，OpenJDK 承诺） |
| **事件驱动** | 不是采样，是事件（GC、锁、IO、方法执行、对象分配） |
| **环形缓冲** | 线程本地 → 全局 → 磁盘，maxage/maxsize 自动滚动 |
| **在线控制** | jcmd JFR.start/dump/stop 不重启 JVM |
| **可扩展** | 自定义事件（JFR Event API），业务关键路径可埋点 |

**JFR vs 传统监控工具**：

| 工具 | 开销 | 模式 | 适合场景 |
|------|------|------|---------|
| **JFR** | < 1% | 持续 + 按需 | 生产常态画像 + 事故回放 |
| jstack | 中（STW） | 按需快照 | 线程死锁、CPU 飙升 |
| jmap | 高（STW） | 按需快照 | OOM 后堆分析 |
| async-profiler | < 1% | 按需采样 | 火焰图、CPU/Memory profile |
| jstat | 低 | 持续采样 | GC 频率、堆使用率 |
| Prometheus | 低 | 持续聚合 | 业务指标、告警 |

**JFR 的不可替代性**：
- jstack/jmap 是"快照"（一次性），错过就没数据
- Prometheus 是"聚合"（QPS/P99），无个体事件
- JFR 是"事件流"（每个 GC、每次锁竞争、每个慢方法都记录），事故后回放

## 二、机制层：JFR 启动、事件、分析

**JFR 启动方式**：

```bash
# 方式 1：启动时配 JFR（生产推荐）
java -XX:StartFlightRecording=\
  filename=/data/jfr/app-$(date +%s).jfr,\
  settings=profile,\
  maxage=1h,\
  maxsize=512m,\
  disk=true \
  -jar app.jar
# settings=profile：详细事件（含方法采样、对象分配）
# settings=default：基础事件（轻量，< 1% 开销）
# maxage=1h：保留最近 1 小时
# maxsize=512m：磁盘文件最大 512MB（自动滚动）

# 方式 2：运行时启动（不重启 JVM）
jcmd <pid> JFR.start name=live settings=profile maxage=1h maxsize=512m

# 方式 3：dump 当前 JFR（不停止录制）
jcmd <pid> JFR.dump name=live filename=/data/jfr/dump-$(date +%s).jfr

# 方式 4：停止录制
jcmd <pid> JFR.stop name=live

# 方式 5：查看录制中的 JFR 列表
jcmd <pid> JFR.check
```

**核心事件类型**（架构师必须能列出）：

| 事件类型 | 用途 | 关键事件 |
|---------|------|---------|
| **GC** | GC 频率、停顿、回收效率 | jdk.GCPhasePause, jdk.GarbageCollection |
| **内存** | 对象分配、堆使用 | jdk.ObjectAllocationSample, jdk.GCHeapSummary |
| **锁** | 锁竞争、死锁 | jdk.JavaMonitorEnter, jdk.JavaMonitorWait |
| **IO** | 文件、Socket | jdk.FileRead/Write, jdk.SocketRead/Write |
| **方法** | 方法采样（CPU profile） | jdk.ExecutionSample |
| **虚拟线程** | pinning、调度 | jdk.VirtualThreadStart/Pinned/Submit |
| **类加载** | 类加载冲突、Metaspace | jdk.ClassLoad, jdk.ClassDefine |
| **JVM** | 异常、错误 | jdk.JavaExceptionThrow, jdk.JavaErrorThrow |

**自定义业务事件**（JFR Event API）：

```java
// 自定义事件：记录关键业务流程
@Name("jd.OrderCreate")
@Label("Order Create")
@Category({"JD", "Business"})
@Description("Order creation event")
public class OrderCreateEvent extends jdk.jfr.Event {
    @Label("Order ID")
    String orderId;

    @Label("User ID")
    Long userId;

    @Label("Amount")
    BigDecimal amount;

    @Label("Duration")
    @Timespan(Timespan.NANOSECONDS)
    long duration;
}

// 业务代码使用
public Order createOrder(OrderDTO dto) {
    OrderCreateEvent evt = new OrderCreateEvent();
    evt.orderId = dto.getOrderId();
    evt.userId = dto.getUserId();
    evt.begin();
    try {
        Order order = doCreate(dto);
        evt.amount = order.getAmount();
        return order;
    } finally {
        evt.end();
        evt.commit();    // 写入 JFR 缓冲区
    }
}
```

## 三、实战层：典型排查场景

**场景 1：定位 P99 RT 抖动**

```bash
# 1. 启动时配 continuous JFR（生产常驻）
java -XX:StartFlightRecording=filename=/data/jfr/app.jfr,settings=profile,maxage=1h,maxsize=512m -jar app.jar

# 2. 抖动发生时 dump JFR
jcmd <pid> JFR.dump name=1 filename=/data/jfr/p99-spike.jfr

# 3. 分析
jfr print --events jdk.GCPhasePause,jdk.JavaMonitorEnter p99-spike.jfr | head -100
# 看抖动时间点有没有 GC pause（> 100ms）
# 看有没有锁竞争（jdk.JavaMonitorEnter 的 duration > 50ms）

# 4. 方法采样定位慢方法
jfr print --events jdk.ExecutionSample p99-spike.jfr \
  | awk '/^StackTrace/ {flag=1} flag' \
  | grep -A 20 "com.jd.order" | head -50
# 看抖动时段哪些方法采样最多
```

**场景 2：虚拟线程 pinning 排查**

```bash
# 自定义 JFR 配置（开启 pinning 事件，threshold 调到 10ms）
cat > /data/jfr/vt.jfc << EOF
<?xml version="1.0" encoding="UTF-8"?>
<configuration version="2.0">
  <event name="jdk.VirtualThreadPinned">
    <setting name="enabled">true</setting>
    <setting name="threshold">10ms</setting>
  </event>
  <event name="jdk.VirtualThreadStart">
    <setting name="enabled">true</setting>
  </event>
  <event name="jdk.VirtualThreadSubmit">
    <setting name="enabled">true</setting>
  </event>
</configuration>
EOF

jcmd <pid> JFR.start name=vt settings=/data/jfr/vt.jfc maxage=1h

# 1 小时后 dump
jcmd <pid> JFR.dump name=vt filename=/data/jfr/vt-dump.jfr

# 分析 pinning 热点
jfr print --events jdk.VirtualThreadPinned vt-dump.jfr | head -50
# 按 duration 排序找 Top N pinning 代码段
```

**场景 3：对象分配热点（allocation stall / OOM 前兆）**

```bash
jcmd <pid> JFR.dump name=1 filename=/data/jfr/alloc.jfr

# 查对象分配采样（哪个类分配最多）
jfr print --events jdk.ObjectAllocationSample alloc.jfr \
  | grep "objectClass" | sort | uniq -c | sort -nr | head -10

# 输出示例：
# 12345 byte[]                  ← 大量 byte[] 分配
#  8721 java.lang.String
#  5432 java.util.HashMap$Node
#  3210 com.jd.OrderItem
```

**场景 4：锁竞争定位**

```bash
jfr print --events jdk.JavaMonitorEnter alloc.jfr \
  | awk '/duration/ {print $3}' | sort -nr | head -10
# 看锁等待最久的 Top 10

# 结合堆栈定位锁竞争点
jfr print --events jdk.JavaMonitorEnter alloc.jfr \
  | awk '/duration = [0-9]{4,}/' \
  | head -20
# 找 duration > 1000ms（1s）的锁等待
```

## 四、底层本质：JFR 为什么低开销

回到第一性：**JFR 怎么做到 < 1% 开销的？**

- **事件分类 + 缓冲区分层**：
  ```
  线程本地缓冲（无锁，每线程一个） → 全局缓冲（少量锁） → 磁盘（异步写）
  ```
  线程写事件到本地缓冲无竞争（无锁），定期 flush 到全局缓冲（少量锁），全局缓冲异步写磁盘（IO 不阻塞业务）。

- **采样 vs 全量**：
  - 高频事件（方法执行、对象分配）用采样（如每 10ms 采一次方法、每 1KB 分配采一次），不全量记录
  - 低频事件（GC、锁竞争、IO 慢）全量记录（本身就少）
  - 这让"事件数量"可控（万级/秒），不会拖垮业务

- **JIT 优化**：
  - JFR 代码被 JIT 内联（事件写入是几条指令）
  - 关闭 JFR 时，相关代码被 JIT 完全消除（dead code elimination），开销为 0
  - 开启 JFR 时，事件写入是 thread-local 数组操作，纳秒级

- **OpenJDK 的承诺**：
  - settings=default：< 1% 开销（生产可常驻）
  - settings=profile：1-3% 开销（含详细方法采样、对象分配采样）
  - 即使开 profile，对业务延迟影响 < 5%

**为什么 JFR 比 BCI（Byte Code Instrumentation）工具低开销**：

- BCI 工具（如 SkyWalking、Pinpoint 的 agent）在每个方法前后插桩（埋点），所有方法都受影响
- JFR 用 JVM 内部钩子（不是字节码插桩），JIT 可以优化掉
- JFR 的事件写入是 thread-local 无锁，BCI 工具的埋点常常有锁或同步

**JFR 的环形缓冲设计**：

```
Thread 1 ──→ Thread-local Buffer ─┐
Thread 2 ──→ Thread-local Buffer ─┼─→ Global Buffer ──→ Disk File
Thread N ──→ Thread-local Buffer ─┘   (maxage 滚动)      (maxsize 滚动)

maxage=1h：保留最近 1 小时事件，老的自动滚动删除
maxsize=512m：磁盘文件最大 512MB，满了自动滚动
```

事故时 dump 当前环形缓冲内容，拿到最近 1 小时的所有事件。

## 五、AI 架构师加问：5 个

1. **AI 自动分析 JFR 找性能瓶颈怎么设计？**
   AI 解析 jfr 文件（jfr tools 库），按事件类型分类：GC pause Top N、锁竞争 Top N、对象分配 Top N、方法采样 Top N。结合业务知识（高频方法是否关键路径）输出"Top 3 优化建议 + 证据（事件 + 堆栈）"。误报控制：要 AI 区分"高频但非热点"（如日志方法采样多但不是瓶颈）和"真热点"（CPU 时间占比高）。

2. **AI 推理服务用 JFR 监控什么？**
   关键事件：jdk.ObjectAllocationSample（大对象分配，如 attention matrix）、jdk.JavaMonitorEnter（锁竞争）、jdk.SocketRead/Write（RPC 调用）、jdk.GarbageCollection（GC pause）。自定义事件：ModelInference（每次推理的延迟、token 数、模型版本）。AI 分析推理 P99 抖动时关联 GC、锁、IO 事件归因。

3. **AI Copilot 帮业务写 JFR 自定义事件，最容易翻车在哪？**
   三个点：① 事件 begin/end/commit 调用顺序（begin 必须在 try 前，commit 必须在 finally，否则事件不记录或记录错误）；② 字段类型（JFR 限定支持基本类型和 String，复杂对象要 toString）；③ 事件频率（高频事件如每次循环都 commit 会撑爆缓冲，要采样）。AI 输出要 lint 这些规则。

4. **JFR 数据接入 RAG 让 AI 助手回答性能问题怎么做？**
   知识库分层：JFR 事件类型文档、JDK 官方调优指南、事故复盘（JFR 数据 + 根因）。检索时按问题类型过滤（GC 问题只检索 GC 事件文档）。AI 看到当前服务的 jfr print 输出，RAG 检索相似历史事故，输出"这个 GC pause 模式像 XX 事故，建议检查 YY"。

5. **大模型推理服务的 JFR 自定义事件设计？**
   核心：ModelInferenceEvent（begin/end/commit 包住一次推理）。字段：model_version（字符串）、prompt_tokens（int）、completion_tokens（int）、latency_ms（long）、cache_hit（boolean）。配合 jdk.GCPhasePause（GC 是否影响推理）和 jdk.SocketRead（推理调下游）做归因。AI Agent 分析"为什么 P99 推理慢"时把这些事件关联。

## 六、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"JVM 内置、< 1% 开销、事件驱动、生产常开、jcmd 控制"**。

- **本质**：JVM 内置的低开销持续画像（< 1% 开销）
- **模式**：continuous（生产常驻，maxage/maxsize 滚动）+ profiling（短期压测）
- **事件**：GC、内存、锁、IO、方法采样、虚拟线程、对象分配
- **控制**：jcmd JFR.start/dump/stop，不重启 JVM
- **工具**：jfr print（CLI）、JMC（GUI）、Grafana（看板）
- **低开销原理**：线程本地缓冲 + 采样 + JIT 优化
- **不可替代**：jstack/jmap 是快照，JFR 是事件流，事故必有数据

### 拟人化理解

把 JFR 想成**飞机黑匣子**。平时一直录（飞行数据、机舱对话），出事故时取出来回放。JFR 录 JVM 的"飞行数据"——GC pause、锁竞争、IO 慢、对象分配热点。事故发生时 jcmd JFR.dump 取最近 1 小时回放，看到"10:23:45 有 200ms GC pause"、"10:23:50 锁竞争 1s"、"10:23:55 大量 byte[] 分配"，定位根因不用复现。

### 面试现场 60 秒回答

> JFR（Java Flight Recorder）是 JVM 内置的低开销持续画像（< 1% 开销），生产环境一直开。事件驱动（GC、内存、锁、IO、方法采样、虚拟线程、对象分配），事件流式写入线程本地缓冲 → 全局缓冲 → 磁盘，maxage/maxsize 自动滚动。生产用 settings=default（轻量）+ continuous 模式，事故时 jcmd JFR.dump 取最近 1 小时数据。核心排查场景：P99 抖动（关联 GC pause 和锁竞争）、虚拟线程 pinning（jdk.VirtualThreadPinned 事件）、对象分配热点（jdk.ObjectAllocationSample）、OOM 前兆。和 async-profiler 互补：JFR 全景画像常驻，async-profiler 深度采样按需。低开销靠线程本地缓冲（无锁）+ 采样（不全量）+ JIT 优化。

### 反问面试官

> 贵司生产环境 JFR 是常驻还是事故时开？事故平均定位时间（MTTR）多少？有没有用过 JMC 或自研 JFR 分析工具？这决定我聊 JFR 持续画像还是按需排查。

## 七、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 已经有 Prometheus 监控了，为什么还要 JFR？ | Prometheus 是聚合指标（QPS/P99），无个体事件；JFR 是事件流（每个 GC、每次锁竞争、每个慢方法都记录）。事故时 Prometheus 看到 P99 抖动，但不知道为什么——JFR 能看到抖动时段的 GC、锁、IO、方法采样。证明：P99 抖动排查时间从 30 分钟降到 5 分钟 |
| 证据追问 | 怎么证明 JFR 真的 < 1% 开销？ | OpenJDK 官方承诺 < 1%；压测对比开/关 JFR 的 QPS 差异（应 < 1%）；JFR 自己有 jdk.ActiveRecording 事件记录开销。生产长期开 JFR 的服务 QPS 和未开的服务对比无差异 |
| 边界追问 | JFR 能解决所有 JVM 问题吗？ | 不能。业务逻辑 bug（如计算错误）看代码；网络问题要抓包；JVM crash 看 core dump；操作系统问题看 dmesg。JFR 主要解决"性能画像"问题 |
| 反例追问 | 什么场景不要开 JFR？ | 极致吞吐场景（< 1% 也想省）、JDK < 11（不开源）、磁盘紧张（JFR 写盘）、容器无持久化存储（jfr 文件丢失）。但大多数生产场景都应该开 |
| 风险追问 | 长期开 JFR 最大风险？ | ① 磁盘占用（maxsize 控制，但要注意）；② 事件缓冲内存（小，但极端场景要监控）；③ 敏感数据（业务事件可能含 PII，要脱敏）。治法：maxsize 限制、敏感字段不进 JFR、定期清理 |
| 验证追问 | 怎么证明 JFR 帮助了排查？ | 对比"开 JFR 前"vs"开 JFR 后"的 MTTR（平均定位时间）；统计事故"JFR 提供关键证据"的比例；团队反馈排查效率提升 |
| 沉淀追问 | 团队推广 JFR 沉淀什么？ | 默认 JVM 启动参数模板（含 -XX:StartFlightRecording）、JFR 事件查询 SOP（按场景）、JMC 培训、自定义业务事件规范、JFR 数据接入告警平台 |

### 现场对话示例

**面试官**：生产环境 JFR 一直开会影响性能吗？

**候选人**：OpenJDK 承诺 < 1% 开销，实测确实如此。三个原因：第一，事件写入是线程本地缓冲（无锁），几条指令搞定；第二，高频事件用采样（如方法采样每 10ms 一次、对象分配每 1KB 采样一次），不全量记录；第三，JIT 优化——JFR 代码被内联，关闭时相关代码被消除。生产建议 settings=default（轻量）+ maxage=1h + maxsize=512m，磁盘 512MB 滚动。事故时 jcmd JFR.dump 取最近 1 小时数据。

**面试官**：JFR 和 async-profiler 用哪个？

**候选人**：互补。JFR 是 JVM 内置、事件驱动（GC、锁、IO、对象分配都记录）、生产常驻；async-profiler 是外部工具、采样为主、火焰图好、按需启动。生产常态画像用 JFR（一直在录），深度排查某个性能问题时用 async-profiler 出火焰图。两者数据可以交叉验证。JFR 是"全景"，async-profiler 是"放大镜"。

**面试官**：怎么用 JFR 排查虚拟线程 pinning？

**候选人**：JDK 21+ 内置 jdk.VirtualThreadPinned 事件（threshold 默认 20ms）。第一步，自定义 JFR 配置把 threshold 调到 10ms（抓更小 pinning），jcmd JFR.start settings=vt.jfc 启动。第二步，跑半小时压测，dump jfr 文件。第三步，`jfr print --events jdk.VirtualThreadPinned dump.jfr` 查所有 pinning 事件，按 duration 排序找 Top N。第四步，结合堆栈定位代码——如 com.example.OrderService.queryDB 在 synchronized 块内 IO 阻塞。最后换 ReentrantLock 治理。

## 常见考点

1. **JFR 是什么？**——JDK 11+ 开源的 JVM 内置持续画像，< 1% 开销，事件驱动，生产常驻。
2. **JFR 怎么启用？**——启动时 -XX:StartFlightRecording=settings=profile,maxage=1h,maxsize=512m；运行时 jcmd JFR.start/dump/stop。
3. **JFR 低开销原理？**——线程本地缓冲（无锁）+ 采样（不全量）+ JIT 优化（事件代码内联/消除）。
4. **JFR 和 async-profiler 区别？**——JFR 内置、事件驱动、生产常驻；async-profiler 外部、采样为主、按需启动。互补。
5. **怎么用 JFR 排查 P99 抖动？**——dump 抖动时段的 jfr，jfr print 查 GC/锁/IO/方法采样事件，关联时间点定位瓶颈。

## 结构化回答

**30 秒电梯演讲：** JFR（Java Flight Recorder，JDK 11+ 开源）是 JVM 内置的低开销持续性能画像——生产环境一直开（< 1% 开销），事件流式写入环形缓冲区，事故时 dump 最近 1 小时数据。它把 GC、内存、锁、IO、CPU、虚拟线程等画像合一，是不重启 JVM 排查问题的杀手锏

**展开框架：**
1. **JFR（JDK 11+ 开源）** — JVM 内置，< 1% 开销，生产常开
2. **jcmd JFR.sta** — jcmd JFR.start / JFR.dump / JFR.stop 在线控制
3. **事件类型** — GC、内存、锁、IO、CPU、虚拟线程、对象分配

**收尾：** 以上是我的整体思路。您想继续深入聊——JFR 和 async-profiler 区别？


## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：JFR 在线诊断与持续性能画像 | "这题核心是——JFR（Java Flight Recorder，JDK 11+ 开源）是 JVM 内置的低开销持续……" | 开场钩子 |
| 0:15 | JFR（JDK 11+ 开源）示意/对比图 | "JVM 内置，< 1% 开销，生产常开" | JFR（JDK 11+ 开源）要点 |
| 0:40 | jcmd JFR.sta示意/对比图 | "jcmd JFR.start / JFR.dump / JFR.stop 在线控制" | jcmd JFR.sta要点 |
| 1:25 | 总结卡 | "记住：JFR。下期见。" | 收尾 |
