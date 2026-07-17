---
id: java-architect-090
difficulty: L4
category: java-architect
subcategory: 模型服务
tags:
- Java 架构师
- 模型服务
- 降级
- 成本
feynman:
  essence: 模型服务网关 = LLM 版的 API Gateway，核心职责是统一接入（多模型多供应商）、流量治理（限流/熔断/降级）、成本控制（token 预算/模型路由/缓存）、可观测（延迟/成本/质量指标）。降级的关键不是"换个模型"，而是换模型后质量是否可接受（quality SLO）。
  analogy: 像一个多语种翻译调度台——有贵的金牌翻译（GPT-4）、便宜的新手翻译（小模型）、离线备用的翻译机（规则引擎）。调度员根据任务难度、紧急程度、当日预算，把请求分发给合适的人，谁请假了（供应商宕机）立刻换人，月底还要算总账不超预算。
  first_principle: 单一模型供应商 = 单点故障（OpenAI 曾多次宕机）、单一成本结构（无议价空间）、单一能力上限。引入多供应商 + 网关后，可在供应商级故障时降级、在成本压力下路由到便宜模型、在质量要求下路由到强模型。但引入新复杂度：模型能力差异（A 的 GPT-4 和 B 的 GPT-4 输出质量不同）、token 计费方式不同、SLA 不同。网关的核心价值就是用统一抽象屏蔽这些差异。
  key_points:
  - 多供应商统一抽象：OpenAI/Anthropic/通义/自部署 统一 ChatClient 接口，配置化切换
  - 降级链：主模型（贵强）→ 备模型（便宜次）→ 规则引擎（确定性兜底），按 RT/错误率/预算触发
  - 模型路由：按任务复杂度路由（cheap 模型分类、expensive 模型生成），省 60%+ 成本
  - 成本控制：租户 token 预算、语义缓存（相似 prompt 命中）、prompt 压缩（长上下文摘要）
  - 质量护栏：降级后监控 task_accuracy，质量跌破阈值自动回切强模型
  - 可观测：model_latency_p95、token_cost_per_request、fallback_rate、error_rate
first_principle:
  problem: 在保证质量 SLO 和成本预算的前提下，如何让 LLM 服务具备供应商级高可用和弹性降级能力？
  axioms:
  - 任何单模型供应商都会宕机（OpenAI 2023-2024 多次事故），单点依赖不可接受
  - 强模型（GPT-4）和弱模型（GPT-4o-mini）成本差 10-30 倍，全用强模型账单失控
  - 降级不是无代价：弱模型质量更差，必须监控质量指标决定降级是否可接受
  - 成本和质量是跷跷板：网关的职责是在两者间找到当前最优解
  rebuild: 建模型服务网关层——统一抽象多供应商（LiteLLM/Spring AI 多 ChatModel），按 SLA/成本/质量三维路由（主→备→规则引擎降级链），token 预算和语义缓存控成本，质量监控（task_accuracy）做降级回切的闭环。网关本身走 Java 服务的全部稳定性实践（限流、熔断、隔离、灰度）。
follow_up:
  - 多供应商怎么保证输出一致？——不可能完全一致（同 prompt 不同模型输出不同）。工程上：对结构化输出用 JSON Schema 强制约束降低差异；对自由文本输出做 A/B 看用户满意度差异；关键场景锁定单一供应商不降级。
  - 语义缓存命中率多少正常？——FAQ 类场景 30-50%（相似问题多），对话类场景 5-10%（每次上下文不同）。缓存用 embedding 相似度（> 0.95 视为命中），TTL 按 prompt 类型设。
  - 模型路由怎么实现？——规则路由（按 task_type 字段）最简单；LLM 路由（用 cheap 模型先分类再决定走哪个模型）更智能但多一次调用。生产先用规则，有数据后再上 LLM 路由。
  - token 预算超了怎么办？——三级响应：警告（80% 提醒）、限流（95% 对非核心请求拒绝）、熔断（100% 只保留核心请求走便宜模型）。预算按租户/天/月分维度设。
  - 怎么验证降级后质量可接受？——上线前离线 eval（弱模型在评测集上 task_accuracy 是否达阈值）；上线后 A/B（5% 流量降级，对比 user_feedback_score 和业务转化率），质量跌就回切。
