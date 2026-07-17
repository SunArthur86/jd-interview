---
id: java-architect-032
difficulty: L2
category: java-architect
subcategory: Kafka
tags:
- Java 架构师
- 消息队列
- 顺序
- 幂等
feynman:
  essence: 消息顺序的本质是"局部有序"——同 key 进同分区保序；重复消费的根因是网络重试与 offset 提交滞后；幂等落库的工程解是"业务唯一键 + 数据库唯一索引"做最后兜底，而不是寄希望于 MQ 的 exactly-once。
  analogy: 像 JD 物流按订单号分拣：同一订单的"下单→支付→发货"必须走同一条传送带（同 key 同分区）才保序；快递员投递失败会重投（重复消费），收件人要凭取件码（幂等键）只取一次不重复签收。
  first_principle: 全局有序与高吞吐不可兼得（全局有序意味着单分区单消费者）。所以工程上放弃全局有序，只承诺"按业务 key 局部有序"。重复消费无法从协议层根除（at-least-once 是默认），只能用幂等把"重复"转化为"幂等无害"。
  key_points:
  - 顺序保证靠分区：同 key 同分区严格有序，跨分区无序
  - 重复消费根因：producer 重试、consumer offset 提交前宕机、rebalance 重分配
  - 幂等三件套：业务唯一键（msgId/bizId）+ 数据库唯一索引 + 状态机
  - 顺序消费的代价：单分区单消费者，吞吐受限；并发消费就破坏顺序
  - 顺序+幂等+重试是"可靠消息"三位一体，缺一不可
first_principle:
  problem: 高并发场景下既要消息有序、又要不重复、还要不丢失，三者怎么同时满足？
  axioms:
  - 全局有序与高吞吐互斥（全局有序 = 单分区 = 串行）
  - 网络不可靠，重试必然带来重复
  - 数据库唯一索引是幂等的最后兜底，比任何应用层判重都可靠
  rebuild: 把"全局有序"降级为"按业务 key 局部有序"（同订单/用户 key 进同分区），用 producer 幂等 + at-least-once 消费避免丢消息，重复消费用数据库唯一索引或状态机转化为幂等。三者组合：分区保序 + at-least-once 不丢 + 业务幂等去重 = 工程上的"可靠有序消费"。
follow_up:
  - 全局有序怎么办？——单分区单消费者，吞吐极低，只适合配置变更、Binlog 同步等低 QPS 场景；高 QPS 全局有序是反模式
  - 顺序消息怎么扩容？——分区数固定时只能纵向扩（单消费者提速）；要横向扩必须重新设计 key 路由（如按 user_id % N 拆 N 个子 topic）
  - Redis 令牌幂等可靠吗？——单独 Redis 不可靠（宕机丢令牌）。要 Redis + DB 双保险：Redis 快判重拦 99%，DB 唯一索引兜底拦 1%
  - 状态机幂等怎么做？——定义合法状态转移（INIT→PAID→SHIPPED），消息带目标状态，UPDATE WHERE status IN (合法前置) 只命中一次
  - 乱序怎么发现？——给消息加 seq 字段，消费端校验 seq 递增，断裂告警；或按业务时间戳对账发现后到的旧消息
memory_points:
  - 顺序 = 同 key 同分区，全局有序是反模式
  - 重复根因 = producer 重试 + offset 滞后 + rebalance
  - 幂等三件套：业务唯一键 + DB 唯一索引 + 状态机
  - 顺序消费必须单分区单消费者，要并发就牺牲顺序
  - at-least-once + 业务幂等是工业标准答案，exactly-once 跨系统是伪命题
---

# 【Java 后端架构师】消息顺序、重复消费与幂等落库

> 适用场景：JD 核心技术。订单状态机（下单→支付→发货→签收）消息必须有序，否则"先发货后支付"的乱序会让业务崩溃；扣款消息重复消费一次用户就多扣一笔。架构师必须能讲清楚顺序怎么保、重复怎么去、幂等怎么落。

## 一、概念层：顺序、重复、幂等三个独立问题

**三者不是同一回事**（面试常被混为一谈）：

| 问题 | 根因 | 工程解 |
|------|------|--------|
| **顺序** | 多分区并行消费，跨分区无序 | 同 key 路由同分区（局部有序） |
| **重复** | producer 重试 / consumer offset 滞后 / rebalance | 业务幂等（唯一键/状态机） |
| **丢失** | acks=0 / offset 先提交后处理 | acks=all + at-least-once + 手动提交 |

