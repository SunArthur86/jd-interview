---
id: java-architect-116
difficulty: L2
category: java-architect
subcategory: 可观测性
tags:
- Java 架构师
- eBPF
- 可观测性
- 内核观测
feynman:
  essence: eBPF（Extended Berkeley Packet Filter）是 Linux 内核的可编程沙箱——在内核态运行沙箱程序，无需改内核源码或加载内核模块。在 Java 可观测性场景，eBPF 提供内核级观测：网络（TCP 连接/重传/延迟）、文件 IO、系统调用、CPU 调度，无需改 Java 代码、无需 Agent、几乎零开销。代表项目：Pixie（K8s 网络观测）、Parca（持续 profiling）、Cilium（网络+可观测性）。
  analogy: 像"超级仪表盘的探针"——传统监控是"在车上装 GPS"（应用层埋点），eBPF 是"在路面装传感器"（内核层观测）。不用改车（应用），传感器看所有经过的车。
  first_principle: 传统可观测性的盲区是内核态——Java Agent 看不到 TCP 重传、syscall 延迟、CPU 调度。eBPF 把观测点放到内核：① 无侵入（不改应用代码）；② 全量观测（所有进程的网络/IO/syscall）；③ 低开销（JIT 编译，纳秒级钩子）。补齐应用层监控的盲区。
  key_points:
  - eBPF = Linux 内核可编程沙箱（不改内核源码）
  - 钩子点：kprobe/uprobe/tracepoint/XDP/TC
  - 无侵入观测 Java：网络/IO/syscall/CPU 调度
  - 代表项目：Pixie/Parca/Cilium/bpftrace
  - 几乎零开销（JIT 编译 + 验证器）
  - 补齐应用层监控（Agent/Micrometer）的内核盲区
first_principle:
  problem: Java 应用层监控（Agent/Micrometer）看不到 TCP 重传、syscall 阻塞、CPU 调度延迟，怎么补齐？
  axioms:
  - 应用层只能看到应用调用栈（HTTP/JDBC），看不到内核
  - 内核问题是高阶故障源（网络抖动、IO 阻塞、调度饥饿）
  - 改内核源码或加模块不现实（生产环境不允许）
  rebuild: eBPF 在内核态运行沙箱程序，钩子点（kprobe/uprobe/tracepoint）拦截内核函数。程序经验证器（安全检查）+ JIT 编译后执行。观测 Java：① 网络层（TCP 重传、连接延迟、RTT）；② IO 层（文件读写延迟）；③ syscall（open/read/write 频率和耗时）；④ CPU 调度（调度延迟、上下文切换）。应用零改动、Agent 不用部署、开销 < 1%。
follow_up:
  - eBPF 和 Java Agent 区别？——Agent 在应用层（JVM 内）观测 HTTP/JDBC；eBPF 在内核层观测网络/IO/syscall。互补，不替代
  - eBPF 安全吗？——验证器（verifier）保证程序安全（无死循环、不越界访问内存）。eBPF 程序要 root 权限加载（CAP_BPF）
  - eBPF 看什么 Java 指标？——TCP 重传率、连接延迟（三次握手耗时）、syscall 频率、CPU 调度延迟、GC 引起的 STW 对 syscall 的影响
  - eBPF 能看 JVM 内部吗？——能通过 uprobe 钩 JVM 函数（如 JVM_GC_Pause），但不如 JFR 详细。eBPF 优势在内核观测，JVM 内部用 JFR
  - eBPF 怎么用？——bpftrace（命令行脚本）/Pixie（K8s 一键观测）/Parca（持续 profiling）/Cilium（网络+可观测）
memory_points:
  - eBPF = Linux 内核可编程沙箱（不改内核源码）
  - 钩子点：kprobe（内核函数）/uprobe（用户函数）/tracepoint/XDP（网络包）
  - 验证器 + JIT 编译 → 安全 + 高性能
  - 补应用层监控的内核盲区（TCP/syscall/调度）
  - 代表项目：Pixie/Parca/Cilium/bpftrace
  - 应用零改动、Agent 不用部署、开销 < 1%
  - Java 场景：网络抖动/IO 阻塞/GC 对 syscall 影响
---

# 【Java 后端架构师】eBPF 与 Java 服务可观测性如何结合

