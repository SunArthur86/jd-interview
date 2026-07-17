---
id: java-architect-039
difficulty: L3
category: java-architect
subcategory: 限流
tags:
- Java 架构师
- 限流
- 令牌桶
- 保护
feynman:
  essence: 限流的四种算法（计数器、滑动窗口、漏桶、令牌桶）解决"如何在超量流量时保护系统"。令牌桶（Token Bucket）是工业首选——匀速产令牌、桶可攒余量，既能限平均速率又能容忍突发。多级限流是架构师视角——网关限粗粒度（用户/租户）、服务限细粒度（接口）、下游限资源（DB 连接），层层兜底。
  analogy: 像 JD 水库防洪：计数器是"每分钟开闸 N 次"（边界突冲）、滑动窗口是"细分到秒的滑动统计"、漏桶是"匀速放水"（严格无突发）、令牌桶是"匀速产水票，攒够才能取水"（允许突发）。水库要在入水口（网关）、闸门（服务）、支流（下游）多级防洪，单点拦不住。
  first_principle: 系统处理能力有物理上限，超量流量必须拒绝或排队。限流算法的核心是"如何计数 + 如何决策"——固定窗口简单但有边界突冲、滑动窗口平滑、漏桶严格匀速、令牌桶允许突发。生产选令牌桶（兼顾平滑和突发）。
  key_points:
  - 四种算法：计数器（固定窗口）、滑动窗口、漏桶（匀速）、令牌桶（匀速产+可攒）
  - 令牌桶参数：容量（允许突发上限）、速率（平均 QPS）
  - 单机限流 vs 集群限流：单机用 Sentinel/Resilience4j，集群用 Redis+Lua 或 Sentinel 集群模式
  - 多级限流：网关（用户/租户维度）→ 服务（接口维度）→ 下游（资源维度）
  - 限流响应：429 Too Many Requests + Retry-After，前端指数退避重试
first_principle:
  problem: 系统处理能力有上限，超量流量如何在不拖垮系统的前提下公平拒绝？
  axioms:
  - 系统容量有物理上限，超量必然崩溃
  - 限流要"公平"（按用户/租户/接口分配额度）而非"先到先得"
  - 限流算法要"平滑"（避免边界突冲）和"突发容忍"（短时尖峰不误杀）
  rebuild: 令牌桶是工业最优——以固定速率向桶里加令牌（最多到桶容量），请求取走令牌才处理。桶满则新令牌丢弃，桶空则请求拒绝。容量参数控制突发（攒余量），速率控制平均 QPS。多级限流让每层做自己最擅长的——网关粗粒度按用户、服务细粒度按接口、下游按资源。单机用本地令牌桶（无网络开销），集群用 Redis+Lua 原子操作或 Sentinel 集群模式。
follow_up:
  - 令牌桶和漏桶区别？——令牌桶允许突发（攒余量后一次取多个）、漏桶严格匀速（出口固定速率）。限流选令牌桶，MQ 削峰选漏桶
  - 集群限流怎么实现？——Redis+Lua 原子操作（INCRBY + EXPIRE，或令牌桶 Lua 脚本）。Sentinel 集群模式（Token Server 集中分配）。代价是网络开销（每次请求一次 Redis）
  - 限流阈值怎么定？——压测找单机拐点 × 集群数 × 0.7（30% 余量）。例：单机 1万 × 10 台 × 0.7 = 7万 QPS
  - 限流后用户体验？——429 + Retry-After 头，前端指数退避重试。秒杀场景排队页（"前面 N 人"），异步通知结果
  - 怎么发现限流误杀？——监控限流触发率（rate_limited_count / total_count），正常 < 1%，过高说明阈值过低
memory_points:
  - 四算法：计数器（边界突冲）、滑动窗口（平滑）、漏桶（匀速无突发）、令牌桶（匀速+突发）
  - 令牌桶 = 容量（突发上限）+ 速率（平均 QPS）
  - 单机 Sentinel/Resilience4j，集群 Redis+Lua 或 Sentinel 集群
  - 多级限流：网关 → 服务 → 下游，层层兜底
  - 限流阈值 = 单机压测拐点 × 集群数 × 0.7
---

# 【Java 后端架构师】限流算法与多级限流体系设计

