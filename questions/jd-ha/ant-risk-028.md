---
id: ant-risk-028
difficulty: L3
category: jd-ha
subcategory: 负载均衡
tags:
- 蚂蚁
- 风控
- 高可用
- 负载均衡
- 隔离
- 压测
feynman:
  essence: 负载均衡分散请求到多机、隔离限制故障爆炸半径、压测验证容量上限，三者让系统"均衡分布、故障可控、容量可知"。
  analogy: 负载均衡像交通调度（车流分散到多车道）、隔离像防火墙分区（一区着火不蔓延）、压测像建筑抗震测试（提前验证能扛多大震）。
  first_principle: 单机容量有限，多机并行需要均衡；多业务共享资源需要隔离防互相影响；容量上限不可知就无法应对突发。
  key_points:
  - 负载均衡：DNS/HTTP/TCP/服务端（注册中心+LoadBalancer）
  - 算法：轮询/随机/最少连接/一致性哈希/权重
  - 隔离：线程池/信号量/集群/容器/物理
  - 压测：单机/全链路/线上/影子库
first_principle:
  problem: 多机部署下如何让流量合理分布、不同业务互不影响、且知道系统能扛多少？
  axioms:
  - 单机容量有限
  - 不同业务优先级不同
  - 容量上限不验证就是未知风险
  rebuild: 负载均衡把流量分散（避免热点）+ 隔离把爆炸半径限制（防互相影响）+ 压测把容量上限验证（数据驱动扩容）。
follow_up:
- 一致性哈希解决什么问题？——节点增减时最小化数据迁移（缓存场景）
- 线程池隔离 vs 信号量隔离？——线程池强（独立资源）但开销大，信号量轻（共享线程）但隔离弱
- 全链路压测怎么做？——影子库 + 流量录制回放 + 全链路监控
memory_points:
- 负载均衡：DNS/网关/服务端/RPC 层
- 算法：轮询/随机/最少连接/一致性哈希
- 隔离 4 级：线程池/信号量/集群/物理
- 压测：单机/全链路/影子流量
---

# 【蚂蚁风控】高可用——负载均衡、隔离、压测，怎么做？

> JD 依据："保障海量数据系统的稳定性"。

## 一、负载均衡（Load Balancing）

### 多层负载均衡

```
DNS 负载均衡（机房级）
  ↓ 解析到 VIP
VIP（LVS/F5，TCP 层）
  ↓ 转发到
API Gateway（HTTP 层，Spring Cloud Gateway）
  ↓ 路由到
服务实例（Spring Cloud LoadBalancer）
  ↓ 调用
下游服务（Dubbo/Feign 客户端负载均衡）
```

### 负载均衡算法

| 算法 | 行为 | 适用 |
|------|------|------|
| **轮询**（Round Robin） | 依次分配 | 实例性能相近 |
| **随机**（Random） | 随机选 | 简单，大数下均衡 |
| **最少连接**（Least Connections） | 选当前连接最少的 | 长连接、处理时长不均 |
| **一致性哈希**（Consistent Hash） | 同 key 同实例 | 缓存（减少 miss） |
| **权重**（Weighted） | 按权重分配 | 实例性能不一 |
| **响应时间**（Shortest Response） | 选最快的 | 对延迟敏感 |
| **同机房优先** | 优先同 cluster | 跨机房场景 |

### 风控的同城优先路由

```java
public class ClusterAwareBalancer implements ReactorServiceInstanceLoadBalancer {
    public Mono<Response<ServiceInstance>> choose(Request request) {
        List<ServiceInstance> all = instances.get();
        // 1. 优先同机房
        List<ServiceInstance> local = all.stream()
            .filter(i -> "SH".equals(i.getMetadata().get("cluster")))
            .collect(toList());
        // 2. 同机房没有再用全部
        return chooseRandomFrom(local.isEmpty() ? all : local);
    }
}
```

**好处**：减少跨机房 RT（同城 1ms，跨城 30ms）。

## 二、隔离（Isolation）

### 隔离的层次

```
物理级（最强）
  └─ 不同业务用不同集群（成本最高）
集群级
  └─ 同集群不同 namespace/K8s namespace
容器级
  └─ 不同 Docker 容器，资源限额
进程级
  └─ 同机不同进程
线程级（最弱）
  └─ 线程池隔离
信号量级
  └─ 信号量计数隔离
```

### 线程池隔离 vs 信号量隔离

| 维度 | 线程池隔离 | 信号量隔离 |
|------|----------|----------|
| 隔离强度 | 强（独立线程池） | 弱（共享线程） |
| 开销 | 大（线程切换） | 小（计数） |
| 异步支持 | 支持 | 不支持 |
| 适用 | 重要下游 | 简单调用 |

### 风控的资源隔离

```java
// 不同下游用不同线程池
@Configuration
public class ThreadPoolConfig {
    @Bean("featurePool")
    public Executor featurePool() {
        return new ThreadPoolExecutor(64, 128, ...);
    }

    @Bean("rulePool")
    public Executor rulePool() {
        return new ThreadPoolExecutor(32, 64, ...);
    }

    @Bean("modelPool")
    public Executor modelPool() {
        return new ThreadPoolExecutor(32, 64, ...);
    }
}
// → 特征慢不会拖死规则和模型
```

### 业务隔离

```
风控集群按业务分：
  ├─ risk-loan-cluster（借贷，实例级隔离）
  ├─ risk-pay-cluster（支付，实例级隔离）
  └─ risk-marketing-cluster（营销，共享）

→ 借贷大促不影响支付
```

## 三、压测（Load Testing）

### 压测的类型

