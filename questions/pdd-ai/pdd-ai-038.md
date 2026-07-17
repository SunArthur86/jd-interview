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

## 苏格拉底式面试追问

> 这组追问不背答案，模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：你说用 LangGraph 做多 Agent 编排。但拼多多已有的 Airflow/DAG 工作流引擎也能做任务编排（定义节点、依赖、条件分支），为什么还要引入 LangGraph？Airflow 不是更稳定成熟吗？**

Airflow 和 LangGraph 的本质区别是"任务编排"vs"决策编排"。第一，Airflow 的 DAG 是人预设的固定流程（节点 A → 节点 B → 条件分支 C 或 D），每个节点的执行逻辑是确定的代码，适合"数据 ETL、定时任务"这种流程固定的场景。第二，Agent 编排需要"动态决策"——LLM 根据上一步结果决定下一步做什么，比如 Researcher 查到"GMV 跌幅 15%"后，Planner 要动态决定"是查实验还是查用户画像"，这个决策是 LLM 实时推理的，不是预设的 if-else。第三，LangGraph 的 `StateGraph` 支持"循环"（Critic 不满意可以让 Worker 重做），Airflow 的 DAG 是有向无环图（不能循环）。第四，LangGraph 的节点是 LLM + Tools，Airflow 的节点是 Python 函数。混用方案：流程固定的部分（数据准备、报告分发）用 Airflow，需要 LLM 决策的部分（规划、分析、审查）用 LangGraph，两者通过消息队列（Kafka）衔接。

### 第二层：证据与定位

**Q：Agent 上线后，用户反馈"分析报告内容跑题"，比如问"数码 GMV 为什么跌"，报告里掺了"服装类目趋势"。你怎么定位是 Planner 拆解错还是 Researcher 检索错？**

用 LangGraph 的 trace 追踪每一步状态。第一，看 Planner 生成的 plan——打开 LangSmith 或 LangGraph 的 state log，看 Planner 输出的任务列表，如果 plan 里包含了"查询服装类目"这一步，是 Planner 错（LLM 理解 query 时发散了，可能是 system prompt 没约束"只查相关类目"）。第二，如果 plan 正确（只查数码），但 Researcher 执行 `query_metric(metric="GMV")` 时传了 `dimension="all_categories"`，是 Researcher 错（工具调用的参数错了，LLM 没把"数码"这个约束传进去）。第三，如果 Researcher 参数对但返回了全类目数据（中台 API 的默认行为），是工具定义的问题（`query_metric` 的 `dimension` 参数没设默认值或枚举约束）。具体定位：在 LangSmith 的 trace 里看每一步的 input/output，找到"数码 → 服装"这个错误的源头。根因 80% 在工具 schema 定义不清（参数没必填/没枚举约束），20% 在 Planner 发散。

### 第三层：根因深挖

**Q：你发现 Researcher 调用 `query_metric` 时经常传错参数（比如把 `start_date` 写成 `start`）。这是 LLM 能力问题还是工具定义问题？怎么根本解决？**

根因是工具 schema 不够明确，LLM 要"猜"参数名。第一，**工具 schema 要用 OpenAPI/JSON Schema 严格定义**——每个参数有 `name`、`type`、`required`、`enum`、`description`，`description` 要写清"参数名是 start_date 不是 start，格式是 YYYY-MM-DD"。LLM 调用工具时看的就是这个 schema。第二，**加 few-shot 示例**——在工具描述里附 1-2 个正确调用示例（`query_metric(metric="GMV", start_date="2024-01-01", end_date="2024-01-31")`），LLM 会模仿格式。第三，**参数校验 + 友好报错**——工具执行前用 JSON Schema 校验参数，如果 `start_date` 缺失或类型错，返回明确错误（"参数 start_date 缺失，请传入 YYYY-MM-DD 格式的日期"），LLM 看到错误会自动修正重试（ReAct 循环）。第四，**工具名要自描述**——`query_metric` 不如 `query_business_metric_with_date_range` 明确，名字本身约束了 LLM 的理解。根本解是"把工具定义当成 API 设计"，LLM 是 API 调用方。

**Q：那为什么不直接让 LLM 生成 SQL 去查数据库，而要封装成 `query_metric` 这样的工具？SQL 更灵活，不用预定义每个指标。**

LLM 直接生成 SQL 有三个生产风险。第一，**安全性**——LLM 可能生成 `DROP TABLE` 或查敏感表（用户表），工具封装限制了可操作的 SQL（只允许 SELECT 指定表）。第二，**准确性**——LLM 不知道表结构（列名、JOIN 关系），生成的 SQL 经常跑不通，而 `query_metric` 工具把 SQL 生成逻辑封装在后端（确定的 SQL 模板），LLM 只传 `metric="GMV"`，后端映射到正确的表查询。第三，**性能**——LLM 生成的 SQL 可能没有索引、全表扫描，拖垮数据库，工具封装可以强制走索引（参数化的 SQL 预编译）。Text-to-SQL 适合"分析探索"场景（用户自助查数据，有权限隔离），Agent 工具调用适合"自动化流程"（确定性强、安全性要求高）。两者结合：Agent 调用 `query_metric`（安全）+ 必要时调 `run_sql`（沙箱隔离 + 只读权限）。

### 第四层：方案权衡

**Q：多 Agent 协作（Planner + Researcher + Analyst + Writer）每次任务要调 5-8 次 LLM，单次任务成本 0.5 元。客服场景日均 100 万请求，一天 50 万 LLM 成本。怎么降成本？**

