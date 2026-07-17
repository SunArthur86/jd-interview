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

## 苏格拉底式面试追问

> 这组追问不背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：LLM 推理优化的目标到底是"快"还是"省"？这两个目标有时候是冲突的（如投机解码快但费算力），你怎么定优先级？**

要先看业务场景的约束是什么。客服 LLM 是"延迟敏感"——用户等回答，P99 < 3s 是硬约束，慢了用户流失，优化目标首先是"快"（降延迟）。凌晨对账/批量生成是"成本敏感"——不交互，慢一点无所谓，目标是"省"（降单次成本）。投机解码快但费算力，用在客服场景值得（快换体验），用在批量场景不值（省比快重要）。优先级不是拍脑袋，是看 SLA（延迟要求）× 调用量 × 单价，算出"延迟成本"和"金钱成本"哪个是瓶颈，对症优化。

### 第二层：证据与定位

**Q：线上客服 LLM 的 P99 从 2s 飙到 8s，你怎么定位是推理引擎的问题，还是 GPU 资源的问题，还是 prompt 的问题？**

按推理链路拆证据。三步：
1. 看推理引擎指标——vLLM 暴露的 metrics：`vllm:num_requests_waiting`（排队数）、`vllm:time_to_first_token`（TTFT）、`vllm:time_per_output_token`。如果 `num_requests_waiting` 飙升（请求堆积），是 GPU 算力不够或 batch 太满；如果 TTFT 正常但 `time_per_output_token` 变长，是生成阶段慢（可能 KV Cache 膨胀或显存压力）。
2. 看 GPU 利用率——`nvidia-smi` 看 GPU 利用率（util%）和显存占用（mem）。如果利用率 < 60% 但延迟高，是 batching 没拼满或锁竞争；如果利用率 100% 且显存快满，是容量不够要扩容。
3. 看 prompt 长度分布——`prompts:tokens_avg`。如果某次 prompt 变长了（如 RAG 召回更多文档塞进去），KV Cache 膨胀导致生成慢，是 prompt/检索问题不是引擎问题。三组证据交叉定位。

### 第三层：根因深挖

**Q：你定位到是 KV Cache 膨胀（prompt 平均从 500 token 涨到 3000 token），根因是 RAG 召回了太多文档塞 prompt。光在推理层优化能解决吗？**

推理层优化是治标。根因在 RAG 召回策略：
1. 召回过多——topK=20 全塞 prompt，但很多文档和问题弱相关。治本是召回后做 rerank（如用 reranker 模型重排），只取 top3-5 最相关的塞 prompt，token 从 3000 降到 800。
2. prompt 没截断保护——RAG 召回结果直接拼 prompt 没限长，长文档一次塞满。治本是 prompt 模板设 `max_context_tokens=2000`，超了按相关度截断。
3. KV Cache 膨胀的推理层缓解——PagedAttention 虽然管碎片但管不住总量，可开启 prefix caching（相同 system prompt 部分复用 KV），但根本上要控制 prompt 长度。根因是"召回策略让 prompt 变长"，推理层优化顶不住无限增长的 prompt，必须从源头控 token。

**Q：那为什么不直接限制 RAG 只召回 topK=3，从源头就短，不就不用推理层优化了吗？**

topK=3 太激进会掉召回率。用户问"百亿补贴的退货规则"，topK=3 可能只召回"退货流程"漏了"退货时效"，回答不全。召回和精度是 trade-off——topK 大召回全但 prompt 长生成慢，topK 小 prompt 短但可能漏关键信息。正确做法是"大 topK 召回 + rerank 精排 + 截断"：
1. topK=20 召回保证不漏（高 Recall）。
2. reranker 模型对 20 个文档重排，取相关度最高的 top3-5（提 Precision）。
3. 截断保护 prompt 长度。推理层优化（PagedAttention/prefix caching/量化）和召回层优化（rerank/截断）是互补的，不是二选一——召回层控输入长度，推理层提吞吐，两层都要做。

### 第四层：方案权衡

**Q：你要降成本，方案有量化（INT8）、小模型蒸馏、缓存复用。这三个怎么选？哪个收益最大？**

