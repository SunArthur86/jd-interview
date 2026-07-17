---
id: java-architect-051
difficulty: L3
category: java-architect
subcategory: 风控架构设计
tags:
- Java 架构师
- 安全
- 审计
- 风控
feynman:
  essence: 安全架构的 AAA 是认证（你是谁）、授权（你能做什么）、审计（你做了什么）。风控是在 AAA 之上的"实时威胁检测"——识别异常登录、异常下单、薅羊毛、撞库攻击。四层叠加：网关层做认证（确认身份）、应用层做授权（校验权限）、数据层做审计（记录行为）、风控层做决策（放行/拦截/挑战验证码）。
  analogy: 像银行的安全体系。认证是查验身份证（你是张三吗），授权是查账户权限（你的卡能取多少钱），审计是监控录像（你今天取了 3 次钱都有记录），风控是反欺诈系统（你突然在异国取现，系统拦截并打电话确认）。
  first_principle: 为什么 AAA 不够还要风控？因为 AAA 是"静态规则"（有权限就放行），但攻击者可能盗用了合法身份（撞库/Session 劫持）。风控用"行为基线 + 实时决策"识别"合法身份的异常行为"——张三的账号突然在 10 分钟内下了 100 单，AAA 放行（身份合法），风控拦截（行为异常）。
  key_points:
  - AAA：Authentication（认证）+ Authorization（授权）+ Audit（审计）
  - 认证三要素：知识（密码）、拥有（手机/Token）、生物（指纹/人脸），多因素认证（MFA）
  - 审计日志三不可：不可篡改（append-only）、不可删除、可追溯
  - 风控决策流：放行（PASS）/挑战（CHALLENGE 验证码）/拦截（REJECT）
  - 风控引擎：规则引擎（确定性规则）+ 模型引擎（ML 评分）
first_principle:
  problem: 如何在合法身份被滥用（撞库/盗号/薅羊毛）时，实时识别并拦截，同时不误伤正常用户？
  axioms:
  - AAA 只验证"身份合法性"，不验证"行为合理性"
  - 攻击者用合法身份做异常操作（高频下单/批量领券），AAA 无法识别
  - 风控要在毫秒级决策（放行/挑战/拦截），不能明显增加延迟
  rebuild: 三层叠加。AAA 做身份和权限管控（基础防线）。审计日志记录所有行为（事后追溯）。风控引擎做实时威胁检测——规则引擎跑确定性策略（如同 IP 1 分钟登录失败 5 次锁定），模型引擎跑 ML 评分（如设备指纹+行为序列给 risk_score）。决策流编排：低风险放行，中风险挑战（验证码/短信），高风险拦截。
follow_up:
  - 撞库攻击怎么防？——登录限流（同 IP/同账号失败次数限制）、设备指纹识别、验证码（连续失败触发）、异地登录二次验证。京东登录有设备指纹库，陌生设备首次登录强制短信验证。
  - 薅羊毛怎么识别？——风控规则：同设备多账号领券、同 IP 高频领券、新注册账号立即领大额券。用设备指纹+IP+账号画像综合判断。
  - 审计日志被篡改怎么办？——日志写入用 WORM（Write Once Read Many）存储，或上链（区块链/哈希链），保证不可篡改。DB 层面 revoke 所有 UPDATE/DELETE 权限。
  - 风控规则怎么灰度？——新规则先"观察模式"（只记录不拦截），统计命中量和误伤率，调整阈值后再切"拦截模式"。
  - 风控决策的延迟怎么控？——规则引擎用内存计算（< 10ms），模型推理用预加载模型（< 50ms），特征查询用 Redis（< 5ms）。整体 RT < 100ms，用户无感。
memory_points:
  - AAA：认证（你是谁）+授权（你能做）+审计（你做了）
  - 认证 MFA：知识+拥有+生物，三选二
  - 审计三不可：不可篡改、不可删除、可追溯
  - 风控决策：PASS/CHALLENGE/REJECT
  - 风控引擎：规则（确定性）+模型（ML 评分），RT < 100ms
---

