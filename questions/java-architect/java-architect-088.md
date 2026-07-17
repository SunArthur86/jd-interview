---
id: java-architect-088
difficulty: L2
category: java-architect
subcategory: RAG 工程
tags:
- Java 架构师
- RAG
- 向量检索
- 权限
feynman:
  essence: RAG = 检索 + 生成，工程难点不在"接个向量库"，而在让召回结果"对、新、全、合规"——对（语义相关）、新（索引新鲜度）、全（不漏关键文档）、合规（权限过滤不泄露）。权限必须前置（检索前过滤），不能后置（生成后才发现越权）。
  analogy: 像一个带门禁的企业资料室——用户提问时，管理员先核对借阅证（权限），再去对应书架（向量索引）找，找到后还要确认每份文件都没过期（freshness），最后才让顾问（LLM）基于这些文件回答并标注出处。
  first_principle: LLM 的知识有截止时间且可能幻觉。RAG 用"先检索相关文档再喂给模型"解决这两个问题。但检索本身引入新问题：召回的文档可能不相关（噪声）、可能过期（stale）、可能越权（泄露）、可能不全（漏召回）。这四个问题的工程解就是索引设计、召回策略、权限过滤、引用校验。
  key_points:
  - 索引层：文档 → 切片（chunk）→ embedding → 向量库（Milvus/pgvector），区分全量构建和增量更新
  - 召回层：混合检索（向量 + BM25 倒排）+ 重排（cross-encoder）提升精度
  - 权限层：检索前过滤（pre-filter by ACL），绝不能检索后过滤（会漏召回且泄露风险）
  - 引用层：答案必须带 citation，无法回答时明确拒答，避免幻觉
  - 评估：retrieval_hit_rate（召回命中率）、answer_citation_rate（引用率）、permission_filter_miss（权限漏检）
first_principle:
  problem: 如何让 LLM 基于企业私有知识库给出"准确、最新、不越权、可溯源"的回答？
  axioms:
  - LLM 知识有截止时间，无法回答私有/最新数据
  - 直接把全量知识塞进 prompt 不现实（context window 有限且贵）
  - 检索质量决定生成质量（garbage in garbage out）
  - 权限是硬约束：A 部门用户不能看到 B 部门的机密文档，哪怕语义相关
  rebuild: 文档经切片+embedding 入向量库，查询时先做权限过滤（pre-filter）缩小候选集，再做混合检索（向量+BM25）召回 Top-K，cross-encoder 重排取 Top-3，喂给 LLM 生成带引用的回答，无法回答时拒答。索引通过 CDC（Change Data Capture）或定时任务保持新鲜度。
follow_up:
  - 向量库怎么选？——Milvus（分布式、亿级、Java SDK 成熟）适合大规模；pgvector（Postgres 扩展、ACID、运维简单）适合中小规模且已有 PG；Pinecone（托管、贵）适合不想运维。JD 这种规模一般自建 Milvus。
  - 切片（chunk）多大合适？——一般 256-512 token，重叠 50 token。太小丢上下文，太大稀释相关性。按语义切（标题/段落）比固定长度切更好。
  - 权限过滤怎么做？——pre-filter：向量库的 metadata filter（如 Milvus 的 expr="dept in ['sales','public']"），把无权限文档在检索阶段就排除。绝不能 post-filter（先召回再过滤，会漏且慢）。
  - 索引怎么保持新鲜？——文档变更走 CDC（Debezium 监听 binlog）或消息队列，增量 re-embedding 后 upsert 向量库。监控 index_freshness_seconds（文档更新到可检索的延迟）。
  - 怎么知道召回好不好？——建评测集（query + 相关文档标注），跑 retrieval_hit_rate@k（Top-K 里是否包含相关文档）和 MRR（平均倒数排名）。低于阈值就调切片/embedding/重排。
memory_points:
  - RAG 四难：对（相关）、新（freshness）、全（不漏）、合规（权限）
  - 权限必须 pre-filter（检索前），绝不能 post-filter（检索后）——会漏召回 + 泄露风险
  - 混合检索 = 向量（语义）+ BM25（关键词），cross-encoder 重排提精度
  - 切片 256-512 token + 重叠 50，按语义切优于固定长度
  - 答案必带 citation，无法回答必拒答——这是防幻觉的最后防线
  - 评估金指标：retrieval_hit_rate、answer_citation_rate、permission_filter_miss、index_freshness_seconds
