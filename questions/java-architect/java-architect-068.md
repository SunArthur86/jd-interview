---
id: java-architect-068
difficulty: L2
category: java-architect
subcategory: 决策引擎设计
tags:
- Java 架构师
- 风控
- 规则引擎
- 决策流
- 编排
feynman:
  essence: 风控决策引擎是"根据用户行为判断是否放行"的大脑。用户下单/领券/提现时，引擎综合多维数据（用户画像/设备/行为/历史）做决策：PASS（放行）/CHALLENGE（人机验证）/REJECT（拒绝）。核心挑战是"规则多且组合复杂（反欺诈/防刷/限额）+ 决策要快（< 50ms）+ 可解释（为什么拒绝）"。解法是"决策流编排 + 规则引擎 + 模型评分"——规则用 DSL 配置（规则链），模型给风险评分，决策流编排两者的执行顺序。
  analogy: 像机场入境审查。旅客到柜台（用户请求）→ 边检官查护照（基础规则：身份合法？）→ 查签证（规则：签证有效？）→ 查黑名单（规则：在通缉名单？）→ 查行为可疑（模型：行李/神态可疑？）→ 决策：放行/盘问/拒绝。每步规则独立，组合成"决策流"。风控引擎一样——多维数据 + 规则 + 模型，决策流编排。
  first_principle: 为什么不用 if-else 硬编码风控规则？因为规则多（几百条）、变化频繁（新欺诈模式不断出现）、组合复杂（规则间有优先级和依赖）。硬编码改规则要发版（慢），难维护（代码膨胀），难解释（拒绝原因查不清）。解法是"规则引擎 + 决策流编排"——规则配置化（DSL），决策流可视化编排（拖拽配置），模型评分补充规则盲区。
  key_points:
  - 决策三态：PASS（放行）/ CHALLENGE（人机验证/二次确认）/ REJECT（拒绝）
  - 规则引擎：条件→动作，DSL 配置（不发版）
  - 决策流编排：规则/模型的执行顺序（串行/并行/分支）
  - 模型评分：ML 模型给风险分（补充规则的语义盲区）
  - 可解释性：每个决策有"原因链"（哪条规则/模型触发，为什么）
first_principle:
  problem: 用户请求（下单/提现），怎么在 50ms 内综合多维数据判断风险，并给出可解释的决策？
  axioms:
  - 规则多且变化频繁（反欺诈持续对抗）
  - 规则硬编码不可维护（发版慢、代码膨胀）
  - 规则有盲区（新型欺诈无规则，靠模型识别）
  - 决策要可解释（用户/合规要求说明拒绝原因）
  rebuild: 决策流编排 + 规则引擎 + 模型评分。决策流（DAG）编排执行顺序——基础规则（黑名单/限额）先行（快筛），模型评分补充（复杂欺诈），决策规则综合（风险分→决策）。规则 DSL 配置化（条件→动作），决策流可视化编排。输出决策 + 原因链（哪条规则/模型触发）。监控 decision_rt（决策延迟，< 50ms）、reject_rate（拒绝率）、false_positive_rate（误杀率）。
follow_up:
  - 规则冲突怎么处理（一条说 PASS 一条说 REJECT）？——优先级（高优先级覆盖）+ 决策矩阵（最严决策胜出，安全优先）。
  - 模型和规则怎么协同？——规则先执行（明确规则直接决策），规则不确定的用模型评分，模型分高则 REJECT。
  - 怎么做规则的灰度上线？——新规则先"观察模式"（只记录不决策），验证效果后切"拦截模式"。
  - 决策延迟怎么降？——并行执行无依赖规则、模型预评分（异步算）、缓存用户画像。
  - 风控规则怎么对抗进化（欺诈者绕规则）？——规则持续更新（新欺诈模式加规则）+ 模型泛化（识别规则未覆盖的新型）。
memory_points:
  - 决策三态：PASS/CHALLENGE/REJECT
  - 规则引擎：DSL 配置（条件→动作）
  - 决策流：DAG 编排规则/模型执行
  - 模型评分：补充规则盲区
  - 可解释：决策原因链
---

# 【Java 后端架构师】风控规则引擎与决策流编排

