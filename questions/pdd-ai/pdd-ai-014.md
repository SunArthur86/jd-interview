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

## 苏格拉底式面试追问

> 这组追问不背答案，模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：你说 vLLM 的核心是 PagedAttention。但传统推理框架（HuggingFace Transformers）也能跑 LLM，为什么非要用 PagedAttention？传统连续分配 KV Cache 的"碎片"到底有多大？**

碎片浪费随序列长度放大。传统推理为每个请求预分配"最大可能长度"的连续 KV Cache（比如 max_seq_len=2048），但实际请求的输出长度可能只有 100 token（剩下 1948 token 的空间空着不能给别人用）。假设 batch=32、max_seq=2048、实际平均输出 200 token，显存利用率只有 200/2048=10%，剩下 90% 是"内部碎片"（预分配但没用）。再加上"外部碎片"（请求结束释放后留下不连续的小块，新请求用不上），传统推理的有效显存利用率约 20-40%。PagedAttention 把 KV Cache 切成固定大小的 block（比如每 block 16 token），按需分配——请求生成多少 token 就分配多少 block，利用率提升到 90%+。同样的 GPU（A100 80G），传统推理 batch=32，vLLM batch=128+，吞吐差 4 倍。这不是"优化"，是"管理方式的本质区别"。

### 第二层：证据与定位

**Q：vLLM 上线后吞吐确实高了，但偶发 OOM（`torch.cuda.OutOfMemoryError`）。`gpu_memory_utilization=0.9` 已经留了 10% buffer，为什么还 OOM？**

vLLM 的 OOM 原因和传统 PyTorch 不同。第一，**`gpu_memory_utilization` 是初始预估，不是硬限制**——vLLM 启动时算"模型权重 + 激活 + KV Cache 池 = 0.9 × 总显存"，但运行时如果 batch 突然增大（流量峰值），激活显存（attention 中间矩阵）可能超预估，挤占 KV Cache 池导致 OOM。排查：看 vLLM 的 `vllm:gpu_cache_usage_perc` 指标（KV Cache 池使用率），如果接近 100% 说明池满了。第二，**`max_num_batched_tokens` 设太大**——这个参数控制单 batch 最大 token 数（比如 8192），如果设太大，batch 里有长 prompt 请求时激活显存暴增。排查：看 vLLM 日志的 `# tokens in batch`，峰值是否超预期。第三，**PyTorch 临时张量碎片**——vLLM 用 PyTorch 做 attention 计算，中间张量（如 attention score 矩阵）分配/释放会产生碎片，长期运行后可用显存减少。解法：降 `gpu_memory_utilization` 到 0.85、降 `max_num_batched_tokens`、重启 vLLM 释放碎片（治标）。

### 第三层：根因深挖

**Q：你发现 OOM 发生在"长 prompt 请求突增"时（比如用户传了 8K token 的文档做摘要）。但单个 8K prompt 的 KV Cache 才 100MB，A100 80G 怎么会不够？**

根因是"Prefill 阶段的激活显存爆炸"。长 prompt 的 Prefill（一次性计算所有 prompt token 的 KV）不是 KV Cache 大，而是**中间激活张量大**。Self-Attention 的中间步骤：`Q·K^T` 生成一个 `[batch, num_heads, seq_len, seq_len]` 的矩阵，seq_len=8192 时这个矩阵是 8192×8192×num_heads×FP16，单头 128MB，32 头 = 4GB，batch=4 就是 16GB 的瞬时张量。这就是为什么 FlashAttention 重要——它把这个大矩阵分块计算（不会同时存在 8192×8192 的完整矩阵），激活显存从 16GB 降到 1GB。排查方法：在 vLLM 启动参数加 `--enforce-eager`（禁用 CUDA Graph，看是否还 OOM）、加 `VLLM_LOGGING_LEVEL=DEBUG` 看 OOM 时的 batch 组成（有没有超长 prompt）。解法：限制 `max_model_len=4096`（拒绝超长 prompt）、开启 FlashAttention（`--dtype half` + 默认 flash_attn）、用 Chunked Prefill（vLLM 的 `--enable-chunked-prefill`，把长 prompt 切块算）。

