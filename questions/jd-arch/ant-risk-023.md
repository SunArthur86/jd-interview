---
id: ant-risk-023
difficulty: L4
category: jd-arch
subcategory: 关系网络设计
tags:
- 蚂蚁
- 风控
- 图数据库
- 关系网络
- 图计算
- 系统设计
feynman:
  essence: 关系网络风控把"账号、设备、IP、手机号、银行卡"等实体建成图，用社区发现、中心度、路径分析挖掘团伙欺诈，是单点规则的"上帝视角"。
  analogy: 关系网络像地铁图——每个站点是一个实体（账号/设备），线是关系（同 IP/同设备/转账）。欺诈团伙像频繁共线的可疑站点簇，图算法能一眼揪出。
  first_principle: 单点规则只能看个体特征，团伙欺诈靠"伪装正常个体"绕过；用图建模实体关系，能从网络拓扑结构发现"看似正常但聚集异常"的团伙。
  key_points:
  - 实体：账号、设备、IP、手机、银行卡、商户
  - 关系：同设备登录、同 IP、转账、同 Wi-Fi、同联系人
  - 在线查询：邻居、度数、最短路径（图数据库 Neo4j/JanusGraph）
  - 离线分析：社区发现（Louvain）、中心度（PageRank）、路径（连通分量）
  - 准实时：Flink + 图增量更新
first_principle:
  problem: 团伙欺诈（中介养号、批量套现）里每个账号都伪装正常，单点规则失效，如何识别"群体异常"？
  axioms:
  - 欺诈有协作性（同伙会用同设备/同 IP）
  - 网络拓扑暴露群体特征
  - 图算法能发现隐藏的聚集
  rebuild: 建图——实体为节点，关系为边；在线查询单点关系（这个 UID 共享多少设备），离线图算法挖团伙（社区发现/连通分量）。
follow_up:
- 图数据库选型？——Neo4j（小规模，社区版不支持分布式）、JanusGraph（大规模，HBase 后端）、HugeGraph（百度开源）
- 十亿节点规模怎么存？——JanusGraph + HBase 后端 + Elasticsearch 索引
- 怎么和实时风控结合？——预计算高风险团伙标签，实时查 UID 是否在团伙里
memory_points:
- 关系网络 = 节点（实体）+ 边（关系）+ 图算法（拓扑分析）
- 在线查询（图数据库，毫秒）+ 离线分析（图计算，T+1）
- 核心算法：社区发现、连通分量、中心度、路径
- 团伙欺诈靠网络拓扑识别，单点规则失效
---

# 【蚂蚁风控】用图数据库做风控关系网络怎么设计？怎么发现团伙欺诈？

> JD 依据：JD 提到"图数据库"。蚂蚁是图风控的代表，这是高级架构题。

## 一、需求拆解

**业务场景**：
- 中介养号（一个手机登录几十个账号）
- 团伙套现（多个账号给同一商户刷单）
- 黑产设备农场（同 IP/同设备批量操作）
- 资金清洗（资金多跳转账隐藏来源）

**核心难点**：
- 每个账号单独看都"正常"（有实名、有交易历史）
- 单点规则失效
- 需要从"关系"维度发现异常聚集

## 二、图模型设计

**节点（实体）**：
```
(:User {uid, age, score})
(:Device {did, type})
(:IP {ip, isp})
(:Phone {phone})
(:Card {cardno, bank})
(:Merchant {mid, type})
(:Address {addr})
```

**关系（边）**：
```
(:User)-[:LOGIN_FROM]->(:Device)      // 用户从设备登录
(:User)-[:USE_IP]->(:IP)              // 用户用 IP
(:User)-[:OWN_PHONE]->(:Phone)        // 用户绑手机
(:User)-[:PAY_WITH]->(:Card)          // 用户用卡支付
(:User)-[:TRADE_WITH]->(:Merchant)    // 用户和商户交易
(:User)-[:TRANSFER_TO]->(:User)       // 用户间转账
```

