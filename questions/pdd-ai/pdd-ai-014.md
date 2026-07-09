---
id: pdd-ai-014
difficulty: L4
category: pdd-ai
subcategory: LLM 推理
tags:
- 拼多多
- AI 中台
- vLLM
- PagedAttention
- KV Cache
feynman:
  essence: vLLM 是"为 LLM 推理量身定制的高吞吐引擎"，核心是 PagedAttention（像 OS 虚拟内存管理 KV Cache），把显存碎片降到极低，吞吐提升 2-4 倍。
  analogy: 传统推理像固定停车位——每个请求预留一大块（不管用不用满），浪费；vLLM 像共享单车——按需分页申请显存，腾出空间给更多请求。
  first_principle: LLM 推理瓶颈是 KV Cache 显存（不是算力），传统连续分配碎片严重、利用率低，必须像 OS 管内存一样分页管理。
  key_points:
  - KV Cache 是显存大头（占 80%+），不是模型权重
  - PagedAttention：KV 分块（block）+ 页表映射，按需分配
  - Continuous Batching：请求动态加入/退出 batch
  - 前缀缓存：共享 system prompt 的 KV
  - 吞吐 2-4x HuggingFace，接近或超 TensorRT-LLM
first_principle:
  problem: LLM 推理显存被 KV Cache 吃光、batch 上不去，怎么提升吞吐？
  axioms:
  - 显存有限且贵
  - KV Cache 随 seq_len 线性增长
  - 连续分配导致碎片和浪费
  rebuild: PagedAttention（分页管理 KV）+ Continuous Batching（动态组批）。
follow_up:
  - vLLM 和 TensorRT-LLM 区别？——vLLM 开源易用通用，TRT-LLM NVIDIA 官方极致优化但部署复杂
  - PagedAttention 延迟会增加吗？——寻址多一跳但整体吞吐高，长 batch 场景延迟反而降
  - 怎么进一步加速？——前缀缓存（Prefix Cache）+ 量化（AWQ/GPTQ）+ 投机解码
memory_points:
  - KV Cache 是显存大头（80%+）
  - PagedAttention 分页管理（block + 页表）
  - Continuous Batching 动态组批
  - 吞吐 2-4x HF
---

# 【拼多多 AI 中台】vLLM 和 PagedAttention 原理是什么？

> JD 依据："vLLM、推理加速、KV Cache"。

## 一、LLM 推理的瓶颈是显存

```
模型推理显存占用：
  - 模型权重：13B FP16 ≈ 26GB（固定）
  - KV Cache：13B、seq=2048、batch=32 ≈ 80GB+（吃大头）

为什么 KV Cache 大？
  每层每头都要存 K、V 矩阵
  层数 × 头数 × seq_len × hidden_dim × 2（K+V）
  13B 模型：40 层 × 40 头 × 2048 × 128 × 2 × 2B（FP16）≈ 80GB
```

**结论**：KV Cache 才是显存杀手，传统连续分配下利用率只有 20-40%。

## 二、传统 KV Cache 分配的问题

```
传统：每请求预分配 max_seq_len 的连续显存
  请求 A（实际输出 100 token，预分配 2048）→ 浪费 1948 槽
  请求 B（实际输出 2000 token）→ 正好
  并发多了显存碎掉，无法利用碎片空间
```

**问题**：
- **内部碎片**：预分配 max 用不满（实际输出短）
- **外部碎片**：请求退出后显存空洞难复用
- **batch 上不去**：显存不够 batch 多个请求

## 三、PagedAttention：分页管理 KV

灵感来自 OS 虚拟内存分页。

```
逻辑 KV（连续）           物理 KV（block，每块 16 个 token 槽）
[请求 A 逻辑]              Block 表（页表）
token0-15  → Block 1       A: [Block1, Block5, Block8]
token16-31 → Block 5
token32-47 → Block 8       B: [Block2, Block3]
```

