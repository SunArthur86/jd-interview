---
id: java-architect-112
difficulty: L2
category: java-architect
subcategory: Spring Boot
tags:
- Java 架构师
- Spring Boot
- 虚拟线程
- 线程池
feynman:
  essence: Spring Boot 3.2+ 一行配置 `spring.threads.virtual.enabled=true` 开启虚拟线程，但"开启"不等于"调优"。虚拟线程和平台线程池（@Async、TaskExecutor、HikariCP、Reactor）的共存策略——哪些应该改虚拟线程、哪些必须保留平台线程池、哪些要分而治之——才是落地的核心。
  analogy: 像把一条小河（平台线程池）改造成"主干道 + 毛细血管"系统：主干道（carrier）固定几条负责重活，毛细血管（虚拟线程）百万条负责轻活（IO 等待）。但有些设备（GPU、JNI、第三方 SDK）只能用主干道，强行改造反而出事。
  first_principle: 不是所有线程都该用虚拟线程。IO 密集用虚拟线程（让出 carrier），CPU 密集用平台线程池（避免 carrier 频繁切换），JNI/GPU 用固定平台线程（避免 pinning）。Spring Boot 的虚拟线程配置只是入口，业务要按场景区分。
  key_points:
  - spring.threads.virtual.enabled=true（Spring Boot 3.2+）
  - Tomcat / @Async / TaskExecutor 默认改虚拟线程
  - 必须保留平台线程池的场景：CPU 密集、JNI/GPU、第三方 SDK
  - HikariCP 不变（连接池大小独立于线程模型）
  - Reactor / WebFlux 不需要虚拟线程（已经异步）
first_principle:
  problem: Spring Boot 开启虚拟线程后，哪些组件改了、哪些没改、怎么和现有线程池共存？
  axioms:
  - 虚拟线程适合 IO 密集（让出 carrier）
  - CPU 密集用虚拟线程无收益（carrier 还是平台线程在跑）
  - JNI/GPU 调用会 pinning，必须用平台线程池
  - 连接池（HikariCP）独立于线程模型，按后端容量配
  rebuild: Spring Boot 3.2+ 一行配置开启虚拟线程，自动把 Tomcat 请求线程、@Async、TaskExecutor 改成虚拟线程。但要分类处理：CPU 密集任务（计算、加解密）保留 Platform Thread Pool；JNI/GPU（CUDA、ONNX Runtime）用固定平台线程池；IO 密集（HTTP、DB、消息）用虚拟线程。HikariCP 大小按 MySQL 承载能力配，不随线程模型变。
follow_up:
  - spring.threads.virtual.enabled 影响哪些组件？——Tomcat 请求线程、@Async 默认 Executor、Spring Boot TaskExecutor、Quartz 调度。不影响 HikariCP（连接池）、JMS Listener（独立配置）、Reactor（已异步）
  - "@Async 的线程池怎么配？——默认改成 VirtualThreadTaskExecutor。如果要保留平台线程池，自定义 AsyncConfigurer 返回平台线程池"
  - CPU 密集任务为什么不能用虚拟线程？——虚拟线程的 carrier 是平台线程（CPU 核数个），CPU 密集任务会让 carrier 长时间占用，影响其他虚拟线程调度。用平台线程池控制并发度
  - WebFlux 要不要开虚拟线程？——没必要。WebFlux 已经异步（Reactor + Netty event loop），线程数固定。但 WebFlux 内部的 blocking call（如 JDBC）可以用虚拟线程包
  - 怎么监控虚拟线程和平台线程的协作？——JFR 看 jdk.VirtualThreadPinned、jstack 看 carrier 数、Micrometer 1.12+ 暴露 jvm.threads.virtual.count
