---
id: pdd-ai-016
difficulty: L4
category: pdd-ai
subcategory: LLM 推理
tags:
- 拼多多
- AI 中台
- PD 分离
- Prefill
- Decode
- RDMA
feynman:
  essence: PD 分离是把 LLM 推理的 Prefill（首 token，算力瓶颈）和 Decode（续写，带宽瓶颈）拆到不同实例，各自优化硬件和调度，整体吞吐和 SLO 双提升。
  analogy: 像快递分拣中心——大批量卸货（Prefill，重活，壮汉团队）和分送上门（Decode，碎活，配送团队）分开，效率比一队人两头跑高。
  first_principle: Prefill 和 Decode 资源画像完全不同（算力 vs 带宽），混部会互相阻塞，分离后各自最大化利用。
  key_points:
  - Prefill：算力瓶颈，矩阵乘，几秒
  - Decode：带宽瓶颈，向量乘，毫秒
  - 分离：KV Cache 跨实例传输（RDMA/NVLink）
  - 优势：吞吐 + SLO 双提升，资源独立优化
  - 挑战：KV 传输开销、调度复杂
first_principle:
  problem: 混部下 Prefill 阻塞 Decode（反之亦然），SLO 和吞吐难兼顾？
  axioms:
  - Prefill 算力密集（GPU 满载）
  - Decode 带宽密集（GPU 大半空闲）
  - 资源互斥会互相干扰
  rebuild: PD 分离（独立集群/实例）+ KV Cache 跨节点传输。
follow_up:
  - KV 怎么传？——RDMA（GPU Direct）/NVLink（同机）/TCP（兜底）
  - 什么时候不用 PD 分离？——小模型或低 QPS 场景，分离的开销 > 收益
  - Chunked Prefill 是什么？——把长 Prefill 切块和 Decode 混跑，避免完全分离的 KV 传输
memory_points:
  - Prefill 算力瓶颈，Decode 带宽瓶颈
  - 混部互相阻塞
  - 分离 + KV 跨传（RDMA）
  - 代表：Mooncake/Splitwise/DeepSeek-V3
---

# 【拼多多 AI 中台】PD 分离（Prefill-Decode Disaggregation）是什么？

> JD 依据："PD 分离、推理加速"。

## 一、为什么要 PD 分离

**传统混部问题**（一个实例同时跑 Prefill 和 Decode）：

```
时间轴：
  请求 A（prefill, 长 prompt）─────────────── 5 秒 ────▶
  请求 B（decode, 输出中）─ 等待 ────────────────────▶  ← 被 A 阻塞

或：
  Decode 占着 GPU 但带宽只用 30%（算力浪费）
  Prefill 想跑但要等 Decode
```

**冲突点**：
- Prefill 是算力瓶颈（GPU FLOPS 满载）
- Decode 是带宽瓶颈（GPU 算力浪费 60%）
- 两者混部：Decode 拖慢首 token SLO，Prefill 拖慢续写

## 二、Prefill vs Decode 资源画像

| 维度 | Prefill | Decode |
|------|---------|--------|
| 计算特征 | 矩阵乘（GEMM） | 向量乘（GEMV） |
| 瓶颈 | 算力（FLOPS） | 显存带宽 |
| GPU 利用率 | 高（90%+） | 低（30%） |
| 单次耗时 | 秒级（首 token） | 毫秒级（每 token） |
| KV Cache | 计算 + 写入 | 读取为主 |
| 适合硬件 | H100（强算力） | L4/A10（带宽友好） |

## 三、PD 分离架构

```
┌──────────────────────────────────────────────┐
│ 路由层（按阶段分发）                          │
└───────┬──────────────────────────┬───────────┘
        ▼                          ▼
┌──────────────────┐       ┌──────────────────┐
│ Prefill 集群     │       │ Decode 集群       │
│ - 大算力（H100） │       │ - 带宽优化（L4）  │
│ - 算 KV Cache    │       │ - 接收 KV 续写    │
│ - 适合大 prompt  │       │ - Continuous Batch│
└────────┬─────────┘       └─────────▲────────┘
         │                           │
         └──── KV Cache 传输 ────────┘
              （RDMA / GPU Direct）
```

