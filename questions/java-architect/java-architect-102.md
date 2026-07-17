---
id: java-architect-102
difficulty: L3
category: java-architect
subcategory: Java 并发
tags:
- Java 架构师
- 虚拟线程
- pinning
- JFR
feynman:
  essence: pinning 是虚拟线程在阻塞时无法把 continuation unmount 到堆，导致 carrier 平台线程被"钉死"的现象。三大元凶：synchronized 块内阻塞、JNI 内阻塞、特定 native IO。治理不是"换 ReentrantLock"那么简单——要先靠 JFR 的 jdk.VirtualThreadPinned 事件定位热点、再按代价（改造 vs 升级 JDK 24）排序修复。
  analogy: 像地铁乘客（虚拟线程）霸座（pinning）——车厢（carrier）眼看还有 50 个空位，但被霸座的座位不能用。霸座乘客越多，地铁实际运力越接近车厢数。JFR 是车厢监控摄像头，能精确拍到哪个乘客在哪个站霸座多久。
  first_principle: carrier 数 = CPU 核数，是吞吐上限。pinning 让 carrier 无法服务其他虚拟线程，等价于把虚拟线程降级回平台线程。pinning 率（pinned 时长 / 总运行时长）超过 10% 就基本没有虚拟线程收益了。
  key_points:
  - pinning 三大元凶：synchronized 块内阻塞、JNI/native 阻塞、Object.wait（已部分修复）
  - 诊断利器：JFR jdk.VirtualThreadPinned 事件，含 duration + 堆栈
  - jcmd + jstack 看 carrier 数和虚拟线程挂起原因
  - JDK 21/22/23 都有 pinning，JDK 24（JEP 491）才修 synchronized
  - 治理路径：JFR 画像 → 按热点排序 → synchronized 换 ReentrantLock / native 调用换 NIO
first_principle:
  problem: 虚拟线程在 carrier 上执行时，哪些情况无法 unmount continuation，如何量化发现并修复？
  axioms:
  - carrier 是稀缺资源（CPU 核数个），pinning 一个就少一个
  - JVM 无法 unmount 的根因是栈帧被外部持有（monitor 的 owner 字段、JNI 局部引用）
  - 阻塞 + 无法 unmount = pinning；阻塞 + 能 unmount = 正常虚拟线程行为
  rebuild: 先用 JFR 持续采集 jdk.VirtualThreadPinned 事件（duration threshold 默认 20ms），按堆栈聚合找出 Top N pinning 代码段。再分类治理：① synchronized → ReentrantLock（最常见）；② native IO → NIO/AsyncClient；③ 第三方库（如老版 DatabaseDriver）→ 升级或替换。最后 JDK 24 GA 后整体升级根治 synchronized。
follow_up:
  - 怎么判断一个 pinning 是"严重"还是"可忽略"？——看 duration × frequency。100ms 以上的 pinning 即使频率低也有问题；< 1ms 的 pinning 即使每秒万次也基本无感
  - JFR 的 jdk.VirtualThreadPinned 阈值怎么设？——jdk.VirtualThreadPinned 默认 threshold=20ms，生产可调到 10ms 看高频小 pinning；开销可控（事件本身很轻）
  - 第三方库（如 JDBC 驱动、HttpClient）的 pinning 怎么办？——升到 JDK 友好版本。MySQL Connector/J 8.0.33+、PostgreSQL 42.6+ 已修常见 pinning
  - pinning 会导致吞吐下降多少？——按 pinning 率算。100% pinning = 退化为平台线程；10% pinning = 吞吐损失约 10%（与 carrier 数相关）
  - JDK 24 之后 synchronized 就完全不 pinning 了吗？——基本是，JEP 491 把 Object.wait/synchronized 都改为可 unmount；但 JNI 内阻塞仍可能 pinning
