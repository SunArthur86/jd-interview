---
id: ant-risk-007
difficulty: L3
category: jd-core
subcategory: Spring Cloud
tags:
- 蚂蚁
- 风控
- Sentinel
- 熔断
- 网关
- 限流
feynman:
  essence: 熔断器用"半开探测-恢复"机制防止下游故障向调用链上游蔓延；限流器在入口按 QPS/线程数截断洪峰，二者是高可用系统的"保险丝"和"水闸"。
  analogy: 熔断像电路保险丝——电流过大自动断电保护电器；限流像水坝泄洪闸——超过库容放掉多余的水。系统恢复时熔断"半开"先试探小流量，正常再"闭合"全放开。
  first_principle: 在依赖关系复杂的分布式系统里，单个下游故障会通过线程池耗尽向调用方级联传染，需要在依赖链路里加"切断器"阻断传染。
  key_points:
  - 熔断三态：CLOSED（正常）/ OPEN（熔断，快速失败）/ HALF_OPEN（半开探测）
  - 限流维度：QPS、并发线程数、调用关系（链路）
  - Sentinel 用滑动窗口统计 + 信号量隔离；Hystrix 用桶计数 + 线程池隔离
  - 流控效果：直接拒绝、Warm Up、排队等待
  - 熔断策略：慢调用比例、异常比例、异常数
first_principle:
  problem: 在调用链复杂、依赖众多的分布式系统里，如何防止单点故障引发雪崩？
  axioms:
  - 调用方依赖被调方的线程池/连接池
  - 被调变慢会拖死调用方资源
  - 故障会沿调用链上游传染（雪崩）
  rebuild: 在每个调用点加"断路器"——统计失败率/RT，超阈值 OPEN 拒绝调用保护自己；定期 HALF_OPEN 探测恢复。再加"限流器"在入口控总量，从源头削峰。
follow_up:
- Sentinel 和 Hystrix 区别？——Hystrix 已停更，线程池隔离开销大；Sentinel 信号量隔离轻量，且流控规则更丰富，阿里系默认选 Sentinel
- 熔断恢复时间怎么定？——半开周期通常 5-10s，先放 1 个请求试探，成功转 CLOSED 失败转 OPEN
- 风控里怎么用 Sentinel？——决策服务对每个下游（特征/规则/画像）配独立熔断规则；入口网关按 UID 限流防刷
memory_points:
- 熔断三态 CLOSED/OPEN/HALF_OPEN，恢复靠半开探测
- Sentinel 信号量隔离（轻量）vs Hystrix 线程池隔离（强但有上下文切换开销）
- 限流维度：QPS / 并发数 / 链路；流控效果：拒绝/Warm Up/排队
- 集群限流：Token Server 集中算 QPS，避免单机限流偏差
---

# 【蚂蚁风控】Spring Cloud 里的熔断和限流怎么实现的？Sentinel 原理？风控怎么用？

> JD 依据："Spring Cloud" + "保障海量数据系统的稳定性"。熔断限流是风控系统高可用的核心组件。

## 一、表面层：为什么需要熔断限流

**雪崩场景**（没有熔断）：
```
特征服务慢查询 → 决策服务调用特征超时 → 决策线程池被占满
   → 决策服务不可用 → 网关调用决策堆积 → 网关线程池满
   → 全链路雪崩
```

**熔断的作用**：特征服务变慢到阈值 → 决策侧熔断器 OPEN → 快速失败返回兜底 → 决策线程不被拖死 → 上游正常 → 故障被"切断"在依赖链路中。

## 二、熔断器三态机（核心机制）

```
        失败率/RT超阈值              定时探测
   ┌──────────────────┐      ┌──────────────────┐
   │                  ▼      │                  │
   │             ┌─────────────┐            │
   │             │   OPEN      │            │
   │             │  (熔断拒绝) │            │
   │             └─────────────┘            │
   │                  │                      │
   │       等待时间到(半开)                  │
   │                  ▼                      │
   │             ┌─────────────┐            │
   │             │ HALF_OPEN   │            │
   │             │ (放1请求试探)│            │
   │             └─────────────┘            │
   │              /       \                 │
   │       成功  /         \ 失败           │
   │            ▼           ▼               │
   │      ┌────────┐   回到 OPEN            │
   └─────│ CLOSED │                        │
         │ (正常) │                        │
         └────────┘                        
```

- **CLOSED**：正常放行，统计失败率
- **OPEN**：直接拒绝（不发起调用），保护本地资源
- **HALF_OPEN**：等待超时后放 1 个请求试探，成功→CLOSED，失败→OPEN

## 三、Sentinel 原理

Sentinel 是阿里开源的流量治理组件，核心是**滑动窗口统计 + 责任链插槽**。

**插槽链**（每个请求经过）：
```
NodeSelectorSlot → ClusterBuilderSlot → StatisticSlot → FlowSlot → DegradeSlot → ...
   选节点         构建集群节点          统计RT/QPS        限流判断    熔断判断
```

