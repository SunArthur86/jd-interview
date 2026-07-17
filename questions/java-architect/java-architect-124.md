---
id: java-architect-124
difficulty: L2
category: java-architect
subcategory: 多活容灾
tags:
- Java 架构师
- 多集群
- Kubernetes
- 容灾
feynman:
  essence: 多集群 Kubernetes 是异地多活/容灾的基础设施——跨机房/跨地域部署多个 K8s 集群，流量按地域就近路由，故障时切换。核心组件：① 多集群 Service Mesh（Istio Multi-Cluster，统一治理跨集群流量）；② 全局负载均衡（GSLB/DNS，按地域/健康度路由）；③ 数据同步（异地数据复制，CDC/双向同步）；④ 流量治理（VirtualService 跨集群权重 + 故障切换）。容灾 RTO/RPO 目标决定架构——同城双活（RTO 分钟级）、两地三中心（RTO < 30 分钟）、异地灾备（RTO 小时级）。
  analogy: 像连锁餐厅的"多店运营"——单店（单集群）出事（火灾/停电）影响一家，多店（多集群）互备，一家关了客人去另一家。总部（控制面）统一管理，各店就近服务客人（地域路由），数据总部同步（异地复制）。
  first_principle: 单集群 K8s 是单点故障域——整个集群挂了，所有服务不可用。多集群分散风险：① 地域分散（机房停电/网络故障隔离）；② 版本隔离（灰度集群）；③ 容量扩展（单集群上限）。但多集群带来新挑战：跨集群服务发现、流量路由、数据一致性。架构要按容灾目标（RTO/RPO）选——RTO 越短，架构越复杂（同步复制 > 异步复制）。
  key_points:
  - 多集群 K8s：跨机房/地域部署，容灾 + 就近接入
  - 容灾等级：同城双活 / 两地三中心 / 异地灾备
  - Istio Multi-Cluster：统一治理跨集群流量
  - GSLB（全局 DNS）：地域路由 + 健康检查 + 故障切换
  - 数据同步：CDC（变更捕获）/ 双向同步 / 最终一致
  - RTO/RPO：恢复时间目标 / 数据恢复点目标
first_principle:
  problem: 单集群 K8s 挂了，整个业务不可用，怎么做到跨机房/地域容灾？
  axioms:
  - 单集群是单点故障域（etcd/控制面挂 = 全集群挂）
  - 容灾要分散风险（多机房/多地域）
  - 不同容灾等级成本不同（RTO 越短越贵）
  rebuild: 按容灾目标选架构。① 同城双活（RTO 分钟级）：同城两个机房 + 跨机房负载均衡，主集群挂了切备集群，数据库同步复制（强一致）。② 两地三中心（RTO < 30 分钟）：同城两中心 + 异地一中心，同城主 + 异地灾备，数据库异步复制（RPO 秒级）。③ 异地灾备（RTO 小时级）：异地冷备，主挂了拉起备，数据定时备份（RPO 小时级）。多集群治理：Istio Multi-Cluster（东西向网格统一）+ GSLB（南北向全局 DNS）+ VirtualService 跨集群权重。数据同步：MySQL 用 CDC（binlog 同步）/ Redis 用 cluster replica / Kafka 用 MirrorMaker。
follow_up:
  - 同城双活和异地多活区别？——同城双活（< 100km，延迟 < 1ms，可强一致）；异地多活（> 1000km，延迟 > 10ms，只能最终一致）。成本和延迟权衡
  - Istio Multi-Cluster 怎么工作？——多集群共享信任（共用根 CA），Sidecar 跨集群发现服务，VirtualService 跨集群权重路由。东西向流量统一治理
  - GSLB 怎么做故障切换？——DNS 解析时按地域 + 健康检查返回 IP。主集群健康返回主 IP，故障返回备 IP（DNS TTL 短，秒级切换）
  - 数据一致性怎么保证？——同步复制（强一致，延迟高，同城双活）/ 异步复制（最终一致，延迟低，异地多活）/ CDC（变更捕获，解耦）。按业务 SLA 选
  - 跨集群服务发现怎么做？——Istio Multi-Cluster（共用服务注册）/ KubeFed（联邦服务）/ 自建全局注册中心（Nacos 多机房）
