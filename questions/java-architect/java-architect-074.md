---
id: java-architect-074
difficulty: L2
category: java-architect
subcategory: 高可用
tags:
- Java 架构师
- Kubernetes
- Java
- 资源
feynman:
  essence: K8s 上 Java 服务资源治理的核心矛盾是"容器 cgroup 限制"与"JVM 内存模型"的认知错位。K8s 用 request/limit 控制 CPU 和内存，JVM 按堆/非堆/直接内存划分，两者不对齐会导致 OOMKilled（容器超限被杀）或资源浪费（堆设太小）。CPU 限流（CFS throttle）会让 JVM STW 看起来像 GC 停顿。
  analogy: 像把一头大象（JVM 完整内存模型：堆+栈+元空间+直接内存+GC overhead）关进一个精确到克的笼子（K8s memory limit）。笼子标了 4GB，但大象实际要吃堆 3GB + 元空间 512MB + 线程栈 512MB + GC overhead 512MB = 4.5GB，结果被饿死（OOMKilled）。
  first_principle: 容器的 CPU/内存限制是硬约束（超了被 kill 或 throttle），JVM 看不到容器边界（早期版本按宿主机内存算）。要让 JVM 在容器里稳定运行，必须让 JVM 内存各区（堆+元空间+线程栈+直接内存+JIT+GC overhead）的总和小于容器 memory limit，且 CPU limit 要留余量避免 CFS throttle。
  key_points:
  - JVM 内存 ≠ 堆内存：总内存 = 堆 + Metaspace + 线程栈×线程数 + 直接内存 + JIT cache + GC overhead
  - 容器 memory limit 必须 > JVM 总内存 + 安全余量（通常留 25%）
  - 用 MaxRAMPercentage 而非 -Xmx 设堆（自动适配容器内存）
  - CPU limit 过低导致 CFS throttle（JVM 表现为偶发 STW、RT 抖动），Java 11+ 用 +UseContainerSupport
  - HPA（水平自动扩缩）基于 CPU/内存利用率，阈值要配合 JVM 行为调（如 GC 频繁时 CPU 会飙）
first_principle:
  problem: 一个 4C8G 容器里跑 Java 服务，线上偶发 OOMKilled 和 RT 抖动，如何定位是容器资源配比问题还是 JVM 配置问题？
  axioms:
  - 容器 memory limit 是硬上限，JVM 各内存区总和超了就被 OOMKilled（不是 OOM 异常，是内核 SIGKILL）
  - CPU limit 用 CFS 调度，超了被 throttle（不是报错，是进程暂停执行）
  - JVM 早期版本（8u191 前）不识别 cgroup，按宿主机内存算堆大小导致 OOMKilled
  rebuild: 分三步——第一，算清 JVM 总内存（堆+元空间+线程栈+直接内存+GC overhead），确保 < 容器 memory limit × 0.75。第二，用 -XX:MaxRAMPercentage=75 替代 -Xmx（JDK 10+ 自动适配容器内存），加 -XX:+UseContainerSupport。第三，CPU request/limit 配置合理（request 用于调度，limit 用于 CFS），监控 container_cpu_cfs_throttled_seconds，throttle 高就调大 limit 或减并发。
