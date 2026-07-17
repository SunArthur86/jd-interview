---
id: ant-risk-011
difficulty: L3
category: ant-risk
subcategory: HBase
tags:
- 蚂蚁
- 风控
- HBase
- LSM
- 大数据
- 列式存储
feynman:
  essence: HBase 用 LSM 树（写内存 + 顺序刷盘 + 后台归并）+ Region 分片 + WAL 保证海量数据的高吞吐写入和按 RowKey 查询。
  analogy: HBase 像一个快递分拣中心：包裹（写入）先放传送带（MemStore 内存），满了批量装车（Flush 到 HFile 顺序写磁盘），夜间合并车辆整理（Compaction 合并小文件）。
  first_principle: 磁盘随机写慢但顺序写快，LSM 把"随机写"转成"顺序写+后台合并"，让写吞吐突破磁盘随机写瓶颈。
  key_points:
  - LSM 树：写 MemStore（内存）→ Flush 成 HFile（磁盘）→ Minor/Major Compaction 合并
  - WAL（Write-Ahead Log）保证写不丢
  - RowKey 字典序排序，Region 按 RowKey 范围切分
  - 写快、按 RowKey 查快，但二级索引弱、聚合差
  - Flush 顺序写磁盘快，Compaction 是写放大的来源
first_principle:
  problem: 如何在海量数据（PB 级）+ 高吞吐写入场景下，平衡写性能、读性能和存储成本？
  axioms:
  - 磁盘顺序写 >> 随机写（百倍差距）
  - 内存有限，不能放下所有数据
  - 数据需要按 key 可查
  rebuild: LSM 树——写先入内存 MemStore，顺序 Flush 成有序文件 HFile，后台 Compaction 把多个 HFile 合并成大的；读走"MemStore + 多 HFile + BlockCache"。代价是写放大和读放大，靠布隆过滤器优化读。
follow_up:
- HBase 为什么快？——写入是 MemStore + WAL 顺序日志，Flush 也是顺序写；读靠 RowKey 排序 + BlockCache + 布隆过滤
- HBase 和 Cassandra 区别？——HBase 中心化（HMaster+RegionServer，强一致），Cassandra 去中心化（P2P，最终一致）
- 风控为什么用 HBase？——海量用户画像（亿级 × 千字段）+ 高频写入（实时特征流）+ 按 uid 查，HBase 是最佳选择
memory_points:
- LSM：MemStore(内存)→Flush→HFile(磁盘顺序写)→Compaction(后台合并)
- WAL 保证写不丢（先写日志再写内存）
- RowKey 排序，Region 按范围分；RowKey 设计是 HBase 性能关键
- 写快（顺序写）+ 读靠 RowKey 快，但二级索引和聚合要靠 Phoenix 或 ES
---

# 【蚂蚁风控】HBase 的底层架构？LSM 树原理？风控的用户画像怎么存在 HBase？

> JD 依据：JD 明确写"HBase"。蚂蚁风控用户画像就是亿级 × 千字段的典型 HBase 场景。

## 一、表面层：HBase 是什么

HBase 是基于 HDFS 的分布式列式 KV 存储，灵感来自 Google Bigtable。

**核心特性**：
- 海量数据（PB 级）、稀疏表（null 不占空间）
- 高吞吐写、按 RowKey 强一致查
- 自动分片（Region）、自动故障转移
- 弱 SQL（需 Phoenix/HBase SQL）

**对比 MySQL**：
| 维度 | MySQL | HBase |
|------|-------|-------|
| 数据规模 | 千万级 | PB 级 |
| 模式 | 强 Schema | 列族灵活 |
| 查询 | SQL 灵活 | 按 RowKey + Scan |
| 事务 | 强 | 单行强一致 |
| 二级索引 | 强 | 弱 |
| 写吞吐 | 中（万/秒） | 极高（百万/秒） |

## 二、逻辑模型：RowKey + 列族

```
RowKey       列族(cf1)                          列族(cf2)
  │          ├─ name ├─ age ├─ risk_score │ ├─ addr ├─ mobile
  ▼
user_001     张三     30      85              杭州     13800...
user_002     李四     25      60              上海     13900...
```

- **RowKey**：主键，按字典序排序（**RowKey 设计是 HBase 最重要的优化点**）
- **列族**：列的分组，物理存储在一起（建表时定义，影响 IO）
- **列限定符**：列族下的具体列（动态，按需添加）
- **版本**：每个 cell 默认保留 1 个版本（可配）

