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

## 苏格拉底式面试追问

> 这组追问不背答案，模拟面试宫层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：PD 分离的核心是把 Prefill 和 Decode 拆到不同实例。但传统混部（一个实例同时跑 P 和 D）也能工作，vLLM 默认就是混部。为什么要费力分离？混部有什么根本问题？**

混部的根本问题是"Prefill 和 Decode 的资源画像互斥，互相阻塞"。第一，**Prefill 是算力密集型**——处理一个 2K token 的 prompt 是大规模矩阵乘（Q·K^T 是 2K×2K），GPU 算力打满，耗时 50-200ms。这期间同实例的 Decode 请求必须等待（GPU 被 Prefill 占用），Decode 的 P99 延迟被 Prefill 拖高。第二，**Decode 是带宽密集型**——每 token 读 KV Cache（带宽瓶颈），GPU 算力闲置（利用率 20%）。如果这时来一个 Prefill 请求，可以填补算力空闲，但 Prefill 的矩阵乘会占住算力，让正在 Decode 的请求延迟抖动。第三，**结果**——混部时 Prefill 请求的突增会让所有在 Decode 的请求延迟飙升（用户看到的"卡顿"），Decode 的长尾不可控。分离后 Prefill 实例专注算力（GPU 满载跑 Prefill），Decode 实例专注带宽（多请求并发 Decode），两者互不干扰，SLO 和吞吐双赢。

### 第二层：证据与定位

**Q：PD 分离上线后，Decode 实例的 P99 确实降了（从 2s 到 500ms），但 Prefill 实例的 OOM 频发。你怎么定位 Prefill 实例的 OOM？**

Prefill 实例的 OOM 来自"Prefill 的激活显存爆炸"。第一，**看 OOM 时的 batch 组成**——Prefill 实例集中处理 Prefill 请求，如果同时 batch 了多个长 prompt（比如 5 个 4K token 的 prompt），Prefill 的中间激活（attention score 矩阵 4K×4K）暴增，单 batch 激活显存可能 10GB+，加 KV Cache 池就 OOM。第二，**看 `max_num_batched_tokens` 配置**——Prefill 实例如果设了 `max_num_batched_tokens=16384`，意味着单 batch 可以容纳 16K token（4 个 4K prompt 或 16 个 1K prompt），激活显存随 token 数平方增长，16K token 的 Prefill 激活极大。第三，**看 FlashAttention 是否启用**——如果 Prefill 实例没开 FlashAttention（`--dtype half` 但 flash_attn 失效），4K×4K 的 attention 矩阵完整存在显存（64MB/层 × 32 层 = 2GB/batch），batch=5 就 10GB 激活，OOM。解法：降 `max_num_batched_tokens` 到 8192、确认 FlashAttention 生效（看日志 `Using FlashAttention`）、开启 Chunked Prefill（把长 prompt 切块，单块激活小）。

### 第三层：根因深挖

**Q：PD 分离的核心挑战是"KV Cache 跨实例传输"。Prefill 算完 KV Cache 后要传给 Decode 实例。一个 2K prompt 的 KV Cache 是 1.6GB（13B 模型），传输要多久？会不会成为瓶颈？**

KV 传输是 PD 分离的关键瓶颈，必须用 GPU Direct RDMA。第一，**传输量**——13B 模型、2K prompt 的 KV Cache = `2 × num_layers(40) × num_kv_heads(40) × seq(2048) × head_dim(128) × 2B(FP16) = 2.6GB`（不是 1.6GB，之前算小了）。如果用 TCP 传输（1Gbps 网络），2.6GB / 1Gbps = 20 秒，完全不可用。第二，**InfiniBand NDR 400Gbps**——带宽 50GB/s，2.6GB 传输 52ms，可接受但叠加 Decode 的 0.8ms/token，有开销。第三，**GPU Direct RDMA**——KV Cache 从 Prefill 的 GPU 显存直接传到 Decode 的 GPU 显存（不经 CPU 内存），延迟再降 50%（省去 GPU→CPU→网卡→远端 CPU→GPU 的 4 跳），2.6GB 传输 26ms。第四，**分块流式传输**——Prefill 不等全部 KV 算完，算完一个 layer 就传一个 layer（pipeline 传输），Decode 端边收边算，把传输延迟隐藏在计算中。优化后 KV 传输的感知延迟从 52ms 降到 10ms 以内。

