---
id: ant-risk-026
difficulty: L3
category: jd-ha
subcategory: 池化
tags:
- 蚂蚁
- 风控
- 高并发
- 池化
- 缓存
- 异步
- 队列
feynman:
  essence: 高并发五件套——池化（复用资源降创建成本）、缓存（少计算/少 IO）、扩容（加机器横向扩展）、异步（不阻塞主流程）、队列（削峰填谷）。
  analogy: 餐厅应对客流高峰五招：员工不辞退（池化）、菜单预先备料（缓存）、加桌加服务员（扩容）、点单后取号不等菜（异步）、排号进入慢慢服务（队列）。
  first_principle: 高并发场景下，请求处理速度（吞吐量）受限于资源（CPU/内存/连接/带宽）和同步等待，五件套分别从复用、减少计算、扩展、减少等待、缓冲五个角度提升吞吐。
  key_points:
  - 池化：线程池、连接池、对象池（降低创建销毁成本）
  - 缓存：CPU 缓存/进程缓存/分布式缓存/CDN（少重复计算）
  - 扩容：垂直（升硬件）vs 水平（加机器）
  - 异步：CompletableFuture/反应式/事件驱动
  - 队列：Kafka/RocketMQ 削峰填谷
first_principle:
  problem: 单机处理能力有限，如何在不无限堆硬件的前提下应对突发流量？
  axioms:
  - 资源创建有成本（线程、连接）
  - 重复计算浪费（同样数据多次算）
  - 同步等待是浪费 CPU
  - 突发流量超过处理能力
  rebuild: 池化复用资源，缓存少算少 IO，水平扩容加节点，异步减少等待，队列缓冲突发。五者组合把单机性能榨干 + 横向扩展。
follow_up:
- 缓存三大问题？——穿透（查不存在）、击穿（热 key 失效）、雪崩（大量失效）
- 池化一定要有界？——必须有界，无界会 OOM；线程池队列必须有界（阿里规约）
- 队列丢消息怎么办？——生产端持久化+ACK，消费端幂等+重试
memory_points:
- 池化（复用）+ 缓存（少算）+ 扩容（加机器）+ 异步（少等）+ 队列（削峰）= 高并发五件套
- 缓存三问题：穿透（空值缓存）/击穿（互斥锁）/雪崩（TTL 抖动）
- 池化必须上界，无界 = 定时炸弹
- 队列削峰本质：把同步洪峰转成稳定的处理速率
---

# 【蚂蚁风控】高并发五件套——池化、缓存、扩容、异步、队列，怎么用？

> JD 依据："攻克各种高并发技术难关"。这是高并发的核心方法论。

## 一、池化（Pooling）：复用资源

**为什么**：每次创建线程/连接都有成本（OS 调度、TCP 握手），高并发下创建销毁占大头。

**池化对象**：
- **线程池**（ThreadPoolExecutor）：复用线程
- **连接池**（HikariCP、Druid）：复用 DB/Redis 连接
- **对象池**（Commons-Pool、Netty ByteBuf）：复用昂贵对象
- **协程池**（Kotlin/Go goroutine 调度）

**风控实战**：
```java
// 风控决策的多个下游独立线程池
ThreadPoolExecutor featurePool = new ThreadPoolExecutor(
    64, 128, 60, SECONDS,
    new LinkedBlockingQueue<>(2000),    // 有界！
    new ThreadFactoryBuilder().setNameFormat("feat-%d").build(),
    new CallerRunsPolicy()
);

// 数据库连接池（HikariCP）
HikariConfig config = new HikariConfig();
config.setMaximumPoolSize(50);    // 必须 ≤ MySQL max_connections
config.setMinimumIdle(10);
config.setConnectionTimeout(3000);
```

**关键**：必须有界（线程数、队列、连接数），否则 OOM。

## 二、缓存（Caching）：减少重复计算/IO

