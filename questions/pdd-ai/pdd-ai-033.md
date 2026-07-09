---
id: pdd-ai-033
difficulty: L4
category: pdd-ai
subcategory: Agent 工程化
tags:
- 拼多多
- AI 中台
- LLMOps
- Agent 工程化
- Harness
- 评估
feynman:
  essence: LLMOps/Harness 是"LLM 应用的全生命周期工程化"——Prompt/模型/数据版本管理、离线/在线评估、监控/灰度/回滚，把"调通 demo"升级为"稳定上线的产品"。
  analogy: 像电视剧制作——剧本（Prompt）+ 演员（模型）+ 排练（评估）+ 试播（灰度）+ 正式播出（上线）+ 收视率监控（监控），每环节都管控。
  first_principle: LLM 应用有幻觉/概率性/效果难量化，必须工程化（版本/评估/监控/迭代）才能稳定上线。
  key_points:
  - Prompt/模型/数据版本管理
  - 评估：离线（自动+人工）+ 在线（A/B）
  - 监控：延迟/幻觉/满意度/成本
  - 灰度/回滚：和传统软件类似但更复杂
  - Harness：模型/Prompt/RAG/Agent 全链路编排
first_principle:
  problem: 怎么把 LLM 应用从"能跑的 demo"变成"稳定可演进的线上产品"？
  axioms:
  - LLM 输出概率性，效果不稳定
  - 没有评估就没有改进
  - 上线后需要持续监控迭代
  rebuild: LLMOps 平台（版本管理 + 评估 + 监控 + 灰度 + 迭代）。
follow_up:
  - Prompt 怎么版本管理？——Git 风格（diff/branch/merge）+ 业务标签
  - 离线评估怎么做？——自动指标（BLEU/ROUGE）+ LLM-as-Judge + 人工
  - 怎么监控幻觉？——抽样人工标注 + 规则校验 + 用户反馈（点踩率）
memory_points:
  - 版本：Prompt/模型/数据
  - 评估：离线+在线
  - 监控：延迟/幻觉/满意度/成本
  - Harness：全链路编排
---

# 【拼多多 AI 中台】AI Harness 工程化（LLMOps 全链路）怎么做？

> JD 依据："大模型训练框架开发维护、AI Harness 工程化"。

## 一、LLMOps 全景

```
开发 → 评估 → 灰度 → 上线 → 监控 → 迭代
  ↑                                      │
  └──────────────────────────────────────┘

管理对象：
  - Prompt（模板/版本/变量）
  - 模型（基座/微调/版本）
  - 数据（训练/评估/反馈）
  - RAG（向量库/检索策略/重排序）
  - Agent（工具/编排/记忆）
```

## 二、Prompt 管理

### 版本化
```
prompt_id: customer_service_v1
content: |
  你是拼多多客服，回答用户问题：{question}
  规则：礼貌、准确、不超过 100 字
variables: [question]
model: qwen-72b
temperature: 0.7
created_at: 2026-01-01
author: zhangsan
tags: [客服, v1]
```

### Prompt 工程实践
```
1. 模板化（Jinja2/Mustache）：变量化
2. 版本管理（Git 风格）：diff/branch/merge
3. A/B 实验：多版本对比
4. 灰度：新 Prompt 5% → 20% → 100%
5. 回滚：效果掉秒级切回旧版本
6. 评估：自动指标 + 人工评分
```

### 工具
- LangSmith（LangChain）
- PromptHub/Promptfoo
- 自研（Java + 配置中心）

## 三、评估体系

### 1. 离线评估（上线前）

#### 自动指标
```
- BLEU/ROUGE（文本相似度）
- 准确率（事实性问题）
- 完整性（关键信息覆盖）
- 一致性（同问题多次回答一致）
```

#### LLM-as-Judge
```
用 GPT-4/Claude 当裁判评估：
prompt: |
  你是评估员，给以下回答打分（1-5）：
  问题：{question}
  回答：{answer}
  标准：准确性/完整性/礼貌
  返回 JSON: {score, reason}

优势：规模化（不用人工逐条）
劣势：裁判模型也可能错
```

#### 人工评估
```
- 抽样（每版本 100-1000 条）
- 标注员打分（多维：准确/流畅/有用）
- 多人交叉（一致性检验）
- 黄金集（已知答案，回归测试）
```

#### 业务指标
```
- 任务完成率（如客服问题解决率）
- 用户满意度（评分/点踩）
- 转化率（如推荐点击）
```

### 2. 在线评估（上线后）

```
A/B 实验：
  对照组（旧 Prompt/模型）vs 实验组（新）
  指标：满意度/转化率/任务完成率
  显著性检验

监控：
  - 实时指标（满意度/点踩率）
  - 业务指标（GMV/CTR）
  - 安全指标（违规率/敏感词）
```

