---
id: java-architect-065
difficulty: L4
category: java-architect
subcategory: 特征平台设计
tags:
- Java 架构师
- 推荐系统
- 在线服务
- 特征一致性
feynman:
  essence: 推荐系统的核心难题不是模型（模型公开可复现），而是"特征一致性"——离线训练用的特征和在线预测用的特征必须完全一致，否则模型在线效果崩。一致性陷阱：离线用历史全量数据算特征（如"近 30 天点击数"），在线用实时流算（同一特征但数据窗口/计算逻辑微妙不同），导致离线训练的模型在线预测时特征值"偏移"，模型效果骤降。架构核心是"统一特征平台 + 在线离线特征对齐"。
  analogy: 像培训销售。培训时（离线训练）用去年的市场数据教销售话术，上岗后（在线预测）面对的是实时市场。如果培训数据和市场实时数据口径不一致（去年统计"高意向客户"的标准和今年实时判断标准不同），销售的话术就失效。推荐系统一样——离线训练特征口径必须和在线预测完全一致，否则模型学到的是"错口径的特征模式"，在线预测用"对口径的特征"输入，模型懵了。
  first_principle: 为什么特征一致性这么难？因为离线（批处理）和在线（流处理）是两套技术栈——离线用 Spark 算历史特征（全量数据），在线用 Flink 算实时特征（增量数据）。同样的特征（如"近 30 天点击数"）在两套系统里实现，细微差异（时间窗口边界、去重逻辑、聚合方式）导致特征值不一致。解法是"统一特征定义 + 双跑校验"——用同一份特征配置生成离线和在线代码，且定期双跑对账。
  key_points:
  - 特征一致性陷阱：离线训练 vs 在线预测，特征口径不一致导致模型失效
  - 统一特征平台：特征定义一次，离线/在线生成（DSL → Spark/Flink 代码）
  - 在线特征服务：低延迟查询（Redis/特征存储），模型预测时实时取特征
  - 特征监控：离线/在线特征值对账（同 entity 同特征，值应一致）
  - 特征回填：在线实时特征同步到离线（保证训练用最新特征口径）
first_principle:
  problem: 推荐模型离线训练效果好（AUC 0.8），上线后效果差（AUC 0.6），根因是特征不一致，怎么解决？
  axioms:
  - 离线训练用批处理（Spark，全量历史数据）
  - 在线预测用流处理（Flink，实时增量数据）
  - 两套系统实现同一特征，口径微妙不同导致值不一致
  - 模型在"错口径特征"上训练，"对口径特征"上预测，效果崩
  rebuild: 统一特征平台 + 在线离线对齐。特征用 DSL 定义（声明式），平台自动生成离线 Spark 作业和在线 Flink 作业（同口径）。在线预测时从特征存储（Redis/Feature Store）实时取特征。定期双跑对账——同一 entity 同一时间点，离线特征值 vs 在线特征值，差异率应 < 0.1%。监控 feature_consistency_rate（一致性率，应 > 99.9%）。
follow_up:
  - 实时特征怎么低延迟查询？——Redis 存（特征 key = entity_id + feature_name），模型预测时批量 MGET。
  - 特征版本管理怎么做？——特征变更版本化（v1/v2），模型训练锁定特征版本，特征变更不影响已上线模型。
  - 新特征怎么 A/B 测试？——新特征灰度上线（部分流量用），对比效果，好则全量。
  - 特征怎么回填（历史数据补算）？——新特征上线时，离线补算历史数据，供模型训练。
  - 特征重要性怎么评估？——模型训练后输出特征重要性（如 XGBoost 的 feature_importance），低重要性特征剔除。
memory_points:
  - 特征一致性：离线训练 vs 在线预测口径一致
  - 统一特征平台：DSL 定义，生成 Spark+Flink
  - 在线特征服务：Redis 低延迟查询
  - 特征对账：离线/在线值比对，差异 < 0.1%
  - 特征版本：锁定训练版本，变更不影响线上模型
---

# 【Java 后端架构师】推荐系统在线服务与特征一致性