**Q：那为什么不全用 FlashAttention？还有不用 FlashAttention 的场景吗？**

FlashAttention 不是"有就行"，有版本和兼容性限制。第一，**版本差异**——FlashAttention v1 不支持 sliding window attention（Mistral 用的），v2 支持但要求 CUDA 11.8+，vLLM 默认用 v2，但老 GPU（如 V100）不支持（需要 Ampere 架构 SM80+）。第二，**模型兼容性**——FlashAttention 假设 attention mask 是因果的（下三角），但有些模型用自定义 mask（如 prefix-LM、文档级 attention），FlashAttention 不支持，只能回退到标准 attention（慢但兼容）。第三，**精度差异**——FlashAttention 用 FP16/BF16 计算，某些对精度敏感的场景（如长文本生成、数学推理）可能要 FP32 的标准 attention。生产选择：能用 FlashAttention 就用（vLLM 默认开），不能用的（老 GPU/自定义 mask）用 PagedAttention 的 fallback（flash_attn=False）。监控 `attention_impl` 指标，确认实际用的是 flash_attn 而不是标准 attention（否则性能差 2-3 倍）。

### 第四层：方案权衡

**Q：vLLM 和 TensorRT-LLM 怎么选？TRT-LLM 单次延迟更低，但部署复杂。你们选了 vLLM，理由是什么？**

vLLM 适合"快速迭代 + 通用性"，TRT-LLM 适合"极致延迟 + 固定模型"。**vLLM 的优势**：第一，易用——`pip install vllm` + `python -m vllm.entrypoints.openai.api_server --model xxx`，3 行命令跑起来；TRT-LLM 要先 `trtllm-build` 编译引擎（每个模型 + GPU 架构单独编译，30 分钟-2 小时）。第二，灵活性——vLLM 支持动态加载模型（换模型重启即可）、LoRA 适配器热加载；TRT-LLM 的引擎是"编译期固定"的，改模型要重新编译。第三，社区——vLLM 开源活跃（GitHub 20k+ star），新模型支持快（Llama3/Qwen 发布 1 周内 vLLM 支持）。**TRT-LLM 的优势**：延迟低 20-30%（kernel 融合 + 平铺优化 + INT8/FP8 原生支持），适合"延迟敏感 + 模型固定"的场景（如实时对话、要求 TTFT < 200ms）。**拼多多实践**：客服场景（模型迭代频繁）用 vLLM（灵活），搜索广告（延迟极致要求）用 TRT-LLM（性能）。不是"二选一"，而是按场景选。

**Q：为什么不用自己写一个推理引擎？拼多多有足够强的工程团队，自研能针对性优化（针对电商场景）。**

自研推理引擎的投入产出比不划算。第一，**技术深度**——推理引擎的核心是 CUDA kernel 优化（PagedAttention、FlashAttention 的 kernel 要手写 PTX 汇编级优化），需要顶级 GPU 编程专家（NVIDIA 背景/博士级），这种人才稀缺且贵，拼多多招齐一个 10 人核心团队要 1-2 年。第二，**生态追赶**——vLLM/TRT-LLM 每月迭代（新模型支持、新优化），自研引擎要持续追赶，落后一个版本就支持不了新模型（如 Llama3 发布后 2 周内业务就要用）。第三，**投入产出**——自研引擎的性能提升可能只有 10-20%（vLLM 已经很优了），但投入 10 人×2 年 = 几千万成本，不如把人力投在"推理平台的工程化"（网关/调度/监控/PD 分离）上，价值更高。自研只在"有独特需求且开源不满足"时才值得（比如字节有 Whale 引擎是因为 MoE 训推一体化需求）。拼多多用 vLLM + 在其上做增量优化（PD 分离、前缀缓存适配业务），是性价比最高的选择。

