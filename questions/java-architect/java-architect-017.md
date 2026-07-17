---
id: java-architect-017
difficulty: L2
category: java-architect
subcategory: 微服务
tags:
- RPC
- 超时
- 幂等
feynman:
  essence: 超时、重试、幂等是分布式调用的"稳定性三件套"——超时防止无限等待拖垮调用方，重试容忍瞬时故障提升成功率，幂等保证重试不产生副作用。三者配合的数学本质是：超时切断长尾、重试把 P99 请求重映射到成功分布、幂等把"重复执行"等价于"一次执行"。
  analogy: 像打电话给客服。超时是"响铃 30 秒没人接就挂断"（不无限等待占线）；重试是"占线就再打一次"（容忍瞬时繁忙）；幂等是"同一问题打两次客服，结果一样"（重复下单不会扣两次款）。三者缺一——只超时不重试（瞬时故障也失败）、只重试不超时（无限等待拖死）、重试不幂等（重复扣款）。
  first_principle: 为什么超时/重试/幂等必须配套？因为分布式调用的失败模式是"不确定失败"——请求发出去了，但响应没回来（网络丢包、服务端 crash 后才处理、响应在途中丢失）。调用方不知道服务端到底执行了没有，唯一安全的重试前提是"操作幂等"（重复执行等价于一次执行）。
  key_points:
  - 超时分层设置：连接超时（短）、读超时（按 P99）、全局超时（兜底），按调用链路递增
  - 重试策略：固定间隔、指数退避（Exponential Backoff）、抖动（Jitter），避免惊群
  - 幂等设计：唯一请求 ID + 去重表 / 乐观锁版本号 / 状态机 / Token 令牌
  - 重试要区分可重试错误（网络超时、5xx）和不可重试错误（4xx 参数错误、业务拒绝）
  - 重试风暴防御：限制重试次数、熔断器、hedge 请求（备选请求）替代盲目重试
first_principle:
  problem: 在网络不可靠、服务可能瞬时故障的环境下，如何让调用方既不无限等待，又能容忍瞬时故障，且重复调用不产生副作用？
  axioms:
  - 网络是不可靠的（丢包、延迟、分区）
  - 服务端可能 crash（请求处理到一半挂了）
  - 调用方不知道失败时服务端是否已执行（不确定失败）
  rebuild: 超时切断长尾等待（读超时按 P99 + 余量设），重试容忍瞬时故障（指数退避 + Jitter 防惊群，限 2-3 次），幂等保证重试安全（唯一请求 ID + 去重，或状态机）。三者配套：超时触发重试，重试依赖幂等。重试只针对可重试错误（网络超时、5xx），不可重试错误（4xx）直接返回。重试要有熔断保护（连续失败触发熔断不重试），防止重试放大流量打爆下游（重试风暴）。
follow_up:
  - 超时时间设多少合适？——按 P99 + 余量。压测拿到接口 P99（如 200ms），读超时设 3-5 倍（600ms-1s）。连接超时短（100-500ms，连不上大概率服务不可用）。链路超时要递增（网关 2s > 订单 1s > 库存 500ms），避免上游超时下游还在跑
  - 指数退避为什么要加 Jitter？——多个调用方同时重试会形成同步风暴（thundering herd）。加随机抖动（Jitter）让重试时间分散，避免同步。如退避时间 = base * 2^n + random(0, base)
  - 幂等键怎么生成？——自然幂等（查询、删除，重复执行结果不变）；业务幂等键（订单号、支付流水号，业务生成）；客户端生成唯一 ID（UUID，防重复提交）。幂等键 + 去重表（或 Redis SET NX）保证只执行一次
  - 重试和熔断什么关系？——重试是"容忍瞬时故障"，熔断是"保护故障持续时不再打"。连续失败触发熔断（如 5 秒失败率 > 50%），熔断期间直接快速失败不重试，等下游恢复后半开试探。重试是短期容错，熔断是长期保护
  - hedge 请求是什么？——对冲请求：发请求后等一个阈值（如 P99）还没返回，立刻发第二个请求到另一个实例，谁先返回用谁。比盲目重试更高效（不浪费已发出的请求），但消耗 2 倍资源，适合尾延迟敏感场景（Google SRE 推荐）
