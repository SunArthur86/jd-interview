---
id: ant-risk-027
difficulty: L3
category: jd-ha
subcategory: 限流
tags:
- 蚂蚁
- 风控
- 高可用
- 限流
- 降级
- 超时重试
feynman:
  essence: 限流在入口截流（防过载）、降级在故障时兜底（保核心）、超时重试在调用层保护（防级联失败），三者是高可用系统的"防御工事"。
  analogy: 高可用三件套像城市防洪——限流是水闸（控制进水量）、降级是应急通道（核心功能保命）、超时重试是检查站（快速失败不死等）。
  first_principle: 系统容量有限，故障必然发生。限流防过载、降级保核心、超时重试防级联，三者在不同维度构建"故障可控"的防御。
  key_points:
  - 限流：令牌桶（允许突发）/ 漏桶（匀速）/ 滑动窗口（统计）
  - 降级：兜底返回、关闭非核心、简化逻辑
  - 超时：连接超时、读超时、总超时（必须分层设）
  - 重试：幂等前提、指数退避、最大次数限制
first_principle:
  problem: 系统资源有限、下游可能挂、网络会抖，如何让自身在压力和故障下仍提供核心服务？
  axioms:
  - 入口流量不可控（洪峰）
  - 下游不可控（故障）
  - 资源有上限（线程、连接、内存）
  rebuild: 限流控制入口（拒绝超额请求）、超时控制下游等待（不让一个慢拖死全部）、重试应对瞬时抖动、降级在故障时返回兜底——四者构成完整的"边界保护"。
follow_up:
- 令牌桶和漏桶区别？——令牌桶允许突发（攒令牌），漏桶强制匀速
- 怎么避免重试风暴？——指数退避 + 抖动 + 最大次数 + 熔断器
- 风控为什么超时必须分级？——总超时 = 用户容忍（200ms），分配到每个下游（特征 50ms、规则 50ms、模型 50ms）
memory_points:
- 限流（入口截流）+ 降级（兜底）+ 超时（防等死）+ 重试（防抖动）= 高可用四件套
- 令牌桶（突发）/漏桶（匀速）/滑动窗口（统计）
- 超时必须分级：连接/读/总，且总超时 < 用户容忍
- 重试必须幂等 + 指数退避 + 限次数 + 配熔断
---

# 【蚂蚁风控】高可用三件套——限流、降级、超时重试，怎么设计？

> JD 依据："保障海量数据系统的稳定性"。这是高可用的核心方法论。

## 一、限流（Rate Limiting）

**作用**：控制入口流量，超过阈值的请求被拒绝，保护系统不被冲垮。

**三种算法**：

### 1. 令牌桶（Token Bucket）
```
固定速率向桶里放令牌（如 1000 个/秒）
请求来时拿令牌：
  - 有令牌：放行，令牌 -1
  - 无令牌：拒绝
桶满则丢弃新令牌

特点：允许突发（桶里的令牌可瞬间消费完）
```

### 2. 漏桶（Leaky Bucket）
```
请求像水滴流入桶
桶以恒定速率漏水（处理请求）
水满则拒绝新水

特点：强制匀速（不允许突发）
```

### 3. 滑动窗口（Sliding Window）
```
统计过去 N 秒的请求数
超过阈值则拒绝
窗口滑动（按时间分桶）

特点：精确统计，但有边界突变
```

**风控的限流策略**：
- **全局 QPS 限流**：保护系统总容量（10万 QPS）
- **单 UID 限流**：防恶意刷（每秒 10 次）
- **单 IP 限流**：防爬虫（每分钟 100 次）
- **集群限流**：用 Token Server 集中算

**Sentinel 配置**：
```java
@SentinelResource(value = "risk_decide",
    blockHandler = "decideBlock")  // 限流时调用
public RiskResult decide(Event e) { ... }

public RiskResult decideBlock(Event e, BlockException ex) {
    return RiskResult.degrade("rate_limited");  // 限流降级
}
```

## 二、降级（Degradation）

