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

## 苏格拉底式面试追问

> 这组追问不背答案，模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：你们推理网关用 Spring Cloud Gateway + Nacos。但推理服务（vLLM）是无状态的 HTTP/gRPC 服务，为什么还需要注册中心？不能直接配 IP + 负载均衡（Nginx）吗？**

推理服务的"无状态"特性更需要注册中心，因为实例频繁变动。第一，**弹性扩缩**——推理服务按流量弹性（白天 10 个实例，大促 50 个实例），K8s HPA 动态创建/销毁 Pod，IP 时刻在变，Nginx 的静态 upstream 配置跟不上，必须用注册中心动态发现。第二，**健康检查**——推理服务可能"进程活着但 GPU 挂了"（CUDA OOM 后服务僵死），Nacos 的心跳机制 + 自定义健康检查（`/health` 接口检查 GPU 可用性）能自动剔除故障实例，Nginx 的被动健康检查（请求失败才标记 down）反应慢。第三，**元数据路由**——推理服务有多种规格（A100 实例、L4 实例），Nacos 的 metadata（`gpu_type=A100`）让网关按 GPU 类型路由（大模型走 A100，小模型走 L4），Nginx 做不到基于元数据的路由。注册中心是"动态拓扑 + 智能路由"的基础设施。

### 第二层：证据与定位

**Q：Dubbo 调用推理服务报 `No provider available`。但 Nacos 控制台显示服务实例是健康的（5 个实例在线）。为什么调用方找不到 provider？**

三个方向排查。第一，**分组/版本不匹配**——Dubbo 调用要匹配 `group` + `version` + `interface`，provider 注册的是 `group=inference, version=2.0`，consumer 调用的是 `group=inference, version=1.0`，版本不一致 Nacos 过滤掉了。检查 `@DubboReference` 的 group/version 配置。第二，**Tag 路由过滤**——如果用了 Dubbo Tag 路由（灰度），consumer 带 `dubbo.tag=gray`，但 5 个实例里只有 1 个注册了 `gray` tag（其他 4 个是 `stable`），且那个 gray 实例刚好在重启，就会报 no provider。检查 Nacos 实例的 metadata 里的 `dubbo.tags`。第三，**订阅延迟**——Nacos 2.x 是长连接推模式，但 consumer 刚启动时订阅还没完成（push 有 100-500ms 延迟），如果第一个请求在这期间发出，会报 no provider。用 `nacos.log` 看订阅完成时间戳，对比请求时间。定位命令：`curl 'http://nacos:8848/nacos/v1/ns/instance/list?serviceName=inference-service'` 看实际注册的实例和 metadata。

### 第三层：根因深挖

**Q：你定位到是"灰度路由"的问题——网关把 10% 流量打了 gray tag，但 gray 实例只有 1 个（2 个在扩容中）。结果 10% 流量全打到 1 个实例，P99 延迟飙到 5 秒。这个灰度策略设计有什么问题？**

根因是"灰度流量比例和灰度实例数不匹配"。灰度的正确逻辑是"实例容量匹配流量比例"：如果总流量需要 10 个实例（每个扛 10%），灰度 10% 流量就需要 1 个实例（10% × 10 = 1）。但这里的问题是"灰度实例扩容中"，实际容量只有预期的一半（1 个 vs 2 个），导致单实例过载。解法：第一，**容量预留**——灰度前先扩好 gray 实例（确保 gray 实例数 >= 灰度流量比例 × 总实例数），K8s 的 `readinessProbe` 确保实例就绪后才打 gray tag。第二，**流量按容量分配**——不要硬编码"10% 流量走 gray"，而是按"gray 实例数 / 总实例数"动态算流量比例（2 gray / 20 total = 10%），实例扩缩时自动调整。第三，**Sentinel 熔断兜底**——gray 实例设限流（单实例 QPS 上限），超限的请求 fallback 到 stable（降级而非超时），保证 P99 不崩。

**Q：那为什么不直接用"蓝绿发布"（Blue-Green）替代灰度？蓝绿是切流量（10% → 50% → 100%），不是更简单吗？**

蓝绿和灰度的区别是"切换粒度"。**蓝绿发布**：准备一套完整的 Green 环境（10 个实例），流量从 Blue（旧版）整体切到 Green（新版），回滚是切回 Blue。优点是简单（整切）、隔离彻底（Blue/Green 互不影响）；缺点是**资源翻倍**（要同时维持 Blue 和 Green 各 10 个实例，20 个实例的成本）。**灰度发布**：新旧版本共用资源池，按比例分流（1 gray + 9 stable），逐步调比例。优点是**省资源**（总实例数不变）；缺点是**隔离弱**（gray 实例挂了影响整条链路）。**推理服务的选型**：GPU 实例昂贵（H100 时租几十元），蓝绿要 2 倍 GPU 成本，不划算；灰度更经济。但"重大版本升级"（比如换模型基座）用蓝绿（隔离风险），"小迭代"（Prompt 调整）用灰度（省成本）。两者不是替代，是按风险等级选择。

### 第四层：方案权衡

**Q：Sentinel 的流控规则你们怎么配？比如推理服务单实例 QPS 上限是 100，你配 QPS=100 还是 QPS=80？**