# 【Java 后端架构师】安全架构：认证、授权、审计与风控

> 适用场景：JD 核心技术。京东每天处理亿级请求，其中混着撞库攻击、薅羊毛团伙、恶意爬虫。单纯靠 AAA（认证+授权+审计）防不住——攻击者用合法账号做坏事。风控层是"行为防线"，识别"合法身份的异常行为"，是交易链路的隐形守门员。

## 一、概念层：安全架构四层

**四层安全架构**（面试必画）：

```
请求流入
    │
    ▼
┌─────────────────────────────────────────────┐
│  第 1 层：网关层（认证 Authentication）        │
│  - 验证 Token/JWT 是否有效                    │
│  - 拒绝匿名请求（除白名单接口）               │
│  - 提取 userId、tenantId 放入上下文           │
├─────────────────────────────────────────────┤
│  第 2 层：应用层（授权 Authorization）         │
│  - RBAC 校验功能权限（能不能调这个接口）       │
│  - ABAC 校验数据权限（能看到哪些数据）         │
├─────────────────────────────────────────────┤
│  第 3 层：风控层（威胁检测 Risk Control）      │
│  - 规则引擎：高频下单/异常登录/薅羊毛          │
│  - 模型引擎：设备指纹+行为评分                │
│  - 决策：PASS / CHALLENGE / REJECT           │
├─────────────────────────────────────────────┤
│  第 4 层：审计层（Audit）                      │
│  - 记录所有行为（谁、何时、做了什么、结果）     │
│  - 不可篡改，事后追溯                         │
└─────────────────────────────────────────────┘
    │
    ▼
  业务处理
```

## 二、机制层：认证与 MFA

**多因素认证（MFA）代码**：

```java
@Service
public class AuthService {

    @Autowired private PasswordEncoder passwordEncoder;
    @Autowired private SmsService smsService;
    @Autowired private DeviceFingerprintService deviceService;

    public LoginResult login(LoginRequest req) {
        // 因素 1：密码（知识认证）
        User user = userRepo.findByUsername(req.getUsername());
        if (user == null || !passwordEncoder.matches(req.getPassword(), user.getPassword())) {
            recordLoginFailure(req);   // 记录失败，用于撞库检测
            throw new AuthException("用户名或密码错误");
        }

        // 设备指纹检查
        boolean trustedDevice = deviceService.isTrusted(
            user.getId(), req.getDeviceFingerprint());

        // 风险评估：是否需要因素 2
        RiskLevel risk = assessLoginRisk(user, req);
        if (risk == RiskLevel.HIGH || !trustedDevice) {
            // 因素 2：短信验证码（拥有认证）
            String otp = generateOtp();
            smsService.send(user.getPhone(), otp);
            redisTemplate.opsForValue().set(
                "otp:" + user.getId(), otp, 5, TimeUnit.MINUTES);
            return LoginResult.challenge(user.getId(), "SMS_OTP");
        }

        // 低风险 + 受信设备：直接登录
        return LoginResult.success(issueToken(user));
    }

    private RiskLevel assessLoginRisk(User user, LoginRequest req) {
        // 规则 1：异地登录
        if (!req.getCity().equals(user.getLastLoginCity())) {
            return RiskLevel.HIGH;
        }
        // 规则 2：异常时间（凌晨 + 新设备）
        if (isLateNight() && !deviceService.isTrusted(user.getId(), req.getDeviceFingerprint())) {
            return RiskLevel.HIGH;
        }
        // 规则 3：近期登录失败多次（撞库嫌疑）
        if (loginFailureCount(user.getId(), 1, TimeUnit.HOURS) > 3) {
            return RiskLevel.HIGH;
        }
        return RiskLevel.LOW;
    }
}
```

## 三、机制层：审计日志

**不可篡改的审计日志**（哈希链）：

