---
id: java-architect-029
difficulty: L2
category: java-architect
subcategory: Redis
tags:
- Redis-Cluster
- 哨兵
- 高可用
- 容量规划
feynman:
  essence: Redis 高可用的本质是"数据分片解决单机容量/性能瓶颈，主从复制解决单点故障，自动故障转移解决人工干预延迟"。主从（一主多从，手动切换）→ 哨兵（Sentinel 监控+自动选主，但单分片）→ Cluster（多分片+多主从，16384 槽位路由，去中心化）。容量规划要算"内存、QPS、带宽、连接数"四个维度，按业务峰值留 50% 余量。
  analogy: 像连锁店管理。主从复制是"总店（主）和分店（从）同步商品目录（数据），客人查商品去分店（读分离）"。哨兵是"有个监工盯着总店，总店出事监工选个分店升为总店"（自动选主）。Cluster 是"全国分多个大区（分片），每个大区有总店和分店，客人按商品编号（key 的 CRC16）去对应大区"（分片+每分片主从）。
  first_principle: 为什么需要 Cluster？——单 Redis 有上限：内存（单机几十 G 到顶）、QPS（单实例 10 万左右）、单点风险（宕机全挂）。解决方法：水平分片（Cluster，数据分散多节点）、读写分离（从库分担读）、高可用（主从+自动切换）。核心权衡是"分片提升容量但引入路由复杂度（跨槽位命令受限）"。
  key_points:
  - 主从复制：全量（RDB）+ 增量（repl_backlog）
  - 哨兵 Sentinel：监控+通知+自动故障转移+配置中心
  - Cluster：16384 槽位，CRC16(key)%16384 路由，每分片一主多从
  - Gossip 协议：节点间通信（ping/pong 携带集群信息）
  - 容量规划：内存（业务数据×2 留碎片）、QPS、带宽、连接数
first_principle:
  problem: 单 Redis 实例遇到瓶颈（内存/性能/可用性），如何扩展？
  axioms:
  - 单机内存有物理上限（几十 G）
  - 单实例 QPS 有上限（10 万左右，CPU 单核瓶颈）
  - 单点故障不可接受（宕机全业务受影响）
  - 分布式系统要权衡 CAP（Redis 选 AP：高可用+最终一致）
  rebuild: 用数据分片解决容量/性能（Cluster，16384 槽位 CRC16 路由，每分片独立主从），用主从复制解决读压力和单点故障（从库分担读，主库宕机从库提升），用哨兵或 Cluster 内置故障转移解决人工干预延迟（自动选主）。容量规划按"内存（数据量×2 留碎片和膨胀）、QPS（峰值×1.5）、带宽（大 value 慎用）、连接数（应用实例数×连接池）"四维度算，留 50% 余量。跨分片操作受限（mget/事务/管道要同槽位），用 hash tag {} 强制同槽。
follow_up:
  - 哨兵和 Cluster 什么区别，怎么选？——哨兵是"单分片主从+独立监控进程"，适合数据量小（单机装得下）只需高可用的场景。Cluster 是"多分片+每分片主从+内置路由"，适合数据量大（超单机内存）需要水平扩展的场景。新项目优先 Cluster（未来扩展空间大）
  - Cluster 为什么用 16384 个槽位？——Antirez 解释：①心跳包携带槽位信息，16384/8=2KB（可控）；②Redis 集群建议 1000 节点以内，16384 槽位足够分散；③如果用 65536 槽位，心跳包 8KB 太大。16384 是性能和扩展性的平衡
  - Cluster 怎么处理跨槽位命令？——mset/mget/事务/Lua 跨槽位会报错（CROSSSLOT）。解法：①用 hash tag {} 让相关 key 同槽位（如 user:{1001}:info 和 user:{1001}:order 同槽）；②应用层拆分多次请求；③用 pipeline（每条命令独立路由）
  - 哨兵的故障转移流程？——①主观下线（SDOWN）：单个哨兵 ping 主库超时；②客观下线（ODOWN）：多数哨兵确认主库异常；③选举 leader 哨兵（Raft）；④leader 选最优从库（优先级+偏移量+runid）提升为主；⑤通知客户端新主地址
  - 容量规划怎么算 Redis 内存？——数据量×单 value 大小×2（留 hash 表膨胀和内存碎片）+ 主从复制 buffer。如 1 亿用户×1KB=100GB，Redis 内存要预留 200GB+。大 key（如 hash 存百万 field）要单独评估
