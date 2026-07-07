---
id: ant-risk-034
difficulty: L4
category: jd-ai
subcategory: LLM 推理
tags:
- 蚂蚁
- 风控
- LLM
- vLLM
- 量化
- KV Cache
- 推理优化
feynman:
  essence: LLM 推理优化三大手段：vLLM 用 PagedAttention 让 KV cache 像虚拟内存分页管理（吞吐 5-10 倍）、量化用 INT8/INT4 降精度换速度、KV Cache 复用减少重复计算。
  analogy: vLLM 像操作系统的虚拟内存——把碎片化的 KV cache 用页表管理，利用率从 30% 到 90%；量化像压缩图片——精度略降但体积小几倍；KV Cache 像浏览器缓存——同会话不重复计算。
  first_principle: LLM 推理瓶颈是显存（KV cache 占用大）和计算（自回归逐步生成），vLLM 优化显存利用、量化减少计算量、KV Cache 复用避免重复计算。
  key_points:
  - vLLM/PagedAttention：KV cache 分页管理，吞吐 5-10 倍
  - 量化：INT8/INT4，精度损失小速度大幅提升
  - KV Cache：自回归推理中间结果缓存
  - Continuous Batching：动态拼 batch 提升利用率
  - 投机解码：小模型先生成，大模型验证
first_principle:
  problem: LLM 推理慢、显存占用大、单 GPU 吞吐低，如何用工程手段提升？
  axioms:
  - 显存有限（A100 80GB）
  - KV cache 是显存大头（长 prompt 几 GB）
  - 自回归生成串行（无法并行）
  rebuild: PagedAttention 把 KV cache 分页（像虚拟内存）+ Continuous Batching 动态拼请求 + 量化降精度减计算量，三者组合提升单 GPU 吞吐 5-10 倍。
follow_up:
- KV cache 占多少显存？——大约每 token 2×layers×hidden×2bytes，70B 模型每 token ~100KB
- 量化精度损失多大？——INT8 几乎无损，INT4 在风控这种结构化决策场景可接受
- vLLM 和 TensorRT-LLM 区别？——vLLM 开源生态好，TensorRT-LLM 是 NVIDIA 官方性能极致
memory_points:
- vLLM/PagedAttention：KV cache 分页管理，吞吐 5-10 倍
- 量化 INT8/INT4：精度略降换速度
- KV Cache：自回归中间结果缓存
- Continuous Batching：动态拼 batch
---

# 【蚂蚁风控】LLM 推理怎么优化？vLLM 原理？怎么降本增效？

> JD 依据："大模型实践" + "AI Harness"。推理优化是 LLM 生产部署的核心。

## 一、LLM 推理的性能瓶颈

**为什么 LLM 推理慢**：
1. **自回归生成**：每生成一个 token 都要把前面所有 token 重新算注意力（KV cache 优化了这个但仍慢）
2. **显存占用大**：KV cache 随序列长度线性增长
3. **GPU 利用率低**：传统 batching 静态，请求长度不齐导致浪费

**性能数据**（70B 模型，A100）：
```
传统推理（HuggingFace）：
  单请求延迟: 1-5 秒
  单 GPU 吞吐: 10-20 QPS
  显存利用率: 30%（碎片化）

vLLM 优化后：
  单请求延迟: 0.5-2 秒
  单 GPU 吞吐: 100-200 QPS
  显存利用率: 90%
```

## 二、KV Cache：自回归推理的基础

**问题**：自回归生成时，每生成新 token 都要算"新 token 和前面所有 token 的注意力"。

**朴素做法**：每次重算所有 token 的 K、V → 计算量爆炸。

**KV Cache**：把已计算的 K、V 存起来，新 token 只算自己的 K、V：
```
Token 序列: [t1, t2, t3, t4]
KV Cache: [K1,K2,K3,K4], [V1,V2,V3,V4]

生成 t5:
  只算 t5 的 K5, V5
  拼接: [K1..K5], [V1..V5]
  算注意力
```

