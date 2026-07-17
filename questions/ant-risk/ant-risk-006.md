---
id: ant-risk-006
difficulty: L3
category: ant-risk
subcategory: Spring Cloud
tags:
- 蚂蚁
- 风控
- Spring Cloud
- 注册中心
- Nacos
- 服务发现
feynman:
  essence: 注册中心让"服务提供者"主动注册地址、"服务消费者"按名查询地址，用临时+持久实例、心跳续约、长轮询推送把分布式寻址变成 O(1) 名字查找。
  analogy: 注册中心像电话簿：服务方登记自己号码（注册），调用方查名字拿号码（发现）。号码变更自动通知（推送），欠费注销（心跳过期）。
  first_principle: 分布式系统里服务实例 IP 动态变化（扩容/宕机/迁移），调用方不能硬编码 IP，需要一个"名字→实例列表"的动态映射。
  key_points:
  - Provider 启动注册、关闭注销；Consumer 拉取订阅
  - 心跳续约（默认 5s）+ 摘除（默认 15s 未续约）
  - 临时实例（客户端心跳）vs 持久实例（服务端主动探测）
  - 推送：长轮询（Nacos 1.x）/ gRPC 流（Nacos 2.x）
  - AP（Eureka/Nacos 临时实例）vs CP（Zookeeper/Consul/Nacos 持久实例）
first_principle:
  problem: 在实例频繁上下线的分布式环境里，如何让调用方以 O(1) 代价拿到最新的目标实例列表？
  axioms:
  - 实例 IP 动态变化（弹性扩缩、故障）
  - 名字（服务名）是稳定的逻辑标识
  - 通知比轮询更高效
  rebuild: 引入"名字服务"组件——Provider 注册 IP+端口+元数据，Consumer 按名订阅，变更通过长连接推送。用 CAP 取舍决定 AP（可用优先）还是 CP（一致优先）。
follow_up:
- Eureka 和 Nacos 区别？——Eureka 只 AP 且无配置中心；Nacos 同时支持 AP/CP，集成配置
- 为什么风控选 Nacos 而不是 Zookeeper？——ZK 是 CP，主从切换时注册不可用；风控要求高可用，AP 的 Nacos 注册数据短暂不一致不影响调用
- 注册中心挂了能调用吗？——能，客户端会本地缓存实例列表，仍可调用（但拿不到新增/下线实例）
memory_points:
- AP vs CP：AP（Eureka/Nacos临时实例，可用优先）、CP（ZK/Consul/Nacos持久实例，一致优先）
- 临时实例=客户端心跳维持、宕机即摘除；持久实例=服务端探测、需主动注销
- Nacos 2.x 用 gRPC 长连接取代长轮询，推送延迟从秒级到亚秒
- 客户端缓存实例列表，注册中心宕机仍可降级调用
---

# 【蚂蚁风控】Spring Cloud 服务注册与发现原理？Nacos 为什么比 Eureka 更适合风控？

> JD 依据："Spring Cloud"。蚂蚁风控拆成几十个微服务（特征、规则、决策、画像），注册中心是基础设施。

## 一、表面层：注册中心解决什么问题

**硬编码 IP 的问题**：
```
风控决策服务 → http://10.0.0.5:8080/feature  // 实例扩容/迁移就失效
```

**注册中心解法**：
```
风控决策服务 → 查 Nacos: "feature-service" → [10.0.0.5:8080, 10.0.0.6:8080, ...]
                                                              ↓ 负载均衡
                                              选一个调用
```

## 二、核心流程：注册、续约、发现、摘除

```
Provider 启动
   │
   ├─→ POST /nacos/v1/ns/instance  (注册: IP+port+service+元数据)
   │
   ├─→ 每 5s PUT /instance/beat    (心跳续约)
   │
Provider 关闭
   │
   └─→ DELETE /instance           (注销)

Consumer 启动
   │
   ├─→ GET /instance/list?service=xxx (拉取实例列表)
   │
   └─→ 订阅（长轮询/gRPC 流）     (变更推送)

Nacos 服务端
   │
   ├─→ 15s 未收到心跳 → 标记不健康
   └─→ 30s 未收到心跳 → 摘除实例
```