memory_points:
  - 主从：全量 RDB + 增量 repl_backlog
  - 哨兵：SDOWN→ODOWN→选 leader→提升从库
  - Cluster：16384 槽位，CRC16 路由，每分片主从
  - Gossip：节点间 ping/pong 传播集群状态
  - 容量：内存（数据×2）+ QPS（峰值×1.5）+ 带宽 + 连接数
---

# 【Java 后端架构师】Redis 高可用架构与容量规划

> 适用场景：JD 核心技术。缓存、计数、分布式锁都依赖 Redis，Redis 宕机就是全站故障。架构师必须会选型（主从 vs 哨兵 vs Cluster）、做容量规划（避免 OOM 和性能瓶颈）、理解故障转移机制（避免脑裂和数据丢失）。

## 一、概念层：Redis 高可用三阶段

**演进路线**：单机 → 主从 → 哨兵 → Cluster。

| 阶段 | 架构 | 解决问题 | 局限 |
|------|------|----------|------|
| **单机** | 1 个实例 | 简单 | 单点故障，宕机全挂 |
| **主从** | 1 主 N 从 | 读写分离、数据备份 | 主宕需手动切换 |
| **哨兵** | 主从 + Sentinel 集群 | 自动故障转移 | 单分片（数据量受单机内存限） |
| **Cluster** | 多分片 × 主从 | 水平扩展 + 自动切换 | 跨槽位命令受限 |

## 二、机制层：主从复制

**全量同步（首次或断线太久）**：

```
从库执行 REPLICAOF master_ip master_port 后：
  1. 从库连接主库，发 PSYNC ? -1（首次同步）
  2. 主库执行 BGSAVE 生成 RDB 文件（fork 子进程，期间用 copy-on-write）
  3. 主库把 RDB 文件发给从库
  4. 从库加载 RDB（清空旧数据后加载）
  5. 主库把 RDB 期间的新写命令（存在客户端输出缓冲区）发给从库
  6. 之后进入增量同步（命令传播）
```

**增量同步（断线重连）**：

```
主库维护 repl_backlog（环形缓冲区，默认 1MB）：
  - 记录最近的写命令和偏移量（offset）
  - 从库断线重连时发 PSYNC <runid> <offset>
  - 主库检查 offset 是否在 backlog 范围内：
    是 → 增量同步（发 offset 之后的命令）
    否 → 全量同步（offset 太旧，backlog 覆盖不到）

调优：
  repl-backlog-size 256mb   # 大流量场景调大，避免频繁全量
  repl-backlog-ttl 3600     # backlog 空闲保留时间
  repl-diskless-sync yes    # 网络直传 RDB（不落盘，省 IO）
```

**复制的局限**——异步复制，有延迟：

```
主库写命令 → 立即返回客户端 OK
         → 异步同步到从库（毫秒延迟）

风险：主库写完还没同步从库就宕机 → 数据丢失
解法：min-replicas-to-write 1（至少 1 个从库同步才算成功，降性能）
```

## 三、机制层：哨兵 Sentinel

**哨兵三任务**（必背）：

| 任务 | 说明 |
|------|------|
| **监控** | 哨兵定期 ping 主/从库和其他哨兵，检测存活 |
| **通知** | 客户端订阅哨兵的频道，主变更时通知 |
| **自动故障转移** | 主宕自动选从库提升为新主，通知客户端 |

**故障转移流程**（面试高频）：

