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

## 苏格拉底式面试追问

> 这组追问不是背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：你说 vLLM 用 KV Cache 加速，但 Transformer 原生就有 KV Cache 的概念，vLLM 的 KV Cache 有什么不同？为什么能提效？**

vLLM 的创新不在"有没有 KV Cache"（这是 Transformer 自带的），而在 KV Cache 的"显存管理"。传统推理框架连续分配 KV Cache（一个请求一块连续显存），有两个问题：①外部碎片（请求大小不一，显存空洞浪费）；②内部碎片（预分配最大长度，但实际用不满，浪费一半以上）。vLLM 的 PagedAttention 借鉴 OS 虚拟内存，把 KV Cache 分成固定大小的 block（如 16 token），逻辑地址映射物理块，按需分配。结果是显存利用率从 50% 提到 95%+，同样的 GPU 能塞更大 batch，吞吐翻倍。本质是从"连续分配"到"分页按需"，解决的是显存浪费而非 KV 计算本身。

### 第二层：证据与定位

**Q：审核 Agent 上线后，P99 延迟从 300ms 涨到 800ms。你怎么定位是 KV Cache 问题还是计算问题？**

分层定位：
1. 看 GPU 指标——`nvidia-smi` 看显存占用和 SM 利用率。显存接近满（>95%）但 SM 利用率低（<60%），是显存瓶颈（KV Cache 撑爆）；显存有余但 SM 利用率高，是计算瓶颈。
2. 看 batch 分布——vLLM 的 `/metrics` 看 `vllm:num_requests_running`（运行中）vs `vllm:num_requests_waiting`（等待中）。等待队列长说明显存不够 batch 不下，是 KV Cache 问题。
3. 看请求长度——如果输入 prompt 变长（如审核从 500 字变 2000 字），KV Cache 暴涨。`vllm:request_prompt_length` 直方图验证。
4. 区分 prefill/decode——prefill（首 token）计算密集，decode（后续）显存密集。P99 涨在 prefill 是计算问题，涨在 decode 是 KV Cache 问题。

### 第三层：根因深挖

**Q：你用 INT4 量化降了显存提了速度，但准确率掉了 2%。这个精度损失在审核场景能接受吗？根因是什么？**

审核场景对精度敏感（误杀影响用户体验，漏判有合规风险），2% 损失需评估：
1. 根因——INT4 量化把权重从 FP16 压到 4 位，极端值（outlier）被截断，attention 计算误差累积。尤其小模型（7B）对量化更敏感（参数少，每个权重大）。
2. 影响评估——离线跑 benchmark（1 万条标注），看 INT4 vs FP16 的准确率/召回率。如果误判率从 0.5% 涨到 1%，在合规场景不能接受。
3. 优化——换 AWQ/GPTQ 量化（保重要性权重，精度优于朴素 INT4）；或退到 INT8（几乎无损，显存省一半，速度提 30%）；或用大模型 INT4（13B INT4 接近 7B FP16 效果）。
4. 折中——审核用 INT8（保精度），客服闲聊用 INT4（可容忍）。按场景分级。

### 第四层：方案权衡

**Q：vLLM 是开源通用的，TensorRT-LLM 是 Nvidia 极致的。你的审核场景高 QPS，为什么选 vLLM 而非 TensorRT-LLM？**

权衡维度：
1. 性能——TensorRT-LLM 比 vLLM 快 20-30%（Nvidia 定制内核 + Kernel fusion），极致延迟场景（P99 <200ms）选它。
2. 兼容性——vLLM 支持任意 HuggingFace 模型（开箱即用），TensorRT-LLM 要转 engine（编译慢，模型适配麻烦）。
3. 生态——vLLM 社区活跃（OpenAI 兼容 API，LangChain/LlamaIndex 直接对接），TensorRT-LLM 生态窄。
4. 成本——vLLM 开发效率高（换模型几小时），TensorRT-LLM 换模型要重新编译调优（几天）。
5. 硬件——vLLM 跨硬件（Nvidia/AMD），TensorRT-LLM 只 Nvidia。
结论：审核场景 QPS 100+、P99 <500ms，vLLM 够用；且模型迭代频繁（每周换），vLLM 的灵活性价值 > TensorRT-LLM 的极致性能。除非延迟卡到 200ms 内才换。

### 第五层：验证与沉淀

**Q：你优化后说"QPS 提升了 3 倍"，怎么证明不是流量波动带来的错觉？**

量化验证：
1. 基准测试——用固定压力（locust/wrk，1000 并发持续 10 分钟），对比优化前后 QPS，排除流量波动。
2. 控制变量——同模型、同输入分布、同硬件，只改优化项（如开 PagedAttention），其余不变。
3. 指标维度——不只看 QPS，看 P50/P99 延迟、显存利用率、token/s、错误率。QPS 涨但 P99 也涨是退步。
4. 长期监控——上线后看 7 天趋势（Prometheus + Grafana），QPS 稳定在优化后的水平，排除短期波动。
5. A/B——同一时间，一半流量走旧版一半走新版，对比同负载下的 QPS。
沉淀：优化前后指标入文档（如"PagedAttention 显存 50%→95%，QPS 30→100"），作为团队知识库；监控大盘加 LLM 推理专项指标（token/s、显存利用率、KV Cache 命中率）。

## 结构化回答


**30 秒电梯演讲：** LLM 推理像餐厅出餐——KV Cache 是备菜（避免重算）、连续批处理是拼桌（多人一起）、量化是减油（精度略降但快）、张量并行是多灶台。

**展开框架：**
1. **KV Cache** — 缓存 attention 的 K/V 避免重算
2. **连续批处理（Continu…** — 连续批处理（Continuous Batching）：动态拼请求
3. **量化（INT8/INT4）** — 量化（INT8/INT4）：减显存提速度

**收尾：** vLLM 为什么快？


## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：LLM 推理优化方案？ | 今天聊「LLM 推理优化方案？」。一句话：LLM 推理优化是"用 KV Cache+连续批处理+量化+分布式推理"降延迟提吞吐；内容场景高并发（审核/客服）需深… | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：KV Cache：缓存 K/V 避免重算 | 核心概念 |
| 0:51 | 能力/参数拆解表 | 要点是：连续批处理：动态拼请求 | 能力拆解 |
| 1:30 | 流程图：输入→处理→输出 | 要点是：量化：INT8/INT4 | 关键机制 |
| 2:09 | 代码片段 + 注释高亮 | 要点是：并行：张量/Pipeline | 实战要点 |
| 3:00 | 总结卡 + 下期预告 | 记住这些核心点就够了。下期我们接着聊——vLLM 为什么快？。 | 收尾 |
