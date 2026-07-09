---
id: pdd-content-013
difficulty: L3
category: pdd-content
subcategory: Spring Cloud
tags:
- 拼多多
- 内容
- Spring Cloud
- Feign
- 微服务
- 服务治理
feynman:
  essence: Spring Cloud 用 Feign（声明式 RPC）+ Ribbon/LoadBalancer（负载）+ Sentinel/Hystrix（熔断限流）+ Nacos/Eureka（注册）组合，是微服务治理套件。
  analogy: Spring Cloud 像城市基础设施——Feign 是出租车（声明去哪）、注册中心是电话簿、熔断是保险丝、网关是收费站。
  first_principle: 微服务之间需要"调用+发现+容错+监控"，Spring Cloud 提供一套标准化方案。
  key_points:
  - 注册发现：Nacos/Eureka
  - 声明式调用：Feign（接口注解）
  - 负载均衡：Ribbon/LoadBalancer
  - 熔断限流：Sentinel/Hystrix
  - 网关：Spring Cloud Gateway
first_principle:
  problem: 微服务间如何优雅调用+发现+容错？
  axioms:
  - 服务地址动态变化
  - 远程调用会失败
  - 调用要简单（透明）
  rebuild: 注册中心+声明式 RPC+负载+熔断。
follow_up:
  - Feign 超时怎么配？——connectTimeout/readTimeout 区分建链和读取
  - 熔断和限流区别？——熔断是保护自己（下游挂了不调用），限流是保护自己（请求太多拒绝）
  - Nacos 和 Eureka 区别？——Nacos AP/CP 双模式+配置中心一体
memory_points:
  - 注册：Nacos
  - 调用：Feign（接口）
  - 负载：LoadBalancer
  - 熔断：Sentinel
  - 网关：Gateway
---

# 【拼多多内容】Spring Cloud + Feign 服务治理（内容中台）？

> JD 依据："Spring"、"微服务"、"新媒体业务平台"。

## 一、Spring Cloud 全家桶

| 能力 | 组件（主流） |
|------|--------------|
| 注册发现 | Nacos / Eureka / Consul |
| 配置中心 | Nacos / Apollo / Config |
| 声明式 RPC | OpenFeign |
| 负载均衡 | LoadBalancer / Ribbon |
| 熔断限流 | Sentinel / Resilience4j |
| 网关 | Spring Cloud Gateway / Zuul |
| 链路追踪 | Sleuth + Zipkin / SkyWalking |
| 分布式事务 | Seata |

## 二、Feign 声明式 RPC

```java
// 定义接口（不需要写实现）
@FeignClient(name = "review-service", fallback = ReviewClientFallback.class)
public interface ReviewClient {
    @GetMapping("/reviews/{id}")
    Review getReview(@PathVariable Long id);

    @PostMapping("/reviews")
    Review createReview(@RequestBody ReviewDTO dto);
}

// 降级（服务挂时返回默认）
@Component
public class ReviewClientFallback implements ReviewClient {
    @Override
    public Review getReview(Long id) {
        return Review.defaultReview();   // 兜底
    }
}

// 使用（像本地方法一样调用）
@Autowired ReviewClient reviewClient;
reviewClient.getReview(1L);
```

## 三、调用流程

```
业务调用 reviewClient.getReview(1)
   ↓
Feign 动态代理 → 拼装 HTTP 请求（基于注解）
   ↓
LoadBalancer 从注册中心拉 review-service 实例列表
   ↓
选一个实例（轮询/权重/最少连接）
   ↓
Sentinel 检查熔断/限流
   ↓
发起 HTTP（OkHttp/HttpClient）→ 远程服务
   ↓
失败重试 / 降级
```

## 四、内容中台服务架构

```
                       ┌─ Spring Cloud Gateway ─┐
                       │   认证/限流/路由         │
                       └───────────┬─────────────┘
                                   │
        ┌──────────────┬───────────┼─────────────┬───────────────┐
        ▼              ▼           ▼             ▼               ▼
   评价服务       直播服务     Feed 服务      搜索服务       内容审核服务
   (review)      (live)       (feed)         (search)       (audit)
        │              │           │             │               │
        └──────────┬───┴───────────┴─────────────┴───────────────┘
                   ▼
            Nacos（注册+配置）
            MySQL/Redis/ES/Kafka
```

## 五、Feign 实战配置

```yaml
feign:
  client:
    config:
      default:
        connectTimeout: 1000       # 建链 1s
        readTimeout: 3000          # 读取 3s
        loggerLevel: BASIC
  hystrix:
    enabled: true                  # 启用降级
  compression:
    request:
      enabled: true
      mime-types: application/json
      min-request-size: 2048       # >2KB 压缩
```

**调用链路优化**：
```java
// 1. 设超时（不拖累调用方）
// 2. 设降级（fallback 返回兜底数据）
// 3. 设重试（GET 幂等可重试，POST 不重试）
// 4. 设压缩（大请求体）
// 5. 设连接池（替代每次 new Connection）
```

## 六、Sentinel 熔断限流

```java
@SentinelResource(value = "getReview",
    blockHandler = "blockHandler",       // 限流降级
    fallback = "fallback")                // 异常降级
public Review getReview(Long id) {
    return reviewClient.getReview(id);
}

public Review blockHandler(Long id, BlockException e) {
    return Review.defaultReview();        // 限流时返回默认
}
```

**熔断策略**：
- 慢调用比例：>RT 阈值的比例 >50% 触发熔断
- 异常比例：异常率 >50% 触发
- 异常数：异常数 >N 触发

## 七、底层本质

Spring Cloud 本质是**"用一套注解+组件把微服务治理标准化"**——Feign 让 RPC 像本地调用、注册中心做服务发现、Sentinel 做熔断限流、Gateway 做统一入口。

## 常见考点
1. **Feign 怎么实现**？——JDK 动态代理 + 注解解析 + HTTP 客户端。
2. **熔断器状态机**？——Closed（正常）→ Open（熔断）→ Half-Open（探测）→ Closed/Reopen。
3. **网关和反向代理（Nginx）区别**？——网关有业务能力（鉴权/限流/灰度），Nginx 偏流量分发。