follow_up:
  - OOMKilled 和 Java OOM 有什么区别？——OOMKilled 是内核 SIGKILL（容器超 memory limit），JVM 来不及打印堆栈，dmesg 或 kubectl describe 能看到 OOMKilled。Java OOM（java.lang.OutOfMemoryError）是 JVM 内部异常，能打堆栈，容器没超限
  - 为什么 CPU limit 要用但不设太低？——CPU limit 设太低导致 CFS throttle（时间片用完后等到下个周期才能执行），JVM 看起来像偶发停顿，GC、网络处理都受影响。生产建议 request=limit（绑核避免 throttle）或 limit=2×request
  - JVM 怎么看容器内存？——JDK 8u191+ 支持 -XX:+UseContainerSupport（默认开），能读 cgroup 内存限制。-XX:InitialRAMPercentage/MaxRAMPercentage 按容器内存百分比设堆
  - HPA 基于 CPU 利用率，但 GC 时 CPU 会飙怎么办？——HPA 误判会频繁扩缩容。解法：HPA 阈值设宽（如 80% 而非 50%）、用自定义指标（QPS/RT）而非 CPU、GC 调优减少 Full GC
  - Pod 重启（OOMKilled）怎么定位？——kubectl describe pod 看 Last State 的 Reason（OOMKilled）和 Exit Code（137）；kubectl get events 看 pod_restart_count；JVM 加 -XX:+HeapDumpOnOutOfMemorySeparator 但 OOMKilled 抓不到 dump（来不及）
memory_points:
  - JVM 总内存 = 堆 + Metaspace + 线程栈×线程数 + 直接内存 + JIT + GC overhead
  - 容器 memory limit > JVM 总内存 × 1.25（留 25% 余量）
  - 用 MaxRAMPercentage=75 替代 -Xmx（自动适配容器）
  - OOMKilled = 容器超限被内核杀（Exit Code 137），Java OOM = JVM 异常（能打堆栈）
  - CFS throttle = CPU limit 被限流，监控 container_cpu_cfs_throttled_seconds
  - HPA 用业务指标（QPS/RT）而非 CPU，避免 GC 抖动误扩缩
---

# 【Java 后端架构师】Kubernetes 上 Java 服务的资源治理

> 适用场景：JD 核心技术。交易服务容器化部署在 K8s，规格 4C8G。大促期间偶发 OOMKilled（容器被杀）和 RT 抖动。架构师必须算清 JVM 各内存区与容器 limit 的关系、定位 CFS throttle、设计 HPA 策略保证大促弹性。

## 一、概念层：容器限制与 JVM 内存模型

**JVM 在容器里的完整内存画像**（面试必画）：

```
┌────────────────── 容器 memory limit = 8 GB ──────────────────┐
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │           JVM 进程总内存 ≈ 7.5 GB                    │   │
│  │                                                      │   │
│  │  ┌─────────────────────┐  堆 Heap = 6 GB (75%)       │   │
│  │  │  Eden + Survivor    │  -XX:MaxRAMPercentage=75    │   │
│  │  │  Old (G1 Region)    │                             │   │
│  │  └─────────────────────┘                             │   │
│  │  ┌─────────────────────┐  Metaspace ≈ 256 MB         │   │
│  │  │  类元信息、常量池    │  -XX:MaxMetaspaceSize=256m │   │
│  │  └─────────────────────┘                             │   │
│  │  ┌─────────────────────┐  线程栈 = 200×1MB = 200 MB  │   │
│  │  │  200 个线程 × 1MB    │  -Xss1m (默认 1MB/线程)    │   │
│  │  └─────────────────────┘                             │   │
│  │  ┌─────────────────────┐  直接内存 ≈ 512 MB          │   │
│  │  │  DirectByteBuffer   │  -XX:MaxDirectMemorySize   │   │
│  │  │  (Netty/NIO)        │                             │   │
│  │  └─────────────────────┘                             │   │
│  │  ┌─────────────────────┐  JIT + GC overhead ≈ 500 MB │   │
│  │  │  CodeCache、G1 内部 │  -XX:ReservedCodeCacheSize │   │
│  │  └─────────────────────┘                             │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌─────────────────────┐  安全余量 = 512 MB (留给 OS、cgroup)│
│  └─────────────────────┘                                     │
└──────────────────────────────────────────────────────────────┘

关键：堆 6G + 元空间 256M + 线程栈 200M + 直接内存 512M + JIT/GC 500M = 7.46G
      + 余量 512M = 7.98G < 8G limit（刚好安全）
```

