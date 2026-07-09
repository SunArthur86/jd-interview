---
id: pdd-trade-037
difficulty: L4
category: pdd-trade
subcategory: 模型服务
tags:
- 拼多多
- 交易
- AI Infra
- GPU 调度
- 推理平台
- 弹性
feynman:
  essence: AI Infra 是"支撑 AI 应用的基础设施"——GPU 池化/调度、训练推理平台、模型仓库、弹性扩缩、监控计费，让业务像用云一样用 AI。
  analogy: AI Infra 像"电厂"——业务方不需要自己发电（买 GPU），插电（调 API）就用，电厂负责发电+调度+计费+稳定。
  first_principle: GPU 贵且稀缺，每个业务自建不现实，需统一池化+调度+服务化。
  key_points:
  - GPU 池化：统一池+优先级调度
  - 推理平台：vLLM/Triton 服务化+自动扩缩
  - 训练平台：任务队列+资源隔离
  - 模型仓库：版本化+灰度+回滚
  - 计费监控：按 token/秒计费+成本归因
first_principle:
  problem: GPU 贵且稀缺，如何统一服务多个 AI 业务？
  axioms:
  - GPU 成本高（H100 单卡数万美元）
  - 业务潮汐（白天推理高峰/夜间训练）
  - 需隔离和公平
  rebuild: GPU 池化 + 优先级调度 + 推理/训练平台 + 弹性 + 计费。
follow_up:
  - GPU 怎么池化？——物理 GPU 切片（MIG）+ 虚拟 + 任务级复用
  - 推理和训练怎么不抢资源？——分池 + 优先级 + 分时（白天推理/夜间训练）
  - 怎么降本？——弹性扩缩+ Spot 实例+蒸馏量化+路由小模型
memory_points:
  - GPU 池化+优先级调度
  - 推理平台：vLLM/Triton 服务化
  - 训练平台：队列+隔离
  - 弹性+计费+监控
---

# 【拼多多交易】AI Infra 怎么搭？

> JD 依据："AI Infra"。

## 一、整体架构

```
业务方（交易/客服/搜索/推荐）
    ↓ 统一 API
AI 网关（路由/鉴权/限流/计费）
    ↓
┌─────────────────────────────────┐
│ 推理平台          训练平台       │
│ vLLM/Triton       任务队列       │
│ 自动扩缩           资源隔离       │
└─────────────────────────────────┘
    ↓
GPU 池（H100/A100 集群）
    ↓ 调度
K8s + Volcano/KubeFlow
```

## 二、GPU 池化与调度

**池化**：
```
物理 GPU → MIG 切片（1 卡切 7 实例，小模型用）
        → 任务级复用（推理完切训练）
统一池 → 按业务优先级分配
```

**优先级调度**（Volcano）：
```yaml
# 在线推理（高优先级）
scheduling:
  priorityClassName: high-priority
  queue: inference
# 离线训练（低优先级，可抢占）
scheduling:
  priorityClassName: low-priority
  queue: training
  preemptionPolicy: PreemptLowerPriority
```

**分时**：
```
白天 9-23：80% GPU 给推理（大促 100%）
夜间 23-9：GPU 给训练（微调/对齐）
```

## 三、推理平台

```yaml
# 模型服务（KServe/vLLM）
apiVersion: serving.kserve.io/v1beta1
kind: InferenceService
metadata:
  name: trade-llm
spec:
  predictor:
    minReplicas: 2
    maxReplicas: 50
    scaleTarget: 100    # QPS 触发扩容
    containers:
      - image: vllm:v0.6
        args: ["--model=qwen2-7b", "--tensor-parallel-size=2"]
        resources:
          limits: {nvidia.com/gpu: 2}
```

**自动扩缩**：
```
QPS 涨 → HPA 扩副本
GPU 利用率低 → 缩容（成本）
大促预热 → 提前手动扩
```

## 四、训练平台

```
任务队列（训练/微调/评测）→ 资源调度 → GPU 执行 → 日志/指标
```

**微调流水线**：
```python
@pipeline
def finetune_pipeline(dataset, base_model):
    # 1. 数据预处理
    train_data = preprocess(dataset)
    # 2. LoRA 微调
    adapter = lora_finetune(base_model, train_data)
    # 3. 评测
    score = evaluate(adapter, eval_set)
    if score < threshold:
        return reject()
    # 4. 合并+部署
    merged = merge_adapter(base_model, adapter)
    deploy(merged, stage="canary")
```

## 五、模型仓库

```
模型中心（MLflow）：
  - 版本化（v1/v2/canary）
  - 元数据（训练数据/指标/prompt）
  - 灰度发布（5%→20%→100%）
  - 一键回滚
```

## 六、计费与监控

```
按 token 计费：业务调用多少 token 算多少钱
按 GPU 时：训练任务按卡时
监控：
  GPU 利用率（目标 > 70%）
  推理 RT/吞吐
  业务成本归因（哪个接口花多少）
```

## 七、拼多多实战

- **GPU 集群**：千卡级 H100，推理/训练分池
- **弹性**：大促白天推理扩到 80%，夜间切训练
- **多模型路由**：简单走 1.5B（便宜），复杂走 14B（贵但准）
- **成本看板**：每个 AI 接口的 GPU 成本，业务方按需优化

## 八、底层本质

AI Infra 本质是**"把 GPU 当云资源来管"**——池化提利用率，调度保公平，平台化降低业务门槛，弹性降成本。

## 常见考点
1. **GPU 利用率怎么提**？——池化+分时+MIG 切片+Continuous Batching。
2. **推理扩容有什么坑**？——模型加载慢（分钟级），需预热+流量预热。
3. **训练和推理冲突怎么办**？——分池+优先级抢占+Volcano 调度。