> 适用场景：JD 核心技术。秒杀抢券（瞬时 100 万 QPS）、大促 0 点下单、恶意爬虫刷接口、外部 API 配额——这些场景架构师必须能选对算法、定准阈值、设计多级防线，否则峰值必挂。

## 一、概念层：四种限流算法对比

**四种算法的本质区别**（必背表格）：

| 算法 | 原理 | 平滑性 | 突发容忍 | 适用 |
|------|------|--------|---------|------|
| **固定窗口计数器** | 固定时间窗口（1秒）内计数 | 差（边界突冲） | 无 | 简单场景 |
| **滑动窗口计数器** | 细分小窗口（1秒分 10 个 100ms）滑动统计 | 中 | 部分 | 一般场景 |
| **漏桶（Leaky Bucket）** | 请求进桶匀速漏出，超量直接拒绝 | 优（严格匀速） | 无 | MQ 削峰、严格限速 |
| **令牌桶（Token Bucket）** | 匀速产令牌进桶，请求取令牌 | 优 | 允许突发 | API 限流（首选） |

**边界突冲问题**（固定窗口的缺陷）：

```
固定窗口 1 秒 100 QPS：
  0.0-1.0s：0 请求
  0.9s：突然来 100 请求（窗口内，允许）
  1.0s：窗口切换
  1.1s：又来 100 请求（新窗口内，允许）
  → 0.9s-1.1s 这 200ms 内处理了 200 请求，瞬时 1000 QPS，超目标 10 倍

滑动窗口（1 秒分 10 个 100ms 窗口）：
  每 100ms 限制 10 请求，滑动统计最近 1 秒
  → 任意 1 秒内最多 100，平滑很多
```

**令牌桶 vs 漏桶**（面试高频）：

```
令牌桶（Token Bucket）：
  桶里以 R 速率产令牌（最多到容量 C）
  请求到达 → 取令牌 → 有则处理，无则拒绝
  特点：攒满 C 个令牌后，瞬时 C 个请求都能处理（突发）
        长期平均 R QPS

漏桶（Leaky Bucket）：
  请求进桶，桶以 R 速率漏出处理
  桶满（容量 C）则拒绝
  特点：无论来多少，出口固定 R QPS（严格匀速）
        无突发

例子：
  R=100/s, C=50
  
  令牌桶：空闲 1 秒攒 50 令牌 + 新产 100 令牌 = 150
          瞬时来 150 请求 → 全部处理（突发）
          之后回归 100/s

  漏桶：瞬时来 150 请求，桶容量 50
        桶满拒 100，只处理 50（按 R=100/s 漏出）
        严格不超 100/s
```

## 二、机制层：令牌桶算法实现

**令牌桶核心参数**：

```
capacity（容量）：桶最多存多少令牌，决定突发上限
rate（速率）：每秒产生多少令牌，决定平均 QPS

关键公式：
  当前令牌数 = min(capacity, 上次令牌数 + (now - last_refill) × rate)
  if 当前令牌数 >= 1: 取 1 令牌，允许请求
  else: 拒绝请求
```

**单机令牌桶实现**（Java，无锁 CAS）：

```java
public class TokenBucket {

    private final long capacity;        // 桶容量
    private final long ratePerMillis;   // 每毫秒产令牌数（rate / 1000）

    private AtomicLong tokens;          // 当前令牌数
    private AtomicLong lastRefillNanos; // 上次补充时间

    public TokenBucket(long capacity, long ratePerSecond) {
        this.capacity = capacity;
        this.ratePerMillis = ratePerSecond * 1000;
        this.tokens = new AtomicLong(capacity);
        this.lastRefillNanos = new AtomicLong(System.nanoTime());
    }

    public boolean tryAcquire() {
        refill();   // 懒补充：每次取前先算这段时间该补多少
        while (true) {
            long current = tokens.get();
            if (current <= 0) return false;
            if (tokens.compareAndSet(current, current - 1)) {
                return true;
            }
        }
    }

    private void refill() {
        long now = System.nanoTime();
        long last = lastRefillNanos.get();
        if (now <= last) return;

        long elapsedMillis = (now - last) / 1_000_000;
        long newTokens = elapsedMillis * ratePerMillis / 1_000_000;   // 这段时间产多少
        if (newTokens <= 0) return;

        long newLast = last + newTokens * 1_000_000 / ratePerMillis;
        if (lastRefillNanos.compareAndSet(last, newLast)) {
            while (true) {
                long current = tokens.get();
                long updated = Math.min(capacity, current + newTokens);
                if (tokens.compareAndSet(current, updated)) break;
            }
        }
    }
}
```

