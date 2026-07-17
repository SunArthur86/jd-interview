---
id: java-architect-034
difficulty: L2
category: java-architect
subcategory: 系统解耦
tags:
- Java 架构师
- EDA
- Outbox
- 解耦
feynman:
  essence: EDA（事件驱动架构）让服务间通过事件异步解耦，消费方按需订阅不阻塞主流程；Outbox 模式用"业务表 + 事件表同事务写入 + 独立 relayer 投递 MQ"解决"本地 DB 与 MQ 发送原子性"，是微服务可靠事件的事实标准。
  analogy: 像 JD 仓库发货：EDA 是"发货后通过广播通知各部门（营销、风控、履约）各自处理"，不再打电话逐个通知；Outbox 是"出库单和通知单一起写进同一本台账（同事务），仓管员专门负责把通知单抄送给各部门（relayer）"，避免出库了但通知忘发。
  first_principle: 微服务间 RPC 同步调用会形成强耦合（调用方等待、故障扩散、性能瓶颈）。EDA 把"调用"变成"发布事件 + 订阅"，消费方自治。但"DB 提交"与"事件发布"无原生事务，Outbox 把事件作为业务事务的一部分写入事件表（同事务），独立 relayer 异步投递 MQ，保证"DB 提交则事件必发"。
  key_points:
  - EDA 三要素：事件（fact，已发生）、生产者（发布）、消费者（订阅）
  - 事件类型：事件通知（轻量）、事件携带状态转移（携带数据）、事件溯源（事件即状态）
  - Outbox 表与业务表同事务写入，relayer 独立扫描投递 MQ
  - relayer 必须保证 at-least-once + 消费端幂等（双保险）
  - 事件 schema 演进要兼容（version 字段 + forward/backward 兼容）
first_principle:
  problem: 微服务间如何在不强耦合、不阻塞、故障不扩散的前提下协同？
  axioms:
  - 同步 RPC 形成调用图（A→B→C），任一节点故障扩散到全链路
  - 服务自治要求"我变了通知你们，怎么反应你们自己定"
  - DB 本地事务和 MQ 发送是两个独立系统，无原生原子
  rebuild: EDA 让生产者只负责"发布事件"（已发生的业务事实），不关心谁订阅、怎么反应。消费方按需订阅，自治处理。解耦的关键是"事件是 fact（过去时），不是 command（祈使）"。Outbox 解决可靠投递——业务事务内同事务写业务表+事件表，独立 relayer 扫事件表投递 MQ，保证 DB 提交则事件必发；消费端 at-least-once + 业务幂等处理重复。
follow_up:
  - 事件和命令（command）区别？——事件是"已发生的事实"（过去时，OrderPlaced），命令是"请求对方做事"（祈使，PlaceOrder）。事件不可拒绝，命令可拒绝。EDA 用事件解耦
  - Outbox 和事务消息区别？——事务消息是 MQ 厂商特性（RocketMQ），半消息+回查；Outbox 是设计模式，MQ 无关。Outbox 更通用，事务消息更高效
  - Outbox 表会膨胀怎么办？——已投递的事件定期归档/删除（保留 7-30 天）。relayer 用 in-flight 状态 + 时间窗口避免误删
  - 事件 schema 演进怎么办？——version 字段、forward/backward 兼容（新消费者读旧事件、旧消费者读新事件）、必要时做事件版本转换层
  - 一个事件被多个消费者订阅，重复消费吗？——每个消费组独立 offset，互不影响。Outbox 只投递一次 MQ，MQ 自己做 fan-out
memory_points:
  - EDA：事件是 fact（已发生），不是 command（祈使）
  - Outbox：业务表 + 事件表同事务写，独立 relayer 投递 MQ
  - relayer 保证 at-least-once，消费端业务幂等
  - 事件命名用过去时（OrderPlaced, PaymentConfirmed）
  - 事件 schema 必须版本兼容（version 字段 + forward/backward）
---

# 【Java 后端架构师】事件驱动架构与 Outbox 模式

> 适用场景：JD 核心技术。下单触发营销/风控/履约/积分、库存变更触发搜索索引更新、用户注册触发发券/通知——这些场景架构师必须能用 EDA + Outbox 画出完整的事件发布订阅链路，并解释为什么 Outbox 是微服务可靠事件的事实标准。

## 一、概念层：事件 vs 命令 vs 事件溯源

**三个容易混淆的概念**（面试常被问）：

