---
id: pdd-content-034
difficulty: L4
category: pdd-content
subcategory: LLM 推理
tags:
- 拼多多
- 内容
- LLM 推理
- vLLM
- 量化
- KV Cache
- 显存
feynman:
  essence: LLM 推理优化是"用 KV Cache+连续批处理+量化+分布式推理"降延迟提吞吐；内容场景高并发（审核/客服）需深度优化。
  analogy: LLM 推理像餐厅出餐——KV Cache 是备菜（避免重算）、连续批处理是拼桌（多人一起）、量化是减油（精度略降但快）、张量并行是多灶台。
  first_principle: LLM 推理瓶颈在显存+计算，需算法+系统+硬件协同优化。
  key_points:
  - KV Cache：缓存 attention 的 K/V 避免重算
  - 连续批处理（Continuous Batching）：动态拼请求
  - 量化（INT8/INT4）：减显存提速度
  - 张量并行/Pipeline 并行：多卡分布式
  - 推理框架：vLLM/TensorRT-LLM/SGLang
first_principle:
  problem: LLM 推理延迟高+显存大+成本贵，如何优化？
  axioms:
  - 自回归每步重算 attention 慢
  - 显存装不下大模型
  - 吞吐 vs 延迟权衡
  rebuild: KV Cache+连续批处理+量化+并行。
follow_up:
  - vLLM 为什么快？——PagedAttention（显存分页）+连续批处理
  - 量化精度损失？——INT8 几乎无损/INT4 略降
  - 怎么选推理框架？——vLLM（开源通用）/TensorRT-LLM（Nvidia 极致）
memory_points:
  - KV Cache：缓存 K/V 避免重算
  - 连续批处理：动态拼请求
  - 量化：INT8/INT4
  - 并行：张量/Pipeline
  - 框架：vLLM/TensorRT-LLM
---

# 【拼多多内容】LLM 推理优化方案？

> JD 依据："和算法同学挖掘业务问题"、"系统架构优化"。

## 一、推理瓶颈

```
LLM 推理（自回归）：
  每生成一个 token，要重算所有历史的 attention
  
瓶颈：
  - 计算密集（生成阶段）
  - 显存密集（KV Cache 占大头）
  - 内存带宽（读 KV Cache）

vs 训练：训练可并行（一次前向多 token），推理串行（一次一 token）
```

## 二、KV Cache

**原理**：缓存每层的 K/V，避免重复计算历史 attention。

```
无 KV Cache：每生成一个 token，重算所有历史
  step 1: attention([t1])
  step 2: attention([t1, t2])          重算 t1
  step 3: attention([t1, t2, t3])      重算 t1, t2

有 KV Cache：只算新 token 的 K/V，存起来
  step 1: k1,v1 = K(t1),V(t1); attention([k1,v1])
  step 2: k2,v2 = K(t2),V(t2); attention([k1,v2,k2,v2])   只算 t2
  step 3: k3,v3 = K(t3),V(t3); ...                         只算 t3
```

**代价**：显存占用大（长上下文 KV Cache 几十 GB）。

## 三、PagedAttention（vLLM 创新）

**问题**：传统 KV Cache 连续分配，碎片+浪费。

**PagedAttention**（借鉴 OS 虚拟内存）：
```
KV Cache 分成固定大小的块（block，如 16 token）
逻辑地址 → 物理块映射（页表）
按需分配，不连续
  → 显存利用率从 50% 提到 95%+
  → 支持更大 batch
```

## 四、连续批处理（Continuous Batching）

**传统批处理**：
```
batch 内 4 个请求，长度不同
最长的决定整体时间，短的等
提前结束的请求资源浪费
```

**连续批处理**：
```
动态拼请求：
  新请求随时加入 batch
  完成的请求随时退出
  每步都满 batch
  → 吞吐提升 5-10 倍
```

vLLM/SGLang 都支持。

## 五、量化

| 量化 | 精度 | 显存 | 速度 | 精度损失 |
|------|------|------|------|----------|
| FP16 | 基准 | 100% | 基准 | 无 |
| BF16 | 基准 | 100% | 基准 | 无 |
| INT8 | 8 位 | 50% | +30% | 几乎无损 |
| INT4 | 4 位 | 25% | +50% | 略降 |
| GPTQ/AWQ | 4 位 | 25% | +50% | 优于朴素 INT4 |

**AWQ/GPTQ**（先进量化）：保精度降显存。

## 六、分布式推理

**张量并行（TP）**：
```
模型一层切成多块 → 多卡并行算 → all-reduce 合并
适合：单机多卡（NVLink 高速互联）
例：7B 模型 2 卡 TP
```

**Pipeline 并行（PP）**：
```
模型按层切成多段 → 每卡算一段 → 流水线
适合：超大模型跨机
```

**专家并行（EP）**：
```
MoE 模型：不同专家分布在不同卡
适合：MoE 模型（如 Mixtral）
```

## 七、推理框架对比

| 框架 | 特点 | 适用 |
|------|------|------|
| vLLM | PagedAttention+连续批处理，开源通用 | 通用首选 |
| TensorRT-LLM | Nvidia 极致优化 | Nvidia 卡极致性能 |
| SGLang | 编程语言式，复杂场景 | 多 Agent/结构化 |
| LMDeploy | 国产，量化好 | 中文场景 |
| TGI | HuggingFace，易用 | 快速上线 |

## 八、内容场景实战

**审核 Agent（高并发）**：
```
模型：7B 微调（领域适配）
部署：vLLM + 2 卡 TP + INT8 量化
优化：
  - PagedAttention 提显存利用
  - 连续批处理提吞吐
  - 批量推理（多条评价一起）
  - 缓存（相似内容）
  
指标：
  - QPS：100+（单机）
  - 延迟 P99：<500ms
  - 显存利用率：90%+
```

**客服 Agent（交互式）**：
```
模型：13B
部署：vLLM + 4 卡 TP
优化：
  - 流式输出（首字延迟 <1s）
  - KV Cache（多轮对话复用）
  - 会话级批处理
  
指标：
  - 首字延迟 <1s
  - 完整响应 <5s
```

## 九、其他优化

**投机解码（Speculative Decoding）**：
```
小模型先草拟 N 个 token → 大模型并行验证 → 接受/拒绝
  → 大模型串行变并行，2-3 倍加速
```

**Prefix Caching**：
```
相同前缀（system prompt）的 KV Cache 复用
  → 大幅降低长 prompt 成本
```

**模型蒸馏**：
```
大模型（教师）→ 小模型（学生）蒸馏
  → 小模型接近大模型效果，速度快
```

## 十、监控与成本

```
监控：
  - QPS/延迟（P50/P99）
  - 显存利用率
  - token 消耗
  - 错误率

成本：
  - 单次推理成本 = token × 单价
  - GPU 利用率（>70% 才划算）
  - 分级调用（简单走小模型）
```

## 十一、底层本质

LLM 推理优化本质是**"算法（KV Cache/量化）+系统（连续批处理/PagedAttention）+硬件（多卡并行）协同"**——vLLM 是集大成者，内容场景需结合并发特点深度调优。

## 常见考点
1. **vLLM 为什么快**？——PagedAttention（显存分页）+连续批处理（动态拼请求）。
2. **量化怎么选**？——INT8 几乎无损/INT4 略降但省显存，AWQ/GPTQ 更优。
3. **张量并行 vs Pipeline 并行**？——TP 切层内（多卡同算一层），PP 切层间（每卡一段）。