memory_points:
  - spring.threads.virtual.enabled=true（Spring Boot 3.2+）
  - 自动改：Tomcat 请求线程、@Async、TaskExecutor
  - 不改：HikariCP（连接池）、JMS Listener、Reactor
  - 必须保留平台线程池：CPU 密集、JNI/GPU、第三方 SDK
  - HikariCP 大小按后端容量配（不随线程模型变）
  - 监控：JFR jdk.VirtualThreadPinned + jvm.threads.virtual.count
---

# 【Java 后端架构师】Spring Boot 虚拟线程配置与线程池共存策略

> 适用场景：JD 核心技术。订单服务 Spring Boot 3.2 开启虚拟线程后，QPS 翻倍但 GPU 风控推理服务出现 pinning（JNI 调用 CUDA），数据库连接池被打爆（百万虚拟线程等 10 个连接）。架构师必须设计虚拟线程和平台线程池的共存策略。

## 一、概念层：Spring Boot 虚拟线程的影响范围

**spring.threads.virtual.enabled=true 影响的组件**（这张表面试必问）：

| 组件 | 默认行为 | 开启虚拟线程后 | 配置 |
|------|---------|--------------|------|
| **Tomcat 请求线程** | 平台线程池（maxThreads=200） | VirtualThreadTaskExecutor | spring.threads.virtual.enabled |
| **@Async 默认 Executor** | SimpleAsyncTaskExecutor（平台） | VirtualThreadTaskExecutor | spring.threads.virtual.enabled |
| **TaskExecutor Bean** | 平台线程池 | 虚拟线程（如未自定义） | spring.threads.virtual.enabled |
| **MVC async 请求** | 平台线程池 | 虚拟线程 | spring.threads.virtual.enabled |
| **HikariCP 连接池** | 固定大小（10） | **不变** | spring.datasource.hikari.maximum-pool-size |
| **JMS Listener** | 平台线程池 | 平台线程池（独立配） | spring.jms.listener.concurrency |
| **Quartz 调度** | 平台线程池 | 平台线程池（独立配） | spring.quartz.thread-pool-size |
| **WebFlux / Reactor** | Netty event loop | Netty event loop（已异步） | 不影响 |

**关键认知**：
- 开启虚拟线程只影响"按请求/任务起线程"的组件（Tomcat / @Async / MVC async）
- "连接池"（HikariCP）、"调度池"（Quartz）、"异步框架"（WebFlux）不受影响
- WebFlux 已经是异步模型，开启虚拟线程没有收益（但也不会坏）

**配置示例**：

```yaml
# application.yml
spring:
  threads:
    virtual:
      enabled: true      # 一行配置开启

  # HikariCP 不受影响，单独配
  datasource:
    hikari:
      maximum-pool-size: 50    # 按后端 MySQL 容量配，不随线程模型变
      connection-timeout: 2000
```

## 二、机制层：自动配置与例外场景

**Spring Boot 自动配置源码逻辑**：

```java
// Spring Boot 3.2 的 TaskExecutionAutoConfiguration
@ConditionalOnThreading(Threading.VIRTUAL)
@Bean
public TaskExecutor applicationTaskExecutor() {
    return new TaskExecutorAdapter(Executors.newVirtualThreadPerTaskExecutor());
}

// Tomcat 的 ProtocolHandler
@ConditionalOnThreading(Threading.VIRTUAL)
public TomcatProtocolHandlerCustomizer<?> protocolHandlerVirtualThreadCustomizer() {
    return protocolHandler -> {
        protocolHandler.setExecutor(
            new VirtualThreadTaskExecutor("tomcat-vt-")
        );
    };
}
```

**必须保留平台线程池的场景**：

| 场景 | 为什么不能用虚拟线程 | 解法 |
|------|--------------------|------|
| **CPU 密集任务** | carrier 长期占用，影响其他 VT 调度 | Platform ThreadPool 大小 = CPU 核数 |
| **JNI / GPU 调用** | JNI 内阻塞必然 pinning | Platform ThreadPool 大小 = GPU 并发数 |
| **第三方 SDK 用 synchronized + IO** | pinning 元凶 | Platform ThreadPool 或换 SDK |
| **Reactor 阻塞调用桥接** | BlockHound 检测 + 平台线程隔离 | Schedulers.boundedElastic() |
| **Spring Batch / 定时任务** | 长生命周期、CPU 混合 | 按任务特征配 |