| 类型 | 含义 | 命名 | 谁主导 |
|------|------|------|--------|
| **命令（Command）** | 请求对方做某事，可拒绝 | PlaceOrder / ConfirmPayment | 调用方意图 |
| **事件（Event）** | 已发生的事实，不可拒绝 | OrderPlaced / PaymentConfirmed | 生产者宣告 |
| **事件溯源（Event Sourcing）** | 事件即状态，状态是事件回放结果 | 事件 store 是唯一真相 | 极少数场景 |

**EDA 的核心抽象**：

```
生产者服务 A                事件总线（MQ）              消费者服务 B/C/D
┌──────────┐              ┌──────────────┐            ┌──────────┐
│ 业务逻辑  │ ──publish──> │  Topic:       │ <─subscribe│ 营销服务  │
│          │   OrderPlaced│  order_events │            │ 风控服务  │
└──────────┘              │              │            │ 履约服务  │
   A 不关心                 └──────────────┘            └──────────┘
   谁订阅、                  MQ 做 fan-out                各自决定
   怎么反应                                               怎么处理
```

**EDA vs 同步 RPC 对比**：

| 维度 | 同步 RPC | EDA |
|------|---------|-----|
| 耦合 | 强（调用方知道服务地址） | 弱（只知 topic） |
| 阻塞 | 是（等待响应） | 否（发布即返回） |
| 故障扩散 | 是（级联失败） | 否（消费方故障不影响生产者） |
| 扩展新消费方 | 改调用方代码 | 订阅 topic 即可 |
| 一致性 | 强一致（实时） | 最终一致（毫秒到秒级延迟） |
| 复杂度 | 简单 | 高（需处理重复、乱序、schema） |

## 二、机制层：Outbox 模式完整设计

**核心问题**：业务事务（写订单）和事件发布（发 MQ）必须原子，但两者无原生事务。

**Outbox 方案**：

```
┌─────────────────────────────────────────────────────────┐
│ 服务 A（生产者）                                          │
│                                                          │
│  ┌─────────────────────────────────────────────────┐    │
│  │ 本地数据库事务                                     │    │
│  │                                                   │    │
│  │  INSERT INTO orders(...)        # 业务表           │    │
│  │  INSERT INTO outbox_events(...) # 事件表（同事务） │    │
│  │  COMMIT                                           │    │
│  └─────────────────────────────────────────────────┘    │
│                          │                               │
│  ┌───────────────────────▼──────────────────────┐       │
│  │ OutboxRelayer（独立进程/线程）                  │       │
│  │                                                 │       │
│  │  while true:                                    │       │
│  │    events = SELECT * FROM outbox_events         │       │
│  │             WHERE status='PENDING' LIMIT 100    │       │
│  │    for e in events:                             │       │
│  │      mqProducer.send(e.topic, e.payload)        │       │
│  │      UPDATE outbox_events SET status='SENT'     │       │
│  │      WHERE id=e.id AND status='PENDING'         │       │
│  └─────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
                    MQ Topic
                          │
                          ▼
                   消费者服务（幂等消费）
```

**Outbox 表 schema**：

```sql
CREATE TABLE outbox_events (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    aggregate_id VARCHAR(64) NOT NULL,    -- 聚合根 ID（如 order_id）
    aggregate_type VARCHAR(32) NOT NULL,  -- 聚合类型（Order）
    event_type VARCHAR(64) NOT NULL,      -- 事件类型（OrderPlaced）
    topic VARCHAR(128) NOT NULL,          -- 投递的 topic
    payload TEXT NOT NULL,                -- 事件 JSON
    headers TEXT,                         -- 头信息（traceId、version 等）
    status VARCHAR(16) DEFAULT 'PENDING', -- PENDING / SENT
    created_at TIMESTAMP DEFAULT NOW(),
    sent_at TIMESTAMP NULL,

    INDEX idx_status_created (status, created_at),   -- relayer 扫描索引
    INDEX idx_aggregate (aggregate_type, aggregate_id)
);
```

**生产端代码（业务事务 + Outbox 写入）**：