memory_points:
  - 多集群 K8s：跨机房/地域部署，容灾 + 就近接入
  - 容灾等级：同城双活（RTO 分钟）/ 两地三中心（< 30 分钟）/ 异地灾备（小时级）
  - Istio Multi-Cluster：跨集群服务发现 + 流量治理
  - GSLB：全局 DNS 地域路由 + 健康检查 + 故障切换
  - 数据同步：同步（强一致，同城）/ 异步（最终一致，异地）/ CDC
  - RTO/RPO：恢复时间 / 数据恢复点
  - 跨集群：东西向 Mesh + 南北向 GSLB
---

# 【Java 后端架构师】多集群 Kubernetes 的流量治理与容灾

> 适用场景：JD 核心技术。单集群 K8s 曾因 etcd 故障导致全站不可用 30 分钟。架构师必须设计多集群容灾架构，实现同城双活（RTO < 5 分钟）+ 异地灾备（RTO < 30 分钟）。

## 一、概念层：多集群容灾架构

**容灾等级**（这张表面试必答）：

| 等级 | 架构 | RTO | RPO | 成本 | 适用 |
|------|------|-----|-----|------|------|
| **同城双活** | 同城 2 机房 + 负载均衡 | 分钟级 | 0（同步） | 高 | 金融/电商核心 |
| **两地三中心** | 同城 2 + 异地 1 | < 30 分钟 | 秒级 | 中高 | 大型企业 |
| **异地灾备** | 异地冷备 | 小时级 | 小时级 | 中 | 一般业务 |
| **异地多活** | 多地域多活 | 分钟级 | 秒级 | 极高 | 全球业务（出海） |

**多集群架构全景**：

```
                 用户（全球）
                     │
                     ▼
            ┌────────────────┐
            │  GSLB（全局 DNS）│  ← 地域路由 + 健康检查 + 故障切换
            └────────┬───────┘
       ┌─────────────┼─────────────┐
       ▼             ▼             ▼
┌──────────┐  ┌──────────┐  ┌──────────┐
│ 北京集群  │  │ 上海集群  │  │ 广州集群  │  ← 多集群 K8s
│ (主)      │  │ (主)      │  │ (灾备)    │
├──────────┤  ├──────────┤  ├──────────┤
│ Istio     │  │ Istio     │  │ Istio     │  ← 东西向 Mesh（跨集群）
│ + Envoy   │  │ + Envoy   │  │ + Envoy   │
├──────────┤  ├──────────┤  ├──────────┤
│ 订单服务  │  │ 订单服务  │  │ 订单服务  │  ← 应用（多副本）
│ MySQL(主) │◄►│ MySQL(从) │  │ MySQL(备) │  ← 数据同步（CDC/复制）
└──────────┘  └──────────┘  └──────────┘
       │             │             │
       └──────CDC────┴────CDC──────┘  ← 数据复制（异步）
```

**核心组件分工**：

| 层级 | 组件 | 作用 |
|------|------|------|
| **南北向** | GSLB / 全局 DNS | 地域路由 + 健康检查 + 故障切换 |
| **东西向** | Istio Multi-Cluster | 跨集群服务发现 + 流量治理 |
| **数据层** | CDC / 主从复制 | 跨集群数据同步 |
| **应用层** | 多副本 + 健康探针 | 自愈 + 流量切换 |

## 二、机制层：Istio Multi-Cluster 配置

**1. 多集群网络模型**：

