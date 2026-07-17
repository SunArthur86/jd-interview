---
id: java-architect-150
difficulty: L4
category: java-architect
subcategory: MySQL
title: MySQL 大事务、长事务与锁等待治理
tags: [大事务, 长事务, 锁等待, InnoDB, MDL]
related: [java-architect-149, java-architect-143, java-architect-141]
---

# MySQL 大事务、长事务与锁等待治理

> **场景**：京东结算系统，凌晨跑一个批量更新事务，扫了 1000 万行。期间从库延迟 2 小时，上午业务报错"锁等待超时"。面试官问：大事务、长事务、锁等待怎么治理？

## 一、概念层：三者的区别与危害

### 1.1 定义

| 概念 | 定义 | 危害 |
|------|------|------|
| **大事务** | 单事务影响行数多（如百万行更新） | Undo log 膨胀、binlog 膨胀、主从延迟 |
| **长事务** | 事务持续时间长（如几分钟-小时） | 占用 MDL、阻塞 DDL、Undo 版本链膨胀 |
| **锁等待** | 事务 A 等待事务 B 持有的锁 | 超时（50s 默认）、连接池耗尽、雪崩 |

三者关系：大事务→持续时间长→长事务→持有锁久→锁等待。

### 1.2 危害链条

```
大事务 → Undo log 持续增长 → 历史版本链过长 → 查询走老版本（慢查询）
       → binlog 单条过大 → 从库回放慢 → 主从延迟
       → 锁持有时间长 → 锁等待超时 → 业务报错
       → MDL 长期持有 → 阻塞 DDL → 后续 DDL 雪崩
```

## 二、机制层：InnoDB 锁与事务

### 2.1 锁的类型

| 锁 | 粒度 | 场景 |
|----|------|------|
| **共享锁（S）** | 行 | `SELECT ... LOCK IN SHARE MODE` |
| **排他锁（X）** | 行 | `UPDATE/DELETE/SELECT ... FOR UPDATE` |
| **意向锁（IS/IX）** | 表 | 行锁前的表级标记 |
| **记录锁** | 行 | 精确匹配索引 |
| **间隙锁（Gap）** | 范围 | `WHERE id BETWEEN 10 AND 20` |
| **临键锁（Next-Key）** | 范围 | 记录锁 + 间隙锁（RR 默认） |
| **插入意向锁** | 间隙 | INSERT 在 gap 内 |
| **自增锁（AUTO-INC）** | 表 | 自增主键插入 |
| **MDL（元数据锁）** | 表 | DDL/DML 互斥 |

### 2.2 锁等待诊断

```sql
-- 1. 查看当前所有事务
SELECT 
  trx_id, trx_state, trx_started, 
  TIME_TO_SEC(TIMEDIFF(NOW(), trx_started)) AS duration_sec,
  trx_rows_locked, trx_rows_modified,
  trx_query
FROM information_schema.innodb_trx
ORDER BY trx_started ASC;

-- 2. 查看锁等待关系（谁阻塞谁）
SELECT 
  r.trx_id AS waiting_trx_id,
  r.trx_mysql_thread_id AS waiting_thread,
  r.trx_query AS waiting_query,
  b.trx_id AS blocking_trx_id,
  b.trx_mysql_thread_id AS blocking_thread,
  b.trx_query AS blocking_query,
  TIMEDIFF(NOW(), b.trx_started) AS blocking_duration
FROM information_schema.innodb_lock_waits w
JOIN information_schema.innodb_trx b ON b.trx_id = w.blocking_trx_id
JOIN information_schema.innodb_trx r ON r.trx_id = w.requesting_trx_id;

-- 3. 查看行锁详情
SELECT * FROM performance_schema.data_locks;
SELECT * FROM performance_schema.data_lock_waits;

-- 4. 看完整锁状态
SHOW ENGINE INNODB STATUS\G
```

`SHOW ENGINE INNODB STATUS` 的核心输出：

