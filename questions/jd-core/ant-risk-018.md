---
id: ant-risk-018
difficulty: L2
category: jd-core
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
