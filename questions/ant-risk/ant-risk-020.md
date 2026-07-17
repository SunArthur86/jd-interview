---
id: ant-risk-020
difficulty: L3
category: ant-risk
subcategory: 实时计算
tags:
- 蚂蚁
- 风控
- 可观测性
- 监控
- 全链路
- SkyWalking
feynman:
  essence: 可观测性 = Metrics（指标）+ Logs（日志）+ Traces（链路）三件套，让分布式系统从"黑盒"变"白盒"，故障可定位、性能可分析。
  analogy: 可观测性像行车仪表盘——Metrics 是时速/油量（聚合数字）、Logs 是行车记录仪（事件流水）、Traces 是导航轨迹（每个路口耗时），三者配合还原车况。
  first_principle: 微服务调用链可能跨几十个服务，没有可观测性时故障"黑盒化"；Metrics/Logs/Traces 从不同维度还原系统状态，让故障可见、可定位、可分析。
  key_points:
  - 三支柱：Metrics（聚合数）+ Logs（事件流）+ Traces（调用链）
  - Metrics 三种：Counter（累加）/ Gauge（瞬时）/ Histogram（分布）
  - Trace 三个概念：Trace（一次请求）/ Span（一次调用）/ Context（traceId 透传）
  - 日志分级 + 关键字段（traceId/uid/eventType）+ ELK/Loki
first_principle:
  problem: 分布式系统跨多服务、多机器、多区域，故障时如何快速定位是哪个环节出问题？
  axioms:
  - 单服务视角不够（要全链路）
  - 聚合数据不够（要事件级）
  - 单一时间不够（要时间序列）
  rebuild: Metrics 看宏观趋势告警，Traces 定位具体调用链哪一段慢/错，Logs 看具体事件细节。三者用 traceId/时间窗口关联。
follow_up:
- 用过什么监控栈？——Prometheus（Metrics）+ ELK（Logs）+ SkyWalking/Jaeger（Traces）
- 全链路 traceId 怎么传？——HTTP header/Sleuth 注入；线程池要装饰 Runnable
- 风控系统的关键监控指标？——决策 RT（P99）、规则命中率、拦截率、误杀率、模型分数分布
memory_points:
- 可观测性三支柱：Metrics + Logs + Traces
- Metrics 4 种：Counter/Gauge/Histogram/Summary
- Trace = 多个 Span（每个调用一个），用 traceId 串联
- 全链路 traceId 透传（HTTP/MQ/线程池都要处理）
---

# 【蚂蚁风控】分布式系统的全链路监控怎么做？可观测性三支柱？

> JD 依据："保障海量数据系统的性能和稳定性"。监控是稳定性的眼睛。

## 一、表面层：可观测性是什么

**可观测性 = Metrics + Logs + Traces**

| 支柱 | 内容 | 解决什么 | 工具 |
|------|------|---------|------|
| **Metrics** | 聚合数值（QPS、RT、错误率） | 看趋势、告警 | Prometheus、Micrometer |
| **Logs** | 事件流水 | 看具体发生了什么 | ELK、Loki、SLS |
| **Traces** | 调用链路（一棵树） | 定位慢/错在哪个环节 | SkyWalking、Jaeger、Zipkin |

三者配合：告警发现 → trace 定位环节 → log 看细节。

## 二、Metrics：聚合指标

**4 种指标类型**：

| 类型 | 含义 | 例子 |
|------|------|------|
| **Counter** | 单调递增 | 请求总数、错误总数 |
| **Gauge** | 瞬时值（可增可减） | 当前连接数、内存使用 |
| **Histogram** | 分布（分桶） | RT 分布（P50/P90/P99） |
| **Summary** | 分布（客户端算分位） | 同上，但不支持聚合 |

**风控关键 Metrics**：
```
# 业务指标
risk_decision_total{result="pass"}        # 决策数（按结果分）
risk_decision_duration_seconds            # 决策耗时分布
risk_rule_hit_total{rule_id="R001"}       # 规则命中次数
risk_intercept_rate                       # 拦截率（Gauge）

# 系统指标
jvm_memory_used_bytes                     # JVM 内存
jvm_gc_pause_seconds                      # GC 耗时
http_server_requests_seconds              # HTTP 请求
```

**告警规则**（Prometheus）：
```yaml
# 风控决策 P99 RT > 500ms
- alert: RiskDecisionSlow
  expr: histogram_quantile(0.99, rate(risk_decision_duration_seconds_bucket[5m])) > 0.5
  for: 5m
  labels: { severity: warning }
  annotations: { summary: "决策 P99 > 500ms" }

# 拦截率突增（可能有规则异常）
- alert: RiskInterceptRateAnomaly
  expr: rate(risk_decision_total{result="reject"}[5m]) / rate(risk_decision_total[5m]) > 0.5
  for: 10m
```

