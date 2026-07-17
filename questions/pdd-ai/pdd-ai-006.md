---
id: pdd-ai-006
difficulty: L3
category: pdd-ai
subcategory: 规则引擎
tags:
- 拼多多
- AI 中台
- 规则引擎
- Drools
- 决策
feynman:
  essence: 业务规则中台是"把业务逻辑从代码里抽出来用规则引擎执行"，支持运营/算法同学在线编辑规则即时生效，不用发版。
  analogy: 像红绿灯可远程控制——规则（红灯停绿灯行）写在控制器里，交通局随时改（重载规则），不用重修马路（改代码发版）。
  first_principle: 业务规则频繁变（营销/风控/推荐），每次改规则都改代码发版太慢且风险高，必须把规则数据化+动态加载。
  key_points:
  - 规则模型：when-then（条件-动作）/决策树/决策表/评分卡
  - 引擎选型：Drools（Reteoo 算法重）/Aviator（表达式轻）/QLExpress/自研 DSL
  - 动态加载：规则存 DB/配置中心，热更新（KnowledgeBase 重载）
  - 与 AI 结合：LLM 生成规则/规则校验 LLM 输出
first_principle:
  problem: 业务规则频繁变且需运营自助，怎么不发版上线？
  axioms:
  - 规则本质是数据（条件-动作）
  - 数据可热加载
  - 代码发版成本高
  rebuild: 规则引擎（规则数据化）+ 动态加载 + 运营后台自助编辑。
follow_up:
  - Drools 为什么慢？——Reteoo 网络重，规则上千要预热，不适合超高频
  - Aviator 和QLExpress 区别？——都是轻量表达式，Aviator 编译字节码快，QLExpress 阿里出品支持流程控制
  - 规则和 AI 怎么协同？——规则做硬约束（合规/上限），AI 做柔性决策；LLM 可把自然语言转规则
memory_points:
  - when-then 模型（条件-动作）
  - 引擎：Drools 重/Aviator/QLExpress 轻
  - 规则存 DB + 热加载
  - 规则（硬约束）+ AI（柔性）
---

# 【拼多多 AI 中台】业务规则中台怎么设计？规则引擎选型？

> JD 依据："消费者服务策略算法中台、规则中台"。

## 一、规则中台要解决的问题

**传统痛点**：
```
运营：今晚 8 点活动，价格 < 100 的商品打 8 折
研发：改代码 → 测试 → 发版（2 天后上线，活动早过了）
```

**中台方案**：运营在后台配规则 → 推送配置中心 → 业务侧热加载 → 即时生效。

## 二、规则模型

```
1. when-then（条件-动作）
   when: price < 100 && category == "数码"
   then: discount = 0.8

2. 决策树（多条件分支）
   user.age > 60 → 老年
       └ vip == true → 高优
   user.age < 18 → 少儿

3. 决策表（多条件矩阵）
   | 信用分 | 收入 | 授信 |
   | >700   | >1w  | 10w  |

4. 评分卡（加权打分）
   score = age*0.3 + income*0.5 + credit*0.2
```

## 三、引擎选型对比

| 引擎 | 类型 | 性能 | 优点 | 缺点 |
|------|------|------|------|------|
| **Drools** | 完整规则引擎 | 中 | Reteoo 算法、决策表、社区成熟 | 重，规则上千预热慢 |
| **Aviator** | 表达式 | 高 | 编译字节码，单条 ms | 不支持流程控制 |
| **QLExpress** | 表达式+流程 | 高 | 阿里出品，支持脚本/流程 | 生态小 |
| **Easy Rules** | 轻量规则 | 高 | 简单 POJO + 注解 | 功能少 |
| **自研 DSL** | 定制 | 可控 | 贴合业务、可控 | 研发成本 |

**选型建议**：
- 复杂规则 + 决策表 → Drools
- 高频简单表达式（营销/计价） → Aviator/QLExpress
- 业务特化（如风控决策流） → 自研 DSL + JSON 描述

## 四、架构设计

