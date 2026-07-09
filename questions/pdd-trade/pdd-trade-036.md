---
id: pdd-trade-036
difficulty: L4
category: pdd-trade
subcategory: RAG 工程
tags:
- 拼多多
- 交易
- RAG
- 向量检索
- GraphRAG
feynman:
  essence: RAG 是"给 LLM 挂外挂知识库"——文档切块→向量化→检索→拼 prompt，让 LLM 基于企业知识回答；交易场景 RAG 商品/规则/订单文档，客服/导购场景降幻觉。
  analogy: RAG 像"开卷考试"——LLM 是考生（理解+生成能力），知识库是课本，考试时先翻书（检索）再答，比硬背（训练）准且可更新。
  first_principle: LLM 知识有截止日期+不知道企业私有数据，需外挂检索补知识。
  key_points:
  - 流程：切块→embedding→向量检索→rerank→拼 prompt
  - 文档类型：商品详情/售后规则/FAQ/订单政策
  - 进阶：GraphRAG（关系图）/Hybrid（向量+关键词）
  - 工程：增量更新+缓存+评测
first_principle:
  problem: LLM 不知道企业最新知识（商品/政策/订单），如何外挂？
  axioms:
  - LLM 知识有截止
  - 企业数据私有且更新频繁
  - 直接训练成本高且慢
  rebuild: 文档向量化 + 检索 + 拼 prompt（RAG）。
follow_up:
  - 切块怎么切？——按语义（标题/段落）+ 重叠窗口（防切断上下文）
  - 召回率低怎么办？——Hybrid（向量+BM25）+ Rerank + Query 改写
  - 知识更新怎么同步？——增量索引（文档变更触发 re-embed）
memory_points:
  - 流程：切块→embed→检索→rerank→prompt
  - 切块：语义+重叠窗口
  - Hybrid：向量+BM25
  - GraphRAG：关系图增强
---

# 【拼多多交易】RAG 在交易怎么用？

> JD 依据："RAG 在交易"。

## 一、RAG 流程

```
文档库 → 切块（chunk）→ embedding → 向量库
                                        ↓（检索）
用户问题 → embedding → 相似检索 → rerank → 拼 prompt → LLM 生成
```

## 二、文档处理

**切块策略**：
```python
# 按语义切块（标题/段落）+ 重叠窗口
chunks = semantic_chunk(
    doc,
    max_tokens=500,
    overlap=50,          # 防切断上下文
    split_on=["h1","h2","段落"]
)
```

**文档类型**：
```
商品详情：标题/规格/参数/详情页（每商品独立索引）
售后规则：退货政策/退款流程/争议处理（按政策版本）
FAQ：高频问题+答案（客服自助）
订单政策：拼团/预售/百亿补贴规则
```

## 三、检索+重排

```java
public List<Chunk> retrieve(String query, String docType) {
    // 1. 向量召回（粗排，top50）
    List<Chunk> vec = vectorStore.search(embed(query), topK=50);
    // 2. 关键词召回（BM25，补精确匹配）
    List<Chunk> bm25 = keywordStore.search(query, topK=50);
    // 3. 合并 + 去重
    List<Chunk> merged = merge(vec, bm25);
    // 4. Rerank（精排，cross-encoder，top5）
    return reranker.rerank(query, merged, topK=5);
}
```

**Hybrid 必要性**：
- 纯向量：语义相似但关键词错（"iPhone 15" 检出 "iPhone 14"）
- 纯 BM25：精确但不懂同义（"退款" 匹配不到 "退货"）
- 混合：语义+精确兼顾

## 四、Query 改写

用户问得口语化/模糊，先改写：
```
用户："买的那个还没到"
改写：订单状态查询 → "订单 [订单号] 物流状态 预计送达"
+ 查用户最近订单上下文
```

## 五、GraphRAG（关系增强）

商品/类目/品牌有强关系，传统向量检索忽略结构。

```
知识图：商品 -[属于]-> 类目 -[关联]-> 配件
       商品 -[品牌]-> 品牌 -[同档]-> 竞品
```

GraphRAG：向量召回 + 图扩展（找关联商品/品牌）。

**拼多多导购**：
```
"推荐 iPhone 配件" →
  向量召回：配件商品
  图扩展：iPhone 关联的充电壳/膜/数据线
```

## 六、工程化

**增量索引**：
```java
@KafkaListener(topics = "product-update")
public void onProductUpdate(ProductEvent e) {
    List<Chunk> chunks = chunker.chunk(e.getProduct());
    List<Vector> vectors = embedder.embed(chunks);
    vectorStore.upsert(e.getProductId(), vectors);  // 增量更新
}
```

**缓存**：
```
热门问题（"怎么退款"）→ 缓存答案，命中 60% 流量
```

**评测**：
```
标注集 1000 问 → 召回率/准确率/满意度
新版检索/切块 → 回归评测 → 上线
```

## 七、底层本质

RAG 本质是**"用检索给 LLM 补外挂知识"**——切块平衡精度和上下文，Hybrid+Rerank 提召回质量，GraphRAG 增强关系，增量索引保时效。

## 常见考点
1. **切块多大合适**？——512-1024 token，太大稀释相似度，太小丢上下文，按文档类型调。
2. **Rerank 为什么必要**？——向量召回快但不精（双塔），Rerank（cross-encoder）精排提准确。
3. **RAG 和微调区别**？——RAG 外挂知识（即时更新），微调内化能力（风格/格式），可叠加。
