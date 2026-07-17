---
id: biopharm-032
difficulty: L3
category: biopharm
subcategory: Prompt 工程
tags:
- 生物医药
- AI 全栈
- Prompt 工程
- CoT
- ReAct
- Few-shot
- 结构化输出
feynman:
  essence: "Prompt 工程是'用自然语言编程 LLM'——CoT 让它分步推理，ReAct 让它边想边调工具，Few-shot 给范例对齐格式，结构化输出约束格式，版本管理让 prompt 像代码一样可演进。"
  analogy: "像教新人干活——CoT 是'别急着想清楚一步步来'，ReAct 是'边查资料边思考'，Few-shot 是'先看几个例子照着做'，结构化输出是'按这个表格填'，版本管理是'上次有效的教程存档别弄丢'。"
  first_principle: "LLM 是基于上下文预测下一个 token 的概率模型，prompt 决定了它'看到什么'就'生成什么'。Prompt 工程的本质是'用上下文工程化引导 LLM 的概率分布，让它更可能输出符合预期的结果'。"
  key_points:
  - "CoT（Chain-of-Thought）：让 LLM 分步推理，提升复杂问题准确率"
  - "ReAct：Thought-Action-Observation 循环，推理+工具调用"
  - "Few-shot：给范例对齐格式/风格/逻辑"
  - "结构化输出：JSON schema/Function Calling 约束输出格式"
  - "Prompt 版本管理：像代码一样版本化+评测+灰度"
  socratic:
  - "直接问 LLM 一个复杂数学题，和让它'一步步想'，结果差多少？"
  - "要 LLM 调工具，怎么让它知道什么时候调、调完怎么用？"
  - "LLM 输出格式乱七八糟，下游没法解析，怎么约束？"
  - "改了一版 prompt 好像变好了又好像变差了，怎么科学判断？"
  - "Few-shot 给几个例子才合适？给多了有用吗？"
first_principle:
  problem: "如何用上下文工程化引导 LLM 稳定输出符合预期的结果？"
  axioms:
  - "LLM 是基于上下文预测 token 的概率模型"
  - "prompt 决定 LLM '看到什么就生成什么'"
  - "复杂任务/格式约束需特定技巧"
  rebuild: "CoT 引导分步推理提准确率，ReAct 让推理+工具循环，Few-shot 给范例对齐，结构化输出（schema/Function Calling）约束格式，版本管理+评测让 prompt 可演进，把'调 API'变成可工程化的上下文编程。"
follow_up:
- "CoT 为什么有效？——分步推理让 LLM 把复杂问题拆成简单步，每步预测更准（中间 token 给模型思考空间）；Zero-shot CoT（'一步步想'）也有效。"
- "结构化输出怎么保证可靠？——Function Calling/JSON mode + schema 校验 + 失败重试 + 兜底解析；不要纯靠 prompt 提示（不稳）。"
- "Prompt 版本怎么管？——Git/专门平台存版本，绑定评测集，变更触发回归，灰度上线，A/B 验证（见025 LLMOps）。"
memory_points:
- "CoT 分步推理提准确率"
- "ReAct：Thought-Action-Observation"
- "Few-shot 对齐格式/逻辑"
- "结构化输出 + 版本管理"
---

# 【生物医药 AI】Prompt 工程怎么进阶（CoT/ReAct/Few-shot/结构化输出/版本管理）？

> JD 依据："Prompt 工程；LLM 应用开发。"

## 一、Prompt 工程的本质

```
LLM：基于上下文预测下一个 token（概率模型）
prompt = 你给 LLM 的全部上下文
→ prompt 决定 LLM 看到什么、生成什么
→ Prompt 工程就是"用上下文工程化引导概率分布"
```

## 二、CoT（Chain-of-Thought，思维链）

### 原理
```
直接问：
  "某患者剂量怎么算？" → LLM 直接答（可能错）

CoT：
  "一步步推理：
   1. 患者体重、肾功能
   2. 按指南公式
   3. 计算..."
  → 分步推理，每步更准，最终更对
```
- **原理**：分步让模型有"思考 token"空间，每步预测更准。
- **Zero-shot CoT**：加"Let's think step by step"也有效。
- **适合**：数学、推理、复杂判断。

## 三、ReAct（Reasoning + Acting）

```
循环：Thought（思考）→ Action（调工具）→ Observation（观察结果）

Thought: 用户问药物相互作用，我需要查药品库
Action: search_interaction("阿司匹林", "华法林")
Observation: {risk: "高出血风险", source: "..."}
Thought: 查到高风险，需提示医生
Action: generate_answer(...)
```
- 推理和工具调用交织，LLM 边想边查。
- 现代实现：Function Calling 结构化 Action（见003）。

## 四、Few-shot（少样本示例）

```
给范例对齐格式/风格/逻辑：
  示例1：输入X → 输出Y（按格式）
  示例2：输入X' → 输出Y'
  现在：输入X'' → ?
→ LLM 照范例模式生成
```
- **作用**：对齐输出格式、风格、逻辑模式。
- **数量**：2-5 个通常够，多了边际递减还费 token。
- **选例**：选有代表性的、和当前任务相似的、多样的（覆盖边界情况）。

