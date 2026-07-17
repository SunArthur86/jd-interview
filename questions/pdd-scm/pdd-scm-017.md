---
id: pdd-scm-017
difficulty: L2
category: pdd-scm
subcategory: Java 并发
tags:
- 拼多多
- 供应链
- 线程池
- 池化
- ThreadPoolExecutor
feynman:
  essence: 线程池用"核心线程+队列+非核心线程+拒绝策略"四级兜底应对流量洪峰；阿里规约禁止 Executors，必须 new ThreadPoolExecutor 且队列有界。
  analogy: 线程池像餐厅——正式员工（核心线程）、等位区（队列）、临时工（非核心线程）、超载拒绝（拒绝策略）。
  first_principle: 创建线程成本高（OS 调度+1MB 栈），池化复用；四级水位让流量洪峰优雅降级而非崩溃。
  key_points:
  - 7 参数：core/max/keepAlive/queue/factory/handler/unit
  - 提交顺序：核心 → 队列 → 非核心 → 拒绝（先队列后扩容！）
  - 4 种拒绝：Abort/CallerRuns/Discard/DiscardOldest
  - 禁用 Executors（无界 OOM）
first_principle:
  problem: 高并发下线程创建/销毁成本高，如何复用+削峰+降级？
  axioms:
  - 线程创建有成本
  - 资源有限，过载需降级
  - 排队是最便宜削峰
  rebuild: 核心线程常驻+有界队列+临时扩容+拒绝策略四级水位。
follow_up:
- 线程数怎么设？——CPU 密集 N+1，IO 密集 2N 或 N×(1+等待/计算)
- Executors 为什么禁用？——newFixedThreadPool 队列无界 OOM；newCachedThreadPool 线程数 MAX_VALUE
- 怎么传 TraceId？——装饰 Runnable，submit 时捕获父线程 MDC
memory_points:
- 提交顺序：核心 → 队列 → 非核心 → 拒绝
- 必须有界（队列+线程数）
- 4 种拒绝策略，常用 CallerRuns（反压）
- 线程必须命名（setNameFormat）便于排查
---

# 【拼多多供应链】线程池原理？怎么配置？

> JD 依据："理解并发、高并发系统调优"。

## 一、7 个核心参数

```java
new ThreadPoolExecutor(
    corePoolSize,           // 核心线程数
    maximumPoolSize,        // 最大线程数
    keepAliveTime,          // 非核心空闲存活
    unit,
    workQueue,              // 任务队列（必须有界）
    threadFactory,          // 线程工厂（必须命名）
    rejectedHandler         // 拒绝策略
);
```

## 二、任务提交流程

```
execute(task)
   ↓
当前线程数 < core? → 创建核心线程
   ↓ 否
队列没满? → 入队
   ↓ 否
当前线程数 < max? → 创建非核心线程
   ↓ 否
执行拒绝策略
```

**关键**：先入队再扩容（不是先扩容）！

## 三、4 种拒绝策略

| 策略 | 行为 | 适用 |
|------|------|------|
| AbortPolicy（默认） | 抛异常 | 默认 |
| CallerRunsPolicy | 调用方执行 | 反压（让上游感知压力） |
| DiscardPolicy | 丢弃 | 可丢（日志） |
| DiscardOldestPolicy | 丢最老 | 关心最新 |

## 四、供应链实战配置

```java
ThreadPoolExecutor productPool = new ThreadPoolExecutor(
    64, 128, 60, SECONDS,
    new LinkedBlockingQueue<>(2000),                // 有界！
    new ThreadFactoryBuilder().setNameFormat("product-%d").build(),
    new CallerRunsPolicy()                           // 反压
);
```

**线程数计算**（IO 密集，查 DB/Redis 多）：
```
线程数 ≈ N × (1 + 等待/计算)
8 核机器 IO 密集 → 64 线程
```

## 五、阿里规约禁用 Executors

| Executors 方法 | 坑 |
|----------------|-----|
| newFixedThreadPool | LinkedBlockingQueue 无界 → OOM |
| newCachedThreadPool | 线程数 Integer.MAX_VALUE → OOM |
| newSingleThreadExecutor | 同 Fixed，无界队列 |

必须 new ThreadPoolExecutor + 有界队列 + 有界线程数。

## 六、监控（生产必备）

```java
Gauge.builder("pool.active", pool, ThreadPoolExecutor::getActiveCount).register();
Gauge.builder("pool.queue.size", pool, p -> p.getQueue().size()).register();
// 队列使用率 > 80% 告警扩容
```

## 七、底层本质