## 四、监控

### 性能
```
- TTFT（首 token 延迟）
- TPOT（每 token 延迟）
- QPS
- 错误率
- GPU 利用率/显存
```

### 效果
```
- 幻觉率（抽样标注 + 规则校验 + 用户反馈）
- 满意度（点踩率/评分）
- 任务完成率
- 安全合规（违规率）
```

### 成本
```
- 单次推理成本（GPU 时）
- token 单价
- 缓存命中率
- 模型/Prompt 维度成本归因
```

### 漂移
```
- 输入分布漂移（用户问题类型变化）
- 输出分布漂移（模型行为变化）
- 数据漂移（特征/知识变化）
```

## 五、灰度发布

```
模型/Prompt 灰度流程：
1. 沙箱测试（历史数据回放）
2. 内部白名单（员工先用）
3. 小流量灰度（1% → 5%）
4. 放量（20% → 50%）
5. 全量（100%）
6. 监控异常 → 秒级回滚

灰度维度：
- 用户百分比
- 用户分群（新老/地域）
- 业务线
```

## 六、回滚

```
传统软件回滚：代码版本
LLM 回滚：
  - 模型版本（基座/微调）
  - Prompt 版本
  - RAG 配置（向量库版本/检索策略）
  - Agent 工具配置

实现：
  - 所有配置版本化（配置中心）
  - 一键回滚脚本
  - 监控触发自动回滚（错误率/满意度掉）
```

## 七、Harness（全链路编排）

LLM 应用是"模型 + Prompt + RAG + Agent"的组合，Harness 把这些编排起来。

```
用户请求
   ↓
[Router]（意图识别 → 路由到不同场景）
   ↓
[Context Builder]
  - RAG 检索（向量库）
  - 特征查询（中台特征）
  - 历史对话（记忆）
   ↓
[Prompt Builder]
  - 模板填充
  - few-shot 选择
   ↓
[LLM Call]
  - 模型选择（大/小模型）
  - 参数（temperature/max_tokens）
   ↓
[Guardrail]
  - 输入过滤（敏感词/Prompt 注入）
  - 输出过滤（合规/安全）
  - 事实校验（RAG 引用验证）
   ↓
[Post-process]
  - 格式化
  - 工具调用执行（Function Calling）
  - 缓存写入
   ↓
响应（流式）
```

每一环节都版本化、可监控、可灰度、可回滚。

## 八、典型 LLMOps 平台

| 平台 | 特点 |
|------|------|
| **LangSmith** | LangChain 官方，Trace/eval/prompt 管理 |
| **Weights & Biases** | 训练/实验追踪 |
| **MLflow** | 模型生命周期 |
| **Arize Phoenix** | LLM 监控/评估 |
| **Helicone** | LLM 调用监控 |
| **Portkey** | LLM 网关 + observability |
| **自研** | 大厂常用（深度定制） |

## 九、拼多多 LLMOps 实战

```
平台能力：
- Prompt 管理（版本/A-B/灰度）
- 模型管理（注册/部署/版本）
- 评估（离线自动+人工，在线 A/B）
- 监控（性能/效果/成本/漂移）
- Harness（多模型/Prompt/RAG/Agent 编排）

关键指标：
- 上线前：准确率（黄金集）/满意度（人工）
- 上线后：任务完成率/点踩率/GPU 成本

挑战：
- 评估难（人工贵，LLM-as-Judge 有偏差）
- Prompt 效果不稳定（同 Prompt 不同 case 表现差大）
- 多组件协同（Prompt 改了影响 RAG/Agent）
- 成本控制（72B 推理贵，要量化和缓存）
```

## 十、底层本质

LLMOps/Harness 本质是**"把 LLM 应用当成传统软件一样工程化"**——Prompt/模型/数据版本管理（像代码版本），离线+在线评估（像测试），监控+灰度+回滚（像发布）。Harness 把模型/Prompt/RAG/Agent 编排成完整应用，全链路可观测、可演进。是 LLM 应用从 demo 到产品的关键工程层。

## 常见考点

1. **LLM 评估为什么难**？——输出概率性（同输入不同输出），任务多样（无统一指标），人工贵，LLM-as-Judge 可能错。
2. **Prompt 工程的核心是什么**？——清晰指令（角色/任务/约束）+ few-shot 示例 + 变量化 + 版本管理 + 持续评估。
3. **怎么监控幻觉**？——抽样人工标注 + 规则校验（关键事实）+ RAG 引用验证 + 用户反馈（点踩率）+ 同问题多次一致性。
