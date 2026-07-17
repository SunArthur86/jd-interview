---
id: pdd-content-027
difficulty: L4
category: pdd-content
subcategory: 限流
tags:
- 拼多多
- 内容
- 限流
- 降级
- 超时
- 重试
- 直播
- 评价
feynman:
  essence: 限流降级超时重试是高可用四件套——限流防过载、降级保核心、超时防雪崩、重试保成功；内容场景如直播弹幕限流、评价降级。
  analogy: 像医院急诊——限流是限号（防挤爆）、降级是非急病转门诊（保核心）、超时是手术限时、重试是换医生再试。
  first_principle: 系统资源有限，故障必然发生，需主动保护+优雅退化。
  key_points:
  - 限流：单机（令牌桶/漏桶）+集群（Sentinel/网关）
  - 降级：核心优先，非核心兜底/返回默认
  - 超时：连接+读取分层，避免雪崩
  - 重试：幂等+退避+次数限制
first_principle:
  problem: 系统资源有限+故障必然，如何主动保护+优雅退化？
  axioms:
  - 资源有上限
  - 故障会发生
  - 核心要保住
  rebuild: 限流（防过载）+降级（保核心）+超时（防雪崩）+重试（保成功）。
follow_up:
  - 令牌桶和漏桶区别？——令牌桶允许突发，漏桶匀速
  - 降级怎么触发？——异常率/慢调用/手动开关
  - 重试风暴怎么防？——退避+熔断+限制重试次数
memory_points:
  - 限流：令牌桶/漏桶+Sentinel
  - 降级：核心优先+默认值
  - 超时：连接+读取分层
  - 重试：幂等+退避+限次
---

# 【拼多多内容】限流降级超时重试怎么设计？

> JD 依据："系统高可用/扩展性"、"稳定性建设"。

## 一、限流

**算法**：
| 算法 | 原理 | 特点 |
|------|------|------|
| 计数器 | 单位时间内计数 | 简单，临界点突刺 |
| 滑动窗口 | 切分小窗口 | 平滑 |
| 漏桶 | 固定速率出水 | 匀速，无突发 |
| 令牌桶 | 固定速率发令牌 | 允许突发 |

**令牌桶**（Guava RateLimiter）：
```java
RateLimiter limiter = RateLimiter.create(100);   // 100 QPS
if (!limiter.tryAcquire(1, 1, SECONDS)) {
    throw new TooManyRequestsException();
}
```

**Sentinel（集群限流+熔断）**：
```java
@SentinelResource(value = "submitReview",
    blockHandler = "onBlock",
    fallback = "onError")
public Result submit(ReviewDTO dto) {
    return reviewService.submit(dto);
}

public Result onBlock(ReviewDTO dto, BlockException e) {
    return Result.fail("系统繁忙，请稍后");
}
```

**限流维度**：
- 单 UID（防刷）
- 全局 QPS（保护系统）
- 房间级（直播弹幕）
- 接口级（不同接口不同阈值）

## 二、降级

**降级策略**：
- **返回默认值**：评价列表空时返回"暂无评价"
- **走兜底数据**：推荐挂时返回热榜
- **关闭非核心**：双 11 关闭"我的足迹"
- **同步→异步**：实时统计降级为离线

**触发条件**：
- 异常率 > 阈值
- 慢调用比例 > 阈值
- 资源（CPU/内存）超限
- 手动开关（活动/故障）

```java
// 评价查询降级
@SentinelResource(value = "listReviews",
    fallback = "listReviewsFallback")
public List<Review> listReviews(Long pid) {
    return reviewService.findByProductId(pid);
}

public List<Review> listReviewsFallback(Long pid, Throwable e) {
    // 降级：返回空列表或缓存
    return Collections.emptyList();
}
```

**核心 vs 非核心**：
- 核心：评价查询/下单/支付（保住）
- 非核心：推荐/统计/广告（可降级）

## 三、超时

**分层超时**：
```
网关超时（30s）
  ↓
服务超时（10s）
  ↓
DB 超时（3s）/ Redis（500ms）/ 远程调用（3s）
```

```java
// Feign 超时
feign:
  client:
    config:
      default:
        connectTimeout: 1000
        readTimeout: 3000

// 数据库超时
spring:
  datasource:
    hikari:
      connection-timeout: 3000
```

**为什么超时重要**：无超时会引发调用方线程堆积→雪崩。

## 四、重试

**重试原则**：
- 幂等才重试（GET/带幂等键的 POST）
- 退避（指数退避：1s/2s/4s）
- 限制次数（通常 3 次）
- 熔断时不重试

