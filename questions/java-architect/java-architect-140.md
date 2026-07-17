---
id: java-architect-140
difficulty: L4
category: java-architect
subcategory: 系统解耦
tags:
- Java 架构师
- Outbox
- CDC
- 事件发布
feynman:
  essence: Outbox 模式解决"业务数据更新 + 事件发布"的原子性问题——传统模式（先更 DB 后发消息）会因发消息失败丢事件，Outbox 把事件和业务数据放同一事务写到一个 outbox 表，保证原子。CDC（Change Data Capture）异步监听 outbox 表变更（通过 binlog），把事件推到 Kafka。这样"业务事务原子写 outbox + CDC 异步推 Kafka"，实现可靠事件发布。
  analogy: 像寄信。Outbox 是"邮局信箱"——你写信投到信箱（和业务操作一起，原子），不直接送给邮递员（避免送信失败丢信）。CDC 是"邮递员定期开信箱取信分发"——异步、可靠、不阻塞业务。
  first_principle: 为什么不"先更 DB 后发消息"？因为 DB 提交和消息发送是两个系统，无法原子。发消息失败要么丢事件（业务已提交但消息没发），要么业务回滚（消息发了但业务失败）。Outbox 把"事件"变成业务事务的一部分（写 outbox 表），用 DB 本地事务保证原子，再用 CDC 异步推 Kafka。
  key_points:
  - Outbox 表：和业务表同库，存待发布事件（id, aggregate_id, type, payload, status, created_at）
  - CDC：Debezium 监听 outbox 表 binlog，变更即推 Kafka
  - 幂等：消费端按 event_id 去重，CDC 重启可能重投
  - 顺序：同一 aggregate 的事件按 created_at 顺序（单分区）
  - 失败处理：CDC 失败 outbox 堆积；消费失败重试或死信
first_principle:
  problem: 微服务架构下"业务数据更新 + 事件通知下游"如何原子，避免事件丢失或业务回滚？
  axioms:
  - DB 提交和 Kafka 发送是两个系统，2PC 性能差不可行
  - 业务事务原子性是底线（数据不能错），事件丢失可补偿
  - 跨系统原子只能用"本地事务 + 异步同步"模式
  rebuild: 业务事务里同时写 business 表和 outbox 表（一个本地事务，原子）。CDC（Debezium）监听 outbox 表 binlog，变更异步推 Kafka。这样事件发布是"at-least-once + 业务幂等"——CDC 重启可能重投，消费端按 event_id 去重。outbox 表定期清理（已发布事件归档），避免无限膨胀。
follow_up:
  - Outbox 表会无限膨胀吗？——会。已发布事件定期归档/删除（如保留 7 天）。CDC 推 Kafka 后状态置 PUBLISHED，后台 job 清理。
  - CDC 失败怎么办？——CDC 是 Debezium 实例，挂了 binlog 不消费（offset 不变），重启从上次 offset 继续。outbox 表会堆积，但 DB 扛得住（数据量可控）。
  - 事件顺序怎么保证？——同一 aggregate_id 路由到同 Kafka 分区，单分区内按 created_at 顺序消费。跨 aggregate 无序（业务可接受）。
  - Debezium 怎么部署？——独立服务（Connect 模式）或独立进程（Standalone），监听 MySQL binlog。生产用 Connect 集群（Kafka Connect）。
  - Outbox 和 Saga 区别？——Outbox 解决"事件可靠发布"（一次操作一个事件）；Saga 解决"跨服务长事务"（多步操作链式补偿）。两者互补：Saga 用 Outbox 发补偿事件。
memory_points:
  - Outbox 表：业务事务原子写，存待发布事件
  - CDC（Debezium）监听 binlog，异步推 Kafka
  - 幂等：消费端按 event_id 去重
  - 顺序：aggregate_id 路由同分区，单分区内按时间顺序
  - 清理：已发布事件定期归档/删除
---

# 【Java 后端架构师】Outbox + CDC 如何保证事件可靠发布