memory_points:
  - 网关四职责：统一接入、流量治理、成本控制、可观测
  - 降级链：主模型 → 备模型 → 规则引擎，按 RT/错误率/预算触发
  - 成本三件套：模型路由（省最多）、token 预算（防失控）、语义缓存（省重复）
  - 质量护栏：降级必监控 task_accuracy，跌破阈值自动回切
  - 供应商级高可用：多供应商 + 自动 failover，单家宕机无感切换
---

# 【Java 后端架构师】模型服务网关、降级与成本控制

> 适用场景：JD 核心技术。LLM 调用单价 0.01-0.1 元/千 token，一个日均亿级请求的业务如果全走 GPT-4，一年烧几十亿。同时 OpenAI 多次全球性宕机（2023 年至少 4 次），单供应商就是单点故障。架构师要设计的是"模型服务网关"——一个介于业务系统和 LLM 供应商之间的中间层，统一处理多供应商接入、降级、成本控制、可观测，让业务代码像调一个普通 RPC 一样调用 LLM，同时保证质量、成本、可用性三个 SLO 都达标。

## 一、概念层：模型服务网关的四层架构

```
┌─────────────────────────────────────────────────────────────┐
│  业务系统（客服 / 搜索 / 推荐 / 内容生成）                    │
└──────────────────────────┬──────────────────────────────────┘
                           │ 统一 ChatClient 接口
┌──────────────────────────▼──────────────────────────────────┐
│                  模型服务网关（Model Gateway）                │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────────┐  │
│  │ 接入抽象 │ │ 流量治理 │ │ 成本控制 │ │   可观测      │  │
│  │ 多供应商 │ │ 限流熔断 │ │ 路由缓存 │ │ 延迟成本质量  │  │
│  │ 统一 API │ │ 降级重试 │ │ 预算审计 │ │ traceId 串联  │  │
│  └──────────┘ └──────────┘ └──────────┘ └───────────────┘  │
└──────────────────────────┬──────────────────────────────────┘
                           │
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
   ┌─────────┐       ┌─────────┐       ┌──────────┐
   │ OpenAI  │       │ 通义/文心│       │ 自部署    │
   │ (主)    │       │ (备)    │       │ Llama/Qwen│
   └─────────┘       └─────────┘       └──────────┘
```

| 层 | 职责 | 关键机制 |
|----|------|---------|
| **接入抽象** | 屏蔽供应商差异，统一 ChatClient API | LiteLLM/Spring AI 多 ChatModel，配置化切换 |
| **流量治理** | 保护网关和下游，故障隔离 | 限流（按租户/模型）、熔断（错误率/延迟）、降级链 |
| **成本控制** | 在预算内最大化质量 | 模型路由、token 预算、语义缓存、prompt 压缩 |
| **可观测** | 质量/成本/延迟三维 SLO 监控 | model_latency_p95、token_cost_per_request、fallback_rate |

## 二、机制层：网关核心实现

### 2.1 多供应商统一抽象

```java
// 基于 Spring AI 的多供应商配置
@Configuration
public class ModelConfig {

    @Bean("primaryModel")     // 主模型：OpenAI GPT-4o
    public ChatModel primaryModel() {
        return OpenAiChatModel.builder()
            .apiKey("${openai.key}")
            .model("gpt-4o")
            .build();
    }

    @Bean("secondaryModel")   // 备模型：通义 qwen-max
    public ChatModel secondaryModel() {
        return DashScopeChatModel.builder()
            .apiKey("${dashscope.key}")
            .model("qwen-max")
            .build();
    }

    @Bean("fallbackModel")    // 兜底模型：自部署 Qwen（数据不出域）
    public ChatModel fallbackModel() {
        return OllamaChatModel.builder()
            .baseUrl("http://internal-llm:11434")
            .model("qwen2.5:32b")
            .build();
    }
}
```

### 2.2 降级链（核心）

