---
id: java-architect-164
difficulty: L2
category: java-architect
subcategory: 模型服务
tags:
- Java 架构师
- AI成本
- 限流
- 降级
feynman:
  essence: AI 应用的成本治理本质是"按价值分配 token 预算"——高价值用户/场景用强模型，低价值用弱模型或缓存。限流防"一个用户烧光预算"，降级保证"模型挂了业务不停"。核心杠杆：模型路由（贵贱分级）、语义缓存（相似 query 复用）、token 预算（租户/用户级配额）、降级链（LLM → 规则 → 兜底文案）。
  analogy: 像旅行社的成本控制——VIP 客户用专属顾问（强模型），普通客户用 AI 客服（弱模型），常见问题查 FAQ（缓存），系统挂了给个模板回复（降级），每个客户有预算上限不能无限咨询。
  first_principle: LLM 调用是按 token 计费的（GPT-4 约 $0.03/1K token），一个恶意用户构造超长 prompt 能在一分钟烧掉数千美元。成本失控是 AI 应用的头号风险，必须用预算、限流、缓存、路由四道闸兜住。
  key_points:
  - 模型路由：简单 query → cheap 模型（GPT-3.5），复杂推理 → expensive（GPT-4）
  - 语义缓存：embedding query 相似度 > 0.95 命中缓存，复用历史回答
  - token 预算：租户/用户级日预算，超额拒绝或降级
  - 限流：QPS 限流 + token/min 限流，防单用户烧钱
  - 降级链：LLM 挂 → 规则引擎 → 缓存 → 兜底文案，保证业务可用
first_principle:
  problem: 如何让 AI 应用在成本可控的前提下保证服务可用性，不让恶意用户或模型故障拖垮系统？
  axioms:
  - LLM 调用按 token 计费，成本和输入/输出长度正相关
  - 强模型（GPT-4）比弱模型（GPT-3.5）贵 10-15 倍，但不是所有 query 都需要强模型
  - 模型服务可能挂（OpenAI 也有故障），业务不能 100% 依赖单一模型
  - 恶意用户可能构造超长 prompt 或高频调用攻击
  rebuild: 四道闸——(1) 模型路由按 query 复杂度选模型；(2) 语义缓存复用相似 query 的回答；(3) token 预算按租户/用户限额；(4) 降级链保证模型挂了走规则或缓存。监控 cost_per_query、cache_hit_rate、model_distribution、fallback_rate。
follow_up:
  - 怎么判断 query 要用强模型还是弱模型？——规则 + 分类器。规则：字数/关键词（"紧急"/"投诉"用强模型）。分类器：用小模型（或 embedding + 阈值）判断意图复杂度，复杂的走强模型。
  - 语义缓存怎么避免缓存污染？——key 用 query 的 embedding，相似度 > 0.95 才命中。但要做权限校验（A 用户的私有数据回答不能给 B）。缓存 TTL 短（1 小时），避免过期信息。
  - token 预算超了怎么办？——分档：超额 10% 告警，超额 20% 降级到弱模型，超额 50% 拒绝服务。预算按业务价值分配（付费用户 > 免费用户）。
  - 降级到规则引擎体验差怎么办？——降级不是常态，是兜底。平时优化模型可用性（多供应商：OpenAI + Claude + 自建），降级只在极端故障时触发。监控 fallback_rate < 1%。
  - 怎么量化单个 query 的成本？——记录每次调用的 input_tokens + output_tokens，按模型单价算 cost。cost_per_query = 总成本 / 总 query 数。按用户/租户/场景维度聚合。
memory_points:
  - 模型路由：简单→cheap 模型，复杂→expensive 模型，省 60%+ 成本
  - 语义缓存：embedding 相似度 > 0.95 命中，省重复调用
  - token 预算：租户/用户级日预算，超额降级或拒绝
  - 限流：QPS + token/min 双限，防单用户烧钱
  - 降级链：LLM → 规则 → 缓存 → 兜底文案，业务不断
---

# 【Java 后端架构师】AI 应用的成本预算、限流与降级

> 适用场景：JD 核心技术。智能客服上线后日均百万次 LLM 调用，月成本 200 万。发现有 1% 的用户贡献了 30% 的调用量（疑似刷接口），有 40% 的 query 是重复问题（"怎么退货"问了 10 万次）。架构师要从成本、限流、降级三个维度把 AI 应用做成可持续的服务。

## 一、概念层：AI 应用的四道成本闸

| 闸门 | 作用 | 杠杆 | 效果 |
|------|------|------|------|
| **模型路由** | 按复杂度选模型 | 简单用 GPT-3.5，复杂用 GPT-4 | 省 60%+ 成本 |
| **语义缓存** | 复用相似 query 回答 | embedding 相似度 > 0.95 命中 | 命中率 30-50% |
| **token 预算** | 按租户/用户限额 | 日预算超额降级 | 防成本失控 |
| **降级链** | 模型挂了业务不停 | LLM → 规则 → 缓存 → 兜底 | 保可用性 |

