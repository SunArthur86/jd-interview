---
id: java-architect-201
difficulty: L3
category: java-architect
subcategory: MySQL
tags:
- Java 架构师
- MySQL
- 死锁
- 事务证据链
feynman:
  essence: 线上频繁死锁告警时，架构师要能用 MySQL 自带的"证据链"还原死锁现场——从 SHOW ENGINE INNODB STATUS 拿最近一次死锁详情（两个事务 + 等待锁 + 持有锁 + 被回滚事务），用 performance_schema.data_lock_waits/data_locks 还原锁等待图（waiting_trx_id → blocking_trx_id），用 threads JOIN events_statements_history_long 把事务 ID 映射回具体 SQL 文本，最后定位到"哪两类 SQL 加锁顺序相反形成环"。核心不是背"死锁是互相等待"，而是能在生产环境把证据一条条串起来。
  analogy: 像刑侦破案——死锁是案发现场（有尸体=回滚的事务），SHOW ENGINE INNODB STATUS 是现场勘查报告（谁和谁冲突），performance_schema.data_lock_waits 是监控录像（锁等待图），events_statements_history_long 是通讯记录（事务执行过哪些 SQL）。把三份证据串起来，才能锁定"凶手"（加锁顺序相反的两类业务 SQL）。
  first_principle: MySQL InnoDB 检测到死锁会自动回滚代价较小的事务，并把死锁现场记录在 LATEST DETECTED DEADLOCK。但只看最近一次不够——频繁死锁要打开 innodb_print_all_deadlocks 收集全部，再结合 data_lock_waits/data_locks 还原锁等待图，用 events_statements_history_long 把事务映射回 SQL。证据链完整才能定位根因（加锁顺序/事务过长/索引缺失），对症修复。
  key_points:
  - 第一现场：SHOW ENGINE INNODB STATUS 的 LATEST DETECTED DEADLOCK
  - 锁等待图：performance_schema.data_lock_waits JOIN data_locks
  - SQL 还原：threads JOIN events_statements_history_long
  - 全量收集：SET GLOBAL innodb_print_all_deadlocks = ON
  - 根因：加锁顺序相反 / 事务过长 / 索引缺失导致范围锁扩大
first_principle:
  problem: 线上频繁死锁告警，如何从 MySQL 信息中拿到证据，定位是哪两类 SQL、哪两个事务发生了死锁？
  axioms:
  - InnoDB 检测到死锁会自动回滚一个事务（选 undo 量小的）
  - 死锁现场记录在 SHOW ENGINE INNODB STATUS 的 LATEST DETECTED DEADLOCK
  - performance_schema 保留实时的锁等待和持有关系（data_lock_waits/data_locks）
  - events_statements_history_long 保留线程最近执行的 SQL 历史
  - 死锁根因是"两个事务加锁顺序相反形成环"，不是"锁本身有问题"
  rebuild: 三步证据链。第一步拿第一现场——SHOW ENGINE INNODB STATUS\G 看 LATEST DETECTED DEADLOCK 的两个 TRANSACTION、等待锁、持有锁。第二步还原锁等待图——performance_schema.data_lock_waits JOIN data_locks，确认事务 A 等 B、B 等 A 形成环。第三步映射回 SQL——threads JOIN events_statements_history_long，定位是哪两类业务 SQL 加锁顺序相反。频繁死锁打开 innodb_print_all_deadlocks 收集全部，结合应用 traceId 定位业务链路。
follow_up:
  - SHOW ENGINE INNODB STATUS 只保留最近一次死锁怎么办？——SET GLOBAL innodb_print_all_deadlocks = ON，从 error log 收集全部
  - performance_schema.data_locks 是空的？——确认 MySQL 版本（5.7 用 information_schema.innodb_locks），且 performance_schema 已开启
  - 事务 ID 映射回 SQL 查不到？——events_statements_history_long 默认只保留最近 10000 条，可能被覆盖。调大参数或案发时立即查
  - 定位到两类 SQL 后怎么修复？——统一加锁顺序（所有链路先 A 后 B）、缩短事务、补索引避免范围锁
  - 死锁能完全消除吗？——不能完全消除（并发必然有竞争），但要控制频率（死锁告警阈值 < 10 次/分钟），且业务侧做幂等重试
memory_points:
  - 第一现场：SHOW ENGINE INNODB STATUS\G → LATEST DETECTED DEADLOCK
  - 锁等待图：data_lock_waits JOIN data_locks（waiting → blocking）
  - SQL 还原：threads JOIN events_statements_history_long
  - 全量收集：innodb_print_all_deadlocks = ON → error log
  - 根因修复：统一加锁顺序 / 缩短事务 / 补索引 / 队列串行化
