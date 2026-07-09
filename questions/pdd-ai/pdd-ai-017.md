---
id: pdd-ai-017
difficulty: L4
category: pdd-ai
subcategory: LLM 推理
tags:
- 拼多多
- AI 中台
- 量化
- INT8
- INT4
- AWQ
- GPTQ
feynman:
  essence: 量化是"把 FP16 权重压成 INT8/INT4"，显存减半到 1/4，推理提速 2-4 倍，掉点通常 < 1%；AWQ/GPTQ 是当前主流 PTQ 算法。
  analogy: 像照片压缩——JPEG 把 BMP 压到 1/10，肉眼几乎看不出差别（精度损失小），但传输/存储快得多。
  first_principle: LLM 推理瓶颈是显存和带宽，FP16 大部分位是冗余信息，用低比特表示能 2-4 倍降本。
  key_points:
  - PTQ（训练后量化）vs QAT（量化感知训练）
  - 对称/非对称、per-tensor/per-channel/per-group
  - AWQ：激活感知保护重要权重
  - GPTQ：基于二阶信息逐层量化
  - INT4 几乎无损，INT8 通用首选
first_principle:
  problem: 怎么在不掉点的前提下大幅降显存和带宽？
  axioms:
  - 权重分布相对集中
  - 部分权重对输出敏感（保护重点）
  - 算力受限于显存带宽
  rebuild: 量化（低比特表示 + 重要权重保护 + 反量化计算）。
follow_up:
  - INT4 量化会掉多少点？——AWQ/GPTQ 通常 PPL 涨 < 1，下游任务几乎无损
  - 量化为什么能加速？——显存带宽减半/4 倍，Decode 阶段带宽瓶颈直接受益
  - GGUF 和 AWQ 区别？——GGUF llama.cpp 用（CPU/混合），AWQ GPU 用
memory_points:
  - PTQ 训后量化 vs QAT 训练感知
  - AWQ：激活感知保护重要权重
  - GPTQ：二阶信息逐层量化
  - INT4 几乎无损，INT8 通用
---

# 【拼多多 AI 中台】LLM 量化（INT8/INT4/AWQ/GPTQ）怎么选？

> JD 依据："量化、推理加速、混合精度"。

## 一、为什么量化

**显存压力**：
```
LLaMA-70B FP16 = 140GB → 单 8×H100（640GB）才能放
LLaMA-70B INT4 = 35GB  → 单 H100（80GB）轻松放
```

**带宽压力**（Decode 阶段更明显）：
```
FP16：每 token 读 140GB 权重 → 70ms（2TB/s HBM）
INT4：每 token 读 35GB   → 17ms（4x 加速）
```

## 二、量化分类

### 1. 按时机
- **PTQ**（Post-Training Quantization，训练后量化）：训完直接量化，快速通用
- **QAT**（Quantization-Aware Training，量化感知训练）：训练时模拟量化，精度更好但成本高

### 2. 按比特
- INT8：通用、几乎无损
- INT4：激进、需保护（AWQ/GPTQ）
- FP8：H100 支持，介于 INT8/FP16 之间

### 3. 按粒度
- per-tensor：整个张量一组 scale（粗）
- per-channel：每通道一组（中）
- per-group：每 N 个连续元素一组（细，AWQ/GPTQ 用）

### 4. 对称/非对称
- 对称：[-max, max] 映射到 [-127, 127]（INT8）
- 非对称：[min, max] 映射到 [0, 255]，加 zero-point

## 三、基础 PTQ（RTN，Round-To-Nearest）

最简单：直接四舍五入。

```python
scale = max(|W|) / 127
W_int8 = round(W / scale)
# 反量化
W_recovered = W_int8 * scale
```

**问题**：粗暴，INT4 掉点明显（异常大值拉高 scale，小值精度差）。

## 四、GPTQ：基于二阶信息的逐层量化

**核心思想**：量化一个权重时，用 Hessian 矩阵（二阶信息）调整其他权重补偿误差。

```
对每层权重 W（OUT × IN）：
1. 计算 Hessian H = X·X^T（X 是校准数据激活）
2. 逐列量化 W[:, j]：
   - 量化 W[:, j] → ŵ
   - 误差 e = W[:, j] - ŵ
   - 调整未量化列：W[:, rest] -= e · H[j, rest] / H[j, j]
3. 累积误差被后续列补偿
```

