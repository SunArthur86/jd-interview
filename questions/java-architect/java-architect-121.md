---
id: java-architect-121
difficulty: L2
category: java-architect
subcategory: 高可用
tags:
- Java 架构师
- K8s 探针
- Pod 重启
- 雪崩防控
feynman:
  essence: K8s 三探针（startup/liveness/readiness）+ 重启机制是服务自愈的核心，但配置不当会引发雪崩——liveness 误判导致 Pod 反复重启、readiness 失败导致流量摘除、级联重启打爆下游。核心原则：① startup 先判断启动完成（慢启动场景）；② liveness 只判"死锁/僵死"（不判慢）；③ readiness 判"能否接流量"（包含依赖检查）。配合优雅停机 + PDB + 限流，才能防控雪崩。
  analogy: 像医院的"病人监护系统"——startup 是"术后苏醒监测"（确认病人清醒），liveness 是"心跳监测"（心跳停了=死亡，要抢救），readiness 是"能否接客"（病人能否被探视）。误判会误抢救（重启）或误隔离（摘流量），引发连锁反应（雪崩）。
  first_principle: 探针的本质是"让 K8s 判断 Pod 健康状态，自动决策（重启/摘流量）"。但"健康"是多维的——能启动、能运行、能服务是不同状态。配置不当的代价：liveness 太敏感 → Pod 反复重启（JVM 预热慢，重启期间不接流量，雪崩）；readiness 检查下游 → 下游故障导致所有 Pod 摘流量（级联故障）。
  key_points:
  - 三探针：startup（启动完成）/liveness（存活）/readiness（接流量）
  - startup 先于 liveness（慢启动场景，JVM 预热期不杀 Pod）
  - liveness 只判死锁/僵死，不判慢（慢不是死）
  - readiness 不检查下游（防级联雪崩）
  - 重启策略：Always（默认）/OnFailure/Never
  - PDB（PodDisruptionBudget）防止批量重启
first_principle:
  problem: Pod 偶发重启，或下游故障导致本服务 Pod 全部摘流量，怎么防控？
  axioms:
  - 探针配置不当会误判（liveness 太敏感导致重启雪崩）
  - readiness 检查下游会导致级联（下游挂了，本服务也摘流量）
  - 重启期间不接流量，批量重启打爆服务
  rebuild: "三探针分工。① startup：判\"启动完成\"，failureThreshold 大（10 次 × 10 秒 = 100 秒，覆盖 JVM 预热），期间 liveness 不生效（不杀 Pod）。② liveness：判\"死锁/僵死\"（如 GC 长时间 STW、死锁），timeout 短（1 秒），不判慢请求（慢不是死）。③ readiness：判\"能否接流量\"，只查本 Pod 状态（HTTP 200 + 本地资源），不查下游（下游故障不摘本 Pod 流量，避免级联）。配合：优雅停机（preStop 摘流量）+ PDB（minAvailable: 1，防批量重启）+ 限流（Sentinel，防下游慢打爆线程池）。"
follow_up:
  - 三探针区别？——startup（启动完成，先于 liveness）；liveness（存活，失败重启）；readiness（接流量，失败摘流量不重启）
  - 为什么 readiness 不能检查下游？——下游故障时，本服务 readiness 失败 → 全 Pod 摘流量 → 服务完全不可用（级联雪崩）。下游故障应靠熔断（Sentinel）降级
  - liveness 失败会怎样？——K8s 重启 Pod（kill + 重新拉起）。重启期间（JVM 预热 10-30 秒）不接流量。频繁重启会雪崩
  - startup 解决什么问题？——慢启动应用（如加载大模型、预热缓存）期间 liveness 误判杀 Pod。startup 先判断启动完成，期间 liveness 不生效
  - 怎么防雪崩？——① liveness 不判慢；② readiness 不查下游；③ PDB 防批量重启；④ 优雅停机；⑤ 限流熔断
memory_points:
  - 三探针：startup（启动完成）/liveness（存活，重启）/readiness（接流量，摘流量）
  - startup 先于 liveness（慢启动保护，JVM 预热期不杀）
  - liveness 只判死锁/僵死，不判慢（慢不是死）
  - readiness 不检查下游（防级联雪崩）
  - 重启策略：Always（默认）
  - PDB：PodDisruptionBudget，防批量重启（minAvailable）
  - 配合：优雅停机 + 限流熔断（Sentinel）