```
------------
TRANSACTIONS
------------
Trx id counter 12345678
Trx #1: ACTIVE 1800 sec（活跃 30 分钟，长事务！）
  mysql tables in use 1, locked 1
  LOCK WAIT 2 lock struct(s), heap size 1136, 1 row lock(s)
  MySQL thread id 12345, OS thread handle 0x..., query id 67890 ...
  UPDATE t_order SET status='PAID' WHERE order_id IN (...10000 rows...)
  ------- TRX HAS BEEN WAITING 50 SEC TO OBTAIN LOCK（等了 50 秒）:
  RECORD LOCKS space id 100 page no 5 n bits 72 index PRIMARY of table `trade_order`.`t_order`
  trx id 12345678 lock_mode X（排他锁） waiting
```

### 2.3 MDL 诊断

```sql
-- MDL 等待（DDL 被长事务阻塞的典型场景）
SELECT * FROM performance_schema.metadata_locks 
WHERE OBJECT_SCHEMA='trade_order' AND OBJECT_NAME='t_order';

-- 谁持有 MDL
SELECT * FROM sys.schema_table_lock_waits;
```

## 三、实战层：JD 的治理实践

### 3.1 大事务拆分

```java
// 错误：一次性更新 1000 万行
@Transactional
public void batchUpdateBad() {
    List<Order> orders = mapper.selectAllPending();  // 1000w
    for (Order o : orders) {
        o.setStatus("SETTLED");
        mapper.update(o);
    }
}

// 正确：分批提交，每批 1000 行
public void batchUpdateGood() {
    int batchSize = 1000;
    long lastId = 0;
    while (true) {
        List<Order> batch = mapper.selectPendingAfter(lastId, batchSize);
        if (batch.isEmpty()) break;
        
        transactionTemplate.execute(status -> {
            for (Order o : batch) {
                o.setStatus("SETTLED");
                mapper.update(o);
            }
            return null;
        });
        
        lastId = batch.get(batch.size() - 1).getId();
        // 批间休眠，给从库追平时间
        sleep(100);
    }
}
```

### 3.2 长事务监控告警

```java
// Spring Boot 拦截长事务
@Aspect
@Component
public class LongTransactionMonitor {
    private static final long WARN_THRESHOLD_MS = 5000;
    private static final long KILL_THRESHOLD_MS = 30_000;
    
    @Around("@annotation(transactional)")
    public Object monitor(ProceedingJoinPoint pjp, Transactional transactional) throws Throwable {
        long start = System.currentTimeMillis();
        try {
            return pjp.proceed();
        } finally {
            long elapsed = System.currentTimeMillis() - start;
            if (elapsed > WARN_THRESHOLD_MS) {
                monitor.alert("LONG_TRANSACTION", 
                    pjp.getSignature().toShortString(), elapsed);
            }
        }
    }
}
```

定时 SQL 巡检：

```sql
-- 每分钟扫描，找活跃 > 5 分钟的事务
SELECT trx_id, trx_mysql_thread_id, trx_started, trx_query
FROM information_schema.innodb_trx
WHERE TIME_TO_SEC(TIMEDIFF(NOW(), trx_started)) > 300;
-- 告警 + 自动 kill
```

### 3.3 锁等待治理 SOP

```
1. 告警触发（Threads_running 飙升 / 业务报错）
2. 定位：SHOW ENGINE INNODB STATUS → 找 blocking_trx
3. 评估：
   - blocking 是正常业务 → 等它完成
   - blocking 是异常（bug/恶意） → kill
4. kill 阻塞源：KILL <thread_id>
5. 观察锁等待是否释放
6. 复盘：优化 SQL（加索引/缩小范围）
```

```bash
# 自动化 kill 锁等待超 60s 的源头
#!/bin/bash
while true; do
  mysql -h master -N -e "
    SELECT CONCAT('KILL ', b.trx_mysql_thread_id, ';')
    FROM information_schema.innodb_lock_waits w
    JOIN information_schema.innodb_trx b ON b.trx_id = w.blocking_trx_id
    JOIN information_schema.innodb_trx r ON r.trx_id = w.requesting_trx_id
    WHERE TIME_TO_SEC(TIMEDIFF(NOW(), r.trx_wait_started)) > 60
  " | mysql -h master
  sleep 10
done
```

### 3.4 关键参数调优

```ini
# my.cnf
innodb_lock_wait_timeout = 30              # 锁等待超时 30s（默认 50s）
innodb_rollback_on_timeout = ON            # 超时回滚整个事务
max_execution_time = 30000                 # SELECT 超时 30s
innodb_deadlock_detect = ON                # 死锁检测（高并发可能关闭）
lock_wait_timeout = 60                     # MDL 等待超时
transaction_isolation = READ-COMMITTED     # RC 减少间隙锁（JD 订单库用 RC）
```

