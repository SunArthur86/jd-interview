---
id: ant-risk-018
difficulty: L2
category: ant-risk
subcategory: MySQL
tags:
- 蚂蚁
- 风控
- MySQL
- binlog
- 主从同步
- Canal
feynman:
  essence: MySQL 主从同步靠 binlog：主库把变更写 binlog，从库 IO 线程拉取写 relay log，SQL 线程回放，最终数据一致。
  analogy: 主从同步像新闻广播——主库是电台（编发 binlog），从库是收音机（IO 线程收 + SQL 线程播放），有秒级延迟但内容一致。
  first_principle: 单库扛不住读写压力，需要副本。主从同步让"一份数据多副本"，主写从读分离压力。
  key_points:
  - binlog 三格式：STATEMENT（语句，官方默认）/ ROW（行变更，生产推荐）/ MIXED
  - 主从复制线程：Dump（主）+ IO/SQL（从）
  - 同步延迟：异步（默认）/ 半同步 / 组复制
  - binlog 还有：数据恢复、CDC（Canal）、审计
first_principle:
  problem: 如何让 MySQL 在多副本下保证数据最终一致，且不阻塞主库写？
  axioms:
  - 写是稀缺资源（主库），读可分散
  - 同步要异步（不阻塞主）
  - 主从可能断连，要支持续传
  rebuild: 主库写完即返回（不等从），binlog 异步推送给从库。从库有位点（offset），断连后续传。强一致要求场景用半同步（至少一个从确认）。
follow_up:
- 主从延迟怎么解决？——关键路径强制读主、半同步、业务容忍
- Canal 怎么用？——伪装成从库订阅 binlog，解析后投递 Kafka，用于缓存刷新、ES 同步、对账
- ROW 格式为什么生产推荐？——记录每行变更，主从一致最稳；STATEMENT 在不确定函数（now/uuid）下可能不一致。注意 STATEMENT 是官方原版默认，但云数据库（阿里云 RDS）通常默认改 ROW
memory_points:
- 主从复制三线程：主库 Dump + 从库 IO + 从库 SQL
- binlog 三格式：STATEMENT（语句，官方默认）/ROW（行变更，生产推荐）/MIXED
- 同步方式：异步（默认秒级延迟）/半同步（毫秒级）/组复制（强一致）
- binlog 三用途：主从同步、数据恢复、CDC（Canal）
---

# 【蚂蚁风控】MySQL 主从同步原理？binlog 是什么？Canal 怎么用？

> JD 依据："MySQL"。主从同步是 MySQL 高可用和数据流转的基础。

## 一、表面层：主从复制解决什么问题

```
单库痛点:
- 读压力大（每秒 10万 QPS）→ 单库扛不住
- 单点故障 → 数据丢失

主从复制方案:
- 主库（Master）：写
- 从库（Slave）：读
- 主从数据同步
```

**好处**：
- 读写分离（读分到多库）
- 高可用（主挂从升）
- 异地容灾
- 数据分析（从库跑报表）

## 二、主从复制原理

**三个线程协作**：

```
Master（主库）                Slave（从库）
   │                            │
   ├─ binlog（变更日志）        │
   │                            │
   ├─ Dump 线程 ───────────────▶│ IO 线程
   │   (推送 binlog)            │ (拉取写 relay log)
   │                            │
   │                            ├─ relay log
   │                            │
   │                            ├─ SQL 线程
   │                            │ (回放 relay log，写数据)
   │                            │
   │                            └─ 数据文件
```

**流程**：
1. 主库执行写操作，写 binlog（提交事务的一部分）
2. 从库 IO 线程连接主库，请求从某个 binlog 位点开始
3. 主库 Dump 线程读取 binlog 推送给从库
4. 从库 IO 线程写入 relay log（中继日志）
5. 从库 SQL 线程读 relay log，重放 SQL/行变更
6. 从库数据更新

## 三、binlog 三种格式

| 格式 | 记录内容 | 优缺点 |
|------|---------|--------|
| **STATEMENT** | SQL 语句 | 体积小；官方默认；但 `now()`、`uuid()` 在从库执行结果可能不一致 |
| **ROW** | 每行的变更前后镜像 | 主从一致最稳；体积大；**生产推荐/阿里云默认** |
| **MIXED** | 智能选择 | 折中 |

**风控选 ROW**：金融场景要求主从绝对一致。