## 三、机制层：Sentinel 限流实战

**Sentinel 资源定义**（推荐生产使用）：

```java
@Service
public class OrderService {

    @SentinelResource(
        value = "OrderService.placeOrder",
        blockHandler = "placeOrderBlocked",     // 限流后的处理
        fallback = "placeOrderFallback"          // 异常后的降级
    )
    public OrderResult placeOrder(OrderDTO dto) {
        // 业务逻辑
        return doPlaceOrder(dto);
    }

    // 限流处理（BlockException）
    public OrderResult placeOrderBlocked(OrderDTO dto, BlockException ex) {
        if (ex instanceof FlowException) {
            return OrderResult.tooManyRequests("系统繁忙，请稍后重试");
        }
        return OrderResult.error("rejected");
    }

    // 降级处理
    public OrderResult placeOrderFallback(OrderDTO dto, Throwable t) {
        log.error("placeOrder fallback", t);
        return OrderResult.degraded("服务降级");
    }
}
```

**Sentinel 规则配置**（Nacos 动态推送）：

```java
// 1. QPS 限流（单机）
FlowRule rule1 = new FlowRule("OrderService.placeOrder");
rule1.setGrade(RuleConstant.FLOW_GRADE_QPS);
rule1.setCount(1000);   // 单机 1000 QPS
rule1.setLimitApp("default");
// 流控行为：直接拒绝（默认）/ Warm Up（预热）/ 排队等待
rule1.setControlBehavior(RuleConstant.CONTROL_BEHAVIOR_DEFAULT);

// 2. 并发线程数限流（防慢调用拖垮线程池）
FlowRule rule2 = new FlowRule("OrderService.placeOrder");
rule2.setGrade(RuleConstant.FLOW_GRADE_THREAD);
rule2.setCount(200);   // 单机最多 200 并发线程

// 3. 集群限流（Token Server 集中分配）
FlowRule rule3 = new FlowRule("OrderService.placeOrder");
rule3.setClusterMode(true);
rule3.setClusterConfig(new ClusterFlowConfig()
    .setThresholdType(ClusterFlowConfig.GLOBAL_THRESHOLD_TYPE)   // 全局阈值
);
rule3.setCount(10000);   // 集群总 1万 QPS

// 加载规则
FlowRuleManager.loadRules(Arrays.asList(rule1, rule2, rule3));
```

**集群限流架构**（Sentinel Token Server）：

```
应用实例 1 ─┐
应用实例 2 ─┼─> Token Server（独立部署）──> 全局令牌桶
应用实例 3 ─┘

每次请求，应用实例向 Token Server 申请令牌：
  - 申请到 → 处理请求
  - 申请不到 → 限流

优点：精确的全局阈值（不受实例数影响）
缺点：Token Server 单点（要 HA）、网络开销（每次请求一次 RPC）
折中：Sentinel 用"批量申请"优化——一次申请 N 个令牌缓存本地，减少 RPC
```

## 四、机制层：Redis+Lua 集群限流

**Redis+Lua 原子令牌桶**（无 Token Server，去中心化）：

```lua
-- rate_limiter.lua
-- KEYS[1]: 限流 key（如 "rate_limit:order:user:123"）
-- ARGV[1]: capacity（桶容量）
-- ARGV[2]: rate（每秒产令牌数）
-- ARGV[3]: now（当前时间戳，秒）
-- ARGV[4]: requested（本次请求需令牌数，通常 1）

local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local requested = tonumber(ARGV[4])

-- 读取上次状态
local bucket = redis.call("HMGET", key, "tokens", "timestamp")
local tokens = tonumber(bucket[1]) or capacity
local last_time = tonumber(bucket[2]) or now

-- 补充令牌（懒补充）
local delta = math.max(0, now - last_time)
local refilled = tokens + delta * rate
tokens = math.min(refilled, capacity)

-- 判断
if tokens >= requested then
    tokens = tokens - requested
    redis.call("HMSET", key, "tokens", tokens, "timestamp", now)
    redis.call("EXPIRE", key, 3600)   -- 1 小时过期（避免 key 膨胀）
    return 1   -- 允许
else
    redis.call("HMSET", key, "tokens", tokens, "timestamp", now)
    redis.call("EXPIRE", key, 3600)
    return 0   -- 拒绝
end
```