**OOMKilled vs Java OOM 对比**（面试必考）：

| 维度 | OOMKilled（容器级） | Java OOM（JVM 级） |
|------|---------------------|-------------------|
| **触发** | JVM 进程总内存 > 容器 memory limit | 堆/Metaspace/直接内存 用满 |
| **执行者** | Linux 内核（cgroup OOM Killer） | JVM 自己抛异常 |
| **信号** | SIGKILL（进程立即终止） | 无信号，抛 OutOfMemoryError |
| **Exit Code** | 137（128 + 9，SIGKILL） | 1（或自定义） |
| **堆栈** | 抓不到（来不及 dump） | 能打 heap dump（-XX:+HeapDumpOnOutOfMemorySeparator） |
| **容器状态** | RestartCount +1，Last State OOMKilled | 进程退出，容器也可能重启 |
| **定位方式** | kubectl describe pod / dmesg | GC 日志 + heap dump + MAT |

## 二、机制层：Deployment YAML + JVM 容器参数

**生产级 Deployment YAML**（核心配置，逐字段能解释）：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-service
  labels:
    app: order-service
spec:
  replicas: 10
  selector:
    matchLabels:
      app: order-service
  template:
    metadata:
      labels:
        app: order-service
        version: v1
    spec:
      containers:
        - name: order-service
          image: registry.jd.com/order-service:1.0.0
          ports:
            - containerPort: 8080

          # 资源配额（核心）
          resources:
            requests:
              cpu: "2000m"        # 2 核（调度依据，保证拿到）
              memory: "8Gi"       # 8G（调度依据）
            limits:
              cpu: "4000m"        # 4 核（CFS 上限，最多用 4 核）
              memory: "8Gi"       # 8G（硬上限，超了 OOMKilled）
              # 注意：memory request=limit 避免内存超卖导致的 OOM 风暴

          # JVM 参数（通过 JAVA_OPTS 环境变量传入）
          env:
            - name: JAVA_OPTS
              value: >-
                -XX:+UseContainerSupport
                -XX:InitialRAMPercentage=50.0
                -XX:MaxRAMPercentage=75.0
                -XX:+UseG1GC
                -XX:MaxGCPauseMillis=100
                -XX:+HeapDumpOnOutOfMemorySeparator
                -XX:HeapDumpPath=/data/heapdump/
                -XX:MaxMetaspaceSize=256m
                -XX:MaxDirectMemorySize=512m
                -Xss512k
                -Djava.security.egd=file:/dev/./urandom
                -XX:+UseZGC                        # JDK 21+ 用 Generational ZGC
                -XX:+ZGenerational

          # 健康检查（保证 K8s 能摘除不健康 Pod）
          livenessProbe:
            httpGet:
              path: /actuator/health/liveness
              port: 8080
            initialDelaySeconds: 60     # JVM 启动慢，给足时间
            periodSeconds: 10
            failureThreshold: 3
          readinessProbe:
            httpGet:
              path: /actuator/health/readiness
              port: 8080
            initialDelaySeconds: 30
            periodSeconds: 5
            failureThreshold: 3

          # 启动探针（JDK 启动慢，避免被 liveness 误杀）
          startupProbe:
            httpGet:
              path: /actuator/health/liveness
              port: 8080
            failureThreshold: 30        # 30×10s=5 分钟启动窗口
            periodSeconds: 10

          # 优雅终止（保证请求处理完才停）
          lifecycle:
            preStop:
              exec:
                command: ["sh", "-c", "sleep 15"]   # 先等负载均衡摘除
            # 配合 terminationGracePeriodSeconds: 60

      terminationGracePeriodSeconds: 60
```

**JVM 容器参数详解**（每个都要能解释）：

```bash
# 1. 容器感知（JDK 10+ 默认开，JDK 8u191+ 需确认）
-XX:+UseContainerSupport
#   JVM 读取 cgroup 内存/CPU 限制，按容器规格算堆

