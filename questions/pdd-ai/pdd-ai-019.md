---
id: pdd-ai-019
difficulty: L4
category: pdd-ai
subcategory: LLM 训练
tags:
- 拼多多
- AI 中台
- 混合精度
- FP16
- BF16
- FP8
- 梯度累加
feynman:
  essence: 混合精度训练是"前向反向用 FP16/BF16 算（快），权重/梯度/优化器状态用 FP32 存（准）"，省显存提速 2-3 倍，配合 Loss Scaling 防小梯度下溢。
  analogy: 像精密加工——粗加工用快速工具（FP16 计算快），关键尺寸用卡尺精修（FP32 主权重），快慢结合又不失精度。
  first_principle: FP16 算得快但精度低易溢出，FP32 精确但慢且占显存，混合用两者优势。
  key_points:
  - 主权重 FP32 + 计算 FP16（AMP）
  - Loss Scaling：放大 loss 防小梯度下溢
  - BF16：动态范围同 FP32，无需 scaling（A100+ 首选）
  - FP8：H100 新一代，进一步提速
  - 梯度累加：小卡训大 batch（多步累加再更新）
first_principle:
  problem: 怎么兼顾训练速度、显存、收敛性？
  axioms:
  - FP16 快但范围小易溢出
  - FP32 精确但慢
  - 主权重需要高精度保证长期收敛
  rebuild: 混合精度（计算 FP16 + 主权重 FP32 + Loss Scaling 或用 BF16）。
follow_up:
  - FP16 和 BF16 区别？——FP16 数位多范围小（易溢出），BF16 范围同 FP32 但精度低
  - 为什么要 Loss Scaling？——FP16 小梯度下溢（小于 6e-8 变 0），放大 loss 同步放大梯度
  - 梯度累加等于大 batch 吗？——数学近似等价，但 BN 统计/正则项可能不同
memory_points:
  - 主权重 FP32 + 计算 FP16/BF16
  - Loss Scaling 防 FP16 下溢
  - BF16（A100+）范围同 FP32 无需 scaling
  - 梯度累加：多 micro-batch 累加后更新
---

# 【拼多多 AI 中台】混合精度训练怎么实现？FP16/BF16/FP8 怎么选？

> JD 依据："混合精度训练、梯度压缩"。

## 一、为什么混合精度

**FP32 训练问题**：
```
模型显存大：13B 模型 + 优化器状态（Adam）≈ 13B × 16 = 208GB
计算慢：FP32 Tensor Core 慢
```

**FP16 直接训的问题**：
```
范围小：最大 65504，溢出
精度低：最小 6e-8，小梯度下溢（变 0）
收敛差：长期更新失精度
```

**混合精度**：计算用 FP16（快），关键状态用 FP32（准）。

## 二、AMP（Automatic Mixed Precision）原理

NVIDIA 2017 提出（APEX/PyTorch AMP）。

```
权重维护两份：
  - Master Weight（FP32，长期累积）
  - Compute Weight（FP16，由 master 转换，前向反向用）

每步：
1. FP32 master → 转 FP16 compute
2. 前向：FP16 算 logits（快）
3. loss = criterion(logits, labels)
4. loss = loss × scale（防梯度下溢）
5. 反向：FP16 算梯度（快）
6. 梯度 unscale：grad = grad / scale
7. FP16 梯度 → FP32 累加到 master（精确保存）
8. optimizer.step() 更新 master
```

## 三、Loss Scaling（FP16 必备）

**问题**：FP16 最小可表示数 6e-8，小梯度（如 1e-9）下溢为 0。

**解决**：
```
放大 loss → 反向传播时梯度同步放大 → 不下溢
更新前再除回真实值

scale 选择：
  - 静态：固定（如 2^16）
  - 动态（PyTorch 默认）：监测溢出，自适应调整
    若反向出现 inf/nan → 减半 scale
    连续 N 步无溢出 → 翻倍 scale
```

## 四、BF16：A100+ 时代首选

```
FP16：1 符号 + 5 指数 + 10 尾数 → 范围 ±65504，精度高
BF16：1 符号 + 8 指数 + 7 尾数  → 范围 ±3e38（同 FP32），精度低
```

**BF16 优势**：
- 范围等同 FP32，**无需 Loss Scaling**
- 训练更稳（不易溢出）
- A100/H100/TPU 原生支持

