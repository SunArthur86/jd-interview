---
id: pdd-content-033
difficulty: L4
category: pdd-content
subcategory: Agent 工程化
tags:
- 拼多多
- 内容
- AI Harness
- 工程化
- 评测
- 编排
- LangGraph
feynman:
  essence: AI Harness 工程化是"把 LLM 当组件，用编排+评测+监控+版本管理构建可靠 Agent 系统"；类比传统软件工程，但模型不确定性需额外护栏。
  analogy: AI Harness 像导演拍片——LLM 是演员（有不确定性），Harness 是剧本+排练+审片+上线监控。
  first_principle: LLM 是概率模型有不确定性，需工程化手段保证可靠/可控/可观测。
  key_points:
  - 编排：LangGraph/LangChain/Dify（流程图）
  - 评测：自动+人工，建立 benchmark
  - 监控：延迟/成本/幻觉/用户反馈
  - 版本管理：prompt/模型/数据版本化
  - 护栏：输入校验+输出过滤+人审
first_principle:
  problem: LLM 不确定性+成本高+效果难量化，如何工程化落地？
  axioms:
  - LLM 是概率模型
  - 效果需量化
  - 生产要可控
  rebuild: 编排+评测+监控+版本+护栏。
follow_up:
  - 怎么评测 Agent？——构建测试集+自动打分+人工抽检
  - 怎么控制成本？——分级调用+缓存+小模型蒸馏
  - 怎么做 A/B？——流量分桶+指标对比+灰度
memory_points:
  - 编排：LangGraph/Dify
  - 评测：benchmark+自动+人工
  - 监控：延迟/成本/幻觉
  - 版本：prompt/模型/数据
  - 护栏：校验+过滤+人审
---

# 【拼多多内容】AI Harness 工程化怎么落地？

> JD 依据："和算法同学挖掘业务问题"、"系统架构优化"。

## 一、AI Harness 是什么

把 LLM 当组件，构建可靠 Agent 系统的工程化框架/方法论。包括：
- **编排**：流程定义（节点+边）
- **评测**：效果量化
- **监控**：运行可观测
- **版本**：变更管理
- **护栏**：安全可控

## 二、编排（Workflow）

**LangGraph**（图式编排）：
```python
from langgraph.graph import StateGraph

def perceive(state):
    return {"content": extract(state.input)}

def decide(state):
    if rule_check(state.content).is_certain():
        return {"result": rule_check(state.content)}
    return {"next": "llm"}

def llm_audit(state):
    return {"result": llm.judge(state.content)}

graph = StateGraph(State)
graph.add_node("perceive", perceive)
graph.add_node("decide", decide)
graph.add_node("llm_audit", llm_audit)
graph.add_edge("perceive", "decide")
graph.add_conditional_edges("decide", lambda s: s.get("next", "end"), 
                            {"llm_audit": "llm_audit", "end": END})
```

**Dify/Coze**（低代码可视化）：
- 拖拽节点（LLM/工具/分支）
- 适合非工程师快速搭建

**核心模式**：
- ReAct（思考-行动循环）
- Plan-and-Execute（先规划后执行）
- Multi-Agent（多 Agent 协作）

## 三、评测（关键且常被忽视）

**为什么重要**：LLM 效果不量化，改了 prompt 不知道好坏。

**评测方法**：
```
1. 构建测试集（标注 100-1000 条典型 case）
2. 自动打分：
   - 规则匹配（关键词/格式）
   - LLM-as-Judge（用强模型评判弱模型）
   - 业务指标（准确率/召回率）
3. 人工抽检（10% 抽样）
4. 在线 AB（真实流量对比）
```

**评测平台**：
```python
def eval_agent(test_cases):
    results = []
    for case in test_cases:
        output = agent.run(case.input)
        score = {
            "accuracy": llm_judge(output, case.expected),    # LLM 评判
            "format": check_format(output),                  # 格式
            "latency": measure_latency(),
            "cost": calculate_cost()
        }
        results.append(score)
    return aggregate(results)
```

**benchmark 建设**：
- 离线测试集（回归测试）
- 在线指标（CTR/解决率/满意度）
- 红队对抗（找漏洞）

## 四、监控

**指标**：
```
业务：
  - 解决率/转人工率（客服）
  - 审核准确率/覆盖率（审核）
  - CTR/停留时长（推荐）

技术：
  - 延迟（P50/P99）
  - 成本（token 消费）
  - 错误率
  - 幻觉率（抽检）

用户体验：
  - 满意度（赞/踩）
  - 投诉率
```

**告警**：
- 延迟飙升（模型卡）
- 成本飙升（异常调用）
- 幻觉率上升（模型退化）
- 用户负反馈上升

## 五、版本管理

```
Prompt 版本（git 管理）
模型版本（v1.0/v1.1，回滚）
数据版本（RAG 知识库版本）
评测版本（测试集版本）

发版流程：
  改 prompt → 离线评测 → 灰度（5% 流量）→ 全量
  出问题 → 一键回滚到上版本
```

## 六、护栏

**输入护栏**：
```
- 越狱检测（"忽略上面的指令..."）
- 敏感话题过滤
- 长度限制
- 注入攻击检测
```

**输出护栏**：
```
- 格式校验（JSON schema）
- 敏感词过滤
- 事实核查（与 RAG 数据对比）
- 置信度阈值
- 人审兜底
```

```python
def safe_generate(prompt):
    # 输入护栏
    if detect_jailbreak(prompt): return refuse()
    # 生成
    output = llm.generate(prompt)
    # 输出护栏
    if not validate_format(output): return retry_or_fallback()
    if contains_sensitive(output): return filter_or_refuse()
    return output
```

## 七、成本控制

```
分级调用：
  - 简单：规则/小模型（便宜）
  - 中等：中等模型
  - 复杂：大模型（贵）
  
优化：
  - 缓存（相似问题命中）
  - 批量推理
  - 小模型蒸馏（学生模型）
  - Prompt 精简（减 token）
  - 流式输出（降首字延迟）
```

## 八、内容场景实战

**审核 Agent 工程化**：
```
编排：规则 → 小模型 → LLM Agent → 人审（图式）
评测：
  - 离线：1000 条标注（涉政/广告/正常）
  - 在线：误判率/漏判率/审核延迟
监控：审核量/准确率/成本/幻觉
版本：prompt + 模型 + 敏感词库版本
护栏：输入（截断）+输出（JSON 校验+敏感词）+人审
```

**客服 Agent 工程化**：
```
编排：意图 → RAG/工具 → 生成 → 反馈
评测：解决率/转人工率/满意度
监控：延迟/成本/投诉
版本：prompt+知识库版本
护栏：输入（越狱检测）+输出（事实核查）+人审
```

## 九、底层本质

AI Harness 工程化本质是**"用编排+评测+监控+版本+护栏把不确定的 LLM 变成可靠的 Agent 系统"**——类比传统软件工程，但额外强调评测（效果量化）和护栏（不确定性控制）。

## 常见考点
1. **怎么评测 Agent**？——离线测试集+LLM-as-Judge+人工抽检+在线 AB。
2. **怎么控制 LLM 幻觉**？——RAG 接真实数据+事实核查+置信度+人审。
3. **LangGraph 和 LangChain 区别**？——前者图式（状态机），后者链式（线性）。