memory_points:
  - 超时三层：连接超时（短）、读超时（P99×3-5）、全局超时（兜底）
  - 重试策略：指数退避 + Jitter，限 2-3 次，只重试可重试错误（超时/5xx）
  - 幂等四方案：唯一 ID + 去重表、乐观锁版本号、状态机、Token 令牌
  - 链路超时递增：网关 > 订单 > 库存，避免上游超时下游还在跑
  - 重试风暴防御：熔断器 + 重试预算（retry budget）+ hedge 请求
---

# 【Java 后端架构师】服务间调用的超时、重试与幂等控制

> 适用场景：JD 核心技术。下单链路调 5 个下游服务（商品、库存、优惠券、风控、支付），任一超时拖垮全链路。重试不加幂等就是重复扣款。架构师必须能设计分层超时、退避重试、幂等去重——这是"调用链路在故障下还能稳定"的根基。

## 一、概念层：稳定性三件套的定位

**超时、重试、幂等的职责分工**：

| 机制 | 解决的问题 | 设置原则 | JD 场景 |
|------|-----------|---------|---------|
| **超时（Timeout）** | 防止无限等待 | 读超时 = P99 × 3-5 | 支付调用超过 3s 视为失败 |
| **重试（Retry）** | 容忍瞬时故障 | 指数退避 + Jitter，2-3 次 | 库存超时重试 1 次 |
| **幂等（Idempotency）** | 保证重复执行安全 | 唯一键 + 去重表 | 支付回调重复不重复扣款 |
| **熔断（Circuit Break）** | 保护持续故障 | 失败率 > 50% 触发 | 支付服务挂了直接快速失败 |
| **降级（Fallback）** | 故障时返回兜底 | 读服务可降级默认值 | 商品查询失败返回缓存 |

**关键认知**：超时/重试/幂等必须**配套**。只超时不重试 → 瞬时故障也失败；重试不幂等 → 重复扣款/超卖；重试不熔断 → 重试风暴打爆下游。

**不确定失败的本质**（面试核心）：

```
调用方发出请求 ─────► 服务端处理 ─────► 响应返回
       │                                      │
       │            可能发生的失败：
       │            1. 请求丢失（服务端没收到）
       │            2. 服务端 crash（处理到一半）
       │            3. 响应丢失（服务端处理完但响应没到）
       │
       └── 调用方看到的都是"超时"，但服务端状态可能是：
              a. 没执行（请求丢失）→ 安全重试
              b. 执行了一半（crash）→ 危险，需幂等
              c. 执行完了（响应丢失）→ 危险，需幂等

  结论：重试安全的前提是幂等，幂等是重试的许可证
```

## 二、机制层：超时分层设计

**调用链路超时分层**（画图必考）：

```
用户请求 (5s)
    │
    ▼
网关 (4s) ──────────────────────────────────────────
    │
    ├──► 订单服务 (3s) ─────────────────────────────
    │       │
    │       ├──► 商品服务 (500ms) ─────────────────
    │       ├──► 库存服务 (800ms) ─────────────────
    │       └──► 优惠券服务 (1s) ──────────────────
    │
    └──► 风控服务 (1.5s) ──────────────────────────
```

**超时设置原则**：

1. **链路超时递增**：上游超时 > 下游所有调用超时之和 + 余量。否则上游超时了下游还在跑（浪费资源）。如用户 5s > 网关 4s > 订单 3s > 库存 800ms。
2. **读超时按 P99**：压测拿接口 P99（如 200ms），读超时设 3-5 倍（600ms-1s）。设太短误杀正常请求，设太长拖垮调用方。
3. **连接超时要短**：100-500ms，连不上大概率服务不可用，快速失败触发熔断。
4. **全局超时兜底**：整个请求设一个上限（如 10s），防止读超时叠加。

**Feign/OpenFeign 超时配置**：

```yaml
feign:
  client:
    config:
      default:
        connect-timeout: 1000          # 连接超时 1s
        read-timeout: 3000             # 读超时 3s
      payment-service:                 # 针对特定服务覆盖
        connect-timeout: 500
        read-timeout: 5000             # 支付链路慢，单独放宽
```

## 三、机制层：重试策略

**重试算法对比**：