---

# 【Java 后端架构师】线上频繁死锁告警：如何用 MySQL 证据链定位死锁

> 适用场景：JD 核心技术。线上死锁告警频繁，不能只看"死锁是互相等待"的概念，要能用 MySQL 自带的证据链（SHOW ENGINE INNODB STATUS、performance_schema、events_statements_history_long）一步步还原现场，定位到具体哪两类 SQL、哪两个事务、哪两个资源互相等待，最后给出修复方案。

## 一、概念层：死锁证据链总览

### 1.1 死锁的本质与 InnoDB 的处理

```
死锁形成（两个事务加锁顺序相反）

时间线：
  T1: BEGIN;
  T1: UPDATE account SET ... WHERE id=1;  -- 持有 account.id=1 的 X 锁
                                            │
  T2: BEGIN;                                │
  T2: UPDATE account SET ... WHERE id=2;  -- 持有 account.id=2 的 X 锁
                                            │
  T1: UPDATE account SET ... WHERE id=2;  -- 等 id=2 的锁（T2 持有）
                                            │   T1 等 T2
  T2: UPDATE account SET ... WHERE id=1;  -- 等 id=1 的锁（T1 持有）
                                            │   T2 等 T1  ← 形成环！
  ▼
InnoDB 死锁检测器发现环 → 自动回滚 undo 量小的事务（假设回滚 T2）
  ▼
T1 获得 id=2 锁，继续执行；T2 收到 deadlock error（1213）
```

**InnoDB 处理**：
- 自动检测（wait-for graph 算法，O(n) 复杂度）
- 自动回滚（选 undo log 量小的事务，代价低）
- 记录现场（LATEST DETECTED DEADLOCK 段）

### 1.2 证据链三步法

```
Step 1: 第一现场（最近一次死锁详情）
  SHOW ENGINE INNODB STATUS\G
  → LATEST DETECTED DEADLOCK 段
  → 两个 TRANSACTION + 等待锁 + 持有锁 + 被回滚事务
        │
        ▼
Step 2: 锁等待图（还原资源依赖）
  performance_schema.data_lock_waits JOIN data_locks
  → waiting_trx_id → blocking_trx_id
  → 两条边互相指向 = 死锁环
        │
        ▼
Step 3: SQL 还原（定位业务 SQL）
  threads JOIN events_statements_history_long
  → 事务 ID 映射到线程 → 线程的 SQL 历史
  → 定位"哪两类 SQL 加锁顺序相反"
```

## 二、机制层：证据链完整 SQL（核心）

### 2.1 第一现场：SHOW ENGINE INNODB STATUS

**最高优先级**看 InnoDB 保存的最近一次死锁：

```sql
SHOW ENGINE INNODB STATUS\G
```

重点看 `LATEST DETECTED DEADLOCK` 这段，关键字段：

| 证据字段 | 你要读出什么 |
|----------|--------------|
| `TRANSACTION` | 两个事务的事务 ID、活跃时间、持有锁数量、undo log 条数 |
| `WAITING FOR THIS LOCK TO BE GRANTED` | 当前事务在等哪个表、哪个索引、哪种锁 |
| `HOLDS THE LOCK(S)` | 对方事务已经持有哪些锁 |
| `RECORD LOCKS` | 锁的是记录锁、间隙锁、next-key lock，还是插入意向锁 |
| `index` / `space id` / `page no` / `heap no` | 锁落在哪个索引和物理记录上 |
| `WE ROLL BACK TRANSACTION` | InnoDB 最后选择回滚哪个事务 |

**典型输出片段**：

```
------------------------
LATEST DETECTED DEADLOCK
------------------------
*** (1) TRANSACTION:
TRANSACTION 12345, ACTIVE 2 sec starting index read
mysql tables in use 1, locked 1
LOCK WAIT 3 lock struct(s), heap size 1136, 2 row lock(s)
MySQL thread id 100, OS thread handle 0x..., query id 200 updating
UPDATE account SET amount = amount - 100 WHERE user_id = 1

*** (1) WAITING FOR THIS LOCK TO BE GRANTED:
RECORD LOCKS space id 50 page no 3 n bits 72 index PRIMARY of table `db`.`account`
trx id 12345 lock_mode X locks rec but not gap waiting
Record lock, heap no 2 PHYSICAL RECORD: n_fields 5; compact format; ...

*** (2) TRANSACTION:
TRANSACTION 12346, ACTIVE 1 sec starting index read
mysql tables in use 1, locked 1
3 lock struct(s), heap size 1136, 2 row lock(s)
MySQL thread id 101, OS thread handle 0x..., query id 201 updating
UPDATE account SET amount = amount - 50 WHERE user_id = 2

*** (2) HOLDS THE LOCK(S):
RECORD LOCKS space id 50 page no 3 n bits 72 index PRIMARY of table `db`.`account`
trx id 12346 lock_mode X locks rec but not gap

*** (2) WAITING FOR THIS LOCK TO BE GRANTED:
RECORD LOCKS space id 50 page no 5 n bits 72 index PRIMARY of table `db`.`account`
trx id 12346 lock_mode X locks rec but not gap waiting

*** WE ROLL BACK TRANSACTION (2)
```