memory_points:
  - pinning = 虚拟线程阻塞但 carrier 无法让出 = 退化为平台线程
  - 三大元凶：synchronized 块内阻塞、JNI/native 阻塞、第三方库老版本
  - 诊断：JFR jdk.VirtualThreadPinned 事件（duration threshold 20ms）
  - 治理：synchronized → ReentrantLock；native → NIO；第三方库升级
  - JDK 24（JEP 491）彻底修 synchronized pinning
  - jstack 看 carrier 数 = `ForkJoinPool-1-worker-N`，挂起 reason = "wait" 时是 pinned
---

# 【Java 后端架构师】虚拟线程 pinning 问题如何发现与治理

> 适用场景：JD 核心技术。订单服务迁移到 JDK 21 虚拟线程后，压测发现 QPS 只比平台线程池高 20%（预期是 5 倍），jstack 一片 carrier 在 RUNNABLE 但实际啥也没干。架构师必须能用 JFR 在线诊断 pinning、按 ROI 排序治理。

## 一、概念层：pinning 的本质与载体代价

**pinning 是什么**：虚拟线程在 carrier 上执行时遇到阻塞，但 JVM 无法把它的 continuation unmount 到堆，于是 carrier 平台线程被"钉死"陪着虚拟线程一起阻塞。pinning 期间这个 carrier 无法服务其他虚拟线程。

**carrier 数 = 吞吐上限**：

```
CPU 8 核 → ForkJoinPool 平台 carrier 8 个

正常情况（无 pinning）：
  100 万虚拟线程，8 个 carrier 高速 mount/unmount，吞吐拉满

pinning 情况（synchronized 阻塞）：
  100 万虚拟线程，5 个 carrier 被钉死等数据库
  实际只有 3 个 carrier 在工作 → 吞吐接近平台线程 8 个的水平
```

**三大 pinning 元凶对比**（这张表面试必问）：

| 元凶 | 触发场景 | 修复方法 | JDK 24 是否根治 |
|------|---------|---------|----------------|
| **synchronized 块内阻塞** | `synchronized(lock){ db.query(); }` | 换 ReentrantLock | 是（JEP 491） |
| **JNI / native 方法阻塞** | 老 JDK IO、第三方 native 库 | 换 NIO / 升级库 | 部分（Object.wait 修复） |
| **Object.wait()** | 部分并发工具的内部实现 | JDK 21 已修大部分 | 是 |
| **第三方库内部 synchronized** | MySQL Connector/J < 8.0.33 | 升级版本 | 升级后自动获益 |

## 二、机制层：JFR + jstack 诊断 pinning

**JFR 开启 VirtualThreadPinned 事件**（生产必开）：

```bash
# 1. 启动时配 JFR（持续低开销画像）
java -XX:StartFlightRecording=\
  filename=/data/jfr/vt-$(date +%s).jfr,\
  settings=profile,\
  maxage=1h,\
  maxsize=512m \
  -jar app.jar

# 2. 或运行时 jcmd 启动
jcmd <pid> JFR.start name=vt-profile settings=profile maxage=1h maxsize=512m

# 3. 自定义 JFR 配置，开启 VirtualThreadPinned（默认开启但 threshold 20ms）
# 文件 vt-config.jfc 关键片段：
# <event name="jdk.VirtualThreadPinned">
#   <setting name="enabled">true</setting>
#   <setting name="threshold">10ms</setting>   <!-- 调低能抓小 pinning -->
# </event>
jcmd <pid> JFR.start name=vt settings=vt-config.jfc maxage=1h

# 4. dump 当前 JFR 到文件
jcmd <pid> JFR.dump name=vt filename=/data/jfr/dump.jfr
```

**JFR 事件查询（jfrprint / JMC）**：

