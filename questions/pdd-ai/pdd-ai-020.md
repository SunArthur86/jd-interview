---
id: pdd-ai-020
difficulty: L4
category: pdd-ai
subcategory: LLM 推理
tags:
- 拼多多
- AI 中台
- TensorRT-LLM
- vLLM
- TGI
- 推理框架对比
feynman:
  essence: TensorRT-LLM 是 NVIDIA 官方 LLM 推理引擎，对自家 GPU 优化到极致；vLLM 是开源通用方案（PagedAttention），易用性强。生产场景两者各有适用。
  analogy: TensorRT-LLM 像 F1 赛车（NVIDIA 调校，极致性能但复杂），vLLM 像高端量产车（通用易用，性能也强）。
  first_principle: 推理框架本质是"调度 + 显存 + kernel"三件套，谁把 GPU 利用率高、显存管得好、kernel 优化深谁就快。
  key_points:
  - TensorRT-LLM：NVIDIA 官方，kernel 极致优化，需模型转换
  - vLLM：PagedAttention + Continuous Batching，开源易用
  - TGI：HuggingFace 出品，简单易上手
  - lightLLM：轻量模块化
  - 选型：通用 vLLM，极致用 TRT-LLM，快速上线用 TGI
first_principle:
  problem: 不同推理框架在性能、易用、生态上如何权衡？
  axioms:
  - 推理瓶颈在显存和算力利用
  - 官方优化最深但部署复杂
  - 开源生态降低门槛
  rebuild: 按场景选型（极致/通用/快速）+ 关注核心指标（吞吐/延迟/显存）。
follow_up:
  - 为什么 TRT-LLM 比 vLLM 快？——官方 kernel（FlashAttention/MMA）+ 算子融合 + 平铺更细
  - 怎么从 HF 模型转 TRT-LLM？——convert_checkpoint.py 转 engine，需校准/精度配置
  - vLLM 生态为什么火？——开源易用、社区活跃、模型支持快
memory_points:
  - TRT-LLM：NVIDIA 官方极致优化，部署复杂
  - vLLM：PagedAttention 易用通用
  - TGI：HF 出品简单
  - lightLLM：轻量模块化
---

# 【拼多多 AI 中台】TensorRT-LLM 和 vLLM/TGI 怎么对比选型？

> JD 依据："VLLM/TGI/TensorRT-LLM/lightLLM"。

## 一、四大主流推理框架

| 框架 | 出品 | 定位 | 优势 |
|------|------|------|------|
| **TensorRT-LLM** | NVIDIA | 官方极致优化 | 性能最强、支持最新卡 |
| **vLLM** | UC Berkeley | 开源通用 | PagedAttention、易用、社区 |
| **TGI** | HuggingFace | 简单易用 | 接入 HF 生态最快 |
| **lightLLM** | Tencent/开源 | 轻量模块化 | 可定制、自定义 kernel |

## 二、TensorRT-LLM 详解

### 特点
- NVIDIA 官方维护，对自家 GPU 优化最深
- 基于 TensorRT 引擎，算子融合 + 平铺优化
- 支持 FP8/INT4 AWQ/GPTQ/SmoothQuant
- In-flight Batching（类似 Continuous Batching）
- 支持 TP/PP 多卡并行

### 工作流程
```
1. 模型转换
   HF 模型 → TensorRT 引擎（编译期优化）
   python convert_checkpoint.py --model_dir ./llama-hf --output ./llama-engine
   python build.py --checkpoint_dir ./llama-engine --use_fp8

2. Triton + TRT-LLM 后端服务化
   tritonserver --model-repository=./triton-llm

3. 客户端调用（gRPC/HTTP）
```

### 优势
- **吞吐最高**：比 vLLM 高 20-40%（kernel 优化深）
- **延迟最低**：P99 TTFT/TPOT 优
- **支持新硬件特性快**：FP8/H100 B200 第一时间支持

### 劣势
- **部署复杂**：模型要转换编译（小时级）
- **模型支持滞后**：新模型等官方适配
- **闭源部分**：核心 engine 编译器闭源
- **灵活性差**：自定义 attention 难

## 三、vLLM 详解

### 特点
- 开源（Apache 2.0），UC Berkeley 出品
- PagedAttention（核心创新）
- Continuous Batching
- Prefix Caching
- 支持主流模型（社区贡献快）

### 使用
```bash
vllm serve meta-llama/Llama-3-70B-Instruct \
    --tensor-parallel-size 4 \
    --quantization awq \
    --enable-prefix-caching \
    --max-model-len 8192
```