---

# 【Java 后端架构师】RAG 服务的索引、召回与权限过滤

> 适用场景：JD 核心技术。客服机器人要回答"我的订单 888 昨天为什么没发货"，模型不知道你的订单数据——这就需要 RAG。但 RAG 工程化远不止"接个 Milvus"：召回的文档可能过期（昨天退款了但索引还是"待发货"）、可能越权（A 商家的用户看到 B 商家的订单）、可能不相关（召回一堆噪声导致幻觉）。架构师要设计的是一条"可信回答链路"。

## 一、概念层：RAG 链路的四个工程难点

| 难点 | 表现 | 后果 | 解法 |
|------|------|------|------|
| **不相关（噪声）** | 召回的文档语义相似但答非所问 | LLM 基于噪声幻觉 | 混合检索 + cross-encoder 重排 |
| **过期（stale）** | 文档已更新但向量库还是旧版 | 回答错误信息（如已退款还说待发货） | CDC 增量索引 + freshness 监控 |
| **越权（泄露）** | A 用户看到 B 用户的私有文档 | 数据泄露事故 | pre-filter 权限过滤 |
| **幻觉（无引用）** | LLM 编造文档里没有的内容 | 误导用户 | 强制 citation + 拒答策略 |

**核心架构原则**：RAG 的核心不是"接向量库"，而是构建一条**"检索-过滤-重排-生成-引用"的可信链路**，每一环都有质量护栏和可观测指标。

## 二、机制层：索引构建与召回实现

### 2.1 文档切片与 Embedding 入库

```java
@Service
public class IndexingService {

    private final EmbeddingModel embeddingModel;   // Spring AI 的 EmbeddingModel
    private final MilvusClient milvusClient;
    private final TokenTextSplitter splitter;

    // 文档入库完整链路
    public void index(Document doc) {
        // 1. 切片（256 token，重叠 50）
        List<String> chunks = splitter.split(doc.getContent(), 256, 50);

        // 2. 批量 embedding
        List<float[]> vectors = embeddingModel.embed(chunks);

        // 3. 构造向量记录（带 metadata，用于权限过滤和过滤）
        List<InsertParam.Field> fields = IntStream.range(0, chunks.size())
            .mapToObj(i -> InsertParam.Field.builder()
                .name(buildChunkId(doc, i))
                .vector(vectors.get(i))
                .metadata(Map.of(
                    "doc_id", doc.getId(),
                    "tenant_id", doc.getTenantId(),      // 租户隔离
                    "dept", doc.getDept(),                // 部门权限
                    "acl", doc.getAcl().toString(),       // 访问控制列表
                    "version", doc.getVersion(),          // 版本号
                    "updated_at", doc.getUpdatedAt()      // 新鲜度
                ))
                .build())
            .collect(toList());

        // 4. upsert（同 doc_id+version 先删后插，避免重复）
        milvusClient.upsert(InsertParam.builder()
            .collectionName("kb_chunks")
            .fields(fields)
            .build());
    }
}
```

**Milvus Collection 建表**（HNSW 索引，平衡精度和速度）：

```python
# HNSW 参数：M=16, efConstruction=200，召回率 95%+ 且查询 < 10ms
collection_params = {
    "fields": [
        {"name": "chunk_id", "type": "VARCHAR", "is_primary": True, "max_length": 64},
        {"name": "vector", "type": "FLOAT_VECTOR", "dim": 1536},
        {"name": "tenant_id", "type": "VARCHAR", "max_length": 32},   # 标量过滤字段
        {"name": "dept", "type": "VARCHAR", "max_length": 32},
        {"name": "acl", "type": "JSON"},
        {"name": "version", "type": "INT64"},
        {"name": "updated_at", "type": "INT64"},
    ],
    "index": {"field": "vector", "type": "HNSW", "params": {"M": 16, "efConstruction": 200}}
}
```

