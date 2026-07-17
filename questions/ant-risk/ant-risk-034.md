---
id: ant-risk-034
difficulty: L4
category: ant-risk
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

## 苏格拉底式面试追问

> 这组追问不是背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：vLLM 相比 HuggingFace Transformers 的核心提升是 PagedAttention。为什么 KV cache 管理这么关键，它能带来 5-10 倍提升？**

KV cache 是 LLM 推理的显存大头——每生成一个 token，要把之前所有 token 的 Key/Value 张量缓存下来避免重算。70B 模型每 token 的 KV cache 约 100KB，一个 2048 token 的请求就要 200MB。传统做法（HF Transformers）为每个请求预分配"最大长度"的连续显存（比如 2048 token × 100KB = 200MB），但实际生成可能只到 500 token 就结束，剩余 150MB 全浪费（内部碎片）。加上不同请求长度不同（外部碎片），显存利用率只有 30-40%。PagedAttention 借鉴操作系统的虚拟内存分页——把 KV cache 切成固定大小的 block（如 16 token/block），按需分配，用 block table 管理（像页表），利用率提升到 90%+。同样显存能容纳 2-3 倍的并发请求，吞吐自然提升 5-10 倍。

### 第二层：证据与定位

**Q：vLLM 上线后，监控发现单 GPU 吞吐只有预期的 60%。你怎么定位是参数配错了还是负载特征不对？**

看 vLLM 的指标：
1. `gpu_cache_usage_perc`——KV cache 利用率。如果 < 50%，说明 `max_num_seqs` 或 `gpu_memory_utilization` 配低了，GPU 显存没用满。调大 `gpu_memory_utilization` 从 0.85 到 0.92，或调大 `max_num_seqs`。
2. `avg_preemption_count`——抢占次数。如果 > 0，说明显存不够导致 preemption（部分请求被换出），会重算增加延迟。这说明 `max_num_seqs` 配太大超出了显存承受，要调小或扩 GPU。
3. 看 batch 大小——`avg_running_requests` 是否接近 `max_num_seqs`。如果远小于，说明请求不够（QPS 低），GPU 空转。这种情况不是 vLLM 配置问题，是上游 QPS 不够，需要攒批（客户端用 async batch 接口）或缩容。

### 第三层：根因深挖

**Q：你发现 `gpu_cache_usage_perc` 只有 40%，但 `max_num_seqs` 已经配到 256。为什么显存没用满？**

根因可能是模型加载本身占了大头显存，留给 KV cache 的空间不够。vLLM 启动时显存分配顺序：模型权重（固定）→ 临时激活值（固定）→ KV cache（剩余空间）。如果模型权重大（比如 70B FP16 要 140GB，4 卡 A100 80GB 刚好放权重），留给 KV cache 的空间就很少。解法：第一，量化模型权重——AWQ INT4 把 70B 从 140GB 压到 35GB，释放 105GB 给 KV cache，`gpu_cache_usage_perc` 立刻上去了。第二，调 `enforce_eager=True` 禁用 CUDA Graph（省一些显存但会降速），权衡使用。第三，扩 GPU——4 卡变 8 卡，权重分摊到更多卡，每卡有更多显存给 KV cache。根因是"模型权重 + KV cache 争抢显存"，不是 vLLM 配置错误。

**Q：那为什么不直接用最激进的量化（INT4）+ 最小模型，把显存压到最低，吞吐最高？**

因为量化有精度损失，且损失不均匀。INT8 几乎无损（ perplexity 差 < 1%），但 INT4 在某些任务上损失明显——尤其是风控这种需要精细推理的场景，INT4 可能导致 LLM 对复杂欺诈 case 的判断准确率掉 3-5 个百分点。而且量化的损失是"非线性"的——简单任务（分类）几乎不影响，复杂任务（多步推理）损失大。风控决策是多步推理（读证据 → 分析关系 → 判断风险），正好是量化损失敏感的场景。所以正确策略是分层：实时高频链路用 INT8（快且几乎无损），离线深度分析用 FP16（最准但慢），INT4 只用于"粗筛"场景（先快速过滤明显正常的，剩下的走精确模型）。不能一刀切用 INT4。

### 第四层：方案权衡

**Q：风控 LLM 推理选自建 vLLM 还是调云端 API（如 GLM API）？怎么权衡？**

看三个维度：
1. 成本——API 按 token 计费（约 0.01-0.05 元/千 token），自建按 GPU 折旧 + 电费（A100 约 8 元/小时）。如果 QPS 高（> 100 并发）且 prompt 长，自建的单次成本远低于 API（自建约 0.001 元/次，API 约 0.02 元/次，差 20 倍）。低 QPS 则 API 更划算（不用养 GPU）。
2. 延迟——API 有网络往返（同地域 50-100ms）+ 排队（高峰期秒级），自建在同机房（< 5ms）且可控。风控实时链路对延迟敏感，自建有优势。
3. 数据敏感——风控数据涉及用户隐私（交易、行为），自建数据不出内网，合规更简单。API 要求数据脱敏 + 合规审查。蚂蚁的实践是：风控核心链路自建（数据敏感 + 延迟敏感 + 高 QPS），边缘场景（如运营文案生成）用 API（低 QPS + 非敏感）。

