---
id: java-architect-083
difficulty: L2
category: java-architect
subcategory: 高可用
tags:
- Java 架构师
- 数据迁移
- 双写
- 切流
feynman:
  essence: 数据迁移的本质是"不停机把数据从旧存储搬到新存储，且保证一致性"。核心方案是"双写 + 全量同步 + 增量同步 + 影子读校验 + 灰度切流 + 可回滚"。双写保证新数据同时落新旧库，全量同步搬历史数据，增量同步（binlog/CDC）追平双写期间的变更，影子读校验数据一致，灰度切流逐步把读流量从旧库切到新库。
  analogy: 像搬家（旧库→新库）时不能停业。先在新家摆好家具（全量同步历史），之后新买的东西同时放新旧两家（双写），定期对账两家东西是否一致（影子读），最后让客人逐步去新家（灰度切流），都适应了再退掉旧家。
  first_principle: 迁移的难点是"迁移期间数据持续变更"。静态搬迁（停服拷数据）不可行（停服成本高）。双写让新数据同时落新旧库，但双写有短暂窗口（旧库已写、新库还没写）和一致性问题（双写失败怎么办）。增量同步（binlog/CDC）追平双写窗口期的变更。影子读不返回结果只对比，验证一致后才切流。
  key_points:
  - 全量同步：历史数据一次性搬运（DataX/mysqldump/Spark）
  - 双写：新写入同时落新旧库（代码层双写或 binlog 同步）
  - 增量同步：binlog/CDC 追平双写期间的变更
  - 影子读：切流前对比新旧库查询结果，验证一致
  - 灰度切流：1%→10%→50%→100% 逐步把读流量切到新库
  - 可回滚：切流开关秒级切回旧库
first_principle:
  problem: 订单库从 MySQL（单机）迁移到 TiDB（分布式），500G 数据、日均亿级写入，如何不停机迁移且保证数据一致？
  axioms:
  - 迁移期间数据持续写入，不能停服
  - 双写有失败风险（网络、超时），需补偿
  - 切流前必须验证新旧库数据一致
  rebuild: 六阶段——第一，全量同步（DataX 搬历史数据到 TiDB）。第二，开双写（代码层同时写 MySQL 和 TiDB，MySQL 为主 TiDB 失败忽略）。第三，增量同步（binlog 同步追平全量期间的变更， Canal/Debezium）。第四，影子读（随机对比 MySQL 和 TiDB 查询结果，diff_rate < 0.01% 才继续）。第五，灰度切流（1%→10%→50%→100% 读切到 TiDB，写仍双写）。第六，停止双写（写只写 TiDB），下线 MySQL（保留只读副本 30 天兜底）。
follow_up:
  - 双写失败怎么办？——以旧库为主（先写旧库成功再写新库），新库失败记录到补偿表，异步重试。不能让新库失败影响主链路（旧库）。影子读校验发现新库缺数据，触发补偿
  - 全量同步期间的数据变更怎么追？——全量同步开始时记录 binlog 位点，全量完成后从该位点开始增量同步（binlog replay），追到实时
  - 影子读怎么对比？——同一请求同时查新旧库，对比结果（JSON diff）。不完全一致记录到 diff 表，分析原因。不返回新库结果给用户（只对比不切流）
  - 切流后发现问题怎么回滚？——切流是读流量切换（配置中心开关），秒级切回旧库。但切流期间新库可能已接收写入（双写），回滚后旧库也有（双写保证），数据不丢
  - 双写性能影响？——每次写操作多一倍 DB 调用（写新库）。异步双写（MQ 解耦）降低影响但有一致性窗口。同步双写延迟增加（等新库返回）。生产用异步双写 + 补偿
memory_points:
  - 六阶段：全量 → 双写 → 增量 → 影子读 → 灰度切流 → 停双写
  - 双写：旧库为主，新库失败补偿
  - 增量同步：binlog/CDC（Canal/Debezium）
  - 影子读：对比新旧库结果，diff_rate < 0.01%
  - 灰度切流：1%→10%→100%，配置中心秒级回滚
  - 回滚：读切回旧库，双写保证数据不丢
