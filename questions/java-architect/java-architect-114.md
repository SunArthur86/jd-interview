---
id: java-architect-114
difficulty: L3
category: java-architect
subcategory: 可观测性
tags:
- Java 架构师
- Micrometer
- 指标
- SLO
feynman:
  essence: Micrometer 是 Spring Boot 的"指标门面"（类似 SLF4J 之于日志），定义一套维度（name + tags + 数值）的指标模型，底层可对接 Prometheus / Datadog / NewRelic / CloudWatch。设计指标体系的核心是"少而准"——RED（Rate/Errors/Duration）+ USE（Utilization/Saturation/Errors）+ 业务核心指标（如订单量、支付成功率），用 SLO 倒推采集什么，不是"什么都能采"。
  analogy: 像汽车仪表盘：油量表（Gauge，当前值）、里程表（Counter，单调递增）、转速表（Histogram，分布）、温度警告灯（报警规则）。Micrometer 是仪表盘的统一驱动，不论装在特斯拉还是比亚迪，仪表盘外观一致。
  first_principle: 指标体系的本质是"用最小成本回答最重要的问题"——服务有没有问题（RED）、资源够不够用（USE）、业务正常吗（业务指标）。每个指标都要回答一个具体问题，没有问题的指标是浪费。
  key_points:
  - Micrometer 是指标门面（SLF4J 模式），支持多后端
  - 四种指标类型：Counter（递增）/Gauge（瞬时值）/Histogram（分布）/Timer（延迟+计数）
  - RED 黄金信号：Rate（QPS）/Errors（错误率）/Duration（P99 延迟）
  - USE 黄金信号：Utilization（利用率）/Saturation（饱和度）/Errors（错误）
  - Histogram 优于 Summary（服务端聚合，跨实例合并）
first_principle:
  problem: 怎么设计一套既能告警又能定位问题的指标体系，且采集成本可控？
  axioms:
  - 指标是聚合数字（QPS/P99/错误率），低成本全量采集
  - 不同信号有不同擅长：指标告警、日志排查、链路定位
  - 指标要回答具体问题（"服务有问题吗" / "资源够吗" / "业务正常吗"）
  rebuild: 用 RED + USE 框架设计指标。RED（服务视角）：Rate=QPS、Errors=错误率、Duration=P99 延迟，回答"服务有没有问题"。USE（资源视角）：Utilization=CPU/内存利用率、Saturation=线程池/连接池饱和度、Errors=GC/OOM，回答"资源够不够用"。加业务核心指标（订单量、支付成功率）。用 Micrometer 的 Histogram 类型（服务端聚合分位），采集全量但聚合后低成本。SLO 倒推采集：先定 SLO（如 P99 < 200ms），再设计指标（histogram_quantile）。
follow_up:
  - Histogram 和 Summary 区别？——Histogram 在服务端聚合分位（多个实例可合并算 P99）；Summary 在客户端算分位（跨实例无法合并）。生产用 Histogram
  - 指标命名怎么规范？——{domain}_{action}_{outcome}_{unit}，如 order_create_duration_seconds。Micrometer 自动规范化（点→下划线）
  - 高基数标签（cardinality）怎么避免？——不要用 userId / orderId 当标签（每个 ID 一个时序，标签爆炸）。标签应该是有限集合（如 method、status、env）
  - SLO 怎么定？——SLI（指标）→ SLO（目标，如 P99 < 200ms，错误率 < 0.1%）→ SLA（对外承诺）。SLO 是内部目标，SLA 是合同
  - 自定义业务指标怎么写？——@Timed 注解 / MeterRegistry 自定义 / Micrometer 注解
memory_points:
  - Micrometer 是指标门面（SLF4J 模式），多后端
  - 四类型：Counter（递增）/Gauge（瞬时）/Histogram（分布）/Timer（延迟+计数）
  - RED：Rate（QPS）/Errors（错误率）/Duration（P99）
  - USE：Utilization（利用率）/Saturation（饱和度）/Errors（错误）
  - Histogram 优于 Summary（服务端聚合，跨实例合并）
  - 高基数标签要避免（不用 userId/orderId 当标签）
  - SLO 倒推：先定目标再设计指标