---

# 【Java 后端架构师】Pod 重启、探针与服务雪崩防控

> 适用场景：JD 核心技术。订单服务上线后偶发 Pod 重启，某次下游 MySQL 慢导致 readiness 全失败，所有 Pod 摘流量，服务完全不可用 5 分钟。架构师必须重新设计探针策略，防控雪崩。

## 一、概念层：K8s 三探针的分工

**三探针是什么**：

```
Pod 生命周期：
┌──────────────────────────────────────────────────────────────┐
│ 启动期（Pending → ContainerCreating → Running）              │
│                                                                │
│ ┌────────────────────────────────────────┐                    │
│ │ startup probe（启动探针）               │                    │
│ │ - 判"启动完成"                          │                    │
│ │ - 期间 liveness/readiness 不生效        │                    │
│ │ - failureThreshold 大（覆盖 JVM 预热） │                    │
│ └────────────────┬───────────────────────┘                    │
│                  │ 成功                                         │
│                  ▼                                              │
│ ┌────────────────────────────────────────┐                    │
│ │ liveness probe（存活探针）              │                    │
│ │ - 判"存活"（死锁/僵死）                 │                    │
│ │ - 失败 → 重启 Pod                       │                    │
│ └────────────────────────────────────────┘                    │
│                                                                │
│ ┌────────────────────────────────────────┐                    │
│ │ readiness probe（就绪探针）             │                    │
│ │ - 判"能否接流量"                        │                    │
│ │ - 失败 → 摘流量（从 Endpoints 移除）    │                    │
│ │ - 不重启 Pod                            │                    │
│ └────────────────────────────────────────┘                    │
└──────────────────────────────────────────────────────────────┘
```

**三探针对比**（这张表面试必问）：

| 探针 | 作用 | 失败后果 | 适用场景 |
|------|------|---------|---------|
| **startup** | 判断启动完成 | 重启 Pod（启动失败） | 慢启动（JVM 预热/模型加载） |
| **liveness** | 判断存活（死锁/僵死） | **重启 Pod** | GC 长时间 STW、死锁检测 |
| **readiness** | 判断能否接流量 | **摘流量**（不重启） | 依赖检查（但不应查下游） |

**关键参数**：

```yaml
livenessProbe:           # 同样适用 readiness/startup
  httpGet:
    path: /actuator/health/liveness
    port: 8080
  initialDelaySeconds: 0     # 启动后多久开始探测（startup 配合后可设 0）
  periodSeconds: 10          # 每 10 秒探测一次
  timeoutSeconds: 1          # 超时 1 秒
  successThreshold: 1        # 成功 1 次算"就绪"
  failureThreshold: 3        # 连续失败 3 次算"不健康"
```

## 二、机制层：探针配置实战

**Spring Boot Actuator 健康端点**：

```yaml
# application.yml
management:
  endpoint:
    health:
      probes:
        enabled: true                # 启用 liveness/readiness 端点
      show-details: always           # 显示健康详情
      group:
        liveness:                    # liveness 组（只查 JVM 存活）
          include: ping              # 只 ping（不查下游）
        readiness:                   # readiness 组（查本 Pod 能否服务）
          include: ping,db,redis     # 查本地依赖
  health:
    livenessstate:
      enabled: true                  # 启用 liveness state（Spring 内部判断）
    readinessstate:
      enabled: true
```

**Spring Boot 探针状态**：

```java
// Spring Boot 2.3+ 自动管理探针状态
// ApplicationAvailability 接口

@Component
public class AvailabilityListener {

    @EventListener
    public void onReadinessState(AvailabilityStateChangeEvent<ReadinessState> event) {
        switch (event.getState()) {
            case ACCEPTING_TRAFFIC:
                log.info("Ready to accept traffic");
                break;
            case REFUSING_TRAFFIC:
                log.info("Refusing traffic（启动中/优雅停机中）");
                break;
        }
    }
}

// 自定义健康指标（readiness 组）
@Component
public class CustomReadinessIndicator implements HealthIndicator {

    @Override
    public Health health() {
        // 只查本地资源（不查下游，防级联）
        if (localCache.isReady()) {
            return Health.up().build();
        }
        return Health.down().withDetail("error", "cache not ready").build();
    }
}
```