**Java 调用代码**：

```java
@Component
public class RedisRateLimiter {

    @Resource RedisTemplate<String, String> redisTemplate;
    @Resource DefaultRedisScript<Long> rateLimitScript;

    @PostConstruct
    public void init() {
        rateLimitScript = new DefaultRedisScript<>();
        rateLimitScript.setScriptSource(new ResourceScriptSource(
            new ClassPathResource("rate_limiter.lua")));
        rateLimitScript.setResultType(Long.class);
    }

    public boolean tryAcquire(String key, long capacity, long rate) {
        Long result = redisTemplate.execute(
            rateLimitScript,
            Collections.singletonList(key),
            String.valueOf(capacity),
            String.valueOf(rate),
            String.valueOf(System.currentTimeMillis() / 1000),
            "1"
        );
        return result != null && result == 1L;
    }
}

// 使用
public OrderResult placeOrder(OrderDTO dto) {
    String key = "rate_limit:order:user:" + dto.getUserId();
    if (!rateLimiter.tryAcquire(key, 100, 10)) {   // 容量 100，速率 10/s
        throw new TooManyRequestsException("user rate limited");
    }
    // 业务逻辑
}
```

## 五、实战层：多级限流体系设计

**三道防线架构**（架构师必须能画）：

```
入口层（Nginx / API 网关）
  └── 用户/租户/IP 维度限流（粗粒度）
       例：单用户 100 QPS、单 IP 1000 QPS、租户 1万 QPS
       工具：Nginx limit_req、Sentinel 网关流控、APISIX

服务层（应用）
  └── 接口/方法维度限流（细粒度）
       例：placeOrder 接口 5000 QPS、queryOrder 接口 1万 QPS
       工具：Sentinel @SentinelResource、Resilience4j RateLimiter

资源层（下游依赖）
  └── 资源维度限流（DB/Redis/外部 API）
       例：DB 连接池 200、Redis 连接池 100、外部 API 配额 100/s
       工具：线程池隔离、信号量、Resilience4j Bulkhead
```

**JD 风格多级限流规则示例**：

```
用户 U001 下单请求：

  网关层：
    - 全局限流：单 IP 1000 QPS（防爬虫）
    - 用户限流：单用户 50 QPS（防刷）
    → 通过

  服务层 OrderService.placeOrder：
    - 接口限流：单机 1000 QPS（基于压测）
    - 线程数限流：最多 200 并发（防慢调用）
    → 通过

  资源层（下游调用）：
    - DB 连接池：最多 50 并发（连接池上限）
    - 库存服务调用：最多 100 QPS（基于下游容量）
    - 营销服务调用：最多 500 QPS
    → 通过

  任意一层触发限流 → 快速失败（429）
```

**限流响应规范**：

```java
@RestControllerAdvice
public class RateLimitHandler {

    @ExceptionHandler(TooManyRequestsException.class)
    @ResponseStatus(HttpStatus.TOO_MANY_REQUESTS)   // 429
    public ResponseEntity<ErrorResponse> handleRateLimit(TooManyRequestsException e) {
        HttpHeaders headers = new HttpHeaders();
        headers.set("Retry-After", "5");   // 建议客户端 5 秒后重试

        return ResponseEntity.status(429)
            .headers(headers)
            .body(new ErrorResponse("RATE_LIMITED", "系统繁忙，请稍后重试"));
    }
}
```

## 六、底层本质：为什么是令牌桶 + 多级限流

回到第一性：**系统容量有物理上限，超量流量必须公平拒绝**。