| 类型 | 目的 | 工具 |
|------|------|------|
| **基准压测** | 单机性能基线 | wrk、JMeter |
| **链路压测** | 端到端容量 | 全链路压测平台 |
| **稳定性压测** | 长时间持续负载 | Soak Test |
| **容量压测** | 找到系统极限 | 持续加压到崩 |
| **突发压测** | 模拟洪峰 | 瞬时高 QPS |

### 全链路压测（风控的核心）

**目标**：验证风控系统能扛双 11 的 100 万 QPS。

**方案**：
```
1. 流量录制
   录制线上真实请求（千万条）

2. 影子流量构造
   把录制的请求 × N 倍回放
   打影子标签（压测流量标识）

3. 影子隔离
   压测流量走影子库（不污染生产）
   影子 Kafka 队列
   影子 Redis 命名空间

4. 全链路监控
   监控所有服务的指标
   发现瓶颈
```

**风控影子库设计**：
```java
public class ShadowRouter {
    public DataSource route(TraceContext ctx) {
        if (ctx.isShadow()) {
            return shadowDataSource;  // 压测流量走影子
        }
        return productionDataSource;
    }
}
```

**压测流程**：
```
准备阶段：
  - 录制流量、构造影子数据、扩容集群

执行阶段：
  - 阶梯式加压（10万 → 50万 → 100万 QPS）
  - 监控指标、记录瓶颈

分析阶段：
  - 找出瓶颈服务（哪个先扛不住）
  - 找出瓶颈资源（CPU/IO/连接/带宽）
  - 找出降级阈值

验证阶段：
  - 调整扩容策略
  - 验证降级生效
  - 制定容量预案
```

## 四、三件套的协同

```
负载均衡（流量均匀分布，避免热点）
      +
隔离（爆炸半径限制，故障不传染）
      +
压测（容量上限可知，扩容有据）
      =
      系统可承受突发流量、故障可控
```

**完整的容量规划**：
```
日常 QPS: 5万
峰值 QPS: 100万（双 11）
容量冗余: 1.5 倍（防突发）

需要容量: 100万 × 1.5 = 150万 QPS
单机容量: 5000 QPS
所需实例: 300 台

通过压测验证 300 台能撑住 150万 QPS
```

## 五、风控的实战案例

**双 11 容量保障**：

**T-30 天**：
- 全链路压测（找出瓶颈）
- 扩容（按容量规划）
- 降级预案演练

**T-7 天**：
- 弹性扩容到 1.5 倍
- 缓存预热
- 监控大盘搭建

**T-1 天**：
- 降级非核心功能（推荐、运营位）
- 增加 oncall 人员

**当天**：
- 实时监控各项指标
- 一键扩容（K8s HPA）
- 一键降级（配置中心开关）

## 六、监控与告警

**负载均衡指标**：
```
instance_qps{instance="i-xxx"}    # 每实例 QPS（应均匀）
instance_rt_p99{instance="i-xxx"} # 每实例 P99
imbalance_ratio                   # 不均衡比例（>20% 告警）
```

**隔离指标**：
```
threadpool_active{name="feat"}        # 线程池活跃数
threadpool_rejected{name="feat"}      # 拒绝数（>0 告警）
circuit_breaker_state{service="feat"} # 熔断状态
```

**压测指标**：
```
压测 QPS、P99 RT、错误率、CPU、内存
对比线上同 QPS 时的表现
```

## 七、底层本质：分布式系统的"均衡-隔离-验证"三角

**负载均衡**：分布式系统效率最大化（避免热点）
- 类比：交通分流（避免拥堵）

**隔离**：分布式系统稳定性保障（爆炸半径限制）
- 类比：船的隔水舱（一舱破不沉船）

**压测**：分布式系统容量可知（数据驱动决策）
- 类比：建筑抗震测试（提前验证能扛多少）

**三者的关系**：
- 均衡让分布合理（前提）
- 隔离让故障可控（保障）
- 压测让容量可信（验证）

**这是分布式系统"运维知识体系"的核心**：
- 知道流量如何走（均衡）
- 知道故障如何限（隔离）
- 知道极限在哪里（压测）

## 八、AI 时代的演进

**LLM 服务的负载均衡新挑战**：
- GPU 资源稀缺，不能简单加机器
- 模型推理并行度低（单请求占满 GPU）
- 多模型混部

**对应方案**：
- 负载均衡：按 token 数路由（而非请求）
- 隔离：GPU 池化 + 多租户隔离
- 压测：token 吞吐量压测（而非 QPS）

## 常见考点
1. **一致性哈希解决什么**？——缓存场景，节点增减时只影响相邻段数据（而非全量 rehash）。
2. **线程池隔离和信号量何时选**？——重要下游用线程池（强隔离）、简单调用用信号量（省资源）。
3. **线上压测怎么不打扰用户**？——影子流量（特殊标记）+ 影子库（不污染生产）+ 影子 MQ（独立队列）。

**代码示例**（一致性哈希负载均衡）：
```java
public class ConsistentHashBalancer {
    private final TreeMap<Integer, ServiceInstance> ring = new TreeMap<>();
    private final int VIRTUAL_NODES = 150;

    public ConsistentHashBalancer(List<ServiceInstance> instances) {
        for (ServiceInstance inst : instances) {
            for (int i = 0; i < VIRTUAL_NODES; i++) {
                int hash = hash(inst.getHost() + ":" + i);
                ring.put(hash, inst);
            }
        }
    }

    public ServiceInstance route(String key) {
        int hash = hash(key);
        SortedMap<Integer, ServiceInstance> tail = ring.tailMap(hash);
        int target = tail.isEmpty() ? ring.firstKey() : tail.firstKey();
        return ring.get(target);
    }
}
```