```
1. 主观下线（SDOWN）
   单个哨兵 ping 主库，超时（down-after-milliseconds，默认 30s）
   标记主库为 SDOWN（只是这个哨兵的判断）

2. 客观下线（ODOWN）
   哨兵询问其他哨兵："主库是不是挂了？"
   超过半数（quorum 配置）哨兵同意 → 标记 ODOWN（集群共识）

3. 选举 Leader 哨兵
   哨兵间用 Raft 算法选一个 leader 负责执行故障转移
   （谁先发现 ODOWN 谁先发起选举，任期递增）

4. Leader 选新主
   从所有从库中选最优的：
   a. 过滤不健康的（断线频繁、断线太久）
   b. 按 slave-priority（优先级，数字小优先）
   c. 优先级相同看复制偏移量（offset 大的，数据新）
   d. 偏移量相同看 runid（字典序小的）

5. 提升新主
   Leader 对选中从库发 SLAVEOF NO ONE（变为主库）
   对其他从库发 SLAVEOF <新主ip> <新主port>（指向新主）
   通知客户端新主地址（发布订阅频道）

6. 旧主回归
   旧主恢复后变成新主的从库（自动 SLAVEOF 新主）
```

**脑裂问题**：

```
场景：主库网络分区，哨兵认为它挂了（实际还活着）
  - 哨兵选新主，旧主还以主自居
  - 客户端可能写旧主（分区未感知）
  - 分区恢复后旧主降为从库，同步新主时清空自己数据 → 写丢失

解法：
  min-replicas-to-write 1
  min-replicas-max-lag 10
  # 主库至少有 1 个从库延迟<10s 才接受写，否则拒绝（防脑裂写丢失）
```

## 四、机制层：Cluster 集群

**槽位（Slot）路由机制**：

```
Cluster 有 16384 个槽位（slot），分散到各主节点：
  节点 A：0-5460
  节点 B：5461-10922
  节点 C：10923-16383

key 路由：slot = CRC16(key) % 16384
  → slot 落在哪个节点范围，就去哪个节点

客户端缓存路由表（slot → node 映射），直接访问目标节点
  如果 key 不在当前节点，返回 MOVED 错误：
    MOVED 5474 127.0.0.1:7001
  客户端更新路由表，重试到新节点
```

**Hash Tag（强制同槽位）**：

```bash
# 默认：不同 key 可能落不同槽位
SET user:1001:info "x"   # slot = CRC16("user:1001:info") % 16384
SET user:1001:order "y"  # slot = CRC16("user:1001:order") % 16384
# 可能不同槽 → mget/事务跨槽报错

# Hash Tag：用 {} 包裹，CRC16 只算 {} 内的部分
SET {user:1001}:info "x"    # slot = CRC16("user:1001") % 16384
SET {user:1001}:order "y"   # slot = CRC16("user:1001") % 16384（相同！）
# 同槽位 → mget/事务可用
MGET {user:1001}:info {user:1001}:order  # 成功
```

**Gossip 协议**（节点间通信）：

```
每个节点定期（每秒）随机选几个节点发 PING：
  PING 携带：本节点已知的集群信息（哪些节点在、哪些疑似下线）
  收到 PING 回 PONG（同样携带集群信息）
  
效果：
  - 信息扩散（Gossip，像传八卦一样传播）
  - 检测下线（ping 超时标记 PFAIL 主观下线）
  - 集群自愈（故障节点被多数标记 FAIL 后做故障转移）

故障转移（Cluster 内置）：
  1. 主库 A 的从库发现 A 标记为 FAIL（多数节点共识）
  2. 从库发起选举（Raft，复制偏移量大的优先）
  3. 当选后升级为主（SLAVEOF NO ONE）
  4. 接管 A 的槽位，通知集群
```

**Cluster 的局限**：

```
1. 跨槽位命令受限
   mset/mget/事务/Lua 跨槽位报错 CROSSSLOT
   解法：Hash Tag {} 让相关 key 同槽

2. 不支持多 DB
   Cluster 只能用 DB 0（SELECT 1 报错）

3. 客户端复杂
   要支持 MOVED/ASK 重定向（客户端库如 Jedis/Lettuce 已封装）

4. 主从异步复制
   主宕机从库提升可能丢数据（异步复制未同步部分）
```