---

# 【Java 后端架构师】Micrometer 指标体系如何设计

> 适用场景：JD 核心技术。订单服务上线后，Prometheus 大盘有几百个指标但没人看，告警每天误报 100 次被忽视。架构师必须用 RED + USE 框架重新设计指标体系，让每个指标回答具体问题，告警准确率 > 95%。

## 一、概念层：指标的类型与门面模式

**Micrometer 是什么**：

```
应用代码（Micrometer API）
        │
        ▼
   MeterRegistry（门面）
        │
   ┌────┼────┬────────┬─────────┐
   ▼    ▼    ▼        ▼         ▼
Prometheus Datadog NewRelic CloudWatch Atlas
```

**Micrometer 是 SLF4J 模式**：定义统一 API（Counter/Gauge/Histogram/Timer），底层对接多个监控系统。换监控系统不改代码。

**四种指标类型**（这张表面试必问）：

| 类型 | 用途 | Prom 对应 | 例子 |
|------|------|---------|------|
| **Counter** | 单调递增计数 | `http_requests_total` | 总请求数、总错误数 |
| **Gauge** | 瞬时值（可增可减） | `jvm_memory_used_bytes` | 当前内存、当前线程数、连接池活跃数 |
| **Histogram（直方图）** | 分布统计 | `http_request_duration_seconds_bucket` | P99 延迟、P999 延迟 |
| **Timer（计时器）** | 延迟 + 计数（Histogram + Counter） | 自动组合 | 方法耗时分布 |
| **LongTaskTimer** | 长任务计时 | gauge + counter | 进行中的批处理任务 |
| **DistributionSummary** | 任意值分布 | `_bucket` | 响应体大小分布 |

**Histogram vs Summary**（架构师必须答全）：

```
Histogram（推荐）：
  服务端（Prometheus）按 bucket 聚合分位
  多个实例可合并算 P99
  bucket 大小固定（如 50ms/100ms/200ms/500ms/1s）

Summary（不推荐）：
  客户端（应用）算分位（quantile 0.5/0.95/0.99）
  跨实例无法合并（每个实例有自己的 P99）
  资源消耗大（维护分位数据结构）
```

## 二、机制层：Micrometer 代码示例

**Spring Boot 自动配置 + 自定义指标**：

```java
// application.yml
management:
  endpoints:
    web:
      exposure:
        include: health,info,prometheus,metrics
  metrics:
    tags:
      application: order-service   # 全局标签（所有指标带）
      env: ${spring.profiles.active:prod}
    distribution:
      percentiles-histogram:
        http.server.requests: true                    # HTTP 自动开 Histogram
      slo:
        http.server.requests: 50ms,100ms,200ms,500ms,1s,2s   # SLO 分桶
      percentiles:
        http.server.requests: 0.5,0.95,0.99           # 客户端算分位（少用）

// 自定义业务指标
@Service
public class OrderService {
    private final Counter orderCreatedCounter;
    private final Counter orderFailedCounter;
    private final Timer orderCreateTimer;
    private final Gauge inventoryGauge;

    public OrderService(MeterRegistry registry) {
        // Counter：订单创建总数（带标签：type）
        this.orderCreatedCounter = Counter.builder("order.created.total")
            .tag("type", "normal")
            .description("Total orders created")
            .register(registry);

        this.orderFailedCounter = Counter.builder("order.failed.total")
            .tag("reason", "unknown")    // 失败时按原因打标签
            .register(registry);

        // Timer：订单创建耗时（Histogram）
        this.orderCreateTimer = Timer.builder("order.create.duration")
            .description("Order creation duration")
            .publishPercentiles(0.5, 0.95, 0.99)
            .register(registry);

        // Gauge：当前库存（瞬时值）
        this.inventoryGauge = Gauge.builder("inventory.level", () -> getInventory())
            .register(registry);
    }

    public Order createOrder(OrderDTO dto) {
        return orderCreateTimer.record(() -> {     // 自动计时
            try {
                Order order = doCreate(dto);
                orderCreatedCounter.increment();   // 计数 +1
                return order;
            } catch (Exception e) {
                orderFailedCounter.increment();    // 失败计数
                throw e;
            }
        });
    }
}
```