```
网络模型选择：
① 扁平网络（Flat Network）：所有集群 Pod CIDR/Service CIDR 不重叠，可直接路由
   - 优点：Pod 直连（低延迟）
   - 缺点：网络规划复杂（CIDR 分配）

② 单网络（Single Network）：多集群共用网络，通过网关互通
   - 优点：网络简单
   - 缺点：流量过网关（增加延迟）

③ 多网络（Multi-Network）：各集群独立网络，通过东西向网关互联
   - 优点：网络隔离（安全）
   - 缺点：流量过网关（延迟 + 复杂）
```

**2. Istio Multi-Cluster 配置（单控制面 + 多网络）**：

```yaml
# 集群 1（北京，主集群）：运行 istiod
# 集群 2（上海，从集群）：共享 istiod

# 步骤 1：建立跨集群信任（共用根 CA）
# 两个集群用相同的根 CA 签发证书，mTLS 互通
istioctl install --set values.global.meshID=mesh1 \
  --set values.global.network=network1 \
  --set values.global.multiCluster.clusterName=cluster1

# 步骤 2：跨集群服务发现（Secret 挂载远程集群 kubeconfig）
kubectl create secret generic istio-remote-secret-cluster2 \
  --from-file=context=cluster2 \
  -n istio-system

# 步骤 3：东西向网关（跨集群流量入口）
apiVersion: networking.istio.io/v1beta1
kind: Gateway
metadata:
  name: cross-network-gateway
  namespace: istio-system
spec:
  selector:
    istio: eastwestgateway
  servers:
  - port:
      number: 15443
      name: tls
      protocol: TLS
    tls:
      mode: ISTIO_MUTUAL
    hosts:
    - "*"
```

**3. 跨集群 Service（ServiceEntry）**：

```yaml
# 在集群 1 声明集群 2 的服务（跨集群发现）
apiVersion: networking.istio.io/v1beta1
kind: ServiceEntry
metadata:
  name: order-service-cluster2
spec:
  hosts:
  - order-service.default.svc.cluster2.local
  location: MESH_INTERNAL
  ports:
  - number: 8080
    name: http
    protocol: HTTP
  resolution: DNS
  endpoints:
  - address: cluster2-eastwest-gateway.external-ip
    ports:
      http: 15443
```

**4. 跨集群流量治理（VirtualService）**：

```yaml
# 按权重跨集群路由（正常：80% 集群1 + 20% 集群2）
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: order-service-global
spec:
  hosts:
  - order-service
  http:
  - route:
    - destination:
        host: order-service.default.svc.cluster.local       # 集群1
        port:
          number: 8080
      weight: 80
    - destination:
        host: order-service.default.svc.cluster2.local      # 集群2
        port:
          number: 8080
      weight: 20
```

**5. GSLB 全局 DNS（故障切换）**：

```
GSLB 工作流程：
1. 用户访问 order.jd.com
2. GSLB DNS 解析：
   - 检测各集群健康（HTTP 探测 /health）
   - 按地域就近 + 健康度返回 IP
3. 正常：返回北京集群入口 IP（地域近）
4. 北京集群故障：返回上海集群 IP（DNS TTL 短，秒级切换）

DNS 记录：
  order.jd.com.  60  IN  A  1.1.1.1    # 北京集群（主）
  order.jd.com.  60  IN  A  2.2.2.2    # 上海集群（备）
  
GSLB 策略：
  - 地理路由（用户在北京 → 返回北京 IP）
  - 健康检查（北京集群挂了 → 不返回北京 IP）
  - 负载均衡（两地健康 → 按权重返回）
```

## 三、实战层：故障切换流程

**场景：北京集群故障，切到上海集群**