JD 订单库从 RR 改 RC 的收益：间隙锁消失 → 死锁减少 80%、并发提升 30%。

## 四、底层本质：MVCC 与锁的权衡

### 4.1 First Principle：锁是为隔离服务的

InnoDB 的锁不是"为了锁而锁"，而是为了实现**事务隔离级别**：
- RR（可重复读）：Next-Key 锁防止幻读，但并发度低
- RC（读已提交）：只有记录锁，无间隙锁，并发度高

JD 订单库选择 RC + 业务幂等，是"用业务层换数据库层"的经典权衡。

### 4.2 为什么长事务是万恶之源

```
长事务 → 持有锁久 → 锁等待 → 雪崩
       → Undo log 版本链长 → 查询走老版本 → 慢查询
       → MDL 长期持有 → DDL 阻塞 → 后续变更雪崩
       → binlog 单事务巨大 → 从库回放慢 → 主从延迟
```

一个长事务可能引发四种问题，所以**长事务治理是数据库稳定性的核心**。

### 4.3 Feynman 解释

把数据库事务想象成"图书馆借书"。
- 大事务：一次借 1 万本书，搬不动、记不清、还拖累别人。
- 长事务：借了一本书看 3 个月，别人想借只能等（锁等待），馆长想整理书架（DDL）也动不了（MDL）。
- 锁等待：A 借了书，B 想借只能等 A 还；A 借太久，B 等得抓狂。

治理思路：少借、快还、按时归还（拆分小事务、快速提交、超时回滚）。

## 五、AI 架构师加问

**Q1：RR 和 RC 在锁上有什么区别？**
- RR：Next-Key 锁（记录锁 + 间隙锁），防止幻读，但锁范围大、并发低
- RC：只有记录锁，无间隙锁，并发高，但有幻读（业务侧用 `FOR UPDATE` 解决）

JD 订单库从 RR 改 RC 后，死锁减少 80%、并发提升 30%。

**Q2：死锁怎么排查？**
```sql
SHOW ENGINE INNODB STATUS\G
-- 找 LATEST DETECTED DEADLOCK 段，看两个事务的 SQL 和持有/等待的锁
```
典型死锁：两个事务以不同顺序更新同一批行。解决：统一加锁顺序。

**Q3：批量更新 1000 万行如何不阻塞业务？**
- 分批提交（每批 1000-5000 行）
- 批间休眠（给从库追平时间）
- 低峰期执行
- 用乐观锁代替行锁（version 字段）

**Q4：高并发下死锁检测成为瓶颈怎么办？**
MySQL 8 可以关闭 `innodb_deadlock_detect=OFF`，靠 `innodb_lock_wait_timeout` 兜底。但需要业务能接受锁等待超时回滚。JD 高并发场景（库存扣减）已用 Redis 替代 DB 行锁。

**Q5：为什么不能在事务里调用远程接口？**
- 远程接口慢 → 事务时间长 → 长事务
- 远程失败 → 事务回滚（但远程操作不可回滚，数据不一致）
- 正确：先本地事务提交，再调远程；或用 Outbox 模式（见 140 题）

## 六、记忆口诀

```
大事务拆小批，长事务勤提交，锁等待秒回滚。
SHOW ENGINE INNODB STATUS，找源头 KILL 线程。
RR 间隙锁范围大，RC 记录锁并发高。
事务里别调远程，Outbox 模式更稳。
JD 订单改 RC，死锁减八成，并发升三成。
长事务是万恶源，Undo/MDL/binlog 全受牵连。
```

## 七、苏格拉底追问

| 层级 | 问题 | 关键答案 |
|------|------|----------|
| L1 表象 | 大事务有什么危害？ | Undo 膨胀、binlog 大、主从延迟、锁持有久 |
| L2 机制 | InnoDB 行锁怎么实现？ | 索引上的记录锁/间隙锁/临键锁 |
| L3 边界 | RR 和 RC 锁的区别？ | RR 有间隙锁防幻读；RC 只有记录锁并发高 |
| L4 权衡 | 为什么 JD 订单用 RC？ | 死锁减 80%、并发升 30%，业务用幂等弥补幻读 |
| L5 反例 | 事务里调 RPC 会怎样？ | RPC 慢→长事务；RPC 失败→数据不一致 |
| L6 极限 | 1000 万行更新不阻塞业务？ | 分批提交 + 低峰执行 + 乐观锁 |
| L7 系统 | 全局锁监控体系怎么搭？ | innodb_trx + lock_waits + data_locks 三表联查 + 告警 + 自动 kill |

