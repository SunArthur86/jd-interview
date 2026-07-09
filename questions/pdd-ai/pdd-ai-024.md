---
id: pdd-ai-024
difficulty: L4
category: pdd-ai
subcategory: 特征工程
tags:
- 拼多多
- AI 中台
- 特征平台设计
- 实时
- 离线
- 一致性
feynman:
  essence: 特征平台架构核心是"离线批（T+1）+ 实时流（毫秒）+ 在线查询（Feature Store API）+ 训推一致"，难点在实时离线打通和训练-推理特征对齐。
  analogy: 像现代超市——大仓每周补货（离线仓），冷鲜每天来（实时窗口），货架（在线查询）随取随有，前端 POS（推理）和后端盘点（训练）用同一套 SKU 编码（一致）。
  first_principle: 模型推理需要新鲜 + 海量 + 训推一致的特征，离线保证覆盖度，实时保证新鲜度，统一服务保证一致性。
  key_points:
  - 三层：离线仓 / 实时流 / 在线查询
  - 离线：Spark/Hive T+1 → HBase/特征仓
  - 实时：Kafka → Flink → Redis
  - 在线：Feature Store API（聚合+降级）
  - 一致性：共享 DSL / Feature Log 回流
first_principle:
  problem: 怎么为模型提供新鲜、海量、训推一致的特征？
  axioms:
  - 离线覆盖广但慢
  - 实时新但成本高
  - 训推必须一致否则分布漂移
  rebuild: 特征平台（双链路 + 在线服务 + 一致性保证）。
follow_up:
  - 实时特征延迟怎么办？——水位线 + 延迟监控 + 降级用离线
  - 怎么保证训推一致？——共享 DSL + Feature Log 回流 + 上线前分布校验
  - 千亿特征怎么存？——Redis Cluster / HBase 分片 + 冷热分层
memory_points:
  - 三层：离线/实时/在线
  - 离线 Spark/Hive T+1
  - 实时 Kafka/Flink/Redis
  - 一致：共享 DSL + Feature Log
---

# 【拼多多 AI 中台】特征平台架构设计？实时离线怎么打通？

> JD 依据："特征平台、消费者服务策略算法中台"。

## 一、平台架构

```
┌────────────────────────────────────────────────────┐
│ 在线推理服务（毫秒级特征查询）                     │
└────────────────────┬───────────────────────────────┘
                     │ Feature Store API
┌────────────────────▼───────────────────────────────┐
│ 在线查询层（聚合 + 降级 + 缓存）                   │
│ - 实时特征：Redis（<1ms）                          │
│ - 离线特征：HBase/Cassandra（<5ms）                │
│ - 本地缓存：Caffeine（<0.1ms）                     │
└──────┬─────────────────────────────┬───────────────┘
       │                             │
┌──────▼──────────┐         ┌────────▼─────────────┐
│ 实时计算链路     │         │ 离线计算链路          │
│ Kafka → Flink   │         │ Hive → Spark         │
│   → Redis/HBase │         │   → 特征仓（Hive+索引）│
└─────────────────┘         └────────────────────────┘

┌────────────────────────────────────────────────────┐
│ 元数据治理                                          │
│ - 特征注册中心（owner/版本/血缘/质量）             │
│ - 共享 DSL（训推一致）                             │
│ - Feature Log 回流                                 │
└────────────────────────────────────────────────────┘
```

## 二、离线特征链路（T+1）

**场景**：用户长期画像、商品统计、历史行为。

```sql
-- T+1 离线 SQL（Spark/Hive）
INSERT OVERWRITE TABLE feat.user_profile
SELECT
  user_id,
  AVG(amount) OVER (PARTITION BY user_id ORDER BY dt ROWS 30 PRECEDING) AS avg_amount_30d,
  COUNT(order_id) AS total_orders,
  MAX(dt) AS last_active_dt
FROM dwd.dwd_order
WHERE dt BETWEEN date_sub(current_date, 30) AND current_date
GROUP BY user_id;
```

**产出存储**：
- Hive（离线查询/训练用）
- HBase（在线查询，列存）
- 索引到本地缓存（在线服务预热）

**调度**：Airflow T+1 调度，凌晨跑完，6 点前可用。

## 三、实时特征链路（毫秒级）

**场景**：用户最近 1 小时点击数、实时加购、最近浏览商品序列。

```
App/服务端行为埋点
       ↓
    Kafka
       ↓
    Flink（窗口聚合/状态计算）
       ↓
    Redis / HBase
```

### Flink 实时聚合示例
```java
DataStream<Event> events = env.addSource(new FlinkKafkaConsumer<>("events", schema, props));

events
    .keyBy(Event::getUserId)
    .window(SlidingEventTimeWindows.of(Time.hours(1), Time.minutes(5)))  // 1h 窗口 5min 滑动
    .aggregate(new CountAgg())
    .addSink(new RedisSink<>(redisConfig, new FeatureRedisMapper("feat:user:click_cnt_1h")));
```