## 四、复制方式（延迟 vs 一致性）

### 1. 异步复制（默认）
```
主库写完 → 立即返回客户端（不等从库）
   ↓ 异步
从库 IO 线程拉取
```
- 延迟：秒级（视网络和压力）
- 风险：主挂未同步的数据丢失

### 2. 半同步复制（semi-sync）
```
主库写完 → 等至少 1 个从库 ACK → 返回客户端
```
- 延迟：毫秒级（多一个 RTT）
- 安全：至少 1 从确认，主挂不丢
- 配置：`rpl_semi_sync_master_wait_for_slave_count=1`

### 3. 组复制（MGR）
```
写需要多数派（N/2+1）节点确认
```
- 强一致
- 性能开销大
- 适合强一致金融场景

## 五、主从延迟的原因和解决

**延迟原因**：
1. **大事务**：从库回放慢（一次 update 百万行）
2. **DDL**：从库执行 ALTER 重建表
3. **从库性能差**：硬件不如主库
4. **网络抖动**
5. **从库被业务大查询拖慢**：SQL 线程争资源

**解决方案**：
- **关键场景强制读主**：`@Master` 注解，写后立即读主（避免读从看到旧数据）
- **半同步复制**：业务可接受毫秒延迟
- **从库不跑大查询**：分析查询走专用 OLAP 库
- **并行复制**（5.7+）：从库多线程回放（按库/写集合并行）

**风控实战**：
```java
@Transactional
public void deduct(long uid, long amount) {
    accountDao.deduct(uid, amount);    // 主库写
    // 强制读主，避免主从延迟看到旧余额
    Account acc = accountDao.findByMaster(uid);
    log.info("deduct done, balance={}", acc.getBalance());
}
```

## 六、binlog 的其他用途

### 1. 数据恢复（PITR）
```bash
# 用全量备份 + binlog 恢复到任意时间点
mysqlbinlog --start-datetime="2026-07-07 10:00:00" \
            --stop-datetime="2026-07-07 10:30:00" \
            binlog.000123 | mysql -u root -p
```

### 2. CDC（Change Data Capture）
**Canal**（阿里开源）伪装成从库订阅 binlog，把变更投递到下游：
```
MySQL binlog → Canal（伪装从库）→ Kafka → 下游
                                          ├─ 缓存刷新（Redis）
                                          ├─ 索引同步（ES）
                                          ├─ 实时计算（Flink）
                                          └─ 对账系统
```

**风控的应用**：
- 风控事件入库 MySQL → Canal 订阅 → 投递 Kafka → Flink 算实时特征
- 缓存一致性：MySQL 改了 → Canal 通知 Redis 刷新（替代双写）

### 3. 审计
binlog 记录所有变更，可用于审计追溯（"谁在什么时候改了什么"）。

## 七、风控实战：主从架构

```
风控事件库（一主三从）
   ├─ 主库（master）：写
   ├─ 从库1（slave1）：风控决策读（高优先级，不跑报表）
   ├─ 从库2（slave2）：报表统计读
   ├─ 从库3（slave3）：Canal 订阅（伪从库，不参与读）
   └─ 异地从库（dr）：灾备
```

**故障切换**（主挂）：
- MHA / Orchestrator 自动选新主
- 应用层通过注册中心感知切换
- 主从延迟期内数据可能丢失（异步复制）

## 八、底层本质：复制的"位点续传"思想

主从复制的核心是**"位点"（offset）**：
- 主库 binlog 有全局递增位点（文件名 + 偏移量，或 GTID）
- 从库记录"已同步到的位点"
- 断连续传：从库告诉主库"我从 X 位点开始要"，主库从 X 推送

**GTID（Global Transaction ID）**（5.6+）：
- 每个事务有全局唯一 ID（`uuid:seq`）
- 从库记录已执行的 GTID 集合
- 主从切换更简单（不用算文件位点）

**这是分布式系统"日志驱动状态"的范式**：
- 主库的 binlog 是事件日志
- 从库回放日志得到相同状态
- 类似：Kafka 的 offset、区块链的区块序号、git 的 commit hash

## 九、Canal 的工作原理

**Canal 伪装成 MySQL 从库**：
```
1. Canal 向主库发起 COM_BINLOG_DUMP 命令（带 binlog 位点）
2. 主库 Dump 线程推送 binlog
3. Canal 解析 binlog（ROW 格式 → 行变更）
4. 投递到下游（Kafka/RocketMQ/TCP）
```

