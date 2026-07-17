---
id: pdd-ai-022
difficulty: L4
category: pdd-ai
subcategory: 模型服务
tags:
- 拼多多
- AI 中台
- 模型服务平台
- 推理网关
- 路由
- 弹性
feynman:
  essence: 模型服务平台是"推理网关 + 路由 + 多后端 + 弹性 + 监控"的一体化系统，业务方传模型即可服务化，平台保证性能/稳定/低成本。
  analogy: 像 5G 基站——手机（业务）发请求，基站（网关）路由到最优信号塔（推理实例），流量大时自动开新塔（弹性扩容）。
  first_principle: 模型推理涉及网关/路由/调度/弹性/监控等多环节，需要平台整合让业务方零负担上线。
  key_points:
  - 推理网关：鉴权/限流/路由/AB/灰度
  - 路由策略：轮询/最少请求/GPU 利用率/模型亲和
  - 多后端：Triton/vLLM/TRT-LLM
  - 弹性：基于 QPS/GPU 利用率/队列长度
  - 监控：延迟/QPS/错误率/GPU/成本
first_principle:
  problem: 怎么把多模型/多后端/动态流量统一服务化？
  axioms:
  - 模型多样（CV/NLP/LLM）
  - 后端多样（Triton/vLLM/TRT-LLM）
  - 流量动态需弹性
  rebuild: 模型服务平台（网关 + 路由 + 多后端 + 弹性 + 监控）。
follow_up:
  - 推理网关和 API 网关区别？——推理网关额外管模型版本/路由/批次/GPU 调度
  - 怎么选路由策略？——LLM 用 KV 命中率/GPU 利用率，CV 用最少请求
  - 怎么降成本？——量化 + batching + 弹性 + 多模型共享 GPU
memory_points:
  - 网关：鉴权/限流/路由/AB/灰度
  - 路由：GPU 利用率/最少请求/模型亲和
  - 后端：Triton/vLLM/TRT-LLM
  - 弹性：QPS/利用率/队列
---

# 【拼多多 AI 中台】模型服务平台架构怎么设计？

> JD 依据："图像/语音/NLP 模型服务、Java + RPC + 微服务"。

## 一、平台目标

**业务方诉求**：
- 传模型（.pt/.safetensors）→ 自动服务化
- 高性能（低延迟/高吞吐）
- 稳定（高可用/不丢请求）
- 低成本（GPU 利用率高）
- 可观测（延迟/错误/成本可见）

**平台职责**：网关 + 路由 + 多后端 + 弹性 + 监控。

## 二、整体架构

```
┌────────────────────────────────────────────────────┐
│ 业务方（推荐/搜索/客服/...）                       │
└────────────────────┬───────────────────────────────┘
                     │ HTTP/gRPC
┌────────────────────▼───────────────────────────────┐
│ 推理网关（Java/Spring Cloud Gateway）              │
│ - 鉴权/限流/熔断                                   │
│ - 模型路由（按 model_id/version）                  │
│ - A/B 实验分流                                     │
│ - 灰度发布                                        │
│ - 协议转换                                        │
│ - 请求/响应日志                                    │
└────────┬───────────────┬───────────────┬──────────┘
         │               │               │
┌────────▼─────┐ ┌───────▼──────┐ ┌──────▼────────┐
│ Triton 集群  │ │ vLLM 集群     │ │ TRT-LLM 集群   │
│ CV/NLP/推荐  │ │ LLM 通用      │ │ LLM 极致       │
└────────┬─────┘ └───────┬──────┘ └──────┬────────┘
         │               │               │
         └───────────────┼───────────────┘
                         │
┌────────────────────────▼───────────────────────────┐
│ 调度层（K8s + GPU Operator）                       │
│ - Pod 调度（GPU 亲和）                             │
│ - 弹性扩缩（HPA/VPA/自定义指标）                   │
│ - 资源池化                                        │
└────────────────────────────────────────────────────┘

横切：
- 模型注册中心（MLflow）：模型元数据/版本/部署
- 监控（Prometheus）：延迟/QPS/错误/GPU 利用率
- 日志（ELK）：推理日志/异常 trace
- 配置（Nacos）：模型路由表/灰度策略
```

## 三、推理网关设计

