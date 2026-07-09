---
id: pdd-scm-026
difficulty: L3
category: pdd-scm
subcategory: 池化
tags:
- 拼多多
- 供应链
- 高并发
- 池化
- 缓存
- 异步
feynman:
  essence: 高并发五件套——池化（复用资源）、缓存（少算少 IO）、扩容（加机器）、异步（不阻塞）、队列（削峰），分别从复用/减少/扩展/不等待/缓冲五个角度提升吞吐。
  analogy: 餐厅应对客流五招：员工不辞退（池化）、预先备料（缓存）、加桌加人（扩容）、点单后取号（异步）、排号进入（队列）。
  first_principle: 吞吐量 = 并发数 / 平均处理时间；五件套分别优化分子（池化+扩容）和分母（缓存+异步），队列削峰。
  key_points:
  - 池化：线程池/连接池/对象池（必须有界）
  - 缓存：Caffeine → Redis → MySQL 多级
  - 扩容：垂直（升硬件）vs 水平（加机器，无状态）
  - 异步：CompletableFuture 并行 + MQ 异步
  - 队列：Kafka 削峰填谷
first_principle:
  problem: 单机处理能力有限，如何在不无限堆硬件下应对突发流量？
  axioms:
  - 资源创建有成本
  - 重复计算浪费
  - 同步等待浪费 CPU
  rebuild: 池化复用 + 缓存少算 + 水平扩容 + 异步少等 + 队列削峰。
follow_up:
- 缓存三问题？——穿透（布隆）、击穿（互斥锁）、雪崩（TTL 抖动）
- 池化必须上界？——是，无界 OOM
- 队列丢消息？——acks=all + 幂等消费
memory_points:
- 五件套：池化/缓存/扩容/异步/队列
- 池化必须有界，缓存多级，扩容无状态
- 异步：CompletableFuture 并行 + MQ 解耦
- 队列削峰：洪峰转稳定流
---

# 【拼多多供应链】高并发五件套怎么用？

> JD 依据："高并发系统的开发和调优"。

## 一、五件套详解

### 1. 池化
```java
ThreadPoolExecutor pool = new ThreadPoolExecutor(
    64, 128, 60, SECONDS,
    new LinkedBlockingQueue<>(2000),  // 有界！
    new ThreadFactoryBuilder().setNameFormat("scm-%d").build(),
    new CallerRunsPolicy());
```

### 2. 缓存（多级）
```java
Product p = caffeine.getIfPresent(id);          // L1 本地（50% 命中）
if (p == null) p = redis.get("p:" + id);         // L2 分布式（95% 命中）
if (p == null) { p = mysql.findById(id); redis.set(...); }
```

### 3. 扩容
```yaml
# K8s HPA
minReplicas: 50
maxReplicas: 500
metrics: [{ type: Resource, resource: { name: cpu, target: { averageUtilization: 60 }}}]
```
前提：服务无状态（状态外置 Redis/HBase）。

### 4. 异步
```java
// 并行查询
CompletableFuture<Stock> sf = supplyAsync(() -> stockService.get(sku), pool);
CompletableFuture<Price> pf = supplyAsync(() -> priceService.get(sku), pool);
CompletableFuture.allOf(sf, pf).get(50, MS);  // 并行，50ms 超时

// MQ 异步
kafka.send("order-created", event);  // 不阻塞主流程
```

### 5. 队列
```
大促订单洪峰 → Kafka（入队）→ 消费者稳定处理（削峰）
```

## 二、供应链组合应用

```
商品详情页查询：
  池化（连接池）+ 缓存（Caffeine+Redis 98%命中）+ 异步（并行查库存/价格/评价）
  → 单接口 RT 从 200ms → 30ms
```

## 三、底层本质

吞吐量 = 并发数 / 处理时间。五件套：
- 分子（并发）：池化 + 扩容
- 分母（时间）：缓存 + 异步
- 削峰（突发）：队列

## 常见考点
1. **缓存一致性**？——Cache Aside（先 DB 后删缓存）+ 延迟双删。
2. **池化为什么必须上界**？——无界导致 OOM（Executors 的坑）。
3. **异步化代价**？——失去强一致，需最终一致补偿。
