---
id: pdd-ai-031
difficulty: L4
category: pdd-ai
subcategory: Agent 改造
tags:
- 拼多多
- AI 中台
- Agent 改造
- Function Calling
- ReAct
- 中台
feynman:
  essence: 用 AI Agent 改造中台是"把 LLM 当大脑、中台能力当工具，让 Agent 自主调用特征/规则/模型/实验完成复杂任务"，从"人调 API"升级为"Agent 自主演绎"。
  analogy: 像给中央厨房配个智能主厨——主厨（Agent）按订单（用户请求）自主决定用哪些食材（特征）、调料（规则）、菜谱（模型）、试吃（实验），不用每步都问经理（人）。
  first_principle: LLM 有推理能力，中台有工具能力，两者结合能完成复杂多步任务（之前要人编排）。
  key_points:
  - Agent = LLM + Tools + Memory + Planning
  - Function Calling：LLM 调中台 API（特征/规则/模型）
  - ReAct：Reasoning + Acting（思考-行动循环）
  - 编排：LangGraph/AutoGen/自研
  - 中台工具化：每个中台能力注册成 Tool
first_principle:
  problem: 怎么让 LLM 自主调用中台能力完成复杂任务？
  axioms:
  - LLM 有推理能力
  - 中台有工具能力（API）
  - Function Calling 让 LLM 调 API
  rebuild: Agent（LLM + Tool Registry + Planning + Memory）。
follow_up:
  - Function Calling 怎么实现？——LLM 输出结构化 JSON（工具名+参数），业务侧执行后返回结果
  - Agent 怎么避免无限循环？——最大步数 + 收敛检测 + 人工兜底
  - 多 Agent 怎么协作？——分工（planner/worker）+ 消息传递 + 共享状态
memory_points:
  - Agent = LLM + Tools + Memory + Planning
  - Function Calling 调中台 API
  - ReAct：思考-行动循环
  - 中台能力注册为 Tool
---

# 【拼多多 AI 中台】用 AI Agent 改造中台怎么做？

> JD 依据："消费者服务策略算法中台、用 AI Agent 改造中台"。

## 一、Agent 核心要素

```
Agent = LLM（大脑）+ Tools（工具）+ Memory（记忆）+ Planning（规划）

工作流：
用户请求 → LLM 思考 → 调用工具 → 观察结果 → 继续思考 → ... → 返回

例：用户"为什么我推荐里没有数码产品？"
LLM 思考：
  1. 查用户兴趣特征 → call get_user_features(uid)
  2. 查数码类目策略 → call get_strategy("数码")
  3. 分析是否被过滤 → call check_filter(uid, "数码")
  4. 生成解释
```

## 二、Function Calling 机制

```python
# OpenAI 风格 Function Calling
response = client.chat.completions.create(
    model="qwen-72b",
    messages=[{"role": "user", "content": "查用户 u123 的兴趣"}],
    tools=[{
        "type": "function",
        "function": {
            "name": "get_user_features",
            "description": "查询用户特征",
            "parameters": {
                "type": "object",
                "properties": {
                    "uid": {"type": "string"}
                }
            }
        }
    }],
)

# LLM 输出
{
    "tool_calls": [{
        "function": {
            "name": "get_user_features",
            "arguments": "{\"uid\": \"u123\"}"
        }
    }]
}

# 业务侧执行
result = feature_service.query("u123")

# 结果返回给 LLM 继续推理
```

## 三、中台能力工具化

把中台每个能力注册成 Tool：

```java
@Component
public class AiPlatformTools {

    @Tool(name = "get_user_features", desc = "查询用户实时+离线特征")
    public Map<String, Object> getUserFeatures(@ToolParam("uid") String uid) {
        return featureService.queryAll(uid);
    }

    @Tool(name = "query_recommend", desc = "调用推荐模型")
    public List<Item> queryRecommend(@ToolParam("uid") String uid, @ToolParam("scene") String scene) {
        return recommendService.recall(uid, scene);
    }

    @Tool(name = "eval_rule", desc = "执行规则引擎")
    public RuleResult evalRule(@ToolParam("rule_id") String ruleId, @ToolParam("ctx") Map ctx) {
        return ruleEngine.fire(ruleId, ctx);
    }

    @Tool(name = "get_experiment_variant", desc = "查询实验分流")
    public String getVariant(@ToolParam("uid") String uid, @ToolParam("layer") String layer) {
        return abTest.assign(uid, layer);
    }

    @Tool(name = "llm_chat", desc = "调用 LLM 生成回复")
    public String chat(@ToolParam("prompt") String prompt) {
        return llmClient.invoke(prompt);
    }
}
```

工具注册到 Agent 框架，LLM 按需调用。

## 四、ReAct 模式

```
ReAct = Reasoning + Acting 交替

循环：
Thought: 我需要先查用户特征
Action: get_user_features(uid=u123)
Observation: {interest: ["数码", "母婴"], age: 28}

Thought: 用户对数码感兴趣，查数码类目
Action: query_recommend(uid=u123, scene=数码)
Observation: [商品 A, 商品 B]

Thought: 推荐里没有，可能是被规则过滤
Action: eval_rule(rule_id=数码策略, ctx={...})
Observation: {filtered: true, reason: "风控限制"}

Thought: 找到原因，生成回复
Action: llm_chat(prompt="用户被风控限制...")
Observation: "您账号有风控限制，暂不展示数码商品"

Final Answer: ...
```