> 适用场景：JD 核心技术。京东订单创建后要发 Kafka 事件给履约、营销、风控、BI。"先更 DB 后发消息"模式在网络抖动时会丢事件——订单创建了但下游不知道，导致履约延迟、风控漏判。引入 Outbox + CDC 后，订单事务原子写 outbox 表，Debezium 异步监听推 Kafka，事件零丢失。

## 一、概念层

**三种事件发布模式对比**（必背）：

| 模式 | 原子性 | 复杂度 | 适用 |
|------|--------|--------|------|
| **先更 DB 后发消息** | 不保证（发消息失败丢事件） | 低 | 低一致性要求 |
| **先发消息后更 DB** | 不保证（DB 失败消息已发） | 低 | 极少用 |
| **2PC（XA）** | 强一致 | 高 | 性能差，不推荐 |
| **Outbox + CDC** | 业务事务原子 + 事件 at-least-once | 中 | 推荐，生产标配 |

**Outbox + CDC 流程**（必画）：

```
应用 ──── 业务事务 ────┬─► 1. UPDATE orders SET status='PAID' WHERE id=?
                     │
                     └─► 2. INSERT INTO outbox (event_id, type, payload) VALUES (...)
                     │
                     ▼
              DB 提交本地事务（原子！）
                     │
                     ▼
           ┌──── Debezium（CDC）────┐
           │  监听 outbox 表 binlog │
           │  新增行 → 读 payload    │
           │  → 推到 Kafka          │
           └────────────┬───────────┘
                        │
                        ▼
                   Kafka topic
                        │
                        ▼
                   下游消费（幂等）
```

## 二、机制层：Outbox 表设计

**Outbox 表结构**：

```sql
CREATE TABLE outbox (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    event_id VARCHAR(64) NOT NULL,          -- 事件唯一 ID（UUID，幂等用）
    aggregate_type VARCHAR(50) NOT NULL,    -- 聚合类型（如 Order）
    aggregate_id VARCHAR(64) NOT NULL,      -- 聚合 ID（如订单号，分区路由用）
    event_type VARCHAR(50) NOT NULL,        -- 事件类型（如 OrderPaid）
    payload JSON NOT NULL,                  -- 事件内容
    headers JSON,                           -- 元数据（traceId, user_id 等）
    created_at DATETIME NOT NULL,
    published_at DATETIME,                  -- 已发布时间（NULL 表示未发布）

    INDEX idx_aggregate (aggregate_type, aggregate_id),
    INDEX idx_created (created_at),
    INDEX idx_unpublished (published_at)
);
```

**业务事务原子写 outbox**：

```java
@Service
public class OrderService {

    @Autowired private OrderRepo orderRepo;
    @Autowired private OutboxRepo outboxRepo;

    @Transactional
    public void payOrder(String orderId) {
        // 1. 业务更新（同事务）
        Order order = orderRepo.findById(orderId);
        order.setStatus("PAID");
        order.setPaidAt(Instant.now());
        orderRepo.save(order);

        // 2. 写 outbox（同事务，原子）
        OutboxEvent event = new OutboxEvent();
        event.setEventId(UUID.randomUUID().toString());
        event.setAggregateType("Order");
        event.setAggregateId(orderId);
        event.setEventType("OrderPaid");
        event.setPayload(JSON.toJSONString(Map.of(
            "orderId", orderId,
            "userId", order.getUserId(),
            "amount", order.getAmount(),
            "paidAt", order.getPaidAt()
        )));
        event.setHeaders(JSON.toJSONString(Map.of(
            "traceId", MDC.get("traceId"),
            "version", "1.0"
        )));
        event.setCreatedAt(new Date());
        outboxRepo.save(event);

        // 事务提交后，outbox 行已落库，CDC 会监听到
    }
}
```

## 三、机制层：CDC（Debezium）配置

**Debezium MySQL Connector 配置**：

