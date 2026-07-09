---
id: pdd-trade-032
difficulty: L3
category: pdd-trade
subcategory: 模型服务
tags:
- 拼多多
- 交易
- LLM
- 订单
- 客服
- RAG
feynman:
  essence: LLM 在订单/客服的应用是"用大模型理解用户意图+检索订单知识+生成自然回复"——客服问答、订单状态解释、售后咨询，用 RAG 挂载业务知识，幻觉降到可接受。
  analogy: 像"金牌客服"——听懂用户问题（理解）、查订单系统（工具）、按规则答（RAG 知识）、说话还客气（生成）。
  first_principle: 客服场景"理解+查+答"重复，人贵且不一致，LLM 理解+生成+RAG 知识可自动化。
  key_points:
  - 意图理解：LLM 识别用户意图（查单/退款/投诉）
  - RAG 知识：挂载售后规则/FAQ/订单数据
  - 工具调用：查订单/物流/发起退款
  - 人工兜底：低置信度/高风险转人工
first_principle:
  problem: 客服重复多、人力贵、质量不一致，如何用 LLM 自动化？
  axioms:
  - 大量是"理解+查+答"重复
  - 人力贵且情绪化
  - LLM 理解+生成强但有幻觉
  rebuild: LLM 理解意图 + RAG 挂业务知识 + 工具查数据 + 人工兜底。
follow_up:
  - 客服 LLM 怎么降幻觉？——RAG 挂最新规则+约束 prompt+引用来源
  - 怎么评估客服质量？——人工标注+用户满意度+自动指标（BLEU/ROUGE）
  - 订单数据怎么给 LLM？——Function Calling 查实时订单，不放 prompt（太长）
memory_points:
  - 意图理解（LLM）+ RAG 知识 + 工具查单
  - 降幻觉：RAG+prompt 约束+引用
  - 兜底：低置信转人工
  - 评估：人工+满意度+自动指标
---

# 【拼多多交易】LLM 在订单/客服怎么应用？

> JD 依据："LLM 在订单/客服应用"。

## 一、客服场景分层

```
L1 自助（FAQ）：物流/退款规则/优惠说明 → RAG 直接答（80% 流量）
L2 AI 客服（查单）：查订单状态/解释异常 → LLM + 工具（15%）
L3 人工（投诉/复杂）：情绪安抚/特殊处理 → 人工兜底（5%）
```

## 二、RAG 架构

```
用户问题 → 向量化 → 向量库检索（FAQ/规则）→ 拼 prompt → LLM 生成 → 回答
                         ↑
                   业务知识库（售后规则/FAQ/政策）
```

**知识库构建**：
```
售后政策（退货/换货/退款规则）
商品 FAQ（常见问题）
订单状态说明（拼团/预售/百亿补贴）
物流异常处理 SOP
```

**检索+生成**：
```java
public String answer(String question, long uid) {
    // 1. 向量检索相关 FAQ
    List<Doc> docs = vectorStore.search(question, topK=5);
    // 2. 查用户订单（工具）
    List<Order> orders = orderService.listByUid(uid);
    // 3. 拼 prompt
    String prompt = buildPrompt(question, docs, orders);
    // 4. LLM 生成
    String answer = llm.chat(prompt);
    // 5. 低置信转人工
    if (confidence(answer) < 0.7) return routeToHuman();
    return answer;
}
```

## 三、订单状态解释（LLM 加值）

传统：返回"已发货"（用户不懂细节）。
LLM：
```
你的订单已发货，顺丰单号 SF123，预计 7/10 送达。
当前在【上海转运中心】，正常时效。
如超时可回复"延期"申请补偿。
```

## 四、降幻觉手段

1. **RAG 约束**：检索最新政策喂 prompt，避免过时知识
2. **Prompt 约束**：明确"只基于提供的资料回答，不知道就说不知道"
3. **引用来源**：回答附政策链接，用户可核实
4. **Function Calling**：实时数据（订单/物流）走工具，不靠 LLM 记忆

## 五、拼多多实战

- **百亿补贴客服**：LLM 解释补贴规则、查补贴进度
- **拼团咨询**：解释成团机制、未成团自动退款流程
- **物流异常**：LLM 主动联系物流+安抚用户+发补偿券
- **多轮对话**：支持"退款进度→退款到哪→预计到账"连续追问

## 六、底层本质

LLM 客服本质是**"理解+检索+生成三件套"**——LLM 理解意图，RAG 提供准确知识，Function Calling 查实时数据，组合起来覆盖 80% 自助+15% AI 客服，5% 留人工兜底。

## 常见考点
1. **RAG 怎么选向量模型**？——中文用 BGE/M3E，召回优先用向量+关键词混合检索。
2. **多轮对话怎么记上下文**？——session 记历史 message，超出窗口用摘要压缩。
3. **LLM 回答违规怎么办**？——安全分类器前置+关键词黑名单+prompt 约束+人工抽审。
