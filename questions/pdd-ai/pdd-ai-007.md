---
id: pdd-ai-007
difficulty: L4
category: pdd-ai
subcategory: 特征工程
tags:
- 拼多多
- AI 中台
- 特征平台
- 实时计算
- 离线
feynman:
  essence: 特征平台是"统一管理模型用的特征数据"，离线（T+1 批）和实时（毫秒级流）双链路，对在线推理提供毫秒级特征查询。
  analogy: 像餐厅食材库——离线大仓（批补充隔天到货）+ 即时窗口（当天鲜货秒级补充），厨师（模型）下单立刻取用对应食材（特征）。
  first_principle: 模型推理依赖特征，特征分散在各业务系统/数据仓库，需要统一存储、计算、服务，保证训练-推理一致。
  key_points:
  - 三层：离线特征仓（Hive/HDFS）+ 实时特征（Flink/Redis）+ 在线服务（特征查询 API）
  - 离线：Spark/Hive 批处理 T+1
  - 实时：Flink 流计算 + Redis/在线存储
  - 训练-推理一致性：特征逻辑复用（同一份 SQL/DSL）
  - 特征注册中心：元数据/版本/血缘
first_principle:
  problem: 如何让模型在训练和线上推理拿到一致、新鲜、海量的特征？
  axioms:
  - 模型效果依赖特征
  - 特征来源多、时效要求不一
  - 训练/推理特征必须一致（否则分布漂移）
  rebuild: 特征平台（统一计算 + 统一存储 + 统一服务 + 元数据治理）。
follow_up:
  - 实时特征怎么算？——Flink 消费 Kafka 实时聚合写 Redis，推理读 Redis
  - 怎么保证训练-推理一致？——同一份特征 DSL（如 Feathr/共享 SQL），统一生成
  - 千亿特征怎么存？——分片 KV（Redis Cluster/HBase）+ 冷热分层
memory_points:
  - 三层：离线仓/实时/在线服务
  - 离线 Spark/Hive T+1，实时 Flink+Redis
  - 训推一致：同一份特征 DSL
  - 元数据：血缘/版本/注册中心
---

# 【拼多多 AI 中台】特征平台架构怎么设计？实时离线怎么打通？

> JD 依据："特征平台、消费者服务策略算法中台"。

## 一、特征平台要解决什么

**痛点**：
```
算法同学：要训练模型 → 找业务方取数据（一周）→ 各算各的特征 → 上线发现分布漂移（线上算的特征和训练不一致）
```

**平台目标**：
1. **统一存储**：特征集中管理，不散落各业务
2. **统一计算**：离线/实时用同一份逻辑（保证训推一致）
3. **统一服务**：在线推理毫秒级取特征
4. **治理**：血缘/版本/质量监控

## 二、分层架构

```
┌──────────────────────────────────────────────┐
│ 在线推理服务（毫秒级取特征）                 │
│   GET /feature?entity=user123&feats=age,...  │
└──────────────┬───────────────────────────────┘
               │
┌──────────────▼───────────────────────────────┐
│ 特征查询层（Feature Store API）              │
│   - 读实时（Redis）                          │
│   - 读离线（HBase/Cassandra，冷数据）        │
└──────┬───────────────────────┬───────────────┘
       │                       │
┌──────▼──────────┐  ┌─────────▼─────────────┐
│ 实时特征计算    │  │ 离线特征计算           │
│ Flink 流计算    │  │ Spark/Hive 批处理      │
│ Kafka → Flink   │  │ Hive → Spark           │
│   → Redis/HBase │  │   → Hive/特征仓        │
└─────────────────┘  └────────────────────────┘

┌──────────────────────────────────────────────┐
│ 元数据/治理（注册中心、血缘、版本、质量）    │
└──────────────────────────────────────────────┘
```

## 三、离线特征（T+1）

**场景**：用户画像、商品统计、长期行为。