**注解方式（@Timed）**：

```java
// 自动给 Spring MVC 接口加 Timer
@Configuration
public class MetricsConfig {
    @Bean
    public TimedAspect timedAspect(MeterRegistry registry) {
        return new TimedAspect(registry);
    }
}

@RestController
public class OrderController {
    @Timed(value = "order.api.duration",
           description = "Order API duration",
           percentiles = {0.5, 0.95, 0.99})
    @PostMapping("/orders")
    public Order create(@RequestBody OrderDTO dto) {
        return orderService.createOrder(dto);
    }
}
```

**多维度标签（cardinality 控制）**：

```java
// 反例：高基数标签（不要这么做）
Counter.builder("order.created")
    .tag("userId", dto.getUserId())    // 100 万用户 = 100 万时序！
    .register(registry);
// 标签爆炸：Prometheus 卡死

// 正确：低基数标签
Counter.builder("order.created")
    .tag("type", dto.getType())        // normal / vip / enterprise（几种）
    .tag("channel", dto.getChannel())  // web / app / miniapp（几种）
    .tag("status", "success")          // success / failed（几种）
    .register(registry);
// 时序数 = type × channel × status 几十种，可控
```

## 三、实战层：RED + USE 指标体系

**RED 黄金信号（服务视角）**：

```yaml
# application.yml（Spring Boot 自动暴露）
management:
  metrics:
    web:
      server:
        request:
          autotime:
            enabled: true              # 自动给 HTTP 接口加 Timer

# Prometheus 查询
# Rate：QPS
rate(http_server_requests_seconds_count{app="order-service"}[1m])

# Errors：错误率
rate(http_server_requests_seconds_count{app="order-service", status=~"5.."}[1m])
  / rate(http_server_requests_seconds_count{app="order-service"}[1m])

# Duration：P99 延迟
histogram_quantile(0.99,
  rate(http_server_requests_seconds_bucket{app="order-service"}[5m])
)
```

**USE 黄金信号（资源视角）**：

```yaml
# Spring Boot 自带的 JVM / 系统指标
# Utilization：CPU/内存利用率
process_cpu_usage                      # CPU 利用率
jvm_memory_used_bytes{area="heap"}     # 堆内存使用
jvm_memory_used_bytes{area="nonheap"}  # 非堆

# Saturation：饱和度
hikaricp_connections_active            # HikariCP 活跃连接
hikaricp_connections_pending           # 等待连接数
executor_active_threads{name="cpuExecutor"}  # 线程池活跃
executor_queue_remaining_tasks{name="cpuExecutor"}  # 队列大小

# Errors：错误
rate(jvm_gc_pause_seconds_count[1m])  # GC 频率
jvm_threads_states_threads{state="blocked"}  # 阻塞线程数
```

**业务核心指标**：

```java
// 自定义业务指标
@Service
public class MetricsService {
    private final Counter orderCreated;
    private final Counter paymentSuccess;
    private final Counter paymentFailed;
    private final Gauge activeUsers;

    public MetricsService(MeterRegistry registry) {
        orderCreated = Counter.builder("business.order.created")
            .tag("app", "order-service")
            .register(registry);

        paymentSuccess = Counter.builder("business.payment.success")
            .register(registry);

        paymentFailed = Counter.builder("business.payment.failed")
            .tag("reason", "unknown")
            .register(registry);

        activeUsers = Gauge.builder("business.active.users",
                () -> userSessionManager.getActiveCount())
            .register(registry);
    }
}

// Prometheus 业务告警
# 支付成功率 < 95%
rate(business_payment_success_total[5m])
  / (rate(business_payment_success_total[5m]) + rate(business_payment_failed_total[5m]))
  < 0.95
```

**SLO 设计**：

