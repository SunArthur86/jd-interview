---
id: java-architect-117
difficulty: L3
category: java-architect
subcategory: 可观测性
tags:
- Java 架构师
- Profiling
- async-profiler
- 火焰图
feynman:
  essence: Profiling 是性能问题的"X 光"——持续采样应用的调用栈，把热点函数（CPU 占比高/分配多/锁等待长）可视化成火焰图。Java 生态核心工具：async-profiler（低开销、准）、JFR（JDK 内建、低开销）、Arthas（交互式、定位用）。本质区别于监控（看趋势）——profiling 看"为什么慢"，定位到具体方法/行号。
  analogy: 像医生的 X 光片——监控（指标）是体温计量体温（知道发烧），profiling 是 X 光（看到哪发炎）。火焰图是把时间维度压扁，函数占的宽度 = CPU 占比，一眼看出热点。
  first_principle: 性能优化的本质是"找到瓶颈"——CPU 热点（哪个方法占 CPU 多）、内存热点（哪个方法分配多）、锁热点（哪个锁等待长）。Profiling 通过高频采样（每 10ms 一次调用栈）+ 统计（栈出现的频率 = CPU 占比）定位热点。火焰图把树状调用栈压扁成层叠矩形，宽度 = 占比，高度 = 调用深度。
  key_points:
  - async-profiler：低开销（< 1%）、准确（基于 perf_events）、火焰图输出
  - JFR（Java Flight Recorder）：JDK 内建、低开销、事件驱动
  - 火焰图：宽度 = CPU 占比，高度 = 调用深度
  - 四种 profiling：CPU/Memory/Lock/Wall-clock
  - Arthas：交互式诊断（实时观测方法耗时、查看变量）
  - 采样 vs 埋点：profiling 采样（统计），不用埋点（不精确但低开销）
first_principle:
  problem: 服务慢，监控只知道 P99 = 800ms，怎么定位是哪个方法慢？
  axioms:
  - 监控看趋势（P99 高），定位看代码（哪个方法慢）
  - 全量埋点不现实（每行代码加耗时统计太贵）
  - 采样统计：高频抓调用栈，栈出现频率 = CPU 占比
  rebuild: Profiling 通过高频采样（async-profiler 每 10ms 抓一次调用栈）统计每个函数的 CPU 占比。火焰图可视化：每层是一个函数，宽度 = CPU 占比，高度 = 调用深度。一眼看出热点（最宽的方法）。四种维度：① CPU profile（CPU 热点）；② Memory profile（分配热点，找 GC 压力）；③ Lock profile（锁等待，找并发瓶颈）；④ Wall-clock（实际耗时，含 IO 等待）。
follow_up:
  - async-profiler 和 JFR 区别？——async-profiler 基于 perf_events（内核），准确、开销 < 1%；JFR 是 JDK 内建，事件驱动（对象分配/GC/锁），更详细但需要 JDK 商业特性（JDK 11+ 开源）
  - 火焰图怎么看？——横轴 CPU 占比（宽度），纵轴调用栈（深度）。找最宽的"平顶"——那是热点方法
  - CPU profile 和 Wall-clock 区别？——CPU profile 只算 CPU 时间（IO 等待不算）；Wall-clock 算墙钟时间（含 sleep/IO 等待）。CPU 密集型用 CPU profile，IO 密集型用 Wall-clock
  - 生产能持续 profiling 吗？——能。JFR 默认开启（开销 < 1%），持续录制 24h，事件循环覆盖。async-profiler 也可低频持续采样
  - 为什么不用 jstack？——jstack 是某一时刻的快照（瞬时），profiling 是持续的统计（趋势）。jstack 看死锁，profiling 看热点
