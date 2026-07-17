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

## 苏格拉底式面试追问

> 这组追问不背答案，模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：你们的模型训练流水线为什么用 Airflow 而不是用 Argo Workflows？Argo 是 K8s 原生的，你们训练任务都跑在 K8s 上，不是更顺吗？**

历史和生态原因。Airflow 在我们引入时（2020 年）生态最成熟——Python DAG 灵活（算法同学会 Python）、Operator 丰富（SparkSubmitOperator、EmailOperator、SlackOperator）、UI 成熟、社区大。Argo 当时还偏新，文档少。现在 Argo 确实更适合 K8s 原生场景（YAML 声明、Pod 级别调度、GPU 资源直接用 K8s 的 device plugin），但迁移成本高——我们有上千个 DAG，全部从 Python 翻译成 YAML 工作量巨大，而且 Airflow 的 Python DAG 里有很多复杂逻辑（条件分支、XCom 传参、动态生成 task），Argo 的 YAML 表达这些更繁琐。折中方案：新项目用 Argo（K8s 原生优势明显），老项目维持 Airflow，通过 Webhook 互调（Airflow 的 DAG 完成后触发 Argo Workflow）。

### 第二层：证据与定位

**Q：一个模型训练流水线（extract→features→train→evaluate→deploy）跑到 train 步骤时 hung 住了 30 分钟没动。你怎么排查是任务卡死还是在等资源？**

分三步。第一，看 Airflow UI 的 Task Instance 详情——`Task State` 如果是 `running`，看 `Duration` 是否异常长；点进 `Log` 看 K8s Pod 的日志，如果日志最后一条是 `Loading checkpoint...` 然后没下文，是任务真的在跑（可能是数据加载慢）。如果日志停在 `Scheduling pod...`，是 K8s 调度器没分配到 GPU（集群满载）。第二，`kubectl get pods -n airflow | grep <task-id>` 看 Pod 状态——如果 `Pending`，是资源不足（`kubectl describe pod` 看 Events，会写 `Insufficient nvidia.com/gpu`）；如果 `Running` 但 CPU/GPU 利用率 0（看 Prometheus），是训练进程死锁了（NCCL 等待超时但没报错）。第三，看 Airflow Scheduler 日志——如果 Scheduler 本身 hang 了（单点问题），所有 Task Instance 都会卡，不只这一个。

### 第三层：根因深挖

**Q：你定位到是 train Pod 一直 Pending，`kubectl describe` 显示 `Insufficient nvidia.com/gpu`。集群明明有 100 张 GPU，为什么分配不到？**

根因可能是三个。第一，拓扑约束——训练任务要 8 卡 NVLink 互联（`nodeSelector: accelerator=nvidia-a100 + hostIPC: true`），集群有 100 张卡但分布在不同节点，满足"单节点 8 卡"的节点只有 10 个且都被占满了。第二，优先级被抢占——高优先级的在线推理 Pod 抢走了 GPU，训练任务（低优）被 evict 或调度不上去。看 `kubectl get events` 有没有 `Preempted` 事件。第三，GPU 资源碎片化——K8s 默认调度器不做 GPU bin-packing，如果一个节点上 8 张卡被 8 个单卡 Pod 各占 1 张，剩 0 张整块可用，8 卡训练任务调度不上去。解法：用 Volcano/KubeBatch 的 Gang Scheduling（全部 8 卡资源就绪才启动，避免部分启动后死等），或定期清理僵尸 Pod 释放碎片。

**Q：那为什么不直接给训练任务高优先级，让它能抢占推理任务的 GPU？训练可是离线的，不影响线上。**

这是在线/离线混部的核心矛盾。训练任务时长通常几小时到几天，如果给它高优先级抢占推理 Pod，推理 Pod 被 evict 后要重新加载模型（分钟级冷启动），线上 P99 延迟飙升，影响真实用户。正确做法是"时间错峰 + 弹性抢占"：白天（流量高峰）训练任务低优先级，只填推理的空闲 GPU；夜间（流量低谷）训练任务提升优先级，批量跑。我们的策略是给训练任务配 `priorityClassName: training-night`（白天低优）和 `training-batch`（夜间中优），配合 CronJob 在 23:00 自动切换优先级。极端情况下（紧急训练）手动提优先级，但要走审批 + 通知值班。混部的关键是"不为了离线效率牺牲在线 SLA"。

### 第四层：方案权衡

**Q：你们用 Airflow 的 retries=3 + 指数退避做容错。但如果 train 步骤在第 2 次重试时成功了，第 1 次重试的副作用（比如写了部分 checkpoint）怎么处理？**