> 适用场景：JD 推荐核心。推荐模型离线训练 AUC 0.8（效果好），上线后 AUC 0.6（效果崩）——这是"训练服务不一致"的经典问题。根因是特征不一致——离线训练用的特征计算口径和在线预测不同。解决不了这个问题，模型再先进也白搭。核心是"统一特征平台 + 在线离线对齐"。

## 一、概念层：特征一致性陷阱

**训练服务不一致的三种表现**：

```
陷阱 1：特征口径不一致
  离线训练：Spark 算"近 30 天点击数"，时间窗口 [T-30, T]
  在线预测：Flink 算"近 30 天点击数"，时间窗口 [T-30, T)  ← 少了边界点
  结果：同一用户同一时刻，离线 28 次，在线 27 次，特征值不一致

陷阱 2：数据分布漂移
  离线训练：用 1 月份数据训练，用户画像"价格敏感"
  在线预测：6 月份预测，用户行为变了（消费升级），但特征还是旧的
  结果：模型基于过时分布训练，预测效果差

陷阱 3：特征工程不一致
  离线训练：特征做了归一化（min-max，min=0, max=1000）
  在线预测：特征没归一化（或归一化参数不同）
  结果：模型输入分布偏移，预测错误
```

**统一特征平台架构**（解决一致性）：

```
                    特征 DSL 定义（声明式）
                    "近30天点击数：窗口30天，聚合COUNT"
                          │
              ┌───────────┴───────────┐
              │                       │
              ▼                       ▼
    ┌─────────────────┐     ┌─────────────────┐
    │ 离线特征生成      │     │ 在线特征生成      │
    │ (Spark 批处理)   │     │ (Flink 流处理)   │
    │                  │     │                  │
    │ 算历史特征       │     │ 算实时特征        │
    │ 写特征仓库       │     │ 写 Redis         │
    │ 供模型训练       │     │ 供在线预测        │
    └─────────────────┘     └─────────────────┘
              │                       │
              │     ┌─────────┐       │
              └────►│ 特征对账 │◄──────┘
                    │ 差异检测 │
                    └─────────┘
                        │
                   不一致告警 + 修复
```

## 二、机制层：特征 DSL 与统一生成

**特征 DSL 设计**：

```java
/**
 * 特征定义（DSL）：声明式描述，平台自动生成离线/在线代码
 */
@Data
public class FeatureSpec {
    private String name;              // 特征名：user_click_count_30d
    private String description;       // 描述：近30天点击数
    private FeatureType type;         // 类型：用户/商品/上下文
    private String entityType;        // 实体：user_id / item_id
    private Aggregation agg;          // 聚合：COUNT / SUM / AVG
    private Duration window;          // 窗口：30 days
    private String sourceEvent;       // 来源事件：click
    private List<Filter> filters;     // 过滤条件：status=success
    private boolean realtime;         // 是否实时特征
}

/**
 * 示例：用户近30天点击数
 */
FeatureSpec clickCount30d = FeatureSpec.builder()
    .name("user_click_count_30d")
    .description("用户近30天点击数")
    .type(FeatureType.USER)
    .entityType("user_id")
    .agg(Aggregation.COUNT)          // 聚合方式：计数
    .window(Duration.ofDays(30))     // 时间窗口：30 天
    .sourceEvent("click")            // 来源：点击事件
    .filters(Arrays.asList(
        new Filter("status", "=", "success")))  // 只算成功点击
    .realtime(true)                   // 实时特征
    .build();
```

**特征平台（生成离线/在线作业）**：