```json
{
  "name": "order-outbox-connector",
  "config": {
    "connector.class": "io.debezium.connector.mysql.MySqlConnector",
    "database.hostname": "mysql.jd.com",
    "database.port": "3306",
    "database.user": "debezium",
    "database.password": "${VAULT_PASSWORD}",
    "database.server.id": "184054",
    "database.server.name": "order-service",
    "database.include.list": "order_db",
    "table.include.list": "order_db.outbox",
    "database.history.kafka.bootstrap.servers": "kafka:9092",
    "database.history.kafka.topic": "schema-history.order",

    "transforms": "outbox",
    "transforms.outbox.type": "io.debezium.transforms.outbox.EventRouter",
    "transforms.outbox.table.field.event.id": "event_id",
    "transforms.outbox.table.field.event.key": "aggregate_id",
    "transforms.outbox.table.field.event.type": "event_type",
    "transforms.outbox.table.field.event.payload": "payload",
    "transforms.outbox.table.field.event.headers": "headers",
    "transforms.outbox.route.by.field": "aggregate_type",
    "transforms.outbox.route.topic.replacement": "order.${routedByValue}",

    "transforms.outbox.predicate": "false",

    "snapshot.mode": "schema_only_recovery",
    "tombstones.on.delete": "false"
  }
}
```

**EventRouter Transform** 是 Debezium 内置的 Outbox 模式转换器，把 outbox 表行转成 Kafka 消息（key=aggregate_id, value=payload, headers=headers），路由到不同 topic。

**部署 Debezium**（Kafka Connect 模式）：

```bash
# 启动 Kafka Connect（带 Debezium plugin）
docker run -d \
    -p 8083:8083 \
    -e BOOTSTRAP_SERVERS=kafka:9092 \
    -e GROUP_ID=1 \
    -e CONFIG_STORAGE_TOPIC=connect_configs \
    -e OFFSET_STORAGE_TOPIC=connect_offsets \
    -v /plugins/debezium:/kafka/connect \
    confluentinc/cp-kafka-connect

# 注册 connector（POST 配置到 Connect REST API）
curl -X POST http://localhost:8083/connectors \
    -H "Content-Type: application/json" \
    -d @order-outbox-connector.json
```

## 四、机制层：消费端幂等

**消费端按 event_id 去重**：

```java
@Service
public class OrderEventConsumer {

    @Autowired private OrderEventLogRepo logRepo;
    @Autowired private FulfillmentService fulfillmentService;

    @KafkaListener(topics = "order.Order")
    public void consume(@Header("eventId") String eventId,
                         @Payload String payload) {
        // 1. 幂等检查
        if (logRepo.existsByEventId(eventId)) {
            log.info("Event already processed: {}", eventId);
            return;
        }

        // 2. 业务处理
        OrderEvent event = JSON.parseObject(payload, OrderEvent.class);
        switch (event.getEventType()) {
            case "OrderPaid":
                fulfillmentService.startFulfillment(event.getOrderId());
                break;
            case "OrderCancelled":
                fulfillmentService.cancelFulfillment(event.getOrderId());
                break;
        }

        // 3. 记录已处理（幂等用）
        OrderEventLog log = new OrderEventLog();
        log.setEventId(eventId);
        log.setProcessedAt(Instant.now());
        logRepo.save(log);   // event_id UNIQUE 约束兜底
    }
}
```

## 五、机制层：Outbox 清理

**定期清理已发布事件**：

```java
@Scheduled(cron = "0 0 3 * * *")  // 每天凌晨 3 点
public void cleanupOutbox() {
    // 删除 7 天前已发布的事件
    outboxRepo.deletePublishedBefore(Date.from(
        Instant.now().minus(7, ChronoUnit.DAYS)
    ));
}
```

**双保险：CDC + Polling 兜底**：

```java
// 如果 CDC 挂了，定时扫描未发布事件手动推 Kafka
@Scheduled(fixedDelay = 60000)
public void fallbackPublisher() {
    List<OutboxEvent> unpublished = outboxRepo.findUnpublished(100);
    for (OutboxEvent e : unpublished) {
        try {
            kafkaTemplate.send("order." + e.getAggregateType(),
                e.getAggregateId(), e.getPayload());
            outboxRepo.markPublished(e.getId());
        } catch (Exception ex) {
            log.error("Fallback publish failed: " + e.getEventId(), ex);
        }
    }
}
```