memory_points:
  - async-profiler：基于 perf_events，开销 < 1%，火焰图
  - JFR：JDK 内建，事件驱动，低开销持续录制
  - 火焰图：宽度 = CPU 占比，高度 = 调用深度
  - 四维度：CPU / Memory（分配）/ Lock（锁）/ Wall-clock（墙钟）
  - CPU profile vs Wall-clock：CPU 只算 CPU 时间，Wall-clock 含等待
  - 找"平顶"：火焰图最宽的方法是热点
  - Arthas：交互式诊断（watch/trace/profiler 命令）
---

# 【Java 后端架构师】Profiling 如何定位 CPU 与内存热点

> 适用场景：JD 核心技术。订单服务 P99 从 100ms 涨到 500ms，CPU 利用率 80%，但看代码不知道哪里慢。架构师用 async-profiler 抓火焰图，发现是 JSON 序列化占 40% CPU，定位热点方法。

## 一、概念层：Profiling 的四种维度

**Profiling 是什么**：

```
应用（运行中）
   │  高频采样调用栈（每 10ms）
   ▼
采样数据（栈帧频率统计）
   │
   ▼
火焰图（可视化）
   │
   ▼
热点定位（最宽的方法 = CPU 占比最高）
```

**四种 profiling 维度**（这张表面试必问）：

| 维度 | 测量什么 | 工具 | 场景 |
|------|---------|------|------|
| **CPU profile** | CPU 时间（不含等待） | async-profiler / JFR | CPU 密集型（计算、序列化） |
| **Wall-clock** | 墙钟时间（含 sleep/IO） | async-profiler --wall | IO 密集型（DB/HTTP） |
| **Memory profile** | 对象分配（字节/次数） | async-profiler --alloc / JFR | GC 压力、内存泄漏 |
| **Lock profile** | 锁等待时间 | async-profiler --lock / JFR | 并发瓶颈 |

**火焰图怎么看**：

```
┌──────────────────────────────────────────────────────────┐
│ main                                                      │  ← 最顶层（宽度=100% CPU）
│ ├──────────────────────────┬──────────────────────────┐  │
│ │ createOrder (60%)         │ queryInventory (40%)    │  │  ← 第二层
│ │ ├─────────────┬─────────┐ │ ├──────────┬──────────┐ │  │
│ │ │ toJSON 40%  │ JDBC 20%│ │ │ Redis 25%│ JDBC 15% │ │  │  ← 第三层
│ │ │ ┌─────────┐│         │ │ │          │          │ │  │
│ │ │ │write 35%││         │ │ │          │          │ │  │  ← 第四层（writeString 最宽=热点）
│ │ │ └─────────┘│         │ │ │          │          │ │  │
│ │ └─────────────┴─────────┘ │ └──────────┴──────────┘ │  │
│ └──────────────────────────┴──────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
横轴：CPU 占比（宽度）
纵轴：调用栈深度（高度）
找"平顶"：writeString 占 35%，最宽 → 热点！
```

**核心工具对比**：

| 工具 | 类型 | 开销 | 优势 | 劣势 |
|------|------|------|------|------|
| **async-profiler** | 采样（perf_events） | < 1% | 准确、低开销、火焰图 | 需要 Linux |
| **JFR** | 事件驱动 | < 1% | JDK 内建、事件详细 | 分析需工具（JMC） |
| **Arthas** | 交互式 | 中（按需） | 实时、可视化、操作丰富 | 需 attach、生产谨慎 |
| **jstack** | 快照 | 低 | 简单、内建 | 瞬时、无统计 |
| **YourKit/JProfiler** | 商业 | 中 | UI 友好 | 收费 |

## 二、机制层：async-profiler 与 JFR 实战

**async-profiler 命令行**：

