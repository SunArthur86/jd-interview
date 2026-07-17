---
id: pdd-ai-015
difficulty: L4
category: pdd-ai
subcategory: LLM 推理
tags:
- 拼多多
- AI 中台
- KV Cache
- Prefill
- Decode
- 显存
feynman:
  essence: KV Cache 是"把 Transformer 每层的 K/V 缓存下来避免重复计算"，让自回归生成只算当前 token；理解它的来源/大小/复用/管理是 LLM 推理优化的基础。
  analogy: 像背单词——每读一个新单词（新 token），把之前的释义（K/V）记在笔记本（Cache）上，下次直接翻笔记本不用重读。
  first_principle: 自回归生成每个新 token 都要看前面所有 token 的 K/V，不缓存就要从头算，复杂度 O(n²)；缓存后 O(n)。
  key_points:
  - 来源：每层 Self-Attention 的 K = W_K·x，V = W_V·x
  - 大小：2 × L × H × seq × d × 2B（FP16）
  - Prefill 阶段：计算全部 prompt KV（算力瓶颈）
  - Decode 阶段：增量算新 token KV（显存带宽瓶颈）
  - 复用：Prefix Caching（共享前缀）/多请求共享
first_principle:
  problem: 怎么让自回归生成不被重复计算拖垮？
  axioms:
  - 每个新 token 要看全部历史
  - 历史 K/V 不变可缓存
  - 显存有限要高效管理
  rebuild: KV Cache（缓存历史 K/V）+ Prefill/Decode 分阶段 + 分页管理。
follow_up:
  - KV Cache 为什么这么大？——每层每头每 token 都要存 K 和 V，乘以 seq_len
  - 怎么减少 KV Cache？——MQA/GQA（共享头）、量化（INT8/FP8）、滑动窗口
  - 多请求能共享 KV 吗？——Prefix Caching（共享 system prompt）
memory_points:
  - 来源：每层 K/V = W·x
  - 大小：2·L·H·seq·d·2B
  - Prefill 算力瓶颈，Decode 带宽瓶颈
  - 减优：MQA/GQA/量化/滑窗
---

# 【拼多多 AI 中台】KV Cache 原理是什么？怎么估算大小？

> JD 依据："KV Cache、推理加速"。

## 一、KV Cache 是什么

Transformer Self-Attention：
```
输入 x → K = W_K·x, V = W_V·x, Q = W_Q·x
Attention(Q, K, V) = softmax(Q·K^T / √d) · V
```

**自回归生成**：生成第 t 个 token 时要算第 1~t 个 token 的 Q·K^T。

**问题**：前 t-1 个 token 的 K/V 在之前 token 生成时算过且不变，重复计算浪费。

**解决**：缓存历史 K/V，生成新 token 只算当前 token 的 K/V 追加到 cache。

```
生成 token t:
  新 K_t = W_K · x_t，新 V_t = W_V · x_t
  cache_K = [K_1, K_2, ..., K_{t-1}, K_t]   ← 追加
  cache_V = [V_1, V_2, ..., V_{t-1}, V_t]
  Attention = softmax(Q_t · cache_K^T) · cache_V
```

## 二、KV Cache 大小估算

```
单 token KV 大小 = 2（K 和 V）× 层数 L × 头数 H × 头维度 d × 精度字节数
                = 2 · L · H · d · 2B（FP16）

注意：H · d = hidden_dim
所以单 token KV = 2 · L · hidden_dim · 2B（FP16）

序列 KV = 单 token KV · seq_len · batch_size
```

**示例**（13B 模型，FP16，单请求 seq=2048）：
```
13B 模型典型：L=40, hidden_dim=5120
单 token KV = 2 · 40 · 5120 · 2 = 1.6 MB
seq 2048 单请求 = 1.6 · 2048 ≈ 3.2 GB
batch=32 = 102 GB（远超 26GB 权重）
```

**结论**：KV Cache 是显存大头，超过模型权重数倍。

## 三、Prefill 和 Decode 两个阶段