```bash
# 用 jfr print 工具（JDK 自带）查询 pinning 事件 Top N
jfr print --events jdk.VirtualThreadPinned dump.jfr | head -50

# 输出示例：
# jdk.VirtualThreadPinned {
#   startTime = 2026-07-13T10:23:45.123Z
#   duration = 245 ms        ← pinning 时长
#   thread = "vt-order-123" (java.lang.VirtualThread)
#   stackTrace = {
#     java.lang.Object.wait0(Object.java)        ← synchronized wait
#     com.example.OrderService.queryDB(OrderService.java:45)
#     ...
#   }
# }

# 按 pinning 时长排序找热点
jfr print --events jdk.VirtualThreadPinned dump.jfr \
  | grep "duration =" | sort -t= -k2 -nr | head -20
```

**jstack 看 carrier 与虚拟线程状态**：

```bash
jcmd <pid> Thread.print > thread-dump.txt

# 关键看：
# "vt-order-123" #456 VirtualThread            ← 虚拟线程
#   java.lang.Thread.State: WAITING (on object monitor)
#       at java.lang.Object.wait0(...)
#       - locked <0x...> (a java.lang.Object)   ← 有 monitor = pinning
# 
# "ForkJoinPool-1-worker-3" #12                ← carrier 平台线程
#   java.lang.Thread.State: RUNNABLE
#       at java.lang.VirtualThread$VThreadContinuation.yield(...)  ← 正常调度

# carrier 在 RUNNABLE 但 CPU 利用率低 = 大量 pinning
```

**Carrier 数与利用率关系**：

```bash
# 查 ForkJoinPool 的并行度（carrier 数）
jcmd <pid> VM.flags | grep -i parallelism
#   ForkJoinPool.common.parallelism = 8   ← 默认 = CPU 核数

# 用 Micrometer 监控
# 指标 1：jvm.threads.virtual.count（虚拟线程数）
# 指标 2：carrier CPU 利用率（process_cpu_usage）
# 指标 3：自定义 pinned_counter（从 JFR 事件聚合）
```

## 三、实战层：典型 pinning 场景与治理案例

**场景 1：synchronized + IO 阻塞（最高频）**

```java
// 反例（pinning 元凶）
public class OrderCache {
    private final Map<String, Order> cache = new HashMap<>();

    public Order get(String id) {
        synchronized (cache) {            // ← 整个 carrier 钉死
            Order o = cache.get(id);
            if (o == null) {
                o = db.query(id);         // ← IO 阻塞 + synchronized = pinning
                cache.put(id, o);
            }
            return o;
        }
    }
}

// 修复 1：换 ConcurrentHashMap（无锁）
public class OrderCache {
    private final ConcurrentHashMap<String, Order> cache = new ConcurrentHashMap<>();

    public Order get(String id) {
        return cache.computeIfAbsent(id, this::dbQuery);  // ← dbQuery 在虚拟线程上 unmount
    }
}

// 修复 2：换 ReentrantLock（功能等价）
public class OrderCache {
    private final Map<String, Order> cache = new HashMap<>();
    private final ReentrantLock lock = new ReentrantLock();

    public Order get(String id) {
        lock.lock();
        try {
            // ... 业务
        } finally {
            lock.unlock();               // ← ReentrantLock 不 pinning
        }
    }
}
```

**场景 2：第三方 JDBC 驱动内部 synchronized**

```java
// 反例：MySQL Connector/J 8.0.32 内部有 synchronized + socket read
// JFR jdk.VirtualThreadPinned 堆栈：
//   com.mysql.cj.jdbc.StatementImpl.executeQuery(...)
//   com.mysql.cj.protocol.a.NativeProtocol.readMessage(...)
//   synchronized(this.connectionLock) {   ← 第三方库内部 pinning
//       socketImpl.read(...)
//   }

// 修复：升级到 8.0.33+（已修 synchronized pinning）
// pom.xml
<dependency>
    <groupId>mysql</groupId>
    <artifactId>mysql-connector-java</artifactId>
    <version>8.0.33</version>            <!-- 或 8.4.0 -->
</dependency>
```

**场景 3：FileInputStream / 老 IO**

