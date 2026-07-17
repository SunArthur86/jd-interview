---
id: java-architect-101
difficulty: L2
category: java-architect
subcategory: Java 并发
tags:
- Java 架构师
- 虚拟线程
- JDK21
- Loom
feynman:
  essence: 虚拟线程是把"线程 = 内核线程"这一 30 年假设打破的轻量级抽象——JVM 在少量 carrier（平台线程）上调度海量虚拟线程，遇到阻塞操作时把栈帧 unmount 到堆，让 carrier 立即服务其他虚拟线程。落地不是"开个开关"，而是要解决 ThreadLocal 泄漏、pinning、synchronized 阻塞、连接池上限、监控失真等真实工程问题。
  analogy: 像把一辆大巴（carrier 线程）改成"地铁"：大巴固定 50 个座位（平台线程池），满员就拒载；地铁随时让乘客（虚拟线程）上车，到站下车（阻塞时 unmount）腾出车厢给新乘客，理论上能承载百万乘客，前提是乘客不要霸座（pinning）或带太多行李（ThreadLocal）。
  first_principle: 平台线程的代价来自内核：1MB 栈 + 内核调度上下文 + TLS，万级线程就把内存和上下文切换压垮。虚拟线程把栈放到堆（可控几百字节到几 KB），由 JVM 而非内核调度，阻塞时不切换内核上下文而是 unmount 栈帧。代价消失了，"一请求一线程"才从奢供建模变成默认架构。
  key_points:
  - 虚拟线程 ≠ 平台线程：栈在堆、JVM 调度、阻塞 unmount，万级并发无压力
  - carrier 线程数 = ForkJoinPool 平台线程数（默认 CPU 核数），是真正的并发度上限
  - 三大坑：synchronized 阻塞导致 pinning、ThreadLocal 继承引发内存泄漏、池化虚拟线程是反模式
  - 不要池化虚拟线程（用完即弃），但 HTTP/DB 连接池仍要限制，否则后端被打爆
  - 落地三步：JDK 21 + JFR 监控 jdk.VirtualThreadPinned + 灰度切流量
first_principle:
  problem: 平台线程是 1:1 映射内核线程，每个线程占 1MB 栈 + 内核调度成本，怎么用少量内存承载百万级并发 IO？
  axioms:
  - 阻塞 IO（DB/HTTP/RPC）占线程生命周期 99%+ 的时间，但 CPU 这段时间空闲
  - 内核线程切换成本（us 级 + TLB 刷新）是 JVM 调度成本（ns 级）的上千倍
  - 栈大小可以动态伸缩——深栈才需要大栈，浅栈只需几 KB
  rebuild: 把线程拆成"调度载体（carrier 平台线程）"和"执行单元（虚拟线程）"两层。carrier 数量等于 CPU 核数（CPU 密集部分），虚拟线程数量等于并发请求数（IO 密集部分）。虚拟线程遇到阻塞 IO 时把 continuation unmount 到堆，carrier 立即调度下一个就绪的虚拟线程。这样既保留"同步代码 = 简单可读"的开发模型，又拿到接近 Reactor/CompletableFuture 的吞吐。
follow_up:
  - 虚拟线程能完全替代 Reactor/CompletableFuture 吗？——IO 编排上基本能，但背压、流式处理、超时组合仍是 Reactive 强项；CPU 密集任务用虚拟线程无收益（carrier 本身就是平台线程）
  - synchronized 还能用吗？——能用但会 pinning，JDK 21 没改；JDK 24（JEP 491）才把 synchronized 改成可 unmount。生产建议先替换成 ReentrantLock
  - 虚拟线程怎么监控？——JFR 的 jdk.VirtualThreadStart/Pinned/Submit 事件，jstack 看到 "mount" 或 carrier 信息；Micrometer 1.12+ 暴露 jvm.threads.virtual 指标
  - 连接池要不要调大？——要！HikariCP 默认 maximumPoolSize=10，虚拟线程下会成为吞吐上限，按 后端承载能力 × 副本数 调
  - ThreadLocal 在虚拟线程下的坑？——虚拟线程数量大，每个都有 ThreadLocal 等于内存 ×N，且 inheritable 透传会被复用 carrier 错乱；用 ScopedValue（JDK 21 预览）
