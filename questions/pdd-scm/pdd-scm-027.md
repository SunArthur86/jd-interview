---
id: pdd-scm-027
difficulty: L3
category: pdd-scm
subcategory: 限流
tags:
- 拼多多
- 供应链
- 高可用
- 限流
- 降级
- 超时重试
feynman:
  essence: 限流在入口截流（防过载）、降级在故障兜底（保核心）、超时重试在调用层保护（防级联），三者是高可用"防御工事"。
  analogy: 像城市防洪——限流是水闸（控进水）、降级是应急通道（保命）、超时重试是检查站（快速失败不死等）。
  first_principle: 系统容量有限、故障必然，主动防御（限流）+ 故障兜底（降级）+ 边界保护（超时重试）。
  key_points:
  - 限流：令牌桶（突发）/ 漏桶（匀速）/ 滑动窗口
  - 降级：兜底返回、关闭非核心、读旧数据
  - 超时：连接/读/总，必须分级
  - 重试：幂等前提、指数退避、限次数
first_principle:
  problem: 资源有限、下游可能挂、网络会抖，如何让系统在压力下仍提供核心服务？
  axioms:
  - 入口流量不可控
  - 下游不可控
  - 资源有上限
  rebuild: 限流控入口 + 超时控等待 + 重试应对抖动 + 降级保核心。
follow_up:
- 令牌桶和漏桶区别？——令牌桶允许突发（攒令牌），漏桶强制匀速
- 重试风暴怎么防？——指数退避 + 抖动 + 熔断器
- 供应链超时怎么分级？——总 200ms，分到各下游 30-50ms
memory_points:
- 限流（令牌桶/漏桶/滑动窗口）+ 降级（兜底）+ 超时（分级）+ 重试（幂等+退避）
- 令牌桶突发、漏桶匀速
- 重试必须幂等 + 指数退避 + 限次数 + 配熔断
- 超时：总 < 用户容忍，下游 < 上游
---

# 【拼多多供应链】高可用三件套（限流/降级/超时重试）怎么设计？

> JD 依据："线上系统稳定性和维护经验"。

## 一、限流

**令牌桶**（允许突发）：
```
固定速率放令牌（1000/s），请求拿令牌，无则拒绝
桶满丢新令牌 → 允许攒令牌应对突发
```

**漏桶**（匀速）：
```
请求入桶，恒定速率漏出（处理）
水满拒绝 → 强制匀速
```

**Sentinel 配置**：
```java
@SentinelResource(value = "query_product", blockHandler = "fallback")
public Product query(long id) { ... }
```

## 二、降级

```java
public Product query(long id) {
    try {
        return productService.get(id);          // 正常
    } catch (Exception e) {
        return cachedProduct(id);                // 降级：读缓存
    }
}
// 极端：return Product.default();               // 兜底默认
```

降级开关（配置中心一键）：
```java
@NacosValue("${scm.degrade.recommend:false}", autoRefreshed = true)
private boolean degradeRecommend;
```

## 三、超时分级

```yaml
feign:
  client:
    config:
      default: { connect-timeout: 1000, read-timeout: 2000 }
      product-service: { read-timeout: 50 }      # 严格下游
```

## 四、重试

```java
@Retryable(maxAttempts = 3, backoff = @Backoff(delay = 100, multiplier = 2))
public Product callProduct(long id) { ... }
```

**幂等前提**：非幂等（扣款）不能盲目重试，需业务幂等 token。

## 五、供应链实战

```
商品详情请求:
  ├─ 网关限流（单 UID 10/s）
  ├─ 超时分级（商品 50ms / 库存 30ms / 评价 50ms）
  ├─ 评价服务挂 → 降级隐藏评价模块
  └─ 全挂 → 兜底返回基础商品信息
```

## 六、底层本质

高可用三件套承认**"故障必然"**，从被动应对转主动防御：
- 限流：保护自己边界
- 超时重试：防被外界拖死
- 降级：故障时保核心价值

## 常见考点
1. **熔断和限流区别**？——限流主动（按 QPS 拒绝）；熔断被动（按失败率切断）。
2. **重试风暴**？——上游重试放大下游压力 → 必须配熔断器。
3. **降级和熔断关系**？——熔断触发降级（熔断后走 fallback）。