**举例**：
```
账户A ─┬─ 登录设备1
       ├─ 用 IP X
       └─ 转账给 → 账户B ─┬─ 登录设备1  ← 同设备！
                          └─ 用 IP X    ← 同 IP！

→ A、B 高度关联，疑似同一人控制
```

## 三、整体架构

```
┌──────────────────────────────────────────────────────────┐
│                  数据采集层（CDC）                       │
│  MySQL binlog → Canal → Kafka                            │
│  日志事件 → Kafka                                        │
└──────────────────────────────────────────────────────────┘
                          ↓
┌──────────────────────────────────────────────────────────┐
│              图构建层（Flink + 批量）                    │
│  Flink：实时增量更新边（同设备登录立即建边）             │
│  Spark：T+1 批量重建图                                   │
└──────────────────────────────────────────────────────────┘
                          ↓
┌──────────────────────────────────────────────────────────┐
│                  图存储层                                │
│  ┌──────────────┐         ┌──────────────────┐          │
│  │ JanusGraph   │         │ GraphCompute     │          │
│  │ + HBase 后端 │         │ (Spark GraphX /  │          │
│  │ + ES 索引    │         │  GraphScope)     │          │
│  │ 在线查询     │         │ 离线批量分析     │          │
│  └──────────────┘         └──────────────────┘          │
└──────────────────────────────────────────────────────────┘
                          ↓
┌──────────────────────────────────────────────────────────┐
│              风控服务层                                  │
│  在线：查 UID 关联风险（设备共享、团伙标签）             │
│  离线：团伙挖掘 → 高风险团伙标签 → 推在线缓存            │
└──────────────────────────────────────────────────────────┘
```

## 四、在线查询（毫秒级）

**实时决策时查关系风险**：

```cypher
// Cypher 查询：UID 共享设备数
MATCH (u:User {uid: $uid})-[:LOGIN_FROM]->(d:Device)<-[:LOGIN_FROM]-(other:User)
WHERE other.uid <> $uid
RETURN COUNT(DISTINCT other.uid) as shared_users,
       COLLECT(DISTINCT d.did) as shared_devices

// 结果：shared_users=15, shared_devices=3
// 一个用户和其他 15 个用户共享 3 个设备 → 高风险
```

**预计算的高风险标签**（更快）：
```java
// 离线算好后推到 Redis
RiskResult decide(Event e) {
    // 1. 查 UID 是否在高风险团伙
    Integer gangId = gangCache.get(e.uid);
    if (gangId != null) {
        return RiskResult.reject("in_gang_" + gangId);
    }
    // 2. 查共享设备数
    Integer sharedDevs = sharedDeviceCache.get(e.uid);
    if (sharedDevs > 5) {
        return RiskResult.review("shared_device_" + sharedDevs);
    }
    // 3. 查 2 跳邻居黑名单
    Integer blackNeighbors = blackNeighborCache.get(e.uid);
    if (blackNeighbors > 0) {
        return RiskResult.review("connected_to_blacklist");
    }
    return RiskResult.pass();
}
```

**性能**：
- 预计算 + Redis：3ms 内
- 在线 Cypher：30-50ms（1-2 跳）
- 超过 3 跳：必须预计算

## 五、离线图算法（团伙挖掘）

**1. 连通分量（Connected Components）**：
找出"完全连通"的团伙。
```
A-B-C-D 是一个连通分量（团伙1）
E-F-G 是另一个连通分量（团伙2）
```

**2. 社区发现（Louvain）**：
按"边密集度"挖社区，比连通分量更松。
```
社区1：节点间边多 → 强团伙
社区2：节点间边少 → 弱团伙
```

**3. 中心度（PageRank / 度数）**：
找出"枢纽节点"（高风险点）。
```
节点 X 连接 100 个账号 → X 是中介 → 标记
```

**4. 路径分析**：
查资金流转路径。
```
A → B → C → D → E（资金多跳转账）
深度 > 5 → 疑似洗钱
```