> 适用场景：JD 风控核心。用户下单/领券/提现/注册，系统要判断"是不是本人/是不是薅羊毛/是不是欺诈"。毫秒级决策，多维数据综合判断。核心是"决策流编排 + 规则引擎 + 模型评分"——规则处理已知风险，模型识别未知风险，决策流编排两者。

## 一、概念层：风控决策全景

**决策流架构**（面试必画）：

```
用户请求（下单/提现/领券）
       │
       ▼
┌──────────────────────────────────────────────────────────┐
│ 数据采集层（并行，< 10ms）                                 │
│  ┌─ 用户画像（注册时间/历史行为/信用分）                    │
│  ├─ 设备信息（指纹/IP/位置）                                │
│  ├─ 请求上下文（金额/频率/时段）                            │
│  └─ 外部数据（黑名单/征信）                                 │
├──────────────────────────────────────────────────────────┤
│ 规则引擎层（决策流编排，< 20ms）                            │
│                                                            │
│  ┌─ 基础规则（黑名单/限额/频率）                            │
│  │   命中 → REJECT（直接拒绝）                              │
│  │                                                         │
│  ├─ 行为规则（异常登录/异地/批量）                          │
│  │   命中 → CHALLENGE（人机验证）                           │
│  │                                                         │
│  └─ 模型评分（ML 风险模型）                                 │
│      score > 0.8 → REJECT                                  │
│      0.5 < score < 0.8 → CHALLENGE                         │
│      score < 0.5 → 继续规则                                │
│                                                            │
│  决策矩阵：多规则结果合并，最严决策胜出                      │
├──────────────────────────────────────────────────────────┤
│ 决策输出 + 原因链                                          │
│  决策：PASS / CHALLENGE / REJECT                           │
│  原因：[规则 R001 黑名单触发, 规则 R005 高频触发]            │
└──────────────────────────────────────────────────────────┘
```

**决策三态**：

| 决策 | 含义 | 处理 |
|------|------|------|
| PASS | 放行 | 正常处理（下单成功） |
| CHALLENGE | 人机验证 | 要求验证码/短信/人脸（通过则 PASS） |
| REJECT | 拒绝 | 拦截（下单失败）+ 记录 |

**规则 vs 模型**：

| 维度 | 规则 | 模型 |
|------|------|------|
| 表达 | 条件→动作（明确） | 特征→评分（隐含） |
| 可解释 | 强（"命中黑名单"） | 弱（"模型评分高"） |
| 覆盖 | 已知风险（明确模式） | 未知风险（新模式泛化） |
| 维护 | 加规则（运营配置） | 重训练（数据驱动） |
| 适用 | 简单明确的风险 | 复杂模糊的风险 |

## 二、机制层：规则引擎实现

**规则 DSL 与接口**：

```java
/**
 * 风控规则接口
 */
public interface RiskRule {
    String getRuleId();
    RulePriority getPriority();          // 优先级
    boolean enabled();                   // 是否启用
    RiskDecision evaluate(RiskContext ctx);   // 评估
}

/**
 * 规则示例：黑名单规则
 */
@Component
public class BlacklistRule implements RiskRule {

    @Autowired private BlacklistService blacklistService;

    @Override
    public String getRuleId() { return "R001_BLACKLIST"; }

    @Override
    public RulePriority getPriority() { return RulePriority.CRITICAL; }   // 最高优先级

    @Override
    public boolean enabled() { return true; }

    @Override
    public RiskDecision evaluate(RiskContext ctx) {
        // 查用户/设备/IP 是否在黑名单
        if (blacklistService.isUserBlacklisted(ctx.getUserId())) {
            return RiskDecision.reject("用户在黑名单");
        }
        if (blacklistService.isDeviceBlacklisted(ctx.getDeviceFingerprint())) {
            return RiskDecision.reject("设备在黑名单");
        }
        if (blacklistService.isIpBlacklisted(ctx.getClientIp())) {
            return RiskDecision.reject("IP 在黑名单");
        }
        return RiskDecision.pass();   // 不命中，继续其他规则
    }
}

/**
 * 规则示例：高频交易规则
 */
@Component
public class HighFrequencyRule implements RiskRule {

    @Autowired private RedisTemplate redis;

    @Override
    public String getRuleId() { return "R005_HIGH_FREQ"; }

    @Override
    public RulePriority getPriority() { return RulePriority.HIGH; }

    @Override
    public RiskDecision evaluate(RiskContext ctx) {
        // 滑动窗口计数（1 分钟内同一用户请求次数）
        String key = "risk:freq:" + ctx.getUserId() + ":" +
            Instant.now().getEpochSecond() / 60;
        Long count = redis.opsForValue().increment(key);
        redis.expire(key, Duration.ofMinutes(2));

        if (count > 10) {
            return RiskDecision.challenge("高频请求，需验证");
        }
        return RiskDecision.pass();
    }
}
```