```yaml
# SLO 定义
slo:
  availability:
    target: 99.9%              # 成功率
    window: 30d
    sli: |
      1 - (
        rate(http_server_requests_seconds_count{status=~"5.."}[30d])
        / rate(http_server_requests_seconds_count[30d])
      )
  
  latency:
    target: 99%                # 99% 请求 P99 < 200ms
    threshold: 200ms
    window: 30d
    sli: |
      histogram_quantile(0.99,
        rate(http_server_requests_seconds_bucket{le="0.2"}[30d])
      )
      / histogram_quantile(0.99,
        rate(http_server_requests_seconds_bucket[30d])
      )
```

## 四、底层本质：为什么是 RED + USE

回到第一性：**为什么不是"采集所有指标"，要按 RED + USE 框架选？**

- **采集成本**：每个指标 = 一条时序数据，Prometheus 存储有上限（百万时序就吃力）。无脑采集导致"指标通胀"——几百个指标没人看，告警天天误报。
- **指标要回答问题**：RED 回答"服务有没有问题"（用户视角），USE 回答"资源够不够用"（系统视角）。业务指标回答"业务正常吗"。每个指标都要对应一个"问题"，没有问题的指标删掉。
- **Histogram 优于 Summary 的本质**：
  - Summary 在客户端算分位，每个实例独立——10 个实例每个 P99=50ms，但合并 P99 可能 200ms（长尾在某个实例）。Summary 看不到这个。
  - Histogram 在服务端聚合，把所有实例的 bucket 合并算分位——全局 P99 准确。代价是服务端计算量大（Prometheus）。
  - 所以生产用 Histogram，Summary 只在单实例场景（如 CLI 工具）用。

**SLO 倒推采集**：
- 先定 SLO（如 P99 < 200ms，错误率 < 0.1%）
- 再定 SLI（指标公式）
- 再设计采集（HTTP Histogram + 错误 Counter）
- 最后建告警（基于 SLO 违反）

**为什么 Micrometer 是门面模式**：
- Spring Boot 默认用 Micrometer 作为指标门面
- 应用代码只调 Micrometer API（Counter.increment、Timer.record）
- MeterRegistry 决定推送到哪个监控系统（Prometheus / Datadog / NewRelic）
- 换监控系统只改配置（spring.metrics.export.prometheus.enabled），不改代码

## 五、AI 架构师加问：5 个

1. **AI 推理服务的指标体系怎么设计？**
   RED：推理 QPS、推理错误率、推理 P99 延迟。USE：GPU 利用率、显存占用、模型加载时间。业务：tokens_per_second（吞吐）、cost_per_request（成本）、cache_hit_rate（缓存命中）。SLO：P99 < 1s、错误率 < 1%、tokens_per_second > 100。

2. **AI 能自动推荐指标体系吗？**
   AI 分析服务的业务特征（API 列表、依赖、关键流程），按 RED + USE 框架推荐基础指标 + 业务专属指标。结合历史事故库（这个业务常出什么问题），补充专项指标（如"曾发生 OOM，加 memory 监控"）。AI 输出指标清单 + 告警规则，人工 review。

3. **大模型推理的 tokens_per_second 指标怎么设计？**
   Gauge 类型，每次推理更新。tag：model_version（不同模型不同吞吐）、batch_size、gpu_type。配合 Histogram 看 tokens/s 的分布（P50/P99）。SLO：P50 > 50 tokens/s（用户体验阈值）。

4. **AI Agent 的 tool_call 指标怎么记录？**
   Counter：tool_call_total（按 tool_name/status 打标签，区分成功失败）。Timer：tool_call_duration（按 tool_name 打标签，看哪个工具最慢）。Gauge：active_tool_calls（当前进行中的工具调用数，防止 N+1 调用拖垮）。配合 traceId 关联，AI 分析时能下钻到具体工具调用。

5. **AI 怎么做指标异常检测？**
   AI 学习历史指标模式（正常基线），实时检测异常：QPS 突变（环比/同比）、错误率突升、P99 抖动、长尾分布异常。比固定阈值告警更智能（适应业务季节性，如大促期间 QPS 高是正常的）。AI 给异常分级（P0/P1/P2）和归因（关联哪些指标一起异常），人工确认。