## 三、Logs：事件流水

**日志三原则**：
1. **结构化**（JSON，方便解析）
2. **关键字段**（traceId、uid、timestamp、eventType）
3. **分级**（ERROR/WARN/INFO/DEBUG）

**风控的日志规范**：
```java
log.info(JSON.stringify(Map.of(
    "traceId", TraceContext.get(),
    "uid", uid,
    "event", "DECISION",
    "result", "REJECT",
    "duration_ms", 45,
    "hit_rules", "R001,R045",
    "timestamp", System.currentTimeMillis()
)));
```

**ELK 架构**：
```
应用日志 → Filebeat → Kafka → Logstash → Elasticsearch → Kibana
                  （缓冲）   （解析）    （存储+搜索）    （查询展示）
```

**Loki（轻量替代）**：
```
应用日志 → Promtail → Loki → Grafana
```
比 ELK 省资源，索引只标 label 不索引全文。

## 四、Traces：调用链路（核心）

**Trace 是一棵树**：
```
风控决策（traceId=abc, spanId=1, 200ms）
  ├─ 特征查询（spanId=2, 50ms）   ← OK
  ├─ 规则匹配（spanId=3, 100ms）
  │    └─ Redis 查询（spanId=4, 90ms）  ← 慢点
  └─ 模型推理（spanId=5, 50ms）    ← OK
```

每个 **Span** 包含：
- traceId（整棵树唯一）
- spanId（自己唯一）
- parentSpanId（父调用）
- 操作名、开始时间、耗时
- tags（业务字段：uid、amount）
- logs（事件）

**调用链传播**：
```
HTTP: 通过 header（X-B3-TraceId / traceparent）
  ↓
RPC（Dubbo/Feign）：通过附件（attachment）
  ↓
消息队列：通过消息属性
  ↓
线程池：通过装饰 Runnable（不然 traceId 丢失！）
```

**线程池的 traceId 透传**（容易踩坑）：
```java
public class TraceRunnable implements Runnable {
    private final Runnable delegate;
    private final String traceId;
    public TraceRunnable(Runnable r) {
        this.delegate = r;
        this.traceId = TraceContext.get();   // 构造时捕获
    }
    public void run() {
        try {
            TraceContext.set(traceId);       // 运行时设置
            delegate.run();
        } finally {
            TraceContext.clear();
        }
    }
}
// pool.submit(new TraceRunnable(() -> queryProfile(uid)));
```

## 五、风控的全链路监控架构

```
风控链路（一笔交易的风险决策）:
用户支付 → 风控网关 → 风控决策 → 特征查询（HBase/Redis）
                              ↘ 规则匹配（规则引擎）
                              ↘ 模型推理（ML 模型）
                              ↘ 画像查询（用户画像服务）

每个环节埋点：
  - HTTP/RPC 调用自动埋点（SkyWalking agent）
  - 业务关键点手动埋点（@Trace 注解）
  - 数据库/缓存调用自动埋点
```

**SkyWalking Java Agent**：
```bash
# 启动时挂载 agent（无侵入）
java -javaagent:skywalking-agent.jar \
     -Dskywalking.agent.service_name=risk-decision \
     -Dskywalking.collector.backend_service=sw-oap:11800 \
     -jar risk-decision.jar
```

自动埋点：
- HTTP/Servlet
- Spring Cloud（Feign、Gateway）
- 数据库（MySQL、HBase）
- 缓存（Redis）
- 消息（Kafka）
- 线程池

## 六、风控关键监控看板

**业务大盘**（实时）：
- QPS（每秒决策数）
- P99 RT（决策耗时）
- 拦截率、误杀率（业务关键）
- 规则命中 Top 10
- 模型分数分布直方图

**系统大盘**：
- JVM 内存、GC
- 数据库连接池
- Redis 命中率
- Kafka lag

**告警分级**：
- P0（电话）：决策不可用、P99 > 2s
- P1（短信）：拦截率突增 50%、规则异常
- P2（IM）：P99 > 500ms、慢查询

## 七、底层本质：可观测性的"还原系统状态"哲学

可观测性来自控制论，定义是：
> 通过外部输出推断系统内部状态的能力。