## 三、物理架构：Region + HMaster

```
                HMaster (协调)
                    │
    ┌───────────────┼───────────────┐
    ▼               ▼               ▼
RegionServer1   RegionServer2   RegionServer3
    │               │               │
 [Region A]     [Region B]      [Region C]   ← Region 是 HBase 分片单位
 [Region D]     [Region E]      [Region F]      按 RowKey 范围切分
```

- **Region**：表按 RowKey 范围切分的分片（默认 1 个，达 10GB 分裂）
- **RegionServer**：承载多个 Region，处理读写
- **HMaster**：分配 Region、负载均衡、Schema 变更
- **ZooKeeper**：选主、Region 寻址、状态协调

**Region 寻址**：
```
Client → ZooKeeper → hbase:meta (哪个 RegionServer 有目标 Region)
       → RegionServer → MemStore + HFile
```
首次寻址后客户端缓存 Region 位置，后续直连。

## 四、LSM 树（核心数据结构）

LSM（Log-Structured Merge-Tree）和 B+ 树的根本区别：
- B+ 树：原地更新，随机写
- LSM：追加写，顺序刷盘 + 后台合并

**写入流程**：
```
1. Client put(uid, data)
2. 写 WAL（HDFS 顺序日志，保证不丢）
3. 写 MemStore（内存，按 RowKey 排序）
4. 返回成功
```

**Flush（MemStore 满，默认 128MB）**：
```
MemStore → HFile（顺序写 HDFS）
此时磁盘可能有多个小 HFile
```

**Compaction（后台合并）**：
- **Minor Compaction**：合并几个小 HFile 成中等（默认触发）
- **Major Compaction**：合并所有 HFile 成 1 个，删除已删除/过期版本（重 IO，常关自动定期手动）

```
[HFile1][HFile2][HFile3] ──Minor──▶ [HFileA][HFileB]
                              ──Major─▶ [HFileBIG]
```

## 五、读取流程

```
1. 查 MemStore（内存，最新未刷盘数据）
2. 查 BlockCache（读缓存，LRU）
3. 查 HFile（磁盘）
   ├─ 布隆过滤器先过滤（这个 RowKey 在不在文件里）
   ├─ 二分定位 Block（HDFS 块索引）
   └─ 读出多版本取最新
```

**读优化**：
- **BlockCache**：LRU 缓存热数据块（默认 on-heap 40%）
- **布隆过滤器**：避免扫所有 HFile（误判率 ~1%）
- **HFile 索引**：块索引+布隆一起常驻内存

## 六、RowKey 设计（HBase 最重要的优化）

RowKey 决定数据分布和查询效率：

**设计原则**：
1. **分散**：避免热点（如全用时间戳前缀会聚集到一个 Region）
2. **前缀匹配查询**：常用查询条件放前面
3. **定长**：字典序排序可预期

**反面案例**：
```java
// ❌ 时间戳做前缀，相邻时间全进同一 Region → 热点
rowKey = System.currentTimeMillis() + "_" + uid;

// ✅ 反转时间戳 或 加 hash 前缀分散
rowKey = (Long.MAX_VALUE - timestamp) + "_" + uid;  // 倒序时间，新数据分散
rowKey = (uid.hashCode() % 16) + "_" + uid + "_" + timestamp;  // hash 前缀
```

## 七、风控实战：用户画像存储

**Schema 设计**：
```
表: user_profile
RowKey: reverse(uid) % 100 + "_" + uid   // 散列 + uid
列族: profile（基础属性）、risk（风险特征）、behavior（行为特征）
版本: 1（最新）

存储：亿级用户 × 千字段 = 千亿 cell，单 cell 平均 100B，约 10TB
```

**写入**（实时特征流）：
```java
// Kafka 实时特征 → HBase
Put put = new Put(Bytes.toBytes(hashPrefix(uid) + "_" + uid));
put.addColumn(CF_RISK, Bytes.toBytes("score"), Bytes.toBytes(85));
put.addColumn(CF_RISK, Bytes.toBytes("update_time"), Bytes.toBytes(now));
table.put(put);  // 高吞吐（百万/秒）
```