## 三、机制层：决策流编排

**决策流引擎**：

```java
@Service
public class DecisionEngine {

    @Autowired private List<RiskRule> rules;
    @Autowired private RiskModelClient modelClient;

    /**
     * 风控决策：规则 + 模型 + 决策矩阵
     */
    public RiskResult decide(RiskRequest request) {
        long start = System.currentTimeMillis();

        // 1. 构建上下文（并行采集数据）
        RiskContext ctx = buildContext(request);

        // 2. 执行规则链（按优先级）
        List<RiskDecision> decisions = new ArrayList<>();
        List<String> reasons = new ArrayList<>();

        List<RiskRule> sortedRules = rules.stream()
            .filter(RiskRule::enabled)
            .sorted(Comparator.comparing(r -> r.getPriority().getWeight()))
            .collect(Collectors.toList());

        for (RiskRule rule : sortedRules) {
            RiskDecision decision = rule.evaluate(ctx);
            if (decision.getAction() != Action.PASS) {
                decisions.add(decision);
                reasons.add(rule.getRuleId() + ": " + decision.getReason());
            }
        }

        // 3. 模型评分（规则不确定时补充）
        if (decisions.isEmpty() || hasOnlyPass(decisions)) {
            double score = modelClient.predict(ctx);
            if (score > 0.8) {
                decisions.add(RiskDecision.reject("模型评分过高：" + score));
                reasons.add("MODEL: score=" + score);
            } else if (score > 0.5) {
                decisions.add(RiskDecision.challenge("模型评分中等：" + score));
                reasons.add("MODEL: score=" + score);
            }
        }

        // 4. 决策矩阵：合并多规则结果，最严决策胜出
        RiskDecision finalDecision = mergeDecisions(decisions);

        // 5. 输出决策 + 原因链
        RiskResult result = RiskResult.builder()
            .decision(finalDecision.getAction())
            .reasons(reasons)
            .score(ctx.getModelScore())
            .rt(System.currentTimeMillis() - start)
            .build();

        // 6. 记录决策日志（审计）
        decisionLogService.log(request, result);

        monitor.record("decision_rt", result.getRt());
        monitor.record("decision_action", result.getDecision());
        return result;
    }

    /**
     * 决策矩阵：最严决策胜出（REJECT > CHALLENGE > PASS）
     */
    private RiskDecision mergeDecisions(List<RiskDecision> decisions) {
        if (decisions.isEmpty()) {
            return RiskDecision.pass();
        }
        // 优先级：REJECT 最严，胜出
        if (decisions.stream().anyMatch(d -> d.getAction() == Action.REJECT)) {
            return RiskDecision.reject("命中拒绝规则");
        }
        if (decisions.stream().anyMatch(d -> d.getAction() == Action.CHALLENGE)) {
            return RiskDecision.challenge("命中挑战规则");
        }
        return RiskDecision.pass();
    }

    /**
     * 并行构建上下文（数据采集）
     */
    private RiskContext buildContext(RiskRequest request) {
        CompletableFuture<UserProfile> userFuture =
            CompletableFuture.supplyAsync(() -> profileService.get(request.getUserId()));
        CompletableFuture<DeviceInfo> deviceFuture =
            CompletableFuture.supplyAsync(() -> deviceService.get(request.getDeviceFingerprint()));
        CompletableFuture<ExternalData> extFuture =
            CompletableFuture.supplyAsync(() -> externalService.get(request.getUserId()));

        CompletableFuture.allOf(userFuture, deviceFuture, extFuture)
            .join();   // 等所有数据采集完成

        RiskContext ctx = new RiskContext();
        ctx.setRequest(request);
        ctx.setUserProfile(userFuture.join());
        ctx.setDeviceInfo(deviceFuture.join());
        ctx.setExternalData(extFuture.join());
        return ctx;
    }
}
```

