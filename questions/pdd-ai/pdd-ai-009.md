---
id: pdd-ai-009
difficulty: L3
category: pdd-ai
subcategory: 中台
tags:
- 拼多多
- AI 中台
- 工作流引擎
- DAG
- Airflow
feynman:
  essence: 工作流引擎是"把任务编排成 DAG（有向无环图）自动调度执行"，处理依赖、重试、并发、监控，是 AI 中台/数据处理/模型训练的"流水线"。
  analogy: 像工厂流水线——零件（任务）按工序（DAG）流转，前一道工序（上游任务）做完才进下一道，机器故障（任务失败）自动重试或报警。
  first_principle: 复杂任务有依赖关系，手工调度易错且不可观测，需要引擎自动管理 DAG 调度。
  key_points:
  - DAG：节点是任务，边是依赖
  - 调度：基于时间/事件/上游触发
  - 容错：失败重试 + 超时 + 旁路
  - 选型：Airflow（Python DAG）/DolphinScheduler（可视化）/Temporal（代码即流程）
first_principle:
  problem: 怎么把多个有依赖的任务自动、可靠、可观测地编排起来？
  axioms:
  - 任务有先后依赖
  - 任务会失败要重试
  - 流程要可视化和可重跑
  rebuild: 工作流引擎（DAG 建模 + 调度器 + 执行器 + 状态机 + 监控）。
follow_up:
  - Airflow 和 DolphinScheduler 区别？——Airflow Python DAG 重代码，DS 可视化更易用
  - 任务依赖怎么定义？——DAG 中 set_downstream/set_upstream，引擎拓扑排序调度
  - 怎么保证不重复执行？——幂等 + 任务实例 ID（run_id + task_id + try_number）
memory_points:
  - DAG：任务+依赖
  - 调度：时间/事件/上游
  - 容错：重试/超时/旁路
  - 选型：Airflow/DS/Temporal
---

# 【拼多多 AI 中台】工作流引擎怎么选？DAG 调度怎么做？

> JD 依据："工作流引擎、消费者服务策略算法中台"。

## 一、为什么需要工作流引擎

**场景**（模型训练流水线）：
```
1. 拉数据（依赖数据团队）
2. 特征工程（依赖 1）
3. 模型训练（依赖 2）
4. 模型评估（依赖 3）
5. 上线发布（依赖 4，需人工审批）
```

**痛点**：
- 跨团队依赖靠人工协调
- 失败要重跑全流程（或精确定位失败步骤）
- 进度不可见，老板问"训到哪了"答不上来

**引擎解决**：DAG 描述 → 自动调度 → 失败重试 → 可视化监控。

## 二、DAG 模型

```
   ┌──────────┐
   │ 拉数据    │
   └────┬─────┘
        │
   ┌────▼─────┐
   │ 特征工程 │
   └────┬─────┘
        │
   ┌────▼─────┐    ┌──────────┐
   │ 模型训练 │◀───│ 监控数据 │
   └────┬─────┘    └──────────┘
        │
   ┌────▼─────┐
   │ 模型评估 │
   └────┬─────┘
        │
   ┌────▼─────┐
   │ 上线发布 │
   └──────────┘
```

- 节点 = 任务（Task）
- 边 = 依赖（A 完成才能跑 B）
- 拓扑排序决定执行顺序

## 三、引擎选型

| 引擎 | 风格 | 优点 | 缺点 | 场景 |
|------|------|------|------|------|
| **Airflow** | Python DAG | 生态成熟、插件多、代码化 | 学习曲线、Scheduler 单点 | 数据/ML 流水线 |
| **DolphinScheduler** | 可视化+少量代码 | 易用、可视化拖拽、去中心化调度 | 生态小 | 数据中台、运营自助 |
| **Temporal** | 代码即流程 | 强一致、长事务、状态持久化 | 重，要部署 Temporal Server | 业务流程（订单/审批） |
| **Argo Workflows** | K8s 原生 YAML | 云原生、容器化 | K8s 依赖强 | K8s 环境 ML/CI |
| **Activiti/Flowable** | BPMN | 业务流程标准 | 偏审批流，不擅长数据流 | OA/审批 |

**AI 中台推荐**：Airflow（数据/ML 流水线）+ Temporal（业务长流程），或自研 DSL 简化版。

## 四、Airflow 实战