memory_points:
  - 虚拟线程 = 栈在堆 + JVM 调度 + 阻塞 unmount，承载百万 IO 并发
  - carrier 数 = CPU 核数（CPU 并发上限），虚拟线程数 = IO 并发数
  - 三大坑：synchronized pinning、ThreadLocal 泄漏、连接池成瓶颈
  - 不要池化虚拟线程（用完即弃），但 HTTP/DB 连接池要按后端容量限
  - 监控：JFR jdk.VirtualThreadPinned 事件 + jvm.threads.virtual 指标
  - JDK 24（JEP 491）才彻底解决 synchronized pinning
---

# 【Java 后端架构师】JDK 21 虚拟线程在线上系统如何落地

> 适用场景：JD 核心技术。订单、交易、风控这种 IO 密集服务，单实例几万 QPS 时平台线程池被打满（jstack 一片 BLOCKED 等数据库），改成 Reactor 又面临团队学习成本。JDK 21 虚拟线程让你保留"同步代码写法 + 异步吞吐"，但落地踩坑率极高——pinning、ThreadLocal 泄漏、连接池成新瓶颈都是真实事故源。

## 一、概念层：虚拟线程的本质与边界

**平台线程 vs 虚拟线程对比**（这张表面试必问）：

| 维度 | 平台线程（Platform） | 虚拟线程（Virtual） |
|------|---------------------|--------------------|
| **栈位置** | 内核态 + JVM 栈（默认 1MB） | 堆上的 continuation（几 KB 起步，按需扩展） |
| **调度** | OS 内核调度（1:1 内核线程） | JVM 调度（挂在 ForkJoinPool 上，M:N） |
| **数量上限** | 几千（受栈内存限制） | 百万级（堆内存决定） |
| **阻塞成本** | 内核上下文切换（us 级，TLB flush） | unmount continuation（ns 级） |
| **CPU 密集收益** | 无差异 | **无收益**（carrier 还是平台线程） |
| **IO 密集收益** | 高 | 巨大（阻塞时让出 carrier） |
| **创建成本** | `new Thread()` ≈ 50us | `Thread.ofVirtual()` ≈ 1us |

**调度模型**（必须能在白板画出）：

```
        应用代码（同步阻塞写法）
              │
              ▼
   ┌─────────────────────────┐
   │   虚拟线程 VT1..VTn      │  (n = 百万级，IO 并发)
   │   栈在堆上，JVM 调度     │
   └─────────┬───────────────┘
             │ mount / unmount
             ▼
   ┌─────────────────────────┐
   │  Carrier Pool           │  (CPU 核数个平台线程)
   │  ForkJoinPool 共享池    │  ← 真正的并发度上限
   └─────────┬───────────────┘
             │
             ▼
        物理 CPU 核
```

**关键认知**：carrier 数量是 CPU 并发度上限（默认 `ForkJoinPool.commonPool` 的并行度 = CPU 核数），虚拟线程数量是 IO 并发上限。如果业务是 CPU 密集（哈希、加密、压缩），用虚拟线程**没有收益**——carrier 还是平台线程在跑。

## 二、机制层：从阻塞到 unmount 的完整链路

**虚拟线程阻塞时的 unmount 流程**（架构师必须能讲清）：

```
VT1 在 carrier-1 上执行 → 遇到 socket.read() 阻塞
        │
        ▼
JVM 把 VT1 的 continuation（栈帧）从 carrier-1 复制到堆
        │
        ▼
carrier-1 空闲，ForkJoinPool 调度 VT2 mount 上来执行
        │
        ▼
VT1 的 socket 数据就绪，JVM 把 continuation 从堆复制回某个 carrier，继续执行
```

**三大 pinning 元凶**（阻塞时不 unmount，carrier 被钉死）：

```java
// 1. synchronized 块内阻塞（JDK 21/22/23 都 pinning，JDK 24 JEP 491 修复）
synchronized (lock) {
    Thread.sleep(1000);     // ← 这里整个 carrier 被钉死，VT1 不让出
    db.query();             // ← 同样 pinning
}

// 正确做法：换 ReentrantLock
ReentrantLock lock = new ReentrantLock();
lock.lock();
try {
    db.query();             // ← unmount 正常，carrier 让给其他 VT
} finally {
    lock.unlock();
}

// 2. native 方法或 JNI 调用内部阻塞
FileInputStream.read();     // 老 IO 部分实现会 pinning，用 NIO/AsyncClient

// 3. Object.wait()（已修，但部分第三方库的 wait/notify 仍可能 pin）
```

