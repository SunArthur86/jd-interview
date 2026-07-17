---
id: ant-risk-009
difficulty: L3
category: ant-risk
subcategory: MySQL
tags:
- 蚂蚁
- 风控
- MySQL
- 事务
- MVCC
- 隔离级别
feynman:
  essence: InnoDB 用 undo log + read view 实现 MVCC，让读写互不阻塞：每行有多个历史版本，事务按"开始时的快照"读，写通过版本链+隐藏列维护。
  analogy: MVCC 像维基百科的版本历史——每篇文章（行）有多个历史版本，读者读"快照时刻的版本"，作者改出新版本不冲突。
  first_principle: 数据库要同时保证 ACID 和高并发，加锁会让读写互相阻塞。MVCC 让读不加锁、写用版本链，从架构上消除读写竞争。
  key_points:
  - 4 级隔离：读未提交 / 读已提交（RC）/ 可重复读（RR，InnoDB 默认）/ 串行化
  - RR 通过 read view 在事务首次读时建立，整个事务复用 → 可重复读
  - RC 每次 select 都新建 read view → 能看到最新已提交
  - 隐藏列 trx_id（最近修改事务ID）、roll_pointer（指向 undo 版本链）
  - InnoDB 在 RR 下用 Next-Key Lock 解决幻读
first_principle:
  problem: 如何让读写并发不互相阻塞，且不同隔离级别下读到的数据语义可控？
  axioms:
  - 读用锁会阻塞写，性能差
  - 每次修改保留历史版本，可让读按"某个时刻"的快照读
  - 事务有"开始时间"概念，决定看到哪些版本
  rebuild: 每行存版本链（undo log 链表），事务读时根据"事务开始时活跃事务列表"判定哪个版本对自己可见。RC 每次读重建可见性列表（看最新），RR 只建一次（看快照）。
follow_up:
- 为什么 InnoDB 默认 RR 而不是 RC？——历史原因（binlog 主从复制要 RR 才能正确），现在 row-based binlog 下 RC 也安全；阿里 OB 默认 RC
- 幻读怎么解决？——RR 下 InnoDB 用 Next-Key Lock（行锁+间隙锁）锁住范围，阻止插入
- 长事务为什么危险？——undo 版本链无法 purge，导致回滚段膨胀、备份变慢
memory_points:
- RR 默认隔离级别，read view 在事务首次读时建立后复用
- RC 每次读都新建 read view，所以能看到新提交
- 隐藏列 trx_id + roll_pointer 维护版本链
- Next-Key Lock = Record Lock + Gap Lock（RR 解决幻读）
---

# 【蚂蚁风控】MySQL 事务隔离级别？MVCC 原理？InnoDB 怎么解决幻读？

> JD 依据："MySQL"。风控的转账、规则匹配、风险扣款都是事务场景，MVCC 是必考。

## 一、表面层：四个隔离级别

| 隔离级别 | 脏读 | 不可重复读 | 幻读 |
|---------|------|-----------|------|
| 读未提交（RU） | ✗ 可能 | ✗ 可能 | ✗ 可能 |
| 读已提交（RC） | ✓ 避免 | ✗ 可能 | ✗ 可能 |
| 可重复读（RR） | ✓ 避免 | ✓ 避免 | ✓ 避免（InnoDB） |
| 串行化（S） | ✓ 避免 | ✓ 避免 | ✓ 避免 |

- **脏读**：读到未提交的数据
- **不可重复读**：同一事务两次读结果不同（其他事务 update 了）
- **幻读**：同一事务两次范围查询结果集不同（其他事务 insert 了）

**InnoDB 默认 RR**。

## 二、MVCC 是什么

MVCC（Multi-Version Concurrency Control）让**读不加锁**：每行有多个历史版本，读按快照读，写创建新版本。

**InnoDB 实现的三要素**：

1. **隐藏列**（每行）：
   - `DB_TRX_ID`：最近修改这行的事务 ID
   - `DB_ROLL_PTR`：指向 undo log 里的旧版本
   - `DB_ROW_ID`：隐含主键（无主键时）