```java
@Service
@Slf4j
public class FailoverChatClient {

    @Qualifier("primaryModel")    private final ChatModel primary;
    @Qualifier("secondaryModel")  private final ChatModel secondary;
    @Qualifier("fallbackModel")   private final ChatModel fallback;
    private final RuleEngine ruleEngine;                 // 最终确定性兜底
    private final CircuitBreaker primaryCb;              // 主模型熔断器
    private final CircuitBreaker secondaryCb;

    public String chat(ChatRequest req) {
        // 降级链：primary → secondary → fallback → ruleEngine
        try {
            if (primaryCb.getState() == CLOSED) {
                return primary.call(req);
            }
        } catch (Exception e) {
            log.warn("主模型失败，降级备模型 traceId={}", MDC.get("traceId"), e);
            metrics.counter("model.fallback").tag("from", "primary").increment();
        }

        try {
            if (secondaryCb.getState() == CLOSED) {
                return secondary.call(req);
            }
        } catch (Exception e) {
            log.warn("备模型失败，降级自部署 traceId={}", MDC.get("traceId"), e);
            metrics.counter("model.fallback").tag("from", "secondary").increment();
        }

        try {
            return fallback.call(req);
        } catch (Exception e) {
            log.error("所有模型失败，降级规则引擎 traceId={}", MDC.get("traceId"), e);
            metrics.counter("model.fallback").tag("from", "fallback").increment();
            return ruleEngine.respond(req);   // 确定性兜底，永不失败
        }
    }
}
```

**熔断器配置（Resilience4j）**：

```yaml
resilience4j:
  circuitbreaker:
    instances:
      primaryModel:
        failure-rate-threshold: 30        # 错误率 30% 触发熔断
        slow-call-rate-threshold: 50      # 慢调用（>10s）率 50% 触发
        slow-call-duration-threshold: 10s
        wait-duration-in-open-state: 60s  # 熔断 60s 后半开试探
        sliding-window-size: 20
      secondaryModel:
        failure-rate-threshold: 50
        wait-duration-in-open-state: 30s
```

### 2.3 模型路由（成本优化核心）

```java
@Component
public class ModelRouter {

    private final ChatModel cheap;    // gpt-4o-mini（0.15 元/百万 token）
    private final ChatModel mid;      // gpt-4o（2.5 元/百万 token）
    private final ChatModel expensive;// gpt-4o + 高温度（复杂推理）

    public ChatModel route(ChatRequest req) {
        return switch (classify(req)) {
            case INTENT_CLASSIFY, KEYWORD_EXTRACT, SIMPLE_QA
                -> cheap;                    // 80% 流量走这里，省最多
            case SUMMARIZE, TRANSLATE, MULTI_TURN
                -> mid;                      // 15% 流量
            case COMPLEX_REASONING, CODE_GEN, MATH
                -> expensive;                // 5% 流量，贵但准
        };
    }

    // 用 cheap 模型做意图分类（LLM 路由）
    private TaskType classify(ChatRequest req) {
        if (req.getTaskType() != null) return req.getTaskType();  // 业务已标注
        return cheap.classify(req.getPrompt());   // 未标注则 cheap 模型分类
    }
}
```

### 2.4 语义缓存

```java
@Component
public class SemanticCache {

    private final EmbeddingModel embed;
    private final MilvusClient milvus;

    public Optional<String> get(String prompt) {
        float[] vec = embed.embed(prompt);
        // 相似度 > 0.95 视为命中
        List<SearchResult> hits = milvus.search("prompt_cache", vec, 1, "similarity > 0.95");
        if (hits.isEmpty()) return Optional.empty();
        CacheEntry entry = hits.get(0).getEntity();
        // TTL 检查
        if (entry.getExpireAt().isBefore(Instant.now())) return Optional.empty();
        metrics.counter("cache.hit").increment();
        return Optional.of(entry.getResponse());
    }

    public void put(String prompt, String response, Duration ttl) {
        // 按 prompt 类型设 TTL：FAQ 1 小时，对话 5 分钟
        milvus.upsert("prompt_cache", new CacheEntry(embed.embed(prompt), response, Instant.now().plus(ttl)));
    }
}
```