**Thread.ofVirtual() 三种创建方式**：

```java
// 1. 直接 start
Thread vt = Thread.ofVirtual().name("vt-1").start(() -> {
    handleRequest();
});

// 2. 未启动的 Thread，由 Executor 启动
Thread vt = Thread.ofVirtual().name("vt-2").unstarted(() -> handleRequest());

// 3. 通过 newVirtualThreadPerTaskExecutor（推荐，配合 try-with-resources）
try (ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor()) {
    List<Future<String>> futures = IntStream.range(0, 10_000)
        .mapToObj(i -> executor.submit(() -> fetch(i)))
        .toList();
    // 1 万个虚拟线程并发跑，carrier 只有 CPU 核数个
}
```

## 三、实战层：Spring Boot 落地与连接池治理

**Spring Boot 3.2+ 一行配置开虚拟线程**：

```yaml
# application.yml
spring:
  threads:
    virtual:
      enabled: true   # Tomcat 用 VirtualThreadTaskExecutor，请求线程变虚拟线程
```

**这行配置背后发生了什么**：

```
HTTP 请求进来
    │
    ▼
Tomcat 的 ProtocolHandler 不再用 platform thread pool
    │
    ▼
每个请求一个虚拟线程 → @RestController 方法在虚拟线程上跑
    │
    ▼
JdbcTemplate.query() / RestTemplate / @Async / KafkaListener
全部在虚拟线程上执行，阻塞 IO 时 unmount
```

**但启用虚拟线程后，必须同步调整三个池**：

```java
// 坑 1：HikariCP 默认 maximumPoolSize=10，1 万虚拟线程等 10 个连接，全部 pinning
@Configuration
public class DataSourceConfig {
    @Bean
    public HikariDataSource dataSource() {
        HikariConfig cfg = new HikariConfig();
        // 按后端 MySQL 承载能力算，不是按应用并发数算
        // 公式：connections = (核心数 × 2) + 有效磁盘数（HikariCP Wiki 公式）
        cfg.setMaximumPoolSize(50);     // 而不是 10000
        cfg.setConnectionTimeout(2000); // 失败快，避免虚拟线程长时间挂起
        return new HikariDataSource(cfg);
    }
}

// 坑 2：RestTemplate / WebClient 内部连接池
HttpClient client = HttpClient.newBuilder()
    .version(HttpClient.Version.HTTP_1_1)
    .connectTimeout(Duration.ofSeconds(2))
    // 默认 keepAlive + 连接池，注意 maxConnections 上限
    .build();

// 坑 3：@Async 默认线程池要换成虚拟线程
@EnableAsync
@Configuration
public class AsyncConfig implements AsyncConfigurer {
    @Override
    public Executor getAsyncExecutor() {
        return Executors.newVirtualThreadPerTaskExecutor();
    }
}
```

**坑 4：ThreadLocal 在虚拟线程下的内存陷阱**：

```java
// 反例：百万虚拟线程每个都有 10 个 ThreadLocal → 内存爆炸
private static ThreadLocal<UserContext> ctx = new ThreadLocal<>();
// 每个虚拟线程都有一份 ctx，100 万 VT × 1KB = 1GB

// JDK 21 推荐：ScopedValue（预览，不可变 + 自动清理）
private static final ScopedValue<UserContext> CTX = ScopedValue.newInstance();
ScopedValue.where(CTX, userContext).run(() -> handleRequest());

// 实在需要可变 ThreadLocal，必须 try-finally 清理
ThreadLocal<Buffer> buf = ...;
try {
    handle(buf.get());
} finally {
    buf.remove();   // 虚拟线程用完即弃但仍要 remove，防 GC 前泄漏
}
```

## 四、底层本质：为什么是 continuation 而不是协程

回到第一性：**为什么 Java 选 continuation 而不是 Kotlin/Go 的协程？**

- **协程**（Kotlin/Go）：编译器把 `suspend fun` 改写成状态机，开发者必须显式标 `suspend`，颜色化函数问题（红色函数不能在普通函数调）。
- **continuation**（Java）：JVM 在字节码层面拦截阻塞操作，把整个调用栈打包成 continuation 对象，对开发者完全透明——`Thread.sleep()`、`socket.read()` 这些老 API 在虚拟线程下自动 unmount，**不需要 async/await 关键字**。

