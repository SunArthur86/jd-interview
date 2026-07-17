---
id: biopharm-026
difficulty: L4
category: biopharm
subcategory: LLM 推理
tags:
- 生物医药
- AI 全栈
- LLM 推理
- vLLM
- KV Cache
- 量化
- 批处理
feynman:
  essence: "LLM 推理优化是'用更少 GPU 算更多 token'——vLLM 的 PagedAttention+连续批处理提吞吐，KV Cache 复用减重复计算，量化降显存，让推理又快又省。"
  analogy: "像优化餐厅出餐——vLLM 是动态拼桌（不同请求凑一锅炒省燃气），KV Cache 是半成品预制（公共酱料不重熬），量化是小包装（同样冷库存更多食材）。三招让厨房吞吐翻倍。"
  first_principle: "LLM 推理是显存和算力密集（自回归逐 token 生成），瓶颈在显存带宽和 KV Cache 占用。推理优化的本质是'提升 GPU 利用率（批处理）、减少重复计算（KV Cache 复用）、降低显存占用（量化）'，把单位成本压下来。"
  key_points:
  - "vLLM：PagedAttention（显存分页）+ continuous batching（动态批），吞吐数倍"
  - "KV Cache：缓存注意力中间态，复用公共前缀（如系统 prompt）"
  - "量化：INT8/INT4 降显存换少量精度，多装请求"
  - "批处理：攒多请求一次推理，GPU 利用率↑"
  - "其他：投机解码/推测解码、张量并行、prefix caching"
  socratic:
  - "LLM 一个 token 一个 token 生成，GPU 大部分时间在干嘛？"
  - "100 个请求，一个一个推理 vs 攒一起推理，差别多大？"
  - "每个请求都带相同的系统 prompt，这部分能不能不算重复？"
  - "70B 模型要几百 GB 显存，普通卡跑不起，怎么办？"
  - "vLLM 为什么比原生 Transformers 快好几倍？"
first_principle:
  problem: "如何用更少 GPU 资源算出更多 token（提吞吐降成本）？"
  axioms:
  - "LLM 推理是显存/算力密集（自回归逐 token）"
  - "瓶颈在显存带宽和 KV Cache 占用"
  - "GPU 利用率低（逐 token 等待）"
  rebuild: "三招提效——vLLM（PagedAttention+连续批处理）提 GPU 利用率和吞吐、KV Cache 复用减重复计算、量化降显存多装请求，把单位 token 成本压到最低。"
follow_up:
- "PagedAttention 解决什么？——传统 KV Cache 预分配连续显存导致碎片/浪费，PagedAttention 像虚拟内存分页，按需分配，碎片↓利用率↑。"
- "量化损失多大？——INT8 几乎无损，INT4 小损（需校准）；用 AWQ/GPTQ 等量化算法保精度，关键场景 A/B 验证。"
- "投机解码是什么？——小模型先草拟多个 token，大模型并行验证，对的直接接受，减少大模型串行步数。"
memory_points:
- "vLLM：PagedAttention+连续批处理"
- "KV Cache 复用公共前缀"
- "量化 INT8/INT4 降显存"
- "瓶颈是显存带宽，非纯算力"
---

# 【生物医药 AI】LLM 推理怎么优化（vLLM/KV Cache/量化/批处理）？

> JD 依据："LLM 应用开发；系统性能优化；成本控制。"

## 一、LLM 推理的瓶颈

```
自回归生成：一个 token 一个 token 生成
每步要算 attention（读 KV Cache）+ 前馈
瓶颈：
  - 显存带宽（KV Cache 读写）而非纯算力
  - KV Cache 占用大（长上下文几十 GB）
  - 逐 token 生成，GPU 常常空等
→ GPU 利用率低，吞吐上不去
```

## 二、批处理（提利用率）

```
逐请求推理：
  req1 ▓▓▓▓ (生成中，GPU 利用 20%)
  req2      (排队)
  → 利用率低

批处理（Batch）：
  [req1, req2, req3, req4] 一次前向，并行生成
  → GPU 利用率 80%+，吞吐数倍
```
- **continuous batching（连续批处理）**：请求随到随拼进 batch，不等齐，动态进出（vLLM 核心特性）。
- 传统静态批处理要等齐 N 个或超时，连续批处理更高效。

## 三、vLLM（推理引擎首选）

### 核心创新：PagedAttention
```
传统 KV Cache：预分配连续显存 → 碎片/浪费（最长上下文预留）
PagedAttention：像虚拟内存分页，按需分配小块，避免碎片
→ 显存利用率↑，同显存能装更多请求
```

### continuous batching
- 请求动态进出 batch，GPU 持续满载。
- 配合 PagedAttention，vLLM 吞吐可达原生 Transformers 的数倍到数十倍。

### 其他特性
- Prefix caching（复用公共前缀 KV）。
- 张量并行（多 GPU 切分大模型）。
- 流式输出。

## 四、KV Cache 复用