## 五、Agent 编排框架

### 1. LangGraph（推荐）
```python
from langgraph.graph import StateGraph

graph = StateGraph(AgentState)
graph.add_node("plan", plan_node)
graph.add_node("execute", execute_node)
graph.add_node("reflect", reflect_node)

graph.add_edge("plan", "execute")
graph.add_conditional_edges("execute", should_continue, {
    "continue": "plan",
    "end": END,
})

app = graph.compile()
```

### 2. AutoGen（多 Agent）
```python
planner = AssistantAgent("planner", system_msg="拆解任务")
worker = AssistantAgent("worker", system_msg="执行子任务")
critic = AssistantAgent("critic", system_msg="审查结果")

groupchat = GroupChat([planner, worker, critic])
manager = GroupChatManager(groupchat)
```

### 3. 自研（Java）
```java
public class Agent {
    LlmClient llm;
    ToolRegistry tools;
    MemoryStore memory;
    int maxSteps = 10;

    public String run(String userInput) {
        memory.add(Message.user(userInput));
        for (int i = 0; i < maxSteps; i++) {
            Message resp = llm.chat(memory.all(), tools.schemas());
            if (resp.hasToolCalls()) {
                for (ToolCall call : resp.toolCalls()) {
                    Object result = tools.invoke(call);
                    memory.add(Message.tool(result));
                }
            } else {
                return resp.content();   // 最终答案
            }
        }
        return "未能完成任务";
    }
}
```

## 六、Agent 改造中台典型场景

### 1. 智能客服 Agent
```
用户："我订单为啥还没发货？"
Agent：
  - get_order(orderId) → 状态：待发货
  - get_logistics(orderId) → 仓库打包中
  - llm_chat("用户订单 X 状态 Y，仓库 Z") → "您的订单在 Z 仓库打包中，预计今天发出"
```

### 2. 数据分析师 Agent
```
业务："最近数码类 GMV 为什么跌？"
Agent：
  - query_metric("数码", "gmv", "最近7天") → 跌 15%
  - ab_test_check("数码") → 实验组掉
  - feature_drift("数码用户") → 用户画像漂移
  - llm_chat(分析数据) → "实验组 X 影响了数码用户..."
```

### 3. 运营助手 Agent
```
运营："给数码类目设计一个促销"
Agent：
  - query_inventory("数码") → 库存
  - query_history_promo("数码") → 历史促销效果
  - eval_rule("促销规则", ...) → 规则校验
  - create_experiment("新促销", 5%) → 创建 A/B 实验
  - llm_chat(总结) → 方案 + 实验 + 预期效果
```

### 4. 代码助手 Agent
```
开发："加一个查询用户特征的工具"
Agent：
  - search_code("feature_service") → 找到相关代码
  - read_file(...) → 理解现有模式
  - generate_code(@Tool pattern) → 写新 Tool
  - run_test(...) → 验证
  - 提交 PR
```

## 七、Agent 工程化挑战

### 1. 可靠性
```
- 幻觉（编造不存在的工具/参数）→ 工具白名单 + 参数校验
- 无限循环 → 最大步数 + 收敛检测
- 错误传播 → 每步异常处理 + 重试
```

### 2. 成本
```
- 每步调 LLM（贵）→ 用小模型做简单步骤
- token 累积 → 上下文压缩/遗忘
- 工具调用 → 批量/缓存
```

### 3. 延迟
```
- 多步推理 → 用户等不了
- 流式输出 → 中间结果反馈
- 并行工具调用 → 减少串行
```

### 4. 评估
```
- 怎么知道 Agent 做对了？
- 自动化测试（已知答案的任务集）
- 人工评估（抽样）
- 在线指标（任务完成率/满意度）
```

### 5. 安全
```
- 工具调用权限（按 uid/角色）
- 敏感操作（删除/支付）二次确认
- Prompt 注入防护
```

## 八、拼多多落地

```
场景 1：智能客服（替代传统客服）
  - Agent 调订单/物流/规则/LLM
  - 任务完成率从 60% → 85%

场景 2：数据分析师（业务自助）
  - Agent 调指标/实验/特征
  - 业务方不用找数据同学

场景 3：运营助手
  - Agent 调规则/库存/实验
  - 运营自动配置活动

挑战：
- 中台 API 标准化（命名/参数/错误码）
- Agent 框架自研（Java 生态）
- 效果评估体系建设
```

## 九、底层本质

Agent 改造中台本质是**"LLM 推理 + 中台工具 + 自主编排"**——把中台每个能力注册成 Tool，LLM 作为大脑按 ReAct/Plan-Execute 模式自主调用。从"人调 API"升级为"Agent 自主演绎"，能完成之前要人编排的复杂任务。是 AI 中台从"能力平台"到"智能平台"的演进方向。

## 常见考点

1. **Function Calling 和 RAG 区别**？——Function Calling 是调外部 API（动态数据），RAG 是检索文档（静态知识），两者可结合（RAG 召回知识 + FC 调实时数据）。
2. **Agent 怎么避免幻觉工具**？——工具白名单 + 参数 schema 校验 + LLM 用支持 FC 的模型（不靠 prompt 解析）。
3. **多 Agent 协作怎么设计**？——角色分工（planner/worker/critic）+ 消息协议 + 共享状态 + 冲突仲裁。