**场景 1：CPU 密集任务保留平台线程池**

```java
// 反例：CPU 密集用虚拟线程（无收益）
@Service
public class CryptoService {
    @Async   // 如果 spring.threads.virtual.enabled=true，会用虚拟线程
    public byte[] hash(byte[] data) {
        return heavyHashComputation(data);   // CPU 密集，carrier 占满
    }
}

// 修复：自定义平台线程池
@Configuration
public class CpuIntensiveConfig {
    @Bean("cpuExecutor")
    public TaskExecutor cpuExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(Runtime.getRuntime().availableProcessors());
        executor.setMaxPoolSize(Runtime.getRuntime().availableProcessors());
        executor.setQueueCapacity(100);
        executor.setThreadNamePrefix("cpu-");
        return executor;
    }
}

@Service
public class CryptoService {
    @Async("cpuExecutor")    // 指定平台线程池
    public byte[] hash(byte[] data) {
        return heavyHashComputation(data);
    }
}
```

**场景 2：JNI / GPU 调用用平台线程池**

```java
// GPU 推理（ONNX Runtime JNI）会 pinning，必须用平台线程池
@Configuration
public class GpuInferenceConfig {
    @Bean("gpuExecutor")
    public TaskExecutor gpuExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        // 大小 = GPU 可并发推理数（如 8）
        executor.setCorePoolSize(8);
        executor.setMaxPoolSize(8);
        executor.setQueueCapacity(1000);
        executor.setThreadNamePrefix("gpu-");
        return executor;
    }
}

@Service
public class InferenceService {
    @Async("gpuExecutor")    // 平台线程池，避免 pinning
    public float[] infer(float[] input) {
        return ortSession.run(input);   // JNI 调 ONNX Runtime，平台线程
    }
}

// 主流程用虚拟线程
public Order handle(Request req) {
    // Tomcat 线程（虚拟线程）接收
    float[] features = extractFeatures(req);   // 虚拟线程
    float[] result = inferenceService.infer(features).get();  // 提交到 GPU 平台池，等待
    // 虚拟线程在 .get() 时 unmount，carrier 服务其他 VT
    return buildOrder(result);
}
```

**场景 3：HikariCP 配置（关键！）**

```yaml
spring:
  datasource:
    hikari:
      # 虚拟线程下，连接池是新瓶颈！
      # 默认 maximum-pool-size=10，百万 VT 等 10 连接 = 全部 pinning
      maximum-pool-size: 50       # 按 MySQL 承载能力配
      connection-timeout: 2000    # 失败快，避免 VT 长时间挂起
      # 公式：池大小 ≈ (核心数 × 2) + 有效磁盘数（PostgreSQL 公式）
      # 实际：看 MySQL max_connections 和单查询耗时
```

## 三、实战层：订单服务的虚拟线程落地

**架构图**（架构师必须能画）：

```
HTTP 请求 ──> Tomcat 虚拟线程（per-request）
                 │
                 ├─> @Async("ioExecutor")      IO 异步任务（虚拟线程）
                 │     └─ HTTP / DB / 消息队列
                 │
                 ├─> @Async("cpuExecutor")     CPU 密集任务（平台线程池）
                 │     └─ 加解密 / 序列化 / 压缩
                 │
                 └─> @Async("gpuExecutor")     GPU 推理（平台线程池）
                       └─ JNI / ONNX Runtime

HikariCP（独立配置）──> MySQL（max_connections=200）
                       ↑ 池大小按 MySQL 容量配，不随 VT 变
```

**完整配置**：

