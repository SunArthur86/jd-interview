---
id: java-architect-033
difficulty: L3
category: java-architect
subcategory: Kafka
tags:
- Java 架构师
- RocketMQ
- 事务消息
- 延迟消息
feynman:
  essence: RocketMQ 事务消息用"半消息（half message）+ 本地事务回查"解决"本地数据库提交与消息发送"的原子性，是分布式事务最终一致的工业解；延迟消息用固定延迟级别（1s/5s/10s/.../2h）+ 改写 topic 为 SCHEDULE_TOPIC_XXXX 实现定时投递，订单超时关单、延迟支付场景必备。
  analogy: 像 JD 快递寄贵重物品：事务消息是"先开保价单（半消息），确认货真价实（本地事务回查 OK）再正式发车（commit 半消息）"；延迟消息是"快递员把包裹先放进定时柜（SCHEDULE_TOPIC），到点自动弹出派送"。
  first_principle: 为什么本地 DB 提交和 MQ 发送不能简单串联？因为两者无原生事务。先 DB 后 MQ：DB 成功后进程崩溃 → 消息没发出去。先 MQ 后 DB：MQ 发了但 DB 失败 → 消息发了但本地没数据。事务消息的本质是"两阶段提交"——先发半消息（broker 不投递）→ 执行本地事务 → 根据结果 commit/rollback 半消息，再加回查机制兜底进程崩溃场景。
  key_points:
  - 事务消息四步：发送半消息 → 执行本地事务 → commit/rollback 半消息 → Broker 主动回查（兜底）
  - 半消息存内部 topic RMQ_SYS_TRANS_HALF_TOPIC，消费者不可见
  - 延迟消息 18 个级别（1s/5s/10s/30s/1m/2m/3m/4m/5m/6m/7m/8m/9m/10m/20m/30m/1h/2h），5.x 支持任意时间
  - 延迟消息实现：改写 topic 为 SCHEDULE_TOPIC_XXXX，后台定时任务到期改回原 topic
  - 事务消息回查接口必须幂等且超时短（默认 60s），避免回查风暴
first_principle:
  problem: 如何在不引入 XA 分布式事务（性能差、阻塞）的前提下，保证"本地数据库更新"和"消息可靠发送"两者原子？
  axioms:
  - 本地数据库事务和 MQ 发送是两个独立系统，无原生原子保证
  - 两阶段提交（2PC）性能差且阻塞，不适合高并发
  - 最终一致 + 补偿比强一致更现实，前提是有可靠的状态回查机制
  rebuild: RocketMQ 事务消息用"半消息"把 MQ 发送分成两阶段。第一阶段发半消息到 broker，broker 存储但不投递（消费者不可见）。第二阶段执行本地 DB 事务，根据结果通知 broker commit（投递）或 rollback（丢弃）。若 producer 崩溃未通知，broker 定时回查 producer 的本地事务状态（业务实现 checkLocalTransaction），以此兜底进程崩溃。这套机制比 XA 轻量，比"本地消息表 + 定时扫表"省一次 DB 查询。
follow_up:
  - 事务消息和本地消息表怎么选？——事务消息省一张消息表和扫表开销，但强依赖 RocketMQ；本地消息表方案 MQ 无关（Kafka/Rabbit 都行），但要维护扫表任务和去重。自建 MQ 选本地消息表，RocketMQ 选事务消息
  - 事务回查接口怎么实现？——业务维护事务状态表（事务 ID + 状态），checkLocalTransaction 查表返回 COMMIT/ROLLBACK/UNKNOWN。UNKNOWN 时 broker 会继续重试，达到最大次数（默认 15 次）后默认 ROLLBACK
  - 延迟消息为什么只有 18 个级别？——早期 RocketMQ 用固定延迟级别优化（同级别消息进同一 queue，按到期时间排序），降低实现复杂度。5.x 开始支持任意延迟时间（基于时间轮）
  - 延迟消息能精确到秒吗？——4.x 最小 1s，5.x 支持任意时间精确到毫秒。但实际投递有秒级误差（broker 扫描周期），不能用于对精度敏感的场景
  - 事务消息能保证消费端 exactly-once 吗？——不能。事务消息只保证"发送与本地事务原子"，消费端还是 at-least-once，必须业务幂等