2. **undo log 版本链**：
   ```
   当前行: trx_id=200, data="新值"
      ↑ roll_ptr
   undo: trx_id=150, data="旧值"
      ↑ roll_ptr
   undo: trx_id=100, data="更旧"
   ```

3. **Read View**（读视图）：
   - 事务读时建立，记录"当前活跃事务列表"
   - 包含：`m_ids`（活跃事务ID）、`min_trx_id`、`max_trx_id`、`creator_trx_id`

## 三、可见性判定算法

读某行时，沿版本链找到第一个**对自己可见**的版本：

```
判定规则（对版本的 trx_id = T）：
1. T == creator_trx_id        → 自己改的，可见
2. T < min_trx_id             → 已提交的旧事务，可见
3. T >= max_trx_id            → 未来事务，不可见 → 找上一版本
4. min_trx_id <= T < max_trx_id:
   - T 在 m_ids 中             → 还活跃，不可见 → 找上一版本
   - T 不在 m_ids 中           → 已提交，可见
```

## 四、RC vs RR 的关键差异

**唯一差异：read view 的建立时机**。

| 隔离级别 | read view 建立 | 效果 |
|---------|---------------|------|
| RC | **每次 SELECT 都建立** | 每次都能看到最新已提交 |
| RR | **事务第一次 SELECT 建立，整个事务复用** | 整个事务看快照，可重复读 |

**示例**：
```
事务A 开启
事务A: SELECT * FROM t WHERE id=1;  -- 假设读到 value=10

事务B: UPDATE t SET value=20 WHERE id=1; COMMIT;

RC: 事务A: SELECT ... → value=20   （新 read view，看到 B 的提交）
RR: 事务A: SELECT ... → value=10   （复用旧 read view，看快照）
```

## 五、幻读与 Next-Key Lock

RR 级别下，**快照读**用 MVCC 不会幻读（看快照），但**当前读**（`SELECT ... FOR UPDATE`、UPDATE、DELETE）需要锁来防幻读。

**Next-Key Lock = Record Lock + Gap Lock**：
```sql
-- 表 t 有 id=5, 10, 15
SELECT * FROM t WHERE id BETWEEN 7 AND 12 FOR UPDATE;
-- 锁住: (5,10], (10,15]  → 区间 (5,15) 都不能插入
```

- **Record Lock**：锁住已有行（id=10）
- **Gap Lock**：锁住间隙（(5,10), (10,15)）
- 阻止其他事务在间隙 INSERT，从而避免幻读

**RC 没有 Gap Lock**（所以 RC 可能幻读，但并发更高）。

## 六、风控实战：事务场景

**场景 1：风险扣款事务**
```sql
START TRANSACTION;

-- 1. 查用户余额（当前读，加行锁）
SELECT balance FROM account WHERE uid = 500 FOR UPDATE;

-- 2. 检查风控规则（无锁，用 MVCC 快照读）
SELECT COUNT(*) FROM risk_event WHERE uid = 500 AND status = 1 AND created_at > NOW() - INTERVAL 1 HOUR;

-- 3. 扣款
UPDATE account SET balance = balance - 100 WHERE uid = 500;

-- 4. 记录流水
INSERT INTO trade_log(uid, amount, ...) VALUES (500, -100, ...);

COMMIT;
```

**关键点**：
- 余额用 `FOR UPDATE` 加行锁（防超卖）
- 风控规则用快照读（不影响其他事务的写）
- 整个事务保证原子性

**场景 2：长事务的坑**

风控跑批任务：开了事务处理 1 小时 → undo 版本链膨胀 10GB → 备份变慢、回滚段占满。

**解决**：拆分批事务（每 1000 条 commit 一次）。

## 七、底层本质：MVCC 的"版本即时间"哲学

MVCC 本质是**"不可变数据 + 时间快照"**：
- 每次修改不原地改，而是创建新版本（类似 git commit）
- 读按时间点（read view）看历史版本
- 读写天然不冲突（读看历史、写创新版本）

这是函数式编程"不可变"思想在数据库的体现：
- **写不阻塞读**：读看快照
- **读不阻塞写**：读不加锁
- **不同事务看不同版本**：各自快照