## 三、AP vs CP：CAP 取舍（关键）

CAP 定理：分布式系统只能同时满足两个。

| 注册中心 | 模式 | 一致性策略 | 适用场景 |
|---------|------|----------|---------|
| **Zookeeper** | CP | ZAB 协议强一致；主从切换时注册不可用 | 强一致场景（分布式锁、配置） |
| **Consul** | CP（默认）/ AP | Raft | 偏运维 |
| **Eureka** | AP | 节点间异步复制，最终一致 | 云原生早期 |
| **Nacos**（临时实例） | **AP** | Distro 协议，节点间最终一致 | **微服务注册（推荐）** |
| **Nacos**（持久实例） | CP | Raft | 数据库/消息队列等服务端管理的实例 |

**风控选 AP 的 Nacos**：注册中心短暂不一致（某节点不知道新实例）可接受，但注册不可用（CP 模式选主期间）会让全链路雪崩，AP 更稳。

## 四、Nacos vs Eureka：为什么选 Nacos

| 维度 | Eureka | Nacos |
|------|--------|-------|
| CAP | AP | AP/CP 可选 |
| 配置中心 | 无 | 集成（注册+配置一体） |
| 推送 | 客户端轮询（30s） | 长轮询（1.x）/ gRPC 流（2.x，亚秒级） |
| 健康检查 | 客户端心跳 | 心跳 + 服务端主动探测 |
| 实例类型 | 仅临时 | 临时 + 持久 |
| 大规模集群 | 弱（>5w 实例性能下降） | 强（支撑 100w+ 实例） |

**蚂蚁规模**：万级服务实例，Eureka 的轮询模式对服务端压力大，Nacos 2.x 的 gRPC 长连接推送大幅降低。

## 五、风控实战架构

```
风控链路（日均亿级请求、峰值百万级 QPS）:
  网关 → 风控决策(feature-service) → 风控规则(rule-engine)
                                    ↘ 用户画像(profile-service)
                                    ↘ 黑名单(check-service)

注册中心：Nacos 集群（5节点 AP）
配置中心：Nacos 集群（同一套，CP）
```

**关键配置**（Spring Cloud Alibaba）：
```yaml
spring:
  cloud:
    nacos:
      discovery:
        server-addr: nacos-cluster:8848
        namespace: risk-prod        # 命名空间隔离（prod/test/dev）
        group: RISK_GROUP
        cluster-name: SH            # 同城集群，优先调用本地
        metadata:
          version: 2.1.0
          weight: 100
```

**风控的同城优先路由**：上海机房的风控服务优先调用上海机房的特征服务（避免跨机房 RT）——通过 `cluster-name` 元数据 + 自定义 LoadBalancer 实现。

## 六、推送机制：从轮询到 gRPC

**Nacos 1.x 长轮询**：
- 客户端发起长轮询请求，服务端 hold 住 30s
- 期间数据变更，立即返回；否则 30s 超时返回
- 折中方案，仍有延迟

**Nacos 2.x gRPC 双向流**：
- 客户端与服务端建立 gRPC 长连接
- 服务端数据变更**立即推送**
- 延迟从秒级 → **亚秒级**

风控对实例上下线感知要求高（实例下线要立刻摘流量），Nacos 2.x 是关键升级。

## 七、客户端缓存：注册中心宕机的降级

注册中心宕机时，消费者仍可调用：
1. 客户端本地缓存了实例列表（内存）
2. 调用走缓存列表
3. 拿不到新上线实例，但已有实例不受影响

**风控的演练**：每季度做"注册中心全挂"演练，验证客户端缓存能否独立支撑 30 分钟。

## 八、底层本质：服务发现的"目录"抽象

注册中心本质是分布式系统的**"名字服务目录"**——把"逻辑名（service name）"映射到"物理位置（IP:port）列表"，并提供动态变更通知。