**顺序的三层语义**（必须分清）：

```
全局有序（Global Order）   所有消息严格按发送顺序消费
  → 单分区 + 单消费者，吞吐极低，仅配置/Binlog 场景

分区有序（Partition Order） 同 key 消息进同分区，分区内有序
  → 99% 业务场景的工程解，按 order_id / user_id 做 key

无序（Best Effort）        多分区并行，不保证顺序
  → 日志、埋点、监控，吞吐优先
```

## 二、机制层：顺序保证的工程实现

**同 key 同分区的路由机制**：

```java
// Producer 端：用业务 key（如 orderId）做分区路由
ProducerRecord<String, String> record = new ProducerRecord<>(
    "order_event",
    orderId,         // key —— Kafka 用 hash(key) % partitionCount 路由
    eventJson        // value
);
producer.send(record);

// 同一 orderId 的 下单/支付/发货 必然进同一分区，分区内严格按发送顺序排列
```

**Kafka 默认分区器**：

```java
// org.apache.kafka.clients.producer.internals.DefaultPartitioner 简化逻辑
public int partition(String topic, Object key, byte[] keyBytes, ...) {
    if (keyBytes == null) {
        return StickyPartitioner...;  // 无 key：黏性分区（攒批同分区，提升吞吐）
    }
    return Utils.toPositive(Utils.murmur2(keyBytes)) % numPartitions;  // 有 key：murmur2 hash
}
```

**消费者顺序消费**（单分区单消费者）：

```java
// 一个分区在同一消费组内只能被一个消费者消费 → 天然串行
// 但要警惕：poll 一次拉多条，业务处理顺序就是 records 顺序
ConsumerRecords<String, String> records = consumer.poll(Duration.ofMillis(500));
for (ConsumerRecord<String, String> r : records) {  // 顺序处理
    process(r);   // 必须串行，不能 parallel stream
}
consumer.commitSync();
```

**顺序消费的代价与扩展性瓶颈**：

```
单分区吞吐上限 ≈ 单消费者处理速度
  → 5万 QPS 单分区只能由 1 个消费者处理 → 该消费者必须能扛 5万 QPS
  → 扛不住怎么办？拆 key 维度（按 userId % 100 拆 100 个子 topic）
  → 注意：拆了之后，跨子 topic 又无序了，只能保证子 topic 内有序
```

## 三、机制层：重复消费的根因分析

**重复产生的四个时机**：

```
1. Producer 重试重复
   send() 超时 → retries 触发 → 实际 broker 已写入 → 重复
   解：enable.idempotence=true（PID + seq 去重）

2. Consumer offset 滞后
   处理完消息 → 提交 offset 前 consumer 宕机 → 重启从旧 offset 消费 → 重复
   解：业务幂等兜底（at-least-once 必然重复）

3. Rebalance 重分配
   消费者加入/退出 → 分区重新分配 → 新消费者从上次提交 offset 开始 → 可能重复
   解：max.poll.interval.ms 调大、处理完再提交

4. 跨系统调用重复
   消费 → 调下游 HTTP → 下游成功但响应超时 → 重试 → 下游收到两次
   解：HTTP 调用带 requestId，下游幂等
```

**Producer 幂等原理**（Kafka 0.11+）：

```
开启 enable.idempotence=true 后：
  Producer 启动时从 TransactionCoordinator 拿到 PID (Producer ID)
  每条消息带 (PID, partition, sequenceNumber)
  Broker 端按 (PID, partition) 维护 seq，重复 seq 的消息丢弃
  → 单 producer 单会话内重试不重复

局限：PID 是 ephemeral 的，producer 重启后 PID 变 → 跨重启不幂等
     跨重启幂等要 transactional.id（事务 producer），但要配合事务 API
```

## 四、机制层：幂等落库的三种工程方案

**方案 1：数据库唯一索引（最可靠）**

