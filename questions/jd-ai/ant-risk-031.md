---
id: ant-risk-031
difficulty: L4
category: jd-ai
subcategory: Agent 改造
tags:
- 蚂蚁
- 风控
- AI Agent
- LLM
- 系统设计
feynman:
  essence: 用 AI Agent 改造风控系统，把"固定 DAG 决策"升级为"Agent 自主编排"——LLM 做意图理解+工具调用，规则和模型变成 Agent 的工具，决策更灵活、配置更自然。
  analogy: 传统风控像自动售货机（按钮→固定流程），AI Agent 风控像便利店店员（理解需求→灵活组合商品→应对新场景）。
  first_principle: 传统规则引擎是"if-then"硬编码，新型欺诈层出不穷难维护；LLM 有泛化能力，能理解场景语义、动态组合工具，让"防欺诈"从"配置规则"变成"对话决策"。
  key_points:
  - Agent 架构：LLM + 工具（规则/模型/特征）+ 记忆 + 规划
  - ReAct 模式：思考→行动→观察循环
  - Multi-Agent：决策 Agent、复核 Agent、解释 Agent 协作
  - 工具化：把规则引擎、模型、关系网络包装成 Agent 可调用的工具
first_principle:
  problem: 传统风控规则引擎难应对新型欺诈（规则需人工配置），如何用 AI Agent 让风控决策更智能、更灵活、更易扩展？
  axioms:
  - LLM 有泛化能力（理解新场景）
  - 工具调用让 LLM 能执行具体动作
  - Multi-Agent 协作能拆解复杂决策
  rebuild: Agent 架构——LLM 做意图理解和决策编排，把规则/模型/特征/关系网络包装成 MCP 工具，Agent 自主选择调用，多 Agent 协作完成决策。
follow_up:
- LLM 推理慢（秒级）怎么实时风控？——分层：简单场景规则秒级、复杂场景 Agent 异步复核
- 怎么防 LLM 幻觉？——结果验证（决策必须可解释）+ 工具结果约束 + 关键场景双 Agent 交叉验证
- Agent 和规则引擎冲突？——Agent 编排规则（而非替代），规则做硬约束、Agent 做软判断
memory_points:
- Agent = LLM + 工具 + 记忆 + 规划
- ReAct：思考→行动→观察循环
- 把规则/模型/特征包装成 MCP 工具，Agent 自主调用
- 实时链路分层：简单走规则（毫秒）、复杂走 Agent 复核（秒）
---

# 【蚂蚁风控】如何用 AI Agent 改造风控系统？

> JD 依据："大模型、机器学习"前瞻探索。这是 AI 转型的核心方向。

## 一、传统风控的痛点

**规则引擎的局限**：
- 规则靠人工配置，新型欺诈滞后
- 规则数到几千条后维护困难
- 跨场景规则冲突难调和
- 决策逻辑僵化（无法应对"看似正常但实际异常"的复杂场景）

**模型的局限**：
- 黑盒，监管不接受
- 训练数据滞后（新欺诈样本少）
- 单模型覆盖面有限

## 二、AI Agent 风控的核心理念

**从"固定 DAG"到"Agent 自主编排"**：
```
传统风控：
  名单 → 特征 → 规则 → 模型 → 决策（固定流程）

Agent 风控：
  LLM 接收事件 → 理解场景 → 自主选择工具（特征/规则/模型/关系）→ 综合决策
```

**Agent 的优势**：
- 理解语义（"深夜大额转账到陌生账户"是风险，不用规则写死）
- 灵活组合（不同场景调不同工具）
- 自然语言配置（运营说人话，Agent 翻译）
- 自主推理（新型欺诈无需预先定义规则）

## 三、Agent 架构

