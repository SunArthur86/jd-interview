---
id: java-architect-022
difficulty: L2
category: java-architect
subcategory: MySQL
tags:
- MVCC
- 锁
- 事务
feynman:
  essence: MVCC（多版本并发控制）的本质是"给每行数据维护多个版本，读事务读快照（不加锁），写事务加行锁写新版本"——让读写不互相阻塞，大幅提升并发。InnoDB 通过隐藏列（trx_id、roll_pointer）+ undo log 构建版本链，ReadView 决定事务能看到哪个版本，实现 RC（读已提交）和 RR（可重复读）两个隔离级别。
  analogy: 像协作编辑的文档系统。悲观锁是"一个人编辑时其他人只能看不能改"（串行）；MVCC 是"每次编辑存历史版本，读者选择看某个时刻的快照"——读者看旧版本不加锁，编辑者写新版本互不干扰。RR 隔离级别是"事务开始时拍快照，之后只看这个快照"；RC 是"每次 SELECT 都重新拍快照，总能看到最新已提交的"。
  first_principle: 为什么不用悲观锁（读写都加锁）？因为悲观锁让读写串行（读阻塞写、写阻塞读），高并发下性能差。MVCC 的洞察是"读多写少"——读不修改数据，没必要加锁，给读一个历史版本快照即可。只有写之间才需要锁（同一行不能同时被两个事务修改）。
  key_points:
  - InnoDB 隐藏列：DB_TRX_ID（事务 ID）、DB_ROLL_PTR（指向 undo log 的回滚指针）
  - 版本链：每次修改生成 undo log，通过 roll_pointer 链接成历史版本链
  - ReadView：记录"当前活跃事务列表"，决定当前事务能看到哪个版本
  - RC vs RR：RC 每次 SELECT 生成新 ReadView（看到最新已提交）；RR 事务开始时生成一次 ReadView（快照不变）
  - 锁体系：行锁（记录锁/间隙锁/临键锁）、表锁、意向锁、MDL 锁
first_principle:
  problem: 如何让多个事务并发读写同一份数据，既保证隔离性（不互相干扰）又保证并发性（不串行等待）？
  axioms:
  - 读写互斥（悲观锁）会让读阻塞写、写阻塞读，并发度低
  - 读不修改数据，读历史版本快照即可（不需要加锁）
  - 只有写之间才真冲突（同一行不能同时被两个事务修改）
  rebuild: 给每行数据维护多个版本（通过 undo log 版本链）。读事务根据自己的 ReadView（记录可见的事务范围）从版本链选一个可见版本读取，不加锁。写事务加行锁修改数据，生成新版本。这样读读不阻塞、读写不阻塞（读旧版本）、只有写写阻塞（行锁）。隔离级别由 ReadView 生成时机决定——RC 每次 SELECT 生成新 ReadView（看到最新已提交），RR 事务首次读生成 ReadView 之后不变（快照重复读）。
follow_up:
  - MVCC 解决了幻读吗？——RR 级别下，快照读（普通 SELECT）用 MVCC 不会幻读（快照固定）。但当前读（SELECT FOR UPDATE、UPDATE、DELETE）会看到新数据，可能幻读。InnoDB 用临键锁（next-key lock）在当前读时锁住范围，防止其他事务插入，解决幻读
  - 间隙锁（Gap Lock）是什么？——锁住索引记录之间的"间隙"，防止其他事务在间隙插入。如锁住 (10, 20) 间隙，其他事务不能插入 id=15。只在 RR 级别生效（解决幻读），RC 没有间隙锁
  - 死锁怎么产生的？——两个事务互相等待对方持有的锁。如 T1 锁了 A 等待 B，T2 锁了 B 等待 A。InnoDB 有死锁检测（innodb_deadlock_detect），检测到死锁自动回滚代价较小的事务
  - 当前读和快照读区别？——快照读（普通 SELECT）读 MVCC 版本链的快照，不加锁。当前读（SELECT FOR UPDATE、UPDATE、DELETE、INSERT）读最新数据并加锁。更新操作必须当前读（不能更新旧版本）
  - 为什么 MySQL 默认 RR 而不是 RC？——历史原因（早期 binlog 只有 statement 格式，RC 下主从复制会错乱）+ 安全（RR 防幻读）。但现在 binlog 用 row 格式，RC 也能正确复制，很多互联网公司（如阿里）改用 RC（并发更高，间隙锁少）
