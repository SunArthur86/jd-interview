---
id: pdd-ai-027
difficulty: L4
category: pdd-ai
subcategory: 限流
tags:
- 拼多多
- AI 中台
- 限流
- 降级
- 超时
- 重试
- LLM 网关
feynman:
  essence: 限流降级超时重试是"高可用四板斧"——限流防过载、降级保核心、超时防雪崩、重试应对偶发，LLM 网关特别要按 token/成本维度限流。
  analogy: 像医院急诊——人数超容限流（拿号），轻症降级（自助药），等待超时回家（超时），偶尔叫不到号重试（再挂）。
  first_principle: 系统容量有限，突发流量必须控制（限流），异常要快速失败（超时/熔断），偶发失败要兜底（重试），核心要保（降级）。
  key_points:
  - 限流算法：令牌桶/漏桶/滑动窗口/计数器
  - 限流维度：QPS/并发/token/成本
  - 降级：返回兜底/切小模型/关闭非核心
  - 超时：连接/读/整体，分层设置
  - 重试：指数退避 + 上限 + 幂等
first_principle:
  problem: 怎么在过载/故障时保核心、防雪崩、可恢复？
  axioms:
  - 容量有限
  - 故障必然发生
  - 雪崩会扩散
  rebuild: 限流 + 降级 + 超时 + 重试（四板斧组合）。
follow_up:
  - LLM 怎么按 token 限流？——预估输出 token，按累计 token 限（防超长输出爆资源）
  - 重试为什么会放大故障？——大量重试 → 雪崩，要退避 + 熔断
  - 怎么判断该降级？——错误率/RT/资源水位超阈值自动触发
memory_points:
  - 算法：令牌桶/漏桶/滑窗/计数
  - 维度：QPS/并发/token/成本
  - 降级：兜底/小模型/关非核心
  - 重试：退避 + 上限 + 幂等
---

# 【拼多多 AI 中台】限流降级超时重试怎么做？LLM 网关怎么限流？

> JD 依据："高并发、模型服务、消费者服务策略算法中台"。

## 一、限流算法

### 1. 计数器（固定窗口）
```
每秒请求数 < 100
简单但有边界突刺（窗口切换瞬间 2x）
```

### 2. 滑动窗口
```
把窗口切成小格（如 1 秒分 10 个 100ms 格）
滑动统计，平滑无突刺
Sentinel 默认实现
```

### 3. 漏桶（Leaky Bucket）
```
请求进桶（容量有限），按固定速率出桶
强制平滑速率
适合保护下游（保证匀速）
```

### 4. 令牌桶（Token Bucket）
```
固定速率发令牌，桶满丢弃
请求拿令牌才能处理
允许突发（桶里存令牌）
适合限速但不死板
Guava RateLimiter 实现
```

## 二、限流维度

```
1. QPS（每秒请求数）
2. 并发数（同时处理数）
3. token/s（LLM 特殊，按 token 限）
4. 成本（每小时花费上限）
5. 用户维度（单 uid 限流）
6. IP 维度（防刷）
7. 模型维度（按 model_id 限）
8. 接口维度（不同接口不同阈值）
```

### LLM 网关限流（关键）
```java
@Component
public class LlmRateLimiter {

    // 多维度组合限流
    public void check(String uid, String model, String prompt) {
        int estTokens = estimateTokens(prompt) + 1000;  // 估算输入+输出

        // 1. 全局 QPS
        rateLimiter.tryAcquire("llm_global_qps", 1000);

        // 2. 单 uid QPS（防刷）
        rateLimiter.tryAcquire("llm_uid:" + uid, 10);

        // 3. 单 uid token/s（防超长输出）
        tokenBucket.acquire("llm_uid_tokens:" + uid, estTokens, 10000);

        // 4. 模型维度（贵模型限更严）
        int modelQps = MODEL_LIMIT.get(model);  // gpt-4 类 → 100 QPS
        rateLimiter.tryAcquire("llm_model:" + model, modelQps);

        // 5. 成本维度（每小时累计成本）
        double cost = calcCost(model, estTokens);
        if (costLedger.tryDeduct(uid, cost) == 0) {
            throw new RateLimitException("超出成本配额");
        }
    }
}
```

## 三、降级策略

```
1. 返回兜底（默认结果）
   "系统繁忙，稍后再试" / 推荐默认商品列表

2. 切小模型
   LLM：72B → 7B（响应快成本低）
   推荐：精排 → 粗排

3. 关闭非核心
   大促时关个性化推荐、关评论展示

4. 简化流程
   跳过 RAG（直接 LLM）
   跳过重排（只召回+精排）

5. 静态化
   动态页面 → CDN 静态页
```

