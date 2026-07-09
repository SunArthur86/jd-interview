---
id: pdd-ai-038
difficulty: L4
category: pdd-ai
subcategory: Agent 架构
tags:
- 拼多多
- AI 中台
- 智能 AI 中台
- Agent 编排
- 多 Agent
- LangGraph
feynman:
  essence: 智能 AI 中台是"用 Agent 编排中台能力"，把传统中台（被动调 API）升级为"会思考、会自主调用、会协作"的智能平台。
  analogy: 像把传统中央厨房升级为智能厨房——之前厨师（业务）按菜谱做菜（调 API），现在智能主厨（Agent）按订单自主调度食材/调料/工序，多 Agent 协作出宴席。
  first_principle: 中台能力成熟 + LLM 推理能力 + Function Calling → Agent 能自主完成之前要人编排的复杂任务。
  key_points:
  - 编排框架：LangGraph/AutoGen/自研
  - 多 Agent 协作：Planner/Worker/Critic
  - 状态管理：共享状态/记忆
  - 工具注册：中台能力标准化为 Tool
  - 监控治理：Agent 行为可观测
first_principle:
  problem: 怎么让 Agent 编排中台完成复杂任务？
  axioms:
  - 单 Agent 能力有限
  - 中台能力丰富但需编排
  - 任务复杂需要分工
  rebuild: 智能 AI 中台（多 Agent + 编排 + 中台工具化 + 治理）。
follow_up:
  - 多 Agent 怎么分工？——按职能（规划/执行/审查）+ 按域（业务/数据/算法）
  - 怎么保证 Agent 决策正确？——工具白名单 + 约束规则 + 人工兜底 + 监控
  - Agent 编排和工作流引擎区别？——工作流是固定 DAG，Agent 是动态决策（更灵活但更难控）
memory_points:
  - 框架：LangGraph/AutoGen/自研
  - 多 Agent：Planner/Worker/Critic
  - 中台能力 → Tool
  - 状态：共享记忆
---

# 【拼多多 AI 中台】智能 AI 中台（Agent 编排）怎么设计？

> JD 依据："消费者服务策略算法中台、Agent 编排"。

## 一、从传统中台到智能中台

```
传统中台：
  业务方 → 调特征 API → 调模型 API → 调规则 API → 拼结果
  人写编排逻辑（Java 代码）

智能中台：
  用户："分析下最近数码 GMV 跌的原因"
  Agent 自主：
    1. 查指标（GMV 趋势）
    2. 查实验（哪个实验影响）
    3. 查特征（用户画像漂移）
    4. 综合分析
    5. 生成报告

  Agent 替代人写编排逻辑
```

## 二、架构

```
┌────────────────────────────────────────────────────┐
│ 用户交互层（Chat/IDE/API）                         │
└────────────────────┬───────────────────────────────┘
                     │
┌────────────────────▼───────────────────────────────┐
│ Agent 编排层                                       │
│ - Router（意图识别 → 选 Agent）                    │
│ - Planner（拆解任务）                              │
│ - Worker（执行子任务）                             │
│ - Critic（审查）                                   │
│ - Memory（共享状态/历史）                          │
└────────────────────┬───────────────────────────────┘
                     │ Function Calling
┌────────────────────▼───────────────────────────────┐
│ 中台工具层（Tool Registry）                        │
│ - 特征查询（get_features）                         │
│ - 模型推理（invoke_model）                         │
│ - 规则执行（eval_rule）                            │
│ - 实验查询（get_variant）                          │
│ - 数据分析（query_metric）                         │
│ - LLM 调用（llm_chat）                             │
│ - RAG 检索（rag_search）                           │
└────────────────────┬───────────────────────────────┘
                     │
┌────────────────────▼───────────────────────────────┐
│ 中台能力层（特征/模型/规则/实验/LLM）              │
└────────────────────────────────────────────────────┘
```

## 三、Agent 编排模式

### 1. 单 Agent（简单任务）
```
LLM + Tools + ReAct 循环
适合：单一领域任务（查订单/查指标）
```

### 2. Plan-and-Execute（复杂任务）
```
Planner 拆解任务 → Workers 并行执行 → 综合结果
适合：多步分析/报告生成
```

