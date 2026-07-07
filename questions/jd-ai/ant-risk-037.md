---
id: ant-risk-037
difficulty: L4
category: jd-ai
subcategory: LLM 推理
tags:
- 蚂蚁
- 风控
- AI Infra
- 大模型基础设施
- 训练
- 数据
feynman:
  essence: AI Infra 是支撑大模型全生命周期的底层设施——数据（采集/标注/管理）、训练（分布式/优化）、推理（部署/服务）、监控（评估/迭代），相当于 AI 时代的"数据库 + 中间件"。
  analogy: AI Infra 像传统软件的"数据库+应用服务器+监控"——上层应用（Agent/LLM）跑在它上面，它管数据、训练、部署、监控的脏活累活。
  first_principle: 大模型从训练到生产涉及海量数据、巨大算力、复杂工程，单点工具不够；需要平台化的基础设施让 AI 开发像传统软件开发一样高效。
  key_points:
  - 数据层：采集、标注、版本、特征
  - 训练层：分布式训练、优化器、checkpoint
  - 推理层：部署、服务、优化（vLLM）
  - 监控层：评估、漂移、迭代
  - 工具链：MLflow、Weights & Biases、Ray
first_principle:
  problem: 大模型应用涉及数据、训练、推理、监控的全链路，每环都复杂，如何系统化？
  axioms:
  - 数据是基础（脏数据训不出好模型）
  - 训练成本高（GPU 稀缺）
  - 推理要工程化（生产部署）
  - 必须持续监控（漂移、效果）
  rebuild: AI Infra 平台——数据管理（采集标注）+ 训练平台（分布式调度）+ 推理服务（部署优化）+ 监控评估（持续迭代），让 AI 开发标准化。
follow_up:
- 训练和推理 GPU 怎么调度？——训练用 A100/H100（大显存），推理用 T4/A10（性价比）
- 大模型怎么持续迭代？——决策回流 → 标注 → 增量训练 → 灰度上线
- 风控 AI Infra 的特点？——数据敏感（私有部署）、实时性要求（推理延迟）、监管（可追溯）
memory_points:
- AI Infra = 数据 + 训练 + 推理 + 监控 四层
- 数据：采集/标注/版本（DVC）/特征
- 训练：分布式（数据/张量/Pipeline 并行）+ checkpoint
- 推理：vLLM + 量化 + GPU 池化
- 风控特点：私有部署、实时、监管
---

# 【蚂蚁风控】AI Infra 怎么设计？支撑大模型全生命周期

> JD 依据："智能化数据平台" + "大模型"。AI Infra 是 AI 时代的基础设施。

## 一、AI Infra 是什么

**AI Infra = 大模型的"操作系统 + 数据库 + 中间件"**

支撑大模型全生命周期：
```
数据采集 → 数据标注 → 模型训练 → 模型评估 → 模型部署 → 推理服务 → 监控评估 → 迭代
   ↑________________________________________________________________________________↓
                                          闭环
```

**对比传统软件**：
| 传统软件 | AI 应用 |
|---------|---------|
| IDE | Notebook / ML 平台 |
| 数据库 | 数据平台 + 特征平台 |
| 应用服务器 | 推理服务 |
| 监控 | 评估 + 漂移监控 |
| CI/CD | 训练流水线 |

## 二、AI Infra 的四层架构

### 1. 数据层

**数据采集**：
- 业务数据（风控决策日志）
- 公开数据（规则文档、法规）
- 标注数据（人工审核结果）

**数据标注**：
- 平台：Label Studio、Doccano
- 标注：人工 + 主动学习（模型辅助）
- 质量：多人标注 + 投票

**数据版本**（DVC）：
```bash
dvc add datasets/risk_events_202607.csv
dvc push  # 推到对象存储
git commit -m "update dataset"
# 数据可追溯、可回滚
```

**特征平台**（见 ant-risk-022）：
- 特征定义、计算、存储、服务

### 2. 训练层

**分布式训练**：

| 并行方式 | 原理 | 适用 |
|---------|------|------|
| **数据并行** | 每张卡算一部分数据，梯度同步 | 模型放得下单卡 |
| **张量并行** | 把模型矩阵切到多卡 | 模型放不下单卡 |
| **Pipeline 并行** | 把模型层分到多卡 | 超大模型（GPT-3 级） |