### Prefill 阶段（处理 prompt）
```
输入：完整的 prompt（如 2000 token）
计算：一次性算全部 prompt 的 K/V（矩阵乘，算力密集）
耗时：几秒（首 token 延迟主要来源）
瓶颈：算力（GPU FLOPS）
```

### Decode 阶段（逐 token 生成）
```
输入：每次一个新 token
计算：新 K/V 追加 + 算 attention（向量乘，访存密集）
耗时：每 token 几十毫秒
瓶颈：显存带宽（不是算力！）
```

**关键洞察**：
- Prefill 是算力瓶颈 → 用 batching 提升利用率
- Decode 是带宽瓶颈 → batching 能分摊带宽开销（vLLM 优势）

## 四、PD 分离（Prefill-Decode Disaggregation）

把 Prefill 和 Decode 拆到不同集群/实例：
```
Prefill 集群（算力强，HBM 大）：处理 prompt 阶段
Decode 集群（带宽优化，KV Cache 池化）：逐 token 生成

Prefill 算完 KV → 通过 RDMA 传给 Decode → Decode 继续生成
```

**优势**：
- 各自优化硬件配置（Prefill 用 H100，Decode 用 L4）
- 资源利用率最大化（不互相阻塞）
- KV Cache 可在 Decode 集群池化复用

**代表**：DeepSeek-V3、Mooncake、Splitwise。

## 五、KV Cache 优化方向

### 1. MQA / GQA（减少头数）
```
MHA（标准）：每头独立 K/V → KV 大
MQA（Multi-Query）：所有头共享一组 K/V → KV 小 H 倍
GQA（Grouped-Query）：分组共享（折中）→ KV 小 G 倍
```

Llama 2/3 用 GQA，KV Cache 减少数倍。

### 2. KV Cache 量化
```
FP16 → INT8/INT4：显存减半/4 倍
注意量化误差，长序列可能掉点
```

### 3. 滑动窗口（Sliding Window）
```
只缓存最近 N 个 token 的 KV（滑动窗口）
KV = N（固定，不随 seq 增长）
适合超长上下文（如 Mistral 用 4096 滑窗）
```

### 4. KV Eviction（淘汰）
```
长上下文中按重要性淘汰部分 KV（如 H2O 算法保留 top-k 重要 token）
精度换显存
```

### 5. PagedAttention（见专题）
分页管理，利用率从 20% 提升到 90%+。

### 6. Prefix Caching
共享 system prompt 的 KV Cache，多请求复用。

## 六、Java 业务侧的 KV Cache 感知

业务层无法直接管 KV Cache（vLLM 内部），但要：
```java
// 1. 控制上下文长度（避免 KV 爆炸）
if (tokens(prompt) > MAX_CTX) prompt = truncate(prompt);

// 2. 复用 system prompt（享受 Prefix Caching）
List<Message> msgs = new ArrayList<>();
msgs.add(systemPrompt);          // 固定（缓存）
msgs.add(new Message(role, user)); // 变化

// 3. 流式生成（减少长输出 KV 占用）
client.chatCompletions(req).stream()...

// 4. 监控显存（避免 OOM）
monitorGpuMemory();
```

## 七、底层本质

KV Cache 本质是**"用空间换时间——缓存历史 K/V 避免自回归重复计算"**。它的爆炸性增长（随 seq × batch）是 LLM 推理瓶颈的根源。理解 KV Cache 大小估算、Prefill/Decode 阶段差异、各种减优手段（MQA/量化/滑窗/分页/PD 分离）是 LLM 推理优化的核心。

## 常见考点

1. **KV Cache 和激活的关系**？——KV Cache 是历史 K/V 矩阵（需持久保存），激活是当前 token 的中间结果（用完丢弃）。
2. **为什么 Decode 阶段带宽瓶颈**？——每 token 都要读全部 KV Cache 做点积，访存量远大于算力消耗。
3. **MQA 为什么掉点少**？——K/V 共享但 Q 仍多头，保留多头表达能力；实测效果接近 MHA 但省显存。

## 苏格拉底式面试追问