代价是 undo log 膨胀——所以必须有 purge 线程清理"无事务再需要"的旧版本。

**对比"全锁"方案**：用悲观锁让所有读写串行，ACID 最强但并发弱；MVCC 在 ACID 和并发间取平衡，成为 OLTP 数据库的事实标准。

## 八、为什么 InnoDB 默认 RR（历史 + 现状）

**历史原因**：MySQL 早期 binlog 是 statement 格式，**statement binlog 必须配合 RR**——因为 RC 隔离下并发语句的执行顺序在从库回放时无法复现，会导致主从不一致；RR 让事务串行化，语句顺序确定才安全。后来引入 ROW 格式（记行变更而非语句），与隔离级别无关，RC + ROW 也安全，所以现代互联网公司多改用 RC 提升并发。

**现状**：row-based binlog 下 RC 也安全，主流互联网公司（阿里、字节）默认改 RC，因为 RC 没有 Gap Lock 并发更高。

**风控的选择**：通常 RC（少 Gap Lock，并发高）+ 业务幂等设计（防幻读带来的问题）。

## 常见考点
1. **快照读和当前读区别**？——快照读（普通 SELECT）用 MVCC；当前读（FOR UPDATE / UPDATE / DELETE）读最新且加锁。
2. **MVCC 解决了幻读吗**？——只解决了快照读幻读；当前读仍需 Next-Key Lock。
3. **statement binlog 和 RR 是什么关系**？——**statement 必须配 RR**（RC 下并发语句顺序在从库不可复现）；ROW 模式记的是行变更数据，与隔离级别无关，所以 ROW + RC 也安全。现代趋势是 ROW + RC 提升并发。

**代码示例**（乐观锁替代悲观锁）：
```sql
-- 用 version 字段实现乐观锁（无锁并发，失败重试）
UPDATE account SET balance = balance - 100, version = version + 1
WHERE uid = 500 AND version = 10;  -- 影响行数=0 说明被改过，需重试
```

## 苏格拉底式面试追问

> 这组追问不是背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：风控的扣款事务你用 RR（InnoDB 默认）+ SELECT FOR UPDATE 做悲观锁，而不是 RC + 乐观锁（version 字段）。决策依据是什么？为什么风控扣款场景偏向悲观？**

风控扣款是强一致性场景——余额不能超扣（超扣=资损）、不能少扣（少扣=风险漏放）。乐观锁依赖"冲突时重试"，但扣款场景如果两个并发请求同时扣同一账户，乐观锁会让其中一个重试（version 不匹配），重试期间用户可能在另一端发起了第二笔，重试逻辑复杂且容易出错（重试时要重新检查风控规则、重新算余额）。悲观锁 SELECT FOR UPDATE 直接串行化，逻辑简单——查余额、检查规则、扣款，全程持锁，第二个请求等待第一个提交后才继续。风控对正确性的要求高于对并发的要求（同一账户的并发扣款本来就不多，大部分是不同账户），所以选悲观。决策依据是冲突率——实测同一账户并发扣款概率 <1%，悲观锁的等待代价可忽略，而乐观锁的重试逻辑复杂度 + 潜在的资损风险不值得。

### 第二层：证据与定位

**Q：风控扣款服务突然大面积超时，RT 从 50ms 飙到 5 秒。你怎么确认是锁等待（MVCC 相关）还是别的？**

两组证据定位锁等待：
1. `SHOW ENGINE INNODB STATUS` 看 TRANSACTIONS 段——如果大量事务状态是 `LOCK WAIT`，且 `PROCESSLIST` 里显示等待时间长（>1s），是锁等待。看 `mysql.innodb_lock_waits` 视图（`SELECT * FROM performance_schema.data_lock_waits` 8.0+）能看到谁等谁的锁、等的是什么锁。
2. `SHOW PROCESSLIST` 看线程状态——如果大量线程状态是 `Waiting for lock`，且都是同一张表（account），是锁竞争。进一步用 `SELECT * FROM information_schema.innodb_trx` 看活跃事务的执行时间和等待状态，找出"持锁最久的事务"（`trx_started` 字段早于其他事务的即为罪魁）。
如果排除了锁等待（没有 LOCK WAIT），再看慢查询日志是否是 SQL 本身慢、或 buffer pool miss 导致 IO 高。

