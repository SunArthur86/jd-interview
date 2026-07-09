---
id: pdd-scm-037
difficulty: L4
category: pdd-scm
subcategory: LLM 训练
tags:
- 拼多多
- 供应链
- AI Infra
- 大模型基础设施
- 训练
feynman:
  essence: AI Infra 是支撑大模型全生命周期的底层——数据（采集/标注）+ 训练（分布式）+ 推理（部署/优化）+ 监控（评估/迭代），相当于 AI 时代的"数据库+中间件"。
  analogy: AI Infra 像传统软件的"数据库+应用服务器+监控"——上层应用（Agent/LLM）跑在它上面。
  first_principle: 大模型从训练到生产涉及海量数据、巨大算力、复杂工程，需平台化基础设施。
  key_points:
  - 数据层：采集、标注、版本（DVC）
  - 训练层：分布式（数据/张量/Pipeline 并行）+ checkpoint
  - 推理层：vLLM、量化、GPU 调度
  - 监控层：漂移检测、效果评估、迭代
first_principle:
  problem: 大模型全生命周期（数据→训练→推理→监控）每环都复杂，如何系统化？
  axioms:
  - 数据是基础
  - 训练成本高（GPU 稀缺）
  - 推理要工程化
  rebuild: AI Infra 平台——数据管理+训练平台+推理服务+监控评估。
follow_up:
- 训练 GPU 怎么调度？——训练 A100/H100，推理 T4/A10，优先级调度
- Java 工程师转 AI Infra 优势？——分布式系统、性能优化、工程化
- 大模型怎么持续迭代？——决策回流→标注→增量训练→灰度上线
memory_points:
- AI Infra = 数据 + 训练 + 推理 + 监控 四层
- 训练：分布式（数据/张量/Pipeline 并行）
- 推理：vLLM + 量化 + GPU 池化
- 监控：漂移检测 + 效果评估 + 迭代
---

# 【拼多多供应链】AI Infra 怎么设计？

> JD 依据：JD 9 大模型工程师核心。

## 一、AI Infra 四层

```
数据层（采集/标注/版本 DVC）
   ↓
训练层（分布式训练 PyTorch/DeepSpeed）
   ↓
推理层（vLLM 部署/量化/GPU 调度）
   ↓
监控层（漂移/效果/迭代）
```

## 二、数据层

```bash
# DVC 数据版本管理
dvc add datasets/supply_chain_202607.csv
dvc push
git commit -m "update dataset"
```

- 标注：Label Studio + 主动学习
- 版本：DVC（数据可追溯）
- 特征：特征平台（Feast）

## 三、训练层

**分布式训练**：
| 并行 | 适用 |
|------|------|
| 数据并行 | 模型单卡放得下 |
| 张量并行 | 单卡放不下（切矩阵） |
| Pipeline 并行 | 超大模型（切层） |

**Checkpoint**：定期保存，故障可恢复。

**实验管理**：MLflow / W&B（参数/metrics/模型追踪）。

## 四、推理层

```python
# vLLM 部署
llm = LLM(
    model="/models/supply-chain-llm",
    quantization="awq",              # INT4 量化
    tensor_parallel_size=4,          # 4 GPU 张量并行
    gpu_memory_utilization=0.9,
)
```

**GPU 调度**：
```
训练池（A100，高优先级）
推理池（T4/A10，常驻）
弹性池（闲时共享）
```

## 五、监控层

```python
def check_drift(model):
    psi = compute_psi(current_features, baseline)
    if psi > 0.25: alert("数据漂移")
    recent_auc = evaluate(model, recent_data)
    if recent_auc < baseline - 0.05: trigger_retrain()
```

## 六、底层本质

AI Infra 是**"让 AI 从手工作坊到工业流水线"**：
- 数据平台统一管理
- 训练流水线自动化
- 部署标准化
- 监控持续化

**Java 工程师的优势**：分布式系统、性能优化、工程化——AI Infra 本质是系统工程。

## 常见考点
1. **AI Infra 和 MLOps 区别**？——MLOps 偏流程（CI/CD），AI Infra 偏平台（基础设施）。
2. **训练和推理为什么用不同 GPU**？——训练需大显存（A100）；推理重吞吐（T4 性价比）。
3. **怎么处理模型漂移**？——监控数据/概念漂移 → 触发重训。