```java
// 反例：FileInputStream.read() 在 JDK 21 部分实现仍 pinning
FileInputStream fis = new FileInputStream("big.log");
byte[] buf = new byte[8192];
fis.read(buf);                            // ← 可能 pinning

// 修复：用 NIO（虚拟线程友好）
try (FileChannel ch = FileChannel.open(Path.of("big.log"))) {
    ByteBuffer buf = ByteBuffer.allocate(8192);
    ch.read(buf);                         // ← NIO 在虚拟线程上正常 unmount
}

// 或用 java.net.http.HttpClient（已针对虚拟线程优化）
HttpClient client = HttpClient.newHttpClient();
HttpRequest req = HttpRequest.newBuilder(URI.create("https://api.jd.com")).build();
HttpResponse<String> resp = client.send(req, BodyHandlers.ofString());  // ← 友好
```

**治理工作流（架构师必备 SOP）**：

```
1. 压测建立基线：QPS / P99 / carrier CPU / jvm.threads.virtual
        │
        ▼
2. JFR 持续采集 jdk.VirtualThreadPinned，dump 分析
        │
        ▼
3. 按堆栈聚合 Top 10 pinning 代码段（duration × frequency 排序）
        │
        ▼
4. 分类治理：
   - synchronized → ReentrantLock（业务代码）
   - 第三方库 synchronized → 升级到 JDK 21 友好版本
   - native IO → NIO / AsyncClient
        │
        ▼
5. 验证：同一压测对比 QPS 提升、pinning 事件数下降
        │
        ▼
6. 上线灰度：10% 流量跑 3 天看 P99 不退化、pinning 持续下降
        │
        ▼
7. 中长期：评估升级 JDK 24（JEP 491）根治 synchronized pinning
```

## 四、底层本质：为什么 synchronized 不能 unmount

回到第一性：**为什么 synchronized 块内阻塞无法 unmount continuation，而 ReentrantLock 可以？**

- **synchronized 的 monitor**：JVM 用对象头（Mark Word）存储 monitor 状态，wait queue 由 JVM 管理。当线程进入 synchronized 块时，JVM 把线程 ID 写入对象头，unmount continuation 会破坏这个映射（continuation 复制到堆后，对象头的线程 ID 失效）。所以 JDK 21/22/23 选择 pinning（保守），JDK 24（JEP 491）通过重写 monitor 实现（脱离对象头，用单独的 ObjectMonitor 数据结构）才允许 unmount。
- **ReentrantLock**：基于 AQS（AbstractQueuedSynchronizer），等待队列是 Java 对象，park/unpark 通过 `LockSupport` 实现，与 continuation 协调好（park 时 JVM 知道这是 Java 层阻塞，可以 unmount）。
- **JNI 内阻塞**：JVM 看不到 native 栈（C/C++ 栈），无法把 native 栈打包成 continuation，所以 JNI 内阻塞必然 pinning。这是 JDK 24 也无法解决的——native 代码必须自己改用非阻塞 IO。

**pinning 不一定是 bug**：synchronized 块内的纯 CPU 计算（不阻塞 IO）不 pinning，因为没阻塞就没 unmount 需求。pinning 只在"synchronized + 阻塞 IO/wait/sleep"组合时发生。所以"看到 synchronized 就紧张"是过度反应——要看块内是否有阻塞操作。

## 五、AI 架构师加问：5 个

1. **让 AI 自动扫描代码找 pinning 风险，怎么设计？**
   静态规则 + 历史堆栈学习。静态规则：synchronized 块内调用 sleep/wait/IO/socket/db 的代码段（AST 扫描）；历史：JFR jdk.VirtualThreadPinned 的堆栈做语料训练分类器。输出风险评分 + 修复建议（换 ReentrantLock / 改 NIO）。误报主要来自 synchronized 块内纯 CPU 计算，要 AI 区分。

