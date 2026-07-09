---
id: pdd-content-007
difficulty: L4
category: pdd-content
subcategory: MySQL
tags:
- 拼多多
- 内容
- MySQL
- MVCC
- 事务隔离
feynman:
  essence: MVCC 用"undo log 版本链 + ReadView"实现快照读，不加锁实现 RC/RR 隔离；内容场景评价读取用 MVCC 避免锁等待。
  analogy: MVCC 像档案馆——每次改都留底稿（undo），读者按"领取时间"看对应版本，互不打扰。
  first_principle: 读读不冲突天然安全，读写互斥加锁慢，用版本快照让读不加锁。
  key_points:
  - 隐藏字段：trx_id（事务ID）/roll_pointer（指向 undo）
  - undo 版本链：每改一次留一份
  - ReadView：事务开启时的活跃事务列表
  - RC vs RR：ReadView 生成时机不同
first_principle:
  problem: 读写互斥加锁慢，如何让读不加锁还能读到一致快照？
  axioms:
  - 读读不冲突
  - 读多写少
  - 加锁降吞吐
  rebuild: 版本链 + ReadView 判断可见性（MVCC）。
follow_up:
  - RC 和 RR 的快照差异？——RC 每次读生成新 ReadView，RR 第一次读生成
  - 幻读怎么解决？——RR 用间隙锁（当前读）+ MVCC（快照读）
  - 当前读 vs 快照读？——当前读取最新（for update），快照读走 MVCC
memory_points:
  - 隐藏字段：trx_id + roll_pointer
  - undo 版本链
  - ReadView：活跃事务列表
  - RC 每次/RR 首次生成 RV
---

# 【拼多多内容】MVCC 原理与评价读写隔离？

> JD 依据："稳定性建设"、"系统架构优化"。

## 一、为什么需要 MVCC

```
传统锁：写时读阻塞（X 锁排他）→ 读吞吐差
MVCC：读走快照不加锁，写走当前版本 → 读写不冲突
```

## 二、三个核心组件

**1. 隐藏字段**（InnoDB 每行）：
```
review 表一行：
  id | product_id | content | ... | trx_id（最后改的事务ID） | roll_pointer（指向 undo）
```

**2. undo log 版本链**：
```
T3 修改：  content="好" trx_id=300 → roll_ptr → undo
T2 修改：  content="差" trx_id=200 → roll_ptr → undo
T1 插入：  content="" trx_id=100
```
每次改前把旧值写 undo，roll_pointer 串成链表。

**3. ReadView**（快照）：
```
ReadView {
  m_ids：当前活跃（未提交）事务 ID 列表
  min_trx_id：m_ids 最小值
  max_trx_id：下一个将分配的事务 ID
  creator_trx_id：当前事务 ID
}
```

## 三、可见性判断规则

对版本的 trx_id：

```
1. trx_id == creator_trx_id：自己改的，可见
2. trx_id < min_trx_id：生成时已提交，可见
3. trx_id >= max_trx_id：ReadView 之后才开的事务，不可见
4. min_trx_id <= trx_id < max_trx_id：
   - 在 m_ids 中：活跃（未提交），不可见
   - 不在 m_ids 中：已提交，可见
```

不可见则顺 roll_pointer 找上一版本。

## 四、RC vs RR

| | Read Committed | Repeatable Read |
|---|---|---|
| ReadView 生成 | 每次快照读都生成 | 事务第一次读时生成 |
| 效果 | 同一查询可能读到不同值 | 同事务内可重复读 |

```
事务 A（RR）             事务 B
BEGIN
SELECT * FROM review WHERE id=1  → 读到 v1（生成 RV）
                          BEGIN
                          UPDATE review SET content='x' WHERE id=1
                          COMMIT
SELECT * FROM review WHERE id=1  → 仍读到 v1（用同一 RV）
```

## 五、内容场景应用

**评价列表读（高并发）**：
```java
// 读用快照读（MVCC），不阻塞写
@Transactional(isolation = Isolation.REPEATABLE_READ)
public List<Review> listReviews(Long productId) {
    return reviewDao.findByProductId(productId);
}
```

**审核改状态（当前读，加锁）**：
```java
// 当前读（FOR UPDATE）保证读到最新并加锁
@Transactional
public void audit(Long id, int status) {
    Review r = reviewDao.findByIdForUpdate(id);  // SELECT ... FOR UPDATE
    r.setStatus(status);
    reviewDao.save(r);
}
```

**避免热点商品评价写入阻塞读**：MVCC 让商品页读取不被审核写入阻塞。

## 六、幻读问题

```
RR 隔离下：
快照读：MVCC 解决（同一 ReadView）
当前读：间隙锁（Gap Lock）/ 临键锁（Next-Key Lock）解决
  SELECT * FROM review WHERE product_id = 100 FOR UPDATE;
  → 锁住 product_id=100 的所有行 + 间隙，防止插入
```

## 七、底层本质

MVCC 本质是**"用版本链+ReadView 让读不加锁看历史快照"**——读读/读写不冲突，仅写写互斥，吞吐大幅提升。

## 常见考点
1. **MVCC 解决了什么问题**？——读写冲突，读不加锁提吞吐。
2. **RR 完全解决幻读吗**？——快照读解决，当前读用间隙锁解决，但混合使用仍可能。
3. ** undo log 怎么清理**？——purge 线程，当没有更早的 ReadView 引用时回收。