```java
@Service
public class OrderService {

    @Resource OrderRepository orderRepo;
    @Resource JdbcTemplate jdbc;
    @Resource ApplicationContext applicationContext;

    @Transactional   // 关键：业务表 + outbox 表同事务
    public Order placeOrder(OrderDTO dto) {
        Order order = orderRepo.save(new Order(dto));   // 业务表

        OrderPlacedEvent event = new OrderPlacedEvent(
            order.getId(), order.getUserId(), order.getAmount(), "1.0");
        saveOutbox(event);   // outbox 表（同事务）
        // 注意：不在这里 send MQ！交给 relayer 异步投递

        return order;
    }

    private void saveOutbox(DomainEvent e) {
        jdbc.update(
            "INSERT INTO outbox_events(aggregate_id, aggregate_type, event_type, " +
            "topic, payload, headers, status) VALUES(?, ?, ?, ?, ?, ?, 'PENDING')",
            e.getAggregateId(), e.getAggregateType(), e.getEventType(),
            e.getTopic(), JSON.toJSONString(e),
            JSON.toJSONString(e.getHeaders()));
    }
}
```

**OutboxRelayer 代码**：

```java
@Component
public class OutboxRelayer {

    @Resource JdbcTemplate jdbc;
    @Resource DefaultMQProducer producer;

    @Scheduled(fixedDelay = 200)   // 每 200ms 扫一次
    public void relay() {
        List<OutboxEvent> events = jdbc.query(
            "SELECT * FROM outbox_events WHERE status='PENDING' " +
            "ORDER BY id ASC LIMIT 100",
            outboxRowMapper);

        for (OutboxEvent e : events) {
            try {
                Message msg = new Message(e.getTopic(), e.getPayload().getBytes());
                msg.putUserProperty("eventId", String.valueOf(e.getId()));
                msg.putUserProperty("eventType", e.getEventType());
                producer.send(msg);

                // 关键：用 UPDATE WHERE status='PENDING' 保证幂等
                // 多 relayer 实例并发时，只有一个能更新成功
                int rows = jdbc.update(
                    "UPDATE outbox_events SET status='SENT', sent_at=NOW() " +
                    "WHERE id=? AND status='PENDING'",
                    e.getId());
                // rows=0 说明被其他 relayer 抢走了，跳过

            } catch (Exception ex) {
                log.warn("Relay failed for event {}: {}", e.getId(), ex.getMessage());
                // 不更新状态，下次重试（at-least-once）
            }
        }
    }
}
```

## 三、实战层：多 relayer 并发与去重

**问题**：relayer 单点会故障，要多实例并发；但多实例可能同时投递同一事件。

**解决方案**（三选一）：

```
方案 1：乐观锁抢占（推荐）
  UPDATE outbox SET status='PROCESSING' WHERE id=? AND status='PENDING'
  影响行数 1 才处理，0 说明被抢占。处理完改 SENT。

方案 2：分片处理
  relayer 实例 N 个，按 id % N 分片，每个 relayer 只扫自己分片
  避免竞争但要维护分片分配（一致性 hash 或协调器）

方案 3：SELECT FOR UPDATE SKIP LOCKED
  SELECT * FROM outbox WHERE status='PENDING'
  ORDER BY id ASC LIMIT 100 FOR UPDATE SKIP LOCKED
  MySQL 8.0+ / PostgreSQL 支持，行级锁不阻塞
```

**消费端幂等**（必须，因为 relayer 可能重投）：

```java
@RocketMQMessageListener(topic = "order_events", consumerGroup = "marketing_group")
public class OrderEventListener implements RocketMQListener<MessageExt> {

    @Override
    public void onMessage(MessageExt msg) {
        String eventId = msg.getUserProperty("eventId");
        // 用 eventId 做幂等键（DB 唯一索引或 Redis 令牌）
        if (!idempotentGuard.tryAcquire(eventId)) {
            return;   // 已处理过，跳过
        }
        OrderPlacedEvent event = JSON.parseObject(msg.getBody(), OrderPlacedEvent.class);
        marketingService.sendCoupon(event.getUserId());
    }
}
```

## 四、实战层：事件 schema 演进

**事件 schema 是契约**，消费方依赖它。schema 变更要兼容。

**兼容性策略**：

| 类型 | 含义 | 例子 |
|------|------|------|
| **Backward** | 新消费者能读旧事件 | 新增字段必须有默认值 |
| **Forward** | 旧消费者能读新事件 | 删除字段必须先停所有旧消费者 |
| **Full** | 双向兼容 | 推荐 |

**演进代码示例**：

```java
public class OrderPlacedEvent {
    private String eventId;
    private String aggregateId;     // order_id
    private String eventType = "OrderPlaced";
    private String version = "2.0"; // 版本号

    // v1.0 字段
    private Long userId;
    private BigDecimal amount;

    // v2.0 新增字段（带默认值，backward 兼容）
    private String currency = "CNY";
    private List<String> skuList = Collections.emptyList();   // v2 新增

    // v1.0 删除字段（forward 不兼容，必须谨慎）
    // private String legacyField;  // v2 删除
}
```

