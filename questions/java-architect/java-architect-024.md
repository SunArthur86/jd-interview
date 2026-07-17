---
id: java-architect-024
difficulty: L3
category: java-architect
subcategory: MySQL
tags:
- 读写分离
- 主从延迟
- 一致性
feynman:
  essence: 读写分离的本质是"写主库、读从库，用多个从库分摊读压力"。核心矛盾是主从复制延迟——写主库后从库异步同步有秒级延迟，导致"写完立即读不到"。兜底方案按一致性强度选：强一致场景走主库、容忍延迟用缓存过渡、跨机房用半同步复制。
  analogy: 像报社的"主编辑部 + 各地印刷厂"。记者写稿交主编辑部（写主库），各地印刷厂同步印刷（从库复制）。但同步有延迟（运输时间），可能出现"刚交稿去当地买报纸发现还没印"（写后读不到）。解法：重要新闻指定看主编辑部原稿（读主库），或等印刷完成通知（等待复制完成）。
  first_principle: 为什么读写分离？因为大部分业务读多写少（读写比 10:1 到 100:1），单库承受不了读压力。把读分摊到多个从库，主库只负责写，整体吞吐提升 N 倍（N 是从库数）。代价是主从延迟引入的一致性问题。
  key_points:
  - 主从复制：binlog → relay log → replay，异步（默认）或半同步
  - 复制延迟来源：网络、大事务、慢 SQL、从库单线程 replay
  - 写后读一致：强制读主库、缓存过渡（写后缓存标记）、半同步复制
  - 多活架构：同城主备、异地双活、异地多活（按一致性需求选）
  - ShardingSphere/Aware 路由：注解或 SQL 解析自动路由读写
first_principle:
  problem: 如何在不分库的前提下，用多个副本分摊读压力，同时控制主从延迟导致的一致性问题？
  axioms:
  - 业务读多写少，单库读压力是瓶颈
  - 异步复制有延迟（秒级），写后立即读可能读到旧数据
  - 强一致读要回主库（牺牲分离收益），最终一致读走从库
  rebuild: 主库负责写，多个从库负责读（读写分离）。复制用 binlog 异步同步（默认）或半同步（至少一个从库确认）。写后读一致性问题用三种兜底：第一，关键业务（如支付后查订单）强制读主库；第二，写后在 Redis 标记"该用户 N 秒内读主库"（缓存过渡）；第三，用半同步复制降低延迟（从库收到 binlog 才算提交成功，延迟降到毫秒级但写入变慢）。从库延迟监控用 Seconds_Behind_Master，超阈值告警。
follow_up:
  - Seconds_Behind_Master 是什么？——从库复制延迟指标（秒），表示从库落后主库多少秒。SHOW SLAVE STATUS 查看。超 1s 告警，超 5s 可能影响业务。但这个指标有局限（基于 binlog 时间戳，不完全准确），MySQL 8.0 用 performance_schema.replication_applier_status 更准确
  - 半同步复制（semi-sync）是什么？——主库提交事务后，至少等一个从库收到 binlog（ack）才算提交成功。降低延迟（从库收到即接近同步）但写入变慢（等 ack）。适合对一致性敏感的场景
  - 从库延迟大怎么排查？——常见原因：从库单线程 replay（MySQL 5.7+ 支持并行复制 multi-threaded slave）、大事务（一个事务阻塞后续）、慢 SQL（从库查询阻塞 replay）、网络抖动。用 SHOW SLAVE STATUS 看 Seconds_Behind_Master 和 Slave_IO/SQL_Running
  - 读写分离怎么路由？——中间件（ShardingSphere/ProxySQL）自动路由（解析 SQL，SELECT 走从库，DML 走主库）；注解（@Master/@Slave 手动指定）；客户端感知（如写后在 ThreadLocal 标记强制读主）。注解更灵活但侵入代码
  - 主库挂了怎么办？——从库提升为主（failover）。用 MHA/MGR/Orchestrator 自动切换。切换时要处理：选最新的从库、重定向应用连接、处理延迟（等从库追平）。切换过程有短暂不可用（秒到分钟级）
