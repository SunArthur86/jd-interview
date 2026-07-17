---
id: java-architect-172
difficulty: L2
category: java-architect
subcategory: 实验平台
tags:
- Java 架构师
- 实验平台
- 分流
- 归因
feynman:
  essence: 增长实验平台的本质是"用分流哈希把用户分桶、用互斥域避免干扰、用统计显著性归因"。分流是 userId 哈希到 [0,100) 的桶，实验组对照组各占 N%。互斥域避免多个实验互相干扰（A 实验改 UI、B 实验也改 UI 会污染）。归因用假设检验（p-value < 0.05 才可信）+ 增量计算（实验组转化率 - 对照组）。
  analogy: 像医学临床试验——病人随机分组（分流）、不同药物试验不能混（互斥域）、统计显著性才能下结论（p-value）。不能"试了 3 个人有效就说有效"。
  first_principle: 增长决策不能靠直觉（"我觉得这个 UI 好"），必须用数据驱动。实验平台让"假设 → 验证 → 决策"可量化：假设新按钮提升转化，分流 5% 流量跑一周，统计显著性通过则全量。
  key_points:
  - 分流哈希：userId + 实验层 hash 到 [0,100)，保证同一用户始终同一桶
  - 正交分层：layer_1 做 UI 实验、layer_2 做推荐实验，互不干扰
  - 互斥域：同 layer 内多个实验互斥（同一用户只能进一个实验）
  - 归因指标：增量（实验组-对照组）、p-value（显著性）、置信区间
  - SRM 检查：Sample Ratio Mismatch（分流比例异常，如配置 50/50 实际 48/52）
first_principle:
  problem: 如何让多个增长实验同时运行而不互相干扰，且实验结果可统计归因（因果关系而非相关性）？
  axioms:
  - 用户分流必须稳定（同一用户每次访问进同一实验组）
  - 多个实验可能互相干扰（A 改 UI、B 改算法，效果叠加无法归因）
  - 实验结果可能有随机波动（小样本时噪音大），必须统计显著性检验
  - 分流比例必须精确（配 5% 不能实际分到 6%）
  rebuild: 正交分层分流——每层（layer）用 userId+layerId 哈希独立分桶，层间正交（互不影响），层内互斥（同用户只进一个实验）。归因用 T 检验算 p-value（< 0.05 显著）+ 增量百分比。SRM 检查（卡方检验）发现分流异常。
follow_up:
  - 分流哈希为什么要带 layerId？——保证层间正交。只用 userId 哈希的话，不同层的分桶结果相关（同用户在所有层都进桶 1）。加 layerId 后每层独立哈希，用户在 layer_1 进桶 1 在 layer_2 可能进桶 2。
  - 实验要多大样本？——按效果大小算。检测 1% 提升需要更大样本，检测 10% 提升小样本即可。用功效分析（power analysis）算最小样本量。
  - 实验跑多久？——至少一个完整周期（7 天覆盖周一到周日），避免工作日/周末偏差。长期实验要考虑 novelty effect（新鲜感退去效果衰减）。
  - SRM 怎么检测？——卡方检验。配置 50/50 但实际 48/52，卡方值超阈值说明分流异常（可能有 bug 或某个浏览器不兼容导致用户被过滤）。
  - 互斥和正交区别？——互斥是同层内只能进一个实验（UI 实验 A 和 B 不能同时做）；正交是不同层独立（UI 实验和推荐实验可同时进行）。
memory_points:
  - 分流：hash(userId + layerId) % 100 → 桶号，稳定且正交
  - 正交分层：层间独立（UI 层 + 推荐层），层内互斥（同用户一个实验）
  - 归因：增量（实验组-对照组）+ p-value < 0.05（显著性）
  - SRM 检查：卡方检验发现分流比例异常
  - 样本量：power analysis 算最小样本，至少跑 7 天
---

# 【Java 后端架构师】增长实验平台的分流、互斥与归因

> 适用场景：JD 核心技术。推荐团队想验证"新的推荐算法是否提升 CTR"，UI 团队想验证"新版商品卡片是否提升转化率"。两个实验同时跑，怎么保证不互相干扰？结果怎么统计才可信？架构师要设计的是一套"正交分流 + 互斥控制 + 统计归因"的实验平台。

