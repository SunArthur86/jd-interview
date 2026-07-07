---
id: ant-risk-032
difficulty: L4
category: jd-ai
subcategory: LLM 风控
tags:
- 蚂蚁
- 风控
- LLM
- GraphRAG
- 大模型
feynman:
  essence: LLM 风控把"语义理解"能力引入风控——LLM 理解交易备注、聊天、用户行为文本；GraphRAG 把知识图谱和检索增强结合，让 LLM 决策可追溯、可解释。
  analogy: LLM 风控像懂语义的侦探——能读懂"账单备注里的暗语"、理解"用户行为的异常模式"；GraphRAG 像 LLM 的"案卷夹"，让它在推理时能查具体的关系网络证据。
  first_principle: 传统风控只能用结构化特征（金额、次数），无法理解语义（"代付"、"中介话术"）；LLM 有语义理解能力，GraphRAG 让它结合知识图谱事实，决策既智能又可追溯。
  key_points:
  - LLM 风控场景：文本风险识别、行为意图理解、异常解释
  - GraphRAG = 知识图谱 + 检索增强生成
  - 防幻觉：决策必须引用图谱证据
  - 实时性：LLM 推理慢，用 RAG 检索 + 简短 prompt 加速
first_principle:
  problem: 风控需要理解交易文本、聊天、用户行为语义，传统规则和模型无法处理，LLM 有能力但易幻觉，如何让 LLM 既智能又可靠？
  axioms:
  - LLM 有语义理解能力（识别暗语、意图）
  - LLM 易幻觉（编造事实）
  - 知识图谱有事实（关系网络）
  rebuild: GraphRAG——LLM 推理前先从知识图谱检索相关证据，prompt 里带事实，LLM 基于事实推理，输出带证据引用，可追溯可解释。
follow_up:
- GraphRAG 和普通 RAG 区别？——普通 RAG 检索向量库（文本片段），GraphRAG 检索图谱（实体+关系）
- LLM 风控的成本？——token 贵，需要"少样本 + 短 prompt + 缓存"
- 怎么防 LLM 误判（拦截正常用户）？——人工复核 + 申诉 + 监控拦截率
memory_points:
- LLM 风控核心：语义理解（文本/行为/意图）
- GraphRAG = 知识图谱 + RAG（检索事实给 LLM）
- 防 LLM 幻觉：决策必须引用图谱证据
- 加速：预检索 + 短 prompt + 缓存结果
---

# 【蚂蚁风控】LLM 风控怎么用？GraphRAG 怎么应用？

> JD 依据："大模型实践"。LLM 在风控的应用是 AI 转型热点。

## 一、LLM 在风控的核心场景

**1. 文本风险识别**
传统规则识别不了"暗语"：
```
账单备注: "代付"、"帮忙刷单"、"中介费"、"套现"
聊天: "亲，给个好评返现哦"、"加微信领红包"
```
LLM 能理解语义，识别欺诈话术。

**2. 行为意图理解**
```
用户行为序列：登录 → 改密码 → 改手机 → 大额转账 → 退群
LLM 推理：这是一次"账户被盗后的资金转移"，强风险
```

**3. 异常解释生成**
传统模型给分但不解释，LLM 能生成自然语言解释：
```
"拦截原因：用户是新注册账户，深夜给陌生账户转账 5 万，
且收款方在关系网络中关联 8 个被标记的高风险账户，
综合风险分 0.92。"
```

**4. 案件审核辅助**
人工审核案件时，LLM 自动总结、分类、推荐处理方案。

## 二、LLM 风控的挑战

| 挑战 | 问题 | 解法 |
|------|------|------|
| **幻觉** | 编造事实 | GraphRAG 提供事实约束 |
| **慢** | 推理秒级 | 异步复核 + 缓存 + 分层 |
| **贵** | token 成本 | 短 prompt + 小模型 + 缓存 |
| **不可解释** | 黑盒决策 | 强制结构化输出 + 证据引用 |
| **监管** | 不接受黑盒 | 关键场景双验证 + 人工复核 |