---

# 【Java 后端架构师】数据迁移、双写与在线切流

> 适用场景：JD 核心技术。订单库从 MySQL 单机迁移到 TiDB 分布式（500G 数据、亿级写入），或从旧分库分表方案迁到新方案。架构师必须设计不停机迁移、保证数据一致、灰度切流、可回滚。

## 一、概念层：迁移六阶段全景

**迁移六阶段时间线**（面试必画）：

```
时间 ──────────────────────────────────────────────────────────>

阶段1：全量同步          阶段3：增量同步
├─ DataX 搬历史 500G    ├─ binlog 追全量期间的变更
├─ 记录 binlog 位点     ├─ 追到实时（lag=0）
└─ 耗时几小时           └─ 验证新旧库一致

         阶段2：开双写（代码层同时写新旧库）
         ├─ 先写旧库（主），再写新库（辅）
         ├─ 新库失败记补偿表，异步重试
         └─ 双写贯穿阶段 2-5

                  阶段4：影子读校验
                  ├─ 随机对比新旧库查询结果
                  ├─ diff_rate < 0.01% 才继续
                  └─ 不返回新库结果（只对比）

                           阶段5：灰度切流（读）
                           ├─ 1% 读流量切新库
                           ├─ 10% → 50% → 100%
                           └─ 写仍双写

                                    阶段6：停双写 + 下线旧库
                                    ├─ 写只写新库
                                    ├─ 读全切新库
                                    └─ 旧库保留只读 30 天兜底
```

**新旧库一致性保障矩阵**：

| 阶段 | 旧库（MySQL） | 新库（TiDB） | 一致性来源 |
|------|-------------|------------|-----------|
| 全量同步 | 读+写 | 只读（搬入） | 历史数据搬运 |
| 双写开启 | 读+写 | 写（双写） | 双写 + 增量同步 |
| 增量追平 | 读+写 | 读+写 | binlog replay |
| 影子读 | 读（用户） | 读（对比） | diff 校验 |
| 切流 | 读（减少） | 读（增加） | 读流量切换 |
| 停双写 | 只读（兜底） | 读+写 | 新库为主 |

## 二、机制层：双写代码实现

**双写核心代码**（旧库为主，新库失败补偿）：

```java
@Service
@Slf4j
public class OrderWriteService {

    @Autowired private OrderMapper oldOrderMapper;   // MySQL（旧库）
    @Autowired private OrderMapper newOrderMapper;   // TiDB（新库）
    @Autowired private CompensateMapper compensateMapper;
    @Autowired private MigrationConfig config;        // 迁移配置（开关）

    @Transactional("oldTransactionManager")
    public void createOrder(Order order) {
        // 1. 先写旧库（主，必须成功）
        oldOrderMapper.insert(order);

        // 2. 双写新库（辅，失败不影响主链路）
        if (config.isDualWriteEnabled()) {
            try {
                newOrderMapper.insert(order);
            } catch (Exception e) {
                // 新库失败，记补偿表（异步重试）
                log.warn("双写新库失败 orderId={}, 记补偿表", order.getId(), e);
                compensateMapper.insert(new CompensateTask(
                    order.getId(), "INSERT", JSON.toJSONString(order)));
                // 不抛异常，主链路（旧库）已成功
            }
        }
    }

    @Transactional("oldTransactionManager")
    public void updateOrder(Order order) {
        // 1. 先更新旧库
        oldOrderMapper.update(order);

        // 2. 双写新库
        if (config.isDualWriteEnabled()) {
            try {
                newOrderMapper.update(order);
            } catch (Exception e) {
                compensateMapper.insert(new CompensateTask(
                    order.getId(), "UPDATE", JSON.toJSONString(order)));
            }
        }
    }
}
```

**双写补偿任务**（异步重试保证最终一致）：