这取决于任务是否幂等。如果 train 步骤每次都从头读数据、覆盖写 checkpoint（`torch.save` 覆盖同名文件），重试没有副作用，自然幂等。但如果 checkpoint 是追加写（`append` 模式）或中间结果写到分布式存储没清理，重试会产生脏数据。规范要求：第一，所有 DAG 任务的输出必须覆盖写（`OUTPUT_DIR` 每次启动先 `rm -rf` 清空），保证重试幂等。第二，任务实例 ID（`run_id + task_id + try_number`）作为输出路径的一部分（`/output/{dag_id}/{run_id}/{task_id}/try_{try_number}/`），重试不会覆盖前次，事后可审计。第三，跨任务的依赖用 Airflow 的 XCom 或外部存储（S3/HDFS）传参，不用本地文件（本地文件在 Pod 重启后丢失）。

**Q：为什么不直接用 Temporal？Temporal 有强一致的状态持久化，重试/补偿/长事务都原生支持，比 Airflow 的 retries 强多了。**

Temporal 确实更强（workflow 状态持久化、activity 重试可配置、长流程支持好），但它偏"业务流程编排"（订单/审批/支付），对"数据/ML 流水线"的场景支持不如 Airflow。Airflow 有 SparkSubmitOperator、HiveOperator、S3Sensor 这些开箱即用的数据生态 Operator，Temporal 要自己写 Activity 适配。而且 Temporal Server 本身要部署（Temporal Cluster + 数据库），运维成本高于 Airflow（Airflow 一个 Scheduler + PostgreSQL 就能起）。选型看场景：数据/ML 流水线用 Airflow，业务长流程用 Temporal，不要强求统一。

### 第五层：验证与沉淀

**Q：你怎么证明训练流水线的容错机制真的能在 Pod 挂掉时恢复？平时不挂的时候根本验证不了。**

混沌注入。第一，定期（每周一次）在生产流水线里注入故障——用 Chaos Mesh 故意 kill 掉 train 步骤的 Pod（`pod-kill` action），看 Airflow 是否在 retries 内恢复。如果 retries 用尽仍失败，说明容错机制有漏洞。第二，注入网络分区——让某个 worker Pod 网络隔离 60 秒（`network-partition`），看 NCCL 是否 timeout 检测到 + 触发重试。第三，注入慢节点——用 StressNG 让某个 Pod 的 CPU 满 100%（模拟资源争抢），看任务 timeout 是否触发。这些注入要在非关键流水线上跑（或影子环境），记录"故障注入到恢复"的 MTTR（平均恢复时间），目标 < 10 分钟。

**Q：怎么让团队不再写出"重试有副作用"的 DAG？**

两条规范。第一，DAG 编写规范——强制所有任务输出走"覆盖写 + 任务实例 ID 路径"，禁止追加写本地文件。CI 里检查 DAG 代码是否有 `open(..., 'a')` 或 `os.path.join(local_dir, ...)` 这种模式。第二，DAG 模板——提供 `@task(idempotent=True)` 装饰器，自动在任务启动时清空 `try_number` 对应的输出目录，强制幂等。算法同学写 DAG 时继承模板，不能裸写。第三，DAG Code Review checklist——"输出是否幂等""重试是否安全""超时是否设置""依赖是否用 XCom 而非本地文件"，四项检查不过 review 打回。

## 结构化回答


**30 秒电梯演讲：** 像工厂流水线——零件（任务）按工序（DAG）流转，前一道工序（上游任务）做完才进下一道，机器故障（任务失败）自动重试或报警。

**展开框架：**
1. **DAG** — 节点是任务，边是依赖
2. **调度：基于时** — 基于时间/事件/上游触发
3. **容错：失败重** — 失败重试 + 超时 + 旁路

**收尾：** Airflow 和 DolphinScheduler 区别？


## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：工作流引擎怎么选？DAG 调度怎么做？ | 今天聊「工作流引擎怎么选？DAG 调度怎么做？」。一句话：工作流引擎是"把任务编排成 DAG（有向无环图）自动调度执行"，处理依赖、重试、并发、监控 | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：DAG：任务+依赖 | 核心概念 |
| 1:04 | 能力/参数拆解表 | 要点是：调度：时间/事件/上游 | 能力拆解 |
| 1:56 | 流程图：输入→处理→输出 | 要点是：容错：重试/超时/旁路 | 关键机制 |
| 3:00 | 总结卡 + 下期预告 | 记住这些核心点就够了。下期我们接着聊——Airflow 和 DolphinScheduler 区别？。 | 收尾 |