## 三、实战层：成本控制闭环

### 3.1 Token 预算管理（三级响应）

```java
@Component
public class TokenBudget {

    private final RedisTemplate<String, Long> redis;

    public void checkAndReserve(String tenantId, int estimatedTokens) {
        String dailyKey = "budget:day:" + tenantId + ":" + LocalDate.now();
        String monthlyKey = "budget:month:" + tenantId + ":" + YearMonth.now();

        long dailyUsed = redis.opsForValue().increment(dailyKey, estimatedTokens);
        long monthlyUsed = redis.opsForValue().increment(monthlyKey, estimatedTokens);
        long dailyLimit = limitService.dailyLimitOf(tenantId);
        long monthlyLimit = limitService.monthlyLimitOf(tenantId);

        // 三级响应
        if (dailyUsed >= dailyLimit || monthlyUsed >= monthlyLimit) {
            // 100%：熔断，只保留核心请求走便宜模型
            throw new BudgetExceededException("预算耗尽，降级到 cheap 模型或拒绝");
        }
        if (dailyUsed >= dailyLimit * 0.95) {
            // 95%：限流，非核心请求拒绝
            if (!isCoreRequest()) throw new RateLimitedException("接近预算上限");
        }
        if (dailyUsed >= dailyLimit * 0.8) {
            // 80%：警告 + 自动降级到便宜模型
            alertService.warn("租户 " + tenantId + " 日预算使用 80%");
            modelRouter.forceDowngrade(tenantId);
        }
    }
}
```

### 3.2 成本看板（Grafana）

```promql
# 单请求成本（P95）
histogram_quantile(0.95, rate(token_cost_per_request_bucket[5m]))

# 模型分布（各模型调用量占比）
sum(rate(model_calls_total[5m])) by (model_name)

# 降级率（健康指标，过高说明主模型不稳定或预算太紧）
rate(model_fallback_total[5m]) / rate(model_calls_total[5m])

# 缓存命中率（越高省越多）
rate(cache_hit_total[5m]) / (rate(cache_hit_total[5m]) + rate(cache_miss_total[5m]))

# 租户日花费 Top 10（控成本）
topk(10, sum(increase(token_cost_total[1d])) by (tenant_id))
```

### 3.3 质量护栏（降级回切闭环）

```java
// 降级后必须监控质量，质量跌就回切
@Component
public class QualityGuard {

    public void evaluate(String tenantId, TaskType type, String response) {
        // 在线质量信号：用户点踩、人工接管、拒答率
        double qualityScore = qualityService.score(response, type);
        qualityMetric.label(tenantId, type).observe(qualityScore);

        // 质量跌破阈值，回切强模型
        if (qualityScore < threshold(type)) {
            log.warn("质量 {} 低于阈值，回切强模型 tenantId={}", qualityScore, tenantId);
            modelRouter.forceUpgrade(tenantId, type);
            alertService.warn("降级导致质量下降，已回切");
        }
    }
}
```

## 四、底层本质：成本-质量-可用性的三角权衡

模型服务网关的底层是**三角权衡**：成本（每请求多少钱）、质量（task_accuracy）、可用性（SLA）。三者不可同时最优，网关的职责是找到当前业务的最优平衡点。

**为什么不能全用强模型**：GPT-4 单次调用成本 0.05-0.5 元，日均亿级请求 = 日均千万级成本。而 80% 请求是简单任务（意图分类、FAQ），用 cheap 模型（成本低 30 倍）质量差异 < 5%。模型路由就是把"好钢用在刀刃上"。

**为什么不能只靠降级省成本**：降级是被动响应（主模型挂了才切），省的是可用性成本不是常规成本。主动省成本靠模型路由（80% 流量分流到 cheap）和语义缓存（相似请求不重复调用）。两者结合才能把成本压下来。

**为什么质量护栏是降级的闭环**：降级到弱模型后，如果不监控质量，可能用户投诉激增（弱模型幻觉率高、答非所问多）。质量护栏的闭环是：降级 → 监控 task_accuracy → 跌破阈值 → 自动回切强模型。这个闭环让降级从"一刀切"变成"动态调整"。

