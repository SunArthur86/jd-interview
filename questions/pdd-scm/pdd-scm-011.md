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

## 苏格拉底式面试追问

> 这组追问不是背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：供应链从单体拆成商品/库存/订单等 7 个微服务。拆分的依据是什么？为什么不拆成 70 个更细粒度的服务？**

拆分依据是 DDD 限界上下文 + 团队规模（康威定律）：
1. **限界上下文对齐**——商品、库存、订单各自有独立的领域模型和业务规则（商品的 SPU/SKU 模型 vs 订单的状态机模型），边界天然清晰，拆开独立演进。
2. **团队所有权**——7 个服务对应 7 个团队（约 5-8 人/团队），一个团队 owning 1-2 个服务，职责清晰。拆 70 个意味着团队要拆到 0.5 人/服务，违反"两个披萨团队"原则。
3. **避免过度拆分**——70 个服务的代价是 RPC 调用链爆炸（一次下单要调 10+ 服务）、分布式事务复杂度指数上升、Nacos 注册压力大。7 个是"高内聚低耦合"和"运维成本"的平衡点。

### 第二层：证据与定位

**Q：订单服务调用库存服务的 Feign 接口间歇性超时（P99 抖动）。你怎么定位是网络、库存服务慢，还是注册中心路由到慢实例？**

四步排查：
1. **看 Feign 调用链**——APM（如 SkyWalking/Jaeger）看 `order→inventory` 这一段的 trace，如果 span 显示"调用发起→响应"耗时长，是库存服务处理慢（看库存服务自身的 DB/Redis 耗时）；如果"发起→建立连接"慢，是网络或 LB 选实例慢。
2. **看库存服务实例列表**——`nacos-cli` 查 inventory-service 注册的实例，如果有的实例 `healthy=false` 还在被路由，是健康检查没生效，LB 选中了半死实例。
3. **看 GC 日志**——库存服务的某个实例如果频繁 Full GC（jstat -gcutil），处理请求会卡顿，LB 轮询到它就超时。
4. **看 LB 策略**——如果用轮询（RoundRobin），慢实例会拖低整体 P99；改用"加权响应时间"（如 NacosWeightedRule）让慢实例少被选中。

### 第三层：根因深挖

**Q：定位后发现是库存服务某个实例 Full GC 频繁导致超时。根因是 GC 参数不对还是别的？**

先看 GC 原因再下结论。`jstat -gccause <pid>` 看 GC 原因：
1. **Allocation Failure**——老年代不够，看 `jmap -histo:live` 是不是大对象。库存服务的真实案例是 `stock_log` 缓存用 HashMap 无上限，囤了 2GB 数据，每次 Minor GC 晋升老年代，最终撑爆。根因是缓存无上限，不是 GC 参数。
2. **System.gc()**——某些框架（如 Netty 的 DirectByteBuffer 释放）会主动调 System.gc()，触发 Full GC。加 `-XX:+DisableExplicitGC` 禁用。
3. **Metaspace 满**——动态生成 Class（如反射/CGLIB）撑爆元空间，`-XX:MaxMetaspaceSize=256m` 限制。看 `jstat -gcutil` 的 M 列是否 99%。
定位根因后对症下药，盲目调 `-XX:+UseG1GC` 或加大堆是掩耳盗铃。

**Q：那为什么不直接把这个慢实例从注册中心摘掉（手动下线），最快恢复？**

摘掉能临时止血，但有风险：
1. **容量不足**——如果库存服务只有 3 个实例，摘掉 1 个剩 2 个，每个扛的 QPS 涨 50%，可能连锁打挂剩下 2 个（雪崩）。
2. **掩盖根因**——摘掉后 GC 问题没解决，这个实例重启或换一台照样犯。
正确做法：先定位是 GC 还是别的，如果是 GC，用 `jcmd <pid> GC.heap_dump` dump 后重启（清空异常缓存），实例恢复后再分析 dump 修根因。摘实例只在"确认有冗余容量"时做。

### 第四层：方案权衡

**Q：Feign 调用库存服务，你配了 Sentinel 熔断器。但大促时库存服务 RT 从 10ms 涨到 500ms，熔断器没触发，订单服务线程池却被拖垮了。为什么？**