按"收益/风险/适用性"权衡：
1. 缓存复用——收益最高且零风险。FAQ 场景相同问题命中率 60%，命中直接返回不调 LLM，成本省 60%。但只适合"问题重复度高"的场景，开放性问答命中率低。
2. INT8 量化（AWQ）——显存减半、吞吐近翻倍、精度损失 < 1%，几乎零风险，是通用方案，所有场景都该做。
3. 小模型蒸馏——把 14B 蒸馏到 7B/1.5B，成本降 10 倍，但蒸馏后能力下降，复杂问题答不好。需配合"分级路由"（简单走小模型，复杂转大模型）。落地顺序：先量化（通用 + 低风险）→ 再缓存（高收益场景）→ 最后蒸馏 + 分级路由（极致成本）。缓存是性价比最高的，但前提是场景适合。

**Q：为什么不全部用 FP8（A100/H100 原生支持，无损），一步到位，还要搞 INT8？**

FP8 的限制是硬件绑定。FP8 只有 H100/H200 原生支持，A100 是 FP16 卡跑 FP8 要模拟反而慢。团队的 GPU 池可能混部（A100 + H100 + 消费级 4090），FP8 不能全覆盖。INT8（AWQ/GPTQ）是"跨硬件通用"——A100/H100/4090 都能跑，且 AWQ 量化精度损失可控。实际是按硬件分：有 H100 的节点跑 FP8（无损最优），A100/4090 节点跑 INT8。一步到位 FP8 的前提是全部换 H100，硬件成本巨大。混合部署（FP8 + INT8）是成本和精度的现实平衡。

### 第五层：验证与沉淀

**Q：你上了 INT8 量化，怎么证明"精度损失 < 1%"这个结论成立，而不是量化后线上回答质量暗降？**

不能只看量化报告（理论 perplexity 差异），要业务验证：
1. 离线回归——INT8 模型在 10 万标注集上跑，对比 FP16 的准确率/格式合规率/幻觉率，各项指标差异 < 1% 才算"几乎无损"。perplexity 是语言模型指标，业务指标（客服准确率）才是真标准。
2. 在线 A/B——5% 流量跑 INT8，对比 FP16 的满意度/转人工率/错退率，统计显著无劣化才全量。量化可能在某些 case（如小数金额推理）精度掉，离线集没覆盖到，线上 A/B 才暴露。
3. bad case 对比——抽样 INT8 和 FP16 输出差异最大的 case（如用 LLM-as-judge 找分歧大的），人工复核差异是否是量化导致。验证是"离线标注集 + 在线 A/B + bad case 交叉"，单一指标不够。

**Q：LLM 推理优化怎么沉淀成团队能力，而不是每次都靠专家调？**

沉淀成"推理优化平台 + 规范"：
1. 推理镜像标准化——vLLM + INT8 量化 + PagedAttention 封装成标准镜像，业务侧声明模型和并发即可，不碰底层参数。
2. 容量规划模型——按"模型大小 × 预期 QPS × 延迟 SLA"自动算 GPU 数量，避免拍脑袋扩容。
3. 监控看板——`TTFT`/`time_per_output_token`/`GPU util`/`mem`/`cost_per_request` 统一采集，异常告警（如 P99 > SLA 的 80% 预警）。
4. 弹性伸缩——大促白天扩容、夜间缩容的自动策略，结合 GPU spot 实例降本。
5. 优化经验库——记录"什么模型 + 什么量化 + 什么并发配置 = 什么性能"，新应用查表即可，不用重新调。把推理优化从"专家手工调"变"平台自动化"，这是 LLM Infra 工程化的路径。

## 结构化回答


**30 秒电梯演讲：** LLM 推理像"餐厅出餐"——KV Cache 是预备食材（不重复切）、Continuous Batching 是动态拼桌（满负荷）、量化是简装盒饭（省成本）、投机解码是预炒半成品（加速）。

**展开框架：**
1. **KV Cache** — 避免重复算历史 token
2. **Continuous Ba…** — 动态拼 batch，GPU 不闲
3. **量化：INT** — INT8/FP8 降显存提吞吐

**收尾：** vLLM 为什么快？


## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：LLM 推理怎么优化？ | 今天聊「LLM 推理怎么优化？」。一句话：LLM 推理优化是"用更少 GPU 算更快的 token" | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：KV Cache 复用历史 | 核心概念 |
| 0:51 | 能力/参数拆解表 | 要点是：Continuous Batching 动态拼 batch | 能力拆解 |
| 1:30 | 流程图：输入→处理→输出 | 要点是：量化 INT8/FP8 省显存 | 关键机制 |
| 2:09 | 代码片段 + 注释高亮 | 要点是：投机解码：小草稿+大校验 | 实战要点 |
| 3:00 | 总结卡 + 下期预告 | 记住这些核心点就够了。下期我们接着聊——vLLM 为什么快？。 | 收尾 |