**从这段读出**：
- 事务 12345 等 user_id=1 的 X 锁
- 事务 12346 持有部分锁，等另一个 X 锁
- InnoDB 回滚了事务 12346（undo 量小）

### 2.2 还原锁等待图：performance_schema

死锁正在频繁发生或要拿结构化证据，查 `performance_schema`：

```sql
SELECT
  r.ENGINE_TRANSACTION_ID AS waiting_trx_id,
  r.THREAD_ID AS waiting_thread_id,
  r.OBJECT_SCHEMA,
  r.OBJECT_NAME,
  r.INDEX_NAME,
  r.LOCK_TYPE,
  r.LOCK_MODE,
  r.LOCK_DATA,
  b.ENGINE_TRANSACTION_ID AS blocking_trx_id,
  b.THREAD_ID AS blocking_thread_id,
  b.LOCK_MODE AS blocking_lock_mode
FROM performance_schema.data_lock_waits w
JOIN performance_schema.data_locks r
  ON w.REQUESTING_ENGINE_LOCK_ID = r.ENGINE_LOCK_ID
JOIN performance_schema.data_locks b
  ON w.BLOCKING_ENGINE_LOCK_ID = b.ENGINE_LOCK_ID;
```

**结果解读**：每行是一条"等待边"——`waiting_trx_id → blocking_trx_id`。如果两条边互相指向（A 等 B、B 等 A），就证明是事务 A 和 B 形成死锁环。

### 2.3 映射回 SQL 文本：events_statements_history_long

只有事务 ID 不够，面试官会继续问"到底是哪两类 SQL"。把事务、线程、SQL 历史串起来：

```sql
SELECT
  t.THREAD_ID,
  t.PROCESSLIST_ID,
  t.PROCESSLIST_USER,
  t.PROCESSLIST_HOST,
  t.PROCESSLIST_DB,
  esh.EVENT_ID,
  esh.SQL_TEXT,
  esh.TIMER_WAIT
FROM performance_schema.threads t
JOIN performance_schema.events_statements_history_long esh
  ON t.THREAD_ID = esh.THREAD_ID
WHERE t.THREAD_ID IN (?, ?)
ORDER BY t.THREAD_ID, esh.EVENT_ID DESC;
```

再看事务历史（确认事务状态和隔离级别）：

```sql
SELECT
  THREAD_ID,
  EVENT_ID,
  STATE,
  TIMER_WAIT,
  ACCESS_MODE,
  ISOLATION_LEVEL
FROM performance_schema.events_transactions_history_long
WHERE THREAD_ID IN (?, ?)
ORDER BY THREAD_ID, EVENT_ID DESC;
```

**定位结果**：把"事务 A"映射到应用侧某条更新链路，例如：

- **SQL 类型 1**：`UPDATE order SET status = ? WHERE id = ?`（先更新订单）
- **SQL 类型 2**：`UPDATE account_balance SET amount = amount - ? WHERE user_id = ?`（再更新账户）

另一类链路相反：
- **SQL 类型 1'**：`UPDATE account_balance SET ... WHERE user_id = ?`（先更新账户）
- **SQL 类型 2'**：`UPDATE order SET status = ? WHERE id = ?`（再更新订单）

**两类业务 SQL 加锁顺序相反 → 形成循环等待 → 死锁**。

### 2.4 MySQL 5.7 或兼容环境的替代证据

环境在 MySQL 5.7，或 `performance_schema.data_locks` 不完整，用 `information_schema`：

```sql
SELECT * FROM information_schema.innodb_trx\G
SELECT * FROM information_schema.innodb_locks\G
SELECT * FROM information_schema.innodb_lock_waits\G
SHOW FULL PROCESSLIST;
```

**字段说明**：