## 四、机制层：规则灰度与可解释性

**规则灰度上线**：

```java
/**
 * 规则模式：观察（只记录不决策）→ 拦截（实际决策）
 */
public enum RuleMode {
    OBSERVE,    // 观察模式：命中只记录，不影响决策
    INTERCEPT   // 拦截模式：命中触发决策
}

@Service
public class RuleGrayReleaseService {

    /**
     * 新规则先观察模式上线，验证效果后切拦截
     */
    @Transactional
    public void enableRule(String ruleId, RuleMode mode) {
        ruleConfigRepo.updateMode(ruleId, mode);

        if (mode == RuleMode.OBSERVE) {
            // 观察模式：记录命中但不决策
            monitor.record("rule_observe_enabled", ruleId);
        } else {
            // 拦截模式：正式生效
            monitor.record("rule_intercept_enabled", ruleId);
        }
    }

    /**
     * 评估观察模式规则的效果（命中率/准确率）
     */
    public RuleEvaluation evaluateObservation(String ruleId, Duration period) {
        List<DecisionLog> hits = decisionLogRepo.findByRule(ruleId, period);

        // 统计：命中数 / 后续是否真违规（用后续事件验证）
        long totalHits = hits.size();
        long confirmedFraud = hits.stream()
            .filter(h -> isLaterConfirmedFraud(h))
            .count();

        double precision = (double) confirmedFraud / totalHits;

        return RuleEvaluation.builder()
            .totalHits(totalHits)
            .confirmedFraud(confirmedFraud)
            .precision(precision)
            .recommendation(precision > 0.8 ? "INTERCEPT" : "TUNE")
            .build();
    }
}
```

**可解释性（决策原因链）**：

```java
/**
 * 决策日志：完整记录决策过程，支持解释
 */
@Entity
@Table(name = "t_decision_log")
public class DecisionLog {
    private Long id;
    private String requestId;          // 请求 ID
    private Long userId;
    private String decision;           // PASS/CHALLENGE/REJECT
    private String reasonChain;        // 原因链 JSON（规则 ID + 原因）
    private Double modelScore;         // 模型评分
    private Long rtMs;                 // 决策耗时
    private LocalDateTime createdAt;
}

/**
 * 查询决策原因（客服/用户解释）
 */
@Service
public class DecisionExplainService {

    public DecisionExplanation explain(String requestId) {
        DecisionLog log = decisionLogRepo.findByRequestId(requestId);

        // 解析原因链
        List<ReasonItem> reasons = JSON.parseArray(
            log.getReasonChain(), ReasonItem.class);

        // 生成可读解释
        StringBuilder explanation = new StringBuilder();
        explanation.append("您的请求被").append(log.getDecision()).append("，原因：\n");
        for (ReasonItem r : reasons) {
            explanation.append("- ").append(humanReadable(r)).append("\n");
        }

        return DecisionExplanation.builder()
            .decision(log.getDecision())
            .reasons(reasons)
            .humanReadable(explanation.toString())
            .build();
    }

    private String humanReadable(ReasonItem r) {
        switch (r.getRuleId()) {
            case "R001_BLACKLIST": return "账户存在风险记录";
            case "R005_HIGH_FREQ": return "操作过于频繁，请稍后再试";
            case "MODEL": return "系统检测到异常风险";
            default: return r.getReason();
        }
    }
}
```

## 五、底层本质：风控的本质是"风险与体验的平衡"

回到第一性：**风控的本质是"在风险（漏判损失）和体验（误杀流失）之间找平衡"**。

- **风险代价**：漏判（放过欺诈）导致直接损失（薅羊毛/欺诈提现/恶意下单）。漏判率每降 1%，可能省百万损失。
- **体验代价**：误杀（拦截正常用户）导致用户流失/投诉。误杀率每升 1%，可能流失万用户。
- **平衡点**：根据业务风险偏好调——金融业务偏保守（高误杀换低漏判，安全优先），电商偏开放（低误杀换高转化，体验优先）。这是"风险偏好"的产品决策。
- **三态决策的意义**：不是非黑即白（PASS/REJECT），中间有 CHALLENGE（人机验证）——对"不确定"的请求，不直接拒绝（避免误杀），也不直接放行（避免漏判），而是要求二次验证（验证通过放行，验证失败拒绝）。这是"灰度处理"。