> 适用场景：JD 核心技术。订单服务偶发 P99 抖动，应用层监控（Micrometer/OTel）显示一切正常，但用户投诉。架构师用 eBPF 观测内核态，发现是 TCP 重传率突升（机房网络抖动），定位到应用层看不到的盲区。

## 一、概念层：eBPF 的内核可编程沙箱

**eBPF 是什么**：

```
用户态：Java 应用 / bpftrace / Pixie
            │  加载 eBPF 程序
            ▼
─────────────────────────────────
内核态：
   ┌──────────────────────────────────────┐
   │ eBPF 钩子点                          │
   │ ┌────────┬─────────┬──────────────┐  │
   │ │kprobe │ uprobe  │ tracepoint   │  │
   │ │(内核) │ (用户)  │ (静态点)     │  │
   │ └────────┴─────────┴──────────────┘  │
   │ ┌────────┬──────────────────────┐    │
   │ │ XDP    │ TC（Traffic Control）│    │  ← 网络层
   │ │(网卡)  │ (网卡队列)           │    │
   │ └────────┴──────────────────────┘    │
   │                                      │
   │ eBPF 程序（验证器 + JIT 编译后执行） │
   └──────────────────────────────────────┘
            │  输出到 ring buffer / map
            ▼
用户态：分析（Grafana / bpftrace 输出）
```

**eBPF 钩子点分类**（这张表面试必问）：

| 钩子点 | 位置 | 用途 | Java 场景 |
|--------|------|------|----------|
| **kprobe / kretprobe** | 内核函数入口/返回 | 拦截内核函数 | TCP 重传、syscall |
| **uprobe / uretprobe** | 用户函数入口/返回 | 拦截应用函数 | JVM 内部、JDK 函数 |
| **tracepoint** | 内核静态点 | 内核预定义点 | 调度、syscall |
| **XDP（eXpress Data Path）** | 网卡驱动层 | 最早处理网络包 | DDoS 防护、L4 过滤 |
| **TC（Traffic Control）** | 网卡队列 | 网络流量控制 | 流量观测、限速 |
| **perf_event** | 性能事件 | CPU 计数器 | 火焰图、profiling |

**eBPF vs 传统可观测性**：

| 维度 | 传统（Agent/Micrometer） | eBPF |
|------|------------------------|------|
| **观测层** | 应用层（JVM 内） | 内核层（网络/IO/syscall） |
| **侵入性** | 需部署 Agent / 改代码 | 零侵入（不改应用） |
| **覆盖** | 单进程 | 全机器所有进程 |
| **盲区** | 内核态（TCP/调度） | JVM 内部（需 JFR 补） |
| **开销** | 1-5% CPU | < 1% CPU（JIT 编译） |

## 二、机制层：bpftrace 实战与 Java 场景

**bpftrace 命令行示例**：

```bash
# 1. 观测 TCP 连接建立耗时（三次握手）
bpftrace -e '
  kprobe:tcp_v4_connect { @start[tid] = nsecs; }
  kretprobe:tcp_v4_connect /@start[tid]/ {
    @tcp_connect_us = hist((nsecs - @start[tid]) / 1000);
    delete(@start[tid]);
  }
'
# 输出：TCP 连接建立耗时分布（微秒）
# 看到慢连接 → 定位下游服务慢

# 2. 观测 TCP 重传（网络抖动根因）
bpftrace -e '
  tracepoint:tcp:tcp_retransmit_skb {
    @retransmit[ntop(args->saddr), ntop(args->daddr)] = count();
  }
'
# 输出：每个 IP 对的重传次数
# 看到 192.168.1.10 -> 192.168.1.20 重传 100 次 → 网络抖动

# 3. 观测 syscall 频率（Java 应用 IO 模式）
bpftrace -e '
  tracepoint:raw_syscalls:sys_enter { @[comm, args->id] = count(); }
'
# 输出：进程 + syscall ID + 调用次数
# 看到 java 进程 epoll_wait 调用 100w 次/秒 → 事件循环高频

# 4. 观测文件 IO 延迟（磁盘瓶颈）
bpftrace -e '
  kprobe:vfs_read { @start[tid] = nsecs; }
  kretprobe:vfs_read /@start[tid]/ {
    @read_us = hist((nsecs - @start[tid]) / 1000);
    delete(@start[tid]);
  }
'
# 输出：文件读延迟分布
# 看到 P99 > 10ms → 磁盘慢或 cache miss

# 5. 观测 CPU 调度延迟（CPU 饥饿）
bpftrace -e '
  tracepoint:sched:sched_wakeup { @start[args->pid] = nsecs; }
  tracepoint:sched:sched_switch /@start[args->prev_pid]/ {
    @runq_us = hist((nsecs - @start[args->prev_pid]) / 1000);
    delete(@start[args->prev_pid]);
  }
'
# 输出：进程被唤醒到实际运行的延迟
# 看到 P99 > 1ms → CPU 调度饥饿（CPU 不够用）
```