2. **AI 自动把 synchronized 改成 ReentrantLock 安全吗？**
   不全自动。语义差异：synchronized 是块结构（自动释放），ReentrantLock 要显式 unlock（漏掉 finally 就死锁）；synchronized 不可中断，ReentrantLock.lockInterruptibly 可中断。AI 改造必须保证 try-finally 包裹、评估中断语义变化、跑回归测试。建议 AI 出 diff，人工 review。

3. **AI 推理服务用 JNI 调 GPU 库（CUDA/ONNX Runtime），怎么避免 pinning？**
   JNI 内阻塞必然 pinning，无法绕过。解法：把 GPU 推理调用包到固定大小的平台线程池（不要走虚拟线程），通过队列和虚拟线程解耦。即：虚拟线程接收 HTTP 请求 → 提交推理任务到 platform executor → 等结果（虚拟线程 unmount）→ 返回。GPU 限制的是平台线程池大小（按 GPU 显存和并发算）。

4. **怎么用 AI 评估 JDK 24 升级的 pinning 收益？**
   用 JFR 历史数据：把所有 synchronized 相关的 jdk.VirtualThreadPinned 事件按 duration 求和，估算升级后这部分 pinning 全部消失能提升多少 carrier 利用率。结合吞吐公式（吞吐 ≈ carrier 数 / (1 - pinning 率)）算预期 QPS 增益，再对比升级风险（JDK 24 兼容性、新 GC 行为）做决策。

5. **大模型 Agent 调用工具时频繁 pinning，AI 怎么自愈？**
   Agent 的 tool_call 内部如果调用第三方 SDK（如某些 SaaS API 用老 IO），会 pinning。自愈策略：① AI 检测 pinning 频发自动切换 SDK 实现（如 Apache HttpClient → java.net.http.HttpClient）；② 用 circuit breaker 跳过 pinning 频发的 tool，返回降级结果；③ 长期重写 tool wrapper 用虚拟线程友好的 IO 库。

## 六、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"三大元凶、JFR 看 pinned、按 ROI 治理、JDK 24 根治"**。

- **三大元凶**：synchronized+IO、JNI/native、第三方库老版本
- **诊断**：JFR `jdk.VirtualThreadPinned` 事件（threshold 20ms）+ jstack 看 carrier
- **治理**：synchronized → ReentrantLock；native → NIO；第三方库 → 升级
- **指标**：pinning 率 > 10% 基本没收益；duration × frequency 排序找热点
- **根治**：JDK 24（JEP 491）让 synchronized 可 unmount
- **carrier**：CPU 核数个，是吞吐上限，pinning 等于退化

### 拟人化理解

把 pinning 想成**地铁霸座**。carrier 是车厢（CPU 核数节），虚拟线程是乘客。正常情况下乘客到站下车（unmount），车厢立刻接新乘客。但有的乘客（synchronized 阻塞）霸座——上车后赖着不动，车厢眼看是空的也用不了。JFR 是车厢监控摄像头（jdk.VirtualThreadPinned 事件），能精确拍到"vt-order-123 在 OrderService.java:45 霸座 245ms"。治理就是劝离霸座乘客（换 ReentrantLock），或者等地铁升级（JDK 24）让所有座位都不允许霸座。

### 面试现场 60 秒回答

> pinning 是虚拟线程阻塞时无法 unmount continuation，导致 carrier 被钉死，吞吐退化到平台线程水平。三大元凶：synchronized 块内 IO 阻塞、JNI/native 阻塞、第三方库老版本（如 MySQL Connector/J < 8.0.33）。诊断用 JFR 的 jdk.VirtualThreadPinned 事件（threshold 默认 20ms），按 duration × frequency 排序找 Top N 热点，jstack 看 carrier 数和挂起 reason。治理路径：synchronized 换 ReentrantLock 或 ConcurrentHashMap、native IO 换 NIO、第三方库升级到 JDK 21 友好版本。根治要等 JDK 24 的 JEP 491（让 synchronized 可 unmount）。pinning 率超过 10% 就基本没虚拟线程收益，所以治理要按 ROI 排序——先改 Top 3 高频 pinning 代码段。