## 一、概念层：正交分层分流模型

```
用户 userId = "user_888"

Layer 1（UI 层，正交于其他层）：
  hash("user_888" + "UI_LAYER") % 100 = 37
  实验 A（新版卡片）覆盖 [0, 5)    → 桶 37 不命中，进默认组
  实验 B（新版导航）覆盖 [5, 10)   → 桶 37 不命中

Layer 2（推荐层，正交于 UI 层）：
  hash("user_888" + "REC_LAYER") % 100 = 72    ← 不同 hash 结果
  实验 C（新算法）覆盖 [0, 10)     → 桶 72 不命中
  实验 D（多样性增强）覆盖 [70, 80) → 桶 72 命中！进实验组

Layer 3（营销层）：
  hash("user_888" + "MKT_LAYER") % 100 = 15
  ...独立分桶

结果：user_888 在 UI 层进默认组、推荐层进实验 D、营销层独立分桶
     三层互不干扰（正交），同层只进一个实验（互斥）
```

## 二、机制层：分流实现

```java
@Service
public class ExperimentRouter {

    private final ExperimentConfigService configService;

    /**
     * 分流：决定用户在每个层进入哪个实验组
     */
    public ExperimentAssignment assign(String userId) {
        ExperimentAssignment assignment = new ExperimentAssignment();
        List<Layer> layers = configService.getActiveLayers();

        for (Layer layer : layers) {
            // 每层独立哈希（保证层间正交）
            int bucket = hashBucket(userId, layer.getId());
            Experiment experiment = findExperiment(layer, bucket);

            if (experiment != null) {
                // 层内互斥：同一用户在层内只进一个实验
                String group = assignGroup(userId, experiment);
                assignment.add(layer.getId(), experiment.getId(), group);
            } else {
                assignment.add(layer.getId(), "default", "control");
            }
        }
        return assignment;
    }

    /**
     * 哈希分桶：MurmurHash3（分布均匀）+ 取模
     */
    private int hashBucket(String userId, String layerId) {
        String key = userId + ":" + layerId;
        return Math.abs(MurmurHash3.hash(key)) % 100;
    }

    /**
     * 组分配：实验组 vs 对照组
     */
    private String assignGroup(String userId, Experiment exp) {
        // 用不同 hash 决定组（实验组/对照组）
        int groupBucket = Math.abs(
            MurmurHash3.hash(userId + ":" + exp.getId() + ":group")) % 100;
        if (groupBucket < exp.getTreatmentPercent()) {
            return "treatment";          // 实验组
        }
        return "control";                // 对照组
    }
}
```

## 三、机制层：实验配置模型

```java
@Data
public class Layer {
    private String id;                  // "UI_LAYER"
    private String name;
    private String description;
}

@Data
public class Experiment {
    private String id;                  // "exp_card_v2"
    private String layerId;
    private String name;
    private int bucketStart;            // [0, 5) 覆盖桶 0-4
    private int bucketEnd;              // 5
    private int treatmentPercent;       // 实验组比例 50（组内再分实验/对照）
    private String status;              // DRAFT / RUNNING / STOPPED
    private LocalDate startDate;
    private LocalDate endDate;
    private List<Metric> targetMetrics; // 关注指标（CTR/转化率/GMV）
}
```

## 四、机制层：归因与统计检验