memory_points:
  - MVCC = 多版本（undo log 版本链）+ ReadView（可见性判断）
  - RC 每次 SELECT 新 ReadView；RR 首次读后 ReadView 不变
  - 行锁三态：记录锁（锁行）、间隙锁（锁间隙，防插入）、临键锁（记录+间隙）
  - 快照读（普通 SELECT）不加锁；当前读（FOR UPDATE）加锁
  - RR 用临键锁解决幻读；RC 无间隙锁并发高
  - 死锁检测 innodb_deadlock_detect 自动回滚
---

# 【Java 后端架构师】InnoDB MVCC、锁与事务隔离

> 适用场景：JD 核心技术。高并发下单时，多个事务同时读写订单和库存，没有 MVCC 就是读写互相阻塞，TPS 骤降；锁设计不当就是死锁频发。架构师必须能讲清 MVCC 版本链、ReadView 可见性、行锁三态、死锁检测——这是数据库并发控制的根基。

## 一、概念层：事务 ACID 与隔离级别

**事务 ACID**（必背）：

| 特性 | 含义 | 实现机制 |
|------|------|---------|
| **A（原子性）** | 事务要么全做要么全不做 | undo log（回滚日志） |
| **C（一致性）** | 事务前后数据约束一致 | A + I + 业务约束共同保证 |
| **I（隔离性）** | 并发事务互不干扰 | 锁 + MVCC |
| **D（持久性）** | 提交后永久保存 | redo log（重做日志） |

**四种隔离级别**（必考对比）：

| 隔离级别 | 脏读 | 不可重复读 | 幻读 | 性能 |
|---------|------|-----------|------|------|
| **READ_UNCOMMITTED** | 有 | 有 | 有 | 最高 |
| **READ_COMMITTED（RC）** | 无 | 有 | 有 | 高 |
| **REPEATABLE_READ（RR）** | 无 | 无 | 有（InnoDB 已解决） | 中 |
| **SERIALIZABLE** | 无 | 无 | 无 | 低（串行） |

**三种读异常**（画图理解）：

```
脏读（Dirty Read）：T2 读到 T1 未提交的数据（T1 后来回滚了）
  T1: BEGIN; UPDATE balance SET amt = amt - 100;  -- 未提交
  T2: BEGIN; SELECT amt;  -- 读到扣减后的值（脏读）
  T1: ROLLBACK;  -- T2 读的是不存在的数据

不可重复读（Non-Repeatable Read）：T2 两次读同一行结果不同（T1 中间提交了修改）
  T2: BEGIN; SELECT amt;  -- 读到 1000
  T1: BEGIN; UPDATE balance SET amt = 900; COMMIT;
  T2: SELECT amt;  -- 读到 900（同一事务内两次读不一致）

幻读（Phantom Read）：T2 两次范围查询结果集不同（T1 中间提交了插入）
  T2: BEGIN; SELECT * FROM orders WHERE amt > 100;  -- 10 条
  T1: BEGIN; INSERT INTO orders(amt) VALUES(200); COMMIT;
  T2: SELECT * FROM orders WHERE amt > 100;  -- 11 条（多了"幻影"行）
```

**MySQL 默认 RR**，且 InnoDB 在 RR 下用临键锁解决了幻读。

## 二、机制层：MVCC 多版本并发控制

**InnoDB 隐藏列**（画图必考）：