> 这组追问不背答案，模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：KV Cache 占了 LLM 推理显存的 80%+，那为什么不直接不缓存 KV，每次重新算？反正 GPU 算力够，重算 K/V 不就是一个矩阵乘法吗？**

重算的代价是"O(n²) 复杂度爆炸"。自回归生成每输出一个新 token，都要计算它和之前所有 token 的 attention，如果不缓存 KV，每生成一个 token 都要重算前面所有 token 的 K/V（`W_K · x_prev`），然后做 `Q·K^T`。对于 seq_len=2048、batch=32 的请求，每生成一个新 token 要重算 2048 次 K/V 矩阵乘 + 2048×2048 的 attention score，单 token 的计算量等于完整 Prefill。生成 200 个 token 的总计算量 = 200 × 完整 Prefill = 200 倍。缓存 KV 后，每生成一个 token 只算新 token 的 K/V（1 次）+ 增量 attention（Q·K^T 是 1×2048），复杂度从 O(n²) 降到 O(n)。GPU 算力够是没错，但"算力是带宽瓶颈下的算力"——重算要把权重重新从显存读到计算单元，带宽消耗也是 200 倍。KV Cache 是"用显存换计算+带宽"的经典 trade-off，在 LLM 这种自回归场景是必须的。

### 第二层：证据与定位

**Q：线上推理服务 P99 延迟 800ms，但你发现 Decode 阶段的 GPU 利用率才 20%。Decode 不是在算 token 吗？为什么 GPU 不忙？**

Decode 阶段是"显存带宽瓶颈"而非"算力瓶颈"。第一，**Decode 的计算特征**——每生成一个 token，要计算 `Q · K^T`，其中 Q 是当前 token（1×d），K 是历史所有 token 的 KV Cache（seq_len×d）。这个矩阵乘的算力消耗很小（1×d × d×seq_len = d×seq_len FLOPs，d=4096、seq=2048 约 8M FLOPs，GPU 算 0.01ms），但要从显存读整个 KV Cache（seq_len × num_layers × 2 × d × 2B，13B 模型 seq=2048 约 1.6GB），显存读取耗时（1.6GB / 2TB/s = 0.8ms）。所以 Decode 是"读 KV Cache 花了 0.8ms，计算只花 0.01ms"，GPU 算力单元闲置（算力利用率 1%），但显存带宽利用率 100%。第二，**为什么 GPU 利用率显示 20%**——`nvidia-smi` 的 GPU utilization 是"过去采样周期内有 kernel 执行的时间比例"，Decode 时 kernel 在执行（只是等显存），所以显示有活动，但算力没用满。真正要看的指标是 `dram_read_throughput`（显存带宽利用率），Decode 时应该接近峰值（2TB/s）。

### 第三层：根因深挖

**Q：既然 Decode 是带宽瓶颈，那增加 batch_size 是不是就能提升吞吐？batch=32 时每次读 KV Cache 是 32×1.6GB=51GB，batch=128 时是 204GB，显存带宽被更充分利用了，GPU 利用率应该上去？**

分析正确，batch 增大确实提升 Decode 的算力利用率，但有上限。第一，**算力利用率随 batch 线性提升**——batch=1 时 Q·K^T 是 1×d × d×seq，算力消耗小；batch=128 时是 128×d × d×seq，算力消耗是 batch=1 的 128 倍，而 KV Cache 读取量也是 128 倍（每请求独立 KV Cache），所以"算力/带宽比"不变，但总算力和总带宽都上去了，GPU 更满载。第二，**上限是显存容量**——batch=128、seq=2048、13B 模型的 KV Cache 总量 = 128 × 1.6GB = 204GB，A100 80G 放不下（OOM）。所以 batch 上限由"显存容量 / 单请求 KV Cache"决定。第三，**Continuous Batching 的动态平衡**——vLLM 会根据"当前可用显存 + 各请求的 KV Cache 大小"动态调整 batch_size，新请求加入、老请求完成退出，batch 在波动中最大化吞吐。解法：增大 batch 不是手动调参，是"保证显存足够（降 gpu_memory_utilization 留 buffer）+ 开启 Continuous Batching（自动调 batch）"。