### 3. 多 Agent 协作（最复杂）
```
角色分工：
- Orchestrator：总指挥
- Researcher：查资料
- Analyst：分析数据
- Writer：写报告
- Critic：审查质量

消息传递 + 共享状态
适合：复杂业务流程
```

### 4. Supervisor 模式
```
Supervisor Agent 管理多个专家 Agent
按任务路由到对应专家
```

## 四、LangGraph 编排

```python
from langgraph.graph import StateGraph, END

class AgentState(TypedDict):
    query: str
    plan: list
    current_step: int
    results: dict
    final_answer: str

def planner(state):
    plan = llm.plan(state["query"])
    return {"plan": plan, "current_step": 0}

def worker(state):
    step = state["plan"][state["current_step"]]
    result = execute_tool(step)
    state["results"][step["id"]] = result
    return {"current_step": state["current_step"] + 1, "results": state["results"]}

def critic(state):
    if not quality_ok(state["results"]):
        return {"plan": revise_plan(state)}     # 重规划
    return {}

def should_continue(state):
    if state["current_step"] < len(state["plan"]):
        return "worker"
    return "synthesizer"

graph = StateGraph(AgentState)
graph.add_node("planner", planner)
graph.add_node("worker", worker)
graph.add_node("critic", critic)
graph.add_node("synthesizer", synthesize)

graph.set_entry_point("planner")
graph.add_edge("planner", "worker")
graph.add_conditional_edges("worker", should_continue)
graph.add_edge("critic", "worker")
graph.add_edge("synthesizer", END)

app = graph.compile()
```

## 五、多 Agent 协作模式

### AutoGen 风格
```python
from autogen import AssistantAgent, UserProxyAgent, GroupChat

researcher = AssistantAgent("researcher", system_message="查资料，调特征/数据 API")
analyst = AssistantAgent("analyst", system_message="分析数据，调模型/指标 API")
writer = AssistantAgent("writer", system_message="写报告，调 LLM")

group_chat = GroupChat(
    agents=[user_proxy, researcher, analyst, writer],
    messages=[],
    max_round=20,
)
manager = GroupChatManager(group_chat)

user_proxy.initiate_chat(manager, message="分析数码 GMV 跌原因")
```

### 角色职责
```
Orchestrator：理解任务，路由到合适 Agent
Researcher：调特征/数据/指标 API 查信息
Analyst：调模型/规则 API 做分析
Writer：调 LLM 生成最终输出
Critic：审查质量，必要时回退

每 Agent 有专长工具集（避免工具过多 LLM 混乱）
```

## 六、中台工具化（关键）

把中台每个能力注册成 Tool，Agent 按需调用。

```java
@Component
public class PlatformToolRegistry {

    @Tool(name = "query_metric",
          desc = "查询业务指标（GMV/CTR/转化率等），返回时间序列")
    public MetricResult queryMetric(
        @ToolParam("metric") String metric,
        @ToolParam("dimension") String dim,
        @ToolParam("start") String start,
        @ToolParam("end") String end) {
        return metricService.query(metric, dim, start, end);
    }

    @Tool(name = "check_ab_experiment",
          desc = "检查实验对指标的影响")
    public ExpResult checkExperiment(
        @ToolParam("layer") String layer,
        @ToolParam("metric") String metric) {
        return abTest.analyze(layer, metric);
    }

    @Tool(name = "get_feature_drift",
          desc = "查询特征分布漂移")
    public DriftResult getDrift(
        @ToolParam("feature") String feat,
        @ToolParam("window") String window) {
        return featureMonitor.drift(feat, window);
    }

    @Tool(name = "rollback_model",
          desc = "回滚模型版本（高风险，需确认）")
    @RequireConfirmation   // 二次确认
    public RollbackResult rollback(
        @ToolParam("model_id") String modelId,
        @ToolParam("to_version") String version) {
        return modelService.rollback(modelId, version);
    }
}
```

### 工具设计原则
```
- 描述清晰（LLM 能理解何时用）
- 参数 schema 明确（类型/必填/枚举）
- 错误信息友好（LLM 能修正）
- 高风险操作加确认（不直接执行）
- 返回结构化（LLM 易处理）
```

## 七、状态管理