**训练框架**：
- PyTorch DDP（数据并行）
- DeepSpeed（ZeRO 优化）
- Megatron-LM（大模型）

**checkpoint 管理**：
```python
# 定期保存 checkpoint（容错）
for epoch in range(epochs):
    train_one_epoch()
    if epoch % 5 == 0:
        save_checkpoint(model, optimizer, epoch)

# 训练中断可恢复
load_checkpoint(latest)
```

**超参管理**：
- Weights & Biases / MLflow
- 实验追踪（参数、metrics、模型）

### 3. 推理层（见 ant-risk-034）

**模型部署**：
- 模型仓库（版本管理）
- 灰度发布（影子流量 → 灰度 → 全量）
- 蓝绿部署（一键切流）

**推理优化**：
- vLLM/PagedAttention
- 量化（INT8/INT4）
- 批处理

**GPU 调度**：
```
GPU 集群（K8s + GPU 调度）
  ├─ 训练任务（高优先级，A100）
  ├─ 推理服务（中优先级，T4/A10）
  └─ 批处理（低优先级，闲时跑）
```

### 4. 监控评估层

**在线监控**：
- 推理性能（延迟、QPS、错误率）
- 业务指标（决策准确率、拦截率）
- 数据漂移（特征分布变化）

**离线评估**：
- 测试集准确率
- A/B 对比
- 人工标注抽检

**模型迭代**：
```
决策回流 → 标注 → 增量训练 → 评估 → 上线
周期：周/月
```

## 三、AI Infra 工具链

| 阶段 | 工具 |
|------|------|
| 数据 | DVC、Label Studio、Feast |
| 训练 | PyTorch、DeepSpeed、Ray |
| 实验 | MLflow、W&B、TensorBoard |
| 部署 | Triton、vLLM、BentoML |
| 监控 | Evidently、Arize、Fiddler |
| 编排 | Airflow、Kubeflow、Metaflow |

## 四、风控 AI Infra 的特点

**1. 数据敏感**：
- 私有部署（数据不出境）
- 加密存储、访问审计
- 训练数据脱敏

**2. 实时性**：
- 推理延迟 < 500ms
- 决策链路集成
- 异步复核（秒级）

**3. 监管要求**：
- 决策可追溯（带证据）
- 模型可解释
- 审计日志保留

**4. 规模大**：
- 亿级用户、千亿特征
- 千万级事件/天
- 持续训练

## 五、训练流水线（风控场景）

```python
# 端到端训练流水线
@pipeline
def risk_model_pipeline():
    # 1. 数据准备
    data = load_decision_logs(start='-30d')
    labeled = label_with_audit(data)  # 用人工审核结果标注

    # 2. 特征工程
    features = feature_store.get_features(labeled['uid'])

    # 3. 训练
    model = train(
        data=labeled,
        features=features,
        hyperparams={'lr': 1e-4, 'epochs': 10}
    )

    # 4. 评估
    metrics = evaluate(model, test_set)
    if metrics.auc < 0.75:
        alert("模型质量下降")
        return

    # 5. 部署（灰度）
    deploy(model, traffic=0.1)  # 10% 灰度
    monitor(model)
```

## 六、GPU 资源调度

**问题**：GPU 稀缺且贵，需要高效调度。

**策略**：
```
集群分级:
  - 训练池（A100，高优先级）
  - 推理池（T4/A10，常驻服务）
  - 弹性池（闲时共享）

调度:
  - 工作时间：训练 + 推理
  - 夜间：批处理 + 训练
  - GPU 复用（多模型共享）
```

**蚂蚁的实践**：
- 自研 GPU 调度系统
- 多租户隔离
- 弹性扩缩容

## 七、模型管理（Model Registry）

**模型仓库**：
```
models:
  - name: risk-decision-v2
    versions:
      - 2.3.1 (production, 100%)
      - 2.3.2 (canary, 10%)
      - 2.4.0 (shadow, 0%)
    metrics: {auc: 0.85, psi: 0.05}
    training_data: datasets/risk_202606
```

**功能**：
- 版本管理（每次迭代存版本）
- 灰度控制（流量比例）
- 回滚（一键切回旧版）
- 元数据（训练数据、参数、metrics）

