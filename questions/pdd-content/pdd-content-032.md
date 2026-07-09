---
id: pdd-content-032
difficulty: L4
category: pdd-content
subcategory: Agent 架构
tags:
- 拼多多
- 内容
- LLM
- 智能客服
- Agent
- RAG
- 工具调用
feynman:
  essence: LLM 智能客服是"LLM+RAG（知识库）+工具调用（订单/物流查询）+人审兜底"的 Agent 系统；替代传统 IVR/关键词客服，理解+个性化。
  analogy: 传统客服像查 FAQ（关键词），LLM 客服像有经验的导购（理解+查资料+办业务+疑难交人）。
  first_principle: 客服场景复杂（多轮+个性化+业务办理），LLM 理解+工具调用+RAG 知识能大幅提效。
  key_points:
  - LLM 理解意图（替代关键词）
  - RAG 检索知识库（FAQ/政策/商品）
  - 工具调用（查订单/物流/退款）
  - 多轮对话管理（记忆/状态）
  - 人审兜底（复杂/情绪化）
first_principle:
  problem: 客服场景复杂，传统关键词/IVR 体验差，如何用 LLM Agent 提升体验？
  axioms:
  - 客服问题多样
  - 需要业务办理（查订单/退款）
  - 复杂/情绪化要人审
  rebuild: LLM+RAG+工具+人审兜底。
follow_up:
  - 怎么防幻觉？——RAG 接入真实数据+置信度+人审
  - 多轮怎么记忆？——会话状态+摘要+长期记忆
  - 怎么衡量效果？——解决率/转人工率/满意度
memory_points:
  - 核心：LLM+RAG+工具+人审
  - RAG：FAQ/政策/商品知识
  - 工具：订单/物流/退款
  - 兜底：复杂/情绪化转人
---

# 【拼多多内容】LLM 智能客服 Agent 怎么设计？

> JD 依据："和算法同学挖掘业务问题"、"新媒体业务平台"。

## 一、传统客服的痛点

```
IVR（按键菜单）：体验差，找不到选项
关键词客服：只能命中预设 FAQ，复杂问题无解
人工客服：成本高，高峰排队
```

## 二、LLM 客服 Agent 架构

```
用户消息
   ↓
意图识别（LLM）：咨询/投诉/办理/闲聊
   ↓
路由：
  ├─ FAQ 咨询 → RAG 检索知识库 → LLM 生成答案
  ├─ 业务办理 → 工具调用（查订单/退款）→ LLM 总结
  ├─ 情绪化/复杂 → 转人工
  └─ 闲聊 → LLM 直接回（带人设）
   ↓
输出（带引用来源）
   ↓
满意度反馈 → 优化
```

## 三、RAG 知识库

**知识来源**：
- FAQ（常见问题）
- 平台政策（退款/售后/规则）
- 商品信息（规格/参数）
- 历史工单（优质回答）

**流程**：
```
知识库 → 切片 → Embedding → 向量库（Milvus/Faiss）
  ↓
用户问题 → Embedding → 向量检索 TopK → 重排 → LLM 生成
```

```python
def rag_answer(question):
    # 1. 检索
    docs = vector_db.search(embed(question), top_k=5)
    # 2. 重排（Cross-Encoder）
    reranked = reranker.rerank(question, docs)
    # 3. 生成
    prompt = f"基于以下资料回答：\n{reranked}\n问题：{question}"
    return llm.generate(prompt)
```

## 四、工具调用

```python
tools = [
    {
        "name": "query_order",
        "description": "查询用户订单",
        "parameters": {"uid": "string", "order_id": "string"}
    },
    {
        "name": "query_logistics",
        "description": "查询物流状态",
        "parameters": {"order_id": "string"}
    },
    {
        "name": "apply_refund",
        "description": "发起退款申请",
        "parameters": {"order_id": "string", "reason": "string"}
    }
]

# 用户："我的订单到哪了？"
# LLM 决策：调用 query_order 拿订单 → query_logistics 查物流 → 总结回答
```

## 五、多轮对话管理

**会话状态**：
```python
session = {
    "uid": "123",
    "history": [...],          # 最近 N 轮
    "context": {...},          # 提取的实体（订单号/商品）
    "intent": "查询物流",      # 当前意图
    "slot": {"order_id": None} # 待填充槽位
}

# 多轮：用户没给订单号 → LLM 反问 → 用户补全 → 继续工具调用
```

**长期记忆**：
- 用户画像（偏好/历史投诉）
- Redis 存最近会话摘要

## 六、人审兜底

**触发条件**：
```
1. 情绪检测（用户愤怒/抱怨）→ 转人
2. LLM 置信度低（多次澄清仍不懂）→ 转人
3. 高风险操作（大额退款/账号问题）→ 转人
4. 用户主动要求人工
```

```python
if detect_anger(user_msg) or confidence < 0.5 or is_high_risk(intent):
    transfer_to_human(session)
```

## 七、防幻觉

```
1. RAG 接真实数据（不凭空生成）
2. 输出带引用来源（"根据退款政策第 3 条..."）
3. 工具调用拿真实数据（订单/物流）
4. 置信度阈值（低不答，转人）
5. 关键场景人审（涉及资金/账号）
```

## 八、Prompt 设计

```
你是拼多多智能客服小多。

人设：友好/专业/简洁

能力：
  - 回答 FAQ（基于知识库）
  - 查询订单/物流（工具调用）
  - 协助退款/售后（工具调用）

约束：
  - 不确定时不要编，反问或转人工
  - 涉及资金/账号操作要确认
  - 用户愤怒时优先安抚+转人工
  - 回答带来源（"根据xxx政策"）

工具：query_order / query_logistics / apply_refund / ...
```

## 九、内容场景应用

**1. 评价投诉**：
```
用户："我评价被删了怎么回事？"
LLM：查评价状态 → 解释审核规则 → 申诉通道
```

**2. 直播问题**：
```
用户："主播没发货"
LLM：查订单 → 联系商家 → 退款选项
```

**3. 内容咨询**：
```
用户："这个商品评价好吗？"
LLM：RAG 检索评价摘要 → 总结（好评点/差评点）
```

## 十、效果衡量

```
业务指标：
  - 解决率（不转人工）目标 >70%
  - 转人工率 <30%
  - 首次响应时间 <2s
  - 用户满意度 CSAT >4.5/5
  
技术指标：
  - 意图识别准确率
  - RAG 召回率
  - 工具调用成功率
  - 幻觉率（抽检）
```

## 十一、底层本质

LLM 智能客服本质是**"LLM 理解+RAG 知识+工具调用+人审兜底"**——LLM 替代关键词理解意图、RAG 接真实知识、工具办业务、人审处理复杂/情绪化，是 Agent 工程化的典型场景。

## 常见考点
1. **怎么防幻觉**？——RAG+工具拿真实数据+置信度+人审+引用来源。
2. **多轮怎么管理**？——会话状态+槽位填充+历史摘要+长期记忆。
3. **RAG 怎么提升**？——切片优化+混合检索（向量+关键词）+重排+查询改写。
