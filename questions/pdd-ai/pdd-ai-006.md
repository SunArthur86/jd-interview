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