```yaml
spring:
  threads:
    virtual:
      enabled: true

  # 虚拟线程 IO 任务用（不需要配，spring.threads.virtual 自动）
  
  datasource:
    hikari:
      maximum-pool-size: 50
      connection-timeout: 2000

# 平台线程池用代码配置
```

```java
@Configuration
public class ThreadPoolConfig {

    @Bean("cpuExecutor")
    public TaskExecutor cpuExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(Runtime.getRuntime().availableProcessors());
        executor.setMaxPoolSize(Runtime.getRuntime().availableProcessors());
        executor.setQueueCapacity(100);
        executor.setThreadNamePrefix("cpu-");
        executor.setRejectedExecutionHandler(new ThreadPoolExecutor.CallerRunsPolicy());
        return executor;
    }

    @Bean("gpuExecutor")
    public TaskExecutor gpuExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(8);       // GPU 并发数
        executor.setMaxPoolSize(8);
        executor.setQueueCapacity(1000);
        executor.setThreadNamePrefix("gpu-");
        return executor;
    }

    @Bean("jmsListenerExecutor")
    public TaskExecutor jmsListenerExecutor() {
        // JMS Listener 默认平台线程池，按需配
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(10);
        executor.setMaxPoolSize(20);
        return executor;
    }
}
```

**业务代码使用**：

```java
@Service
public class OrderService {

    @Resource(name = "cpuExecutor")
    private TaskExecutor cpuExecutor;

    @Async("gpuExecutor")
    public CompletableFuture<Float[]> infer(float[] features) {
        return CompletableFuture.completedFuture(ortSession.run(features));
    }

    public Order createOrder(OrderDTO dto) throws Exception {
        // Tomcat 虚拟线程
        Order order = orderRepo.create(dto);     // HikariCP 50 连接，VT 等待时 unmount
        
        // CPU 密集：异步提交平台线程池
        cpuExecutor.submit(() -> {
            String signature = heavyHash(order.getId());   // 平台线程跑
        });

        // GPU 推理：提交 gpuExecutor（平台线程池）
        if (dto.needRiskCheck()) {
            infer(features).get(2, TimeUnit.SECONDS);      // VT 等待时 unmount
        }

        return order;
    }
}
```

## 四、底层本质：为什么"开启"不等于"调优"

回到第一性：**为什么 spring.threads.virtual.enabled=true 只是起点，不是终点？**

- **虚拟线程只解决 IO 阻塞问题**：它让 carrier 在 VT 等 IO 时服务其他 VT。但 CPU 密集任务、JNI 调用、synchronized 阻塞都不受益（甚至受害）。
- **线程模型分层**：现代应用是"IO 密集 + CPU 密集 + GPU/JNI"混合。一刀切用虚拟线程（CPU 任务用 VT）或一刀切用平台线程（IO 任务用平台）都是错的。要按任务特征分流。
- **连接池是新瓶颈**：HikariCP 默认 10 个连接，VT 时代百万并发等 10 个连接 = 全部 pinning。连接池配置要从"按应用并发配"改成"按后端容量配"。
- **监控盲区**：传统的 jvm.threads.live 看不出 VT 和平台线程的协作。要新增 jvm.threads.virtual.count、carrier CPU 利用率、pinning 事件计数。

**Spring Boot 自动配置的边界**：
- 自动改的：Tomcat / @Async 默认 / TaskExecutor（用户没显式配的）
- 不自动改的：HikariCP（连接池，独立维度）、Quartz（调度，独立配置）、JMS（消息监听容器，独立配）
- 用户自定义的：自定义 TaskExecutor Bean 不会被自动覆盖（@ConditionalOnMissingBean）

**为什么 HikariCP 不自动改**：
- HikariCP 大小取决于后端数据库容量（MySQL max_connections、PostgreSQL 公式），不是应用线程模型
- 应用层不该决定连接池大小，要按 DB 容量算
- 如果改成"按 VT 数配"会导致 DB 被打爆