分布式系统下，"输出"就是 Metrics/Logs/Traces：
- **Metrics**：高频聚合（宏观，省存储）
- **Logs**：低频详细（微观，看具体）
- **Traces**：结构化关联（中观，看链路）

**三者的关联**：
```
告警（Metrics 发现 RT 高）
   ↓ 点开看
Trace（哪一段慢）→ 找到 Redis Span 慢
   ↓ 关联
Log（Redis 慢的具体命令、key）→ 发现大 key
```

**这是"分形观测"**：
- 远看（Metrics）发现异常
- 中看（Traces）定位环节
- 近看（Logs）看细节

## 八、压测与预案的可观测性

**全链路压测**：
- 用真实流量录制 + N 倍回放
- 影子库/影子表隔离压测数据
- 实时监控各项指标

**预案演练**：
- 定期"杀实例"演练（验证高可用）
- 演练时全程观测（验证降级生效）

**SRE 的"金标准"**：
- MTTR（平均恢复时间）< 5 分钟
- 关键故障演练覆盖 > 80%

## 九、AI 时代的可观测性演进

**AIOps**（智能运维）：
- 异常自动检测（机器学习识别异常模式）
- 根因自动定位（基于 trace 图分析）
- 容量预测（基于历史数据）

**LLM + 可观测性**：
- 用 LLM 解读日志、生成报告
- 自然语言查询（"昨天风控系统为什么慢"）
- 智能告警聚合（避免告警风暴）

## 常见考点
1. **Metrics 选 Counter 还是 Gauge**？——Counter 只增不减（请求数）；Gauge 可增可减（连接数）。
2. **Trace 怎么保证全局唯一**？——上游传 traceId，下游复用；不传则生成新的（断了链路）。
3. **大流量下采样策略**？——Trace 默认 100% 采样，高 QPS 时按比例采样（如 1%）；Error 必采。

**代码示例**（自定义 Metrics 埋点）：
```java
// 用 Micrometer 暴露业务指标
@Service
public class RiskDecisionService {
    private final MeterRegistry registry;
    private final Counter decisionCounter;
    private final Timer decisionTimer;

    public RiskDecisionService(MeterRegistry registry) {
        this.registry = registry;
        this.decisionCounter = Counter.builder("risk.decision")
            .description("Risk decision count")
            .register(registry);
        this.decisionTimer = Timer.builder("risk.decision.duration")
            .publishPercentiles(0.5, 0.99)
            .register(registry);
    }

    public Result decide(Event e) {
        return decisionTimer.record(() -> {
            Result r = doDecide(e);
            decisionCounter.increment();  // 计数
            registry.counter("risk.decision", "result", r.name()).increment();  // 带标签
            return r;
        });
    }
}
```

## 苏格拉底式面试追问

> 这组追问不是背答案，而是模拟面试官层层逼迫本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：风控全链路监控你选了 SkyWalking 而不是 Pinpoint 或 Zipkin。决策依据是什么？为什么 SkyWalking 更适合风控？**

三个维度：性能开销、生态、功能。性能上，SkyWalking 的字节码增强开销 <5%（CPU），Pinpoint 约 5-10%（更细粒度的字节码改写），风控决策链路 RT 预算紧（P99 <50ms），监控开销要小。生态上，SkyWalking 是 Apache 顶级项目，社区活跃，对中国系中间件（Dubbo、Nacos、Sentinel、RocketMQ）支持好，风控技术栈正是阿里系，兼容性优。功能上，SkyWalking 同时提供 Metrics + Trace + Log（三合一），而 Zipkin 只做 Trace，需要额外配 Prometheus（Metrics）+ ELK（Log），运维多套系统。决策依据是压测对比——同 QPS 下 SkyWalking 的决策 RT P99 增加 2ms，Pinpoint 增加 4ms，Zipkin + Prometheus 组合增加 3ms 且要运维两套。SkyWalking 性能最优且三合一，是风控的最佳匹配。

### 第二层：证据与定位

**Q：风控决策 P99 RT 告警（>500ms），但业务方说"用户感知没这么慢"。你怎么确认是真实慢还是监控误报？**

两组证据区分监控准确性：
1. 对比客户端和服务端 RT——监控的 P99 是服务端处理时间，但用户感知的是端到端（含网络）。拉 CDN/网关的访问日志看客户端 RT，如果客户端 P99 也是 500ms，是真实慢；如果客户端 P99 是 50ms 但服务端 P99 500ms，是监控口径问题（如 SkyWalking 的 trace 只算了部分 span、或异步线程的 RT 统计错误）。看网关（如 Nginx）的 `$request_time` 和 `$upstream_response_time` 对比。
2. 看监控的样本量——如果 P99 的样本只有 10 条（低峰期），一条异常就能拉高 P99，不具代表性。看 `histogram_quantile` 的桶分布，如果 P99 落在样本量极少的尾部，是噪音。改用 P95 或增加样本窗口（从 1 分钟到 5 分钟）看是否仍高。
如果确认是真实慢，进 trace 定位是哪一段（见第三层）。