### 2.2 增量索引（保持 freshness）

```java
// CDC 方式：Debezium 监听 MySQL binlog，文档变更触发 re-index
@Component
public class DocChangeConsumer {

    @KafkaListener(topics = "kb.doc.change")
    public void onDocChange(ChangeEvent event) {
        if (event.getType() == DELETE) {
            milvusClient.delete(DeleteParam.builder()
                .collectionName("kb_chunks")
                .expr("doc_id == '" + event.getDocId() + "'")
                .build());
        } else {
            indexingService.index(documentRepo.findById(event.getDocId()));
        }
        // 记录新鲜度指标：文档更新到可检索的延迟
        metrics.gauge("index_freshness_seconds",
            System.currentTimeMillis() / 1000 - event.getUpdatedAt());
    }
}
```

### 2.3 混合检索 + 权限过滤（核心）

**关键：权限 pre-filter，绝不能 post-filter。**

```java
@Service
public class RetrievalService {

    private final MilvusClient milvusClient;
    private final EmbeddingModel embeddingModel;
    private final ElasticsearchClient esClient;       // BM25 倒排
    private final CrossEncoderReranker reranker;       // 重排

    public List<Chunk> retrieve(Query query, UserContext user) {
        // 1. 构造权限过滤表达式（pre-filter，在检索阶段就排除）
        String aclFilter = buildAclFilter(user);
        // 例：tenant_id == 'jd' && dept in ['sales','public'] && json_contains(acl, 'user_123')

        // 2. 向量检索（带权限 filter）
        float[] queryVec = embeddingModel.embed(query.getText());
        List<Chunk> vecResults = milvusClient.search(SearchParam.builder()
            .collectionName("kb_chunks")
            .vector(queryVec)
            .topK(50)                                   // 初筛多召回
            .expr(aclFilter)                            // 关键：权限过滤
            .build());

        // 3. BM25 关键词检索（带权限 filter）
        List<Chunk> bm25Results = esClient.search(s -> s
            .index("kb_chunks")
            .query(q -> q.bool(b -> b
                .must(m -> m.match(t -> t.field("content").query(query.getText())))
                .filter(f -> f.term(t -> t.field("tenant_id").value(user.getTenantId())))
            ))
            .size(50), Chunk.class).hits();

        // 4. 融合（RRF - Reciprocal Rank Fusion）
        List<Chunk> merged = rrfFuse(vecResults, bm25Results);

        // 5. cross-encoder 重排（精度提升关键，从 50 取 top 5）
        List<Chunk> reranked = reranker.rerank(query.getText(), merged, 5);

        // 6. 新鲜度过滤（排除过期版本）
        return reranked.stream()
            .filter(c -> c.getVersion() >= docRepo.currentVersion(c.getDocId()))
            .collect(toList());
    }

    private String buildAclFilter(UserContext user) {
        // 租户隔离 + 部门权限 + 用户级 ACL
        return String.format(
            "tenant_id == '%s' && (dept in %s || json_contains(acl, '%s'))",
            user.getTenantId(), user.getAccessibleDepts(), user.getUserId()
        );
    }
}
```

**为什么不能 post-filter**：假设向量检索召回 50 条，其中 30 条无权限，post-filter 后只剩 20 条——可能漏掉真正相关的高分文档（它在 50 名之外，本该被召回但因权限文档挤占名额）。pre-filter 在检索时就排除，保证召回的是权限内最相关的。

## 三、实战层：生成、引用与拒答