**Q：既然自建 vLLM 成本低，为什么不所有场景都自建，还要保留 API 调用？**

因为自建的运维成本高且灵活性低。自建要管 GPU 采购、部署、监控、故障恢复、模型升级（下载权重、重新量化、benchmark），一个 4 卡 A100 节点的运维成本（人力 + 备件）不低。而且自建模型的"能力天花板"是固定的（部署的是 GLM-4-9B 就是 9B 的能力），想用更强的 GLM-4-Plus 必须重新部署大模型（70B 需要 8 卡 A100，成本骤增）。API 的优势是"即开即用 + 按需选模型"——今天用 Flash，明天想换 Plus，改一个参数就行，不用重新部署。所以正确策略是"核心稳定负载自建 + 弹性突发流量走 API"，类似传统架构的"自有机房 + 公有云"混合模式。

### 第五层：验证与沉淀

**Q：你怎么证明 vLLM 的推理优化真的有效，而不是碰巧那几天负载低？**

基线对比实验：
1. 吞吐对比——相同测试集（10000 条 prompt）、相同模型、相同 GPU，分别用 HF Transformers 和 vLLM 跑，对比 `tokens/second/GPU`。预期 vLLM 提升 5-10 倍。
2. 延迟对比——固定并发数（如 100 并发），测 P50/P99 延迟，vLLM 的 P99 应显著低于 HF（因为 PagedAttention 减少了排队）。
3. 显存对比——`nvidia-smi` 看 GPU 显存利用率，vLLM 应到 90%+，HF 可能只有 30-40%。
4. 线上验证——A/B 实验（50% 流量走 vLLM，50% 走旧方案），对比 P99 延迟、吞吐、成本（元/千次推理），跑 1 周确认稳定。

**Q：LLM 推理优化的经验怎么沉淀成团队标准操作？**

三件事：
1. 部署模板——标准化的 vLLM 部署脚本（Docker + 配置模板），按模型大小（7B/70B）和场景（实时/离线）提供推荐配置（`tensor_parallel_size`、`max_num_seqs`、`quantization`），新模型上线直接用。
2. 性能基线库——每个模型版本上线前跑标准 benchmark（吞吐、延迟、显存），结果存档，版本间对比，防止"升级后性能退化"。
3. GPU 容量规划——根据业务 QPS 和模型吞吐，给出"需要多少卡"的计算公式和压测工具，避免拍脑袋采购 GPU（GPU 贵，买多用少浪费）。


## 结构化回答

**30 秒电梯演讲：** 聊到LLM 推理怎么优化？vLLM 原理？怎么降本增效，我的理解是——LLM 推理优化三大手段：vLLM 用 PagedAttention 让 KV cache 像虚拟内存分页管理（吞吐 5-10 倍）、量化用 INT8/INT4 降精度换速度、KV Cache 复用减少重复计算。打个比方，vLLM 像操作系统的虚拟内存——把碎片化的 KV cache 用页表管理，利用率从 30% 到 90%；量化像压缩图片——精度略降但体积小几倍；KV Cache 像浏览器缓存——同会话不重复计算。

**展开框架：**
1. **vLLM/PagedAttention** — KV cache 分页管理，吞吐 5-10 倍
2. **量化** — INT8/INT4，精度损失小速度大幅提升
3. **KV Cache** — 自回归推理中间结果缓存

**收尾：** 这块我在项目里也踩过坑——想深入的话，可以接着聊：KV cache 占多少显存？您更想看哪个方向？

## 视频脚本

> 预计时长：4 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡 | "LLM 推理怎么优化？vLLM 原理？怎么降本增效——这道题面试官到底想考什么？我用 30 秒给你讲透。" | 开场钩子 |
| 0:15 | 缓存架构图 | 先说核心：LLM 推理优化三大手段：vLLM 用 PagedAttention 让 KV cache 像虚拟内存分页管理（吞吐 5-10 倍）、量化用 INT8/INT4 降精度换速度、。 | 核心定义 |
| 0:50 | 推理优化对比图 | INT8/INT4，精度损失小速度大幅提升。 | 量化 |
| 1:20 | 模型量化对比表 | 自回归推理中间结果缓存。 | KV Cache |
| 1:50 | 概念结构示意图 | 动态拼 batch 提升利用率。 | Continuous Batching |
| 3:30 | 总结卡 | 一句话记忆：vLLM/PagedAttention：KV cache 分页管理，吞吐 5-10 倍。 下期可以接着聊：KV cache 占多少显存。 | 收尾总结 |