```
┌────────────────────────────────────────────────┐
│              决策 Agent（LLM）                │
│  理解事件 → 规划 → 调工具 → 综合 → 决策       │
└────────────────────────────────────────────────┘
              ↓ 调用（MCP 工具）
┌────────────────────────────────────────────────┐
│                工具层（MCP Server）             │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│  │特征查询  │ │规则匹配  │ │模型推理  │       │
│  │Tool      │ │Tool      │ │Tool      │       │
│  └──────────┘ └──────────┘ └──────────┘       │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│  │关系网络  │ │黑名单查询│ │历史案件  │       │
│  │Tool      │ │Tool      │ │Tool      │       │
│  └──────────┘ └──────────┘ └──────────┘       │
└────────────────────────────────────────────────┘
              ↓ 结果
┌────────────────────────────────────────────────┐
│                记忆层                          │
│  短期：本次决策上下文                          │
│  长期：用户历史决策、典型案件                  │
└────────────────────────────────────────────────┘
```

## 四、ReAct 模式（决策过程）

**ReAct = Reasoning + Acting**，Agent 思考-行动-观察的循环：

```
事件：用户 A 深夜给陌生账户转账 5 万

Agent 思考 1：这是大额夜间转账，需要查用户画像
Agent 行动 1：调用 profileTool(uid=A)
Agent 观察 1：A 是新注册 3 天的账户，无历史交易

Agent 思考 2：新账户大额转账，风险高，查收款方
Agent 行动 2：调用 relationTool(uid=A, target=B)
Agent 观察 2：A 和 B 无历史关系，B 是高风险账户（已被标记）

Agent 思考 3：高风险收款方 + 新账户 + 大额夜间 → 强风险信号
Agent 行动 3：调用 modelTool(event) 算综合分
Agent 观察 3：模型分 0.92（高风险）

Agent 决策：拦截，理由：新账户+夜间+大额+高风险收款方
```

## 五、Multi-Agent 协作

**单 Agent 局限**：决策链长、上下文大、易幻觉。

**Multi-Agent 分工**：

```
┌──────────────────┐
│  Coordinator     │  ← 接入 Agent，理解事件、分派
│  Agent           │
└────────┬─────────┘
         │
    ┌────┼────┐
    ▼    ▼    ▼
┌──────┐┌──────┐┌──────┐
│情报  ││决策  ││复核  │
│Agent ││Agent ││Agent │
└──────┘└──────┘└──────┘
  查特征  规则+模型  交叉验证
  查关系  综合决策  解释生成
```

**职责**：
- **Coordinator**：理解事件、决定调用哪些 Agent
- **情报 Agent**：收集特征、关系、历史
- **决策 Agent**：综合情报做决策
- **复核 Agent**：交叉验证、生成解释、防幻觉

## 六、实时性挑战与解法

**问题**：LLM 推理慢（秒级），实时决策要求 < 200ms。

**解法：分层决策**：
```
所有事件 →
  ├─ 简单场景（黑名单、明显规则命中）→ 毫秒级规则
  └─ 复杂场景（边缘案例）→ Agent 决策（秒级）

进一步：
  ├─ 实时拦截（明显风险）→ 规则毫秒
  ├─ 异步复核（可疑案例）→ Agent 秒级
  └─ 离线深度（新型模式）→ Agent 离线分析
```

**预计算 Agent 分**（提速）：
- 离线用 Agent 跑全量用户，算"风险预分"
- 缓存 Redis，决策时 O(1) 查
- 在线 Agent 只看动态特征

## 七、防幻觉与可解释

**幻觉风险**：
- LLM 可能"编造"特征值
- 决策理由可能不符合实际
- 监管不接受不可解释决策

**防幻觉设计**：
1. **工具结果约束**：Agent 只能基于工具返回的数据决策，不能编造
2. **决策双验证**：关键决策两个 Agent 交叉验证
3. **结构化输出**：强制 JSON schema 输出（决策 + 命中规则 + 引用工具结果）
4. **可解释链路**：保留完整 ReAct trace

```json
{
  "decision": "REJECT",
  "reasoning": [
    {"step": 1, "thought": "新账户大额夜间转账", "tool": "profileTool", "result": {...}},
    {"step": 2, "thought": "收款方高风险", "tool": "relationTool", "result": {...}}
  ],
  "confidence": 0.95
}
```