## 五、结构化输出

### 问题
```
LLM 自由生成 → 格式乱（"答案是：阿司匹林"vs"阿司匹林"）
→ 下游解析困难
```

### 方案
```
1. JSON Mode：约束输出为合法 JSON
2. Function Calling：输出符合 schema 的结构化调用
3. Schema 校验：JSON Schema 验证 + 失败重试
4. 格式约束 prompt：明确要求格式 + 范例
```
```python
# 用 Function Calling 强约束
tools = [{
    "name": "drug_advice",
    "parameters": {
        "drug": "string",
        "advice": "string",
        "confidence": "number",
        "citation": "string"
    }
}]
# LLM 输出严格符合 schema，下游可解析
```

## 六、Prompt 版本管理（工程化）

```
prompt 像代码一样管：
  - 版本化（Git/专门平台，如 LangSmith/Promptfoo）
  - 绑定评测集（每次变更跑回归）
  - 灰度发布（A/B 验证）
  - 变更记录（为什么改、改了什么、效果）

流程：
  改 prompt → 跑评测集（不能退化）→ 灰度 → 全量 → 监控
```
不管理的 prompt 是黑盒，改一次可能引入回归都不知道。

## 七、Prompt 组合实战

```
医药咨询 Agent prompt 组合：
  [角色]你是医药咨询助手，仅基于资料回答并标注引用。
  [Few-shot]示例：问X→答Y（带引用格式）
  [工具]可用：search_drug, check_interaction
  [ReAct]一步步思考，需要时调工具
  [约束]不确定要说明，结构化输出{drug, advice, citation}
  [CoT]复杂问题分步推理
```

## 八、Prompt 调试技巧

- **明确具体**：模糊指令（"写好点"）效果差，具体（"用三段、每段<50字、带数据"）好。
- **角色设定**：给 LLM 角色（"你是资深药师"）约束风格。
- **负面约束**：明确不要做什么（"不要编造文献"）。
- **分隔符**：用 ``` 或 XML 标签分隔指令和内容。
- **迭代调试**：基于失败 case 逐步改进，记入评测集。

## 九、底层本质

Prompt 工程本质是**"用上下文工程化引导 LLM 的概率分布"**。CoT 引导分步推理，ReAct 让推理+工具，Few-shot 对齐模式，结构化输出约束格式，版本管理让 prompt 可演进。

**Prompt 不是'写句话'，而是'用自然语言编程'** —— 工程化的 prompt 管理是 LLM 应用可靠的基础。

## 常见考点

1. **CoT 什么时候有用？**——多步推理/数学/复杂判断有用；简单事实问答没必要（反而费 token 还可能跑偏）。
2. **结构化输出怎么可靠？**——Function Calling/JSON mode 强约束 + schema 校验 + 失败重试 + 兜底解析；纯 prompt 提示不稳定，不能依赖。
3. **Prompt 改了怎么知道好坏？**——评测集回归（离线）+ 灰度 A/B（在线）+ 监控质量指标，不能凭感觉，要数据驱动。


## 结构化回答

**30 秒电梯演讲：** 聊到Prompt 工程怎么进阶，我的理解是——Prompt 工程是'用自然语言编程 LLM'——CoT 让它分步推理，ReAct 让它边想边调工具，Few-shot 给范例对齐格式，结构化输出约束格式，版本管理让 prompt 像代码一样可演进。打个比方，像教新人干活——CoT 是'别急着想清楚一步步来'，ReAct 是'边查资料边思考'，Few-shot 是'先看几个例子照着做'，结构化输出是'按这个表格填'，版本管理是'上次有效的教程存档别弄丢'。

**展开框架：**
1. **CoT（Chain-of-Thought）** — 让 LLM 分步推理，提升复杂问题准确率
2. **ReAct** — Thought-Action-Observation 循环，推理+工具调用
3. **Few-shot** — 给范例对齐格式/风格/逻辑

**收尾：** 这块我在项目里也踩过坑——想深入的话，可以接着聊：CoT 为什么有效？您更想看哪个方向？

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡 | "Prompt 工程怎么进阶——这道题面试官到底想考什么？我用 30 秒给你讲透。" | 开场钩子 |
| 0:15 | Prompt 模板代码截图 | 先说核心：Prompt 工程是'用自然语言编程 LLM'——CoT 让它分步推理，ReAct 让它边想边调工具，Few-shot 给范例对齐格式，结构化输出约束格式，版本管理让 prom。 | 核心定义 |
| 0:40 | 概念结构示意图 | Thought-Action-Observation 循环，推理+工具调用。 | ReAct |
| 1:05 | 流程图 | 给范例对齐格式/风格/逻辑。 | Few-shot |
| 2:30 | 总结卡 | 一句话记忆：CoT 分步推理提准确率。 下期可以接着聊：CoT 为什么有效。 | 收尾总结 |