**K8s Deployment 探针配置**：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-service
spec:
  template:
    spec:
      containers:
      - name: order-service
        image: registry.jd.com/order-service:latest
        livenessProbe:
          httpGet:
            path: /actuator/health/liveness
            port: 8080
          periodSeconds: 10
          timeoutSeconds: 1          # 超时 1 秒（快速判死锁）
          failureThreshold: 3        # 连续失败 3 次（30 秒）才重启
          # 不配 initialDelaySeconds（用 startup 代替）

        readinessProbe:
          httpGet:
            path: /actuator/health/readiness
            port: 8080
          periodSeconds: 10
          timeoutSeconds: 2
          failureThreshold: 3

        startupProbe:                # 慢启动保护
          httpGet:
            path: /actuator/health/liveness
            port: 8080
          periodSeconds: 10
          failureThreshold: 30       # 30 × 10 秒 = 300 秒（5 分钟启动期）
          # 期间 liveness/readiness 不生效（不杀 Pod）

        resources:
          requests:
            cpu: 500m
            memory: 1Gi
          limits:
            cpu: 1000m
            memory: 2Gi
```

**PDB（PodDisruptionBudget）防批量重启**：

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: order-service-pdb
  namespace: order
spec:
  minAvailable: 2                    # 至少保 2 个 Pod 可用（防全部同时重启）
  # 或 maxUnavailable: 1             # 最多 1 个不可用
  selector:
    matchLabels:
      app: order-service
```

## 三、实战层：雪崩场景与防控

**场景 1：liveness 太敏感导致重启雪崩**

```
错误配置：
  livenessProbe:
    httpGet:
      path: /api/orders   # 业务接口（慢请求）
    timeoutSeconds: 1     # 超时 1 秒
    failureThreshold: 3

问题：
  1. 业务接口慢（GC/下游慢），P99 > 1 秒
  2. liveness 超时（1 秒），连续失败 3 次
  3. K8s 重启 Pod
  4. 重启期间 JVM 预热 30 秒，不接流量
  5. 其他 Pod 流量增加，也变慢，也重启
  6. 雪崩：所有 Pod 轮流重启

修复：
  livenessProbe:
    httpGet:
      path: /actuator/health/liveness   # 只 ping，不调业务
    timeoutSeconds: 1
    failureThreshold: 5                 # 容忍 5 次失败（50 秒）
  + startupProbe 保护启动期
```

**场景 2：readiness 检查下游导致级联雪崩**

```
错误配置：
  readinessProbe:
    httpGet:
      path: /actuator/health   # 默认查所有依赖（含 MySQL）

  management.endpoint.health.group.readiness.include: db,redis

问题：
  1. MySQL 慢（连接池打满）
  2. 本服务 readiness 失败（db 检查失败）
  3. 所有 Pod 摘流量
  4. 服务完全不可用（级联雪崩）

修复：
  # readiness 只查本地，不查下游
  management.endpoint.health.group.readiness.include: ping
  # 下游故障用熔断降级（Sentinel）
  @SentinelResource(value = "queryOrder", fallback = "queryOrderFallback")
```

**场景 3：慢启动 Pod 被 liveness 误杀**

```
错误配置（无 startup probe）：
  livenessProbe:
    httpGet:
      path: /actuator/health/liveness
    initialDelaySeconds: 30
    failureThreshold: 3

问题：
  1. JVM 预热 + 加载缓存需要 60 秒
  2. initialDelaySeconds=30，30 秒后开始探测
  3. 但 JVM 还在预热（预热期响应慢）
  4. liveness 失败 3 次（30 秒），Pod 被杀
  5. 反复重启（启动 → 被杀 → 启动 → 被杀）

修复：加 startup probe
  startupProbe:
    httpGet:
      path: /actuator/health/liveness
    periodSeconds: 10
    failureThreshold: 30       # 300 秒（5 分钟）启动期
  # startup 成功前，liveness 不生效（不杀 Pod）
  livenessProbe:
    httpGet:
      path: /actuator/health/liveness
    # 不配 initialDelaySeconds（startup 保护）
```

**场景 4：批量发布打爆服务**