```java
// Spring Retry
@Retryable(value = { SQLException.class },
    maxAttempts = 3,
    backoff = @Backoff(delay = 1000, multiplier = 2))
public void saveReview(Review r) {
    reviewDao.insert(r);
}

@Recover
public void recover(SQLException e, Review r) {
    // 重试耗尽，进死信
    deadLetterQueue.send(r);
}
```

**重试风暴**：
- A 调 B，B 调 C；C 挂，A 重试 3 次，B 重试 3 次 → C 收到 9 倍流量
- 解法：上游熔断（不重试），下游限流（保护自己）

## 五、内容场景实战

**1. 直播弹幕限流**：
```java
// 房间级限流
@SentinelResource("danmaku")
public void send(Danmaku d) { ... }

// 规则：每房间 500 QPS，超限返回拥挤提示
```

**2. 评价查询降级**：
```
评价服务挂 → 商品页降级显示"评价加载中"+默认评分 5.0
推荐挂     → 返回热销榜兜底
搜索挂     → 走 MySQL 简单查询
```

**3. 直播开播预热（避免冷启动超时）**：
- 提前 10 分钟扩容
- 缓存预热（直播间统计/在线列表）
- 数据库连接预热

**4. 评价提交重试（幂等）**：
```java
// 幂等键（orderId+uid），重试不重复创建
@PostMapping("/reviews")
public Result submit(@RequestBody ReviewDTO dto,
                     @RequestHeader("X-Request-Id") String reqId) {
    if (reviewDao.existsByRequestId(reqId)) {
        return Result.ok(reviewDao.getByRequestId(reqId));
    }
    reviewService.create(dto, reqId);
}
```

## 六、Sentinel 规则配置

```java
// 限流规则
FlowRule flow = new FlowRule();
flow.setResource("submitReview");
flow.setCount(1000);                   // 1000 QPS
flow.setGrade(RuleConstant.FLOW_GRADE_QPS);
flow.setLimitApp("default");

// 熔断规则（慢调用）
DegradeRule degrade = new DegradeRule();
degrade.setResource("listReviews");
degrade.setGrade(CircuitBreakerStrategy.SLOW_REQUEST_RATIO.getType());
degrade.setCount(500);                 // RT > 500ms 算慢
degrade.setSlowRatioThreshold(0.5);    // 慢调用比例 >50% 触发
degrade.setTimeWindow(10);             // 熔断 10s
```

## 七、底层本质

限流降级超时重试本质是**"用主动保护+优雅退化应对资源有限+故障必然"**——限流防过载、降级保核心、超时防雪崩、重试保成功，四者协同形成高可用防线。

## 常见考点
1. **令牌桶 vs 漏桶**？——令牌桶允许突发（适合限流用户请求），漏桶匀速（适合保护下游）。
2. **熔断器状态机**？——Closed→Open（熔断）→Half-Open（探测）→Closed。
3. **重试风暴怎么防**？——熔断时不重试+下游限流+限制次数。

## 苏格拉底式面试追问

> 这组追问不是背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：直播弹幕限流你用令牌桶，但评价查询用漏桶（Sentinel 默认匀速）。为什么同是限流，算法不同？**

算法选择取决于"是否允许突发"。令牌桶（RateLimiter）允许突发——桶里攒的令牌可以瞬间消耗，适合"用户请求"场景（用户瞬时点几下不应被限）。直播弹幕是用户产生的，有突发性（高潮时密集发），用令牌桶能容纳合理突发，只在超桶容量时拒绝。漏桶（匀速队列）是"固定速率出水"，不管来多猛都匀速放过，适合"保护下游"场景（下游只能扛固定 QPS）。评价查询如果直接打 DB，DB 扛不住突发，用漏桶把请求匀速化，保护 DB。本质：令牌桶"宽容上游"（允许突发），漏桶"保护下游"（强制匀速）。弹幕限流是保护系统不被用户打爆（令牌桶），评价查 DB 限流是保护 DB（漏桶）。

### 第二层：证据与定位

**Q：评价提交接口开始大量返回"系统繁忙"（限流触发），但实际 QPS 没到阈值。你怎么定位是限流规则配错还是别的？**

限流误触发排查：
1. 看 Sentinel 规则——`limitApp` 是否配成了特定来源（如只限某调用方），或 `grade` 是 QPS 还是并发线程数。如果配成并发线程数限流（grade=THREAD），即使 QPS 低，但单请求耗时长（如 500ms），并发数 = QPS × 耗时 = 可能超阈值。
2. 看是否是"热点参数限流"——如果配了 `@SentinelResource` 的热点参数（如按 productId 限流），某爆款商品的提交集中，触发单 key 限流，但整体 QPS 不高。
3. 看集群限流——如果是集群限流（基于 Token Server），Token Server 故障或网络抖动会导致"获取令牌失败"被误判为限流。看 Sentinel 的 `block.exception` 类型（FlowException vs其他）。

