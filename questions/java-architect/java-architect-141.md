---
id: java-architect-141
difficulty: L3
category: java-architect
subcategory: 系统解耦
title: Debezium 在 Java 数据同步中的应用
tags: [Debezium, CDC, 数据同步, Binlog, Kafka Connect]
related: [java-architect-140, java-architect-142, java-architect-137]
---

# Debezium 在 Java 数据同步中的应用

> **场景**：京东订单库分库分表后，搜索平台（ES）、风控实时画像、数据中台三套系统都要订单数据。如果用定时任务抽数，秒级延迟和数据库压力无法承受。面试官问：用 Debezium 怎么做？架构怎么落地？

## 一、概念层：Debezium 到底解决了什么

### 1.1 一句话定位

**Debezium = 基于数据库日志的变更数据捕获（CDC）平台，把"数据库每一次变更"转化为 Kafka 上的有序事件流。**

### 1.2 为什么不用轮询 / 双写

| 方案 | 延迟 | DB压力 | 一致性 | 适用 |
|------|------|--------|--------|------|
| 定时全量/增量轮询 | 分钟级 | 高（扫表） | 中（漏更新） | 对账/离线 |
| 业务双写 | 毫秒 | 低 | 差（分布式事务难） | 简单场景 |
| 触发器 + 日志表 | 秒级 | 高（写放大） | 高 | 历史遗留 |
| **Debezium/CDC** | **亚秒** | **低（读binlog）** | **高（事务边界）** | **主流** |

### 1.3 核心抽象

```
MySQL (binlog) ─┐
PostgreSQL (WAL)─┤→ Debezium Source Connector ─→ Kafka Topic ─→ Consumer(ES/Redis/Hudi)
MongoDB (oplog)─┘     (Kafka Connect Worker)        (按表分分区)
```

每个变更事件（`SourceRecord`）三段式结构：
- `source`：来自哪个 server/db/table、binlog position、GTID、ts_ms
- `before` / `after`：变更前后的行快照（可选）
- `op`：`c`(create) / `u`(update) / `d`(delete) / `r`(snapshot read)

## 二、机制层：Debezium 怎么工作

### 2.1 MySQL Connector 工作机理

```
1. 连接 MySQL，FLUSH TABLES WITH READ LOCK（仅初次snapshot）
2. 读取当前 binlog position (file + position)
3. 释放锁，事务一致性快照（SELECT ... LOCK IN SHARE MODE 分块）
4. 切换到 streaming：伪装成 MySQL slave，订阅 binlog
5. 持续解析 ROW 模式 binlog，产出 change event
```

关键参数：
- `snapshot.mode=schema_only_recovery`：不重新全量，仅补 schema
- `snapshot.locking.mode=minimal`：减小锁粒度（≥MySQL 5.7）
- `database.hostname` + `database.server.id`：必须全局唯一（否则主从冲突）
- `binlog_format=ROW` + `binlog_row_image=FULL`：必须，否则 before 为空

### 2.2 Schema Registry 与 Schema Evolution

数据库加字段（如 `ADD COLUMN risk_level TINYINT`），下游消费者老 schema 反序列化会失败。解决：

```yaml
# Confluent Schema Registry + Avro
value.converter: io.confluent.connect.avro.AvroConverter
value.converter.schema.registry.url: http://schema-registry:8081
value.converter.enhanced.avro.schema.support: true

# BACKWARD 兼容：新 schema 能读老数据（加字段必须 default）
schema.compatibility: BACKWARD
```

JD 实践：DDL 上线前用 `avro-tools compile` 校验兼容性，不通过则在 outbox 侧加 default 值。

### 2.3 Exactly-Once 与位点管理

Debezium 不靠外部存储位点，依赖 Kafka Connect 的 `offset.storage.topic`（内部 Compact topic）：

```
key:   [connector名称, task id, partition]
value: {binlog file, position, GTID, snapshot flag}
```

- Worker 重启 → 从 connect-offsets 恢复 → 从上次位点继续读 binlog
- 结合 Sink 端 Kafka EOS（`isolation.level=read_committed`）→ 端到端 at-least-once，业务侧用 event_id 幂等