memory_points:
  - 事务消息四步：半消息 → 本地事务 → commit/rollback → 回查兜底
  - 半消息存 RMQ_SYS_TRANS_HALF_TOPIC，消费者不可见，commit 后改写真实 topic
  - 回查接口实现 checkLocalTransaction，必须幂等 + 快速（默认 60s 超时）
  - 延迟消息：setDelayTimeLevel(1-18) 或 5.x 的 setDeliverTime(timestamp)
  - 延迟实现：改写 topic 为 SCHEDULE_TOPIC_XXXX，后台 ScheduleMessageService 扫描到期改回原 topic
---

# 【Java 后端架构师】RocketMQ 事务消息与延迟消息设计

> 适用场景：JD 核心技术。下单扣库存（本地 DB 扣库存 + MQ 通知营销/履约）、订单超时 30 分钟自动关单、延迟 24 小时发券、支付回调幂等——这些场景架构师必须能现场画出事务消息半消息流程和延迟消息时间轮机制。

## 一、概念层：为什么需要事务消息和延迟消息

**两个独立的工程问题**：

| 问题 | 场景 | 不解的后果 |
|------|------|-----------|
| **本地事务 + MQ 原子** | 下单：扣库存（DB）+ 发消息（MQ 通知营销） | DB 成功 MQ 失败 → 营销不知道；MQ 成功 DB 失败 → 超卖 |
| **定时投递** | 下单 30 分钟未支付自动关单、延迟 24 小时发券 | 用定时任务扫表，海量订单扫不动；用延迟队列自建复杂 |

**传统方案的痛点**：

```
方案 A：先 DB 后 MQ
  DB.commit() ──进程崩溃──✗──> MQ.send()   消息丢失

方案 B：先 MQ 后 DB
  MQ.send() ──> DB.commit() 失败 ──> 回滚   消息已发但本地没数据

方案 C：本地消息表 + 定时扫表
  DB { 业务表 + 消息表 } 同事务 ──> 定时扫消息表发 MQ
  缺点：每次业务多写一张表、扫表任务维护、消息表膨胀

方案 D：RocketMQ 事务消息（最优解）
  半消息 → 本地事务 → commit/rollback → 回查兜底
```

## 二、机制层：事务消息完整流程

**事务消息四步流程**（必须能现场画）：

```
Producer                    Broker                      Consumer
   │                          │                            │
   │ 1. 发送半消息(half)        │                            │
   │ ─────────────────────────>│ (存 RMQ_SYS_TRANS_HALF_TOPIC, 不投递)
   │  半消息发送成功             │                            │
   │ <─────────────────────────│                            │
   │                          │                            │
   │ 2. 执行本地 DB 事务         │                            │
   │ (扣库存、写订单等)         │                            │
   │                          │                            │
   │ 3. 根据本地事务结果         │                            │
   │    commit / rollback      │                            │
   │ ─────────────────────────>│                            │
   │                          │ commit: 半消息改写真实 topic  │
   │                          │ ───────────────────────────>│ (消费者可见)
   │                          │ rollback: 删半消息           │
   │                          │                            │
   │ [异常兜底]                 │                            │
   │ 4. Broker 回查本地事务状态  │                            │
   │ <─────────────────────────│                            │
   │   checkLocalTransaction()│                            │
   │   返回 COMMIT/ROLLBACK    │                            │
   │ ─────────────────────────>│                            │
```

**半消息的存储机制**：

```
半消息发送后：
  原始 topic + queueId + offset 被记录在半消息属性中
  消息体被改写存入内部 topic: RMQ_SYS_TRANS_HALF_TOPIC
  消费者订阅的是原 topic，所以 RMQ_SYS_TRANS_HALF_TOPIC 对消费者不可见

commit 时：
  Broker 把半消息改写回原 topic + queueId，存入 RMQ_SYS_TRANS_OP_HALF_TOPIC 标记已处理
  消费者下次拉取原 topic 时可见

rollback 时：
  只标记已处理（存入 OP_HALF_TOPIC），不投递
```

**事务消息代码实现**（必背模板）：