memory_points:
  - 读写分离：写主库、读从库，分摊读压力
  - 复制延迟：binlog → relay log → replay，秒级
  - 写后读一致：强制读主、缓存过渡、半同步
  - 延迟监控：Seconds_Behind_Master，超 1s 告警
  - 半同步：至少一个从库 ack 才提交，延迟毫秒级但写入变慢
  - 路由：中间件自动 / 注解手动 / ThreadLocal 感知
---

# 【Java 后端架构师】读写分离、主从延迟与一致性兜底

> 适用场景：JD 核心技术。商品详情页读 QPS 10 万，单库扛不住，读写分离后从库延迟导致"下单后看不到订单"。架构师必须能设计读写分离架构、诊断主从延迟、实现写后读一致性——这是高并发读场景的标准配置。

## 一、概念层：主从复制架构

**MySQL 主从复制原理**（画图必考）：

```
主库 (Master)                         从库 (Slave)
┌───────────────────┐               ┌───────────────────┐
│ 1. 事务提交        │               │                   │
│    写 binlog      │               │                   │
│                   │  2. IO Thread  │                   │
│                   │ ◀──────────── │ 请求 binlog       │
│                   │  推送 binlog   │                   │
│                   │ ────────────▶ │ 3. 写 relay log   │
│                   │               │                   │
│                   │               │ 4. SQL Thread     │
│                   │               │    replay relay log│
│                   │               │    → 数据变更      │
└───────────────────┘               └───────────────────┘

复制流程：
  主库写 binlog → 从库 IO Thread 拉取 binlog 写 relay log → 从库 SQL Thread replay

延迟来源：
  1. 网络（主从间网络传输）
  2. relay log replay（从库单线程串行执行，MySQL 5.7+ 支持并行复制）
  3. 大事务（一个事务阻塞后续 replay）
  4. 从库慢查询（查询锁阻塞 replay）
```

**复制模式对比**：

| 模式 | 机制 | 延迟 | 数据安全 | 适用 |
|------|------|------|---------|------|
| **异步复制**（默认） | 主库写 binlog 即返回，不等从库 | 秒级 | 主库宕可能丢未同步数据 | 高性能容忍丢失 |
| **半同步复制** | 主库等至少 1 个从库 ack 才返回 | 毫秒级 | 至少 1 从库有数据 | 平衡一致和性能 |
| **全同步复制** | 主库等所有从库 ack | 高（等最慢从库） | 不丢数据 | 极少用（性能差） |
| **组复制（MGR）** | Paxos 协议多数派 ack | 毫秒级 | 多数派一致 | 高可用集群 |

## 二、机制层：读写分离路由

**路由策略**（面试必考）：

```
策略 1：SQL 解析自动路由（中间件）
  SELECT ... → 从库（负载均衡选一个）
  INSERT/UPDATE/DELETE → 主库
  ── ShardingSphere/ProxySQL 自动处理，业务无感知

策略 2：注解手动指定
  @Master   → 强制走主库（写后读一致）
  @Slave    → 强制走从库
  ── 灵活但侵入代码

策略 3：ThreadLocal 上下文感知
  写操作后在 ThreadLocal 标记"该请求 N 秒内读主"
  后续读检查标记决定路由
```

**ShardingSphere 读写分离配置**：

```yaml
spring:
  shardingsphere:
    rules:
      readwrite-splitting:
        data-sources:
          readwrite_ds:
            write-data-source-name: master_ds
            read-data-source-names: slave_ds_0,slave_ds_1,slave_ds_2
            load-balancer-name: round_robin
        load-balancers:
          round_robin:
            type: ROUND_ROBIN     # 轮询（还有 RANDOM 权重随机）
```

```java
// 业务代码无感知
@Service
public class OrderService {
    @Autowired
    private OrderMapper orderMapper;

    // ShardingSphere 自动路由：SELECT 走从库
    public Order queryOrder(Long id) {
        return orderMapper.selectById(id);
    }

    // 自动路由：INSERT 走主库
    public void createOrder(Order order) {
        orderMapper.insert(order);
    }
}
```

**强制读主库**（写后读一致）：

