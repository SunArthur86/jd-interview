---
id: ant-risk-022
difficulty: L4
category: jd-arch
subcategory: 特征平台设计
tags:
- 蚂蚁
- 风控
- 特征平台
- FeatureStore
- 系统设计
feynman:
  essence: 特征平台是"特征的定义、计算、存储、服务"一站式平台，解决特征复用、口径一致、上线慢的痛点。
  analogy: 特征平台像中央厨房——食材（原始数据）→半成品（特征）→配送（在线服务）。各餐厅（业务）共享中央厨房，避免各自备料。
  first_principle: 算法/规则都依赖特征，没有平台会重复造轮子、口径不一致、上线慢。平台化让"特征即服务"。
  key_points:
  - 特征生命周期：定义 → 计算 → 存储 → 服务 → 治理
  - 离线特征（Spark/Hive）+ 实时特征（Flink）双轨
  - 在线存储：HBase（持久）+ Redis（热缓存）
  - 离线存储：Hive（特征仓库）+ Iceberg（版本）
  - 一致性：同一份 SQL 双跑 + 对账
first_principle:
  problem: 风控算法依赖几百个特征，每个算法各算各的导致重复、口径不一致、上线慢，如何统一？
  axioms:
  - 特征有自然复用性（多模型共用）
  - 计算口径必须一致（避免业务事故）
  - 在线/离线双轨必须保证一致
  rebuild: 建特征平台——统一定义（DSL）、统一计算（批+流）、统一存储（离线+在线）、统一服务（API），让特征像数据库表一样可被多个业务复用。
follow_up:
- 离线在线一致性怎么保证？——同一 SQL 双引擎执行；T+1 对账；用同一份代码（如 Feast）
- 实时特征延迟要求？——Flink 写入 HBase < 1s；在线查询 < 30ms
- 怎么评估特征质量？——IV（信息价值）、PSI（群体稳定性）、覆盖率、重要性
memory_points:
- 特征平台 = 定义 + 计算 + 存储 + 服务 + 治理 五位一体
- 离线 Spark + 实时 Flink 双轨，靠同一 SQL 保证一致
- 在线 HBase + Redis，离线 Hive + Iceberg
- 特征注册要带：定义、SQL、版本、owner、TTL
---

# 【蚂蚁风控】设计一个特征平台，支持亿级用户、千万特征、毫秒级查询

> JD 依据："智能化数据平台"。这是 JD 明确提到"优先"的方向。

## 一、需求拆解

**业务需求**：
- 支撑风控规则、模型、关系网络
- 千万级特征定义，亿级用户实例
- 实时特征（毫秒）、离线特征（T+1）

**技术需求**：
- 在线查询 < 30ms（决策同步链路）
- 实时特征写入延迟 < 1s
- 离线计算吞吐支持千亿数据
- 离线在线口径 100% 一致

## 二、整体架构

```
┌──────────────────────────────────────────────────────────────┐
│                      特征定义层（DSL）                       │
│  feature.yaml: name, type, sql, ttl, owner, version         │
└──────────────────────────────────────────────────────────────┘
                              ↓
┌──────────────────────────────────────────────────────────────┐
│                      特征计算层                              │
│  ┌────────────────┐         ┌────────────────┐              │
│  │ 离线（Spark）  │         │ 实时（Flink）  │              │
│  │ T+1 跑批       │         │ 毫秒级流式     │              │
│  │ 千亿数据       │         │ 增量更新       │              │
│  └────────────────┘         └────────────────┘              │
└──────────────────────────────────────────────────────────────┘
                              ↓
┌──────────────────────────────────────────────────────────────┐
│                      特征存储层                              │
│  ┌────────────────┐         ┌────────────────┐              │
│  │ 离线（Hive+    │         │ 在线（HBase +  │              │
│  │ Iceberg）      │         │ Redis）        │              │
│  │ 训练用         │         │ 决策查询用     │              │
│  └────────────────┘         └────────────────┘              │
└──────────────────────────────────────────────────────────────┘
                              ↓
┌──────────────────────────────────────────────────────────────┐
│                      特征服务层（API）                       │
│  getFeatures(uid, [feat_names]) → Map<name, value>          │
│  Point Query: <10ms (Redis)                                  │
│  Batch Query: <30ms (Redis Pipeline + HBase)                │
└──────────────────────────────────────────────────────────────┘
                              ↓
┌──────────────────────────────────────────────────────────────┐
│                      特征治理层                              │
│  版本、权限、监控、对账、特征目录                            │
└──────────────────────────────────────────────────────────────┘
```

## 三、特征定义（统一 DSL）

```yaml
# 特征定义文件
features:
  - name: user_trade_cnt_1h
    type: REAL_TIME
    description: "用户近 1 小时交易次数"
    sql: |
      SELECT uid, COUNT(*) as cnt, HOP_START(1h, 5min) as w_start
      FROM trades
      GROUP BY uid, HOP(proctime, INTERVAL '5' MINUTE, INTERVAL '1' HOUR)
    storage:
      online: { type: HBASE, table: feat_realtime, ttl: 7d }
      offline: { type: HIVE, table: feat_realtime_hist }
    owner: risk-team
    version: 2.1.0

  - name: user_amount_sum_90d
    type: OFFLINE
    description: "用户近 90 天累计金额"
    sql: |
      SELECT uid, SUM(amount) FROM trades
      WHERE dt >= date_sub(current_date, 90)
      GROUP BY uid
    storage:
      offline: { type: HIVE, table: feat_offline }
      online: { type: HBASE, table: feat_offline_online }  # T+1 推到在线
    schedule: "0 2 * * *"   # 每天 2 点跑
    owner: risk-team
    version: 1.0.0
```