```java
public class OrderTransactionProducer {

    public static void main(String[] args) {
        TransactionMQProducer producer = new TransactionMQProducer("order_tx_group");
        producer.setNamesrvAddr("127.0.0.1:9876");

        // 事务回查监听器（broker 主动调用）
        producer.setTransactionCheckListener((msg, checkCtx) -> {
            String txId = msg.getProperty("txId");
            // 查本地事务状态表
            TxStatus status = txStatusDao.query(txId);
            if (status == TxStatus.COMMIT)   return LocalTransactionState.COMMIT_MESSAGE;
            if (status == TxStatus.ROLLBACK) return LocalTransactionState.ROLLBACK_MESSAGE;
            return LocalTransactionState.UNKNOW;   // 还没执行完，让 broker 继续回查
        });

        // 事务执行器
        producer.setTransactionListener(new TransactionListener() {
            @Override
            public LocalTransactionState executeLocalTransaction(Message msg, Object arg) {
                try {
                    String txId = msg.getProperty("txId");
                    // 执行本地 DB 事务（扣库存、写订单）
                    orderService.createOrder((OrderDTO) arg);
                    // 记录事务状态（供回查用）
                    txStatusDao.insert(txId, TxStatus.COMMIT);
                    return LocalTransactionState.COMMIT_MESSAGE;
                } catch (Exception e) {
                    txStatusDao.insert(txId, TxStatus.ROLLBACK);
                    return LocalTransactionState.ROLLBACK_MESSAGE;
                }
            }

            @Override
            public LocalTransactionState checkLocalTransaction(MessageExt msg) {
                String txId = msg.getProperty("txId");
                TxStatus s = txStatusDao.query(txId);
                switch (s) {
                    case COMMIT:   return LocalTransactionState.COMMIT_MESSAGE;
                    case ROLLBACK: return LocalTransactionState.ROLLBACK_MESSAGE;
                    default:       return LocalTransactionState.UNKNOW;
                }
            }
        });

        producer.start();

        // 发送事务消息
        Message msg = new Message("order_topic", orderJson.getBytes());
        msg.putUserProperty("txId", UUID.randomUUID().toString());
        TransactionSendResult result = producer.sendMessageInTransaction(msg, orderDTO);
        // result.getLocalTransactionState() 是本地事务执行结果
    }
}
```

**回查的关键细节**：

- broker 默认 60s 后开始回查（`transactionCheckInterval`）
- 最大回查次数默认 15 次（`transactionCheckMax`），超过后默认 ROLLBACK
- 回查接口必须**幂等**（broker 可能重复回查）且**快速**（单次 < 5s，否则阻塞 broker）
- `UNKNOW` 状态会让 broker 继续回查，不要长时间返回 UNKNOW（最终会被 rollback）

## 三、机制层：延迟消息实现原理

**RocketMQ 4.x 的延迟级别**（固定 18 级）：

```
1s  5s  10s  30s  1m  2m  3m  4m  5m  6m  7m  8m  9m  10m  20m  30m  1h  2h
 ↑   ↑   ↑    ↑    ↑   ↑   ↑   ↑   ↑   ↑   ↑   ↑   ↑   ↑    ↑    ↑   ↑   ↑
 1   2   3    4    5   6   7   8   9   10  11  12  13  14   15   16  17  18
```

**延迟消息发送代码**：

```java
Message msg = new Message("order_timeout_topic", orderId.getBytes());
msg.setDelayTimeLevel(3);   // 第 3 级 = 10s 后投递
// RocketMQ 5.x 支持任意时间：
// msg.setDeliverTime(System.currentTimeMillis() + 30 * 60 * 1000);  // 30 分钟后

producer.send(msg);
```

**延迟消息 Broker 端实现**：

```
发送时：
  Producer ──> Broker
  Broker 改写消息 topic = SCHEDULE_TOPIC_XXXX（XXXX = 延迟级别）
  原 topic + queueId 存入消息属性
  消息存入 SCHEDULE_TOPIC 的对应 queue（按延迟级别分 queue）

后台 ScheduleMessageService 定时任务（每个级别一个 Timer）：
  每 delayLevel 秒扫描 SCHEDULE_TOPIC 的对应 queue
  对比消息的"投递时间"（storeTime + delay）
  到期的消息：改写回原 topic + queueId，写入 ConsumeQueue
  消费者下次拉取原 topic 即可消费
```