**Q：那 KV Cache 这么占显存，有没有办法"压缩"它？除了 MQA/GQA 还有别的技术吗？**

KV Cache 压缩有四个层次。第一，**MQA/GQA（结构压缩）**——MQA 所有 head 共享一组 K/V（num_kv_heads=1），GQA 分组共享（如 8 组），KV Cache 从 `num_heads × seq × d` 降到 `num_kv_heads × seq × d`，省 4-8 倍。但这是"模型架构层面的"，推理引擎改不了（模型已经训好）。第二，**量化（精度压缩）**——KV Cache 从 FP16 量化到 INT8/FP8，省 2 倍显存。vLLM 支持 `kv_cache_dtype=fp8`，精度损失 < 1%。第三，**滑动窗口（长度压缩）**——只保留最近 N 个 token 的 KV Cache（如 sliding_window=4096），丢弃更早的 KV，省显存。Mistral/Gemma 用这个技术，但会损失长距离依赖（超过窗口的 token 互相看不到）。第四，**PagedAttention + 前缀缓存（复用压缩）**——多个请求共享相同前缀（如 system prompt）的 KV Cache，vLLM 的 `enable_prefix_caching=true` 自动复用，100 个请求共享 2K system prompt，省 100× 的重复 KV。生产选择：量化（通用，2 倍）+ 前缀缓存（业务相关，N 倍）是性价比最高的组合。

### 第四层：方案权衡

**Q：KV Cache 量化到 FP8 能省 2 倍显存，但精度损失 1%。客服场景能接受吗？会不会导致"回答质量下降被投诉"？**

1% 的精度损失要看"什么指标"和"业务影响"。第一，**精度损失的度量**——FP8 KV Cache 的 benchmark（vLLM 官方数据）：perplexity（语言模型困惑度）涨 0.5-1%（几乎无感），但"长文本生成"（seq > 4K）的退化更明显（2-3%），因为 FP8 的表示范围有限，长序列的 KV 值累积误差。第二，**业务影响**——客服场景的输出长度短（200-500 token），FP8 的退化在 1% 内，用户无感（准确率从 88% 降到 87.5%，统计不显著）；但"文档摘要"（输入 8K、输出 2K）的退化可能更明显（关键信息遗漏）。第三，**生产决策**——先用 FP8 KV Cache 灰度 5% 流量，A/B 测试 1 周，对比 `user_satisfaction`（点赞率）和 `task_completion_rate`（任务完成率），如果退化 < 0.5% 且用户无投诉，全量；否则回退 FP16。不要凭"1% 精度损失"拍板，要业务指标说话。FP8 在"显存紧张 + 短输出"场景值得，在"长文本 + 质量敏感"场景谨慎。

**Q：那为什么不用 KV Cache 的"offload 到 CPU 内存"技术？GPU 显存不够就把 KV Cache 放 CPU 内存，用的时候再读回来，不是更灵活吗？**

CPU offload 的代价是"PCIe 带宽瓶颈"。第一，**PCIe 带宽不够**——A100 的 HBM 带宽是 2TB/s，PCIe Gen4 是 64GB/s（差 30 倍）。KV Cache offload 到 CPU 后，每次 Decode 都要通过 PCIe 读回 GPU（1.6GB / 64GB/s = 25ms），Decode 延迟从 0.8ms 飙到 25ms（30 倍慢），完全不可用于实时推理。第二，**适用场景**——offload 适合"离线批处理"（延迟不敏感，算得多慢都行），用大 CPU 内存存大量请求的 KV Cache，GPU 慢慢算。不适合在线服务。第三，**更好的替代方案**——如果显存不够，优先用 PD 分离（Prefill 和 Decode 分机群，各自最大化显存利用）或量化（省 2 倍显存），而不是 offload（牺牲延迟）。CPU offload 是"最后手段"（显存极度紧张且延迟不敏感），不是首选。DeepSpeed 的 Zero-Inference 用 offload，但主要用于"单卡跑超大模型"（研究/演示），不是高吞吐生产场景。

### 第五层：验证与沉淀

