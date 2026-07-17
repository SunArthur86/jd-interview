---
id: pdd-ai-030
difficulty: L4
category: pdd-ai
subcategory: 可观测性
tags:
- 拼多多
- AI 中台
- 可观测性
- 稳定性治理
- 跨团队
- Metrics/Logs/Traces
feynman:
  essence: 可观测性是"系统的眼睛"——Metrics（指标）+ Logs（日志）+ Traces（链路）三件套让系统透明；跨团队治理要统一标准、共享平台、对齐 SLO。
  analogy: 像城市管理——监控摄像头（Metrics）、事件记录仪（Logs）、巡逻路径（Traces），加上统一指挥中心（治理）才能管好城市。
  first_principle: 复杂系统看不见就是黑盒，必须可观测才能诊断/优化/治理；多团队协作要统一标准避免信息孤岛。
  key_points:
  - 三件套：Metrics/Logs/Traces
  - SLO/SLI/错误预算
  - 全链路追踪（TraceId 透传）
  - 治理：统一标准 + 共享平台 + 跨团队对齐
  - LLM 特殊：效果监控（幻觉率/满意度）
first_principle:
  problem: 复杂系统跨团队怎么可观测、可诊断、可治理？
  axioms:
  - 看不见就无法管理
  - 多团队要统一标准
  - SLO 是共同语言
  rebuild: 可观测性平台（三件套 + SLO + 全链路 + 统一治理）。
follow_up:
  - Metrics 和日志区别？——Metrics 聚合数值（QPS/RT），日志详细事件
  - 全链路追踪怎么做？——TraceId 透传（HTTP/gRPC/Kafka/MQ）
  - 跨团队怎么对齐？——SLO + 错误预算 + 联合复盘
memory_points:
  - 三件套：Metrics/Logs/Traces
  - SLO/SLI/错误预算
  - TraceId 全链路透传
  - 统一标准 + 共享平台
---

# 【拼多多 AI 中台】可观测性和跨团队治理怎么做？

> JD 依据："可观测性、稳定性治理、跨团队"。

## 一、可观测性三件套

| 维度 | 是什么 | 工具 | 用途 |
|------|--------|------|------|
| **Metrics** | 聚合数值（时序） | Prometheus + Grafana | 监控/告警 |
| **Logs** | 详细事件日志 | ELK / Loki | 排查根因 |
| **Traces** | 调用链 | Jaeger / SkyWalking | 跨服务定位 |

补充：
- **Profiling**：性能剖析（PyTorch Profiler/Java JFR）
- **Event**：变更事件（发布/扩缩/告警）

## 二、Metrics

### 黄金信号（Google SRE）
```
4 个关键指标：
- 延迟（Latency）：P50/P95/P99
- 流量（Traffic）：QPS/并发
- 错误（Errors）：5xx/超时/异常
- 饱和度（Saturation）：CPU/GPU/内存/显存

LLM 补充：
- 首 token 延迟（TTFT）
- 每 token 延迟（TPOT）
- 显存利用率
- KV Cache 占用
- 批次大小
```

### Prometheus 监控
```java
// 业务埋点
@RequestMapping("/chat")
public String chat(String prompt) {
    Timer.Sample sample = Timer.start();
    try {
        String result = llmClient.invoke(prompt);
        chatCounter.increment();
        return result;
    } catch (Exception e) {
        errorCounter.increment();
        throw e;
    } finally {
        sample.stop(chatLatency);
    }
}
```

### Grafana 大盘
```
- 总览（QPS/RT/错误率）
- 模型维度（按 model_id）
- GPU 维度（利用率/显存）
- 实例维度（每 Pod）
- 用户维度（按 uid/IP）
```

## 三、Logs

### 结构化日志
```java
log.info("llm_inference",
    "request_id", requestId,
    "uid", uid,
    "model", model,
    "prompt_tokens", promptTokens,
    "output_tokens", outputTokens,
    "latency_ms", latency,
    "status", "success"
);
```