## 二、机制层：模型路由

```java
@Service
public class ModelRouter {

    private final ChatClient strongModel;    // GPT-4 / Claude-3-Opus
    private final ChatClient weakModel;      // GPT-3.5 / Claude-3-Haiku
    private final IntentClassifier classifier;

    /**
     * 按 query 复杂度路由到不同模型
     */
    public ChatClient route(String query, UserContext user) {
        // VIP 用户强制走强模型
        if (user.isVip()) {
            metrics.counter("model.route", "model", "strong", "reason", "vip").increment();
            return strongModel;
        }

        // 分类器判断复杂度
        IntentType intent = classifier.classify(query);
        switch (intent) {
            case SIMPLE_FAQ:                       // 简单 FAQ
            case ORDER_QUERY:                      // 订单查询
            case CHITCHAT:                         // 闲聊
                metrics.counter("model.route", "model", "weak").increment();
                return weakModel;                  // 70% query 走弱模型

            case COMPLAINT:                        // 投诉（需同理心）
            case REFUND_DISPUTE:                   // 退款争议（需推理）
            case MULTI_INTENT:                     // 多意图
                metrics.counter("model.route", "model", "strong").increment();
                return strongModel;

            default:
                return weakModel;                  // 默认弱模型省成本
        }
    }
}
```

## 三、机制层：语义缓存

```java
@Service
public class SemanticCache {

    private final MilvusClient vectorStore;
    private final RedisTemplate<String, String> redis;
    private final EmbeddingModel embeddingModel;

    private static final double SIMILARITY_THRESHOLD = 0.95;

    /**
     * 先查语义缓存，命中直接返回（不调 LLM）
     */
    public Optional<String> get(String query, UserContext user) {
        // 1. 精确匹配（Redis，高频 query）
        String exactKey = "cache:exact:" + user.getTenantId() + ":" + hash(query);
        String exact = redis.opsForValue().get(exactKey);
        if (exact != null) {
            metrics.counter("cache.hit", "type", "exact").increment();
            return Optional.of(exact);
        }

        // 2. 语义匹配（向量检索，找相似 query）
        float[] queryVec = embeddingModel.embed(query);
        List<CacheEntry> candidates = vectorStore.search(
            SearchParam.builder()
                .collectionName("query_cache")
                .vector(queryVec).topK(1)
                .expr("tenant_id == '" + user.getTenantId() + "'")  // 租户隔离
                .build());

        if (!candidates.isEmpty() && candidates.get(0).getScore() > SIMILARITY_THRESHOLD) {
            metrics.counter("cache.hit", "type", "semantic").increment();
            // 刷新 TTL
            redis.opsForValue().set(exactKey, candidates.get(0).getAnswer(),
                Duration.ofHours(1));
            return Optional.of(candidates.get(0).getAnswer());
        }

        metrics.counter("cache.miss").increment();
        return Optional.empty();
    }

    /**
     * 写缓存：LLM 回答后存入
     */
    public void put(String query, String answer, UserContext user) {
        // 只缓存高质量回答（用户没点踩）
        float[] vec = embeddingModel.embed(query);
        vectorStore.upsert("query_cache", new CacheEntry(query, answer, vec, user.getTenantId()));
        redis.opsForValue().set(
            "cache:exact:" + user.getTenantId() + ":" + hash(query),
            answer, Duration.ofHours(1));
    }
}
```

## 四、机制层：token 预算与限流

### 4.1 多维限流（QPS + token/min）

```java
@Service
public class AiRateLimiter {

    private final RedisTemplate<String, String> redis;

    private static final int USER_QPS = 5;              // 单用户每秒 5 次
    private static final int USER_TOKEN_PER_MIN = 5000; // 单用户每分钟 5000 token
    private static final int TENANT_QPS = 500;          // 单租户每秒 500 次

    /**
     * 双限流：QPS 防高频调用，token/min 防超长 prompt
     */
    public void checkLimit(String userId, String tenantId, int estimatedTokens) {
        // 1. QPS 限流（滑动窗口）
        String qpsKey = "rate:qps:" + userId;
        Long count = redis.opsForValue().increment(qpsKey);
        if (count == 1) redis.expire(qpsKey, Duration.ofSeconds(1));
        if (count > USER_QPS) {
            throw new RateLimitException("请求过于频繁，请稍后再试");
        }

        // 2. token/min 限流（防超长 prompt 烧钱）
        String tokenKey = "rate:token:" + userId;
        Long tokenUsed = redis.opsForValue().increment(tokenKey, estimatedTokens);
        if (tokenUsed == estimatedTokens) redis.expire(tokenKey, Duration.ofMinutes(1));
        if (tokenUsed > USER_TOKEN_PER_MIN) {
            throw new TokenBudgetException("Token 预算超限");
        }

        // 3. 租户级限流
        String tenantKey = "rate:tenant:" + tenantId;
        Long tenantCount = redis.opsForValue().increment(tenantKey);
        if (tenantCount == 1) redis.expire(tenantKey, Duration.ofSeconds(1));
        if (tenantCount > TENANT_QPS) {
            throw new RateLimitException("租户流量超限");
        }
    }
}
```