```java
@Service
public class AuditService {

    @Autowired private AuditLogRepo repo;

    // 每条日志包含前一条的哈希，形成链式结构（类似区块链）
    public void audit(Long userId, String action, String resource, String result) {
        AuditLog last = repo.findLatest();
        String prevHash = (last != null) ? last.getHash() : "GENESIS";

        AuditLog log = new AuditLog();
        log.setUserId(userId);
        log.setAction(action);
        log.setResource(resource);
        log.setResult(result);
        log.setTimestamp(Instant.now());
        log.setIp(RequestContextHolder.get().getIp());
        log.setPrevHash(prevHash);
        log.setHash(computeHash(log));   // 当前记录的哈希

        repo.save(log);
        // DB 权限：只允许 INSERT，禁止 UPDATE/DELETE（DBA revoke）
    }

    private String computeHash(AuditLog log) {
        String content = log.getUserId() + log.getAction() + log.getResource()
            + log.getResult() + log.getTimestamp() + log.getPrevHash();
        return DigestUtils.sha256Hex(content);
    }

    // 验证日志链完整性（防篡改检测）
    public boolean verifyChain() {
        List<AuditLog> logs = repo.findAllOrderByTime();
        for (int i = 1; i < logs.size(); i++) {
            AuditLog curr = logs.get(i);
            AuditLog prev = logs.get(i - 1);
            // 验证哈希链连续性
            if (!curr.getPrevHash().equals(prev.getHash())) {
                return false;   // 日志被篡改
            }
            // 验证当前记录哈希正确
            if (!curr.getHash().equals(computeHash(curr))) {
                return false;   // 内容被篡改
            }
        }
        return true;
    }
}
```

## 四、机制层：风控决策引擎

**风控决策流**（规则 + 模型）：

```java
@Service
public class RiskEngine {

    @Autowired private List<RiskRule> rules;        // 规则链
    @Autowired private RiskModelService modelService; // ML 模型
    @Autowired private RedisTemplate redis;

    public RiskDecision evaluate(RiskContext ctx) {
        // 第 1 步：规则引擎（确定性规则，< 10ms）
        for (RiskRule rule : rules) {
            RuleResult result = rule.evaluate(ctx);
            if (result.getAction() == Action.REJECT) {
                return RiskDecision.reject(rule.getRuleId(), "命中拦截规则");
            }
            if (result.getAction() == Action.CHALLENGE) {
                return RiskDecision.challenge(rule.getRuleId(), "需要验证码");
            }
        }

        // 第 2 步：模型评分（ML，< 50ms）
        double score = modelService.score(ctx);   // 0-100，越高越危险
        if (score > 80) {
            return RiskDecision.reject("MODEL", "风险评分过高: " + score);
        }
        if (score > 60) {
            return RiskDecision.challenge("MODEL", "需要短信验证");
        }

        // 第 3 步：通过
        return RiskDecision.pass();
    }
}

// 规则示例：同 IP 高频下单
@Component
@Order(1)
public class HighFrequencyOrderRule implements RiskRule {

    @Override
    public RuleResult evaluate(RiskContext ctx) {
        String key = "order_freq:" + ctx.getIp();
        Long count = redis.opsForValue().increment(key);
        if (count == 1) redis.expire(key, 60, TimeUnit.SECONDS);
        if (count > 20) {   // 同 IP 1 分钟下单超 20 次
            return RuleResult.reject("同 IP 高频下单: " + count);
        }
        if (count > 10) {
            return RuleResult.challenge("同 IP 下单频繁，需要验证码");
        }
        return RuleResult.pass();
    }
}

// 规则示例：新账号大额下单
@Component
@Order(2)
public class NewAccountLargeOrderRule implements RiskRule {

    @Override
    public RuleResult evaluate(RiskContext ctx) {
        if (ctx.getAccountAgeDays() < 7 && ctx.getOrderAmount() > 10000) {
            return RuleResult.challenge("新账号大额下单，需要人工审核");
        }
        return RuleResult.pass();
    }
}
```

**风控规则灰度上线**（先观察后拦截）：

