---
id: pdd-trade-005
difficulty: L4
category: pdd-trade
subcategory: 网关设计
tags:
- 拼多多
- 交易
- 网关
- Spring Cloud Gateway
- 限流
feynman:
  essence: 网关是统一入口，负责"路由+鉴权+限流+灰度+日志"，用 Spring Cloud Gateway 编程式配置，支撑拼多多百万 QPS 交易接入。
  analogy: 网关像大厦前台——来访者（请求）先登记（鉴权）、分流（路由）、限流（高峰排队）、记录（日志），统一入口管理。
  first_principle: 微服务拆分后需要统一入口处理横切关注点（鉴权/限流/灰度），避免每个服务重复实现。
  key_points:
  - 核心：路由+过滤器（前置/后置）+限流+熔断
  - 鉴权：JWT/Session 统一校验
  - 灰度：按 UID/版本路由（金丝雀发布）
  - 限流：Sentinel/Redis 令牌桶
first_principle:
  problem: 微服务后每个服务都需鉴权/限流/日志，如何统一？
  axioms:
  - 横切关注点重复
  - 需要统一入口
  - 配置要动态
  rebuild: 网关层统一处理（路由+鉴权+限流+灰度+日志）。
follow_up:
- 网关怎么灰度发布？——按 UID hash 路由到新版本实例（10% 流量）
- 网关挂了怎么办？——多实例 + SLB 兜底
- 网关怎么扛百万 QPS？——无状态+水平扩容+Redis 集中限流
memory_points:
- 网关：路由+鉴权+限流+灰度+日志
- 鉴权统一（JWT/Session）
- 灰度：按 UID/版本路由
- 无状态+水平扩容
---

# 【拼多多交易】网关怎么设计？怎么扛百万 QPS？

> JD 依据："接口网关"。

## 一、网关核心职责

```
请求 → 网关
   ├─ 路由（按路径转发到服务）
   ├─ 鉴权（JWT/Session 校验）
   ├─ 限流（令牌桶，保护后端）
   ├─ 灰度（金丝雀路由）
   ├─ 日志（访问日志/审计）
   └─ 熔断（保护自身）
```

## 二、Spring Cloud Gateway 配置

```yaml
spring:
  cloud:
    gateway:
      routes:
        - id: order-service
          uri: lb://order-service
          predicates: [Path=/api/order/**]
          filters:
            - name: RequestRateLimiter
              args: { redis-rate-limiter.replenishRate: 1000, burstCapacity: 2000 }
            - JwtAuth
            - GrayRelease
```

## 三、鉴权过滤器

```java
@Component
public class JwtAuthFilter implements GlobalFilter {
    public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
        String token = exchange.getRequest().getHeaders().getFirst("Authorization");
        if (!jwtUtil.verify(token)) {
            return unauthorized(exchange);
        }
        return chain.filter(exchange);
    }
}
```

## 四、灰度发布

```java
// 按 UID hash 路由到新版本（10% 流量）
public String route(String uid, String service) {
    if (Math.abs(uid.hashCode()) % 10 == 0) {
        return service + "-canary";  // 金丝雀实例
    }
    return service;  // 稳定版
}
```

## 五、限流

- 单 UID：防刷（每秒 10 次）
- 全局：保护总容量（每秒百万）
- 集群限流：Redis 集中算（避免单机偏差）

## 六、底层本质

网关本质是**"横切关注点的统一收口"**——把鉴权/限流/日志等通用功能从业务服务抽到入口层，让业务服务聚焦业务。

## 常见考点
1. **网关和服务网格区别**？——网关应用层（业务感知），服务网格基础设施层（Sidecar）。
2. **网关怎么扛高 QPS**？——无状态+水平扩容+异步非阻塞（WebFlux）。
3. **灰度怎么实现**？——按 UID/版本/header 路由到不同实例。