多级降本。第一，**小模型分级**——Planner 和 Writer 用 72B（复杂推理），Researcher 和 Analyst 用 7B（简单工具调用），单次任务成本从 0.5 元降到 0.15 元（7B 的 token 成本是 72B 的 1/10）。实测 7B 做工具调用准确率 90%（72B 是 95%），够用。第二，**缓存**——相同 query 的 Planner 输出（任务拆解）缓存（Redis，TTL 1h），高频问题（top-1000 query）命中缓存直接复用，省 Planner 的 LLM 调用。第三，**状态压缩**——多 Agent 协作时，每个 Agent 把历史消息传给下一个 Agent，token 累积。用"摘要传递"（只传 summary 不传完整 history），token 从 8K 降到 2K。第四，**并行化**——Researcher 和 Analyst 能并行的步骤用 LangGraph 的 `add_edge(parallel=True)` 并行执行，减少串行 LLM 调用次数。优化后单次成本从 0.5 元降到 0.08 元，日均 8 万元。

**Q：为什么不直接用单 Agent（一个大模型 + 所有工具），而要拆成多个 Agent？单 Agent 调用次数少，不是更便宜吗？**

单 Agent 的成本陷阱在"工具数量爆炸"。第一，**工具过多导致选择错误**——单 Agent 注册 50 个工具（特征/模型/实验/数据 API），LLM 的 system prompt 要描述 50 个工具，token 多（prompt 就 5K），且 LLM 在 50 个工具里选对的准确率随工具数下降（研究显示 >15 个工具时准确率从 90% 降到 60%）。第二，**上下文窗口浪费**——单 Agent 要在 context 里维护所有中间结果和对话历史，token 累积快，长任务容易超 context（32K window）。第三，**可维护性**——单 Agent 的 prompt 要覆盖所有场景，改一个工具的描述可能影响其他工具的选择。多 Agent 按职能拆分（Researcher 只管查数据、Analyst 只管分析），每个 Agent 的工具少（5-8 个）、prompt 短、选择准。成本上多 Agent 虽然调用次数多，但每次调用的 token 少（prompt 短）、小模型能用，总成本反而更低。单 Agent 适合工具 < 10 个的简单任务。

### 第五层：验证与沉淀

**Q：你怎么证明多 Agent 协作比单 Agent 的任务完成率更高？**

三个维度的对照实验。第一，**离线评估集**——准备 200 个已知答案的任务（"分析数码 GMV 跌因"的正确报告是人工标注的），单 Agent 和多 Agent 分别跑，对比 `task_completion_rate`（报告是否包含关键结论）和 `tool_call_accuracy`（工具调用参数正确率）。多 Agent 预期 task_completion_rate 85%（单 Agent 70%），tool_call_accuracy 92%（单 Agent 75%）。第二，**线上 A/B**——单 Agent 和多 Agent 各 50% 流量，对比 `user_satisfaction`（点赞率）和 `first_try_success`（用户第一次提问就解决），连续 2 周看是否稳定提升。第三，**成本效率比**——单 Agent 成本低但完成率低，多 Agent 成本高但完成率高，算"单次成功任务的成本"（total_cost / successful_tasks），如果多 Agent 的单位成功成本更低，证明多 Agent 更优。

**Q：Agent 系统上线后怎么监控"它在做什么"，防止它做了不该做的事（比如调了高危工具）？**

三道防线。第一，**全链路 trace**——每次 Agent 执行都记录到 LangSmith/自建 trace 平台，包括每一步的 input/output、工具调用、LLM 推理过程，可视化展示决策链路（`planner → researcher → analyst → writer`）。第二，**高危工具审计**——`rollback_model`、`delete_data` 这类工具加 `@RequireConfirmation`（需人工确认）和审计日志（记录 who/when/what），每周 review 高危工具调用记录。第三，**异常检测**——监控 `tool_call_frequency`（某工具调用突增可能是 Agent 失控）、`task_step_count_p99`（单任务步数过多可能死循环）、`tool_error_rate`（工具调用错误率高可能 schema 有问题），异常自动告警 + 暂停 Agent。Agent 的可观测性比传统系统更重要，因为它的决策是 LLM 黑盒推理的，必须把每一步都记录可审计。

## 结构化回答


**30 秒电梯演讲：** 像把传统中央厨房升级为智能厨房——之前厨师（业务）按菜谱做菜（调 API），现在智能主厨（Agent）按订单自主调度食材/调料/工序，多 Agent 协作出宴席。

**展开框架：**
1. **编排框架** — LangGraph/AutoGen/自研
2. **多 Agent 协作** — Planner/Worker/Critic
3. **状态管理** — 共享状态/记忆

**收尾：** 多 Agent 怎么分工？


## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：智能 AI 中台（Agent 编排）怎么设计？ | 今天聊「智能 AI 中台（Agent 编排）怎么设计？」。一句话：智能 AI 中台是"用 Agent 编排中台能力"，把传统中台（被动调 API）升级为"会思考、会自主调用、会协作"的… | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：框架：LangGraph/AutoGen/自研 | 核心概念 |
| 0:51 | 能力/参数拆解表 | 要点是：多 Agent：Planner/Worker/Critic | 能力拆解 |
| 1:30 | 流程图：输入→处理→输出 | 要点是：中台能力 → Tool | 关键机制 |
| 2:09 | 代码片段 + 注释高亮 | 要点是：状态：共享记忆 | 实战要点 |
| 3:00 | 总结卡 + 下期预告 | 记住这些核心点就够了。下期我们接着聊——多 Agent 怎么分工？。 | 收尾 |
