---
id: pdd-ai-037
difficulty: L4
category: pdd-ai
subcategory: LLM 训练
tags:
- 拼多多
- AI 中台
- AI Infra
- GPU 集群
- RDMA
- NVLink
- 存储
feynman:
  essence: AI Infra 是"大模型训练/推理的硬件基础设施"，核心是 GPU 集群 + 高速互联（NVLink 机内 + RDMA/IB 机间）+ 高性能存储 + 调度系统。
  analogy: 像超算中心——计算节点（GPU）、内部总线（NVLink）、机房间光缆（IB）、磁盘阵列（Lustre）、操作系统（K8s），缺一不可跑大模型。
  first_principle: 大模型训练需要千卡协同、TB/s 通信、PB 级数据，单机不可能承载，必须建专用基础设施。
  key_points:
  - GPU：A100/H100/B200，HBM 显存
  - 机内互联：NVLink/NVSwitch（300-900 GB/s）
  - 机间互联：InfiniBand/RoCE（200-400 Gbps）
  - 存储：Lustre/CephFS（TB/s 吞吐）
  - 调度：K8s + GPU Operator + Volcano
  - 故障：千卡每周 N 次故障，需容错
first_principle:
  problem: 怎么构建能跑大模型训练/推理的硬件底座？
  axioms:
  - 算力需求大（PFLOPS 级）
  - 通信带宽是瓶颈
  - 数据 IO 要跟得上
  rebuild: AI Infra（GPU + 高速互联 + 存储 + 调度 + 容错）。
follow_up:
  - NVLink 和 PCIe 区别？——NVLink 是 GPU 直连（300+GB/s），PCIe 是通用总线（64GB/s），差 5x
  - InfiniBand 和 RoCE 区别？——IB 专用网络协议（贵稳），RoCE 基于以太网（便宜）
  - 千卡训练为什么频繁挂？——硬件故障率 × 卡数，单卡 MTBF 1000 小时，千卡每周 N 次故障
memory_points:
  - GPU：A100/H100/B200
  - 机内 NVLink，机间 IB/RoCE
  - 存储：Lustre/CephFS（TB/s）
  - 容错：checkpoint + 自动恢复
---

# 【拼多多 AI 中台】AI Infra（GPU 集群/RDMA/NVLink）怎么构建？

> JD 依据："GPU/CPU 资源调度、RDMA/NVLink、混合精度"。

## 一、AI Infra 全景

```
┌────────────────────────────────────────────────────┐
│ 应用层：训练（万亿 token）/ 推理（百万 QPS）       │
└────────────────────┬───────────────────────────────┘
                     │
┌────────────────────▼───────────────────────────────┐
│ 调度层：K8s + GPU Operator + Volcano               │
│ - 任务调度（拓扑感知）                             │
│ - 资源池化（在线/离线混部）                        │
│ - 容错（checkpoint + 自动恢复）                    │
└────────────────────┬───────────────────────────────┘
                     │
┌────────────────────▼───────────────────────────────┐
│ 计算层：GPU 集群                                   │
│ - A100/H100/B200                                   │
│ - CPU 节点（数据预处理/服务）                      │
└────────────────────┬───────────────────────────────┘
                     │
┌────────────────────▼───────────────────────────────┐
│ 网络层：                                           │
│ - 机内：NVLink/NVSwitch（900 GB/s）                │
│ - 机间：InfiniBand NDR（400 Gbps）/RoCE            │
│ - GPU Direct RDMA（网卡直读 GPU）                  │
└────────────────────┬───────────────────────────────┘
                     │
┌────────────────────▼───────────────────────────────┐
│ 存储层：                                           │
│ - 并行文件系统（Lustre/CephFS，TB/s 吞吐）         │
│ - 对象存储（S3 兼容，海量冷数据）                  │
│ - 缓存（本地 SSD/NVMe）                            │
└────────────────────────────────────────────────────┘
```

## 二、GPU 硬件

### 主流 GPU 对比

