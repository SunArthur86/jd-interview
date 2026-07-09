---
id: pdd-trade-011
difficulty: L2
category: pdd-trade
subcategory: Spring Cloud
tags:
- 拼多多
- 交易
- Feign
- 服务调用
- 负载均衡
feynman:
  essence: Feign 把"远程 HTTP 调用"伪装成"本地方法调用"，底层封装动态代理+负载均衡+熔断+重试，让交易链路（订单→库存→支付）开发像单体。
  analogy: Feign 像快递——你只管把包裹（参数）给快递员（代理），不用关心走哪条路、用什么车。
  first_principle: 远程调用本质是序列化+网络+反序列化，复杂度高；包装成本地调用降低使用成本。
  key_points:
  - 动态代理拦截 + LoadBalancer 选实例 + HTTP 调用
  - 集成 Sentinel（熔断）/ Retryer（重试）
  - RequestInterceptor 传上下文（traceId）
  - fallback 降级
first_principle:
  problem: 微服务间调用如何像本地方法一样简单，底层治理（熔断/重试/负载）透明？
  axioms:
  - 业务不应感知分布式细节
  - 网络不可靠
  - 需要统一治理
  rebuild: 动态代理封装"寻址→负载→调用→失败处理"，业务像调本地。
follow_up:
- Feign 怎么传 TraceId？——RequestInterceptor 塞 header，线程池要装饰
- Feign 超时怎么配？——connectTimeout + readTimeout，按服务细分
- Feign 和 Dubbo 区别？——Feign HTTP 通用；Dubbo TCP 高性能
memory_points:
- Feign = 动态代理 + HTTP + LoadBalancer + Sentinel
- RequestInterceptor 传 traceId
- fallback 降级、Retryer 重试
- Feign 通用 / Dubbo 高性能
---

# 【拼多多交易】Feign 怎么用？服务间调用怎么治理？

> JD 依据："熟悉 RPC/MQ"。

## 一、Feign 使用

```java
@FeignClient(name = "inventory-service", fallback = InventoryFallback.class)
public interface InventoryClient {
    @PostMapping("/deduct")
    Result deduct(@RequestBody DeductReq req);
}

@Autowired InventoryClient client;
Result r = client.deduct(req);  // 像本地方法
```

## 二、底层流程

```
调用 client.deduct()
   ↓ 动态代理拦截
   ↓ 解析注解构造 HTTP 请求
   ↓ LoadBalancer 选实例
   ↓ Sentinel 熔断检查
   ↓ HTTP 调用
   ↓ 失败 → 重试 / 熔断 / fallback
   ↓ 反序列化
```

## 三、上下文传递（TraceId）

```java
@Component
public class TraceInterceptor implements RequestInterceptor {
    public void apply(RequestTemplate t) {
        t.header("X-TraceId", MDC.get("traceId"));
        t.header("X-UID", RequestContext.getUid());
    }
}
```

线程池需装饰（否则 traceId 丢失）。

## 四、治理配置

```yaml
feign:
  sentinel: { enabled: true }
  client:
    config:
      default: { connect-timeout: 1000, read-timeout: 2000 }
      inventory-service: { read-timeout: 50 }  # 严格下游
```

## 五、降级

```java
@Component
public class InventoryFallback implements InventoryClient {
    public Result deduct(DeductReq req) {
        return Result.degrade("库存服务不可用");  // 降级返回
    }
}
```

## 六、底层本质

Feign 是**"位置透明性"**——让远程调用像本地。但分布式八谬误提醒这是"美丽谎言"，必须配超时/重试/熔断/降级。

## 常见考点
1. **Feign 怎么集成 Sentinel**？——`feign.sentinel.enabled=true` + fallback。
2. **Feign 和 Dubbo**？——Feign HTTP 通用可跨语言；Dubbo TCP+二进制高性能。
3. **超时怎么分级**？——总超时 < 用户容忍，各下游独立超时。