## 六、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"门面模式、四类型、RED+USE、Histogram 优于 Summary、低基数标签"**。

- **门面**：Micrometer = SLF4J for metrics，多后端（Prometheus/Datadog/...）
- **四类型**：Counter（递增）/Gauge（瞬时）/Histogram（分布）/Timer（延迟+计数）
- **RED**：Rate（QPS）/Errors（错误率）/Duration（P99）
- **USE**：Utilization（利用率）/Saturation（饱和度）/Errors（错误）
- **Histogram > Summary**：服务端聚合分位，跨实例合并
- **低基数标签**：标签值有限集合（不用 userId/orderId 当标签）
- **SLO 倒推**：先定 SLO，再设计 SLI 指标

### 拟人化理解

把 Micrometer 想成**汽车仪表盘的统一驱动**。Counter 是里程表（单调递增）、Gauge 是油量表（瞬时值，可增可减）、Histogram 是转速分布表（统计分布）、Timer 是单圈计时器（耗时 + 计数）。Micrometer 不论装在特斯拉还是比亚迪（Prometheus / Datadog），仪表盘外观一致，司机（业务代码）不用关心底层实现。RED 是"速度表 + 警告灯 + 油耗"（服务视角），USE 是"发动机温度 + 油量 + 故障灯"（资源视角）。

### 面试现场 60 秒回答

> Micrometer 是 Spring Boot 的指标门面（SLF4J 模式），四种类型：Counter（递增）、Gauge（瞬时值）、Histogram（分布）、Timer（延迟+计数）。设计指标体系用 RED + USE 框架：RED（服务视角）= Rate/QPS + Errors/错误率 + Duration/P99 延迟，回答"服务有没有问题"；USE（资源视角）= Utilization/CPU 内存 + Saturation/连接池线程池 + Errors/GC OOM，回答"资源够不够"。加业务核心指标（订单量、支付成功率）。Histogram 优于 Summary（服务端聚合分位，跨实例合并算 P99）。低基数标签（标签值有限集合，不用 userId/orderId 当标签防爆）。SLO 倒推：先定 SLO（如 P99 < 200ms），再设计指标。告警准确率 > 95%。

### 反问面试官

> 贵司指标栈是 Prometheus + Grafana 吗？SLO 定了吗？指标数量级多少（万级、十万级）？这决定我聊指标体系设计还是高基数治理。

## 七、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 已经有日志了，为什么还要指标？ | 指标是聚合数字（QPS/P99），低成本全量采集，适合告警和趋势分析。日志是离散事件，昂贵，适合具体排查。告警靠指标，定位靠日志。两者分工 |
| 证据追问 | 怎么证明指标体系设计合理？ | 告警准确率（误报 < 5%）、MTTR（平均定位时间 < 10 分钟）、指标使用率（> 80% 指标有人看）、SLO 覆盖率（核心服务 100% 有 SLO） |
| 边界追问 | 指标能解决所有监控吗？ | 不能。业务逻辑 bug 看代码 + 日志；JVM 问题看 dump + JFR；网络问题抓包；性能问题 profile。指标主要解决"大盘监控 + 告警" |
| 反例追问 | 什么场景不要上指标？ | 单次脚本、CLI 工具、内部小工具、研发阶段（用日志即可）。指标有采集成本（Prometheus 存储 + 查询），ROI 低不要上 |
| 风险追问 | 指标体系最大风险？ | ① 高基数标签导致 Prometheus 卡死（userId 当标签）；② 指标通胀（几百指标没人看）；③ 告警疲劳（误报多被忽视）。治法：低基数、SLO 倒推、告警分级 |
| 验证追问 | 怎么证明 SLO 真的有用？ | SLO 违反触发告警 → 工程师响应 → 修复；SLO 达成率统计（如本月可用性 99.95%）；SLO 调整频率（按业务调整，不是一成不变） |
| 沉淀追问 | 团队指标规范沉淀什么？ | 指标命名规范（domain_action_outcome_unit）、RED + USE 必采清单、低基数标签规则、SLO 模板、Grafana 大盘模板、告警规则 SOP |