```
每行数据有两个隐藏列：
  DB_TRX_ID（6 字节）：最后修改该行的事务 ID
  DB_ROLL_PTR（7 字节）：回滚指针，指向 undo log 中的上一个版本

版本链示例：
  当前行：[data: v3, trx_id: 300, roll_ptr: → undo_log_v2]
                                                      │
                                                      ▼
                          undo log: [data: v2, trx_id: 200, roll_ptr: → undo_log_v1]
                                                                                  │
                                                                                  ▼
                                              undo log: [data: v1, trx_id: 100, roll_ptr: NULL]

  每次修改生成一条 undo log，通过 roll_pointer 链接成历史版本链
  undo log 还用于事务回滚（ROLLBACK 时沿链恢复）
```

**ReadView 可见性判断**（核心机制）：

```
ReadView 包含四个关键字段：
  m_ids：生成 ReadView 时当前活跃（未提交）的事务 ID 列表
  min_trx_id：m_ids 中的最小值
  max_trx_id：生成 ReadView 时系统应分配的下一个事务 ID
  creator_trx_id：生成该 ReadView 的事务 ID

可见性判断规则（沿版本链找第一个可见版本）：
  对于版本的 trx_id：
    1. trx_id == creator_trx_id：自己修改的，可见
    2. trx_id < min_trx_id：修改在 ReadView 前已提交，可见
    3. trx_id >= max_trx_id：修改在 ReadView 后才开始，不可见
    4. min_trx_id <= trx_id < max_trx_id：
       - trx_id 在 m_ids 中：未提交，不可见
       - trx_id 不在 m_ids 中：已提交，可见
  不可见则沿 roll_pointer 找上一个版本，重复判断
```

**RC vs RR 的 ReadView 生成时机**（面试核心）：

```
RC（读已提交）：每次 SELECT 都生成新的 ReadView
  T2: BEGIN;
  T2: SELECT amt;  -- 生成 ReadView1，此时 T1 未提交，看不到 T1 的修改
  T1: COMMIT;      -- T1 提交
  T2: SELECT amt;  -- 生成 ReadView2，T1 已提交，能看到 T1 的修改（不可重复读）

RR（可重复读）：事务首次 SELECT 时生成 ReadView，之后不变
  T2: BEGIN;
  T2: SELECT amt;  -- 生成 ReadView1，此时 T1 未提交，看不到
  T1: COMMIT;
  T2: SELECT amt;  -- 复用 ReadView1，仍然看不到 T1 的修改（可重复读）

  核心差异：RC 每次 SELECT 新 ReadView（总能看到最新已提交）；
           RR 首次读后 ReadView 固定（快照不变，可重复读）
```

## 三、机制层：InnoDB 锁体系

**锁的分类**（必考全景）：

| 维度 | 类型 | 说明 |
|------|------|------|
| **粒度** | 表锁 / 行锁 | InnoDB 默认行锁（MyISAM 表锁） |
| **性质** | 共享锁（S）/ 排他锁（X） | S 读锁可共存，X 写锁互斥 |
| **行锁三态** | 记录锁 / 间隙锁 / 临键锁 | RR 级别下默认临键锁 |
| **意向锁** | IS / IX | 表级，表示表内有行锁，加速锁冲突判断 |
| **MDL 锁** | 元数据锁 | 防止 DDL 和 DML 冲突 |

**行锁三态详解**（画图理解）：

```
假设索引上有记录：10, 15, 20, 25

记录锁（Record Lock）：锁单条记录
  SELECT * FROM t WHERE id = 10 FOR UPDATE;
  锁住 id=10 这一条

间隙锁（Gap Lock）：锁住记录之间的间隙（不锁记录本身）
  SELECT * FROM t WHERE id > 10 AND id < 15 FOR UPDATE;
  锁住 (10, 15) 间隙，防止其他事务插入 id=12
  间隙锁只在 RR 生效，RC 无间隙锁

临键锁（Next-Key Lock）：记录锁 + 前面的间隙（左开右闭）
  SELECT * FROM t WHERE id <= 15 FOR UPDATE;
  锁住 (10, 15]，即 (10,15) 间隙 + id=15 记录
  这是 RR 默认的行锁类型，锁住范围防幻读

插入意向锁（Insert Intention Lock）：插入前的特殊间隙锁
  INSERT INTO t VALUES(12);
  表示"我要插入到 (10,15) 间隙"，与其他插入意向锁不冲突
  但和间隙锁冲突（防止间隙被锁时插入）
```