**关键设计**（面试加分点）：

- 同延迟级别的消息进同一 queue，按到期时间顺序排列（因为同级别延迟时间固定，storeTime 顺序 = 到期顺序）
- Broker 用 ConsumeQueue 的 offset 维护扫描进度，避免重复扫描
- 5.x 的任意延迟基于时间轮（TimingWheel），支持毫秒级任意延迟

## 四、实战层：订单超时关单场景

**业务需求**：用户下单 30 分钟未支付，自动关单回滚库存。

**方案对比**：

| 方案 | 实现 | 优劣 |
|------|------|------|
| 定时扫表 | 每 5 分钟扫 orders WHERE status=INIT AND created < now-30min | 简单但扫表慢、有 5 分钟误差、海量订单扛不住 |
| Redis 过期通知 | 订单 ID 存 Redis，过期触发 keyspace notification | 不可靠（Redis 过期通知丢）、集群模式坑多 |
| RocketMQ 延迟消息 | 下单时发延迟 30 分钟消息，消费时检查状态关单 | 精确、解耦、横向扩展（推荐） |

**延迟消息代码实现**：

```java
// 下单服务
@Service
public class OrderService {

    @Resource DefaultMQProducer producer;

    public Order createOrder(OrderDTO dto) {
        Order order = orderDao.insert(dto);   // 写 DB

        // 发延迟 30 分钟消息（level 16 = 30m）
        Message msg = new Message(
            "order_timeout_topic",
            JSON.toJSONString(new TimeoutEvent(order.getId())).getBytes()
        );
        msg.setDelayTimeLevel(16);   // 30 分钟
        producer.send(msg);

        return order;
    }
}

// 关单消费者
@RocketMQMessageListener(topic = "order_timeout_topic", consumerGroup = "timeout_group")
public class OrderTimeoutConsumer implements RocketMQListener<TimeoutEvent> {

    @Override
    public void onMessage(TimeoutEvent event) {
        Order order = orderDao.getById(event.getOrderId());
        if (order.getStatus() == OrderStatus.INIT) {
            // 仍未支付，关单 + 回滚库存
            orderService.closeAndRollback(order);
        }
        // 已支付，忽略（幂等）
    }
}
```

**坑点 1：业务幂等**。延迟消息可能因 rebalance 重复消费，关单操作必须幂等（UPDATE WHERE status=INIT）。

**坑点 2：消息丢失兜底**。延迟消息发送失败要有补偿——重试 + 兜底定时任务扫表（兜底用，不主用）。

**坑点 3：业务提前完成**。用户在 30 分钟内支付了，延迟消息到点消费时发现已支付，直接忽略（幂等）。不需要 cancel 延迟消息。

## 五、实战层：事务消息 vs 本地消息表选型

| 维度 | RocketMQ 事务消息 | 本地消息表 |
|------|-------------------|-----------|
| MQ 依赖 | 强绑 RocketMQ | MQ 无关（Kafka/Rabbit 都行） |
| DB 开销 | 无（不写消息表） | 多写一张消息表 + 定时扫表 |
| 实时性 | 高（commit 即投递） | 中（扫表周期） |
| 实现复杂度 | 中（实现回查接口） | 中（实现扫表任务） |
| 进程崩溃兜底 | Broker 回查 | 扫表任务（消息表状态未更新） |
| 适用 | 用 RocketMQ 的高并发场景 | 用 Kafka/Rabbit 或多 MQ 场景 |

**选型决策**：用 RocketMQ 就用事务消息（省一张表、实时性好）；用 Kafka 或多 MQ 混合用本地消息表（解耦 MQ 依赖）。

## 六、底层本质：为什么是半消息+回查这套设计

回到第一性：**本地 DB 事务和 MQ 发送是两个独立系统，无法原生原子**。

**为什么不直接 XA 事务**：XA 是数据库 + MQ 都支持两阶段提交，性能差（资源锁定时间长）、实现复杂、可用性差（任一参与方挂掉整事务阻塞）。高并发场景不可接受。

