---
id: java-architect-148
difficulty: L2
category: java-architect
subcategory: 稳定性治理
title: 故障注入如何验证超时、重试与熔断
tags: [故障注入, 超时, 重试, 熔断, Resilience4j]
related: [java-architect-147, java-architect-146, java-architect-145]
---

# 故障注入如何验证超时、重试与熔断

> **场景**：京东订单服务调用 10+ 下游（库存、优惠券、支付、风控）。代码里写了 `@Retryable` 和 `CircuitBreaker`，但从未在故障下验证过——真故障来了才发现熔断阈值配错、重试放大流量。面试官问：如何用故障注入验证这些保护机制？

## 一、概念层：超时、重试、熔断三件套

### 1.1 三者的协作关系

```
请求 ──→ 超时（200ms 内必须返回，否则放弃）
            │
            ↓ 超时
         重试（最多 3 次，指数退避）
            │
            ↓ 全部失败
         熔断（失败率 > 50%，打开熔断器，5 分钟内直接拒绝）
            │
            ↓ 熔断打开
         降级（返回兜底数据）
```

### 1.2 常见的"配了等于没配"

| 配置 | 典型错误 | 后果 |
|------|----------|------|
| 超时 | 只配 connectTimeout，没配 readTimeout | 连接上了但读响应卡住，无超时 |
| 重试 | 重试 5 次无退避 | 放大 5 倍流量打爆下游 |
| 熔断 | 失败率阈值 90% | 等于没熔断，下游早死了 |
| 兜底 | fallback 调用另一个下游 | 二级故障，兜底也挂 |

故障注入的目的：**把这些"配了等于没配"的问题提前暴露**。

## 二、机制层：三类故障注入

### 2.1 注入超时（验证超时配置）

**目标**：让下游响应慢，验证客户端是否在配置时间内放弃。

```java
// 服务端：故意 sleep 模拟慢响应
@RestController
public class InventoryController {
    @GetMapping("/inventory/{skuId}")
    public Inventory get(@PathVariable String skuId,
                         @RequestParam(defaultValue = "0") long delayMs) {
        if (delayMs > 0) {
            try { Thread.sleep(delayMs); } 
            catch (InterruptedException ignored) {}
        }
        return inventoryService.get(skuId);
    }
}
```

```java
// 客户端：验证超时是否生效
@Test
void testTimeout() {
    long start = System.currentTimeMillis();
    assertThrows(TimeoutException.class, () -> {
        inventoryClient.get("sku-001", 500);  // 服务端延迟 500ms
    });
    long elapsed = System.currentTimeMillis() - start;
    // 验证：客户端 200ms 后超时放弃（不是等服务端 500ms）
    assertThat(elapsed).isBetween(180L, 300L);
}
```

**Resilience4j 配置**：

```java
@Bean
public TimeLimiter timeLimiter() {
    return TimeLimiter.of("inventory", TimeLimiterConfig.custom()
        .timeoutDuration(Duration.ofMillis(200))   // 200ms 超时
        .cancelRunningFuture(true)                  // 超时后取消
        .build());
}
```

### 2.2 注入失败（验证重试 + 熔断）

```java
// 服务端：按概率返回 500
@RestController
public class PaymentController {
    private final AtomicInteger counter = new AtomicInteger();
    
    @PostMapping("/pay")
    public ResponseEntity<PayResult> pay(@RequestBody PayRequest req,
                                          @RequestParam double failRate) {
        if (Math.random() < failRate) {
            counter.incrementAndGet();
            return ResponseEntity.status(500).body(PayResult.fail("INJECTED"));
        }
        return ResponseEntity.ok(PayResult.ok());
    }
}
```