**锁的兼容矩阵**（S/X 锁）：

|  | S（共享） | X（排他） |
|--|---------|---------|
| **S（共享）** | 兼容 | 冲突 |
| **X（排他）** | 冲突 | 冲突 |

- S 锁：`SELECT ... LOCK IN SHARE MODE`
- X 锁：`SELECT ... FOR UPDATE`、`UPDATE`、`DELETE`、`INSERT`

**当前读 vs 快照读**：

```sql
-- 快照读（普通 SELECT，读 MVCC 快照，不加锁）
SELECT * FROM orders WHERE id = 1;

-- 当前读（读最新数据 + 加锁）
SELECT * FROM orders WHERE id = 1 FOR UPDATE;   -- 加 X 锁
SELECT * FROM orders WHERE id = 1 LOCK IN SHARE MODE;  -- 加 S 锁
UPDATE orders SET status = 'PAID' WHERE id = 1;  -- 当前读 + X 锁
DELETE FROM orders WHERE id = 1;                  -- 当前读 + X 锁
```

## 四、实战层：锁问题诊断

**查看锁状态**：

```sql
-- 1. 查看当前锁等待
SELECT * FROM information_schema.innodb_lock_waits;
SELECT * FROM performance_schema.data_locks;        -- MySQL 8.0+
SELECT * FROM performance_schema.data_lock_waits;   -- MySQL 8.0+

-- 2. 查看当前事务
SELECT * FROM information_schema.innodb_trx
WHERE TIME_TO_SEC(TIMEDIFF(NOW(), trx_started)) > 5;
-- trx_started 超过 5 秒的事务可能是长事务，持有锁

-- 3. 查看正在执行的 SQL
SHOW FULL PROCESSLIST;
-- Time 列显示执行时长，长的可能是慢 SQL 或锁等待

-- 4. 死锁日志
SHOW ENGINE INNODB STATUS;
-- 查看 LATEST DETECTED DEADLOCK 部分，有死锁详情
```

**死锁场景示例**：

```sql
-- 死锁产生
T1: BEGIN; UPDATE account SET amt = amt - 100 WHERE id = 1;  -- 锁 id=1
T2: BEGIN; UPDATE account SET amt = amt - 100 WHERE id = 2;  -- 锁 id=2
T1: UPDATE account SET amt = amt + 100 WHERE id = 2;  -- 等 T2 释放 id=2
T2: UPDATE account SET amt = amt + 100 WHERE id = 1;  -- 等 T1 释放 id=1
-- 死锁！T1 等 T2，T2 等 T1

-- InnoDB 死锁检测（innodb_deadlock_detect=ON，默认开启）
-- 检测到死锁后，自动回滚代价较小的事务（修改行数少的）
-- 错误：ERROR 1213 (40001): Deadlock found when trying to get lock
```

**死锁优化**：

```java
// 1. 统一加锁顺序（防死锁）
// 反例：不同方法按不同顺序加锁
public void transferAtoB() { update(id=1); update(id=2); }
public void transferBtoA() { update(id=2); update(id=1); }  // 反顺序，死锁

// 正例：所有转账按 id 升序加锁
public void transfer(Long from, Long to) {
    Long first = Math.min(from, to);
    Long second = Math.max(from, to);
    update(first);   // 先锁小的
    update(second);  // 再锁大的
}

// 2. 缩短事务（减少锁持有时间）
@Transactional
public void createOrder() {
    // 不要在事务里做 RPC 调用（慢、长事务）
    validate();          // 快
    saveOrder();         // 快
    // rpc.notify();     // 移出事务！
}

// 3. 降低隔离级别（RC 无间隙锁，锁冲突少）
// SET session transaction isolation level read committed;

// 4. 合理用索引（避免行锁升级为表锁）
// 没走索引的 UPDATE 会锁全表（因为要扫描所有行）
UPDATE orders SET status = 'X' WHERE non_indexed_col = 'Y';  -- 锁全表！
UPDATE orders SET status = 'X' WHERE indexed_col = 'Y';       -- 只锁匹配行
```