**半消息的巧妙之处**：把"MQ 发送"分成两阶段。第一阶段半消息对消费者不可见，所以"发了等于没发"，不影响业务一致性。第二阶段 commit/rollback 才真正决定投递。这样把"DB 提交 + MQ 投递"的原子性，转化为"DB 提交 + 通知 broker commit"的原子性——后者比前者简单（broker 提供了 idempotent 的 commit 接口，重复 commit 无害）。

**回查的必要性**：producer 在"DB 提交后、通知 broker 前"崩溃，broker 永远收不到 commit/rollback，半消息成了"孤儿"。回查机制让 broker 主动问 producer："这个事务到底成了没？" producer 查本地事务状态表回答。这是工程上对"进程崩溃"的兜底，比 XA 的"协调者崩溃阻塞"优雅得多。

**延迟消息的本质**：MQ 本质是日志，日志只能追加不能延迟。延迟消息通过"改写 topic 暂存 + 定时扫描恢复"实现延迟，本质是"先藏起来，到点放出来"。固定延迟级别是性能优化（同级别排队按 storeTime 自然有序），任意延迟（时间轮）是 5.x 的演进。

## 七、AI 架构师加问：5 个 AI 相关问题

1. **AI 推理请求超时取消能用延迟消息吗？**
   可以。发请求时发一条延迟消息（如 30s 后），到点消费检查请求是否已完成，未完成则触发取消（kill 推理进程或标记失败）。比定时扫表轻量，比 RPC 超时灵活（可分级超时）。

2. **AI Agent 长流程编排如何用事务消息保证一致？**
   Agent 每个 step 的状态变更（DB）+ 下游通知（MQ）用事务消息原子。回查接口查 Agent step 状态表，UNKNOW 时 broker 继续回查，直到 step 完成。Agent 重启后能从 step 状态表恢复，不丢步骤。

3. **AI 知识库更新的事务消息如何设计？**
   业务库变更 + MQ 通知向量化服务。事务消息保证业务库 commit 与 MQ 投递原子。消费端（向量化）幂等：doc_id + version 唯一，重复消费覆盖。回查接口查 doc 变更日志表的状态。

4. **让 AI 自动诊断事务消息回查失败，AI 接管哪段？**
   AI 解析 broker 的回查日志、producer 的本地事务状态表，分类根因（回查超时、状态表未写入、回查接口异常）。AI 出建议（调 transactionCheckInterval、修回查接口超时、补状态表写入），人工 review。

5. **AI 推理服务的延迟回调用 RocketMQ 还是时间轮框架？**
   量小（< 千 QPS）用 RocketMQ 延迟消息（运维成熟）。量大（万 QPS 延迟回调）用专门的时间轮框架（如 HashedWheelTimer）或 Redis ZSet，避免 RocketMQ 延迟 queue 成为瓶颈。监控延迟消息的 SCHEDULE_TOPIC 积压。

## 八、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"半消息两阶段、回查兜底崩溃、延迟 18 级、commit 投递 rollback 丢"**。

- **事务消息**：半消息（HALF_TOPIC 不可见）→ 本地事务 → commit/rollback → 回查兜底（默认 15 次）
- **回查接口**：查本地事务状态表，COMMIT/ROLLBACK/UNKNOW，必须幂等且快
- **延迟消息**：4.x 固定 18 级（1s 到 2h），5.x 任意时间（时间轮）
- **延迟实现**：改写 topic 为 SCHEDULE_TOPIC_XXXX，后台定时任务到期恢复
- **选型**：RocketMQ 用事务消息（省表），Kafka/多 MQ 用本地消息表

### 拟人化理解

把事务消息想成 **JD 寄贵重物品开保价单**。半消息是"先开保价单但不正式发车"（broker 收了但消费者看不到）。本地事务是"确认货真价实"（DB 提交）。commit 是"正式发车"（半消息改写真实 topic 投递），rollback 是"取消寄送"（删半消息）。回查是"快递员打电话问寄件人这单到底成不成"（兜底寄件人手机没电）。

延迟消息是 **快递员把包裹先放进定时柜**（SCHEDULE_TOPIC），柜子按级别分格（同级别一起），到点自动弹出派送（改回原 topic）。固定级别是因为同级别的包裹按放入时间自然排序，扫描高效。

### 面试现场 60 秒回答