### 职责
```
1. 鉴权：API Key/Token 校验
2. 限流：按 model_id/uid/IP 维度
3. 熔断：错误率/RT 阈值触发
4. 路由：按模型 ID + 版本选后端
5. AB 实验：按 uid 分流到不同模型版本
6. 灰度：新版本 5%→20%→100%
7. 协议转换：HTTP ↔ gRPC ↔ Triton 协议
8. 日志：请求/响应/异常
9. 缓存：相同请求结果缓存
```

### 实现（Spring Cloud Gateway）
```java
@Component
public class ModelRoutePredicate extends AbstractRoutePredicateFactory<Config> {
    public boolean apply(ServerWebExchange exchange) {
        String modelId = exchange.getRequest().getHeaders().getFirst("X-Model");
        String version = routeTable.getActiveVersion(modelId);  // 从配置中心读
        String variant = abTest.assign(uid);                     // AB 分流
        return routeToBackend(modelId, version, variant);
    }
}
```

## 四、路由策略

| 策略 | 适用 | 实现 |
|------|------|------|
| 轮询 | 通用 | Round Robin |
| 最少请求 | 异构负载 | Least Connections |
| 加权 | 性能差异 | Weighted Random |
| **GPU 利用率** | LLM | 选利用率低的实例 |
| **模型亲和** | 共享 GPU | 路由到已加载模型的实例 |
| **KV 命中** | LLM PD 分离 | 路由到 KV Cache 命中的 Decode 实例 |
| 地理位置 | 低延迟 | 就近路由 |

**LLM 路由特殊**：
- 考虑 KV Cache 命中率（共享 prefix）
- 考虑 GPU 显存（OOM 风险）
- 考虑 batch 队列长度

## 五、多后端抽象

```java
public interface InferenceBackend {
    PredictResponse invoke(String modelId, String version, PredictRequest req);
    boolean supports(String modelType);  // CV/NLP/LLM
}

public class TritonBackend implements InferenceBackend { ... }
public class VllmBackend implements InferenceBackend { ... }
public class TrtLlmBackend implements InferenceBackend { ... }

// 网关层按模型类型分发
public PredictResponse invoke(String modelId, PredictRequest req) {
    ModelMeta meta = registry.get(modelId);
    InferenceBackend backend = backends.stream()
        .filter(b -> b.supports(meta.getType()))
        .findFirst().orElseThrow();
    return backend.invoke(modelId, meta.getVersion(), req);
}
```

## 六、弹性扩缩

### 触发指标
```
- QPS（业务流量）
- GPU 利用率（>80% 扩容）
- 队列长度（推理请求积压）
- P99 延迟（SLO 违规）
- 显存利用率（OOM 风险）
```

### K8s HPA
```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: llm-service
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: llm-vllm
  minReplicas: 3
  maxReplicas: 50
  metrics:
  - type: Pods
    pods:
      metric:
        name: gpu_utilization
      target:
        type: AverageValue
        averageValue: "80"
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
```

### GPU 弹性（难点）
- GPU Pod 启动慢（加载模型几分钟）
- **预热**：提前扩容（基于流量预测）
- **超卖**：低优任务填空（批次推理/训练）
- **冷启动优化**：模型分片缓存、镜像瘦身

## 七、模型生命周期管理

```
注册（MLflow）
  ↓
开发/测试（沙箱）
  ↓
部署（K8s + Triton/vLLM）
  ↓
灰度（5% → 20% → 100%）
  ↓
监控（性能/效果）
  ↓
迭代（新版本上线，老版本下线）
  ↓
归档（模型 + 元数据 + 血缘）
```

## 八、监控体系

### 性能监控
```
延迟：P50/P95/P99 TTFT/TPOT
吞吐：QPS/token per second
错误率：5xx/超时/异常
GPU：利用率/显存/温度
```

### 业务监控
```
效果：CTR/AUC/GMV（按模型版本对比）
成本：单次推理成本/GPU 小时费
漂移：特征/预测分布漂移告警
```

### 可观测性三件套
- **Metrics**（Prometheus + Grafana）：指标
- **Logs**（ELK）：详细日志
- **Traces**（Jaeger/Zipkin）：调用链

## 九、高可用

