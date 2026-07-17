---
id: pdd-ai-010
difficulty: L4
category: pdd-ai
subcategory: 模型服务
tags:
- 拼多多
- AI 中台
- 模型服务
- Triton
- TensorRT
- GPU
feynman:
  essence: 模型服务化是"把训练好的模型部署成高可用、可扩展、可监控的推理 API"，核心是推理引擎（Triton/vLLM）+ 服务治理（路由/限流/弹性）。
  analogy: 像开餐厅卖菜——厨师（模型）做好菜，但要有服务员（API）、传菜员（路由）、限量招牌（限流），才能服务大批食客（请求）。
  first_principle: 模型训练好只是"半成品"，要稳定服务线上请求才算落地，工程化（部署/调度/弹性/监控）是关键。
  key_points:
  - 推理引擎：Triton（多框架）/vLLM（LLM 专用）/TF Serving（TF 模型）
  - 服务化：模型注册 → 路由 → 推理 → 后处理 → 监控
  - GPU 调度：显存池化、动态 batching、多模型共享卡
  - 弹性：基于 GPU 利用率/QPS 自动扩缩
first_principle:
  problem: 怎么把模型高效、稳定、低成本地服务线上请求？
  axioms:
  - 推理有 GPU/CPU 成本
  - 请求有突发和长尾
  - 模型多、版本多要治理
  rebuild: 模型服务平台（推理引擎 + 路由网关 + 弹性调度 + 监控治理）。
follow_up:
  - Triton 和 vLLM 区别？——Triton 通用多框架（CV/NLP/语音），vLLM 专精 LLM（PagedAttention）
  - 怎么提高 GPU 利用率？——动态 batching + 多模型共享卡 + INT8 量化
  - 推理延迟 P99 怎么优化？—— batching + KV Cache + 量化 + 弹性扩容
memory_points:
  - 推理引擎：Triton（通用）/vLLM（LLM）
  - 服务化：注册→路由→推理→监控
  - GPU：动态 batch + 显存池化 + 多模型共享
  - 弹性：基于利用率/QPS 自动扩缩
---

# 【拼多多 AI 中台】模型服务平台怎么设计？Triton 怎么用？

> JD 依据："图像/语音/NLP 模型服务、Java + NoSQL + RPC"。

## 一、模型服务化要解决什么

**痛点**：
```
算法：训好一个 ResNet 模型（.pt 文件）
工程：怎么部署成线上 API？
  - 直接 Flask 起一个？并发扛不住
  - 模型加载占 4G 显存，每请求加载？爆显存
  - 多模型怎么共享 GPU？
  - 怎么监控延迟/QPS/错误率？
```

**平台目标**：算法同学只管传模型，平台保证高效稳定服务。

## 二、推理引擎选型

| 引擎 | 类型 | 优势 | 适用 |
|------|------|------|------|
| **Triton Inference Server** | 通用 | 多框架（TensorFlow/PyTorch/ONNX/TensorRT）+ 动态 batching + 多模型共享 GPU | CV/NLP/语音/推荐 |
| **vLLM** | LLM 专用 | PagedAttention 高吞吐、连续 batching | LLM 推理（首选） |
| **TensorRT-LLM** | LLM 专用 | NVIDIA 官方，极致优化 | 大模型生产部署 |
| **TGI**（HuggingFace） | LLM 专用 | 简单易用、社区活跃 | LLM 快速上线 |
| **TF Serving** | TensorFlow | 谷歌官方 | 纯 TF 模型 |
| **ONNX Runtime** | 通用 | 跨框架、轻量 | 端侧/嵌入式 |

**拼多多 AI 中台**：传统 CV/NLP/推荐用 Triton，LLM 用 vLLM/TensorRT-LLM。

## 三、Triton 核心能力

### 1. 多框架支持
```
模型仓库结构：
models/
├── resnet50/
│   ├── config.pbtxt          # 配置（max_batch_size/输入输出/动态 batching）
│   └── 1/
│       └── model.pt          # PyTorch 模型
├── bert_classifier/
│   └── 1/
│       └── model.onnx
```

### 2. 动态 Batching
```
请求 A 到达（0ms）→ 等待
请求 B 到达（2ms）→ 等待
请求 C 到达（4ms）→ 满足 max_batch_size 或延迟阈值
↓ 一次 batch 推理（GPU 并行度高）
返回 A、B、C 结果
```

吞吐提升 5-10 倍（GPU batch 友好）。

