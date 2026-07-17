---
id: pdd-scm-013
difficulty: L2
category: pdd-scm
subcategory: Redis
tags:
- 拼多多
- 供应链
- Redis
- 持久化
- RDB
- AOF
feynman:
  essence: Redis 持久化两种方式——RDB（全量快照，体积小恢复快但有丢失窗口）和 AOF（追加每条写命令，更安全但体积大），生产用 AOF + RDB 混合。
  analogy: RDB 像定期拍全仓照（恢复快但丢增量），AOF 像录每笔出入库流水（完整但文件大），混合用最佳。
  first_principle: 纯内存 Redis 重启数据丢，需要持久化兜底；RDB 和 AOF 在"恢复速度 vs 数据安全"上各有取舍。
  key_points:
  - RDB：bgsave 全量快照，二进制压缩，恢复快但丢最后一段
  - AOF：append 写命令，everysec（折中），文本可读
  - 混合（4.0+）：AOF rewrite 时用 RDB 格式存全量 + 后续追加命令
  - fork + COW 实现非阻塞快照
first_principle:
  problem: Redis 内存数据库重启数据丢，如何持久化且不影响性能？
  axioms:
  - 持久化要异步（不阻塞主线程）
  - 全量快照恢复快但有窗口
  - 操作日志完整但文件大
  rebuild: RDB（fork+COW 全量快照）+ AOF（追加写命令，everysec 刷盘）+ 混合（AOF rewrite 嵌 RDB）。
follow_up:
- Redis 怎么实现非阻塞快照？——fork 子进程 + COW（写时复制）
- AOF 文件太大怎么办？——bgrewriteaof 重写（合并命令 + RDB 全量）
- 生产选哪种？——AOF everysec + RDB 定时（混合）
memory_points:
- RDB：全量快照，恢复快，丢窗口
- AOF：追加命令，everysec（最多丢 1s）
- 混合 4.0+：AOF rewrite = RDB 全量 + 后续命令
- fork + COW 实现非阻塞快照
---

# 【拼多多供应链】Redis 持久化 RDB 和 AOF 怎么选？

> JD 依据："熟悉 Redis 原理"。

## 一、RDB（快照）

```redis
BGSAVE  # fork 子进程生成 dump.rdb
```

- 全量二进制快照，体积小，恢复快
- 缺点：两次快照间数据丢
- fork + COW：子进程写 RDB，主进程继续服务；父进程修改页时 COW 复制

## 二、AOF（追加日志）

```redis
CONFIG SET appendonly yes
CONFIG SET appendfsync everysec   # 每秒刷盘（折中）
```

- 追加每条写命令，文本格式
- 三种刷盘：always（最安全慢）、everysec（折中，最多丢 1s）、no（OS 决定）
- 文件大 → `BGREWRITEAOF` 重写（合并等价命令）

## 三、混合持久化（4.0+，生产推荐）

```
AOF rewrite 时：
  前半 = RDB 格式（当前全量快照）
  后半 = 增量 AOF 命令（rewrite 后的写）
```

恢复快（RDB 部分快）+ 数据全（AOF 增量补）。

## 四、供应链 Redis 配置

```redis
# 生产配置
appendonly yes
appendfsync everysec
auto-aof-rewrite-percentage 100
auto-aof-rewrite-min-size 64mb
save 900 1              # RDB 兜底
save 300 10
```

库存、商品缓存用 Redis，持久化保证重启不丢（虽然缓存丢了可从 DB 恢复，但持久化能快速恢复减少 DB 压力）。

## 五、底层本质

持久化是"恢复速度 vs 数据完整性"的权衡：
- RDB：快（全量二进制）但有窗口
- AOF：全（每条命令）但慢
- 混合：二者优点结合

## 常见考点
1. **fork 会不会阻塞**？——fork 本身快（复制页表），但大内存实例 fork 慢（页表大），用 `vm.overcommit_memory=1`。
2. **AOF 重写阻塞吗**？——主进程不阻塞（fork 子进程），但重写期间新命令同时写旧 AOF 和缓冲，重写完替换。
3. **Redis 4.0 混合持久化**？——AOF rewrite 嵌入 RDB，恢复先加载 RDB 快，再 replay AOF 增量。

## 苏格拉底式面试追问

> 这组追问不是背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：供应链的 Redis 主要存商品缓存和库存（热点数据），你配了 AOF everysec。但缓存丢了从 DB 恢复就行，为什么要配 AOF？是不是多此一举？**