```java
// 场景：用户下单后立即跳转订单详情页，必须看到新订单
@Service
public class OrderService {

    @Transactional
    @MasterHint    // 自定义注解，强制走主库
    public Order createAndQuery(Long userId, OrderDTO dto) {
        Order order = createOrder(dto);   // 写主库
        return queryOrder(order.getId()); // 读主库（强制）
    }
}

// 或用 ShardingSphere 的 HintManager
public Order createAndQuery(Long userId, OrderDTO dto) {
    Order order = createOrder(dto);
    try (HintManager hint = HintManager.getInstance()) {
        hint.setMasterRouteOnly();   // 强制主库
        return queryOrder(order.getId());
    }
}
```

## 三、机制层：主从延迟诊断

**查看延迟指标**：

```sql
-- 查看从库状态（经典指标）
SHOW SLAVE STATUS\G
-- 关注：
--   Seconds_Behind_Master: 5    （落后主库 5 秒）
--   Slave_IO_Running: Yes       （IO 线程正常）
--   Slave_SQL_Running: Yes      （SQL 线程正常）
--   Last_IO_Error / Last_SQL_Error （错误信息）

-- MySQL 8.0+ 更准确的延迟指标
SELECT * FROM performance_schema.replication_applier_status_by_worker;
-- 看 APPLY_TRANSACTION 和 LAST_APPLY_TRANSACTION 的延迟

-- 查看复制拓扑
SELECT * FROM performance_schema.replication_connection_status;
```

**延迟大的常见原因与排查**：

| 原因 | 表现 | 排查 | 解决 |
|------|------|------|------|
| **从库单线程 replay** | SQL Thread 串行执行跟不上主库并发写 | Seconds_Behind_Master 持续增长 | 开启并行复制（slave_parallel_workers） |
| **大事务** | 单个事务执行很久阻塞后续 | relay log 中有大事务 | 拆分大事务（如批量 INSERT 分批） |
| **从库慢查询** | 业务慢 SQL 锁表阻塞 replay | SHOW PROCESSLIST 看从库查询 | 慢 SQL 优化 / 读写分离从库只做复制不对外查询 |
| **网络抖动** | IO 线程拉 binlog 慢 | Last_IO_Error 有重连日志 | 网络优化 / 压缩 binlog 传输 |
| **从库硬件差** | 从库 CPU/IO 比主库弱 | 从库负载高 | 从库硬件对齐主库 |

**并行复制（MySQL 5.7+）**：

```sql
-- 从库开启并行复制（基于组提交，同一组的 binlog 可并行 replay）
CHANGE REPLICATION SOURCE TO
  SOURCE_AUTO_POSITION = 1,
  SOURCE_CONNECT_RETRY = 60;

SET GLOBAL slave_parallel_type = LOGICAL_CLOCK;     -- 基于组提交
SET GLOBAL slave_parallel_workers = 16;              -- 16 个 worker 线程
SET GLOBAL slave_preserve_commit_order = ON;         -- 保持提交顺序

-- 效果：从库 replay 速度接近主库写入，延迟降到毫秒级
```

## 四、实战层：写后读一致性方案

**场景**：用户下单后跳转订单详情页，必须看到新订单。但写主库后从库还没同步，读从库会查不到。

**方案 1：强制读主库**（简单粗暴）

```java
// 写后立即的读走主库
@Transactional
public OrderVO createOrderAndReturn(Long userId, OrderDTO dto) {
    Order order = orderMapper.insert(orderFactory.create(dto));
    // 强制读主库
    HintManager.getInstance().setMasterRouteOnly();
    Order fresh = orderMapper.selectById(order.getId());
    return convert(fresh);
}
```

**适用**：少量关键场景（下单后查看、支付后查看）。代价是主库读压力增加。

**方案 2：缓存过渡标记**（推荐）

```java
@Service
public class OrderService {

    @Transactional
    public OrderVO createOrder(Long userId, OrderDTO dto) {
        Order order = orderMapper.insert(orderFactory.create(dto));
        // 写后在 Redis 标记"该用户 N 秒内读主库"
        redisTemplate.opsForValue().set(
            "read_master:" + userId, "1", 3, TimeUnit.SECONDS);
        return convert(order);
    }

    // 查询时检查标记
    public OrderVO queryOrder(Long userId, Long orderId) {
        // 如果标记存在，强制读主库
        if (redisTemplate.hasKey("read_master:" + userId)) {
            HintManager.getInstance().setMasterRouteOnly();
        }
        return convert(orderMapper.selectById(orderId));
    }
}
```