# 2. 堆按容器内存百分比（替代 -Xmx，自动适配不同规格）
-XX:InitialRAMPercentage=50.0    # 初始堆 = 容器内存 × 50%
-XX:MaxRAMPercentage=75.0        # 最大堆 = 容器内存 × 75%
#   8G 容器 → 初始堆 4G，最大堆 6G
#   不要用 -Xmx6g 硬编码（换规格要改参数）

# 3. 非堆内存限制（防止 Metaspace/直接内存泄漏撑爆容器）
-XX:MaxMetaspaceSize=256m        # 元空间上限
-XX:MaxDirectMemorySize=512m     # 直接内存上限（Netty/NIO 用）
-Xss512k                         # 线程栈（默认 1MB 太大，200 线程省 100M）

# 4. GC 配置
-XX:+UseG1GC                     # 或 ZGC（JDK 21+ 用 Generational ZGC）
-XX:MaxGCPauseMillis=100
-XX:+UseZGC -XX:+ZGenerational   # JDK 21+ 超低延迟

# 5. OOM 诊断
-XX:+HeapDumpOnOutOfMemorySeparator     # Java OOM 时自动 dump（OOMKilled 抓不到）
-XX:HeapDumpPath=/data/heapdump/

# 6. 容器特殊优化
-Djava.security.egd=file:/dev/./urandom  # 加速 SecureRandom（否则启动慢）
```

## 三、机制层：CFS CPU 限流与 HPA 弹性

**CFS Throttle 原理**（CPU limit 导致的偶发停顿）：

```
CPU limit = 2000m（2 核），CFS period = 100ms
每个 100ms 周期，进程最多用 200ms CPU 时间（2 核 × 100ms）

时间线：
├── 0-50ms：满负载运行（用掉 100ms 配额，因为 2 核）
├── 50-100ms：THROTTLED（配额用完，进程暂停）
├── 100ms：新周期，恢复运行
├── ...

现象：RT 抖动、GC 停顿延长（GC 线程也被 throttle）
监控：container_cpu_cfs_throttled_seconds_total 持续增长
```

**CFS Throttle 的 JVM 表现**：

```bash
# JVM 看到的：偶发 STW，但不是 GC 引起
# GC 日志：没有对应的 GC pause
# 火焰图：出现大量 kernel态的 sched 等待

# 查看是否被 throttle
cat /sys/fs/cgroup/cpu/cpu.stat
#   nr_periods 12345
#   nr_throttled 678      # 被 throttle 的周期数
#   throttled_time 12.5s  # 总 throttle 时间
```

**HPA 配置**（水平自动扩缩）：

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: order-service-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: order-service
  minReplicas: 10
  maxReplicas: 100              # 大促扩到 100 副本
  metrics:
    # 基于 CPU 利用率（阈值 70%）
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
    # 基于内存利用率（阈值 80%）
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 80
    # 基于自定义指标（QPS，更准）
    - type: Pods
      pods:
        metric:
          name: http_requests_per_second
        target:
          type: AverageValue
          averageValue: "500"   # 每副本 500 QPS 触发扩容
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 0   # 扩容立即生效
      policies:
        - type: Percent
          value: 100                   # 一次最多翻倍
          periodSeconds: 60
    scaleDown:
      stabilizationWindowSeconds: 300  # 缩容等 5 分钟（避免抖动）
      policies:
        - type: Percent
          value: 10                    # 一次最多缩 10%
          periodSeconds: 60
```

## 四、实战层：OOMKilled 与 CFS Throttle 排查

**OOMKilled 排查链路**：