```java
@Service
public class RagAnswerService {

    private final RetrievalService retrieval;
    private final ChatClient llm;
    private final CitationValidator citationValidator;

    private static final String RAG_PROMPT = """
        你只能基于以下检索文档回答用户问题。如果文档中没有相关信息，必须回答"根据现有资料无法回答"。
        每个事实陈述后必须标注来源，格式：[doc_id:chunk_id]。

        检索文档：
        {context}

        用户问题：{question}
        """;

    public RagAnswer answer(Query query, UserContext user) {
        // 1. 检索（带权限过滤）
        List<Chunk> chunks = retrieval.retrieve(query, user);

        // 2. 构造 context（带来源标识）
        String context = chunks.stream()
            .map(c -> String.format("[%s:%s] %s", c.getDocId(), c.getChunkId(), c.getContent()))
            .collect(joining("\n\n"));

        // 3. 生成（强制引用 + 拒答策略）
        String raw = llm.prompt()
            .system("你是 JD 客服助手。只基于检索文档回答，不得编造。")
            .user(RAG_PROMPT.replace("{context}", context).replace("{question}", query.getText()))
            .call()
            .content();

        // 4. 引用校验（回答里引用的 doc_id 必须在检索结果中）
        citationValidator.validate(raw, chunks);

        // 5. 记录指标
        metrics.counter("rag.answer.cited").increment(containsCitation(raw) ? 1 : 0);

        return new RagAnswer(raw, chunks);
    }
}
```

## 四、底层本质：为什么权限必须前置

这是 RAG 工程化最容易翻车的点，单独深挖。

**场景**：JD 有商家 A 和商家 B。商家 A 的客服问"昨天的退货政策"，向量检索召回 Top-5，其中 3 条是商家 B 的退货政策（语义高度相似）。

**Post-filter（错误做法）**：先召回 50 条 → 过滤掉商家 B 的 → 剩 20 条 → 取 Top-5。问题：商家 A 的相关文档可能排在第 6-50 名之外（被商家 B 的高分文档挤掉），过滤后召回质量骤降。更严重的是，如果模型 prompt 已经塞了过滤前的文档，存在泄露窗口。

**Pre-filter（正确做法）**：检索时带 `tenant_id == 'A'`，直接在商家 A 的文档子集里找 Top-5。保证召回的是权限范围内最相关的，且模型上下文里绝不会出现商家 B 的内容。

这个原则推广到所有 RAG 场景：**权限是检索阶段的硬约束，不是生成阶段的后置检查**。工程实现上就是向量库的 metadata filter（Milvus expr、pgvector 的 WHERE、Pinecone 的 namespace）。

## 五、AI 工程化深挖：评估、护栏与可观测

1. **RAG 效果怎么评估，不靠"感觉挺好"？**
   建三层 eval：(1) 检索层，retrieval_hit_rate@k（Top-K 是否包含标注的相关文档）、MRR（相关文档排名倒数）；(2) 生成层，answer_citation_rate（带引用比例）、faithfulness（回答是否忠于检索文档，不幻觉）；(3) 业务层，user_feedback_score（点赞/点踩）、人工处理率。每次 embedding/切片/重排模型升级，跑离线 eval 看指标是否退化。

2. **召回质量差怎么调？**
   按链路定位：hit_rate 低 → 检索阶段问题（调 embedding 模型、chunk 大小、是否启用混合检索）；hit_rate 高但 answer 差 → 重排或生成问题（换更强的 cross-encoder、调 prompt）。最常见的是 chunk 太大稀释语义——切成 256 token 通常比 1024 好。

3. **索引 freshness 怎么保证且不爆系统？**
   增量优于全量。CDC（Debezium 监听 binlog）实时性最好（秒级），但写入压力大；定时任务（每 5 分钟扫 updated_at）折中。监控 index_freshness_seconds，超阈值（如 > 60s）告警。对"已退款但索引还是待发货"这种业务一致性敏感场景，回答时再做一次源系统校验（double check）。

4. **多租户 RAG 怎么隔离？**
   三层隔离：(1) Collection 级（大租户独立 collection，物理隔离最强）；(2) Partition 级（Milvus partition，中等）；(3) Metadata filter（tenant_id 过滤，轻量但依赖 filter 正确性）。JD 这种多商家场景一般 partition + filter 双保险。

5. **RAG 链路怎么和 trace 串联？**
   每次 RAG 查询生成 span 树：`rag.query` → `rag.embed`（query embedding）→ `rag.retrieve.vector`（向量检索，带 hit_count）→ `rag.retrieve.bm25` → `rag.rerank` → `rag.generate`（LLM 调用，带 token/cost）。traceId 贯穿，排查"为什么这次回答错了"时能下钻到具体召回了哪些 chunk、LLM 收到的 context 是什么。

## 六、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"切片、混合、前置、引用"** 四个词。