**机制**：
1. KV Cache 切成固定大小 block（默认 16 token）
2. 每请求有"页表"映射逻辑 → 物理 block
3. 按需申请 block（生成新 token 才申请新 block）
4. 请求退出 → block 归还池子复用

**效果**：
- 显存利用率 20% → 90%+
- 同样显存能 batch 更多请求
- 吞吐提升 2-4 倍

## 四、注意力计算改造

标准 Attention：
```
Q × K^T → softmax → × V
```

PagedAttention 的 K/V 分散在 block 中，要在 kernel 里按页表读取并计算。vLLM 用 CUDA/TileLang 重写了 attention kernel。

```python
# 简化逻辑
def paged_attention(query, block_table, kv_cache):
    for block_idx in block_table:
        block = kv_cache[block_idx]              # 按页表取 block
        scores = query @ block.K.T / sqrt(d)
        attn = softmax(scores) @ block.V
    return sum(attn)
```

## 五、Continuous Batching（连续批处理）

传统 batching（static batching）：
```
请求 A、B、C 进 batch，A 短先结束，要等 B、C 都完才能开始新批次
GPU 大部分时间空等
```

Continuous Batching：
```
请求 A 结束 → 立刻让请求 D 加入 batch
GPU 持续满载
```

**效果**：相比 static batching 吞吐再翻倍。

## 六、Prefix Caching（前缀缓存）

```
大量请求共享 system prompt：
"你是一个电商客服，请回答用户问题..."（前缀）
+
不同用户输入（后缀）

传统：每个请求都重新计算前缀 KV
vLLM：前缀 KV 缓存复用（命中省一大半计算）
```

**效果**：共享前缀场景吞吐再提升 2-5 倍。

## 七、使用 vLLM

```bash
# 启动服务（OpenAI 兼容 API）
python -m vllm.entrypoints.openai.api_server \
    --model Qwen/Qwen2-7B-Instruct \
    --tensor-parallel-size 2 \                # 2 卡张量并行
    --max-model-len 8192 \
    --gpu-memory-utilization 0.9 \
    --enable-prefix-caching
```

```python
# 客户端
from openai import OpenAI
client = OpenAI(base_url="http://localhost:8000/v1", api_key="EMPTY")

resp = client.chat.completions.create(
    model="Qwen/Qwen2-7B-Instruct",
    messages=[{"role": "user", "content": "你好"}],
    stream=True,                                # 流式
)
```

## 八、vLLM vs 其他推理框架

| 框架 | 优势 | 劣势 |
|------|------|------|
| **vLLM** | PagedAttention、易用、开源社区活跃 | 非 NVIDIA 优化最深 |
| **TensorRT-LLM** | NVIDIA 官方，极致优化，支持最新卡 | 部署复杂，需模型转换 |
| **TGI**（HF） | 简单易上手 | 吞吐不如 vLLM |
| **lightLLM** | 轻量、模块化 | 生态小 |
| **DeepSpeed-FastGen** | Dynamic Splitfuse | 主要服务 DS 生态 |

**拼多多选型**：通用场景 vLLM，极致性能用 TensorRT-LLM。

## 九、底层本质

vLLM 本质是**"用 OS 虚拟内存思路管理 LLM 的 KV Cache 显存"**——PagedAttention 解决显存碎片，Continuous Batching 解决 GPU 空等，Prefix Caching 解决共享前缀重复计算。三者叠加让 LLM 推理吞吐提升数倍，是 LLM 工程化的关键工程优化。

## 常见考点

1. **PagedAttention 为什么快**？——解决碎片（利用率 20%→90%）+ 按需分配（短输出不浪费）+ block 池化复用。
2. **怎么估 LLM 推理显存**？——权重 + KV Cache + 激活；KV = 2 × L × H × seq × d × batch × 2B（FP16）。
3. **vLLM 限制**？——某些自定义 attention 不支持；首 token 延迟可能比 TRT-LLM 高（首 token 没 batching）。
