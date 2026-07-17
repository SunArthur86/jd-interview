---
id: java-architect-149
difficulty: L2
category: java-architect
subcategory: MySQL
title: 数据库在线 DDL 与无损变更
tags: [DDL, gh-ost, pt-online-schema-change, 无锁变更, MySQL]
related: [java-architect-150, java-architect-142, java-architect-141]
---

# 数据库在线 DDL 与无损变更

> **场景**：京东订单表 50 亿行，要给 `t_order` 加一个 `risk_level` 字段。直接 `ALTER TABLE` 会锁表几小时，业务全停。面试官问：在线 DDL 怎么做？gh-ost 和 pt-osc 怎么选？

## 一、概念层：DDL 的核心痛点

### 1.1 MySQL 原生 DDL 的三种代价

| DDL 类型 | MySQL 5.6+ 支持 | 锁级别 | 耗时（亿级表） |
|----------|-----------------|--------|----------------|
| 加列（无默认值） | ✅ INPLACE | 不锁 | 分钟级 |
| 加列（有默认值） | ⚠️ 部分 | 元数据锁 | 分钟-小时 |
| 修改列类型 | ❌ COPY | 全表锁 | 小时级 |
| 加索引 | ✅ INPLACE | 不锁（写阻塞） | 分钟级 |
| 改字符集 | ❌ COPY | 全表锁 | 小时级 |

**问题**：
- 即使是 INPLACE，也会在开始/结束阶段短暂持有**元数据锁（MDL）**，长事务会把 MDL 等待放大为长时间阻塞
- COPY 模式直接锁全表，业务停摆
- 主从延迟：大 DDL 在从库回放，造成分钟-小时级延迟

### 1.2 在线 DDL 的核心思想

**影子表 + Trigger/Binlog 同步**：

```
1. 创建影子表 _t_order_new（结构与原表相同 + DDL 变更）
2. 拷贝数据：原表 → 影子表（分批，避免压力）
3. 持续同步增量：原表的 INSERT/UPDATE/DELETE 同步到影子表
4. 数据一致后，原子 RENAME：原表 → _t_order_old，影子表 → t_order
5. 删除旧表
```

整个过程业务无感知，无锁。

## 二、机制层：两种主流工具

### 2.1 pt-online-schema-change（pt-osc，Percona Toolkit）

**原理**：用 MySQL **触发器**同步增量。

```
原表 t_order ──触发器──→ 影子表 _t_order_new
       │
       └─分块拷贝─→ 影子表 _t_order_new
```

```bash
# 加字段
pt-online-schema-change \
  --alter "ADD COLUMN risk_level TINYINT DEFAULT 0 COMMENT '风控等级'" \
  --host=mysql-master.jd.local --port=3306 \
  --user=admin --ask-pass \
  D=trade_order,t=t_order \
  --execute \
  --chunk-size=2000 \
  --max-load="Threads_running=50" \      # 超过阈值暂停
  --critical-load="Threads_running=200" \ # 超过阈值中止
  --alter-foreign-keys-method=auto
```

**优点**：成熟稳定，Percona 出品，使用广泛
**缺点**：
- 触发器有性能损耗（写入放大 2-3 倍）
- 需要表有主键/唯一键
- 高并发写场景触发器成为瓶颈

### 2.2 gh-ost（GitHub Online Schema Change）

**原理**：用 **binlog 订阅**同步增量，不用触发器。

```
原表 t_order ──binlog──→ gh-ost ──→ 影子表 _t_order_ghost_
       │
       └─分块拷贝─→ 影子表 _t_order_ghost_
```

```bash
gh-ost \
  --host=mysql-master.jd.local \
  --user=admin --password=******** \
  --database=trade_order --table=t_order \
  --alter="ADD COLUMN risk_level TINYINT DEFAULT 0 COMMENT '风控等级'" \
  --execute \
  --chunk-size=2000 \
  --max-load='Threads_running=50' \
  --critical-load='Threads_running=200' \
  --max-lag-millis=1500 \              # 从库延迟超 1.5s 暂停
  --throttle-control-replicas="slave1.jd.local:3306,slave2.jd.local:3306"
```

**优点**：
- 无触发器，写入零损耗
- 可暂停（支持 `kill -SIGUSR2` 暂停/恢复）
- 可控流量（throttle 机制）
- 支持 dynamic 交互（运行时调整参数）

**缺点**：
- 表必须有主键/唯一键
- binlog_format 必须是 ROW
- 对级联外键支持有限

### 2.3 选型对比

| 维度 | pt-osc | gh-ost |
|------|--------|--------|
| 同步机制 | 触发器 | binlog |
| 写入损耗 | 高（2-3 倍放大） | 零 |
| 暂停/恢复 | 不支持 | 支持（信号） |
| 外键 | 支持 | 有限 |
| 高并发写 | 不适合 | 适合 |
| 成熟度 | 极高 | 高 |
| JD 选用 | 历史遗留 | 主推 |

**JD 实践**：高并发大表用 gh-ost，老旧表（有复杂外键）用 pt-osc。