**查询**（风控决策时）：
```java
Get get = new Get(Bytes.toBytes(hashPrefix(uid) + "_" + uid));
get.addFamily(CF_RISK);  // 只取风险列族（避免取不需要的列族）
Result r = table.get(get);
```

**Scan 查询**（按 uid 前缀范围扫）：
```java
Scan scan = new Scan();
scan.setRowPrefixFilter(Bytes.toBytes(hashPrefix(uid)));  // 前缀过滤
scan.setLimit(100);
ResultScanner rs = table.getScanner(scan);
```

## 八、底层本质：LSM 的"写优先"哲学

B+ 树和 LSM 是数据库存储的两个流派：

| 维度 | B+ 树（MySQL） | LSM（HBase/Cassandra/RocksDB） |
|------|---------------|------------------------------|
| 写 | 随机写（原地改页） | 顺序写（追加 + 后台合并） |
| 读 | 1-4 次 IO | 多文件 + 合并（需缓存） |
| 写放大 | 1（改一页） | 10+（多次 Compaction） |
| 读放大 | 1-4 | 5-10（多 HFile） |
| 空间放大 | 1 | 1.1（旧版本未清理） |
| 适合 | 读多写少 | **写多读少** |

**核心洞察**：磁盘的"顺序写 vs 随机写"差距远大于"内存 vs 磁盘"差距，LSM 牺牲读性能和写放大，换极致写吞吐。

风控场景（实时特征流持续写入）→ 写多读少 → LSM 最优。读热点靠 BlockCache + Redis 兜底。

## 常见考点
1. **HBase 写过程为什么快**？——WAL + MemStore 都是顺序写（HDFS 追加），不需要找磁盘位置；Flush 也是顺序写。
2. **Region 分裂和合并**？——Region 达阈值（默认 10GB）自动分裂；HMaster 平衡 Region 到各 RegionServer；Major Compaction 是手动控制避免 IO 抖动。
3. **HBase 强一致还是最终一致**？——强一致。Region 同一时刻只在一个 RegionServer 提供服务，无副本冲突（HDFS 多副本但 Region 单点）。

**代码示例**（批量写入优化 BulkLoad）：
```java
// 海量数据初始化用 BulkLoad 直接生成 HFile，绕过 RegionServer 写入瓶颈
LoadIncrementalHFiles loader = new LoadIncrementalHFiles(conf);
loader.doBulkLoad(new Path("/tmp/hfiles"), table);  // MapReduce 生成 HFile → 直接 load
```

## 苏格拉底式面试追问

> 这组追问不是背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：风控用户画像你存在 HBase 而不是 MySQL 或 Redis。亿级用户 × 千字段，决策依据是什么？为什么不全用 Redis（内存数据库更快）？**

三个维度决定用 HBase：容量、写吞吐、查询模式。容量上，亿级用户 × 千字段 × 平均 100B ≈ 10TB，Redis 全内存放 10TB 成本极高（内存单价是磁盘 50 倍）。写吞吐上，实时特征流每秒百万次写入，MySQL 单机写万级、Redis 单机写十万级但持久化有瓶颈，HBase 的 LSM 顺序写可达百万级且持久化在 HDFS。查询模式上，风控决策按 uid 单行查询 + 取部分列族，HBase 的 RowKey 点查 + 列族过滤正好匹配，RT 在 5-10ms（BlockCache 命中时 <2ms）。Redis 的角色是"HBase 的前置缓存"——热用户（最近活跃）的特征先查 Redis（<1ms），未命中再查 HBase，不是替代 HBase。决策依据是 TCO（总成本）：HBase 10TB 约 50 台磁盘机，Redis 同容量要 500 台内存机，成本差 10 倍。

### 第二层：证据与定位

**Q：风控决策服务查 HBase 的 RT 突然从 10ms 飙到 200ms。你怎么确认是 HBase 侧问题还是网络/客户端问题？**

三组证据定位：
1. HBase RegionServer 指标——HBase JMX 暴露了 `regionserver.Server.Get_max`（get 操作最大耗时）、`regionserver.Server.Get_mean`（平均耗时），如果这两个值飙升，是 HBase 侧慢。进一步看 `regionserver.Server.QueueReadSize`（读队列堆积）、`regionserver.Server.blockCacheHitCount`（缓存命中数）——如果 BlockCache 命中率从 80% 掉到 30%，是缓存失效（冷数据查询增多或缓存被挤占）。
2. HBase UI 看 Compaction 状态——`hbase shell: status 'detailed'` 看是否有 RegionServer 正在执行 Major Compaction（`compactionState=MAJOR`），Major Compaction 会占大量 IO，导致读写慢。
3. 客户端侧网络——如果 HBase 侧指标正常（Get_mean <5ms）但客户端 RT 200ms，是网络或客户端连接池问题。`ping regionserver_ip` 看网络延迟，`arthas trace HTable get '#cost>100'` 看是 HBase.get 慢还是连接池等待慢。