**KV Cache 占用**（70B 模型）：
```
每 token KV cache 大小 ≈ 2 × layers × hidden × 2bytes
                       ≈ 2 × 80 × 8192 × 2 = 2.6 MB/token

1000 token 的 prompt: 2.6 GB KV cache
```

## 三、vLLM 与 PagedAttention（核心创新）

**传统 KV Cache 的问题**：
```
请求 A（长 prompt，需大块 KV cache）: [████████]
请求 B（短 prompt，小块）:              [██]
请求 C（中等）:                         [████]

传统预分配（按最大长度）:
  请求 A: [████████░░░░░] 预留但没用
  请求 B: [██░░░░░░░░░░░] 浪费
  请求 C: [████░░░░░░░░░] 浪费

→ 显存利用率 30%，碎片严重
```

**PagedAttention（vLLM 创新）**：
灵感来自**操作系统的虚拟内存分页**：
```
物理显存划分成固定大小的 Block（如每块 16 token）
逻辑 KV cache 由若干 Block 组成（不必连续）

请求 A 的 KV cache: Block 1 → Block 5 → Block 8（链表）
请求 B 的 KV cache: Block 2
请求 C 的 KV cache: Block 3 → Block 6

→ 显存利用率 90%，无碎片
```

**效果**：
- 显存利用率从 30% → 90%
- 同 GPU 能跑更多并发请求
- 吞吐提升 5-10 倍

## 四、Continuous Batching（动态批处理）

**传统静态 batching**：
```
batch = [Req A（1000 token）, Req B（50 token）, Req C（200 token）]
→ 必须等最长的 A 生成完，B、C 才能出 batch
→ B、C 生成完了但仍占资源等 A
```

**Continuous Batching**：
```
动态调度，B、C 生成完立即出 batch，新请求 D 加入
→ 持续保持 batch 满载
→ GPU 利用率最大化
```

**vLLM 的核心**：PagedAttention + Continuous Batching，让单 GPU 跑出最大吞吐。

## 五、量化（Quantization）

**原理**：把模型权重从 FP16（16 bit）降到 INT8（8 bit）或 INT4（4 bit），减少显存和计算量。

| 量化 | 显存 | 速度 | 精度损失 |
|------|------|------|---------|
| FP16 | 100% | 1× | 0% |
| INT8 | 50% | 2× | <1% |
| INT4 | 25% | 3-4× | 1-3% |

**量化方法**：
- **PTQ**（Post-Training Quantization）：训练后量化，简单
- **GPTQ**：基于二阶信息的量化，精度损失小
- **AWQ**：保留重要权重不量化

**风控场景选择**：
- INT8：日常用（精度几乎无损）
- INT4：成本敏感场景（结构化决策对精度不敏感）

**效果**：
- 70B 模型从 140GB → 35GB（INT4）
- 单 A100 80GB 能跑 70B（原本要 2 张）

## 六、其他优化技术

### 1. 投机解码（Speculative Decoding）
```
小模型（7B）先生成几个 token（快）
大模型（70B）并行验证（一次 forward）
匹配的 token 直接接受，不匹配的由大模型重生成
→ 大模型生成速度 +2 倍
```

### 2. Flash Attention
- 优化注意力计算的内存访问
- 减少中间结果读写
- 速度 +2-3 倍

### 3. 张量并行（Tensor Parallelism）
- 把模型分到多张 GPU
- 每张 GPU 算一部分
- 适合大模型（>40B）

### 4. 前缀缓存（Prefix Caching）
- 相同前缀的 prompt 复用 KV cache
- 风控决策 prompt 有公共前缀（系统提示）
- 命中缓存大幅提速

## 七、风控的 LLM 推理部署

**场景**：实时风控决策、异步复核、运营配置。

**部署方案**：
```
风控 LLM 推理集群:
  - 20 张 A100 80GB
  - vLLM 部署
  - 模型: GLM-4 风控微调版（INT8 量化）
  - 单卡吞吐: 100 QPS（vLLM）
  - 集群吞吐: 2000 QPS

调度:
  - 实时决策（< 500ms）→ 小模型 + 短 prompt
  - 异步复核（秒级）→ 大模型 + 完整推理
```