**schema registry**（生产级推荐）：

- 用 Confluent Schema Registry 或自建 schema 仓库
- 生产时注册 schema，校验兼容性（backward）
- 消费时按 schema 反序列化
- 不兼容变更要新建 topic（order_events_v3）

## 五、实战层：Outbox vs 事务消息 vs 本地扫表

| 方案 | 原理 | 优势 | 劣势 |
|------|------|------|------|
| **Outbox** | 业务表+事件表同事务，独立 relayer 投递 | MQ 无关、解耦、可审计 | 多一张表、relayer 维护 |
| **事务消息** | RocketMQ 半消息+回查 | 省表、实时 | 强绑 RocketMQ |
| **本地消息表+扫表** | 定时扫业务表生成事件 | 简单 | 业务表耦合、扫表慢 |
| **CDC（Debezium）** | 监听 DB binlog 生成事件 | 业务零侵入 | binlog 解析复杂、事件语义弱 |

**JD 实际选型**：金融/订单核心链路用 Outbox（审计要求、MQ 解耦）；轻量场景用 CDC（Debezium 监听 MySQL binlog 推 Kafka）；强一致场景用 RocketMQ 事务消息。

## 六、底层本质：为什么是事件 + Outbox

回到第一性：**服务自治和可靠协同是微服务架构的两个核心诉求**。

**为什么 EDA 优于同步 RPC**：同步 RPC 形成"调用图"，A 调 B、B 调 C，任一节点故障扩散到全链路（雪崩）。EDA 把"调用"变成"发布事件 + 订阅"，生产者不依赖消费者，消费者自治。新增消费方（如新增营销规则）只需订阅 topic，不改生产者代码——这是开闭原则在分布式系统的体现。

**为什么事件是 fact 而非 command**：事件是"已发生的事实"（OrderPlaced），不可拒绝、不需响应。command 是"请求对方做事"（PlaceOrder），可拒绝、需响应。用事件解耦的关键是生产者只宣告事实，不指挥消费者——这样消费方可以自由决定如何反应（发券、风控、履约各自自治）。如果用 command，生产者必须知道消费者的能力，耦合就回来了。

**为什么 Outbox 是事实标准**：业务事务和 MQ 发送无原生原子，必须用"同事务写表 + 异步投递"绕开。Outbox 的精妙在于把"可靠投递"转化为"本地事务一致性 + at-least-once 投递 + 消费端幂等"三个简单问题的组合。每个子问题都有成熟解（DB ACID、MQ 重试、业务幂等），组合起来比 XA 事务简单可靠。CDC（binlog 监听）是 Outbox 的演进——用 binlog 替代 outbox 表，业务零侵入，但事件语义弱（binlog 是数据变更，不是业务事件）。

**这套设计的代价**：最终一致而非强一致（延迟毫秒到秒级）、事件 schema 演进复杂、调试链路长（traceId 必须透传）、消费端幂等是硬性要求。

## 七、AI 架构师加问：5 个 AI 相关问题

1. **AI RAG 知识库更新用 EDA + Outbox 怎么设计？**
   业务库变更（文档更新）→ Outbox 写事件 → relayer 投递 Kafka → 消费端做 embedding → 写向量库（Milvus）。doc_id 做幂等键，version 做乱序丢弃。监控 outbox_backlog 和 embedding_lag。

2. **AI Agent 多步编排如何用事件解耦？**
   每个 step 发布 StepCompleted 事件，下一步订阅上一步的事件。Outbox 保证 step 状态变更与事件发布原子。Agent 重启后从事件 store 重放恢复状态（事件溯源的轻量版）。

3. **让 AI 自动发现事件 schema 不兼容，AI 接管哪段？**
   AI 对比生产者和消费者的 schema 版本、扫描消费端的反序列化失败日志、识别 breaking change（删字段、改类型）。AI 出治理建议（生产者回滚 schema、消费者升级、新建 topic），人工 review。

4. **AI 推理结果如何用事件流式推送给前端？**
   EDA 不适合流式推送（事件是离散 fact）。流式用 SSE/WebSocket 直推。EDA 适合推理结果的审计、异步通知、批量分析场景。

5. **AI 工具调用链如何用 Outbox 保证幂等？**
   每个 tool_call 写入 outbox（带 request_id），relayer 投递到工具执行服务。工具服务用 request_id 幂等（重复 request_id 返回上次结果）。失败重试由 relayer 保证 at-least-once。