```java
@Service
public class FeaturePlatform {

    /**
     * 注册特征：DSL → 生成离线 Spark 作业 + 在线 Flink 作业
     */
    public void registerFeature(FeatureSpec spec) {
        // 1. 生成离线 Spark SQL（训练用）
        String sparkSql = generateSparkSql(spec);
        sparkJobService.submit(spec.getName() + "_offline", sparkSql);

        // 2. 生成在线 Flink 作业（实时预测用）
        if (spec.isRealtime()) {
            String flinkCode = generateFlinkCode(spec);
            flinkJobService.deploy(spec.getName() + "_online", flinkCode);
        }

        // 3. 注册特征元信息（供查询）
        featureMetaRepo.save(spec);

        // 4. 启动对账任务（离线/在线一致性检测）
        scheduleReconciliation(spec);

        log.info("特征 {} 注册完成", spec.getName());
    }

    /**
     * 生成 Spark SQL（离线特征计算）
     */
    private String generateSparkSql(FeatureSpec spec) {
        // 根据 DSL 自动生成 SQL，确保口径一致
        return String.format(
            "SELECT user_id, " +
            "       COUNT(1) as %s " +     // 聚合方式
            "FROM click_event " +           // 来源事件
            "WHERE status = 'success' " +   // 过滤条件
            "  AND event_time BETWEEN " +
            "      DATE_SUB('{{date}}', %d) AND '{{date}}' " +  // 窗口
            "GROUP BY user_id",
            spec.getName(),
            (int) spec.getWindow().toDays()
        );
    }

    /**
     * 生成 Flink 代码（在线实时特征）
     */
    private String generateFlinkCode(FeatureSpec spec) {
        // 生成 Flink KeyedProcessFunction，窗口聚合，结果写 Redis
        return FlinkCodeGen.generate(spec);
    }
}
```

## 三、机制层：在线特征服务

**特征查询服务（低延迟）**：

```java
@Service
public class FeatureService {

    @Autowired private RedisTemplate redis;

    /**
     * 在线查询特征：模型预测时调用，需低延迟（< 10ms）
     */
    public Map<String, Object> getFeatures(String entityType, Long entityId,
                                            List<String> featureNames) {
        Map<String, Object> features = new HashMap<>();

        // 批量从 Redis 取（MGET，一次网络往返）
        List<String> keys = featureNames.stream()
            .map(name -> "feature:" + entityType + ":" + entityId + ":" + name)
            .collect(Collectors.toList());

        List<Object> values = redis.opsForValue().multiGet(keys);

        for (int i = 0; i < featureNames.size(); i++) {
            Object value = values.get(i);
            if (value == null) {
                // 特征缺失：降级（默认值 or 实时算）
                value = computeOnDemand(featureNames.get(i), entityId);
                monitor.record("feature_missing", featureNames.get(i));
            }
            features.put(featureNames.get(i), value);
        }

        monitor.record("feature_query_rt",
            System.currentTimeMillis() - startTime);
        return features;
    }

    /**
     * 特征缺失时按需计算（降级，慢但保可用）
     */
    private Object computeOnDemand(String featureName, Long entityId) {
        FeatureSpec spec = featureMetaRepo.findByName(featureName);
        if (spec == null) return getDefault(featureName);

        // 从实时事件流临时算（降级，延迟高）
        return realtimeComputeService.compute(spec, entityId);
    }
}
```

**推荐预测服务（组合特征查询 + 模型推理）**：

```java
@Service
public class RecommendService {

    @Autowired private FeatureService featureService;
    @Autowired private ModelClient modelClient;

    /**
     * 推荐：召回 → 特征查询 → 模型预测 → 排序
     */
    public List<RecommendItem> recommend(Long userId, List<Long> candidateItems) {
        // 1. 查询用户特征
        Map<String, Object> userFeatures = featureService.getFeatures(
            "user", userId, getUserFeatureNames());

        // 2. 批量查询商品特征
        Map<Long, Map<String, Object>> itemFeatures = new HashMap<>();
        for (Long itemId : candidateItems) {
            itemFeatures.put(itemId, featureService.getFeatures(
                "item", itemId, getItemFeatureNames()));
        }

        // 3. 组装模型输入（用户特征 + 商品特征 + 交叉特征）
        List<ModelInput> inputs = candidateItems.stream()
            .map(itemId -> assembleInput(userId, itemId,
                userFeatures, itemFeatures.get(itemId)))
            .collect(Collectors.toList());

        // 4. 批量调模型预测（gRPC，GPU 推理）
        List<Prediction> predictions = modelClient.batchPredict(inputs);

        // 5. 排序
        return sortAndReturn(predictions, candidateItems);
    }

    private ModelInput assembleInput(Long userId, Long itemId,
            Map<String, Object> userFeat, Map<String, Object> itemFeat) {
        ModelInput input = new ModelInput();
        input.setUserFeatures(userFeat);
        input.setItemFeatures(itemFeat);
        // 交叉特征（用户-商品交互）
        input.addCrossFeature("user_item_match",
            calcMatchScore(userFeat, itemFeat));
        return input;
    }
}
```