- **切片**：256-512 token + 重叠 50，按语义切优于固定长度
- **混合**：向量（语义）+ BM25（关键词），RRF 融合，cross-encoder 重排
- **前置**：权限 pre-filter（检索阶段过滤），绝不 post-filter
- **引用**：答案必带 citation，无法回答必拒答

### 面试现场 60 秒回答

> RAG 工程化的核心不是接向量库，是构建可信回答链路。索引层：文档切片（256 token + 重叠 50）→ embedding → Milvus，通过 Debezium CDC 监听 binlog 做增量索引，监控 index_freshness_seconds 保证新鲜度。召回层：混合检索（向量 + BM25），RRF 融合后 cross-encoder 重排取 Top-5。权限层是最容易翻车的——必须 pre-filter（检索时带 tenant_id 和 ACL 过滤），绝不 post-filter，否则会漏召回且有泄露风险。生成层：prompt 强制要求带 [doc_id:chunk_id] 引用，无法回答时拒答，输出做 citation 校验防止幻觉。评估指标四个：retrieval_hit_rate（召回准不准）、permission_filter_miss（权限漏不漏）、index_freshness_seconds（索引新不新）、answer_citation_rate（回答带不带引用）。

### 反问面试官

> 贵司 RAG 的知识库是结构化（订单/商品，走 SQL + 语义层）还是非结构化（文档/手册，走向量检索）？两者架构差异很大——结构化 RAG 要做 Text-to-SQL，非结构化才是传统向量检索。

## 七、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不直接 fine-tune 模型，要搞 RAG？ | RAG 优势：知识可热更新（不用重训）、可溯源（带引用）、省成本（不用 GPU 训练）、可权限控制。Fine-tune 适合风格/格式定制，不适合知识更新。两者互补：fine-tune 调风格，RAG 喂知识 |
| 证据追问 | 你怎么证明 RAG 比直接问 LLM 好？ | 用标注评测集跑 retrieval_hit_rate、answer_citation_rate、faithfulness（回答是否忠于文档）。对比"无 RAG"和"有 RAG"的幻觉率。线上看 user_feedback_score 和人工接管率 |
| 边界追问 | RAG 解决不了什么？ | 推理类任务（数学、逻辑链）、需要全量知识聚合的任务（"统计所有订单"应走 SQL 不是 RAG）、实时数据（仍需 freshness 保障）。结构化数据查询走 Text-to-SQL 更合适 |
| 反例追问 | 什么场景不上向量检索？ | 纯关键词匹配（如商品 SKU 编码精确查找）走 ES 更准；结构化统计（"昨天销量"）走 SQL；超小知识库（< 100 文档）直接塞 prompt |
| 风险追问 | RAG 上线最大风险是什么？ | 权限泄露（post-filter 或 filter 写错）。兜底：pre-filter + 单元测试覆盖权限矩阵 + 线上红蓝对抗（用无权限账号探测）。第二风险是召回质量差导致幻觉，兜底是 citation 校验 + 拒答策略 |
| 验证追问 | 召回质量怎么持续保障？ | 建评测集（query + 相关文档标注），CI/CD 里跑 retrieval_hit_rate，低于阈值（如 0.8）阻断发布。线上采样人工标注，监控指标漂移 |
| 沉淀追问 | 团队 RAG 规范沉淀什么？ | 切片规范（按文档类型给不同 chunk 策略）、权限矩阵模板、prompt 模板库（版本化 + eval）、retrieval_hit_rate 和 permission_filter_miss 的告警阈值、RAG 接入 Code Review checklist |

### 现场对话示例

**面试官**：你说权限要 pre-filter，但 Milvus 的 metadata filter 性能行吗？亿级数据带过滤会不会很慢？

**候选人**：Milvus 2.x 的标量过滤是在向量索引内部做的（不是先查再过滤），性能取决于过滤的选择性。如果权限过滤能砍掉 90% 数据（如租户隔离），反而加速。真正慢的是过滤后候选集太小（< 100），HNSW 的 ef 要调大保证召回。生产实践：租户+部门做粗粒度 partition（物理分片），用户级 ACL 做 filter（细粒度），两级结合性能和灵活性都够。

