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

## 苏格拉底式面试追问

> 这组追问不是背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：供应链系统你选 RC（读已提交）而不是 MySQL 默认的 RR（可重复读）。金融场景都用 RR，供应链为什么不一样？**

因为供应链追求"高并发 + 业务幂等"，而金融追求"强一致"。RR 在 InnoDB 下用 Next-Key Lock（行锁+间隙锁）防幻读，但间隙锁的代价是——并发 INSERT 时会锁住"间隙"，多个订单同时插入同一区间的订单号会互相阻塞，并发度骤降。RC 没有间隙锁，INSERT 互不阻塞，并发高。供应链用 RC + 业务幂等（订单号唯一索引、扣减幂等键）兜底，不需要靠数据库锁保证一致性。金融必须 RR 是因为对账要求"事务内看到一致快照"。

### 第二层：证据与定位

**Q：库存扣减批量跑批时出现死锁（Deadlock found when trying to get lock; try restarting transaction）。你怎么定位是哪些事务互锁？**

用 InnoDB 死锁日志 + 锁等待表：
1. **看死锁日志**——`SHOW ENGINE INNODB STATUS` 的 `LATEST DETECTED DEADLOCK` 段，它会打印两个事务各自持有和等待的锁。比如：
   - 事务 A 持有 `lock: stock (sku_id=1)` 的行锁，等待 `sku_id=2`
   - 事务 B 持有 `sku_id=2`，等待 `sku_id=1`
   典型的交叉扣减死锁。
2. **看锁等待**——`SELECT * FROM information_schema.innodb_lock_waits` 查当前锁等待关系，`innodb_trx` 看事务的 SQL 和持有行数。
3. **看业务调用**——死锁的两个事务分别扣了 sku 1 和 2，根因是不同请求的扣减顺序不一致（A 先 1 后 2，B 先 2 后 1）。统一扣减顺序（按 sku_id 升序）就能消除死锁。

### 第三层：根因深挖

**Q：你统一了扣减顺序，但还是有死锁，日志显示是 Gap Lock 导致的。但你不是用 RC 吗，RC 怎么会有 Gap Lock？**

RC 确实没有大部分 Gap Lock，但有**例外**：外键约束检查和唯一性检查时会临时加 Gap Lock。根因大概率是：
1. **唯一索引冲突检查**——`INSERT INTO stock_log (order_id, sku) VALUES (...)`，`order_id` 有唯一索引，INSERT 时 InnoDB 要检查唯一性，对 `(order_id)` 加 Gap Lock 防止并发插入相同值。两个事务同时插入相邻 order_id 就会 Gap Lock 互锁。
2. **外键约束**——如果 `stock_log.sku_id` 有外键指向 `stock.sku_id`，INSERT 时会检查父表，加 Gap Lock。
定位：死锁日志里看锁类型，如果 `lock_mode X locks gap before rec`，就是 Gap Lock。解法：去掉不必要的外键（供应链高并发场景一般不用外键，靠应用保证），或把唯一索引改成普通索引 + 应用层幂等校验。

**Q：那为什么不直接把所有扣减改成 SELECT FOR UPDATE 先加锁，串行化执行彻底避免死锁？**

串行化是杀鸡用牛刀，会摧毁并发性能：
1. **行锁等待**——`SELECT FOR UPDATE` 对所有涉及行加 X 锁，其他事务必须等，QPS 从几千掉到几十。
2. **锁升级**——范围查询 `WHERE category_id=100 FOR UPDATE` 可能锁住多行甚至间隙，并发度更低。
正确做法是"缩短锁持有时间 + 固定加锁顺序"：
1. 把 `SELECT FOR UPDATE` + `UPDATE` 缩成一个事务，事务里不做 RPC 调用（避免锁等待时网络超时）。
2. 按固定顺序加锁（sku_id 升序），消除循环等待。
3. 用乐观锁替代悲观锁（`UPDATE stock SET qty=qty-1 WHERE sku=? AND qty>=?`，影响行数=0 重试），大部分场景无锁竞争。

### 第四层：方案权衡

**Q：库存扣减你用 RC + 乐观锁（UPDATE ... WHERE qty>=?），但大促时大量扣减失败重试（影响行数=0），怎么办？**