```java
@Component
@Slf4j
public class DualWriteCompensator {

    @Autowired private CompensateMapper compensateMapper;
    @Autowired private OrderMapper newOrderMapper;

    @Scheduled(fixedRate = 10000)    // 每 10 秒扫描补偿表
    @SchedulerLock(name = "compensate", lockAtMostFor = "5m")
    public void retryFailedDualWrites() {
        List<CompensateTask> tasks = compensateMapper.selectPending();
        for (CompensateTask task : tasks) {
            try {
                Order order = JSON.parseObject(task.getData(), Order.class);
                switch (task.getOperation()) {
                    case "INSERT":
                        newOrderMapper.insert(order);
                        break;
                    case "UPDATE":
                        newOrderMapper.update(order);
                        break;
                    case "DELETE":
                        newOrderMapper.deleteById(task.getOrderId());
                        break;
                }
                task.setStatus("DONE");
                compensateMapper.update(task);
            } catch (Exception e) {
                task.setRetryCount(task.getRetryCount() + 1);
                if (task.getRetryCount() >= 10) {
                    task.setStatus("DEAD_LETTER");
                    alertService.sendAlert("双写补偿死信: " + task.getOrderId());
                }
                compensateMapper.update(task);
            }
        }
    }
}
```

## 三、机制层：增量同步（binlog/CDC）

**Canal binlog 同步架构**：

```
MySQL（旧库）
  │ binlog（记录所有变更）
  ▼
Canal Server（伪装 MySQL slave，订阅 binlog）
  │ 解析 binlog 事件（INSERT/UPDATE/DELETE）
  ▼
Canal Client（Java 应用 / Flink）
  │ 转换 + 写入
  ▼
TiDB（新库）
```

**Canal 客户端代码**（增量同步）：

```java
@Component
public class CanalSyncClient {

    @Autowired private OrderMapper newOrderMapper;

    @PostConstruct
    public void startSync() {
        CanalConnector connector = CanalConnectors.newSingleConnector(
            new InetSocketAddress("canal-server", 11111),
            "order-sync", "", "");

        new Thread(() -> {
            connector.connect();
            connector.subscribe("old_db.orders");    // 订阅订单表 binlog
            while (true) {
                Message msg = connector.getWithoutAck(1000);  // 批量获取 1000 条
                long batchId = msg.getId();
                try {
                    for (Entry entry : msg.getEntries()) {
                        syncEntry(entry);   // 同步到 TiDB
                    }
                    connector.ack(batchId);   // 成功 ACK
                } catch (Exception e) {
                    log.error("同步失败", e);
                    connector.rollback(batchId);   // 失败回滚，重试
                }
            }
        }).start();
    }

    private void syncEntry(Entry entry) {
        RowChange rowChange = RowChange.parseFrom(entry.getStoreValue());
        for (RowData rowData : rowChange.getRowDatasList()) {
            switch (rowChange.getEventType()) {
                case INSERT:
                    Order order = parseRow(rowData.getAfterColumnsList());
                    newOrderMapper.insert(order);    // 写入 TiDB
                    break;
                case UPDATE:
                    Order updated = parseRow(rowData.getAfterColumnsList());
                    newOrderMapper.update(updated);
                    break;
                case DELETE:
                    Long id = parseId(rowData.getBeforeColumnsList());
                    newOrderMapper.deleteById(id);
                    break;
            }
        }
    }
}
```

**全量 + 增量衔接**（保证不丢数据）：

```
1. 记录 MySQL 当前 binlog 位点
   mysql> SHOW MASTER STATUS;
   → file='mysql-bin.001234', position=456789

2. 开始全量同步（DataX 搬 500G 历史数据到 TiDB）
   耗时 3 小时

3. 全量同步完成后，从步骤 1 的 binlog 位点开始增量同步
   Canal 从 position=456789 开始读 binlog
   追 3 小时内的所有变更到 TiDB

4. 增量追到实时（lag=0）后，验证一致

5. 开启双写（代码层），此时新旧库数据已一致
```

## 四、机制层：影子读校验与灰度切流

**影子读校验**（切流前验证一致）：