**对话还原**：
> 面试官：长事务怎么治理？
> 我：三招——Spring AOP 拦截 > 5s 告警；定时 SQL 巡检活跃 > 5min 的事务；分批提交避免大事务。
> 面试官：发现锁等待怎么办？
> 我：SHOW ENGINE INNODB STATUS 找阻塞源头，评估后 kill。JD 有自动化脚本，锁等待 > 60s 自动 kill 源头。
> 面试官：RR 和 RC 怎么选？
> 我：我们订单库用 RC。间隙锁消失，死锁减 80%，并发升 30%。幻读问题业务用 SELECT FOR UPDATE 解决。
> 面试官：事务里能调 RPC 吗？
> 我：不能。RPC 慢导致长事务，RPC 失败导致数据不一致。我们用 Outbox 模式，事务只写本地表，CDC 异步发 RPC。
> 面试官：1000 万行批量更新怎么做？
> 我：分批 5000 行，批间休眠 100ms，低峰执行。

## 八、常见考点

1. **大事务/长事务/锁等待的定义** —— 三者递进关系
2. **SHOW ENGINE INNODB STATUS** —— 必会诊断命令
3. **innodb_trx + lock_waits 联查** —— 锁等待定位
4. **RR vs RC 锁差异** —— 间隙锁是关键
5. **分批提交** —— 大事务标准解法
6. **事务里不能调 RPC** —— 经典反模式
7. **锁等待超时治理 SOP** —— 定位→评估→kill→复盘
8. **关键参数** —— innodb_lock_wait_timeout、transaction_isolation

## 结构化回答




**30 秒电梯演讲：** 长事务是数据库稳定性的万恶之源——一个长事务能同时引爆 Undo 版本链膨胀、MDL 长期持有阻塞 DDL、binlog 巨大拖垮从库、锁持有久导致锁等待雪崩四颗雷。JD 结算治理就三招：大事务拆小批、长事务勤提交、锁等待秒回滚。

**展开框架：**
1. **大事务拆分提交** — 一次性扫 1000 万行的批量更新改为按主键游标分批，每批 1000-5000 行独立事务提交，批间休眠 100ms 给从库追平时间，低峰期执行
2. **长事务监控拦截** — Spring AOP 拦截 @Transactional，执行 > 5s 告警、> 30s kill；定时 SQL 巡检 `innodb_trx` 活跃 > 5min 的事务自动处理；事务里禁止调 RPC（用 Outbox 模式解耦）
3. **锁等待定位治理** — `SHOW ENGINE INNODB STATUS` + `innodb_trx/innodb_lock_waits/data_locks` 三表联查定位阻塞源；JD 订单库从 RR 改 RC，间隙锁消失，死锁减 80%、并发升 30%；自动化脚本锁等待 > 60s 自动 kill 源头

**收尾：** 一句话定调——RR 防幻读用间隙锁，RC 用业务幂等换并发，您想深入哪一段？





## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：MySQL 大事务、长事务与锁等待治理 | "这题一句话：京东结算系统，凌晨跑一个批量更新事务，扫了 1000 万行。" | 开场钩子 |
| 0:15 | 大事务/长事务/锁等待的定义示意/对比图 | "大事务/长事务/锁等待的定义 —— 三者递进关系" | 大事务/长事务/锁等待的定义要点 |
| 0:40 | SHOW ENGINE示意/对比图 | "SHOW ENGINE INNODB STATUS —— 必会诊断命令" | SHOW ENGINE要点 |
| 1:05 | innodb_trx +示意/对比图 | "innodb_trx + lock_waits 联查 —— 锁等待定位" | innodb_trx +要点 |
| 1:30 | 要点 4 详解 | "这部分看正文对比表和代码示例。" | 要点 4 |
| 1:55 | 总结卡 | "记住：大事务/长事务/锁等待的定义。下期见。" | 收尾 |