**规则 vs 模型的本质是"确定性 vs 泛化"**：规则处理"确定性风险"（黑名单明确违规），模型处理"模糊风险"（行为模式异常但无明确规则）。规则可解释（命中哪条规则），模型泛化强（识别新型风险）。两者互补——规则覆盖已知，模型覆盖未知。这是"符号主义 vs 连接主义"的 AI 哲学在风控的体现。

**决策流编排的本质是"执行计划"**：规则和模型有执行顺序——基础规则先行（快筛明显违规），模型评分补充（处理规则不确定的）。决策流（DAG）描述这个顺序，支持串行/并行/分支。这是"工作流编排"思想在风控的应用——把决策逻辑从代码剥离，可视化配置。

**灰度上线的本质是"风险可控的变更"**：新规则可能误判（误杀正常用户），直接上线风险大。观察模式（只记录不决策）先验证规则的准确率（命中后是否真违规），准确率达标（> 80%）才切拦截模式。这是"渐进式发布"——先验证再生效，降低变更风险。

## 六、AI 架构师加问：5 个

1. **用大模型（LLM）做风控决策（替代规则），怎么做？**
   LLM 理解复杂场景（如"用户行为序列是否异常"），但成本高（推理慢）+ 不可解释（黑盒）。适用场景：疑难案例（规则和传统模型都不确定的），LLM 做"二审"。京东风控探索：LLM 处理 1% 疑难案例，准确率 90%+，但主链路仍用规则+传统模型（快）。

2. **用图神经网络（GNN）识别团伙欺诈，怎么做？**
   团伙欺诈（多个账号关联作案）用 GNN 分析账号关系图（同设备/同 IP/同收货地址），识别"社区"（团伙）。比单账号规则更准——单个账号行为正常，但团伙模式异常。京东反欺诈：GNN 识别百级团伙/天。

3. **用 AI 做实时行为分析（鼠标轨迹/输入节奏），怎么做？**
   AI 分析用户操作行为（鼠标移动/打字节奏/页面停留），区分人和机器人。真人行为有"噪声"（不规则），机器人行为精确（规律）。用序列模型（RNN/Transformer）分析行为序列。

4. **AI 自适应学习（欺诈进化时自动更新），怎么做？**
   AI 监控模型效果衰减（欺诈者绕过模型），自动触发重训练（用最新数据）。或用在线学习（实时更新模型参数）。但在线学习不稳定，需和离线模型集成（保底）。

5. **用 AI 生成对抗样本（测试风控健壮性），怎么做？**
   AI 生成"欺诈样本"（模拟欺诈者绕规则），测试风控能否识别。这是"红队测试"——用 AI 攻击自己的风控，发现漏洞修补。京东安全：AI 红队测试，持续发现风控盲区。

## 七、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"决策三态 PASS CHALLENGE REJECT、规则引擎 DSL 配置、决策流编排 DAG、模型评分补盲区、灰度观察后拦截"**。

- **决策三态**：PASS（放行）/ CHALLENGE（人机验证）/ REJECT（拒绝）
- **规则引擎**：RiskRule 接口（evaluate 返回决策），DSL 配置不发版
- **决策流编排**：规则按优先级执行，模型评分补充，决策矩阵合并（最严胜出）
- **规则 vs 模型**：规则处理已知风险（可解释），模型覆盖未知风险（泛化）
- **灰度上线**：新规则先观察模式（只记录），验证准确率后切拦截模式
- **可解释**：决策原因链（哪条规则/模型触发），客服可查用户可解释

### 面试现场 60 秒回答

