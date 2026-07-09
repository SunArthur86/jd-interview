---
id: pdd-trade-026
difficulty: L3
category: pdd-trade
subcategory: 池化
tags:
- 拼多多
- 交易
- 池化
- 缓存
- 扩容
- 异步
- 队列
feynman:
  essence: 池化（连接/线程）+ 缓存（多级）+ 扩容（弹性）+ 异步队列（削峰）是扛高并发四件套——用空间换时间、用队列换稳定。
  analogy: 像餐厅运营——池化是预备桌椅（不临时买）、缓存是常备菜（不用每次去菜场）、扩容是高峰加桌（弹性）、异步队列是排队叫号（削峰）。
  first_principle: 单机 QPS 有上限，用池化复用资源、缓存挡读、扩容加机器、队列削峰填谷。
  key_points:
  - 池化：连接池（HikariCP）/线程池/对象池
  - 缓存：本地（Caffeine）+ 分布式（Redis Cluster）+ 多级
  - 扩容：无状态服务弹性（K8s HPA）+ 有状态分片
  - 异步队列：Kafka 削峰、延时 MQ 关单
first_principle:
  problem: 单机 QPS 有上限，如何让系统支撑突发大流量？
  axioms:
  - 资源创建昂贵（连接/线程）
  - 读多写少可缓存
  - 流量有峰谷
  rebuild: 池化复用 + 多级缓存 + 弹性扩容 + 队列削峰。
follow_up:
  - 缓存击穿/穿透/雪崩怎么防？——击穿（互斥锁/永不过期）/穿透（布隆过滤器）/雪崩（随机过期）
  - 线程池怎么配？——CPU 密集 N+1，IO 密集 2N，结合压测
  - Kafka 削峰怎么保证不丢？——acks=all + 消费限流 + 死信队列
memory_points:
  - 池化：连接池/线程池/对象池
  - 缓存：Caffeine + Redis 多级
  - 扩容：无状态 HPA + 有状态分片
  - 队列：Kafka 削峰 + 延时关单
---

# 【拼多多交易】高并发四件套：池化/缓存/扩容/异步队列？

> JD 依据："高并发/高可用"。

## 一、池化

**连接池（HikariCP）**：
```yaml
spring:
  datasource:
    hikari:
      maximum-pool-size: 20          # 经验值：CPU 核心数 * 2 + 有效磁盘数
      minimum-idle: 10
      connection-timeout: 3000
      idle-timeout: 600000
```

**线程池**（创单隔离）：
```java
@Bean("createOrderExecutor")
public ThreadPoolExecutor createOrderExecutor() {
    return new ThreadPoolExecutor(
        50, 100, 60, TimeUnit.SECONDS,
        new LinkedBlockingQueue<>(1000),
        new ThreadFactoryBuilder().setNameFormat("create-order-%d").build(),
        new ThreadPoolExecutor.CallerRunsPolicy()  // 拒绝策略：让调用方降速
    );
}
```

## 二、多级缓存

```
请求 → Caffeine（本地，ms）→ Redis Cluster（分布式）→ DB
        L1（秒级失效）       L2（分钟级）            兜底
```

```java
@Cacheable(value = "product", key = "#id", cacheManager = "multiLevel")
public Product getProduct(Long id) {
    return productDao.findById(id);
}
```

**三防**：
- 击穿（热 key 失效）：互斥锁重建
- 穿透（不存在的 key）：布隆过滤器 + 缓存空值
- 雪崩（批量失效）：过期时间加随机 `ttl + random(60s)`

## 三、弹性扩容

**无状态服务（K8s HPA）**：
```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: order-service
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: order-service
  minReplicas: 10
  maxReplicas: 200
  metrics:
    - type: Resource
      resource: { name: cpu, target: { type: Utilization, averageUtilization: 60 } }
```

**有状态分片**（Redis/MySQL）：分片+预热，扩容走 2 倍法。

## 四、异步队列削峰

```
下单请求 → Kafka（削峰，积压可控）→ 创单消费者（按容量消费）
```

**延时队列（关单）**：
```java
// RocketMQ 延时消息
rocketMQTemplate.asyncSend(
    MessageBuilder.withPayload(new OrderCloseMsg(orderId))
        .setHeader(MessageConst.PROPERTY_DELAY_TIME_LEVEL, 14)  // 30min
        .build(),
    callback
);
```

## 五、拼多多双 11 实战

- **预热**：商品/库存/价格预热到 Redis
- **限流**：网关 Sentinel 单 UID 限流
- **削峰**：创单走 Kafka，消费按容量限速
- **扩容**：HPA + 提前手动扩容（核心服务 5 倍）

## 六、底层本质

四件套本质是**"用空间/资源换时间和稳定"**——池化换创建开销、缓存换 DB 压力、扩容换吞吐、队列换峰值冲击。

## 常见考点
1. **缓存一致性怎么保证**？——Cache Aside（先写库再删缓存）+ 延时双删。
2. **线程池满了怎么办**？——拒绝策略（CallerRuns 反压/Abort 抛异常）+ 上游限流。
3. **Kafka 积压怎么处理**？——临时加消费者+扩分区+跳过历史（先恢复实时）。