**临键锁防幻读案例**：

```sql
-- RR 隔离级别下，当前读用临键锁防幻读
T1: BEGIN;
T1: SELECT * FROM orders WHERE amt > 100 FOR UPDATE;
-- 假设返回 10 条（amt > 100 的记录）
-- InnoDB 锁住 amt > 100 的所有记录 + 间隙（临键锁）
-- 锁范围：(当前最大 amt, +∞) 的间隙也被锁

T2: BEGIN;
T2: INSERT INTO orders(amt) VALUES(200);  -- 阻塞！间隙被锁
-- T2 等待 T1 释放锁，无法插入，防止幻读

T1: COMMIT;  -- 释放锁
T2: 插入成功
```

## 五、底层本质：MVCC 与锁的分工

回到第一性：**数据库并发控制的本质是"读写分离处理——读用 MVCC 不加锁，写用锁串行化"**。

- **MVCC 解决读-读、读-写并发**：读事务读快照（undo log 版本链选可见版本），不加锁不阻塞写。写事务加行锁写新版本，不阻塞读（读旧版本）。这样读读不冲突、读写不冲突，只有写写冲突。
- **锁解决写-写冲突**：同一行不能同时被两个事务修改，用 X 锁串行化。记录锁锁单行，间隙锁锁间隙（防插入），临键锁（RR）锁范围防幻读。
- **RC vs RR 的本质权衡**：RC 每次 SELECT 新 ReadView（总能看到最新已提交，但同一事务内读不一致），无间隙锁（并发高，但可能幻读）。RR 首次读后 ReadView 固定（可重复读），有间隙锁（防幻读，但锁范围大并发低）。互联网很多公司选 RC 换更高并发。
- **undo log 的双重作用**：undo log 既是 MVCC 版本链的数据源（读旧版本），又是事务回滚的依据（ROLLBACK 时恢复）。所以 undo log 不能在事务提交后立即删除——要等没有活跃事务依赖这个版本（purge 线程定期清理）。

**为什么 InnoDB 能在 RR 解决幻读**：标准 SQL 的 RR 是有幻读的（只锁行不锁间隙）。InnoDB 的 RR 用临键锁（记录锁 + 间隙锁）在当前读时锁住整个查询范围，防止其他事务插入新行到范围内。这是 InnoDB 对标准 RR 的增强。但只对当前读有效（快照读本身不会幻读，因为 ReadView 固定）。

## 六、AI 架构师加问：5 个 AI 相关问题

1. **AI 推理服务写 DB 的高并发怎么避免锁冲突？**
   推理结果批量写入（INSERT 批量）而非逐条，减少锁次数。热点数据（如用户最新画像）用 Redis 缓存异步落库，避免高并发 UPDATE 同一行。如果必须写热点，用"分片 + 合并"（按 user_id 分片写入不同行，定时合并）。

2. **让 AI 诊断死锁，AI 接管哪段？**
   AI 解析 `SHOW ENGINE INNODB STATUS` 的死锁日志 → 提取事务和锁的信息 → 匹配代码定位是哪个业务逻辑 → 推荐加锁顺序调整。AI 输出死锁根因分析和修复建议，人工确认后改代码。

3. **AI 生成的事务代码怎么验证不会有死锁？**
   静态分析：检查事务内多个写操作的加锁顺序是否一致（不同方法按不同顺序锁同一组表会死锁）。压测注入：模拟并发场景跑事务，监控死锁次数。AI 还能检查事务范围（事务里有 RPC 调用就是长事务，容易锁冲突）。

