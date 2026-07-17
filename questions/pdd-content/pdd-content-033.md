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

## 苏格拉底式面试追问

> 这组追问不是背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：AI Harness 工程化你强调"评测"，但传统软件工程测试就够了（单测/集成测试）。为什么 LLM 应用要单独强调"评测"？**

传统软件的"测试"和 LLM 应用的"评测"有本质区别。传统软件的输出是确定的（给定输入，函数返回固定值），测试用断言（assertEquals）。LLM 的输出是概率性的（同一输入，每次生成可能不同），无法用 assertEquals。传统软件的 bug 是"代码逻辑错"（可定位），LLM 的 bug 是"输出不符合预期"（可能是 prompt/模型/输入综合导致，难定位）。评测是针对概率系统的"测试"——用标注数据集 + LLM-as-Judge + 业务指标量化效果。没有评测，改 prompt 是盲改（不知道变好还是变差），上线上线是赌博（不知道用户反馈如何）。Harness 强调评测，本质是"让 LLM 应用的效果可量化、可回归、可对比"，这是把 LLM 从"玩具"变成"生产系统"的前提。

### 第二层：证据与定位

**Q：审核 Agent 上线后，用户投诉"误删评价"增多。你怎么用 Harness 的监控+评测定位是 prompt 变差了还是模型退化？**

Harness 的分层定位：
1. 监控——看 `misjudgment_rate`（误判率）指标是否上升。如果某天突然跳升，看是否当天发了版本（prompt/模型变更）。看 `user_appeal_rate`（用户申诉率）作为辅助验证。
2. 版本管理——对比当前版本 vs 上个版本的 prompt 和模型。如果是 prompt 改了（如加了"宁可严判"的指令），回滚 prompt 验证。
3. 离线评测——用基准测试集（1000 条标注）跑当前版本，对比历史版本的准确率。如果当前版本准确率降了 3%，是版本退化。
4. 数据漂移——如果 prompt/模型没变但效果降，看输入分布是否变了（如新业务线接入，内容特征和原来不同，模型在新分布上泛化差）。

### 第三层：根因深挖

**Q：你用 LLM-as-Judge（强模型评判弱模型）做自动评测，但 Judge 模型本身也会出错。怎么保证评测的准确性？**

LLM-as-Judge 的偏差和校正：
1. Judge 偏好——强模型可能偏好某种回答风格（如更长/更详细），而非真正更准。解法：评测 prompt 明确"评分标准"（准确性/相关性/安全性），不评风格。
2. 位置偏差——Judge 对"先出现的答案"偏好。解法：交换答案顺序跑两次，取平均。
3. 自我偏好——Judge 偏好与自己相似的回答（同家族模型）。解法：用不同家族的模型交叉评判（如 GPT 评 Claude，Claude 评 GPT）。
4. 校正——定期用人工标注校准 Judge：抽 100 条让人工打分，对比 Judge 打分，计算一致性（Cohen's Kappa）。一致性 <0.7 说明 Judge 不准，需换模型或调 prompt。

### 第四层：方案权衡

**Q：Agent 的护栏（输入校验+输出过滤+人审兜底）让系统更安全，但也增加延迟和成本。怎么权衡安全性和体验？**

护栏的成本-收益权衡：
1. 输入护栏（越狱检测/敏感话题）——成本低（规则匹配毫秒级），收益高（防滥用）。必加。
2. 输出护栏（格式校验/敏感词/事实核查）——格式校验快（必加），事实核查慢（调 RAG 对比，几百 ms）。权衡：关键场景（审核/客服资金）加事实核查，闲聊不加。
3. 人审兜底——成本最高（人力），延迟最长（分钟级）。只用于高风险（大额退款/账号操作/严重违规）。
4. 分级策略——按"风险等级"配护栏：低风险（闲聊/查询）只加输入护栏，高风险（资金/合规）全护栏 + 人审。用"风险评分"自动路由。
拼多多客服 Agent：闲聊只加越狱检测（秒回），退款操作加事实核查 + 置信度 + 人审确认（牺牲延迟保安全）。

### 第五层：验证与沉淀

**Q：Agent 系统怎么 A/B 测试？传统软件的 AB 是"功能开关"，Agent 的 AB 有什么不同？**

Agent AB 的特殊性：
1. 变更维度多——传统软件 AB 是"代码变更"，Agent 的变更可能是 prompt/模型/工具/RAG 知识库/编排流程。每个维度都可独立 AB。
2. 效果难量化——传统软件看转化率（确定），Agent 的输出是概率性的，同样的输入在实验组/对照组可能输出不同，需要足够样本（几千次交互）才能统计显著。
3. 实验设计——按 `uid hash` 分桶（同一用户始终在一组，避免体验跳变），实验组 5% 用新版本，对照组 5% 用旧版本，跑 1-2 周收集足够数据。
4. 指标——不只看单一指标，看多维（解决率/满意度/幻觉率/成本）。可能出现"解决率涨但满意度降"（Agent 答得多但答得啰嗦），需综合判断。
5. 灰度——AB 验证正向后，逐步放量（5%→20%→50%→100%），每步监控指标不退化。
沉淀：prompt/模型版本入 git，每次变更可回滚；评测基准每次变更前跑（gate，不达标不准上线）；AB 实验平台支持"多实验正交"（同时跑多个不冲突的实验）。

## 结构化回答

**30 秒电梯演讲：** LLM 不确定性+成本高+效果难量化，如何工程化落地？简单说就是——AI Harness 工程化是"把 LLM 当组件，用编排+评测+监控+版本管理构建可靠 Agent 系统"；类比传统软件工程，但模型不确定性需额外护栏。评测：benchmark+自动+人工；监控：延迟/成本/幻觉。

**展开框架：**
1. **编排** — 编排：LangGraph/Dify
2. **评测** — 评测：benchmark+自动+人工
3. **监控** — 监控：延迟/成本/幻觉

**收尾：** 您想继续往深里聊吗——比如「怎么评测 Agent？」

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：AI Harness 工程化怎么落地？ | 今天聊「AI Harness 工程化怎么落地？」。一句话：AI Harness 工程化是"把 LLM 当组件，用编排+评测+监控+版本管理构建可靠 Agent 系统"；类比传统… | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：编排：LangGraph/Dify | 核心概念 |
| 0:51 | 能力/参数拆解表 | 要点是：评测：benchmark+自动+人工 | 能力拆解 |
| 1:30 | 监控大盘截图 + 指标曲线 | 要点是：监控：延迟/成本/幻觉 | 关键机制 |
| 2:09 | 代码片段 + 注释高亮 | 要点是：版本：prompt/模型/数据 | 实战要点 |
| 3:00 | 总结卡 + 下期预告 | 记住这些核心点就够了。下期我们接着聊——怎么评测 Agent？。 | 收尾 |