**Pixie（K8s 一键观测，无需部署 Agent）**：

```python
# Pixie 自动用 eBPF 采集，不用改应用代码
# 查询：所有 HTTP 请求（自动从内核 syscall 提取）
import px

# HTTP 请求延迟
df = px.DataFrame(table='http_events', start_time='-5m')
df.latency_ms = df.latency / 1e6
df.service = df.service
px.display(df.groupby('service').agg(
    p99_latency=('latency_ms', px.percentiles(99)),
    error_rate=('http_resp_status', lambda x: (x >= 500).mean()),
    qps=('http_resp_status', 'count')
))

# TCP 重传（内核观测）
df = px.DataFrame(table='tcp_retransmits', start_time='-5m')
px.display(df.groupby(['remote_addr', 'local_addr']).agg(
    retransmits=('count', 'sum')
))
```

**Parca（持续 profiling，无 Agent）：

```yaml
# Parca 用 eBPF 采集所有进程的 CPU 火焰图
# 不用改 Java 代码，不用 async-profiler
parca-agent:
  config:
    remote_store_address: parca:7070
    remote_store_interval: 10s
    profiling_cpu_enabled: true
    profiling_mem_enabled: false    # Java 内存用 JFR 更好
```

**Java GC 对 syscall 的影响（内核观测）**：

```bash
# 观测 GC 期间 syscall 是否堆积（STW 影响 IO）
bpftrace -e '
  uprobe:/usr/lib/jvm/libjvm.so:GenCollectNoGang {
    @gc_start = nsecs;
    printf("GC start at %d\n", nsecs);
  }
  tracepoint:raw_syscalls:sys_enter /@gc_start/ {
    @syscalls_during_gc[pid] = count();
  }
  uretprobe:/usr/lib/jvm/libjvm.so:GenCollectNoGang {
    printf("GC end, syscalls during GC: %d\n', @syscalls_during_gc[pid]);
    delete(@gc_start);
    clear(@syscalls_during_gc);
  }
'
```

## 三、实战层：Java 服务内核观测场景

**场景 1：P99 抖动根因定位**

```
现象：订单服务 P99 从 100ms → 500ms（应用层监控一切正常）

步骤：
1. 应用层（Micrometer）：QPS/错误率/CPU 都正常
2. OTel trace：调用链没慢 span
3. eBPF 观测（bpftrace）：
   - TCP 重传：发现到 MySQL 的连接重传 50 次/秒
   - TCP 连接建立：P99 200ms（正常 < 1ms）
4. 根因：MySQL 所在机器网络故障，重传导致请求堆积
5. 解决：切换 MySQL 副本，P99 恢复
```

**场景 2：CPU 调度饥饿**

```
现象：Java 服务 CPU 利用率 70%，但 P99 偶发尖峰

步骤：
1. top：CPU 70%（看起来不饱和）
2. eBPF 观测 CPU 调度延迟：
   - 平均调度延迟 50μs（正常）
   - P99 调度延迟 10ms（异常！）
3. 根因：K8s 节点超卖（limit 限制），高负载时 CPU 调度排队
4. 解决：迁移到独占节点或调大 CPU limit
```

**场景 3：文件 IO 瓶颈**

```
现象：日志写入偶尔卡 100ms+

步骤：
1. 应用层看不到 IO 延迟（只看到 fsync 慢）
2. eBPF 观测 vfs_write：
   - P99 vfs_write 延迟 50ms
   - 原因：page cache 满，触发直接写盘
3. 解决：日志异步 + 压盘策略调整
```

**场景 4：网络连接异常**