```sql
-- 业务表加 msg_id 唯一索引
CREATE TABLE order_event_log (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    msg_id VARCHAR(64) NOT NULL,
    order_id BIGINT NOT NULL,
    -- ...
    UNIQUE KEY uk_msg_id (msg_id)   -- 关键！重复插入报 1062 错误
);

-- 消费逻辑
public void consume(OrderEvent event) {
    try {
        jdbcTemplate.update(
            "INSERT INTO order_event_log(msg_id, order_id, ...) VALUES(?, ?, ...)",
            event.getMsgId(), event.getOrderId(), ...);
    } catch (DuplicateKeyException e) {
        // 唯一键冲突 = 已处理过，幂等返回
        log.info("Duplicate msg {} skipped", event.getMsgId());
        return;
    }
    // 后续业务逻辑
}
```

**方案 2：状态机幂等（业务流转场景）**

```sql
-- 订单状态机：INIT → PAID → SHIPPED → DELIVERED
-- 幂等靠 UPDATE WHERE 限定前置状态

-- 处理"支付消息"
UPDATE orders
SET status = 'PAID', paid_at = NOW()
WHERE order_id = ? AND status = 'INIT';   -- 只有 INIT 状态能转 PAID

-- 影响行数 = 0 表示：① 订单不存在 ② 已是 PAID（重复消息）③ 状态非法跳转
-- 影响行数 = 1 表示：状态转移成功
```

```java
public void handlePaidEvent(PaidEvent event) {
    int rows = jdbcTemplate.update(
        "UPDATE orders SET status='PAID', paid_at=NOW() WHERE order_id=? AND status='INIT'",
        event.getOrderId());
    if (rows == 0) {
        Order o = orderDao.getById(event.getOrderId());
        if (o == null) throw new OrderNotFoundException();
        if ("PAID".equals(o.getStatus())) {
            log.info("Already paid, idempotent skip");
            return;  // 幂等
        }
        throw new IllegalStateTransitionException(o.getStatus() + "→PAID");
    }
}
```

**方案 3：Redis 令牌（高并发快判重）**

```java
public boolean tryIdempotent(String msgId) {
    // SETNX + 过期时间，返回 true 表示首次，false 表示重复
    Boolean ok = redis.opsForValue().setIfAbsent(
        "idempotent:" + msgId, "1", Duration.ofHours(24));
    return Boolean.TRUE.equals(ok);
}
```

**三种方案的取舍**：

| 方案 | 可靠性 | 性能 | 适用 |
|------|--------|------|------|
| **DB 唯一索引** | 最高（数据库 ACID 保证） | 中（每次写表） | 资金、订单核心链路（推荐兜底） |
| **状态机** | 高（业务语义保证） | 高（一条 UPDATE） | 状态流转场景（订单、工单） |
| **Redis 令牌** | 中（Redis 宕机丢令牌） | 最高 | 高并发前置判重，必须配 DB 兜底 |

**生产推荐组合**：Redis 令牌前置拦 99% + DB 唯一索引兜底拦 1%。Redis 单独用不可靠（宕机丢令牌导致重复），DB 单独用性能差（每次查表），双保险最优。

## 五、实战层：完整可靠消费代码

**生产级顺序+幂等消费模板**：

```java
@Component
@Slf4j
public class OrderEventConsumer {

    @KafkaListener(
        topics = "order_event",
        groupId = "order_consumer_group",
        concurrency = "3"   // = min(分区数, 消费者数)
    )
    public void onMessage(
            @Payload String message,
            @Header(KafkaHeaders.RECEIVED_MESSAGE_KEY) String key,
            Acknowledgment ack) {

        OrderEvent event = JSON.parseObject(message, OrderEvent.class);
        String msgId = event.getMsgId();

        try {
            // 1. Redis 快判重（拦 99%）
            if (!redisOps.setIfAbsent("idempotent:" + msgId, "1", Duration.ofHours(24))) {
                log.info("Duplicate msg {} (redis), skipped", msgId);
                ack.acknowledge();   // 重复也要提交 offset，否则反复消费
                return;
            }

            // 2. 事务内：DB 唯一索引兜底 + 业务状态机
            transactionTemplate.execute(status -> {
                jdbcTemplate.update(
                    "INSERT INTO order_event_log(msg_id, order_id, event_type, ...) " +
                    "VALUES(?, ?, ?, ...)",
                    msgId, event.getOrderId(), event.getType(), ...);

                applyEvent(event);   // 状态机转移：UPDATE orders SET status=? WHERE ...

                return null;
            });

            // 3. 处理成功，提交 offset
            ack.acknowledge();

        } catch (DuplicateKeyException e) {
            // DB 唯一键冲突 = Redis 令牌丢失后重复，幂等跳过
            log.info("Duplicate msg {} (db), skipped", msgId);
            ack.acknowledge();

        } catch (IllegalStateTransitionException e) {
            // 乱序消息：如已 SHIPPED 又收到 PAID，记录后跳过（不能无限重试卡死分区）
            log.error("Out-of-order msg {}: {}", msgId, e.getMessage());
            sendToDlq(message, "OUT_OF_ORDER");   // 转死信队列人工介入
            ack.acknowledge();
        }
    }
}
```