```
每个请求都带相同系统 prompt（如人设/工具说明）：
  传统：每请求重算这部分 KV
  优化：缓存公共前缀的 KV，多请求复用
→ 省大量重复计算
```
- vLLM 的 prefix caching / SGLang 的 RadixAttention 都做这个。
- 适合：多请求共享长系统 prompt、多轮对话历史复用。

## 五、量化（降显存）

```
FP16（原始）→ INT8（显存减半，几乎无损）→ INT4（显存 1/4，小损）
```
| 精度 | 显存 | 精度损失 | 适用 |
|------|------|----------|------|
| FP16 | 基准 | 无 | 生产基线 |
| INT8 | 1/2 | 几乎无 | 推荐 |
| INT4 | 1/4 | 小（需校准） | 显存紧张 |

- 量化算法：AWQ / GPTQ / GGUF（CPU/边缘）。
- **效果**：同样显存装更大模型或更多请求，单 token 成本↓。
- 关键场景要 A/B 验证量化后质量（医药幻觉敏感）。

## 六、其他优化

| 技术 | 原理 |
|------|------|
| 投机解码 | 小模型草拟，大模型并行验证，减串行步 |
| 张量并行 | 大模型切分到多 GPU |
| 流水线并行 | 按层切分多 GPU |
| Prefix caching | 复用公共前缀 KV |
| Chunked prefill | 长 prompt 分块填充，平衡吞吐和延迟 |

## 七、选型与部署

```
推理引擎选型：
  vLLM —— 通用首选，吞吐高，社区活跃
  TGI（HuggingFace）—— 生产成熟
  SGLang —— 结构化输出/复杂控制强
  TensorRT-LLM —— NVIDIA 极致性能，部署复杂
  llama.cpp —— CPU/边缘部署

部署：
  多 GPU 张量并行（大模型）
  多副本负载均衡（高 QPS）
  按负载自动扩缩
```

## 八、底层本质

LLM 推理优化本质是**"提升 GPU 利用率、减少重复计算、降低显存占用"**。批处理（含连续批）提利用率，KV Cache 复用减重复，量化降显存，vLLM 把这些工程化集成。

**这是自部署 LLM 成本可控的核心** —— 不优化的推理 10 倍于优化后的成本，规模一大就是巨额差距。

## 常见考点

1. **vLLM 为什么快？**——PagedAttention 减显存碎片提利用率 + continuous batching 动态拼 batch 提吞吐 + prefix caching 减重复计算，三者叠加吞吐数倍。
2. **量化会不会降质量？**——INT8 几乎无损，INT4 小损（需校准和评测）；用 AWQ/GPTQ 保精度，关键场景 A/B 验证，幻觉敏感的医药要谨慎。
3. **怎么选推理引擎？**——通用 vLLM（吞吐高/社区强），结构化输出 SGLang，NVIDIA 极致 TensorRT-LLM，边缘 llama.cpp；按部署环境和需求选。


## 结构化回答

**30 秒电梯演讲：** 聊到LLM 推理怎么优化，我的理解是——LLM 推理优化是'用更少 GPU 算更多 token'——vLLM 的 PagedAttention+连续批处理提吞吐，KV Cache 复用减重复计算，量化降显存，让推理又快又省。打个比方，像优化餐厅出餐——vLLM 是动态拼桌（不同请求凑一锅炒省燃气），KV Cache 是半成品预制（公共酱料不重熬），量化是小包装（同样冷库存更多食材）。三招让厨房吞吐翻倍。

**展开框架：**
1. **vLLM** — PagedAttention（显存分页）+ continuous batching（动态批），吞吐数倍
2. **KV Cache** — 缓存注意力中间态，复用公共前缀（如系统 prompt）
3. **量化** — INT8/INT4 降显存换少量精度，多装请求

**收尾：** 这块我在项目里也踩过坑——想深入的话，可以接着聊：PagedAttention 解决什么？您更想看哪个方向？

## 视频脚本

> 预计时长：4 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡 | "LLM 推理怎么优化——这道题面试官到底想考什么？我用 30 秒给你讲透。" | 开场钩子 |
| 0:15 | 缓存架构图 | 先说核心：LLM 推理优化是'用更少 GPU 算更多 token'——vLLM 的 PagedAttention+连续批处理提吞吐，KV Cache 复用减重复计算，量化降显存，让推理又。 | 核心定义 |
| 0:50 | 推理优化对比图 | 缓存注意力中间态，复用公共前缀（如系统 prompt）。 | KV Cache |
| 1:20 | 模型量化对比表 | INT8/INT4 降显存换少量精度，多装请求。 | 量化 |
| 1:50 | 概念结构示意图 | 攒多请求一次推理，GPU 利用率↑。 | 批处理 |
| 3:30 | 总结卡 | 一句话记忆：vLLM：PagedAttention+连续批处理。 下期可以接着聊：PagedAttention 解决什么。 | 收尾总结 |
