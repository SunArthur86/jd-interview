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

## 苏格拉底式面试追问

> 这组追问不背答案，模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：你们 1024 卡训练 7B 模型用了张量并行（TP）+ 数据并行（DP）。但 Megatron 默认就是 TP+PP+DP 三路并行，你们为什么不用流水并行（PP）？**

PP（Pipeline Parallel）的引入要看模型规模和通信开销权衡。7B 模型单卡 A100 80G 放得下（FP16 约 14G 权重 + 14G 梯度 + 14G 优化器状态 = 42G），所以不需要 PP 切层——PP 是为了"模型太大单卡放不下"才用的（比如 70B 必须 PP）。第一，PP 有 bubble 开销——流水线各 stage 要等前一个 stage 算完才能算下一个，micro-batch 填不满时有空闲（bubble ratio 随 PP 数增加，PP=8 时 bubble 约 12.5%）。第二，PP 的通信是点对点（stage 间传激活），延迟比 TP 的 AllReduce 低但吞吐要求高，对 IB 带宽敏感。第三，7B 用 TP=8（机内 8 卡 NVLink）+ DP=128（机间）就够，TP 的 AllReduce 跑 NVLink 900GB/s 几乎无开销，比 PP 简单。70B 或更大才需要 TP+PP+DP 三路。

### 第二层：证据与定位

**Q：训练跑到 step 5000 突然 loss 变 NaN，整个 job 崩了。你怎么快速定位是 GPU 硬件故障还是训练逻辑问题？**

分三层定位。第一，**看日志的 NaN 时间点**——PyTorch 报 NaN 时会打印 `loss=nan` 的 step，看是某个 step 突然 NaN（可能梯度爆炸）还是慢慢发散（可能学习率过大）。第二，**看 GPU 硬件状态**——`nvidia-smi -q` 看 Xid 错误日志（Xid 63=违反内存访问、Xid 79=ECC 错误），`dmesg | grep -i nvidia` 看驱动层报错，如果有 Xid 79 说明是硬件故障（GPU 显存损坏），不是训练逻辑。第三，**看梯度分布**——打开 PyTorch 的梯度监控（`torch.autograd.detect_anomaly(True)` 或手动 `torch.isnan(grad).any()`），定位是哪一层的梯度先变 NaN，如果是 embedding 层梯度爆炸，可能是某个 token id 超出 vocab（数据 bug）；如果是 attention 层，可能是 attention score 数值不稳定（softmax 溢出，要加 `attn_implementation=flash_attention_2`）。硬件问题（Xid 79）从 checkpoint 重启到正常节点；逻辑问题要修代码后重训。

### 第三层：根因深挖

**Q：loss NaN 排除硬件问题后，你发现是 BF16 训练下 attention 的 softmax 溢出。为什么 BF16 会溢出，FP32 不会？BF16 不是号称"动态范围和 FP32 一样大"吗？**

BF16 的动态范围确实和 FP32 一样（8 位指数），但精度低（只有 7 位尾数，FP32 是 23 位）。溢出的根因不是"最大值小"，而是"中间计算精度不够导致数值放大"。具体到 softmax：`exp(q·k)` 当 `q·k` 很大（比如 100）时，`exp(100)=2.7e43`，这个值在 BF16 里能表示（不溢出），但累加多个 attention score 时，如果有一个特别大，其他 `exp` 后相对很小，累加结果精度损失严重，反向传播时梯度计算会出现极大值，某一步反向就 NaN。解法：第一，用 FlashAttention-2（它把 softmax 分块计算，数值更稳定，`scale=1/sqrt(d)` 后中间值小）；第二，加 Loss Scaling（混合精度训练的标准做法，把 loss 乘一个大数让小梯度不丢精度）；第三，检查学习率（BF16 下学习率要调小，比如从 2e-4 降到 1e-4）。核心是"BF16 不是银弹，数值敏感操作（softmax/layer norm）要特别处理"。

**Q：那为什么不直接全程用 FP32 训练？精度够了不就没这些事了？**

FP32 训练的代价是"显存翻倍 + 算力减半"。第一，显存——FP32 权重是 BF16 的 2 倍，7B 模型 FP32 训练要 168G 显存（42G×4），单卡 A100 80G 放不下，必须 PP 切更多层或减小 batch，训练效率大降。第二，算力——A100 的 BF16 算力是 312 TFLOPS，FP32 是 19.5 TFLOPS，差 16 倍，训练时间从 1 周变成 16 周，成本不可接受。第三，研究证明 BF16 训练的效果（loss 收敛、模型质量）和 FP32 基本一致（BF16 论文和 OpenAI/Anthropic 的实践验证），只要数值敏感操作用 FP32 累加（BF16 存储 + FP32 计算 master weight）。混合精度（BF16 compute + FP32 master）才是生产标配，纯 FP32 是研究/调试才用。

### 第四层：方案权衡

**Q：千卡训练每周崩 3 次，每次从 checkpoint 恢复要 20 分钟（加载 7B 模型 + 优化器状态到 GPU）。一周崩 3 次就是 1 小时浪费。怎么减少恢复时间？**