## 五、AI 架构师加问：5 个

1. **AI 推理服务的虚拟线程怎么配置？**
   网关层（HTTP 接收、鉴权、转发）用虚拟线程（Tomcat 自动）；模型推理用平台线程池（GPU JNI 会 pinning，executor 大小 = GPU 并发数）；数据预处理（IO 密集）用虚拟线程。三个线程模型分层共存，通过 CompletableFuture 或队列解耦。

2. **AI Copilot 帮业务配虚拟线程，最容易翻车在哪？**
   三个点：① CPU 密集任务用 @Async 默认 Executor（虚拟线程）导致 carrier 占满；② JNI/GPU 调用没指定平台线程池导致 pinning；③ HikariCP 没调大（默认 10）导致 VT 等连接 pinning。AI 要能识别"这个方法是 CPU 密集 / JNI 调用"，建议用 @Async("platformExecutor")。

3. **AI Agent 调用多个工具，工具内部混合 CPU/IO/GPU，怎么编排？**
   外层用 StructuredTaskScope（虚拟线程编排），每个 tool_call 根据特征分流：IO 工具（数据库/HTTP）走虚拟线程；CPU 工具（编码/解码）走 cpuExecutor 平台线程池；GPU 工具（推理）走 gpuExecutor 平台线程池。Agent 主流程虚拟线程负责等结果（让出 carrier），工具内部按特征选线程模型。

4. **AI 能自动评估服务的线程模型健康度吗？**
   AI 分析 JFR 的 jdk.VirtualThreadPinned（pinning 热点）、jvm.threads.virtual.count（VT 数）、carrier CPU 利用率、HikariCP active/wait。建模：如果 pinning 率 > 10%，建议治理；如果 HikariCP wait 高，建议调大；如果 carrier CPU 接近 100%，建议拆分 CPU 密集任务到平台线程池。输出线程模型调优建议。

5. **大模型推理服务的"请求级虚拟线程 + 推理级平台线程池"架构怎么设计？**
   Tomcat 接收 HTTP（虚拟线程）→ 解析 prompt（虚拟线程做 IO）→ 提交推理任务到 GPU Executor（平台线程池，避免 JNI pinning）→ 虚拟线程 .get() 等结果（unmount）→ 返回响应。GPU Executor 大小 = GPU 并发数（如 4），队列大小按业务容忍延迟配。流式输出场景下用 SynchronousQueue 或 Flux 把 token 流式传回，虚拟线程不阻塞等待完整响应。

## 六、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"一行配置、自动改 Tomcat、HikariCP 不变、CPU/GPU 用平台池"**。

- **配置**：spring.threads.virtual.enabled=true（Spring Boot 3.2+）
- **自动改**：Tomcat 请求线程、@Async 默认、TaskExecutor
- **不变**：HikariCP（按后端容量配）、JMS Listener、Quartz
- **必须平台池**：CPU 密集（@Async("cpuExecutor")）、JNI/GPU、synchronized 重
- **HikariCP 必调**：默认 10 太小，按后端 MySQL 容量配（50-100）
- **监控**：JFR jdk.VirtualThreadPinned + jvm.threads.virtual.count

### 拟人化理解

把虚拟线程配置想成**改造城市交通**。spring.threads.virtual.enabled 是"开启毛细血管系统"（百万虚拟线程跑 IO 轻活），但城市还有主干道（carrier 平台线程跑重活）。CPU 密集任务（如加密）像大型货车——只能走主干道，硬要走毛细血管会堵死；JNI/GPU 调用像超限运输——必须走专用主干道（平台线程池），否则 pinning 出事故。HikariCP 像高速公路收费站——容量固定（10 个通道），百万车辆（VT）挤 10 通道必然瘫痪，要按 DB 容量扩到 50 通道。

### 面试现场 60 秒回答

