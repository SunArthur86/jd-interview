---
id: pdd-ai-022
difficulty: L4
category: pdd-ai
subcategory: 模型服务
tags:
- 拼多多
- AI 中台
- 模型服务平台
- 推理网关
- 路由
- 弹性
feynman:
  essence: 模型服务平台是"推理网关 + 路由 + 多后端 + 弹性 + 监控"的一体化系统，业务方传模型即可服务化，平台保证性能/稳定/低成本。
  analogy: 像 5G 基站——手机（业务）发请求，基站（网关）路由到最优信号塔（推理实例），流量大时自动开新塔（弹性扩容）。
  first_principle: 模型推理涉及网关/路由/调度/弹性/监控等多环节，需要平台整合让业务方零负担上线。
  key_points:
  - 推理网关：鉴权/限流/路由/AB/灰度
  - 路由策略：轮询/最少请求/GPU 利用率/模型亲和
  - 多后端：Triton/vLLM/TRT-LLM
  - 弹性：基于 QPS/GPU 利用率/队列长度
  - 监控：延迟/QPS/错误率/GPU/成本
first_principle:
  problem: 怎么把多模型/多后端/动态流量统一服务化？
  axioms:
  - 模型多样（CV/NLP/LLM）
  - 后端多样（Triton/vLLM/TRT-LLM）
  - 流量动态需弹性
  rebuild: 模型服务平台（网关 + 路由 + 多后端 + 弹性 + 监控）。
follow_up:
  - 推理网关和 API 网关区别？——推理网关额外管模型版本/路由/批次/GPU 调度
  - 怎么选路由策略？——LLM 用 KV 命中率/GPU 利用率，CV 用最少请求
  - 怎么降成本？——量化 + batching + 弹性 + 多模型共享 GPU
memory_points:
  - 网关：鉴权/限流/路由/AB/灰度
  - 路由：GPU 利用率/最少请求/模型亲和
  - 后端：Triton/vLLM/TRT-LLM
  - 弹性：QPS/利用率/队列
---

# 【拼多多 AI 中台】模型服务平台架构怎么设计？

> JD 依据："图像/语音/NLP 模型服务、Java + RPC + 微服务"。

## 一、平台目标

**业务方诉求**：
- 传模型（.pt/.safetensors）→ 自动服务化
- 高性能（低延迟/高吞吐）
- 稳定（高可用/不丢请求）
- 低成本（GPU 利用率高）
- 可观测（延迟/错误/成本可见）

**平台职责**：网关 + 路由 + 多后端 + 弹性 + 监控。

## 二、整体架构

```
┌────────────────────────────────────────────────────┐
│ 业务方（推荐/搜索/客服/...）                       │
└────────────────────┬───────────────────────────────┘
                     │ HTTP/gRPC
┌────────────────────▼───────────────────────────────┐
│ 推理网关（Java/Spring Cloud Gateway）              │
│ - 鉴权/限流/熔断                                   │
│ - 模型路由（按 model_id/version）                  │
│ - A/B 实验分流                                     │
│ - 灰度发布                                        │
│ - 协议转换                                        │
│ - 请求/响应日志                                    │
└────────┬───────────────┬───────────────┬──────────┘
         │               │               │
┌────────▼─────┐ ┌───────▼──────┐ ┌──────▼────────┐
│ Triton 集群  │ │ vLLM 集群     │ │ TRT-LLM 集群   │
│ CV/NLP/推荐  │ │ LLM 通用      │ │ LLM 极致       │
└────────┬─────┘ └───────┬──────┘ └──────┬────────┘
         │               │               │
         └───────────────┼───────────────┘
                         │
┌────────────────────────▼───────────────────────────┐
│ 调度层（K8s + GPU Operator）                       │
│ - Pod 调度（GPU 亲和）                             │
│ - 弹性扩缩（HPA/VPA/自定义指标）                   │
│ - 资源池化                                        │
└────────────────────────────────────────────────────┘

横切：
- 模型注册中心（MLflow）：模型元数据/版本/部署
- 监控（Prometheus）：延迟/QPS/错误/GPU 利用率
- 日志（ELK）：推理日志/异常 trace
- 配置（Nacos）：模型路由表/灰度策略
```

## 三、推理网关设计

### 职责
```
1. 鉴权：API Key/Token 校验
2. 限流：按 model_id/uid/IP 维度
3. 熔断：错误率/RT 阈值触发
4. 路由：按模型 ID + 版本选后端
5. AB 实验：按 uid 分流到不同模型版本
6. 灰度：新版本 5%→20%→100%
7. 协议转换：HTTP ↔ gRPC ↔ Triton 协议
8. 日志：请求/响应/异常
9. 缓存：相同请求结果缓存
```

### 实现（Spring Cloud Gateway）
```java
@Component
public class ModelRoutePredicate extends AbstractRoutePredicateFactory<Config> {
    public boolean apply(ServerWebExchange exchange) {
        String modelId = exchange.getRequest().getHeaders().getFirst("X-Model");
        String version = routeTable.getActiveVersion(modelId);  // 从配置中心读
        String variant = abTest.assign(uid);                     // AB 分流
        return routeToBackend(modelId, version, variant);
    }
}
```