### 3. 多模型共享 GPU
```
GPU 0（80GB 显存）
├── Model A 占 20G
├── Model B 占 15G
└── Model C 占 30G
Triton 同进程加载多模型，共享 CUDA context
```

### 4. 模型版本管理
```
models/resnet50/
├── 1/model.pt   ← 旧版本
├── 2/model.pt   ← 当前版本（config 指定）
└── 3/model.pt   ← 灰度版本（5% 流量）
```

## 四、模型服务平台架构

```
┌──────────────────────────────────────────────┐
│ 推理网关（Java/Spring Cloud Gateway）        │
│   - 鉴权/限流/路由/A-B 实验                  │
│   - 协议转换（HTTP/gRPC）                    │
└──────────────┬───────────────────────────────┘
               │
┌──────────────▼───────────────────────────────┐
│ Triton/vLLM 集群（K8s 部署）                 │
│   Pod1: GPU 0 - models [A, B]                │
│   Pod2: GPU 1 - models [A, C]                │
│   Pod3: GPU 2 - models [B, C]                │
└──────────────┬───────────────────────────────┘
               │
┌──────────────▼───────────────────────────────┐
│ 模型注册中心（MLflow / 自研）                │
│   - 模型元数据、版本、血缘                    │
│   - 部署配置、灰度策略                        │
└──────────────────────────────────────────────┘

监控：Prometheus + Grafana（延迟/QPS/错误率/GPU 利用率）
日志：ELK（推理日志、异常 trace）
```

## 五、Java 业务侧调用

```java
// 通过 gRPC 调 Triton
@Service
public class ModelInferenceService {
    @Autowired private InferenceServerGrpc.InferenceServerBlockingStub tritonStub;

    public float[] predict(List<Float> imageFeatures) {
        InferInput input = InferInput.newBuilder()
            .setName("input")
            .setDatatype(DataType.FP32)
            .setShape(List.of(1, 2048))
            .build();
        input.setContents(InferTensorContents.newBuilder()
            .addAllFp32Contents(imageFeatures));

        ModelInferRequest req = ModelInferRequest.newBuilder()
            .setModelName("resnet50")
            .setModelVersion("2")             // 灰度可动态切换
            .addInputs(0, input.toInferInput())
            .build();

        ModelInferResponse resp = tritonStub.modelInfer(req);
        return parseOutput(resp);
    }
}
```

## 六、GPU 调度优化

| 优化 | 说明 |
|------|------|
| 动态 Batching | 攒批提升 GPU 利用率 |
| 多模型共享 | 同卡部署多模型，避免显存浪费 |
| 显存池化 | KV Cache / 工作区预分配复用 |
| INT8/FP16 量化 | 减半显存，提速 2-3 倍 |
| 多流（CUDA Stream） | 并发执行多个推理 |
| GPU 弹性扩缩 | K8s + GPU operator，基于 QPS/利用率 HPA |

## 七、弹性与高可用

```
- 多副本：每个模型至少 N 副本，单 Pod 挂不影响
- 健康检查：/v2/health/ready，K8s liveness/readiness
- 负载均衡：按 GPU 利用率路由（比轮询更优）
- 限流：网关层按 model_id 限流，防雪崩
- 降级：LLM 超载时降级到小模型或返回兜底话术
- 灰度：模型新版本灰度 5% → 50% → 100%
```

## 八、底层本质

模型服务平台本质是**"推理引擎 + 服务治理 + GPU 调度"**——Triton 解决多框架/批处理/共享 GPU，vLLM/TensorRT-LLM 解决 LLM 高吞吐，网关层做路由/限流/灰度，K8s 做弹性扩缩。这是 AI 中台把"模型"变成"线上服务"的关键工程层。

## 常见考点

1. **动态 batching 怎么权衡**？——batch 大吞吐高但延迟升，要按业务设阈值（如 50ms 内最多 32）。
2. **怎么降低推理成本**？——量化（INT8/INT4）+ batching + 共享 GPU + 弹性扩缩 + 模型蒸馏。
3. **冷启动慢怎么办**？——模型预加载、避免运行时加载、镜像瘦身、模型分片缓存。

## 苏格拉底式面试追问

> 这组追问不背答案，模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：你们 CV/NLP 模型用 Triton，但 LLM 用 vLLM。为什么不统一用 Triton？Triton 也支持 PyTorch 模型，LLM 不也是 PyTorch 模型吗？**