**原理**：写操作后用户大概率立即查询（3 秒内），这段时间强制读主库保证一致；3 秒后从库已同步，恢复正常读从库。

**方案 3：半同步复制**（降低延迟）

```sql
-- 主库开启半同步插件
INSTALL PLUGIN rpl_semi_sync_source SONAME 'semisync_source.so';
SET GLOBAL rpl_semi_sync_source_enabled = 1;
SET GLOBAL rpl_semi_sync_source_timeout = 1000;   -- 1 秒超时

-- 从库开启半同步
INSTALL PLUGIN rpl_semi_sync_replica SONAME 'semisync_replica.so';
SET GLOBAL rpl_semi_sync_replica_enabled = 1;
```

**效果**：主库提交事务后等至少一个从库收到 binlog（ack）才算成功，延迟降到毫秒级。代价是写入变慢（等 ack），如果从库没及时 ack 会降级为异步（超时机制）。

**方案 4：版本号/时间戳校验**

```java
// 写时记录版本号
@Transactional
public OrderVO createOrder(Long userId, OrderDTO dto) {
    Order order = orderMapper.insert(orderFactory.create(dto));
    // 在 ThreadLocal 或 Session 记录"用户已知最新版本"
    UserContext.setLastWriteTime(userId, System.currentTimeMillis());
    return convert(order);
}

// 读时校验从库是否已同步到该版本
public OrderVO queryOrder(Long userId, Long orderId) {
    long lastWrite = UserContext.getLastWriteTime(userId);
    // 查从库的同步位点是否 >= lastWrite
    if (!isSlaveSynced(lastWrite)) {
        HintManager.getInstance().setMasterRouteOnly();   // 没同步读主
    }
    return convert(orderMapper.selectById(orderId));
}
```

## 五、实战层：高可用与 failover

**主库故障切换**（failover）：

```
主库宕机时的切换流程：
1. 检测：MHA/Orchestrator/MGR 检测主库不可达（心跳超时）
2. 选主：从从库中选数据最新的（binlog 位点最靠前）
3. 等待：等从库 relay log replay 完（保证数据完整）
4. 提升：选中的从库提升为主库（reset slave all; reset master）
5. 重定向：其他从库指向新主库（CHANGE MASTER TO ...）
6. 通知应用：应用感知主库变更（通过配置中心或 VIP 漂移）

切换耗时：秒级（MGR）到分钟级（MHA）
风险：可能丢数据（异步复制时主库宕机，未同步的 binlog 丢失）
```

**高可用方案对比**：

| 方案 | 切换时效 | 数据一致 | 复杂度 | 适用 |
|------|---------|---------|--------|------|
| **MHA** | 分钟级 | 可能丢数据 | 中 | 传统主从 |
| **Orchestrator** | 秒级 | 可能丢数据 | 中 | 传统主从（GitHub 开源） |
| **MGR（组复制）** | 秒级 | 多数派一致 | 高 | 强一致高可用 |
| **云数据库（RDS）** | 秒级 | 依赖厂商 | 低 | 托管场景 |

**跨机房读写分离**：

```
同城双活（同城两机房）：
  机房 A：主库（读写）
  机房 B：从库（读）+ 备主（故障切换）
  ── 同城网络延迟 < 5ms，半同步可行

异地多活（跨城市）：
  北京机房：北方用户主库
  上海机房：南方用户主库
  ── 按 user_id 路由到就近机房，异地异步同步
  ── 异地延迟 30-100ms，强同步不可行，用最终一致

单元化（全链路同城/异地多活）：
  每个机房是独立单元（应用 + DB + 缓存）
  按 user_id 路由到单元，单元内闭环
  ── 极致高可用，但架构复杂（适合超大规模如阿里、京东）
```

## 六、底层本质：CAP 在读写分离中的体现

回到第一性：**读写分离是 CAP 中选择 AP（可用+分区容忍）的典型实践，用主从延迟（最终一致）换读性能**。

