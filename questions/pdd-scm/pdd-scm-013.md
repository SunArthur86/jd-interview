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