乐观锁在"高竞争热点"下退化（大量失败重试）。两种方案：
1. **热点分桶**——把 sku_id=1 的库存 1000 拆成 10 桶（`stock_slot_0` 到 `stock_slot_9` 各 100），扣减时按 threadId 或随机选桶，失败再试其他桶，把单行竞争分散 10 倍。
2. **Redis 前置扣减**——热点 SKU 在 Redis Lua 扣减（高性能），DB 异步对账。MySQL 只兜底，不扛大促峰值。

**Q：为什么不直接用 SELECT FOR UPDATE 悲观锁，保证扣减一定成功？**

悲观锁保证"语义正确"但不保证"性能可用"：
1. **热点 SKU 行锁排队**——爆款商品的所有扣减请求都等同一行锁，QPS 被压到几十，大促直接超时。
2. **锁等待超时**——`innodb_lock_wait_timeout=50s`，排队 50 秒后报错，用户体验灾难。
乐观锁虽然部分失败，但配合"快速失败 + 前端重试"（返回"手慢了，再试一次"），比悲观锁的全局排队体验更好。供应链策略是：Redis 挡热点（99% 请求在 Redis 扣成功），MySQL 做兜底（冷门 SKU + 对账），两者结合。

### 第五层：验证与沉淀

**Q：你怎么证明数据库的死锁率在可控范围、RC + 乐观锁方案没有引入新问题？**

三个监控指标：
1. **死锁计数**——`SHOW GLOBAL STATUS LIKE 'Innodb_deadlocks'`，每分钟采集，大促时 < 10 次/分钟可接受（业务层重试兜底），> 100 次/分钟告警（扣减顺序或锁粒度有问题）。
2. **锁等待时间**——`innodb_lock_waits` 表的 `waiting_started` 和当前时间差，P99 < 50ms 正常；> 500ms 说明热点行锁严重，要分桶或上 Redis。
3. **乐观锁失败率**——`UPDATE ... WHERE qty>=?` 影响行数=0 的比例，正常 < 5%（偶尔库存不足）；如果 > 30%，说明竞争过激，要分桶。

**Q：怎么让团队写扣减/事务代码时不再踩死锁和长事务的坑？**

沉淀规范：
1. **事务规范文档**——明确"事务内不做 RPC/远程调用（避免锁等待超时）""事务粒度 ≤ 100ms""多行更新按主键升序加锁"。
2. **慢事务监控**——`information_schema.innodb_trx` 采集运行 > 1 秒的事务，告警 + 记录 SQL，定位长事务源头（如跑批没 commit）。
3. **Code Review checklist**——所有 `@Transactional` 注解必须 review：方法内不能有循环 RPC、不能有大查询、扣减多 SKU 必须排序。SonarQube 扫 `@Transactional` 包含 `for/while` 的代码报 critical。

## 结构化回答

**30 秒电梯演讲：** 高并发下读写如何不互相阻塞？简单说就是——InnoDB 用 undo log 版本链 + read view 实现 MVCC，让读写不互相阻塞；RC 每次 select 建 read view（看到最新已提交）。

**展开框架：**
1. **4 级隔离** — 4 级隔离：RU/RC/RR（默认）/Serializable
2. **隐藏列 tr** — 隐藏列 trx_id + roll_pointer 维护版本链
3. **RC 每次读** — RC 每次读建 read view；RR 首次读建后复用

**收尾：** 您看这块要不要再展开聊聊？

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：MySQL 事务隔离级别？MVCC 原理？ | 今天聊「MySQL 事务隔离级别？MVCC 原理？」。一句话：InnoDB 用 undo log 版本链 + read view 实现 MVCC，让读写不互相阻塞；RC 每次 se… | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：4 级隔离：RU/RC/RR（默认）/Serializable | 核心概念 |
| 1:04 | 能力/参数拆解表 | 要点是：隐藏列 trx_id + roll_pointer 维护版本链 | 能力拆解 |
| 1:56 | 流程图：输入→处理→输出 | 要点是：RC 每次读建 read view；RR 首次读建后复用 | 关键机制 |
| 3:00 | 总结卡 + 下期预告 | 记住核心要点就够了。下期见。 | 收尾 |
