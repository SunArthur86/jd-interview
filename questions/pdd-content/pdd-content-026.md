---
id: pdd-content-026
difficulty: L3
category: pdd-content
subcategory: 池化
tags:
- 拼多多
- 内容
- 池化
- 缓存
- 扩容
- 异步
- 队列
- 评价
- 直播
feynman:
  essence: 高并发四件套（池化+多级缓存+弹性扩容+异步队列削峰）是内容社区扛流量的标配；评价写入用池+缓存挡读、直播弹幕用队列削峰。
  analogy: 像餐厅运营——池化是预备桌椅、缓存是常备菜、扩容是高峰加桌、队列是排队叫号。
  first_principle: 单机 QPS 有上限，用池化复用、缓存挡读、扩容加机、队列削峰。
  key_points:
  - 池化：连接池/线程池（评价/直播分池）
  - 缓存：Caffeine+Redis 多级（评价列表/直播统计）
  - 扩容：K8s HPA 无状态+分片有状态
  - 队列：Kafka 削峰（弹幕/评价事件）
first_principle:
  problem: 内容社区突发大流量（直播开播/活动），如何扛住？
  axioms:
  - 单机 QPS 有上限
  - 读多写少
  - 流量有峰谷
  rebuild: 池化+多级缓存+弹性扩容+队列削峰。
follow_up:
  - 缓存击穿/穿透/雪崩？——击穿互斥锁/穿透布隆/雪崩随机 TTL
  - 线程池怎么配？——CPU 密集 N+1，IO 密集 2N
  - Kafka 削峰怎么不丢？——acks=all+消费限流+死信
memory_points:
  - 池化：HikariCP/线程池
  - 缓存：Caffeine+Redis
  - 扩容：HPA+分片
  - 队列：Kafka 削峰
---

# 【拼多多内容】高并发四件套（池化/缓存/扩容/异步队列）？

> JD 依据："高并发大流量"、"系统高可用/扩展性"、"稳定性建设"。

## 一、池化

**连接池（HikariCP）**：
```yaml
spring:
  datasource:
    hikari:
      maximum-pool-size: 20
      minimum-idle: 10
      connection-timeout: 3000
```

**线程池（业务隔离）**：
```java
// 评价写入池
@Bean("reviewWriteExecutor")
public ThreadPoolExecutor reviewWrite() {
    return new ThreadPoolExecutor(50, 200, 60, SECONDS,
        new LinkedBlockingQueue<>(5000),
        new ThreadFactoryBuilder().setNameFormat("review-write-%d").build(),
        new ThreadPoolExecutor.CallerRunsPolicy());
}

// 直播弹幕池（短队列，丢弃快的）
@Bean("danmakuExecutor")
public ThreadPoolExecutor danmaku() {
    return new ThreadPoolExecutor(200, 500, 30, SECONDS,
        new ArrayBlockingQueue<>(500),   // 短队列
        new ThreadPoolExecutor.DiscardOldestPolicy());  // 丢老的
}
```

## 二、多级缓存

```
请求 → Caffeine（本地）→ Redis Cluster（分布式）→ DB
        L1（秒级）       L2（分钟级）            兜底
```

```java
@Cacheable(value = "review:product", key = "#productId",
           cacheManager = "multiLevel")
public List<Review> listReviews(Long productId) {
    return reviewDao.findByProductId(productId);
}
```

**三防**：
- 击穿（热 key 失效）：互斥锁重建
- 穿透（不存在的 key）：布隆过滤器 + 空值缓存
- 雪崩（批量失效）：TTL 加随机 `ttl + random(60s)`

**直播统计缓存**：
```
直播间在线/观看/礼物数：
  key = live:stat:{liveId}（Hash）
  实时增量更新（incr）+ 定时校准
```

## 三、弹性扩容

**无状态服务（K8s HPA）**：
```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: review-service
spec:
  minReplicas: 10
  maxReplicas: 200
  metrics:
    - type: Resource
      resource: { name: cpu, target: { type: Utilization, averageUtilization: 60 } }
```

**有状态分片**（Redis/MySQL）：分片+预热，扩容走 2 倍法。

**直播开播流量洪峰**：
- 提前预热（热门主播开播前 10 分钟扩容）
- CDN 带宽按需扩
- 信令网关按在线数扩

## 四、异步队列削峰

```
评价事件：评价服务 → Kafka（削峰）→ 消费者按容量消费
直播弹幕：观众 → 网关 → Kafka → 消费者限速广播
```

**延时队列**（评价延时发布）：
```java
rocketMQTemplate.asyncSend(
    MessageBuilder.withPayload(new ReviewPublishMsg(reviewId))
        .setHeader(MessageConst.PROPERTY_DELAY_TIME_LEVEL, 14)  // 30min
        .build(), callback);
```

## 五、内容场景实战

**1. 评价页读取（多级缓存）**：
```
请求 → Caffeine（1s）→ Redis（5min）→ MySQL/ES
  命中率：本地 30% + Redis 65% + DB 5%
  DB QPS 从 10w 降到 5k
```

**2. 直播弹幕削峰**：
```
百万 QPS 弹幕 → Kafka（按 liveId 分 32 区）→ 消费者限速广播
  服务端：每房 500/s 下发
  网关：单连接 5/s 限流
  客户端：节流渲染
```

**3. Feed 写扩散**：
```
发布 Feed → Kafka feed.published → 消费者按容量扩散到粉丝收件箱
  大 V：不扩散（拉模式）
  普通：异步推（活跃粉丝优先）
```

## 六、预热与压测

**预热**：
- 活动/热门直播前预热缓存（脚本批量灌）
- 灰度放量（10% → 50% → 100%）

**全链路压测**：
- 影子库表+压测标识透传
- 模拟峰值（直播开播瞬时）
- 验证扩容+限流+降级预案

## 七、底层本质

四件套本质是**"用空间/资源换时间和稳定"**——池化换创建开销、缓存换 DB 压力、扩容换吞吐、队列换峰值冲击；内容场景的精髓是把读多写少的特性用缓存吃满，把突发流量（直播/活动）用队列削平。

## 常见考点
1. **缓存一致性怎么保证**？——Cache Aside（写库删缓存）+ 延时双删。
2. **线程池满了怎么办**？——CallerRuns 反压+上游限流。
3. **Kafka 积压怎么处理**？——加消费者+扩分区+跳过历史。
