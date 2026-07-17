---
id: boss-ai-036
difficulty: L3
category: boss-ai
subcategory: Prompt 工程
tags:
- 巨剧核
- AI 陪伴
- Prompt 工程
- CoT
- ReAct
- Few-shot
- 结构化输出
feynman:
  essence: "Prompt 工程进阶是用 CoT（思维链）/ReAct（推理+行动）/Few-shot（范例）/结构化输出等技巧，把'写自然语言问 LLM'升级为'用结构化策略引导 LLM 高质量推理和输出'。"
  analogy: "像教徒弟解题——直接给题（朴素 prompt）徒弟乱做；教他先列已知再推导（CoT）、遇到缺信息会查资料（ReAct）、给几个例题照着学（Few-shot）、要求最后写标准格式答案（结构化），质量天差地别。"
  first_principle: "LLM 是基于上下文预测 token 的概率模型，prompt 决定了它'怎么想、怎么答'。结构化、引导式 prompt 能激活模型的最佳推理路径，把'碰运气'升级为'可控高质量生成'。"
  key_points:
  - "CoT（思维链）：让 LLM 先列推理步骤再答，提升复杂题"
  - "ReAct：推理（Thought）+行动（Action）+观察（Observation）循环"
  - "Few-shot：给范例引导风格/格式/思路"
  - "结构化输出：JSON/Markdown 强约束格式"
  - "组合用：CoT+Few-shot+结构化，按场景调"
  socratic:
  - "同一个问题，'算一下 17×24'和'请一步步算 17×24'，LLM 回答质量会差多少？为什么？"
  - "LLM 答错了，你让它'再想想'还是换个问法？哪种更有效？"
  - "让 LLM 直接输出 JSON，它经常格式乱，怎么强制它规规矩矩？"
  - "用户问需要查实时信息的问题，LLM 不知道，但 ReAct 怎么让它'自己去查'？"
  - "Few-shot 给几个例子最好？给多了会怎样？"
first_principle:
  problem: "如何用 prompt 技巧激活 LLM 的最佳推理路径，让它高质量、可控、可预期地完成任务？"
  axioms:
  - "LLM 是基于上下文预测 token 的概率模型"
  - "Prompt 决定 LLM 怎么想怎么答"
  - "结构化/引导式 prompt 优于自然语言随性提问"
  rebuild: "用 CoT 引导推理 + ReAct 接工具 + Few-shot 给范例 + 结构化输出强约束，组合使用按场景调，把'碰运气式提问'升级为'策略式引导'。"
follow_up:
- "CoT 为什么有效？——强制 LLM 把推理过程显式写出来，每步基于前步上下文预测，减少跳步出错；类似人脑'想清楚再说'。"
- "ReAct 和 Tool Calling 啥关系？——ReAct 是'推理+行动'范式（Thought/Action/Observation 循环）；Tool Calling 是工程实现；ReAct 用 Tool Calling 落地。"
- "结构化输出怎么保证 JSON 不挂？——强 prompt 指令 + JSON Schema 约束 + grammar-constrained decoding（vLLM/outlines）+ 解析失败重试。"
memory_points:
- "CoT：先推理再答"
- "ReAct：Thought/Action/Observation 循环"
- "Few-shot：范例引导"
- "结构化输出：JSON/Schema 约束"
---

# 【巨剧核 AI 陪伴】Prompt 工程进阶（CoT/ReAct/Few-shot/结构化）？

> JD 依据："熟悉 Prompt 工程进阶：CoT、ReAct、Few-shot、结构化输出。"

## 一、为什么朴素 prompt 不够

```
朴素：
  Q: "用户说想死，怎么回？"
  A: LLM 自由发挥 → 可能说教/可能不当回事/质量随机

进阶：
  - CoT：让 LLM 先分析用户情绪和需求，再生成回复
  - Few-shot：给几个"丧亲/抑郁/危机"的优秀回复范例
  - 结构化：要求输出 {emotion:..., strategy:..., reply:...}
  - 结果：质量稳定可控
```