**劣势**：
- 精度低（尾数 7 位），某些场景（强精度要求）不如 FP16
- 老卡（V100 及之前）不支持

**结论**：新硬件首选 BF16，老卡用 FP16 + Loss Scaling。

## 五、FP8：H100 新一代

```
H100 支持 FP8（E4M3 / E5M2 两种格式）
显存再减半（vs FP16/BF16）
算力翻倍（H100 FP8 算力近 2PFLOPS）
```

**用法**：
- E4M3（精度高）：前向
- E5M2（范围大）：反向梯度
- 配合 Transformer Engine（NVIDIA 库）

**现状**：精度调优复杂，框架（PyTorch/Nemo/Transformer Engine）逐步支持。

## 六、对比表

| 精度 | 字节 | 范围 | 精度 | Loss Scaling | 硬件 |
|------|------|------|------|-------------|------|
| FP32 | 4 | ±3e38 | 高 | 不需要 | 所有 |
| FP16 | 2 | ±65504 | 中 | 需要 | V100+ |
| BF16 | 2 | ±3e38 | 低 | 不需要 | A100+ |
| TF32 | 4(存储)/低精度计算 | 同 FP32 | 中 | 不需要 | A100+ |
| FP8 | 1 | 小 | 低 | 视情况 | H100+ |

## 七、PyTorch AMP 用法

```python
from torch.cuda.amp import autocast, GradScaler

scaler = GradScaler()  # 动态 loss scale（FP16 用，BF16 不需要）

for x, y in dataloader:
    optimizer.zero_grad()
    with autocast(dtype=torch.float16):  # 或 bfloat16
        logits = model(x)
        loss = criterion(logits, y)
    scaler.scale(loss).backward()       # 放大 loss
    scaler.step(optimizer)              # unscale + 更新
    scaler.update()                     # 调整 scale
```

**BF16 简化**：
```python
with autocast(dtype=torch.bfloat16):
    loss = criterion(model(x), y)
loss.backward()
optimizer.step()                        # 无需 scaler
```

## 八、显存收益估算（13B 模型，Adam 优化器）

```
纯 FP32：
  权重 13B×4 + 梯度 13B×4 + Adam(m, v) 13B×8 = 16 × 13B = 208GB

混合精度（FP16 计算 + FP32 master）：
  权重 FP16 13B×2 + 梯度 FP16 13B×2 + master FP32 13B×4 + Adam 13B×8 = 16 × 13B = 208GB

ZeRO-1（优化器分片到 N 卡）：
  每卡：(16/N) × 13B
  1024 卡：每卡约 200MB（轻松）

实际收益还要看激活：
  激活用 FP16/BF16 比 FP32 减半，激活 checkpointing 进一步省
```

## 九、梯度累加（Gradient Accumulation）

**问题**：单卡显存放不下大 batch（如 batch=256）。

**解决**：拆成多个 micro-batch 累加梯度，等价大 batch 更新。

```python
accumulation_steps = 4
for i, (x, y) in enumerate(dataloader):
    with autocast(dtype=torch.bfloat16):
        loss = criterion(model(x), y) / accumulation_steps  # 缩放
    loss.backward()                                          # 梯度累加

    if (i + 1) % accumulation_steps == 0:
        optimizer.step()
        optimizer.zero_grad()
```

**等价性**：累加 N 步等价于 batch=N×micro_batch。

**注意**：
- BN 统计仍按 micro-batch 算（不完全等价）
- 正则项（如 dropout）按 micro-batch
- 大模型训练常用 GPT/LN 不受影响

## 十、拼多多实战选型

```
预训练大模型（H100 集群）：
  - 计算：BF16（首选）或 FP8（极致）
  - 优化器：ZeRO-1/2 分片
  - 激活：BF16 + activation checkpointing
  - 通信：FP16 梯度 AllReduce + PowerSGD 压缩

微调（A100/V100 集群）：
  - 计算：FP16 + Loss Scaling（V100）或 BF16（A100）
  - LoRA/QLoRA 进一步省显存

边缘/低资源训练：
  - QLoRA：4-bit 权重 + LoRA 微调
  - 单卡 24G 可微调 70B 模型
```

## 十一、底层本质

混合精度本质是**"计算快用低精度，长期状态高精度"**——FP16/BF16 计算 + FP32 主权重 + Loss Scaling 防溢出（FP16 必备）。BF16 是当前主流（A100+），FP8 是 H100 时代前沿。配合 ZeRO/LoRA/梯度累加等显存优化，让千亿模型训练成为可能。