```
现象：偶发 Connection refused，但下游服务健康

步骤：
1. 应用层：HttpClient 报 ConnectException
2. eBPF 观测 TCP 状态：
   - TIME_WAIT 连接 60000（端口耗尽）
   - SYN_SENT 状态 P99 1s（半连接队列满）
3. 根因：短连接 + 高 QPS → 端口耗尽
4. 解决：改长连接 + 调内核参数 net.ipv4.ip_local_port_range
```

## 四、底层本质：为什么是 eBPF

回到第一性：**为什么不是更强大的 Agent，而是 eBPF？**

- **应用层监控的盲区**：Java Agent 在 JVM 内运行，看不到 TCP 重传（内核网络栈）、syscall 延迟（内核 IO）、CPU 调度（内核调度器）。这些是高阶故障源——网络抖动、IO 阻塞、CPU 饥饿。
- **eBPF 补齐内核盲区**：在内核态运行沙箱程序，钩子点（kprobe/uprobe/tracepoint）观测内核函数。应用零改动、Agent 不用部署、看所有进程。
- **零侵入的本质**：Agent 需要改应用配置（启动参数/依赖），eBPF 在内核层运行，应用完全无感。多语言（Java/Go/Python）统一观测。

**eBPF 安全的本质**：
- **验证器（verifier）**：加载时检查程序——不能死循环、不能越界访问内存、不能空指针。保证安全。
- **权限要求**：eBPF 程序要 root 权限（CAP_BPF 或 CAP_SYS_ADMIN）。普通用户不能加载——防止恶意程序。
- **沙箱执行**：eBPF 程序在专用栈执行，不能调用任意内核函数（只能调 helper 函数）。出问题不会 crash 内核。

**eBPF 高性能的本质**：
- **JIT 编译**：eBPF 字节码加载时 JIT 编译成原生指令，执行效率接近原生代码。
- **纳秒级钩子**：kprobe 钩子开销 50-100ns，对生产无感。
- **map + ring buffer**：数据通过 map（哈希表）或 ring buffer（无锁队列）传到用户态，避免频繁上下文切换。

**为什么 eBPF 看不了 JVM 内部**：
- eBPF 优势在内核观测（网络/IO/syscall/调度）。
- JVM 内部（GC、JIT、堆内存）用 JFR 更详细。eBPF 可以用 uprobe 钩 JVM 函数（如 `JVM_GC_Pause`），但不如 JFR 详细。
- 两者互补：eBPF 看内核，JFR 看 JVM。

## 五、AI 架构师加问：5 个

1. **AI 推理服务的 eBPF 观测重点？**
   GPU 不是 CPU，eBPF 观测有限。重点：① GPU 调用前的 syscall（cudaMemcpy 之前的数据准备）；② 网络层（模型权重加载的带宽）；③ CPU 调度（推理服务 CPU 饥饿影响 GPU 利用率）。GPU 内部要用厂商工具（nvidia-smi / DCGM）。

2. **AI 能自动分析 eBPF 数据找异常吗？**
   AI 学习历史 eBPF 指标的正常基线（TCP 重传率、syscall 频率、调度延迟），检测异常：① TCP 重传突升（网络抖动）；② 某进程 syscall 模式变化（异常行为）；③ 调度延迟 P99 抖动（CPU 饥饿）。AI 关联多信号归因："网络重传 + 某下游 IP → 下游服务网络问题"。

3. **大模型推理的 eBPF 能看到什么？**
   ① CPU 调度延迟（推理前的预处理是否 CPU 饱和）；② 网络层（请求 batch 的网络延迟）；③ 文件 IO（模型权重加载延迟，冷启动场景）；④ syscall 频率（cuda 调用模式）。看不到：GPU 内部执行（用 DCGM）、模型精度（用业务指标）。

4. **AI 怎么用 eBPF 做安全异常检测？**
   eBPF 可观测所有进程的 syscall，AI 学习正常 syscall 模式（Java 应用典型调用 epoll_read/sendto/mmap）。检测异常：① 突然出现 execve（可能被注入执行命令）；② 异常网络连接（连到未知 IP）；③ 文件读敏感路径（/etc/passwd）。AI 告警 + 自动隔离。

5. **AI Agent 链路如何用 eBPF 补全？**
   OTel Trace 看应用层（API 调用），eBPF 补内核层：① 每次 LLM 调用的 TCP RTT（网络抖动影响推理延迟）；② vector DB 查询的 syscall（mmap/read 模式）；③ tool_call 的外部调用网络。两者关联：traceId + PID + 时间戳对齐。