**作用**：故障或高压时，主动牺牲非核心功能、返回兜底，保核心可用。

**降级策略**：

| 策略 | 含义 | 例子 |
|------|------|------|
| **返回默认值** | 故障时返回兜底 | 特征查不到用默认特征 |
| **关闭非核心** | 关掉次要功能 | 高峰期关闭推荐、运营位 |
| **简化逻辑** | 跑简化版 | 用规则替代模型（模型挂了） |
| **读旧数据** | 用缓存 | 数据库挂了用缓存 |
| **同步转异步** | 不阻塞主流程 | 通知、日志改异步 |

**风控的降级链路**：
```java
public RiskResult decide(Event e) {
    try {
        // 1. 优先正常路径
        return doDecide(e);
    } catch (Exception ex) {
        // 2. 降级路径
        return degradeDecide(e);
    }
}

private RiskResult degradeDecide(Event e) {
    // 降级 1：模型挂了，退化为规则
    if (modelService.isDown()) {
        return ruleOnlyDecide(e);
    }
    // 降级 2：特征挂了，用缓存
    if (featService.isDown()) {
        return cachedDecide(e);
    }
    // 降级 3：全部挂了，用兜底（黑名单 + 基础规则）
    return basicDecide(e);
}
```

**降级开关**：
```java
// 用配置中心管理降级开关（一键开关）
@NacosValue(value = "${risk.degrade.model:false}", autoRefreshed = true)
private boolean degradeModel;

if (degradeModel) {
    return ruleOnlyDecide(e);  // 强制降级
}
```

## 三、超时（Timeout）

**为什么必须设超时**：
- 不设超时 → 一个慢请求拖死线程池 → 雪崩
- 设超时 → 快速失败，释放资源

**分层超时**：
```java
// 风控决策的超时分配（总 200ms）
决策总超时: 200ms
  ├─ 特征查询: 50ms
  │   ├─ Redis: 10ms
  │   └─ HBase: 50ms
  ├─ 规则匹配: 50ms
  ├─ 模型推理: 50ms
  └─ 决策融合: 10ms
```

**关键原则**：
- **总超时 < 用户容忍**（用户支付等不及 < 1s）
- **下游超时 < 上游超时**（留余量给上层处理）
- **超时必须显式**（不依赖默认值）

**Feign 配置**：
```yaml
feign:
  client:
    config:
      default:
        connect-timeout: 1000     # 连接超时
        read-timeout: 2000        # 读超时
      feature-service:
        read-timeout: 50          # 特征调用更严
```

## 四、重试（Retry）

**适用场景**：
- 瞬时抖动（网络闪断、瞬时超时）
- 必须幂等（避免重复副作用）

**重试策略**：
```java
// 指数退避 + 抖动
public <T> T callWithRetry(Callable<T> call) throws Exception {
    int maxRetry = 3;
    for (int i = 0; i <= maxRetry; i++) {
        try {
            return call.call();
        } catch (Exception e) {
            if (i == maxRetry) throw e;
            long wait = (long) (100 * Math.pow(2, i) + random(50));  // 指数 + 抖动
            Thread.sleep(wait);
        }
    }
}
```

**重试的坑**：
1. **非幂等操作不能重试**：转账接口重试可能扣两次
2. **重试风暴**：上游重试放大下游压力（雪崩）→ 必须配熔断器
3. **无限重试**：必须设最大次数

**幂等保证**：
```java
// 用业务幂等 token
public void transfer(TransferReq req) {
    if (!redisTemplate.setIfAbsent("idempotent:" + req.getRequestId(), "1", 1, DAYS)) {
        return;  // 已处理过，跳过
    }
    doTransfer(req);
}
```

## 五、四件套的协同

```
请求进入
   ↓
[限流] 超过阈值直接拒绝（保护容量）
   ↓
[超时] 调用下游限时（防止拖死）
   ↓
[重试] 瞬时失败自动重试（应对抖动）
   ↓
[熔断] 持续失败熔断（防止重试风暴）
   ↓
[降级] 故障时返回兜底（保证可用）
```