| 表/字段 | 用途 |
|---------|------|
| `innodb_trx.trx_id` | 事务 ID |
| `innodb_trx.trx_mysql_thread_id` | MySQL 线程 ID |
| `innodb_trx.trx_query` | 当前正在执行或等待的 SQL |
| `innodb_trx.trx_started` | 事务开始时间（判断长事务） |
| `innodb_trx.trx_rows_locked` | 锁定行数 |
| `innodb_locks` | 当前锁信息（哪个事务持有什么锁） |
| `innodb_lock_waits` | 谁在等谁（requesting_trx_id → blocking_trx_id） |
| `SHOW FULL PROCESSLIST` | 连接来源、当前 SQL、执行时间 |

### 2.5 打开全量死锁日志（关键操作）

`SHOW ENGINE INNODB STATUS` **只保留最近一次死锁**。频繁死锁时必须打开全量记录：

```sql
SET GLOBAL innodb_print_all_deadlocks = ON;
```

然后从 **MySQL error log** 持续收集每一次死锁详情：

```bash
# 在 error log 里找死锁记录
grep -A 100 "LATEST DETECTED DEADLOCK" /var/log/mysql/error.log

# 统计死锁频率（按时间分组）
grep "TRANSACTION.*ACTIVE" /var/log/mysql/error.log | awk '{print $1, $2}' | sort | uniq -c
```

**全量日志能判断**：
- 是不是同一对 SQL 反复死锁（同一 index/space/page 反复出现）
- 是否集中在某张表、某个索引、某个业务时间窗口
- 是否和最近发布、批任务、补偿任务、营销活动有关

**注意**：`innodb_print_all_deadlocks` 是全局参数，打开后所有死锁都写 error log，排查完记得关闭（避免日志膨胀）。

## 三、实战层：完整排查流程与修复方案

### 3.1 死锁排查完整流程

```
告警：deadlock detected (频繁)

Step 1: 立即拿第一现场（5 分钟内）
  ├─ SHOW ENGINE INNODB STATUS\G
  │   → 看 LATEST DETECTED DEADLOCK
  │   → 记录两个事务 ID + 等待/持有锁
  └─ 查应用日志：deadlock 对应的 traceId、业务参数

Step 2: 打开全量死锁日志（防止后续死锁证据丢失）
  ├─ SET GLOBAL innodb_print_all_deadlocks = ON;
  └─ 持续收集 error log 1-2 小时

Step 3: 还原锁等待图（拿结构化证据）
  ├─ performance_schema.data_lock_waits JOIN data_locks
  └─ 确认 waiting_trx_id → blocking_trx_id 形成环

Step 4: 映射回业务 SQL（定位根因）
  ├─ threads JOIN events_statements_history_long
  ├─ 找到两类 SQL（加锁顺序相反）
  └─ 结合 traceId 定位业务链路（哪个接口、哪个 @Transactional）

Step 5: 修复 + 验证
  ├─ 统一加锁顺序 / 缩短事务 / 补索引
  ├─ 灰度发布修复
  └─ 观察 innodb_row_lock_time / 死锁告警频率下降
```

### 3.2 应用侧证据补充

数据库证据定位锁和 SQL，但要定位"业务链路"，还要补应用证据：

| 证据 | 怎么拿 | 用来定位 |
|------|--------|----------|
| traceId / requestId | MDC / Sleuth / SkyWalking | 死锁事务来自哪个接口 |
| SQL mapper / repository | MyBatis mapper / JPA 仓库 | 代码入口 |
| 业务参数 | 订单 ID、用户 ID、SKU ID | 哪笔业务触发 |
| 事务边界 | `@Transactional` 范围 | 一个事务包了哪些 SQL |
| 连接池日志 | HikariCP / Druid | 是否长事务、慢 SQL |
| 慢日志 + binlog | slow_query_log / mysqlbinlog | SQL 执行频率、顺序、影响行数 |

### 3.3 修复方向（7 种方案）

```
修复优先级（按 ROI 排序）

【高 ROI 快速赢】
1. 统一加锁顺序
   所有链路按同一顺序更新表和行
   例：所有转账链路都"先锁账户 A 再锁账户 B"
   实现：在 Service 层封装统一的多表更新顺序

2. 补正确索引
   无索引或低选择性索引 → 范围锁扩大 → 更易死锁
   例：UPDATE ... WHERE non_indexed_col = ? → 锁全表
   修复：为 WHERE 条件建合适索引

3. 缩短事务时间
   事务里不做 RPC、IO、复杂计算、大批量循环
   例：@Transactional 里调外部支付接口（RPC 慢）→ 锁持有时间长
   修复：RPC 移出事务，事务只包 DB 操作

【中 ROI 中投入】
4. 降低隔离级别
   REPEATABLE READ（默认）→ 间隙锁 → 更易死锁
   评估是否可用 READ COMMITTED（无间隙锁）
   业务能接受不可重复读就用 RC

5. 拆批处理
   大事务拆小批次，降低锁持有时间
   例：批量更新 1000 条 → 拆成 10 批各 100 条

6. 死锁重试（业务侧兜底）
   死锁是 InnoDB 正常保护，业务侧识别 deadlock error 幂等重试
   例：catch DeadlockLoserDataAccessException，重试 3 次

【长期投入】
7. 热点串行化
   热点账户、热点库存通过队列或分片锁做局部串行
   例：热点 SKU 库存扣减 → Redis 原子扣减 + 队列串行落 DB
```

