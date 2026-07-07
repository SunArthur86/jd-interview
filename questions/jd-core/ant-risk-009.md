---
id: ant-risk-009
difficulty: L3
category: jd-core
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
