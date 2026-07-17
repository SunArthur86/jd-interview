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

## 苏格拉底式面试追问

> 这组追问不背答案，模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：特征平台有"离线 T+1"和"实时流"两套链路。但两套链路意味着双倍的开发/计算/存储成本。为什么不只做实时流（Flink）？实时特征更新鲜，离线的是不是过时了？**

实时流不能完全替代离线，有三个根本原因。第一，**计算复杂度**——有些特征需要"全量历史聚合"（如"用户过去 30 天的购买类目分布"），实时流处理 30 天的窗口数据成本高（Flink 的 state 膨胀，TB 级状态），而离线 Spark 扫历史分区一把算完，成本低 10 倍。第二，**历史回算**——模型训练需要"历史某时刻的特征值"（T 时刻的模型看 T-30 天的特征），实时流只保留当前快照（不存历史），训练时拿不到"一个月前的实时特征"。离线仓存全量历史，训练时能精确回算。第三，**训推一致性**——如果模型训练用离线特征（T+1），推理用实时特征（毫秒），两者的"时间窗口"不一致（离线是"昨天截止"，实时是"当前时刻"），特征分布漂移，模型效果降。解法：训练和推理用同一套特征 DSL（共享逻辑），离线用 Spark 算、实时用 Flink 算，保证"逻辑一致"，即使时间窗口略有差异，分布也不漂移。两套链路是"成本 + 新鲜度 + 训推一致"的 trade-off。

### 第二层：证据与定位

**Q：模型上线后 AUC 从离线的 0.78 降到线上的 0.72。你怀疑是"训练-推理特征不一致"（training-serving skew）。怎么定位是哪个特征出了问题？**

用 Feature Log 回流 + 分布对比定位。第一，**Feature Log 回流**——在线推理时，把每次请求的"输入特征值"记到 Feature Log（Kafka → Hive），形成"线上特征快照"。第二，**离线-线上分布对比**——对每个特征，算离线训练集和线上 Feature Log 的分布差异（KS 检验、PSI）。如果某特征的 KS > 0.1 或 PSI > 0.2，说明分布漂移严重，是 skew 嫌疑。第三，**常见 skew 原因**——（1）时间窗口不一致（离线算"过去 7 天"，实时算"过去 7 天到当前"，差几小时）；（2）计算逻辑不一致（离线用 SQL 的 `COUNT DISTINCT`，实时用 Flink 的 `HyperLogLog` 近似，结果略有差异）；（3）缺失值处理不一致（离线填 0，实时填默认值 -1）。第四，**A/B 验证**——把嫌疑特征改成"离线/线上一致"的逻辑，重新训模型，看 AUC 是否恢复。如果改了特征 X 后 AUC 从 0.72 回到 0.78，特征 X 是 skew 源头。

### 第三层：根因深挖

**Q：你定位到 skew 来自"用户购买次数"特征——离线用 Spark 算（精确），实时用 Flink 算（近似）。为什么同一逻辑会算出不同值？**

根因是"计算引擎的实现差异"。第一，**窗口边界差异**——离线 Spark 算"过去 7 天的购买次数"是 `[7天前 00:00, 今天 00:00]`（按自然日），实时 Flink 算是 `[当前时刻 - 7天, 当前时刻]`（滚动窗口）。两者差几小时，如果用户在这几小时内购买了，实时多算 1 次。第二，**去重逻辑差异**——离线用 `COUNT(DISTINCT order_id)`（精确去重），实时用 Flink 的 `HyperLogLog`（近似去重，误差 1-2%）。大用户（购买多）的去重差异更明显。第三，**数据延迟**——离线用 T+1 的全量数据（订单已确认），实时用 Kafka 的实时事件流（可能有"待支付"订单，后来取消）。实时把"取消订单"也算进购买次数，离线不算。解法：第一，**统一 DSL**——用同一套特征定义代码，编译成 Spark 和 Flink 的实现（如 FeatHub/自研 DSL），保证逻辑一致。第二，**统一窗口语义**——明确"7 天"是"自然日 7 天"还是"滚动 168 小时"，离线和实时一致。第三，**Feature Log 校验**——每天对比离线和实时的特征值（同一时间点），差异 > 5% 告警。