### 第三层：根因深挖

**Q：你定位到是 account 表的行锁等待——事务 A 持有 uid=500 的行锁 3 秒不释放，几十个事务排队等。根因是什么？为什么事务 A 持锁这么久？**

行锁持锁久通常是事务里有慢操作。看事务 A 的 `innodb_trx.trx_query` 字段——它在执行什么 SQL。真实案例常见根因：事务 A 在 FOR UPDATE 之后调了一个外部 RPC（如风控规则引擎的远程调用），RPC 抖动耗时 3 秒，期间行锁不释放（事务没提交）。根因是"事务里包了远程调用"，把一个本该几十毫秒的本地事务撑到 3 秒。这是 MVCC/锁机制的典型误用——事务边界不该跨越网络调用。验证方法：看事务 A 持锁期间的应用日志，如果有 `call rule-engine cost 3000ms` 的记录，实锤。

**Q：根因是事务里有 RPC。那为什么不把 RPC 移出事务？不查余额（FOR UPDATE）怎么保证不超扣？**

RPC 必须移出事务，但要重新设计扣款的正确性保证。方案是把扣款拆成两阶段：阶段一（无事务）——查余额（快照读）+ 调风控规则 RPC + 算出扣款金额；阶段二（短事务）——`UPDATE account SET balance=balance-100 WHERE uid=500 AND balance>=100`，用 WHERE 条件保证不超扣（影响行数=0 说明余额不够，回滚业务）。这样事务里只有一个 UPDATE 语句（毫秒级），持锁极短，但通过"WHERE balance >= amount"的条件保证原子性。代价是放弃了"先锁后查"的悲观语义，改用"条件更新"的乐观语义，但风控扣款本来就要求"余额不足则失败"，这个语义天然契合。这就是为什么很多支付系统用"UPDATE ... WHERE balance >= ?"而不是"SELECT FOR UPDATE + UPDATE"。

### 第四层：方案权衡

**Q：你改成了 UPDATE WHERE balance >= amount，但业务说有些场景要先查余额展示给用户（"您的余额 1000 元"），然后扣款时余额变了（其他人扣了 600），用户以为能扣 1000 结果失败。怎么权衡？**

这是展示一致性 vs 并发性能的权衡。展示的余额是"快照"，扣款时用"当前"，中间可能有变化。三种权衡方案：
1. 乐观展示——展示时快照读余额（无锁），扣款用 UPDATE WHERE，失败提示"余额已变化，请重试"。代价是用户体验差（看到余额但扣款失败），适合低频场景。
2. 预占额度——展示时先 `INSERT INTO hold(uid, amount) VALUES(500, 100)` 预占 100，余额展示=balance-hold，扣款时核销 hold。这是电商/支付的主流方案（如支付宝的"冻结-扣减"两阶段），保证展示和扣款一致。代价是多一张 hold 表 + 超时清理逻辑。
3. 短事务重试——展示快照读，扣款如果失败，快速重试一次（读最新余额再扣），重试仍失败才提示用户。适合冲突率极低的场景。
风控扣款我们选方案 2（预占额度）——因为风控扣款是交易链路的一环，用户体验要求高（不能"看到余额却扣失败"），且预占表的开销（一张表 + 超时清理）可接受。

**Q：为什么不直接用 RC（读已提交）替代 RR，少一些 Gap Lock，并发更高？预占额度方案在 RC 下不也能工作吗？**

确实可以，且我们风控的 MySQL 实际就是 RC。RC 相比 RR 的优势：没有 Gap Lock（间隙锁），并发插入更高；死锁概率更低（Gap Lock 是死锁的主要来源之一）。RR 的 Gap Lock 在风控场景反而有害——比如批量插入风险事件时，RR 的 Next-Key Lock 会锁住更大范围，阻塞并发插入。RC 的代价是"不可重复读"和"幻读"，但风控的扣款用 UPDATE WHERE 保证原子性（不依赖可重复读），批量查询用业务幂等保证（不依赖防幻读），所以 RC 的缺点可规避。切换依据：压测对比 RC vs RR 在风控写入 QPS 下的表现，RC 高约 30%（无 Gap Lock 的锁开销）。所以风控用 RC + 业务层幂等，而不是依赖 RR 的数据库层一致性。

