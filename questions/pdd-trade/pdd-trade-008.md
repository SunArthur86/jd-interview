---
id: pdd-trade-008
difficulty: L3
category: pdd-trade
subcategory: Kafka
tags:
- 拼多多
- 交易
- 消息队列
- 数据同步
- Kafka
feynman:
  essence: 消息队列在交易系统三作用——解耦（订单事件通知多下游）、削峰（秒杀异步）、数据同步（Canal→Kafka→ES/Redis）；选 Kafka（吞吐高）或 RocketMQ（事务消息）。
  analogy: 消息队列像公司内部邮件组——发件人（生产者）发一次，多个收件人（消费者）各取所需，发件人不用等回复（异步）。
  first_principle: 同步调用让服务强耦合且互相等待，MQ 解耦+异步+削峰。
  key_points:
  - 解耦：订单事件 → 库存/物流/积分/风控 各订阅
  - 削峰：洪峰入队，稳定消费
  - 数据同步：Canal→Kafka→ES/Redis
  - Kafka（吞吐）/RocketMQ（事务消息原生）
first_principle:
  problem: 同步调用让服务强耦合、互相等待，如何解耦+异步+削峰？
  axioms:
  - 服务间有依赖
  - 不需要同步等结果
  - 流量有突发
  rebuild: MQ 解耦（发布订阅）+ 异步（不等结果）+ 削峰（入队缓冲）。
follow_up:
- Kafka 和 RocketMQ 怎么选？——Kafka 吞吐高生态广；RocketMQ 事务消息原生支持（电商常用）
- 消息顺序怎么保证？——同 key 进同 partition，单 partition 有序
- 消息积压怎么办？——扩消费者 + 排查慢消费 + 临时跳过
memory_points:
- MQ 三作用：解耦/削峰/数据同步
- Kafka 吞吐高、RocketMQ 事务消息原生
- 顺序：同 key 同 partition
- 可靠性：acks=all + 副本 + 手动 offset + 幂等消费
---

# 【拼多多交易】消息队列怎么用？数据同步怎么做？

> JD 依据："消息中间件、数据同步平台"。

## 一、MQ 三大作用

```
1. 解耦: 订单事件 → 库存/物流/积分/风控（各订阅）
2. 削峰: 秒杀洪峰 → Kafka → 稳定消费
3. 数据同步: MySQL binlog → Canal → Kafka → ES/Redis/数仓
```

## 二、Kafka vs RocketMQ

| 维度 | Kafka | RocketMQ |
|------|-------|----------|
| 吞吐 | 极高（百万/秒） | 高（十万/秒） |
| 事务消息 | 弱 | 原生支持 |
| 顺序 | partition 内 | 队列内 |
| 适用 | 大数据/日志 | 电商事务 |

拼多多交易选 RocketMQ（事务消息）+ Kafka（数据同步）。

## 三、数据同步（Canal + Kafka）

```
MySQL → Canal（伪装从库）→ Kafka → 消费者
   ├→ ES（搜索索引）
   ├→ Redis（删缓存）
   └→ 数仓（离线分析）
```

业务代码无感知，binlog 驱动最终一致。

## 四、消息可靠性

```properties
# 生产
acks=all
enable.idempotence=true

# Broker
replication.factor=3
min.insync.replicas=2

# 消费
enable.auto.commit=false  # 手动提交
```

消费端幂等（业务唯一键）。

## 五、订单事件流（交易核心）

```
下单 → topic: order-created
   ├→ 库存服务：冻结库存
   ├→ 营销服务：核销券
   ├→ 风控服务：异步复核
   └→ 数仓：实时 GMV

支付 → topic: order-paid
   ├→ 库存：确认扣减
   ├→ 商家：通知发货
   └→ 积分：加分
```

## 六、底层本质

MQ 本质是**"生产者消费者的解耦中间件"**——把同步强依赖转异步弱依赖，让系统更松耦合、更弹性。

## 常见考点
1. **Kafka 为什么快**？——顺序写磁盘 + 零拷贝（sendfile）+ 批量压缩 + 分区并行。
2. **怎么保证消息顺序**？——同 key 进同 partition，单 partition 单消费者有序。
3. **消息积压**？——扩消费者 + 排查慢消费 + 临时跳过堆积。