## 四、机制层：特征对账与一致性保障

**特征对账服务**：

```java
@Service
public class FeatureReconciliationService {

    /**
     * 对账：同一 entity 同一时间点，离线特征值 vs 在线特征值
     */
    @Scheduled(cron = "0 0 * * * ?")   // 每小时跑一次
    public void reconcile() {
        List<FeatureSpec> realtimeFeatures = featureMetaRepo.findRealtimeFeatures();

        for (FeatureSpec spec : realtimeFeatures) {
            // 抽样 1000 个 entity
            List<Long> sampleEntities = entityRepo.sample(spec.getEntityType(), 1000);

            int mismatchCount = 0;
            for (Long entityId : sampleEntities) {
                // 离线值（从特征仓库查）
                Object offlineValue = offlineFeatureStore.get(
                    spec.getName(), entityId, LocalDateTime.now());

                // 在线值（从 Redis 查）
                Object onlineValue = redis.opsForValue().get(
                    "feature:" + spec.getEntityType() + ":" + entityId + ":" + spec.getName());

                // 比对（允许微小误差，如浮点数）
                if (!isConsistent(offlineValue, onlineValue, spec)) {
                    mismatchCount++;
                    log.warn("特征不一致 {} entity={} offline={} online={}",
                        spec.getName(), entityId, offlineValue, onlineValue);
                }
            }

            double consistencyRate = 1.0 - (double) mismatchCount / sampleEntities.size();
            monitor.record("feature_consistency_rate", spec.getName(), consistencyRate);

            // 一致性 < 99% 告警
            if (consistencyRate < 0.99) {
                alertService.send("特征一致性告警",
                    spec.getName() + " 一致性 " + consistencyRate);
            }
        }
    }

    private boolean isConsistent(Object offline, Object online, FeatureSpec spec) {
        if (offline == null && online == null) return true;
        if (offline == null || online == null) return false;

        if (offline instanceof Number && online instanceof Number) {
            double diff = Math.abs(
                ((Number) offline).doubleValue() - ((Number) online).doubleValue());
            // 允许 1% 误差（浮点精度）
            return diff / Math.max(((Number) offline).doubleValue(), 1.0) < 0.01;
        }
        return offline.equals(online);
    }
}
```

## 五、底层本质：特征一致性的本质是"训练预测同构"

回到第一性：**特征一致性的本质是"保证模型在训练时看到的特征分布和预测时一致"**。

- **训练预测同构**：模型是一张"特征→预测"的映射表。训练时学的是"某组特征值→某标签"，预测时必须用同口径特征值才能复现学到的模式。口径不一致（同 entity 特征值不同），模型预测就错。这像"用错字典翻译"——训练用英汉词典，预测用汉英词典，结果驴唇不对马嘴。
- **离线在线同源**：统一特征平台从一份 DSL 生成离线 Spark 和在线 Flink 代码，从源头保证口径一致。这是"单一真理源"——特征定义只有一份，离线在线都基于它生成，不可能不一致。
- **对账是兜底**：即使 DSL 统一，实现细节（Spark 和 Flink 的算子语义微差）可能引入不一致。对账是"事后验证"——抽样比对离线在线值，发现差异即修复。这是"信任但验证"。
- **特征是模型的血液**：模型本身可以复现（公开算法），但特征是"数据工程"的产物，每个公司不同。特征一致性是推荐系统的核心竞争力——不是模型多先进，而是特征多准确。这是"数据 > 模型"的体现。

**实时特征的挑战是"新鲜度 vs 延迟"**：实时特征（如"最近 5 分钟点击数"）新鲜度高（反映用户当下兴趣），但实时计算有延迟（Flink 处理 + Redis 写入），可能和"理论值"有偏差。解法是"近似但一致"——实时特征允许和理论值有小误差，但离线训练也要用同样的"近似口径"，保证训练预测一致。