### 第三层：根因深挖

**Q：你定位到是 BlockCache 命中率从 80% 掉到 30%，导致大量请求穿透到磁盘 HFile。根因是什么？为什么缓存突然失效？**

BlockCache 失效有几种根因。看 HBase 的 BlockCache 配置和访问模式：
1. 缓存容量不足——`hfile.block.cache.size=0.4`（默认 40% heap）。如果最近有新业务上线（如查全量用户的历史画像做模型训练），扫描了大量冷数据，把热数据挤出缓存（LRU 淘汰）。看 `regionserver.Server.blockCacheEvictionCount` 是否飙升。
2. MemStore 占用挤压——`hbase.regionserver.global.memstore.upperLimit=0.4`，如果写突增导致 MemStore 占满，BlockCache 可用空间被压缩。看 `regionserver.Server.memStoreSize` 是否接近上限。
3. Region 迁移——HMaster 做 balance 把某些 Region 迁到别的 RegionServer，新 RegionServer 的 BlockCache 是冷的，命中率为 0，需要预热。看 HMaster UI 的 `balancer` 日志。
真实案例常见是第 1 种——离线分析任务扫了全表，把在线热用户挤出缓存。验证方法：看 BlockCache 的"被驱逐的 key"分布，如果大量驱逐的是 user_001~user_100000（热用户），而缓存里留下的是离线任务的扫描范围，实锤。

**Q：根因是离线扫描挤占在线缓存。那为什么不直接把 BlockCache 调大？调大不就解决了吗？**

调大 BlockCache 是治标。Heap 是固定的（64GB），BlockCache 从 40% 调到 60%，MemStore 只剩 30%，写吞吐下降（MemStore 小了更频繁 Flush）。而且离线扫描的数据量是 10TB，再大的 BlockCache 也装不下，扫描完照样把热数据挤出去。治本是"读写隔离"——在线查询和离线分析用不同的 HBase 集群（或同一集群的不同 RegionServer 池）。离线分析走"只读副本"（HBase 的 read replica 或 HDFS snapshot），不碰在线集群的 BlockCache。如果资源不允许双集群，退一步用 BucketCache 分层——L1 LruBlockCache 放热数据（小）、L2 BucketCache 放温数据（大，off-heap），离线扫描只影响 L2，L1 的热数据不被挤。

### 第四层：方案权衡

**Q：你做了读写隔离后缓存命中率恢复了。但业务说离线分析任务也变慢了（走副本有延迟）。怎么权衡在线查询和离线分析的优先级？**

在线优先，离线让步。风控的核心 SLA 是"在线决策 RT <200ms"（影响用户支付体验），离线分析是"小时级 T+1 任务"（影响分析师效率）。优先级明确后，方案是资源配额 + 错峰：离线任务限定在低峰期（凌晨 1-6 点）跑、限制并发（同时只有 2 个 Scan）、用低优先级队列（HBase 的 `callQueue` 按读写分离 + 权重）。离线分析"变慢"从 1 小时变成 3 小时可接受（仍能在天亮前完成），但在线查询快 10 倍是硬需求。如果离线任务必须实时，考虑给它单独的 HBase 集群（成本换隔离）。权衡标准是 SLA 刚性——在线 SLA 不可妥协，离线 SLA 可弹性。

**Q：为什么不直接换成 Cassandra（去中心化、无单点），避免 HBase 的 HMaster 单点和 Region 热点问题？**

Cassandra 确实去中心化（无 HMaster），但它的最终一致性模型不适合风控。风控写入用户画像后，下一次查询（可能毫秒级后）必须读到最新值（强一致），Cassandra 的一致性级别（ONE/QUORUM/ALL）要达到强一致需用 QUORUM/ALL，性能下降且仍非严格强一致（Hinted Handoff 期间可能读到旧值）。HBase 的 Region 虽有"单点"（某时刻在一个 RegionServer），但这保证了强一致 + 可线性化。HMaster 单点问题有 HA 方案（多 HMaster + ZK 选主），Region 热点靠 RowKey 设计规避（hash 前缀）。风控选 HBase 是因为"强一致 + 写吞吐"组合，Cassandra 的"去中心化 + 最终一致"不匹配。只有最终一致可接受的场景（如物联网时序数据、社交 feed）才选 Cassandra。