```python
from airflow import DAG
from airflow.operators.python import PythonOperator
from airflow.providers.apache.spark.operators.spark_submit import SparkSubmitOperator
from datetime import datetime

with DAG(
    dag_id="llm_finetune_pipeline",
    start_date=datetime(2026, 1, 1),
    schedule_interval="0 2 * * *",     # 每天 2 点
    catchup=False,
    default_args={"retries": 3, "retry_delay": timedelta(minutes=5)},
) as dag:

    extract = SparkSubmitOperator(
        task_id="extract_data",
        application="/jobs/extract.py",
    )

    features = SparkSubmitOperator(
        task_id="build_features",
        application="/jobs/features.py",
    )

    train = PythonOperator(
        task_id="train_model",
        python_callable=train_llm,     # 调 GPU 训练
    )

    evaluate = PythonOperator(
        task_id="evaluate",
        python_callable=eval_model,
    )

    deploy = PythonOperator(
        task_id="deploy",
        python_callable=deploy_model,
        trigger_rule="all_done",       # 即使前面失败也尝试（用于清理）
    )

    extract >> features >> train >> evaluate >> deploy
```

**关键概念**：
- `Task`：最小执行单元
- `TaskInstance`：任务一次具体执行（含 run_id/try_number）
- `DAG Run`：DAG 一次完整执行
- `XCom`：任务间传小数据（大数据走存储）

## 五、容错与可靠性

| 机制 | 实现 |
|------|------|
| 失败重试 | `retries=3`，指数退避 |
| 超时 | `execution_timeout` |
| 幂等 | 任务设计成可重跑（覆盖写不追加） |
| 旁路 | 失败任务发钉钉/邮件，可手动重试 |
| 检查点 | 长任务存中间结果，失败从检查点恢复 |
| SLA 告警 | 任务超时未完成告警 |

## 六、AI 中台典型工作流

### 模型训练流水线
```
数据校验 → 特征构建 → 分布式训练（多 GPU）→ 评估 → 模型注册 → A/B 实验 → 灰度上线
```

### 模型推理流水线（在线）
```
请求 → 预处理 → 特征查询 → 模型推理 → 后处理 → 缓存 → 返回
```
（这是同步链路，引擎更多用编排框架如 Spring Integration）

### 数据治理流水线
```
凌晨 T+1：业务库 → CDC → ODS → DWD → DWS → 特征仓 → 实验平台指标
```

### Agent 工作流（LLM）
```
用户输入 → 意图识别（LLM）→ 路由 → 工具调用（Function Calling）→ 结果聚合 → 回复
```
LLM Agent 工作流引擎：LangGraph/AutoGen/自研（基于状态机 + DAG）。

## 七、自研工作流引擎（轻量方案）

中台不想引入 Airflow 重依赖，可基于 DB + 调度器自研：

```sql
CREATE TABLE workflow_instance (
    id BIGINT PRIMARY KEY,
    dag_id VARCHAR,
    status ENUM('RUNNING','SUCCESS','FAILED'),
    context JSON,
    started_at TIMESTAMP,
    updated_at TIMESTAMP
);

CREATE TABLE task_instance (
    id BIGINT PRIMARY KEY,
    workflow_id BIGINT,
    task_name VARCHAR,
    status ENUM('PENDING','RUNNING','SUCCESS','FAILED'),
    retry_count INT,
    upstream_task_ids JSON,
    started_at TIMESTAMP,
    ended_at TIMESTAMP
);
```

调度器扫表 → 拓扑排序找可执行任务（上游全 SUCCESS）→ 跑 → 更新状态。

## 八、底层本质

工作流引擎本质是**"DAG 建模 + 拓扑调度 + 状态机 + 容错"**——把复杂依赖关系抽象成图，引擎负责调度执行、失败重试、状态持久化、可视化。AI 中台用它编排数据流水线、模型训练、Agent 工作流，是"AI 生产的流水线"。

## 常见考点

1. **怎么保证任务幂等**？——任务设计成"覆盖写"而非"追加"，用任务实例 ID 做去重，关键步骤加分布式锁。
2. **环形依赖怎么处理**？——DAG 不允许环，构建时检测（拓扑排序能完成则无环），环要拆成多个 DAG 或加状态机。
3. **大 DAG 性能问题**？——Airflow Scheduler 是单点，万级任务要分 Scheduler（CeleryExecutor + 多 worker），或换 Argo/K8s 原生。