## 三、实战层：JD 大表 DDL 全流程

### 3.1 变更前评估

```sql
-- 1. 检查表大小
SELECT 
  table_name,
  table_rows,
  ROUND(data_length/1024/1024/1024, 2) AS data_gb,
  ROUND(index_length/1024/1024/1024, 2) AS index_gb
FROM information_schema.tables
WHERE table_schema='trade_order' AND table_name='t_order';

-- 2. 检查是否有长事务（会阻塞 MDL）
SELECT * FROM information_schema.innodb_trx 
WHERE TIME_TO_SEC(TIMEDIFF(NOW(), trx_started)) > 60;

-- 3. 检查主从延迟
SHOW SLAVE STATUS\G  -- Seconds_Behind_Master

-- 4. 检查表是否有主键
SHOW INDEX FROM t_order WHERE Key_name='PRIMARY';
```

### 3.2 低峰期执行

```bash
# 用 cron 调度，凌晨 2 点执行
#!/bin/bash
set -e

# 1. 预检
mysql -h master -e "SELECT COUNT(*) FROM information_schema.innodb_trx WHERE TIME_TO_SEC(TIMEDIFF(NOW(), trx_started)) > 60" | tail -1 | {
  read count
  if [ "$count" -gt 0 ]; then
    echo "有长事务，中止"; exit 1
  fi
}

# 2. 执行 gh-ost
gh-ost \
  --host=mysql-master.jd.local --user=admin --password=$PWD \
  --database=trade_order --table=t_order \
  --alter="ADD COLUMN risk_level TINYINT DEFAULT 0" \
  --execute \
  --chunk-size=2000 \
  --max-load='Threads_running=50' \
  --critical-load='Threads_running=200' \
  --max-lag-millis=1500 \
  --throttle-control-replicas="slave1.jd.local,slave2.jd.local" \
  --serve-socket-file=/tmp/gh-ost.sock \
  --verbose \
  2>&1 | tee /var/log/gh-ost-t_order-$(date +%Y%m%d).log

# 3. 验证
mysql -h master -e "DESCRIBE t_order" | grep risk_level
```

### 3.3 动态控制（运行中调整）

```bash
# 暂停
echo "unpostpone" | nc -U /tmp/gh-ost.sock
kill -SIGUSR2 $(pgrep gh-ost)   # 暂停

# 查看进度
echo "status" | nc -U /tmp/gh-ost.sock

# 恢复
kill -SIGUSR1 $(pgrep gh-ost)   # 恢复

# 紧急中止
kill -SIGTERM $(pgrep gh-ost)   # 清理影子表，安全退出
```

### 3.4 失败回滚

gh-ost 失败或中止时：
- 影子表 `_t_order_ghost_` 保留（可手动清理）
- 原表 `t_order` 不受影响（未 RENAME）
- 安全：`DROP TABLE _t_order_ghost_`

最坏情况：cut-over 阶段失败（原子 RENAME 失败），原表不受影响，重跑即可。

## 四、底层本质：DDL 的元数据锁陷阱

### 4.1 First Principle：DDL 的真正风险不是"耗时"而是"锁"

DDL 的风险不在执行时间长（在线 DDL 解决了），而在：
- **MDL（元数据锁）竞争**：DDL 必须获取 MDL 独占锁，期间所有读写被阻塞
- **长事务放大 MDL 等待**：一个开了 1 小时的长事务，DDL 会等它结束才能拿到 MDL，期间新请求也排队等 MDL → 雪崩
- **从库回放延迟**：DDL 在从库串行回放，大 DDL 导致从库小时级延迟

**gh-ost/pt-osc 通过影子表绕开了 MDL 竞争**——业务表的 DDL 是"伪装的"，实际操作的是影子表。

### 4.2 cut-over 的原子性

gh-ost 的 cut-over 阶段是关键：

```sql
-- gh-ost 的 cut-over 原子操作（MySQL 5.7+）
LOCK TABLES t_order WRITE, _t_order_ghost_ WRITE;
RENAME TABLE t_order TO _t_order_del, _t_order_ghost_ TO t_order;
UNLOCK TABLES;
```

整个过程是原子的，业务中断只有毫秒级。

### 4.3 Feynman 解释

把数据库表想象成一栋办公楼，DDL 是装修。
- 原生 DDL：直接在原楼装修，员工没法办公（锁表）。
- 在线 DDL：在旁边盖一栋一模一样的新楼（影子表），盖的过程中原楼照常办公；同时把原楼的人员变动（增删改）同步到新楼；盖好后，让员工瞬间搬到新楼（RENAME 原子），原楼留着备用（随时可回滚）。
- gh-ost：用监控摄像头（binlog）同步人员变动；pt-osc 用前台登记本（触发器）同步。

## 五、AI 架构师加问

**Q1：50 亿行表加字段，gh-ost 跑多久？**
约 5-10 小时（chunk-size=2000，throttle 控制速度）。过程中业务无感知。

