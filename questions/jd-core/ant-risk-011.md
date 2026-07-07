---
id: ant-risk-011
difficulty: L3
category: jd-core
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