**为什么令牌桶是工业首选**：固定窗口有边界突冲（边界处瞬时 2 倍流量），滑动窗口只是缓解。漏桶严格匀速但完全不容忍突发——实际业务流量是波动的，瞬时尖峰（如用户连点）用漏桶会大量误杀。令牌桶兼顾两者：长期平均速率（rate 参数控制），短时突发允许（capacity 参数控制攒余量）。这与实际业务最匹配——业务既能接受平均速率限制，又需要容忍合理突发。

**为什么多级限流**：单点限流做不到精细控制。只在网关限流（按用户/IP）无法保护特定接口（如支付接口容量比查询小）。只在服务层限流无法防恶意爬虫（爬虫分散在各接口）。只在资源层限流（DB 连接池）反应太慢（请求已进服务消耗资源）。多级限流让每层做自己最擅长的事——网关拦外部恶意流量、服务保护接口容量、资源保护下游依赖。层层兜底，任一层失效其他层补位。

**为什么集群限流**：单机限流的问题——假设限流阈值 1000 QPS，部署 10 台实例，实际集群能扛 1万 QPS。但如果流量倾斜（80% 集中到 2 台），那 2 台到 1000 QPS 就限流，其他 8 台闲置，整体只用了 2000 QPS。集群限流（Token Server 或 Redis+Lua）做全局阈值——总流量 1万 QPS 内才允许，不限于单机。代价是网络开销（每次请求一次 RPC），用"批量申请令牌"缓解。

**限流的反模式**：①阈值凭感觉定（不压测）；②只网关限流不服务限流（单点失效全挂）；③限流不返回明确状态码（用 500 误导客户端）；④被限流后无限重试（重试风暴）。正确姿势是压测定阈值、多级兜底、429+Retry-After、客户端指数退避。

## 七、AI 架构师加问：5 个 AI 相关问题

1. **AI 推理服务的限流怎么设计？**
   GPU 资源稀缺，限流更严。按用户配额（VIP 高、普通低）+ 按模型分池（大模型配额少、小模型配额多）+ 按 token 限流（防长 prompt 耗尽资源）。监控 rate_limited_count 和 token_rejected_count。

2. **让 AI 动态调整限流阈值，AI 接管哪段？**
   AI 实时分析负载（CPU、RT、错误率），动态调整 Sentinel 阈值（通过 Nacos 推送）。AI 出建议（"当前负载低，阈值可从 1000 提到 1500"），人工确认或自动执行。监控调整效果（限流触发率、P99）。

3. **AI Agent 工具调用的限流怎么设计？**
   每个 tool_call 按下游容量限流（如搜索 API 100 QPS、DB 50 并发）。AI 重试时指数退避 + 抖动，避免重试风暴。监控 tool_call_rate_limited_count，过高说明下游容量不足。

4. **AI 推理请求的令牌桶怎么配？**
   capacity 设为"突发上限"（如 VIP 用户 100，普通 10），rate 设为"平均速率"（如 VIP 10/s，普通 1/s）。这样 VIP 用户偶尔连发不误杀，普通用户防刷。按用户分桶，不全局共享。

5. **AI 服务如何防止恶意调用？**
   多层防护：网关 IP/用户限流（拦爬虫）+ API key 配额（按签约额度）+ 按内容限流（长 prompt 限频）+ 行为分析（异常调用模式识别）。监控 abuse_detection_rate，异常账号自动降级。

## 八、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"四算法对比、令牌桶首选、多级三道防线、阈值压测×0.7、429+Retry-After"**。

- **四算法**：计数器（边界突冲）、滑动窗口（平滑）、漏桶（匀速无突发）、令牌桶（匀速+突发）
- **令牌桶**：capacity（突发上限）+ rate（平均 QPS），懒补充令牌
- **多级三道防线**：网关（用户/IP）→ 服务（接口）→ 资源（DB/下游）
- **集群限流**：Sentinel Token Server 或 Redis+Lua（原子操作）
- **阈值**：单机压测拐点 × 集群数 × 0.7，429 + Retry-After

### 拟人化理解

把限流想成 **JD 水库防洪**。计数器是"每分钟开闸 N 次"（边界处双倍放水）、滑动窗口是"细分到秒的滑动统计"（平滑）、漏桶是"匀速放水"（严格不超）、令牌桶是"匀速产水票，攒够才能取水"（允许突发取票）。水库要多级防洪——入水口（网关拦外部洪水）、闸门（服务限接口流量）、支流（资源保护下游水库）。令牌桶首选是因为既限平均速率又能容忍合理突发（业务流量本来波动）。