- **为什么有延迟**：异步复制是性能和一致的权衡。主库写完不等从库（异步），写入快（高吞吐），但从库有延迟。如果等从库同步（同步复制），写入慢但一致强。半同步是折中——等一个从库，平衡。
- **写后读不一致的本质**：用户写主库后立即读从库，从库还没同步到最新数据，导致"我刚下的单查不到"。这不是 bug 而是最终一致的固有特征——在延迟窗口内，系统处于不一致状态。
- **兜底方案的本质**：强制读主是放弃读写分离（牺牲读性能换一致）；缓存过渡是"预判用户行为"（写后大概率立即读，这段时间读主）；半同步是降低延迟（缩短不一致窗口）。按业务一致性需求选。
- **互联网的选择**：大部分业务（商品查询、推荐、社交）容忍秒级延迟（最终一致），读从库。少量关键业务（支付、下单后查看）强制读主。这是"按场景分级一致性"的工程实践。

## 七、AI 架构师加问：5 个 AI 相关问题

1. **AI 推理结果的读写分离怎么设计？**
   推理结果写入主库（强一致），查询（如用户历史）走从库（容忍秒级延迟）。如果用户刚推理完立即查（写后读），用缓存标记强制读主 3 秒。大字段（向量）单独存向量库，不参与读写分离。

2. **让 AI 监控主从延迟，怎么设计？**
   AI 监控 Seconds_Behind_Master 和 replication_applier_status → 延迟超阈值告警 → 根因分析（大事务/慢SQL/网络）。AI 还能预测延迟趋势（如大促前写入飙升导致延迟），提前扩容从库。

3. **AI 自动切换读写路由怎么设计？**
   AI 监控从库延迟 → 延迟大时自动把读流量切回主库（避免读到旧数据）→ 延迟恢复后切回从库。但切换要谨慎（频繁切换抖动），设冷却时间（如 5 分钟内只切一次）。

4. **AI 辅助 failover 决策怎么做？**
   AI 评估从库数据新鲜度（binlog 位点）→ 选最新从库提升为主 → 验证数据一致性 → 通知应用切换。AI 还要评估切换时机（太早切换丢数据，太晚影响可用性）。

5. **RAG 知识库的读写分离有特殊考虑吗？**
   RAG 的写入（文档更新+重新embedding）是低频操作，走主库。检索（向量查询）是高频，走从库或独立向量库。embedding 生成是异步的（写后发消息），不阻塞写入，所以延迟问题不突出。

## 八、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"写主读从、复制延迟、写后读三方案、并行复制、failover"**。

- **读写分离**：写主库、读从库（分摊读压力）
- **复制延迟**：binlog → relay log → replay，异步秒级
- **写后读一致**：强制读主、缓存过渡（Redis 标记）、半同步复制
- **延迟优化**：并行复制（slave_parallel_workers）、拆大事务
- **监控**：Seconds_Behind_Master，超 1s 告警
- **failover**：MHA/MGR 选最新从库提升为主

### 拟人化理解

把读写分离想成**报社主编辑部 + 各地印刷厂**。记者写稿交主编辑部（写主库），各地印刷厂同步印刷（从库复制）。但同步有运输延迟，可能出现"刚交稿去当地买报纸发现还没印"（写后读不到）。解法：重要新闻指定看主编辑部原稿（读主库），或主编辑部通知"3 秒内来原稿看"（缓存过渡），或用快传（半同步，运输快但成本高）。印刷厂多了能服务更多读者（读扩展），但要管理同步延迟。

### 面试现场 60 秒回答

> 读写分离解决单库读压力——写主库，多个从库分摊读。MySQL 主从复制是主库写 binlog → 从库 IO Thread 拉取写 relay log → 从库 SQL Thread replay，异步默认有秒级延迟。写后读一致性三个方案：关键业务（下单后查看）强制读主库；通用方案用 Redis 缓存标记"写后 N 秒该用户读主"；对一致性敏感的用半同步复制（主库等一个从库 ack，延迟降到毫秒级但写入变慢）。从库延迟大的原因：单线程 replay（开并行复制 slave_parallel_workers 解决）、大事务阻塞（拆分）、慢查询锁（优化）。监控 Seconds_Behind_Master 超 1s 告警。主库故障用 MHA/MGR 自动 failover，选最新从库提升为主。大部分业务容忍秒级延迟走从库，少量关键业务强制读主。

### 反问面试官