```sql
-- 离线 SQL（Spark/Hive），次日产出
SELECT
  user_id,
  AVG(amount_30d) AS avg_amount_30d,
  COUNT(order_id) AS order_cnt_30d,
  LAST_CLICK_CAT AS interest_cat
FROM dwd_order
WHERE dt >= date_sub(current_date, 30)
GROUP BY user_id;
```

产出写入特征仓（Hive 表 + 索引到 HBase/Cassandra 供在线读）。

## 四、实时特征（毫秒级）

**场景**：用户最近 1 小时点击数、实时加购、最近浏览商品序列。

```
用户行为（点击/加购）→ Kafka → Flink 流计算 → Redis
                                          ↓
                                       (sliding window 聚合)
```

**Flink 实时聚合**：
```java
stream
  .keyBy(Event::getUserId)
  .window(SlidingEventTimeWindows.of(Time.hours(1), Time.minutes(5)))
  .aggregate(new CountAgg())                       // 最近 1 小时点击数
  .addSink(new RedisSink<>(redisConfig, new FeatureRedisMapper()));
```

**Redis 存储设计**：
```
key:   feat:user:123:click_cnt_1h
value: 42（计数）
TTL:   2 小时（过期自动清理）

或 Hash：
key:   feat:user:123
field: click_cnt_1h / cart_cnt_1h / ...
value: 对应值
```

## 五、在线特征查询

```java
// 推理时按 entity 取特征
public Map<String, Object> getFeatures(String entityId, List<String> feats) {
    Map<String, Object> result = new HashMap<>();
    // 1. 实时特征（Redis，<1ms）
    result.putAll(redis.hgetAll("feat:" + entityId));
    // 2. 离线特征（HBase，<5ms，已加载到本地缓存）
    result.putAll(localCache.get(entityId));   // Caffeine，定时刷新
    // 3. 跨表拼接（如商品特征 + 用户特征 join）
    return project(result, feats);
}
```

**优化**：
- **本地缓存**（Caffeine）：高 QPS 特征预热到 JVM 本地，避免每请求打 Redis
- **批量拉取**（Pipeline）：一次取多个特征减少 RTT
- **降级**：实时特征 Redis 不可用时，降级用离线（容忍秒级延迟）

## 六、训练-推理一致性（核心难点）

**问题**：训练用 SQL A 算，线上推理用 Java B 实现，逻辑差异 → 特征分布不一致 → 模型效果掉。

**方案**：
1. **共享特征 DSL**：训练/推理同一份定义（如 Feathr/Tecton 模式）
2. **特征日志**：推理时落特征快照（feature log），训练时回放当训练样本
3. **CI 校验**：特征上线前用历史数据校验分布（KS 检验）

```
训练样本 = 离线特征（T+1） + 标签
推理样本 = 实时特征 + 离线特征
两者通过 feature log 回流校验一致性
```

## 七、特征治理

- **注册中心**：每个特征有 owner、版本、血缘（来源表、计算逻辑）
- **质量监控**：缺失率/分布漂移/新鲜度（实时特征延迟告警）
- **复用**：特征目录可被多个模型复用，避免重复造轮子

## 八、底层本质

特征平台本质是**"特征的统一计算 + 统一存储 + 统一服务 + 治理"**——离线批量保证覆盖度（长期画像），实时流保证新鲜度（短期行为），在线服务保证查询性能，元数据治理保证训推一致。是 AI 中台的"数据底座"。

## 常见考点

1. **实时特征和离线特征冲突怎么办**？——以实时为准（新鲜），离线作冷启动/兜底；定期对账修正。
2. **千亿特征怎么存**？——分片 KV（Redis Cluster / HBase），按 entity 哈希分片，冷数据 HBase 冷热分层。
3. **怎么评估特征价值**？——IV（信息价值）、SHAP（模型贡献）、PCA 降维，结合业务可解释性筛选。