**乱序消息的检测与兜底**：

```java
// 给消息加 seq 字段，消费端校验
public void onMessage(OrderEvent event) {
    Long lastSeq = redisOps.get("seq:" + event.getOrderId());
    if (lastSeq != null && event.getSeq() <= lastSeq) {
        log.warn("Stale msg seq {} <= last {}", event.getSeq(), lastSeq);
        return;  // 旧消息，丢弃
    }
    redisOps.set("seq:" + event.getOrderId(), event.getSeq());
    process(event);
}
```

## 六、底层本质：为什么顺序+不重+不丢是 CAP 级别的难题

回到第一性：**这是分布式系统的基本约束，不是 Kafka 的实现缺陷**。

**为什么全局有序与高吞吐互斥**：全局有序要求所有消息进同一队列，单队列串行消费，吞吐上限 = 单消费者速度。这是物理约束——并行就必然乱序（不同消费者处理速度不同）。所以工程上放弃全局有序，只承诺按 key 局部有序。

**为什么重复无法从协议层根除**：网络不可靠是物理事实。producer send 超时无法区分"消息没到 broker"还是"到了但响应丢"。保险起见只能重试，重试就可能重复。即使 Kafka 给了 producer 幂等（PID+seq），跨系统边界（消费 → 写 MySQL）依然有重复窗口（处理成功但 commit offset 失败）。所以 at-least-once 是工业默认，exactly-once 跨系统是伪命题。

**幂等的本质是"让重复无害化"**：与其纠结"如何不重复"，不如接受"必然重复"的事实，把重复消费转化为幂等无害操作。数据库唯一索引是幂等的最强兜底——它依赖数据库 ACID，比任何应用层判重都可靠（应用层判重怕并发，数据库唯一索引不怕）。

**顺序+幂等的组合代价**：顺序 = 单分区单消费者 = 并行度受限；幂等 = 每条消息多一次查重。两者都是用"性能"换"正确性"。架构师的工作是算清楚：业务 key 维度有多少（决定分区数）、单 key QPS 多少（决定单消费者压力）、判重成本多少（决定 Redis vs DB）。

## 七、AI 架构师加问：5 个 AI 相关问题

1. **AI RAG 知识库增量更新如何保证消息有序不重？**
   业务变更走 Kafka，按 doc_id 做 key 路由同分区（保证同 doc 的多次变更有序）。消费端用 doc_id + version 做幂等，version 小于当前 version 的消息丢弃。写入向量库时用 doc_id 做唯一键 upsert。

2. **AI 推理结果异步回写用什么消费语义？**
   at-least-once + 业务幂等。推理请求带 request_id，结果回写时 request_id 唯一索引。重复消费只覆盖相同结果（推理幂等），不影响业务。

3. **让 AI 自动发现乱序消息根因，AI 接管哪段？**
   AI 解析死信队列的乱序消息、对比同 key 消息的发送时间戳与消费时间戳，分类根因（producer 端异步发送乱序、消费端多线程处理乱序、rebalance 重分配乱序）。AI 出治理建议（producer 改同步 send、消费端改串行、调 rebalance 参数），人工 review。

4. **AI Agent 工具调用如何用 requestId 实现幂等？**
   每个 tool_call 必须带唯一 request_id，工具执行前检查 Redis/DB 是否已处理过该 request_id。AI 重试或网络抖动重发同一 request_id 时，工具返回上次结果（幂等），不重复执行副作用。审计日志记录每个 request_id 的执行次数。

5. **AI 训练数据回流如何避免重复数据污染训练集？**
   回流消息按 sample_id 做 key 同分区，消费端按 sample_id 去重。训练集加载时再做一次 sample_id 全局去重（防回流管道重复）。监控训练集 duplicate_rate，过高说明回流幂等失效。