**多级缓存**：
```
L1 CPU 缓存（硬件） → L2 进程缓存（Caffeine） → L3 分布式缓存（Redis）
   → L4 数据库（MySQL） → L5 持久存储（HBase/HDFS）
```

**风控的多级缓存**：
```java
public Feature getFeature(String uid) {
    // L1 进程缓存（Caffeine，10ms 内）
    Feature f = caffeineCache.getIfPresent(uid);
    if (f != null) return f;

    // L2 分布式缓存（Redis，10-30ms）
    f = redisCache.get(uid);
    if (f != null) {
        caffeineCache.put(uid, f);  // 回填 L1
        return f;
    }

    // L3 HBase（30-50ms）
    f = hBaseDao.get(uid);
    redisCache.put(uid, f);
    caffeineCache.put(uid, f);
    return f;
}
```

**缓存三大问题**：

| 问题 | 原因 | 解法 |
|------|------|------|
| **穿透**（Penetration） | 查不存在的 key，每次打到 DB | 空值缓存 + 布隆过滤器 |
| **击穿**（Breakdown） | 热 key 失效瞬间，大量请求打 DB | 互斥锁（只让一个查 DB） + 永不过期 |
| **雪崩**（Avalanche） | 大量 key 同时失效 | TTL 加随机抖动 + 多级缓存 |

**穿透的布隆过滤器**：
```java
BloomFilter<String> blackList = BloomFilter.create(Funnels.stringFunnel(), 1_000_000);
if (!blackList.mightContain(uid)) return null;  // 一定不存在，直接返回
```

## 三、扩容（Scaling）：增加处理能力

**垂直扩容（Scale Up）**：
- 升级单机配置（CPU、内存、磁盘）
- 简单但有上限

**水平扩容（Scale Out）**：
- 加机器，无状态服务可任意扩
- 状态服务需要分片（数据按 hash/range 分散）

**风控的弹性扩容**：
```yaml
# K8s HPA（自动扩缩容）
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: risk-decision-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: risk-decision
  minReplicas: 50
  maxReplicas: 500                    # 弹性范围
  metrics:
  - type: Resource
    resource:
      name: cpu
      target: { type: Utilization, averageUtilization: 60 }
```

**关键**：服务必须无状态（状态外置到 Redis/HBase）才能任意扩缩。

## 四、异步（Async）：减少同步等待

**异步场景**：
- 主流程不依赖结果的（如发通知、记日志）
- 多个独立任务可并行的（用 CompletableFuture）

**风控的异步化**：
```java
// 同步链路只做决策必须的
RiskResult decide(Event e) {
    // 并行查特征（异步）
    CompletableFuture<Profile> pF = CompletableFuture.supplyAsync(
        () -> profileService.get(e.uid), pool);
    CompletableFuture<Features> fF = CompletableFuture.supplyAsync(
        () -> featService.get(e.uid), pool);

    // 等所有结果（带超时）
    CompletableFuture.allOf(pF, fF).get(80, MS);

    // 决策
    return fuse(pF.join(), fF.join());
}

// 异步通知、日志、回流走 MQ
kafkaTemplate.send("risk-events", event);  // 异步
```

**反应式编程**（WebFlux）：
```java
public Mono<RiskResult> decide(Event e) {
    return Mono.fromCallable(() -> query(e))
        .subscribeOn(boundedElastic())
        .timeout(Duration.ofMillis(100));
}
```
非阻塞 IO，少量线程支撑高并发。

## 五、队列（Queue）：削峰填谷

**为什么需要队列**：
- 生产速率 ≠ 消费速率（洪峰时生产快）
- 同步调用会让生产者被消费者拖死
- 队列做"水库"，把洪峰转成稳定流

**风控的队列应用**：
```
实时事件 → Kafka（高吞吐入队）→ Flink（消费算特征）→ HBase
                                      ↓ 慢
                                  队列缓冲，不拖死生产者
```