```java
@Service
public class ExperimentAnalyzer {

    /**
     * 分析实验结果：增量 + 显著性 + 置信区间
     */
    public AnalysisReport analyze(String experimentId) {
        // 1. 拉取实验组和对照组的指标数据
        MetricData treatment = metricRepo.findByExperiment(experimentId, "treatment");
        MetricData control = metricRepo.findByExperiment(experimentId, "control");

        // 2. SRM 检查（样本比例偏差）
        double expectedRatio = 0.5;
        double actualRatio = (double) treatment.getSampleSize()
            / (treatment.getSampleSize() + control.getSampleSize());
        double chiSquare = calcChiSquare(treatment.getSampleSize(),
            control.getSampleSize(), expectedRatio);
        boolean srmViolation = chiSquare > 3.84;   // p < 0.05
        if (srmViolation) {
            log.warn("SRM 异常！配置 50/50 实际 {}", actualRatio);
        }

        // 3. 增量计算
        double treatmentMean = treatment.getConversionRate();   // 0.12
        double controlMean = control.getConversionRate();       // 0.10
        double lift = (treatmentMean - controlMean) / controlMean;  // +20%

        // 4. T 检验（显著性）
        double pValue = tTest(treatment.getSamples(), control.getSamples());
        boolean significant = pValue < 0.05;

        // 5. 置信区间
        double[] ci = confidenceInterval(treatment, control, 0.95);

        return AnalysisReport.builder()
            .treatmentRate(treatmentMean)
            .controlRate(controlMean)
            .liftPercent(lift * 100)
            .pValue(pValue)
            .significant(significant)
            .confidenceInterval(ci)
            .srmViolation(srmViolation)
            .sampleSize(treatment.getSampleSize() + control.getSampleSize())
            .recommendation(decideRecommendation(significant, lift, srmViolation))
            .build();
    }

    private String decideRecommendation(boolean sig, double lift, boolean srm) {
        if (srm) return "SRM 异常，数据不可信，需排查";
        if (sig && lift > 0) return "全量上线（显著正向）";
        if (sig && lift < 0) return "停止（显著负向）";
        return "继续观察（不显著）";
    }
}
```

## 五、机制层：指标上报与分流日志

```java
@Service
public class ExperimentLogger {

    /**
     * 每次 API 请求带分流信息，落日志供离线归因
     */
    public void logExposure(String userId, String experimentId, String group) {
        // 落到大数据（Kafka → 数仓），离线 JOIN 业务指标算增量
        logJson.writeObject(LogEvent.builder()
            .userId(userId)
            .experimentId(experimentId)
            .group(group)
            .timestamp(System.currentTimeMillis())
            .build());
    }
}

// 业务埋点带分流信息
// { event: "click_product", userId: "888",
//   experiments: {"REC_LAYER": "exp_new_algo: treatment"} }
// 离线按 experimentId + group 分组算 CTR/转化率
```

## 六、底层本质：因果推断而非相关分析

实验平台的本质是"建立因果关系"——新算法 X 导致了转化率提升 Y。相关性分析（看数据发现 X 和 Y 相关）无法排除混杂因素（可能是周末效应、可能是其他实验干扰）。A/B 实验通过随机分流控制了混杂因素，使得"实验组和对照组的唯一差异就是实验变量"，从而建立因果。

**正交分层的数学基础**：如果只用 userId 哈希，不同实验的分桶结果会高度相关（同用户在所有实验都进同一桶）。加入 layerId 后，每层独立哈希，桶分布相互独立（正交）。这保证了 UI 层实验和推荐层实验的效果可以独立归因，不互相污染。

**SRM 的本质**：分流配置 50/50 但实际样本比例偏离（如 48/52），说明分流过程有 bug 或偏差（某个浏览器版本的用户被过滤）。SRM 下所有归因都不可信，必须先修分流 bug。

**统计显著性的意义**：p-value < 0.05 表示"如果实验无效，观察到这个增量（或更极端）的概率 < 5%"。低 p-value 让我们有信心拒绝"实验无效"的零假设。但 p-value 不等于效果大小（小样本可能 p-value 显著但增量微小无业务价值）。

## 七、AI 工程化深挖

1. **AI 怎么辅助实验设计？**
   LLM 根据业务目标（提升 CTR）推荐实验变量（改卡片布局/改文案/改推荐算法）和指标。但实验设计要人审核——AI 可能推荐不可行的方案。监控 experiment_success_rate（实验正向比例）。

2. **怎么用 AI 做实验结果解读？**
   实验报告是数据（增量/p-value/置信区间），LLM 翻译成业务语言（"新算法使 CTR 提升 20%，统计显著，建议全量"）。但要标注数据来源和置信度，不能 LLM 自由发挥。

3. **多变量实验（MVT）怎么分析？**
   同时改 UI + 算法 + 文案，传统 A/B 分析不了交互效应。AI 可用（方差分析 ANOVA 或机器学习模型分解各因素贡献）。但 MVT 样本量指数增长（3 因素 × 2 水平 = 8 组），通常拆成多个独立 A/B。