## 五、实战层：选型与配置

**选型决策树**：

```
数据量 < 10GB 且只需高可用？
  → 哨兵（Sentinel）模式，单分片主从+自动切换
  → 部署：1 主 2 从 + 3 哨兵（哨兵奇数，防脑裂）

数据量 > 10GB 或 QPS > 10 万？
  → Cluster 模式，多分片水平扩展
  → 部署：3 分片 ×（1 主 1 从）= 6 节点起步
  → 扩展：加分片（需迁移槽位，支持在线扩容）

读多写少？
  → 主从模式（1 主多从），读分散到从库
  → 注意：从库只读，写必须到主库
```

**哨兵配置示例**（sentinel.conf）：

```
# 监控的主库（名字、IP、端口、quorum=多少哨兵同意才算下线）
sentinel monitor mymaster 127.0.0.1 6379 2

# 主库多久无响应算下线（毫秒）
sentinel down-after-milliseconds mymaster 30000

# 故障转移时同时多少从库同步新主（数字小恢复快但压力大）
sentinel parallel-syncs mymaster 1

# 故障转移超时时间
sentinel failover-timeout mymaster 180000

# 哨兵自身要至少 3 个（奇数，防脑裂）
# 部署在不同机器（防单机故障全挂）
```

**Cluster 部署**（redis-cli 创建）：

```bash
# 启动 6 个 Redis 实例（3 主 3 从），配置：
# cluster-enabled yes
# cluster-config-file nodes-7000.conf
# cluster-node-timeout 15000

# 创建集群（自动分配槽位）
redis-cli --cluster create \
  127.0.0.1:7000 127.0.0.1:7001 127.0.0.1:7002 \
  127.0.0.1:7003 127.0.0.1:7004 127.0.0.1:7005 \
  --cluster-replicas 1   # 每主 1 个从库

# 查看集群状态
redis-cli -c -p 7000 cluster nodes
redis-cli -c -p 7000 cluster info

# 扩容：加节点 + 迁移槽位
redis-cli --cluster add-node 127.0.0.1:7006 127.0.0.1:7000
redis-cli --cluster reshard 127.0.0.1:7000  # 交互式迁移槽位
```

**Java 客户端**（Lettuce 连接 Cluster）：

```java
@Configuration
public class RedisClusterConfig {

    @Bean
    public RedisConnectionFactory redisConnectionFactory() {
        RedisClusterConfiguration config = new RedisClusterConfiguration()
            .clusterNode("node1", 7000)
            .clusterNode("node2", 7001)
            .clusterNode("node3", 7002);
        config.setMaxRedirects(3);  // MOVED/ASK 重定向最大次数
        return new LettuceConnectionFactory(config);
    }

    @Bean
    public RedisTemplate<String, Object> redisTemplate(
            RedisConnectionFactory factory) {
        RedisTemplate<String, Object> template = new RedisTemplate<>();
        template.setConnectionFactory(factory);
        template.setKeySerializer(new StringRedisSerializer());
        template.setValueSerializer(new GenericJackson2JsonRedisSerializer());
        return template;
    }
}
```

## 六、实战层：容量规划

**四维度规划法**（架构师必会）：

```
1. 内存维度
   数据量 × 平均 value 大小 = 原始数据
   × 2（hash 表膨胀 + 内存碎片）= 实际占用
   × 1.5（留余量，eviction 前）= 规划容量

   示例：1 亿用户 × 1KB（用户信息）= 100GB
        × 2 = 200GB（实际占用）
        × 1.5 = 300GB（规划容量）
        → 单分片 32GB 不够，用 10 分片（每分片 30GB）

2. QPS 维度
   业务峰值 QPS = 预估
   单 Redis QPS = 10 万（benchmark 实测）
   分片数 = 业务 QPS / 单分片 QPS × 1.5（余量）

   示例：业务峰值 50 万 QPS
        分片数 = 50万 / 10万 × 1.5 = 7.5 → 8 分片

3. 带宽维度
   QPS × 平均 value 大小 = 带宽
   注意大 value（如存 JSON 几 MB）容易打满带宽

   示例：10 万 QPS × 1KB = 100MB/s = 800Mbps
        → 千兆网卡（1Gbps）快满，用万兆网卡或分片

4. 连接数维度
   应用实例数 × 连接池大小 = 总连接数
   单 Redis maxclients 默认 10000
   注意留余量（监控/运维也占连接）

   示例：50 应用实例 × 50 连接池 = 2500 连接
        → 单 Redis 10000 连接够，但多实例共享要规划
```