```
- 多副本：每模型 N 副本
- 多可用区：跨 AZ 部署
- 健康检查：K8s liveness/readiness
- 故障转移：实例挂自动路由到其他
- 限流降级：超载降级小模型/兜底
- 灰度回滚：异常版本秒级回滚
- 数据备份：模型/配置/特征多副本
```

## 十、拼多多实战规模

```
- 模型数：上千（推荐/搜索/风控/LLM）
- QPS：百万级
- GPU：万卡级
- 实验并行：千级
- 业务接入：百级

关键挑战：
- 多模型共享 GPU（显存池化）
- LLM 高成本（量化 + batching + PD 分离）
- 弹性（流量预测 + 预热）
- 跨团队治理（统一标准 + 自助接入）
```

## 十一、底层本质

模型服务平台本质是**"推理网关 + 多后端抽象 + 弹性调度 + 监控治理"**——网关层做流量治理（鉴权/限流/路由/AB），后端层抽象多推理引擎（Triton/vLLM/TRT-LLM），调度层基于 K8s 做 GPU 弹性，监控保证可观测。是 AI 中台把"模型"变成"线上服务"的工程核心。

## 常见考点

1. **冷启动慢怎么优化**？——模型预加载、镜像分层缓存、镜像瘦身、模型分片并行加载。
2. **怎么避免 OOM**？——显存监控 + 限流（拒绝超量请求）+ 弹性扩容 + KV Cache 上限。
3. **LLM 和传统模型怎么共平台**？——抽象 InferenceBackend 接口，按模型类型路由到不同后端；网关统一接入。

## 苏格拉底式面试追问

> 这组追问不背答案，模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：推理网关要支持多后端（Triton/vLLM/TRT-LLM）。但为什么不统一成一个后端？维护一个推理引擎比维护三个简单多了。为什么要做"多后端"的复杂设计？**

多后端是"业务场景多样"的必然结果。第一，**不同模型类型有不同最优引擎**——CV 模型（ResNet/YOLO）用 Triton（动态 batching 强）、LLM 用 vLLM（PagedAttention）、延迟极致敏感的 LLM 用 TRT-LLM（kernel 最优）。没有"一个引擎通吃所有模型"。第二，**技术演进**——推理引擎在迭代（vLLM 从 2023 年崛起到 2026 年主流），如果只支持一个引擎（如 TensorRT），当新引擎（vLLM）更好时迁移成本大。多后端设计让"切换引擎"成为配置变更而非架构重构。第三，**厂商绑定**——如果只用 NVIDIA 的 TRT-LLM，被绑死在 NVIDIA GPU；支持 vLLM（开源、支持 AMD GPU）有议价权。多后端是"灵活性 + 技术演进 + 厂商制衡"的综合考量，不是"为了复杂而复杂"。

### 第二层：证据与定位

**Q：推理网关的 P99 延迟 500ms，但下游 vLLM 实例的推理延迟才 200ms。中间 300ms 去哪了？怎么定位网关层的开销？**

用全链路追踪（TraceId）拆解每段耗时。第一，**网关内部耗时**——Spring Cloud Gateway 的 filter chain（鉴权 5ms + 限流 3ms + 路由 2ms + 日志 5ms = 15ms），如果 filter 多了（业务方加了各种自定义 filter），可能到 50ms。看网关日志的 `gateway_route_duration` 和 `filter_duration`。第二，**网络往返**——网关到 vLLM 实例的网络 RTT（同机房 1ms，跨机房 5ms），如果网关和 vLLM 不在同机房，往返 10ms。第三，**vLLM 实例的排队**——vLLM 收到请求后可能排队（Continuous Batching 等下一个 iteration），`vllm:request_waiting_time` 如果是 200ms，说明 vLLM 的 batch 满了，请求在等。第四，**路由策略差**——如果网关用 round-robin 路由，可能把请求分到"已经满载"的实例（实例间负载不均），改用"最少请求"路由，让请求分到空闲实例。定位方法：在网关注入 TraceId，传到 vLLM 的请求 header，vLLM 返回时带耗时信息，全链路看每段耗时，找到 300ms 的损耗点。

### 第三层：根因深挖

**Q：你发现 300ms 里有 250ms 是"vLLM 实例的请求排队"（`vllm:request_waiting_time=250ms`）。为什么 vLLM 要让请求排队 250ms？**