```java
// 客户端：Resilience4j 重试 + 熔断
@Service
public class PaymentClient {
    @CircuitBreaker(name = "payment", fallbackMethod = "payFallback")
    @Retry(name = "payment")
    public PayResult pay(PayRequest req) {
        return restTemplate.postForObject("/pay", req, PayResult.class);
    }
    
    public PayResult payFallback(PayRequest req, Throwable t) {
        return PayResult.degraded("PAYMENT_UNAVAILABLE");
    }
}

// 配置
circuitbreaker:
  instances:
    payment:
      failure-rate-threshold: 50          # 失败率 50% 触发
      slow-call-rate-threshold: 80
      slow-call-duration-threshold: 500ms
      sliding-window-size: 20             # 滑动窗口 20 次
      minimum-number-of-calls: 10         # 最少 10 次才统计
      wait-duration-in-open-state: 30s    # 熔断 30s
      permitted-number-of-calls-in-half-open-state: 3
retry:
  instances:
    payment:
      max-attempts: 3                      # 最多 3 次（含首次）
      wait-duration: 200ms                 # 固定间隔
      retry-exceptions: [SocketTimeoutException, HttpServerErrorException]
```

### 2.3 验证脚本

```java
@SpringBootTest
class PaymentResilienceTest {
    @Autowired private PaymentClient client;
    @Autowired private CircuitBreakerRegistry cbRegistry;
    
    @Test
    @DisplayName("50% 失败率下，重试后部分成功，超过阈值熔断打开")
    void testRetryAndCircuitBreaker() {
        CircuitBreaker cb = cbRegistry.circuitBreaker("payment");
        
        // 阶段 1：调用 20 次，服务端 50% 失败
        int success = 0, fail = 0;
        for (int i = 0; i < 20; i++) {
            try {
                client.pay(PayRequest.builder().failRate(0.5).build());
                success++;
            } catch (Exception e) { fail++; }
        }
        // 验证：重试后成功率高于 50%（部分被重试救回）
        assertThat(success).isGreaterThan(5);
        
        // 阶段 2：继续调用，熔断应已打开
        CircuitBreaker.State state = cb.getState();
        assertThat(state).isIn(CircuitBreaker.State.OPEN, CircuitBreaker.State.HALF_OPEN);
    }
    
    @Test
    @DisplayName("熔断打开后，请求走 fallback")
    void testFallbackAfterCircuitOpen() {
        // 先触发熔断
        for (int i = 0; i < 15; i++) {
            client.pay(PayRequest.builder().failRate(1.0).build());
        }
        // 验证 fallback
        PayResult result = client.pay(PayRequest.builder().failRate(0).build());
        assertThat(result.getStatus()).isEqualTo("PAYMENT_UNAVAILABLE");
    }
}
```

## 三、实战层：JD 的故障注入平台

### 3.1 集成混沌注入（自动化）

```java
// 集成 Chaos Mesh，自动化注入超时/失败
@SpringBootTest
class ChaosIntegrationTest {
    @Autowired private ChaosMeshClient chaos;
    @Autowired private OrderClient orderClient;
    
    @Test
    @DisplayName("库存服务超时 500ms 时，订单走缓存兜底")
    void testInventoryTimeoutFallback() throws Exception {
        String expId = chaos.injectNetworkDelay(
            "inventory-service", "500ms", Duration.ofMinutes(2));
        try {
            OrderResult result = orderClient.createOrder(testOrder());
            // 验证：500ms 内返回（熔断 + fallback）
            assertThat(result.getElapsed()).isLessThan(1000);
            assertThat(result.getInventory()).isFromCache();
        } finally {
            chaos.rollback(expId);
        }
    }
}
```

### 3.2 重试放大的陷阱（必测）

```java
@Test
@DisplayName("重试 3 次无退避，下游被打 3 倍")
void testRetryAmplification() {
    // 客户端：retry 3 次
    // 服务端：模拟 100% 超时
    AtomicInteger serverHits = new AtomicInteger();
    when(inventoryService.get(any())).thenAnswer(inv -> {
        serverHits.incrementAndGet();
        Thread.sleep(500);  // 超过客户端超时
        return null;
    });
    
    assertThrows(TimeoutException.class, () -> 
        client.getInventory("sku"));
    
    // 1 次请求 → 服务端被打了 3 次（重试放大）
    assertThat(serverHits.get()).isEqualTo(3);
    // 这是问题！应该用退避或熔断提前止损
}
```

**修复方案**：

```yaml
retry:
  instances:
    payment:
      max-attempts: 3
      wait-duration: 200ms
      exponential-backoff-multiplier: 2   # 指数退避
      exponential-max-wait-duration: 2s
      retry-exceptions:
        - SocketTimeoutException
        - HttpServerErrorException
      # 重要：不重试 4xx（业务错误，重试无意义）
      ignore-exceptions:
        - HttpClientErrorException
        - BusinessException
```