| 箖法 | 间隔公式 | 优点 | 缺点 |
|------|---------|------|------|
| **固定间隔** | 固定 N ms | 简单 | 惊群效应（同步重试） |
| **指数退避** | base × 2^n | 渐进，给恢复时间 | 仍可能同步（多调用方同时算出相同间隔） |
| **指数退避 + 抖动** | base × 2^n + random(0, base) | 分散重试，防惊群 | 略复杂（推荐） |
| **装饰抖动** | random(base, base × 3^n) | 最大分散 | 实现稍复杂 |

**指数退避 + Jitter 代码**：

```java
public class ExponentialBackoffRetry {
    private final int maxAttempts;       // 最大重试次数（含首次）
    private final long baseInterval;     // 基础间隔 ms
    private final long maxInterval;      // 最大间隔 ms

    public <T> T execute(Callable<T> task) throws Exception {
        Exception lastException = null;
        for (int attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                return task.call();
            } catch (RetryableException e) {
                lastException = e;
                if (attempt == maxAttempts) break;
                long backoff = calculateBackoff(attempt);
                Thread.sleep(backoff);
            }
        }
        throw lastException;
    }

    private long calculateBackoff(int attempt) {
        // 指数退避 + 全抖动（Full Jitter）
        long exponential = (long) (baseInterval * Math.pow(2, attempt - 1));
        long capped = Math.min(exponential, maxInterval);
        // Full Jitter: 在 [0, capped] 之间随机
        return ThreadLocalRandom.current().nextLong(0, capped + 1);
    }
}
```

**可重试错误判断**：

```java
public boolean isRetryable(Exception e) {
    // 1. 网络超时/连接失败 → 可重试
    if (e instanceof SocketTimeoutException) return true;
    if (e instanceof ConnectException) return true;
    // 2. 5xx 服务端错误 → 可重试（服务端临时故障）
    if (e instanceof HttpServerErrorException) return true;
    // 3. 4xx 客户端错误 → 不可重试（参数错误，重试也错）
    if (e instanceof HttpClientErrorException) return false;
    // 4. 业务异常 → 看具体类型
    if (e instanceof BusinessException) {
        return ((BusinessException) e).isRetryable();   // 业务自己声明
    }
    return false;
}
```

**重试风暴防御**（生产必做）：

```java
// 1. 重试预算（Retry Budget）：限制重试流量占比
// 如总流量 1000 QPS，重试预算 10%，最多 100 QPS 重试
// 超过预算的重试请求直接快速失败（不再重试）

// 2. 熔断器配合：连续失败触发熔断，熔断期间不重试
@CircuitBreaker(failureRateThreshold = 0.5, waitDurationInOpenState = 5s)
@Retry(maxAttempts = 3)
public Result callPayment() { ... }

// 3. Hedge 请求（对冲请求）：P99 还没返回就发第二个，不盲目重试
public <T> CompletableFuture<T> callWithHedge(Supplier<CompletableFuture<T>> call) {
    CompletableFuture<T> primary = call.get();
    // P99 时间后还没完成，发第二个请求
    primary.orTimeout(p99, MILLISECONDS)
           .exceptionallyCompose(ex -> {
               if (ex instanceof TimeoutException) {
                   return call.get();   // 发 hedge 请求
               }
               return CompletableFuture.failedFuture(ex);
           });
}
```

## 四、实战层：幂等设计四大方案

**幂等的核心思路**：让"重复执行"等价于"一次执行"。根据业务特性选择方案。

**方案 1：唯一请求 ID + 去重表（最通用）**

```java
@Service
public class PaymentService {
    @Transactional
    public PaymentResult pay(PayRequest request) {
        String requestId = request.getRequestId();   // 客户端生成唯一 ID

        // 1. 查去重表，已处理直接返回上次结果
        IdempotentRecord existing = idempotentRepo.findByRequestId(requestId);
        if (existing != null) {
            return existing.getResult();   // 重复请求返回上次结果（不是错误）
        }

        // 2. 处理业务（同一事务）
        PaymentResult result = doPay(request);

        // 3. 记录去重表（同一事务，保证原子）
        idempotentRepo.save(new IdempotentRecord(requestId, result));

        return result;
    }
}
```

**去重表设计**：

```sql
CREATE TABLE idempotent_record (
    request_id VARCHAR(64) PRIMARY KEY,    -- 唯一请求 ID（客户端生成）
    business_type VARCHAR(32),             -- 业务类型（支付/下单/退款）
    result JSON,                           -- 处理结果（重复请求返回）
    created_at TIMESTAMP,
    UNIQUE KEY uk_request (request_id)     -- 唯一约束兜底
);
-- 利用唯一约束：并发重复插入会失败（防并发）
```