| 型号 | 显存 | 算力（FP16） | 互联 | 适用 |
|------|------|-------------|------|------|
| V100 | 32GB | 125 TF | NVLink 300GB/s | 老卡 |
| A100 | 80GB | 312 TF | NVLink 600GB/s | 主流训练 |
| H100 | 80GB | 989 TF | NVLink 900GB/s | 大模型 |
| H200 | 141GB | 989 TF | NVLink 900GB/s | 长上下文 |
| B200 | 192GB | 2250 TF | NVLink 1800GB/s | 最新 |
| L4/L40 | 24/48GB | 中 | PCIe | 推理 |
| Llama（消费） | 24GB | 中 | PCIe | 实验 |

### 关键指标
```
- FLOPS（算力）：FP16/BF16/FP8/INT8
- HBM（显存）：A100 80GB，H100 80GB
- 显存带宽：HBM3（3TB/s）
- 互联带宽：NVLink（>300GB/s）
```

### 选型
```
预训练大模型：H100/H200/B200（大显存 + 高算力）
微调/中等训练：A100（性价比）
推理（大流量）：H100（强算力）或 L4/L40（性价比）
推理（边缘/低延迟）：L4/A10
```

## 三、机内互联：NVLink

### NVLink
```
NVIDIA 专用 GPU 互联协议
- A100：600 GB/s
- H100：900 GB/s
- B200：1800 GB/s

对比 PCIe 5.0：64 GB/s
NVLink 是 PCIe 的 10-30 倍带宽
```

### NVSwitch
```
机内全互联芯片
8 卡之间都跑满 NVLink 带宽（无瓶颈）
DGX H100 标配
```

### 为什么重要
```
张量并行（TP）：每层前向/反向要 AllReduce
通信带宽直接决定 TP 效率
NVLink 让机内 8 卡 TP 几乎无通信开销
```

## 四、机间互联：InfiniBand / RoCE

### InfiniBand（IB）
```
专用网络协议（NVIDIA/Mellanox）
- HDR：200 Gbps
- NDR：400 Gbps
- XDR：800 Gbps

特点：
- 低延迟（< 1μs）
- 高带宽
- GPU Direct RDMA（网卡直读 GPU 显存）
- 但贵
```

### RoCE（RDMA over Converged Ethernet）
```
基于以太网的 RDMA
- 比 IB 便宜
- 兼容现有以太网
- 性能略低于 IB
- 拥塞控制不如 IB

适合中等规模或成本敏感
```

### 选型
```
大规模生产训练（>1024 卡）：InfiniBand NDR
中等规模/成本敏感：RoCE
推理集群：以太网足够（通信少）
```

### GPU Direct RDMA
```
传统：GPU 显存 → CPU 内存 → 网卡 → 远端
GPU Direct：GPU 显存 → 网卡 → 远端（不经 CPU）
延迟降 50%+，CPU 不参与通信

PD 分离的 KV Cache 传输必备
```

## 五、存储

### 训练数据存储
```
痛点：
- 训练数据 TB-PB 级
- 多 GPU 同时读取
- IO 跟不上算力（GPU 等数据）

方案：
1. 并行文件系统（Lustre/GPFS/CephFS）
   - 分布式，多节点并行读写
   - TB/s 级吞吐

2. 本地 SSD 缓存
   - 训练数据预加载到本地
   - 减少网络 IO

3. 数据 pipeline 优化
   - 预取（next batch 提前加载）
   - 数据格式（TFRecord/WebDataset）
```

### 模型/Checkpoint 存储
```
- 模型文件：对象存储（S3 兼容）+ CDN
- Checkpoint：并行文件系统（快速读写）
- 版本管理：MLflow/自研
```

## 六、调度（K8s + GPU）

### K8s GPU 调度
```yaml
apiVersion: v1
kind: Pod
spec:
  containers:
  - resources:
      limits:
        nvidia.com/gpu: 8
```

### GPU Operator
```
NVIDIA 出品，简化 K8s GPU 管理
- 自动安装驱动/runtime
- GPU 监控
- DRA（Dynamic Resource Allocation）
```