## 三、实战层：从 Connector 到 Java 消费者

### 3.1 MySQL Connector 配置（REST 注册）

```bash
curl -X POST http://connect:8083/connectors \
  -H "Content-Type: application/json" -d '{
  "name": "mysql-order-connector",
  "config": {
    "connector.class": "io.debezium.connector.mysql.MySqlConnector",
    "database.hostname": "order-mysql.jd.local",
    "database.port": "3306",
    "database.user": "debezium",
    "database.password": "********",
    "database.server.id": "184054",
    "database.allowPublicKeyRetrieval": "true",
    "database.server.name": "order-db",
    "database.include.list": "trade_order",
    "table.include.list": "trade_order.t_order,trade_order.t_order_item",
    "database.history.kafka.bootstrap.servers": "kafka:9092",
    "database.history.kafka.topic": "schema-changes.order",
    "snapshot.mode": "initial",
    "snapshot.locking.mode": "minimal",
    "tombstones.on.delete": "true",
    "transforms": "unwrap",
    "transforms.unwrap.type": "io.debezium.transforms.ExtractNewRecordState",
    "transforms.unwrap.drop.tombstones": "false",
    "transforms.unwrap.delete.handling.mode": "rewrite",
    "max.batch.size": "2048",
    "max.queue.size": "16384",
    "heartbeat.interval.ms": "5000"
  }
}'
```

- `transforms=unwrap`：把 Debezium envelope 扁平化为 `{id, ...fields, __op, __deleted}`，下游消费更轻量
- `heartbeat.interval.ms`：低流量时定期写入，防止 binlog 位点过期（`binlog_expire_logs_seconds`）

### 3.2 Java 消费者（写 ES + Redis 双写）

```java
@Component
@RequiredArgsConstructor
@Slf4j
public class OrderCdcConsumer {
    private final RestHighLevelClient esClient;
    private final StringRedisTemplate redis;
    private final OrderIdempotentRepository idemRepo; // event_id 去重

    @KafkaListener(
        topics = "order-db.trade_order.t_order",
        groupId = "sync-to-es-redis",
        containerFactory = "kafkaListenerContainerFactory"
    )
    public void onMessage(ConsumerRecord<String, String> record,
                          Acknowledgment ack) throws IOException {
        JsonObject payload = JsonParser.parseString(record.value()).getAsJsonObject();
        String orderId = payload.get("order_id").getAsString();
        String op = payload.has("__deleted") && payload.get("__deleted").getAsBoolean() ? "d" 
                  : payload.get("__op").getAsString();
        String eventId = record.topic() + ":" + record.partition() + ":" + record.offset();

        // 幂等：基于 topic-partition-offset
        if (!idemRepo.tryInsert(eventId)) { ack.acknowledge(); return; }

        switch (op) {
            case "d":
                esClient.delete(DeleteRequest.of(d -> d.index("orders").id(orderId)));
                redis.delete("order:" + orderId);
                break;
            case "c": case "u": case "r":
                Map<String, Object> doc = flatten(payload, "__op", "__deleted", "before");
                esClient.index(IndexRequest.of(i -> i.index("orders").id(orderId).document(doc)));
                redis.opsForValue().set("order:" + orderId, record.value(),
                    Duration.ofMinutes(30));
                break;
        }
        ack.acknowledge(); // 手动提交位点，确保 at-least-once
    }
}
```

注意：Debezium 是 **at-least-once**，下游必须幂等。最稳的去重 key = `topic-partition-offset`（全局唯一）。

### 3.3 监控与反压

Debezium 暴露 JMX 指标：
- `source.binlog-filename / binlog-position`：消费进度（对比 `SHOW MASTER STATUS`）
- `source.binlog-queue-size`：内存队列堆积（默认 max.queue=8192，堆积说明下游慢）
- `MiNRowFetchTimeMs`：拉取行耗时

Prometheus JMX Exporter 配置后接入 Grafana，阈值：queue 占用 > 70% 触发告警。

### 3.4 选型对比