### 3.4 死锁重试代码示例

```java
@Service
public class TransferService {
    
    /**
     * 转账（死锁自动重试）
     * 死锁是 InnoDB 正常保护机制，业务侧做幂等重试
     */
    @Retryable(
        value = {DeadlockLoserDataAccessException.class, CannotAcquireLockException.class},
        maxAttempts = 3,
        backoff = @Backoff(delay = 100, multiplier = 2)
    )
    @Transactional(isolation = Isolation.READ_COMMITTED)
    public void transfer(Long fromUserId, Long toUserId, BigDecimal amount) {
        // 统一加锁顺序：按 userId 排序，小 ID 先锁
        Long first = Math.min(fromUserId, toUserId);
        Long second = Math.max(fromUserId, toUserId);
        
        accountRepo.deduct(first, amount);   // 先锁小的
        accountRepo.add(second, amount);     // 再锁大的
    }
    
    @Recover
    public void recover(DeadlockLoserDataAccessException e, 
                        Long fromUserId, Long toUserId, BigDecimal amount) {
        // 重试 3 次仍死锁，记录告警 + 转人工
        log.error("转账死锁超重试次数 from={} to={} amount={}", 
                  fromUserId, toUserId, amount, e);
        alertService.send("转账死锁超阈值", e);
        throw new BusinessException("系统繁忙，请稍后重试");
    }
}
```

## 四、底层本质：为什么死锁是"正常"的，但要控制频率

**死锁是并发事务的必然产物**。只要两个事务访问多张表/多行，且加锁顺序可能不同，就有死锁风险。InnoDB 的死锁检测（wait-for graph）是"主动发现 + 主动回滚"——比"等到超时"快得多（超时默认 50 秒，检测是毫秒级）。所以死锁不是 bug，是 InnoDB 的保护机制。

**为什么要定位到具体 SQL**：死锁是"正常"的，但**频繁死锁是异常的**。如果同一对 SQL 反复死锁（每小时几百次），说明业务设计有问题（加锁顺序不一致），必须修复。架构师的价值就是从"死锁告警"挖到"哪两类 SQL 加锁顺序反"，对症修复——而不是简单调大 `innodb_lock_wait_timeout`（那是掩盖问题）。

**为什么证据链要完整**：只看 SHOW ENGINE INNODB STATUS 看到的是"最近一次死锁"，可能不是代表性案例（偶发的）。频繁死锁必须打开 innodb_print_all_deadlocks 收集全部，结合 performance_schema 还原锁等待图，再映射回 SQL，才能确认"是不是同一对 SQL 反复死锁"。证据链不完整 = 修复方向可能错（修了不相关的 SQL）。

**为什么修复要"统一加锁顺序"**：死锁的根因是"加锁顺序相反形成环"。如果能保证所有事务按同一顺序加锁（如所有转账都"先锁小 ID 再锁大 ID"），就不会形成环。这是最根本的修复——其他方案（缩短事务/补索引）是降低死锁概率，统一加锁顺序是消除死锁可能。

## 五、AI 架构师加问：5 个

1. **AI 能自动分析死锁日志吗？**
   能。LLM 解析 SHOW ENGINE INNODB STATUS 的 LATEST DETECTED DEADLOCK 段，提取两个事务/锁/SQL，自动关联到代码（SQL 文本 → mapper → Service 方法），生成"死锁根因报告"。但修复方案要人确认（AI 可能误判加锁顺序）。

2. **AI 能预测死锁吗？**
   能做辅助预测——分析事务的 SQL 序列（从 events_statements_history_long），识别"两个事务的加锁顺序相反"，提前预警。但预测有假阳性（不是所有顺序相反都会死锁，取决于并发时序），要人复核。

3. **AI 能自动修复死锁吗？**
   能修简单的——自动调整 @Retryable 注解（加死锁重试）、建议补索引。复杂的（重构业务逻辑统一加锁顺序）AI 给建议但人改。AI 自动改代码要跑测试 + 灰度，不能直接上线。

4. **LLM 怎么辅助死锁排查？**
   LLM 做"证据串联"——输入 SHOW ENGINE INNODB STATUS + performance_schema 查询结果 + 应用 traceId，LLM 输出"死锁根因分析"（哪两类 SQL、加锁顺序如何相反、建议修复）。比人手动分析快，但结论要人验证。

