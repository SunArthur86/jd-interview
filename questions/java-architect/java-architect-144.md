---
id: java-architect-144
difficulty: L3
category: java-architect
subcategory: 限流
title: 限流从单机到分布式如何演进
tags: [限流, 令牌桶, Redis Lua, 漏桶, Sentinel]
related: [java-architect-145, java-architect-138, java-architect-026]
---

# 限流从单机到分布式如何演进

> **场景**：京东开放 API 平台为 1 万商家提供接口，每个商家有独立 QPS 配额（10-10000 不等）。单机限流无法保证全局配额，分布式限流怎么做？面试官追问：限流算法的演进路径和选型？

## 一、概念层：限流要解决什么

### 1.1 三个层次的目标

| 层次 | 目标 | 工具 |
|------|------|------|
| 接入层 | 防恶意流量（爬虫/CC） | Nginx limit_req、WAF |
| 应用层 | 保护下游服务不雪崩 | Sentinel、Resilience4j |
| 业务层 | 商家配额、用户配额 | Redis 分布式限流 |

### 1.2 四种主流算法对比

| 算法 | 原理 | 优点 | 缺点 |
|------|------|------|------|
| **固定窗口** | 每秒计数 | 简单 | 临界点突刺（59s 和 1s 各放 100） |
| **滑动窗口** | 时间片加权 | 平滑 | 内存占用高 |
| **漏桶** | 恒定速率出水 | 强平滑 | 无法应对突发 |
| **令牌桶** | 恒定速率发牌 | 支持突发（桶大小） | 实现稍复杂 |

**令牌桶是工业界主流**（Guava RateLimiter、Sentinel、AWS API Gateway 都是变种）。

## 二、机制层：从单机到分布式的演进

### 2.1 阶段一：单机令牌桶（Guava）

```java
// 每个实例独立 100 QPS，3 台集群理论 300 QPS
private final RateLimiter limiter = RateLimiter.create(100);

public Response handle(Request req) {
    if (!limiter.tryAcquire(1, 100, MILLISECONDS)) {
        return Response.tooManyRequests();
    }
    return doProcess(req);
}
```

**问题**：
- 实例间不感知，总 QPS = 实例数 × 单机 QPS，无法精确控制全局
- 扩缩容时配额变化，难以稳定
- 商家配额无法跨实例统计

### 2.2 阶段二：Redis + 计数器（简单分布式）

```java
public boolean allow(String key, int limit, int windowSec) {
    String lua = 
        "local c = redis.call('INCR', KEYS[1]) " +
        "if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end " +
        "return tonumber(c) <= tonumber(ARGV[1])";
    Long result = redis.execute(new DefaultRedisScript<>(lua, Long.class),
        List.of("rate:" + key), String.valueOf(limit), String.valueOf(windowSec));
    return result != null && result == 1L;
}
```

**问题**：固定窗口的临界突刺。1s 末尾放 100，2s 开头放 100，200ms 内通过 200。

### 2.3 阶段三：Redis + Lua 滑动窗口（生产可用）

```lua
-- sliding-window.lua
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])  -- 窗口大小 ms
local now = tonumber(ARGV[3])
local cleared = now - window

-- 1. 移除过期时间片
redis.call('ZREMRANGEBYSCORE', key, '-inf', cleared)
-- 2. 当前窗口计数
local count = redis.call('ZCARD', key)
if count >= limit then
    return 0
end
-- 3. 加入当前请求
redis.call('ZADD', key, now, now .. ':' .. math.random())
redis.call('EXPIRE', key, window / 1000 + 1)
return 1
```

```java
public boolean allowSliding(String bizKey, int limit, int windowMs) {
    String key = "rate:sliding:" + bizKey;
    Long allowed = redis.execute(slidingScript,
        List.of(key),
        String.valueOf(limit),
        String.valueOf(windowMs),
        String.valueOf(System.currentTimeMillis()));
    return allowed != null && allowed == 1L;
}
```

**优点**：精确控制全局 QPS，无突刺
**缺点**：ZSET 内存占用较高，每次请求一次 Redis RTT

### 2.4 阶段四：Redis + Lua 分布式令牌桶（最常用）