### 3.3 超时级联（Timeout Cascade）验证

```
订单服务(总超时 1s) ──→ 库存(200ms) + 优惠券(200ms) + 支付(500ms)
                  并行调用，max(200,200,500) = 500ms，留 500ms 余量
```

```java
@Test
@DisplayName("并行调用三个下游，总耗时不超过 1s")
void testParallelTimeout() {
    long start = System.currentTimeMillis();
    OrderResult result = orderClient.createOrderParallel(testOrder());
    long elapsed = System.currentTimeMillis() - start;
    
    // 验证：即使支付慢，总耗时 < 1s（最慢的下游决定）
    assertThat(elapsed).isLessThan(1000);
}
```

**反模式**：串行调用三个下游，每个 500ms，总耗时 1.5s → 必然超时。改成并行是核心优化。

### 3.4 熔断恢复验证

```java
@Test
@DisplayName("熔断 30s 后进入 half-open，恢复成功则关闭熔断")
void testCircuitRecovery() throws Exception {
    // 触发熔断
    for (int i = 0; i < 15; i++) {
        client.pay(PayRequest.builder().failRate(1.0).build());
    }
    assertThat(cb.getState()).isEqualTo(CircuitBreaker.State.OPEN);
    
    // 等待 30s（熔断 open 时间）
    Thread.sleep(31_000);
    
    // half-open：放 3 个试探请求
    for (int i = 0; i < 3; i++) {
        client.pay(PayRequest.builder().failRate(0).build());  // 全成功
    }
    // 熔断关闭，恢复正常
    assertThat(cb.getState()).isEqualTo(CircuitBreaker.State.CLOSED);
}
```

## 四、底层本质：分布式系统的"不可避免失败"

### 4.1 First Principle：调用下游 = 调用一个"可能失败的资源"

任何下游调用都隐含三个假设：
1. 它可能慢（网络/负载）→ 需要超时
2. 它可能临时挂（重启/抖动）→ 需要重试
3. 它可能持续挂（故障）→ 需要熔断

故障注入的本质：**用受控的方式提前触发这些假设**，验证保护机制是否真的能起作用。

### 4.2 重试是"双刃剑"

```
单请求重试 3 次 → 该请求流量放大 3 倍
高 QPS 下重试 → 下游被打爆（雪崩）
```

所以重试必须有：
- **退避**（避免同步重试打爆）
- **限制总重试次数**（避免重试链）
- **熔断先行**（熔断打开时不再重试）
- **只重试可恢复错误**（不重试业务错误、4xx）

### 4.3 Feynman 解释

把下游调用想象成"打电话给同事"。
- 超时：响了 10 声没人接，挂掉（不能无限等）。
- 重试：挂了再打一次（也许他在洗手间，第二次接了）。但不能疯狂连打（放大流量）。
- 熔断：连续打 5 次都没接，先停 10 分钟不打（也许他休假了，再打也没用）。
- 故障注入：故意让同事"不接电话"，验证你这套流程是否真的会停手。

## 五、AI 架构师加问

**Q1：超时设多少合理？**
看 SLA。订单服务 SLA 1s，最慢下游给 500ms（留 500ms 给自己处理）。计算公式：`总超时 > Σ(下游超时) + 自己处理时间`。

**Q2：重试和熔断冲突吗？**
不冲突，但有优先级：熔断先行。熔断 OPEN 时直接拒绝，不重试。HALF-OPEN 时放试探请求，可重试。

**Q3：Spring Cloud OpenFeign 怎么配超时最稳？**
```yaml
feign:
  client:
    config:
      default:
        connect-timeout: 1000
        read-timeout: 3000
      payment-service:           # 特定服务覆盖默认
        read-timeout: 500
```
关键是 connectTimeout 和 readTimeout 都要配，只配 connectTimeout 等于没超时。

**Q4：服务端怎么配合重试做幂等？**
重试意味着同一请求可能被处理多次。服务端必须幂等：
- 写操作用 `Idempotency-Key` 头（见 130 题）
- 状态机：`PROCESSING → SUCCESS`，重试不会回滚到 PROCESSING
- 唯一索引：`(order_id, action)` 防重复扣减