> 贵司读写分离是从库几个？主从延迟平均多少（Seconds_Behind_Master）？写后读一致性怎么处理（强制读主/缓存标记）？有没有用半同步？failover 用 MHA 还是 MGR 还是云厂商托管？

## 九、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不分库，要读写分离？ | 用成本说话：读写分离是"读扩展"（加从库分摊读），不改数据结构，改造成本低。分库是"写扩展+数据分散"，改造成本高（路由/跨库查询/全局ID）。业务读多写少时优先读写分离，写压力也大了再分库 |
| 证据追问 | 主从延迟大你怎么发现和定位？ | SHOW SLAVE STATUS 看 Seconds_Behind_Master；performance_schema.replication_applier_status 更准确；SHOW PROCESSLIST 看从库是否有慢查询阻塞；排查 relay log 是否有大事务；监控网络延迟 |
| 边界追问 | 读写分离能解决所有读压力吗？ | 不能。解决不了：热点读（同一行被高频读，从库也扛不住，要缓存）、强一致读（必须读主）、写瓶颈（读写分离不分散写，写多了要分库）。读写分离只解决"读量"问题 |
| 反例追问 | 什么场景不该读写分离？ | 写多读少（分离收益小反而增加复制成本）、强一致需求高（延迟导致不一致）、事务内读写（必须同库）。小规模系统（单库够用）也没必要，徒增复杂度 |
| 风险追问 | 读写分离上线后最大风险？ | 主动点出：写后读不一致（用户感知异常）、从库延迟大（读到旧数据）、failover 丢数据（异步复制主库宕可能丢未同步）、从库慢查询阻塞复制（replay 卡住） |
| 验证追问 | 怎么证明读写分离真的分摊了压力？ | 监控主库 QPS（应主要是写）、从库 QPS（应主要是读）、各从库负载均衡（轮询是否均匀）；压测对比单库 vs 读写分离的读 TPS；主从延迟在容忍范围（P99 < 1s） |
| 沉淀追问 | 团队读写分离治理规范，沉淀什么？ | 写后读 SOP（哪些场景强制读主）、从库延迟监控大盘、failover 演练计划（定期模拟主库宕机）、从库慢 SQL 治理（从库慢查询阻塞复制）、半同步配置规范 |

### 现场对话示例

**面试官**：用户下单后看不到订单，怎么排查是主从延迟？

**候选人**：首先确认现象——用户下单成功（主库写成功）但查询返回空（从库读到空）。排查步骤：第一，看从库延迟指标 SHOW SLAVE STATUS 的 Seconds_Behind_Master，如果 > 1s 大概率是延迟。第二，直接查主库（强制读主）验证数据存在，对比从库——主库有从库没有就是延迟。第三，看从库 SQL Thread 是否正常（Slave_SQL_Running: Yes），如果 No 说明 replay 卡住（可能是慢查询或锁）。解法分两层：临时方案是强制读主（关键场景）；根本方案是降低延迟（开并行复制、拆大事务、优化从库慢 SQL）。预防方案是写后读用缓存标记过渡——下单后在 Redis 标记"该用户 3 秒内读主"，3 秒后从库已同步恢复正常读从。

**面试官**：从库延迟一直降不下来怎么办？

**候选人**：先定位延迟来源。第一，看是不是从库单线程 replay 跟不上——如果主库并发写很高，单线程 replay 必然慢。开并行复制（slave_parallel_workers=16, slave_parallel_type=LOGICAL_CLOCK），从库多线程 replay，速度接近主库写入。第二，看是不是大事务阻塞——某个事务执行很久（如批量 INSERT 几十万行），后续 binlog 都被阻塞。解法是拆分大事务（分批 INSERT）。第三，看是不是从库慢查询——从库对外提供查询，某条慢 SQL 锁表阻塞 replay。解法是从库只做复制不对外查询（单独的分析从库），或优化慢 SQL。第四，看是不是网络问题——binlog 传输慢，用 SHOW SLAVE STATUS 的 Last_IO_Error 看是否有重连。第五，看从库硬件是否比主库差——CPU/IO 跟不上，升级硬件对齐主库。一般开了并行复制 + 治理大事务和慢 SQL，延迟能降到毫秒级。

**面试官**：半同步复制和异步比有什么代价？