## 六、底层本质：本地事务替代分布式事务

回到第一性：**Outbox 模式的精髓是"用本地事务 + 异步同步"替代"分布式事务"，让事件发布变成业务事务的一部分**。

- **为什么本地事务能解决原子性**：业务表和 outbox 表在同一 DB，一个本地事务保证两者原子。提交后 outbox 行一定存在，CDC 一定能监听到。
- **为什么 CDC 而不是业务代码发 Kafka**：业务代码发 Kafka 在事务外，无法原子（事务提交前发可能业务回滚，事务提交后发可能失败）。CDC 监听 binlog 是"事件驱动"——DB 提交后 binlog 一定有记录，CDC 一定能读到。
- **at-least-once 的本质**：CDC 重启可能重投（offset 未保存），消费端必须幂等。幂等靠 event_id 唯一索引去重。
- **顺序保证的本质**：同一 aggregate_id 的事件按 created_at 顺序写入 outbox，binlog 顺序一致，CDC 推 Kafka 时按 aggregate_id 路由到同分区，单分区内严格有序。

**为什么不用 RocketMQ 事务消息**：
- RocketMQ 事务消息原理类似（半消息 + 本地事务 + 回查），但锁定 RocketMQ
- Outbox + CDC 是数据库无关、消息系统无关（Kafka/Pulsar/RabbitMQ 都行）
- Outbox 表可审计（事件历史留痕），事务消息不留痕

**Outbox 的代价**：
- outbox 表写入开销（业务事务多一次 INSERT）
- 表清理维护（不清理无限膨胀）
- CDC 运维（Debezium 集群）

## 七、AI 架构师加问：5 个

1. **LLM 推理事件用 Outbox 吗？**
   推理结果发事件用 Outbox 模式（保证推理完成 + 事件发布原子）。但 LLM 推理本身是"近似计算"，事件丢失影响小，可以接受 at-least-once + 幂等，不需要 Outbox 那么重。

2. **AI Agent 工作流事件用 Outbox？**
   Agent 多步工作流用 Temporal/Saga 内置的事件机制（workflow state + activity），不直接用 Outbox。Outbox 适合"单业务操作 + 事件通知"，Saga 适合"跨服务多步补偿"。

3. **LLM 怎么辅助 Outbox 治理？**
   LLM 读 outbox 表堆积情况 + CDC 健康度，识别异常（如某 aggregate 事件持续未发布、CDC offset 滞后），告警 + 推荐修复（重启 CDC、扩容）。

4. **AI 训练样本回流用 Outbox？**
   可以。业务事务里写 sample_outbox 表（样本数据），CDC 推到 Kafka，Flink 消费转训练样本格式写入数据湖。这样保证"业务数据 + 训练样本"一致。

5. **用 LLM 自动生成 Outbox schema？**
   LLM 读业务领域模型（DDD 聚合根、事件）→ 推荐 outbox 表结构 + event type 命名规范。但 schema 设计要人工 review（业务语义理解）。

## 八、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"业务事务写 outbox、CDC 监听推 Kafka、消费幂等去重"**。

- **Outbox 表**：业务事务原子写，存待发布事件
- **CDC（Debezium）**：监听 binlog，EventRouter Transform 转 Kafka 消息
- **消费幂等**：event_id 唯一索引去重，CDC 重投安全
- **顺序**：aggregate_id 路由同分区，单分区内按时间顺序
- **清理**：已发布事件定期归档/删除；Polling 兜底（CDC 挂了）

### 拟人化理解

把 Outbox 想成**邮局信箱**。你写信（业务操作）投到信箱（outbox 表）和"寄信"是同一次去邮局（一个事务，原子）——不会出现"信投了但没寄"或"寄了但没投"。CDC 是邮递员——定期开信箱取信分发，不阻塞你投信。如果邮递员病了（CDC 挂），信箱里信堆积但 DB 扛得住；邮递员恢复后从上次位置继续取（offset）。收信人按信件编号去重（幂等），同一收信人的信按时间顺序送达（顺序）。

### 面试现场 60 秒回答