| 维度 | Debezium | Canal | Maxwell |
|------|----------|-------|---------|
| 部署 | Kafka Connect（HA自动failover） | Server+Client 两段 | 单进程 |
| 多DB支持 | MySQL/PG/Mongo/Oracle/SQLServer | 仅 MySQL | 仅 MySQL |
| Schema Registry | ✅ Avro/Protobuf | ❌ | ❌ |
| DDL同步 | ✅ history topic | ✅ | 部分 |
| 社区活跃 | 极高（Red Hat主导） | 高（阿里） | 中 |
| JD选用 | ✅ 大部分中台 | 订单/商品遗留 | 早期小工具 |

## 四、底层本质：为什么 CDC 比双写省事

### 4.1 First Principle：把"数据写入"和"数据分发"解耦

业务代码只写主库 → 单机事务保证 ACID。CDC 在数据库"事后"读取日志，**不参与业务事务，但保证事务边界完整**（一个事务的多个事件要么全发，要么全不发）。

这是 **CQRS + Event Sourcing 的轻量落地**：写模型 = 主库表，读模型 = ES/Redis/数仓，CDC 是事件总线。

### 4.2 为什么 binlog ROW 模式才能做 CDC

- STATEMENT 模式：只记录 SQL，`UPDATE t SET x=x+1` 反解不出 before/after
- ROW 模式：记录每行变化（before+after 二进制），是真正的"事件流"
- MIXED：不可靠

这是 MySQL 8 默认 `binlog_format=ROW` 的原因。

### 4.3 Feynman 解释

把数据库想成一本"账本"。双写是"每次记账都在三本账本上各记一遍"，容易记错。CDC 是"派一个抄写员专门盯着账本的补遗页（binlog），抄一份给搜索、风控、数仓"。抄写员不参与记账，所以业务无感；但他抄得快（毫秒级）且完整（事务边界保留）。

## 五、AI 架构师加问

**Q1：Debezium Connector 挂了重启，会丢数据吗？**
不会。Connector 的 binlog position 存在 Kafka Connect 的 `offset.storage.topic`，重启从上次位点继续读。前提：MySQL binlog 未被 `binlog_expire_logs_seconds` 清理（默认 7 天，超长故障要扩容）。

**Q2：MySQL 主从切换时 Debezium 怎么办？**
开启 GTID 模式（`gtid_mode=ON`），Debezium 用 GTID 而非 file+position 定位，主从切换自动续接。配置 `gtid.source.filter.dml.events` 过滤循环复制。

**Q3：单表千万级全量 snapshot 时下游能扛住吗？**
分批 snapshot（`snapshot.fetch.size=2048`）+ 下游消费端批量写 ES（`bulk`）。极端情况用 `snapshot.mode=schema_only_recovery` 跳过全量，仅走增量。

**Q4：Schema 变更（加列）会让消费者挂吗？**
不会，只要：
1. 加列必须有 DEFAULT（Avro BACKWARD 兼容）
2. 老消费者忽略未知字段（Jackson `FAIL_ON_UNKNOWN_PROPERTIES=false`，Avro 自动处理）
3. 删列/改类型属于 BREAKING，必须先升消费者再 DDL

**Q5：如果下游 ES 写入失败，如何不阻塞 binlog 消费？**
三种模式：
- **死信队列**：失败事件写 `connect-errors` topic，主流程继续
- **重试 + 跳过**：Spring Retry 3 次后写 DLQ
- **停 connector**：强一致场景下宁可阻塞也不丢，依赖告警人工介入

## 六、记忆口诀

```
CDC 三件事：读日志、转事件、保位点。
ROW 模式是前提，GTID 抗主从切换。
Schema 注册 Avro，BACKWARD 加默认值。
消费幂等 offset-key，DLQ 兜底不阻塞。
JD 中台三套库，搜索风控和数仓，
全靠 Debezium + Kafka Connect 一条管道打天下。
```

## 七、苏格拉底追问