## 八、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"事件是 fact、Outbox 同事务、relayer at-least-once、消费幂等、schema 兼容"**。

- **EDA**：发布订阅解耦，事件命名用过去时（OrderPlaced）
- **Outbox**：业务表 + outbox_events 同事务写，独立 relayer 投递 MQ
- **可靠性**：relayer at-least-once + 消费端业务幂等（eventId 唯一）
- **并发**：乐观锁抢占（UPDATE WHERE status='PENDING'）或分片或 SKIP LOCKED
- **schema**：version 字段 + backward/forward 兼容，breaking change 新建 topic

### 拟人化理解

把 EDA 想成 **JD 仓库广播系统**。仓库发货（生产者发布事件）后通过广播通知各部门（消费者订阅）：营销发券、风控审计、履约配送。仓库不关心谁在听、怎么反应，只管广播"货已发"。Outbox 是"出库单和广播稿一起写进同一本台账"（同事务），专门的广播员（relayer）按台账发广播——台账写了就必发，广播员挂了换一个继续发。消费端各部门凭通知单号（eventId）只处理一次，重复通知幂等忽略。

### 面试现场 60 秒回答

> EDA 用发布订阅解耦微服务：生产者只宣告已发生的事实（OrderPlaced，过去时命名），消费者按需订阅自治处理。可靠投递用 Outbox 模式——业务表 + outbox_events 同事务写入（保证 DB 提交则事件必存），独立 relayer 扫事件表投递 MQ（at-least-once），消费端用 eventId 做业务幂等。多 relayer 并发用乐观锁抢占（UPDATE WHERE status='PENDING'）或 SKIP LOCKED。事件 schema 要版本兼容（version 字段 + backward），breaking change 新建 topic。选型：RocketMQ 用事务消息省表，多 MQ 用 Outbox 解耦。

### 反问面试官

> 贵司的事件驱动是 RPC + 事件混合还是纯 EDA？事件投递用 Outbox 还是事务消息还是 CDC？这决定我用哪套方案。

## 九、苏格拉底式面试追问

每一问先回答"为什么"，再"怎么做"，最后"如何证明"。

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不直接 RPC 调用，要搞 EDA？ | RPC 强耦合（调用方等响应）、故障扩散（雪崩）、扩展新消费方要改调用方。EDA 解耦，新增消费方订阅即口。证明：下单场景从 2 个下游扩到 6 个，EDA 不改生产者，RPC 要改 4 次 |
| 证据追问 | 怎么证明 Outbox 事件真的投递了？ | outbox_events 表统计 PENDING/SENT 数（SENT 应 100%）、监控 outbox_backlog（PENDING 积压量）、消费端 eventId 唯一索引统计重复率、对账业务表变更数与事件数 |
| 边界追问 | Outbox 能保证消费端 exactly-once 吗？ | 不能。relayer 是 at-least-once（崩溃重投），消费端必须业务幂等。eventId 唯一索引是兜底，Redis 令牌前置拦 99%。跨系统 exactly-once 不存在 |
| 反例追问 | 什么场景不用 EDA？ | 强一致实时场景（资金扣款、库存校验）、低延迟同步场景（< 100ms）、简单单体应用。EDA 是最终一致，强一致场景必须 RPC + 事务 |
| 风险追问 | Outbox 表膨胀最大风险？ | 表无限膨胀拖垮 DB（扫描慢、索引大）、relayer 扫表慢导致事件延迟。治法：SENT 事件定期归档/删除（保留 7-30 天）、PENDING 超时告警、分表分库 |
| 验证追问 | 怎么证明事件 schema 演进没破坏消费者？ | schema registry 强制兼容校验、消费端反序列化失败率监控、灰度发布新 schema（先新消费者上线、再生产者切换）、回滚预案（旧 schema 可恢复） |
| 沉淀追问 | 团队 EDA 规范沉淀什么？ | 事件命名规范（过去时）、Outbox 表标准 schema、relayer 标准实现、消费端幂等模板、schema registry 接入流程、outbox_backlog 和 event_latency 告警阈值 |

### 现场对话示例

**面试官**：Outbox 模式怎么保证事件不丢？