```java
@Aspect
@Component
@Slf4j
public class ShadowReadAspect {

    @Autowired private OrderMapper oldOrderMapper;
    @Autowired private OrderMapper newOrderMapper;
    @Autowired private DiffAnalyzer diffAnalyzer;

    @Around("execution(* com.jd.order.service.OrderService.findById(..))")
    public Object shadowRead(ProceedingJoinPoint pjp) throws Throwable {
        Long orderId = (Long) pjp.getArgs()[0];

        // 查旧库（用户实际结果）
        Order oldOrder = oldOrderMapper.findById(orderId);

        // 影子读新库（异步，不阻塞用户）
        CompletableFuture.runAsync(() -> {
            try {
                Order newOrder = newOrderMapper.findById(orderId);
                // 对比结果
                if (!Objects.equals(oldOrder, newOrder)) {
                    diffAnalyzer.recordDiff(orderId, oldOrder, newOrder);
                    // 记录差异，分析原因
                }
            } catch (Exception e) {
                log.warn("影子读新库失败 orderId={}", orderId, e);
            }
        });

        return oldOrder;   // 返回旧库结果（用户无感）
    }
}

// 差异分析器
@Component
public class DiffAnalyzer {
    private final Counter diffCounter = Metrics.counter("migration_diff_total");
    private final Counter readCounter = Metrics.counter("migration_shadow_read_total");

    public void recordDiff(Long orderId, Order oldOrder, Order newOrder) {
        diffCounter.increment();
        log.warn("数据不一致! orderId={} old={} new={}", orderId, oldOrder, newOrder);
        // 记录到 diff 表，人工分析原因（双写遗漏？增量延迟？）
    }

    public double getDiffRate() {
        return diffCounter.count() / readCounter.count();
        // diff_rate < 0.01% 才允许切流
    }
}
```

**灰度切流**（配置中心控制流量比例）：

```java
@Service
public class OrderReadService {

    @Autowired private OrderMapper oldOrderMapper;
    @Autowired private OrderMapper newOrderMapper;
    @Autowired private ConfigService configService;   // Nacos/Apollo

    public Order findById(Long orderId) {
        // 读流量切流比例（配置中心动态调）
        int newDbPercent = configService.getInt("migration.read.newdb.percent", 0);
        // 0% → 1% → 10% → 50% → 100%

        // 按 orderId hash 决定走新库还是旧库（保证同一订单一致性）
        int hash = Math.abs(orderId.hashCode()) % 100;
        if (hash < newDbPercent) {
            return newOrderMapper.findById(orderId);    // 走新库
        } else {
            return oldOrderMapper.findById(orderId);    // 走旧库
        }
    }
}
```

**切流节奏与回滚**：

```
切流节奏：
  Day 1：newDbPercent = 1   （1% 读切新库，影子读继续）
         监控：error_rate、latency_p99、diff_rate
  Day 3：newDbPercent = 10  （10%，观察 2 天）
  Day 7：newDbPercent = 50  （50%，观察 3 天）
  Day 10：newDbPercent = 100（全切新库）
  Day 14：停止双写，写只写新库
  Day 44：下线旧库（保留只读副本 30 天兜底）

回滚：
  任何阶段发现 error_rate 上升或 diff_rate > 0.01%
  → 配置中心秒级把 newDbPercent 调回 0
  → 读流量切回旧库
  → 双写仍在（数据不丢）
```

## 五、底层本质：为什么数据迁移这么难

回到第一性：**迁移的本质是"在数据持续变更的前提下，把数据从 A 搬到 B 且保证 A 和 B 最终一致"**。