> 风控决策引擎核心是决策流编排 + 规则引擎 + 模型评分。决策三态——PASS（放行）、CHALLENGE（人机验证，验证码/短信/人脸）、REJECT（拒绝），不是非黑即白，灰度处理不确定请求。规则引擎——每条规则实现 RiskRule 接口（evaluate 返回决策），DSL 配置（条件→动作），运营改规则不发版。规则示例——黑名单规则（用户/设备/IP 查黑名单）、高频规则（滑动窗口计数，1 分钟 > 10 次挑战）。决策流编排——数据并行采集（用户画像/设备/外部数据），规则按优先级执行（CRITICAL/HIGH/MEDIUM），规则不确定时模型评分补充（score > 0.8 REJECT，0.5-0.8 CHALLENGE）。决策矩阵合并——多规则结果取最严（REJECT > CHALLENGE > PASS），安全优先。规则 vs 模型互补——规则处理已知风险（可解释"命中黑名单"），模型覆盖未知风险（泛化识别新型欺诈）。规则灰度上线——新规则先观察模式（只记录不决策），验证准确率（命中后是否真违规，precision > 80%）后切拦截模式。可解释性——决策日志记完整原因链（规则 ID + 原因 + 模型分），客服可查询，用户可解释"账户存在风险记录"。监控 decision_rt（决策延迟，< 50ms）、reject_rate（拒绝率）、false_positive_rate（误杀率，应 < 5%）。最关键的是"规则和模型各取所长——规则确定性可解释，模型泛化覆盖未知"。

## 八、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不全用模型（ML 端到端，不用规则）？ | 模型黑盒不可解释（用户问"为什么拒绝"答不上来），合规风险（金融要求可解释）；模型冷启动差（新场景无数据训练）。规则可解释 + 模型泛化，互补最好。用 explainability_score（可解释性）和 cold_start_performance（冷启动效果）量化 |
| 证据追问 | 怎么证明风控有效（欺诈都拦了）？ | 事后验证（被 PASS 的请求后续是否真欺诈，算漏判率）+ 外部数据（银行/支付渠道的欺诈通报）+ 人工抽检。监控 false_negative_rate（漏判率，应 < 1%）和 fraud_loss_rate（欺诈损失率） |
| 边界追问 | 风控能拦所有欺诈吗？ | 不能。新型欺诈（无规则无数据）会漏，需人工兜底 + 模型泛化；高仿真欺诈（真人操作的团伙）难识别。风控是"提高成本"非"绝对杜绝" |
| 反例追问 | 什么场景不需要风控（全放行）？ | 内部操作（员工系统，可信）、低风险动作（浏览/搜索，无资金风险）。但涉及资金/营销补贴/账号操作必须风控 |
| 风险追问 | 风控系统最大风险？ | 主动点出：规则漏判（欺诈绕过）、模型退化（数据分布变）、误杀泛滥（用户流失）、决策延迟（用户体验差）。靠规则持续更新 + 模型迭代 + 灰度验证 + 性能优化 |
| 验证追问 | 怎么验证规则正确（不误杀）？ | 观察模式验证（新规则先只记录，算 precision）+ A/B（开/关规则对比欺诈率和误杀率）+ 用户申诉分析（被拒用户的申诉，验证是否误判）。监控 rule_precision（规则准确率，应 > 80%） |
| 沉淀追问 | 风控沉淀什么？ | 规则引擎框架、决策流编排平台、模型评分服务、决策日志/可解释工具、风控监控大盘（决策延迟/拒绝率/误杀率/规则准确率） |

### 现场对话示例

**面试官**：规则越来越多（几百条），决策延迟从 50ms 涨到 200ms，怎么办？

**候选人**：规则多导致延迟，三层优化。第一层，规则分类——热规则（高频命中，如黑名单）和冷规则（低频，如特定金额规则），热规则先行（快速过滤），冷规则按需执行（热规则已 REJECT 的不跑冷规则）。第二层，并行执行——无依赖的规则并行（CompletableFuture），有依赖的串行。如黑名单和频率规则独立，并行跑；决策矩阵规则依赖前面的结果，串行。第三层，规则索引——按请求类型（下单/提现）路由到相关规则集，不是所有规则都跑。如"下单"只跑交易相关规则，不跑"提现"规则。极端优化——规则编译成决策树（像 Drools 的 RETE 算法），共享条件只算一次。京东风控：规则从 100 条增到 500 条，延迟控制在 30ms（并行 + 路由 + 决策树）。监控 decision_rt_p99（< 50ms）和 rule_execution_count（每请求执行规则数）。

**面试官**：用户投诉"我没违规但被风控拦截了"，怎么排查？