**容量监控命令**：

```bash
# 内存
redis-cli info memory | grep used_memory_human
redis-cli info memory | grep used_memory_peak_human

# QPS
redis-cli info stats | grep instantaneous_ops_per_sec

# 连接数
redis-cli info clients | grep connected_clients

# 大 key（定期扫描）
redis-cli --bigkeys
redis-cli --memkeys   # 按内存排序

# 慢日志
redis-cli slowlog get 10

# Cluster 状态
redis-cli -c -p 7000 cluster info
redis-cli -c -p 7000 cluster countkeysinslot <slot>
```

## 七、底层本质：分片与一致性的权衡

回到第一性：**Redis Cluster 选 AP（高可用+最终一致），牺牲跨分片一致性**。

- **为什么 Cluster 用 16384 槽位**：Antirez 的解释——①心跳包带槽位 bitmap，16384/8=2KB（可控）；②集群建议 1000 节点以内，16384 足够分散；③如果 65536 槽位，心跳包 8KB 太大。这是性能（心跳开销）和扩展性（槽位数）的平衡。
- **为什么主从异步复制**：同步复制降性能（主等从确认），Redis 选异步保证高可用（主不等从，快速响应）。代价是主宕机可能丢未同步数据（极小概率）。要强一致用 min-replicas-to-write（降性能换一致）。
- **为什么故障转移有延迟**：要等 down-after-milliseconds（默认 30s）确认下线 + 选举 + 切换。太短容易误判（网络抖动），太长影响可用性。生产调到 10-30s 根据业务敏感度。
- **为什么 Cluster 跨槽位命令受限**：分片本质是"数据分散在不同节点"，跨节点要 2PC 保证原子（Redis 没实现，太复杂）。所以跨槽位命令报错，强制用户用 Hash Tag 规划数据分布。

## 八、AI 架构师加问：5 个 AI 相关问题

1. **AI 推理结果缓存，用 Redis Cluster 怎么规划？**
   按 prompt 的 hash 分片（key=hash(prompt)），Cluster 自动路由。热点 prompt（高频问题）用本地缓存（Caffeine）+ Redis 二级缓存。缓存 TTL 根据模型更新频率设（如模型每天更新，TTL 设 1 天）。

2. **让 AI 做 Redis 容量规划，需要哪些数据？**
   AI 需要：业务数据量（当前+预测增长）、访问模式（读写比、QPS 峰值）、value 大小分布（是否有大 key）、可用预算（决定分片数）。AI 输出推荐分片数、内存配置、TTL 策略。但 AI 不直接改配置（风险高），给推荐由人审核。

3. **AI Agent 共享 Redis，怎么隔离？**
   不同 Agent 用不同 key 前缀（agent1:、agent2:），Cluster 按 key hash 自动分散。避免大 Agent 打满 Redis 影响其他——用 Redis 6.0 的 ACL（用户隔离）+ maxmemory-per-client（单客户端内存上限）。强隔离用不同 Cluster 实例。

4. **怎么用 AI 检测 Redis 异常？**
   AI 分析 INFO/慢日志/--bigkeys 数据 → 异常检测（如内存突增可能内存泄漏、QPS 飙升可能被刷、慢命令激增可能大 key）。AI 还能预测容量瓶颈（按增长趋势预测何时扩容）、识别热点 key（高频访问的 key）。

5. **向量数据库和 Redis Cluster 怎么配合？**
   AI 场景（如语义搜索）用专用向量库（Milvus/Pinecone）存 embedding，Redis 存业务数据（用户信息、商品信息）。检索时先向量库查相似 ID，再 Redis 批量取业务数据（mget）。Redis 不适合存向量（计算相似度慢），但适合做向量结果的缓存（避免重复计算）。