Triton 是通用推理引擎，支持多框架但每个框架的性能优化不够深。LLM 推理的核心瓶颈是 KV Cache 显存管理和 Continuous Batching，这两个是 vLLM 的 PagedAttention 专门解决的——Triton 没有等价机制（它的 batching 是通用的 dynamic batching，不理解 LLM 的 token-level 增量生成）。vLLM 对 LLM 的吞吐优化是 Triton 的 3-5 倍（官方 benchmark）。Triton 适合"输入固定 → 一次前向 → 输出"的模型（ResNet 分类、BERT 编码），vLLM 适合"自回归生成"的 LLM。统一用 Triton 会损失 LLM 的性能优势，得不偿失。多后端抽象（InferenceBackend 接口）比强行统一引擎更合理。

### 第二层：证据与定位

**Q：Triton 推理服务的 P99 延迟从 50ms 飙到 800ms，但 GPU 利用率才 30%。这不是 GPU 不够忙吗？为什么延迟还这么高？**

GPU 利用率低 + 延迟高，典型的是" batching 不充分 + 请求排队"。第一，看 Triton 的 `nv_inference_request_duration` 和 `nv_inference_request_success` 指标，算单次推理平均耗时——如果单次还是 50ms，说明 GPU 没慢，是请求在队列里等。第二，看 `nv_inference_queue_duration`（请求在 Triton 队列里的等待时间），如果 queue_duration 从 5ms 涨到 700ms，就是 batching 攒批策略的问题——dynamic batching 的 `max_queue_delay_microseconds`（默认 0，立即执行）或 `preferred_batch_size` 设置不合理，要么没攒够 batch 就执行（GPU 利用率低），要么攒太久（延迟高）。第三，看 `nv_inference_exec_count` 和并发请求数，如果并发 200 但 exec_count 才 50/s，说明 GPU 每 batch 只处理了少量请求。

### 第三层：根因深挖

**Q：你发现 queue_duration 很高但 batch_size 才 4（配置的是 32）。为什么 batch 攒不满？流量不是很够吗？**

根因可能是"请求长度差异大 + preferred_batch_size 配置死板"。Triton 的 dynamic batching 攒批时，如果配置了 `preferred_batch_size: [4, 8, 16, 32]`，它会等攒到 32 或超时（`max_queue_delay_microseconds`）。但如果流量峰值时大部分请求是长 prompt（比如 2000 token），GPU 显存只能容纳 4 个这样的请求一个 batch（显存预算 = batch_size × seq_len × hidden_dim），Triton 会提前执行 batch=4 而不是等到 32。另一个根因是模型配置的 `max_batch_size` 设太小（比如配置成 4），Triton 永远不会攒超过 4。排查手段：看 Triton 的 `config.pbtxt` 里 `max_batch_size` 和 `dynamic_batching` 配置，再看 `--log-verbose=1` 的日志里实际执行的 batch_size 分布。

**Q：那为什么不直接把 max_batch_size 调到 256？越大不是吞吐越高吗？**

batch_size 大吞吐高但有上限和代价。第一，显存限制——ResNet50 输入是图片张量（224×224×3×FP16），batch=32 占约 18MB 激活显存，batch=256 占 144MB，加上模型权重和中间激活，可能超出 GPU 显存触发 OOM。第二，延迟代价——batch 越大，GPU 单次前向计算时间越长（虽然吞吐高），单个请求的延迟（从入队到返回）可能升高。第三，长尾放大——batch=256 时，如果 255 个请求都算完了但 1 个卡住，255 个都要等。正确做法是按 GPU 显存和 SLO 反算 max_batch_size：单次前向 P99 < 100ms 约束下，A100 跑 ResNet50 最优 batch 是 64-128。调参要实测（用 `perf_analyzer` 工具扫不同 batch_size 的吞吐-延迟曲线找拐点）。

### 第四层：方案权衡

**Q：你把 batch_size 从 4 调到 64 后吞吐上去了，但 P99 反而升到 300ms（虽然平均降了）。客服场景要求 P99 < 200ms。这个权衡你怎么处理？**

这是吞吐和长尾的经典矛盾。batch 大 → GPU 利用率高、平均延迟低，但偶尔的大 batch 会让队尾请求等更久，P99 升高。解法是分级 batching：第一，给请求打优先级标签（`priority` header），Triton 的 dynamic batching 支持 priority queue——高优先级请求（客服实时对话）优先组 batch，低优先级（批量分析）等高优处理完再组。第二，设 `max_queue_delay_microseconds=50000`（50ms）——请求在队列里最多等 50ms，超时就强制执行（即使 batch 没攒够），保证 P99 不超过 50ms + 推理延迟。第三，分池部署——客服场景独占一个小集群（batch_size=8，低延迟），批量分析用大集群（batch_size=64，高吞吐），互不影响。