```lua
-- token-bucket.lua
local key = KEYS[1]
local capacity = tonumber(ARGV[1])     -- 桶容量
local rate = tonumber(ARGV[2])         -- 每秒生成令牌数
local now = tonumber(ARGV[3]) / 1000   -- 当前秒
local requested = tonumber(ARGV[4])    -- 本次请求令牌数

-- 上次填充时间和剩余令牌
local last = tonumber(redis.call('HGET', key, 'last')) or now
local tokens = tonumber(redis.call('HGET', key, 'tokens')) or capacity

-- 按时间差补充令牌
local delta = math.max(0, now - last)
tokens = math.min(capacity, tokens + delta * rate)

if tokens < requested then
    -- 不够：更新已补充的令牌（不消耗）
    redis.call('HMSET', key, 'tokens', tokens, 'last', now)
    redis.call('EXPIRE', key, math.ceil(capacity / rate) * 2)
    return 0
end

tokens = tokens - requested
redis.call('HMSET', key, 'tokens', tokens, 'last', now)
redis.call('EXPIRE', key, math.ceil(capacity / rate) * 2)
return 1
```

```java
@Service
public class DistributedRateLimiter {
    private final StringRedisTemplate redis;
    private final DefaultRedisScript<Long> script;

    public boolean allow(String bizKey, int capacity, int rate, int requested) {
        Long r = redis.execute(script,
            List.of("ratelimit:" + bizKey),
            String.valueOf(capacity),
            String.valueOf(rate),
            String.valueOf(System.currentTimeMillis()),
            String.valueOf(requested));
        return r != null && r == 1L;
    }
}
```

## 三、实战层：JD 开放平台的限流架构

### 3.1 多维度限流规则

```java
@Configuration
public class RateLimitRules {
    // 商家维度：根据 SLA 等级
    public RateLimitRule merchantRule(String merchantId, String sla) {
        return switch (sla) {
            case "PLATINUM" -> new RateLimitRule(10000, 10000);  // 桶容 1w, 速率 1w/s
            case "GOLD"     -> new RateLimitRule(2000, 1000);
            case "SILVER"   -> new RateLimitRule(500, 200);
            default         -> new RateLimitRule(50, 10);
        };
    }
    
    // API 维度：保护单个接口
    public RateLimitRule apiRule(String api) {
        return new RateLimitRule(50000, 50000);  // 全局接口上限
    }
    
    // IP 维度：防恶意
    public RateLimitRule ipRule(String ip) {
        return new RateLimitRule(100, 100);
    }
}
```

### 3.2 网关 + Redis 两级限流

```
请求 → Nginx(limit_req IP维度) → API Gateway(Sentinel + Redis分布式限流) → 业务
       防恶意爬虫                  商家+API配额维度
```

```java
@Component
public class ApiGatewayFilter implements GlobalFilter {
    private final DistributedRateLimiter limiter;
    private final MerchantService merchantService;

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
        String merchantId = exchange.getRequest().getHeaders().getFirst("X-Merchant-Id");
        String api = exchange.getRequest().getPath().value();
        String ip = getClientIp(exchange);

        // 多维度校验：任一失败即限流
        if (!limiter.allow("merchant:" + merchantId, merchantCap(merchantId), merchantRate(merchantId), 1)
         || !limiter.allow("api:" + api, 50000, 50000, 1)
         || !limiter.allow("ip:" + ip, 100, 100, 1)) {
            exchange.getResponse().setStatusCode(HttpStatus.TOO_MANY_REQUESTS);
            exchange.getResponse().getHeaders().add("Retry-After", "1");
            return exchange.getResponse().setComplete();
        }
        return chain.filter(exchange);
    }
}
```

### 3.3 异步限流（提升 Redis 性能）

每请求一次 Redis 在高 QPS 下成为瓶颈。优化：**本地批量预扣令牌**。