```
┌──────────────────────────────────────────┐
│ 规则运营后台（DSL 编辑器/可视化）        │
│   - 新建/编辑/测试/灰度/发布              │
└────────────┬─────────────────────────────┘
             │ 推送（规则 JSON/DSL）
             ▼
┌──────────────────────────────────────────┐
│ 配置中心（Nacos/Apollo）+ 版本管理        │
└────────────┬─────────────────────────────┘
             │ 监听变更
             ▼
┌──────────────────────────────────────────┐
│ 规则引擎 SDK（业务侧，热加载）            │
│   - 编译规则 → KnowledgeBase             │
│   - 执行：fire(request) → result         │
└──────────────────────────────────────────┘
```

## 五、Drools 实战（动态热加载）

```java
public class RuleEngine {
    private volatile KieBase kieBase;

    // 热加载（监听配置中心变更）
    public void reload(String dsl) {
        KieServices ks = KieServices.Factory.get();
        KieFileSystem kfs = ks.newKieFileSystem();
        kfs.write("src/main/resources/rule.drl", dsl);
        ks.newKieBuilder(kfs).buildAll();
        KieContainer container = ks.newKieContainer(ks.getRepository().getDefaultReleaseId());
        this.kieBase = container.getKieBase();   // volatile 保证可见性
    }

    public <T> Result fire(T fact) {
        KieSession session = kieBase.newKieSession();
        try {
            session.insert(fact);
            session.fireAllRules();
            return ((ResultHolder) fact).getResult();
        } finally {
            session.dispose();    // 注意释放，否则内存泄漏
        }
    }
}
```

**避坑**：
- `KieSession` 非线程安全，每请求一个并 dispose
- 规则文件大量时预热（首次 fire 慢，启动时跑空请求预热）
- 规则复杂度上限定阈值（如单请求规则数 < 200），超限告警

## 六、轻量方案（QLExpress）

```java
ExpressRunner runner = new ExpressRunner();
// 编译一次缓存
String rule = "if (price < 100 && cat == '数码') return 0.8; else return 1.0;";
// 执行
Object discount = runner.execute(rule, context, errorList, isCache, isTrace);
```

适合超高频场景（万 QPS），规则简单、性能要求高。

## 七、规则中台与 AI 的协同

```
1. 规则做硬约束（合规/风控上限）
   - 授信金额硬上限
   - 敏感词过滤
   - 监管规则
2. AI 做柔性决策
   - LLM 生成商品描述
   - 推荐排序
   - 智能客服回复
3. LLM 辅助规则
   - 自然语言 → 规则 DSL（"价格低于 100 打 8 折" → drl）
   - 规则解释（规则命中后 LLM 生成话术）
```

## 八、底层本质

规则中台本质是**"业务逻辑数据化 + 动态加载"**——把易变的规则从代码中抽离成数据，运营自助编辑、配置中心推送、业务侧热加载。选型上重规则用 Drools，轻表达式用 Aviator/QLExpress。AI 时代，规则引擎和 LLM 互补：规则保下限（合规/硬约束），LLM 提上限（柔性智能）。

## 常见考点

1. **规则引擎为什么能热更新**？——规则编译成独立的 KnowledgeBase/AST，运行时替换引用（volatile），老会话执行完即生效新规则。
2. **怎么保证规则正确性**？——发布前沙箱测试（历史数据回放）+ 灰度（5% 流量）+ A/B + 监控指标对比。
3. **规则性能瓶颈在哪**？——规则数 × 条件数（Rete 网络节点），上百万规则要分片/索引/剪枝。

## 苏格拉底式面试追问

> 这组追问不背答案，模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：你们规则中台主推 Drools，但 Drools 重量级、预热慢，为什么不用 Aviator 这种轻量表达式引擎？营销规则大多是简单条件判断，Aviator 性能更好不是吗？**