**方案 2：乐观锁版本号（适合更新操作）**

```java
@Transactional
public boolean updateStock(Long skuId, int delta, int version) {
    // UPDATE inventory SET stock = stock + ?, version = version + 1
    //       WHERE sku_id = ? AND version = ?
    int affected = inventoryMapper.updateStock(skuId, delta, version);
    return affected > 0;   // 版本不匹配返回 0，重复更新失败
}
```

**方案 3：状态机（适合有状态流转的操作）**

```java
@Transactional
public void confirmOrder(Long orderId) {
    Order order = orderRepo.findById(orderId);
    // 只有 PENDING_PAYMENT 状态能确认，已确认的重复请求会被状态机挡住
    if (order.getStatus() != OrderStatus.PENDING_PAYMENT) {
        return;   // 幂等：重复确认不报错也不重复执行
    }
    order.confirm();   // 状态流转 PENDING_PAYMENT → CONFIRMED
    orderRepo.save(order);
}
```

**方案 4：Token 令牌（适合表单提交防重复）**

```java
// 1. 表单页加载时，后端发一个 token 给前端
@GetMapping("/order/form")
public String form() {
    String token = UUID.randomUUID().toString();
    redisTemplate.opsForValue().set("order:token:" + token, "1", 10, MINUTES);
    return token;
}

// 2. 提交时带 token，后端原子删除（Redis Lua 保证原子）
@PostMapping("/order/submit")
public Result submit(@RequestHeader("X-Token") String token, @RequestBody OrderDTO dto) {
    // SETNX + DEL 原子操作（Lua）
    String lua = "if redis.call('get', KEYS[1]) == ARGV[1] then "
               + "  return redis.call('del', KEYS[1]) "
               + "else return 0 end";
    Long deleted = redisTemplate.execute(new DefaultRedisScript<>(lua, Long.class),
        Collections.singletonList("order:token:" + token), "1");
    if (deleted == 0) {
        return Result.fail("重复提交");   // token 不存在说明已提交过
    }
    return orderService.create(dto);
}
```

**支付回调幂等案例**（真实生产高频场景）：

```java
// 第三方支付异步回调可能重复发送，必须幂等
@Service
public class PaymentCallbackService {
    @Transactional
    public void handleCallback(PaymentCallback callback) {
        String callbackId = callback.getTradeNo();   // 第三方流水号

        // 1. 查是否已处理
        Payment payment = paymentRepo.findByTradeNo(callbackId);
        if (payment == null) {
            // 首次收到，处理（可能是乱序回调，先创建记录）
            payment = createPayment(callback);
        }

        // 2. 状态机校验（已成功的回调直接忽略）
        if (payment.getStatus() == PaymentStatus.SUCCESS) {
            log.info("重复回调，忽略: {}", callbackId);
            return;   // 幂等返回
        }

        // 3. 状态流转 + 业务处理（同一事务）
        if (callback.isSuccess()) {
            payment.markSuccess();
            orderService.confirmOrder(payment.getOrderId());   // 触发订单确认
        } else {
            payment.markFailed();
            orderService.cancelOrder(payment.getOrderId());
        }
        paymentRepo.save(payment);
    }
}
```

## 五、底层本质：不确定失败与 CAP 的工程化

回到第一性：**分布式调用的根本困难是"不确定失败"——调用方不知道服务端到底执行了没有**。

- **超时的本质**：用时间换确定性。超过阈值未响应就视为失败（无论服务端是否真的失败）。代价是可能误杀（服务端处理完了但响应慢），所以超时后服务端可能还在跑——必须幂等才能安全重试。
- **重试的本质**：把 P99 长尾请求重映射到成功分布。单次请求成功率 99%（P99 失败），重试 1 次成功率 99.99%（失败概率 1% × 1%）。但重试放大流量（N 次重试 = N+1 倍流量），所以要有重试预算和熔断保护。
- **幂等的本质**：让"f(x) 执行多次"等价于"f(x) 执行一次"。数学上 f(f(x)) = f(x)。通过去重（记录已执行）、乐观锁（版本号防覆盖）、状态机（状态流转防重复）实现。
- **三者配套的数学基础**：超时切断了"可能失败"的请求，重试把切断的请求重投，幂等保证重投安全。三者形成"失败检测→容忍→安全重投"的闭环。