**配置示例**：
```properties
# canal.properties
canal.serverMode = kafka
canal.mq.servers = kafka:9092

# example.properties（实例配置）
canal.instance.master.address = mysql-master:3306
canal.instance.dbUsername = canal
canal.instance.filter.regex = risk_db\\..*   # 只订阅 risk_db 库
canal.mq.topic = risk-event-cdc
```

**消费端**：
```java
@KafkaListener(topics = "risk-event-cdc")
public void onCDC(ChangeEvent event) {
    if (event.getType() == INSERT) {
        redisCache.put(event.getRow().getUid(), event.getRow());   // 刷缓存
        esClient.index(event.getRow());                            // 同步 ES
    }
}
```

## 常见考点
1. **主从延迟怎么彻底解决**？——不能彻底解决，只能缓解（半同步/读主/业务容忍）。
2. **binlog 和 redo log 区别**？——binlog 是 Server 层的归档日志（所有引擎共用）；redo log 是 InnoDB 引擎的崩溃恢复日志（物理页修改）。
3. **Canal 会丢数据吗**？——会有"重启丢失"风险（位点没及时持久化），用 ACK 机制保证 at-least-once。

**代码示例**（GTID 主从配置）：
```ini
# my.cnf（主）
gtid_mode=ON
enforce_gtid_consistency=ON
log_bin=ON
server_id=1

# my.cnf（从）
gtid_mode=ON
enforce_gtid_consistency=ON
server_id=2

# 从库 CHANGE MASTER 用 GTID
CHANGE MASTER TO MASTER_AUTO_POSITION=1;
START SLAVE;
```

## 苏格拉底式面试追问

> 这组追问不是背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：风控事件库你用 Canal 订阅 binlog 做 CDC（同步到 ES + Kafka），而不是用业务代码"双写"（写 MySQL 同时发 Kafka）。为什么？决策依据是什么？**

双写的核心问题是"一致性 + 性能"。一致性上，双写要靠分布式事务（XA 或 TCC），否则"写 MySQL 成功但发 Kafka 失败"时数据不一致，且 Kafka 失败时是重试还是回滚 MySQL 逻辑复杂。性能上，双写让写路径变长（MySQL + Kafka 都成功才返回），RT 增加。Canal 订阅 binlog 是"单写 + 异步派生"——业务只写 MySQL（单机事务，强一致），Canal 异步订阅 binlog 派生到 ES/Kafka，最终一致。写路径快、一致性有保障（binlog 是 MySQL 事务的一部分，只要 MySQL 写成功 binlog 就在）。代价是延迟（Canal 订阅 + Kafka 投递有秒级延迟）和"非实时"（ES 数据滞后于 MySQL）。决策依据是 SLA——风控事件写入要求强一致 + 低延迟（用户支付时写流水），派生数据（ES/Kafka）可接受秒级延迟。所以主链路单写 MySQL，派生链路 Canal 异步。

### 第二层：证据与定位

**Q：业务反馈"ES 里的风控事件比 MySQL 慢 5 分钟"，怀疑 Canal 延迟。你怎么确认是 Canal 慢还是下游 Kafka/ES 慢？**

沿数据流逐段定位（MySQL → Canal → Kafka → ES）：
1. MySQL 到 Canal——对比 MySQL 的 binlog 位点（`SHOW MASTER STATUS` 的 position/file）和 Canal 记录的已消费位点（Canal 的 `canal.instance.master.position`，在 ZK 或内存）。如果差值大（位点差几万），是 Canal 消费跟不上（Canal 解析慢或网络）。看 Canal 的 `canal.instance.network.receiveBufferSize` 和解析延迟指标。
2. Canal 到 Kafka——看 Canal 的 `canal.mq.produce.latency`（投递 Kafka 的延迟）和 Kafka 的 `consumer_lag`（Kafka 消费者 lag）。如果 Canal 投递正常但 Kafka lag 大，是下游消费者（ES 同步 job）慢。
3. Kafka 到 ES——看 ES 同步 job 的处理速率（每秒消费多少条）。如果消费速率 < 生产速率，是 ES 写入慢（如 ES 的 refresh interval 太短导致频繁 segment merge，或 ES 集群负载高）。用 `curl es:9200/_cat/segments` 看 segment 数量。
真实案例常见是第 3 种——ES 的 refresh_interval=1s（默认）导致每秒 refresh 一次，大批量写入时 merge 跟不上，消费速率掉到几十/秒。调大 refresh_interval 到 30s，写入速率恢复。