**流程**：
1. 请求进入 → 路由到 Prefill 集群
2. Prefill 算完 prompt 的 KV Cache
3. KV Cache 通过 RDMA 传到 Decode 集群某实例
4. Decode 集群接管，逐 token 续写
5. 完成 → 返回

## 四、KV Cache 跨实例传输

**传输量**：每请求几 GB（13B 模型 seq=2048 约 3GB）。

**传输技术**：
- **RDMA**（Remote Direct Memory Access）：网卡直接读 GPU 显存，不经过 CPU，亚毫秒延迟
- **NVLink**：同机 GPU 间高速互联（300GB/s）
- **GPU Direct RDMA**：网卡直读 GPU 显存（最优）
- **TCP**（兜底）：慢，仅小模型/低 QPS

**优化**：
- KV Cache 分块传输（边算边传，隐藏延迟）
- 压缩（FP16 → INT8 减半）
- 池化（Decode 集群维护 KV 池，命中省传输）

## 五、优势

### 1. SLO 优化
```
首 token 延迟（TTFT）：Prefill 集群不被 Decode 拖累
每 token 延迟（TPOT）：Decode 集群不被 Prefill 阻塞
```

### 2. 吞吐提升
```
Prefill 集群 GPU 90% 满载（连续 prefill）
Decode 集群通过 Continuous Batching 把带宽吃满
资源利用率最大化
```

### 3. 资源独立优化
```
Prefill：用 H100（算力卡）、大显存、张量并行
Decode：用 L4/A10（带宽卡）、多副本、小卡多副本
弹性扩缩各自指标
```

### 4. KV Cache 复用
```
Decode 集群维护 KV 池
相同 system prompt 的请求复用已存的 prefix KV
```

## 六、挑战与权衡

### 1. KV 传输开销
- 跨机 RDMA 仍有几 GB 传输成本
- 优化：GPU Direct + 分块流式 + 压缩

### 2. 调度复杂
- Prefill 实例选哪个？
- Decode 实例怎么选（负载/KV 命中）？
- 跨实例失败怎么处理？
- 需要 KV Cache 路由感知调度器

### 3. 适用边界
- 小模型（<7B）PD 分离收益小（KV 小、prefill 快）
- 低 QPS 场景分离开销 > 收益
- 适合：大模型 + 高 QPS + SLO 严格

### 4. Chunked Prefill（折中方案）
把 Prefill 切成 chunk，和 Decode 交错跑：
```
GPU 时间片：
  [P1][D1][P2][D2][P3][D3]...
避免 Prefill 长时间独占 GPU
```
代表：vLLM 0.5+、Sarathi-Serve。

## 七、代表系统

| 系统 | 特点 |
|------|------|
| **Mooncake**（Moonshot） | KV Cache 池化 + PD 分离，Kimi 生产用 |
| **Splitwise**（MSR） | 学术原型，证明 PD 分离优势 |
| **DistServe** | PD 分离 + 资源分配优化 |
| **DeepSeek-V3 推理** | 部分 PD 分离策略 |
| **TensorRT-LLM** | 支持 inflight batching（折中） |

## 八、拼多多落地思考

```
场景：客服 LLM（QPS 高、prompt 长、SLO 严）
方案：
  Prefill 集群：8 卡 H100，张量并行处理大 prompt
  Decode 集群：16 张 L4，多副本 Continuous Batching
  KV 传输：GPU Direct RDMA，分块流式
  调度器：自研，基于负载 + KV 命中率路由
监控：TTFT、TPOT、KV 传输延迟、GPU 利用率分别监控
```

## 九、底层本质

PD 分离本质是**"按资源画像拆分阶段，独立优化"**——Prefill 算力瓶颈和 Decode 带宽瓶颈混部会互相阻塞，分离后各自最大化硬件利用率，配合 RDMA 跨传 KV Cache。是 LLM 推理服务极致优化的方向，适合大模型高并发生产场景。

## 常见考点

1. **PD 分离什么时候不值**？——小模型、低 QPS、prompt 短，KV 传输开销 > 收益。
2. **KV 传输延迟怎么隐藏**？——分块流式（算一块传一块）+ RDMA（亚毫秒）+ Decode 端预取。
3. **怎么调度 Prefill/Decode 实例数**？——按请求率/平均 prompt 长度/输出长度建模，目标 SLO 约束下吞吐最大化。