| 层级 | 问题 | 关键答案 |
|------|------|----------|
| L1 表象 | Debezium 部署在哪？ | Kafka Connect 集群（独立于业务应用） |
| L2 机制 | 如何保证事务完整性？ | binlog 事务边界 → 同一事务的事件在同一 Kafka 分区连续 |
| L3 边界 | snapshot 期间业务还在写怎么办？ | snapshot 用 RR 隔离，结束后切到 streaming 从 snapshot 时刻位点继续，无重叠无遗漏 |
| L4 权衡 | 为什么不全用 Debezium 替代双写？ | 双写延迟更低（同事务），CDC 有 ~100ms 延迟；强一致要求用 Outbox+CDC（见 140 题） |
| L5 反例 | binlog_expire_logs_seconds=1 天，故障 2 天会怎样？ | Debezium 无法续接，需重新全量 snapshot，期间下游数据缺失 |
| L6 极限 | 单 Connector 单表 QPS 上限？ | 单分区有序，MySQL binlog 单线程解析上限约 10-20k events/s，更高用多 Connector 按表分片 |
| L7 系统 | JD 万级表、千级库如何编排？ | 按 DB 维度分 Connector，Connector name 做 namespace，schema-registry 全局唯一，offset topic 独立 |

**对话还原**：
> 面试官：你们用 Debezium 同步 ES，QPS 多少？
> 我：订单高峰约 3 万 events/s，单表峰值 5k。我们按 DB 拆了 8 个 Connector，每个 Connector 4 个 task 并行。
> 面试官：Schema 加字段踩过坑吗？
> 我：踩过。早期没接 Schema Registry，加了 `risk_level` 字段 Avro 反序列化直接崩，影响搜索 30 分钟。后来强制走 Schema Registry + BACKWARD 兼容校验，DDL 工单系统联动校验。
> 面试官：Connector 重启位点了，binlog 已过期怎么办？
> 我：两道防线——一是 `binlog_expire_logs_seconds=259200`（3 天）兜底；二是 MySQL 到 Kafka Connect 间挂一个 `relay binlog`（中间件），扩容消费窗口。最坏走 `schema_only_recovery` + 业务侧 outbox 重放补偿。

## 八、常见考点

1. **binlog_format 必须是 ROW**（否则 before/after 无法反解）—— 高频考点
2. **at-least-once，下游必须幂等**：用 `topic-partition-offset` 或业务主键 + version 去重
3. **GTID 模式**是主从切换的救命稻草，没有 GTID 切换后位点全乱
4. **Schema Evolution 三件套**：Schema Registry + Avro + BACKWARD 兼容
5. **心跳**（`heartbeat.interval.ms`）防止低流量时 binlog 过期
6. **vs Canal**：多 DB 支持、Schema Registry、社区是选 Debezium 的三大理由
7. **监控**：binlog position 滞后、queue 堆积、task 失败是三大核心指标
8. **tombstone 事件**：delete 操作额外产生一个 null value，用于 Kafka log compaction 清理 key

## 结构化回答

**30 秒电梯演讲：** 京东订单库分库分表后，搜索平台（ES）、风控实时画像、数据中台三套系统都要订单数据。如果用定时任务抽数，秒级延迟和数据库压力无法承受

**展开框架：**
1. **binlog_format 必须是 ROW** — binlog_format 必须是 ROW（否则 before/after 无法反解）—— 高频考点
2. **at-least-once，下游必须幂等** — 用 topic-partition-offset 或业务主键 + version 去重
3. **GTID 模式是主从切换** — GTID 模式是主从切换的救命稻草，没有 GTID 切换后位点全乱

**收尾：** 以上是我的整体思路。您想继续深入聊——Debezium 部署在哪？


## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：Debezium 在 Java 数据同步中的应用 | "这题一句话：京东订单库分库分表后，搜索平台（ES）、风控实时画像、数据中台三套系统都要订单数据。" | 开场钩子 |
| 0:15 | binlog_format 必须示意/对比图 | "binlog_format 必须是 ROW（否则 before/after 无法反解）—— 高频考点" | binlog_format 必须要点 |
| 0:40 | at-least-once，下游示意/对比图 | "用 topic-partition-offset 或业务主键 + version 去重" | at-least-once，下游要点 |
| 1:05 | GTID 模式是主从切换示意/对比图 | "GTID 模式是主从切换的救命稻草，没有 GTID 切换后位点全乱" | GTID 模式是主从切换要点 |
| 1:55 | 总结卡 | "记住：binlog_format。下期见。" | 收尾 |
