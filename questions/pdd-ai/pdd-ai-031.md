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

## 苏格拉底式面试追问

> 这组追问不背答案，模拟面试宫层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：你们用 Function Calling 把"查订单"工具注册给 LLM。但传统做法是"用户输入 → 意图识别（分类模型）→ 路由到查订单接口"。Function Calling 不就是意图识别的升级版吗？为什么要用 LLM 做 FC，传统分类模型不行吗？**

FC 和意图识别的"泛化能力"完全不同。第一，**意图识别的局限**——分类模型要预定义意图列表（查订单/退款/物流），用户说"我的包裹到哪了"如果训练集没有这个表述，分类模型识别为"其他"，路由失败。FC 的 LLM 理解语义，"我的包裹到哪了"能映射到 `query_logistics(order_id)` 工具。第二，**参数提取**——意图识别后要"另一步"提取参数（用 NER 或规则提取 order_id），两个模型串联（意图+NER），错误叠加。FC 一次调用同时决定"调哪个工具 + 传什么参数"（LLM 直接输出结构化 JSON）。第三，**多工具组合**——用户说"查下我昨天订单的物流，如果还没发货就退款"，意图识别只能识别一个意图，FC 可以让 LLM 连续调用 `query_order → query_logistics → refund`（多步规划）。第四，**传统方案的优势**——意图识别快（10ms）、便宜（小模型），适合"意图固定 + 表述标准"的场景（IVR 语音菜单）。FC 慢（500ms）、贵（LLM），但泛化强，适合"开放对话 + 多意图"。拼多多客服：高频固定意图（"查物流"）用意图识别（快），复杂多步需求（"帮我处理这个订单的问题"）用 FC（灵活）。两者结合，不是替代。

### 第二层：证据与定位

**Q：Agent 上线后，工具调用的准确率只有 75%（25% 的 case 调错工具或传错参数）。你怎么定位是"LLM 能力不足"还是"工具定义不清"？**

用 trace 分层定位。第一，**看工具选择准确率**——LLM 选对了工具吗？如果 25% 的错误里，15% 是"选错工具"（用户要查物流，LLM 调了查订单），可能是工具描述不清（`query_order` 和 `query_logistics` 的 description 没区分清楚）或 LLM 能力弱（小模型理解差）。第二，**看参数提取准确率**——LLM 选对工具后，参数传对了吗？如果 25% 的错误里，10% 是"选对工具但参数错"（`query_logistics` 要 order_id 但 LLM 传了 user_id），是参数 schema 不明确或 LLM 没正确从对话提取参数。第三，**判断根因**——如果"工具描述模糊"导致选错，改工具的 description（写清楚 `query_order：查订单状态（含商品/金额）；query_logistics：查物流进度（含快递单号/位置）`），LLM 选择准确率会提升。如果"参数 schema 复杂"导致参数错，简化 schema（参数名自描述、加 enum、加 example）。如果改了描述和 schema 后准确率还是 75%，是 LLM 能力不足（换更大的模型，如 7B → 72B）。定位逻辑：先优化工具定义（成本低），再考虑换模型（成本高）。

### 第三层：根因深挖

**Q：你定位到"工具描述不清"是主因。但工具描述写多详细才够？写得越详细 token 越多（占 context window），写太简略 LLM 又选错。怎么平衡？**

工具描述要"精确 + 简洁 + 有示例"。第一，**精确**——描述要说清"这个工具做什么 + 什么时候用 + 不做什么"。如 `query_order`："查询订单的状态和详情（商品列表、金额、下单时间）。适用于用户询问'我的订单'、'订单状态'。不用于查询物流（用 query_logistics）"。明确边界（查订单 vs 查物流）。第二，**简洁**——不用长篇大论，30-50 token 够。LLM 的注意力有限，描述太长反而"稀释"关键信息。重点是"关键词"（订单/物流），让 LLM 快速匹配。第三，**示例**——在描述里附 1 个调用示例（`query_order(order_id="12345") → 返回订单详情`），LLM 模仿能力强，示例比文字描述更有效。第四，**参数 schema**——每个参数写 `description`（"订单号，格式是 10 位数字"）、`required`（是否必填）、`enum`（如果是固定值）。LLM 看 schema 理解参数。第五，**经验值**——5-10 个工具时，每个描述 50 token，总共 500 token（占 32K context 的 1.5%，可接受）。超过 20 个工具时，考虑"工具分层"（Agent 先选"类别"再选"具体工具"），减少单次 context 的工具数。

