---
id: pdd-ai-020
difficulty: L4
category: pdd-ai
subcategory: LLM 推理
tags:
- 拼多多
- AI 中台
- TensorRT-LLM
- vLLM
- TGI
- 推理框架对比
feynman:
  essence: TensorRT-LLM 是 NVIDIA 官方 LLM 推理引擎，对自家 GPU 优化到极致；vLLM 是开源通用方案（PagedAttention），易用性强。生产场景两者各有适用。
  analogy: TensorRT-LLM 像 F1 赛车（NVIDIA 调校，极致性能但复杂），vLLM 像高端量产车（通用易用，性能也强）。
  first_principle: 推理框架本质是"调度 + 显存 + kernel"三件套，谁把 GPU 利用率高、显存管得好、kernel 优化深谁就快。
  key_points:
  - TensorRT-LLM：NVIDIA 官方，kernel 极致优化，需模型转换
  - vLLM：PagedAttention + Continuous Batching，开源易用
  - TGI：HuggingFace 出品，简单易上手
  - lightLLM：轻量模块化
  - 选型：通用 vLLM，极致用 TRT-LLM，快速上线用 TGI
first_principle:
  problem: 不同推理框架在性能、易用、生态上如何权衡？
  axioms:
  - 推理瓶颈在显存和算力利用
  - 官方优化最深但部署复杂
  - 开源生态降低门槛
  rebuild: 按场景选型（极致/通用/快速）+ 关注核心指标（吞吐/延迟/显存）。
follow_up:
  - 为什么 TRT-LLM 比 vLLM 快？——官方 kernel（FlashAttention/MMA）+ 算子融合 + 平铺更细
  - 怎么从 HF 模型转 TRT-LLM？——convert_checkpoint.py 转 engine，需校准/精度配置
  - vLLM 生态为什么火？——开源易用、社区活跃、模型支持快
memory_points:
  - TRT-LLM：NVIDIA 官方极致优化，部署复杂
  - vLLM：PagedAttention 易用通用
  - TGI：HF 出品简单
  - lightLLM：轻量模块化
---

# 【拼多多 AI 中台】TensorRT-LLM 和 vLLM/TGI 怎么对比选型？

> JD 依据："VLLM/TGI/TensorRT-LLM/lightLLM"。

## 一、四大主流推理框架

| 框架 | 出品 | 定位 | 优势 |
|------|------|------|------|
| **TensorRT-LLM** | NVIDIA | 官方极致优化 | 性能最强、支持最新卡 |
| **vLLM** | UC Berkeley | 开源通用 | PagedAttention、易用、社区 |
| **TGI** | HuggingFace | 简单易用 | 接入 HF 生态最快 |
| **lightLLM** | Tencent/开源 | 轻量模块化 | 可定制、自定义 kernel |

## 二、TensorRT-LLM 详解

### 特点
- NVIDIA 官方维护，对自家 GPU 优化最深
- 基于 TensorRT 引擎，算子融合 + 平铺优化
- 支持 FP8/INT4 AWQ/GPTQ/SmoothQuant
- In-flight Batching（类似 Continuous Batching）
- 支持 TP/PP 多卡并行

### 工作流程
```
1. 模型转换
   HF 模型 → TensorRT 引擎（编译期优化）
   python convert_checkpoint.py --model_dir ./llama-hf --output ./llama-engine
   python build.py --checkpoint_dir ./llama-engine --use_fp8

2. Triton + TRT-LLM 后端服务化
   tritonserver --model-repository=./triton-llm

3. 客户端调用（gRPC/HTTP）
```

### 优势
- **吞吐最高**：比 vLLM 高 20-40%（kernel 优化深）
- **延迟最低**：P99 TTFT/TPOT 优
- **支持新硬件特性快**：FP8/H100 B200 第一时间支持

### 劣势
- **部署复杂**：模型要转换编译（小时级）
- **模型支持滞后**：新模型等官方适配
- **闭源部分**：核心 engine 编译器闭源
- **灵活性差**：自定义 attention 难

## 三、vLLM 详解

### 特点
- 开源（Apache 2.0），UC Berkeley 出品
- PagedAttention（核心创新）
- Continuous Batching
- Prefix Caching
- 支持主流模型（社区贡献快）

### 使用
```bash
vllm serve meta-llama/Llama-3-70B-Instruct \
    --tensor-parallel-size 4 \
    --quantization awq \
    --enable-prefix-caching \
    --max-model-len 8192
```

### 优势
- **易用**：一行命令起服务
- **通用**：HF 模型直接加载，不需转换
- **模型支持快**：新模型社区 PR 几天内支持
- **性能优秀**：PagedAttention 让吞吐接近 TRT-LLM