```bash
# 1. CPU profile（找 CPU 热点）
./profiler.sh -d 60 -f cpu.html <pid>
# -d 60：采样 60 秒
# -f cpu.html：输出火焰图 HTML
# 默认 CPU profile（基于 perf_events）

# 2. Memory profile（找分配热点）
./profiler.sh -d 60 -e alloc -f mem.html <pid>
# -e alloc：测量对象分配（字节）

# 3. Lock profile（找锁等待）
./profiler.sh -d 60 -e lock -f lock.html <pid>
# -e lock：测量锁等待时间

# 4. Wall-clock（找耗时含等待）
./profiler.sh -d 60 -e wall -f wall.html <pid>
# -e wall：墙钟时间（含 IO/sleep）

# 5. 指定采样频率
./profiler.sh -d 60 -i 10ms -f cpu.html <pid>
# -i 10ms：每 10ms 采样一次（默认 10ms）

# 6. 只 profile 特定方法（过滤）
./profiler.sh -d 60 --filter 'com.jd.order.*' -f cpu.html <pid>
```

**JFR 持续录制（生产推荐）**：

```bash
# 启动时开启 JFR（无开销，持续录制）
java -XX:StartFlightRecording=duration=24h,filename=/var/log/app.jfr \
     -XX:FlightRecorderOptions=stackdepth=64 \
     -jar app.jar

# jcmd 控制 JFR
jcmd <pid> JFR.start duration=1h filename=/tmp/profile.jfr
jcmd <pid> JFR.dump filename=/tmp/dump.jfr
jcmd <pid> JFR.stop

# JDK Mission Control（JMC）分析 .jfr 文件
# 看事件：对象分配、GC、锁等待、方法采样、IO
```

**JFR 关键事件**：

```java
// JDK 内建事件类型（JFR 自动采集）
jdk.GCPhasePause              // GC 暂停
jdk.ObjectAllocationSample    // 对象分配采样（找分配热点）
jdk.JavaMonitorWait           // 锁等待
jdk.ThreadPark                // 线程 park（IO 等待）
jdk.SocketRead / SocketWrite  // 网络 IO
jdk.FileRead / FileWrite      // 文件 IO
jdk.ExecutionSample           // CPU 采样（方法级热点）
jdk.Compilation               // JIT 编译

// 自定义事件（业务关键节点）
@Name("order.OrderCreated")
@Category("Business")
@Label("Order Created")
class OrderCreatedEvent extends jdk.jfr.Event {
    @Label("Order ID")
    String orderId;
    @Label("Amount")
    long amount;

    @Override
    public void commit() {
        super.commit();  // 提交事件
    }
}

// 使用
OrderCreatedEvent event = new OrderCreatedEvent();
event.orderId = "ORD123";
event.amount = 1000;
event.begin();    // 开始计时
// ... 业务逻辑
event.commit();   // 提交（自动记录时间戳）
```

**Arthas 交互式诊断**：

```bash
# 启动 Arthas（attach 到 JVM）
java -jar arthas-boot.jar <pid>

# 1. 看方法耗时（trace）
trace com.jd.order.OrderService createOrder -n 5 --skipJDKMethod false
# 实时显示 createOrder 方法每一步耗时

# 2. 看方法返回值（watch）
watch com.jd.order.OrderService createOrder returnObj -x 2
# 实时显示方法返回值

# 3. 反编译看代码（jad）
jad com.jd.order.OrderService
# 反编译指定类（确认线上版本）

# 4. profiler（async-profiler 集成）
profiler start
# 等 60 秒
profiler stop --format html --file /tmp/cpu.html
# 输出火焰图

# 5. dashboard（实时大盘）
dashboard
# 显示线程、内存、GC 实时情况
```

## 三、实战层：CPU 热点与内存热点定位

**场景 1：CPU 热点定位（JSON 序列化）**