5. **AI 时代死锁排查会自动化吗？**
   会部分自动化——监控告警 → AI 收集证据 → AI 生成根因报告 → AI 建议修复方案。但"决策"（改不改业务逻辑、接受多大改动风险）是人做的。AI 是"死锁排查副驾"，人是"驾驶员"。

## 六、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"第一现场、锁等待图、SQL 还原、全量收集、统一加锁顺序"** 五个词。

- **第一现场**：`SHOW ENGINE INNODB STATUS\G` → LATEST DETECTED DEADLOCK
- **锁等待图**：`performance_schema.data_lock_waits JOIN data_locks`（waiting → blocking 形成环）
- **SQL 还原**：`threads JOIN events_statements_history_long`（事务 ID → SQL 文本）
- **全量收集**：`SET GLOBAL innodb_print_all_deadlocks = ON`（error log 收集全部）
- **统一加锁顺序**：所有链路按同一顺序更新（小 ID 先锁），消除死锁环

### 拟人化理解

把死锁排查想成 **刑侦破案**。死锁是案发现场（有"尸体"= 被回滚的事务），`SHOW ENGINE INNODB STATUS` 是现场勘查报告（谁和谁冲突、冲突在哪），`performance_schema.data_lock_waits` 是监控录像（锁等待图，谁等谁），`events_statements_history_long` 是通讯记录（事务执行过哪些 SQL）。把三份证据串起来，才能锁定"凶手"（加锁顺序相反的两类业务 SQL），对症下药（统一加锁顺序）。

### 面试现场 60 秒回答

> 线上频繁死锁我用三步证据链。第一步拿第一现场——`SHOW ENGINE INNODB STATUS\G` 看 LATEST DETECTED DEADLOCK，读出两个事务 ID、等待锁、持有锁、被回滚事务。第二步还原锁等待图——`performance_schema.data_lock_waits JOIN data_locks`，确认事务 A 等 B、B 等 A 形成环。第三步映射回 SQL——`threads JOIN events_statements_history_long`，把事务 ID 映射到线程的 SQL 历史，定位是哪两类业务 SQL 加锁顺序相反。频繁死锁必须打开 `innodb_print_all_deadlocks = ON` 从 error log 收集全部，否则只看最近一次可能不是代表性案例。最后结合应用 traceId 定位业务链路，修复方案是统一加锁顺序（所有链路按同一顺序更新）、缩短事务（事务里不做 RPC）、补索引（避免范围锁扩大）、死锁重试（业务侧幂等兜底）。死锁本身是 InnoDB 正常保护机制，但频繁死锁说明业务设计有问题（加锁顺序不一致），必须修根因。

### 反问面试官

> 贵司死锁告警的频率和阈值是什么？目前是手动排查还是有自动化工具？这决定我改进的方向——频繁死锁要建自动化证据收集（定时跑 SHOW ENGINE INNODB STATUS + 归档），偶发死锁可以手动排查。

## 七、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 死锁是 InnoDB 正常机制，为什么要花精力排查？ | 偶发死锁正常（业务侧重试即可），频繁死锁（每小时几百次）说明业务设计问题（加锁顺序不一致），导致大量重试 + 用户失败 + 资源浪费。架构师要控制死锁频率（告警阈值 < 10 次/分钟），修根因 |
| 证据追问 | 你说事务 A 等 B、B 等 A，证据在哪？ | 用 `performance_schema.data_lock_waits JOIN data_locks` 查到 `waiting_trx_id → blocking_trx_id` 两条边互相指向。结合 `SHOW ENGINE INNODB STATUS` 的 TRANSACTION 段交叉验证。证据链完整才能下结论 |
| 边界追问 | SHOW ENGINE INNODB STATUS 只保留最近一次，怎么办？ | `SET GLOBAL innodb_print_all_deadlocks = ON` 打开全量，从 error log 收集。排查完关闭（避免日志膨胀）。或用 `performance_schema` 实时查（不依赖历史日志） |
| 反例追问 | 统一加锁顺序就能消除死锁吗？ | 能消除"加锁顺序相反"类死锁，但不能消除所有死锁（如间隙锁冲突、唯一键冲突死锁）。且统一加锁顺序在复杂业务（多表多行）实现成本高。所以是"降低死锁概率"不是"绝对消除"，配合死锁重试兜底 |
| 风险追问 | 死锁重试会不会导致业务问题？ | 会。重试必须幂等——用唯一键/版本号/状态机保证重复执行不重复扣款。且重试次数有限（3 次），超限转人工。重试不是"万能兜底"，是"偶发死锁的容错"，频繁死锁必须修根因 |
| 验证追问 | 修复后怎么验证死锁减少？ | 看 `innodb_row_lock_time`（行锁等待总时间下降）、死锁告警频率（从几百次/小时降到几次）、业务失败率（deadlock error 下降）。A/B 对比——修复前后各观察 1 天 |
| 沉淀追问 | 团队怎么避免反复踩死锁坑？ | (1) 代码规范——多表更新必须按统一顺序（小 ID 先锁）；(2) Code Review 查 @Transactional 范围（事务里不能调 RPC）；(3) 监控告警——死锁频率超阈值自动告警；(4) 事故复盘——每次死锁事故沉淀到知识库 |