## 二、CoT（Chain of Thought，思维链）

```
朴素：
  Q: 17×24=?
  A: 408（可能错）

CoT：
  Q: 一步步算 17×24
  A: 
    17×24
    = 17×20 + 17×4
    = 340 + 68
    = 408
  （强制显式推理，准确率高）

触发方式：
  - "一步步思考"
  - "Let's think step by step"
  - "先分析...再回答..."
  - Zero-shot CoT（直接加触发语）
  - Few-shot CoT（范例里展示推理过程）

适用：
  数学/逻辑/复杂决策/规划
  AI 陪伴：情绪分析、关系判断、共情策略
```

## 三、ReAct（Reasoning + Acting）

```
范式：
  Thought（思考）：分析当前情况，决定下一步
  Action（行动）：调工具/查信息
  Observation（观察）：看工具返回
  循环直到解决

示例：
  用户："今天上海适合户外吗"
  
  Thought: 用户问户外适宜度，需要天气信息
  Action: get_weather(city=上海)
  Observation: 28度，PM2.5 30，无雨
  Thought: 温度舒适+空气好+无雨，适合户外
  Answer: 今天上海 28 度空气好无雨，很适合户外活动～
```

ReAct 让 LLM：
- 知道自己缺什么信息
- 主动调工具补全
- 基于结果再推理

本质：把"一次推理"扩展为"推理-行动-观察"的多步循环。

## 四、Few-shot Learning（范例引导）

```
Zero-shot：
  Q: 翻译"hello"
  A: 你好

Few-shot：
  Q: 苹果 → apple
     香蕉 → banana
     hello → ?
  A: 你好（但范例是翻译英文到中文，可能错乱）

正确 Few-shot：
  英文 → 中文翻译：
  apple → 苹果
  banana → 香蕉
  hello → ?
  A: 你好

要素：
  - 范例要和任务一致（同方向/同风格）
  - 数量 3-5 个够（多了 token 浪费/可能干扰）
  - 多样性（覆盖不同子场景）
  
AI 陪伴用例：
  范例展示：
    [用户情绪低落 → 共情响应风格]
    [用户愤怒 → 平和响应风格]
    [用户开心 → 共享开心]
  → LLM 学到风格应用到新场景
```

## 五、结构化输出

```
朴素：
  Q: 描述这个用户
  A: 自由文本（难以解析）

结构化：
  Q: 描述这个用户，输出 JSON：
     {
       name: string,
       age: number,
       interests: string[],
       personality: string
     }
  A: 严格 JSON（可程序解析）

保证 JSON 可靠：
  - 强 prompt 指令（"只输出 JSON，不要其他文字"）
  - JSON Schema 约束
  - grammar-constrained decoding（vLLM/outlines 强制语法）
  - 解析失败重试（带错误反馈）
  - 后处理（提取 JSON 部分）

AI 陪伴用例：
  LLM 输出：
    {
      text: "辛苦了～",
      emotion: "caring",
      action: "hug",
      tool_calls: [...]
    }
  程序直接解析后驱动多模态输出
```

## 六、组合策略

```
复杂场景 = CoT + Few-shot + 结构化 + ReAct

例：用户情感支持
  Prompt:
    [人设]
    [Few-shot: 共情范例]
    [CoT: 先分析用户情绪和需求]
    [结构化: 输出 {emotion, strategy, reply, need_tool}]
    [ReAct: 如 need_tool=true，调工具]
  
  输出：
    Thought: 用户表达丧亲悲痛，需要情感陪伴而非建议
    {
      emotion: "grief",
      strategy: "确认情绪+陪伴承诺+不急于建议",
      reply: "听到这个消息我很难过...",
      need_tool: false
    }
```

## 七、AI 陪伴的 prompt 策略

