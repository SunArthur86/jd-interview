---
id: pdd-scm-035
difficulty: L3
category: pdd-scm
subcategory: RAG 工程
tags:
- 拼多多
- 供应链
- RAG
- 知识库
- 向量检索
feynman:
  essence: RAG 让 LLM 基于供应链私有知识回答——检索商品规则/采购流程/历史案例拼到 prompt，LLM 基于事实生成，解决 LLM 不知道内部业务的问题。
  analogy: RAG 像 LLM 的"开卷考试"——考前给"参考书"（知识库），答题时翻书抄相关段落再综合。
  first_principle: LLM 不知道供应链私有规则/流程，RAG 检索内部知识让 LLM 基于事实回答。
  key_points:
  - RAG = 检索（向量库）+ 生成（LLM）
  - 流程：文档切分→Embedding→向量库→检索→拼 prompt→LLM
  - 供应链应用：规则问答、案例检索、运营助手
  - 高级：查询改写、重排序、HyDE
first_principle:
  problem: LLM 不知道供应链私有知识（规则/流程/案例），如何让 LLM 基于内部知识回答？
  axioms:
  - LLM 训练数据无私有知识
  - 知识频繁更新（规则变更）
  - 需可追溯（答案带引用）
  rebuild: RAG——私有知识存向量库，提问检索相关片段拼 prompt，LLM 基于片段生成。
follow_up:
- RAG 检索不准？——优化 embedding + chunk 策略 + 重排序 + 查询改写
- 供应链 RAG 应用？——采购规则问答、历史案例检索、运营知识助手
- RAG vs 微调？——RAG 适合知识频繁更新，微调适合固定模式
memory_points:
- RAG = 向量检索 + LLM 生成
- 文档切分→Embedding→向量库→检索→拼 prompt→LLM
- 供应链应用：规则问答/案例检索/运营助手
- 防幻觉：决策必须引用证据
---

# 【拼多多供应链】RAG 怎么用在供应链？

> JD 依据："大模型业务探索"。

## 一、RAG 流程

```
离线建库:
  文档（规则/流程/案例）→ 切分 chunk → Embedding → Milvus 向量库

在线检索:
  问题 → Embedding → 检索 Top-K → 拼 prompt → LLM 生成（带引用）
```

## 二、供应链 RAG 应用

**1. 采购规则问答**：
```
运营: "单笔采购超过 100 万需要谁审批？"
RAG 检索采购规则文档 → LLM: "根据《采购管理制度》第 5 条，超 100 万需 VP 审批"
```

**2. 历史案例检索**：
```
事件: "供应商 A 到货延迟"
RAG 检索历史类似案例 → LLM: "历史 3 次类似案例处理方案：催货/换供应商/通知用户"
```

**3. 运营知识助手**：
```
客服: "这个 SKU 为什么下架了？"
RAG 检索下架记录 + 规则 → LLM: "因质量投诉超阈值，按规则 X 下架"
```

## 三、高级 RAG

- **查询改写**：原始问题改写更精准
- **HyDE**：LLM 先生成假设答案再检索
- **重排序**：向量召回 Top-50 → cross-encoder 精排 Top-5
- **混合检索**：向量（语义）+ 关键词（精确）

## 四、防幻觉

决策必须引用证据：
```json
{
  "answer": "需要 VP 审批",
  "evidence": ["采购管理制度.docx#section5"],
  "confidence": 0.95
}
```

## 五、底层本质

RAG 是**"知识外置"**——LLM 参数存推理能力，知识存外部向量库，解耦让知识可独立更新不用重训。

## 常见考点
1. **RAG 检索不准怎么办**？——优化 embedding 模型 + chunk 策略 + 重排序 + 查询改写。
2. **RAG 和微调选哪个**？——知识频繁变 RAG；固定模式微调；最佳组合。
3. **向量库为什么近似检索**？——精确 KNN 亿级不可行，HNSW 近似 O(log n)。