**CAP 与幂等的关系**：分区容忍（P）必然存在，调用方在分区时不知道服务端状态，只能假设"可能执行了也可能没"。幂等让调用方无需关心服务端状态——重复调用结果一致，这就是 BASE 理论中"最终一致"的工程实现基础。

## 六、AI 架构师加问：5 个 AI 相关问题

1. **AI 推理服务调用怎么设超时和重试？**
   推理服务延迟差异大（秒级到分钟级，取决于 prompt 长度），超时要按场景设：实时对话 P99 × 3，批处理放宽。重试要区分错误——限流（429）可重试（指数退避），上下文超长（400）不可重试。流式输出（SSE）用读超时而非请求超时（流持续发不能整体超时）。

2. **让 AI 自动调超时阈值，怎么设计？**
   AI 监控接口 P99/P999 变化 → 通过配置中心动态调整 read-timeout（P99 涨了就放宽，但不能超过链路上游超时）。AI 还要监控超时率（timeout_rate），超 1% 说明阈值太紧。变更走灰度，监控调整后的成功率变化。

3. **AI Agent 调用多个工具，幂等怎么保证？**
   Agent 每次工具调用带唯一 request_id（Agent 生成），工具服务用去重表保证幂等。Agent 重试时复用同一 request_id。Agent 编排的状态机本身要幂等——重启后从 checkpoint 恢复，已完成的步骤不重复执行。

4. **怎么用 AI 检测代码中缺幂等的接口？**
   AI 静态分析代码，识别"写操作（POST/PUT/DELETE）但无幂等键"的接口；识别"调用了下游服务但无超时设置"的 RPC；识别"重试但未声明幂等"的调用链。输出风险点清单 + 修复建议（加幂等键、加超时、加重试策略）。

5. **AI 推理结果落库怎么避免重复扣费？**
   推理请求带 request_id，计费服务用去重表保证同一 request_id 只计费一次。推理服务 crash 后客户端重试（同 request_id），计费服务查去重表返回上次结果（不重复计费）。结合乐观锁更新用户余额（version 号防并发覆盖）。

## 七、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"超时三层、指数退避+Jitter、幂等四方案、链路超时递增、重试熔断配套"**。

- **超时**：连接短、读按 P99×3-5、全局兜底；链路递增（网关 > 订单 > 库存）
- **重试**：指数退避 + Full Jitter，限 2-3 次，只重试超时/5xx
- **幂等四方案**：唯一 ID + 去重表、乐观锁版本号、状态机、Token 令牌
- **重试风暴防御**：重试预算 + 熔断器 + Hedge 请求
- **核心认知**：不确定失败 → 重试安全的前提是幂等

### 拟人化理解

把分布式调用想成**打电话给客服**。超时是"响铃 30 秒没人接就挂断"（不无限占线等）；重试是"占线就再打一次"（容忍瞬时繁忙）；幂等是"同一问题打两次客服，结果一样"（重复下单不会扣两次款）。指数退避是"第一次占线等 1 秒再打，第二次等 2 秒，第三次等 4 秒"（给客服恢复时间）；Jitter 是"别在整点重拨（大家都整点重拨会同步占线），随机错开几秒"。熔断是"连续 10 次打不通就别打了，半小时后再试"（保护自己不浪费时间）。Hedge 是"同时打两个客服电话，谁先接用谁"（比盲目重拨快）。

### 面试现场 60 秒回答

> 超时、重试、幂等是稳定性三件套，必须配套。超时三层：连接超时短（100-500ms）、读超时按 P99×3-5、全局超时兜底；链路超时要递增（网关 4s > 订单 3s > 库存 800ms），避免上游超时下游还在跑。重试用指数退避 + Full Jitter（base×2^n + 随机），限 2-3 次，只重试可重试错误（超时/5xx），4xx 不重试。重试要配熔断器（连续失败触发熔断不重试）和重试预算（限制重试流量占比）。幂等四大方案：唯一请求 ID + 去重表（最通用）、乐观锁版本号（更新操作）、状态机（状态流转操作）、Token 令牌（表单防重复）。核心认知是"不确定失败"——超时后服务端可能已执行，所以重试安全的前提是幂等。支付回调这类高频重复场景必须幂等，状态机校验已成功的直接忽略。