## 常见考点

1. **混合精度为什么能收敛**？——主权重 FP32 长期累积精度，单步计算用 FP16 误差可控；Loss Scaling 防下溢。
2. **TF32 是什么**？——A100 引入，存储是 FP32 但矩阵乘用 19-bit 精度（8 指数 + 10 尾数 + 1 符号），自动加速无需改代码。
3. **BF16 为什么不用 Loss Scaling**？——动态范围等同 FP32（8 位指数），小梯度不会下溢。

## 苏格拉底式面试追问

> 这组追问不背答案，模拟面试宫层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：混合精度训练为什么非要用 FP32 存主权重？既然 FP16 算力快，主权重也用 FP16 存不是更省显存吗？省一半的 master weight 显存不香吗？**

FP16 主权重会导致"长期训练的精度累积误差"。第一，**单步更新精度问题**——Adam 优化器的更新是 `weight -= lr × momentum / sqrt(v)`，其中 momentum 和 v 是梯度的指数移动平均。当训练后期梯度很小（如 1e-6），`lr × momentum` 可能是 1e-8，FP16 的最小表示是 6e-8（小于这个就归零），所以更新量在 FP16 下被舍入为 0，权重不变——训练"停滞"。第二，**累积误差**——即使单步更新不为 0，FP16 的舍入误差会累积（每步有微小偏差），训练 10 万步后，权重偏离正确值几个百分点，模型质量下降。第三，**FP32 master weight 的作用**——主权重用 FP32 存（精度高，能表示 1e-8 的更新），前向反向用 FP16 算（快），更新时 `FP32_weight += FP32(lr × momentum)`，再 cast 回 FP16 给下一步前向。这样"计算快（FP16）+ 累积准（FP32 master）"，是混合精度的核心设计。省 master weight 的显存不划算（精度风险大），要省显存用 ZeRO 分片。

### 第二层：证据与定位

**Q：你用 FP16 + Loss Scaling 训练 7B 模型，跑到 step 20000 时 loss 突然变成 NaN。你怎么定位是 Loss Scaling 失效还是其他问题（梯度爆炸/数据异常）？**

分三步排查。第一，**看 Loss Scaling 的 scale 值变化**——混合精度训练的 Loss Scaling 有个动态 scale（开始是 2^16，每 N 步如果梯度不溢出就翻倍，溢出就减半）。看 TensorBoard 的 `loss_scale` 曲线，如果 step 20000 时 scale 骤降（从 2^16 降到 2^10），说明梯度频繁溢出（scale 太大），Loss Scaling 在自动降 scale，但降太多次可能失效。如果 scale 一直是 2^16 稳定，Loss Scaling 没问题，NaN 来自其他原因。第二，**看梯度分布**——step 20000 的梯度，如果某层梯度突然从 0.001 飙到 1000（梯度爆炸），是学习率过大或数据异常。用 `torch.autograd.grad` 手动检查每层梯度的 max/mean。第三，**看数据**——step 20000 对应的 batch 数据，如果有一条异常长的序列（seq_len=8192，其他都 512）或异常值（token_id 超出 vocab），是数据 bug。定位逻辑：loss_scale 降 = scaling 问题；梯度正常但某层异常 = 梯度爆炸；数据异常 = 数据问题。

### 第三层：根因深挖

**Q：你定位到是 Loss Scaling 的 scale 被频繁"溢出"降到了 2^4（太小），导致梯度精度丢失，训练不收敛。为什么 scale 会频繁溢出？**

scale 频繁溢出的根因是"梯度的动态范围大"。Loss Scaling 的原理是把 loss 乘以 scale（如 2^16），反向传播时梯度也放大 2^16 倍，让小梯度（1e-8）变成 1e-2（FP16 可表示），更新时再除以 scale 还原。但如果某些层的梯度本来就大（如 1e-2），放大 2^16 倍 = 655，超过 FP16 的最大值 65504，就"溢出"（Inf）。一旦检测到梯度 Inf，Loss Scaling 就把 scale 减半（防溢出）。如果梯度的"大小分布"跨度大（有些层 1e-8，有些层 1e-2），scale 很难选（选大的大梯度溢出，选小的小梯度下溢），就会反复溢出-降 scale。解法：第一，**用 BF16 替代 FP16**——BF16 动态范围和 FP32 一样（最大 3e38），不需要 Loss Scaling，大梯度不溢出、小梯度不下溢。这是 A100+ 的标配。第二，**如果必须用 FP16（老 GPU）**，用 per-layer Loss Scaling（不同层不同 scale）或 gradient clipping（先 clip 梯度到合理范围再 scaling）。第三，**检查学习率**——学习率过大会让梯度波动大，增加溢出概率，降学习率（从 2e-4 到 1e-4）可能缓解。