## 八、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"同 key 同分区保序、at-least-once 必重复、DB 唯一索引兜底、状态机幂等流转"**。

- **顺序**：全局有序是反模式（单分区串行），同 key 同分区局部有序是工程解
- **重复**：producer 重试 + offset 滞后 + rebalance 三大根因
- **幂等**：业务唯一键 + DB 唯一索引（最可靠兜底）+ 状态机 + Redis 令牌前置
- **取舍**：顺序消费牺牲并行度，幂等牺牲性能（多一次判重）
- **工业答案**：at-least-once + 业务幂等，exactly-once 跨系统是伪命题

### 拟人化理解

把消息消费想成 **JD 物流分拣签收**。同一订单的包裹（同 key）必须走同一条传送带（同分区），不能拆到不同传送带（否则先发货后支付的乱序）。快递员投递失败重投（重复消费），收件人凭取件码（幂等键）只签收一次——即使快递员来 10 次，取件码已核销就拒绝重复签收。状态机是"订单只能从待支付到已支付"，已经支付的再来一次支付消息自然被拒。

### 面试现场 60 秒回答

> 消息顺序我用同 key 同分区局部有序——按 order_id 做 key 路由，Kafka murmur2 hash 保证同 key 进同分区，分区内严格有序，全局有序是反模式。重复消费的根因是 producer 重试、offset 提交前宕机、rebalance 重分配，at-least-once 是协议默认，跨系统 exactly-once 是伪命题。幂等我用三件套：Redis 令牌前置拦 99%、DB 唯一索引兜底拦 1%、状态机做业务流转幂等。状态机幂等的精髓是 UPDATE WHERE status='INIT' 只命中一次，重复消息影响行数 0 直接幂等返回。乱序消息我加 seq 字段校验，旧 seq 丢弃转死信队列。

### 反问面试官

> 贵司核心链路对消息顺序的要求是全局有序还是局部有序？幂等是 DB 唯一索引还是状态机？这决定我的分区 key 设计和幂等方案选型。

## 九、苏格拉底式面试追问

每一问先回答"为什么"，再"怎么做"，最后"如何证明"。

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不直接全局有序，要搞局部有序？ | 全局有序 = 单分区 = 单消费者串行，吞吐上限 = 单消费者速度，5万 QPS 单消费者扛不住。局部有序（同 key 同分区）让不同 key 并行，吞吐随分区数线性扩展。证明：单分区顺序消费压测 5000 QPS 到顶，100 分区 = 50万 QPS |
| 证据追问 | 怎么证明线上有重复消费？ | DB 查重复 msg_id（按 msg_id group by having count > 1）、对账系统按业务流水号日切对齐、消费端日志统计 DuplicateKeyException 次数、kafka-consumer-groups.sh --describe 看 LAG 与 commit offset 差距 |
| 边界追问 | 幂等能处理所有重复吗？ | 不能。带副作用的下游调用（发短信、扣外部积分）下游不幂等就难办，要把 requestId 透传给下游做幂等。跨系统真正 exactly-once 不存在，只能端到端幂等 |
| 反例追问 | 什么场景你不用状态机幂等？ | 非状态流转场景（如埋点上报、计数累加），状态机无意义。这类用 DB 唯一键或 Redis SETNX。强行套状态机是过度设计 |
| 风险追问 | Redis 令牌幂等最大风险？ | Redis 宕机丢令牌导致重复（即使 AOF 也有秒级窗口）、Redis 主从切换期间双写。所以 Redis 令牌必须配 DB 唯一索引兜底，Redis 只做前置快判重，不能单独依赖 |
| 验证追问 | 怎么证明幂等真的生效？ | 压测时主动制造重复（同 msg_id 发 10 次），消费端统计实际处理次数应 = 1；故障演练杀消费者实例期间灌消息，恢复后对账 send 数与处理数应一致；监控 duplicate_skip_rate 和 DuplicateKeyException 频率 |
| 沉淀追问 | 团队幂等规范沉淀什么？ | 消息必须带 msg_id 字段、业务表必须有 msg_id 唯一索引、状态机流转用 UPDATE WHERE 约束前置状态、Redis 令牌前置 + DB 兜底标准模板、乱序检测加 seq 字段、死信队列人工介入 SOP |

### 现场对话示例

**面试官**：怎么保证订单状态机消息有序？