```bash
# 1. 看容器重启原因
kubectl describe pod order-service-xxx
#   Last State: Terminated
#     Reason: OOMKilled        # ← 容器内存超限被杀
#     Exit Code: 137           # 128 + 9 (SIGKILL)

# 2. 看重启次数
kubectl get pods -o wide
#   NAME              READY   STATUS    RESTARTS   # RESTARTS > 0 说明重启过
#   order-service-1   1/1     Running   3

# 3. 看事件
kubectl get events --field-selector involvedObject.name=order-service-xxx
#   LAST SEEN   TYPE     REASON      MESSAGE
#   2m          Warning  BackOff     Container failed liveness probe...

# 4. 算 JVM 内存各区总和，定位哪个区超了
#    堆 6G + 元空间 256M + 线程栈（可能泄漏到 1000 线程 × 1M = 1G）
#    定位：线程数泄漏（线程池没上限），线程栈撑爆容器

# 5. 修复：限制线程数 + 调小堆给线程栈留余量
```

**CFS Throttle 排查链路**：

```bash
# 1. Prometheus 看 throttle 指标
rate(container_cpu_cfs_throttled_seconds_total{pod="order-service-xxx"}[5m]) > 0
#   如果持续 > 0，说明在 throttle

# 2. 计算 throttle 比例
sum(rate(container_cpu_cfs_throttled_seconds_total[5m])) by (pod)
  / sum(rate(container_cpu_cfs_periods_total[5m])) by (pod)
#   > 10% 就要关注

# 3. 定位：CPU limit 设太低，或线程数太多导致竞争
#    解法：调大 CPU limit（如 2000m → 4000m），或减少并发线程数
```

## 五、底层本质：为什么 Java 在容器里容易翻车

回到第一性：**Java 设计于物理机时代，假设能独占整机资源；K8s 用 cgroup 做硬隔离，两者心智模型不对齐**。

- **内存认知错位**：早期 JVM（8u191 前）按宿主机内存算堆（如 64G 物理机，默认堆 16G），但容器 limit 只给 4G，堆还没满容器就 OOMKilled。8u191 后才默认识别 cgroup。即使现在，JVM 的堆/非堆/直接内存分区与容器的单一 memory limit 不对齐——堆设 6G 但忘了限制直接内存，Netty 用了 3G 直接内存，总内存超 8G 还是 OOMKilled。
- **CPU 认知错位**：JVM 的 GC、JIT、线程调度假设能瞬间拿到 CPU。容器的 CFS 调度按时间片分配（100ms 周期），CPU limit 低时 GC 线程被 throttle，原本 50ms 的 GC pause 变成 200ms（中间被暂停）。这不是 GC 问题，是调度问题，但表现为 RT 抖动。
- **启动慢**：JVM 启动要加载类、JIT 预热，比 Go/Python 慢（几十秒 vs 几秒）。K8s 的 livenessProbe 默认快速探测，JVM 还没起来就被判不健康重启（循环重启）。解法是 startupProbe + 长 initialDelaySeconds。Spring Boot 用 AOT compilation（GraalVM Native Image）能解决启动慢但牺牲灵活性。

**资源配比的核心公式**：`容器 memory limit > 堆 + Metaspace + 线程栈×线程数 + 直接内存 + JIT/GC overhead + 安全余量(25%)`。用 MaxRAMPercentage 设堆，其他区也要显式限制（MaxMetaspaceSize、MaxDirectMemorySize），不能只盯堆。

## 六、AI 架构师加问：5 个

1. **AI 能自动推荐容器的 request/limit 配比吗？**
   能做辅助。AI 分析历史 metrics（cpu_usage、memory_usage、gc_pause）+ 应用画像（QPS、线程数），推荐 request/limit。但必须人工确认——AI 可能推荐过低的 limit 导致 OOMKilled 或 throttle。上线后监控 restart_count 和 throttled_time，持续调优。

2. **HPA 的弹性扩缩怎么避免 GC 抖动误判？**
   HPA 基于 CPU 利用率时，Full GC 会让 CPU 短暂飙到 100%，HPA 误扩容。解法：用自定义指标（QPS、RT）替代 CPU，或设扩容冷却窗口（stabilizationWindowSeconds）。AI 能做更智能的弹性——预测大促流量提前扩容，而非反应式。