类比：
- DNS：域名 → IP（全球分布式目录，强最终一致）
- LDAP：组织架构 → 人
- Nacos/Eureka：服务名 → 实例列表（应用层目录）

它们的共同设计：
- **客户端缓存**（性能 + 容错）
- **变更推送**（时效）
- **CAP 取舍**（按业务定）

风控选 AP，因为"宁可拿到几秒前的旧实例列表（可能误判已下线实例 → 重试别的），也不能注册中心选主期间全链路停摆"。

## 常见考点
1. **Nacos 集群怎么部署**？——3-5 节点，节点间 Distro（AP，临时实例）+ Raft（CP，持久实例）双协议。
2. **实例下线怎么做到秒级感知**？——客户端订阅 + 长连接推送；服务端 15s 心跳超时标记不健康 + 主动 TCP 探测。
3. **跨机房注册怎么做**？——每个机房一套 Nacos + 同步（Distro 跨集群复制）；或一套 Nacos 但用 cluster-name 路由。

**代码示例**（自定义 LoadBalancer 实现同城优先）：
```java
public class ClusterAwareBalancer implements ReactorServiceInstanceLoadBalancer {
    public Mono<Response<ServiceInstance>> choose(Request request) {
        String localCluster = "SH";
        List<ServiceInstance> instances = instances.getAll();
        // 先过滤同 cluster 的
        List<ServiceInstance> local = instances.stream()
            .filter(i -> localCluster.equals(i.getMetadata().get("cluster")))
            .collect(toList());
        // 没有再 fallback 全部
        return chooseFrom(local.isEmpty() ? instances : local);
    }
}
```

## 苏格拉底式面试追问

> 这组追问不是背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：风控选 Nacos 的 AP 模式而不是 Zookeeper 的 CP，你的决策依据是什么？AP 模式实例列表可能不一致，难道不会调用到已经下线的实例吗？**

会调到下线实例，但这是有意的权衡。风控是日均亿级请求的实时链路，注册中心必须 7x24 可用。CP 模式（如 ZK）在 leader 选举期间（十几秒）整个注册不可写，且读取可能阻塞，这十几秒里所有服务扩缩容、故障摘除都停摆，风控链路雪崩。AP 模式允许几秒到几十秒的列表不一致——调用方拿到旧的列表，最坏是发到已下线实例的请求失败一次，客户端重试（Ribbon/LoadBalancer 默认有重试）换一个实例即可，业务无损。决策依据是 SLA 优先级：风控的"可用性"权重高于"一致性"，因为单次失败可重试，全局不可用不可恢复。我们会用 `ribbon.MaxAutoRetries=1` + `ribbon.MaxAutoRetriesNextServer=1` 兜底重试。

### 第二层：证据与定位

**Q：风控服务调用 feature-service 偶发 ConnectException（connection refused），你怎么定位是注册中心列表没同步还是实例本身的问题？**

三组证据区分：
1. 看报错实例的 IP——在调用方的日志里拿到 connection refused 的目标 IP，然后去 Nacos 控制台查这个 IP 在 feature-service 的实例列表里是什么状态。如果 Nacos 显示 healthy=false 或已摘除，但客户端 1 分钟前还调用它，是推送延迟（AP 不一致窗口）；如果 Nacos 显示 healthy=true，是实例本身的问题（进程在但端口没监听，可能是半死状态）。
2. 看 Nacos 的推送指标——客户端有 `nacos.client.config.push.recv.success` 和 `naming.push.cache.data.timestamp` 指标，对比本机列表的时间戳和 Nacos 服务端的最新变更时间，如果差 > 30 秒，是推送链路问题（gRPC 连接断了或长轮询超时）。
3. 在报错实例上 `curl localhost:8080/actuator/health`——如果返回 DOWN 或超时，是实例本身问题；如果返回 UP，说明实例健康但注册中心误摘（可能是心跳网络抖动）。

### 第三层：根因深挖