**供应商级高可用的本质**：单供应商 = 单点。多供应商 + 自动 failover 让单家宕机对业务无感。但多供应商引入一致性问题（同 prompt 不同模型输出不同），解法是结构化输出（JSON Schema 约束）+ 关键场景锁定不降级。

## 五、AI 工程化深挖：评估、护栏与可观测

1. **模型路由的准确率怎么保证？**
   路由准确率 = cheap 模型分类结果与"理想模型选择"的一致率。建评测集（prompt + 标注的最佳模型），LLM 路由跑一遍看准确率。低于 90% 说明分类 prompt 或 cheap 模型能力不足，要调。误路由成本：把复杂任务误判给 cheap 模型（质量差）、把简单任务误判给 expensive 模型（浪费钱），前者伤质量后者伤成本。

2. **降级后质量下降怎么量化？**
   不能靠"感觉变差"。要跟踪三个信号：(1) task_accuracy（离线 eval，弱模型在评测集上的准确率）；(2) user_feedback_score（在线，点赞/点踩比例）；(3) human_takeover_rate（人工接管率，用户不满意转人工）。三者任一显著下降就回切。建议设 5% 流量常驻弱模型做 A/B，持续对比。

3. **语义缓存的正确性怎么保证？**
   缓存的是"相似 prompt 的历史回答"，风险是回答过期或语境不同。解法：(1) 相似度阈值严（> 0.95 才命中）；(2) TTL 按 prompt 类型设（FAQ 长ttl、对话短ttl）；(3) 带时效性的 prompt（"今天的天气"）不缓存；(4) 缓存命中后对时效敏感字段做二次校验。监控 cache_hit_rate 和 cache_error_rate（命中但回答错误的比例）。

4. **多供应商输出不一致怎么办？**
   结构化输出（JSON Schema）能把差异降到最低——schema 约束了字段和类型，不同模型的输出格式趋同。自由文本输出差异大，解法：(1) 关键场景锁定单一供应商不降级（接受单点风险换一致性）；(2) 每个供应商维护独立的 prompt 版本（A 的 GPT-4 和 B 的 GPT-4 用不同 prompt 优化到接近效果）；(3) 对话场景降级时在 system prompt 说明"换了一个助手，风格可能略有不同"。

5. **模型服务网关本身的 SLO 怎么定？**
   网关是业务和 LLM 之间的层，它的延迟是"网关处理延迟"（< 50ms）+ "LLM 调用延迟"（1-15s）。SLO 分层：网关可用性 > 99.9%（不能比 LLM 供应商更不可用）、网关处理延迟 P99 < 100ms、端到端延迟 P95 < 15s（含 LLM）、成本偏差 < 5%（预算 vs 实际）。网关自身要做 Java 服务的全部稳定性实践：限流（保护下游 LLM）、熔断（LLM 不稳定时快速失败）、线程池隔离（LLM 调用不占主线程池）、灰度（新供应商灰度接入）。

## 六、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"多接入、降级链、三件套、质量环"** 四个词。

- **多接入**：多供应商统一 ChatClient，配置化切换，单家宕机无感
- **降级链**：主模型 → 备模型 → 自部署 → 规则引擎，熔断器驱动自动 failover
- **三件套**（成本）：模型路由（80% 流量走 cheap）、token 预算（三级响应）、语义缓存（相似命中）
- **质量环**：降级后监控 task_accuracy，跌破阈值自动回切强模型

### 面试现场 60 秒回答

> 模型服务网关我设计成四层：接入层用 Spring AI 多 ChatModel 抽象 OpenAI/通义/自部署 Qwen，业务代码统一调 ChatClient 不感知供应商。流量治理层走降级链——主模型（GPT-4o）熔断（错误率 30%）自动切备模型（通义），备模型再挂切自部署 Qwen，最后兜底规则引擎，保证永不返回错误。成本控制三件套：模型路由（cheap 模型做 80% 简单任务，省 60%+ 成本）、token 预算（按租户日/月限额，80% 警告 95% 限流 100% 熔断）、语义缓存（相似 prompt embedding 相似度 > 0.95 命中，FAQ 场景命中率 30-50%）。质量护栏是闭环：降级后监控 task_accuracy 和 user_feedback_score，跌破阈值自动回切强模型。核心指标 model_latency_p95、token_cost_per_request、fallback_rate、cache_hit_rate。