### 第三层：根因深挖

**Q：你进 SkyWalking 看慢请求的 trace，发现某个 Span "feature-service.get" 耗时 400ms，但点进去看没有子 Span。根因是什么？为什么这个调用没有子 Span？**

没有子 Span 有两种情况：
1. feature-service 内部没有埋点——如果 feature-service 没装 SkyWalking agent 或 agent 配置漏了某个插件（如 HBase 插件没启用），它的内部调用（查 Redis、HBase）不会有 Span，trace 断在这一层。根因是 feature-service 的监控缺失，要检查它的 agent 配置和插件列表。
2. 调用本身就是单次操作——如果 feature-service.get 是直接查 HBase（一次 RPC），HBase 的客户端（如 HBase Client）没有 SkyWalking 插件支持，Span 就在 "feature-service.get" 停了，但这个 Span 包含了"网络 + HBase 服务端处理 + 网络"，400ms 可能是 HBase 慢。要手动在 feature-service 里加更细的埋点（`@Trace` 注解或手动 Tracer.span`），区分"网络时间"和"HBase 处理时间"。
验证方法：在 feature-service 里加 arthas trace `com.xxx.FeatureService get '#cost>200'`，看是 HBase.get 慢还是别的。如果 HBase.get 慢，是 HBase 侧问题（查 HBase 的 Get_99th 指标）。

**Q：根因是 HBase 慢但 trace 没透到 HBase 层。那为什么不直接给所有组件装 SkyWalking 插件，自动埋点全覆盖？**

全组件自动埋点是理想，但有代价。一是 agent 体积——插件越多 agent jar 越大（SkyWalking agent 全插件可能 50MB+），启动慢、占 metaspace。二是性能开销——每个插件的字节码增强都有 CPU 和内存开销，全组件埋点可能让应用 RT 增加 10%+。三是兼容性——某些中间件的插件可能不稳定（如 HBase 2.x 的插件对老版本不兼容），全量启用可能引入 bug。实务做法是分层启用——核心链路的组件（HTTP、Spring Cloud、MySQL、Redis、Dubbo）全启用（这些插件成熟、开销小），非核心或冷门组件（HBase、特定 MQ）按需启用或手动埋点。对 HBase，如果插件不稳定，我们在 feature-service 里手动加 `@Trace("hbase.get")` 注解，用 Span 包装 HBase.get 调用，手动透传 traceId 到 HBase 的 RPC header（HBase 支持自定义 header），这样 trace 能透到 HBase 的 regionserver（如果 regionserver 也装了 agent）。

### 第四层：方案权衡

**Q：你加了 HBase 手动埋点后 trace 完整了。但业务说"风控链路 RT <50ms，监控开销占比高"。怎么权衡监控精度和性能开销？**

分级采样 + 动态开关。分级采样——正常请求采样 1%（10ms 内的"快请求"只采样少部分），慢请求（>100ms）100% 采样，Error 100% 采样。这样大部分快请求的开销低（1% 采样的 agent 逻辑），慢请求和错误全记录（用于定位）。SkyWalking 支持 `trace.sample_n_per_3_secs` 配置采样率，也支持按"慢阈值"强制采样（`trace.slow_db_threshold`）。动态开关——通过配置中心控制采样率，平时 1%，故障期间临时调到 100%（全量采集辅助排查），故障后调回。开销量化——1% 采样时 agent 的 CPU 开销 <0.5%，对风控链路 RT 影响 <0.5ms，可接受。权衡点是"用采样换开销"，但保证慢请求和错误必采（它们才是需要定位的）。

**Q：为什么不直接用 eBPF（如 Pixie）做无侵入监控，连 agent 都不用装，开销更低？**

eBPF 确实无侵入（内核层抓包分析），但它有局限。一是语义深度——eBPF 抓的是网络包和系统调用，能拿到"HTTP 请求 + RT"，但拿不到应用层的业务语义（如"这个请求的 uid 是多少、命中了哪些规则"），而这些业务字段是风控 trace 的关键。二是 JVM 内部不可见——eBPF 看不到 JVM 内部的方法调用（如 FeatureService.get 内部的规则匹配耗时），只能看到 JVM 发出的网络调用。风控的很多慢是"JVM 内部计算慢"（如规则引擎匹配），eBPF 看不到，必须用 agent 字节码增强。eBPF 适合"基础设施层监控"（网络、内核），Java agent 适合"应用层监控"（业务方法、JVM 内部）。风控要业务可观测性，agent 更合适。eBPF 可以作为补充（监控网络层异常），但不替代 agent。

### 第五层：验证与沉淀

**Q：你怎么验证全链路监控的覆盖率——所有关键调用都被 trace 了、没有断链？怎么量化"监控健康度"？**

三个量化指标：
1. trace 完整性——统计"trace 的平均 span 数"，风控决策链路应该有 15-20 个 span（HTTP → 决策 → 特征 → HBase/Redis + 规则 + 模型）。如果某段时间平均 span 数掉到 5，说明某层 trace 断了（agent 漏装或采样丢失）。按服务维度统计 span 数，发现短板。
2. 断链率——trace 跨服务时，下游服务的 trace 应该继承上游 traceId。统计"trace 在服务 A 调用服务 B 后，B 有 span 的比例"，应 >99%。如果 <95%，是 traceId 透传问题（如 MQ 消费没透传 traceId 到 header，或线程池没装饰 Runnable）。
3. 采样命中率——慢请求（>100ms）和错误请求的 trace 采样率应 100%。统计"慢请求有 trace 的比例"，应 100%。如果慢请求没 trace（采样漏了），无法定位故障。

**Q：怎么让团队的可观测性持续健康、不退化？**

沉淀成规范和机制：
1. 监控规范——新服务上线必须有基础监控（Metrics 暴露 + Trace agent + 结构化日志），SRE 验收否则不发版。监控项包括 QPS、RT P99、错误率、JVM、下游依赖。
2. traceId 透传规范——所有跨边界（HTTP/RPC/MQ/线程池）必须透传 traceId，Code Review 检查。线程池用封装好的 TraceExecutorService（自动装饰 Runnable），禁止裸 submit。
3. 监控覆盖率巡检——每周自动扫描所有服务的 trace span 数、断链率、慢请求采样率，输出报告，低分服务要整改。
4. 告警治理——定期 review 告警的有效性（告警 → 真实故障的转化率），噪音告警调阈值或下线。目标是告警精准（少而准）。
5. 故障复盘——每次故障复盘时 review"监控是否及时发现了故障、定位链路是否顺畅"，如果监控没覆盖到，补埋点。把这次"HBase 慢但 trace 没透到 HBase 层"的 trace 截图、手动埋点方案存知识库。


## 结构化回答

**30 秒电梯演讲：** 聊到分布式系统的全链路监控怎么做？可观测性三支柱，我的理解是——可观测性 = Metrics（指标）+ Logs（日志）+ Traces（链路）三件套，让分布式系统从"黑盒"变"白盒"，故障可定位、性能可分析。打个比方，可观测性像行车仪表盘——Metrics 是时速/油量（聚合数字）、Logs 是行车记录仪（事件流水）、Traces 是导航轨迹（每个路口耗时），三者配合还原车况。

**展开框架：**
1. **三支柱** — Metrics（聚合数）+ Logs（事件流）+ Traces（调用链）
2. **Metrics 三种** — Counter（累加）/ Gauge（瞬时）/ Histogram（分布）
3. **Trace 三个概念** — Trace（一次请求）/ Span（一次调用）/ Context（traceId 透传）

**收尾：** 这块我在项目里也踩过坑——想深入的话，可以接着聊：用过什么监控栈？您更想看哪个方向？

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡 | "分布式系统的全链路监控怎么做？可观测性三支柱——这道题面试官到底想考什么？我用 30 秒给你讲透。" | 开场钩子 |
| 0:15 | 分布式架构图 | 先说核心：可观测性 = Metrics（指标）+ Logs（日志）+ Traces（链路）三件套，让分布式系统从"黑盒"变"白盒"，故障可定位、性能可分析。 | 核心定义 |
| 0:40 | 监控大盘截图 | Counter（累加）/ Gauge（瞬时）/ Histogram（分布）。 | Metrics 三种 |
| 1:05 | 概念结构示意图 | Trace（一次请求）/ Span（一次调用）/ Context（traceId 透传）。 | Trace 三个概念 |
| 2:30 | 总结卡 | 一句话记忆：可观测性三支柱：Metrics + Logs + Traces。 下期可以接着聊：用过什么监控栈。 | 收尾总结 |