> Outbox 模式解决"业务数据更新 + 事件发布"原子性。传统"先更 DB 后发消息"会因发消息失败丢事件，Outbox 把事件写进 outbox 表（和业务表同事务），本地事务保证原子——业务提交了 outbox 行一定在。CDC（Debezium）监听 outbox 表 binlog，用 EventRouter Transform 把行转 Kafka 消息推到 Kafka。消费端按 event_id 唯一索引去重，CDC 重启重投安全（at-least-once + 幂等）。顺序保证：aggregate_id 路由同分区，单分区内按 created_at 严格有序。outbox 表定期清理已发布事件（保留 7 天），避免无限膨胀。双保险：CDC 挂了用 Polling 兜底（定时扫未发布事件手动推 Kafka）。这套让我们订单事件零丢失，下游履约/营销/风控/BI 都能可靠收到。最大坑是 CDC offset 管理——Debezium 重启必须从上次 offset 继续，否则漏事件或重复。

### 反问面试官

> 贵司事件发布用 Outbox 还是 RocketMQ 事务消息？CDC 用 Debezium 还是 Canal？outbox 表多大？怎么清理？

## 九、苏格拉底式面试追问（7 层表格 + 现场对话）

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不用 RocketMQ 事务消息？ | 用解耦说话：RocketMQ 事务消息锁定 MQ，Outbox + CDC 是 DB/MQ 无关；Outbox 表可审计（事件历史），事务消息不留痕；Outbox 跨 MQ（Kafka/Pulsar）通用 |
| 证据追问 | 怎么证明 Outbox 真的零丢失？ | 注入测试：业务事务提交后立刻 kill Kafka，事件应在 outbox；恢复后 CDC 推 Kafka；消费端统计收到的 event_id 应 100% 覆盖 |
| 边界追问 | Outbox 能解决跨服务事务吗？ | 不能直接。Outbox 解决"单服务内事件可靠发布"。跨服务事务用 Saga（每步用 Outbox 发补偿事件）。两者互补 |
| 反例追问 | 什么场景不用 Outbox？ | 低一致性场景（埋点/监控，丢事件无所谓）、单服务无下游（不需要事件）、性能极致（outbox 多一次 INSERT） |
| 风险追问 | Outbox 上线最大风险？ | 主动点出：CDC 挂了 outbox 堆积（要监控）、消费端不幂等导致重复（必须 event_id 去重）、outbox 表膨胀（要清理）、CDC 配置错（binlog 格式必须是 ROW） |
| 验证追问 | 怎么验证 CDC 真的监听到 outbox？ | 测试：业务事务提交后看 Kafka topic 是否收到事件；查 Debezium metric（records-sent-count、offset）；kill Debezium 重启看是否从上次 offset 继续 |
| 沉淀追问 | 团队 Outbox 治理沉淀什么？ | Outbox 表 schema 模板、Debezium connector 配置模板、EventRouter 配置规范、消费端幂等 SDK、CDC 监控大盘（lag/throughput/offset） |

### 现场对话示例

**面试官**：CDC 挂了怎么办？outbox 表会无限膨胀吗？

**候选人**：CDC 挂了 outbox 表会堆积，但有兜底。第一，CDC 高可用——Debezium 用 Kafka Connect 集群部署，实例挂了 rebalance 到其他实例继续消费（offset 存 Kafka connect_offsets topic）。第二，监控——Debezium 的 records-sent-count metric 突然下降告警，第一时间发现。第三，Polling 兜底——业务系统定时扫 outbox 表未发布事件（published_at IS NULL），手动推 Kafka。这样即使 CDC 全挂，事件也不会丢（只是延迟）。outbox 表膨胀：定期清理已发布事件（published_at IS NOT NULL AND created_at < 7 天前），保留窗口够 CDC 重启恢复即可。京东实操：Debezium 3 副本，从未因 CDC 故障丢事件。

**面试官**：同一 aggregate 的多个事件怎么保证顺序？