```
正常状态：
  - 北京集群：承载 80% 流量（主）
  - 上海集群：承载 20% 流量（备）
  - 数据：北京 MySQL 主 → 上海 MySQL 从（同步复制）

故障发生（T+0）：
  - 北京集群 etcd 故障，全集群不可用
  - GSLB 健康检查失败（/health 超时）

故障切换（T+30 秒）：
  1. GSLB 检测北京不健康，DNS 只返回上海 IP
  2. 新流量全部到上海集群
  3. 已建立连接的客户端（旧 IP）会失败重试（连 GSLB 重新解析）

数据切换（T+1 分钟）：
  1. 上海 MySQL 从库提升为主（promotion）
  2. 应用数据库连接池重连（新主）
  3. 数据零丢失（同步复制，RPO=0）

容量评估（T+5 分钟）：
  1. 上海集群从 20% 流量突增到 100%
  2. HPA 自动扩容（CPU 阈值触发）
  3. 或预留容量（上海常态 50% + 弹性 50%）

恢复（T+2 小时）：
  1. 北京集群修复
  2. 反向数据同步（上海 → 北京）
  3. 灰度切回（先 10% → 50% → 80%）

RTO = 30 秒（GSLB 切换）+ 1 分钟（数据提升）= 1.5 分钟
RPO = 0（同步复制）
```

**同城双活配置（北京 + 廊坊，< 100km）**：

```yaml
# 北京集群 + 廊坊集群（同城）
# 数据库：MySQL MGR（Group Replication）同步复制
# 延迟：< 1ms（同城光纤）

apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: order-service-active-active
spec:
  hosts:
  - order-service
  http:
  - route:
    - destination:
        host: order-service.beijing.svc.cluster.local
      weight: 50                    # 同城双活，各 50%
    - destination:
        host: order-service.langfang.svc.cluster.local
      weight: 50
    # 故障自动切换（Envoy 健康检查）
    retries:
      attempts: 2
      retryOn: 5xx,reset,connect-failure
```

**异地多活配置（北京 + 广州，> 2000km）**：

```yaml
# 异地多活（延迟 > 10ms，只能最终一致）
# 数据库：CDC 异步复制（binlog → Kafka → 异地重放）
# 业务：按地域分片（北京用户 → 北京集群，广州用户 → 广州集群）

# 按用户地域路由
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: order-service-geo
spec:
  hosts:
  - order-service
  http:
  - match:
    - headers:
        x-geo-region:
          exact: "south"             # 广州用户
    route:
    - destination:
        host: order-service.guangzhou.svc.cluster.local
  - match:
    - headers:
        x-geo-region:
          exact: "north"             # 北京用户
    route:
    - destination:
        host: order-service.beijing.svc.cluster.local
  - route:                           # 默认（按地域就近）
    - destination:
        host: order-service.beijing.svc.cluster.local
```

## 四、底层本质：为什么是多集群

回到第一性：**为什么单集群不够，要多集群？**

- **单点故障域**：单 K8s 集群的 etcd/控制面是单点，挂了全集群挂。多集群分散风险——一个挂了其他还能服务。
- **地域分散**：用户在全球，单集群单地域延迟高。多集群就近接入（北京用户走北京集群，广州用户走广州集群）。
- **版本隔离**：新版本 K8s/Istio 灰度，多集群可以"灰度集群"先升级，不影响主集群。
- **容量扩展**：单集群有上限（节点数/Pod 数/etcd 性能），多集群横向扩展。

**同城 vs 异地的本质区别**：
- **同城（< 100km）**：光纤延迟 < 1ms，数据库可同步复制（强一致，RPO=0）。适合金融/电商核心（同城双活）。
- **异地（> 1000km）**：光纤延迟 > 10ms，数据库只能异步复制（最终一致，RPO 秒级）。适合灾备/异地多活。
- **权衡**：RTO/RPO 越短，成本越高（同步复制需要低延迟网络，同城光纤贵）。

**数据一致性的本质挑战**：
- **同步复制**：主写 → 等从确认 → 返回。强一致（RPO=0），但延迟高（等从），从挂了主也挂（可用性降）。
- **异步复制**：主写 → 立即返回 → 异步同步到从。最终一致（RPO 秒级），延迟低，但主挂了未同步的数据丢。
- **CDC（Change Data Capture）**：捕获数据库变更（binlog），通过 Kafka 传到异地重放。解耦主从，适合异地多活。