```java
public class BatchTokenLimiter {
    private final AtomicLong localTokens;  // 本地预分配
    private final long capacity;
    private long lastRefillNanos;

    public boolean tryAcquire(String bizKey, int permits) {
        if (localTokens.get() >= permits) {
            // 本地够，直接扣
            if (localTokens.addAndGet(-permits) >= 0) return true;
            localTokens.addAndGet(permits);  // 回滚
        }
        // 本地不够，批量向 Redis 申请
        long batch = Math.min(capacity, Math.max(permits * 10, 100));
        if (redisLimiter.allow(bizKey, capacity, rate, batch)) {
            localTokens.addAndGet(batch - permits);
            return true;
        }
        return false;
    }
}
```

减少 Redis 访问 10-100 倍，代价是精度损失（本地预扣未用完会浪费）。

### 3.4 监控指标

| 指标 | 含义 | 告警阈值 |
|------|------|----------|
| `rate_limit_deny_count` | 被限流次数 | 突增告警 |
| `rate_limit_redis_latency_ms` | Redis RT | P99 > 5ms |
| `rate_limit_local_token_waste` | 本地令牌浪费 | > 30% 调整批量 |

## 四、底层本质：CAP 与精度

### 4.1 First Principle：分布式限流本质是"全局计数器"

单机限流靠进程内变量，分布式限流需要共享状态。Redis 是最简单的共享状态存储。但 Redis 不是强一致的（主从异步），所以**分布式限流必然有误差**。

可接受的误差：
- 主从切换瞬间可能多放 5-10% 流量
- 异步同步延迟可能导致配额瞬时超用

业务可接受 → 用 Redis；不可接受 → 用 ZooKeeper/Etcd 强一致（但性能差 10 倍）。

### 4.2 令牌桶为什么工业界主流

令牌桶允许"突发"（burst）：桶里有 100 个令牌，1ms 内可以全部消耗。这符合真实业务——用户请求不是均匀到来的，是脉冲式的。

漏桶强制恒定出水速率，会把脉冲流量拉平，导致 RT 飙升。**对面向用户的 API，令牌桶体验更好**；对下游保护（如 DB），漏桶更安全。

### 4.3 Feynman 解释

限流像地铁进站口。
- 单机限流：每个进站口独立数人，3 个口各放 30 人，但实际想控制总量 50 人做不到。
- 分布式限流：所有进站口共享一个"中央计数器"，谁先进谁先出，总量可控。
- 令牌桶：中央每秒发 100 个号牌，先到先得；号牌还能存着以后用（突发）。
- 漏桶：每秒只放 100 人进，多了排队，永远恒速。

## 五、AI 架构师加问

**Q1：Redis 主从切换时限流不准怎么办？**
方案：
- 接受误差（业务上多放 5% 可接受）
- 用 Redis Cluster + Redlock（强一致，但性能损失）
- 双层：Redis 分布式粗限 + 本地精限

**Q2：限流维度太多（商家×API×IP），Redis KEY 爆炸怎么办？**
- 用 Hash 结构合并 KEY（一个商家的多维度放在一个 Hash）
- 短期冷 KEY 自动过期
- 监控 Redis 内存，超阈值告警

**Q3：Sentinel 和自研 Redis 限流怎么选？**
- Sentinel：单机集群限流（需 Token Server），适合内部服务保护
- Redis 分布式：精确全局配额，适合开放平台/商家配额
- JD 实践：内部用 Sentinel，对外开放用 Redis 分布式

**Q4：限流后的请求怎么处理？**
- 直接拒绝（429）：保护系统，用户体验差
- 排队等待（漏桶）：RT 高
- 降级返回兜底数据：缓存/默认值
- 异步化：转 MQ 后台处理

**Q5：高 QPS 下 Redis 成为瓶颈怎么优化？**
- 本地批量预扣（见 3.3）
- 多 KEY 分片（rate:bucket0...bucket9）
- 用 Redis Cluster 多分片
- 极限场景用本地限流 + 定时同步配额

## 六、记忆口诀

```
限流四算法：固定滑漏令牌。
单机不感知，分布式 Redis 共享。
Lua 令牌桶，支持突发抗脉冲。
网关+本地双层，多维度商家 API IP。
高 QPS 要批扣，本地令牌省 Redis。
主从切换有误差，业务容忍选 Redis。
```

## 七、苏格拉底追问