### 关键字段
```
- request_id/trace_id：关联请求
- uid：用户
- model：模型版本
- prompt_tokens/output_tokens：成本核算
- latency：性能
- status：成功/失败
- error_type：错误分类
```

### 日志分级
```
ERROR：错误（影响业务）
WARN：警告（可能有问题）
INFO：关键事件（请求/上线/扩缩）
DEBUG：调试（生产默认关）
```

## 四、Traces（全链路追踪）

```
用户请求 → 网关 → 推理服务 → Triton → 返回
              ↓
         生成 trace_id
              ↓
         每跳上报 span（带 parent_id）

最终拼出完整调用链：
[trace_id=abc]
├ span1: gateway (5ms)
├ span2: llm-service (2ms)
│   ├ span3: feat-query (1ms)
│   ├ span4: triton-invoke (1500ms)
│   └ span5: post-process (2ms)
└ span6: response (1ms)

总耗时 1511ms，瓶颈在 triton-invoke
```

### TraceId 透传
```java
// 网关生成 trace_id
String traceId = UUID.randomUUID().toString();
MDC.put("trace_id", traceId);

// 跨服务透传（HTTP/gRPC header）
RequestEntity request = RequestEntity.post(url)
    .header("X-Trace-Id", traceId)
    .body(payload);

// 跨 Kafka 透传
ProducerRecord<String, String> rec = new ProducerRecord<>(topic, value);
rec.headers().add("trace_id", traceId.getBytes());
```

### OpenTelemetry（统一标准）
```
语言无关、可观测性后端无关的标准
- Trace：OpenTelemetry SDK
- Metrics：OpenTelemetry SDK
- Logs：OpenTelemetry Logs（发展中）

接入：业务方加 SDK，自动埋点
```

## 五、SLO/SLI/错误预算

### 定义
```
SLI（Service Level Indicator）：指标
  - 例：成功请求比例 / P99 延迟

SLO（Service Level Objective）：目标
  - 例：99.9% 请求成功 / P99 < 2s

SLA（Service Level Agreement）：合同（对外承诺）
  - 例：99.5%（违例赔偿）

错误预算（Error Budget）：
  - 100% - SLO = 错误预算
  - 例：99.9% SLO → 月错误预算 = 43 分钟
  - 用完暂停发版（保稳定性）
```

### SLO 实践
```yaml
service: llm-inference
slo:
  - name: availability
    sli: successful_requests / total_requests
    target: 0.999
    window: 28d
  - name: latency
    sli: p99_latency
    target: 2000ms
    window: 28d
error_budget:
  availability: 43min/月
  latency: 43min/月
```

### 错误预算的纪律
```
预算内：随便发版（鼓励创新）
预算耗尽：暂停发版（保稳定）
预算超额：必须治理（找根因）
```

## 六、LLM 特殊可观测性

### 性能
```
- TTFT（首 token 延迟）：用户体验关键
- TPOT（每 token 延迟）：吞吐关键
- GPU 利用率
- 显存占用
- KV Cache 占用
- batch size
```

### 效果（业务）
```
- 幻觉率（人工标注 + 自动检测）
- 满意度（用户反馈/点踩率）
- 任务完成率（如客服问题解决率）
- 安全合规（敏感词/违规率）
```

### 成本
```
- 单次推理成本（GPU 时 × 利用率）
- token 单价
- 缓存命中率
- 量化前后对比
```

### 模型漂移
```
- 输入分布漂移（用户输入变化）
- 输出分布漂移（模型行为变化）
- 数据漂移（特征变化）
```

## 七、跨团队治理

### 问题
```
团队 A：用 ELK
团队 B：用 Prometheus
团队 C：用 SkyWalking
→ 信息孤岛，故障排查跨团队难
```

### 治理方案