**5. 三角计数**：
找"三角关系"（强关联）。
```
A-B, B-C, A-C 三角 → 强团伙
```

## 六、GraphScope / GraphX 批量算法

```python
# GraphScope（阿里开源）批量跑社区发现
import graphscope
g = graphscope.g(directed=False)
g = g.load_from(vertices="hdfs://.../users", edges="hdfs://.../edges")
result = graphscope.louvain(g)  # 社区发现
result.output("hdfs://.../communities")
```

**风控的批量任务**：
- 每天凌晨全量跑：连通分量、Louvain、中心度
- 输出：每个 UID 的团伙 ID、团伙规模、团伙风险分
- 推到 Redis 供在线决策用

## 七、增量更新（准实时）

**Flink 实时建边**：
```java
DataStream<LoginEvent> logins = env.addSource(kafka("logins"));

logins.keyBy(e -> e.did)
    // 同设备的所有登录 → 两两建边
    .process(new SameDeviceEdgeBuilder())
    // 写图存储
    .addSink(new JanusGraphSink());
```

**增量 vs 全量**：
- 增量（Flink）：秒级建新边，但算法重算成本高
- 全量（T+1）：每天重建，算法定期更新
- 实战：增量建边 + 定期全量重算算法

## 八、规模与性能

**蚂蚁的规模**：
- 节点：10 亿+（账号 + 设备 + IP + 卡 + 商户）
- 边：1000 亿+
- 图大小：1TB+（压缩存储）

**JanusGraph 选型**：
- 后端 HBase（存图数据）
- 索引 Elasticsearch（按属性查节点）
- 分布式（支持百亿节点）

**为什么不用 Neo4j**：
- Neo4j 社区版单机
- 企业版分布式但贵
- JanusGraph 开源分布式

## 九、底层本质：从"个体"到"群体"的风控范式

传统风控 vs 图风控：

| 维度 | 单点规则 | 图风控 |
|------|---------|--------|
| 视角 | 个体 | 群体 |
| 数据 | 用户特征 | 关系网络 |
| 攻防 | 黑产伪装个体即可绕 | 必须伪装整个网络（成本高） |
| 算法 | 阈值、规则 | 图算法、拓扑分析 |

**图风控的精髓**：
- 黑产可以伪装个体（实名、养号）
- 但很难伪装网络（团伙必然有共享设备/IP/资金流）
- 网络拓扑是不可消除的"指纹"

**这是"关系即风险"的哲学**：
- 个体异常可能误判
- 群体异常几乎准确
- 关系网络是"行为留下的不可磨灭痕迹"

## 十、和 AI 的融合

**GNN（图神经网络）**：
- 节点 embedding（学节点表示）
- 关系预测（预测未知欺诈）
- 团伙分类（GNN 自动挖团伙）

**LLM + 图**：
- GraphRAG（结合知识图谱 + LLM）
- 自然语言查询图（"找出和这个用户相关的可疑团伙"）
- LLM 生成图查询 Cypher

## 常见考点
1. **十亿节点规模怎么存**？——JanusGraph + HBase 后端（按节点 ID 分片）+ ES 索引（属性查）。
2. **在线查询为什么限 2 跳**？——超过 2 跳节点数指数爆炸，必须预计算或离线算。
3. **团伙规模阈值怎么定**？——正常用户 1-3 个关联，黑产通常 10+；阈值要结合误杀率调（看大盘）。

**代码示例**（Flink 实时建同设备边）：
```java
logins.keyBy(e -> e.did)
    .window(SlidingEventTimeWindows.of(Time.hours(1), Time.minutes(10)))
    .apply((did, window, events, out) -> {
        List<LoginEvent> list = new ArrayList<>();
        for (LoginEvent e : events) list.add(e);
        // 两两建边（同设备的不同 UID）
        for (int i = 0; i < list.size(); i++) {
            for (int j = i + 1; j < list.size(); j++) {
                out.collect(new Edge(list.get(i).uid, list.get(j).uid, "same_device", did));
            }
        }
    });
```