**Sentinel 把限流、熔断、降级一体化**：
```java
@SentinelResource(value = "callFeature",
    blockHandler = "rateLimitFallback",      // 限流熔断降级
    fallback = "exceptionFallback")          // 业务异常降级
public Feature callFeature(String uid) {
    return featureService.get(uid);  // 可能慢/失败
}
```

## 六、风控实战：完整的防御工事

**层次化防御**：

```
1. 接入层（网关）
   - 全局 QPS 限流（保护整个风控平台）
   - 单 UID/IP 限流（防刷）
   - 黑名单直拦（IP/UA）

2. 服务层（风控决策）
   - 业务前预热（双 11 提前扩容）
   - 每个下游独立熔断（防雪崩）
   - 决策超时 200ms（用户体验）

3. 依赖层（特征/规则/模型）
   - 调用超时（特征 50ms、规则 50ms、模型 50ms）
   - 重试（瞬时抖动，最多 2 次）
   - 降级（用缓存/默认值）

4. 数据层（Redis/HBase/MySQL）
   - 连接池上限
   - 慢查询告警
   - 主从切换
```

## 七、监控与告警

**限流指标**：
```
risk_rate_limit_total{rule="global_qps"}    # 限流次数
risk_rate_limit_ratio                        # 限流比例（>1% 告警）
```

**熔断指标**：
```
risk_circuit_breaker_state{service="feature"}  # CLOSED/OPEN/HALF_OPEN
risk_circuit_breaker_total{service="feature"}  # 熔断次数
```

**降级指标**：
```
risk_degrade_total{strategy="model_down"}   # 降级次数（>0 告警）
```

**SLA 指标**：
```
风控可用性 = 1 - 拒绝次数/总请求
P99 RT < 200ms
```

## 八、底层本质：故障必然性下的"边界保护"

高可用三件套的本质是承认**"故障必然发生"**，从被动应对转为主动防御：

**限流**：保护自己的边界（不让外界压垮自己）
**超时重试**：保护自己不被外界拖死（快速失败）
**降级**：在部分故障时仍提供核心价值（有限可用）

**这是"防御性编程"在系统层面的体现**：
- 不假设外界友好（限流）
- 不假设依赖可靠（超时重试）
- 不假设一切正常（降级）

**和"韧性工程"的关系**（Resilience Engineering）：
- Chaos Engineering（混沌工程）：主动制造故障验证降级生效
- 故障演练：定期"杀实例"验证限流熔断
- SRE 的"金标准"：MTTR < 5 分钟

## 九、AI 时代的演进

**LLM 服务的高可用新挑战**：
- LLM 推理慢（秒级），传统超时不适用
- Token 成本高，需要"成本限流"
- 模型幻觉可能产生错误决策

**对应方案**：
- 限流：按 token 数限流（防成本爆炸）
- 降级：LLM 挂了 fallback 到规则
- 超时：流式输出（不等完整响应）
- 重试：LLM 调用要幂等（避免重复扣 token）

## 常见考点
1. **令牌桶和漏桶选哪个**？——允许突发选令牌桶（API 网关常见），强制匀速选漏桶（消息队列）。
2. **熔断和限流区别**？——限流是主动防御（按 QPS 拒绝），熔断是被动响应（按失败率切断）。
3. **重试和幂等关系**？——非幂等接口（如扣款）不能盲目重试，必须配业务幂等 token。

**代码示例**（Resilience4j 综合配置）：
```java
@CircuitBreaker(name = "feature", fallbackMethod = "fallback")
@Bulkhead(name = "feature")          // 隔离
@TimeLimiter(name = "feature")       // 超时
@Retry(name = "feature")             // 重试
public CompletableFuture<Feature> callFeature(String uid) {
    return CompletableFuture.supplyAsync(() -> featureService.get(uid));
}

public CompletableFuture<Feature> fallback(String uid, Exception e) {
    return CompletableFuture.completedFuture(Feature.default());  // 降级
}
```