### 第五层：验证与沉淀

**Q：你怎么证明改成"UPDATE WHERE + 预占额度"后，扣款既快又没超扣？怎么验证正确性？**

正确性 + 性能双验证：
1. 超扣测试——写一个并发测试：1000 个线程同时对 uid=500 扣款（余额初始 1000，每次扣 10），跑完后 `SELECT balance FROM account WHERE uid=500`，断言 balance >= 0（不能负数）。同时统计成功扣款数 × 10 + 剩余 balance = 1000（守恒）。如果守恒且 balance >= 0，正确性证明。
2. 性能对比——JMeter 压测同 QPS，对比优化前（SELECT FOR UPDATE + RPC in tx）和优化后（UPDATE WHERE + RPC out tx）的 RT P99 和吞吐。优化前 P99 可能 3 秒（锁等待），优化后 P99 < 50ms（无锁等待），吞吐提升 5-10 倍。
3. 锁等待监控——上线后观察 `innodb_row_lock_time_avg`（平均行锁等待时间），从优化前的 2000ms 降到 <10ms；`innodb_row_lock_waits`（锁等待次数）从每天几万次降到几百次。

**Q：怎么让团队以后不在事务里写 RPC、不滥用锁？**

沉淀成规范和工具：
1. 事务规范——明确"事务边界内禁止 RPC/HTTP/长时间计算"，事务只包含数据库操作。Code Review 用静态检查（Spring 的 @Transactional 方法内不能有 RestTemplate/Feign 调用），命中即告警。
2. 事务超时配置——所有 @Transactional 必须设 timeout（如 5 秒），超时自动回滚，防长事务持锁。用 `@Transactional(timeout=5)`。
3. 锁等待监控——Prometheus 采集 `mysql_global_status_innodb_row_lock_time_avg` 和 `innodb_row_lock_waits`，平均锁等待 >100ms 告警，自动归因到持锁事务的 SQL。
4. 死锁告警——开启 `innodb_print_all_deadlocks=ON`，死锁日志进 error log，自动解析告警 + 复盘。
5. 故障复盘——把这次"事务里 RPC 持锁 3 秒 → 几十事务排队 → 扣款超时"的 innodb_trx 截图、锁等待链路存知识库，作为"事务必须短"的标准案例。


## 结构化回答


**30 秒电梯演讲：** MVCC 像维基百科的版本历史——每篇文章（行）有多个历史版本，读者读"快照时刻的版本"，作者改出新版本不冲突。

**展开框架：**
1. **4 级隔离** — 读未提交 / 读已提交（RC）/ 可重复读（RR，InnoDB 默认）/ 串行化
2. **RR 通过 read** — view 在事务首次读时建立，整个事务复用 → 可重复读
3. **RC 每次 select** — 都新建 read view → 能看到最新已提交

**收尾：** 为什么 InnoDB 默认 RR 而不是 RC？


## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡 | "MySQL 事务隔离级别——这道题面试官到底想考什么？我用 30 秒给你讲透。" | 开场钩子 |
| 0:15 | SQL EXPLAIN 截图 | 先说核心：InnoDB 用 undo log + read view 实现 MVCC，让读写互不阻塞：每行有多个历史版本，事务按"开始时的快照"读，写通过版本链+隐藏列维护。 | 核心定义 |
| 0:40 | 事务隔离级别对比表 | RR 通过 read view 在事务首次读时建立，整个事务复用 → 可重复读。 | RR 通过 read view 在事 |
| 1:05 | MVCC 版本链图 | 能看到最新已提交。 | RC 每次 select 都新建 rea |
| 2:30 | 总结卡 | 一句话记忆：RR 默认隔离级别，read view 在事务首次读时建立后复用。 下期可以接着聊：为什么 InnoDB 默认 RR 而不是 RC。 | 收尾总结 |