**滑动窗口统计**：
```
LeapArray (默认 1 秒，分 2 个 500ms 桶)
   ├─ Window1 [0-500ms]: QPS=200, RT=50ms
   └─ Window2 [500-1000ms]: QPS=180, RT=45ms
滑动：每过 500ms 滚动一个桶
```

**熔断策略**：
1. **慢调用比例**：RT > 阈值的比例超 maxRatio，熔断（适合外部依赖慢）
2. **异常比例**：异常/总请求 > ratio，熔断
3. **异常数**：异常数 > 阈值，熔断

## 四、Sentinel vs Hystrix

| 维度 | Hystrix | Sentinel |
|------|---------|----------|
| 隔离方式 | 线程池（强隔离，开销大） | 信号量（轻量，默认） |
| 熔断策略 | 异常比例 | 慢调用比例 / 异常比例 / 异常数 |
| 限流 | 无（只熔断） | QPS / 并发数 / 关系链路 |
| 流控效果 | 直接拒绝 | 拒绝 / Warm Up / 排队等待 |
| 系统自适应 | 无 | 有（基于 Load1/RT/线程数自适应） |
| 控制台 | 弱 | 强（实时监控+动态规则） |
| 维护状态 | 已停止维护 | 持续更新 |

**风控选 Sentinel**：信号量隔离无上下文切换开销；规则丰富；阿里系生态。

## 五、风控实战配置

**场景 1：决策服务对下游特征的熔断**
```java
@SentinelResource(value = "callFeature",
    blockHandler = "featureFallback",       // 限流熔断的兜底
    fallback = "featureExceptionFallback")  // 业务异常的兜底
public Feature queryFeature(String uid) {
    return featureService.get(uid);          // 可能慢/失败
}

public Feature featureFallback(String uid, BlockException ex) {
    return Feature.empty();                  // 返回空特征，规则用默认策略
}
```

规则（Dashboard 配置）：
- 慢调用比例：RT > 200ms 的比例 > 50% → 熔断 10s
- 最小请求数：5（避免低流量误判）
- 异常比例：> 30% → 熔断

**场景 2：网关限流（防恶意刷）**
```yaml
spring:
  cloud:
    gateway:
      routes:
        - id: risk-invoke
          uri: lb://risk-decision
          predicates:
            - Path=/risk/invoke
          filters:
            - name: RequestRateLimiter
              args:
                redis-rate-limiter.replenishRate: 1000   # 令牌桶填充速率
                redis-rate-limiter.burstCapacity: 2000   # 桶容量
                key-resolver: "#{@userKeyResolver}"      # 按 UID 限流
```

**场景 3：集群限流**
单机限流无法准确控全局 QPS（每台机器看到的只是局部），用 Token Server：
```
风控决策 N 台 → 都向 Token Server 申请令牌
Token Server 集中算全局 QPS，避免单机偏差
```

## 六、流控效果：拒绝 / Warm Up / 排队

| 效果 | 行为 | 适用 |
|------|------|------|
| **直接拒绝** | 超阈值直接抛 BlockException | 大多数场景 |
| **Warm Up** | 阈值从 low 缓升到 high（如 30s 内 10→1000） | 冷启动（缓存刚预热） |
| **排队等待** | 请求匀速通过（漏桶算法），超出排队 | 削峰填谷（消息类） |

**风控的 Warm Up 场景**：发布后缓存冷启动，直接放开 1000 QPS 会击穿缓存 → DB 暴击。用 Warm Up 让流量从 100 缓升到 1000。

## 七、底层本质：流量治理的"保险"机制

熔断/限流本质是给系统装"保险"：
- **熔断 = 自动断路器**：检测下游异常，自动切断保护自己
- **限流 = 流量调节阀**：控制入口流量，让系统在额定功率内运行

它们的**第一性原理**：承认分布式系统的"不可靠性"（网络抖、依赖挂、流量突），不试图消除故障，而是**让故障的影响可控**——单点故障不传染、洪峰不冲垮系统。

**和"高可用三件套"的关系**：
- **限流**：入口截流（防过载）
- **熔断**：依赖隔离（防雪崩）
- **降级**：兜底返回（保可用性）

三者配合，构成系统在高压力下的生存策略。

## 常见考点
1. **滑动窗口和漏桶/令牌桶区别**？——滑动窗口是统计（看历史），漏桶/令牌桶是控制（限流策略）。Sentinel 用滑动窗口统计 + 令牌桶（默认）或漏桶（匀速排队）。
2. **Sentinel 怎么和 Feign 集成**？——`feign.sentinel.enabled=true`，每个 Feign 客户端都可配 fallback。
3. **集群限流一定要 Token Server 吗**？——是的，需要集中算全局 QPS；但可以"伪集群限流"用每机 1/N 阈值近似。

**代码示例**（自定义 Slot 实现业务限流）：
```java
// 按 UID 维度限流（网关层）
@Bean
public KeyResolver userKeyResolver() {
    return exchange -> Mono.just(
        exchange.getRequest().getHeaders().getFirst("X-UID")
    );
}
```