```
现象：订单服务 CPU 80%，P99 = 500ms

步骤：
1. async-profiler 抓火焰图：
   ./profiler.sh -d 60 -f cpu.html <pid>

2. 看火焰图：
   - main 占 100%
     - createOrder 占 60%
       - toJSON 占 40%（异常宽！）
         - writeString 占 35%
           - Java 字符串拼接占 20%
     - queryInventory 占 40%

3. 根因：JSON 序列化用 Jackson + 字符串拼接，CPU 大量消耗在字符串操作

4. 优化：
   - 改用 Gson 或 Fastjson2（减少字符串分配）
   - 或预编译 ObjectMapper（避免反射开销）
   - 或用 Protobuf 替代 JSON（二进制高效）

5. 验证：CPU 降到 50%，P99 = 200ms
```

**场景 2：内存热点定位（GC 压力）**

```
现象：服务每秒 YGC 10 次，P99 抖动

步骤：
1. async-profiler 抓分配热点：
   ./profiler.sh -d 60 -e alloc -f mem.html <pid>

2. 看火焰图：
   - main
     - logDebug 占 50% 分配（异常！）
       - SLF4J 创建 Object[] 参数数组
       - 字符串拼接（即使日志级别过滤也执行）
     - parseRequest 占 30%
       - 正则表达式编译（Pattern.compile 每次调用）

3. 根因：
   - 日志没加 isDebugEnabled() 守卫，参数数组每次创建
   - 正则 Pattern 没缓存，每次重新编译

4. 优化：
   - 日志加守卫：if (log.isDebugEnabled()) log.debug("...", arg)
   - 或用参数化日志 + 占位符（SLF4J {} 延迟拼接）
   - 正则 Pattern 缓存为 static final

5. 验证：YGC 降到 2 次/秒，P99 稳定
```

**场景 3：锁热点定位（并发瓶颈）**

```
现象：服务 QPS 上不去（1000 → 1500 后持平），CPU 只有 50%

步骤：
1. async-profiler 抓锁等待：
   ./profiler.sh -d 60 -e lock -f lock.html <pid>

2. 看火焰图：
   - main
     - processRequest 占 70% 等待
       - synchronized(cache) 占 60%（异常宽！）
         - LinkedHashMap.get 占 50%（锁内执行时间长）

3. 根因：缓存用 synchronized 全局锁，QPS 上去后成为瓶颈

4. 优化：
   - 改用 ConcurrentHashMap（分段锁）
   - 或用 Caffeine（高性能缓存，无锁读）
   - 或缓存分片（减小锁粒度）

5. 验证：QPS 到 5000，CPU 70%
```

**场景 4：IO 等待定位（Wall-clock）**

```
现象：服务 CPU 只有 30%，但 P99 = 800ms

步骤：
1. async-profiler 抓 Wall-clock（含等待）：
   ./profiler.sh -d 60 -e wall -f wall.html <pid>

2. 看火焰图：
   - main
     - createOrder 占 90%（墙钟）
       - httpClient.execute 占 70%（IO 等待）
         - SocketRead 占 60%（等下游响应）

3. 根因：下游服务慢，本服务大部分时间在等 IO

4. 优化：
   - 下游服务优化（异步化、加缓存）
   - 或本服务并发调用（CompletableFuture 并发拉多个下游）
   - 或加超时 + 熔断（防雪崩）

5. 验证：P99 = 200ms（下游优化后）
```

## 四、底层本质：为什么是采样而非埋点

回到第一性：**为什么不每行代码加耗时统计，而用采样？**

- **埋点成本**：每行代码加 `long start = System.nanoTime()` + 日志，开销大（每个方法 2 次 nanoTime + 日志写入），且不能覆盖所有代码。
- **采样本质**：高频抓调用栈（每 10ms 一次），栈出现的频率 = CPU 占比。统计方法——10ms 内函数在栈顶几次 / 总采样数 = CPU 占比。低开销（< 1%），覆盖全代码。
- **精度的本质**：采样是统计概率，不是精确值。但 60 秒 × 100 次/秒 = 6000 个样本，统计意义足够。热点函数（CPU 占比 > 5%）必能发现，长尾函数（< 1%）可能漏。