## 三、GraphRAG：让 LLM 基于事实推理

**RAG（Retrieval-Augmented Generation）回顾**：
```
用户问题 → 检索向量库（文本片段）→ 拼到 prompt → LLM 推理
```

**GraphRAG 升级**：
```
用户问题 → 检索知识图谱（实体+关系）→ 拼到 prompt → LLM 推理
```

**GraphRAG 的优势**：
- 文本片段：分散、无结构
- 知识图谱：结构化、关系明确、可追溯

## 四、GraphRAG 在风控的应用

**架构**：
```
事件: 用户 A 给 B 转账 5 万
   ↓
GraphRAG 检索:
   - A 的画像（新注册、无历史）
   - A-B 关系（无直接关系）
   - B 的风险标签（高风险账户）
   - B 的关联（8 个标记账户）
   - 历史类似案件（"深夜大额转账"）
   ↓
Prompt 给 LLM:
   "事件: A 给 B 转 5 万
    事实: A 新账户; B 高风险; A-B 无关系; B 关联 8 黑账号
    历史案件: 类似模式案件 123 起均为欺诈
    请决策:"
   ↓
LLM 输出:
   "决策: REJECT
    理由: A 新账户+B 高风险+无关系+大额夜间
    证据: 关系图谱查询结果、历史案件 123"
```

**关键**：决策必须引用证据（图谱节点 ID + 案件 ID），可追溯。

## 五、GraphRAG 的实现

**1. 知识图谱构建**（见 ant-risk-023）：
- 节点：账号、设备、IP、案件、规则
- 边：登录、转账、关联、命中

**2. 检索逻辑**：
```python
def graph_rag_retrieve(event, depth=2):
    # 1. 找相关实体（事件涉及的账号、设备）
    entities = extract_entities(event)

    # 2. 在图谱里找邻居
    subgraph = graph.query(
        nodes=entities,
        depth=depth
    )

    # 3. 检索历史相似案件
    similar_cases = case_db.search(
        embedding=embed(event),
        top_k=5
    )

    # 4. 组装上下文
    context = format_subgraph(subgraph) + format_cases(similar_cases)
    return context
```

**3. Prompt 模板**：
```
你是风控决策助手。基于以下事实做决策：

事件: {event}

关系图谱证据:
{graph_context}

历史相似案件:
{cases}

输出 JSON:
{{
  "decision": "PASS/REVIEW/REJECT",
  "confidence": 0.0-1.0,
  "reasoning": "推理过程",
  "evidence": ["图谱节点 ID", "案件 ID"]
}}
```

## 六、实时性与成本优化

**问题**：LLM 推理慢（秒级），token 贵。

**优化策略**：

**1. 分层决策**：
```
所有事件 → 规则引擎（毫秒）
   ↓ 80% 拦截/放行
边缘案例（20%）→ LLM Agent（秒）
```

**2. Prompt 优化**：
- 短 prompt（核心事实 + 明确任务）
- few-shot（5 个典型例子）
- 结构化输出（JSON schema）

**3. 结果缓存**：
- 相似事件复用 LLM 决策
- 用户级预计算（离线 Agent 跑全量）

**4. 模型分级**：
- 简单场景：小模型（7B）
- 复杂场景：大模型（70B）
- 高频场景：本地模型（私有部署）

## 七、防幻觉与可解释

**幻觉类型**：
- 编造特征（"用户历史有欺诈"实际没有）
- 错误推理（"5 万很大"实际是正常金额）
- 引用不存在证据

**防幻觉设计**：

**1. 工具结果约束**：
```python
# LLM 只能基于工具返回的数据推理
context = retrieve_facts(event)  # 工具检索事实
prompt = f"基于以下事实推理，不能编造: {context}"
response = llm.complete(prompt, tools=fact_check_tool)
```