### 反问面试官

> 贵司服务间调用是 RPC（Dubbo/gRPC）还是 HTTP（Feign）？有没有统一的超时/重试治理（如 Service Mesh 层统一配置）？有没有遇到过重试风暴（某个服务挂了，重试放大打爆整个链路）？如果有，我会聊重试预算和熔断配置。

## 八、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不直接重试，要设超时？ | 用资源说话：不设超时则调用方线程无限阻塞，连接池/线程池被耗尽，一个慢下游拖垮全站（雪崩）。超时是"用时间换资源释放"——宁可失败也要释放线程给其他请求 |
| 证据追问 | 超时阈值设得对不对，你怎么证明？ | 看 timeout_rate（应 < 1%）；看 P99/P999（超时应略大于 P99）；看慢调用日志（连续超时的下游）；压测不同阈值下的成功率和 RT。Arthas trace 看真实调用耗时分布 |
| 边界追问 | 重试能解决所有故障吗？ | 不能。解决不了持续故障（要靠熔断）、解决不了容量不足（重试放大流量更糟）、解决不了业务错误（4xx 重试也错）、解决不了非幂等操作（重试产生副作用）。重试只解决瞬时抖动 |
| 反例追问 | 什么场景不该重试？ | 非幂等操作（无去重保护的扣款）、容量不足（重试放大打爆下游）、非可重试错误（4xx 参数错误）、长链路末端（重试放大上游等待）。读操作可自由重试，写操作必须幂等后才能重试 |
| 风险追问 | 重试上线后最大风险？ | 主动点出：重试风暴（下游故障时重试放大流量打爆）、重试不幂等（重复扣款/超卖）、重试超时叠加（重试次数×单次超时 > 上游超时）、重试同步惊群（多调用方同时重试）。要有重试预算 + 熔断 + Jitter + 幂等配套 |
| 验证追问 | 怎么证明幂等真的生效？ | 集成测试模拟重复请求（同一 request_id 发 N 次，断言只执行一次）；压测模拟网络抖动（注入延迟，看重试后数据一致）；线上对账（订单数 vs 支付数 vs 扣款数应一致）；混沌工程（kill 服务端模拟 crash，验证重试不产生脏数据） |
| 沉淀追问 | 团队调用治理规范，沉淀什么？ | 超时配置 SOP（按服务分级默认值）、重试策略规范（必加 Jitter、限次数、配熔断）、幂等规范（写操作必须幂等、幂等键生成规则）、重试监控大盘（重试率、重试成功率、重试风暴告警） |

### 现场对话示例

**面试官**：你说读超时按 P99 × 3-5，为什么是 3-5 倍不是 2 倍或 10 倍？

**候选人**：这是工程经验值。2 倍太紧——P99 是 99 分位，2 倍可能只能覆盖到 99.5 分位，正常的慢请求（如 GC 停顿、大数据量查询）会被误杀。10 倍太松——超时设太长，慢请求拖住线程，连接池/线程池被耗尽，一个慢下游拖垮全站。3-5 倍能覆盖 99.9-99.99 分位，既容忍正常的长尾，又能在真正故障时及时切断。但具体倍数要看业务——交易链路（对延迟敏感）用 3 倍，批处理（对延迟不敏感）可以用 5-10 倍。还要看链路总超时——下游所有调用超时之和不能超过上游超时，否则下游还在跑上游已经超时返回了。

**面试官**：重试为什么不能直接固定间隔，要指数退避 + Jitter？

**候选人**：固定间隔有两个问题。第一，惊群效应（thundering herd）——假设 100 个调用方同时超时，固定间隔会在同一时刻一起重试，瞬间打爆下游（本想容错反而放大故障）。第二，固定间隔没给下游恢复时间——下游故障可能需要几秒恢复，固定 500ms 重试 3 次都在故障期内失败。指数退避解决第二个问题（间隔递增 1s→2s→4s，给下游恢复时间），Jitter 解决第一个（每个调用方加随机抖动，重试时刻分散）。Google SRE 推荐用 Full Jitter（在 [0, 指数间隔] 之间完全随机），比 Decorrelated Jitter 实现简单且效果好。

**面试官**：支付回调重复了怎么保证不重复扣款？