### 反问面试官

> 贵司 JDK 版本是 21 还是 24+？synchronized 用得多吗（可以扫一下代码或问业务背景）？JFR 配置是默认还是自定义？这决定我聊 pinning 治理还是直接推荐升级 JDK 24。

## 七、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不直接等 JDK 24 再上虚拟线程，现在治理 pinning 有意义吗？ | 业务时间窗：现在有 IO 密集瓶颈（线程池打满），等 JDK 24 GA + 生产验证要 1 年。先用 JDK 21 + 治理 Top N pinning 拿 80% 收益，再升级 JDK 24 拿剩下 20%。证明：pinning 率从 30% 降到 5% 时 QPS 已翻倍 |
| 证据追问 | 怎么证明线上真的有 pinning 问题？ | JFR 采集 jdk.VirtualThreadPinned 事件统计 duration 总和、frequency；jstack 看 carrier RUNNABLE 但 CPU 利用率低；对比虚拟线程开启前后 QPS 没提升。证据：pinning 事件 Top 堆栈都指向 OrderService.queryDB |
| 边界追问 | pinning 是不是只要 synchronized 就有？ | 不是。synchronized 块内纯 CPU 计算不 pinning（没阻塞没 unmount 需求），只有 synchronized + 阻塞 IO/wait/sleep 才 pinning。要看块内代码。Object.wait() 在 JDK 21 已基本修复 |
| 反例追问 | 什么 pinning 可以忽略不治理？ | duration < 1ms 且 frequency 低（如启动时初始化锁）、synchronized 块内无 IO 操作（纯内存）、第三方库 pinning 但调用频率极低（如配置加载）。按 ROI（duration × frequency）排序，Top 20% 代码段贡献 80% pinning 时长 |
| 风险追问 | 治理 pinning 时换 ReentrantLock 最大风险？ | 主动点出：① 漏 finally unlock 死锁（synchronized 自动释放，ReentrantLock 显式）；② 中断语义变化（synchronized 不可中断，ReentrantLock 可）；③ 公平锁 vs 非公平锁行为差异。治法：Code Review 强制 try-finally 模板、跑并发回归测试 |
| 验证追问 | 怎么证明治理后真的减少了 pinning？ | 同一压测对比：JFR jdk.VirtualThreadPinned 事件数下降 80%+；jstack carrier RUNNABLE 占比和 CPU 利用率匹配；QPS 提升 + P99 不退化。线上灰度 10% 流量跑 3 天 |
| 沉淀追问 | 团队防 pinning 沉淀什么？ | Code Review checklist（synchronized 块内是否有 IO、是否用 NIO）、JFR 配置模板（含 VirtualThreadPinned threshold=10ms）、第三方库 JDK 21 友好版本清单、pinning 治理 SOP（JFR 画像 → Top N → ROI 排序） |

### 现场对话示例

**面试官**：你们订单服务上了虚拟线程，压测 QPS 只比平台线程高 30%，怎么定位？

**候选人**：第一反应是 pinning。先 jcmd 启动 JFR 持续画像（settings=profile，maxage=1h），跑半小时压测，dump 出 jfr 文件用 `jfr print --events jdk.VirtualThreadPinned` 看 pinning 事件。如果事件多且 duration 长（> 100ms），就是 pinning 问题。按堆栈聚合 Top 10，常见的是 synchronized 块内调数据库（业务代码）或第三方库（MySQL 驱动老版本）。算 pinning 率（pinning 总时长 / 总运行时长），如果 > 10%，carrier 实际有效工作时间只有 (1 - 10%) × 8 核 = 7.2 核，吞吐自然上不去。

**面试官**：具体怎么治理？