池化是"资源租赁市场的做市商"：核心常备覆盖稳态、队列缓冲小波动、临时扩容中波动、拒绝兜底极端波动。每级是上级溢出后的成本递增选项。

## 常见考点
1. **核心线程能回收吗**？——`allowCoreThreadTimeOut(true)` 后可。
2. **submit vs execute**？——execute 无返回值；submit 返回 Future。
3. **怎么传 TraceId**？——装饰 Runnable，submit 时捕获父线程 MDC，run 时设置。

## 苏格拉底式面试追问

> 这组追问不是背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：供应链的商品查询线程池，你配了 core=64, max=128, queue=2000。为什么不直接用 Executors.newCachedThreadPool（按需创建线程），那样不会拒绝任何请求？**

因为 newCachedThreadPool 的 max 是 `Integer.MAX_VALUE`，大促时如果下游 DB 慢，请求堆积会创建几万个线程，每个线程 1MB 栈 = 几十 GB 内存，直接 OOM。设 max=128 是"硬上限"——超过 128 线程 + 2000 队列后走拒绝策略（CallerRuns），让上游感知压力（反压），而不是无限创建线程拖垮整个 JVM。线程池的本质是"用有限资源换可控降级"，不是"满足所有请求"。

### 第二层：证据与定位

**Q：商品查询接口 P99 飙到 5 秒，你怀疑是线程池打满。怎么确认？**

三组证据：
1. **看线程池指标**——监控 `pool.active`（活跃线程数）、`pool.queue.size`（队列堆积）。如果 active=128（等于 max）且 queue.size=2000（队列满），线程池打满，新请求走 CallerRuns（在调用方线程执行，拖慢上游）。
2. **看拒绝次数**——`pool.reject.count`（自定义计数器，CallerRuns 前自增），如果每秒拒绝几百次，说明池子扛不住流量。
3. **看 jstack**——如果 128 个线程都 `RUNNABLE` 但卡在 `socketRead`（等 DB 响应），根因不是线程池小，是下游 DB 慢导致线程被占用（线程池里的线程都等 DB，不释放，队列堆积）。

### 第三层：根因深挖

**Q：线程池打满，active=128 都卡在 socketRead 等 DB。根因是线程池小还是 DB 慢？**

根因是 DB 慢，不是线程池小。128 个线程都在等 DB 响应（socketRead），说明 DB 响应时间暴涨（从 10ms 涨到 500ms），每个线程被占用 500ms，128 个线程 × 500ms = 每秒只能处理 256 个请求，QPS > 256 就堆积。盲目加大线程数（如 max=512）不解决——DB 本来就慢，更多线程涌过去只会让 DB 更慢（连接池打满、锁竞争加剧），雪崩。治本：
1. **修 DB 慢查询**——`SHOW PROCESSLIST` 看 DB 在干什么，大概率是慢 SQL（缺索引或锁等待），加索引或优化 SQL。
2. **加超时 + 熔断**——给 DB 查询配超时（如 `socketTimeout=500ms`），超时快速失败走降级，不让线程被长期占用；配 Sentinel 熔断，DB RT > 阈值时熔断走 fallback。

**Q：那为什么不直接把队列调到无界（queue=100000），让请求排队而不是拒绝？**

无界队列是灾难：
1. **OOM**——每个排队任务是 Runnable 对象，10 万个可能占几 GB 内存，OOM。
2. **延迟暴增**——队列里排 10 万个任务，按处理速度 256 QPS，队尾任务要等 10万/256 = 390 秒，用户早超时了，处理这些过期任务纯浪费。
3. **掩盖问题**——无界队列让"拒绝次数=0"，监控看不到压力，实际请求都积压在队列里慢慢超时，比直接拒绝更糟（拒绝至少 fail-fast 让上游知道）。
有界队列 + 拒绝策略（CallerRuns 或 Abort）才是正解——拒绝是"诚实反馈"，让上游感知压力做自适应降级。

### 第四层：方案权衡

**Q：你用了 CallerRunsPolicy（调用方执行）做反压。但大促时反压导致 Tomcat 线程也跟着跑商品查询逻辑，Tomcat 线程池也满了。怎么办？**