### 4.2 日预算控制

```java
@Service
public class BudgetGuard {

    private final RedisTemplate<String, String> redis;

    /**
     * 租户/用户级日预算
     * 超额分档降级
     */
    public BudgetCheck checkBudget(String userId, String tenantId) {
        // 查当日已用成本
        double userUsed = getDailyCost("cost:user:" + today() + ":" + userId);
        double tenantUsed = getDailyCost("cost:tenant:" + today() + ":" + tenantId);

        double userBudget = getUserBudget(userId);       // 普通用户 $1/天，VIP $10
        double tenantBudget = getTenantBudget(tenantId);

        if (userUsed > userBudget * 0.5 || tenantUsed > tenantBudget * 0.5) {
            metrics.counter("budget.warn").increment();
            // 50% 告警
        }
        if (userUsed > userBudget * 0.8) {
            return BudgetCheck.degradeToWeakModel();     // 80% 降级弱模型
        }
        if (userUsed > userBudget) {
            return BudgetCheck.reject("今日额度已用完"); // 100% 拒绝
        }
        return BudgetCheck.ok();
    }

    public void recordCost(String userId, String tenantId, double cost) {
        redis.opsForValue().increment("cost:user:" + today() + ":" + userId, cost);
        redis.opsForValue().increment("cost:tenant:" + today() + ":" + tenantId, cost);
    }
}
```

## 五、机制层：降级链

```java
@Service
@Slf4j
public class ResilientLlmService {

    private final ChatClient primaryModel;      // GPT-4
    private final ChatClient fallbackModel;     // GPT-3.5
    private final RuleEngine ruleEngine;        // 规则引擎
    private final SemanticCache cache;
    private final FallbackTextProvider textProvider;

    /**
     * 降级链：强模型 → 弱模型 → 规则 → 缓存 → 兜底文案
     */
    public String chat(String query, UserContext user) {
        // 0. 先查缓存
        Optional<String> cached = cache.get(query, user);
        if (cached.isPresent()) return cached.get();

        try {
            // 1. 主模型（带超时和重试）
            String answer = primaryModel.prompt()
                .user(query).timeout(Duration.ofSeconds(10)).call().content();
            cache.put(query, answer, user);
            return answer;

        } catch (TimeoutException | ModelUnavailableException e) {
            log.warn("主模型不可用，降级弱模型");
            metrics.counter("llm.fallback", "to", "weak").increment();
            try {
                // 2. 弱模型
                return fallbackModel.prompt().user(query)
                    .timeout(Duration.ofSeconds(5)).call().content();

            } catch (Exception e2) {
                log.warn("弱模型也不可用，降级规则引擎");
                metrics.counter("llm.fallback", "to", "rule").increment();
                // 3. 规则引擎（FAQ 匹配）
                Optional<String> ruleAnswer = ruleEngine.match(query);
                if (ruleAnswer.isPresent()) return ruleAnswer.get();

                // 4. 兜底文案
                metrics.counter("llm.fallback", "to", "text").increment();
                return textProvider.getDefault(user.getScenario());
            }
        }
    }
}
```

## 六、底层本质：AI 成本是"按 token 计费的云服务"

传统云服务按"实例/时长"计费（固定成本），LLM 按"token 次数"计费（变动成本）。这意味着：
- 用户越多成本越高（不像传统服务边际成本趋零）
- 单次 query 的 prompt 越长成本越高（攻击面）
- 强模型和弱模型价差 10-15 倍（选型直接影响成本）

**成本治理的第一性原理**：把 token 当作"稀缺资源"管理，按价值分配。高价值场景（付费用户、核心业务）给强模型 + 高预算，低价值场景（免费用户、闲聊）给弱模型 + 低预算 + 缓存。这和云计算早期的"按量计费成本治理"同构，只是单位从"CPU 小时"变成"token 数"。

## 七、AI 工程化深挖

1. **怎么评估模型路由的准确性？**
   建标注集：每个 query 标注"应该用强还是弱模型"。分类器的准确率要 > 90%。监控 misroute_rate（路由错误率），强模型被误分到弱模型会降质量，弱模型被误分到强模型会浪费成本。

