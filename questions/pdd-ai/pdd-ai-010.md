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