**候选人**：半同步的代价是写入变慢。异步复制是主库写完 binlog 立即返回（不等从库），写入快。半同步是主库写完后等至少一个从库收到 binlog（ack）才返回，多了一次网络往返（等 ack），写入延迟增加。如果从库在网络差的机房，ack 延迟可能几十毫秒，写入 P99 上升。半同步还有降级机制——如果从库在超时时间内没 ack（如 1 秒），主库降级为异步（避免一直等导致写入卡死）。所以半同步不是 100% 保证不丢数据——降级期间仍可能丢。半同步适合"大部分时间一致，偶尔降级可接受"的场景。如果要求绝对不丢数据（金融），要用全同步（MGR 多数派）或分布式共识，但性能代价更大。生产实践：主从同机房用半同步（延迟低），跨机房用异步（延迟高半同步代价大）。

## 常见考点

1. **MySQL 主从复制有几种方式？**——异步（默认，主库不等从库）、半同步（主库等至少 1 个从库 ack）、全同步（等所有从库，性能差）、组复制 MGR（Paxos 多数派）。生产同机房半同步，跨机房异步。
2. **主从延迟为什么会产生？**——异步复制本质是"主库先写，从库后追"，中间有时间差。来源：网络传输 binlog 延迟、从库 relay log replay 延迟（单线程串行）、大事务阻塞、从库慢查询阻塞。并行复制能显著降低 replay 延迟。
3. **读写分离和分库分表什么关系？**——读写分离是"读扩展"（加从库分摊读，不分数据），分库分表是"写扩展+数据分散"（按维度拆数据到多库）。可以组合——先读写分离（读量大），写量也大了再分库分表。ShardingSphere 同时支持两者。
4. **GTID 复制是什么？**——Global Transaction ID，每个事务有全局唯一 ID（server_uuid:transaction_id）。相比传统基于 binlog 位点的复制，GTID 让 failover 更简单（从库自动找未同步的事务），主从切换不用手动算位点。MySQL 5.6+ 支持，生产推荐开启。


## 结构化回答

**30 秒电梯演讲：** 聊到读写分离、主从延迟与一致性兜底，我的理解是——读写分离的本质是"写主库、读从库，用多个从库分摊读压力"。核心矛盾是主从复制延迟——写主库后从库异步同步有秒级延迟，导致"写完立即读不到"。兜底方案按一致性强度选：强一致场景走主库、容忍延迟用缓存过渡、跨机房用半同步复制。打个比方，像报社的"主编辑部 + 各地印刷厂"。记者写稿交主编辑部（写主库），各地印刷厂同步印刷（从库复制）。但同步有延迟（运输时间），可能出现"刚交稿去当地买报纸发现还没印"（写后读不到）。解法：重要新闻指定看主编辑部原稿（读主库），或等印刷完成通知（等待复制完成）。

**展开框架：**
1. **主从复制** — binlog → relay log → replay，异步（默认）或半同步
2. **复制延迟来源** — 网络、大事务、慢 SQL、从库单线程 replay
3. **写后读一致** — 强制读主库、缓存过渡（写后缓存标记）、半同步复制

**收尾：** 这块我在项目里也踩过坑——想深入的话，可以接着聊：Seconds_Behind_Master 是什么？您更想看哪个方向？

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡 | "读写分离、主从延迟与一致性兜底——这道题面试官到底想考什么？我用 30 秒给你讲透。" | 开场钩子 |
| 0:15 | SQL EXPLAIN 截图 | 先说核心：读写分离的本质是"写主库、读从库，用多个从库分摊读压力"。核心矛盾是主从复制延迟——写主库后从库异步同步有秒级延迟，导致"写完立即读不到"。兜底方案按一致性强度选：强一致场景走。 | 核心定义 |
| 0:40 | 延迟优化对比表 | 网络、大事务、慢 SQL、从库单线程 replay。 | 复制延迟来源 |
| 1:05 | 一致性协议对比表 | 强制读主库、缓存过渡（写后缓存标记）、半同步复制。 | 写后读一致 |
| 2:30 | 总结卡 | 一句话记忆：读写分离：写主库、读从库，分摊读压力。 下期可以接着聊：Seconds_Behind_Master 是什么。 | 收尾总结 |