## 九、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"主从→哨兵→Cluster、槽位路由、Gossip、容量四维度"**。

- **主从**：全量 RDB + 增量 repl_backlog，异步复制有延迟
- **哨兵**：SDOWN（主观）→ ODOWN（客观）→ 选 leader → 提升从库
- **Cluster**：16384 槽位，CRC16 路由，每分片主从，Gossip 通信
- **故障转移**：主宕 → 检测 → 选举从库 → 提升 → 通知客户端
- **容量规划**：内存（数据×2×1.5）+ QPS（峰值/10万×1.5）+ 带宽 + 连接数

### 拟人化理解

把 Redis 高可用想成**连锁店管理**。单机是"一家店"（单点风险）。主从是"总店+分店"（总店更新同步分店，客人查商品去分店）。哨兵是"有个监工盯着总店，总店出事监工选个分店升为总店"（自动选主）。Cluster 是"全国分多个大区，每大区有总店和分店，客人按商品编号去对应大区"（分片+路由）。容量规划是"预估每天客流（QPS）、货架商品量（内存）、门口通道宽度（带宽）、收银台数（连接数）"，按峰值留余量。故障转移是"总店经理突然病倒（主宕），监工马上选最资深的副经理接任（选从库）"，避免无人管理（服务中断）。

### 面试现场 60 秒回答

> Redis 高可用三个阶段：主从（1 主多从，读写分离，但主宕需手动切）、哨兵（主从+Sentinel 监控+自动故障转移，单分片）、Cluster（多分片+每分片主从，16384 槽位 CRC16 路由，去中心化）。选型：数据量小（<10GB）用哨兵，数据量大或 QPS 高用 Cluster。哨兵故障转移流程：主观下线 SDOWN（单哨兵判断）→ 客观下线 ODOWN（多数共识）→ Raft 选 leader 哨兵 → 选最优从库（优先级+偏移量+runid）提升为主 → 通知客户端。Cluster 用 Gossip 协议节点间通信，故障转移内置（从库发现主 FAIL 后 Raft 选举提升）。容量规划四维度：内存（数据量×2 留碎片×1.5 留余量）、QPS（峰值/10万×1.5 分片）、带宽（QPS×value大小）、连接数（实例数×连接池）。跨槽位命令用 Hash Tag {} 让相关 key 同槽位。

### 反问面试官

> 贵司 Redis 用哨兵还是 Cluster？分片数多少、怎么扩容的？有没有遇到过故障切换的坑（脑裂、数据丢失）？容量规划怎么做的，有没有标准？

## 十、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不用单机 Redis？ | 用瓶颈说话：单机内存上限（几十 G）、QPS 上限（10 万）、单点风险（宕机全挂）。分布式系统要水平扩展+高可用。主从解决读压力和备份，哨兵/Cluster 解决自动故障转移 |
| 证据追问 | 怎么知道 Redis 容量/性能够不够？ | 用监控数据说话：INFO memory（used_memory/used_memory_peak）、INFO stats（instantaneous_ops_per_sec）、--bigkeys（大 key）、SLOWLOG（慢命令）、connected_clients（连接数）。压测（redis-benchmark）验证峰值 |
| 边界追问 | Cluster 能保证强一致吗？ | 不能。主从异步复制（主宕可能丢未同步数据）、故障转移期间有短暂不可用（检测+选举+切换需几秒到几十秒）。要强一致用 min-replicas-to-write（降性能）或换 ZK/etcd。Redis 是 AP，适合缓存等容忍小概率错误的场景 |
| 反例追问 | 什么场景不该用 Cluster？ | 数据量小（单机够用，Cluster 增加复杂度不值）、强一致需求（Cluster 异步复制有丢失风险）、跨 key 事务多（Cluster 跨槽位受限，Hash Tag 规划麻烦）。这些场景用哨兵或主从 |
| 风险追问 | Redis 上线最大风险？ | 主动点出：脑裂（主分区后双写，恢复丢数据，用 min-replicas 防护）、全量同步风暴（网络分区恢复后所有从库全量同步，压垮主库）、大 key（单 key 几 MB 打满网络和单线程）、热点 key（单分片 QPS 打满）。要理解每个风险的触发条件和应对 |
| 验证追问 | 怎么验证故障转移有效？ | 混沌工程：kill 主库 Redis 进程，验证哨兵/Cluster 是否在预期时间（如 30s）内完成切换、客户端是否自动重连新主、数据是否一致。压测验证高并发下切换不丢请求 |
| 沉淀追问 | Redis 治理规范，沉淀什么？ | 选型 SOP（数据量/QPS 决定哨兵还是 Cluster）、容量规划模板（四维度算法）、大 key 治理（禁止大 value，用 hash 拆分）、监控大盘（内存/QPS/连接/慢日志）、故障演练流程（定期 kill 主库验证切换） |