### 第三层：根因深挖

**Q：评价查询降级（fallback 返回空列表）频繁触发，但下游评价服务其实没挂。根因可能是什么？**

降级误触发的根因：
1. 熔断规则太敏感——慢调用比例阈值设低了（如 RT >200ms 比例 >30% 触发熔断），但评价服务 P99 就是 250ms（正常水位），规则把正常当异常。看 Sentinel 的 `circuitBreaker.stats`，对比实际 RT 分布。
2. 降级条件用错——`fallback` 是"异常降级"（抛异常才触发），`blockHandler` 是"限流降级"。如果把 `fallback` 配成处理所有 Throwable，业务异常（如参数校验失败）也触发降级返回空，用户以为系统挂了。
3. 依赖链路误判——评价查询 Feign 调用评价服务，Feign 的超时（readTimeout=3s）如果小于评价服务的实际响应（4s），Feign 抛 ReadTimeout，触发 fallback。根因是超时配置不当，不是服务挂。
根治：熔断阈值基于"实际 SLA + 病态值"设（如 P99 是 250ms，阈值设 RT >1000ms 才算病态）；fallback 只处理特定异常（如 RpcException），业务异常向上抛。

### 第四层：方案权衡

**Q：评价提交你用幂等键（X-Request-Id）+ 重试（3 次指数退避），但重试放大了下游压力。你要不要完全去掉重试？**

重试是双刃剑，不能简单去掉。权衡：
1. 重试的价值——网络抖动（瞬时不可达）导致的失败，重试能恢复。评价提交如果不重试，用户网络不稳时失败率高。
2. 重试的风险——下游过载时，重试放大流量（A 重试 3 次 = 下游承受 3 倍流量），加剧过载（重试风暴）。
3. 权衡方案——**条件重试**：
   - 幂等才重试（评价提交带 X-Request-Id 保证幂等，可重试）。
   - 熔断时不重试（下游熔断状态，重试无意义，直接失败）。
   - 退避（1s/2s/4s，给下游恢复时间）。
   - 限次（最多 3 次，不无限重试）。
4. 区分错误类型——网络错误（connect refused）可重试；业务错误（参数校验失败）不重试（重试还是失败）；限流（429）不重试（重试加剧）。
拼多多评价提交用条件重试 + 死信队列兜底——3 次失败进死信，异步补偿，不无限放大下游压力。

### 第五层：验证与沉淀

**Q：限流降级超时重试的规则上线后，怎么验证它们在故障时真的生效（而不是配了但没触发）？**

稳定性预案的验证靠混沌工程：
1. 故障注入——kill 评价服务的某个实例（验证限流：剩余实例扛不住时触发限流返回"繁忙"而非超时）；给评价服务注入延迟（RT 涨到 2s，验证熔断触发 + fallback 返回默认值）。
2. 看监控——故障期间，Sentinel Dashboard 应显示 `blockCount`（限流触发数）和 `circuitBreaker.state`（Open 熔断），应用日志应有 `BlockException` 和 `fallback called`。
3. 端到端——模拟用户请求，验证降级时返回的是"降级数据"（默认评分/空列表）而非 500 错误，用户无感。
沉淀：限流/熔断规则接 Apollo 动态调（故障时可调阈值）；规则变更走灰度（先 5% 流量验证不误杀）；混沌演练每月一次（GameDay），验证预案有效性并更新。

## 结构化回答


**30 秒电梯演讲：** 像医院急诊——限流是限号（防挤爆）、降级是非急病转门诊（保核心）、超时是手术限时、重试是换医生再试。

**展开框架：**
1. **限流：单机（** — 单机（令牌桶/漏桶）+集群（Sentinel/网关）
2. **降级：核心优** — 核心优先，非核心兜底/返回默认
3. **超时：连接+** — 连接+读取分层，避免雪崩

**收尾：** 令牌桶和漏桶区别？


## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：限流降级超时重试怎么设计？ | 今天聊「限流降级超时重试怎么设计？」。一句话：限流降级超时重试是高可用四件套——限流防过载、降级保核心、超时防雪崩、重试保成功；内容场景如直播弹幕限流、评价降级。 | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：限流：令牌桶/漏桶+Sentinel | 核心概念 |
| 0:51 | 能力/参数拆解表 | 要点是：降级：核心优先+默认值 | 能力拆解 |
| 1:30 | 流程图：输入→处理→输出 | 要点是：超时：连接+读取分层 | 关键机制 |
| 2:09 | 代码片段 + 注释高亮 | 要点是：重试：幂等+退避+限次 | 实战要点 |
| 3:00 | 总结卡 + 下期预告 | 记住这些核心点就够了。下期我们接着聊——令牌桶和漏桶区别？。 | 收尾 |
