---
id: pdd-scm-012
difficulty: L3
category: pdd-scm
subcategory: MySQL
tags:
- 拼多多
- 供应链
- MySQL
- MVCC
- 事务隔离
feynman:
  essence: InnoDB 用 undo log 版本链 + read view 实现 MVCC，让读写不互相阻塞；RC 每次 select 建 read view（看到最新已提交），RR 首次 select 建 read view 后复用（可重复读）。
  analogy: MVCC 像维基百科版本历史——每篇文章（行）有历史版本，读者读"开始时快照"（read view），作者改出新版本不冲突。
  first_principle: 读加锁会阻塞写，性能差；MVCC 让读不加锁（看历史版本）、写创新版本，从架构上消除读写竞争。
  key_points:
  - 4 级隔离：RU/RC/RR（默认）/Serializable
  - 隐藏列 trx_id + roll_pointer 维护版本链
  - RC 每次读建 read view；RR 首次读建后复用
  - RR 用 Next-Key Lock 解决幻读
first_principle:
  problem: 高并发下读写如何不互相阻塞？
  axioms:
  - 读加锁阻塞写
  - 保留历史版本可让读按快照
  - 事务有"开始时间"，决定可见性
  rebuild: 每行存版本链（undo log），读时按 read view 判定可见版本；RC 每次重建 view（看最新），RR 只建一次（看快照）。
follow_up:
- RC 和 RR 怎么选？——供应链通常 RC（无 Gap Lock 并发高）+ 业务幂等；金融强一致用 RR
- 幻读怎么解决？——RR 下 Next-Key Lock（行锁+间隙锁）；RC 不解决（接受幻读）
- 长事务为什么危险？——undo 版本链无法 purge，膨胀回滚段
memory_points:
- MVCC = undo 版本链 + read view 可见性判定
- RC 每次读建 view；RR 首次读建后复用
- Next-Key Lock = Record Lock + Gap Lock（RR 防幻读）
- 隐藏列 trx_id + roll_pointer
---

# 【拼多多供应链】MySQL 事务隔离级别？MVCC 原理？

> JD 依据："熟悉 MySQL 原理，具备性能调优能力"。

## 一、四个隔离级别

| 级别 | 脏读 | 不可重复读 | 幻读 |
|------|------|----------|------|
| 读未提交 RU | ✗ | ✗ | ✗ |
| 读已提交 RC | ✓ | ✗ | ✗ |
| 可重复读 RR（默认） | ✓ | ✓ | ✓（InnoDB） |
| 串行化 S | ✓ | ✓ | ✓ |

## 二、MVCC 实现

**三要素**：
1. 隐藏列：`DB_TRX_ID`（最后修改事务）、`DB_ROLL_PTR`（指向 undo 旧版本）
2. undo log 版本链：roll_pointer 串联历史版本
3. read view：读时建立，记录"当前活跃事务列表"

**可见性判定**（沿版本链找第一个可见版本）：
```
版本的 trx_id = T：
  T == 自己 → 可见
  T < min_trx_id → 已提交，可见
  T >= max_trx_id → 未来事务，不可见，找上一版本
  T 在活跃列表 → 不可见，找上一版本
  T 不在活跃列表 → 已提交，可见
```

## 三、RC vs RR

唯一区别：**read view 建立时机**。
- RC：每次 SELECT 都建（看到最新已提交）
- RR：事务首次 SELECT 建，整个事务复用（快照读）

## 四、供应链场景

**订单状态机查询**（RR）：
```sql
START TRANSACTION;
SELECT status FROM orders WHERE id = 1;  -- 假设读到 'PAID'
-- 其他事务改成 SHIPPED 并提交
SELECT status FROM orders WHERE id = 1;  -- RR 仍读 'PAID'（快照）
COMMIT;
```

**库存扣减**（当前读 + 行锁）：
```sql
SELECT qty FROM stock WHERE sku=1 FOR UPDATE;  -- 当前读，加行锁
-- 业务判断
UPDATE stock SET qty = qty - 1 WHERE sku=1;
```

## 五、长事务的坑

长事务持续不提交 → undo 版本链无法 purge → 回滚段膨胀 → 备份慢、性能降。供应链跑批要拆小事务（每 1000 条 commit）。

## 六、底层本质

MVCC 是**"不可变数据 + 时间快照"**思想在数据库的体现：
- 写不阻塞读（读看历史版本）
- 读不阻塞写（读不加锁）
- 不同事务看不同版本

代价是 undo 膨胀，需 purge 清理。

## 常见考点
1. **快照读和当前读**？——普通 SELECT 是快照读（MVCC）；FOR UPDATE/UPDATE/DELETE 是当前读（最新+加锁）。
2. **MVCC 解决幻读吗**？——只解决快照读幻读；当前读仍需 Next-Key Lock。
3. **供应链为什么选 RC**？——无 Gap Lock 并发高，配合业务幂等设计。