#### 1. 统一标准
```
- 可观测性平台（公司级）：统一 Metrics/Logs/Traces 后端
- 命名规范：metric_name / log_field / trace_tag 统一
- 接入规范：业务方统一用 OpenTelemetry SDK
- 数据格式：JSON / Protobuf 标准
```

#### 2. 统一 TraceId
```
所有服务（无论团队）共享同一 trace_id
跨服务/跨 MQ/跨 Kafka 透传
故障排查时一键拉出全链路
```

#### 3. SLO 对齐
```
跨团队 SLO 联合定义：
  - 推理服务 SLO：99.9% 可用
  - 特征服务 SLO：99.95% 可用
  - 上游业务 SLO：99% 可用
  - 联合满足用户体验

错误预算跨团队共享：
  - 上游错误预算耗尽 → 下游也受影响
  - 联合复盘 + 治理
```

#### 4. 联合值班与复盘
```
- 故障联合值班（涉及多团队时）
- 联合 Postmortem（不甩锅，找根因）
- 改进措施跟踪
```

#### 5. 共享大盘
```
公司级大屏：
- 全链路 SLO 状态
- 错误预算消耗
- 关键业务指标（GMV/CTR）
- 故障状态

各团队都能看到全局，避免只看自己一亩三分地
```

## 八、拼多多实战

```
可观测性平台：
- Metrics：自研基于 Prometheus（百万级 metric）
- Logs：ELK + 自研日志平台
- Traces：SkyWalking + 自研增强
- 大盘：Grafana 统一

LLM 监控：
- 性能：TTFT/TPOT/GPU/显存
- 效果：幻觉率/满意度（业务回传）
- 成本：token 单价/GPU 时
- 漂移：分布监控

跨团队治理：
- 统一 TraceId（X-Pdd-Trace-Id）
- 联合 SLO（业务/中台/基础设施）
- 月度稳定性会议
- 故障联合复盘
```

## 九、底层本质

可观测性本质是**"让复杂系统透明可诊断"**——Metrics 看整体健康，Logs 查具体事件，Traces 定位跨服务根因。SLO/错误预算是稳定性治理的共同语言。跨团队治理关键是统一标准（TraceId/SDK/命名）+ 共享平台 + SLO 对齐。LLM 场景还要监控效果（幻觉/满意度）和成本，是传统可观测性的延伸。

## 常见考点

1. **TraceId 怎么透传**？——HTTP header / gRPC metadata / Kafka header / ThreadLocal（异步用 TaskDecorator 拷贝）。
2. **SLO 怎么定**？——基于历史数据 + 用户期望 + 业务关键性，先粗后细，持续调整。
3. **日志和 Metrics 关系**？——日志详细但查询慢/贵；Metrics 聚合但快/便宜；日志可生成 Metrics（如统计错误数）。

## 苏格拉底式面试追问

> 这组追问不背答案，模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：可观测性是 Metrics + Logs + Traces 三件套。但 LLM 推理和传统 Web 服务的可观测性需求不同。LLM 场景的"可观测性"要额外关注什么？为什么要单独讨论 LLM 的？**

LLM 的可观测性要加"效果维度"，传统 Web 只有"性能维度"。第一，**传统 Web 的指标**——QPS、延迟（P99）、错误率、CPU/内存利用率，这些是"系统健康度"指标。Web 服务的"正确性"是确定的（HTTP 200 + 正确 JSON 就是正确）。第二，**LLM 的特殊指标**——（1）**效果指标**：幻觉率（回答是否事实正确）、满意度（用户点赞/点踩）、任务完成率（用户问题是否解决）、引用准确率（RAG 的引用是否对）。这些是"模型质量"指标，传统 Web 没有。（2）**成本指标**：token 消耗（每请求的 prompt/completion token 数）、GPU 时成本（每次推理的 GPU 开销）。LLM 推理是"按 token 计费"的，要监控"每次调用的成本"。（3）**安全指标**：敏感词触发率（输出是否含违禁内容）、Prompt 注入攻击检测率。第三，**为什么重要**——LLM 的"系统健康"（QPS/延迟）可能正常，但"效果"（幻觉率飙升）让用户体验差。只监控性能不监控效果，会发现"系统没挂但用户都在投诉"。LLM 可观测性 = 性能 + 效果 + 成本 + 安全，四维一体。

