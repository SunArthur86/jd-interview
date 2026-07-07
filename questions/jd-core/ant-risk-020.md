---
id: ant-risk-020
difficulty: L3
category: jd-core
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