4. **向量数据库的并发控制和 MySQL 一样吗？**
   向量库（Milvus）通常用乐观并发控制（OCC）而非悲观锁——写入时记录版本，提交时检测冲突。因为向量检索是近似查询（容忍轻微不一致），不需要强隔离。MySQL 是悲观锁 + MVCC 混合，适合强一致需求。

5. **怎么用 AI 预测锁冲突热点？**
   AI 分析 SQL 日志统计"哪些行被高频 UPDATE"（热点行识别）→ 预测锁冲突概率 → 推荐优化（如热点拆分、异步队列削峰、缓存兜底）。监控 innodb_row_lock_waits 和 innodb_row_lock_time_avg，超阈值告警。

## 七、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"ACID、四隔离级别、MVCC 版本链 + ReadView、行锁三态"**。

- **ACID**：原子（undo）、一致、隔离（锁+MVCC）、持久（redo）
- **四隔离**：RC（读已提交）、RR（可重复读，InnoDB 默认，解决幻读）
- **MVCC**：隐藏列（trx_id, roll_ptr）+ undo log 版本链 + ReadView 可见性
- **RC vs RR**：RC 每次 SELECT 新 ReadView；RR 首次读后固定
- **行锁三态**：记录锁（锁行）、间隙锁（锁间隙防插入）、临键锁（记录+间隙，RR 默认）
- **快照读不加锁，当前读加锁**；**死锁检测自动回滚**

### 拟人化理解

把 MVCC 想成**协作文档的历史版本**。每次编辑（写）生成新版本，历史版本通过"版本历史"链接（undo log 版本链）。读者（读事务）选择看某个时刻的版本（ReadView 决定）——你看的是 10 分钟前的快照，我看的是 5 分钟前，互不干扰（读读不冲突）。编辑者（写事务）锁定当前正在编辑的段落（行锁），防止两人同时改同一段（写写冲突）。但编辑者不会阻塞读者（读者看旧版本）。RR 是"你打开文档时拍快照，之后只看这个快照"；RC 是"每次刷新都看最新版"。

### 面试现场 60 秒回答

> InnoDB 并发控制靠 MVCC + 锁。MVCC 给每行维护多版本（隐藏列 trx_id + roll_ptr 指向 undo log 版本链），读事务用 ReadView 判断可见性（沿版本链找第一个可见版本），不加锁不阻塞写。RC 每次 SELECT 生成新 ReadView 看到最新已提交；RR 首次读生成 ReadView 后固定，实现可重复读。写事务加行锁——记录锁锁单行、间隙锁锁间隙防插入、临键锁（记录+间隙）是 RR 默认防幻读。快照读（普通 SELECT）不加锁走 MVCC，当前读（FOR UPDATE/UPDATE）加锁读最新。死锁靠 innodb_deadlock_detect 自动检测回滚。生产优化：事务内按固定顺序加锁（防死锁）、事务缩短（少持锁）、走索引（避免行锁升级表锁）。

### 反问面试官

> 贵司数据库默认隔离级别是 RR 还是 RC？有没有遇到过死锁频发（如秒杀热点）？锁等待超时（innodb_lock_wait_timeout）设多少？如果有热点行锁瓶颈，我会聊分片和异步队列。