### 第五层：验证与沉淀

**Q：你怎么证明 vLLM 的 PagedAttention 比传统推理（HF Transformers）吞吐高 3 倍？有什么客观指标？**

三个指标对比。第一，**throughput（tokens/s）**——固定 batch_size=32、seq_len=512，跑 Llama2-7B 推理，HF Transformers 的 throughput 约 500 tokens/s，vLLM 约 2000 tokens/s（4 倍）。用 vLLM 自带的 `benchmark_throughput.py` 工具测。第二，**concurrent_requests（最大并发）**——固定延迟约束（P99 < 1s），vLLM 能支撑的并发请求数是 HF 的 3-5 倍（因为 KV Cache 利用率高，能 batch 更多请求）。用 `benchmark_serving.py`（模拟多用户并发）测。第三，**GPU utilization（MFU）**——vLLM 的 GPU 利用率峰值 80%+（持续有请求在算），HF Transformers 约 30-40%（大量时间在等 KV Cache 分配/释放）。三个指标从不同维度（吞吐、并发、利用率）证明 vLLM 的优势。注意：对比要控制变量（同模型、同 GPU、同输入），否则不公平。

**Q：vLLM 长期运营怎么避免"升级后性能退化"或"新模型支持有 bug"？**

三件事。第一，**回归测试集**——维护一套 benchmark 数据集（1000 个不同长度的 prompt），每次 vLLM 升级（或换模型）后跑 benchmark，对比 throughput/TTFT/TPOT，指标退化 > 5% 不上线。第二，**canary 发布**——新版本 vLLM 先灰度到 1 个实例（canary），网关分 5% 流量过去，观察 30 分钟的 `error_rate`、`latency_p99`、`oom_count`，无异常才全量。第三，**版本锁定 + 滚动升级**——生产环境锁定 vLLM 版本（如 v0.6.0），升级时新版本和旧版本并行运行（双跑对比 1 天），确认无 regression 再切流。vLLM 迭代快但偶尔有 regression（新版本的 Continuous Batching 策略调整可能影响某些 workload），不能盲目追新。监控 `vllm_version` 标签，每个版本的性能指标单独统计，便于发现问题。

## 结构化回答

**30 秒电梯演讲：** LLM 推理显存被 KV Cache 吃光、batch 上不去，怎么提升吞吐？简单说就是——vLLM 是"为 LLM 推理量身定制的高吞吐引擎"，核心是 PagedAttention（像 OS 虚拟内存管理 KV Cache），把显存碎片降到极低，吞吐提升 2-4 倍。PagedAttention 分页管理（block + 页表）；Continuous Batching 动态组批。

**展开框架：**
1. **KV Cac** — KV Cache 是显存大头（80%+）
2. **PagedA** — PagedAttention 分页管理（block + 页表）
3. **Contin** — Continuous Batching 动态组批

**收尾：** 您想继续往深里聊吗——比如「vLLM 和 TensorRT-LLM 区别？」

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：vLLM 和 PagedAttention 原理是什么？ | 今天聊「vLLM 和 PagedAttention 原理是什么？」。一句话：vLLM 是"为 LLM 推理量身定制的高吞吐引擎"，核心是 PagedAttention（像 OS 虚拟内存管理 K… | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：KV Cache 是显存大头（80%+） | 核心概念 |
| 0:51 | 能力/参数拆解表 | 要点是：PagedAttention 分页管理（block + 页表） | 能力拆解 |
| 1:30 | 流程图：输入→处理→输出 | 要点是：Continuous Batching 动态组批 | 关键机制 |
| 2:09 | 代码片段 + 注释高亮 | 要点是：吞吐 2-4x HF | 实战要点 |
| 3:00 | 总结卡 + 下期预告 | 记住这些核心点就够了。下期我们接着聊——vLLM 和 TensorRT-LLM 区别？。 | 收尾 |