因为营销/风控规则不只是"简单条件判断"，还有决策表（多条件矩阵）、规则优先级冲突解决、规则分组互斥。比如风控授信规则"信用分>700 且收入>1w → 授信 10w；信用分 600-700 且收入>8000 → 授信 5w"，这是决策表，Drools 的决策表编辑器（运营可视化）+ Rete 网络共享条件（信用分判断只算一次，复用给多条规则）效率远高于 Aviator 逐条执行。Aviator 适合"单条表达式"（计价、折扣计算），Drools 适合"多规则集 + 复杂业务逻辑"。我们的做法是分层：复杂风控/授信用 Drools，高频简单计价用 Aviator，按场景选不是一刀切。

### 第二层：证据与定位

**Q：运营说刚配的一条促销规则上线后没生效，但配置中心显示规则已经推送了。你怎么排查是规则没加载还是规则加载了但没命中？**

分两步定位。第一，确认规则是否加载——在规则引擎 SDK 加 `log.info("Rules reloaded: version={}, count={}", version, kieBase.getKiePackages().stream().mapToInt(p->p.getRules().size()).sum())`，业务侧日志里看有没有这次 reload 的记录和规则数量。如果 count 没增加，说明配置中心推送了但 SDK 没收到（Nacos 监听器没注册或 dataId 配错）。第二，确认规则是否命中——Drools 支持 `ksession.setGlobal("logger", ...)` 或用 `RuleRuntimeEventListener` 监听每条规则的 fire 情况，记录 `rule_name, fact, fired_or_skipped`。如果规则加载了但 fire=false，说明 when 条件没满足——把运营的测试 fact 和规则的 LHS（when 子句）对比，常见问题是字段名拼写不一致（规则写 `amount` 但 fact 里是 `orderAmount`）或类型不匹配（规则 `> 100` 但 fact 字段是 String）。

### 第三层：根因深挖

**Q：规则确实加载了、也命中了，但运营说"促销价不对"。Drools 的 rule fires 了但 then 里的赋值没生效，根因可能是什么？**

最常见根因是"多规则冲突 + agenda 顺序"。Drools 是多规则系统，一次 fireAllRules 可能匹配多条规则，如果两条规则都修改 `discount` 字段（A 规则设 0.8，B 规则设 0.9），最终值取决于规则的 salience（优先级）或 agenda group 的执行顺序。用 `ksession.getAgenda().getAgendaGroup("promo").setFocus()` 控制组顺序，或给规则加 `salience=100`。另一个根因是"规则执行后被覆盖"——C 规则在 A/B 之后 fire，把 discount 重置成 1.0。排查手段：开 Drools 的 audit log（`ksession.setRuntimeLogger(new WorkingMemoryFileLogger(...))`），记录每条规则的 fire 顺序和 fact 修改轨迹，看 discount 的最终值是哪条规则设的。

**Q：那为什么不直接用单规则引擎（每次只 fire 一条规则）避免冲突？Drools 的多规则 fire 不是自找麻烦吗？**

单规则会失去 Rete 网络的核心优势——条件共享。授信场景下"信用分>700"这个判断在 10 条规则里都用，Rete 网络只算一次，结果共享给 10 条规则；单规则引擎要算 10 次。而且业务上"多规则同时命中 + 优先级仲裁"是真实需求（风控规则多条触发时取最严格的结果），单规则模式做不到。Drools 的 salience + agenda group + activation-group（互斥组）就是解决冲突的标准机制，不是缺陷，是要正确使用。复杂度是规则引擎的本质，规避不了，只能用规范（规则命名、salience 约定、CI 校验）管理。

### 第四层：方案权衡

**Q：你用配置中心（Nacos）做规则热更新，但 Drools 的 KieBase 重建很慢（上千规则要几秒）。这期间请求是阻塞还是用旧规则？**

用"双 KieBase 切换"模式避免阻塞。后台线程异步构建新 KieBase（`KieServices.get().newKieBuilder(...).buildAll()` 耗时几秒），同时老 KieBase 继续服务线上请求；新 KieBase 构建完成后，通过 `volatile KieBase` 引用切换（CAS），老请求在老 KieSession 跑完即销毁，新请求用新 KieBase。这样热更新对业务透明，P99 不受影响。切换瞬间可能有极少数请求跨了边界（一个请求用了老规则、下一个用了新规则），但规则场景容忍这个（规则版本切换本来就允许短暂不一致）。

