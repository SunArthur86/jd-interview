---
id: pdd-trade-023
difficulty: L4
category: pdd-trade
subcategory: 交易架构
tags:
- 拼多多
- 交易
- 数据同步
- Canal
- Flink CDC
feynman:
  essence: 数据同步平台是"把 MySQL 实时数据流出到 ES/HBase/Kafka/数仓"的中间层，用 Canal/Flink CDC 订阅 Binlog，保证有序、不丢、不重。
  analogy: 数据同步像"广播站"——MySQL 是现场演出，同步平台把实况转播到不同频道（ES 搜索/HBase 归档/数仓分析），每个频道按需收听。
  first_principle: 数据有多处用途（查询/归档/分析），单库扛不住，需把数据实时分发到各存储。
  key_points:
  - 数据源：MySQL Binlog（Canal/Flink CDC）
  - 目标：ES/HBase/Kafka/Hive/ClickHouse
  - 保证：有序（按 PK hash 分区）+ 不丢（offset 持久化）+ 不重（幂等写入）
  - 监控：延迟/吞吐/异常告警
first_principle:
  problem: 同一份业务数据如何高效分发到多个存储（ES/HBase/数仓）？
  axioms:
  - 各存储用途不同（搜索/归档/分析）
  - 业务库不能被分析压垮
  - 数据需实时（不能只靠 T+1）
  rebuild: Binlog 订阅 + 多目标 sink + 幂等保证。
follow_up:
  - Binlog 怎么保证顺序？——按主键 hash 到同一分区
  - 同步延迟怎么排查？——监控 offset 差值+慢消费+反压
  - 怎么保证不丢？——至少一次 + 下游幂等
memory_points:
  - 数据源：Binlog（Canal/Flink CDC）
  - 目标：ES/HBase/Kafka/Hive
  - 保证：有序+不丢+不重（幂等）
  - 监控：延迟/吞吐/告警
---

# 【拼多多交易】数据同步平台怎么设计？

> JD 依据："交易系统技术升级"、"基础电商业务架构"。

## 一、整体架构

```
MySQL ──Binlog──→ Canal/Flink CDC ──→ Kafka ──→ Sink
                                              ├─→ ES（搜索/多维查）
                                              ├─→ HBase（归档/明细）
                                              ├─→ ClickHouse（实时分析）
                                              └─→ Hive（离线数仓）
```

## 二、Canal 订阅 Binlog

```java
// Canal Client 消费 Binlog
@CanalEventListener
public class OrderBinlogListener {
    @Subscribe(topic = "pdd_trade.order")
    public void onOrder(Event event) {
        BinlogRow row = event.getRow();
        KafkaTemplate.send("order-cdc", row.pk(), row.toPayload());  // 按 PK 路由分区
    }
}
```

## 三、有序+不丢+不重

**有序**：按主键 hash 分到同一分区，单分区内严格有序。
```java
// Kafka producer 按 PK 分区
ProducerRecord<String, String> r = new ProducerRecord<>(
    "order-cdc",
    String.valueOf(row.getId()),   // key = PK
    row.toPayload()
);
```

**不丢**：Producer 用 `acks=all`；消费端 offset 手动提交（处理成功才提交）。

**不重**：下游 sink 幂等（ES 用 `_id`=PK、HBase 用 rowKey=PK、MySQL 用 `INSERT ON DUPLICATE`）。

## 四、多目标 sink

```java
// Flink CDC 一个 source 多 sink
StreamExecutionEnvironment env = ...;
DataStream<Row> stream = env.fromSource(
    MySqlSource.<Row>builder()
        .hostname("mysql").databaseList("trade").tableList("order")
        .deserializer(new JsonDebeziumDeserializationSchema())
        .build(),
    WatermarkStrategy.noWatermarks(),
    "order-cdc"
);

stream.keyBy(r -> r.pk())
      .addSink(new ElasticsearchSink<>(...))   // ES
      .addSink(new HBaseSink(...))             // HBase
      .addSink(new ClickHouseSink(...));       // ClickHouse
```

## 五、监控告警

| 指标 | 阈值 | 处理 |
|------|------|------|
| 同步延迟 | > 30s | 告警，查慢消费/反压 |
| 消费异常率 | > 1% | 告警，人工介入 |
| offset 滞后 | > 10 万 | 扩容消费者 |

## 六、底层本质

数据同步本质是**"用日志（Binlog）做 CDC，多 sink 分发"**——业务库专注写，分析库专注查，Binlog 做桥梁。本质是把"写后立即同步"改成"事件驱动异步同步"。

## 常见考点
1. **同步延迟大怎么办**？——扩消费者并发+反压调优+跳过历史（先全量再增量）。
2. **DDL 变更怎么处理**？——Schema Registry 管理版本+下游兼容（加字段向后兼容）。
3. **双写问题（业务直写 ES）**？——用 Binlog 单向同步避免双写不一致。