3. **AI 推理服务（GPU）在 K8s 上怎么资源治理？**
   GPU 是独占资源（一张卡一个 Pod 或 MIG 分区）。CPU/内存仍用 cgroup，但 GPU 显存要单独监控（nvidia_gpu_memory_used）。JVM 跑 CPU 推理时用常规配置，跑 GPU 推理时要注意 JVM 不占 GPU 但占 CPU（数据预处理），要预留。

4. **用 AI 做容器 OOMKilled 的根因分析？**
   AI 分析 Pod 的 metrics 历史（内存增长曲线）+ JVM 内存各区分布 + 容器事件，归因到"线程泄漏/Metaspace 泄漏/直接内存泄漏/堆 OOM/堆外 OOM"。但 OOMKilled 抓不到 heap dump，AI 只能基于趋势分析给出假设，人工验证。

5. **Serverless Java（Knative/Scale-to-zero）怎么处理 JVM 启动慢？**
   JVM 冷启动几十秒，Scale-to-zero 后首次请求超时。解法：GraalVM Native Image（启动 < 100ms 但牺牲反射/GC 调优）、CRaC（Coordinated Restore at Checkpoint，快照恢复）、或 minReplicas=1 保持热实例。AI 能预测流量模式，提前 warm up 冷实例。

## 七、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"各区内存算总和、MaxRAMPercentage、CFS throttle、startupProbe"**。

- **内存总和**：堆+元空间+线程栈+直接内存+GC overhead < limit×0.75
- **堆配置**：MaxRAMPercentage=75 替代 -Xmx，自动适配容器规格
- **OOMKilled**：容器超 memory limit 被内核 SIGKILL（Exit 137），非 Java OOM
- **CFS throttle**：CPU limit 低导致进程暂停，监控 throttled_seconds
- **HPA**：用 QPS/RT 自定义指标，避免 GC 抖动误扩缩
- **启动**：startupProbe + 长 initialDelaySeconds 防 JVM 被误杀

### 拟人化理解

把容器资源治理想成**精确配料的厨房**。K8s 给你一口 8L 的锅（memory limit），JVM 这道菜要用米（堆）6L + 调料（元空间）0.25L + 配菜（线程栈）0.2L + 水（直接内存）0.5L + 火候余量（GC）0.5L，总和 7.45L < 8L 锅才不溢出。火候（CPU）开太大被限流（CFS throttle），菜就半生不熟（RT 抖动）。

### 面试现场 60 秒回答

> 核心是 JVM 内存各区总和要小于容器 memory limit。堆用 MaxRAMPercentage=75 自动适配（不用 -Xmx 硬编码），但元空间（MaxMetaspaceSize）、直接内存（MaxDirectMemorySize）、线程栈（Xss×线程数）也要显式限制，否则 Netty 直接内存泄漏或线程数泄漏都会撑爆容器。OOMKilled 是容器超 limit 被内核 SIGKILL（Exit 137），和 Java OOM（能打堆栈）不同，排查要看 kubectl describe 的 Last State。CPU 用 CFS 调度，limit 太低导致 throttle，表现为 RT 抖动但 GC 日志没停顿，监控 container_cpu_cfs_throttled_seconds。HPA 用 QPS/RT 自定义指标而非 CPU，避免 Full GC 时 CPU 飙升误扩容。JVM 启动慢要配 startupProbe + 长 initialDelaySeconds，否则被 liveness 误杀循环重启。

### 反问面试官

> 贵司容器规格是多大（如 4C8G）？有没有遇到过 OOMKilled 频发或 CFS throttle？HPA 是基于 CPU 还是自定义指标？这决定我聊内存配比还是 CPU 治理。