**候选人**：三层保证。第一层，业务表和 outbox_events 同事务写入，DB ACID 保证要么都成功要么都回滚——DB 提交则事件必存表。第二层，relayer 独立扫描 outbox 表投递 MQ，at-least-once（崩溃重启会重扫重投）。第三层，relayer 用 UPDATE WHERE status='PENDING' 抢占，多 relayer 并发只有一个能投递成功，避免重复（虽然 at-least-once 还是可能重复，但靠消费端幂等兜底）。事件真正丢失的唯一可能是 DB 整体故障（含主备），所以要主从复制 + 定期备份。

**面试官**：事件被多个消费者订阅，Outbox 要投递多次吗？

**候选人**：不用。Outbox 只投递一次 MQ（一次 send），MQ 自己做 fan-out 到多个消费组。每个消费组独立 offset、独立消费、互不影响。Outbox 关心的是"事件到 MQ"，到 MQ 之后怎么分发是 MQ 的事。所以一个 OrderPlaced 事件，营销、风控、履约三个消费组各自订阅消费，Outbox 只投一次。

**面试官**：事件 schema 要新增字段怎么办？

**候选人**：用 backward 兼容策略。新增字段必须有默认值（如 currency = "CNY"），这样新消费者能读旧事件（旧事件没这字段用默认值）。不能直接删除字段（forward 不兼容，旧消费者反序列化失败）。删除字段要分两步：先停所有旧消费者、再删。Breaking change（改字段类型、改语义）要新建 topic（order_events_v2），消费方逐步迁移。生产级用 schema registry 强制校验兼容性。

## 常见考点

1. **事件和命令区别？**——事件是已发生事实（过去时 OrderPlaced，不可拒绝），命令是请求对方做事（祈使 PlaceOrder，可拒绝）。EDA 用事件解耦。
2. **Outbox 和事务消息区别？**——Outbox 是设计模式（业务表+事件表同事务+relayer），MQ 无关；事务消息是 RocketMQ 特性（半消息+回查），强绑 MQ。Outbox 更通用。
3. **Outbox 表怎么避免膨胀？**——SENT 事件定期归档/删除（保留 7-30 天）、PENDING 超时告警、分表分库。relayer 用时间窗口避免误删未投递事件。
4. **多 relayer 并发怎么办？**——乐观锁抢占（UPDATE WHERE status='PENDING' 影响行数 0 即被抢占）、分片（按 id % N）、SELECT FOR UPDATE SKIP LOCKED。
5. **事件 schema 演进怎么做？**——version 字段 + backward/forward 兼容、新增字段带默认值、breaking change 新建 topic、schema registry 强制校验。


## 结构化回答

**30 秒电梯演讲：** 聊到事件驱动架构与 Outbox 模式，我的理解是——EDA（事件驱动架构）让服务间通过事件异步解耦，消费方按需订阅不阻塞主流程；Outbox 模式用"业务表 + 事件表同事务写入 + 独立 relayer 投递 MQ"解决"本地 DB 与 MQ 发送原子性"，是微服务可靠事件的事实标准。打个比方，像 JD 仓库发货：EDA 是"发货后通过广播通知各部门（营销、风控、履约）各自处理"，不再打电话逐个通知；Outbox 是"出库单和通知单一起写进同一本台账（同事务），仓管员专门负责把通知单抄送给各部门（relayer）"，避免出库了但通知忘发。

**展开框架：**
1. **EDA 三要素** — 事件（fact，已发生）、生产者（发布）、消费者（订阅）
2. **事件类型** — 事件通知（轻量）、事件携带状态转移（携带数据）、事件溯源（事件即状态）
3. **Outbox 表与业务表同事务写入** — Outbox 表与业务表同事务写入，relayer 独立扫描投递 MQ

**收尾：** 这块我在项目里也踩过坑——想深入的话，可以接着聊：事件和命令（command）区别？您更想看哪个方向？

## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡 | "事件驱动架构与 Outbox 模式——这道题面试官到底想考什么？我用 30 秒给你讲透。" | 开场钩子 |
| 0:15 | 概念结构示意图 | 先说核心：EDA（事件驱动架构）让服务间通过事件异步解耦，消费方按需订阅不阻塞主流程；Outbox 模式用"业务表 + 事件表同事务写入 + 独立 relayer 投递 MQ"解决"本地。 | 核心定义 |
| 0:30 | 流程图 | 事件通知（轻量）、事件携带状态转移（携带数据）、事件溯源（事件即状态）。 | 事件类型 |
| 1:30 | 总结卡 | 一句话记忆：EDA：事件是 fact（已发生），不是 command（祈使）。 下期可以接着聊：事件和命令（command）区别。 | 收尾总结 |