**关键设计**：
- **统一 SQL**：离线和实时用同一份逻辑（避免口径不一致）
- **声明式**：算法只定义，平台执行
- **版本化**：每个特征有版本，支持回滚

## 四、特征计算层

**离线计算（Spark）**：
- 跑 T+1 全量
- 千亿数据，Spark 数百核并行
- 输出写 Hive + 推 HBase（在线查询用）

**实时计算（Flink）**：
- 订阅 Kafka 事件流
- 滑动窗口聚合
- 写 HBase + Redis（热缓存）

**双轨一致性**：
- 同一份 SQL 在 Spark 和 Flink 双引擎跑
- 每天 4 点对账（离线 vs 实时结果）
- 偏差 > 阈值告警

## 五、特征存储层

**在线存储（决策查询）**：

| 存储 | 角色 | 数据量 | RT |
|------|------|--------|-----|
| **Redis** | 热缓存（95% 命中） | 100GB（亿级 UID × 热特征） | <10ms |
| **HBase** | 兜底 + 全量 | 100TB（亿级 × 千特征） | <30ms |

**离线存储（训练/分析）**：

| 存储 | 用途 |
|------|------|
| **Hive** | 历史特征仓库（T+1 全量） |
| **Iceberg** | 特征版本化（时间旅行） |

## 六、特征服务层（API）

**统一查询接口**：
```java
public interface FeatureService {
    // 单点查（最快）
    Map<String, Object> get(String uid, List<String> featNames);

    // 批量查（一次请求合并）
    Map<String, Map<String, Object>> batchGet(List<String> uids, List<String> featNames);

    // 模型专用（特征向量）
    FeatureVector vector(String uid, String modelName);
}
```

**实现**：
```java
public class FeatureServiceImpl implements FeatureService {
    public Map<String, Object> get(String uid, List<String> feats) {
        // 1. 先查 Redis（Pipeline 批量）
        Map<String, Object> result = redisBatchGet(uid, feats);
        List<String> missing = findMissing(result, feats);

        if (!missing.isEmpty()) {
            // 2. 缺失的查 HBase
            Map<String, Object> fromHBase = hBaseGet(uid, missing);
            result.putAll(fromHBase);
            // 3. 回填 Redis（异步）
            asyncBackfillRedis(uid, fromHBase);
        }
        return result;
    }
}
```

**性能优化**：
- Redis Pipeline：批量查 N 个特征一次 RTT
- HBase 列族：特征按访问模式分族，避免读不需要的列族
- 本地缓存：Caffeine 缓存活跃用户（命中率 60%）

## 七、特征治理

**特征目录**（Feature Catalog）：
- 所有特征可搜索、可浏览
- 描述、字段、计算逻辑、覆盖率
- 用过的模型列表（依赖关系）

**特征版本**：
- 每个变更出新版本
- 训练用历史版本（保证一致）
- 在线用最新版本（灰度切换）

**特征质量监控**：
- **覆盖率**：null 比例
- **稳定性（PSI）**：分布漂移
- **重要性**：模型权重变化
- **新鲜度**：实时特征延迟

## 八、容量规划

```
亿级用户 × 千特征 = 千亿 cell
单 cell 平均 100B → 100TB

存储：
  HBase: 100TB（10 个 RegionServer 集群）
  Redis: 100GB（20 节点分片集群，热数据）
  Hive: 500TB（带历史）

QPS：
  查询：决策链路 5 万 QPS（峰值）
  写入：Flink 100 万 events/秒
```

## 九、底层本质：特征即数据资产

特征平台本质是把"特征"从代码资产升级为**数据资产**：
- 代码资产：每个算法自己写特征代码
- 数据资产：特征是平台管理的可复用资源

**这是从"手工作坊"到"工业流水线"的转变**：
- 定义标准化（DSL）
- 生产规模化（批+流）
- 流通统一（API）
- 质量可控（治理）

类比：
- 数据库时代：表是数据资产
- 数据仓库时代：表+视图是数据资产
- 机器学习时代：特征是数据资产
- LLM 时代：embedding 是数据资产

**和 AI 的关系**：
- LLM 推理需要特征（用户/物品特征作为上下文）
- LLM 训练数据本身就是"广义特征"
- 未来：特征平台 = AI 数据供给平台

## 十、开源方案对比

| 方案 | 特点 |
|------|------|
| **Feast**（开源） | 轻量、标准化，支持 Spark/Flink、Redis/HBase |
| **Tecton**（商业） | Databricks 系，强一致 |
| **自研** | 业务深度定制（蚂蚁的特征中台） |

**风控的选择**：大公司自研（业务复杂、规模大），中小团队用 Feast。

## 常见考点
1. **特征平台和数据库区别**？——特征是"加工后的派生数据"，平台管"计算+存储+服务+版本+治理"，比 DB 多了计算层。
2. **离线在线怎么保证一致**？——同 SQL 双跑 + 对账 + 一致性告警。
3. **怎么处理冷启动（新用户无特征）**？——默认值、相似用户群体统计、初始规则（无特征用规则）。

**代码示例**（特征质量监控）：
```java
// 每天跑一次特征质量检查
public void checkFeatureQuality(String featName) {
    // 覆盖率
    double coverage = computeCoverage(featName);
    if (coverage < 0.8) alert("低覆盖", featName);

    // PSI（群体稳定性，对比 7 天前）
    double psi = computePSI(featName, now(), minus7d());
    if (psi > 0.25) alert("分布漂移", featName);

    // 新鲜度（实时特征延迟）
    long lag = computeLag(featName);
    if (lag > 5000) alert("实时延迟", featName);
}
```