```
[1] 人设保持
    system prompt 强约束 + Few-shot 人设范例 + 人设一致性审核

[2] 共情响应
    CoT 引导"先理解情绪再回应" + Few-shot 共情范例

[3] 记忆引用
    prompt 注入召回记忆 + 引导 LLM 自然引用

[4] 多模态输出
    结构化（text/emotion/action/tool）+ 驱动多模态管线

[5] 安全边界
    system prompt 强边界 + 输出审核
```

## 八、进阶技巧

```
Self-Consistency：
  多次 CoT 推理 → 投票多数派
  提升准确率（贵）

Tree of Thoughts：
  探索多个推理分支 + 评估选最佳
  适合规划/创意

Reflexion：
  生成 → 自评 → 改进
  迭代提升质量

Prompt Chaining：
  复杂任务拆成多 prompt 链
  每 prompt 专做一件事
```

## 九、prompt 调优方法

```
[1] 评测集回归
    维护 bad case 集
    每次改 prompt 跑评测

[2] A/B 测试
    线上对比新旧 prompt
    看业务指标

[3] 自动优化
    DSPy/AutoPrompt 自动调
    基于评测集自动改

[4] LLM-Judge
    用强模型评 prompt 输出质量
    大规模评测
```

## 十、底层本质

Prompt 工程进阶的本质是**"用结构化策略激活 LLM 最佳推理路径"**：

- CoT = 引导显式推理
- ReAct = 接工具的多步循环
- Few-shot = 范例学风格
- 结构化 = 输出可控可解析

这是把'自然语言随性提问'升级为'策略式引导'——prompt 是 AI 产品的'源代码'，写好 prompt 等于写好核心逻辑。

## 常见考点

1. **CoT 万能吗？**——不。简单任务 CoT 反而冗余（"你好"不需要推理）；某些任务 CoT 可能让 LLM 越想越错（强模型有时直觉比推理准）；要按任务选。
2. **Few-shot 范例从哪来？**——业务积累（bad case 改造成范例）+ 人工精选 + LLM 生成筛选；范例要持续更新和优化。
3. **结构化输出和 function calling 关系？**——function calling 是结构化输出的一种特化（输出 tool_call 结构）；通用结构化输出用 JSON Schema + grammar decoding；两者底层都是约束 LLM 输出格式。


## 结构化回答

**30 秒电梯演讲：** 聊到Prompt 工程进阶，我的理解是——Prompt 工程进阶是用 CoT（思维链）/ReAct（推理+行动）/Few-shot（范例）/结构化输出等技巧，把'写自然语言问 LLM'升级为'用结构化策略引导 LLM 高质量推理和输出'。打个比方，像教徒弟解题——直接给题（朴素 prompt）徒弟乱做；教他先列已知再推导（CoT）、遇到缺信息会查资料（ReAct）、给几个例题照着学（Few-shot）、要求最后写标准格式答案（结构化），质量天差地别。

**展开框架：**
1. **CoT（思维链）** — 让 LLM 先列推理步骤再答，提升复杂题
2. **ReAct** — 推理（Thought）+行动（Action）+观察（Observation）循环
3. **Few-shot** — 给范例引导风格/格式/思路

**收尾：** 这块我在项目里也踩过坑——想深入的话，可以接着聊：CoT 为什么有效？您更想看哪个方向？

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡 | "Prompt 工程进阶——这道题面试官到底想考什么？我用 30 秒给你讲透。" | 开场钩子 |
| 0:15 | Prompt 模板代码截图 | 先说核心：Prompt 工程进阶是用 CoT（思维链）/ReAct（推理+行动）/Few-shot（范例）/结构化输出等技巧，把'写自然语言问 LLM'升级为'用结构化策略引导 LLM 。 | 核心定义 |
| 0:40 | 概念结构示意图 | 推理（Thought）+行动（Action）+观察（Observation）循环。 | ReAct |
| 1:05 | 流程图 | 给范例引导风格/格式/思路。 | Few-shot |
| 2:30 | 总结卡 | 一句话记忆：CoT：先推理再答。 下期可以接着聊：CoT 为什么有效。 | 收尾总结 |