**候选人**：三层保证。第一，outbox 表写入顺序——同一 aggregate 的事件按 created_at 顺序写入，binlog 顺序一致（单线程提交保证）。第二，CDC 推 Kafka 路由——Debezium EventRouter 按 aggregate_id hash 路由到同分区（如 hash(orderId) % partitions），同一 aggregate 永远在同一分区。第三，Kafka 单分区内严格有序——消费者单线程消费单分区，按 offset 顺序处理。这样同一 aggregate 的事件严格按时间顺序送达下游。跨 aggregate 无序（业务可接受，如订单 A 和订单 B 的事件顺序不重要）。

**面试官**：消费端怎么保证幂等？

**候选人**：event_id 唯一索引是核心。消费端处理事件前先查"是否已处理过这个 event_id"——查到就跳过。具体实现：(1) 消费端维护 event_log 表，event_id UNIQUE 约束；(2) 业务处理 + 写 event_log 在同一事务（保证"处理了就一定记录"）；(3) 并发场景下两个消费者同时处理同一 event_id，一个成功一个 DuplicateKeyException，捕获后跳过。这样 CDC 重投、Kafka 重试都安全。注意：event_id 必须是 UUID（全局唯一），不能用自增 ID（重启会变）。

## 常见考点

1. **Outbox 和 Saga 区别？**——Outbox 解决"单业务操作的事件可靠发布"（一次操作一个事件）；Saga 解决"跨服务长事务"（多步操作链式补偿）。Saga 每步用 Outbox 发补偿事件。
2. **Debezium 和 Canal 区别？**——Debezium 是开源 CDC 平台（基于 Kafka Connect），支持多种 DB，社区活跃；Canal 是阿里开源，专注 MySQL，国内生态强。两者原理相同（监听 binlog）。
3. **binlog 格式必须是 ROW 吗？**——是的。STATEMENT 格式记录 SQL 语句，CDC 解析复杂（如 NOW() 函数）；ROW 格式记录行变更，CDC 直接读。MIXED 不推荐。
4. **Outbox 表要建索引吗？**——要。aggregate_id 索引（查询同一 aggregate 历史）、created_at 索引（清理按时间）、published_at 索引（Polling 兜底查未发布）。
5. **Outbox 怎么做事务回滚？**——业务事务回滚时 outbox INSERT 也回滚（同事务），事件不会发布。这正是 Outbox 的原子性保证——业务失败事件不发。

## 结构化回答

**30 秒电梯演讲：** Outbox 模式解决业务数据更新 + 事件发布的原子性问题——传统模式（先更 DB 后发消息）会因发消息失败丢事件，Outbox 把事件和业务数据放同一事务写到一个 outbox 表，保证原子。CDC（Change Data Capture）异步监听 outbox 表变更（通过 binlog），把事件推到 Kafka。这样业务事务原子写 outbox + CDC 异步推 Kafka，实现可靠事件发布

**展开框架：**
1. **Outbox 表** — 和业务表同库，存待发布事件（id, aggregate_id, type, payload, status, created_at）
2. **CDC** — Debezium 监听 outbox 表 binlog，变更即推 Kafka
3. **幂等** — 消费端按 event_id 去重，CDC 重启可能重投

**收尾：** 以上是我的整体思路。您想继续深入聊——Outbox 表会无限膨胀吗？


## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：Outbox + CDC 如何保证事件可靠发布 | "这题核心是——Outbox 模式解决业务数据更新 + 事件发布的原子性问题——传统模式（先更 DB 后发消息）……" | 开场钩子 |
| 0:15 | 像寄信。Outbox 是邮局信箱——你写类比图 | "打个比方：像寄信。Outbox 是邮局信箱——你写。" | 核心类比 |
| 0:40 | Outbox 表示意/对比图 | "和业务表同库，存待发布事件（id, aggregate_id, type, payload, status, created_at）" | Outbox 表要点 |
| 1:05 | CDC示意/对比图 | "Debezium 监听 outbox 表 binlog，变更即推 Kafka" | CDC要点 |
| 1:30 | 幂等示意/对比图 | "消费端按 event_id 去重，CDC 重启可能重投" | 幂等要点 |
| 1:55 | 总结卡 | "记住：Outbox 表。下期见。" | 收尾 |
