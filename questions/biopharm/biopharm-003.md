---
id: biopharm-003
difficulty: L4
category: biopharm
subcategory: MCP 协议
tags:
- 生物医药
- AI 全栈
- Tool Calling
- Function Calling
- MCP 协议
- 工具调用
feynman:
  essence: "Tool/Function Calling 让 LLM 学会'调外部工具'；MCP 是把工具的接入标准化——像 USB 一样，工具实现一次，任意模型/Agent 即插即用。"
  analogy: "Function Calling 是'教会模型打电话'（指定函数名+参数）；MCP 是'统一电话插座标准'——任何手机（模型）插任何座机（工具）都能打通，不用每对都定制线。"
  first_principle: "LLM 只懂训练数据里的文本，无法实时查数据、调 API、操作外部系统。要让它连接现实世界，必须定义'模型如何表达调用意图'（Function Calling）和'工具如何标准化暴露'（MCP）两层协议。"
  key_points:
  - "Function Calling：模型输出结构化 JSON（函数名+参数），由宿主执行后回填"
  - "Tool Calling = Function Calling 的通用叫法（OpenAI 用 Function，Anthropic 用 Tool）"
  - "MCP（Model Context Protocol）：标准化工具/资源/Prompt 的暴露与发现协议"
  - "安全：参数校验 + 权限 + 白名单 + 审计 + 人工确认（高危工具）"
  - "并行/循环/嵌套：现代 Agent 支持多工具并发和工具结果驱动下一步"
  socratic:
  - "LLM 怎么知道该调哪个工具？谁来告诉它有哪些工具？"
  - "模型输出的调用参数如果错了（比如传了非法值），怎么防？"
  - "每接一个新工具都要改 Agent 代码，有没有更解耦的方式？"
  - "MCP 比自己写 Function Calling 集成多了什么好处？"
  - "高危工具（如修改病历/发药）直接让模型调用，风险在哪？"
first_principle:
  problem: "如何让 LLM 安全、标准、可复用地连接和调用外部工具/系统？"
  axioms:
  - "LLM 只懂文本，无法直接操作外部世界（DB/API/系统）"
  - "工具多样且不断新增，硬编码集成不可持续"
  - "工具调用有风险（副作用/越权/错误参数），必须可控可审计"
  rebuild: "分两层——Function Calling 让模型用结构化 JSON 表达调用意图；MCP 把工具按统一协议（server）暴露，client（Agent/模型）动态发现并调用，实现工具与模型的解耦。"
follow_up:
- "Function Calling 和 ReAct 的关系？——ReAct 是'推理+行动'的 prompt 范式（Thought/Action/Observation），Function Calling 是其结构化实现，两者常结合。"
- "MCP 的 server/client/transport？——server 暴露 Tools/Resources/Prompts，client（如 Claude Desktop/IDE）连接，transport 用 stdio 或 HTTP+SSE。"
- "医药工具有哪些？——药品库查询、相互作用检查、临床指南检索、检验值解读、文献检索；常包装成 MCP server 统一供 Agent 调用。"
memory_points:
- "Function Calling = 模型输出结构化调用意图"
- "MCP = 工具的 USB 标准，解耦工具与模型"
- "工具安全四件套：校验+权限+白名单+审计"
- "高危工具必须人工二次确认"
---

# 【生物医药 AI】Tool Calling / Function Calling / MCP 协议怎么落地？

> JD 依据："Harness、Skills、Workflow、Tool Calling、Function Calling、MCP。"

## 一、为什么需要工具调用

裸 LLM：
```
"查一下阿司匹林和某药的相互作用" → LLM 只能凭训练记忆答（可能过时/编造）
```

加了工具：
```
LLM 输出：{tool: "drug_interaction", args: {a: "阿司匹林", b: "华法林"}}
宿主执行工具 → 返回真实结果 → LLM 基于结果生成准确答案
```

LLM 从"凭记忆"升级为"查实时数据"。

## 二、Function Calling（函数调用）

模型被约定可以输出**结构化调用 JSON**，宿主执行后把结果回填：

```python
tools = [{
    "name": "search_drug",
    "description": "按药品名查询药品说明书",
    "parameters": {"drug_name": "string", "version": "string?"}
}]
# LLM 返回：{"name":"search_drug","arguments":{"drug_name":"阿司匹林"}}
result = execute(result)          # 宿主执行
answer = llm.final_answer(result) # 基于结果生成
```

- **OpenAI** 叫 Function Calling，**Anthropic** 叫 Tool Use，本质都是"模型输出结构化调用意图"。
- 模型本身**不执行**工具，只表达"我想调这个"；执行权和安全控制在宿主手里。

## 三、MCP（Model Context Protocol）