4. **实验平台怎么做实时分流？**
   分流配置存配置中心（Apollo/Nacos），网关实时读取。用户请求带 userId，网关按配置分流。配置变更（实验停止/启动）秒级生效。分流结果写请求 header 透传到下游。

5. **怎么防止实验干扰生产系统？**
   实验组的代码路径要和对照组隔离（feature flag 控制）。实验组出 bug 不能影响对照组。实验配置支持"紧急停止"（一键把所有用户切回对照组）。监控实验组 error_rate。

## 八、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"正交分层、互斥域、p-value、SRM 检查"** 四个词。

- **正交分层**：layerId 独立哈希，层间正交不干扰
- **互斥域**：同层内同用户只进一个实验
- **p-value**：< 0.05 统计显著，增量（实验组-对照组）/ 对照组
- **SRM 检查**：卡方检验发现分流比例异常

### 面试现场 60 秒回答

> 实验平台用正交分层分流模型。每层用 hash(userId + layerId) % 100 独立分桶——加 layerId 保证层间正交（UI 层和推荐层互不干扰），同层内多个实验覆盖不同桶段实现互斥（同用户只进一个实验）。实验组/对照组用 group hash 再分。分流配置存配置中心，网关实时读取，配置变更秒级生效，分流结果写 header 透传。归因三步：增量（实验组转化率 - 对照组）/ 对照组，T 检验算 p-value < 0.05 为显著，95% 置信区间。SRM 检查用卡方检验——配置 50/50 但实际偏差超阈值说明分流 bug，数据不可信。样本量用 power analysis 算最小值，至少跑 7 天覆盖周一到周日。监控 experiment_count、srm_violation_rate、significant_rate。实验组代码用 feature flag 隔离，出 bug 一键切回对照组。

## 常见考点

1. **正交和互斥区别？**——正交是不同层独立（UI 实验和推荐实验可同时跑）；互斥是同层内只能进一个实验（两个 UI 实验不能同时做）。正交靠 layerId 哈希，互斥靠桶段不重叠。
2. **SRM 怎么检测？**——卡方检验。配置 50/50 实际 48/52，卡方值 > 3.84（p<0.05）判定异常。SRM 下归因不可信。
3. **实验跑多久？**——至少 7 天（覆盖工作日/周末周期）。长期实验要注意 novelty effect（新鲜感退去效果衰减）和 seasonality（季节性波动）。
4. **p-value 显著但增量小怎么办？**——p-value 显著只说明"效果存在"，不说明"效果大"。增量 0.1% 即使显著也无业务价值。要看业务意义（GMV 提升是否覆盖开发成本）。

## 结构化回答

**30 秒电梯演讲：** 增长实验平台的本质是用分流哈希把用户分桶、用互斥域避免干扰、用统计显著性归因。分流是 userId 哈希到 [0,100) 的桶，实验组对照组各占 N%。互斥域避免多个实验互相干扰（A 实验改 UI、B 实验也改 UI 会污染）。归因用假设检验（p-value < 0.05 才可信）+ 增量计算（实验组转化率 - 对照组）

**展开框架：**
1. **分流哈希** — userId + 实验层 hash 到 [0,100)，保证同一用户始终同一桶
2. **正交分层** — layer_1 做 UI 实验、layer_2 做推荐实验，互不干扰
3. **互斥域** — 同 layer 内多个实验互斥（同一用户只能进一个实验）

**收尾：** 以上是我的整体思路。您想继续深入聊——分流哈希为什么要带 layerId？


## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：增长实验平台的分流、互斥与归因 | "这题一句话：增长实验平台的本质是用分流哈希把用户分桶、用互斥域避免干扰、用统计显著性归因。" | 开场钩子 |
| 0:15 | 分流哈希示意/对比图 | "userId + 实验层 hash 到 [0,100)，保证同一用户始终同一桶" | 分流哈希要点 |
| 0:40 | 正交分层示意/对比图 | "layer_1 做 UI 实验、layer_2 做推荐实验，互不干扰" | 正交分层要点 |
| 1:25 | 总结卡 | "记住：分流。下期见。" | 收尾 |