这是 JEP 444 反复强调的"transparent"：现有同步代码（Tomcat Servlet、JDBC、Spring MVC）一行不改就能跑在虚拟线程上。代价是 JVM 必须在所有阻塞点插桩（JDK 内的 `jdk.internal.misc.VirtualThread` 已处理好，第三方 native 库是盲区）。

**carrier 共享 ForkJoinPool 的本质**：虚拟线程不绑死某个 carrier，每次 unmount 后可能 mount 到任意 carrier。这带来两个工程后果：

1. `Thread.currentThread()` 在同一虚拟线程生命周期内会返回不同的载体线程对象（看似反直觉，实际是设计）。
2. carrier 上的 `ThreadLocal`（inheritable）和虚拟线程的 ThreadLocal 是两套——`InheritableThreadLocal` 在虚拟线程下不再可靠透传父线程值，必须改用 `ScopedValue` 或 `TransmittableThreadLocal`。

## 五、AI 架构师加问：5 个

1. **AI 推理服务用虚拟线程有收益吗？**
   分场景。HTTP 网关层（接收请求、转发、返回）是 IO 密集，虚拟线程有收益；模型推理（GPU/CPU 计算）是 CPU 密集，无收益且 carrier 数已经是 CPU 核数。建议：网关用虚拟线程，推理用固定大小的平台线程池，两者通过队列解耦。

2. **AI Agent 调用 N 个工具（LLM + RAG + Tool）怎么编排？**
   用虚拟线程 + `StructuredTaskScope`（JDK 21 预览）：一个 Agent 会话起一个虚拟线程，每个 tool_call 起子虚拟线程，失败/超时自动取消整树。比 CompletableFuture 链式更可读，比 Reactor 更轻。注意 tool_call 内部如果调用第三方 API（OpenAI/Anthropic）要用 HTTP 客户端的虚拟线程友好版（`java.net.http.HttpClient` 已支持）。

3. **怎么用 AI 自动检测虚拟线程代码里的 pinning 风险？**
   AI 扫描代码：`synchronized` 块内是否有阻塞调用（IO/sleep/wait）、native 方法调用、`Object.wait()`。结合 JFR 历史 `jdk.VirtualThreadPinned` 事件的堆栈做训练，输出"高风险代码段 + 修复建议（换 ReentrantLock）"。误报率高的地方要人工 review。

4. **AI Copilot 帮业务改虚拟线程，最容易翻车在哪？**
   ThreadLocal 透传——业务代码常依赖 `RequestContextHolder` / 自定义 `UserContext` 的 ThreadLocal，改虚拟线程后 carrier 切换会让 inheritable 失效。AI 要能识别"这段代码依赖 ThreadLocal 透传"并提示改 ScopedValue。

5. **大模型推理框架（如 vLLM）的并发模型和虚拟线程能类比吗？**
   有相似处：vLLM 用 continuous batching（请求动态加入/移出 batch），类似虚拟线程的 mount/unmount；GPU 是稀缺资源（类似 carrier），LLM 请求是 IO/计算混合（类似虚拟线程的阻塞点）。但底层实现完全不同，类比只用于理解"调度器 + 共享载体"的抽象。

## 六、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"栈在堆、JVM 调度、三大坑、连接池要调、JFR 看 pinned"** 五个点。

- **本质**：栈在堆、JVM 调度、阻塞 unmount，承载百万 IO 并发
- **三大坑**：synchronized pinning、ThreadLocal 泄漏、连接池成瓶颈
- **carrier**：CPU 核数个，是真正的并发度上限（CPU 密集无收益）
- **不要池化**：虚拟线程用完即弃；但 DB/HTTP 连接池要按后端容量限
- **监控**：JFR `jdk.VirtualThreadPinned` 事件 + Micrometer `jvm.threads.virtual`
- **修复**：JDK 24（JEP 491）才彻底解决 synchronized pinning

### 拟人化理解

把虚拟线程想成**地铁系统**。carrier 是车厢（固定几节，对应 CPU 核数），虚拟线程是乘客（百万级）。平台线程是出租车——一辆一个客人，城市的士数量永远上不去（栈太贵）。地铁的关键是"乘客到站下车"（unmount continuation），让车厢立刻接新人。如果乘客霸座（synchronized 内阻塞）、带太多行李（ThreadLocal）、或者车门打不开（连接池满员），车厢就空转。地铁调度员（JVM）只关心车厢利用率，不关心乘客数量。