**候选人**：用 order_id 做 producer 的 key，Kafka 默认分区器用 murmur2 hash key 路由，同一订单的下单/支付/发货消息必然进同一分区，分区内严格按发送顺序排列。消费端单分区单消费者串行处理，不 parallel stream。这里有个坑：producer 端如果异步 send 且没等 future，可能因为重试乱序，要配 enable.idempotence=true（max.in.flight ≤ 5）保证单分区发送顺序。

**面试官**：消费端 rebalance 会不会破坏顺序？

**候选人**：会短暂暂停但不破坏顺序。rebalance 时分区重新分配，新消费者从上次 commit 的 offset 继续消费，offset 是单调递增的，所以顺序保留。问题是 rebalance 期间可能重复消费（处理完未 commit 就被踢），所以还是要业务幂等。我用 CooperativeStickyAssignor 减少重平衡范围，只动变更的分区。

**面试官**：幂等具体怎么做？

**候选人**：三件套。第一，消息必须带全局唯一 msg_id（业务生成 UUID 或用 Kafka 的 record metadata 拼接）。第二，DB 业务表加 msg_id 唯一索引，重复插入抛 DuplicateKeyException 幂等捕获。第三，状态流转用 UPDATE WHERE status='前置状态' 只命中一次。高并发前置 Redis 令牌拦 99% 重复，DB 索引兜底拦剩下 1%（Redis 宕机窗口）。这套组合 Redis 单独不可靠、DB 单独性能差，双保险最稳。

## 常见考点

1. **全局有序怎么办？**——单分区单消费者，吞吐极低，仅 Binlog 同步/配置变更场景。高 QPS 全局有序是反模式，要用局部有序（同 key 同分区）。
2. **重复消费根因？**——producer 重试（解：enable.idempotence）、offset 提交前宕机（解：业务幂等）、rebalance 重分配（解：调 max.poll.interval + CooperativeAssignor）。
3. **幂等最强方案？**——DB 唯一索引，依赖数据库 ACID，比应用层判重可靠（不怕并发）。Redis 令牌单独不可靠（宕机丢令牌），必须配 DB 兜底。
4. **状态机幂等怎么做？**——定义合法状态转移，UPDATE WHERE status IN (前置状态)，影响行数 0 即重复或非法跳转。比 msg_id 唯一键更适合状态流转场景。
5. **乱序怎么检测？**——消息加 seq 字段，消费端按 key 维护 last_seq，新消息 seq ≤ last_seq 即旧消息丢弃转死信队列。


## 结构化回答

**30 秒电梯演讲：** 聊到消息顺序、重复消费与幂等落库，我的理解是——消息顺序的本质是"局部有序"——同 key 进同分区保序；重复消费的根因是网络重试与 offset 提交滞后；幂等落库的工程解是"业务唯一键 + 数据库唯一索引"做最后兜底，而不是寄希望于 MQ 的 exactly-once。打个比方，像 JD 物流按订单号分拣：同一订单的"下单→支付→发货"必须走同一条传送带（同 key 同分区）才保序；快递员投递失败会重投（重复消费），收件人要凭取件码（幂等键）只取一次不重复签收。

**展开框架：**
1. **顺序保证靠分区** — 同 key 同分区严格有序，跨分区无序
2. **重复消费根因** — producer 重试、consumer offset 提交前宕机、rebalance 重分配
3. **幂等三件套** — 业务唯一键（msgId/bizId）+ 数据库唯一索引 + 状态机

**收尾：** 这块我在项目里也踩过坑——想深入的话，可以接着聊：全局有序怎么办？您更想看哪个方向？

## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡 | "消息顺序、重复消费与幂等落库——这道题面试官到底想考什么？我用 30 秒给你讲透。" | 开场钩子 |
| 0:15 | Kafka 架构图 | 先说核心：消息顺序的本质是"局部有序"——同 key 进同分区保序；重复消费的根因是网络重试与 offset 提交滞后；幂等落库的工程解是"业务唯一键 + 数据库唯一索引"做最后兜底，而。 | 核心定义 |
| 0:30 | 消息队列架构图 | producer 重试、consumer offset 提交前宕机、rebalance 重分配。 | 重复消费根因 |
| 1:30 | 总结卡 | 一句话记忆：顺序 = 同 key 同分区，全局有序是反模式。 下期可以接着聊：全局有序怎么办。 | 收尾总结 |