> RocketMQ 事务消息解决"本地 DB 与 MQ 发送原子性"。流程四步：发半消息（存 RMQ_SYS_TRANS_HALF_TOPIC 消费者不可见）→ 执行本地事务 → commit/rollback 半消息（commit 改写真实 topic 投递）→ broker 回查兜底进程崩溃（默认 60s 开始回查、15 次后默认 rollback）。回查接口我查本地事务状态表返回 COMMIT/ROLLBACK/UNKNOW，必须幂等且单次 < 5s。延迟消息用 setDelayTimeLevel(1-18)，broker 改写 topic 为 SCHEDULE_TOPIC_XXXX 暂存，后台 ScheduleMessageService 定时扫描到期改回原 topic。事务消息比本地消息表省一张表，但强绑 RocketMQ；选型看 MQ 是否统一。

### 反问面试官

> 贵司是用 RocketMQ 还是多 MQ 混合？事务一致用事务消息还是本地消息表？延迟场景的量级和精度要求？这决定我用哪套方案。

## 九、苏格拉底式面试追问

每一问先回答"为什么"，再"怎么做"，最后"如何证明"。

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不直接 XA 事务，要搞事务消息？ | XA 性能差（资源锁定）、实现复杂、协调者崩溃全阻塞。事务消息用半消息+回查，最终一致不阻塞，吞吐高。证明：XA 单 TPS 几百，事务消息单 TPS 万级 |
| 证据追问 | 怎么证明事务消息真的原子？ | 灌测试数据：producer 在 commit 前人为杀进程，broker 应 60s 后回查，根据本地事务状态 commit 或 rollback。对账 send 数、本地 DB 提交数、消费端收到数三者一致 |
| 边界追问 | 事务消息能保证消费端 exactly-once 吗？ | 不能。事务消息只保证"发送与本地事务原子"，消费端还是 at-least-once。消费端必须业务幂等（唯一键/状态机）。跨系统 exactly-once 是伪命题 |
| 反例追问 | 什么场景不用事务消息？ | MQ 不是 RocketMQ（用本地消息表）、对实时性要求低（用扫表）、本地事务很轻（直接 try-catch + 补偿）。强一致且性能敏感才上事务消息 |
| 风险追问 | 事务回查接口的最大风险？ | 回查超时（默认 60s）阻塞 broker、回查状态表没写入导致 UNKNOW 被 rollback 丢消息、回查接口本身有 bug 返回错误状态。监控 transaction_check_fail_count 和 half_message_backlog |
| 验证追问 | 怎么证明延迟消息到点投递了？ | 发延迟消息带 deliverTime 字段，消费端记录实际收到时间，对比 deliverTime 计算延迟误差（应 < 1s）。监控 SCHEDULE_TOPIC 的 queue 积压，到期未投递会积压 |
| 沉淀追问 | 团队事务/延迟消息规范沉淀什么？ | 事务状态表标准 schema、回查接口超时和幂等规范、延迟级别使用对照表、消费端幂等标准模板、half_message_backlog 和 transaction_check_fail_count 告警阈值 |

### 现场对话示例

**面试官**：事务消息的半消息存在哪？

**候选人**：半消息存在 broker 的内部 topic RMQ_SYS_TRANS_HALF_TOPIC，原 topic 和 queueId 存在消息属性里。消费者订阅的是原 topic，所以 RMQ_SYS_TRANS_HALF_TOPIC 对消费者不可见。commit 时 broker 把半消息改写回原 topic 投递，rollback 时只是标记处理过不投递。这套设计让"发了半消息"对消费者等于"没发"，不影响业务一致性。

**面试官**：如果 producer 执行完本地事务但 commit 之前崩了怎么办？

**候选人**：这正是回查机制兜底的场景。broker 在发送半消息后 60s（可配 transactionCheckInterval）开始回查，调用 producer 的 checkLocalTransaction 接口。producer 查本地事务状态表，如果该事务已 COMMIT 则回 COMMIT_MESSAGE，broker 投递半消息；如果 ROLLBACK 则回 ROLLBACK_MESSAGE，broker 丢弃；如果状态表没记录（本地事务真没执行成功）则回 UNKNOW，broker 等下个周期继续回查。默认最多回查 15 次，超过后默认 ROLLBACK。所以业务必须把事务状态写进状态表，否则会被误 rollback 丢消息。

