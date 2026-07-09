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