**Q：那 KV 传输用 NVLink 不是更快吗（900GB/s）？为什么要用 RDMA（50GB/s）？NVLink 快 18 倍。**

NVLink 是机内互联，RDMA 是机间互联，适用场景不同。第一，**NVLink 只能机内**——同一台机器的 8 个 GPU 之间用 NVLink（900GB/s），但 Prefill 实例和 Decode 实例是不同的 K8s Pod（可能在不同机器），跨机器不能用 NVLink。第二，**"机内 PD 分离"的意义有限**——如果 Prefill 和 Decode 在同一台机器的 8 卡里（比如 4 卡 Prefill + 4 卡 Decode），那不如混部（同一批卡既跑 P 又跑 D），PD 分离的"资源隔离"优势就没了。PD 分离的价值在于"P 集群和 D 集群独立扩缩"，必然跨机器。第三，**NVLink 适合"同机 TP"场景**——Prefill 实例内部用 TP=8（8 卡张量并行），每层的 AllReduce 走 NVLink（900GB/s），这是机内通信。PD 之间的 KV 传输走 RDMA（机间）。两者分工：NVLink 管机内 TP 通信，RDMA 管机间 KV 传输。所以"NVLink 快"和"用 RDMA"不矛盾，是不同层次的通信。

### 第四层：方案权衡

**Q：PD 分离的收益是吞吐和 SLO 双提升，但代价是"调度复杂"——要决定哪个请求去哪个 Prefill 实例、KV 传给哪个 Decode 实例。这个调度器怎么设计？**

调度器要解决"请求分配 + KV 路由"两个问题。第一，**Prefill 调度**——请求到达后，调度器选一个 Prefill 实例，选择依据是"负载均衡 + 长度匹配"：把长 prompt 分配到算力强的实例（H100）、短 prompt 到 L4；同一实例不要同时处理太多长 prompt（避免激活 OOM）。用最小连接数（least connections）策略 + prompt 长度作为权重。第二，**Decode 路由**——Prefill 完成后，KV Cache 要传到一个 Decode 实例。选择依据是"KV 局部性 + 负载均衡"：优先选"已经有这个请求部分 KV 的实例"（如果之前 Decode 过同会话的请求）、其次选负载最低的实例。第三，**会话亲和**——多轮对话的请求（同一 session_id）应该路由到同一 Decode 实例（复用已有 KV Cache），调度器维护 `session_id → decode_instance` 映射。第四，**KV 传输优化**——调度器把 Prefill 和 Decode 实例的 GPU Direct RDMA 地址配对，KV 传输走最优路径。代表实现：Mooncake（Moonshot）、Splitwise（清华/阿里），都是自研 PD 调度器。

**Q：那为什么不用 Chunked Prefill 替代 PD 分离？Chunked Prefill 把长 Prefill 切块和 Decode 混跑，不需要跨实例传 KV，不是更简单吗？**

Chunked Prefill 是"混部优化"，PD 分离是"架构解耦"，解决的问题层次不同。第一，**Chunked Prefill 的原理**——把 2K token 的 Prefill 切成 8 块（每块 256 token），每块和 Decode 请求一起 batch，Prefill 的算力消耗被"摊薄"到多个 iteration，不会一次占满 GPU 几百毫秒。优点是不传 KV（同实例）、实现简单（vLLM 的 `--enable-chunked-prefill`）；缺点是"Prefill 和 Decode 还是混部"，Prefill 的算力需求和 Decode 的带宽需求抢同一批 GPU，SLO 的确定性不如 PD 分离。第二，**PD 分离的优势**——P 集群可以独立扩容（Prefill 算力不够加卡）、D 集群独立扩容（Decode 带宽不够加卡），资源配比灵活；SLO 严格隔离（Prefill 的突增不影响 Decode）。第三，**生产选择**——中等规模（QPS < 1000、SLO < 1s）用 Chunked Prefill（简单够用），大规模（QPS > 5000、SLO < 500ms 严格）用 PD 分离（SLO 可控）。拼多多/字节的 LLM 平台用 PD 分离，中小团队用 Chunked Prefill。不是非此即彼，Chunked Prefill 可以作为 PD 分离的"过渡方案"。

