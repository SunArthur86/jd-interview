---
id: pdd-trade-027
difficulty: L3
category: pdd-trade
subcategory: 限流
tags:
- 拼多多
- 交易
- 限流
- 降级
- 超时
- 重试
feynman:
  essence: 限流（保护不被打死）+ 降级（保核心弃边缘）+ 超时（不等死）+ 重试（临时故障重试）是稳定性四板斧，本质是"用可控失败换整体存活"。
  analogy: 像医院急诊——限流（限号防挤爆）、降级（重症优先，停普通门诊）、超时（抢救不等人）、重试（监护仪掉线重新测）。
  first_principle: 资源有限，突发流量超过容量，必须有取舍机制保整体存活。
  key_points:
  - 限流：令牌桶/漏桶/Sentinel
  - 降级：核心保交易，非核心（评论/推荐）可关
  - 超时：连接/读/全链路分级超时
  - 重试：指数退避+幂等+有限次
first_principle:
  problem: 流量超过系统容量，如何保整体不崩？
  axioms:
  - 资源有限
  - 核心业务优先（交易 > 评论）
  - 故障会传染（级联）
  rebuild: 限流（入口闸）+ 降级（非核心弃）+ 超时（不等死）+ 重试（临时故障）。
follow_up:
  - 令牌桶和漏桶区别？——令牌桶允许突发（攒令牌），漏桶匀速
  - 重试为什么必须幂等？——否则重复扣款/下单
  - 超时怎么配层级？——下游超时 < 上游超时（DB<服务<网关）
memory_points:
  - 限流：令牌桶/漏桶/Sentinel
  - 降级：核心保交易，非核心弃
  - 超时：分级（DB<服务<网关）
  - 重试：指数退避+幂等+有限次
---

# 【拼多多交易】稳定性四板斧：限流/降级/超时/重试？

> JD 依据："高并发/高可用"。

## 一、限流

**令牌桶**（允许突发）：
```java
RateLimiter limiter = RateLimiter.create(1000);  // 每秒 1000 令牌
if (!limiter.tryAcquire()) {
    throw new RateLimitException();  // 拒绝
}
```

**Sentinel 多维限流**：
```java
@SentinelResource(value = "createOrder",
    blockHandler = "blockHandler",    // 限流降级
    fallback = "fallback")            // 异常降级
public CreateOrderResp createOrder(CreateOrderReq req) { ... }
```

限流维度：
- 单 UID（防刷）
- 全局 QPS（保总容量）
- 接口维度（核心接口单独配额）

## 二、降级

```
大促优先级：
  P0 核心：下单/支付/创单（绝不降级）
  P1 重要：查询/物流（限流保容量）
  P2 边缘：评论/推荐/历史（直接降级返回兜底）
```

```java
public List<Comment> getComments(Long pid) {
    if (switchManager.isDowngrade("comment-service")) {
        return Collections.emptyList();  // 降级：返回空
    }
    return commentService.list(pid);
}
```

## 三、超时（分级）

```
DB 查询：100ms
RPC 调用：200ms
HTTP 网关：3s
全链路：5s（用户可接受）
```

```yaml
feign:
  client:
    config:
      default:
        connect-timeout: 1000
        read-timeout: 2000
ribbon:
  ReadTimeout: 2000
```

**Hystrix 熔断**（失败率/RT 触发）：
```java
@HystrixCommand(commandProperties = {
    @HystrixProperty(name = "circuitBreaker.requestVolumeThreshold", value = "20"),
    @HystrixProperty(name = "circuitBreaker.errorThresholdPercentage", value = "50"),
    @HystrixProperty(name = "execution.isolation.thread.timeoutInMilliseconds", value = "500")
}, fallbackMethod = "fallback")
```

## 四、重试

**指数退避+幂等**：
```java
@Retryable(value = {SQLException.class, SocketTimeoutException.class},
    maxAttempts = 3,
    backoff = @Backoff(delay = 100, multiplier = 2))
public Order pay(Long orderId) {
    // 必须幂等：带 requestId
    return payService.pay(orderId, requestId);
}
```

注意：
- 只对**临时故障**（网络抖动）重试
- 必须**幂等**（防重复扣款）
- **有限次**（3 次以内）+ 指数退避（避免重试风暴）

## 五、拼多多实战

- **大促预热**：限流配额提前调（核心接口 10 倍）
- **熔断兜底**：支付通道失败率 > 50% 熔断切通道
- **预案演练**：每月演练降级/限流，验证兜底有效

## 六、底层本质

四板斧本质是**"用可控的局部失败换整体存活"**——限流挡外部、降级舍内部、超时不等死、重试抗抖动，组合起来构成故障容错网。

## 常见考点
1. **Sentinel 和 Hystrix 区别**？——Sentinel 流量维度（QPS/并发），Hystrix 故障维度（失败率/超时）。
2. **重试风暴怎么防**？——指数退避+随机抖动+有限次+断路器。
3. **降级和熔断区别**？——降级是主动放弃（配置），熔断是被动保护（失败率触发）。
