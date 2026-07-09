---
id: pdd-content-021
difficulty: L4
category: pdd-content
subcategory: 内容架构
tags:
- 拼多多
- 内容
- 评价
- 架构
- 微服务
- 事件驱动
feynman:
  essence: 评价系统架构是"接入→服务（写入/审核/聚合）→数据（DB+Redis+ES）+ 异步事件扩散"的分层+事件驱动模型，关键在审核流+评分聚合+反作弊。
  analogy: 评价系统像新闻编辑部——记者写（用户 UGC）、编辑审（机审+人审）、汇编成刊（聚合评分）、读者订阅（Feed/搜索）。
  first_principle: 评价是 UGC 闭环，需写入+审核+聚合+扩散分层，且各环节解耦。
  key_points:
  - 接入层：网关限流+鉴权
  - 服务层：写入/审核/聚合分服务
  - 数据层：MySQL（主）+Redis（聚合）+ES（搜索）+OSS（图片）
  - 事件驱动：Kafka 扩散到下游
  - 反作弊：内容+行为双维
first_principle:
  problem: 评价是 UGC 闭环（写入/审核/聚合/扩散），如何分层解耦且扩展？
  axioms:
  - 写多读多
  - 审核需独立（不影响写入）
  - 多下游订阅（ES/统计/推荐）
  rebuild: 分层服务+事件驱动+多存储分工。
follow_up:
  - 评分怎么实时？——Redis 增量 + 定时校准
  - 审核挂了评价还能发吗？——不能上架（status=0），但 DB 写入正常
  - 评价量太大怎么办？——按 product_id 分库分表 + ES 索引分片
memory_points:
  - 三层：接入/服务/数据
  - 服务：写入/审核/聚合分
  - 数据：MySQL+Redis+ES+OSS
  - 事件：Kafka 扩散
  - 反作弊：内容+行为
---

# 【拼多多内容】评价系统整体架构怎么设计？

> JD 依据："评价和行家社区"、"稳定性建设"、"系统架构优化"。

## 一、整体架构

```
                  ┌────────────────────────────┐
                  │     API 网关 (Spring Cloud) │
                  │   鉴权 / 限流 / 路由          │
                  └─────────────┬──────────────┘
                                │
        ┌──────────┬────────────┼─────────────┬──────────────┐
        ▼          ▼            ▼             ▼              ▼
   评价写入     评价查询     评价审核       评分聚合       商家回复
   服务        服务        服务           服务           服务
        │          │            │             │              │
        └──────────┴────────────┴─────────────┴──────────────┘
                                │
                                ▼
                        ┌──────────────┐
                        │ Kafka 事件总线│
                        └──────┬───────┘
               ┌────────┬─────┴──────┬──────────┐
               ▼        ▼            ▼          ▼
            ES 同步  统计聚合     推荐召回    通知商家
            (搜索)   (Flink)      (算法)      (消息)
                                │
                                ▼
        ┌─────────────── 存储 ──────────────────┐
        │ MySQL（主，分库分表）│ Redis（聚合缓存）│
        │ ES（搜索索引）       │ OSS（图片/视频） │
        └─────────────────────────────────────────┘
```

## 二、服务拆分

| 服务 | 职责 | 关键能力 |
|------|------|----------|
| 评价写入 | 接收评价提交 | 校验/幂等/落库 |
| 评价查询 | 列表/详情/我的 | 多级缓存 |
| 评价审核 | 机审+人审 | 规则+模型+人工 |
| 评分聚合 | 商品评分实时计算 | Redis 增量 |
| 商家回复 | 商家互动 | 同样审核 |

## 三、写入链路

```java
@PostMapping("/reviews")
public Result submit(@RequestBody ReviewDTO dto) {
    // 1. 参数校验 + 防重（orderId+uid 幂等）
    if (reviewDao.existsByOrderUid(dto.getOrderId(), dto.getUid())) {
        throw new BizException("已评价");
    }
    // 2. 反作弊前置
    if (antiCheatService.isSuspicious(dto)) {
        return Result.fail("评价异常");
    }
    // 3. 落 DB（status=0 待审）
    Review r = reviewService.create(dto);
    // 4. 发事件（异步触发审核/统计/通知）
    eventBus.publish(new ReviewSubmittedEvent(r));
    return Result.ok(r.getId());
}
```

## 四、审核链路

```
ReviewSubmittedEvent
   ↓ Kafka
机审服务（敏感词+模型）
   ├─ 通过 → status=1 → 发 ReviewApprovedEvent
   └─ 疑难 → status=2 → 入人审队列
                  ↓
              人审台决策 → 通过/拒绝 → 发事件
```

## 五、评分聚合

```java
// 实时：Redis Hash 增量
redis.opsForHash().increment("product:rating:" + pid, "count", 1);
redis.opsForHash().increment("product:rating:" + pid, "total_score", score);

// 定时校准：凌晨全量重算（防漂移）
@Scheduled(cron = "0 0 3 * * ?")
public void reconcile() { ... }
```

## 六、查询链路（多级缓存）

```
请求 → Caffeine（本地）→ Redis（分布式）→ ES/MySQL
        L1（秒级）       L2（分钟级）       兜底
```

**搜索走 ES**（关键词/过滤/聚合），**详情走 Redis+MySQL**。

## 七、容量与扩展

```
- MySQL：按 product_id 分库分表（256 张表）
- Redis：Cluster（评分缓存/计数/锁）
- ES：按月建索引（review-2026.07）+ 别名
- Kafka：按 product_id 分区（保证同商品顺序）
- 服务：K8s HPA 弹性扩容
```

## 八、稳定性

```
- 网关限流：单 UID/全局 QPS 限制
- 服务熔断：Sentinel（依赖挂时不拖死）
- 降级：审核挂时先入库 status=0 异步审；ES 挂时查 MySQL
- 监控：写入 QPS/审核延迟/评分一致性/反作弊命中率
```

## 九、底层本质

评价架构本质是**"分层服务 + 事件驱动 + 多存储分工"**——服务按职责拆分，事件总线解耦下游，存储各司其职（MySQL 主、Redis 缓存、ES 搜索、OSS 文件）。

## 常见考点
1. **评分怎么保证一致**？——Redis 增量+定时校准+幂等消费。
2. **审核延迟怎么降**？——机审实时+模型推理优化+人审并发+优先级队列。
3. **评价搜索怎么做**？——ES 倒排+分词+BM25+filter 过滤+聚合。