- **变更持续性的挑战**：500G 数据全量搬要几小时，这几小时内数据持续写入（新订单、状态更新）。全量同步开始时记录 binlog 位点，全量完成后从该位点增量 replay，追到实时。这要求 binlog 保留足够长时间（至少覆盖全量同步耗时 + 安全余量），否则 binlog 被清理导致增量丢失。
- **双写的一致性窗口**：双写"先写旧库再写新库"有短暂窗口——旧库已写、新库还没写。这期间读到旧库是新数据、读到新库是旧数据。双写还不是原子的（两次 DB 调用）。解法：双写失败补偿（新库失败记补偿表异步重试）、增量同步兜底（binlog 同步保证最终一致）。影子读校验发现不一致时分析原因，修复后才切流。
- **切流的一致性要求**：切流是读流量从旧库切到新库。如果新旧库数据不一致（双写遗漏、增量延迟），切流后用户看到的数据可能不同（如订单状态旧库是"已支付"新库是"待支付"）。影子读在切流前持续校验，diff_rate < 0.01% 才允许切流。按 orderId hash 切流保证同一订单始终走同一库（避免同一用户一会儿旧库一会儿新库看到不同数据）。
- **回滚的数据保障**：切流期间双写仍在（写仍同时写新旧库），所以即使切流到新库发现问题，回滚到旧库数据不丢（旧库一直在写）。停双写是最后一步（确认新库稳定后才停双写写旧库）。旧库保留只读副本 30 天，万一发现问题还能查。

**为什么用 binlog 增量同步而不是消息队列**：双写是代码层的（每次写操作手动写两次），漏写或代码 bug 会导致不一致。binlog 同步是数据库层面的（MySQL 所有变更自动记录 binlog），不依赖应用代码，更可靠。生产实践：代码层双写（低延迟，实时）+ binlog 同步（兜底，保证最终一致）双重保障。

## 六、AI 架构师加问：5 个

1. **AI 能自动发现迁移的数据不一致吗？**
   能做辅助。AI 分析影子读的 diff 数据，归类不一致原因（双写失败、增量延迟、数据类型转换问题）。比规则分析更准——能发现隐蔽的模式差异（如时间字段精度不一致）。但修复（补数据）要确定性逻辑。

2. **AI 预测切流风险？**
   AI 分析历史影子读的 diff_rate 趋势、新旧库的延迟分布、QPS 模式，预测切流后可能出现的问题。但切流决策（是否切、切多少）需人工确认——AI 可能过度保守（永远不建议切）或过度激进（漏掉风险）。

3. **向量数据库迁移怎么做？**
   向量库迁移（如从 FAISS 到 Milvus）同样用全量 + 增量。全量搬历史向量，增量同步新增向量。难点是向量索引重建（Milvuk 的 IVF/HNSW 索引要重新构建，耗时）。影子读对比查询召回率（新旧库 top-K 结果重合度）。

4. **AI Agent 触发的数据变更迁移时怎么保证不丢？**
   Agent 的数据变更走正常双写链路（双写 + binlog 同步）。Agent 可能在迁移期间高频写入，双写补偿表要能承受（批量重试而非逐条）。Agent 的操作幂等（带 request_id），即使重复不产生副作用。

5. **用 AI 生成迁移的 SQL 脚本？**
   AI 能根据旧库 schema 生成新库的 DDL（建表语句）、DML（数据转换 SQL）。但 schema 差异（字段类型、约束、索引）要人工 review——AI 可能漏掉外键约束或索引优化。迁移脚本要在 staging 充分测试。

## 七、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"六阶段：全量、双写、增量、影子读、灰度切流、停双写"**。

- **全量**：DataX 搬历史数据，记录 binlog 位点
- **双写**：旧库为主，新库失败记补偿表异步重试
- **增量**：Canal binlog 同步，追全量期间的变更
- **影子读**：对比新旧库结果，diff_rate < 0.01%
- **切流**：1%→10%→100% 按 orderId hash，配置中心秒级回滚
- **停双写**：确认稳定后写只写新库，旧库保留只读 30 天

### 拟人化理解

把数据迁移想成**搬家**。旧家（旧库）搬新家（新库）时不能停业。先在新家摆好家具（全量同步历史），之后新买的东西同时放新旧两家（双写），定期对账两家东西是否一致（影子读），最后让客人逐步去新家（灰度切流），都适应了再退旧家（停双写下线）。搬家期间不断买新东西（数据持续写入），用搬家公司（binlog 同步）追平。

