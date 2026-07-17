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

## 苏格拉底式面试追问

> 这组追问不背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：你用 Binlog（Canal/Flink CDC）做数据同步，为什么不直接业务代码双写（写 MySQL 同时写 ES/HBase）？前面 ES 题也提过，这里再确认数据同步平台层的考量。**

从平台层看，双写的根本问题是"业务侵入 + 一致性难保证 + 不可扩展"。每个业务服务（订单/商品/用户）都要写 N 个目标（ES/HBase/ClickHouse），改一个目标要改所有业务服务的代码，且每个业务服务都要处理"写 MySQL 成功写 ES 失败怎么办"的一致性问题。Binlog 同步平台层做的是"统一数据分发"——业务只写 MySQL（单一职责），平台订阅 Binlog 分发到所有目标。新增目标（如加 ClickHouse 做实时分析）只需在平台配 sink，业务零改动。动机是"把数据分发能力从业务剥离到平台"，解耦 + 可扩展。一致性上，Binlog 是 MySQL 的事务日志，天然有序且完整，比业务双写更可靠。

### 第二层：证据与定位

**Q：数据同步平台的同步延迟从平时的 2 秒飙到 5 分钟，你怎么定位是 Canal 消费慢，还是 Kafka 积压，还是 sink 写入慢？**

按数据流逐段看延迟。三步：
1. 看 Canal 的消费位置 vs MySQL 的 binlog 位点——`SHOW MASTER STATUS` 看 MySQL 当前 binlog position，对比 Canal 记录的已消费 position，差值大说明 Canal 消费慢（可能 Canal 实例负载高或网络问题）。
2. 看 Kafka 的消费延迟——`kafka-consumer-groups.sh --describe` 看 lag，如果 lag 大（如百万条），是 sink 消费慢。进一步看 sink 的消费 TPS 和单条耗时。
3. 看 sink 写入耗时——如果 ES sink 的单条写入从 5ms 飙到 200ms，是 ES 集群慢（`_cat/thread_pool/write?v` 看 write 线程池 queue/rejected，或 ES GC）。如果是 HBase sink 慢，看 HBase RegionServer 负载。关键是沿着"Canal → Kafka → Sink"逐段量延迟，定位瓶颈在哪一段，而不是笼统说"同步慢"。

### 第三层：根因深挖

**Q：你定位到是 ES sink 写入慢（ES write 线程池 queue 满，rejected 上升），根因是什么？光是扩 ES 集群就行吗？**

扩 ES 是治标。根因要看为什么 ES 写入扛不住：
1. 写入并发过高——Binlog 流量大（大促或批量更新），ES 的 write 线程池（默认 CPU 核数）处理不过来。治本是 sink 端做"批量写入"（`bulk` API，一次写 1000 条而非逐条），且限流（控制写入 QPS 在 ES 容量内）。
2. ES 索引 refresh 太频繁——默认 1 秒 refresh 一次（生成新 segment），高写入下 refresh 开销大。调大 `index.refresh_interval` 到 30 秒（牺牲近实时性换写入吞吐），或写入高峰期临时调大。
3. ES 分片不均——某分片特别大（hot shard），写入都压到那个分片的节点。`_cat/shards?v` 看分片大小，用 `_cluster/reroute` 或重新分片。根因可能是"数据源（Canal）写入速率超过了 ES 容量"，治本是"批量+限流+调优 ES"，不是单纯扩容。

**Q：那为什么不直接把 ES 换成 ClickHouse（写入更快），不就没有 sink 慢的问题了吗？**

ClickHouse 写入快，但它的查询模式（OLAP 聚合）和 ES（全文检索+多维过滤）不同。订单搜索要"按商品标题全文搜 + 多条件过滤 + 分页"，ES 的倒排索引擅长，ClickHouse 的列存+向量化不擅长全文检索。换 ClickHouse 解决了写入慢但丢了搜索能力。正确的思路是"按用途选 sink"——搜索走 ES（接受写入吞吐限制，用批量+限流优化）、实时分析走 ClickHouse、明细归档走 HBase。每个 sink 职责单一，不指望一个存储解决所有问题。如果 ES 写入确实是瓶颈且无法优化，可以考虑"ES 只存近期热数据（3 个月），全量走 ClickHouse/HBase"，分流降低 ES 写入压力。

### 第四层：方案权衡

**Q：你的同步保证"有序"靠按主键 hash 分区（同 PK 进同分区内有序），但如果是"跨表的事务"（如订单表+订单明细表同事务更新），两表的 binlog 可能到不同分区，下游看到的状态可能错乱，你怎么权衡？**