### 现场对话示例

**面试官**：Micrometer 和直接用 Prometheus client 区别？

**候选人**：Micrometer 是门面（SLF4J 模式），底层可对接 Prometheus / Datadog / NewRelic。代码用 Micrometer API（Counter/Gauge/Timer），换监控系统只改配置不改代码。直接用 Prometheus client 锁死了 Prometheus。生产推荐 Micrometer——灵活、生态成熟（Spring Boot 默认）。

**面试官**：Histogram 为什么比 Summary 好？

**候选人**：两个原因。第一，Histogram 在服务端（Prometheus）聚合分位，多个实例可合并算全局 P99；Summary 在客户端算分位，每个实例独立 P99，跨实例无法合并。第二，Histogram 的 bucket 是可后处理聚合的（histogram_quantile 函数），Summary 的 quantile 是固定的（客户端配置）。生产场景 10 个实例每个 P99=50ms，但合并 P99 可能 200ms（长尾在某实例）——只有 Histogram 能看到这个。

**面试官**：高基数标签为什么是问题？

**候选人**：Prometheus 时序数据库按标签组合存储——每个标签值组合 = 一条时序。如果用 userId 当标签，100 万用户 × 10 个其他标签 = 千万条时序，Prometheus 内存爆炸、查询慢。所以标签必须是有限集合（如 type=NORMAL/VIP、status=success/failed），基数控制在几十种内。userId 这种业务数据放日志查，不放指标。

## 常见考点

1. **Micrometer 是什么？**——Spring Boot 的指标门面（SLF4J 模式），多后端对接（Prometheus/Datadog/NewRelic）。
2. **四种指标类型？**——Counter（递增）、Gauge（瞬时值）、Histogram（分布）、Timer（延迟+计数）。生产推荐 Histogram 和 Timer。
3. **Histogram 和 Summary 区别？**——Histogram 服务端聚合分位，跨实例可合并；Summary 客户端算分位，跨实例无法合并。生产用 Histogram。
4. **RED 和 USE 黄金信号？**——RED：Rate/Errors/Duration（服务视角）；USE：Utilization/Saturation/Errors（资源视角）。
5. **高基数标签怎么避免？**——标签值必须是有限集合（如 type/status/channel），不用 userId/orderId 当标签。每个标签组合 = 一条时序。

## 结构化回答

**30 秒电梯演讲：** Micrometer 是 Spring Boot 的指标门面（类似 SLF4J 之于日志），定义一套维度（name + tags + 数值）的指标模型，底层可对接 Prometheus / Datadog / NewRelic / CloudWatch。设计指标体系的核心是少而准——RED（Rate/Errors/Duration）+ USE（Utilization/Saturation/Errors）+ 业务核心指标（如订单量、支付成功率），用 SLO 倒推采集什么，不是什么都能采

**展开框架：**
1. **Micrometer 是** — Micrometer 是指标门面（SLF4J 模式），支持多后端
2. **四种指标类型** — Counter（递增）/Gauge（瞬时值）/Histogram（分布）/Timer（延迟+计数）
3. **RED 黄金信号** — Rate（QPS）/Errors（错误率）/Duration（P99 延迟）

**收尾：** 以上是我的整体思路。您想继续深入聊——Histogram 和 Summary 区别？


## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：Micrometer 指标体系如何设计 | "这题核心是——Micrometer 是 Spring Boot 的指标门面（类似 SLF4J 之于日志），定义……" | 开场钩子 |
| 0:15 | 像汽车仪表盘：油量表（Gauge类比图 | "打个比方：像汽车仪表盘：油量表（Gauge。" | 核心类比 |
| 0:40 | Micrometer 是示意/对比图 | "Micrometer 是指标门面（SLF4J 模式），支持多后端" | Micrometer 是要点 |
| 1:05 | 四种指标类型示意/对比图 | "Counter（递增）/Gauge（瞬时值）/Histogram（分布）/Timer（延迟+计数）" | 四种指标类型要点 |
| 1:55 | 总结卡 | "记住：Micrometer 是指标。下期见。" | 收尾 |