### 优势
- **易用**：一行命令起服务
- **通用**：HF 模型直接加载，不需转换
- **模型支持快**：新模型社区 PR 几天内支持
- **性能优秀**：PagedAttention 让吞吐接近 TRT-LLM

### 劣势
- **性能略逊**：比 TRT-LLM 低 20-40%
- **首 token 延迟**：prefill 优化不如 TRT-LLM
- **新硬件特性滞后**：FP8/新算子要等社区

## 四、TGI（Text Generation Inference）

### 特点
- HuggingFace 出品，和 HF Hub 深度集成
- 简单易用（一行 docker run）
- 支持 streaming/watermark/uid rate limit

### 使用
```bash
docker run -p 8080:80 ghcr.io/huggingface/text-generation-inference:latest \
    --model-id meta-llama/Llama-3-8B-Instruct
```

### 优势
- **接入最快**：HF 模型直接拉取
- **运维友好**：docker 一键
- **企业特性**：内置监控/限流

### 劣势
- **性能不如 vLLM/TRT-LLM**
- **定制化弱**

## 五、性能对比（典型场景）

7B/13B 模型，A100 80GB，batch=32：

| 框架 | 吞吐（token/s） | 显存利用率 | 部署难度 |
|------|----------------|-----------|----------|
| HF Transformers | 1000 | 30% | 易 |
| **TGI** | 2500 | 60% | 极易 |
| **vLLM** | 4500 | 90% | 易 |
| **TensorRT-LLM** | 6000 | 90% | 难 |

（数字为示意，实际看模型/硬件）

## 六、选型决策

```
场景：极致性能（生产大流量）
  → TensorRT-LLM（H100 集群，固定模型）

场景：通用易用（快速迭代）
  → vLLM（多模型切换频繁）

场景：快速上线（demo/POC）
  → TGI（docker 一键）

场景：定制/研究
  → lightLLM 或自研

场景：边缘/单卡
  → llama.cpp + GGUF（CPU/混合）

场景：多模态
  → vLLM（支持）或 TRT-LLM（需自适配）
```

## 七、拼多多 AI 中台实践

**分层部署**：
```
高流量生产（客服 LLM）
  → TensorRT-LLM（极致性能）
  → 量化：AWQ INT4（成本优先）
  → PD 分离（KV 池化）

中等流量（推荐召回）
  → vLLM（模型迭代频繁）
  → INT8 量化（平衡）

实验/低流量（A/B 实验）
  → TGI（快速部署）
  → 不量化（保证效果基线）

边缘（本地推理）
  → llama.cpp + GGUF
  → INT4 量化
```

**统一推理网关**：
```java
// 按模型/流量路由到不同后端
public String infer(String model, String prompt) {
    if (isProdModel(model)) {
        return tritonLlmClient.invoke(model, prompt);  // TRT-LLM
    } else if (isExperimental(model)) {
        return tgiClient.invoke(model, prompt);         // TGI
    } else {
        return vllmClient.invoke(model, prompt);        // vLLM
    }
}
```

## 八、关键优化技术对比

| 技术 | TRT-LLM | vLLM | TGI |
|------|---------|------|-----|
| Continuous Batching | ✅（in-flight） | ✅ | ✅ |
| PagedAttention | 部分 | ✅（首创） | 部分 |
| Prefix Caching | ✅ | ✅ | 部分 |
| INT4/INT8 量化 | ✅ | ✅ | ✅ |
| FP8 | ✅（首发） | 部分 | 部分 |
| Speculative Decoding | ✅ | ✅ | ✅ |
| Tensor Parallel | ✅ | ✅ | ✅ |
| Pipeline Parallel | ✅ | 部分 | 部分 |
| PD 分离 | 部分 | 部分 | ✗ |

## 九、新兴方向

- **Speculative Decoding**（投机解码）：小模型先猜 + 大模型校验，2-3 倍加速
- **Medusa/EAGLE**：多头预测加速
- **MLSys 优化**：算子融合、kernel auto-tune
- **多模态融合**：vLLM 0.5+ 支持 LLaVA/Qwen-VL
- **端侧推理**：llama.cpp、MLX（Apple）

## 十、底层本质

LLM 推理框架本质是**"显存管理 + Batching + Kernel 优化"**三件套——vLLM 用 PagedAttention 解决显存，TensorRT-LLM 用官方 kernel 解决算力，TGI 用 HF 生态解决易用。选型按场景权衡：极致性能选 TRT-LLM，通用易用选 vLLM，快速上线选 TGI。未来方向是投机解码 + 多模态 + 端云协同。