根因是熔断阈值配的是"异常比例"（`rt` 触发没配），库存服务虽然慢但没报错，熔断器看的是异常率 = 0，不熔断。解法：
1. **配慢调用熔断**——Sentinel 的 `SlowRequestTrigger`，RT > 300ms 计入慢调用，慢调用比例 > 50% 就熔断（`grade=RT`）。
2. **配 Feign 超时**——`feign.client.config.default.connect-timeout=1000, read-timeout=200`，库存服务超 200ms 直接超时失败，走 fallback 降级，不让线程被占用。
3. **线程池隔离**——Feign 调用用独立线程池（如 `bulkhead` 模式，库存调用池 size=50），打满后快速拒绝（fail-fast），不拖垮订单服务的主线程池。

**Q：为什么不直接把熔断阈值调得很敏感（RT > 50ms 就熔断），保护订单服务？**

调太敏感会误杀正常波动：
1. **误熔断**——大促时正常的库存扣减 RT 本来就会涨到 50-80ms（锁竞争），50ms 阈值会把正常请求也熔断，fallback 大量触发，用户体验差。
2. **雪崩到 fallback**——fallback 如果是"返回默认库存"，大量请求拿到错误库存可能导致下单后超卖。
所以阈值要基于历史 P99 定：平时 P99 是 20ms，阈值设 200ms（10 倍），既能挡住真正的慢调用（500ms+），又容忍正常波动。配合超时 + 线程池隔离多层保护。

### 第五层：验证与沉淀

**Q：你怎么证明微服务拆分后系统的可用性真的提升了、不是引入了更多故障点？**

两个核心指标：
1. **可用性 SLA**——拆分前单体年故障时间 8760h × 0.1% = 87h，拆分后各服务 SLA 99.9%，但 7 个服务串联（一次下单要调全），理论可用性 0.999^7 = 99.3%，反而下降。所以必须配合熔断/降级/重试，让"单服务挂不影响核心链路"。监控 `order_create_success_rate`，单服务故障时核心链路成功率 > 99%（靠降级）。
2. **故障恢复时间 MTTR**——拆分后单服务故障定位更快（看该服务的日志/监控），MTTR 从单体的 1 小时降到 15 分钟。

**Q：怎么让团队拆微服务时遵循统一规范（命名/治理/可观测性）？**

沉淀微服务脚手架：
1. **服务模板**——`scm-service-archetype` 生成标准服务（内置 Nacos 注册、Gateway 网关接入、Sentinel 熔断、Micrometer 监控、统一日志格式），新建服务基于模板，不重复造轮子。
2. **服务治理清单**——新服务上线必须过：注册健康检查（/actuator/health）、熔断配置、限流配置、日志接 ELK、监控接 Prometheus、链路追踪接 SkyWalking，缺一不可上线。
3. **服务依赖图**——用 `jqassistant` 扫描 Feign/Dubbo 调用关系，画依赖图，定期 review 是否有循环依赖或过度调用，防止"分布式大泥球"。

## 结构化回答

**30 秒电梯演讲：** 单体拆成几十个微服务后，如何让它们互相发现、统一入口、动态配置？简单说就是——Spring Cloud 微服务靠"注册中心（Nacos，服务发现）+ 网关（Gateway。

**展开框架：**
1. **Nacos** — Nacos：AP（临时实例，Distro）+ CP（持久实例，Raft）；注册+配置一体
2. **Gateway** — Gateway：路由 + 过滤 + 限流
3. **Feign** — Feign：声明式 HTTP，集成 LoadBalancer + Sentinel

**收尾：** 您看这块要不要再展开聊聊？

## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：Spring Cloud 微服务怎么落地？供应链怎么拆？ | 今天聊「Spring Cloud 微服务怎么落地？供应链怎么拆？」。一句话：Spring Cloud 微服务靠"注册中心（Nacos，服务发现）+ 网关（Gateway | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：Nacos：AP（临时实例，Distro）+ CP（持久实例，Raft）；注册+配置一体 | 核心概念 |
| 1:00 | 能力/参数拆解表 | 要点是：Gateway：路由 + 过滤 + 限流 | 能力拆解 |
| 2:00 | 总结卡 + 下期预告 | 记住核心要点就够了。下期见。 | 收尾 |