## 六、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"内核沙箱、钩子点、零侵入、补盲区"**。

- **内核沙箱**：eBPF 在内核态运行沙箱程序（验证器 + JIT 编译）
- **钩子点**：kprobe（内核函数）/uprobe（用户函数）/tracepoint/XDP（网络包）
- **零侵入**：不改应用代码、不部署 Agent、看所有进程
- **补盲区**：传统监控看应用层，eBPF 看内核层（TCP/IO/syscall/调度）
- **低开销**：< 1% CPU（JIT 编译 + 纳秒钩子）
- **代表项目**：bpftrace（命令行）/Pixie（K8s 观测）/Parca（持续 profiling）/Cilium（网络）
- **Java 场景**：TCP 重传、syscall 模式、CPU 调度延迟、GC 对 syscall 影响

### 拟人化理解

把 eBPF 想成**公路上的智能摄像头**。传统监控是"在每辆车上装 GPS"（应用层 Agent），eBPF 是"在公路上装摄像头"（内核层观测）。摄像头看所有经过的车（所有进程），不用改车（应用零改动）。摄像头有安全围栏（验证器防止恶意代码），有高速处理器（JIT 编译）。摄像头看到的是车在路上的行为（TCP/IO/syscall），看不到车内细节（JVM 内部用 JFR 补）。

### 面试现场 60 秒回答

> eBPF 是 Linux 内核的可编程沙箱，在内核态运行验证过的程序，无需改内核源码。在 Java 可观测性场景，补齐应用层监控（Agent/Micrometer）的内核盲区——观测 TCP 重传、syscall 延迟、CPU 调度、文件 IO。钩子点：kprobe（内核函数）/uprobe（用户函数）/tracepoint/XDP（网络）。零侵入（不改应用代码、不部署 Agent、看所有进程）、低开销（< 1% CPU，JIT 编译 + 纳秒钩子）。代表项目：bpftrace（命令行脚本）、Pixie（K8s 一键观测）、Parca（持续 profiling）、Cilium（网络+可观测）。Java 场景：P99 抖动时应用层看不到问题，用 eBPF 看 TCP 重传率/CPU 调度延迟/syscall 模式，定位网络抖动或 CPU 饥饿。eBPF 和 JFR 互补：eBPF 看内核，JFR 看 JVM 内部。

### 反问面试官

> 贵司内核版本是多少？（eBPF 需要 Linux 4.18+）有 Cilium/Istio 用 eBPF 替代 kube-proxy 吗？这决定我聊 eBPF 网络观测还是 syscall 观测。

## 七、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 已经有 Agent + Micrometer + OTel，为什么还要 eBPF？ | 应用层监控有内核盲区——TCP 重传、CPU 调度、syscall 延迟看不到。eBPF 补内核观测。典型场景：P99 抖动应用层查不到原因，eBPF 看到是网络重传 |
| 证据追问 | 怎么证明 eBPF 有用？ | 定位过"应用层无法解释"的故障：① 网络抖动（TCP 重传突升）；② CPU 饱和（调度延迟 P99 高）；③ IO 瓶颈（vfs_read 延迟高）。这些 Agent 看不到 |
| 边界追问 | eBPF 能替代 JFR 吗？ | 不能。eBPF 优势在内核观测（网络/IO/调度）。JVM 内部（GC/JIT/堆内存）用 JFR 更详细。eBPF 可用 uprobe 钩 JVM 函数，但不如 JFR。两者互补 |
| 反例追问 | 什么场景不要用 eBPF？ | ① 内核版本 < 4.18（不支持）；② Windows 环境（不支持）；③ 应用层问题（用 JFR/Agent 更合适）；④ 小团队（运维成本高，优先用成熟 Agent 方案） |
| 风险追问 | eBPF 最大风险？ | ① 权限要求（root，安全风险）；② 程序写错可能影响性能（虽不会 crash 内核）；③ 内核版本兼容（不同版本 API 差异）；④ 学习曲线陡（要懂内核）。治法：用成熟项目（Pixie/Cilium）而非手写 |
| 验证追问 | 怎么验证 eBPF 观测正确？ | ① 和应用层指标对齐（eBPF 看到的 HTTP QPS = Micrometer 的 QPS）；② 故障注入验证（tc 网络延迟，eBPF 能看到）；③ 和抓包（tcpdump）交叉验证 |
| 沉淀追问 | 团队规范沉淀什么？ | ① eBPF 接入 SOP（Cilium/Pixie 部署）；② 常用 bpftrace 脚本库（TCP/IO/调度）；③ 内核版本要求（4.18+）；④ eBPF + JFR + OTel 三层观测体系；⑤ 告警规则（TCP 重传率/调度延迟） |