**面试官**：混合检索的 RRF 融合具体怎么算？

**候选人**：RRF（Reciprocal Rank Fusion）公式 score = Σ 1/(k + rank_i)，k 一般取 60。比如某文档在向量检索排第 3、BM25 排第 10，RRF 分数 = 1/63 + 1/70 ≈ 0.031。比简单加权平均好在不用调权重，对不同检索器的分数分布鲁棒。融合后再用 cross-encoder（如 bge-reranker）做精排，把 query 和每个 chunk 拼一起算相关性分数，取 Top-5。cross-encoder 比双塔（embedding）精度高但慢 10 倍，所以只重排 Top-50。

**面试官**：如果检索回来的文档本身有矛盾（如新旧两版政策），怎么办？

**候选人**： freshness 过滤是第一道防线——检索结果按 version 和 updated_at 过滤，只保留最新版本。第二道是 prompt 里明确要求"如果文档有矛盾，以 updated_at 最新的为准，并注明"。第三道是源系统校验——对资金、状态这类强一致数据，回答前再查一次 MySQL 确认当前值，不纯信索引。监控 index_freshness_seconds，超 60s 告警。

## 常见考点

1. **向量库怎么选？**——Milvus（分布式、亿级、HNSW/IVF 索引）适合大规模自建；pgvector（PG 扩展、ACID、运维简单、IVFFlat/HNSW）适合中小规模且已有 PG；Pinecone（托管、免运维、贵）适合快速验证。选型看数据量、是否要事务、运维能力。
2. **chunk 大小怎么定？**——256-512 token 是经验值，重叠 50 token 防止切断语义。更优的是按结构切（Markdown 按标题、代码按函数、PDF 按章节）。chunk 太小丢上下文，太大稀释相关性分数。要做 A/B 实验定。
3. **embedding 模型怎么选？**——中文用 bge-large-zh、m3e；英文用 text-embedding-3-large（OpenAI）、bge-large-en。维度越高（1024/1536）精度越好但存储和计算成本越高。私有化部署首选 BGE 系列（开源、中文好）。
4. **什么是 hybrid search 和 RRF？**——hybrid = 向量检索（语义）+ BM25（关键词）并行，RRF（倒数排名融合）合并两路结果。比单路召回率高 15-30%，是 RAG 标配。
5. **RAG 怎么防幻觉？**——三道防线：(1) prompt 强制"只基于文档回答，无依据拒答"；(2) citation 校验（回答引用的 doc_id 必须在 context 里）；(3) faithfulness 评估（离线检测回答是否忠于文档）。三者结合把幻觉率压到 5% 以下。

## 结构化回答

**30 秒电梯演讲：** RAG = 检索 + 生成，工程难点不在接个向量库，而在让召回结果对、新、全、合规——对（语义相关）、新（索引新鲜度）、全（不漏关键文档）、合规（权限过滤不泄露）。权限必须前置（检索前过滤），不能后置（生成后才发现越权）

**展开框架：**
1. **索引层** — 文档 → 切片（chunk）→ embedding → 向量库（Milvus/pgvector），区分全量构建和增量更新
2. **召回层** — 混合检索（向量 + BM25 倒排）+ 重排（cross-encoder）提升精度
3. **权限层** — 检索前过滤（pre-filter by ACL），绝不能检索后过滤（会漏召回且泄露风险）

**收尾：** 以上是我的整体思路。您想继续深入聊——向量库怎么选？


## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：RAG 服务的索引、召回与权限过滤 | "这题核心是——RAG = 检索 + 生成，工程难点不在接个向量库，而在让召回结果对、新、全、合规——对（语……" | 开场钩子 |
| 0:15 | 索引层示意/对比图 | "文档 → 切片（chunk）→ embedding → 向量库（Milvus/pgvector），区分全量构建和增量更新" | 索引层要点 |
| 0:40 | 召回层示意/对比图 | "混合检索（向量 + BM25 倒排）+ 重排（cross-encoder）提升精度" | 召回层要点 |
| 1:25 | 总结卡 | "记住：RAG 四难。下期见。" | 收尾 |
