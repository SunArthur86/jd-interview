---
id: pdd-trade-034
difficulty: L4
category: pdd-trade
subcategory: LLM 推理
tags:
- 拼多多
- 交易
- LLM 推理
- vLLM
- KV Cache
- 量化
feynman:
  essence: LLM 推理优化是"用更少 GPU 算更快的 token"——核心是 KV Cache 复用、Continuous Batching、量化（INT8/FP8）、投机解码、模型并行，把单卡吞吐拉到极限。
  analogy: LLM 推理像"餐厅出餐"——KV Cache 是预备食材（不重复切）、Continuous Batching 是动态拼桌（满负荷）、量化是简装盒饭（省成本）、投机解码是预炒半成品（加速）。
  first_principle: LLM 推理是显存带宽瓶颈（token 一个个生成、KV Cache 膨胀），优化围绕"复用+压缩+并行"。
  key_points:
  - KV Cache：避免重复算历史 token
  - Continuous Batching：动态拼 batch，GPU 不闲
  - 量化：INT8/FP8 降显存提吞吐
  - 投机解码：小模型草稿+大模型校验
  - 模型并行：TP/PP 跨卡
first_principle:
  problem: LLM 推理慢且贵（显存带宽瓶颈），如何提升吞吐降成本？
  axioms:
  - 自回归生成是串行
  - KV Cache 占大显存
  - GPU 贵
  rebuild: KV Cache 复用 + 动态 Batching + 量化 + 投机解码 + 并行。
follow_up:
  - vLLM 为什么快？——PagedAttention 管理 KV Cache 分页，无碎片
  - 量化损失精度吗？——INT8 几乎无损，INT4 轻微降，关键用 AWQ/GPTQ
  - 投机解码原理？——小模型先出 N 个 token，大模型并行校验，正确则省 N-1 步
memory_points:
  - KV Cache 复用历史
  - Continuous Batching 动态拼 batch
  - 量化 INT8/FP8 省显存
  - 投机解码：小草稿+大校验
  - 并行：TP/PP
---

# 【拼多多交易】LLM 推理怎么优化？

> JD 依据："LLM 推理优化"。

## 一、瓶颈分析

```
LLM 推理 = 自回归生成（token 一个个出）
瓶颈：显存带宽（搬 KV Cache）而非算力
KV Cache：每生成一个 token，历史 K/V 都要参与注意力
```

## 二、核心优化

**1. KV Cache**（必做）：
缓存历史 token 的 K/V，避免重算。
```
生成第 N 个 token：
  无 cache：重算前 N-1 个 token 的 K/V（O(N²)）
  有 cache：只算第 N 个，复用前 N-1（O(N)）
```

**2. PagedAttention（vLLM）**：
把 KV Cache 按页管理（像 OS 虚拟内存），无碎片，并发请求共享。
```python
from vllm import LLM
llm = LLM(model="qwen2-7b", tensor_parallel_size=2)
outputs = llm.generate(prompts, sampling_params)
```
吞吐比 HuggingFace 高 5-10 倍。

**3. Continuous Batching**：
传统 batching 等最慢的请求完成才下一批（有空等）。Continuous 动态拼 batch，每步都满。
```
传统：[A,B,C] 等最慢 → [D,E,F] ...
连续：A 完成 → 立刻补 D → 满负荷
```

**4. 量化**：
```
FP16 → INT8（AWQ/GPTQ）：显存减半，吞吐近翻倍，精度损失 < 1%
FP16 → FP8：A100/H100 原生支持，无损
INT4：显存 1/4，精度降 2-3%，适合小模型场景
```

**5. 投机解码**：
```
小模型（草稿）→ 出 N 个候选 token
大模型（校验）→ 并行验证 N 个
正确接受，错误从第一个错位重生成
省 1-2 倍时间
```

**6. 模型并行**：
- TP（Tensor Parallel）：层内切，GPU 间通信大，需 NVLink
- PP（Pipeline Parallel）：层间切，通信小，但有气泡
- 大模型（70B+）TP+PP 组合

## 三、对比

| 方案 | 吞吐提升 | 精度 | 复杂度 |
|------|----------|------|--------|
| KV Cache | 基线 | 无损 | 低 |
| PagedAttention | 5-10x | 无损 | 中 |
| Continuous Batching | 3-5x | 无损 | 中 |
| INT8 量化 | 2x | 几乎无损 | 低 |
| 投机解码 | 1.5-2x | 无损 | 高 |
| TP | 大模型必需 | 无损 | 高 |

## 四、拼多多场景

- **客服 LLM**：7B 模型 + INT8 + vLLM，单卡 100+ QPS
- **大促弹性**：白天扩 GPU，夜间缩容（成本优化）
- **分级模型**：简单问题小模型（1.5B）、复杂转大模型（14B）

## 五、成本优化

```
1. 缓存：相同 prompt 复用（FAQ 场景命中率 60%）
2. 路由：简单走小模型（便宜 10x）
3. 批处理：非实时场景（凌晨对账）走批量
4. 弹性：GPU 按需扩缩
5. 蒸馏：大模型蒸馏到小模型
```

## 六、底层本质

LLM 推理优化本质是**"围绕显存带宽做复用+压缩+并行"**——KV Cache 复用历史、PagedAttention 管碎片、量化压显存、投机解码并行化、TP/PP 跨卡。

## 常见考点
1. **vLLM 为什么比 HF 快**？——PagedAttention 消除 KV Cache 碎片+Continuous Batching 满负荷。
2. **量化怎么选**？——生产用 INT8（AWQ）几乎无损；极致成本 INT4；A100/H100 用 FP8。
3. **投机解码什么时候有效**？——草稿模型与大模型分布相近（同家族），接受率高才省时。