跨表事务的顺序是 Binlog 同步的难点。权衡方案：
1. 按"事务维度"分区而非"表 PK"——Canal 能识别 binlog 的事务边界（GTID），把同一事务的所有变更（订单表+明细表）发到同一 Kafka 分区，保证事务内有序。代价是分区键变成 GTID（而非业务 PK），下游消费时一个分区混合多表数据，处理复杂。
2. 或下游容忍短暂不一致——订单表和明细表分别同步，下游（如 ES）可能短暂出现"订单已更新但明细还是旧的"，但秒级内会一致。对搜索场景可接受（用户搜到的订单详情 1 秒后更新无感）。
3. 强一致场景走同步双写——如果跨表一致性是硬需求（如财务对账），不走 Binlog 异步，走业务层同步保证（事务内同时写多表/多库）。权衡是"大多数场景容忍跨表秒级不一致（Binlog 异步），少数强一致场景走同步"，不追求所有场景强一致。

**Q：为什么不直接用 Flink CDC 的"全局有序"（不分区，单线程消费），保证所有 binlog 严格有序？**

全局有序意味着单线程消费，吞吐被限制在单 partition（几万条/秒），完全失去了 Kafka 多分区的并行优势。拼多多亿级订单的 binlog 流量是每秒几十万条，单线程消费根本跟不上，延迟会无限增大。按 PK 分区是有序性和吞吐的权衡——牺牲"跨 PK 的全局有序"，换"单 PK 内有序 + 多分区并行"。业务上 99% 场景只关心"同一订单（PK）的状态变更有序"，跨订单的顺序无所谓（订单 A 先支付还是订单 B 先支付不影响各自正确性）。所以按 PK 分区是正确的权衡，全局有序是过度约束。

### 第五层：验证与沉淀

**Q：你怎么验证数据同步"不丢不重"？Binlog 同步这种链路，丢几条数据可能没人发现。**

必须有端到端的数据一致性验证：
1. 不丢——定期全量对账，`MySQL count(*) where update_time in [T] == ES count(*) where update_time in [T]`，任何差异说明有丢失。增量层面，对比 Canal 消费的 binlog position 和 MySQL 的最新 position，差值要收敛（不能持续扩大）。
2. 不重——下游 sink 幂等验证。人为制造重复（让 Canal 重放某段 binlog），验证 ES/HBase 的记录数不变（靠 _id/rowKey 幂等）。`duplicate_consume_count` 监控重复消费次数，虽不应为 0（至少一次语义会有重复），但 sink 幂等保证不产生重复数据。
3. 有序验证——对同一 PK 的多次变更（如 status: A→B→C），验证下游最终是 C（而非停在中间态）。构造"快速连续更新同一订单"的测试，验证下游不会"先看到 C 再看到 B"（乱序导致回退）。用版本号/时间戳校验，下游记录的版本必须是单调递增。

**Q：数据同步平台怎么沉淀成可复用能力，让新业务（新表/新 sink）快速接入？**

沉淀成"数据同步中台"：
1. 配置化接入——业务侧通过配置（数据源表/目标 sink/字段映射/过滤条件）接入同步，不用写代码。平台提供 UI 或 DSL 配置，自动生成同步任务。
2. 统一 sink SDK——每个目标（ES/HBase/ClickHouse）封装标准 sink（批量/幂等/限流/重试），新 sink 类型（如新增 Doris）实现 SDK 接口即可接入。
3. Schema 演进管理——数据源表结构变更（加字段/改类型）通过 Schema Registry 版本化，下游 sink 自动适配（向后兼容），不因 DDL 变更导致同步失败。
4. 全链路监控——每个同步任务的延迟/吞吐/错误率自动接入监控大盘，异常自动告警。运维不依赖业务团队，平台统一兜底。这是中台价值：一次建设，多业务复用，降低接入成本。

## 结构化回答

**30 秒电梯演讲：** 同一份业务数据如何高效分发到多个存储（ES/HBase/数仓）？简单说就是——数据同步平台是"把 MySQL 实时数据流出到 ES/HBase/Kafka/数仓"的中间层，用 Canal/Flink CDC 订阅 Binlog，保证有序、不丢、不重。目标：ES/HBase/Kafka/Hive；保证：有序+不丢+不重（幂等）。

**展开框架：**
1. **数据源** — 数据源：Binlog（Canal/Flink CDC）
2. **目标** — 目标：ES/HBase/Kafka/Hive
3. **保证** — 保证：有序+不丢+不重（幂等）

**收尾：** 您想继续往深里聊吗——比如「Binlog 怎么保证顺序？」

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：数据同步平台怎么设计？ | 今天聊「数据同步平台怎么设计？」。一句话：数据同步平台是"把 MySQL 实时数据流出到 ES/HBase/Kafka/数仓"的中间层，用 Canal/Flin… | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：数据源：Binlog（Canal/Flink CDC） | 核心概念 |
| 0:51 | 能力/参数拆解表 | 要点是：目标：ES/HBase/Kafka/Hive | 能力拆解 |
| 1:30 | 流程图：输入→处理→输出 | 要点是：保证：有序+不丢+不重（幂等） | 关键机制 |
| 2:09 | 监控大盘截图 + 指标曲线 | 要点是：监控：延迟/吞吐/告警 | 实战要点 |
| 3:00 | 总结卡 + 下期预告 | 记住这些核心点就够了。下期我们接着聊——Binlog 怎么保证顺序？。 | 收尾 |