**候选人**：这是误杀场景。第一步，查决策日志——用请求 ID 查 t_decision_log，看决策（REJECT）和原因链（哪条规则触发）。第二步，验证规则——看触发规则是否合理，如"高频规则"触发，查该用户当时的请求频率（是否真的高频）。可能是误判（正常用户偶尔高频，如大促抢购）。第三步，如果是误判——调整规则（如高频阈值从 10 次/分钟调到 20 次）或加白名单（该用户豁免）。第四步，补偿用户——如果是误杀导致损失（如抢购失败），酌情补偿（优惠券）。第五步，数据回流——误杀案例加入"负样本"（规则不应拦截的正常行为），训练模型/调规则。监控 false_positive_complaint_rate（误杀投诉率，应 < 1%）。京东风控：误杀投诉 24 小时响应，根因修复 + 用户补偿，持续优化规则准确率。

**面试官**：欺诈者不断换策略绕过风控（今天用 A 策略，明天换 B），怎么对抗？

**候选人**：这是风控的"军备竞赛"，没有终局，但能持续对抗。第一层，规则快速迭代——风控分析师监控新型欺诈（通过漏判案例/外部情报），快速加规则（DSL 配置，秒级生效）。这是"被动防御"（发现新欺诈加规则）。第二层，模型泛化——ML 模型学习欺诈的"通用特征"（如异常行为模式），即使欺诈换策略，只要底层模式相似仍能识别。这是"主动防御"（模型识别未见过的新型）。第三层，图分析——团伙欺诈（多账号关联），用 GNN 分析关系图，即使单账号行为正常，团伙模式暴露。第四层，设备指纹——即使换账号，设备指纹一致仍能识别（同设备多账号）。第五层，延迟决策——对高风险请求不立即拒绝，"延迟处理"（如延迟到账 24 小时），期间人工/模型复审，确认安全再放行。京东反欺诈：规则 + 模型 + 图分析 + 设备指纹多层防御，欺诈识别率 98%+，新欺诈应对时效 < 24 小时。

## 常见考点

1. **风控和内容审核的区别？**——风控针对"行为风险"（欺诈/薅羊毛），审核针对"内容合规"（黄暴政假）。风控看用户行为和交易，审核看内容本身。底层都用人机协同和规则引擎。
2. **怎么做风控的 A/B 测试？**——按用户分流（hash userId），A 组旧规则，B 组新规则，对比欺诈率/误杀率/转化率。注意欺诈率低（需大样本才有统计显著）。
3. **怎么做"限额风控"（如单日提现 < 5 万）？**——规则引擎一条规则（amount > 50000 REJECT），用户维度累计（Redis 计数当日已提现额），超额拒绝。
4. **风控怎么和支付/订单系统集成？**——风控作为独立服务，支付/下单前调风控接口（decide），返回 PASS 才继续，REJECT 拦截。风控不侵入业务代码（解耦）。

## 结构化回答

**30 秒电梯演讲：** 风控决策引擎是根据用户行为判断是否放行的大脑。用户下单/领券/提现时，引擎综合多维数据（用户画像/设备/行为/历史）做决策：PASS（放行）/CHALLENGE（人机验证）/REJECT（拒绝）。核心挑战是规则多且组合复杂（反欺诈/防刷/限额）+ 决策要快（< 50ms）+ 可解释（为什么拒绝）。解法是决策流编排 + 规则引擎 + 模型评分——规则用 DSL 配置（规则链），模型给风险评分，决策流编排两者的执行顺序

**展开框架：**
1. **决策三态** — PASS（放行）/ CHALLENGE（人机验证/二次确认）/ REJECT（拒绝）
2. **规则引擎** — 条件→动作，DSL 配置（不发版）
3. **决策流编排** — 规则/模型的执行顺序（串行/并行/分支）

**收尾：** 以上是我的整体思路。您想继续深入聊——规则冲突怎么处理（一条说 PASS 一条说 REJECT）？


## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：风控规则引擎与决策流编排 | "这题一句话：风控决策引擎是根据用户行为判断是否放行的大脑。" | 开场钩子 |
| 0:15 | 决策三态示意/对比图 | "PASS（放行）/ CHALLENGE（人机验证/二次确认）/ REJECT（拒绝）" | 决策三态要点 |
| 0:40 | 规则引擎示意/对比图 | "条件→动作，DSL 配置（不发版）" | 规则引擎要点 |
| 1:25 | 总结卡 | "记住：决策三态。下期见。" | 收尾 |
