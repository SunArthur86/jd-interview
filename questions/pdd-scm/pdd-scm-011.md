---
id: pdd-scm-011
difficulty: L2
category: pdd-scm
subcategory: Spring Cloud
tags:
- 拼多多
- 供应链
- Spring Cloud
- 注册中心
- Nacos
- 网关
feynman:
  essence: Spring Cloud 微服务靠"注册中心（Nacos，服务发现）+ 网关（Gateway，统一入口）+ 配置中心（Nacos，动态配置）+ RPC（Feign/Dubbo）"四件套串联，供应链拆成商品/库存/订单/结算等几十个服务。
  analogy: 微服务像把大公司拆成事业部——注册中心是通讯录（找部门在哪），网关是前台（统一入口），配置中心是制度公告栏（动态生效）。
  first_principle: 单体扛不住规模，拆微服务后需要"自动发现 + 统一入口 + 动态配置"的基础设施。
  key_points:
  - Nacos：AP（临时实例，Distro）+ CP（持久实例，Raft）；注册+配置一体
  - Gateway：路由 + 过滤 + 限流
  - Feign：声明式 HTTP，集成 LoadBalancer + Sentinel
  - AP vs CP：供应链选 AP（可用优先，短暂不一致可接受）
first_principle:
  problem: 单体拆成几十个微服务后，如何让它们互相发现、统一入口、动态配置？
  axioms:
  - 服务实例 IP 动态变化（扩缩容/故障）
  - 需要统一入口（鉴权/限流/日志）
  - 配置要能动态生效（不重启）
  rebuild: Nacos（服务注册+配置）+ Gateway（统一入口）+ Feign（声明式调用）。
follow_up:
- Nacos 和 Eureka 区别？——Nacos AP/CP 可选+配置中心一体；Eureka 只 AP
- 网关怎么做限流？——Sentinel/RequestRateLimiter（令牌桶，Redis 计数）
- 服务雪崩怎么防？——熔断（Sentinel）+ 降级（fallback）+ 超时
memory_points:
- Nacos：注册（AP/CP）+ 配置一体；2.x 用 gRPC 长连接推送
- Gateway：路由+过滤+限流，统一入口
- Feign：声明式 HTTP + 整合 LoadBalancer/Sentinel
- 客户端缓存实例列表，注册中心挂了仍可降级调用
---

# 【拼多多供应链】Spring Cloud 微服务怎么落地？供应链怎么拆？

> JD 依据："熟悉微服务框架"。

## 一、微服务四件套

```
┌──────────────────────────────────────┐
│           API Gateway（网关）        │  ← 统一入口、鉴权、限流
└──────────────────────────────────────┘
              ↓ 路由
┌──────────────────────────────────────┐
│        Nacos（注册中心+配置中心）    │  ← 服务发现 + 动态配置
└──────────────────────────────────────┘
              ↓ 发现
┌────────┬────────┬────────┬─────────┐
│ 商品   │ 库存   │ 订单   │ 结算    │  ← 微服务集群
│ 服务   │ 服务   │ 服务   │ 服务    │
└────────┴────────┴────────┴─────────┘
              ↕ Feign/Dubbo 调用
```

## 二、供应链微服务拆分

按 DDD 限界上下文拆：
```
商品服务（SPU/SKU/类目）
库存服务（现货/预售/冻结）
订单服务（下单/状态机）
采购服务（采购单/到货）
仓储服务（入库/出库/调拨）
结算服务（对账/发票）
物流服务（运单/轨迹）
```

## 三、Nacos 服务注册

```yaml
spring:
  cloud:
    nacos:
      discovery:
        server-addr: nacos-cluster:8848
        namespace: scm-prod
        cluster-name: SH            # 同机房优先路由
```

- AP 模式（临时实例）：客户端心跳维持，宕机即摘除
- CP 模式（持久实例）：服务端主动探测
- 2.x 用 gRPC 长连接，变更秒级推送

## 四、Gateway 网关

```yaml
spring:
  cloud:
    gateway:
      routes:
        - id: product
          uri: lb://product-service
          predicates: [Path=/api/product/**]
          filters:
            - name: RequestRateLimiter
              args: { redis-rate-limiter.replenishRate: 1000, burstCapacity: 2000 }
```

网关职责：路由、鉴权、限流、日志、跨域。

## 五、Feign 服务间调用

```java
@FeignClient(name = "inventory-service", fallback = InventoryFallback.class)
public interface InventoryClient {
    @PostMapping("/deduct")
    Result deduct(@RequestBody DeductReq req);
}
```

集成 LoadBalancer（负载均衡）+ Sentinel（熔断降级）。

## 六、底层本质

微服务的本质是**"用网络调用替代本地方法调用，换取独立部署和扩展"**。代价是分布式复杂性（网络不可靠、数据一致性、运维复杂）。Spring Cloud 把这些复杂性封装成组件，让业务代码像写单体一样写微服务。

## 常见考点
1. **Nacos AP 还是 CP**？——临时实例 AP（可用优先），持久实例 CP（一致优先）。
2. **网关和服务网格区别**？——网关是应用层（业务感知），服务网格是基础设施层（Sidecar，业务无感）。
3. **微服务一定好吗**？——不是，小团队/简单业务用单体更高效（微服务是规模化的产物）。