**Q：那 BF16 完美替代 FP16 了？为什么还要讨论 FP16？BF16 不是 A100 就支持吗？**

BF16 也不是完美无缺，FP16 在某些场景仍有价值。第一，**精度差异**——BF16 的尾数只有 7 位（FP16 是 10 位），所以 BF16 的"相对精度"比 FP16 低。对于"数值精度敏感"的操作（如 Softmax 累加、Layer Norm 统计），BF16 的精度损失比 FP16 大。虽然大多数情况下这个差异可忽略，但在"高精度要求的训练"（如科学计算、金融模型微调）可能敏感。第二，**硬件支持**——BF16 需要 Ampere 架构（A100）及以上，T4/V100 不原生支持 BF16（要软件模拟，慢）。如果集群有 V100（推理常用），FP16 是唯一选择。第三，**推理场景**——推理不像训练需要"长期累积精度"，FP16 的精度足够（单次前向，不累积），所以推理（vLLM/TensorRT-LLM）默认 FP16，训练（Megatron/DeepSpeed）默认 BF16。结论：训练首选 BF16（A100+），推理用 FP16（够用），老 GPU（V100）训练用 FP16 + Loss Scaling。

### 第四层：方案权衡

**Q：你们 70B 模型训练用 BF16，但 H100 支持 FP8。为什么不直接用 FP8 训练？FP8 算力是 BF16 的 2 倍，训练快一倍不是更好吗？**

FP8 训练在 2026 年仍是前沿，有精度风险和工具链成熟度问题。第一，**精度风险**——FP8 只有 4 位指数 + 3 位尾数（E4M3）或 5 位指数 + 2 位尾数（E5M2），精度极低。训练需要"主权重 FP32 + 计算 FP8"的混合精度，但 FP8 的舍入误差大，梯度更新的有效性受影响。当前 FP8 训练的 benchmark（Transformer Engine 数据）：收敛性和 BF16 接近，但需要精细调参（per-tensor scaling、recipe 选择）。第二，**工具链**——NVIDIA 的 Transformer Engine 支持 FP8，但只覆盖部分模型（Llama/Qwen 支持，自定义模型不一定）；Megatron/DeepSpeed 的 FP8 支持在 2025 年才完善，仍有 bug。第三，**收益权衡**——FP8 训练快 2 倍（H100 的 FP8 算力是 BF16 的 2 倍），但"调试 FP8 精度问题"的时间成本可能抵消加速收益。生产选择：**研究/前沿训练用 FP8**（追求极致，有时间调参），**生产训练用 BF16**（稳定可靠，收敛有保证）。拼多多的大规模生产训练用 BF16（70B/100B 模型），FP8 只在小规模实验或推理量化用。

**Q：那为什么不用 INT8 训练？INT8 推理很成熟，训练应该也能用吧？**

INT8 训练比推理难得多，目前不成熟。第一，**训练 vs 推理的精度需求不同**——推理是"单次前向"，INT8 量化误差是"单次的"，可接受。训练是"前向 + 反向 + 优化器更新"循环 10 万次，每一步的量化误差会"累积放大"。INT8 的梯度量化误差在反向传播中被放大（链式法则），导致训练不收敛。第二，**反向传播的特殊性**——反向传播要用"前向激活的量化值"和"梯度的量化值"做矩阵乘，两边的量化误差叠加，精度损失是前向的 2 倍。研究表明 INT8 训练（不加特殊技巧）会让 loss 不收敛。第三，**当前方案**——INT8 训练需要 QAT（量化感知训练，在训练时模拟量化）或特殊架构（如 GripNet、ZeroQuant），但这些方法复杂、模型覆盖有限，不是通用方案。FP8 是"更好的低精度训练方案"（硬件原生支持、有 Transformer Engine 优化），所以业界训练从 FP32 → FP16/BF16 → FP8 演进，INT8 主要用于推理。训练不用 INT8，是技术路线选择。