```java
@Component
public class RuleDeploymentManager {

    // 新规则先"观察模式"运行
    public void deployRule(RiskRule rule, DeployMode mode) {
        rule.setMode(mode);   // OBSERVE（只记录）/ ENFORCE（拦截）
        rules.add(rule);

        if (mode == DeployMode.OBSERVE) {
            // 观察期统计命中量和误伤率
            metrics.counter("risk.rule.hit",
                "rule", rule.getRuleId(),
                "mode", "observe");
        }
    }

    // 观察 7 天后，分析误伤率，决定是否切拦截
    public RuleAnalysis analyzeRule(String ruleId, int days) {
        long hitCount = metrics.count("risk.rule.hit", ruleId, days);
        long falsePositive = manualReviewRepo.countFalsePositive(ruleId, days);
        double fpRate = (double) falsePositive / hitCount;
        // 误伤率 < 5% 可切拦截，否则调阈值
        return new RuleAnalysis(hitCount, falsePositive, fpRate);
    }
}
```

## 五、底层本质：静态防线 vs 动态防线

回到第一性：**安全架构的本质是"多层防线，各司其职"**。

- **认证（Authentication）是"身份证"**：证明你是谁。但身份证可能被盗（撞库/钓鱼）。
- **授权（Authorization）是"权限卡"**：决定你能进哪些门。但权限卡被盗后，攻击者能做合法操作。
- **审计（Audit）是"监控录像"**：记录发生了什么。是事后追溯，不是事前拦截。
- **风控是"行为分析"**：即使身份合法、权限合规，行为异常也要拦。这是动态防线。

**为什么 AAA 不够**：攻击者用合法账号（撞库得到的密码）登录，AAA 全部通过（身份合法+权限合规），然后批量下单薅羊毛。只有风控能识别"这个账号的行为模式和正常用户不一样"（10 分钟下 100 单 vs 正常用户 1 天 1 单）。

**风控的核心矛盾是"误伤率 vs 漏报率"**：规则太严误伤正常用户（用户体验差），规则太松漏过攻击（资损）。解法是"分层决策"——低风险放行（用户体验），中风险挑战验证码（平衡），高风险拦截（防资损）。挑战机制是关键——与其直接拦截误伤，不如让用户用验证码/短信证明自己是人。

## 六、AI 架构师加问：5 个

1. **用 AI 做风控模型，和规则引擎什么关系？**
   规则引擎处理确定性策略（同 IP 失败 5 次锁定），AI 模型处理模糊判断（这个行为序列像不像机器人）。两者叠加：规则先过滤明显攻击，模型再识别复杂模式。规则可解释（命中哪条规则），模型是黑盒（要 SHAP 解释）。

2. **AI 风控模型怎么防"对抗攻击"？**
   攻击者会试探规则边界（慢慢加频率，不触发阈值）。解法：模型用更多维特征（设备指纹+IP+行为序列+账号画像），不只看单一维度。定期重训模型（攻击模式变化快）。用对抗训练增强鲁棒性。

3. **风控模型的可解释性怎么做？**
   金融风控要求可解释（监管要求"为什么拒绝这笔交易"）。用 SHAP/LIME 输出特征贡献度（如"拒绝原因：新设备+异地+大额，贡献比 40%+30%+30%"）。纯黑盒模型（深度学习）不适合金融场景，用 GBDT+xgboost 配合 SHAP。

4. **AI Agent 做操作，怎么过风控？**
   Agent 的操作带特殊标识（X-Agent: true），风控对 Agent 有独立规则（更严格——限制操作金额/频率，要求人工确认高危操作）。Agent 不能绕过风控，它的每次工具调用都经过风控引擎。

5. **用 AI 生成攻击流量做风控压测，怎么做？**
   AI 模拟攻击者行为（撞库/薅羊毛/爬虫），生成测试流量打风控系统，验证拦截率。但要用隔离环境（不能影响生产），且测试数据要脱敏。AI 生成的攻击模式要覆盖已知攻击类型 + 变种。

## 七、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"AAA 三层 + 风控动态防线 + 审计不可篡改"**。

- **认证**：MFA（密码+手机+生物），异地/新设备二次验证
- **授权**：RBAC 功能权限 + ABAC 数据权限
- **审计**：哈希链不可篡改，DB 禁 UPDATE/DELETE
- **风控**：规则引擎（确定性）+ 模型引擎（ML），PASS/CHALLENGE/REJECT
- **灰度**：新规则先观察模式（只记录），误伤率 < 5% 再切拦截