## 常见考点

1. **为什么 TRT-LLM 编译慢**？——编译期做算子融合/kernel 自动调优/平铺参数搜索，找到最优 kernel 配置。
2. **vLLM 推理时怎么改 batch**？——Continuous Batching 每 iteration 重排，请求进出动态。
3. **Speculative Decoding 怎么实现**？——draft 模型生成 k 个候选 → target 模型并行验证 → 接受/拒绝（保持原分布）。

## 苏格拉底式面试追问

> 这组追问不背答案，模拟面试官层层逼迤本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：你说 vLLM 易用性强，TensorRT-LLM 性能最强。但"易用"和"性能"是定性的说法，有没有具体的量化对比？什么场景下 vLLM 和 TRT-LLM 的差距大到"必须选 TRT-LLM"？**

量化对比要看三个指标。第一，**throughput（tokens/s）**——同模型（Llama2-70B）、同硬件（A100×8）、同 workload（ShareGPT 数据集），TRT-LLM 的 throughput 比 vLLM 高 20-40%（NVIDIA 官方 benchmark）。如果 vLLM 是 2000 tokens/s，TRT-LLM 是 2600-2800 tokens/s。第二，**latency（TTFT + TPOT）**——TRT-LLM 的单次延迟低 20-30%（kernel 融合 + 算子优化），TTFT 从 150ms 降到 110ms。第三，**"必须选 TRT-LLM"的场景**——延迟极度敏感（如实时对话要求 TTFT < 200ms，vLLM 可能勉强，TRT-LLM 有余量）、成本极度敏感（大规模部署时 20% 的吞吐差 = 20% 的 GPU 成本差，万卡集群就是几百万/月）、需要 FP8 推理（TRT-LLM 的 FP8 支持成熟，vLLM 在追赶）。**"vLLM 够用"的场景**——模型迭代频繁（vLLM 支持新模型快 1-2 周，TRT-LLM 要编译 1-2 天）、团队没有 CUDA 优化经验（TRT-LLM 的调优门槛高）、中小规模部署（QPS < 1000，20% 差距不显著）。选型不是"谁绝对好"，是"场景匹配"。

### 第二层：证据与定位

**Q：你们用 vLLM 部署 Qwen-72B，上线后发现 TTFT 比 benchmark 数据高 50%（benchmark 100ms，线上 150ms）。怎么定位是 vLLM 配置问题还是硬件问题？**

分三步排查。第一，**对比 benchmark 和线上的配置差异**——benchmark 通常用"单请求"测（无并发），线上是多请求并发（batch 满载）。如果 benchmark 是 batch=1 的 TTFT=100ms，线上 batch=32 的 TTFT=150ms，这是正常的（batch 大了 TTFT 涨）。用 vLLM 的 `benchmark_serving.py` 模拟线上并发，看 TTFT 是否和线上一致。第二，**检查 vLLM 参数**——`max_num_batched_tokens` 是否设太小（限制了 Prefill 的并行度）、`gpu_memory_utilization` 是否设太低（KV Cache 池小，请求排队）、`enable_chunked_prefill` 是否开启（没开启时长 Prefill 会阻塞）。对比 NVIDIA 官方 benchmark 的配置参数。第三，**硬件检查**——`nvidia-smi` 看 GPU 型号（A100 vs H100，H100 快 2 倍）、`nvidia-smi topo -m` 看 NVLink 是否启用（没启用则 TP 的 AllReduce 走 PCIe，慢 10 倍）、`lscpu` 看 CPU 核数（CPU 少则数据预处理慢，Prefill 前的数据准备成为瓶颈）。最常见的原因：NVLink 没启用（K8s 的 GPU Operator 配置错）或 `max_num_batched_tokens` 太小。

### 第三层：根因深挖

**Q：你定位到 TTFT 高是因为"Prefill 阶段慢"。但 Qwen-72B 的 Prefill 算力消耗是固定的，为什么 vLLM 的 Prefill 比 TRT-LLM 慢 20%？**