## 八、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不用 SERIALIZABLE 一了百了？ | 用性能说话：SERIALIZABLE 读写都加锁串行，高并发下 TPS 骤降。MVCC 的洞察是"读多写少"，读不加锁大幅提升并发。RR（MVCC + 行锁）在保证隔离性的同时并发度高，是性能和一致性的平衡 |
| 证据追问 | 你说有锁冲突，怎么证明？ | 查 innodb_lock_waits 看锁等待关系；SHOW PROCESSLIST 看 State=Waiting for lock；SHOW ENGINE INNODB STATUS 看锁详情；监控 innodb_row_lock_waits（锁等待次数）和 innodb_row_lock_time_avg（平均等待时间） |
| 边界追问 | MVCC 能完全替代锁吗？ | 不能。MVCC 只解决读-写并发（读快照不阻塞写）。写-写冲突必须用锁（同一行不能同时被两个事务修改）。且 MVCC 只对快照读有效，当前读（FOR UPDATE）仍要加锁 |
| 反例追问 | 什么场景该用 RC 而不是 RR？ | 高并发且接受不可重复读的场景（RC 无间隙锁并发高）；互联网很多公司（如阿里）用 RC，因为 row 格式 binlog 解决了主从一致问题，RC 并发优势更明显。RR 的间隙锁在大范围查询时会锁很多间隙影响并发 |
| 风险追问 | 事务隔离用错最大风险？ | 主动点出：RR 下间隙锁范围过大导致并发下降、长事务持有锁导致锁等待、死锁（加锁顺序不一致）、RC 下幻读（业务逻辑依赖固定结果集时出错） |
| 验证追问 | 怎么证明隔离级别配置正确？ | 测试覆盖并发场景（两个事务并发读写，验证隔离性）；监控锁等待（应很少）；对账验证一致性（RC 下短暂不一致窗口在容忍范围）；压测验证并发性能 |
| 沉淀追问 | 团队事务规范，沉淀什么？ | 默认隔离级别（RR/RC）、加锁顺序规范（防死锁）、事务范围规范（事务内禁止 RPC）、慢事务监控大盘、热点行分片规范、死锁日志采集分析 |

### 现场对话示例

**面试官**：MVCC 是怎么实现可重复读的？

**候选人**：核心是 ReadView 的生成时机。ReadView 记录了"当前活跃事务列表"（m_ids）和边界（min_trx_id、max_trx_id）。判断版本可见性时，沿 undo log 版本链找第一个满足"trx_id < min_trx_id 或不在 m_ids 中"的版本。RR 隔离级别下，事务首次执行 SELECT 时生成 ReadView，之后整个事务都用这一个 ReadView。所以即使其他事务提交了新数据（新版本的 trx_id >= max_trx_id 或在 m_ids 中），当前事务都看不到（ReadView 不变），只看得到事务开始时已提交的版本——这就是"可重复读"。RC 不同，每次 SELECT 都生成新 ReadView，所以能看到其他事务新提交的数据（不可重复读）。这就是 RC 和 RR 的本质差异——ReadView 是生成一次还是每次新生成。

**面试官**：间隙锁在什么场景下会有问题？

**候选人**：间隙锁在 RR 级别下生效（防幻读），但有两个问题。第一，锁范围过大影响并发。如 `SELECT ... WHERE id > 10 FOR UPDATE` 会锁住 (10, +∞) 整个间隙，其他事务在这个范围内插入都被阻塞。如果业务只需要锁几条记录，间隙锁会"误伤"大量正常插入。第二，死锁概率上升。两个事务持有不同间隙锁，互相等待对方的间隙锁，容易死锁。解法：如果业务能接受幻读（如统计查询，多几条少几条无所谓），降低到 RC（无间隙锁）。如果是必须防幻读的场景（如库存扣减不能多扣），保留 RR 但优化查询（走等值索引减少间隙范围）。互联网很多公司选 RC 就是为了避免间隙锁的并发问题。

**面试官**：没走索引的 UPDATE 为什么会锁全表？

**候选人**：因为 MySQL 要找到所有满足条件的行来加锁。如果 WHERE 条件没走索引，存储引擎要扫描全表（逐行遍历）找到满足条件的行。在扫描过程中，InnoDB 会对扫描过的每一行都加锁（因为是当前读），包括不满足条件的行（因为它不知道下一行满不满足，只能先锁住）。结果就是整张表的所有行都被锁，其他事务对该表的任何 UPDATE/DELETE 都被阻塞。这叫"行锁升级为表锁"（虽然 InnoDB 没有真正的表锁升级机制，但效果类似）。所以 UPDATE/DELETE 的 WHERE 条件必须走索引，否则在高并发下就是全表锁，TPS 骤降。可以用 EXPLAIN 验证 UPDATE 是否走索引（EXPLAIN UPDATE ...）。

