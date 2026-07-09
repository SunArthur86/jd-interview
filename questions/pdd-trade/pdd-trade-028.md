---
id: pdd-trade-028
difficulty: L4
category: pdd-trade
subcategory: 负载均衡
tags:
- 拼多多
- 交易
- 负载均衡
- 隔离
- 压测
feynman:
  essence: 负载均衡（流量分发）+ 隔离（故障不传染）+ 压测（找容量上限）是稳定性的"防波堤"——均摊压力、划舱隔离、摸清家底。
  analogy: 像轮船设计——负载均衡是均摊载货（不偏沉）、隔离是水密舱（进水不漫）、压测是抗风浪测试（出厂前试航）。
  first_principle: 流量不均会导致单点过载，故障不隔离会级联，没有压测不知道容量上限。
  key_points:
  - LB：客户端（Ribbon）/服务端（Nginx）/DNS/Gateway
  - 隔离：线程池/信号量/集群/物理（核心与非核心分舱）
  - 压测：全链路压测+影子库表+容量预估
first_principle:
  problem: 如何让流量均匀、故障不传染、知道系统扛多少？
  axioms:
  - 单点过载会拖垮
  - 故障会级联
  - 容量必须可量化
  rebuild: 多层 LB + 多维隔离 + 全链路压测定容量。
follow_up:
  - 负载均衡算法怎么选？——轮询（均匀）/最少连接（长连接）/一致性 hash（会话保持）
  - 线程池隔离和信号量区别？——线程池（异步+队列）/信号量（同步计数，轻量）
  - 全链路压测怎么做？——影子库表+压测标透传+mock 外部
memory_points:
  - LB：DNS/网关/Nginx/Ribbon 多层
  - 隔离：线程池/信号量/集群/物理
  - 压测：全链路+影子库表+容量预估
  - 核心：均匀+不传染+知容量
---

# 【拼多多交易】负载均衡/隔离/压测怎么做？

> JD 依据："高并发/高可用"。

## 一、多层负载均衡

```
DNS（地域） → SLB（机房） → Nginx（集群） → Gateway（路由） → Ribbon（实例）
```

| 层 | 算法 | 用途 |
|----|------|------|
| DNS | 轮询/地理位置 | 多机房分流 |
| SLB | 最小连接 | L4 转发 |
| Nginx | 轮询/IP hash | L7 负载 |
| Ribbon | 轮询/一致性 hash | 微服务实例选择 |

**一致性 hash**（会话保持）：
```java
// 同 UID 路由到同实例（本地缓存有效）
int hash = consistentHash(uid.hashCode(), instances);
Server target = instances.get(hash);
```

## 二、隔离（多维度）

**线程池隔离**（核心与非核心）：
```java
@Bean("createOrderPool")
public ThreadPoolExecutor createOrderPool() { ... }  // 核心创单

@Bean("commentPool")
public ThreadPoolExecutor commentPool() { ... }  // 评论，独立池
```
评论挂了不会耗尽创单线程。

**信号量隔离**（轻量，无队列）：
```java
@HystrixCommand(
    commandProperties = @HystrixProperty(
        name = "execution.isolation.strategy", value = "SEMAPHORE"))
public Result query() { ... }
```

**集群隔离**：核心交易集群 vs 营销/推荐集群，物理机分开。

**大促租户隔离**：大商户（苹果/小米）独立集群，防互相影响。

## 三、全链路压测

```
1. 影子库表：压测流量写到 shadow_order 表，不影响真实
2. 压测标透传：header X-Pressure=true 全链路识别
3. mock 外部：支付通道/物流 API 用影子账户
4. 容量预估：压到 RT 拐点 → 推算单机 QPS × 实例数 = 总容量
```

**压测脚本**：
```java
// 模拟双 11 峰值
PressureScenario scenario = PressureScenario.builder()
    .qps(100_000)               // 目标 QPS
    .duration(Duration.ofMinutes(30))
    .rampUp(Duration.ofMinutes(5))  // 爬坡
    .shadowTable(true)          // 影子表
    .build();
pressureEngine.run(scenario);
```

**容量模型**：
```
单机 QPS = 压测拐点 QPS × 安全系数 0.7
总容量 = 单机 QPS × 实例数
扩容目标 = 峰值 QPS / 单机 QPS + 冗余 30%
```

## 四、拼多多双 11 实战

- **LB**：DNS 地域→机房→Nginx 集群→Gateway
- **隔离**：交易/支付/库存核心集群独立（千台级），评论/推荐降级
- **压测**：双 11 前全链路压测（百万 QPS），影子库表隔离，演练降级预案

## 五、底层本质

LB/隔离/压测本质是**"均摊风险+划舱防沉+摸清家底"**——LB 让流量均匀，隔离让故障不传染，压测让容量可量化，是稳定性的预防工程。

## 常见考点
1. **一致性 hash 怎么避免数据倾斜**？——虚拟节点（每实例 150 虚拟节点）。
2. **线程池隔离缺点**？——上下文切换开销+队列内存，适合重 IO 不适合高频轻量。
3. **压测怎么不打扰真实用户**？——影子库表+独立压测集群+夜间低峰压。