根因是"kernel 优化深度"的差异。第一，**算子融合**——TRT-LLM 在编译期把多个小算子（LayerNorm、GELU、Softmax、矩阵乘）融合成一个大 kernel（fused kernel），减少 kernel launch 开销和中间结果的显存读写。vLLM 基于 PyTorch，算子是分开的（LayerNorm 一个 kernel、矩阵乘一个 kernel），每步有 kernel launch 开销（约 10μs/kernel），层多了累积明显。72B 模型有 80 层，每层 5-10 个 kernel，Prefill 一次有 400-800 次 kernel launch，4-8ms 的 launch 开销。第二，**平铺参数优化**——TRT-LLM 的编译器（`trtllm-build`）会搜索最优的 CUDA kernel 平铺参数（block size、shared memory 配置），针对特定 GPU 架构（A100/H100）优化到极致。vLLM 用的是通用的 FlashAttention kernel，平铺参数是"通用最优"不是"特定模型最优"。第三，**权重预布局**——TRT-LLM 编译时把权重重排成"GPU 访问友好的布局"（如 tensor core 对齐），运行时直接用。vLLM 的权重布局是标准的，运行时要做格式转换。所以 TRT-LLM 的 Prefill 快是"编译期优化的红利"，vLLM 要在运行时动态调度，无法做到同等深度。

**Q：那 vLLM 有没有可能在某些场景比 TRT-LLM 快？还是全面落后？**

vLLM 在"高并发 + 多请求混合"场景可能反超 TRT-LLM。第一，**Continuous Batching 的动态性**——vLLM 的 Continuous Batching 每 iteration 动态调整 batch（新请求加入、老请求退出），这种动态性对"请求长度差异大 + 流量波动"的场景优化好。TRT-LLM 也有 in-flight batching（类似 Continuous Batching），但它的动态性受编译期配置约束（比如 max_batch_size 是编译时定的）。第二，**PagedAttention 的显存效率**——vLLM 的 PagedAttention 让 KV Cache 利用率达 90%+，可以 batch 更多请求（吞吐高）。TRT-LLM 的显存管理也是分页的（PagedKVCache），但早期版本的实现不如 vLLM 灵活（2024 年才完善）。第三，**结论**——TRT-LLM 在"单请求延迟 + kernel 级吞吐"领先，vLLM 在"高并发调度 + 显存效率"接近甚至偶有反超。实测（ShareGPT workload、1024 并发）：vLLM 的 throughput 是 TRT-LLM 的 0.9-1.1 倍（互有胜负），TRT-LLM 的 TTFT 是 vLLM 的 0.7-0.8 倍（稳定领先）。不是"全面落后"，是"各有优势"。

### 第四层：方案权衡

**Q：你们客服场景用 vLLM，搜索广告用 TRT-LLM。但维护两套推理引擎意味着两套运维、两套监控、两个团队。这值得吗？统一用一套不是更省运维成本吗？**

统一一套推理引擎在"技术管理"上省心，但"业务价值"上可能亏。第一，**业务需求差异**——客服场景（vLLM）要求"模型迭代快"（每周换 Prompt/模型），vLLM 的灵活性（换模型重启即可）价值高；搜索广告（TRT-LLM）要求"延迟极致"（TTFT < 100ms，否则用户流失），TRT-LLM 的 20% 延迟优势直接转化商业价值（广告点击率）。第二，**成本量化**——两套运维的"人力成本"（2 个工程师 × 30 万年薪 = 60 万/年），但搜索广告用 TRT-LLM 省的 GPU 成本（延迟低 20% = 少 20% GPU = 月省 50 万），1 个月就回本。第三，**统一方案的成本**——如果统一用 vLLM，搜索广告的延迟超 SLO，用户体验下降，广告收入损失可能更大（点击率降 5% = 年损千万）。结论：两套推理引擎的"运维复杂度成本"远小于"业务匹配度收益"。但统一也不是完全不对——如果两个场景的需求接近（都要求中等延迟 + 中等吞吐），统一一套（vLLM）更省心。判断标准：**业务 SLO 差异 > 30% 就分，< 30% 就合**。

**Q：TGI（HuggingFace）比 vLLM 和 TRT-LLM 都简单（`docker run` 一行启动），为什么不选 TGI？简单不是优势吗？**

TGI 简单但性能和功能都落后于 vLLM。第一，**性能差距**——TGI 的 Continuous Batching 和显存管理不如 vLLM 的 PagedAttention 高效（TGI 早期没有 PagedAttention，2024 年才加上），throughput 是 vLLM 的 60-70%。第二，**功能差距**——vLLM 支持 Prefix Caching、Chunked Prefill、LoRA 热加载、PD 分离等先进功能，TGI 的功能较少（聚焦"快速部署 HF 模型"而非"极致优化"）。第三，**生态差距**——vLLM 社区活跃（GitHub 20k+ star，月迭代），新模型/新功能支持快；TGI 的迭代速度慢（HuggingFace 团队资源分散到 many projects）。第四，**TGI 的定位**——TGI 适合"快速验证/原型开发"（`docker run` 跑起来测模型），不适合"生产高并发"（性能不够）。生产部署的标准选择是 vLLM（通用）或 TRT-LLM（极致），TGI 是"开发期工具"。如果团队只会 TGI 且 QPS 低（< 100），可以上生产，但要预期"后续要迁移到 vLLM"（性能不够时）。