**优点**：精度好，INT4 几乎无损。
**缺点**：量化过程慢（分钟到小时级），需校准数据集（128-1024 样本）。

## 五、AWQ：激活感知保护重要权重

**核心观察**：不是所有权重都同样重要，少数"显著"权重（对应大幅激活）量化后掉点多。

**思路**：
```
1. 用校准数据找"重要"权重（激活幅度大）
2. 给重要权重乘缩放因子 s（>1）放大
3. 整体量化（重要权重相对误差小）
4. 推理时反缩放
```

```python
# AWQ 简化
salient = find_salient_weights(W, calibration_data)
s = compute_scale(salient)              # 重要权重缩放
W_scaled = W * s
W_int = quantize(W_scaled)
# 推理：output = dequantize(W_int) * x / s
```

**优点**：比 GPTQ 快（秒级）、精度相当、推理更快。
**缺点**：仍需少量校准数据。

## 六、对比表

| 方法 | 比特 | 精度 | 量化速度 | 推理速度 | 适用 |
|------|------|------|----------|----------|------|
| FP16 | 16 | 满分 | - | 基准 | 高端卡 |
| RTN | 8/4 | INT8 好/INT4 差 | 快 | 快 | 简单 |
| GPTQ | 8/4 | 优 | 慢（分钟级） | 快 | 高精度需求 |
| AWQ | 8/4 | 优 | 中（秒级） | 最快 | 生产首选 |
| SmoothQuant | 8 | 优 | 中 | 快 | 激活+权重量化 |
| FP8（H100） | 8 | 接近 FP16 | 快 | 极快 | 新硬件 |

## 七、使用方式

### vLLM 加载 AWQ 模型
```bash
vllm serve TheBloke/Llama-2-13B-AWQ \
    --quantization awq \
    --dtype half
```

### TensorRT-LLM 量化
```python
# GPTQ 转 TRT-LLM 引擎
python convert_checkpoint.py \
    --model_dir ./llama-gptq \
    --quantization gptq \
    --output_dir ./trt-engine
```

### Java 业务侧
业务侧不直接量化，但要：
- 监控量化后效果（业务指标对比）
- 评估成本（INT4 减半显存 → 单卡跑更大模型）
- 兜底方案（量化出问题切 FP16）

## 八、量化为什么能加速

```
Decode 阶段每 token 都要读全部权重
权重越大，访存时间越长（带宽瓶颈）
量化后权重大小减半（INT8）或 1/4（INT4）
访存时间相应减少 → Decode 提速 2-4 倍

注意：Prefill 阶段算力瓶颈，量化收益小（甚至矩阵乘 INT8 反量化有开销）
```

## 九、量化陷阱

1. **INT4 掉点**：数学/代码任务可能掉 3-5%（重要任务用 INT8）
2. **异常值**：少数极端权重拉高 scale，导致整体精度差（用 per-group 或 AWQ）
3. **KV Cache 量化**：权重之外还要考虑 KV 量化
4. **硬件支持**：INT4 需要 GPU 支持（A100/H100 支持，老卡可能不支持 INT4 kernel）
5. **校准数据**：要和业务分布一致（中文场景用中文校准集）

## 十、底层本质

量化本质是**"用更少比特表示权重，关键权重重点保护"**——直接舍入（RTN）粗暴掉点多，GPTQ/AWQ 通过校准数据 + 二阶信息/激活感知智能量化，INT4 几乎无损。对 Decode 阶段（带宽瓶颈）提速明显，是 LLM 推理降本最直接有效的手段。

## 常见考点

1. **INT8 和 INT4 怎么选**？——通用首选 INT8（几乎无损），显存极紧/极致成本选 INT4（数学/代码任务谨慎）。
2. **量化为什么对 Prefill 加速小**？——Prefill 是算力瓶颈，量化甚至增加反量化开销；Decode 是带宽瓶颈，量化直接减带宽。
3. **KV Cache 怎么量化**？——INT8/FP8，配合 sliding window 控制长序列；注意长序列误差累积。