CallerRuns 的副作用是"反压传播到上游"，如果上游（Tomcat）也扛不住，会连锁。解法是分层降级：
1. **服务端快速失败**——把拒绝策略改成 `AbortPolicy`（抛 RejectedExecutionException），在网关层捕获异常返回 503 + Retry-After，让客户端重试而不是 Tomcat 线程兜底。
2. **请求方限流前置**——在网关层（Gateway）对商品查询接口配限流（如 Sentinel QPS=1000），超限直接 429，请求根本不到商品服务的线程池。
3. **降级返回缓存**——线程池拒绝时走 fallback 返回 Redis 里的"最近商品信息"（可能略旧但可用），而不是抛错。用 Resilience4j 的 Bulkhead + Fallback 组合。
策略是"网关限流挡大头 + 服务端线程池兜底 + 降级返回兜底数据"，三层防护。

**Q：为什么不直接用 ForkJoinPool（JDK 8 parallelStream 默认用的），它有 work-stealing，性能更好？**

ForkJoinPool 适合"CPU 密集 + 任务可分治"（如递归拆分大任务），不适合"IO 密集 + 独立任务"（如查 DB）：
1. **work-stealing 对 IO 无益**——IO 密集任务的瓶颈是等待（socketRead），不是计算，work-stealing 帮不上。
2. **公共池污染**——parallelStream 用的公共 ForkJoinPool（`commonPool`）被所有 parallelStream 共享，商品查询用它会让其他业务的 parallelStream（如排序、聚合）受影响。
3. **队列无界**——ForkJoinPool 的队列无限制，遇 IO 慢照样堆积。
所以 IO 密集用自定义 ThreadPoolExecutor（有界队列 + 有界线程 + 拒绝策略），CPU 密集的分治任务才用 ForkJoinPool。

### 第五层：验证与沉淀

**Q：你怎么证明线程池配置合理（线程数、队列大小、拒绝策略），大促时不雪崩？**

压测验证 + 在线监控：
1. **压测**——大促前用 2 倍预期 QPS 压测，观察 `pool.active`、`pool.queue.size`、`pool.reject.count`。合理配置下：active 稳定在 core 附近（64），queue.size < 500（25% 容量），reject.count = 0。如果 reject 频繁，说明 max 或 queue 太小。
2. **线程数公式验证**——IO 密集公式 `N × (1 + 等待/计算)`，压测时用 `arthas trace` 量"单次请求的 DB 等待时间 vs 计算时间"，算出理论线程数，对比实际配置。
3. **动态调整**——用 `ThreadPoolExecutor.setCorePoolSize()` / `setMaximumPoolSize()` 配合配置中心（Nacos）动态调，大促时根据实时流量调整，不用重启。

**Q：怎么让团队规范创建线程池，不用 Executors、不漏监控？**

沉淀线程池规范：
1. **统一创建工具**——封装 `ThreadPoolBuilder`，强制传入线程名前缀、有界队列、拒绝策略、监控埋点，禁止裸 `new ThreadPoolExecutor` 和 `Executors.xxx`。SonarQube 扫 `Executors.` 报 blocker。
2. **线程名规范**——必须 `setNameFormat("biz-pool-%d")`，jstack 能识别是哪个池子，排查问题定位快。
3. **监控强制**——所有线程池必须上报 `active/queue.size/reject.count` 到 Prometheus，配告警（queue > 80%、reject > 0），否则不让上线。
4. **动态化**——接入动态线程池框架（如美团 DynamicTp、阿里 dynamic-tp），通过配置中心实时调整 core/max/queue，不用发版。

## 结构化回答

**30 秒电梯演讲：** 高并发下线程创建/销毁成本高，如何复用+削峰+降级？简单说就是——线程池用"核心线程+队列+非核心线程+拒绝策略"四级兜底应对流量洪峰；阿里规约禁止 Executors，必须 new ThreadPoolExecutor 且队列有界。

**展开框架：**
1. **7 参数** — 7 参数：core/max/keepAlive/queue/factory/handler/unit
2. **提交顺序** — 提交顺序：核心 → 队列 → 非核心 → 拒绝（先队列后扩容！）
3. **4 种拒绝** — 4 种拒绝：Abort/CallerRuns/Discard/DiscardOldest

**收尾：** 您看这块要不要再展开聊聊？

## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：线程池原理？怎么配置？ | 今天聊「线程池原理？怎么配置？」。一句话：线程池用"核心线程+队列+非核心线程+拒绝策略"四级兜底应对流量洪峰；阿里规约禁止 Executors，必须 new … | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：7 参数：core/max/keepAlive/queue/factory/handler/unit | 核心概念 |
| 1:00 | 能力/参数拆解表 | 要点是：提交顺序：核心 → 队列 → 非核心 → 拒绝（先队列后扩容！） | 能力拆解 |
| 2:00 | 总结卡 + 下期预告 | 记住核心要点就够了。下期见。 | 收尾 |