### 现场对话示例

**面试官**：哨兵和 Cluster 怎么选？

**候选人**：核心看两个维度——数据量和扩展需求。如果数据量小（比如几 GB，单机装得下），只是需要高可用（主库宕了自动切换），用哨兵足够。哨兵是"单分片主从+独立监控进程"，部署 1 主 2 从 + 3 哨兵，哨兵负责监控和故障转移，客户端连哨兵获取主库地址。优点是简单、支持所有 Redis 命令（无跨槽位限制）。如果数据量大（超过单机内存，如几十 GB 到 TB），或者 QPS 高（单分片扛不住），用 Cluster。Cluster 是"多分片+每分片主从"，16384 槽位 CRC16 路由，自动分片+故障转移。优点是水平扩展，缺点是跨槽位命令受限（mset/mget/事务跨槽报错，要用 Hash Tag {} 规划）。新项目优先 Cluster——即使初期数据量小，未来扩展空间大，不用迁移。老项目数据量稳定用哨兵更简单。另外 Cluster 客户端要支持 MOVED/ASK 重定向，主流库（Lettuce/Jedis）都支持。

**面试官**：Cluster 扩容怎么做，会中断服务吗？

**候选人**：Cluster 支持在线扩容（不中断服务）。流程：第一步，启动新节点（cluster-enabled yes），用 redis-cli --cluster add-node 加入集群（此时新节点没有槽位）。第二步，用 redis-cli --cluster reshard 迁移槽位——指定要迁移多少槽位到新节点，工具会自动从各主节点迁移。迁移单个槽位的过程：标记源节点和目标节点为 MIGRATING/IMPORTING 状态 → 把槽位的 key 逐个 MIGRATE 到目标节点（MIGRATE 是原子操作，迁移期间 key 被锁）→ 迁移完更新槽位归属。迁移期间，客户端访问正在迁移的槽位：如果 key 在源节点，正常返回；如果已迁移，源节点返回 ASK 重定向，客户端临时去目标节点（不更新路由表，因为迁移未完成）。整个迁移过程对应用透明，可能有毫秒级延迟（MIGRATE 单 key 时阻塞），但不会中断服务。生产建议低峰期扩容，分批迁移（每次迁几个槽位），避免大批量迁移影响性能。迁移后用 cluster nodes 验证槽位分布，用 redis-cli --cluster check 检查集群健康。

**面试官**：Redis 主从切换会丢数据吗？

**候选人**：会，因为 Redis 主从复制是异步的。场景：主库收到写命令立即返回客户端 OK，然后异步同步到从库。如果主库在同步完成前宕机，从库没有这部分数据，故障转移后从库提升为新主，这部分写就丢了。丢失量取决于复制延迟——主从延迟越大，潜在丢失越多。降低丢失的方法：第一，min-replicas-to-write 1 + min-replicas-max-lag 10——主库至少有 1 个从库延迟小于 10 秒才接受写，否则拒绝（降性能换一致）。第二，业务层补偿——关键写操作（如扣款）落 DB，Redis 只做缓存，丢了从 DB 恢复。第三，用 Redis 6.2+ 的 WAIT 命令——写完后 WAIT 1 100（等至少 1 个从库确认，最多等 100ms），保证写已复制。但 WAIT 降性能（要等确认），且网络分区时仍可能不一致。根本认知：Redis 是 AP 系统，主从异步复制注定有丢失风险。强一致需求（资金）不用 Redis 做主存储，用 DB 事务保证。