2. **语义缓存怎么处理时效性？**
   缓存要带 TTL（一般 1 小时）和版本（知识库更新后失效）。对时效敏感的 query（"我的订单状态"）不缓存或短 TTL（5 分钟）。缓存命中后可选刷新（异步调 LLM 更新缓存）。

3. **怎么做多供应商成本优化？**
   不同供应商价格不同（OpenAI 贵但好，开源模型便宜但弱）。建"模型市场"——按 query 类型路由到性价比最优的供应商。监控 each_provider_cost 和 quality_score，动态调整路由策略。

4. **prompt 工程怎么省 token？**
   system prompt 精简（去掉冗余示例）、用 few-shot 而非 zero-shot（减少输出长度）、要求输出结构化（JSON 比散文短）。监控 avg_input_tokens 和 avg_output_tokens，优化 prompt 能省 20-30%。

5. **怎么向 CFO 汇报 AI 成本？**
   按维度拆解：按场景（客服/搜索/推荐）、按用户（VIP/普通）、按模型（强/弱）。给 ROI = 业务收益 / 成本。例如"客服 LLM 月成本 50 万，替代了 20 个人工客服（月薪 30 万），净省 10 万/月"。

## 八、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"路由、缓存、预算、降级"** 四个词。

- **路由**：简单 query → cheap 模型，复杂 → expensive，省 60%
- **缓存**：语义缓存（embedding 相似度 > 0.95），命中率 30-50%
- **预算**：租户/用户日预算，超额降级或拒绝
- **降级**：强模型 → 弱模型 → 规则 → 缓存 → 兜底，业务不断

### 面试现场 60 秒回答

> AI 应用成本治理我用四道闸。第一道模型路由——分类器判断 query 复杂度，简单 FAQ/闲聊走弱模型（GPT-3.5），投诉/争议走强模型（GPT-4），VIP 用户强制强模型，省 60%+ 成本。第二道语义缓存——query embedding 后查向量库，相似度 > 0.95 命中历史回答，命中率 30-50%，带租户隔离防泄露，TTL 1 小时防过期。第三道预算控制——用户级日预算（普通 $1、VIP $10），50% 告警、80% 降级弱模型、100% 拒绝。限流双维度：QPS（单用户 5/s）+ token/min（5000），防超长 prompt 和高频攻击。第四道降级链——主模型超时降弱模型，弱模型挂降规则引擎，规则没匹配降兜底文案，保证业务可用。监控 cost_per_query、cache_hit_rate、fallback_rate，成本看板按场景/用户/模型维度拆解。

## 常见考点

1. **模型路由怎么实现？**——规则（关键词/字数）+ 分类器（小模型或 embedding 判断意图复杂度）。VIP 强制强模型。监控 misroute_rate < 10%。
2. **语义缓存和普通缓存区别？**——普通缓存精确 key 匹配（命中率低），语义缓存用 embedding 相似度匹配（"怎么退货"和"如何退货"命中同一缓存）。但要做权限校验和时效控制。
3. **token 预算怎么分配？**——按用户价值（VIP > 普通）、按场景（核心业务 > 边缘）。预算动态调整（根据历史用量预测）。超额分档降级。
4. **降级链怎么设计不伤体验？**——降级是兜底不是常态。监控 fallback_rate < 1%。平时靠多供应商（OpenAI + Claude + 自建）保证主模型可用性，降级只在极端故障触发。

## 结构化回答

**30 秒电梯演讲：** AI 应用的成本治理本质是按价值分配 token 预算——高价值用户/场景用强模型，低价值用弱模型或缓存。限流防一个用户烧光预算，降级保证模型挂了业务不停。核心杠杆：模型路由（贵贱分级）、语义缓存（相似 query 复用）、token 预算（租户/用户级配额）、降级链（LLM → 规则 → 兜底文案）

**展开框架：**
1. **模型路由** — 简单 query → cheap 模型（GPT-3.5），复杂推理 → expensive（GPT-4）
2. **语义缓存** — embedding query 相似度 > 0.95 命中缓存，复用历史回答
3. **token 预算** — 租户/用户级日预算，超额拒绝或降级

**收尾：** 以上是我的整体思路。您想继续深入聊——怎么判断 query 要用强模型还是弱模型？


## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：AI 应用的成本预算、限流与降级 | "这题一句话：AI 应用的成本治理本质是按价值分配 token 预算——高价值用户/场景用强模型，低价值用弱模型或缓存。" | 开场钩子 |
| 0:15 | 模型路由示意/对比图 | "简单 query → cheap 模型（GPT-3.5），复杂推理 → expensive（GPT-4）" | 模型路由要点 |
| 0:40 | 语义缓存示意/对比图 | "embedding query 相似度 > 0.95 命中缓存，复用历史回答" | 语义缓存要点 |
| 1:25 | 总结卡 | "记住：模型路由。下期见。" | 收尾 |