**Q：那为什么不只用 Flink 算特征（实时 + 存历史），放弃 Spark 离线？一套引擎不是更一致吗？**

只用 Flink 的"流批一体"理论可行，但生产有局限。第一，**历史回算成本**——Flink 的 state 存在 RocksDB/内存，存 30 天的全量历史事件（用户行为流）需要 PB 级 state，Flink 的 state 管理开销大（checkpoint 慢、恢复慢）。Spark 扫 Hive 分区（历史数据已按天分区），批处理算历史特征，成本低 10 倍。第二，**算法复杂度**——有些特征要"复杂 SQL"（多表 JOIN、窗口函数、嵌套子查询），Spark SQL 支持完整，Flink SQL 的功能较少（复杂 JOIN 支持弱）。第三，**数据修正**——历史数据可能要"重算"（发现数据 bug 修正后重跑），Spark 批处理重跑简单（重新扫分区），Flink 重跑要"回放历史流"（Kafka retention 只有 7 天，更早的数据回放不了）。**生产实践**——Flink 做实时特征（毫秒级新鲜度），Spark 做离线特征（T+1 + 历史回算），两者用共享 DSL 保证逻辑一致。Flink 的"流批一体"是趋势（未来可能统一），但当前（2026 年）Spark + Flink 双链路仍是主流。

### 第四层：方案权衡

**Q：特征平台在线查询用 Redis（毫秒）。但一个推荐请求要查 200 个特征（用户特征 + 商品特征 + 上下文特征），200 次 Redis GET 要 200ms。太慢了，怎么优化？**

批量查询 + 本地缓存。第一，**MGET 批量查询**——把 200 个 key 的 GET 合并成一次 `MGET key1 key2 ... key200`，Redis 单命令执行（1ms 拿回 200 个值），从 200ms 降到 1ms。Redis 的 MGET 是原生的批量操作，O(N) 但无网络往返开销。第二，**Pipeline**——如果特征存在不同 Redis 节点（Cluster 分片），用 Pipeline 发送多个 GET（不等单个返回，批量发批量收），减少网络 RTT。第三，**本地缓存**——200 个特征里，有些是"变化慢的"（用户画像，5 分钟更新），用 Caffeine 本地缓存（命中率 80%），80% 的特征从本地内存读（0.01ms），20% 从 Redis 读。综合：本地缓存挡 80%（160 个特征，0.01ms）+ Redis MGET 查剩余 20%（40 个特征，1ms）= 总耗时 1ms。第四，**特征预聚合**——把"一次请求要的 200 个特征"聚合成一个大 Hash 存 Redis（`features:user:123` 包含所有用户特征），一次 HGETALL 拿回，省多次查询。推荐场景用预聚合（请求模式固定），搜索场景用按需查（特征组合多变）。

**Q：那为什么不用 HBase 替代 Redis？HBase 也能毫秒级查询，而且支持海量数据（千亿特征），Redis 内存放不下千亿 key。**

HBase 和 Redis 的延迟差 10 倍，特征查询场景 Redis 不可替代。第一，**延迟对比**——Redis 内存查询 0.1-1ms，HBase（LSM-Tree + 磁盘）查询 5-20ms（即使有 BlockCache）。推荐场景要求总延迟 < 50ms（含模型推理），特征查询 200ms（HBase）超 SLO，Redis 1ms 才达标。第二，**QPS 对比**——Redis 单实例 10 万 QPS，HBase 单 RegionServer 1 万 QPS。推荐场景 QPS 百万级，Redis 10 个实例搞定，HBase 要 100 个 RegionServer。第三，**正确的分层**——**Redis 存"热特征"**（活跃用户的特征，访问频繁，占 20% 数据但 80% 流量），**HBase 存"全量特征"**（所有用户，冷数据回源）。查询路径：Redis（热）→ miss → HBase（冷）→ 回填 Redis。这样 Redis 只存热数据（内存可控），HBase 兜底全量。拼多多特征平台：Redis Cluster（10TB，热特征）+ HBase（1PB，全量特征），Redis 命中率 95%，HBase 只承担 5% 的回源查询。