从 checkpoint 机制和容错两个方向优化。第一，**异步 checkpoint**——传统 checkpoint 是同步的（训练暂停 → 写磁盘 → 恢复），改成异步（训练继续 → 后台线程写 XDR/CelebiR 到分布式存储），单次 checkpoint 开销从 20 分钟降到 30 秒。PyTorch 有 `torch.distributed.checkpoint` 支持异步保存。第二，**内存级 checkpoint**——把 checkpoint 先写到本地 NVMe SSD（1G/ms 级），后台异步上传到 Lustre/对象存储，恢复时优先从本地 SSD 读（20s），远程存储只做备份。第三，**细粒度恢复**——用 PyTorch Elastic（`torchrun --rdzv_backend=etcd`），单节点挂了不用重启整个 job，只需重启那台节点（从最近的 checkpoint 恢复），其他节点继续训练，恢复时间从 20 分钟降到 2 分钟。第四，**减少崩溃频率**——见下一问。优化后单次恢复从 20 分钟降到 2-5 分钟。

**Q：为什么不直接用 spot/preemptible 实例降成本？反正有 checkpoint 容错，被抢占就从 checkpoint 恢复。**

Spot 实例能降 60-70% 成本，但对"千卡同步训练"是灾难。第一，抢占频率高——云厂商 spot 实例可能每小时抢占一次，1024 卡每卡独立被抢占的概率叠加，可能每 30 分钟就有一台被抢占，整个 job 要频繁重启。第二，恢复开销——TP+DP 训练是同步的，一台卡挂了，AllReduce 会 timeout，整个 job 必须重启所有 rank，即使有 PyTorch Elastic，恢复一次也要几分钟。第三，进度损失——频繁重启导致有效训练时间（GPU hours / 总时间）只有 50-60%，计算资源浪费。Spot 实例适合"可独立重启的任务"（如数据预处理、离线推理），不适合"强耦合的同步训练"。训练集群用 on-demand 实例保证稳定，推理/批处理用 spot 降成本，是生产标配。

### 第五层：验证与沉淀

**Q：你怎么证明 PyTorch Elastic + 异步 checkpoint 真的把有效训练时间（MFU，Model FLOPs Utilization）从 40% 提升到了 55%？**

三个维度度量。第一，**MFU 计算**——MFU = 实际训练 FLOPS / GPU 峰值 FLOPS。7B 模型 batch=32、seq=2048 的单步 FLOPS 约 1.2e15，1024 卡 H100 的峰值是 1024×989e12=1e18 FLOPS/s，如果单步耗时 2 秒，MFU=1.2e15/(1e18×2)=60%。对比优化前后 MFU（40%→55%），提升来自"减少重启空闲时间 + checkpoint 开销"。第二，**`effective_training_hours`**——统计一周内"训练在 step N 到 N+1 的真实计算时间"，扣除 checkpoint 写入、重启、通信等待，从 60 小时（优化前）涨到 85 小时（优化后）。第三，**`recovery_time_p99`**——记录每次崩溃到恢复训练的时间，从 20 分钟降到 3 分钟。三个指标一起看，证明容错优化真实生效。

**Q：怎么让 GPU 利用率长期保持在高位，而不是训练时 80%、数据加载时 30%（IO bound）？**

沉淀两件事。第一，**数据预取 pipeline**——用 PyTorch DataLoader 的 `num_workers=8`（多进程预取）、`prefetch_factor=4`（每个 worker 预取 4 batch），保证 GPU 算完一个 batch 时下一个 batch 已经在 GPU 显存里等。配合 WebDataset（把数据打包成分片，避免小文件随机读，提升存储 IO 吞吐）。第二，**存储分层**——训练数据先从对象存储预加载到本地 NVMe（命中率高的数据集常驻本地），DataLoader 从本地读（2GB/s）而不是从 Lustre 读（200MB/s），消除 IO 瓶颈。监控 `data_loading_time_ratio`（数据加载时间占单步训练的比例），如果 > 20% 说明 IO 是瓶颈，要加预取或缓存。

## 结构化回答

**30 秒电梯演讲：** 怎么构建能跑大模型训练/推理的硬件底座？简单说就是——AI Infra 是"大模型训练/推理的硬件基础设施"，核心是 GPU 集群 + 高速互联（NVLink 机内 + RDMA/IB 机间）+ 高性能存储 + 调度系统。机内 NVLink，机间 IB/RoCE；存储：Lustre/CephFS（TB/s）。

**展开框架：**
1. **GPU** — GPU：A100/H100/B200
2. **机内 NVLink** — 机内 NVLink，机间 IB/RoCE
3. **存储** — 存储：Lustre/CephFS（TB/s）

**收尾：** 您想继续往深里聊吗——比如「NVLink 和 PCIe 区别？」

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：AI Infra（GPU 集群/RDMA/NVLink）怎么构建？ | 今天聊「AI Infra（GPU 集群/RDMA/NVLink）怎么构建？」。一句话：AI Infra 是"大模型训练/推理的硬件基础设施"，核心是 GPU 集群 + 高速互联（NVLink 机内 + R… | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：GPU：A100/H100/B200 | 核心概念 |
| 0:51 | 能力/参数拆解表 | 要点是：机内 NVLink，机间 IB/RoCE | 能力拆解 |
| 1:30 | 流程图：输入→处理→输出 | 要点是：存储：Lustre/CephFS（TB/s） | 关键机制 |
| 2:09 | 代码片段 + 注释高亮 | 要点是：容错：checkpoint + 自动恢复 | 实战要点 |
| 3:00 | 总结卡 + 下期预告 | 记住这些核心点就够了。下期我们接着聊——NVLink 和 PCIe 区别？。 | 收尾 |
