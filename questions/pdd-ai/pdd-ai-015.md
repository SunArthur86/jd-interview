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
