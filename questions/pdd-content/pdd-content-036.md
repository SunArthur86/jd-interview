---
id: pdd-content-036
difficulty: L4
category: pdd-content
subcategory: RAG 工程
tags:
- 拼多多
- 内容
- RAG
- UGC
- 检索
- 审核
- 向量
feynman:
  essence: RAG 在内容场景用于"UGC 检索（搜评价/找相似）+ 审核参考（查相似违规案例）"；核心是切片+Embedding+向量检索+重排+引用。
  analogy: RAG 像查资料写文章——先检索（找相关资料）再生成（写答案），带引用可追溯。
  first_principle: LLM 知识截止+无业务数据，需外挂知识库检索增强。
  key_points:
  - 知识库构建：切片+Embedding+向量库
  - 检索：向量+关键词混合
  - 重排：Cross-Encoder 精排
  - 生成：带引用，可追溯
  - 内容场景：UGC 检索+审核参考
first_principle:
  problem: LLM 无业务数据+知识截止，如何接入实时/私有知识？
  axioms:
  - LLM 知识有截止
  - 业务数据私有
  - 检索+生成比微调灵活
  rebuild: RAG（检索增强生成）。
follow_up:
  - 怎么提升召回？——查询改写+混合检索+重排
  - 切片策略？——按语义（段落）/固定长度/递归
  - 怎么防幻觉？——带引用+置信度+事实核查
memory_points:
  - 构建：切片+Embedding+向量库
  - 检索：向量+关键词混合
  - 重排：Cross-Encoder
  - 生成：带引用
  - 场景：UGC 检索+审核参考
---

# 【拼多多内容】RAG 在 UGC 检索与审核的应用？

> JD 依据："分布式/缓存/消息/搜索"、"评价和行家社区"、"和算法同学挖掘业务问题"。

## 一、RAG 是什么

```
Retrieval-Augmented Generation（检索增强生成）
  用户问题 → 检索知识库 → 注入 prompt → LLM 生成（带引用）
  
vs 微调：
  RAG：外挂知识，灵活（数据变了重新索引）
  微调：内化知识，固化（改了要重训）
```

## 二、知识库构建

**1. 数据来源**（内容场景）：
- 历史 UGC（优质评价/回答）
- 平台政策/规则
- 商品信息
- 审核案例（违规样本）
- FAQ

**2. 切片**：
```
按语义切片（优于固定长度）：
  - 段落/章节切分
  - 递归切分（先大后小）
  - 重叠（前后 50 字重叠，防切断语义）
  
元数据：
  chunk = {
    text: "...",
    source: "policy.md",
    section: "退款规则",
    tags: ["退款", "售后"]
  }
```

**3. Embedding**：
```python
from sentence_transformers import SentenceTransformer
model = SentenceTransformer('bge-large-zh')
embeddings = model.encode(chunks)
```

**4. 向量库**：
- Milvus（生产首选，分布式）
- Faiss（单机，快）
- HNSW（图索引，召回好）
- ES（dense_vector，混合检索方便）

## 三、检索

**向量检索**（语义相似）：
```python
q_emb = model.encode(question)
docs = vector_db.search(q_emb, top_k=20)
```

**关键词检索**（BM25，精确匹配）：
```
question 分词 → ES BM25 查询
适合：专有名词/数字/代码
```

**混合检索**（推荐）：
```
向量召回（语义宽）+ BM25 召回（精确）
  → 合并去重
  → 重排
```

**查询改写**：
```python
# 用户问题可能口语化/模糊
# LLM 改写为多个变体提升召回
rewrites = llm.rewrite(question, n=3)
for q in rewrites:
    docs += retrieve(q)
```

## 四、重排

**Cross-Encoder**（精排）：
```python
from sentence_transformers import CrossEncoder
reranker = CrossEncoder('bge-reranker-large')
scores = reranker.predict([(question, doc.text) for doc in docs])
# 取 Top 5
```

**为什么重排**：
- 向量检索（双塔）快但粗
- Cross-Encoder（单塔）慢但准
- 召回用粗排，最终用精排

## 五、生成（带引用）

```python
prompt = f"""
基于以下资料回答问题，引用来源。

资料：
[1] {docs[0].text} (来源: {docs[0].source})
[2] {docs[1].text} (来源: {docs[1].source})
...

问题：{question}

要求：
- 只基于资料回答，不要编造
- 引用来源（如"根据[1]..."）
- 资料不足时说"暂无相关信息"
"""

answer = llm.generate(prompt)
```

## 六、内容场景应用

**1. UGC 智能问答（评价摘要）**：
```
用户："这个商品评价怎么样？"
RAG：
  - 检索商品相关评价（向量+商品 ID 过滤）
  - 重排取 Top K
  - LLM 总结（好评点/差评点/总体）
  - 带引用（"用户 A 说物流快"）
```

**2. 审核 RAG（违规案例参考）**：
```
Agent 审核时：
  - 输入：待审内容
  - RAG 检索：相似历史违规案例
  - LLM 结合案例判断（一致性）
  - 输出：违规类型+相似案例 ID
  
效果：新型违规快速识别（参考历史相似）
```

**3. 平台政策问答（客服/用户）**：
```
用户："怎么退款？"
RAG：
  - 检索退款政策
  - LLM 生成步骤+引用政策条款
```

**4. 行家内容检索**：
```
找行家深度评测：
  - 向量检索（语义相似）
  - 过滤（行家标记）
  - 重排（权威度加权）
```

## 七、防幻觉

```
1. 只基于检索资料生成（不凭空）
2. 输出带引用（可追溯）
3. 资料不足明确说（不编）
4. 事实核查（与 DB/RAG 对比）
5. 置信度阈值（低不答）
```

## 八、工程优化

**缓存**：
```
相似问题缓存（Embedding 相似度 >0.95 命中）
减少 LLM 调用
```

**增量索引**：
```
新评价/政策实时入向量库
Kafka → 消费 → Embedding → 写入
保证知识库新鲜
```

**多模态 RAG**：
```
图片 → 视觉模型生成描述 → 入库
查询时图文联合检索
```

## 九、评测

```
检索质量：
  - Recall@K（召回率）
  - MRR（倒数排名）
  
生成质量：
  - 准确率（事实对不对）
  - 引用准确率（引用对不对）
  - 用户满意度
  
端到端：
  - 解决率（用户问题解决）
  - 转人工率
```

## 十、底层本质

RAG 本质是**"用检索增强 LLM 的知识边界"**——切片+Embedding+向量检索+重排+带引用生成；内容场景特别适合（UGC 海量+审核需要案例参考+客服需要政策），比微调灵活，比纯 LLM 准确。

## 常见考点
1. **RAG 和微调怎么选**？——RAG 适合知识频繁变/私有数据，微调适合任务/风格固化。
2. **怎么提升召回**？——查询改写+混合检索（向量+BM25）+重排。
3. **切片策略怎么定**？——按语义（段落）优于固定长度，重叠防切断。