### 第五层：验证与沉淀

**Q：你怎么证明 BF16 训练的模型质量和 FP32 训练的一样？用什么指标证明"没掉点"？**

三个层次的对比。第一，**loss 曲线对比**——BF16 和 FP32 训练同一模型（同数据、同超参），TensorBoard 对比 training loss 和 validation loss 曲线。如果两条曲线"重叠"（差异 < 1%），说明 BF16 收敛性和 FP32 一致。如果 BF16 的 loss 稍高（0.5-1%），是 BF16 精度略低的正常表现（可接受）。第二，**下游任务 benchmark**——训练完成后，用 GSM8K/MMLU/HumanEval 测准确率，BF16 vs FP32 的差距应 < 0.5%。如果 BF16 的 GSM8K 从 85% 降到 84.7%，可接受；如果降到 80%，BF16 精度有问题（可能要调 Loss Scaling 或检查 BF16 实现）。第三，**生成质量对比**——用同一套 prompt 让 BF16 和 FP32 模型生成回答，人工评估（盲评）"两个模型谁更好"。如果人工无法区分（50:50），证明 BF16 无损。三个层次（loss + benchmark + 人工评）一致，才能说"BF16 等价于 FP32"。业界共识（OpenAI/Anthropic/Meta 的实践）：BF16 训练的 LLM 质量和 FP32 无显著差异，所以 BF16 是训练标配。

**Q：混合精度训练的经验怎么沉淀，让新模型/新同事不踩坑？**

三件事。第一，**训练配置模板**——按模型规模预设混合精度配置（7B 模型 BF16 + ZeRO-2、70B 模型 BF16 + ZeRO-3 + gradient checkpointing），新训练任务套模板，不重复调参。模板里包含：dtype、loss_scale 策略、gradient clip 值、optimizer 配置。第二，**NaN/Inf 排查 SOP**——标准化排查流程：看 loss_scale 变化 → 看梯度分布 → 看数据异常 → 看学习率，每步有具体命令（`torch.isnan(grad).any()`、TensorBoard 查 loss_scale），新人按 SOP 走。第三，**精度评估回归**——每次训练（或改混合精度配置）后，跑下游任务 benchmark（GSM8K/MMLU），和基线对比，指标退化 > 1% 不上线。把混合精度当成"需要验证的训练策略"，不是"默认开就行"。监控训练过程中的 `gradient_overflow_count`（梯度溢出次数）、`loss_scale`（scale 变化），异常告警。

## 结构化回答

**30 秒电梯演讲：** 怎么兼顾训练速度、显存、收敛性？简单说就是——混合精度训练是"前向反向用 FP16/BF16 算（快），权重/梯度/优化器状态用 FP32 存（准）"，省显存提速 2-3 倍，配合 Loss Scaling 防小梯度下溢。Loss Scaling 防 FP16 下溢；BF16（A100+）范围同 FP32 无需 scaling。

**展开框架：**
1. **主权重 FP** — 主权重 FP32 + 计算 FP16/BF16
2. **Loss S** — Loss Scaling 防 FP16 下溢
3. **BF16A** — BF16（A100+）范围同 FP32 无需 scaling

**收尾：** 您想继续往深里聊吗——比如「FP16 和 BF16 区别？」

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：混合精度训练怎么实现？FP16/BF16/FP8 怎么选？ | 今天聊「混合精度训练怎么实现？FP16/BF16/FP8 怎么选？」。一句话：混合精度训练是"前向反向用 FP16/BF16 算（快），权重/梯度/优化器状态用 FP32 存（准）" | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：主权重 FP32 + 计算 FP16/BF16 | 核心概念 |
| 0:51 | 能力/参数拆解表 | 要点是：Loss Scaling 防 FP16 下溢 | 能力拆解 |
| 1:30 | 流程图：输入→处理→输出 | 要点是：BF16（A100+）范围同 FP32 无需 scaling | 关键机制 |
| 2:09 | 代码片段 + 注释高亮 | 要点是：梯度累加：多 micro-batch 累加后更新 | 实战要点 |
| 3:00 | 总结卡 + 下期预告 | 记住这些核心点就够了。下期我们接着聊——FP16 和 BF16 区别？。 | 收尾 |