**async-profiler 准确的本质**：
- 基于 Linux `perf_events`（内核态采样），准确抓调用栈。
- 不像旧 profiler（如 hprof）有 "safepoint bias"——只在 JVM safepoint 采样，错过非 safepoint 的代码。async-profiler 全程采样，无 bias。

**JFR 低开销的本质**：
- 事件驱动：只在事件发生时记录（对象分配、GC、锁等待），不是高频采样。
- ring buffer 写入：事件写入预分配的 ring buffer，无锁、无分配。
- JIT 友好：JFR 代码经过 JIT 优化，开销 < 1%。
- 持续录制：默认开 24h 录制，不影响生产。

**火焰图的本质**：
- 树状调用栈难看（嵌套深），火焰图压扁成层叠矩形。
- 宽度 = 栈帧出现频率 = CPU 占比。找最宽的"平顶"——那是热点。
- 高度 = 调用深度。深的调用链可能是过度封装（反模式）。

**为什么 CPU profile 找不到 IO 问题**：
- CPU profile 只算 CPU 时间（线程在 RUNNABLE 状态）。
- IO 等待线程是 BLOCKED/WAITING 状态，CPU profile 不采样。
- 所以 IO 密集型用 Wall-clock（含等待时间）。

## 五、AI 架构师加问：5 个

1. **AI 推理服务的 profiling 重点？**
   CPU profile 看 LLM 推理的 CPU 占比（token 解码、attention 计算）、Memory profile 看模型权重和 KV cache 分配、Wall-clock 看 GPU 等待（CPU 准备数据慢拖累 GPU）。GPU 内部 profiling 用 nsys（NVIDIA Nsight），Java 层用 async-profiler + JFR。

2. **AI 能自动分析火焰图找热点吗？**
   AI 解析火焰图数据（栈帧 + 占比），识别：① 已知反模式（字符串拼接、未缓存正则、反射调用）；② 异常宽的方法（占比 > 阈值）；③ 调用深度异常（过度封装）。AI 给优化建议："writeString 占 35%，建议改 Fastjson2 或预编译 ObjectMapper"。

3. **大模型 RAG 链路的 profiling 怎么分析？**
   Wall-clock 看：embed_query（query 向量化耗时）、vector_search（向量检索耗时）、llm_call（LLM 推理耗时，通常 80% 时间在这）。CPU profile 看 LLM 内部：tokenizer、attention、FFN 各占多少。Memory profile 看 prompt 上下文的内存分配（长 context 内存压力大）。

4. **AI 怎么做持续 profiling 异常检测？**
   持续抓火焰图（每小时一个），AI 学习正常热点分布（基线），检测异常：① 某方法占比突升（新代码引入热点）；② 调用深度变化（重构后变深）；③ 新方法出现（依赖升级引入）。AI 告警 + 对比基线火焰图，定位变化点。

5. **AI Agent 链路的 profiling 关键指标？**
   每个 tool_call 的 CPU/Memory/Wall-clock：哪个工具最占 CPU（可能逻辑复杂）、哪个最占 Wall-clock（最慢）、哪个分配最多内存（结果集大）。LLM 调用本身：CPU（推理）、Memory（KV cache）、Wall-clock（含网络等待）。profiling 帮助优化 Agent（缓存常用工具结果、并发调用独立工具）。

## 六、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"四维度、火焰图、async-profiler/JFR、找平顶"**。

- **四维度**：CPU（CPU 时间）/Wall-clock（墙钟含等待）/Memory（分配）/Lock（锁等待）
- **火焰图**：宽度 = CPU 占比，高度 = 调用深度，找最宽的"平顶"= 热点
- **async-profiler**：基于 perf_events，准确、开销 < 1%、火焰图输出
- **JFR**：JDK 内建、事件驱动、低开销持续录制（24h）
- **Arthas**：交互式诊断（trace/watch/profiler）
- **CPU profile vs Wall-clock**：CPU 只算 CPU 时间（找 CPU 密集），Wall-clock 含等待（找 IO 瓶颈）
- **采样 vs 埋点**：采样统计概率、低开销、覆盖全代码