### 面试现场 60 秒回答

> 虚拟线程的本质是把栈放到堆上，由 JVM 而不是内核调度，遇到阻塞 IO 时把 continuation unmount 到堆，让 carrier 平台线程立刻服务下一个虚拟线程。所以它对 IO 密集场景（订单/交易/网关）收益巨大，对 CPU 密集（哈希/加密）没收益。落地三大坑：synchronized 块内阻塞会 pinning（JDK 24 才修），ThreadLocal 在百万虚拟线程下内存爆炸要改 ScopedValue，HikariCP 默认 10 个连接会成新瓶颈要按后端容量调。Spring Boot 3.2 一行配置开启，但要配合 JFR 监控 jdk.VirtualThreadPinned 事件，灰度切流验证 P99 和吞吐。

### 反问面试官

> 贵司要落地的服务是 IO 密集（订单/交易/网关）还是 CPU 密集（风控/推荐/搜索）？现在的并发瓶颈是线程池打满还是连接池打满？这决定虚拟线程的收益预期和落地路径——如果瓶颈在 DB 连接池，开虚拟线程没用，要先调 HikariCP。

## 七、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 你为什么选虚拟线程而不是 Reactor 或 CompletableFuture？ | 同步代码可读性 + 团队学习成本。Reactor 链式 API 调试难、错误传播复杂，CompletableFuture 编排深时回调地狱。虚拟线程保留 try/catch/finally 直觉，且现有 Spring MVC/JDBC 代码零改造。证明：改造前后的 code review 时间和 bug 率 |
| 证据追问 | 怎么证明虚拟线程真的提升了吞吐？ | 压测：同一接口平台线程 vs 虚拟线程，看 max QPS 和 P99；线上：jvm.threads.virtual 数 + carrier CPU 利用率 + HikariCP active 数；JFR 看 pinned 事件是否 < 1%。证明：QPS 翻倍但 P99 不升 |
| 边界追问 | 虚拟线程能解决所有并发问题吗？ | 不能。CPU 密集任务无收益（carrier 还是平台线程），pinning 严重的代码反而变慢（carrier 钉死），共享可变状态仍要加锁（虚拟线程不解决并发正确性）。它只解决"IO 阻塞占线程"这个特定问题 |
| 反例追问 | 什么场景你不会用虚拟线程？ | CPU 密集（推荐/搜索/风控模型推理）、超低延迟（亚毫秒，continuation 复制有开销）、库依赖大量 native 阻塞调用（pinning 频发）、JDK < 21（生产化前是预览）。这些场景用平台线程池或固定线程数 |
| 风险追问 | 落地最大风险是什么？ | 主动点出三个：① synchronized pinning 让 carrier 钉死反而吞吐下降（要看 JFR）；② ThreadLocal 在百万 VT 下内存爆炸（要换 ScopedValue）；③ HikariCP/下游连接池被打爆（虚拟线程数量不限但下游容量有限）。治法：先压测，灰度切 10% 流量看 P99 不升再全量 |
| 验证追问 | 怎么证明虚拟线程在生产没引入新问题？ | 上线前：jcstress/junit-threads 测试 + 压测对比；灰度：10% 流量跑 3 天看 pinned 事件数、P99、错误率；上线后：JFR 持续采集 jdk.VirtualThreadPinned，告警阈值 pinned > 100/分钟 |
| 沉淀追问 | 团队防坑沉淀什么？ | Code Review checklist（synchronized 阻塞、ThreadLocal 用法、连接池配置）、JFR 模板（含 VirtualThreadPinned/Start/Submit 事件）、HikariCP 默认池大小规范、Spring Boot 虚拟线程接入模板 |

### 现场对话示例

**面试官**：你说虚拟线程能承载百万并发，但 carrier 只有 CPU 核数个，那真正的并发度不还是 CPU 核数吗？

**候选人**：要区分"并发度"和"吞吐"。CPU 并发度（同时执行的字节码）确实受 carrier 限制，等于 CPU 核数——但 IO 密集业务里，99% 时间在等数据库、等下游、等网络，CPU 实际不忙。虚拟线程的价值是：等 IO 时把 carrier 让出来服务其他虚拟线程的 CPU 工作，让 CPU 利用率拉满。所以"百万虚拟线程"不是百万 CPU 并发，而是百万 IO 并发——同一时刻 100 个在算、99 万 9900 个在等。