**Q：你确认是推送延迟——实例已经下线 30 秒，但调用方还在往它发请求。根因是什么？为什么 gRPC 长连接没及时推送？**

Nacos 2.x 的 gRPC 推送理论上亚秒级，30 秒延迟说明推送链路断了。根因看两点：
1. gRPC 连接状态——用arthas ognl 看 `@com.alibaba.nacos.client.naming.core.PushReceiver@connectionState`，如果是 DISCONNECTED，说明 gRPC 长连接断了但客户端没重建。根因可能是网络设备（如 SLB）的 idle timeout 把空闲连接清掉了，而 gRPC 的 keepalive 没配置或间隔长于 SLB 的 idle 时间。
2. 客户端 fallback 逻辑——Nacos 客户端在 gRPC 断开时会 fallback 到长轮询（1.x 兼容），如果长轮询的间隔是默认 30 秒，就会看到 30 秒延迟。验证方法：arthas watch `com.alibaba.nacos.client.naming.backups.FailoverReactor` 看是否走了 fallback。

**Q：根因是 gRPC keepalive 和 SLB idle timeout 不匹配。那为什么不直接关掉 SLB 的 idle timeout？为什么不用 ZK 的 session 心跳机制？**

关 SLB idle timeout 治标不治本——SLB 的 idle timeout 是为了回收死连接防止资源泄漏（比如客户端进程崩了不通知），全局调大会影响所有经过 SLB 的连接。正确做法是让 gRPC 的 keepalive 间隔 < SLB idle timeout——我们配 `grpc.keepalive.time=30s`（SLB idle=60s），keepalive 探测包保活。至于 ZK 的 session 心跳，ZK 用的是 TCP 长连接 + session timeout，本质上和 gRPC keepalive 是同一套思路（心跳保活 + 超时摘除），但 ZK 的 session 是 CP 语义（session 失效要重新选举连接的 follower），不能简单平移。Nacos 2.x 的 gRPC 是 AP 语义，断了重连即可，不涉及选主。

### 第四层：方案权衡

**Q：你修了 keepalive，推送延迟降到亚秒。但业务说能不能做到"实例下线零误调"——调用方绝对不往已下线实例发请求？**

这是个做不到绝对、只能逼近的目标。即便推送亚秒级，从实例下线（kill 进程）到注册中心感知（心跳超时 15s 或主动注销）再到推送（亚秒）到客户端更新本地列表（立即），整个链路仍有窗口期。要"零误调"，得在调用方加一层主动探测：发请求前先探活（如 TCP connect 或 HTTP health），但这把每次调用的 RT 从 5ms 拉到 10ms（探测+请求），不划算。实务做法是**优雅下线**——实例下线前先调 Nacos API 注销（`POST /instance/deregister`），让推送立刻发出，同时实例进程继续服务老请求 30 秒（graceful shutdown），拒绝新请求但不立即退出。配合调用方的重试，误调率能降到万分之一以下。绝对零误调的代价（每次调用前探活）不值得。

**Q：为什么不直接用 Service Mesh（Istio）的 Pilot 做服务发现，让基础设施层解决一致性？**

Service Mesh 确实把服务发现下沉到 sidecar（Envoy），一致性由 Pilot 保证。但风控是超低延迟链路（P99 < 50ms），sidecar 的每次请求要经过 Envoy 的一次进程间转发（应用 → Envoy → 网络 → Envoy → 应用），增加 1-3ms RT 和 CPU 开销。对于 P99 < 50ms 的链路，这 3ms 占预算 6%，不可接受。Mesh 更适合"延迟不敏感、但需要统一治理"的场景（如内部管理系统、批处理）。风控目前用 SDK 模式（Nacos client + Spring Cloud LoadBalancer）进程内调用，零额外跳转，只有当未来治理复杂度（多语言、多协议、流量染色）超过延迟代价时才考虑 Mesh。当前 SDK 模式 + Nacos 2.x 已经满足需求。

### 第五层：验证与沉淀

**Q：你怎么证明 keepalive 修复后推送延迟真的降了？怎么量化"推送延迟"这个指标？**