**候选人**：支付回调是典型的高频重复场景（第三方支付可能因为网络重试发多次同一回调）。幂等设计两道防线。第一道，用第三方的交易流水号（tradeNo）作为幂等键，查 payment 表是否已处理。第二道，状态机校验——已成功的 payment 直接忽略回调（重复回调是正常行为不是错误）。两道防线都在同一事务内（查 + 处理 + 更新状态），避免并发回调同时进来导致重复处理。如果并发极高（同 tradeNo 的回调几乎同时到达），还可以用 Redis 分布式锁或数据库乐观锁兜底（SELECT FOR UPDATE 或 version 号）。关键认知是：幂等不是"防止重复"（无法防止，网络会重发），而是"重复了也能正确处理"。

## 常见考点

1. **连接超时和读超时区别？**——连接超时是 TCP 三次握手的时间（建立连接），读超时是连接建立后等待数据的时间。连接超时要短（服务不可用快速失败），读超时按业务 P99 设。连接超时触发说明服务端连不上（宕机/网络不通），读超时触发说明服务端处理慢（GC/慢查询/超载）。
2. **Feign 和 Dubbo 的重试有什么不同？**——Feign 默认不重试（Retryer.NEVER_RETRY），需显式配置；Dubbo 默认重试 2 次（共 3 次调用），但只对失败请求重试（Failover Cluster）。Dubbo 还支持 Failfast（不重试）、Failsafe（忽略异常）、Failback（异步重试）等集群容错策略。
3. **幂等键用什么生成？**——自然幂等（查询/删除不需要键）；业务幂等键（订单号、支付流水号，业务生成）；客户端生成 UUID（防重复提交，如前端表单）；雪花算法 ID（分布式唯一）。幂等键要全局唯一且可追溯（能从键反查到原始请求）。
4. **重试预算（Retry Budget）怎么实现？**——用令牌桶或滑动窗口统计重试流量占比。如总流量 1000 QPS，重试预算 10%，最多允许 100 QPS 重试。超过预算的重试请求直接快速失败（不再重试）。目的是防止下游故障时重试放大流量形成雪崩。Google SRE 推荐重试预算 10-20%。


## 结构化回答

**30 秒电梯演讲：** 聊到服务间调用的超时、重试与幂等控制，我的理解是——超时、重试、幂等是分布式调用的"稳定性三件套"——超时防止无限等待拖垮调用方，重试容忍瞬时故障提升成功率，幂等保证重试不产生副作用。三者配合的数学本质是：超时切断长尾、重试把 P99 请求重映射到成功分布、幂等把"重复执行"等价于"一次执行"。打个比方，像打电话给客服。超时是"响铃 30 秒没人接就挂断"（不无限等待占线）；重试是"占线就再打一次"（容忍瞬时繁忙）；幂等是"同一问题打两次客服，结果一样"（重复下单不会扣两次款）。三者缺一——只超时不重试（瞬时故障也失败）、只重试不超时（无限等待拖死）、重试不幂等（重复扣款）。

**展开框架：**
1. **超时分层设置** — 连接超时（短）、读超时（按 P99）、全局超时（兜底），按调用链路递增
2. **重试策略** — 固定间隔、指数退避（Exponential Backoff）、抖动（Jitter），避免惊群
3. **幂等设计** — 唯一请求 ID + 去重表 / 乐观锁版本号 / 状态机 / Token 令牌

**收尾：** 这块我在项目里也踩过坑——想深入的话，可以接着聊：超时时间设多少合适？您更想看哪个方向？

## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡 | "服务间调用的超时、重试与幂等控制——这道题面试官到底想考什么？我用 30 秒给你讲透。" | 开场钩子 |
| 0:15 | 微服务架构图 | 先说核心：超时、重试、幂等是分布式调用的"稳定性三件套"——超时防止无限等待拖垮调用方，重试容忍瞬时故障提升成功率，幂等保证重试不产生副作用。三者配合的数学本质是：超时切断长尾、重试把 。 | 核心定义 |
| 0:30 | RPC 调用流程图 | 固定间隔、指数退避（Exponential Backoff）、抖动（Jitter），避免惊群。 | 重试策略 |
| 1:30 | 总结卡 | 一句话记忆：超时三层：连接超时（短）、读超时（P99×3-5）、全局超时（兜底）。 下期可以接着聊：超时时间设多少合适。 | 收尾总结 |