## 八、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么用容器而不是物理机？容器对 Java 有什么坑？ | 用数据说话：容器提升资源利用率（物理机 20%→容器 60%）、弹性快。坑是 JVM 内存模型与 cgroup 不对齐（OOMKilled）、CFS throttle、启动慢。证明：restart_count、throttled_time 指标 |
| 证据追问 | 怎么证明某个 Pod 是 OOMKilled 而不是代码 bug？ | kubectl describe 看 Last State Reason=OOMKilled、Exit Code=137；kubectl get events 看 BackOff；dmesg 看内核 OOM 日志；JVM heap dump 抓不到（来不及）则确认是容器级而非 JVM 级 |
| 边界追问 | 容器资源治理能解决所有 Java 稳定性问题吗？ | 不能。解决不了 GC 调优（堆设对但 GC 算法不合适）、线程池打满（业务并发太高）、慢 SQL（DB 瓶颈）、网络抖动。资源治理是基础，还要 JVM 调优 + 业务治理 |
| 反例追问 | 什么场景 Java 不该上 K8s？ | 超低延迟（微秒级，高频交易，容器调度开销不可接受）、超大堆（> 64G，G1/ZGC 在容器里效果不如物理机）、强依赖本地存储（如数据库本身）。这类用物理机或专属调度 |
| 风险追问 | 容器化 Java 最大风险？ | 主动点出：memory request≠limit 导致内存超卖 OOM 风暴（多个 Pod 同时 OOMKilled）、CPU limit 低导致 CFS throttle（RT 抖动难定位）、JVM 启动慢被 liveness 误杀（循环重启）、cgroup v1 vs v2 差异 |
| 验证追问 | 怎么证明资源配比合理？ | 压测单 Pod 极限（CPU 80% 时 QPS），按 SLA 倒推副本数；监控 restart_count=0（无 OOMKilled）、throttled_time<1%（无 CPU 限流）、GC pause 正常；故障演练（kill Pod 验证 HPA 扩容时效） |
| 沉淀追问 | 团队容器规范沉淀什么？ | 按服务类型的 Deployment 模板（网关/交易/批处理不同配比）、JVM 参数标准模板（MaxRAMPercentage + 非堆限制）、HPA 配置 SOP（指标选择、阈值、冷却窗口）、OOMKilled 排查 checklist |

### 现场对话示例

**面试官**：线上 Java 服务偶发 RT 抖动，GC 日志正常，你怎么定位？

**候选人**：GC 正常说明不是 GC 停顿，先怀疑 CFS throttle。看 Prometheus 的 container_cpu_cfs_throttled_seconds_total，如果抖动时段这个指标飙升，就是 CPU limit 被限流了。根因是 limit 设太低（如 2 核）但实际 CPU 需求高于 2 核（如 GC 线程 + 业务线程 + JIT 同时竞争）。解法：调大 CPU limit（如 4 核），或减少并发线程数。彻底解法是 request=limit 绑核（独占 CPU 避免 throttle）。另一个可能是内存接近 limit 导致内核频繁回收 page cache，表现为 RT 抖动，看 container_memory_working_set_bytes 接近 limit。

**面试官**：OOMKilled 抓不到 heap dump，怎么排查内存泄漏？

**候选人**：OOMKilled 是内核杀的，JVM 来不及 dump。排查思路：第一，看是堆 OOM 还是堆外 OOM——如果堆没用满（jstat 看 O 区没满）但容器超限，是堆外（直接内存、Metaspace、线程栈）。第二，用 Native Memory Tracking（-XX:NativeMemoryTracking=detail）看 JVM 各区内存分布。第三，jcmd 看 Thread 数（线程栈泄漏）和 DirectByteBuffer（直接内存泄漏）。第四，临时加 -XX:MaxDirectMemorySize 限制直接内存，看是否还 OOMKilled。长期：给所有非堆区设上限，堆用 MaxRAMPercentage，总和留 25% 余量。