**GSLB 故障切换的本质**：
- DNS 层切换——用户解析域名时，GSLB 按健康度返回 IP。
- 优势：全局统一（所有用户），无侵入（应用无感）。
- 劣势：DNS 缓存（TTL 期间旧 IP 仍用，切换有延迟）。
- 优化：短 TTL（60 秒）+ 客户端重试（连失败重新解析）。

**Istio Multi-Cluster 的本质**：
- 跨集群服务发现——Sidecar 知道所有集群的服务实例。
- 跨集群流量治理——VirtualService 跨集群权重路由。
- 统一安全——共用根 CA，mTLS 跨集群加密。
- 代价：复杂（多集群配置 + 网络互通 + 证书管理）。

## 五、AI 架构师加问：5 个

1. **AI 推理服务的多集群容灾？**
   LLM 推理成本高（GPU 贵），多集群容灾要权衡。策略：① 主集群推理 + 备集群模型预热（不常驻 GPU）；② 故障切换时备集群拉起（冷启动 5-10 分钟）；③ 模型权重 CDN 加速分发（多集群同步）。RTO 较长（分钟级），但成本可控。

2. **AI 能预测故障并提前切换吗？**
   AI 监控多集群健康指标（延迟/错误率/CPU/网络），预测故障：① etcd 延迟突升（可能脑裂）；② 网络抖动（可能分区）；③ 资源耗尽（可能 OOM）。AI 提前告警 + 预切换（GSLB 降权重），避免完全故障。比被动切换（故障后切）RTO 更短。

3. **大模型推理的多集群流量治理？**
   按地域路由（北京用户 → 北京集群的 LLM）+ 按模型路由（GPT-4 → A 集群，LLaMA → B 集群）+ 故障切换（A 挂了切 B）。VirtualService 按 model_name/geo_region 路由。数据同步：模型权重用 CDN（多集群预分发），用户数据用 CDC（异地同步）。

4. **AI Agent 服务的多活？**
   Agent 状态持久化（Redis/DB），多集群共享状态（CDC 同步）。会话路由：同一用户的 Agent 调用固定到一个集群（粘性会话），避免状态不一致。故障切换：用户重连到另一集群，从持久化状态恢复。对话上下文不丢。

5. **AI 怎么做多集群容量规划？**
   AI 预测各集群流量（历史周期 + 大促预估），优化容量分配：① 主集群常态 50% + 弹性 50%；② 备集群预留容量（故障时承接）；③ 成本优化（闲时缩容，忙时扩容）。AI 输出容量规划 + 模拟故障切换（验证备集群能承接）。

## 六、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"容灾等级、GSLB、Istio Multi-Cluster、数据同步"**。

- **容灾等级**：同城双活（RTO 分钟，RPO=0，同步复制）/ 两地三中心（< 30 分钟，秒级）/ 异地灾备（小时级）
- **GSLB**：全局 DNS 地域路由 + 健康检查 + 故障切换（DNS TTL 短，秒级）
- **Istio Multi-Cluster**：跨集群服务发现 + VirtualService 权重路由 + 共用根 CA（mTLS）
- **数据同步**：同步（强一致，同城 < 1ms）/ 异步（最终一致，异地 > 10ms）/ CDC（binlog 解耦）
- **东西向 Mesh + 南北向 GSLB**：Mesh 管集群间流量，GSLB 管用户到集群
- **RTO/RPO**：恢复时间目标 / 数据恢复点目标

### 拟人化理解