不是多此一举，两个场景不同：
1. **商品缓存**——确实是缓存语义，丢了从 DB 重新 load，可以不配 AOF（纯 RDB 兜底甚至不持久化）。
2. **库存（Redis 是权威源）**——大促时库存扣减在 Redis Lua 原子完成，Redis 是权威数据源，DB 是异步对账。如果 Redis 重启丢了 30 秒扣减数据，DB 对不上，超卖或漏卖。所以库存这个 key 空间必须配 AOF everysec，保证重启最多丢 1 秒。
策略是**按 key 空间区分**：缓存类（`product:*`）用 RDB 或不持久化，权威数据类（`stock:*`）用 AOF。Redis 实例隔离（缓存和库存分不同实例），各自配持久化策略。

### 第二层：证据与定位

**Q：Redis 主库突然 OOM 重启，从库提升为主。你怎么确认从库数据和原主库一致、没有丢扣减记录？**

三步排查：
1. **看 AOF 最后时间点**——原主库的 `redis-check-aof dump.aof` 看最后几条命令的 `SET/DECRBY stock:*`，对比从库提升为主的时间点，差值就是潜在丢失窗口（最多 1 秒 if everysec）。
2. **对账 DB**——`SELECT order_id, qty FROM stock_log WHERE create_time BETWEEN [重启前10秒] AND [重启后10秒]`，这些订单的扣减要和 Redis 的 `stock:*` 值吻合。如果 Redis 少了，是 AOF 丢的。
3. **看 `INFO persistence`**——`aof_last_bgrewrite_status` 和 `rdb_last_bgsave_status`，如果 failed，说明持久化异常，重启必然丢数据。

### 第三层：根因深挖

**Q：你配了 AOF everysec，但重启后发现丢了 30 秒数据（不是 1 秒）。根因是什么？**

everysec 最多丢 1 秒的前提是"OS 正常 fsync"，丢了 30 秒说明 fsync 没正常执行。三个根因：
1. **AOF 重写期间阻塞**——AOF rewrite 时主进程把新命令写 aof_buf，同时 fork 的子进程写全量 RDB。如果 rewrite 耗时长（大实例），期间 aof_buf 的 fsync 被延迟，主进程只在 rewrite 结束后一次性 fsync，30 秒数据在内存里没落盘，这时 OOM 就丢。
2. **磁盘 IO 饱和**——如果 Redis 和别的 IO 密集服务（如 MySQL）共用磁盘，磁盘 IO 满，everysec 的 fsync 排队等不到，实际延迟到几十秒。看 `iostat -x 1` 的 `%util`，> 90% 就是磁盘瓶颈。
3. **`no-appendfsync-on-rewrite yes`**——这个配置在 AOF rewrite 期间禁用 fsync（避免磁盘竞争），rewrite 越久，禁用窗口越大。大实例 rewrite 30 秒就丢 30 秒。
根因定位：看 AOF rewrite 耗时（`INFO stats` 的 `aof_rewrite_time`），如果 > 30 秒，就是 rewrite 期间禁用 fsync 导致的丢数据。

**Q：那为什么不直接用 appendfsync always（每条命令都 fsync），彻底不丢数据？**

always 的代价是性能灾难：
1. **fsync 慢**——每次 fsync 要等磁盘真正写入（HDD 5-10ms，SSD 0.5-1ms），每条 SET 都等，QPS 从 10 万掉到几百。
2. **磁盘寿命**——SSD 的 fsync 次数有写寿命限制，频繁 fsync 加速 SSD 磨损。
供应链的权衡是"最多丢 1 秒（everysec）+ 业务幂等兜底"——就算丢 1 秒扣减记录，DB 对账时发现偏差，用 stock_log 重放补偿。always 在性能上不可接受，除非是金融级"绝对不能丢"的场景（用 ZK/etcd 更合适，不是 Redis）。

### 第四层：方案权衡

**Q：大促时 Redis 实例内存 30GB，AOF rewrite 要 fork 子进程，fork 时主进程卡顿几百毫秒。你怎么解决？**