### 面试现场 60 秒回答

> 四种限流算法：计数器有边界突冲、滑动窗口平滑、漏桶严格匀速无突发、令牌桶匀速产令牌可攒余量容忍突发。生产首选令牌桶（capacity 突发上限 + rate 平均 QPS），兼顾平滑和业务波动。多级限流三道防线：网关按用户/IP 粗粒度（拦爬虫）、服务按接口细粒度（保容量）、资源按 DB/下游（防雪崩）。单机用 Sentinel @SentinelResource、集群用 Sentinel Token Server 或 Redis+Lua 原子脚本。阈值 = 单机压测拐点 × 集群数 × 0.7，留 30% 余量。限流返回 429 + Retry-After，客户端指数退避重试。

### 反问面试官

> 贵司核心接口的限流阈值是单机还是集群维度？用什么工具（Sentinel/自研）？限流触发率监控吗？这决定我多级限流方案的设计。

## 九、苏格拉底式面试追问

每一问先回答"为什么"，再"怎么做"，最后"如何证明"。

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不限流直接扩容？ | 扩容有延迟（分钟级），限流毫秒响应；扩容按峰值配资源成本爆炸（峰值是日常 10-50 倍）；某些场景（恶意爬虫）必须拒绝而非扩容。限流是实时保护，扩容是容量规划，两者互补 |
| 证据追问 | 怎么证明限流阈值定的合理？ | 压测找单机拐点（P99 突增点）、限流触发率监控（正常 < 1%，过高说明阈值过低误杀）、用户投诉（限流是否影响正常用户）、错误率（应稳定不突增） |
| 边界追问 | 限流能解决所有峰值问题吗？ | 不能。慢性容量不足要扩容，恶意流量要 WAF/黑名单，下游故障要熔断。限流是"快速拒绝超量"，治标不治本，要配扩容和熔断 |
| 反例追问 | 什么场景不限流？ | 内部管理后台（低 QPS 自然）、有自然背压的场景（线程池 CallerRunsPolicy）、试验性服务。强行限流是过度设计 |
| 风险追问 | 限流配置错的最大风险？ | 阈值过高（形同虚设，峰值打挂）、阈值过低（误杀正常用户）、规则配错（限错了接口）、集群限流 Token Server 单点（要 HA）。治法：压测验证、灰度发布规则、监控触发率、Token Server 集群部署 |
| 验证追问 | 怎么证明多级限流生效了？ | 故障演练（kill 下游，看是否触发资源层限流而非雪崩）、压测超量流量（看是否逐层拒绝）、监控各层 rate_limited_count 分布（应网关最多、服务次之、资源最少） |
| 沉淀追问 | 团队限流规范沉淀什么？ | 接口优先级分类（核心/重要/非核心）、阈值计算公式（压测×0.7）、Sentinel 规则模板、多级限流架构图、限流触发率告警、429 响应规范 |

### 现场对话示例

**面试官**：令牌桶和漏桶有什么区别？

**候选人**：核心区别是对突发的处理。令牌桶以固定速率产令牌进桶（最多到容量 C），请求取令牌处理——攒满 C 个令牌后瞬时 C 个请求都能处理，允许突发。漏桶是请求进桶后以固定速率漏出处理，桶满就拒绝——无论来多少请求，出口永远是固定速率，严格无突发。举例：R=100/s, C=50。令牌桶空闲 1 秒后瞬时来 150 请求全部处理（攒了 50 + 新产 100）。漏桶瞬时来 150 请求，桶容量 50，只能处理 50，拒 100。API 限流选令牌桶（业务流量波动要容忍突发），MQ 削峰选漏桶（要严格匀速保护下游）。

**面试官**：集群限流怎么实现？

**候选人**：两种主流方案。第一，Sentinel 集群模式——独立部署 Token Server，应用实例每次请求向 Token Server 申请令牌。优点是精确全局阈值，缺点是 Token Server 单点（要 HA 部署）和网络开销。Sentinel 用"批量申请"优化——一次申请 N 个令牌缓存本地，减少 RPC。第二，Redis+Lua——用 Lua 脚本在 Redis 端原子执行令牌桶逻辑（HMGET + 算补充 + HMSET）。优点是去中心化（无 Token Server）、Redis 天然 HA。缺点是每次请求一次 Redis 网络 IO。选型：量小用 Sentinel 集群（运维成熟），量大用 Redis+Lua（去中心化）。