### 面试现场 60 秒回答

> 安全架构四层：网关层做认证（JWT 验证+MFA 多因素），应用层做授权（RBAC+ABAC），风控层做威胁检测，审计层做追溯。认证用 MFA——密码+短信+设备指纹，异地登录或新设备强制二次验证。审计日志用哈希链保证不可篡改，每条日志含前一条的 hash，DB 层 revoke UPDATE/DELETE 权限。风控引擎是核心——规则引擎跑确定性策略（同 IP 1 分钟失败 5 次锁定），模型引擎跑 ML 评分（设备指纹+行为序列给 risk_score 0-100），决策三档：低风险放行、中风险挑战验证码、高风险拦截。新规则灰度上线——先观察模式（只记录不拦截），统计命中量和误伤率，误伤率 < 5% 才切拦截模式。风控 RT 控制在 100ms 内（规则内存计算+Redis 特征查询+模型预加载），用户无感。

## 八、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不把所有请求都拦截，宁可错杀不放过？ | 用用户体验和转化率说话：过度拦截导致正常用户流失（下单被拒就卸载 App）。用 false_positive_rate（误伤率）和 user_churn_from_block（因拦截流失的用户数）量化，误伤率应 < 1% |
| 证据追问 | 怎么证明风控有效？ | attack_block_rate（攻击拦截率，应 > 99%）、false_positive_rate（误伤率，应 < 1%）、financial_loss_prevented（避免的资损金额）、manual_review_volume（人工审核工单量，应下降） |
| 边界追问 | 风控能防所有攻击吗？ | 不能。防不了零日攻击（新攻击模式规则库没有）、防不了内部人员滥用（有合法权限）、防不了社工攻击（骗用户自己转账）。这些靠流程和审计兜底 |
| 反例追问 | 什么场景风控要放宽？ | 大促期间（双 11 正常用户也会高频下单，规则要临时调宽）、灰度上线新功能（行为模式变化，风控要适应）、测试账号（白名单豁免） |
| 风险追问 | 风控系统本身的风险？ | 主动点出：风控误伤导致用户流失、风控规则冲突（多规则互相矛盾）、风控延迟拖慢主链路（要做异步化）、风控规则泄露（攻击者知道规则就能绕过） |
| 验证追问 | 怎么证明风控规则没误伤？ | 观察模式统计：规则命中后人工 review，算 false_positive_rate；A/B 测试：有规则组 vs 无规则组的用户投诉率对比；监控被拦截用户的后续行为（是否卸载/投诉） |
| 沉淀追问 | 风控系统沉淀什么？ | 规则引擎框架（DSL 定义规则）、特征平台（设备指纹/IP 库/账号画像）、灰度发布工具（观察模式→拦截模式）、人工审核后台、规则效果分析大盘 |

### 现场对话示例

**面试官**：风控规则怎么平衡"误伤"和"漏报"？

**候选人**：核心是分层决策，不是一刀切。低风险行为直接放行（正常用户体验），中风险用"挑战"机制——不直接拦截，而是要求用户做一次验证（滑块验证码/短信验证），如果是机器人就过不了，是真人就通过。高风险才直接拦截（如确定性的攻击特征）。这样误伤的用户只是"多做一次验证"，不会流失；而真正的攻击者会被挑战拦住。具体阈值调优靠灰度——新规则先观察模式跑 7 天，统计命中量里多少是误伤（人工 review），如果误伤率 > 5% 就调宽阈值，< 1% 才切拦截模式。京东下单风控的实践：99% 的订单秒级放行（风控 RT < 50ms），0.9% 触发验证码挑战（用户 3 秒完成），0.1% 拦截转人工审核。这样既防住攻击，又保证正常用户的下单转化率。

**面试官**：风控模型的"黑盒"问题怎么解？用户投诉"为什么我的订单被拒"，怎么回答？