### 现场对话示例

**面试官**：eBPF 和 Java Agent 区别？

**候选人**：观测层不同。Java Agent 在 JVM 内（应用层），看 HTTP/JDBC/Redis 等业务调用。eBPF 在内核态（内核层），看 TCP 重传、syscall、CPU 调度。互补关系——应用层问题用 Agent，内核层问题用 eBPF。典型场景：订单 P99 抖动，Agent 显示一切正常，eBPF 看到 TCP 重传突升，定位是网络问题。两者一起用才是完整观测。

**面试官**：eBPF 安全吗？写错会 crash 内核吗？

**候选人**：不会 crash。eBPF 有验证器（verifier）——加载时检查程序：① 不能死循环（必须有限执行）；② 不能越界访问内存；③ 不能空指针。验证通过才 JIT 编译执行。验证器保证安全。但 eBPF 程序要 root 权限加载（CAP_BPF），有安全风险——所以要限制谁能加载，用成熟项目（Pixie/Cilium）而非手写复杂 eBPF 程序。

**面试官**：eBPF 能看 JVM 内部吗？比如 GC？

**候选人**：能用 uprobe 钩 JVM 函数（如 libjvm.so 的 `JVM_GC_Pause`），但不如 JFR 详细。eBPF 优势在内核观测。JVM 内部（GC 类型、堆分区、对象分配）用 JFR 更准确。两者配合：eBPF 看 GC 对 syscall 的影响（STW 期间 syscall 堆积），JFR 看 GC 详情（GC 类型、暂停时间、回收量）。

## 常见考点

1. **eBPF 是什么？**——Linux 内核可编程沙箱，在内核态运行验证过的程序，无需改内核源码。
2. **钩子点有哪些？**——kprobe（内核函数）/uprobe（用户函数）/tracepoint（静态点）/XDP（网卡）/TC（网卡队列）。
3. **eBPF 和 Java Agent 区别？**——Agent 在应用层（JVM 内），eBPF 在内核层（TCP/IO/syscall/调度）。互补关系。
4. **eBPF 安全吗？**——验证器保证安全（无死循环、不越界、不空指针），要 root 权限加载。
5. **Java 场景用 eBPF 看什么？**——TCP 重传率、syscall 模式、CPU 调度延迟、文件 IO 延迟、GC 对 syscall 的影响。

## 结构化回答

**30 秒电梯演讲：** eBPF（Extended Berkeley Packet Filter）是 Linux 内核的可编程沙箱——在内核态运行沙箱程序，无需改内核源码或加载内核模块。在 Java 可观测性场景，eBPF 提供内核级观测：网络（TCP 连接/重传/延迟）、文件 IO、系统调用、CPU 调度，无需改 Java 代码、无需 Agent、几乎零开销。代表项目：Pixie（K8s 网络观测）、Parca（持续 profiling）、Cilium（网络+可观测性）

**展开框架：**
1. **eBPF = Linux** — eBPF = Linux 内核可编程沙箱（不改内核源码）
2. **钩子点** — kprobe/uprobe/tracepoint/XDP/TC
3. **无侵入观测 Java** — 网络/IO/syscall/CPU 调度

**收尾：** 以上是我的整体思路。您想继续深入聊——eBPF 和 Java Agent 区别？


## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：eBPF 与 Java 服务可观测性如何结合 | "这题核心是——eBPF（Extended Berkeley Packet Filter）是 Linux 内核的可编……" | 开场钩子 |
| 0:15 | eBPF = Linux示意/对比图 | "eBPF = Linux 内核可编程沙箱（不改内核源码）" | eBPF = Linux要点 |
| 0:40 | 钩子点示意/对比图 | "kprobe/uprobe/tracepoint/XDP/TC" | 钩子点要点 |
| 1:25 | 总结卡 | "记住：eBPF = Linux 内。下期见。" | 收尾 |