## 八、模型漂移监控

**漂移类型**：
- **数据漂移**：特征分布变化（PSI > 0.25 告警）
- **概念漂移**：标签和特征关系变化（欺诈模式变了）
- **预测漂移**：模型输出分布变化

**监控**：
```python
def check_drift(model):
    # 数据漂移
    psi = compute_psi(current_features, baseline_features)
    if psi > 0.25:
        alert(f"数据漂移: PSI={psi}")

    # 概念漂移
    recent_auc = evaluate(model, recent_labeled)
    if recent_auc < model.baseline_auc - 0.05:
        alert(f"模型效果下降: AUC={recent_auc}")

    # 触发重训
    if psi > 0.25 or recent_auc < threshold:
        trigger_retrain()
```

## 九、底层本质：AI 的"工业化"

AI Infra 的本质是**让 AI 从"手工作坊"到"工业流水线"**：

**手工作坊**：
- 数据科学家个人 Notebook
- 手动训练、手动评估
- 部署靠工程师手动

**工业流水线**（AI Infra）：
- 数据平台统一管理
- 训练流水线自动化
- 部署标准化
- 监控持续化

**这是传统软件工程在 AI 领域的重演**：
- 1950s：机器码（手工作坊）
- 1970s：编译器 + 操作系统（基础设施）
- 2000s：CI/CD + 云（工业流水线）
- 2020s：AI Infra（AI 工业流水线）

## 十、Java 工程师转 AI Infra 的优势

**AI Infra 的本质是系统工程**，Java 工程师的优势：

| 维度 | Java 工程师优势 |
|------|----------------|
| 分布式系统 | 训练集群调度、推理服务部署 |
| 性能优化 | 推理优化、并发模型 |
| 工程化 | 平台架构、可观测性 |
| 数据处理 | 大数据（Spark/Flink） |
| 高可用 | 服务编排、容灾 |

**需要补充**：
- ML 基础（不深，懂概念）
- Python（生态语言）
- GPU 编程（CUDA 基础）
- ML 框架（PyTorch）

**转型路径**：
1. Java 后端 → 推理服务工程师（部署 LLM）
2. → AI Harness 工程师（建平台）
3. → AI Infra 架构师（全链路设计）

## 十一、未来趋势

**1. 大模型统一化**：
- 一个模型多任务（不用每场景训一个）
- 基础模型 + 微调

**2. Agent 化**：
- 推理服务变成 Agent 服务
- 工具调用、长程推理

**3. 多模态融合**：
- 文本 + 图像 + 音频 + 行为
- 统一特征空间

**4. 边缘 AI**：
- 风控场景：端侧推理（手机端预检）
- 降低中心压力

## 十二、和风控架构的融合

**风控 AI Infra**：
```
传统风控:
  规则引擎 + 模型服务 + 数据平台

AI 加持后:
  规则引擎 + AI Agent + AI Harness + AI Infra
                          ↑
                    LLM 网关、推理服务、训练平台
```

**演进路径**：
- Stage 1：传统风控 + AI 辅助（解释、提示）
- Stage 2：AI 主导（边缘场景）+ 传统兜底
- Stage 3：AI 原生风控（基础设施全 AI 化）

## 常见考点
1. **AI Infra 和 MLOps 区别**？——MLOps 偏流程（CI/CD），AI Infra 偏平台（基础设施），二者重叠。
2. **训练和推理为什么用不同 GPU**？——训练需大显存（A100 80GB）、高带宽；推理重吞吐（T4 性价比）、可量化。
3. **怎么处理模型漂移**？——监控数据/概念漂移 → 触发重训 → 灰度上线新模型。

**代码示例**（训练流水线编排）：
```yaml
# Kubeflow Pipeline
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  name: risk-model-training
spec:
  templates:
  - name: data-prep
    container:
      image: spark:3.5
      command: ["spark-submit", "data_prep.py"]

  - name: train
    container:
      image: pytorch:2.0
      resources:
        limits: {nvidia.com/gpu: 4}
      command: ["python", "train.py"]

  - name: evaluate
    container:
      image: pytorch:2.0
      command: ["python", "evaluate.py"]

  - name: deploy
    container:
      image: deployer:1.0
      command: ["./deploy.sh", "--canary", "10%"]
```