## 四、路由策略

| 策略 | 适用 | 实现 |
|------|------|------|
| 轮询 | 通用 | Round Robin |
| 最少请求 | 异构负载 | Least Connections |
| 加权 | 性能差异 | Weighted Random |
| **GPU 利用率** | LLM | 选利用率低的实例 |
| **模型亲和** | 共享 GPU | 路由到已加载模型的实例 |
| **KV 命中** | LLM PD 分离 | 路由到 KV Cache 命中的 Decode 实例 |
| 地理位置 | 低延迟 | 就近路由 |

**LLM 路由特殊**：
- 考虑 KV Cache 命中率（共享 prefix）
- 考虑 GPU 显存（OOM 风险）
- 考虑 batch 队列长度

## 五、多后端抽象

```java
public interface InferenceBackend {
    PredictResponse invoke(String modelId, String version, PredictRequest req);
    boolean supports(String modelType);  // CV/NLP/LLM
}

public class TritonBackend implements InferenceBackend { ... }
public class VllmBackend implements InferenceBackend { ... }
public class TrtLlmBackend implements InferenceBackend { ... }

// 网关层按模型类型分发
public PredictResponse invoke(String modelId, PredictRequest req) {
    ModelMeta meta = registry.get(modelId);
    InferenceBackend backend = backends.stream()
        .filter(b -> b.supports(meta.getType()))
        .findFirst().orElseThrow();
    return backend.invoke(modelId, meta.getVersion(), req);
}
```

## 六、弹性扩缩

### 触发指标
```
- QPS（业务流量）
- GPU 利用率（>80% 扩容）
- 队列长度（推理请求积压）
- P99 延迟（SLO 违规）
- 显存利用率（OOM 风险）
```

### K8s HPA
```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: llm-service
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: llm-vllm
  minReplicas: 3
  maxReplicas: 50
  metrics:
  - type: Pods
    pods:
      metric:
        name: gpu_utilization
      target:
        type: AverageValue
        averageValue: "80"
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
```

### GPU 弹性（难点）
- GPU Pod 启动慢（加载模型几分钟）
- **预热**：提前扩容（基于流量预测）
- **超卖**：低优任务填空（批次推理/训练）
- **冷启动优化**：模型分片缓存、镜像瘦身

## 七、模型生命周期管理

```
注册（MLflow）
  ↓
开发/测试（沙箱）
  ↓
部署（K8s + Triton/vLLM）
  ↓
灰度（5% → 20% → 100%）
  ↓
监控（性能/效果）
  ↓
迭代（新版本上线，老版本下线）
  ↓
归档（模型 + 元数据 + 血缘）
```

## 八、监控体系

### 性能监控
```
延迟：P50/P95/P99 TTFT/TPOT
吞吐：QPS/token per second
错误率：5xx/超时/异常
GPU：利用率/显存/温度
```

### 业务监控
```
效果：CTR/AUC/GMV（按模型版本对比）
成本：单次推理成本/GPU 小时费
漂移：特征/预测分布漂移告警
```

### 可观测性三件套
- **Metrics**（Prometheus + Grafana）：指标
- **Logs**（ELK）：详细日志
- **Traces**（Jaeger/Zipkin）：调用链

## 九、高可用

```
- 多副本：每模型 N 副本
- 多可用区：跨 AZ 部署
- 健康检查：K8s liveness/readiness
- 故障转移：实例挂自动路由到其他
- 限流降级：超载降级小模型/兜底
- 灰度回滚：异常版本秒级回滚
- 数据备份：模型/配置/特征多副本
```

## 十、拼多多实战规模

```
- 模型数：上千（推荐/搜索/风控/LLM）
- QPS：百万级
- GPU：万卡级
- 实验并行：千级
- 业务接入：百级

关键挑战：
- 多模型共享 GPU（显存池化）
- LLM 高成本（量化 + batching + PD 分离）
- 弹性（流量预测 + 预热）
- 跨团队治理（统一标准 + 自助接入）
```

## 十一、底层本质

模型服务平台本质是**"推理网关 + 多后端抽象 + 弹性调度 + 监控治理"**——网关层做流量治理（鉴权/限流/路由/AB），后端层抽象多推理引擎（Triton/vLLM/TRT-LLM），调度层基于 K8s 做 GPU 弹性，监控保证可观测。是 AI 中台把"模型"变成"线上服务"的工程核心。

## 常见考点

1. **冷启动慢怎么优化**？——模型预加载、镜像分层缓存、镜像瘦身、模型分片并行加载。
2. **怎么避免 OOM**？——显存监控 + 限流（拒绝超量请求）+ 弹性扩容 + KV Cache 上限。
3. **LLM 和传统模型怎么共平台**？——抽象 InferenceBackend 接口，按模型类型路由到不同后端；网关统一接入。