### 第二层：证据与定位

**Q：客服 LLM 上线后，性能指标都正常（P99 < 500ms、错误率 < 0.1%），但用户投诉"回答不准"。你怎么定位是"模型效果差"还是"某些 case 特别差"？**

用效果监控 + 分群分析定位。第一，**效果监控**——采集 `user_feedback_rate`（点踩率，点踩/总评价），如果点踩率从 5% 升到 15%，说明效果退化。但"点踩率"是"用户主动反馈"，很多用户不点（沉默的差评），所以还要用"抽样标注"（每天抽 100 条回答人工标注准确率）。第二，**分群分析**——把回答按维度拆分：按 query 类型（退款/物流/售后）、按 query 长度（短/中/长）、按用户类型（新老用户）。如果"退款类"的准确率 60%（其他 90%），是退款类效果差（可能是知识库退款文档不全）；如果"长 query"准确率 50%（短 query 90%），是长 query 理解差（模型上下文处理弱）。第三，**TraceId 关联**——把"点踩的 case"通过 TraceId 关联到"具体的推理调用"，看那次调用的输入/输出/RAG 召回，定位是"RAG 没召回正确文档"（检索问题）还是"模型理解错"（模型问题）。第四，**根因**——如果某类 case 集中差，针对性优化（补知识库/调 Prompt/微调）；如果所有 case 都差，是模型能力问题（换更大的模型）。

### 第三层：根因深挖

**Q：你发现"TraceId 在异步链路中断裂"——请求从网关 → Kafka → LLM 推理服务，Kafka 消费时 TraceId 丢了，导致全链路追踪断在 Kafka。怎么解决？**

TraceId 要"主动透传"，不依赖框架自动。第一，**Kafka 的 TraceId 透传**——生产者在发送消息时，把 TraceId 放到 Kafka 消息的 header（`headers.put("trace-id", traceId)`），消费者消费时从 header 取出（`headers.get("trace-id")`），继续传递。Spring Cloud Sleuth/OpenTelemetry 支持 Kafka 的自动透传（配 B3 propagation）。第二，**异步线程的 TraceId**——Java 的 ThreadLocal 存 TraceId，但线程池的线程复用，如果不主动清理/设置，TraceId 会"串"（A 请求的 TraceId 被 B 请求继承）。解法：用 `TaskDecorator`（Spring 的异步任务装饰器），在提交异步任务时拷贝父线程的 TraceId，任务执行前 set、执行后 clear。第三，**跨服务的 TraceId**——HTTP/gRPC 调用时，TraceId 放在 header（`X-B3-TraceId`），下游服务从 header 取。Dubbo 用 `RpcContext.getContext().setAttachment("trace-id", traceId)` 透传。第四，**验证**——在链路追踪系统（Jaeger/Zipkin）看一条完整的 trace，应该从"网关 → Kafka → LLM"一气呵成（一个 TraceId 贯穿）。如果断在某处，是该处的透传没配。拼多多：用 OpenTelemetry 的 auto-instrumentation（自动埋点），覆盖 HTTP/gRPC/Kafka/ThreadLocal，开箱即用透传。

**Q：那为什么不每个请求生成一个"唯一 request_id"，用 request_id 查日志？还要 TraceId 做什么？**