## 常见考点

1. **undo log 和 redo log 区别？**——undo log 记录"修改前的旧值"（用于回滚和 MVCC 版本链）；redo log 记录"修改后的新值"（用于崩溃恢复，保证持久性）。undo log 是逻辑日志（记录反向操作），redo log 是物理日志（记录页修改）。事务提交时先写 redo log（保证持久性），undo log 用于回滚和 MVCC。
2. **MySQL 怎么解决幻读？**——RR 级别下，快照读（普通 SELECT）用 MVCC 不会幻读（ReadView 固定）。当前读（SELECT FOR UPDATE/UPDATE/DELETE）用临键锁锁住查询范围，防止其他事务插入新行。RC 不解决幻读（每次新 ReadView，间隙锁不生效）。
3. **乐观锁和悲观锁区别？**——悲观锁（SELECT FOR UPDATE）先加锁再操作，适合写多读少。乐观锁（version 字段 + CAS）不加锁，提交时检测版本号，适合读多写少。MySQL 的 MVCC 是"读不加锁"的乐观策略，写仍用悲观锁。应用层乐观锁用 version 字段（UPDATE ... WHERE version = ?）。
4. **next-key lock 降级为记录锁的条件？**——等值查询且记录存在时，临键锁降级为记录锁（只锁匹配行，不锁间隙）。等值查询记录不存在时，临键锁保持（锁住间隙防止插入）。范围查询保持临键锁（锁住范围内所有间隙）。


## 结构化回答

**30 秒电梯演讲：** 聊到InnoDB MVCC、锁与事务隔离，我的理解是——MVCC（多版本并发控制）的本质是"给每行数据维护多个版本，读事务读快照（不加锁），写事务加行锁写新版本"——让读写不互相阻塞，大幅提升并发。InnoDB 通过隐藏列（trx_id、roll_pointer）+ undo log 构建版本链，ReadView 决定事务能看到哪个版本，实现 RC（读已提交）和 RR（可重复读）两个隔离级别。打个比方，像协作编辑的文档系统。悲观锁是"一个人编辑时其他人只能看不能改"（串行）；MVCC 是"每次编辑存历史版本，读者选择看某个时刻的快照"——读者看旧版本不加锁，编辑者写新版本互不干扰。RR 隔离级别是"事务开始时拍快照，之后只看这个快照"；RC 是"每次 SELECT 都重新拍快照，总能看到最新已提交的"。

**展开框架：**
1. **InnoDB 隐藏列** — DB_TRX_ID（事务 ID）、DB_ROLL_PTR（指向 undo log 的回滚指针）
2. **版本链** — 每次修改生成 undo log，通过 roll_pointer 链接成历史版本链
3. **ReadView** — 记录"当前活跃事务列表"，决定当前事务能看到哪个版本

**收尾：** 这块我在项目里也踩过坑——想深入的话，可以接着聊：MVCC 解决了幻读吗？您更想看哪个方向？

## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡 | "InnoDB MVCC、锁与事务隔离——这道题面试官到底想考什么？我用 30 秒给你讲透。" | 开场钩子 |
| 0:15 | 锁状态转换图 | 先说核心：MVCC（多版本并发控制）的本质是"给每行数据维护多个版本，读事务读快照（不加锁），写事务加行锁写新版本"——让读写不互相阻塞，大幅提升并发。InnoDB 通过隐藏列（trx_。 | 核心定义 |
| 0:30 | SQL EXPLAIN 截图 | 每次修改生成 undo log，通过 roll_pointer 链接成历史版本链。 | 版本链 |
| 1:30 | 总结卡 | 一句话记忆：MVCC = 多版本（undo log 版本链）+ ReadView（可见性判断）。 下期可以接着聊：MVCC 解决了幻读吗。 | 收尾总结 |
