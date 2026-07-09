---
id: pdd-ai-034
difficulty: L4
category: pdd-ai
subcategory: LLM 推理
tags:
- 拼多多
- AI 中台
- 投机解码
- 前缀缓存
- Speculative Decoding
- 推理优化
feynman:
  essence: LLM 推理进阶优化有投机解码（小模型先猜+大模型校验，2-3x 加速）+ 前缀缓存（共享 system prompt 的 KV）+ 蒸馏/剪枝等，让大模型推理逼近小模型速度。
  analogy: 像作家写书——先让助手快速写草稿（小模型投机），主作家快速审稿改几处（大模型校验），比主作家从头写快得多。
  first_principle: Decode 阶段每 token 都要读全部权重（带宽瓶颈），若能一次验证多个候选 token，相当于并行处理多 token，加速明显。
  key_points:
  - 投机解码：Draft 模型生成 + Target 模型并行验证
  - 前缀缓存：共享 system prompt 的 KV Cache
  - 蒸馏：大模型教小模型
  - 剪枝：去不重要权重/头
  - MEDUSA/EAGLE：多头并行预测
first_principle:
  problem: Decode 阶段带宽瓶颈导致慢，怎么并行化？
  axioms:
  - Decode 每次只产 1 token（串行）
  - 大模型推理慢（读全部权重）
  - 小模型快但准度差
  rebuild: 投机解码（小模型猜 + 大模型并行验）+ 前缀缓存 + 蒸馏剪枝。
follow_up:
  - 投机解码什么时候有效？——Draft 准确率高（>50%）+ 大小模型分布相近
  - 蒸馏和量化区别？——蒸馏训出新模型（小但专），量化压缩原模型（同结构低精度）
  - 前缀缓存命中条件？——完全相同前缀（system prompt 固定）
memory_points:
  - 投机：Draft 猜 + Target 验
  - 前缀缓存：共享 system prompt KV
  - 蒸馏：大教小
  - 剪枝：去冗余
---

# 【拼多多 AI 中台】LLM 推理优化进阶（投机解码/前缀缓存）怎么做？

> JD 依据："推理加速、KV Cache"。

## 一、投机解码（Speculative Decoding）

### 原理
```
传统 Decode（串行）：
  token1 → token2 → token3 → ... → tokenN
  每步都要读全部权重，慢

投机解码（并行验证）：
  1. Draft 模型（小，快）快速生成 k 个候选 token：t1, t2, ..., tk
  2. Target 模型（大，准）一次 forward 并行验证这 k 个
  3. 接受前 j 个（分布匹配的），从第 j+1 个重新生成
  4. 若 j=k（全对），额外免费生成 1 个（target 自己产）

效果：单次 forward 处理 k 个 token，2-3x 加速
```

### 数学保证
```
接受/拒绝策略保证最终分布等同 Target 模型：
- Draft 概率 ≤ Target：接受
- Draft 概率 > Target：按比例拒绝（避免分布偏移）
- 拒绝后从调整分布重新采样

→ 投机解码不改变输出分布（无损）
```

### 实现框架
- **Medusa**：Target 模型加多个解码头，并行预测
- **EAGLE**：用 Target 的 hidden state 训 Draft，准确率高
- **vLLM/TensorRT-LLM**：内置投机解码支持

### 代码示例（vLLM）
```bash
vllm serve Qwen/Qwen2-72B \
    --speculative-model Qwen/Qwen2-1.5B \   # draft 模型
    --num-speculative-tokens 5 \             # 每次猜 5 个
    --speculative-draft-tensor-parallel-size 1
```

### 适用条件
```
- Draft 准确率高（>50%）→ 否则浪费算力
- Draft 和 Target 分布相近（同家族模型，如 Qwen 系列）
- 长生成场景（短生成收益小）
- 用户：Draft 用 0.5B/1.5B，Target 用 7B/72B
```

## 二、前缀缓存（Prefix Caching）

### 原理
```
大量请求共享 system prompt：
"你是拼多多客服，请按规则回答用户问题..."
+
用户 A 输入：A 的问题
用户 B 输入：B 的问题
用户 C 输入：C 的问题

传统：每个请求都重新计算 system prompt 的 KV（重复浪费）
前缀缓存：system prompt 的 KV 算一次，多请求复用
```

### 实现
```
1. 识别请求的前缀（按 token 序列哈希）
2. 第一次请求：算 KV，缓存（带版本）
3. 后续相同前缀请求：直接用缓存 KV（跳过 prefill）
4. 只算用户输入部分的 KV

效果：
- 共享 system prompt 场景吞吐 2-5x
- TTFT 显著降低（不用重算 prompt）
```

### vLLM 启用
```bash
vllm serve Qwen/Qwen2-72B --enable-prefix-caching
```