### 第五层：验证与沉淀

**Q：你怎么证明读写隔离后在线查询性能真的恢复了？怎么量化缓存命中率改善？**

三组指标对比：
1. BlockCache 命中率——`regionserver.Server.blockCacheHitCount / (blockCacheHitCount + blockCacheMissCount)`，隔离前 30%、隔离后 85%，且离线任务期间命中率不下降（之前离线任务一来命中率就掉）。
2. Get 操作 RT——`regionserver.Server.Get_99th`（P99 耗时），隔离前 200ms、隔离后 8ms。同时看 Get 的 P999（`Get_99.9th`）从 1 秒降到 30ms，证明尾延迟也改善。
3. 在线决策链路 RT——从决策服务看 HBase 调用的 RT P99 从 200ms 降到 10ms，整个决策链路 P99 从 500ms 降到 200ms，达到 SLA。
对比时要注意流量归一化——用 Get QPS 归一化（Get RT / Get QPS），消除流量波动影响。

**Q：怎么让团队避免离线任务搞挂在线 HBase？**

沉淀成规范和工具：
1. 读写隔离规范——所有离线分析（全表 Scan、批量导出）必须走 read replica 或独立集群，禁止在生产在线集群跑大范围 Scan。Code Review 检查 Scan 的 caching 和 limit 参数。
2. Scan 参数规范——离线必须设 `scan.setCaching(100)`（批量拉取）、`scan.setLimit()`（限制行数）、错峰执行（cron 限定凌晨），违反则任务被 kill。
3. 监控告警——BlockCache 命中率 <60% 告警、Get P99 >50ms 告警、Major Compaction 期间告警（手动控制时机）。
4. 离线任务审计——HBase 开启 Audit Log，记录谁在什么时候跑了什么 Scan，每周 review 大 Scan 的合理性。
5. 故障复盘——把这次"离线全表 Scan 挤占 BlockCache → 在线 Get 慢 → 决策超时"的缓存命中率曲线、Get RT 曲线、Scan 范围存知识库，作为"读写必须隔离"的案例。


## 结构化回答

**30 秒电梯演讲：** 聊到HBase 的底层架构，我的理解是——HBase 用 LSM 树（写内存 + 顺序刷盘 + 后台归并）+ Region 分片 + WAL 保证海量数据的高吞吐写入和按 RowKey 查询。打个比方，HBase 像一个快递分拣中心：包裹（写入）先放传送带（MemStore 内存），满了批量装车（Flush 到 HFile 顺序写磁盘），夜间合并车辆整理（Compaction 合并小文件）。

**展开框架：**
1. **LSM 树** — 写 MemStore（内存）→ Flush 成 HFile（磁盘）→ Minor/Major Compaction 合并
2. **WAL（Write-Ahead Log）** — WAL（Write-Ahead Log）保证写不丢
3. **RowKey 字典序排序** — RowKey 字典序排序，Region 按 RowKey 范围切分

**收尾：** 这块我在项目里也踩过坑——想深入的话，可以接着聊：HBase 为什么快？您更想看哪个方向？

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡 | "HBase 的底层架构——这道题面试官到底想考什么？我用 30 秒给你讲透。" | 开场钩子 |
| 0:15 | 概念结构示意图 | 先说核心：HBase 用 LSM 树（写内存 + 顺序刷盘 + 后台归并）+ Region 分片 + WAL 保证海量数据的高吞吐写入和按 RowKey 查询。 | 核心定义 |
| 0:40 | 流程图 | WAL（Write-Ahead Log）保证写不丢。 | WAL（Write-Ahead Log） |
| 1:05 | 排序模型对比图 | RowKey 字典序排序，Region 按 RowKey 范围切分。 | RowKey 字典序排序 |
| 2:30 | 总结卡 | 一句话记忆：LSM：MemStore(内存)→Flush→HFile(磁盘顺序写)→Compaction(后台合并)。 下期可以接着聊：HBase 为什么快。 | 收尾总结 |