**Q2：如果 gh-ost 跑到一半挂了怎么办？**
- 影子表保留，原表不受影响
- 重跑 gh-ost，会从影子表已有进度继续（idemokey 检查）
- 最坏情况：DROP 影子表重来

**Q3：DDL 期间从库延迟怎么处理？**
- gh-ost 的 `--throttle-control-replicas` 监控从库延迟，超过阈值暂停
- JD 实践：`--max-lag-millis=1500`，从库延迟超 1.5s 就暂停主库拷贝

**Q4：什么 DDL 不能用 gh-ost？**
- 无主键/唯一键的表（无法分块）
- 需要修改主键的 DDL
- 表有外键引用（gh-ost 支持有限）

**Q5：JD 大促期间能做 DDL 吗？**
不能。JD 大促期间（618、双 11 前后 1 个月）禁止一切线上 DDL，变更冻结。DDL 必须在大促前 2 周完成，并经过充分测试。

## 六、记忆口诀

```
原生 DDL 锁表坑，gh-ost 影子表无锁行。
binlog 同步无损耗，可暂停可控制可回滚。
pt-osc 触发器有放大，高并发写不适合选。
低峰执行查长事务，throttle 控从库延迟。
cut-over 原子 RENAME，毫秒切换业务无感。
大促冻结禁变更，提前演练保平安。
```

## 七、苏格拉底追问

| 层级 | 问题 | 关键答案 |
|------|------|----------|
| L1 表象 | 直接 ALTER TABLE 大表会怎样？ | 全表锁（COPY 模式）或 MDL 等待，业务停摆 |
| L2 机制 | gh-ost 怎么同步增量？ | 订阅 binlog，解析 ROW 事件应用到影子表 |
| L3 边界 | gh-ost 失败影响原表吗？ | 不影响，原表未 RENAME，影子表可清理 |
| L4 权衡 | gh-ost vs pt-osc？ | 前者无触发器损耗、可暂停；后者成熟、外键支持好 |
| L5 反例 | 有长事务时跑 DDL？ | MDL 等待雪崩，新请求全排队，业务停摆 |
| L6 极限 | 50 亿行表改字符集？ | COPY 模式，必须 gh-ost 但耗时极长（天级），建议新表迁移 |
| L7 系统 | 多机房同步 DDL？ | 各机房独立执行 gh-ost，主从切换后验证 |

**对话还原**：
> 面试官：50 亿行订单表加字段怎么做？
> 我：用 gh-ost。低峰期执行，chunk-size 2000，throttle 控从库延迟 1.5s。整个 5-10 小时，业务无感。
> 面试官：为什么不用原生 ALTER？
> 我：原生会锁表。即使 INPLACE 也要 MDL，有长事务就雪崩。
> 面试官：gh-ost 跑到一半挂了？
> 我：影子表保留，原表没事。重跑或清理影子表。
> 面试官：pt-osc 为什么不用？
> 我：触发器写入放大 2-3 倍，高并发写场景扛不住。我们订单表高峰 10w 写 QPS，pt-osc 不合适。
> 面试官：大促期间能做 DDL 吗？
> 我：不能。我们变更冻结，大促前 2 周完成所有 DDL。

## 八、常见考点

1. **原生 DDL 的风险** —— 锁表、MDL 等待、长事务雪崩
2. **gh-ost 工作原理** —— 影子表 + binlog 同步
3. **pt-osc 工作原理** —— 影子表 + 触发器同步
4. **选型对比** —— 高并发写用 gh-ost，老表/外键用 pt-osc
5. **cut-over 原子性** —— RENAME 是毫秒级
6. **throttle 机制** —— 控制从库延迟和主库负载
7. **预检三件套** —— 表大小、长事务、主从延迟
8. **大促变更冻结** —— 提前 2 周完成 DDL

## 结构化回答

**30 秒电梯演讲：** 京东订单表 50 亿行，要给 `t_order` 加一个 `risk_level` 字段。直接 `ALTER TABLE` 会锁表几小时，业务全停

**展开框架：**
1. **原生 DDL 的风险** — 原生 DDL 的风险 —— 锁表、MDL 等待、长事务雪崩
2. **gh-ost 工作原理** — gh-ost 工作原理 —— 影子表 + binlog 同步
3. **pt-osc 工作原理** — pt-osc 工作原理 —— 影子表 + 触发器同步

**收尾：** 以上是我的整体思路。您想继续深入聊——直接 ALTER TABLE 大表会怎样？


## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：数据库在线 DDL 与无损变更 | "这题一句话：京东订单表 50 亿行，要给 `t_order` 加一个 `risk_level` 字段。" | 开场钩子 |
| 0:15 | 原生 DDL 的风险示意/对比图 | "原生 DDL 的风险 —— 锁表、MDL 等待、长事务雪崩" | 原生 DDL 的风险要点 |
| 0:40 | gh-ost 工作原理示意/对比图 | "gh-ost 工作原理 —— 影子表 + binlog 同步" | gh-ost 工作原理要点 |
| 1:25 | 总结卡 | "记住：原生 DDL 的风险。下期见。" | 收尾 |