```python
class AgentState:
    query: str                       # 原始问题
    plan: List[Step]                 # 任务计划
    current: int                     # 当前进度
    results: Dict[str, Any]          # 各步结果
    context: List[Message]           # 对话历史
    memory: Dict[str, Any]           # 跨会话记忆
    metadata: Dict                   # trace/审计

共享状态让多 Agent 协作（一个 Agent 写，另一个读）
```

### 记忆类型
- **短期**：单次会话内（context window）
- **长期**：跨会话（向量库 + 关系库）
- **共享**：多 Agent 共享（如 Orchestrator 给 Worker 传任务）

## 八、智能 AI 中台典型应用

### 1. 业务运营助手
```
运营："给数码类目设计促销"
Agent：
  Planner：拆解任务
    1. 查数码库存 → Researcher
    2. 查历史促销效果 → Researcher
    3. 设计促销方案 → Analyst（调 LLM）
    4. 校验规则合规 → Analyst（调规则引擎）
    5. 创建 A/B 实验 → Worker
    6. 生成报告 → Writer

Critic：审查方案合理性
```

### 2. 数据分析助手
```
业务："数码 GMV 为什么跌"
Agent：
  1. query_metric("数码 GMV") → 趋势
  2. check_ab_experiment("数码") → 哪个实验影响
  3. get_feature_drift("数码用户") → 用户画像变化
  4. llm_chat(综合分析) → 原因报告
```

### 3. 故障排查助手
```
告警："LLM 服务错误率突增"
Agent：
  1. 查错误日志 → 定位
  2. 查最近变更 → 找根因
  3. 评估影响 → 决策
  4. 自动回滚或通知值班
```

### 4. 个性化推荐决策
```
用户浏览 → Agent 决策
  - 查用户特征
  - 查场景规则
  - 调推荐模型
  - 调 LLM 生成解释
  - 返回结果 + 理由
```

## 九、工程化挑战

### 1. 可靠性
```
- Agent 决策错（用错工具/参数）→ 工具白名单 + schema 校验
- 无限循环 → 最大步数 + 收敛检测
- 错误传播 → 异常处理 + 重试
```

### 2. 成本
```
- 每步调 LLM（贵）→ 小模型做简单步骤 + 缓存
- 多 Agent 协作 token 多 → 状态压缩
```

### 3. 延迟
```
- 多步推理慢 → 并行工具 + 流式输出
- 用户等不了 → 中间结果反馈
```

### 4. 评估
```
- 任务完成率
- 工具调用准确率
- 用户满意度
- 成本（每次任务 token 数）
```

### 5. 安全
```
- 工具权限（按角色）
- 高风险操作（删除/支付/回滚）二次确认
- Prompt 注入防护
- 审计日志（Agent 全流程记录）
```

## 十、拼多多智能中台演进

```
阶段 1（传统中台）：API 平台，业务调 API
阶段 2（半智能）：单点 LLM 应用（客服/搜索）
阶段 3（智能编排）：Agent 调中台完成单领域任务
阶段 4（多 Agent 协作）：跨域复杂任务（运营/分析/决策）
阶段 5（自主智能）：Agent 自主发现机会/优化策略（远期）

当前重点：
- 工具标准化（所有中台能力 Tool 化）
- Agent 框架（Java 自研 + 借鉴 LangGraph）
- 评估体系（任务完成率 + 成本）
- 安全（高风险操作人工兜底）
```

## 十一、底层本质

智能 AI 中台本质是**"Agent 编排 + 中台工具化 + 多 Agent 协作"**——把中台能力注册为 Tool，Agent（单/多）按 Plan-Execute/Critic 模式自主调用。从"业务写编排代码"升级为"Agent 自主决策"，能完成之前要人编排的复杂任务。是大模型时代中台的核心演进方向，但工程化挑战大（可靠性/成本/延迟/安全）。

## 常见考点

1. **Agent 编排和工作流引擎区别**？——工作流是固定 DAG（人预设），Agent 是动态决策（LLM 推理）；工作流可控，Agent 灵活但难控，可混合（工作流框架 + Agent 决策点）。
2. **多 Agent 怎么避免冲突**？——明确分工 + 共享状态 + Supervisor 仲裁 + 消息协议。
3. **怎么评估 Agent 效果**？——任务完成率 + 工具调用准确率 + 成本（token）+ 用户满意度，自动化测试集（已知答案任务）+ 在线 A/B。