**候选人**：金融风控必须可解释（监管要求），纯深度学习模型不合适。用 GBDT（如 XGBoost/LightGBM）配合 SHAP 值解释——SHAP 能输出每个特征对决策的贡献度。比如拒绝决策的原因可能是"新设备(贡献 40%) + 异地(贡献 30%) + 大额(贡献 30%)"，输出给客服或用户。京东的做法：模型输出 risk_score + top 3 特征贡献，客服系统能查到"您的订单因在新设备+异地登录被风控挑战，请完成短信验证"。对用户透明解释，而不是黑盒拒绝。另外，规则引擎天然可解释（命中规则 X），复杂判断才用模型，两者配合——规则处理明确攻击，模型处理模糊判断，保证整体可解释。

**面试官**：审计日志被内部人员篡改怎么办？

**候选人**：三层防护。第一层，DB 权限——审计日志表的 DB 账号只授 INSERT 权限，revoke UPDATE/DELETE/TRUNCATE，即使 DBA 也改不了（DBA 用单独的管理账号，操作审计）。第二层，哈希链——每条日志含前一条的 hash，篡改任意一条会导致后续所有 hash 不匹配，定期跑 verifyChain() 检测。第三层，WORM 存储/上链——审计日志同步到对象存储的 WORM 桶（Write Once Read Many，写一次不可删），或上链（哈希存区块链）。极端情况（内部人员有最高权限），日志同步到独立的审计系统（不同团队管控，跨团队串通成本高）。京东的审计日志同步到独立的日志审计平台（安全团队管控），业务团队和 DBA 都没权限修改。

## 常见考点

1. **Session 和 Token（JWT）哪个更安全？**——Token 无状态不依赖服务端存储，但一旦泄露在有效期内无法撤销（除非维护黑名单）。Session 可主动注销（服务端删 Session），但要做 Session 同步（多实例）。高安全场景用 Session + 短时 Token。
2. **SSO（单点登录）怎么实现？**——CAS 或 OAuth2。用户在认证中心登录一次，各子系统通过 Ticket/Token 免登录。核心是"认证中心发票据，子系统验票据"。
3. **API 怎么防重放？**——请求带 timestamp + nonce + signature，服务端校验 timestamp 是否在有效期内（5 分钟），nonce 是否用过（Redis 记录已用 nonce）。详见 053 题。
4. **等保 2.0 对安全架构的要求？**——安全计算环境（身份鉴别+访问控制+安全审计）、安全区域边界（边界防护+入侵防范）、安全通信网络（通信加密）。对应认证授权审计+网络隔离+HTTPS。

## 结构化回答

**30 秒电梯演讲：** 安全架构的 AAA 是认证（你是谁）、授权（你能做什么）、审计（你做了什么）。风控是在 AAA 之上的实时威胁检测——识别异常登录、异常下单、薅羊毛、撞库攻击。四层叠加：网关层做认证（确认身份）、应用层做授权（校验权限）、数据层做审计（记录行为）、风控层做决策（放行/拦截/挑战验证码）

**展开框架：**
1. **AAA** — Authentication（认证）+ Authorization（授权）+ Audit（审计）
2. **认证三要素** — 知识（密码）、拥有（手机/Token）、生物（指纹/人脸），多因素认证（MFA）
3. **审计日志三不可** — 不可篡改（append-only）、不可删除、可追溯

**收尾：** 以上是我的整体思路。您想继续深入聊——撞库攻击怎么防？


## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：安全架构：认证、授权、审计与风控 | "这题一句话：安全架构的 AAA 是认证（你是谁）、授权（你能做什么）、审计（你做了什么）。" | 开场钩子 |
| 0:15 | 像银行的安全体系类比图 | "打个比方：像银行的安全体系。" | 核心类比 |
| 0:40 | AAA示意/对比图 | "Authentication（认证）+ Authorization（授权）+ Audit（审计）" | AAA要点 |
| 1:05 | 认证三要素示意/对比图 | "知识（密码）、拥有（手机/Token）、生物（指纹/人脸），多因素认证（MFA）" | 认证三要素要点 |
| 1:55 | 总结卡 | "记住：AAA。下期见。" | 收尾 |