| 层级 | 问题 | 关键答案 |
|------|------|----------|
| L1 表象 | 单机限流有什么问题？ | 实例间不感知，总 QPS 不可控 |
| L2 机制 | Redis Lua 为什么能做分布式限流？ | 单线程原子执行脚本，多客户端共享计数器 |
| L3 边界 | 滑动窗口和令牌桶区别？ | 滑动窗口强制匀速；令牌桶允许突发（桶容） |
| L4 权衡 | Redis 限流 vs ZooKeeper 强一致限流？ | Redis 快但有误差；ZK 强一致但性能差 10 倍 |
| L5 反例 | 商家 QPS 1w，Redis 单点 RT 5ms，单机 1k QPS 时 Redis 扛不住？ | 本地批量预扣，10-100 倍降 Redis 压力 |
| L6 极限 | 亿级 QPS 怎么限流？ | 多级：边缘 Nginx → 网关 Sentinel → Redis 分片集群 |
| L7 系统 | 全局限流和单元化限流冲突？ | 单元化部署时每单元独立配额，全局总量 = 各单元之和；跨单元用全局 Token Server |

**对话还原**：
> 面试官：开放平台怎么限制商家 QPS？
> 我：网关层 Redis Lua 分布式令牌桶，按商家 SLA 分配配额（铂金 1w/s，黄金 1k/s）。叠加 API 维度和 IP 维度。
> 面试官：Redis 主从切换瞬间呢？
> 我：可能多放 5-10%，业务可接受。资金类强一致场景我们走 ZooKeeper 强一致限流，但只用于少量核心接口。
> 面试官：QPS 高了 Redis 成瓶颈？
> 我：本地批量预扣——每次从 Redis 取 100 个令牌放本地，消耗完再取。Redis 压力降 10-100 倍。
> 面试官：被限流的请求怎么办？
> 我：分级——开放 API 直接 429 + Retry-After；核心交易降级返回兜底；可异步的转 MQ。

## 八、常见考点

1. **四种限流算法对比** —— 令牌桶支持突发是主流
2. **Redis Lua 分布式限流** —— 必考，要能写 Lua 脚本
3. **滑动窗口 vs 令牌桶** —— 前者匀速后者突发
4. **分布式限流的误差来源** —— Redis 主从异步、网络延迟
5. **多维度限流** —— 商家/API/IP 组合规则
6. **批量预扣优化** —— 减少 Redis 访问
7. **Sentinel vs 自研** —— 内部 Sentinel、对外 Redis
8. **限流后处置** —— 拒绝/排队/降级/异步化

## 结构化回答

**30 秒电梯演讲：** 京东开放 API 平台为 1 万商家提供接口，每个商家有独立 QPS 配额（10-10000 不等）。单机限流无法保证全局配额，分布式限流怎么做？面试官追问：限流算法的演进路径和选型？

**展开框架：**
1. **四种限流算法对比** — 四种限流算法对比 —— 令牌桶支持突发是主流
2. **Redis Lua 分布式限流** — Redis Lua 分布式限流 —— 必考，要能写 Lua 脚本
3. **滑动窗口 vs 令牌桶** — 滑动窗口 vs 令牌桶 —— 前者匀速后者突发

**收尾：** 以上是我的整体思路。您想继续深入聊——单机限流有什么问题？


## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：限流从单机到分布式如何演进 | "这题一句话：京东开放 API 平台为 1 万商家提供接口，每个商家有独立 QPS 配额（10-10000 不等）。" | 开场钩子 |
| 0:15 | 四种限流算法对比示意/对比图 | "四种限流算法对比 —— 令牌桶支持突发是主流" | 四种限流算法对比要点 |
| 0:40 | Redis Lua 分布式限流示意/对比图 | "Redis Lua 分布式限流 —— 必考，要能写 Lua 脚本" | Redis Lua 分布式限流要点 |
| 1:05 | 滑动窗口 vs 令牌桶示意/对比图 | "滑动窗口 vs 令牌桶 —— 前者匀速后者突发" | 滑动窗口 vs 令牌桶要点 |
| 1:55 | 总结卡 | "记住：四种限流算法对比。下期见。" | 收尾 |
