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