**面试官**：那如果我的业务里 synchronized 用得很多怎么办？

**候选人**：JDK 21/22/23 的 synchronized 块内阻塞会 pinning，carrier 被钉死。短期方案：把 synchronized 替换成 ReentrantLock（功能等价，能 unmount）；中期：评估是否真的需要锁（很多 synchronized 是过度同步，可以用 AtomicReference / 不可变对象）；长期：等 JDK 24 GA 后升级（JEP 491 把 synchronized 改成可 unmount）。落地前必须用 JFR 跑 jdk.VirtualThreadPinned 事件，pinning 严重的代码段不进虚拟线程。

**面试官**：HikariCP 默认 10 个连接，虚拟线程下不够用，调到多少合适？

**候选人**：不能按应用并发数（百万虚拟线程 × 1 连接 = 后端炸），要按后端 MySQL 的承载能力算。HikariCP Wiki 给的公式：`池大小 = (核心数 × 2) + 有效磁盘数`，但生产还要看 MySQL 的 max_connections、单查询耗时。一般 8C 的 MySQL 单实例 max_connections=1000，给应用 50-100 个连接够用。同时调小 connectionTimeout（2s 内失败快），避免虚拟线程长时间挂在等连接上。

## 常见考点

1. **虚拟线程和平台线程区别？**——栈位置（堆 vs 内核栈）、调度器（JVM vs OS）、阻塞成本（unmount vs 上下文切换）、数量上限（百万 vs 几千）。本质是"轻量"和"对 IO 阻塞透明"。
2. **虚拟线程下 synchronized 为什么不能用？**——JDK 21 的 monitor 锁不允许 unmount continuation，块内阻塞会 pinning（carrier 钉死）。要换 ReentrantLock，或等 JDK 24（JEP 491）。
3. **虚拟线程要不要池化？**——不要。虚拟线程创建成本 ≈ 1us，比平台线程轻 50 倍，用完即弃。`Executors.newVirtualThreadPerTaskExecutor()` 每个任务一个新 VT。
4. **ThreadLocal 在虚拟线程下有什么坑？**——百万 VT 每个都有 ThreadLocal 等于内存 ×N；inheritable 在 carrier 切换时透传错乱。用 ScopedValue（不可变 + 自动清理）或显式 try-finally remove。
5. **怎么监控虚拟线程健康？**——JFR 采集 jdk.VirtualThreadStart/Pinned/Submit 事件（pinning 计数）、jstack 看 carrier 数和挂起原因、Micrometer 1.12+ 暴露 jvm.threads.virtual 指标。

## 结构化回答

**30 秒电梯演讲：** 虚拟线程是把线程 = 内核线程这一 30 年假设打破的轻量级抽象——JVM 在少量 carrier（平台线程）上调度海量虚拟线程，遇到阻塞操作时把栈帧 unmount 到堆，让 carrier 立即服务其他虚拟线程。落地不是开个开关，而是要解决 ThreadLocal 泄漏、pinning、synchronized 阻塞、连接池上限、监控失真等真实工程问题

**展开框架：**
1. **虚拟线程 ≠ 平台线程** — 栈在堆、JVM 调度、阻塞 unmount，万级并发无压力
2. **carrier 线程数** — carrier 线程数 = ForkJoinPool 平台线程数（默认 CPU 核数），是真正的并发度上限
3. **三大坑** — synchronized 阻塞导致 pinning、ThreadLocal 继承引发内存泄漏、池化虚拟线程是反模式

**收尾：** 以上是我的整体思路。您想继续深入聊——虚拟线程能完全替代 Reactor/CompletableFuture 吗？


## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：JDK 21 虚拟线程在线上系统如何落地 | "这题核心是——虚拟线程是把线程 = 内核线程这一 30 年假设打破的轻量级抽象——JVM 在少量 carrie……" | 开场钩子 |
| 0:15 | 虚拟线程 ≠ 平台线程示意/对比图 | "栈在堆、JVM 调度、阻塞 unmount，万级并发无压力" | 虚拟线程 ≠ 平台线程要点 |
| 0:40 | carrier 线程数示意/对比图 | "carrier 线程数 = ForkJoinPool 平台线程数（默认 CPU 核数），是真正的并发度上限" | carrier 线程数要点 |
| 1:25 | 总结卡 | "记住：虚拟线程 = 栈在堆 + J。下期见。" | 收尾 |