> Spring Boot 3.2+ 一行配置 spring.threads.virtual.enabled=true 开启虚拟线程，自动把 Tomcat 请求线程、@Async 默认 Executor、TaskExecutor 改成虚拟线程。但要分类共存：IO 密集（HTTP/DB/消息）用虚拟线程（让出 carrier）；CPU 密集（加解密/序列化）保留平台线程池（@Async("cpuExecutor")）；JNI/GPU（CUDA/ONNX）用平台线程池（避免 pinning）。HikariCP 不受影响——必须按后端 MySQL 容量配（50-100，不是默认 10），否则百万 VT 等 10 连接全 pinning。JMS Listener、Quartz 独立配置，不随 spring.threads.virtual 变。监控用 JFR 看 jdk.VirtualThreadPinned 事件 + Micrometer jvm.threads.virtual.count。

### 反问面试官

> 贵司 Spring Boot 版本？业务里有 CPU 密集任务（加解密/序列化）或 GPU/JNI 调用吗？HikariCP 默认配置多大？这决定我聊虚拟线程落地还是线程池共存策略。

## 七、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 已经有 Reactor/WebFlux 了，还要虚拟线程吗？ | 不必须但推荐。WebFlux 已异步（Netty event loop），但 WebFlux 内部的 blocking call（如 JDBC）还是要靠 boundedElastic 平台线程池，虚拟线程能更好。如果纯 WebFlux + Reactive 全栈，虚拟线程收益小 |
| 证据追问 | 怎么证明虚拟线程真的提升了性能？ | 压测：开启前后 QPS / P99 / 内存对比（IO 密集场景 QPS 应翻倍）；监控：jvm.threads.virtual.count + carrier CPU 利用率（应拉满）；JFR：pinning 事件 < 1/分钟 |
| 边界追问 | 所有 @Async 都该用虚拟线程吗？ | 不是。CPU 密集 @Async 用虚拟线程无收益（carrier 占满）；JNI/GPU @Async 必须 platform pool（pinning）；只有 IO 密集 @Async 用虚拟线程有收益。要按任务特征分流 |
| 反例追问 | 什么场景不要开 spring.threads.virtual.enabled？ | 纯 CPU 密集服务（无收益）、JNI/GPU 主导服务（pinning 严重）、第三方库大量 synchronized（pinning）、JDK < 21 |
| 风险追问 | 开启虚拟线程最大风险？ | ① HikariCP 不调大导致 VT 等连接 pinning；② CPU 密集任务被 @Async 默认执行器（虚拟线程）跑导致 carrier 占满；③ JNI/GPU pinning；④ 第三方库 synchronized pinning。治法：HikariCP 调大、@Async 指定平台池、JFR 监控 pinning |
| 验证追问 | 怎么证明虚拟线程落地后健康？ | jstack 看 carrier 数和挂起原因（carrier RUNNABLE 但 CPU 低 = pinning）；JFR 看 jdk.VirtualThreadPinned 频率（< 100/分钟健康）；Micrometer 看 jvm.threads.virtual.count（业务合理范围）；HikariCP active/wait（wait 低健康） |
| 沉淀追问 | 团队推广虚拟线程沉淀什么？ | 线程模型选型矩阵（按任务特征分流）、Spring Boot 虚拟线程 + 平台池共存模板、HikariCP 容量评估 SOP、JFR pinning 监控告警、Code Review checklist（@Async 是否指定正确 executor） |

### 现场对话示例

**面试官**：spring.threads.virtual.enabled=true 开启后，所有 @Async 都用虚拟线程了？

**候选人**：默认是。但这是问题——CPU 密集任务和 JNI/GPU 调用不能用虚拟线程。CPU 密集用虚拟线程会让 carrier 占满（虚拟线程的载体还是平台线程）；JNI/GPU 会 pinning（carrier 钉死）。所以生产代码必须显式指定 executor：@Async("cpuExecutor") 用平台线程池跑 CPU 任务，@Async("gpuExecutor") 用平台线程池跑 GPU 推理。只有 IO 密集 @Async 用默认虚拟线程。这是线程模型分层的核心。