**面试官**：HPA 基于 CPU 扩容，大促时扩太慢怎么办？

**候选人**：两个问题。第一，CPU 指标滞后——等 CPU 飙到 70% 才扩容，新 Pod 启动要 1-2 分钟（JVM 启动+预热），这时流量已经打满了。解法：用 QPS 作为前置指标（QPS 涨比 CPU 快），或大促前定时预扩容（CronHPA 提前扩）。第二，缩容抖动——流量波动导致 HPA 频繁扩缩，新 Pod 预热没完成就被缩。解法：scaleDown 的 stabilizationWindowSeconds 设大（5-10 分钟）、缩容步长小（一次 10%）。最佳实践：HPA + 预扩容 + 业务低峰期定时缩容，三者结合。

## 常见考点

1. **OOMKilled 和 Java OOM 区别？**——OOMKilled 是容器超 memory limit 被内核 SIGKILL（Exit 137），抓不到堆栈；Java OOM 是 JVM 内部异常（OutOfMemoryError），能打 heap dump。排查 OOMKilled 看 kubectl describe 的 Last State + dmesg。
2. **JVM 在容器里怎么配堆？**——用 -XX:MaxRAMPercentage=75（JDK 10+），不用 -Xmx 硬编码。8G 容器自动算出堆 6G。还要配 MaxMetaspaceSize、MaxDirectMemorySize 限制非堆。
3. **CFS throttle 是什么？**——K8s CPU limit 用 CFS 调度，周期（100ms）内 CPU 时间用完就暂停进程。表现为 RT 抖动、GC 延长。监控 container_cpu_cfs_throttled_seconds，解法是调大 limit 或 request=limit 绑核。
4. **HPA 怎么配置才不抖？**——用 QPS/RT 自定义指标（比 CPU 准）、scaleDown stabilizationWindowSeconds 设 5-10 分钟、缩容步长小、大促前定时预扩容。
5. **JVM 启动慢被 liveness 误杀怎么办？**——配 startupProbe（failureThreshold=30, period=10s 给 5 分钟启动窗口）+ livenessProbe 的 initialDelaySeconds 设够长。

## 结构化回答

**30 秒电梯演讲：** K8s 上 Java 服务资源治理的核心矛盾是容器 cgroup 限制与JVM 内存模型的认知错位。K8s 用 request/limit 控制 CPU 和内存，JVM 按堆/非堆/直接内存划分，两者不对齐会导致 OOMKilled（容器超限被杀）或资源浪费（堆设太小）。CPU 限流（CFS throttle）会让 JVM STW 看起来像 GC 停顿

**展开框架：**
1. **JVM 内存 ≠ 堆内存** — 总内存 = 堆 + Metaspace + 线程栈×线程数 + 直接内存 + JIT cache + GC overhead
2. **容器 memory li** — 容器 memory limit 必须 > JVM 总内存 + 安全余量（通常留 25%）
3. **用 MaxRAMPercentage 而非** — Xmx 设堆（自动适配容器内存）

**收尾：** 以上是我的整体思路。您想继续深入聊——OOMKilled 和 Java OOM 有什么区别？


## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：Kubernetes 上 Java 服务的资源治 | "这题一句话：K8s 上 Java 服务资源治理的核心矛盾是容器 cgroup 限制与JVM 内存模型的认知错位。" | 开场钩子 |
| 0:15 | JVM 内存 ≠ 堆内存示意/对比图 | "总内存 = 堆 + Metaspace + 线程栈×线程数 + 直接内存 + JIT cache + GC overhead" | JVM 内存 ≠ 堆内存要点 |
| 0:40 | 容器 memory li示意/对比图 | "容器 memory limit 必须 > JVM 总内存 + 安全余量（通常留 25%）" | 容器 memory li要点 |
| 1:25 | 总结卡 | "记住：JVM 总内存 = 堆 +。下期见。" | 收尾 |