### 第五层：验证与沉淀

**Q：你怎么证明 PD 分离比混部的吞吐提升了 2 倍，而不只是"流量涨了所以吞吐数字好看"？**

控制变量对比。第一，**离线压测**——固定流量（1000 QPS、prompt 分布固定），混部（vLLM 默认）vs PD 分离（Mooncake/自研），对比 `throughput_tokens_per_sec`（每秒输出 token 数）。混部 5000 tokens/s，PD 分离 12000 tokens/s（2.4 倍）。第二，**SLO 达标率**——固定 SLO（TTFT < 500ms、TPOT < 50ms），对比两种架构的 `slo_compliance_rate`（满足 SLO 的请求比例）。混部 75%（Prefill 突增时 Decode 超时），PD 分离 98%（隔离无干扰）。第三，**线上 A/B**——混部和 PD 分离各 50% 流量，同时段对比 `throughput` 和 `slo_compliance_rate`，连续 1 周数据。关键看"SLO 达标率"（不是纯吞吐），因为 PD 分离的价值是"SLO 确定性"而非"峰值吞吐"。三个指标一致，证明 PD 分离的优势。

**Q：PD 分离的调度器复杂度很高，团队怎么沉淀经验避免踩坑？**

三件事。第一，**调度策略可配置**——调度器把"实例选择算法"（least connections、round-robin、KV-locality）做成可配置策略，新场景（如多租户、优先级）通过配置切换，不改代码。第二，**调度效果监控**——监控 `prefill_instance_load_imbalance`（P 实例负载不均度，> 20% 告警）、`kv_transfer_latency_p99`（KV 传输延迟，> 50ms 告警）、`session_affinity_hit_rate`（会话亲和命中率，< 80% 说明路由不优）。第三，**容量规划模型**——建立"QPS + prompt 长度分布 + output 长度分布 → P/D 实例配比"的模型（比如 QPS=1000、平均 prompt 1K、output 200 token，需要 P:H100×4 + D:H100×8），新业务上线按模型预估资源，不拍脑袋。PD 分离是"架构升级"，需要持续调优调度策略和资源配比，不是"上线就完事"。

## 结构化回答


**30 秒电梯演讲：** 像快递分拣中心——大批量卸货（Prefill，重活，壮汉团队）和分送上门（Decode，碎活，配送团队）分开，效率比一队人两头跑高。

**展开框架：**
1. **Prefill** — 算力瓶颈，矩阵乘，几秒
2. **Decode** — 带宽瓶颈，向量乘，毫秒
3. **分离：KV ** — KV Cache 跨实例传输（RDMA/NVLink）

**收尾：** KV 怎么传？


## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：PD 分离（Prefill-Decode Disaggregation）是什么？ | 今天聊「PD 分离（Prefill-Decode Disaggregation）是什么？」。一句话：PD 分离是把 LLM 推理的 Prefill（首 token，算力瓶颈）和 Decode（续写 | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：Prefill 算力瓶颈，Decode 带宽瓶颈 | 核心概念 |
| 0:51 | 能力/参数拆解表 | 要点是：混部互相阻塞 | 能力拆解 |
| 1:30 | 流程图：输入→处理→输出 | 要点是：分离 + KV 跨传（RDMA） | 关键机制 |
| 2:09 | 代码片段 + 注释高亮 | 要点是：代表：Mooncake/Splitwise/DeepSeek-V3 | 实战要点 |
| 3:00 | 总结卡 + 下期预告 | 记住这些核心点就够了。下期我们接着聊——KV 怎么传？。 | 收尾 |