**Q：为什么不直接用 Triton 的"模型多版本"做灰度，而要单独搞推理网关做路由？Triton 自己就支持多版本呀。**

Triton 的多版本（`models/resnet50/1/`, `models/resnet50/2/`）只是加载了多个版本，客户端请求时指定 `model_version` 字段选择。但灰度需要"按 uid 哈希分流量到不同版本"——这个逻辑 Triton 不做（它只是模型服务器，不做业务路由）。推理网关（Spring Cloud Gateway）负责从请求 header 拿 uid、调实验平台的分流 SDK、决定路由到 v1 还是 v2、把 `model_version` 注入到 Triton 请求里。Triton 是"模型执行层"，网关是"流量治理层"，职责分离。如果让 Triton 兼做路由，要把实验配置同步到每个 Triton 实例，且无法做 A/B 实验的指标归因（哪个版本对应哪部分流量）。

### 第五层：验证与沉淀

**Q：你怎么证明 batch_size 调优真的提升了 GPU 利用率而不是只是碰巧流量涨了？**

三个对比。第一，用 Triton 自带的 `perf_analyzer` 离线压测——固定 QPS（比如 1000）跑 batch_size=4 和 batch_size=64，对比 `nv_gpu_utilization` 和 `throughput`（infer/sec），消除流量变量。第二，线上 A/B——同一模型部署两套 Triton 实例（batch=4 和 batch=64），网关 50/50 分流，同时段对比 GPU 利用率和 P99 延迟。第三，长期监控——上线后连续 1 周看 `gpu_utilization_p50` 和 `gpu_utilization_p99`，如果 P50 从 30% 涨到 70% 且稳定，证明是调优效果。同时看 `infer_cost_per_request`（单次推理的 GPU 时成本），应该随利用率提升而下降。

**Q：怎么让团队不再瞎调 batch_size？**

沉淀两件事。第一，每个模型上线时强制跑 `perf_analyzer` benchmark——扫 batch_size=[1,4,8,16,32,64,128] 的吞吐-延迟曲线，选"P99 < SLO 的最大 batch_size"写入 `config.pbtxt`。benchmark 报告存档，作为调参依据。第二，GPU 利用率监控告警——`gpu_utilization_p50 < 50%` 持续 1 小时告警（说明 batch 配小了或流量低），`batch_size_p99 > configured_max * 0.9` 告警（说明 batch 总是攒满，可能要调大）。第三，建立"模型性能档案"——每个模型的 FLOPS、显存占用、最优 batch_size、单次推理延迟，记录在模型注册中心，新模型上线时参考同类模型的配置，不重复踩坑。

## 结构化回答

**30 秒电梯演讲：** 怎么把模型高效、稳定、低成本地服务线上请求？简单说就是——模型服务化是"把训练好的模型部署成高可用、可扩展、可监控的推理 API"，核心是推理引擎（Triton/vLLM）+ 服务治理（路由/限流/弹性）。服务化：注册→路由→推理→监控；GPU：动态 batch + 显存池化 + 多模型共享。

**展开框架：**
1. **推理引擎** — 推理引擎：Triton（通用）/vLLM（LLM）
2. **服务化** — 服务化：注册→路由→推理→监控
3. **GPU** — GPU：动态 batch + 显存池化 + 多模型共享

**收尾：** 您想继续往深里聊吗——比如「Triton 和 vLLM 区别？」

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：模型服务平台怎么设计？Triton 怎么用？ | 今天聊「模型服务平台怎么设计？Triton 怎么用？」。一句话：模型服务化是"把训练好的模型部署成高可用、可扩展、可监控的推理 API"，核心是推理引擎（Triton/vLLM）+ … | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：推理引擎：Triton（通用）/vLLM（LLM） | 核心概念 |
| 0:51 | 监控大盘截图 + 指标曲线 | 要点是：服务化：注册→路由→推理→监控 | 能力拆解 |
| 1:30 | 流程图：输入→处理→输出 | 要点是：GPU：动态 batch + 显存池化 + 多模型共享 | 关键机制 |
| 2:09 | 代码片段 + 注释高亮 | 要点是：弹性：基于利用率/QPS 自动扩缩 | 实战要点 |
| 3:00 | 总结卡 + 下期预告 | 记住这些核心点就够了。下期我们接着聊——Triton 和 vLLM 区别？。 | 收尾 |