## 常见考点

1. **Redis 主从复制的原理？**——全量（RDB 快照）+ 增量（repl_backlog 命令传播）。首次同步用 PSYNC ? -1 触发全量，断线重连用 PSYNC runid offset 触发增量（offset 在 backlog 范围内）或全量（超出范围）。
2. **哨兵的 quorum 怎么设？**——quorum 是"多少哨兵同意才算客观下线"，建议设哨兵总数的一半+1（如 3 哨兵设 2）。太低容易误判（网络抖动误判下线触发切换），太高故障转移不及时。哨兵总数建议奇数（3 或 5），防脑裂。
3. **Cluster 的 MOVED 和 ASK 区别？**——MOVED 是永久重定向（槽位已迁移到新节点），客户端更新路由表。ASK 是临时重定向（槽位正在迁移，key 可能还在源节点），客户端不更新路由表，下次还先问源节点。
4. **Redis 6.0 的多线程是什么？**——Redis 命令执行仍单线程（避免并发问题），多线程只用于网络 IO（接收请求、发送响应）。解决网络 IO 成为瓶颈的场景（高 QPS、大 value）。用 io-threads 配置开启，适合大流量场景。
5. **怎么避免 Redis 大 key？**——规范：单 key 不超过 10KB（hash/list 不超过 5000 元素）。扫描：redis-cli --bigkeys 定期检测。拆分：大 hash 按字段拆成多个小 hash，大 list 分段。监控：SLOWLOG 和 INFO memory 预警。


## 结构化回答

**30 秒电梯演讲：** 聊到Redis 高可用架构与容量规划，我的理解是——Redis 高可用的本质是"数据分片解决单机容量/性能瓶颈，主从复制解决单点故障，自动故障转移解决人工干预延迟"。主从（一主多从，手动切换）→ 哨兵（Sentinel 监控+自动选主，但单分片）→ Cluster（多分片+多主从，16384 槽位路由，去中心化）。容量规划要算"内存、QPS、带宽、连接数"四个维度，按业务峰值留 50% 余量。打个比方，像连锁店管理。主从复制是"总店（主）和分店（从）同步商品目录（数据），客人查商品去分店（读分离）"。哨兵是"有个监工盯着总店，总店出事监工选个分店升为总店"（自动选主）。Cluster 是"全国分多个大区（分片），每个大区有总店和分店，客人按商品编号（key 的 CRC16）去对应大区"（分片+每分片主从）。

**展开框架：**
1. **主从复制** — 全量（RDB）+ 增量（repl_backlog）
2. **哨兵 Sentinel** — 监控+通知+自动故障转移+配置中心
3. **Cluster** — 16384 槽位，CRC16(key)%16384 路由，每分片一主多从

**收尾：** 这块我在项目里也踩过坑——想深入的话，可以接着聊：哨兵和 Cluster 什么区别，怎么选？您更想看哪个方向？

## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡 | "Redis 高可用架构与容量规划——这道题面试官到底想考什么？我用 30 秒给你讲透。" | 开场钩子 |
| 0:15 | Redis 数据结构图 | 先说核心：Redis 高可用的本质是"数据分片解决单机容量/性能瓶颈，主从复制解决单点故障，自动故障转移解决人工干预延迟"。主从（一主多从，手动切换）→ 哨兵（Sentinel 监控+自。 | 核心定义 |
| 0:30 | Sentinel 规则配置截图 | 监控+通知+自动故障转移+配置中心。 | 哨兵 Sentinel |
| 1:30 | 总结卡 | 一句话记忆：主从：全量 RDB + 增量 repl_backlog。 下期可以接着聊：哨兵和 Cluster 什么区别，怎么选。 | 收尾总结 |