### 拟人化理解

把 profiling 想成**医生的 X 光片**。监控（指标）是体温计量体温（知道发烧），profiling 是 X 光（看到哪发炎）。火焰图是把时间维度压扁的 X 光——每个函数占的宽度 = 它占的 CPU 比例，一眼看出哪个"器官"最活跃（热点）。宽的"平顶"就是病灶——CPU 消耗在那。CPU profile 是"代谢 X 光"（看 CPU 活动），Wall-clock 是"等待 X 光"（看 IO 等待），Memory profile 是"分配 X 光"（看对象创建），Lock profile 是"排队 X 光"（看锁等待）。

### 面试现场 60 秒回答

> Profiling 是性能问题的 X 光，通过高频采样调用栈定位热点。四种维度：CPU profile（CPU 时间，找 CPU 密集型热点）、Wall-clock（墙钟时间含 IO 等待，找 IO 瓶颈）、Memory profile（对象分配，找 GC 压力）、Lock profile（锁等待，找并发瓶颈）。核心工具：async-profiler（基于 perf_events，准确、开销 < 1%、火焰图输出）、JFR（JDK 内建、事件驱动、低开销持续录制）、Arthas（交互式诊断，trace/watch/profiler）。火焰图：宽度 = CPU 占比，高度 = 调用深度，找最宽的"平顶"= 热点。典型流程：服务慢 → async-profiler 抓火焰图 → 找热点方法（如 JSON 序列化占 40%）→ 优化（换库或预编译）→ 验证 P99 下降。采样优于埋点（低开销、覆盖全代码），是统计概率而非精确值。

### 反问面试官

> 贵司生产环境怎么持续 profiling？JFR 默认开吗？这决定我聊 JFR 事件分析还是 async-profiler 火焰图。

## 七、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 已经有监控指标了，为什么还要 profiling？ | 监控看趋势（P99 高），profiling 看根因（哪个方法慢）。监控告诉你"有问题"，profiling 告诉你"问题在哪"。两者结合才是完整诊断 |
| 证据追问 | 怎么证明 profiling 结果准确？ | ① 火焰图热点方法和代码逻辑对得上；② 优化热点后 P99 下降（验证因果）；③ 多次采样结果一致（可重现）；④ 和 JFR 事件交叉验证 |
| 边界追问 | profiling 能解决所有性能问题吗？ | 不能。GC 问题看 JFR 的 GC 事件；网络问题看 eBPF/抓包；磁盘问题看 IO 指标；业务逻辑问题看代码。profiling 主要解决"CPU/内存/锁"热点 |
| 反例追问 | 什么场景不要 profiling？ | ① 瞬时问题（偶发卡顿，采样概率漏掉）；② 内存泄漏（用 heap dump 分析）；③ 死锁（用 jstack 看线程状态）；④ 配置问题（看参数，不用 profiling） |
| 风险追问 | profiling 最大风险？ | ① 生产 profiler 开销（async-profiler < 1% 安全，其他工具可能 5%+）；② 采样 bias（只在 safepoint 采样错过非 safepoint 代码）；③ 隐私泄露（火焰图含方法名，敏感信息）。治法：用 async-profiler/JFR（低开销），无 safepoint bias |
| 验证追问 | 怎么验证优化有效？ | ① profiling 后热点占比下降（如 JSON 从 40% → 10%）；② P99/QPS 指标改善；③ CPU/内存利用率下降；④ 多次压测验证稳定性 |
| 沉淀追问 | 团队规范沉淀什么？ | ① profiling SOP（async-profiler 命令 + 火焰图阅读）；② 持续 JFR 录制策略；③ 热点阈值告警（某方法 CPU > 20% 告警）；④ 优化案例库（JSON → Fastjson、正则缓存） |

### 现场对话示例