**2. 强制证据引用**：
```python
def validate_response(resp):
    # 检查每个证据 ID 是否真实存在
    for evidence_id in resp.evidence:
        if not graph.exists(evidence_id):
            raise HallucinationError(f"虚构证据: {evidence_id}")
```

**3. 双 Agent 交叉验证**：
```
决策 Agent → 决策 A
复核 Agent → 决策 B
不一致 → 人工复核
```

## 八、案件回流与持续学习

**Agent 决策的反馈闭环**：
```
Agent 决策 → 落库 → 人工审核结果 → 反馈
   ↓
正确决策 → 强化（加入正样本）
错误决策 → 纠正（加入负样本 + SFT）
   ↓
模型迭代 / Prompt 优化 / 规则补充
```

**LLM 微调**（用风控数据）：
- SFT：用风控决策样本微调
- DPO：用人工审核偏好对齐
- 持续迭代

## 九、底层本质：从"特征工程"到"语义理解"的跃迁

传统风控 vs LLM 风控：

| 维度 | 传统风控 | LLM 风控 |
|------|---------|---------|
| 输入 | 结构化特征 | 文本 + 行为 + 特征 |
| 理解 | 数值统计 | 语义理解 |
| 决策 | 规则/模型 | 推理 + 工具 |
| 解释 | 命中规则 | 自然语言 |
| 适应新场景 | 配置规则 | 自主泛化 |

**核心跃迁**：从"数值特征统计"到"语义理解推理"。

**这是 AI 在风控的根本价值**——理解"为什么"而不仅是"是什么"。

## 十、和关系网络的融合

**GraphRAG 把关系网络变成 LLM 的"案卷"**：
- LLM 推理时能查关系网络（"这个账号关联多少黑账号"）
- 决策基于图谱事实（可追溯）
- 不用人工写规则（LLM 自动理解关系风险）

**未来形态**：
- 关系网络 + 行为序列 + LLM = 端到端智能风控
- 黑产无法绕（关系是客观事实）
- 可解释（每个决策有图谱证据）

## 十一、落地建议

**1. 从辅助开始**：
- LLM 不直接决策，先做"风险提示"
- 给人工审核提供解释和建议

**2. 边缘案例切入**：
- 规则搞不定的复杂场景先用 LLM
- 积累数据，逐步扩大覆盖

**3. 混合架构**：
- 规则（80% 流量，毫秒）
- 模型（15%，几十毫秒）
- LLM Agent（5%，秒级）

**4. 严格监控**：
- LLM 决策一致性（vs 规则对比）
- 幻觉率（虚构证据）
- 成本（token 消耗）

## 常见考点
1. **LLM 风控的最大挑战**？——实时性（秒级太慢）+ 幻觉（编造事实）+ 成本（token 贵）。
2. **GraphRAG 比普通 RAG 好在哪**？——图谱结构化、关系明确、可追溯，适合风控这种需要"证据"的场景。
3. **LLM 决策怎么保证可解释**？——结构化输出 + 强制证据引用 + 推理 trace 保留 + 双 Agent 验证。

**代码示例**（GraphRAG 实现）：
```python
def graphrag_risk_decide(event):
    # 1. 检索图谱证据
    graph_context = graph_rag_retrieve(event)
    cases = retrieve_similar_cases(event)

    # 2. 构造 prompt
    prompt = RISK_DECISION_PROMPT.format(
        event=event,
        graph=graph_context,
        cases=cases
    )

    # 3. LLM 推理
    response = llm.complete(prompt, response_format="json")

    # 4. 验证证据（防幻觉）
    for eid in response["evidence"]:
        if not graph.exists(eid):
            log.warning(f"幻觉证据: {eid}")
            return fallback_to_rule(event)  # 幻觉降级到规则

    return RiskDecision(**response)
```