把多集群容灾想成**连锁餐厅的多店运营**。单店（单集群）出事（火灾/停电）影响一家，多店（多集群）互备。总部（控制面）统一管理，各店就近服务客人（地域路由）。GSLB 是"客服热线"，按客人位置推荐最近的店，某店关门了推荐其他店。Istio Multi-Cluster 是"内部协作系统"，各店共享菜单/库存信息（服务发现），统一服务标准（流量治理）。数据同步是"库存系统"，各店库存实时同步（同步复制，同城）或定期同步（异步复制，异地）。RTO 是"恢复营业时间"，RPO 是"数据丢失量"。

### 面试现场 60 秒回答

> 多集群 K8s 是异地多活/容灾的基础设施，跨机房/地域部署多个集群，分散单集群单点故障风险。容灾等级：① 同城双活（< 100km，延迟 < 1ms，同步复制，RTO 分钟级 RPO=0）；② 两地三中心（同城 2 + 异地 1，RTO < 30 分钟，RPO 秒级）；③ 异地灾备（冷备，RTO 小时级）。核心组件：① GSLB（全局 DNS，地域路由 + 健康检查 + 故障切换，DNS TTL 短秒级切换）；② Istio Multi-Cluster（东西向网格，跨集群服务发现 + VirtualService 权重路由 + 共用根 CA mTLS）；③ 数据同步（MySQL CDC binlog/Kafka MirrorMaker/Redis cluster replica）。故障切换流程：GSLB 检测不健康 → DNS 切换到备集群 → 新流量到备 → 数据从库提升为主 → HPA 扩容。数据一致性：同城同步复制（强一致 RPO=0），异地异步复制（最终一致 RPO 秒级）。按业务 SLA 选架构——金融核心同城双活，一般业务两地三中心，成本敏感异地灾备。东西向 Mesh（Istio）管集群间流量，南北向 GSLB 管用户到集群，两者协作完成多集群流量治理。

### 反问面试官

> 贵司容灾等级是什么（同城双活/两地三中心）？有 Service Mesh 多集群吗？这决定我聊 Istio Multi-Cluster 还是 GSLB。

## 七、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 单集群够用，为什么还要多集群？ | 单集群是单点故障域（etcd 挂全挂）。多集群分散风险 + 地域就近接入 + 版本隔离 + 容量扩展。容灾是核心目标 |
| 证据追问 | 怎么证明多集群容灾有效？ | ① 故障演练（模拟集群挂，验证切换）；② RTO/RPO 达标（实测 < 目标）；③ 数据零丢失（同步复制验证）；④ 流量切换平滑（用户无感） |
| 边界追问 | 多集群适用所有场景吗？ | 不适用：① 小业务（单集群够）；② 成本敏感（多集群贵）；③ 内部工具（不需容灾）。多集群适合核心业务 + 全球业务 |
| 反例追问 | 多集群有什么坑？ | ① 复杂（多集群配置/网络互通/证书）；② 成本（多集群资源 + 数据中心）；③ 数据一致（跨集群事务难）；④ 故障切换风险（切换失败更糟）。治法：演练 + 监控 + 灰度 |
| 风险追问 | 多集群最大风险？ | ① 脑裂（主备同时写，数据冲突）；② 切换失败（备集群没起来）；③ 数据丢失（异步复制 RPO > 0）；④ DNS 缓存（TTL 期间切不过来）。治法：同步复制 + 演练 + 短 TTL |
| 验证追问 | 怎么验证故障切换？ | ① 混沌工程（模拟集群挂）；② 切换演练（定期演练，季度 1 次）；③ 数据校验（切换后数据一致）；④ 性能验证（备集群能承接流量） |
| 沉淀追问 | 团队规范沉淀什么？ | ① 多集群架构 SOP；② 故障切换流程；③ 数据同步规范；④ 演练计划（季度）；⑤ 监控大盘（多集群健康） |

### 现场对话示例

**面试官**：同城双活和异地多活区别？

