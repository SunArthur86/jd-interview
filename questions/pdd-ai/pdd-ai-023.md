---
id: pdd-ai-023
difficulty: L4
category: pdd-ai
subcategory: LLM 训练
tags:
- 拼多多
- AI 中台
- 训练平台
- GPU 调度
- 分布式训练
- 3D 并行
feynman:
  essence: 训练平台是"管理 GPU 集群 + 调度训练任务 + 编排分布式策略"的操作系统，让算法同学提交作业即可跑分布式训练，不用关心底层 GPU/网络/容错。
  analogy: 像超算中心——研究员提交作业（训练任务），中心自动分配计算节点（GPU）、调度依赖、监控进度，研究员只管算法。
  first_principle: 大模型训练需要千卡协同、复杂并行（TP/PP/DP）、长时间运行，单机无法承载，必须平台化调度。
  key_points:
  - 集群管理：GPU 池化 + K8s + 拓扑感知
  - 任务调度：优先级/抢占/队列/拓扑亲和
  - 并行策略：3D 并行（TP+DP+PP）/ZeRO/MoE
  - 容错：checkpoint 恢复/异常检测/自动重启
  - 监控：GPU 利用率/通信占比/loss/收敛
first_principle:
  problem: 怎么高效调度千卡资源、编排复杂分布式训练、保证长任务稳定？
  axioms:
  - GPU 贵且有限
  - 大模型必须分布式
  - 长任务会失败
  rebuild: 训练平台（集群管理 + 任务调度 + 并行编排 + 容错 + 监控）。
follow_up:
  - 怎么提高 GPU 利用率？——拓扑感知调度 + 通信计算重叠 + 弹性抢占
  - 训练挂了怎么恢复？——checkpoint + 自动从最近点恢复 + 数据续训
  - 怎么选并行策略？——按模型大小 + 集群拓扑 + 显存，3D 并行通常最优
memory_points:
  - 集群：K8s + GPU 池化 + 拓扑感知
  - 调度：优先级/抢占/队列
  - 并行：3D（TP+DP+PP）/ZeRO
  - 容错：checkpoint 恢复
---

# 【拼多多 AI 中台】训练平台架构怎么设计？GPU 调度怎么做？

> JD 依据："大模型训练框架开发维护、GPU/CPU 资源调度"。

## 一、训练平台要解决的问题

**痛点**：
```
算法：要训 70B 模型 → 需要 1024 卡 + 张量并行 + 数据并行 + 流水并行
手工：找运维要卡 → 配置分布式 → 训练挂了从头来 → 效率极低
```

**平台目标**：提交作业（Docker + 启动脚本 + 数据），平台自动调度 + 容错 + 监控。

## 二、整体架构

```
┌────────────────────────────────────────────────────┐
│ 用户层（算法同学）                                  │
│ - 提交作业（YAML/CLI/Web 控制台）                  │
│ - 查看进度/日志/指标                                │
└────────────────────┬───────────────────────────────┘
                     │
┌────────────────────▼───────────────────────────────┐
│ 调度层                                              │
│ - 任务队列（优先级/抢占/公平共享）                 │
│ - 资源调度（K8s + Volcano/KubeBatch）              │
│ - 拓扑感知（NVLink/IB 亲和）                       │
│ - 弹性（在线/离线混部）                             │
└────────────────────┬───────────────────────────────┘
                     │
┌────────────────────▼───────────────────────────────┐
│ 训练执行层                                          │
│ - 框架：Megatron-LM / DeepSpeed / PyTorch FSDP     │
│ - 并行：TP / DP / PP / ZeRO / SP                   │
│ - 通信：NCCL + RDMA/NVLink                         │
│ - 容错：checkpoint / 自动恢复                      │
└────────────────────┬───────────────────────────────┘
                     │
┌────────────────────▼───────────────────────────────┐
│ 基础设施层                                          │
│ - GPU 集群（A100/H100）                            │
│ - 网络：机内 NVLink / 机间 InfiniBand              │
│ - 存储：分布式文件系统（Lustre/CephFS）            │
│ - 监控：Prometheus + Grafana                       │
└────────────────────────────────────────────────────┘
```

## 三、GPU 调度

### 1. 集群管理（K8s + GPU Operator）
```yaml
# Pod 申请 GPU
apiVersion: v1
kind: Pod
spec:
  containers:
  - name: trainer
    image: my-training:latest
    resources:
      limits:
        nvidia.com/gpu: 8       # 8 卡
    volumeMounts:
    - name: data
      mountPath: /data
  volumes:
  - name: data
    persistentVolumeClaim:
      claimName: training-data
```

### 2. 拓扑感知调度
```
任务需要 N 卡时：
  - 优先同机（NVLink 互联，通信快）
  - 其次同机架（IB 互联）
  - 最后跨机架（带宽低）

调度器查询节点拓扑，把 Pod 调到最优位置
```

### 3. 优先级与抢占
```
优先级队列：
  - 高优（生产训练）：可抢占低优
  - 中优（实验）
  - 低优（超参搜索/批量）

抢占机制：
  - 高优任务排队等待
  - 调度器驱逐低优任务（checkpoint 后退出）
  - 高优任务接管 GPU
```

### 4. 弹性（在线/离线混部）
```
GPU 池：
  - 在线推理（高优，QPS 敏感）
  - 离线训练（中优，吞吐）
  - 实验/批量（低优）

低峰期：离线任务用满 GPU
高峰期：在线扩容，挤压离线
```

## 四、分布式训练并行策略