**面试官**：HikariCP 怎么配？

**候选人**：HikariCP 不受 spring.threads.virtual 影响，要按后端 MySQL 容量配。原默认 10 个连接在虚拟线程下是灾难——百万 VT 等 10 连接全 pinning。生产建议：maximum-pool-size 按 MySQL 的 max_connections 和单查询耗时算，一般 50-100；connection-timeout 调到 2s（失败快，避免 VT 长时间挂起）。HikariCP Wiki 公式：池大小 = (核心数 × 2) + 有效磁盘数，但实际还要看 DB 承载。

**面试官**：JFR 怎么监控虚拟线程健康？

**候选人**：三个核心指标。第一，jdk.VirtualThreadPinned 事件（threshold 默认 20ms），pinning 频率高说明 synchronized 或 native 调用多，要治理。第二，jvm.threads.virtual.count（Micrometer 暴露），虚拟线程数应在业务合理范围（不是无限增长）。第三，carrier CPU 利用率（process_cpu_usage），正常应该和业务负载匹配；如果 carrier RUNNABLE 但 CPU 低，说明大量 pinning（carrier 在等）。配合 jstack 看 carrier 状态最直观。

## 常见考点

1. **spring.threads.virtual.enabled 影响什么？**——Tomcat 请求线程、@Async 默认 Executor、TaskExecutor Bean。不影响 HikariCP、JMS、Quartz、WebFlux。
2. **CPU 密集任务能用虚拟线程吗？**——不推荐。CPU 密集用虚拟线程无收益（carrier 还是平台线程在跑），反而占满 carrier。用 @Async("cpuExecutor") 指定平台线程池。
3. **HikariCP 在虚拟线程下怎么配？**——按后端 MySQL 容量配（50-100），不随线程模型变。默认 10 个连接是灾难（百万 VT 等连接 pinning）。
4. **JNI/GPU 调用为什么不能用虚拟线程？**——JNI 内阻塞必然 pinning（JVM 看不到 native 栈）。用平台线程池（gpuExecutor）隔离。
5. **怎么监控虚拟线程健康？**——JFR jdk.VirtualThreadPinned（pinning 频率）+ jvm.threads.virtual.count（VT 数）+ carrier CPU 利用率 + HikariCP wait。

## 结构化回答

**30 秒电梯演讲：** Spring Boot 3.2+ 一行配置 `spring.threads.virtual.enabled=true` 开启虚拟线程，但开启不等于调优。虚拟线程和平台线程池（@Async、TaskExecutor、HikariCP、Reactor）的共存策略——哪些应该改虚拟线程、哪些必须保留平台线程池、哪些要分而治之——才是落地的核心

**展开框架：**
1. **spring.threa** — spring.threads.virtual.enabled=true（Spring Boot 3.2+）
2. **Tomcat / @As** — Tomcat / @Async / TaskExecutor 默认改虚拟线程
3. **必须保留平台线程池的场景** — CPU 密集、JNI/GPU、第三方 SDK

**收尾：** 以上是我的整体思路。您想继续深入聊——spring.threads.virtual.enabled 影响哪些组件？


## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：Spring Boot 虚拟线程配置与线程池共存 | "这题核心是——Spring Boot 3.2+ 一行配置 `spring.threads.virtual.enab……" | 开场钩子 |
| 0:15 | spring.threa示意/对比图 | "spring.threads.virtual.enabled=true（Spring Boot 3.2+）" | spring.threa要点 |
| 0:40 | Tomcat / @As示意/对比图 | "Tomcat / @Async / TaskExecutor 默认改虚拟线程" | Tomcat / @As要点 |
| 1:25 | 总结卡 | "记住：spring.threads。下期见。" | 收尾 |
