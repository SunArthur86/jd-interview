---
id: ant-risk-006
difficulty: L3
category: jd-core
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