### 第五层：验证与沉淀

**Q：你怎么证明"搜索广告用 TRT-LLM 比 vLLM 多赚了钱"？技术选型的商业价值怎么量化？**

三个维度的量化。第一，**延迟对业务指标的影响**——A/B 测试：vLLM 和 TRT-LLM 各 50% 流量，对比 `ad_click_through_rate`（广告点击率）和 `user_conversion_rate`（转化率）。如果 TRT-LLM 的 TTFT 从 150ms 降到 100ms（vLLM），广告点击率从 3.0% 升到 3.3%（+10%），这就是延迟优化的商业价值。按广告收入 × 10% = 年增收 X 万。第二，**GPU 成本节省**——TRT-LLM 的 throughput 高 30%，同样 QPS 下少用 23% 的 GPU（100 卡降到 77 卡），月省 23 卡 × 时租 = Y 万/月。第三，**SLO 达标率**——搜索广告的 SLO（TTFT < 100ms）下，vLLM 的达标率 85%（15% 超时用户流失），TRT-LLM 达标率 98%（2% 超时），差 13% 的用户留存。按 DAU × 13% × ARPU = Z 万/年。三个维度（点击率 + GPU 成本 + SLO 达标）综合算 ROI，证明 TRT-LLM 的商业价值。技术选型不能只看"技术指标"（throughput/latency），要翻译成"业务指标"（收入/成本/留存）才能让业务方认可。

**Q：推理框架选型的经验怎么沉淀，让新业务不再纠结选哪个？**

三件事。第一，**场景-选型矩阵**——维护一个"业务场景 → SLO 要求 → 推荐框架"的表（客服 TTFT<500ms → vLLM、搜索 TTFT<100ms → TRT-LLM、内部工具 QPS<100 → TGI），新业务查表选，不重复讨论。第二，**benchmark 基线库**——定期（每季度）跑主流推理框架的 benchmark（同模型、同硬件、同 workload），记录 throughput/TTFT/TPOT，形成"框架性能基线"，选型时有数据支撑（不是拍脑袋）。第三，**迁移成本评估**——如果新业务选了非主流框架（如 lightLLM），评估"迁移到 vLLM 的成本"（API 兼容性、配置差异），避免"锁死在冷门框架"。推理框架是"基础设施"，选型要考虑"团队技能 + 社区生态 + 迁移成本"，不是只看性能数字。把选型决策记录在 ADR（Architecture Decision Record）里，说明"为什么选 X 不选 Y"，便于后续 review 和新人理解。

## 结构化回答

**30 秒电梯演讲：** 不同推理框架在性能、易用、生态上如何权衡？简单说就是——TensorRT-LLM 是 NVIDIA 官方 LLM 推理引擎，对自家 GPU 优化到极致；vLLM 是开源通用方案（PagedAttention）。vLLM：PagedAttention 易用通用；TGI：HF 出品简单。

**展开框架：**
1. **TRT-LLM** — TRT-LLM：NVIDIA 官方极致优化，部署复杂
2. **vLLM** — vLLM：PagedAttention 易用通用
3. **TGI** — TGI：HF 出品简单

**收尾：** 您想继续往深里聊吗——比如「为什么 TRT-LLM 比 vLLM 快？」

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：TensorRT-LLM 和 vLLM/TGI 怎么对比选型？ | 今天聊「TensorRT-LLM 和 vLLM/TGI 怎么对比选型？」。一句话：TensorRT-LLM 是 NVIDIA 官方 LLM 推理引擎，对自家 GPU 优化到极致；vLLM 是开源通用方… | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：TRT-LLM：NVIDIA 官方极致优化，部署复杂 | 核心概念 |
| 0:51 | 能力/参数拆解表 | 要点是：vLLM：PagedAttention 易用通用 | 能力拆解 |
| 1:30 | 流程图：输入→处理→输出 | 要点是：TGI：HF 出品简单 | 关键机制 |
| 2:09 | 代码片段 + 注释高亮 | 要点是：lightLLM：轻量模块化 | 实战要点 |
| 3:00 | 总结卡 + 下期预告 | 记住这些核心点就够了。下期我们接着聊——为什么 TRT-LLM 比 vLLM 快？。 | 收尾 |