### 现场对话示例

**面试官**：你查到是两类 SQL 加锁顺序相反，但业务逻辑就是"先下单再扣库存"和"退款时先退库存再改订单"，顺序天然相反，怎么办？

**候选人**：这是业务语义决定的加锁顺序，不能强统一。三个解法。第一，分库分表——订单和库存分到不同库，不在同一个事务里（用Saga/本地消息表保证最终一致）。第二，队列串行化——同一订单的下单和退款不能并发（用订单 ID 做分布式锁，串行处理），消除死锁可能。第三，死锁重试 + 幂等——接受偶发死锁（业务上退款和下单同时发生的概率低），死锁后重试。我推荐方案三（成本低）+ 监控死锁频率，如果频率上升（如大促退款高峰）再上方案二（队列串行化）。核心是"评估死锁频率 + 业务影响"，频率低就重试兜底，频率高就改架构。

**面试官**：打开 innodb_print_all_deadlocks 会不会影响性能？

**候选人**：影响很小。它只是在死锁发生时多写一份日志到 error log（死锁本身是低频事件，即使"频繁"也是每秒几次不是几万次）。真正要小心的是"忘了关"——如果死锁一直频繁且日志没清理，error log 会膨胀占满磁盘。我的做法：(1) 排查时打开（1-2 小时）；(2) 排查完立即关闭；(3) 日志归档脚本定时清理老死锁日志。长期监控死锁用 `performance_schema.events_errors_summary_global_by_error`（统计 error 1213 次数），不依赖 error log。

**面试官**：events_statements_history_long 查不到死锁时的 SQL，怎么办？

**候选人**：这是常见问题——`events_statements_history_long` 默认只保留 10000 条，高并发时几秒就被覆盖。三个应对。第一，案发时立即查（别等几分钟，SQL 历史早被覆盖）。第二，调大参数 `performance_schema_events_statements_history_long_size=100000`（内存换保留时长）。第三，如果已经被覆盖，退而求其次——用 binlog 反查（mysqlbinlog 按时间点解析，找死锁事务的 SQL）。长期方案是接 APM（SkyWalking/Prometheus）实时采集 SQL，不依赖 performance_schema 历史表。

## 常见考点

1. **死锁证据链怎么拿？**——三步：(1) `SHOW ENGINE INNODB STATUS\G` 看 LATEST DETECTED DEADLOCK；(2) `performance_schema.data_lock_waits JOIN data_locks` 还原锁等待图；(3) `threads JOIN events_statements_history_long` 映射回 SQL。频繁死锁打开 `innodb_print_all_deadlocks = ON` 从 error log 收集全部。
2. **SHOW ENGINE INNODB STATUS 看什么？**——LATEST DETECTED DEADLOCK 段的 TRANSACTION（事务 ID/活跃时间）、WAITING FOR THIS LOCK TO BE GRANTED（等什么锁）、HOLDS THE LOCK(S)（持有什么锁）、RECORD LOCKS（锁类型：记录/间隙/next-key）、WE ROLL BACK TRANSACTION（回滚了谁）。
3. **performance_schema.data_lock_waits 怎么用？**——JOIN data_locks 查 waiting_trx_id → blocking_trx_id。两条边互相指向 = 死锁环。比 SHOW ENGINE INNODB STATUS 结构化，适合程序化分析。
4. **死锁根因和修复方向？**——根因是加锁顺序相反（事务 A 先锁 X 再锁 Y，事务 B 先锁 Y 再锁 X）。修复：(1) 统一加锁顺序（小 ID 先锁）；(2) 缩短事务（事务里不做 RPC）；(3) 补索引（避免范围锁扩大）；(4) 降隔离级别（RC 无间隙锁）；(5) 拆批（大事务拆小）；(6) 死锁重试（幂等兜底）；(7) 热点串行化（队列/分片锁）。
5. **死锁是 bug 吗？**——不是。死锁是 InnoDB 的正常保护机制（wait-for graph 检测 + 自动回滚，比超时快）。偶发死锁业务侧重试即可。但频繁死锁是业务设计问题（加锁顺序不一致），必须修根因。架构师要控制死锁频率（告警阈值 < 10 次/分钟），不能简单调大 `innodb_lock_wait_timeout` 掩盖问题。