```
错误配置（无 PDB）：
  Deployment replicas: 10
  发布时 K8s 滚动更新，可能同时重启多个 Pod

问题：
  1. 滚动更新，maxUnavailable 默认 25%（10 × 25% = 2 个同时不可用）
  2. 但如果 readiness 失败（如启动慢），更多 Pod 处于 NotReady
  3. 可用 Pod 少，流量集中，打爆剩余 Pod

修复：PDB + 滚动策略
  strategy:
    rollingUpdate:
      maxUnavailable: 1          # 最多 1 个不可用
      maxSurge: 1                # 最多多 1 个（先起新再删旧）
  + PDB minAvailable: 8          # 至少 8 个可用
```

## 四、底层本质：为什么会雪崩

回到第一性：**为什么探针配置不当会雪崩？**

- **重启是"重"操作**：Pod 重启 = kill 容器 + 重新拉镜像（如果缓存） + 启动 JVM + 预热（10-30 秒）。期间不接流量。批量重启导致可用 Pod 减少，流量集中打爆剩余 Pod，剩余 Pod 也重启，雪崩。
- **liveness 的边界**：liveness 应判"死锁/僵死"（GC 长时间 STW、死锁、OOM edge case），不判"慢"。慢请求（业务逻辑重/下游慢）不是死，重启无用反而恶化（重启更慢）。
- **readiness 的级联风险**：readiness 失败摘流量，如果 readiness 查下游（DB/Redis），下游故障时本服务所有 Pod 摘流量，服务完全不可用。下游故障应靠熔断降级（Sentinel），不靠 readiness 摘流量。

**startup probe 解决的本质问题**：
- 慢启动应用（JVM 预热、加载大模型、预热缓存）启动需要 1-5 分钟。
- 如果只有 liveness，initialDelaySeconds 配短 → 启动期被误杀；配长 → 真死锁时响应慢。
- startup probe 分离"启动判断"和"存活判断"——startup 期间 liveness 不生效，startup 成功后 liveness 接管。两者职责清晰。

**探针端点分离的本质**：
- Spring Boot Actuator 提供 `/actuator/health/liveness` 和 `/actuator/health/readiness` 两个独立端点。
- liveness 组只包含"存活"检查（如 ping），不查依赖（避免慢）。
- readiness 组包含"能否服务"检查（如本地缓存、本地资源），但不查下游（避免级联）。
- 分离让探针职责清晰，配置灵活。

**PDB 的本质**：
- PodDisruptionBudget 限制"自愿中断"（Voluntary Disruption，如发布、缩容）的最大数量。
- minAvailable: 2 表示任何时候至少 2 个 Pod 可用，K8s 不会同时重启超过（replicas - 2）个。
- 注意：PDB 只防"自愿中断"（kubectl drain / 滚动更新），不防"非自愿中断"（Pod 崩溃、节点故障）。

**K8s 重启策略的本质**：
- `restartPolicy: Always`（默认）：任何退出都重启。
- `OnFailure`：非 0 退出码才重启。
- `Never`：不重启（Job/CronJob 用）。
- Deployment 默认 Always，保证自愈。

## 五、AI 架构师加问：5 个

1. **AI 推理服务的探针怎么设计？**
   startup 配长（模型加载 1-5 分钟，failureThreshold × period = 5 分钟）；liveness 只 ping（不查 GPU，GPU 故障用业务指标告警）；readiness 查模型是否加载完成（/actuator/health 含 model loaded）。PDB minAvailable=1（防全部重启，模型加载慢）。

2. **AI 能预测探针误判吗？**
   AI 学习历史探针失败 + 重启模式，检测异常：① liveness 失败但 Pod 实际健康（误判，如 GC 期间）；② readiness 频繁抖动（边界问题）；③ 批量重启征兆（多个 Pod 同时失败）。AI 告警 + 建议调整参数（如 failureThreshold 加大）。

3. **大模型推理的 startup 探针？**
   startup probe failureThreshold × period = 模型加载时间 × 2（留余量）。如 LLaMA-70B 加载 3 分钟，startup 配 6 分钟（periodSeconds=10, failureThreshold=36）。期间 liveness 不生效，避免加载中被杀。startup 成功后 liveness 接管（只 ping）。

4. **AI Agent 服务的探针策略？**
   startup：JVM 预热 + 初始化（30-60 秒）。liveness：只 ping（判 JVM 存活）。readiness：查本地资源（向量库连接、模型加载）。不查下游 LLM API（用熔断降级处理 LLM 不可用）。PDB minAvailable: 1（Agent 状态持久化，重启可恢复）。