**Q：为什么不直接用 Drools 的 KieScanner 做自动热加载？它不是官方支持的吗？**

KieScanner 依赖 Kjar Maven 仓库（规则打包成 kjar 发到 Nexus），每次规则变更要 mvn deploy + KieScanner 轮询拉取。这个链路对运营不友好——运营在后台改规则，要研发打包发版才能生效，违背了"运营自助"的初衷。我们的方案是规则以 DRL/JSON 存数据库，运营后台编辑后直接推 Nacos，SDK 监听 Nacos 变更触发 KieBase 重建，全程不经过 Maven。KieScanner 适合"规则随代码版本管理"的研发场景，不适合"运营在线编辑"的业务场景。

### 第五层：验证与沉淀

**Q：你怎么证明热更新后新规则真的对所有实例生效了？有没有可能某个 Pod 的 Nacos 监听器挂了，还在跑老规则？**

三层验证。第一，规则版本号注册——每次规则发布带一个递增的 `rule_version`，SDK 加载后上报到 Prometheus（`gauge{rule_set="promo", version="v123", pod="xxx"}`），大盘看所有 Pod 的 version 是否一致，`version_skew_count > 0` 告警。第二，影子请求回放——规则发布后自动跑 100 条历史 fact，对比新规则结果和预期结果，准确率 < 99% 阻断发布。第三，在线对账——生产请求按 1% 采样，把 fact 同时打到新规则引擎跑一遍（影子执行），对比线上结果和新规则结果，`mismatch_rate > 0.1%` 告警，及早发现版本不一致。

**Q：怎么让运营不再配出"规则冲突"的坑？**

沉淀规范和工具。第一，规则上线强制走沙箱回放——运营配完规则后，系统自动用最近 7 天的历史请求回放，对比新规则前后的结果差异，差异 > 5% 的规则需主管审批。第二，规则冲突检测——发布前扫描所有规则的 LHS 和 salience，如果两条规则的 when 条件有重叠且 then 修改同一字段，警告"可能与规则 X 冲突，请确认 salience"。第三，灰度发布——新规则先 1% 流量灰度 30 分钟，监控 GMV/转化率等核心指标，异常自动回滚。第四，规则血缘记录——每条规则改了什么、谁改的、什么时候上的，存 Git 做版本管理，出问题秒级回滚到任意历史版本。

## 结构化回答

**30 秒电梯演讲：** 业务规则频繁变且需运营自助，怎么不发版上线？简单说就是——业务规则中台是"把业务逻辑从代码里抽出来用规则引擎执行"，支持运营/算法同学在线编辑规则就是时生效，不用发版。引擎：Drools 重/Aviator/QLExpress 轻；规则存 DB + 热加载。

**展开框架：**
1. **when-t** — when-then 模型（条件-动作）
2. **引擎** — 引擎：Drools 重/Aviator/QLExpress 轻
3. **规则存 DB** — 规则存 DB + 热加载

**收尾：** 您想继续往深里聊吗——比如「Drools 为什么慢？」

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：业务规则中台怎么设计？规则引擎选型？ | 今天聊「业务规则中台怎么设计？规则引擎选型？」。一句话：业务规则中台是"把业务逻辑从代码里抽出来用规则引擎执行"，支持运营/算法同学在线编辑规则即时生效，不用发版。 | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：when-then 模型（条件-动作） | 核心概念 |
| 1:04 | 能力/参数拆解表 | 要点是：引擎：Drools 重/Aviator/QLExpress 轻 | 能力拆解 |
| 1:56 | 流程图：输入→处理→输出 | 要点是：规则存 DB + 热加载 | 关键机制 |
| 3:00 | 总结卡 + 下期预告 | 记住这些核心点就够了。下期我们接着聊——Drools 为什么慢？。 | 收尾 |