**特征版本管理的本质是"可复现"**：特征定义会变（改窗口、改聚合），模型训练必须锁定特定版本的特征，否则无法复现。新特征上线（v2）不影响旧模型（用 v1），新模型训练用 v2。这像"软件版本管理"——特征是"数据维度的代码"，也要版本化。

## 六、AI 架构师加问：5 个

1. **用大模型（LLM）生成特征，怎么做？**
   LLM 理解业务语义，自动生成特征建议——如分析用户行为，LLM 建议"深夜浏览者特征"（晚上 11 点后活跃用户）。但 LLM 生成的特征需人工验证（是否有效、是否一致）。京东实践：LLM 辅助特征发现，特征数量提升 30%。

2. **AI 自动检测特征漂移（分布变化），怎么做？**
   AI 监控特征分布——训练时特征的分布（均值/方差/分位数），在线预测时的分布，两者偏离（PSI > 0.2）告警。漂移可能因数据问题（采集异常）或业务变化（用户行为变）。AI 定位根因并触发模型重训。

3. **用向量数据库做特征存储，怎么做？**
   高维稠密特征（如 Embedding）用向量库存（Milvus/FAISS），支持近邻查询。但传统特征（计数/统计值）用 Redis/MySQL。混合存储——结构化特征 Redis，向量特征 Milvus，模型预测时分别取合并。

4. **AI 做特征选择（剔除无效特征），怎么做？**
   AI 评估特征重要性——模型训练输出特征权重（XGBoost feature_importance），低权重特征剔除。或用 SHAP 值（特征对预测的贡献），负贡献特征剔除。京东实践：特征从 1000 个精简到 200 个，模型效果不变，延迟降低 5 倍。

5. **AI 做特征实时回填（新特征补历史），怎么做？**
   新特征上线需历史数据训练。AI 自动生成回填作业——从事件流回算历史特征值，写入特征仓库。复杂特征（涉及多事件关联）AI 优化回填算法（增量计算，避免全量重算）。京东实践：新特征回填从天级优化到小时级。

## 七、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"统一特征平台 DSL、离线在线同源生成、特征对账兜底、Redis 低延迟查询"**。

- **一致性陷阱**：离线训练特征口径 vs 在线预测口径不一致，模型效果崩
- **统一平台**：DSL 定义特征，自动生成 Spark（离线）+ Flink（在线），同源保证一致
- **在线服务**：Redis 存特征，MGET 批量查询，< 10ms
- **特征对账**：抽样比对离线/在线值，差异率 < 0.1%，一致性 > 99%
- **特征版本**：模型训练锁定版本，特征变更不影响线上模型

### 面试现场 60 秒回答

> 推荐系统最大难题是特征一致性——模型离线训练 AUC 0.8，上线 0.6，根因是离线训练和在线预测的特征口径不一致。离线用 Spark 算"近30天点击数"（时间窗口含边界），在线用 Flink 算（窗口不含边界），同 entity 特征值不同，模型预测错。解法是统一特征平台——特征用 DSL 声明式定义（名称/聚合/窗口/过滤条件），平台从一份 DSL 自动生成离线 Spark SQL 和在线 Flink 代码，从源头保证同口径。在线预测时特征从 Redis 查询（MGET 批量，< 10ms），缺失按需实时算（降级）。特征对账兜底——每小时抽样 1000 个 entity，比对离线值（特征仓库）和在线值（Redis），一致性率 > 99%，低于则告警。特征版本管理——特征变更版本化（v1/v2），模型训练锁定版本，新特征不影响旧模型。特征存储分层——结构化特征 Redis（低延迟），向量特征 Milvus（近邻查询），模型预测分别取合并。监控 feature_consistency_rate（一致性率，> 99%）、feature_query_rt（查询延迟，< 10ms）、feature_missing_rate（缺失率，< 1%）。最关键的是"训练预测同构——同一份 DSL 生成离线在线代码"，这是特征一致性的根本保障。

