---
id: pdd-ai-026
difficulty: L4
category: pdd-ai
subcategory: 池化
tags:
- 拼多多
- AI 中台
- 池化
- 缓存
- 扩容
- 异步
- 队列
- LLM 推理池化
feynman:
  essence: 高并发"四件套"是池化（预建资源复用）+ 缓存（少打 DB）+ 扩容（弹性加机器）+ 异步队列（削峰），LLM 推理场景四者都不可或缺且要按 GPU 特性调整。
  analogy: 像大餐厅应对饭点高峰——养一群厨师待命（池化）、热门菜提前做好（缓存）、排号等位（异步队列）、临时加厨师（扩容）。
  first_principle: 单机资源有限且建销贵，必须预建/复用/缓存/弹性/削峰才能扛突发。
  key_points:
  - 池化：线程池/连接池/GPU 推理池
  - 缓存：Redis/本地缓存/推理结果缓存
  - 扩容：K8s 弹性 + GPU 预热
  - 异步队列：Kafka 削峰 + 流式响应
  - LLM 特殊：GPU 冷启动慢、推理结果可缓存
first_principle:
  problem: LLM 推理高并发下如何扛住突发 + 控延迟 + 不雪崩？
  axioms:
  - GPU 资源贵且启动慢
  - 请求有突发
  - 相同请求可复用结果
  rebuild: 池化（GPU 推理池）+ 缓存（结果复用）+ 异步队列（削峰）+ 弹性扩容。
follow_up:
  - LLM 推理为什么不能像 Web 一样快扩容？——GPU 加载模型慢（分钟级），要预热
  - 推理结果缓存命中率怎么算？——按 prompt 哈希，命中即返（省 GPU）
  - 异步队列怎么和流式输出结合？——队列存任务，推理完流式返回
memory_points:
  - 池化：线程/连接/GPU 推理池
  - 缓存：Redis/本地/推理结果
  - 扩容：K8s + GPU 预热
  - 异步：Kafka 削峰 + 流式
---

# 【拼多多 AI 中台】池化缓存扩容异步队列四件套怎么用？

> JD 依据："缓存、池化、Java + 微服务"。

## 一、四件套本质

```
池化：资源预建复用（避免运行时建销）
缓存：少打 DB（避免重复计算）
扩容：弹性加机器（扛突发）
异步队列：削峰填谷（不阻塞主流程）
```

## 二、池化

### 线程池（Java）
```java
ThreadPoolExecutor pool = new ThreadPoolExecutor(
    64, 128, 60, TimeUnit.SECONDS,
    new LinkedBlockingQueue<>(2000),
    new CallerRunsPolicy()
);
```
（详见 001 题）

### 连接池（HTTP/DB/gRPC）
```java
// HBase 连接池
HBaseConnection pool = new HBaseConnectionPool(
    100,                          // 最大连接
    Duration.ofSeconds(30),       // 空闲超时
    Duration.ofSeconds(5)         // 连接超时
);
```

### GPU 推理池（LLM 特殊）
```
不是线程池，是 GPU 推理请求池：

方式 1：vLLM Continuous Batching
  - 推理请求入队列
  - 引擎按 batch 调度执行
  - 自动批处理（不用业务方管）

方式 2：业务侧请求队列 + Triton
  - 业务请求入 BlockingQueue
  - 工作线程攒批 → 调 Triton → 返回
  - 比单纯并发更高效（batch 友好）
```

```java
// 业务侧 batch 攒批
BlockingQueue<LlmRequest> queue = new LinkedBlockingQueue<>();
ScheduledExecutor scheduler = Executors.newScheduledThreadPool(4);

scheduler.scheduleAtFixedRate(() -> {
    List<LlmRequest> batch = new ArrayList<>();
    queue.drainTo(batch, 32);                   // 最多 32 或 50ms
    if (!batch.isEmpty()) {
        List<String> results = tritonClient.batchInfer(batch);
        for (int i = 0; i < batch.size(); i++) {
            batch.get(i).complete(results.get(i));   // 异步回调
        }
    }
}, 0, 50, TimeUnit.MILLISECONDS);
```

## 三、缓存

### 多级缓存
```
L1 本地缓存（Caffeine）：< 0.1ms，热点
L2 Redis：< 1ms，全量
L3 持久化（DB/特征仓）：< 10ms
```

### LLM 推理结果缓存
```java
// 同 prompt 直接返回缓存（省 GPU）
public String chat(String prompt) {
    String key = "llm:" + DigestUtils.md5Hex(prompt);
    String cached = redis.get(key);
    if (cached != null) {
        metrics.record("cache_hit");
        return cached;
    }

    String result = llmClient.invoke(prompt);
    redis.setex(key, 3600, result);   // 缓存 1h
    return result;
}
```