### 劣势
- **性能略逊**：比 TRT-LLM 低 20-40%
- **首 token 延迟**：prefill 优化不如 TRT-LLM
- **新硬件特性滞后**：FP8/新算子要等社区

## 四、TGI（Text Generation Inference）

### 特点
- HuggingFace 出品，和 HF Hub 深度集成
- 简单易用（一行 docker run）
- 支持 streaming/watermark/uid rate limit

### 使用
```bash
docker run -p 8080:80 ghcr.io/huggingface/text-generation-inference:latest \
    --model-id meta-llama/Llama-3-8B-Instruct
```

### 优势
- **接入最快**：HF 模型直接拉取
- **运维友好**：docker 一键
- **企业特性**：内置监控/限流

### 劣势
- **性能不如 vLLM/TRT-LLM**
- **定制化弱**

## 五、性能对比（典型场景）

7B/13B 模型，A100 80GB，batch=32：

| 框架 | 吞吐（token/s） | 显存利用率 | 部署难度 |
|------|----------------|-----------|----------|
| HF Transformers | 1000 | 30% | 易 |
| **TGI** | 2500 | 60% | 极易 |
| **vLLM** | 4500 | 90% | 易 |
| **TensorRT-LLM** | 6000 | 90% | 难 |

（数字为示意，实际看模型/硬件）

## 六、选型决策

```
场景：极致性能（生产大流量）
  → TensorRT-LLM（H100 集群，固定模型）

场景：通用易用（快速迭代）
  → vLLM（多模型切换频繁）

场景：快速上线（demo/POC）
  → TGI（docker 一键）

场景：定制/研究
  → lightLLM 或自研

场景：边缘/单卡
  → llama.cpp + GGUF（CPU/混合）

场景：多模态
  → vLLM（支持）或 TRT-LLM（需自适配）
```

## 七、拼多多 AI 中台实践

**分层部署**：
```
高流量生产（客服 LLM）
  → TensorRT-LLM（极致性能）
  → 量化：AWQ INT4（成本优先）
  → PD 分离（KV 池化）

中等流量（推荐召回）
  → vLLM（模型迭代频繁）
  → INT8 量化（平衡）

实验/低流量（A/B 实验）
  → TGI（快速部署）
  → 不量化（保证效果基线）

边缘（本地推理）
  → llama.cpp + GGUF
  → INT4 量化
```

**统一推理网关**：
```java
// 按模型/流量路由到不同后端
public String infer(String model, String prompt) {
    if (isProdModel(model)) {
        return tritonLlmClient.invoke(model, prompt);  // TRT-LLM
    } else if (isExperimental(model)) {
        return tgiClient.invoke(model, prompt);         // TGI
    } else {
        return vllmClient.invoke(model, prompt);        // vLLM
    }
}
```

## 八、关键优化技术对比

| 技术 | TRT-LLM | vLLM | TGI |
|------|---------|------|-----|
| Continuous Batching | ✅（in-flight） | ✅ | ✅ |
| PagedAttention | 部分 | ✅（首创） | 部分 |
| Prefix Caching | ✅ | ✅ | 部分 |
| INT4/INT8 量化 | ✅ | ✅ | ✅ |
| FP8 | ✅（首发） | 部分 | 部分 |
| Speculative Decoding | ✅ | ✅ | ✅ |
| Tensor Parallel | ✅ | ✅ | ✅ |
| Pipeline Parallel | ✅ | 部分 | 部分 |
| PD 分离 | 部分 | 部分 | ✗ |

## 九、新兴方向

- **Speculative Decoding**（投机解码）：小模型先猜 + 大模型校验，2-3 倍加速
- **Medusa/EAGLE**：多头预测加速
- **MLSys 优化**：算子融合、kernel auto-tune
- **多模态融合**：vLLM 0.5+ 支持 LLaVA/Qwen-VL
- **端侧推理**：llama.cpp、MLX（Apple）

## 十、底层本质

LLM 推理框架本质是**"显存管理 + Batching + Kernel 优化"**三件套——vLLM 用 PagedAttention 解决显存，TensorRT-LLM 用官方 kernel 解决算力，TGI 用 HF 生态解决易用。选型按场景权衡：极致性能选 TRT-LLM，通用易用选 vLLM，快速上线选 TGI。未来方向是投机解码 + 多模态 + 端云协同。

## 常见考点

1. **为什么 TRT-LLM 编译慢**？——编译期做算子融合/kernel 自动调优/平铺参数搜索，找到最优 kernel 配置。
2. **vLLM 推理时怎么改 batch**？——Continuous Batching 每 iteration 重排，请求进出动态。
3. **Speculative Decoding 怎么实现**？——draft 模型生成 k 个候选 → target 模型并行验证 → 接受/拒绝（保持原分布）。