指标化推送延迟并对比：
1. 客户端埋点——在 `com.alibaba.nacos.client.naming.cache.DiskCache` 的更新回调里打点，记录"收到推送时刻 - 实例实际变更时刻"（实例变更时刻从推送数据的 `lastModifiedTime` 字段取），上报 Prometheus 的 `nacos.push.delay` 指标。修复前 P99 可能 30 秒（fallback 长轮询），修复后 P99 应 < 500ms。
2. 主动注入测试——在预发环境 kill 一个实例，记录 kill 时间戳 T1，然后看 Nacos 控制台这个实例被标记 unhealthy 的时间 T2、客户端订阅更新的时间 T3，`T3-T1` 就是端到端推送延迟。修复前 T3-T1 > 30s，修复后 < 2s。
3. 线上误调率——统计调用方的 ConnectException 数量 / 总调用数。修复前误调率可能 0.05%（每月几百次），修复后 < 0.001%。

**Q：怎么让团队避免以后再踩"推送延迟"的坑？**

沉淀成机制：
1. SLB/网关配置基线——所有经过负载均衡的长连接（gRPC、Nacos、MQ）必须配置 keepalive 间隔 < SLB idle timeout 的 50%，作为基础设施配置规范，CI 校验。
2. 推送延迟监控——所有服务的 Nacos client 必须暴露 `nacos.push.delay` 指标，告警阈值 P99 > 2s 触发，自动归因到 gRPC 连接状态。
3. 故障演练常态化——每季度做"注册中心全挂"和"实例批量下线"演练，验证客户端缓存和优雅下线的配合，测量端到端误调率。
4. 故障复盘——把这次"SLB idle timeout 杀 gRPC 长连接 → fallback 长轮询 → 30 秒推送延迟 → 误调"的完整链路（含 Nacos client 的 fallback 代码路径）写进知识库，作为"长连接必须配 keepalive"的标准案例。


## 结构化回答

**30 秒电梯演讲：** 聊到Spring Cloud 服务注册与发现原理，我的理解是——注册中心让"服务提供者"主动注册地址、"服务消费者"按名查询地址，用临时+持久实例、心跳续约、长轮询推送把分布式寻址变成 O(1) 名字查找。打个比方，注册中心像电话簿：服务方登记自己号码（注册），调用方查名字拿号码（发现）。号码变更自动通知（推送），欠费注销（心跳过期）。

**展开框架：**
1. **Provider 启动注册** — Provider 启动注册、关闭注销；Consumer 拉取订阅
2. **心跳续约（默认 5s）** — 心跳续约（默认 5s）+ 摘除（默认 15s 未续约）
3. **临时实例（客户端心跳）** — 临时实例（客户端心跳）vs 持久实例（服务端主动探测）

**收尾：** 这块我在项目里也踩过坑——想深入的话，可以接着聊：Eureka 和 Nacos 区别？您更想看哪个方向？

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡 | "Spring Cloud 服务注册与发现原理——这道题面试官到底想考什么？我用 30 秒给你讲透。" | 开场钩子 |
| 0:15 | Spring Bean 生命周期图 | 先说核心：注册中心让"服务提供者"主动注册地址、"服务消费者"按名查询地址，用临时+持久实例、心跳续约、长轮询推送把分布式寻址变成 O(1) 名字查找。 | 核心定义 |
| 0:40 | 注册中心架构图 | 心跳续约（默认 5s）+ 摘除（默认 15s 未续约）。 | 心跳续约（默认 5s） |
| 1:05 | 概念结构示意图 | 临时实例（客户端心跳）vs 持久实例（服务端主动探测）。 | 临时实例（客户端心跳） |
| 2:30 | 总结卡 | 一句话记忆：AP vs CP：AP（Eureka/Nacos临时实例，可用优先）、CP（ZK/Consul/Nacos持久实例，一致优先）。 下期可以接着聊：Eureka 和 Nacos 区别。 | 收尾总结 |
