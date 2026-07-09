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