配 QPS=80（留 20% 安全边界）。第一，**压测基线**——单实例极限 QPS 是 120（压测到 P99=1s 的拐点），但生产不能贴着极限跑（突发流量会超限），配 80（极限的 67%）留 buffer 给突发。第二，**流控策略**——用"快速失败"（超过 QPS 直接拒绝返回 fallback），而不是"排队等待"（请求排队等 GPU 算，延迟飙升）。推理场景宁可拒绝（用户重试）也不要超时（用户等 10 秒后失败，体验更差）。第三，**分级流控**——不是单一 QPS 限制，而是分级：`GPU_UTILIZATION > 85%` 时拒新请求（系统保护规则）、`QPS > 80` 时拒绝（流控规则）、`P99 > 2s` 时熔断（熔断规则）。三个维度交叉，单一 QPS 限制不够。第四，**热点参数限流**——按 `model_id` 限流（大模型 QPS 50，小模型 QPS 200），而不是统一 QPS，因为不同模型消耗的 GPU 资源不同。

**Q：Sentinel 和 Hystrix 都能熔断，为什么选 Sentinel？Hystrix 不是更成熟吗（Netflix 出品）？**

Hystrix 已停止维护（2018 年 Netflix 宣布不再更新），Sentinel 是阿里维护的（Alibaba OSS，持续迭代）。**Sentinel 的优势**：第一，**流控能力强**——Sentinel 支持 QPS 限流、并发线程数限流、关联资源限流（A 限流影响 B）、热点参数限流（按参数值差异化限流），Hystrix 只支持熔断（没有细粒度流控）。第二，**系统自适应保护**——Sentinel 监控 CPU 使用率、Load、RT、入口 QPS，自动判断"系统是否过载"并降级，Hystrix 没有这个能力。第三，**控制台可视化**——Sentinel Dashboard 实时看 QPS、拒绝数、RT，动态调整规则（不用重启），Hystrix Dashboard 只能看（不能改规则）。**Hystrix 的优势**——隔离机制成熟（信号量/线程池隔离），请求隔离更彻底。**生产选择**——新项目用 Sentinel（维护活跃 + 功能全），老项目（已用 Hystrix）保持不动（稳定优先）。两者不是非此即彼，Sentinel 也能集成 Hystrix 的隔离思路。

### 第五层：验证与沉淀

**Q：你怎么证明灰度发布的"实例容量匹配流量比例"策略真的避免了过载？**

三个指标对照。第一，**gray 实例负载**——灰度期间监控 gray 实例的 `cpu_usage_p99`、`gpu_utilization_p99`、`latency_p99`，优化前（流量比例固定 10%）gray 实例 GPU 利用率 95%（过载），优化后（按实例数动态算比例）gray 实例 GPU 利用率 70%（健康）。第二，**fallback 率**——监控 Sentinel 的 `blocked_request_rate`（被限流/熔断的请求比例），优化前 gray 的 fallback 率 15%（过载后大量拒绝），优化后 < 1%。第三，**P99 延迟**——优化前 gray 实例 P99=5s（过载排队），优化后 P99=300ms（正常）。三个指标一致改善，证明策略生效。A/B 验证：新旧策略各灰度一批变更（比如 10 次模型迭代），统计"灰度期间故障次数"（过载导致的 fallback/告警），新策略故障率应降 80%+。

**Q：微服务治理的经验怎么沉淀成团队规范？**

三件事。第一，**灰度发布 SOP**——标准化灰度流程：扩容 gray 实例 → 标记 readiness → 按实例数算流量比例 → 渐进放量（1%→5%→20%→100%，每档观察 30 分钟）→ 全量后清理 gray tag。每次灰度按 SOP 执行，避免人为失误。第二，**Sentinel 规则模板**——按服务类型（推理/特征/网关）预设流控模板（推理：QPS=80 + GPU>85% 拒绝 + P99>2s 熔断；特征：QPS=5000 + P99>100ms 熔断），新服务上线套模板，不重复调参。第三，**故障复盘库**——每次微服务故障（No provider、超时、雪崩）记录根因和解法，形成"故障案例库"，团队定期 review，避免同类问题重复犯。治理不是"一次性配好"，而是"持续迭代的工程纪律"。

## 结构化回答

**30 秒电梯演讲：** 微服务下服务怎么互相找、配置怎么管、异常怎么防雪崩？简单说就是——Spring Cloud Alibaba 是"阿里开源的微服务全家桶"，Nacos（注册配置）/Sentinel（限流降级）/Seata（分布式事务）/Dubbo（RPC）/Ro…。

**展开框架：**
1. **Nacos** — Nacos：服务注册 + 配置中心（推模式 + 长轮询）
2. **Sentinel** — Sentinel：流控/熔断/系统保护（滑动窗口）
3. **Seata** — Seata：AT/TCC/SAGA/XA 四种事务模式

**收尾：** 您想继续往深里聊吗——比如「Nacos 注册和配置区别？」

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：Spring Cloud Alibaba 微服务体系怎么用？ | 今天聊「Spring Cloud Alibaba 微服务体系怎么用？」。一句话：Spring Cloud Alibaba 是"阿里开源的微服务全家桶"，Nacos（注册配置）/Sentinel（限流… | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：Nacos：服务注册 + 配置中心（推模式 + 长轮询） | 核心概念 |
| 1:04 | 能力/参数拆解表 | 要点是：Sentinel：流控/熔断/系统保护（滑动窗口） | 能力拆解 |
| 1:56 | 流程图：输入→处理→输出 | 要点是：Seata：AT/TCC/SAGA/XA 四种事务模式 | 关键机制 |
| 3:00 | 总结卡 + 下期预告 | 记住这些核心点就够了。下期我们接着聊——Nacos 注册和配置区别？。 | 收尾 |