## 八、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不直接用同一套代码算离线在线特征（要两套）？ | 离线全量批处理（Spark，算历史），在线实时流处理（Flink，算当下），技术栈不同。且离线可慢（小时级），在线必须快（毫秒级）。用 feature_consistency_rate（一致性率）和 latency（延迟）量化，统一 DSL 保证口径，不同引擎保证性能 |
| 证据追问 | 怎么证明特征一致（不是自欺欺人）？ | 对账（抽样离线在线比对，差异率 < 0.1%）+ 端到端 A/B（一致特征 vs 不一致特征，比模型效果）+ 线上监控（模型 AUC/CVR 稳定，不骤降）。监控 feature_consistency_rate（> 99%）和 model_auc_drift（AUC 漂移，应 < 5%） |
| 边界追问 | 统一 DSL 能描述所有特征吗？ | 不能。极复杂特征（如"用户聚类标签"，需离线 ML 模型）DSL 难表达，需自定义代码。这类特征单独管理，但对账仍需覆盖 |
| 反例追问 | 什么场景不需要特征一致性（离线在线可不同）？ | 探索性分析（offline only，不在线预测）、冷启动（新特征无在线数据，先用离线）。但生产推荐必须一致 |
| 风险追问 | 特征平台最大风险？ | 主动点出：DSL bug（生成的代码有错，离线在线都错但一致——更危险）、对账漏报（抽样没覆盖问题 entity）、特征漂移（数据分布变化，特征失效）、Redis 故障（在线特征不可查）。靠 DSL 测试 + 全量对账 + 漂移检测 + 降级方案 |
| 验证追问 | 怎么验证特征对账有效（不是漏报）？ | 注入测试（故意制造不一致，验证对账能发现）+ 全量对账（不只抽样，定期跑全量）+ 多维度对账（不同 entity 类型/时间点）。监控 reconciliation_coverage（对账覆盖率，应 100%）和 false_negative（漏报，应 0） |
| 沉淀追问 | 特征平台沉淀什么？ | DSL 引擎、Spark/Flink 代码生成器、特征存储（Redis/Milvus）、对账框架、特征监控大盘（一致性率/查询延迟/缺失率/漂移检测） |

### 现场对话示例

**面试官**：模型上线后发现 AUC 从离线 0.8 降到在线 0.65，怎么排查是特征不一致？

**候选人**：系统化排查。第一步，确认是否特征问题——导出在线预测时的实际特征值（日志），用这些值跑离线模型，看预测是否和在线一致。如果离线用在线特征值跑出 AUC 0.65，说明特征不一致；如果离线用在线特征值还是 0.8，说明模型部署有问题（模型参数不一致）。第二步，定位不一致特征——逐个特征比对离线训练时的特征分布和在线预测时的分布，PSI（Population Stability Index）> 0.2 的特征是嫌疑。第三步，根因分析——对嫌疑特征，抽样具体 entity，查离线 Spark 算的值和在线 Flink 算的值，找差异。常见根因：时间窗口边界（离线含 T，在线不含 T）、过滤条件不同（离线过滤了 status=fail，在线没过滤）、聚合方式不同（离线 COUNT DISTINCT，在线 COUNT）。第四步，修复——统一 DSL，重新生成离线在线代码，重新训练模型。第五步，预防——加强特征对账（从抽样改全量），加特征一致性自动化测试（每次特征变更跑对账）。京东实践：模型上线有"特征一致性校验"门禁，不一致不让上线。监控 model_auc_online vs model_auc_offline，差异 > 10% 告警。

**面试官**：实时特征（如"最近5分钟点击数"）Redis 查询延迟 50ms（超 SLA 10ms），怎么优化？

**候选人**：Redis 查询慢通常因数据量大或网络。优化措施——第一，Key 设计优化（feature:user:123:click_5min，Hash Tag 保证同 entity 同分片，批量 MGET 走同分片）；第二，Pipeline（批量命令一次发送，减少网络往返）；第三，本地缓存（Caffeine 缓存热点用户特征，TTL 1 分钟，Redis 兜底）；第四，特征预取（用户进入推荐页时预取特征，预测时直接用）；第五，Redis 集群分片（按 entity hash 分散，避免热点）。京东实践：特征查询从 50ms 优化到 3ms（Pipeline + 本地缓存 + 集群分片），支撑 10 万 QPS 推荐。监控 feature_query_p99（查询延迟，< 10ms）和 redis_hit_rate（命中率，> 95%）。极端情况 Redis 挂——降级到按需实时算（慢但保可用）或用默认特征（牺牲效果保可用）。