request_id 和 TraceId 的粒度不同。第一，**request_id 是"单次请求"的标识**——用户发一个请求，生成一个 request_id，这个请求的所有日志都带这个 id。但 LLM 服务是多跳的（网关 → 特征查询 → Redis → vLLM），每个服务有自己的日志文件，用 request_id 查要"在每个服务的日志里搜 request_id"，手动关联。第二，**TraceId 是"全链路"的标识**——TraceId 自动透传到所有服务，链路追踪系统（Jaeger）自动聚合"一个 TraceId 下的所有 span（各服务调用）"，可视化展示"网关 5ms → 特征查询 1ms → Redis 0.5ms → vLLM 200ms"的调用树。不用手动搜日志。第三，**TraceId 还有 SpanId（父子关系）**——一个 TraceId 下有多个 Span（每次服务调用一个 Span），Span 之间有父子关系（网关调特征查询是父子），形成调用树。request_id 是"扁平的"（只有 id，没有调用关系），TraceId 是"结构化的"（有调用树）。第四，**生产选择**——两者都要。request_id 用于"业务关联"（把请求和业务数据如订单关联），TraceId 用于"性能分析"（看哪个服务慢）。网关生成 TraceId（全局唯一），同时生成 request_id（业务侧用），两个 id 都透传，日志里都记。排查问题时用 TraceId（看链路），业务关联用 request_id。

### 第四层：方案权衡

**Q：SLO 怎么定？你说 LLM 推理的 SLO 是"TTFT < 500ms + 错误率 < 0.1%"。但这些数字怎么来的？凭什么定 500ms 而不是 200ms 或 1s？**

SLO 要基于"用户期望 + 历史数据 + 业务价值"综合定。第一，**用户期望**——研究表明，LLM 对话的 TTFT < 200ms 时用户"感觉即时"（像打字），TTFT 500ms 时"感觉稍等"，TTFT > 1s 时"感觉卡顿"。客服场景要求"即时感"，SLO 定 TTFT < 500ms（兼顾用户体验和实现成本）。第二，**历史数据**——看过去 30 天的 TTFT 分位数，如果 P95=400ms（95% 的请求 < 400ms），说明系统的"自然性能"是 P95 400ms。SLO 定 P95 < 500ms（略宽松，留 buffer），不要定 P95 < 200ms（系统达不到，频繁违反 SLO）。第三，**错误预算**——SLO 不是"100% 满足"，是"允许一定比例违反"。如 TTFT SLO 是"99% 的请求 < 500ms"（允许 1% 超时）。这 1% 是"错误预算"，用于"创新"（发布新版本可能短暂违反 SLO）。如果 SLO 定太严（99.99%），错误预算耗尽快，团队不敢发布（稳定性拖慢迭代）。第四，**分层 SLO**——核心业务（客服）TTFT < 500ms（严），非核心（内部工具）TTFT < 2s（松）。按业务重要性分级，资源精准投放。拼多多 LLM：客服 TTFT P95 < 500ms、错误率 < 0.1%（SLO 99.9%）；内部工具 TTFT P95 < 2s、错误率 < 1%（SLO 99%）。

**Q：那为什么不把 SLO 定到"完美"（TTFT < 100ms + 错误率 0%）？追求极致不是更好吗？**

完美 SLO 的成本指数级增长，收益边际递减。第一，**成本指数级**——从 TTFT 500ms 优化到 200ms，可能要"换 H100（GPU 算力翻倍）+ PD 分离 + 前缀缓存"，成本翻 3 倍。从 200ms 到 100ms，要"TRT-LLM + FP8 量化 + 投机解码"，成本再翻 2 倍。100ms 到 50ms，几乎不可能（物理极限）。每提升一点，成本翻倍。第二，**收益递减**——TTFT 500ms → 200ms，用户感知提升大（从"稍等"到"即时"）。200ms → 100ms，用户感知提升小（都感觉"即时"）。100ms → 50ms，用户无感。第三，**错误率同理**——错误率从 1% 降到 0.1%，要"加冗余 + 容错"（成本适中）。0.1% → 0.01%，要"多活 + 全冗余"（成本翻倍）。0.01% → 0，几乎不可能（物理故障总有）。第四，**生产哲学**——SLO 是"用户满意度的下限"，不是"技术极限"。定 SLO 的目标是"用最小成本达到用户满意"，不是"追求完美"。客服 LLM 的 SLO 定 TTFT < 500ms（用户满意），投入 10 卡 H100；定 < 100ms（用户无额外感知），要投入 50 卡（5 倍成本换微小感知提升，不划算）。正确的 SLO 是"性价比最优点"，不是"最低延迟"。