Function Calling 的问题：每接一个工具都要在 Agent 里写适配代码，N 个模型 × M 个工具 = N×M 种集成。

**MCP 的解法：标准化** —— 像 USB 一样：

```
[模型/Agent (MCP client)] ←─ MCP 协议 ─→ [工具服务器 (MCP server)]
                                        暴露 Tools / Resources / Prompts
```

- 工具方写一次 MCP server（暴露能力），任何支持 MCP 的 client（Claude Desktop / IDE / Agent）都能即插即用。
- 把 N×M 降为 N+M。

**MCP 三类能力**：
- **Tools**：可执行函数（查询/操作）。
- **Resources**：可读数据（文件/DB 记录）。
- **Prompts**：可复用的 prompt 模板。

## 四、工具调用的安全（企业级硬约束）

```
模型决定调工具
   ↓
[1] 白名单：只允许已注册工具
   ↓
[2] 参数校验：schema 校验 + 业务校验（值域/类型）
   ↓
[3] 权限控制：按租户/角色限制可调工具和数据范围
   ↓
[4] 高危确认：写操作/敏感数据 → 人工二次确认
   ↓
[5] 审计日志：谁、何时、调了什么、参数、结果
   ↓
执行 → 回填
```

**医药高危场景**：修改病历、发药建议、导出患者数据 —— 必须人工确认 + 全程审计。

## 五、并行与编排

现代 Agent 支持：
- **并行调用**：一轮里同时调多个无依赖工具（如同时查药品库+指南+文献）。
- **循环/条件**：工具结果驱动下一步（如查不到 → 换关键词重查）。
- **嵌套**：一个工具触发另一个（编排引擎/Workflow 管）。

## 六、底层本质

工具调用本质是**"给 LLM 装上手和眼"**——Function Calling 定义了"手怎么动"（结构化意图），MCP 定义了"手和工具怎么连接"（标准协议）。两者合起来，把 LLM 从"文本盒子"变成"能操作现实世界的 Agent"。

**企业级的关键不在'能调通'，而在'安全、可审计、可复用'** —— 这正是 MCP 标准化的价值。

## 常见考点

1. **Function Calling 怎么保证参数正确？**——JSON schema 约束 + 宿主二次校验 + 失败反馈让模型修正。
2. **MCP 和 Function Calling 矛盾吗？**——不矛盾，MCP 是工具暴露/发现的传输与注册标准，Function Calling 是模型表达调用的语义，MCP server 内部仍用 function 描述工具。
3. **怎么防止模型乱调高危工具？**——白名单 + 权限 + 人工确认 + 审计 + 工具调用配额。


## 结构化回答

**30 秒电梯演讲：** 聊到Tool Calling / Function Call，我的理解是——Tool/Function Calling 让 LLM 学会'调外部工具'；MCP 是把工具的接入标准化——像 USB 一样，工具实现一次，任意模型/Agent 即插即用。打个比方，Function Calling 是'教会模型打电话'（指定函数名+参数）；MCP 是'统一电话插座标准'——任何手机（模型）插任何座机（工具）都能打通，不用每对都定制线。

**展开框架：**
1. **Function Calling** — 模型输出结构化 JSON（函数名+参数），由宿主执行后回填
2. **Tool Calling = Fun** — Tool Calling = Function Calling 的通用叫法（OpenAI 用 Function，Anthropic 用 Tool）
3. **MCP（Model Context** — MCP（Model Context Protocol）：标准化工具/资源/Prompt 的暴露与发现协议

**收尾：** 这块我在项目里也踩过坑——想深入的话，可以接着聊：Function Calling 和 ReAct 的关系？您更想看哪个方向？

## 视频脚本

> 预计时长：4 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡 | "Tool Calling / Function Ca——这道题面试官到底想考什么？我用 30 秒给你讲透。" | 开场钩子 |
| 0:15 | Tool Calling 流程图 | 先说核心：Tool/Function Calling 让 LLM 学会'调外部工具'；MCP 是把工具的接入标准化——像 USB 一样，工具实现一次，任意模型/Agent 即插即用。 | 核心定义 |
| 0:50 | 概念结构示意图 | Tool Calling = Function Calling 的通用叫法（OpenAI 用 Function，Anthropic 用 Tool）。 | Tool Calling = Fun |
| 1:20 | 流程图 | MCP（Model Context Protocol）：标准化工具/资源/Prompt 的暴露与发现协议。 | MCP（Model Context |
| 1:50 | 安全防御架构图 | 参数校验 + 权限 + 白名单 + 审计 + 人工确认（高危工具）。 | 安全 |
| 3:30 | 总结卡 | 一句话记忆：Function Calling = 模型输出结构化调用意图。 下期可以接着聊：Function Calling 和 ReAct 的关系。 | 收尾总结 |