**Q5：故障注入怎么避免影响真实用户？**
- 测试环境或预发环境做
- 生产做时用流量染色（只对标记为 test 的请求注入故障）
- 流量比例 < 1%

## 六、记忆口诀

```
超时重试熔断降级，四件套保服务不死。
超时设 read+connect 双保险，重试要退避防爆。
熔断 50% 失败开，30 秒后半开试探。
重试只对临时错，业务 4xx 不要重。
故障注入三招：超时慢响应、失败返 500、网络分区断。
JD 流量染色法，生产验证不影响真用户。
```

## 七、苏格拉底追问

| 层级 | 问题 | 关键答案 |
|------|------|----------|
| L1 表象 | 只配 connectTimeout 有什么问题？ | 连接上了但读响应卡住，无超时保护 |
| L2 机制 | 熔断器三个状态？ | CLOSED → OPEN → HALF_OPEN → CLOSED |
| L3 边界 | 重试和熔断冲突吗？ | 不冲突，熔断 OPEN 时不重试 |
| L4 权衡 | 重试次数设多少？ | 一般 2-3 次 + 指数退避，过多放大流量 |
| L5 反例 | 重试 5 次无退避，下游会怎样？ | 流量放大 5 倍，下游被打爆雪崩 |
| L6 极限 | 串行调用 5 个下游各 500ms，总超时 1s？ | 必然超时，改并行（max=500ms） |
| L7 系统 | 全链路超时怎么配？ | 上游超时 > 下游超时，逐级放大留余量 |

**对话还原**：
> 面试官：你们订单调用 10 个下游，超时重试怎么配？
> 我：每个下游单独配。核心下游（库存/支付）read-timeout 500ms，非核心 200ms。重试 3 次 + 指数退避。熔断 50% 失败率触发，30s 后 half-open。
> 面试官：怎么验证这些配置生效？
> 我：故障注入。服务端按概率返回 500 或延迟，客户端验证超时是否在配置内放弃、熔断是否打开、fallback 是否兜底。
> 面试官：重试会放大流量吗？
> 我：会。所以我们要求重试只对 5xx 和超时重试，不重试 4xx；指数退避；熔断打开后不重试。
> 面试官：生产怎么测？
> 我：流量染色。标记为 test 的请求走特殊路由，注入故障不影响真实用户。比例 < 1%。

## 八、常见考点

1. **超时三件套** —— connectTimeout + readTimeout + 总超时
2. **熔断器三状态** —— CLOSED/OPEN/HALF_OPEN
3. **重试的陷阱** —— 流量放大、必须退避、只重试可恢复错误
4. **故障注入三种方式** —— 慢响应、返回错误、网络分区
5. **Resilience4j 配置** —— 业界主流，必会
6. **重试幂等** —— 服务端必须支持重试
7. **级联超时** —— 串行 vs 并行，留余量
8. **流量染色** —— 生产安全验证

## 结构化回答

**30 秒电梯演讲：** 京东订单服务调用 10+ 下游（库存、优惠券、支付、风控）。代码里写了 `@Retryable` 和 `CircuitBreaker`，但从未在故障下验证过——真故障来了才发现熔断阈值配错、重试放大流量

**展开框架：**
1. **超时三件套** — 超时三件套 —— connectTimeout + readTimeout + 总超时
2. **熔断器三状态** — 熔断器三状态 —— CLOSED/OPEN/HALF_OPEN
3. **重试的陷阱** — 重试的陷阱 —— 流量放大、必须退避、只重试可恢复错误

**收尾：** 以上是我的整体思路。您想继续深入聊——只配 connectTimeout 有什么问题？


## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：故障注入如何验证超时、重试与熔断 | "这题一句话：京东订单服务调用 10+ 下游（库存、优惠券、支付、风控）。" | 开场钩子 |
| 0:15 | 超时三件套示意/对比图 | "超时三件套 —— connectTimeout + readTimeout + 总超时" | 超时三件套要点 |
| 0:40 | 熔断器三状态示意/对比图 | "熔断器三状态 —— CLOSED/OPEN/HALF_OPEN" | 熔断器三状态要点 |
| 1:25 | 总结卡 | "记住：超时三件套。下期见。" | 收尾 |