**面试官**：新特征上线（如"用户近期搜索词偏好"），怎么验证有效再全量？

**候选人**：四步验证。第一步，离线评估——新特征加入模型训练，看 AUC/NDCG 是否提升（对比 baseline）。提升显著（AUC +0.01）进入下一步；不显著可能特征无效或工程问题。第二步，特征重要性——模型输出特征重要性，新特征排名靠前（TOP 20%）说明有用；排名垫底可能无效。第三步，在线 A/B——灰度 10% 流量用新特征模型，90% 用旧模型，对比 CTR/CVR/GMV。统计显著性检验（p < 0.05），新模型显著更优则扩大灰度。第四步，全量——50% → 100%，持续监控。每步都有回滚预案（新特征效果差可关闭）。京东实践：新特征上线有"灰度平台"，自动分流 + 自动统计 + 自动决策（显著优扩量，显著差回滚）。监控 feature_ab_lift（A/B 提升幅度）和 feature_rollout_rate（灰度比例）。

## 常见考点

1. **特征工程和特征平台的区别？**——特征工程是"设计特征"（业务理解，如"用户价格敏感度"），特征平台是"工程实现"（特征计算/存储/服务/一致性）。前者是数据科学，后者是工程。
2. **离线特征和实时特征的区别？**——离线特征用批处理（Spark，历史全量，延迟小时级），实时特征用流处理（Flink，增量，延迟秒级）。实时特征新鲜但计算成本高。
3. **怎么做特征重要性分析？**——模型内置（XGBoost feature_importance）、SHAP 值（特征贡献）、Permutation Importance（打乱特征看效果下降）。低重要性特征剔除（降维）。
4. **特征存储选型？**——低延迟查询 Redis（KV 特征）、向量近邻 Milvus（Embedding）、离线仓库 Hive/Parquet（训练）、特征平台 Feast（统一管理）。

## 结构化回答

**30 秒电梯演讲：** 推荐系统的核心难题不是模型（模型公开可复现），而是特征一致性——离线训练用的特征和在线预测用的特征必须完全一致，否则模型在线效果崩。一致性陷阱：离线用历史全量数据算特征（如近 30 天点击数），在线用实时流算（同一特征但数据窗口/计算逻辑微妙不同），导致离线训练的模型在线预测时特征值偏移，模型效果骤降。架构核心是统一特征平台 + 在线离线特征对齐

**展开框架：**
1. **特征一致性陷阱** — 离线训练 vs 在线预测，特征口径不一致导致模型失效
2. **统一特征平台** — 特征定义一次，离线/在线生成（DSL → Spark/Flink 代码）
3. **在线特征服务** — 低延迟查询（Redis/特征存储），模型预测时实时取特征

**收尾：** 以上是我的整体思路。您想继续深入聊——实时特征怎么低延迟查询？


## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：推荐系统在线服务与特征一致性 | "这题核心是——推荐系统的核心难题不是模型（模型公开可复现），而是特征一致性——离线训练用的特征和在线预测用的特……" | 开场钩子 |
| 0:15 | 像培训销售。培训时（离线训练）用去年的市场数类比图 | "打个比方：像培训销售。培训时（离线训练）用去年的市场数。" | 核心类比 |
| 0:40 | 特征一致性陷阱示意/对比图 | "离线训练 vs 在线预测，特征口径不一致导致模型失效" | 特征一致性陷阱要点 |
| 1:05 | 统一特征平台示意/对比图 | "特征定义一次，离线/在线生成（DSL → Spark/Flink 代码）" | 统一特征平台要点 |
| 1:30 | 在线特征服务示意/对比图 | "低延迟查询（Redis/特征存储），模型预测时实时取特征" | 在线特征服务要点 |
| 1:55 | 总结卡 | "记住：特征一致性。下期见。" | 收尾 |
