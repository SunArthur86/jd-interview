---
id: pdd-ai-013
difficulty: L3
category: pdd-ai
subcategory: 微服务
tags:
- 拼多多
- AI 中台
- 微服务
- Spring Cloud Alibaba
- Nacos
- Sentinel
feynman:
  essence: Spring Cloud Alibaba 是"阿里开源的微服务全家桶"，Nacos（注册配置）/Sentinel（限流降级）/Seata（分布式事务）/Dubbo（RPC）/RocketMQ（消息），覆盖微服务全场景。
  analogy: 像连锁餐厅总部——门店（服务）登记到总部（Nacos），客诉多了限流（Sentinel），跨店结算统一对账（Seata）。
  first_principle: 微服务有注册发现/配置/限流/事务/网关/RPC 等通用需求，全家桶统一方案避免重复造轮子。
  key_points:
  - Nacos：服务注册 + 配置中心（推模式 + 长轮询）
  - Sentinel：流控/熔断/系统保护（滑动窗口）
  - Seata：AT/TCC/SAGA/XA 四种事务模式
  - Dubbo：高性能 RPC（Triple/HTTP2）
  - Gateway：网关（路由/限流/鉴权）
first_principle:
  problem: 微服务下服务怎么互相找、配置怎么管、异常怎么防雪崩？
  axioms:
  - 服务实例动态增减
  - 配置需要动态变更
  - 故障要隔离防扩散
  rebuild: 微服务全家桶（注册中心 + 配置中心 + RPC + 限流 + 事务 + 网关）。
follow_up:
  - Nacos 注册和配置区别？——注册发现服务地址，配置中心管配置；2.x 后订阅通知合并
  - Sentinel 和 Hystrix 区别？——Sentinel 流控/系统保护强，Hystrix 熔断隔离优（已停止维护）
  - Seata AT 模式原理？——SQL 解析生成反向 SQL（前镜像+后镜像），自动回滚
memory_points:
- Nacos：注册+配置（推/长轮询）
- Sentinel：流控/熔断/系统保护
- Seata：AT/TCC/SAGA/XA
- Dubbo：高性能 RPC
---

# 【拼多多 AI 中台】Spring Cloud Alibaba 微服务体系怎么用？

> JD 依据："Java + RPC + MQ + 微服务"。

## 一、Spring Cloud Alibaba 全家桶

| 组件 | 功能 | 替代 |
|------|------|------|
| **Nacos** | 服务注册 + 配置中心 | Eureka + Apollo |
| **Sentinel** | 限流降级熔断 | Hystrix |
| **Seata** | 分布式事务 | — |
| **Dubbo** | RPC | Feign + Ribbon |
| **RocketMQ** | 消息队列 | RabbitMQ/Kafka |
| **Gateway** | 网关 | Zuul/Spring Cloud Gateway |

## 二、Nacos：注册中心 + 配置中心

### 1. 服务注册发现
```
服务启动 → 注册到 Nacos（IP:port + 元数据）
消费方 → 从 Nacos 拉服务列表 → 本地缓存 → 负载均衡调用
健康检查：心跳（5s），15s 未心跳摘除
```

### 2. 配置中心
```java
@RefreshScope
@RestController
public class ModelConfig {
    @Value("${llm.model}") String model;       // 配置变更自动刷新
    @NacosConfigListener(dataId = "llm.json")
    public void onCfg(String cfg) { reload(cfg); }
}
```

**推模式**：配置变更 → Nacos 主动推送 → 业务感知（实时）。

## 三、Sentinel：限流降级

```
QPS 超 100 → 限流（拒绝/排队/降级）
异常率 > 50% → 熔断（5s 内拒绝）
RT > 500ms → 慢调用熔断
系统负载高 → 系统保护（CPU/Load）
```

```java
@SentinelResource(value = "chat",
    blockHandler = "chatBlocked",          // 限流处理
    fallback = "chatFallback")             // 异常降级
public String chat(String q) {
    return llmClient.invoke(q);
}

public String chatBlocked(String q, BlockException e) {
    return "系统繁忙，稍后再试";              // 限流兜底
}
```

**规则**：
- 流控（QPS/并发线程数）
- 熔断（异常比例/异常数/慢调用比例）
- 热点（按参数限流，如单 UID）
- 系统（Load/CPU/RT）

## 四、Dubbo：高性能 RPC

```java
// 服务端
@DubboService
public class ModelServiceImpl implements ModelService {
    public PredictResult predict(Feature f) { ... }
}

// 客户端
@DubboReference
private ModelService modelService;
PredictResult r = modelService.predict(feature);
```

**优势**：
- Triple 协议（基于 HTTP/2，兼容 gRPC）
- 高性能序列化（Hessian/Protobuf）
- 服务治理（路由/负载/集群容错）

## 五、Seata：分布式事务

| 模式 | 原理 | 适用 |
|------|------|------|
| **AT**（默认） | SQL 反向解析自动回滚，无侵入 | 大部分业务（强一致） |
| **TCC** | Try-Confirm-Cancel 业务自定义 | 资金/库存（高一致） |
| **SAGA** | 长事务补偿 | 跨多服务长流程 |
| **XA** | DB 原生 XA | 跨多 DB |

**AT 模式**：
```
1. 全局事务注册（TC 分配 XID）
2. 分支事务：执行 SQL + 记录前后镜像 → 本地事务提交 + 存 undo_log
3. 全局提交：删 undo_log
4. 全局回滚：用 undo_log 反向 SQL 回滚
```

```java
@GlobalTransactional
public void placeOrder(Order order) {
    orderService.create(order);          // DB1
    inventoryService.deduct(order);      // DB2
    couponService.use(order);            // DB3
    // 任一失败全局回滚
}
```

## 六、Gateway：API 网关

```yaml
spring:
  cloud:
    gateway:
      routes:
        - id: llm-service
          uri: lb://llm-service          # 负载均衡
          predicates:
            - Path=/api/llm/**
          filters:
            - name: RequestRateLimiter   # 限流
              args: { redis-rate-limiter.replenishRate: 100 }
            - StripPrefix=2
```

**网关职责**：路由、鉴权、限流、日志、协议转换、灰度。

## 七、AI 中台微服务拓扑

```
                    网关（Gateway）
                         │
       ┌────────┬────────┼────────┬────────┐
       ▼        ▼        ▼        ▼        ▼
   推理服务  特征服务  实验服务  规则服务  监控服务
       │        │        │        │        │
       └────────┴────────┼────────┴────────┘
                        │
                  Nacos（注册+配置）
                        │
                  MySQL/Redis/HBase/Kafka
```

## 八、底层本质

Spring Cloud Alibaba 本质是**"微服务通用能力的标准化封装"**——把注册/配置/限流/事务/RPC/网关这些通用需求做成组件，业务聚焦逻辑。AI 中台用它把推理/特征/实验/规则各能力拆成独立服务，统一治理。

## 常见考点

1. **Nacos 1.x vs 2.x**？——2.x 长连接（gRPC）替代短轮询，配置推送更实时、连接数提升 10 倍。
2. **Sentinel 滑动窗口怎么实现**？——LeapArray（每样本窗口一个 Bucket，时间轮），统计时合并多个窗口。
3. **微服务怎么灰度**？——网关按 header（uid/tag）路由 + Nacos 元数据 + Dubbo Tag 路由。