5. **AI 怎么优化探针配置？**
   AI 分析历史数据：启动耗时分布（定 startup failureThreshold）、GC 停顿分布（定 liveness timeout）、请求延迟分布（定 readiness timeout）。AI 输出推荐配置 + 模拟验证（不直接改生产）。定期优化（应用变更后参数可能要调）。

## 六、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"三探针、不判慢、不查下游、PDB 防批量"**。

- **三探针**：startup（启动完成，先于 liveness）/liveness（存活，失败重启）/readiness（接流量，失败摘流量不重启）
- **liveness 不判慢**：只判死锁/僵死（GC STW、死锁），慢请求不是死，重启恶化
- **readiness 不查下游**：只查本地资源，下游故障用熔断降级（防级联雪崩）
- **startup 保护慢启动**：JVM 预热期 liveness 不生效（startup probe 接管）
- **PDB 防批量重启**：minAvailable: 2，K8s 滚动更新不超阈值
- **端点分离**：/actuator/health/liveness（只 ping）/readiness（查本地资源）

### 拟人化理解

把探针想成**医院的三层监护**。startup 是"术后苏醒监测"——病人刚做完手术（Pod 刚启动），苏醒期（JVM 预热）不判心跳，只判"清醒没"。liveness 是"心跳监护"——病人清醒后，心跳停了（死锁/僵死）要抢救（重启）。readiness 是"能否接客"——病人能否被探视（接流量），但不能因为"朋友没来"（下游故障）就拒绝所有探视（级联）。PDB 是"病房管理"——不能所有病人同时手术（批量重启），至少留几个清醒的接客。

### 面试现场 60 秒回答

> K8s 三探针分工：startup 判"启动完成"（慢启动保护，JVM 预热期 liveness 不生效，failureThreshold × period = 5 分钟）；liveness 判"存活"（死锁/僵死，失败重启 Pod），只 ping 不查业务（不判慢，慢不是死，重启恶化）；readiness 判"能否接流量"（失败摘流量，不重启），只查本地资源不查下游（防级联雪崩，下游故障用熔断降级）。雪崩场景：① liveness 查业务接口 + timeout 短 → 慢请求被判死 → 重启雪崩；② readiness 查下游 → 下游故障全 Pod 摘流量 → 级联。防控：startup 保护启动、liveness 只 ping、readiness 不查下游、PDB（minAvailable: 2）防批量重启、优雅停机配合（preStop 摘流量）、限流熔断（Sentinel 处理下游慢）。Spring Boot 用 /actuator/health/liveness 和 /readiness 分离端点，配置灵活。

### 反问面试官

> 贵司探针配置有规范吗？readiness 查不查下游？这决定我聊探针设计还是雪崩复盘。

## 七、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 有 liveness 不够，为什么还要 readiness？ | liveness 失败重启 Pod（重操作），readiness 失败只摘流量（轻操作）。场景不同：liveness 判"死"（要重启），readiness 判"忙"（暂不接流量但还活着，如启动中/优雅停机中） |
| 证据追问 | 怎么证明探针配置合理？ | ① 误重启率 < 0.1%（liveness 没误判）；② 雪崩次数 = 0（无级联故障）；③ 启动成功率 100%（startup 保护生效）；④ 发布期间可用性 > 99.9% |
| 边界追问 | 探针能解决所有高可用问题吗？ | 不能。① OOM 崩溃（探针来不及响应）；② 数据库故障（用熔断）；③ 网络分区（用多集群）；④ 流量洪峰（用限流）。探针主要解决"Pod 级故障自愈" |
| 反例追问 | 什么场景探针反而有害？ | ① liveness 太敏感（GC 期间误杀）；② readiness 查下游（级联雪崩）；③ startup 不配（慢启动被误杀）；④ 无 PDB（批量重启打爆）。治法：按规范配置 |
| 风险追问 | 探针最大风险？ | ① 误判重启（liveness 配置不当，雪崩）；② 级联故障（readiness 查下游）；③ 启动失败（无 startup，慢启动被杀）。治法：liveness 只 ping、readiness 不查下游、startup 必配 |
| 验证追问 | 怎么验证探针生效？ | ① 模拟死锁（kill -19 主线程，liveness 应失败重启）；② 模拟下游故障（readiness 不应失败）；③ 模拟慢启动（startup 应保护）；④ 模拟批量发布（PDB 应限制） |
| 沉淀追问 | 团队规范沉淀什么？ | ① 探针配置模板（startup/liveness/readiness 标准参数）；② 端点规范（liveness 只 ping、readiness 查本地）；③ PDB 规范（minAvailable）；④ 滚动策略（maxUnavailable: 1） |