### 第五层：验证与沉淀

**Q：你怎么证明"Feature Log 回流 + 分布校验"真的消除了 training-serving skew？**

三个指标对比。第一，**特征分布一致性**——对每个特征算离线 vs 线上的 KS 检验值，优化前 30% 的特征 KS > 0.1（漂移），优化后 95% 的特征 KS < 0.05（一致）。每周自动跑 KS 检验，漂移特征告警。第二，**模型 AUC 稳定性**——对比优化前后，离线 AUC 和线上 AUC 的 gap。优化前 gap=0.06（离线 0.78、线上 0.72），优化后 gap=0.02（离线 0.78、线上 0.76）。gap 缩小证明 skew 消除。第三，**黄金集回归**——维护一套"离线-线上对照集"（1000 条样本，同时有离线和线上特征值），模型上线前跑对照集，如果"离线特征推理结果 vs 线上特征推理结果"差异 > 2%，说明 skew 严重，不上线。三个指标（KS + AUC gap + 黄金集）一致改善，证明 skew 治理生效。监控 `feature_skew_alert_count`（漂移特征数），持续治理。

**Q：特征平台的经验怎么沉淀，让新特征上线不再踩 skew 的坑？**

三件事。第一，**统一 Feature DSL**——所有特征用同一套 DSL 定义（Spark 和 Flink 共享），从源头保证逻辑一致。新特征必须用 DSL，不能"离线写 SQL、实时写 Java"两套实现。第二，**自动 KS 校验**——特征上线前，自动跑离线-线上的 KS 检验，KS > 0.1 阻止上线（CI/CD gate）。新特征默认经过校验，不靠人工 review。第三，**Feature Log 标准化**——所有在线推理必须记 Feature Log（不记的模型不让上线），Feature Log 是"线上特征的 ground truth"，用于持续校验和问题排查。把 skew 治理嵌入"特征上线流程"，不是"出了问题再查"。监控 `feature_onboarding_skew_rate`（新上线特征的 skew 比例），目标 < 5%。

## 结构化回答


**30 秒电梯演讲：** 像现代超市——大仓每周补货（离线仓），冷鲜每天来（实时窗口），货架（在线查询）随取随有，前端 POS（推理）和后端盘点（训练）用同一套 SKU 编码（一致）。

**展开框架：**
1. **三层：离线仓** — 离线仓 / 实时流 / 在线查询
2. **离线：Spa** — Spark/Hive T+1 → HBase/特征仓
3. **实时：Kaf** — Kafka → Flink → Redis

**收尾：** 实时特征延迟怎么办？


## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：特征平台架构设计？实时离线怎么打通？ | 今天聊「特征平台架构设计？实时离线怎么打通？」。一句话：特征平台架构核心是"离线批（T+1）+ 实时流（毫秒）+ 在线查询（Feature Store API）+ 训推一致"… | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：三层：离线/实时/在线 | 核心概念 |
| 0:51 | 能力/参数拆解表 | 要点是：离线 Spark/Hive T+1 | 能力拆解 |
| 1:30 | 流程图：输入→处理→输出 | 要点是：实时 Kafka/Flink/Redis | 关键机制 |
| 2:09 | 代码片段 + 注释高亮 | 要点是：一致：共享 DSL + Feature Log | 实战要点 |
| 3:00 | 总结卡 + 下期预告 | 记住这些核心点就够了。下期我们接着聊——实时特征延迟怎么办？。 | 收尾 |