**候选人**：核心区别是延迟和一致性。同城双活（< 100km，同城光纤，延迟 < 1ms）——数据库可同步复制（主写等从确认，强一致 RPO=0），适合金融/电商核心。异地多活（> 1000km，延迟 > 10ms）——同步复制延迟不可接受，只能异步复制（最终一致 RPO 秒级），适合全球业务。成本：同城光纤贵（专线），异地普通网络即可。JD 选择：核心交易同城双活（北京 + 廊坊，RPO=0），非核心异地多活（北京 + 广州，按地域分片）。RTO/RPO 目标决定架构——越短越贵。

**面试官**：GSLB 故障切换原理？

**候选人**：GSLB 是全局 DNS，用户解析域名时按地域 + 健康度返回 IP。正常返回主集群 IP（地域近），故障返回备集群 IP。切换延迟取决于 DNS TTL——TTL 60 秒，最坏 60 秒切完。优化：① 短 TTL（30-60 秒）；② 客户端重试（连失败重新解析，秒级生效）；③ HTTP 层重试（比 DNS 快）。GSLB 是"南北向"切换（用户到集群），Istio Multi-Cluster 是"东西向"切换（集群间流量），两者协作完成完整故障切换。

**面试官**：跨集群数据一致性怎么保证？

**候选人**：按场景选。① 同城双活（延迟 < 1ms）：MySQL MGR（Group Replication）同步复制，强一致 RPO=0。主写等多数节点确认才返回，从挂了不影响主（多数派可用）。② 异地多活（延迟 > 10ms）：CDC（捕获 binlog → Kafka → 异地重放），最终一致 RPO 秒级。主写立即返回，异步同步，主挂了未同步数据丢。③ 业务规避：按用户分片（北京用户数据在北京集群，广州用户在广州），避免跨集群事务。④ 最终一致补偿：Saga/对账机制，定时校验数据一致性。权衡：一致性 vs 可用性 vs 延迟，按业务 SLA 选。

## 常见考点

1. **多集群 K8s 的价值？**——分散单集群单点风险 + 地域就近接入 + 版本隔离 + 容量扩展。容灾是核心目标。
2. **容灾等级？**——同城双活（RTO 分钟 RPO=0 同步复制）/ 两地三中心（< 30 分钟 秒级）/ 异地灾备（小时级）。
3. **GSLB 故障切换原理？**——全局 DNS 按地域 + 健康检查返回 IP，DNS TTL 短（60 秒）秒级切换。
4. **Istio Multi-Cluster？**——跨集群服务发现 + VirtualService 权重路由 + 共用根 CA（mTLS 加密）。
5. **跨集群数据一致性？**——同步复制（同城，强一致 RPO=0）/ 异步 CDC（异地，最终一致 RPO 秒级），按延迟和 SLA 选。

## 结构化回答



**30 秒电梯演讲：** 像连锁餐厅的"多店运营"——单店（单集群）出事（火灾/停电）影响一家，多店（多集群）互备，一家关了客人去另一家。总部（控制面）统一管理，各店就近服务客人（地域路由），数据总部同步（异地复制）。

**展开框架：**
1. **多集群 K8s** — 跨机房/地域部署，容灾 + 就近接入
2. **容灾等级** — 同城双活 / 两地三中心 / 异地灾备
3. **Istio Multi-Cluster** — 统一治理跨集群流量

**收尾：** 同城双活和异地多活区别？




## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：多集群 Kubernetes 的流量治理与容灾 | "这题核心是——多集群 Kubernetes 是异地多活/容灾的基础设施——跨机房/跨地域部署多个 K8s 集群，流……" | 开场钩子 |
| 0:15 | 多集群 K8s示意/对比图 | "跨机房/地域部署，容灾 + 就近接入" | 多集群 K8s要点 |
| 0:40 | 容灾等级示意/对比图 | "同城双活 / 两地三中心 / 异地灾备" | 容灾等级要点 |
| 1:25 | 总结卡 | "记住：多集群 K8s。下期见。" | 收尾 |
