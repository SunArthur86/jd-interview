---
id: pdd-trade-033
difficulty: L4
category: pdd-trade
subcategory: Agent 工程化
tags:
- 拼多多
- 交易
- AI Harness
- Agent 工程化
- 评估
- LLMOps
feynman:
  essence: AI Harness 是"LLM 应用的工程脚手架"——prompt 管理、版本化、评估、监控、灰度、回滚，把"调 prompt 靠玄学"变成"工程化可控"。
  analogy: AI Harness 像"实验室管理"——不是研究化学反应（LLM），而是把温度/压力/记录标准化（工程），让实验可复现、可比对、可优化。
  first_principle: LLM 应用上线后 prompt/模型/数据会变，必须像软件工程一样版本化+评估+监控。
  key_points:
  - Prompt 管理：版本化+模板化+A/B
  - 评估体系：离线（标注集）+在线（A/B+业务指标）
  - 监控：RT/成本/幻觉率/用户满意度
  - LLMOps：CI/CD 灰度+回滚+审计
first_principle:
  problem: LLM 应用 prompt/模型/数据频繁变化，如何工程化管理？
  axioms:
  - LLM 输出不确定
  - prompt 微调影响大
  - 必须可回滚可监控
  rebuild: Prompt 版本管理 + 离线评估集 + 在线 A/B + 监控告警 + 灰度回滚。
follow_up:
  - prompt 怎么版本管理？——Git+模板引擎（Jinja2）+变量注入
  - 怎么评估 LLM 输出好坏？——人工标注集+自动指标（BLEU/LLM-as-judge）+业务转化率
  - LLM 灰度怎么做？——流量分桶（5%/20%/100%）+指标对比+自动止损
memory_points:
  - Harness = prompt 管理+评估+监控+灰度
  - 评估：离线标注集+在线 A/B
  - 监控：RT/成本/幻觉/满意度
  - LLMOps：版本化+回滚+审计
---

# 【拼多多交易】AI Harness 怎么工程化？

> JD 依据："AI Harness 工程化"。

## 一、Harness 整体

```
开发 → Prompt 管理（版本）→ 离线评估（标注集）→ 灰度上线 → 监控 → 回滚
                              ↑                                    ↓
                              └────── 反馈数据回流 ←────────────────┘
```

## 二、Prompt 管理

**模板化+版本化**：
```yaml
# prompts/refund_v3.yaml
name: refund_advisor
version: v3
template: |
  你是拼多多退款助手。根据以下规则判断是否可退款：
  {{policy_docs}}
  用户订单：{{order}}
  用户问题：{{question}}
  只回答"可退/不可退/转人工"+理由，引用规则编号。
variables: [policy_docs, order, question]
```

```java
Prompt prompt = promptManager.get("refund_advisor", "v3");
String rendered = prompt.render(Map.of(
    "policy_docs", rag.retrieve("refund"),
    "order", order,
    "question", q
));
```

## 三、评估体系

**离线评估**（标注集）：
```python
eval_set = load_eval_set("refund_1000.json")  # 1000 标注样本
results = []
for case in eval_set:
    pred = agent.run(case.input)
    results.append({
        "accuracy": llm_judge(pred, case.expected),  # LLM-as-judge
        "latency": pred.latency,
        "cost": pred.tokens * PRICE
    })
print(f"准确率: {mean(r.accuracy for r in results):.2%}")
```

**在线 A/B**：
```
新版 prompt 灰度 10% 流量：
  对照组（v3）：满意度 85%、转人工率 15%
  实验组（v4）：满意度 88%、转人工率 12%
显著提升 → 全量；下降 → 回滚
```

**业务指标**：
- 客服：满意度、转人工率、首问解决率
- 退款：自动通过率、申诉率、错退率

## 四、监控告警

```
指标：
  RT（p99 < 3s）
  成本（单次 < 0.1 元）
  幻觉率（人工抽检 < 1%）
  调用失败率（< 1%）
  用户负反馈率（< 5%）

异常 → 自动切稳定版+告警
```

## 五、LLMOps 流程

```
1. 改 prompt → 单测（标注集）→ 代码评审
2. 预发评估（影子流量）→ 离线报告
3. 灰度上线（5%→20%→100%）
4. 监控异常 → 一键回滚
5. 反馈数据回流 → 迭代下一版
```

## 六、拼多多实战

- **Prompt 仓库**：200+ prompt 版本化，团队协作
- **评估平台**：客服标注集 10 万+，每周回归
- **灰度系统**：LLM 应用像业务一样灰度
- **成本看板**：每天百万次调用，成本精确到接口

## 七、底层本质

AI Harness 本质是**"把 LLM 应用当软件工程来管"**——prompt 是代码（版本化），评估是测试（标注集），灰度是发布，监控是运维，让"玄学调 prompt"变"工程化迭代"。

## 常见考点
1. **LLM-as-judge 可靠吗**？——比人工便宜但有限，关键场景仍需人工，且需校准（与人工一致性）。
2. **prompt 改动怎么评估**？——离线标注集回归+在线 A/B 双验证。
3. **LLM 成本怎么控**？——模型分级（简单用小模型）+缓存（同问题直接返回）+token 优化。