**面试官**：延迟消息 30 分钟关单，如果用户第 29 分钟支付了怎么办？

**候选人**：不用 cancel 延迟消息（RocketMQ 不支持取消已发送的延迟消息）。延迟消息到点消费时，消费者查订单状态：如果已支付（status != INIT）直接忽略（幂等返回）；如果未支付则关单 + 回滚库存。关单操作必须幂等——UPDATE orders SET status='CLOSED' WHERE id=? AND status='INIT'，影响行数 0 即已处理过。所以延迟消息的本质是"定时唤醒检查"，而非"定时强制执行"。

## 常见考点

1. **事务消息和本地消息表怎么选？**——RocketMQ 选事务消息（省表、实时）；Kafka/多 MQ 选本地消息表（解耦 MQ 依赖）。
2. **半消息存哪？**——RMQ_SYS_TRANS_HALF_TOPIC，消费者不可见，commit 后改写真实 topic 投递。
3. **回查接口要注意什么？**——必须幂等（broker 可能重复回查）、快速（单次 < 5s 否则阻塞 broker）、查事务状态表返回明确状态（避免长期 UNKNOW）。
4. **延迟消息级别有哪些？**——4.x 固定 18 级（1s/5s/10s/30s/1m/.../2h），5.x 任意时间（基于时间轮）。
5. **延迟消息能取消吗？**——4.x 不能取消，5.x 支持取消。30 分钟关单场景靠消费时检查状态幂等处理（已支付则忽略）。


## 结构化回答

**30 秒电梯演讲：** 聊到RocketMQ 事务消息与延迟消息设计，我的理解是——RocketMQ 事务消息用"半消息（half message）+ 本地事务回查"解决"本地数据库提交与消息发送"的原子性，是分布式事务最终一致的工业解；延迟消息用固定延迟级别（1s/5s/10s/.../2h）+ 改写 topic 为 SCHEDULE_TOPIC_XXXX 实现定时投递，订单超时关单、延迟支付场景必备。打个比方，像 JD 快递寄贵重物品：事务消息是"先开保价单（半消息），确认货真价实（本地事务回查 OK）再正式发车（commit 半消息）"；延迟消息是"快递员把包裹先放进定时柜（SCHEDULE_TOPIC），到点自动弹出派送"。

**展开框架：**
1. **事务消息四步** — 发送半消息 → 执行本地事务 → commit/rollback 半消息 → Broker 主动回查（兜底）
2. **半消息存内部 topic RMQ_S** — 半消息存内部 topic RMQ_SYS_TRANS_HALF_TOPIC，消费者不可见
3. **延迟消息 18 个级别（1s/5s/** — 延迟消息 18 个级别（1s/5s/10s/30s/1m/2m/3m/4m/5m/6m/7m/8m/9m/10m/20m/30m/1h/2h），5.x 支持任意时间

**收尾：** 这块我在项目里也踩过坑——想深入的话，可以接着聊：事务消息和本地消息表怎么选？您更想看哪个方向？

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡 | "RocketMQ 事务消息与延迟消息设计——这道题面试官到底想考什么？我用 30 秒给你讲透。" | 开场钩子 |
| 0:15 | 事务隔离级别对比表 | 先说核心：RocketMQ 事务消息用"半消息（half message）+ 本地事务回查"解决"本地数据库提交与消息发送"的原子性，是分布式事务最终一致的工业解；延迟消息用固定延迟级别。 | 核心定义 |
| 0:40 | Kafka 架构图 | 半消息存内部 topic RMQ_SYS_TRANS_HALF_TOPIC，消费者不可见。 | 半消息存内部 topic RMQ_S |
| 1:05 | 消息队列架构图 | 延迟消息 18 个级别（1s/5s/10s/30s/1m/2m/3m/4m/5m/6m/7m/8m/9m/10m/20m/30m/1h/2h）。 | 延迟消息 18 个级别（1s/5s/ |
| 2:30 | 总结卡 | 一句话记忆：事务消息四步：半消息 → 本地事务 → commit/rollback → 回查兜底。 下期可以接着聊：事务消息和本地消息表怎么选。 | 收尾总结 |