**候选人**：按 ROI 排序。第一步，JFR Top 3 堆栈定位代码——比如 OrderService.queryDB 用了 `synchronized(cache)` 包 IO 调用，换成 ConcurrentHashMap.computeIfAbsent。第二步，检查第三方库版本——MySQL Connector/J 升到 8.0.33+，PostgreSQL 42.6+，这些版本都修了 synchronized pinning。第三步，治理后再压测对比，pinning 事件应下降 80%+，QPS 提升 3-5 倍。如果治理后还有 20% pinning 残留（第三方库 native 调用），评估升级 JDK 24（JEP 491）根治。

**面试官**：JDK 21 的 Object.wait() 还会 pinning 吗？

**候选人**：JDK 21 已经修了 Object.wait() 的大部分 pinning（JEP 444 的工作），但 synchronized 块内的 wait/notify 在 JDK 24 之前仍可能 pinning。具体来说：纯 Object.wait()（不在 synchronized 块）不 pinning；synchronized 块内调 wait() 会 pinning（因为 monitor 持有）。所以生产代码里如果用 synchronized + wait/notify 的并发工具（如老版 LinkedBlockingQueue），升级 JDK 或换 ReentrantLock 版本的实现。

## 常见考点

1. **pinning 是什么？**——虚拟线程阻塞时 carrier 无法 unmount continuation，被钉死。三大元凶：synchronized 块内阻塞、JNI/native 阻塞、第三方库老版本。
2. **怎么诊断 pinning？**——JFR 的 jdk.VirtualThreadPinned 事件（threshold 默认 20ms，可调到 10ms）；jstack 看 carrier 状态和挂起 reason；Micrometer jvm.threads.virtual 指标。
3. **synchronized 为什么会 pinning？**——JVM 用对象头存 monitor 状态，unmount continuation 会破坏线程 ID 映射。JDK 24（JEP 491）重写 monitor 实现才允许 unmount。
4. **pinning 怎么治理？**——synchronized → ReentrantLock 或 ConcurrentHashMap；native IO → NIO；第三方库 → 升级 JDK 21 友好版本。按 ROI（duration × frequency）排序。
5. **JDK 24 后 synchronized 还 pinning 吗？**——基本不。JEP 491（Synchronize Virtual Threads without Pinning）让 Object.wait 和 synchronized 都可 unmount。但 JNI 内阻塞仍 pinning（JVM 看不到 native 栈）。

## 结构化回答

**30 秒电梯演讲：** pinning 是虚拟线程在阻塞时无法把 continuation unmount 到堆，导致 carrier 平台线程被钉死的现象。三大元凶：synchronized 块内阻塞、JNI 内阻塞、特定 native IO。治理不是换 ReentrantLock那么简单——要先靠 JFR 的 jdk.VirtualThreadPinned 事件定位热点、再按代价（改造 vs 升级 JDK 24）排序修复

**展开框架：**
1. **pinning 三大元凶** — synchronized 块内阻塞、JNI/native 阻塞、Object.wait（已部分修复）
2. **诊断利器** — JFR jdk.VirtualThreadPinned 事件，含 duration + 堆栈
3. **jcmd + jstac** — jcmd + jstack 看 carrier 数和虚拟线程挂起原因

**收尾：** 以上是我的整体思路。您想继续深入聊——怎么判断一个 pinning 是"严重"还是"可忽略"？


## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：虚拟线程 pinning 问题如何发现与治理 | "这题核心是——pinning 是虚拟线程在阻塞时无法把 continuation unmount 到堆，导致 ca……" | 开场钩子 |
| 0:15 | 像地铁乘客（虚拟线程）霸座（pinning）——类比图 | "打个比方：像地铁乘客（虚拟线程）霸座（pinning）——。" | 核心类比 |
| 0:40 | pinning 三大元凶示意/对比图 | "synchronized 块内阻塞、JNI/native 阻塞、Object.wait（已部分修复）" | pinning 三大元凶要点 |
| 1:05 | 诊断利器示意/对比图 | "JFR jdk.VirtualThreadPinned 事件，含 duration + 堆栈" | 诊断利器要点 |
| 1:55 | 总结卡 | "记住：pinning = 虚拟线程。下期见。" | 收尾 |