### Volcano / KubeBatch
```
批处理调度（训练任务）
- Gang Scheduling（同任务 Pod 全部就绪才启动）
- 拓扑感知（机内/机架亲和）
- 优先级/抢占
- 公平共享
```

### 拓扑感知
```
任务需要 N 卡时：
1. 优先同机（NVLink）
2. 其次同机架（IB）
3. 最后跨机架

调度器查询节点拓扑，把 Pod 调到最优位置
```

## 七、故障与容错（千卡训练核心难题）

### 故障类型
```
- GPU 故障（ECC 错误/Xid 错误）
- 网络故障（IB 断连/RDMA 错误）
- 节点失联（OS 挂/硬件故障）
- 训练异常（loss NaN/梯度爆炸）
```

### 故障率
```
单 GPU MTBF（平均无故障时间）约 1000 小时
1024 卡集群：1024 / 1000 ≈ 1 次/小时
实际：每天数十次小故障，每周 N 次大故障
```

### 容错机制
```
1. Checkpoint（定期保存）
   - 每 100-1000 步存一次
   - 异步保存（不阻塞训练）

2. 异常检测
   - 进程崩溃（NCCL timeout）
   - GPU Xid 错误
   - loss NaN

3. 自动恢复
   - 检测异常 → 通知调度器
   - 从最近 checkpoint 重启
   - 数据已处理部分跳过

4. 弹性训练（PyTorch Elastic）
   - 节点失败自动重组（不重启整个任务）
```

## 八、混合云 / 多集群

```
单集群规模受限（电力/网络/容错）→ 多集群

- 跨集群训练（DGX SuperPOD 思路）
- 数据/模型跨集群同步
- 容灾（单集群挂切备用）

拼多多/字节/阿里等万卡级训练多集群协同
```

## 九、推理集群 vs 训练集群

```
训练集群：
- H100/H200（大显存/强算力）
- 全互联（NVLink + NVSwitch）
- IB NDR
- 大容量存储
- 长 job 调度

推理集群：
- L4/L40/A10（性价比）
- 不需强互联（推理通信少）
- 以太网足够
- 弹性扩缩（HPA）
- PD 分离：Prefill 用 H100，Decode 用 L4
```

## 十、拼多多 AI Infra 实战

```
训练集群：
- 规模：万卡级 H100/A100
- 网络：机内 NVLink 900GB/s，机间 IB NDR 400Gbps
- 存储：Lustre 并行文件系统（多 TB/s）
- 调度：K8s + Volcano + 自研拓扑感知
- 容错：checkpoint + PyTorch Elastic + 自动恢复

推理集群：
- 模型：vLLM/TensorRT-LLM
- GPU：H100（高优）+ L4（弹性）
- PD 分离：Prefill/Decode 独立集群
- 量化：AWQ INT4
- KV 传输：GPU Direct RDMA

监控：
- GPU 利用率/温度/显存/Xid 错误
- IB 带宽/延迟
- 存储 IO 吞吐
- 训练 loss/通信占比

挑战：
- 千卡稳定性（每周 N 次故障 → 容错）
- 通信开销（占比 30%+）
- 成本（H100 时租贵）
- 跨团队资源公平共享
```

## 十一、底层本质

AI Infra 本质是**"算力 + 互联 + 存储 + 调度 + 容错"**——GPU 提供算力，NVLink（机内）+ IB/RoCE（机间）+ GPU Direct RDMA 提供高速通信，Lustre/对象存储提供数据底座，K8s + Volcano 做拓扑感知调度，checkpoint + 自动恢复应对千卡故障。是大模型时代 AI 的"水电煤"基础设施。

## 常见考点

1. **为什么千卡训练频繁挂**？——单卡 MTBF 有限，千卡故障率叠加，每周 N 次大故障；必须 checkpoint + 容错。
2. **NVLink 为什么重要**？——TP 的 AllReduce 通信直接决定效率，NVLink 比 PCIe 快 10-30 倍，机内 8 卡 TP 几乎无通信开销。
3. **怎么降低训练成本**？——量化训练（BF16/FP8）+ 通信压缩 + 在线/离线混部 + 弹性抢占 + 多集群负载均衡。