### 第五层：验证与沉淀

**Q：你怎么证明"可观测性建设"提升了系统的"可诊断性"（故障定位更快）？**

三个指标对比。第一，**MTTD（Mean Time To Detect，平均发现时间）**——优化前（监控不全）故障发生后 10 分钟才告警（用户已经投诉），优化后（监控完备）30 秒告警（用户还没投诉就发现）。MTTD 从 10 分钟降到 30 秒。第二，**MTTI（Mean Time To Identify，平均定位时间）**——优化前（无 Trace）故障后要"翻 5 个服务的日志"手动关联，定位 30 分钟。优化后（全链路追踪）Jaeger 一眼看到"Redis 慢"，定位 2 分钟。MTTI 从 30 分钟降到 2 分钟。第三，**MTTR（Mean Time To Restore，平均恢复时间）**——优化前（无预案）定位后还要"想方案 + 手动执行"，恢复 1 小时。优化后（预案自动化）定位后一键执行预案，恢复 5 分钟。MTTR 从 1 小时降到 5 分钟。三个指标（MTTD + MTTI + MTTR）一致下降，证明可观测性建设有效。监控 `incident_total_downtime`（故障总宕机时间），优化前月均 2 小时，优化后月均 10 分钟。

**Q：可观测性的经验怎么沉淀，让新服务/新团队快速达到"可观测"？**

三件事。第一，**标准化埋点**——公司级的可观测性 SDK（基于 OpenTelemetry），新服务引入 SDK 就自动埋点（HTTP/gRPC/Kafka/Redis 都覆盖），不手动写埋点代码。SDK 统一 Metrics 命名规范（`pdd_llm_inference_latency_p99`，带业务前缀），便于跨服务查询。第二，**监控模板**——按服务类型（LLM 推理/Web/搜索）预设监控 dashboard（QPS/延迟/错误率/GPU 利用率/效果指标），新服务套模板，10 分钟搭好监控。第三，**SLO 即代码**——用 Sloth/Slothrod 把 SLO 定义成代码（YAML），CI/CD 自动部署，SLO 违反自动告警。新服务定义 SLO 后，监控/告警/错误预算自动生成，不手动配。可观测性是"系统的基础设施"，要像"水电"一样开箱即用，不是"每个服务从零搭"。目标：新服务上线 1 小时内达到"可观测"，不依赖专人配置。

## 结构化回答




**30 秒电梯演讲：** 像城市管理——监控摄像头（Metrics）、事件记录仪（Logs）、巡逻路径（Traces），加上统一指挥中心（治理）才能管好城市。

**展开框架：**
1. **三件套** — Metrics/Logs/Traces
2. **SLO** — SLO/SLI/错误预算
3. **TraceId** — 全链路追踪（TraceId 透传）

**收尾：** Metrics 和日志区别？




## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：可观测性和跨团队治理怎么做？ | 今天聊「可观测性和跨团队治理怎么做？」。一句话：可观测性是"系统的眼睛" | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：三件套：Metrics/Logs/Traces | 核心概念 |
| 0:51 | 红色警示框 + 反例代码 | 要点是：SLO/SLI/错误预算 | 能力拆解 |
| 1:30 | 流程图：箭头串联各环节 | 要点是：TraceId 全链路透传 | 关键机制 |
| 2:09 | 代码片段 + 注释高亮 | 要点是：统一标准 + 共享平台 | 实战要点 |
| 3:00 | 总结卡 + 下期预告 | 记住这些核心点就够了。下期我们接着聊——Metrics 和日志区别？。 | 收尾 |