### 第三层：根因深挖

**Q：你发现是 Canal 本身慢（位点差几万），Canal 解析 binlog 的吞吐跟不上主库写入。根因是什么？**

Canal 慢几种根因：
1. binlog 格式问题——如果 binlog 是 ROW 格式且表很宽（100 列），每行变更的 binlog 体积大，Canal 解析（反序列化）慢。看 Canal 的 `canal.instance.parser.binlog.byte.per.second`，如果吞吐 < 10MB/s 且 CPU 高，是解析瓶颈。
2. 单线程解析——Canal 默认单线程解析 binlog（一个 parser 线程），如果主库写入 QPS 极高（如每秒 10 万次写），单线程解析跟不上。看 Canal 的 parser 线程 CPU（如果打满 100%，是单核瓶颈）。
3. 投递 Kafka 慢——Canal 投递 Kafka 如果是同步发（等 ACK），每次投递一个 RTT，吞吐受限。看 Canal 的 `canal.mq.produce.latency`，如果每条投递 >10ms，是 Kafka 投递瓶颈。
真实案例常见是第 3 种——Canal 的 Kafka 投递是同步模式（`canal.mq.transaction=true`），每条 binlog 事件等 Kafka ACK，RT 1-3ms，吞吐被限制在 300-1000 TPS。改成异步批量投递（`canal.mq.batch.size=1000` + `canal.mq.async=true`），吞吐提升 10 倍。

**Q：根因是 Canal 投递 Kafka 同步模式慢。那为什么不直接绕过 Canal，用 Debezium 或 Maxwell 做 CDC？它们可能更快。**

Debezium 基于 Kafka Connect，吞吐和可靠性确实好，但有取舍。Debezium 的部署更重（要 Kafka Connect 集群），且它的 schema registry + Avro 序列化对消费端有要求（要解 Avro），而 Canal 的消费端是简单 JSON，对接成本低。Maxwell 轻量但功能弱（不支持 DDL 同步、高可用弱）。Canal 的优势是阿里系生态成熟、支持本地 HA（Canal HA 集群）、和 Kafka/RocketMQ/MQ 对接完善。风控选 Canal 是因为生态熟悉 + 功能满足。根因（同步投递）是配置问题不是工具问题，调配置（异步批量）即可解决，不值得换工具。换工具的迁移成本（重新适配消费端、验证数据一致性）远高于调配置。只有当 Canal 的架构瓶颈（如单线程解析）无法通过配置解决，且吞吐确实不够时，才考虑换。

### 第四层：方案权衡

**Q：你把 Canal 改成异步批量投递，吞吐上去了，但业务说"偶尔会丢数据"（ES 里少了几条事件）。根因是什么？异步模式的数据可靠性怎么权衡？**

异步批量投递的丢数据风险在于"Canal 进程挂了时，内存里未投递的消息丢失"。同步模式（每条等 ACK）不丢（ACK 了才推进位点），但慢；异步批量（内存攒一批再发）快，但挂了内存里的批次丢失。权衡方案是"批量 + 同步位点"——批量投递提升吞吐，但每批投递成功后才推进 Canal 的消费位点（持久化到 ZK/文件）。这样 Canal 挂了重启后，从最后 ACK 的位点重新消费，未投递成功的批次重发（at-least-once）。代价是"可能重复"（已投递但位点未更新的批次重发），需要消费端幂等。风控事件的消费端（ES 同步）用事件 ID 做 `_id`（ES 的 upsert 天然幂等），所以重复投递无副作用。权衡点是"用消费端幂等换生产端吞吐"，这对风控事件（写入是 INSERT，ID 唯一）可行；对非幂等场景（如计数累加）要更复杂的去重。

**Q：为什么不直接用 MySQL 的组复制（MGR）或半同步复制替代 Canal？MGR 强一致不丢数据， Canal 还要处理 at-least-once。**