**面试官**：async-profiler 和 JFR 用哪个？

**候选人**：场景互补。async-profiler 适合"临时抓火焰图"——服务慢了，命令行抓 60 秒，立即看热点。基于 perf_events，准确无 bias，火焰图直观。JFR 适合"持续录制"——生产默认开 24h 录制，事件驱动（对象分配/GC/锁），出问题后回放分析。最佳实践：生产 JFR 持续开（低开销），出问题用 async-profiler 抓详细火焰图，Arthas 做交互式下钻。

**面试官**：火焰图怎么找热点？

**候选人**：找"平顶"——宽度最大的方法。正常调用栈是"尖顶"（每个方法占少量 CPU），热点是"平顶"（某方法占大量 CPU）。典型平顶：JSON 序列化（writeString）、正则编译（Pattern.compile）、反射调用（Method.invoke）。看火焰图先找最宽的平顶，再看它属于哪个业务方法，定位优化点。

**面试官**：CPU profile 和 Wall-clock 什么时候用哪个？

**候选人**：看应用类型。CPU 密集型（计算、序列化）用 CPU profile——只算 CPU 时间，找到真正消耗 CPU 的方法。IO 密集型（DB、HTTP、文件）用 Wall-clock——含等待时间，找到"等 IO"的方法。典型误区：服务 CPU 30% 但 P99 高，用 CPU profile 找不到问题（因为时间在等 IO），要用 Wall-clock 才能看到 httpClient.execute 占 70%。

## 常见考点

1. **Profiling 是什么？**——高频采样调用栈定位热点，区分 CPU/Wall-clock/Memory/Lock 四维度。
2. **async-profiler 优势？**——基于 perf_events，准确无 safepoint bias，开销 < 1%，火焰图输出。
3. **火焰图怎么看？**——宽度 = CPU 占比，高度 = 调用深度，找最宽的"平顶"= 热点方法。
4. **CPU profile 和 Wall-clock 区别？**——CPU 只算 CPU 时间（找 CPU 密集热点），Wall-clock 含 IO 等待（找 IO 瓶颈）。
5. **JFR 持续录制为什么低开销？**——事件驱动（非高频采样）+ ring buffer 无锁写入 + JIT 友好，开销 < 1%。

## 结构化回答

**30 秒电梯演讲：** Profiling 是性能问题的X 光——持续采样应用的调用栈，把热点函数（CPU 占比高/分配多/锁等待长）可视化成火焰图。Java 生态核心工具：async-profiler（低开销、准）、JFR（JDK 内建、低开销）、Arthas（交互式、定位用）。本质区别于监控（看趋势）——profiling 看为什么慢，定位到具体方法/行号

**展开框架：**
1. **async-profiler** — 低开销（< 1%）、准确（基于 perf_events）、火焰图输出
2. **JFR** — JFR（Java Flight Recorder）：JDK 内建、低开销、事件驱动
3. **火焰图** — 宽度 = CPU 占比，高度 = 调用深度

**收尾：** 以上是我的整体思路。您想继续深入聊——async-profiler 和 JFR 区别？


## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：Profiling 如何定位 CPU 与内存热点 | "这题核心是——Profiling 是性能问题的X 光——持续采样应用的调用栈，把热点函数（CPU 占比高/分配……" | 开场钩子 |
| 0:15 | 像医生的 X 光片——监控（指标）是体温计量体温类比图 | "打个比方：像医生的 X 光片——监控（指标）是体温计量体温。" | 核心类比 |
| 0:40 | async-profiler示意/对比图 | "低开销（< 1%）、准确（基于 perf_events）、火焰图输出" | async-profiler要点 |
| 1:05 | JFR示意/对比图 | "JFR（Java Flight Recorder）：JDK 内建、低开销、事件驱动" | JFR要点 |
| 1:55 | 总结卡 | "记住：async-profiler。下期见。" | 收尾 |