### Redis 存储设计
```
方案 1：String
  key: feat:user:123:click_cnt_1h
  val: 42
  TTL: 7200s

方案 2：Hash（推荐，多特征聚合查询）
  key: feat:user:123
  field: click_cnt_1h
  field: cart_cnt_1h
  field: last_cat
  ...
  TTL: 7200s

方案 3：ZSet（最近 N 个商品）
  key: feat:user:123:recent_items
  member: 商品ID
  score: 时间戳
```

## 四、在线查询层

```java
@Service
public class FeatureQueryService {

    @Autowired RedisTemplate<String, String> redis;
    @Autowired HBaseTemplate hbase;
    @Autowired Cache<String, Map<String, Object>> localCache;  // Caffeine

    public Map<String, Object> query(String entityId, List<String> feats) {
        // 1. 本地缓存（热点特征预热）
        Map<String, Object> cached = localCache.getIfPresent(entityId);
        if (cached != null) return project(cached, feats);

        // 2. 实时特征（Redis）
        Map<Object, Object> realtime = redis.opsForHash().entries("feat:user:" + entityId);

        // 3. 离线特征（HBase 或本地预热缓存）
        Map<String, Object> offline = localCache.get(entityId, k -> loadFromHBase(k));

        // 4. 合并
        Map<String, Object> result = new HashMap<>();
        result.putAll(offline);
        result.putAll(realtime);   // 实时覆盖离线（新值优先）

        return project(result, feats);
    }

    private Map<String, Object> loadFromHBase(String entityId) {
        // HBase 查询，结果预热到本地
    }
}
```

**优化**：
- **Pipeline 批量**：一次取多个特征，减少 RTT
- **本地缓存**：高 QPS 特征预热到 JVM（Caffeine，TTL 几秒）
- **降级**：Redis 挂时用离线（容忍秒级延迟）
- **批量预热**：高峰前预热 TopN 用户特征

## 五、训推一致性（核心难点）

**问题**：
```
训练：用 Spark SQL A 算特征
推理：用 Java B 实现同一逻辑
逻辑差异 → 特征分布不一致 → 模型上线效果掉
```

### 解决方案

#### 1. 共享特征 DSL（Feathr/Tecton 模式）
```
统一用 DSL 定义特征：
feature UserClickCount {
  source: events
  transform: count(*) where action == 'click' window = 1h
  output: feat.user.click_cnt_1h
}

训练/推理都调 DSL 编译器生成代码（Spark 或 Java）
逻辑同一份，不可能不一致
```

#### 2. Feature Log 回流
```
推理时记录实际用的特征：
{
  "request_id": "...",
  "entity_id": "user_123",
  "features": {"click_cnt_1h": 42, "age": 28, ...},
  "prediction": 0.85,
  "timestamp": ...
}

→ Kafka → HDFS
→ 训练时回放当训练样本（保证训推特征来源同一）
```

#### 3. CI 分布式校验
```
特征上线前用历史数据校验：
- 训练集 vs 在线推理分布（KS 检验）
- 特征缺失率
- 特征值域
超阈值禁止上线
```

## 六、元数据治理

### 特征注册中心
```
每个特征有：
- name, version, owner
- 类型（数值/类别/序列）
- 数据源（表/流）
- 计算逻辑（SQL/DSL）
- 血缘（来源表 → 特征 → 模型）
- 质量指标（缺失率/分布/延迟）
- 复用情况（被多少模型用）
```

### 质量监控
```
- 实时延迟（实时特征 Flink 到 Redis 延迟，>1min 告警）
- 缺失率（>20% 告警）
- 分布漂移（KS 检验，>0.1 告警）
- 异常值（超出历史分位数告警）
```

## 七、典型存储选型

| 数据类型 | 量级 | 延迟 | 存储 |
|---------|------|------|------|
| 离线画像 | 千万-亿 | 5ms | HBase |
| 实时特征 | 千万-亿 | 1ms | Redis Cluster |
| 序列特征 | 千万-亿 | 5ms | HBase / Redis ZSet |
| Embedding | 亿×千维 | 10ms | 向量库（Milvus/Faiss） |
| 图特征 | 千万 | 10ms | 图数据库（Neo4j/JanusGraph） |

## 八、拼多多实战规模

```
特征量：千亿级
查询 QPS：百万级
延迟：P99 < 10ms
实时特征延迟：Flink → Redis < 30s

关键挑战：
- 千亿特征存储（分片 + 冷热分层）
- 实时低延迟（本地缓存 + Pipeline）
- 训推一致（Feature Log + DSL）
- 多团队复用治理（注册中心）
```

## 九、底层本质

特征平台本质是**"离线批 + 实时流 + 在线查询 + 训推一致"**四位一体——离线保证覆盖度，实时保证新鲜度，在线服务保证性能，元数据治理保证一致和复用。是 AI 中台"数据底座"，所有模型都依赖它。

## 常见考点

1. **实时特征延迟大怎么办**？——Flink 水位线 + 延迟监控 + 降级离线 + 缓存兜底。
2. **特征更新频率怎么定**？——按业务时效性（实时/分钟/小时/天），权衡成本和价值。
3. **特征怎么评估价值**？——IV/SHAP/AUC-drop（移除该特征看模型掉多少），结合业务可解释性筛选。