因为 MGR 和 Canal 解决的是不同问题。MGR 是"MySQL 之间的多副本同步"（主库写到其他 MySQL 从库），解决的是 MySQL 高可用 + 强一致。Canal 是"MySQL 到异构系统（ES/Kafka/Redis）的派生"，解决的是数据流转。我们要的是"风控事件写入 MySQL 后，同步到 ES 做多维查询 + Kafka 做实时计算"，ES 和 Kafka 不是 MySQL，MGR 同步不过去。MGR 只能 MySQL 到 MySQL。要用 MGR 实现 ES 同步，还得在 MySQL 从库上再起一个 Canal 订阅，绕了一圈还是要 Canal。所以正确架构是 MGR（MySQL 高可用）+ Canal（异构派生），两者职责不同。Canal 的 at-least-once + 幂等是异构同步的通用代价，不是 Canal 的缺陷。

### 第五层：验证与沉淀

**Q：你怎么验证 Canal 的 CDC 链路可靠——不丢数据、延迟可控？怎么量化"CDC 健康度"？**

三个核心指标：
1. 端到端延迟——在 MySQL 写入时打时间戳（如事件的 created_at），ES 同步后对比 `now - created_at`，上报 `cdc.latency` 指标。P99 应 <30 秒（Canal 订阅 + Kafka + ES 写入的累计延迟）。延迟 >1 分钟告警。
2. 数据完整性——每天跑对账任务，对比 MySQL 和 ES 的当日事件数（`SELECT COUNT(*) FROM risk_event WHERE date=today` vs `curl es:9200/risk_event/_count?q=date:today`），差异率应 <0.01%（允许 Canal 重启期间极小丢失）。差异 >0.1% 告警。
3. 位点健康——监控 Canal 的消费位点 vs 主库 binlog 位点的差值（`binlog.lag.bytes`），差值持续不增长说明 Canal 跟得上，差值单调增长说明消费跟不上（要扩容或优化）。

**Q：怎么让团队的 CDC 链路稳定、不丢数据？**

沉淀成规范和机制：
1. CDC 统一收口——所有"MySQL 到异构系统"的同步走统一的 Canal 平台（不允许各团队自己起 Canal 实例），平台统一管理位点、监控、HA。
2. 幂等强制——所有 CDC 消费端必须幂等（用业务唯一键去重），CI 校验。Canal 的 at-least-once 语义要求消费端必须容忍重复。
3. 位点持久化——Canal 的位点必须持久化到 ZK/文件，不能只在内存。重启后从持久化位点恢复。定期备份位点。
4. 延迟监控——Canal 的 binlog lag、Kafka consumer lag、ES 同步 job 的处理速率，全链路监控，任何一段积压告警。
5. 对账常态化——每天自动跑 MySQL vs ES/Kafka 的对账，差异告警 + 自动修复（从 MySQL 重灌差异部分）。
6. 故障复盘——把这次"Canal 同步投递慢 → ES 延迟 5 分钟"的位点曲线、投递配置、异步批量方案存知识库，作为"CDC 要异步批量 + 幂等消费"的案例。


## 结构化回答

**30 秒电梯演讲：** 聊到MySQL 主从同步原理，我的理解是——MySQL 主从同步靠 binlog：主库把变更写 binlog，从库 IO 线程拉取写 relay log，SQL 线程回放，最终数据一致。打个比方，主从同步像新闻广播——主库是电台（编发 binlog），从库是收音机（IO 线程收 + SQL 线程播放），有秒级延迟但内容一致。

**展开框架：**
1. **binlog 三格式** — STATEMENT（语句，官方默认）/ ROW（行变更，生产推荐）/ MIXED
2. **主从复制线程** — Dump（主）+ IO/SQL（从）
3. **同步延迟** — 异步（默认）/ 半同步 / 组复制

**收尾：** 这块我在项目里也踩过坑——想深入的话，可以接着聊：主从延迟怎么解决？您更想看哪个方向？

## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡 | "MySQL 主从同步原理——这道题面试官到底想考什么？我用 30 秒给你讲透。" | 开场钩子 |
| 0:15 | SQL EXPLAIN 截图 | 先说核心：MySQL 主从同步靠 binlog：主库把变更写 binlog，从库 IO 线程拉取写 relay log，SQL 线程回放，最终数据一致。 | 核心定义 |
| 0:30 | 主从同步架构图 | Dump（主）+ IO/SQL（从）。 | 主从复制线程 |
| 1:30 | 总结卡 | 一句话记忆：主从复制三线程：主库 Dump + 从库 IO + 从库 SQL。 下期可以接着聊：主从延迟怎么解决。 | 收尾总结 |