### 命中条件
- 完全相同前缀（token 序列）
- 顺序敏感（中间不能差）
- 缓存淘汰策略（LRU/大小上限）

### 进阶：自动前缀缓存
- 不只 system prompt，对话历史也可缓存
- 跨请求复用（同用户多轮对话）
- 智能识别可缓存片段

## 三、模型蒸馏（Distillation）

### 原理
```
Teacher（大模型）→ Student（小模型）

方法 1：硬标签蒸馏
  - Teacher 生成回答，Student 模仿
  - 学生学老师的输出

方法 2：软标签蒸馏
  - 用 Teacher 的 logits（概率分布）
  - KL 散度损失
  - 学生学老师的"思考过程"

方法 3：特征蒸馏
  - 中间层特征对齐
```

### 效果
```
72B Teacher → 7B Student：
  - 任务：客服对话
  - 准确率：保持 95%+
  - 推理快 10x，成本低 10x
```

### 工具
- LLMLingma/PandaLM
- 自研（基于 HuggingFace Trainer）

## 四、剪枝（Pruning）

### 类型
```
权重剪枝：去不重要的权重（接近 0 的）
结构剪枝：
  - 头剪枝（Attention 头去冗余）
  - 层剪枝（去不重要层）
  - 通道剪枝

稀疏度：50% 稀疏（一半权重为 0）
硬件支持：稀疏矩阵乘需要专门支持
```

### 效果
- 模型变小（显存省）
- 推理快（如果硬件支持稀疏）
- 精度损失（要重新校准）

### 工具
- Wanda/SparseGPT（学术）
- TensorRT Model Optimizer

## 五、Medusa / EAGLE（多头投机）

### Medusa
```
Target 模型上加多个解码头（额外训练）：
  - Head 1：预测下一 token
  - Head 2：预测下下 token
  - ...

一次 forward 产 k 个候选，并行验证
优势：不用单独 Draft 模型
劣势：要训 Medusa Head
```

### EAGLE
```
基于 Target 的 hidden state 训 Draft：
  - Draft 看 Target 的隐状态
  - 准确率更高（70%+）
  - 加速更明显（3x+）
```

## 六、其他优化

### 1. 模型架构优化
```
- GQA/MQA：减少 KV Cache
- FlashAttention：注意力 IO 优化
- ALiBi/RoPE：长上下文外推
- Mamba/线性注意力：替代 Transformer（研究前沿）
```

### 2. 算子优化
```
- Kernel fusion（算子融合）
- Custom CUDA/Triton kernel
- KV Cache 量化（INT8/FP8）
- INT4/INT8 权重量化
```

### 3. 调度优化
```
- Continuous Batching（vLLM）
- PD 分离
- 优先级调度
- 流量预测 + 预热
```

## 七、组合应用

```
极致优化组合（生产场景）：
1. 模型：INT4 量化（AWQ）
2. 推理：vLLM + Continuous Batching + PagedAttention
3. 缓存：Prefix Caching（system prompt）
4. 加速：投机解码（Draft 1.5B + Target 72B）
5. 调度：PD 分离（大集群）
6. 弹性：K8s + GPU HPA

效果（示例）：
  原始 72B FP16：单卡 ~100 token/s
  优化后：单卡 ~500+ token/s（5x）
  成本：单次推理成本降到 1/5
```

## 八、拼多多实战

```
客服 LLM 优化：
- 基座：Qwen-72B（INT4 AWQ）
- 推理：vLLM + Prefix Caching（system prompt 固定）
- 投机：Qwen-1.5B 当 Draft（同家族准确率高）
- PD 分离：Prefill 用 H100，Decode 用 L4
- 监控：投机命中率（>60% 才划算）

效果：
- 吞吐：5x
- TTFT：从 3s → 0.8s
- 成本：1/4
- 准确率：持平（无损）
```

## 九、底层本质

LLM 推理优化进阶本质是**"打破 Decode 串行瓶颈 + 复用计算 + 压缩模型"**——投机解码把串行变并行（小猜大验），前缀缓存复用共享 KV（system prompt 不重算），蒸馏/剪枝降模型大小。这些技术组合能把 72B 模型推理成本降到原 1/4-1/5，是 LLM 大规模生产的必经之路。

## 常见考点

1. **投机解码为什么不改变输出分布**？——接受/拒绝策略保证最终概率等同 Target，Draft 准则只是加速器。
2. **前缀缓存命中率怎么提高**？——固定 system prompt + 模板化 + 跨请求复用 + 智能片段识别。
3. **蒸馏和微调区别**？——蒸馏是让 Student 模仿 Teacher（保留能力降规模），微调是让模型适应特定任务（不改变规模）。