### 1. 数据并行（DP）
```
每卡完整模型 + 不同 batch → 算梯度 → AllReduce
简单但显存压力大
```

### 2. 张量并行（TP）
```
单层内切（如 Attention 多头分到多卡）
每层前向/反向要 AllReduce
机内并行（NVLink 高带宽）
```

### 3. 流水并行（PP）
```
按层切（不同卡不同层）
前向/反向相邻层间发激活
跨机并行（IB）
```

### 4. 3D 并行（千亿模型标配）
```
机内 TP（8 卡 NVLink）
+ 跨机 DP（数据并行）
+ 跨机 PP（流水并行）

示例（1024 卡训 175B）：
  TP=8（单机 8 卡）× PP=16（16 个流水段）× DP=8（8 路数据并行）= 1024 卡
```

### 5. ZeRO（DeepSpeed）
```
ZeRO-1：优化器状态分片（省 4x 显存）
ZeRO-2：+ 梯度分片
ZeRO-3：+ 参数分片（最省显存，通信多）
```

### 6. MoE（专家并行）
```
N 个专家分布到多卡
token 路由到对应专家
All-to-All 通信（复杂）
```

## 五、容错与恢复

### 1. Checkpoint
```python
# 定期保存
if step % 100 == 0:
    save_checkpoint({
        'step': step,
        'model': model.state_dict(),
        'optimizer': optimizer.state_dict(),
        'rng_state': torch.get_rng_state(),
    }, path)

# 异常自动恢复
if os.path.exists(latest_ckpt):
    load_checkpoint(latest_ckpt)
```

### 2. 异常检测
```
- 进程崩溃（NCCL timeout）
- GPU 故障（ECC 错误、Xid 错误）
- 网络中断（IB 断连）
- Loss 异常（NaN/爆炸）
- 节点失联
```

### 3. 自动恢复
```
1. 检测异常
2. 通知调度器
3. 从最近 checkpoint 重启（重新调度 Pod）
4. 续训（数据已处理部分跳过）
```

### 4. 弹性训练（PyTorch Elastic）
```python
import torch.distributed.elastic as elastic

# 节点失败自动重组，不重启整个任务
elastic.launch(config)(
    train_fn, args
)
```

## 六、监控

### 性能
```
- GPU 利用率（目标 >80%）
- GPU 显存（防 OOM）
- 通信占比（目标 <30%）
- 数据加载（避免 IO 瓶颈）
- 吞吐（samples/s 或 tokens/s）
```

### 训练指标
```
- loss/gradient norm（收敛/爆炸检测）
- 学习率
- 梯度/激活统计
- 评估指标（AUC/PPL）
```

### 告警
```
- loss NaN
- GPU 利用率 < 50% 持续 10min
- 任务挂掉
- checkpoint 失败
```

## 七、典型训练作业（Megatron）

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: llama-70b-pretrain
spec:
  parallelism: 128                  # 128 副本
  template:
    spec:
      hostIPC: true                 # 共享内存（NCCL）
      hostNetwork: true             # 主机网络（低延迟）
      containers:
      - name: trainer
        image: megatron:latest
        command:
        - torchrun
        - --nproc_per_node=8
        - --nnodes=128
        - pretrain_llama.py
        - --tensor-model-parallel-size=8
        - --pipeline-model-parallel-size=16
        - --num-layers=80
        - --hidden-size=8192
        - --bf16
        - --use-flash-attn
        - --tokenizer-type=Llama2Tokenizer
        resources:
          limits:
            nvidia.com/gpu: 8
            rdma/ib: 1              # IB 资源
```

## 八、用户提交流程

```
1. 算法同学提交作业（Web 控制台 / CLI）
   - Docker 镜像
   - 启动命令
   - 资源需求（GPU 数/并行度）
   - 数据路径
   - 超参

2. 调度器排队（按优先级/公平共享）

3. 分配资源（拓扑感知）

4. 启动训练（拉镜像/下数据/启动 NCCL）

5. 监控（指标上报 + 日志收集）

6. 完成/失败通知

7. 模型产出 → 注册到 MLflow
```

## 九、拼多多实战

```
集群规模：万卡级 A100/H100
网络：机内 NVLink（400GB/s）+ 机间 IB NDR（400Gbps）
存储：Lustre 并行文件系统（TB/s 吞吐）
框架：Megatron-LM + DeepSpeed + 自研增强
调度：K8s + Volcano + 自研拓扑感知
监控：自研 GPU 监控（利用率/温度/显存）+ WandB 集成

关键挑战：
- 千卡训练稳定性（每周 N 次故障）→ checkpoint + 自动恢复
- 通信开销大 → 3D 并行 + 通信压缩
- 资源利用率 → 在线/离线混部 + 弹性抢占
```

## 十、底层本质

训练平台本质是**"GPU 集群 + 调度 + 分布式编排 + 容错"**——K8s 管理硬件，调度器拓扑感知分配 GPU，训练框架（Megatron/DeepSpeed）编排 3D 并行，checkpoint + 自动恢复保证长任务稳定。是大模型时代 AI 基础设施的核心。

## 常见考点

1. **怎么诊断 GPU 利用率低**？——profiler 看通信/数据加载占比，调 batch/并行度/预取。
2. **3D 并行度怎么调**？——TP 受机内 GPU 数限制（8），PP 按层均分，DP = 总卡数 / (TP×PP)。
3. **训练和推理怎么混部**？——在线推理高优 + 离线训练低优，高峰期挤压离线；GPU 实例按时间片抢占。