### 面试现场 60 秒回答

> 迁移六阶段：全量同步、开双写、增量同步、影子读校验、灰度切流、停双写。第一阶段全量同步——用 DataX 搬 500G 历史数据到 TiDB，开始时记录 MySQL binlog 位点。第二阶段开双写——代码层先写旧库（MySQL，为主）再写新库（TiDB），新库失败记补偿表异步重试，不影响主链路。第三阶段增量同步——Canal 从全量开始时的 binlog 位点 replay，追平全量期间的变更到 TiDB。第四阶段影子读——随机对比新旧库查询结果，diff_rate < 0.01% 才允许继续（不返回新库结果只对比）。第五阶段灰度切流——配置中心控制读比例 1%→10%→100%，按 orderId hash 切流（保证同一订单一致性），写仍双写。任何阶段 error_rate 上升秒级回滚（读切回旧库，双写保证数据不丢）。第六阶段停双写——确认新库稳定后写只写 TiDB，旧库保留只读 30 天兜底。关键：双写 + binlog 同步双重保障一致性，影子读验证，灰度切流降低风险。

### 反问面试官

> 贵司迁移场景是 MySQL→TiDB 还是分库分表调整？数据量多大？有没有 binlog 同步工具（Canal/Debezium）？这决定我聊双写策略还是 CDC 同步。

## 八、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不停服迁移，要搞这么复杂？ | 用停服成本说话：交易系统停服 3 小时损失千万级订单。不停机迁移的复杂度是"保业务连续性"的代价。如果是非核心系统（如报表），可以停服窗口迁移，简单很多 |
| 证据追问 | 怎么证明新旧库数据真的一致？ | 影子读 diff_rate（< 0.01%）、全量数据校验（抽样对比 count 和 checksum）、增量同步 lag（= 0，追到实时）。双写补偿表 dead_letter_count（= 0，无死信）。监控 migration_diff_total |
| 边界追问 | 迁移能保证 100% 一致吗？ | 不能保证实时强一致。双写有短暂窗口（旧库写完新库还没写），增量同步有延迟。保证的是"最终一致"（秒级延迟内追平）。强一致需求场景（如资金）用分布式事务（XA/TCC）双写，但性能差 |
| 反例追问 | 什么场景不适合双写？ | 写入量极大（双写翻倍 DB 压力）、旧库不支持 binlog（如 NoSQL）、schema 差异大（字段映射复杂）。这类用"读切流 + 写保持旧库 + 异步搬数据"方案，或接受短暂停服 |
| 风险追问 | 迁移最大风险？ | ① 双写不一致（新库缺数据，影子读发现 + 补偿）；② 增量同步延迟（binlog 堆积，新库落后）；③ 切流后发现新库性能不足（TiDB 比 MySQL 慢，回滚）；④ 回滚后数据冲突（双写期间新库和旧库都被写，停止后旧库可能缺新库的更新） |
| 验证追问 | 怎么验证切流安全？ | 影子读 diff_rate 持续 < 0.01%（一周以上）。新库压测（QPS/延迟达标）。灰度切流 1% 观察 error_rate 和 latency_p99 2 天无异常。故障演练（kill 新库验证回滚时效） |
| 沉淀追问 | 团队迁移规范沉淀什么？ | 双写代码模板（旧库为主 + 补偿表）、Canal 同步配置模板、影子读 Aspect 模板、切流 SOP（节奏 + 阈值 + 回滚）、迁移监控大盘（diff_rate/lag/error_rate/补偿死信数） |

### 现场对话示例

**面试官**：双写时新库写失败了怎么办？

**候选人**：以旧库为主——先写旧库成功，再写新库。新库失败不影响主链路（用户操作已完成，旧库有数据）。失败记录到补偿表（orderId + 操作类型 + 数据 JSON），异步重试。补偿任务每 10 秒扫描补偿表，重试失败的操作，重试 10 次进死信告警。这样新库最终会追上（最终一致）。但有个风险：双写失败期间，影子读会发现新库缺数据（旧库有新库没有），diff_rate 上升。如果补偿还没追上就切流，用户可能看到不一致。所以切流前必须等 diff_rate < 0.01%（补偿追完）。极端情况（新库长时间故障），停止切流，等新库恢复 + 补偿追平。