**Q：那为什么不用微调让 LLM"记住"工具调用能力？微调后 LLM 直接输出正确工具，不用每次传工具描述（省 token）。**

微调工具调用有三个问题。第一，**工具变更频繁**——业务工具（查订单/退款）经常加新接口/改参数，微调一次要重新训（几天 + 成本），跟不上工具迭代。FC 的工具描述是"运行时传"，加新工具只需注册（秒级）。第二，**泛化差**——微调的 LLM 在"训练过的工具调用"上表现好，但遇到"新工具"（没见过的）表现差（没学过）。FC 是"零样本"（LLM 读描述就理解），对新工具也 work。第三，**工具数量限制**——微调能"记住"的工具有限（训练数据里有多少种工具调用 pattern），超过后混淆。FC 的工具数只受 context window 限制（理论可挂 100+ 工具）。第四，**适用场景**——微调适合"固定工具集 + 高频调用"（如内部 API 的标准调用方式），FC 适合"动态工具 + 开放场景"。生产实践：用 FC（灵活），配合"Prompt 优化"（写好工具描述）达到 90%+ 准确率。微调只在"FC 准确率不够 + 工具固定"时用（如针对特定业务微调专用模型）。

### 第四层：方案权衡

**Q：多 Agent 协作（Planner + Worker + Critic）每次任务要调 5-8 次 LLM，延迟 10-30 秒。但用户期望"秒回"。这个延迟怎么解决？**

多 Agent 的延迟要"并行化 + 流式 + 分级"优化。第一，**并行化**——Planner 拆解任务后，多个 Worker 能并行的就并行（用 LangGraph 的 `add_edge(parallel=True)`），从串行 5 次 LLM（25 秒）降到并行 2 次（10 秒）。如"查订单 + 查物流 + 查用户画像"可以并行，不依赖彼此结果。第二，**流式输出**——Worker 执行时，把中间结果流式返回（"正在查询您的订单... 找到订单 #12345... 正在查询物流... 物流显示已发货"），用户看到"在动"，感知快（即使总耗时 20 秒，用户体验比"等 20 秒一次性返回"好）。第三，**分级响应**——简单任务（查订单）单 Agent 秒回（2 秒），复杂任务（多步分析）多 Agent 30 秒，让用户选择"快速简答"还是"深度分析"。第四，**小模型加速**——Planner 和 Worker 用 7B（快，500ms/次），只有 Critic 和最终合成用 72B（准，2 秒），总延迟从 30 秒降到 10 秒。第五，**缓存**——高频任务的 Plan 缓存（"查物流"的拆解计划复用），省 Planner 的 LLM 调用。拼多多客服 Agent：简单查询 2 秒（单 Agent）、复杂投诉处理 15 秒（多 Agent + 流式），用户可接受。

**Q：那为什么不直接用单 Agent（一个 LLM + 所有工具），非要拆成多 Agent？单 Agent 调用次数少，延迟低。**

单 Agent 在"工具多 + 任务复杂"时准确率下降。第一，**工具选择困难**——单 Agent 挂 30 个工具（订单/物流/退款/优惠券/支付），LLM 在 30 个工具里选对的准确率随工具数下降（研究显示 > 15 工具时准确率从 90% 降到 60%）。多 Agent 按职能拆分（订单 Agent 挂 5 个工具、物流 Agent 挂 3 个工具），每个 Agent 工具少、选择准。第二，**上下文爆炸**——单 Agent 要在 context 里维护"对话历史 + 30 个工具描述 + 中间结果"，token 快速累积，超 context window（32K）后要截断（丢信息）。多 Agent 的每个 Agent context 小（只管自己的工具和结果），不超限。第三，**可维护性**——单 Agent 的 prompt 要覆盖所有场景，改一个工具的描述可能影响其他工具的选择。多 Agent 的 prompt 独立（订单 Agent 的 prompt 改了不影响物流 Agent），可维护性好。第四，**生产选择**——工具 < 10 个 + 任务简单 → 单 Agent（延迟低）；工具 > 10 个 + 任务复杂 → 多 Agent（准确率高）。拼多多客服有 50+ 工具（覆盖所有业务），必须多 Agent。单 Agent 适合简单场景（如"只查天气"的工具数 3 的助手）。