### 反问面试官

> 贵司 LLM 调用规模大概多少 QPS？月度 token 成本量级？这决定网关的侧重点——低 QPS 重点在多供应商高可用，高 QPS 重点在成本控制（模型路由 + 缓存）。

## 七、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不让业务直接调 OpenAI SDK，非要加一层网关？ | 直接调有四个问题：供应商散落配置无法统一切换、无统一限流熔断（一家宕机全站挂）、无成本控制（账单失控）、无统一审计。网关层把这四点收敛。证明：没网关时 OpenAI 宕机 3 个团队各自手忙脚乱切供应商；有网关自动 failover 业务无感 |
| 证据追问 | 你怎么证明网关省了钱？ | 对比"全走强模型"和"走网关（路由+缓存）"的 token_cost_per_request 和月度总账单。要有上线前后基线。某场景：全走 GPT-4 月 100 万，加网关路由+缓存后月 35 万，省 65% |
| 边界追问 | 网关解决不了什么？ | 解决不了模型本身的能力上限（cheap 模型就是不如强模型）、解决不了 prompt 质量差（垃圾 prompt 走网关还是垃圾输出）、解决不了业务逻辑 bug。网关只管"接入、治理、成本、观测"，不管"模型能力和 prompt 工程" |
| 反例追问 | 什么场景你不上网关？ | 单一团队、低 QPS（< 10 QPS）、单一供应商、成本不敏感（内部工具）——直接调 SDK 更简单，网关是过度设计。网关适合多团队共用、高 QPS、多供应商、成本敏感的场景 |
| 风险追问 | 网关上线最大风险？ | 降级后质量下降用户不满。兜底：质量护栏闭环（监控 task_accuracy + user_feedback_score，跌破阈值自动回切）。第二风险是网关自身成为单点（所有 LLM 调用都经过它），兜底：网关无状态 + 多实例 + K8s 自愈 |
| 验证追问 | 怎么证明降级链有效？ | 故障演练：注入 OpenAI 宕机（mock 超时/500）看是否自动切备模型、注入所有供应商失败看是否兜底规则引擎。监控 fallback_rate（健康值 < 5%，过高说明主模型不稳定或预算太紧）|
| 沉淀追问 | 团队网关规范沉淀什么？ | 供应商接入模板（ChatModel 配置 + 健康检查）、降级链配置模板（熔断阈值 + 顺序）、模型路由规则库（按 task_type）、成本看板模板（token_cost_per_request + 模型分布）、质量护栏 SOP |

### 现场对话示例

**面试官**：模型路由用 cheap 模型分类，这不是多一次 LLM 调用吗，真的省吗？

**候选人**：算账：cheap 模型分类成本 0.0001 元，如果分类后把一个原本要走 GPT-4（0.1 元）的请求分流到 GPT-4o-mini（0.005 元），单次省 0.095 元，减去分类成本净省 0.0949 元。只要分类准确率 > 50% 就稳赚。实际准确率 90%+，净省 60%+。进一步优化：业务侧已标注 task_type 的请求跳过分类（不调 cheap 模型），只对未标注的走分类。

**面试官**：语义缓存相似度 0.95 会不会误命中（语义不同但 embedding 相似）？

**候选人**：会，所以要分层防护。第一，0.95 阈值严（实测误命中率 < 2%）；第二，缓存只对"事实性/FAQ"类 prompt 开启，对话/时效性 prompt 不缓存（"今天天气"缓存了就是错）；第三，缓存命中后对关键实体做二次校验（命中的回答里的订单号和当前请求的订单号一致才返回）；第四，监控 cache_error_rate（命中但被用户点踩的比例），超阈值降相似度或关缓存。

**面试官**：多供应商同 prompt 输出不一致，A/B 测试时用户感知到了怎么办？