**面试官**：全量同步期间的数据变更怎么不丢？

**候选人**：全量同步开始时先记录 MySQL 的 binlog 位点（SHOW MASTER STATUS，file + position）。全量同步耗时 3 小时，期间数据持续写入 MySQL（binlog 在增长）。全量完成后，Canal 从记录的 binlog 位点开始读，replay 这 3 小时的所有变更到 TiDB。这样全量数据 + 增量变更都同步了。前提是 MySQL 的 binlog 保留时间 > 全量同步耗时（至少 24 小时，安全余量）。如果 binlog 被清理（expire_logs_days 太短），增量同步断点，要重新全量。所以迁移前先检查 binlog 配置。

**面试官**：切流后 TiDB 性能不如 MySQL，怎么回滚？

**候选人**：秒级回滚——配置中心把 newDbPercent 从 100 调回 0，读流量立即切回 MySQL。因为双写一直在（写仍同时写 MySQL 和 TiDB），回滚后 MySQL 数据是最新的（双写保证），不丢数据。用户可能短暂感知延迟（切流瞬间），但功能不受影响。回滚后分析 TiDB 性能问题——可能是索引没建、SQL 不兼容、参数没调。修复后重新灰度切流。关键：切流期间不停双写（双写是回滚的数据保障），直到确认新库完全稳定（全量读 + 写都切新库运行 1-2 周无异常）才停双写。

## 常见考点

1. **双写怎么保证一致？**——旧库为主先写，新库失败记补偿表异步重试。binlog 同步（Canal）兜底保证最终一致。影子读校验 diff_rate。双写 + 增量同步双重保障。
2. **全量+增量怎么衔接？**——全量同步开始时记录 binlog 位点，全量完成后从该位点增量 replay，追到实时。要求 binlog 保留时间 > 全量耗时。
3. **影子读是什么？**——同一请求查新旧库，对比结果（JSON diff）。只对比不返回新库结果。diff_rate < 0.01% 才允许切流。记录 diff 分析原因。
4. **灰度切流怎么回滚？**——配置中心控制读流量比例（newDbPercent），秒级调回 0 切回旧库。双写保证回滚后数据不丢。按 orderId hash 切流保证同一订单一致。
5. **迁移六阶段顺序？**——全量同步→开双写→增量同步（追平）→影子读校验→灰度切流（1%→100%）→停双写下线旧库。每阶段有验证条件，不满足不进入下一阶段。

## 结构化回答

**30 秒电梯演讲：** 数据迁移的本质是不停机把数据从旧存储搬到新存储，且保证一致性。核心方案是双写 + 全量同步 + 增量同步 + 影子读校验 + 灰度切流 + 可回滚。双写保证新数据同时落新旧库，全量同步搬历史数据，增量同步（binlog/CDC）追平双写期间的变更，影子读校验数据一致，灰度切流逐步把读流量从旧库切到新库

**展开框架：**
1. **全量同步** — 历史数据一次性搬运（DataX/mysqldump/Spark）
2. **双写** — 新写入同时落新旧库（代码层双写或 binlog 同步）
3. **增量同步** — binlog/CDC 追平双写期间的变更

**收尾：** 以上是我的整体思路。您想继续深入聊——双写失败怎么办？


## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：数据迁移、双写与在线切流 | "这题一句话：数据迁移的本质是不停机把数据从旧存储搬到新存储，且保证一致性。" | 开场钩子 |
| 0:15 | 全量同步示意/对比图 | "历史数据一次性搬运（DataX/mysqldump/Spark）" | 全量同步要点 |
| 0:40 | 双写示意/对比图 | "新写入同时落新旧库（代码层双写或 binlog 同步）" | 双写要点 |
| 1:25 | 总结卡 | "记住：六阶段。下期见。" | 收尾 |