**面试官**：限流后用户怎么办？

**候选人**：分场景。秒杀抢券：返回"活动太火爆"页 + 前端指数退避重试（1s、2s、4s）。下单：返回排队页"您前面还有 N 人"，异步处理完通知。API 调用：返回 429 + Retry-After 头（建议 5 秒后重试），客户端指数退避。绝不返回 500（误导以为是 bug），要让客户端知道是限流可重试。关键：客户端重试必须有上限（3 次）+ 抖动（避免同步重试风暴），不能无限重试。

## 常见考点

1. **四种限流算法区别？**——计数器（边界突冲）、滑动窗口（平滑）、漏桶（匀速无突发）、令牌桶（匀速+突发）。生产首选令牌桶。
2. **令牌桶和漏桶区别？**——令牌桶允许突发（攒余量一次取多个）、漏桶严格匀速（出口固定）。API 限流选令牌桶，MQ 削峰选漏桶。
3. **集群限流怎么做？**——Sentinel Token Server（集中式，批量申请优化）或 Redis+Lua（去中心化，原子操作）。
4. **多级限流怎么设计？**——网关（用户/IP 粗粒度）→ 服务（接口细粒度）→ 资源（DB/下游）。层层兜底，单点失效其他补位。
5. **限流阈值怎么定？**——单机压测拐点 × 集群数 × 0.7（留 30% 余量）。监控限流触发率（应 < 1%，过高说明阈值过低）。


## 结构化回答

**30 秒电梯演讲：** 聊到限流算法与多级限流体系设计，我的理解是——限流的四种算法（计数器、滑动窗口、漏桶、令牌桶）解决"如何在超量流量时保护系统"。令牌桶（Token Bucket）是工业首选——匀速产令牌、桶可攒余量，既能限平均速率又能容忍突发。多级限流是架构师视角——网关限粗粒度（用户/租户）、服务限细粒度（接口）、下游限资源（DB 连接），层层兜底。打个比方，像 JD 水库防洪：计数器是"每分钟开闸 N 次"（边界突冲）、滑动窗口是"细分到秒的滑动统计"、漏桶是"匀速放水"（严格无突发）、令牌桶是"匀速产水票，攒够才能取水"（允许突发）。水库要在入水口（网关）、闸门（服务）、支流（下游）多级防洪，单点拦不住。

**展开框架：**
1. **四种算法** — 计数器（固定窗口）、滑动窗口、漏桶（匀速）、令牌桶（匀速产+可攒）
2. **令牌桶参数** — 容量（允许突发上限）、速率（平均 QPS）
3. **单机限流 vs 集群限流** — 单机用 Sentinel/Resilience4j，集群用 Redis+Lua 或 Sentinel 集群模式

**收尾：** 这块我在项目里也踩过坑——想深入的话，可以接着聊：令牌桶和漏桶区别？您更想看哪个方向？

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡 | "限流算法与多级限流体系设计——这道题面试官到底想考什么？我用 30 秒给你讲透。" | 开场钩子 |
| 0:15 | 限流算法对比图 | 先说核心：限流的四种算法（计数器、滑动窗口、漏桶、令牌桶）解决"如何在超量流量时保护系统"。令牌桶（Token Bucket）是工业首选——匀速产令牌、桶可攒余量，既能限平均速率又能容忍。 | 核心定义 |
| 0:40 | 概念结构示意图 | 容量（允许突发上限）、速率（平均 QPS）。 | 令牌桶参数 |
| 1:05 | 流程图 | 单机用 Sentinel/Resilience4j，集群用 Redis+Lua 或 Sentinel 集群模式。 | 单机限流 vs 集群限流 |
| 2:30 | 总结卡 | 一句话记忆：四算法：计数器（边界突冲）、滑动窗口（平滑）、漏桶（匀速无突发）、令牌桶（匀速+突发）。 下期可以接着聊：令牌桶和漏桶区别。 | 收尾总结 |