### 现场对话示例

**面试官**：readiness 为什么不能检查下游？

**候选人**：级联雪崩风险。假设 readiness 查 MySQL，MySQL 慢时，本服务所有 Pod 的 readiness 失败（db 检查失败），K8s 把所有 Pod 从 Endpoints 移除，服务完全不可用——而本服务其实还活着（能处理缓存命中的请求）。正确做法：readiness 只查本地资源（cache、本地线程池），下游故障用熔断（Sentinel）降级——下游慢时返回降级响应，而不是把整个服务摘掉。熔断是"部分降级"（降级单个依赖），readiness 摘流量是"全部摘除"（雪崩）。

**面试官**：startup probe 解决什么问题？

**候选人**：慢启动应用的 liveness 误杀问题。JVM 启动需要预热（JIT 编译热点代码、加载缓存、建立连接池），可能 1-5 分钟。如果只有 liveness，initialDelaySeconds 配短（30 秒）→ 预热期 liveness 失败被杀，反复重启。配长（5 分钟）→ 真死锁时要等 5 分钟才响应。startup probe 分离职责：startup 期间（failureThreshold × period = 5 分钟）判断"启动完成"，liveness 不生效（不杀 Pod）。startup 成功后 liveness 接管（快速响应死锁）。两者职责清晰，互不干扰。

**面试官**：PDB 防什么？

**候选人**：PDB（PodDisruptionBudget）防"自愿中断"（Voluntary Disruption）的批量重启。自愿中断包括：kubectl drain（节点维护）、滚动更新（发布）、HPA 缩容。PDB 的 minAvailable: 2 表示任何时候至少 2 个 Pod 可用，K8s 不会同时重启超过（replicas - 2）个。注意 PDB 只防自愿中断，不防非自愿中断（Pod 崩溃、节点故障）——那些要靠多副本 + 反亲和性。生产必配 PDB，否则滚动更新可能一次干掉太多 Pod。

## 常见考点

1. **三探针区别？**——startup（启动完成，先于 liveness）；liveness（存活，失败重启）；readiness（接流量，失败摘流量不重启）。
2. **liveness 为什么不判慢？**——慢请求不是死，重启恶化（重启更慢）。liveness 只判死锁/僵死（GC STW、死锁）。
3. **readiness 为什么不查下游？**——下游故障时所有 Pod 摘流量，级联雪崩。下游故障用熔断降级（Sentinel）。
4. **startup 解决什么？**——慢启动（JVM 预热）期间 liveness 误杀。startup 先判断启动完成，期间 liveness 不生效。
5. **PDB 防什么？**——防自愿中断（发布/缩容）的批量重启，minAvailable 保证最少可用 Pod 数。

## 结构化回答


**30 秒电梯演讲：** 像医院的"病人监护系统"——startup 是"术后苏醒监测"（确认病人清醒），liveness 是"心跳监测"（心跳停了=死亡，要抢救），readiness 是"能否接客"（病人能否被探视）。误判会误抢救（重启）或误隔离（摘流量），...

**展开框架：**
1. **三探针** — startup（启动完成）/liveness（存活）/readiness（接流量）
2. **startup** — 先于 liveness（慢启动场景，JVM 预热期不杀 Pod）
3. **liveness** — 只判死锁/僵死，不判慢（慢不是死）

**收尾：** 三探针区别？



## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：Pod 重启、探针与服务雪崩防控 | "这题核心是——K8s 三探针（startup/liveness/readiness）+ 重启机制是服务自愈的核心，……" | 开场钩子 |
| 0:15 | 三探针示意/对比图 | "startup（启动完成）/liveness（存活）/readiness（接流量）" | 三探针要点 |
| 0:40 | startup 先于 l示意/对比图 | "startup 先于 liveness（慢启动场景，JVM 预热期不杀 Pod）" | startup 先于 l要点 |
| 1:25 | 总结卡 | "记住：三探针。下期见。" | 收尾 |