vLLM 的排队是 Continuous Batching 的调度策略导致的。第一，**Continuous Batching 的 iteration 周期**——vLLM 每 iteration（约 50-100ms）检查一次是否有新请求可以加入 batch，如果请求在 iteration 中间到达，要等到下一个 iteration 才被加入（最多等 100ms）。第二，**batch 已满**——如果当前 batch 已经达到 `max_num_seqs`（最大并发序列数，比如 256），新请求必须等到有请求完成退出才能加入。如果所有 256 个序列都在 Decode（长输出），可能等几百 ms。第三，**GPU 显存满**——如果 KV Cache 池满了（所有 block 被占用），vLLM 会暂停接收新请求（preempt），等有请求完成释放 block。解法：第一，**调 `max_num_seqs`**——如果显存够，调大（256→512）让更多请求并发；第二，**调 `max_num_batched_tokens`**——控制单 iteration 的 token 数，影响调度频率；第三，**扩容**——如果持续排队（说明单实例扛不住），加 vLLM 实例，网关分流。监控 `vllm:request_waiting_time_p99`，超过 100ms 告警。

**Q：那为什么不直接给 vLLM 配"无限大"的 max_num_seqs 和显存？让它能无限接收请求，不就不用排队了？**

"无限大"受限于物理资源（GPU 显存）和 SLO（延迟）。第一，**显存物理限制**——`max_num_seqs` 越大，同时处理的请求越多，KV Cache 占用越大。7B 模型、seq=2K、max_num_seqs=256 的 KV Cache = 256 × 1.6GB = 409GB，A100 80G 远远不够。`max_num_seqs` 的上限是"显存 / 单请求 KV Cache"，A100 跑 7B 大约能支持 max_num_seqs=32-64。第二，**延迟 SLO**——即使显存够（比如 H100 80G），batch 太大（max_num_seqs=512）会让单 iteration 的计算时间变长（要处理 512 个序列的 Decode），每个请求的 TPOT（每 token 延迟）升高。如果 SLO 要求 TPOT < 50ms，max_num_seqs 不能太大（否则单 iteration 超过 50ms）。第三，**正确做法**——不是"调大单实例的 max_num_seqs"，而是"加实例数 + 合理 batch"。10 个实例 × max_num_seqs=64，总并发 640，比 1 个实例 × max_num_seqs=640（不可能）更现实。横向扩展（加实例）优于纵向扩展（加大 batch）。

### 第四层：方案权衡

**Q：路由策略你选了"最少请求"。但"最少请求"要求网关实时知道每个实例的请求数。如果网关和实例之间的状态同步有延迟（实例处理完了但网关还以为它忙），会不会路由不准？**

状态同步延迟确实会导致"最少请求"路由不准，但有缓解方案。第一，**状态同步方式**——网关通过"主动询问"（每次请求后实例回报队列长度）或"被动估算"（网关记录发出去的请求 + 收到的响应，算"in-flight 请求数"）。主动询问准但有网络开销，被动估算无开销但不准（不知道实例的真实队列）。第二，**延迟的影响**——如果实例处理完请求但网关 100ms 后才知道，这 100ms 内网关可能把新请求分到"已经空闲但网关以为还忙"的实例，导致路由不均。但 100ms 的偏差对"大流量"场景影响小（瞬时不均会被后续请求的统计平均掉）。第三，**更好的方案**——用"加权最少请求"（实例的权重按 GPU 利用率/队列长度动态调整），从 vLLM 的 metrics 接口（`/metrics`）实时拉取 `vllm:num_requests_running`，作为路由依据。这比"网关自己计数"准（实例自己最清楚自己的负载）。拼多多推理网关：每 5 秒从所有 vLLM 实例拉取 metrics，更新路由权重，平衡"准"和"开销"。

**Q：为什么不直接用"一致性哈希"路由（按 request_id 哈希到固定实例）？这样 KV Cache 可以复用（同会话的请求到同一实例），不是更好吗？**