**候选人**：分场景。结构化输出（JSON）差异小，schema 约束后基本无感。自由文本输出，解法：(1) 统一 system prompt 规范输出风格，减少差异；(2) 关键链路（如支付确认、法律咨询）锁定单一供应商不降级，接受单点风险换一致性；(3) 对话降级时 system prompt 提示"风格可能略有变化"降低用户预期；(4) 监控 user_feedback_score 在降级期间的波动，显著下降就回切。本质是承认"降级有代价"，用工程手段把代价控制可接受范围。

## 常见考点

1. **LiteLLM 和 Spring AI 多模型区别？**——LiteLLM 是 Python 的 LLM 代理（统一 100+ 模型 API），可独立部署做网关；Spring AI 是 Java 框架，多 ChatModel 在应用内抽象。Java 后端优先 Spring AI（生态一致），跨语言大组织用 LiteLLM 统一代理。
2. **模型路由规则怎么定？**——先按 task_type 字段做规则路由（业务侧标注），简单有效；未标注的用 cheap 模型做 LLM 分类。积累数据后可训练专门的 router 模型（更准但有维护成本）。生产 80% 场景规则路由够用。
3. **token 预算怎么分摊到请求？**——请求前估算 token（prompt 长度 × 1.3 系数），扣减租户预算；响应后按实际 token 回补差额。预算用 Redis 原子计数，按租户/天/月分维度。超限三级响应（警告/限流/熔断）。
4. **熔断器对 LLM 怎么配？**——LLM 延迟高（秒级），slow-call-duration 阈值要调大（10s 而非默认 2s）；错误率阈值 30%（LLM 本身有偶发失败，阈值太严会频繁误熔断）；wait-duration 60s（给供应商恢复时间）。每个供应商独立熔断器，不相互影响。
5. **怎么监控 LLM 质量？**——三层：(1) 在线 user_feedback_score（点赞点踩）；(2) 离线 task_accuracy（评测集回归）；(3) 间接信号（人工接管率、拒答率、重试率）。质量是 LLM 特有维度，传统 APM 不覆盖，要自建 eval pipeline。

## 结构化回答

**30 秒电梯演讲：** 模型服务网关 = LLM 版的 API Gateway，核心职责是统一接入（多模型多供应商）、流量治理（限流/熔断/降级）、成本控制（token 预算/模型路由/缓存）、可观测（延迟/成本/质量指标）。降级的关键不是换个模型，而是换模型后质量是否可接受（quality SLO）

**展开框架：**
1. **多供应商统一抽象** — OpenAI/Anthropic/通义/自部署 统一 ChatClient 接口，配置化切换
2. **降级链** — 主模型（贵强）→ 备模型（便宜次）→ 规则引擎（确定性兜底），按 RT/错误率/预算触发
3. **模型路由** — 按任务复杂度路由（cheap 模型分类、expensive 模型生成），省 60%+ 成本

**收尾：** 以上是我的整体思路。您想继续深入聊——多供应商怎么保证输出一致？


## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：模型服务网关、降级与成本控制 | "这题核心是——模型服务网关 = LLM 版的 API Gateway，核心职责是统一接入（多模型多供应商）、流量治……" | 开场钩子 |
| 0:15 | 像一个多语种翻译调度台——有贵的金牌翻译（GPT类比图 | "打个比方：像一个多语种翻译调度台——有贵的金牌翻译（GPT。" | 核心类比 |
| 0:40 | 多供应商统一抽象示意/对比图 | "OpenAI/Anthropic/通义/自部署 统一 ChatClient 接口，配置化切换" | 多供应商统一抽象要点 |
| 1:05 | 降级链示意/对比图 | "主模型（贵强）→ 备模型（便宜次）→ 规则引擎（确定性兜底），按 RT/错误率/预算触发" | 降级链要点 |
| 1:30 | 模型路由示意/对比图 | "按任务复杂度路由（cheap 模型分类、expensive 模型生成），省 60%+ 成本" | 模型路由要点 |
| 1:55 | 总结卡 | "记住：网关四职责。下期见。" | 收尾 |