**Prompt 优化**（减 token）：
```
❌ 冗长 prompt:
"你是一个风控专家，请仔细分析以下事件...（1000 token）"

✅ 精简 prompt:
"事件: {event}
事实: {facts}
决策（PASS/REVIEW/REJECT）:"
（200 token）
```

**few-shot 而非 zero-shot**：
- 给 5 个典型例子
- 准确率提升，token 量可控

## 八、成本分析

**LLM 推理成本**（70B 模型）：
```
自建:
  - A100 卡: 10 万/张（折旧 3 年）
  - 单卡 100 QPS（vLLM）
  - 1 万 QPS 需要 100 张卡 = 1000 万
  - 年化: 333 万/年

API 调用（如 GLM-4）:
  - 0.05 元/千 token
  - 单次决策 1000 token = 0.05 元
  - 1 亿决策/月 = 500 万/月
```

**自建 vs API**：
- 大规模（> 1 亿/月）：自建便宜
- 中小规模：API 便宜（不用养 GPU）
- 风控选自建（数据敏感、规模大）

## 九、可观测性

**推理服务的监控**：
```
# 性能指标
llm_inference_duration_seconds{model="glm-4"}    # 推理耗时
llm_inference_qps{model="glm-4"}                  # 吞吐
llm_inference_p99_duration                        # P99 延迟

# 资源指标
gpu_utilization                                   # GPU 利用率
gpu_memory_used                                   # 显存使用

# 质量指标
llm_inference_error_rate                           # 错误率
llm_token_total{type="input"}                     # 输入 token
llm_token_total{type="output"}                    # 输出 token
```

**告警**：
- P99 > 2s → 性能告警
- GPU > 90% → 容量告警
- 错误率 > 1% → 稳定性告警

## 十、底层本质：LLM 推理的"系统化"

LLM 推理优化本质是**把"算法问题"转化为"系统工程问题"**：

**算法层**：模型本身（无法改）
**系统层**：
- 显存管理（PagedAttention）
- 调度（Continuous Batching）
- 计算（量化、Flash Attention）
- 缓存（Prefix Caching）

**类比传统数据库优化**：
- 数据库：B+ 树（算法）+ 缓冲池/查询优化器（系统）
- LLM：注意力（算法）+ vLLM/量化（系统）

**这是 AI 工程化的核心**——把 ML 模型部署成高性能服务，让"算法突破"转化为"业务价值"。

## 十一、和传统后端的关系

风控 Java 工程师转 AI Harness 的优势：
- 推理服务部署 = 传统服务部署 + GPU 调度
- LLM 网关 = API 网关 + 多模型路由
- 可观测性 = 传统监控 + token 维度
- 容量规划 = 传统容量 + GPU 利用率

**核心技能迁移**：
- 系统设计（高可用、可扩展）
- 性能优化（缓存、批处理）
- 工程化（监控、降级、预案）
- 团队协作

LLM 推理服务的"难"在算法细节，但"工程框架"和传统后端一致——这是 Java 工程师转 AI Harness 的天然优势。

## 常见考点
1. **vLLM 为什么快**？——PagedAttention（显存利用率 30%→90%）+ Continuous Batching（GPU 持续满载）。
2. **量化精度损失影响风控决策吗**？——INT8 几乎不影响；INT4 在结构化决策可接受（精度损失 1-3%）。
3. **怎么选自建还是 API**？——大规模+数据敏感（自建）；小规模+快速验证（API）。

**代码示例**（vLLM 部署）：
```python
from vllm import LLM, SamplingParams

# 加载模型（INT8 量化）
llm = LLM(
    model="/models/glm-4-risk-finetuned",
    quantization="awq",
    tensor_parallel_size=4,        # 4 GPU 张量并行
    max_num_seqs=256,              # 最大并发
    gpu_memory_utilization=0.9,    # 显存利用率
)

# 批量推理（Continuous Batching）
prompts = [build_prompt(e) for e in events]
sampling = SamplingParams(temperature=0, max_tokens=100)
outputs = llm.generate(prompts, sampling)
```