### 第五层：验证与沉淀

**Q：你怎么证明 Agent 的"工具调用准确率从 75% 提升到 90%"是工具定义优化的效果，而不是 LLM 模型升级的效果？**

控制变量 A/B。第一，**隔离变量**——工具定义优化（变量 A）vs LLM 模型升级（变量 B）。设计 4 组实验：（1）旧工具定义 + 旧模型（基线 75%）、（2）新工具定义 + 旧模型、（3）旧工具定义 + 新模型、（4）新工具定义 + 新模型（目标 90%）。如果（2）=85%（工具优化贡献 10%）、（3）=82%（模型升级贡献 7%）、（4）=90%（两者叠加），证明工具优化是主因。第二，**离线评估集**——维护 500 个标注好的"query → 正确工具+参数"的黄金集，每次改工具定义/换模型都跑黄金集，对比准确率变化。消除"线上流量变化"的干扰。第三，**线上 A/B**——新旧工具定义各 50% 流量，对比 `tool_call_accuracy`（线上实际调用的准确率，通过"用户是否点踩"反推）。如果新定义的点踩率低 30%，证明优化生效。三个验证（控制变量 + 黄金集 + A/B）一致，证明是工具定义优化的效果。

**Q：Agent 工程化的经验怎么沉淀，让新 Agent 快速上线？**

三件事。第一，**工具注册规范**——标准化工具定义（name/description/parameters/example），新工具按规范注册，LLM 能理解。提供工具注册的 CLI（`pdd-agent register-tool --name query_order --desc "..."`），自动生成 schema 和 stub 代码。第二，**Agent 模板**——按场景（客服/分析/运营）预设 Agent 模板（角色/工具集/prompt 模板/评估集），新 Agent 套模板，改改 prompt 就能用。模板里包含"最佳实践"（工具数 < 10、描述 50 token、加示例）。第三，**Agent 评估平台**——每次改 prompt/工具定义/模型，跑黄金集回归（准确率/延迟/成本），指标不降才上线。Agent 是"需要持续评估和优化的系统"，不是"上线就不动"。监控 `tool_call_accuracy`、`task_completion_rate`、`cost_per_task`，持续迭代。Agent 工程化的目标是"让 Agent 开发像 Web 开发一样标准化"，不是"每个 Agent 从零搭"。

## 结构化回答

**30 秒电梯演讲：** 怎么让 LLM 自主调用中台能力完成复杂任务？简单说就是——用 AI Agent 改造中台是"把 LLM 当大脑、中台能力当工具，让 Agent 自主调用特征/规则/模型/实验完成复杂任务"。Function Calling 调中台 API；ReAct：思考-行动循环。

**展开框架：**
1. **Agent** — Agent = LLM + Tools + Memory + Planning
2. **Functi** — Function Calling 调中台 API
3. **ReAct** — ReAct：思考-行动循环

**收尾：** 您想继续往深里聊吗——比如「Function Calling 怎么实现？」

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：用 AI Agent 改造中台怎么做？ | 今天聊「用 AI Agent 改造中台怎么做？」。一句话：用 AI Agent 改造中台是"把 LLM 当大脑、中台能力当工具，让 Agent 自主调用特征/规则/模型/实验完… | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：Agent = LLM + Tools + Memory + Planning | 核心概念 |
| 0:51 | 代码片段 + 关键行高亮 | 要点是：Function Calling 调中台 API | 能力拆解 |
| 1:30 | 流程图：输入→处理→输出 | 要点是：ReAct：思考-行动循环 | 关键机制 |
| 2:09 | 代码片段 + 注释高亮 | 要点是：中台能力注册为 Tool | 实战要点 |
| 3:00 | 总结卡 + 下期预告 | 记住这些核心点就够了。下期我们接着聊——Function Calling 怎么实现？。 | 收尾 |