## 八、工具化（MCP Server）

**把风控组件包装成 MCP 工具**：
```python
@mcp.tool()
def query_profile(uid: str) -> dict:
    """查询用户画像"""
    return profile_service.get(uid)

@mcp.tool()
def query_relation(uid: str, depth: int = 2) -> dict:
    """查询关系网络（默认 2 跳）"""
    return graph_service.query(uid, depth)

@mcp.tool()
def match_rules(features: dict) -> list:
    """匹配专家规则，返回命中规则列表"""
    return rule_engine.match(features)

@mcp.tool()
def model_predict(event: dict) -> dict:
    """模型推理，返回风险分"""
    return model_service.predict(event)
```

**LLM 自动学会调工具**：
- 看到事件描述
- 决定调哪些工具（基于工具描述）
- 综合工具结果决策

## 九、自然语言配置（运营升级）

**传统**：运营学 DSL 配置规则。

**Agent 时代**：
```
运营：夜间大额转账到陌生账户要拦截
   ↓ Agent 翻译
LLM：转化为 DSL（amount > 阈值 && time ∈ [22,6] && relation == new）
   ↓ 自动生效
规则引擎：加载新规则

运营：最近发现中介用模拟器批量注册，怎么防？
   ↓ Agent 分析
LLM：建议增加"模拟器检测"特征 + "同设备注册数"规则
   ↓ 自动配置
```

## 十、和 AI Harness 的关系（见后续题）

Agent 是上层应用，**Harness 是底层基础设施**：
- Agent 调用 LLM → Harness 提供 LLM 推理服务
- Agent 调用工具 → Harness 提供工具执行环境
- Agent 监控 → Harness 提供可观测性

**风控平台的 AI Harness**：
- 统一 LLM 网关（多模型路由）
- 工具市场（注册、发现、调用）
- Agent 编排引擎
- 监控和评估

## 十一、底层本质：从"规则"到"推理"的范式转变

| 维度 | 规则风控 | Agent 风控 |
|------|---------|----------|
| 决策方式 | if-then | 推理 + 工具 |
| 应对未知 | 滞后（人工配规则） | 即时（泛化） |
| 配置方式 | DSL | 自然语言 |
| 解释性 | 强（命中哪条） | 中（推理 trace） |
| 速度 | 快（毫秒） | 慢（秒） |
| 成本 | 低 | 高（LLM 推理） |

**核心转变**：
- 规则：人写规则，机器执行
- Agent：人给目标，机器自主推理执行

**这是从"程序"到"智能体"的演进**——程序按既定逻辑跑，智能体理解目标自主决策。

## 十二、落地挑战与建议

**挑战**：
1. LLM 推理慢（实时性差）
2. 成本高（token 贵）
3. 幻觉（决策风险）
4. 监管（不可解释）

**落地建议**：
1. **混合架构**：规则为主 + Agent 为辅（边缘案例）
2. **分层异步**：实时规则 + 异步 Agent 复核
3. **降级预案**：Agent 挂了降级到规则
4. **逐步切流**：1% → 10% → 50% → 100% 灰度

## 常见考点
1. **LLM 推理慢怎么实时风控**？——分层：简单场景规则（毫秒）、复杂场景 Agent 异步复核（秒）；预计算 Agent 分缓存。
2. **Agent 决策和规则冲突谁优先**？——规则做硬约束（强拦截优先），Agent 做软判断（边缘案例）。
3. **怎么评估 Agent 风控效果**？——召回/精准/RT + 决策一致性（Agent vs 规则对比）+ 幻觉率。

**代码示例**（ReAct Agent 框架）：
```python
def react_agent(event, max_steps=5):
    context = {"event": event, "history": []}
    for step in range(max_steps):
        # LLM 思考下一步
        thought = llm.think(context, tools=available_tools)
        if thought.is_final:
            return thought.decision
        # 执行工具
        result = tools[thought.tool_name].run(thought.tool_args)
        context["history"].append({"thought": thought, "result": result})
    return Decision.fallback()  # 超过最大步数兜底
```