### 降级触发
```java
@SentinelResource(value = "chat",
    blockHandler = "blocked",
    fallback = "fallback")
public String chat(String prompt) {
    return llmClient.invoke(prompt);
}

// 限流时
public String blocked(String prompt, BlockException e) {
    return "系统繁忙";  // 或切小模型
}

// 异常时
public String fallback(String prompt, Throwable e) {
    return smallLlmClient.invoke(prompt);  // 兜底
}
```

## 四、超时设置

```
分层超时：
- 连接超时（connect timeout）：1s
- 读超时（read timeout）：30s（LLM 慢，要长）
- 整体超时（request timeout）：60s
- 流式首 token 超时（TTFT）：5s

LLM 特殊：
- 首 token 必须快（用户等不了）
- 后续 token 可慢
- 总长度有上限（防爆 token）
```

```java
// OkHttp 客户端配置
OkHttpClient client = new OkHttpClient.Builder()
    .connectTimeout(1, TimeUnit.SECONDS)
    .readTimeout(60, TimeUnit.SECONDS)
    .callTimeout(120, TimeUnit.SECONDS)
    .build();
```

## 五、重试策略

```
什么情况重试：
- 网络抖动（连接失败/超时）
- 临时错误（5xx）
- 限流（429，需退避）

什么情况不重试：
- 业务错误（4xx，参数错）
- 持续错误（熔断打开）
- 非幂等操作（部分场景）

重试算法：
- 指数退避：1s → 2s → 4s → 8s
- 抖动：避免重试风暴（+ random jitter）
- 上限：最多 3 次
- 熔断：错误率超阈值停止重试
```

### LLM 重试特别注意
```
LLM 推理可能部分成功（流式输出到一半失败）
- 重试要重新计算 token（已输出部分）
- 或保存已输出部分，从中断点续
- 大部分场景直接整体重试（用户重发）
```

### 重试 + 熔断（Hystrix/Sentinel）
```java
@Retryable(maxAttempts = 3, backoff = @Backoff(delay = 1000, multiplier = 2))
public String callLlm(String prompt) {
    return llmClient.invoke(prompt);
}

@Recover
public String recover(Exception e, String prompt) {
    return "系统繁忙";  // 重试用尽兜底
}
```

## 六、四板斧协同

```
请求进入
   ↓
限流（QPS/uid/token/成本）──超→ 拒绝/排队
   ↓
调用 LLM
   ├ 超时 → 重试（指数退避，3 次内）
   ├ 异常 → 降级（小模型/兜底）
   └ 持续故障 → 熔断（直接降级，不再调用）
   ↓
返回结果
```

## 七、LLM 网关限流特殊设计

### 1. Token-based 限流
```
不是 QPS，而是 tokens/s
原因：
  - 长 prompt 占用资源多
  - 长 generation 占 GPU 久
  - 按 QPS 限流会被长请求绕过

实现：
  - 输入 token 立即扣
  - 输出 token 实时扣（流式时累计）
  - 超额拒绝/降级
```

### 2. 成本维度限流
```
按 $ / ¥ 计费：
  - 72B 模型每千 token $0.01
  - 单用户每小时上限 $10
  - 全局每小时上限 $10000

防：恶意刷 → 成本爆
防：bug 死循环 → 成本爆
```

### 3. 优先级
```
高优先级：付费用户、生产业务
中优先级：内部员工、实验
低优先级：免费用户、批量任务

资源紧张时优先服务高优
```

## 八、拼多多实战

```
LLM 网关（双 11 保障）：
- 全局 QPS：10000
- 单 uid QPS：5
- 单 uid token/s：2000
- 单 uid 每小时成本：¥10
- 大促降级：72B → 7B（响应快成本低）

监控：
- 限流次数（告警）
- 降级次数（告警）
- 超时率
- 重试成功率
- 熔断状态

预案：
- 限流阈值动态调整（运营后台）
- 降级开关（一键切小模型）
- 熔断阈值（错误率/RT 自适应）
```

## 九、底层本质

四板斧本质是**"控制流量 + 快速失败 + 兜底保活"**——限流防过载（按 QPS/并发/token/成本多维），超时防雪崩（连接/读/整体分层），降级保核心（兜底/小模型/关非核心），重试应对偶发（退避+上限+幂等）。LLM 场景特别要按 token 和成本限流，并做好流式降级。

## 常见考点

1. **令牌桶和漏桶区别**？——令牌桶允许突发（存令牌），漏桶强制匀速；网关限流用令牌桶，保护下游用漏桶。
2. **重试风暴怎么避免**？——指数退避 + 随机抖动 + 熔断 + 限制总重试率（如不超过 QPS 10%）。
3. **LLM 流式输出超时怎么办**？——首 token 超时立即失败，后续 token 间歇超时容忍（已生成部分返回 + 标记截断）。