一致性哈希适合"有会话亲和"的场景，但 LLM 推理有特殊性。第一，**会话亲和的价值**——多轮对话（同一 session_id）如果路由到同一实例，可以复用之前的 KV Cache（Prefix Caching），省 Prefill 计算。一致性哈希能让 `hash(session_id)` 固定到同一实例。第二，**问题：负载不均**——如果某些 session 的请求特别多（活跃用户），哈希到同一实例会导致该实例过载。一致性哈希不感知负载，可能"热 key 集中"。第三，**问题：实例增减时 rehash**——扩容/缩容时，一致性哈希会重新分配部分 session 到新实例，之前的 KV Cache 失效（要重新 Prefill），瞬时性能下降。第四，**生产方案**——混合路由："新会话用最少请求（负载均衡）+ 已有会话用 session 亲和（KV 复用）"。网关维护 `session_id → instance` 映射（有亲和），新会话选最闲实例，实例挂了 fallback 到其他实例（牺牲 KV 复用换可用性）。不是纯一致性哈希，是"有状态的负载均衡"。

### 第五层：验证与沉淀

**Q：你怎么证明推理网关的"多后端 + 智能路由"比"单一后端 + 简单轮询"的吞吐高？**

三个指标对比。第一，**throughput（tokens/s 或 QPS）**——多后端 + 智能路由 vs 单后端 + 轮询，固定硬件（10 个实例），跑相同 workload（混合 CV + LLM 请求）。多后端把 CV 路由到 Triton、LLM 路由到 vLLM，各自优化，总 throughput 比单后端（假设都用 vLLM 跑 CV，CV 性能差）高 30-50%。第二，**P99 延迟**——智能路由（最少请求）vs 轮询，智能路由的 P99 低 20-40%（负载均衡好，无单点过载）。第三，**资源利用率**——多后端按模型类型分配 GPU（CV 用 L4、LLM 用 H100），GPU 利用率 70%+；单后端混跑（都用 H100 跑 CV，浪费），利用率 40%。三个指标一致提升，证明架构设计生效。A/B 验证：新旧架构各 50% 流量，连续 1 周对比。

**Q：推理网关的经验怎么沉淀，让新模型/新后端接入不用改网关代码？**

三件事。第一，**InferenceBackend 抽象接口**——定义统一接口（`infer(request) → response`），每个后端（Triton/vLLM/TRT-LLM）实现自己的 adapter，网关只调接口，不耦合具体后端。新后端接入只需写 adapter（不改网关核心）。第二，**模型注册中心**——模型的元信息（类型/版本/后端/路由策略/SLO）存在注册中心（Nacos/自研），网关从注册中心读配置，动态路由。新增模型只在注册中心配置，不改网关代码。第三，**插件化 filter**——网关的 filter（鉴权/限流/日志/路由）做成插件，业务方按需启用，新业务接入不用改网关。推理网关的演进方向是"配置驱动 + 插件化"，不是"每加一个需求改一次代码"。监控网关的"新模型接入耗时"（从配置到上线），目标 < 1 天（理想是 1 小时）。

## 结构化回答

**30 秒电梯演讲：** 怎么把多模型/多后端/动态流量统一服务化？简单说就是——模型服务平台是"推理网关 + 路由 + 多后端 + 弹性 + 监控"的一体化系统，业务方传模型就是可服务化，平台保证性能/稳定/低成本。路由：GPU 利用率/最少请求/模型亲和；后端：Triton/vLLM/TRT-LLM。

**展开框架：**
1. **网关** — 网关：鉴权/限流/路由/AB/灰度
2. **路由** — 路由：GPU 利用率/最少请求/模型亲和
3. **后端** — 后端：Triton/vLLM/TRT-LLM

**收尾：** 您想继续往深里聊吗——比如「推理网关和 API 网关区别？」

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：模型服务平台架构怎么设计？ | 今天聊「模型服务平台架构怎么设计？」。一句话：模型服务平台是"推理网关 + 路由 + 多后端 + 弹性 + 监控"的一体化系统，业务方传模型即可服务化 | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：网关：鉴权/限流/路由/AB/灰度 | 核心概念 |
| 0:51 | 能力/参数拆解表 | 要点是：路由：GPU 利用率/最少请求/模型亲和 | 能力拆解 |
| 1:30 | 流程图：输入→处理→输出 | 要点是：后端：Triton/vLLM/TRT-LLM | 关键机制 |
| 2:09 | 代码片段 + 注释高亮 | 要点是：弹性：QPS/利用率/队列 | 实战要点 |
| 3:00 | 总结卡 + 下期预告 | 记住这些核心点就够了。下期我们接着聊——推理网关和 API 网关区别？。 | 收尾 |