## 结构化回答

**30 秒电梯演讲：** 线上频繁死锁告警，我不会背"死锁是互相等待"这种概念，而是能拿出一条完整的证据链把现场还原出来——`SHOW ENGINE INNODB STATUS` 拿第一现场，`performance_schema.data_lock_waits` 还原锁等待图，`events_statements_history_long` 把事务 ID 映射回 SQL，最后定位到"哪两类业务 SQL 加锁顺序相反形成环"，对症修复。死锁本身是 InnoDB 正常的保护机制，但频繁死锁一定是业务设计有问题。

**展开框架：**
1. **第一现场** — `SHOW ENGINE INNODB STATUS\G` 看 LATEST DETECTED DEADLOCK，读出两个事务 ID、谁等什么锁、谁持有什么锁、InnoDB 回滚了谁；但只保留最近一次，频繁死锁要 `SET GLOBAL innodb_print_all_deadlocks = ON` 从 error log 收集全部。
2. **还原锁等待图** — `performance_schema.data_lock_waits JOIN data_locks`，查 `waiting_trx_id → blocking_trx_id`，两条边互相指向（A 等 B、B 等 A）就证明形成了死锁环，这是结构化、可程序化分析的证据。
3. **映射回 SQL 定位根因** — `threads JOIN events_statements_history_long` 把事务 ID 映射到线程的 SQL 历史，结合应用 traceId 定位业务链路，根因通常是加锁顺序相反、事务过长、索引缺失导致范围锁扩大。

**收尾：** 修复优先级是统一加锁顺序（小 ID 先锁，能消除"顺序相反"类死锁）、缩短事务（事务里不做 RPC）、补索引、死锁幂等重试兜底。您想往深里聊哪一段——锁等待图的 SQL 怎么写，还是业务语义天然相反时（下单先扣库存 vs 退款先退库存）怎么权衡？

## 视频脚本

> 预计时长：4 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：线上频繁死锁，怎么用 MySQL 证据链定位？ | 线上死锁告警频繁，面试官要的不是"死锁是互相等待"这种概念，而是你能不能把现场一条条证据串起来。我用三步证据链还原。 | 开场钩子 |
| 0:20 | 刑侦破案类比图：案发现场→勘查报告→监控→通讯记录 | 把排查想成刑侦破案：死锁是案发现场，SHOW ENGINE INNODB STATUS 是勘查报告，performance_schema 是监控录像，events_statements_history_long 是通讯记录。三份证据串起来才能锁定凶手。 | 核心类比 |
| 0:50 | 终端演示：SHOW ENGINE INNODB STATUS\\G 高亮 LATEST DETECTED DEADLOCK | 第一步拿第一现场：SHOW ENGINE INNODB STATUS，看 LATEST DETECTED DEADLOCK 段，读出两个事务 ID、等待锁、持有锁、回滚了谁。注意它只保留最近一次。 | 第一现场 |
| 1:40 | SQL 截图：data_lock_waits JOIN data_locks + 锁等待环状图 | 第二步还原锁等待图：data_lock_waits JOIN data_locks，看 waiting_trx_id 指向 blocking_trx_id，两条边互相指向就是死锁环，比看日志更结构化。 | 锁等待图 |
| 2:30 | SQL 截图：threads JOIN events_statements_history_long + 两类加锁顺序相反的 SQL 对比 | 第三步映射回 SQL：threads JOIN events_statements_history_long 把事务 ID 映射到线程的 SQL 历史，定位是哪两类业务 SQL 加锁顺序相反。频繁死锁记得打开 innodb_print_all_deadlocks 从 error log 收集全部。 | SQL 还原 |
| 3:20 | 修复优先级表：统一加锁顺序 / 缩短事务 / 补索引 / 死锁重试 | 修复方向：统一加锁顺序（小 ID 先锁，能消除顺序相反类死锁）、缩短事务、补索引避免范围锁扩大、业务侧死锁幂等重试。死锁是 InnoDB 正常保护，但频繁死锁必须修根因，不能靠调大锁超时掩盖。 | 修复方案 |
| 3:50 | 总结卡 + 下期预告 | 记住五个词：第一现场、锁等待图、SQL 还原、全量收集、统一加锁顺序。下期我们聊——业务语义天然相反时（下单 vs 退款）怎么避免死锁。 | 收尾 |