**消息可靠性**：
- 生产端：acks=all + 持久化 + 重试
- Broker：多副本（replication.factor=3）
- 消费端：手动提交 offset + 幂等处理

**削峰效果**：
```
请求峰值 10万 QPS（持续 1 分钟）
→ 入队 Kafka
→ 消费者稳定处理 2 万 QPS（持续 5 分钟）
→ 消费者不被冲垮
```

## 六、五件套的组合应用

**风控决策服务的完整方案**：

```
1. 池化：
   - 线程池（特征查询、规则匹配各自池化）
   - 连接池（HikariCP 50、Lettuce 100）
   - Tomcat 工作线程池 200

2. 缓存：
   - Caffeine（本地，命中率 50%）
   - Redis（分布式，命中率 95%）
   - HBase（兜底）

3. 扩容：
   - K8s HPA（50-500 副本）
   - 业务前主动扩容（双 11 前 1 倍）

4. 异步：
   - 决策内的并行查询（CompletableFuture）
   - 决策后的回流（Kafka）

5. 队列：
   - 实时事件流 Kafka
   - 异步任务队列（人工审核）
```

**容量提升效果**：
- 单实例：5000 QPS
- 加缓存：10000 QPS（缓存命中少算）
- 加并行：15000 QPS（充分利用多核）
- 加扩容到 100 节点：150 万 QPS
- 加队列缓冲：能扛 2 倍突发

## 七、底层本质：吞吐量的"资源-时间-缓冲"分析

吞吐量（QPS）的本质：
```
QPS = 1 / 平均处理时间 × 并发数
```

五件套分别优化：

| 手段 | 优化的项 | 原理 |
|------|---------|------|
| 池化 | 并发数（线程/连接） | 复用，避免创建开销 |
| 缓存 | 平均处理时间 | 命中缓存少算少 IO |
| 扩容 | 并发数（节点数） | 横向加机器 |
| 异步 | 平均处理时间（等） | 不阻塞，重叠等待 |
| 队列 | 突发流量 | 缓冲，转稳定 |

**这是把"吞吐量公式"每个变量都优化的工程实践**：
- 分子（并发数）：池化 + 扩容
- 分母（处理时间）：缓存 + 异步
- 削峰（突发）：队列

## 八、和 AI 的关系

**AI 时代的高并发新挑战**：
- LLM 推理慢（百毫秒到秒级）
- GPU 资源稀缺
- 推理并行度低

**对应解法**：
- 池化：GPU 推理池（多模型复用 GPU）
- 缓存：LLM 结果缓存（同 prompt 复用）
- 扩容：vLLM/PagedAttention 提升单 GPU 吞吐
- 异步：流式输出（不等完整响应）
- 队列：推理任务排队（避免过载）

## 常见考点
1. **池化为什么必须上界**？——无界池会导致 OOM、线程爆炸、连接耗尽；典型反例是 `Executors.newCachedThreadPool`（线程数 Integer.MAX_VALUE）。
2. **缓存一致性怎么保证**？——Cache Aside（先更新 DB 再删缓存）+ 延迟双删 + Canal 订阅 binlog 异步刷新。
3. **异步化和强一致矛盾吗**？——同步路径保证强一致（如风控决策），异步路径只做最终一致（如统计回流）。

**代码示例**（缓存三问题防护）：
```java
public Feature getFeatureSafe(String uid) {
    // 1. 布隆过滤防穿透
    if (!bloomFilter.mightContain(uid)) return Feature.empty();

    // 2. 互斥锁防击穿（热点 key 失效时只让一个查 DB）
    Feature f = redisCache.get(uid);
    if (f == null) {
        synchronized (this) {
            f = redisCache.get(uid);  // 双重检查
            if (f == null) {
                f = hBaseDao.get(uid);
                redisCache.put(uid, f, TTL + random(60));  // TTL 抖动防雪崩
            }
        }
    }
    return f;
}
```