**LLM 缓存特殊**：
- 完全匹配（同 prompt）
- 语义匹配（embedding 相似度，复杂）
- 共享 Prefix KV Cache（vLLM 内部）

### 特征缓存
```
实时特征 → Redis（毫秒）
离线特征 → HBase（5ms）+ 本地缓存（0.1ms）
高 QPS 特征预热到本地
```

## 四、扩容（弹性）

### K8s HPA（CPU/QPS 触发）
```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
spec:
  minReplicas: 3
  maxReplicas: 50
  metrics:
  - type: Resource
    resource:
      name: cpu
      target: { type: Utilization, averageUtilization: 70 }
```

### 自定义指标（GPU 利用率/队列长度）
```yaml
metrics:
- type: Pods
  pods:
    metric: { name: gpu_utilization }
    target: { type: AverageValue, averageValue: "80" }
- type: External
  external:
    metric:
      name: queue_length
      selector: { matchLabels: { queue: llm-infer } }
    target: { type: AverageValue, averageValue: "100" }
```

### LLM 弹性难点
```
普通 Web：Pod 启动秒级
LLM：Pod 启动 + 加载模型 = 分钟级

解决方案：
1. 预热：基于流量预测提前扩容
2. 模型分片缓存：镜像分层 + 模型预热脚本
3. GPU 池化：常备 N 个 warm Pod
4. 流量预测：基于历史/大促日历预测
```

## 五、异步队列（削峰）

### Kafka 削峰
```
瞬时 10 万 QPS 请求 → 写 Kafka → 推理服务按 GPU 容量（1万 QPS）平滑消费

业务侧：
  - 同步返回 task_id
  - 异步处理完通过 webhook/轮询返回结果

适合：可容忍延迟的场景（批量推理/离线分析）
不适合：实时对话（要同步/流式）
```

### 流式响应（LLM 场景）
```java
// SSE 流式输出
@GetMapping(value = "/chat", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
public Flux<String> chat(@RequestParam String prompt) {
    return Flux.create(sink -> {
        llmClient.invokeStream(prompt, new StreamHandler() {
            public void onToken(String token) { sink.next(token); }
            public void onComplete() { sink.complete(); }
            public void onError(Throwable e) { sink.error(e); }
        });
    });
}
```

**流式优势**：
- 首 token 早返回（TTFT 短）
- 长输出不占连接
- 用户感知快

## 六、四件套协同（LLM 推理场景）

```
请求 ──→ 网关（限流/鉴权）
            ↓
         推理结果缓存（命中直接返回）
            ↓ miss
         GPU 推理池（vLLM/Triton，Continuous Batching）
            ↓
         队列积压？→ 写 Kafka 异步处理
            ↓
         GPU 利用率高？→ HPA 弹性扩容（预热 Pod）
            ↓
         流式返回结果
```

## 七、雪崩防护

```
请求突增 → 网关限流（保护后端）
         → 队列积压 → 降级（小模型/兜底话术）
         → 缓存击穿 → 互斥锁重建
         → 服务挂 → 熔断（快速失败）
         → 流式超时 → 优雅降级（已生成部分返回）
```

## 八、拼多多实战

```
场景：客服 LLM 推理，双 11 流量 10 倍
方案：
1. 预测流量 → 提前 30 分钟预热 GPU Pod（避免冷启动）
2. 推理结果缓存（相似问题命中 30%+）
3. vLLM Continuous Batching（GPU 利用率 90%）
4. Kafka 削峰（异步任务/批量推理）
5. 网关限流（按 uid/IP，防恶意刷）
6. 降级（高峰切小模型，成本可控）
7. 流式响应（用户体验好）

效果：
- 单卡 QPS 提升 3x
- P99 TTFT < 2s
- 高峰不雪崩
```

## 九、底层本质

四件套本质是**"资源用得巧 + 弹性 + 削峰"**——池化让资源复用，缓存让重复请求不打 GPU，扩容让弹性应对突发，异步队列让峰值不冲垮系统。LLM 场景下还要特别注意 GPU 冷启动慢（要预热）和推理结果可缓存（命中率关键）。

## 常见考点

1. **LLM 推理为什么不能完全异步化**？——对话/客服要实时反馈（流式），完全异步体验差；批量/离线可全异步。
2. **缓存命中率怎么提高**？——共享 system prompt（Prefix Caching）、相似问题归并、热点问题预热、合理 TTL。
3. **GPU 弹性扩容瓶颈在哪**？——Pod 启动 + 模型加载慢（分钟级），需预热 + 镜像优化 + 流量预测。