fork 慢的根因是"复制页表"——30GB 内存的页表约 60MB，fork 要复制这个页表，耗时几百毫秒，期间主进程 STW。三种方案：
1. **减小实例**——把 30GB 拆成 3 个 10GB 实例（分片），fork 时间降到 1/3。这是最治本的，单实例不超 10GB 是 Redis 最佳实践。
2. **关 THP（Transparent Huge Pages）**——THP 把 4KB 页合并成 2MB，fork 时 COW 复制粒度变大，写 1 字节也要复制 2MB。`echo never > /sys/kernel/mm/transparent_hugepage/enabled` 关掉，fork 后 COW 内存增长更小。
3. **延迟 AOF rewrite**——调大 `auto-aof-rewrite-percentage`（如 200），让 rewrite 频率降低，减少 fork 次数。配合监控 fork 耗时（`INFO stats` 的 `latest_fork_usec`），超阈值告警。

**Q：为什么不直接用 Redis Cluster 分片，把数据分散到多节点，单节点内存小 fork 快？**

Redis Cluster 是正解，但有适用前提：
1. **数据可分片**——库存 key 按 sku_id 分片（`slot = CRC16(sku_id) % 16384`），同一 SKU 的扣减在同一节点，原子性保证。这是 Cluster 的标准用法。
2. **跨槽查询限制**——如果业务要 `MGET stock:1 stock:2 stock:3` 且这三个 key 在不同槽，Cluster 会报错（要用 hash tag `{sku}.stock` 强制同槽，或多次查询）。供应链的多 SKU 扣减（如组合商品）要设计 hash tag。
3. **运维复杂度**——Cluster 要 6+ 节点（3 主 3 从），故障切换、扩缩容比单实例复杂。
所以策略是：热数据（库存）用 Cluster 分片，冷数据（缓存）用单实例 + 主从。不是所有 Redis 都上 Cluster。

### 第五层：验证与沉淀

**Q：你怎么证明 Redis 持久化方案可靠、故障切换后数据丢失在可接受范围？**

混沌演练验证：
1. **故障注入**——生产低峰期 kill -9 主库 Redis，看从库提升为主后的数据状态。对比 kill 前后的 `stock:*` 值，差值应 < 1 秒扣减量（everysec 兜底）。大促前必跑。
2. **持久化健康度监控**——`INFO persistence` 采集 `aof_last_write_status`、`rdb_last_bgsave_status`、`latest_fork_usec`，任一异常告警。`aof_delayed_fsync`（fsync 延迟次数）> 0 说明磁盘慢，要换 SSD 或减负载。
3. **对账巡检**——每天凌晨跑 Redis vs DB 全量对账，`redis_db_diff_count` > 阈值（如 0.001%）告警人工补偿。

**Q：怎么让团队规范配置 Redis 持久化，而不是各服务各写各的？**

沉淀 Redis 使用规范：
1. **实例隔离**——缓存类数据用"缓存集群"（可关 AOF 或 RDB 兜底），权威数据用"持久化集群"（AOF everysec），禁止混用。
2. **配置模板**——Terraform/Ansible 模板统一配 `appendonly yes, appendfsync everysec, save 900 1, no-appendfsync-on-rewrite yes`，新实例自动套用，不允许手改。
3. **内存上限**——单实例 `maxmemory` 不超 10GB，超了强制分片，避免 fork 慢和 AOF rewrite 长。申请大内存 Redis 必须 review。

## 结构化回答

**30 秒电梯演讲：** Redis 内存数据库重启数据丢，如何持久化且不影响性能？简单说就是——Redis 持久化两种方式——RDB（全量快照，体积小恢复快但有丢失窗口）和 AOF（追加每条写命令，更安全但体积大），生产用 AOF + RDB 混合。

**展开框架：**
1. **RDB** — RDB：bgsave 全量快照，二进制压缩，恢复快但丢最后一段
2. **AOF** — AOF：append 写命令，everysec（折中），文本可读
3. **混合4.0+** — 混合（4.0+）：AOF rewrite 时用 RDB 格式存全量 + 后续追加命令

**收尾：** 您看这块要不要再展开聊聊？

## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：Redis 持久化 RDB 和 AOF 怎么选？ | 今天聊「Redis 持久化 RDB 和 AOF 怎么选？」。一句话：Redis 持久化两种方式 | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：RDB：bgsave 全量快照，二进制压缩，恢复快但丢最后一段 | 核心概念 |
| 1:00 | 能力/参数拆解表 | 要点是：AOF：append 写命令，everysec（折中），文本可读 | 能力拆解 |
| 2:00 | 总结卡 + 下期预告 | 记住核心要点就够了。下期见。 | 收尾 |