**Q：你怎么证明"前缀缓存"真的提升了吞吐？系统 prompt 是固定的，但用户的 query 不同，怎么量化前缀复用的收益？**

三个指标量化。第一，**prefix_cache_hit_rate**——vLLM 暴露的指标 `vllm:prefix_cache_hit_rate`，统计 KV Cache 的 block 复用比例。如果 system prompt 是 1K token、用户 query 平均 100 token，前缀复用率应该是 1K/(1K+100)=91%。hit_rate 越高，省的 KV 计算越多。第二，**TTFT（首 token 延迟）下降**——前缀缓存命中时，system prompt 的 KV 不用重新计算（省 1K token 的 Prefill 时间，约 50ms），TTFT 从 150ms 降到 100ms。监控 `vllm:time_to_first_token_p50` 和 `p99`，启用前缀缓存后应降 30-50%。第三，**throughput（吞吐）提升**——省下的 Prefill 计算资源可以服务更多请求，整体 tokens/s 提升 20-40%（取决于前缀占比）。A/B 验证：开启/关闭 `enable_prefix_caching`，对比同时段的吞吐和 TTFT，连续 1 周数据证明收益。注意：前缀缓存的前提是"system prompt 一致"，如果不同业务的 prompt 不同（客服/搜索/代码），前缀命中率低，收益小。

**Q：KV Cache 管理的经验怎么沉淀，让新模型上线时不再手动调参？**

三件事。第一，**显存计算器**——做一个工具，输入模型参数（num_layers/num_heads/d）+ 硬件（GPU 显存）+ 业务约束（max_seq_len/batch_size），输出 KV Cache 占用、可用 batch、推荐 `gpu_memory_utilization`。新模型上线时跑一遍，不用手算。公式：`kv_cache_size = 2 × num_layers × num_kv_heads × seq_len × head_dim × 2B × batch_size`。第二，**配置模板**——按模型类型（7B/13B/70B）+ GPU 类型（A100/H100）预设 vLLM 配置模板（max_model_len、gpu_memory_utilization、max_num_batched_tokens），新模型查模板套用。第三，**KV Cache 监控**——Prometheus 采集 `vllm:gpu_cache_usage_perc`（KV Cache 池使用率）、`vllm:prefix_cache_hit_rate`（前缀命中率）、`vllm:kv_cache_free_blocks`（空闲 block 数），低于阈值告警。把 KV Cache 当成"需要持续监控和调优的资源"，而不是"配一次就不管"。

## 结构化回答

**30 秒电梯演讲：** 怎么让自回归生成不被重复计算拖垮？简单说就是——KV Cache 是"把 Transformer 每层的 K/V 缓存下来避免重复计算"，让自回归生成只算当前 token；理解它的来源/大小/复用/管理是 LLM 推理优化的基…。大小：2·L·H·seq·d·2B；Prefill 算力瓶颈，Decode 带宽瓶颈。

**展开框架：**
1. **来源** — 来源：每层 K/V = W·x
2. **大小** — 大小：2·L·H·seq·d·2B
3. **Prefill 算力瓶颈** — Prefill 算力瓶颈，Decode 带宽瓶颈

**收尾：** 您想继续往深里聊吗——比如「KV Cache 为什么这么大？」

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：KV Cache 原理是什么？怎么估算大小？ | 今天聊「KV Cache 原理是什么？怎么估算大小？」。一句话：KV Cache 是"把 Transformer 每层的 K/V 缓存下来避免重复计算"，让自回归生成只算当前 tok… | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：来源：每层 K/V = W·x | 核心概念 |
| 0:51 | 能力/参数拆解表 | 要点是：大小：2·L·H·seq·d·2B | 能力拆解 |
| 1:30 | 流程图：输入→处理→输出 | 要点是：Prefill 算力瓶颈，Decode 带宽瓶颈 | 关键机制 |
| 2:09 | 代码片段 + 注释高亮 | 要点是：减优：MQA/GQA/量化/滑窗 | 实战要点 |
| 3:00 | 总结卡 + 下期预告 | 记住这些核心点就够了。下期我们接着聊——KV Cache 为什么这么大？。 | 收尾 |
