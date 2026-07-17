---
id: java-architect-160
difficulty: L4
category: java-architect
subcategory: RAG 工程
tags:
- Java 架构师
- RAG评测
- 重排
- 置信度
feynman:
  essence: RAG 召回评测的本质是"用标注好的 query-doc 对量化检索质量"——recall@k（Top-K 是否包含相关文档）、MRR（相关文档排名倒数）、NDCG（排序质量）。重排（rerank）是用 cross-encoder 精排双塔召回的粗结果，把"语义相关但排序不准"修正到准确。答案置信度是"让模型自评 + 检索证据支撑度"双信号融合，低置信度触发拒答或转人工。
  analogy: 像高考录取——双塔召回是"初筛过线"（量大但粗），cross-encoder 重排是"面试精筛"（慢但准），置信度是"综合分是否够投档线"（不够就补录或退档）。
  first_principle: 检索质量 = 召回率 × 精确率 × 排序质量。双塔（embedding）召回率高但排序粗（只算向量余弦），cross-encoder 精排排序准但慢（query+doc 拼接过 transformer）。两者级联：双塔取 Top-50，cross-encoder 精排取 Top-5，兼顾召回和精度。
  key_points:
  - 评测三指标：recall@k（召回率）、MRR（平均倒数排名）、NDCG（归一化折损累积增益）
  - 重排核心：cross-encoder（bge-reranker）比双塔精度高 10-20%，但慢 10 倍，只重排 Top-50
  - RRF 融合：向量 + BM25 两路召回用 RRF 合并，score = Σ 1/(k+rank)，k=60
  - 答案置信度：logit_entropy（模型不确定性）+ citation_coverage（引用覆盖率）+ retrieval_score（检索分数）
  - 拒答策略：置信度 < 阈值 → "根据现有资料无法回答" → 转人工或换检索策略
first_principle:
  problem: 如何让 RAG 的召回结果又准又排序合理，且对"无法回答的问题"有可靠的拒答机制？
  axioms:
  - 双塔召回（query 和 doc 独立 embedding）丢失了 query-doc 交互信息，排序精度有限
  - cross-encoder（query+doc 拼接）捕获交互信息，精度高但计算量大（每对都要过 transformer）
  - 召回不相关文档会污染 LLM 上下文导致幻觉，必须用置信度兜底
  - 评测必须离线化（标注集）+ 在线化（用户反馈），不能靠感觉
  rebuild: 三段式——双塔召回 Top-50（混合向量+BM25 用 RRF 融合）→ cross-encoder 重排 Top-5（bge-reranker）→ 喂 LLM 生成答案并算置信度（logit + citation + retrieval 三信号），低置信度拒答转人工。离线用标注集跑 recall@10/MRR/NDCG，在线看 answer_citation_rate 和 user_feedback。
follow_up:
  - cross-encoder 为什么比双塔准？——双塔是 query 和 doc 分别编码后算余弦，交互信息只在最后点积；cross-encoder 是 query+doc 拼接后过 transformer，每层都有 attention 交互，能捕获细粒度匹配（如"退货"和"7天无理由"的语义关联）。
  - 重排模型怎么选？——中文用 bge-reranker-large（27亿参数，精度高）、bge-reranker-base（560M，性价比高）。英文用 cohere-rerank-3 或 bge-reranker-en。私有化部署首选 BGE 系列（开源）。
  - 置信度阈值怎么定？——用标注集跑，把"应该能回答"和"应该拒答"两类样本的置信度分布画出来，取两类分布交叉点作为阈值。一般 0.6-0.7。
  - 召回质量突然下降怎么发现？——在线监控 recall@10（用隐式反馈：用户点了"没有帮助"的 query 回溯看召回结果）+ 离线回归测试（每次索引/embedding 变更跑评测集）。
  - NDCG 和 MRR 区别？——MRR 只看第一个相关文档的排名；NDCG 考虑所有相关文档的排名且靠前的权重更高（折损）。推荐场景用 NDCG（多相关文档），问答场景用 MRR（一个正确答案）。
memory_points:
  - 评测三指标：recall@k（召回）、MRR（首命中排名）、NDCG（排序质量）
  - 重排：cross-encoder（bge-reranker）比双塔精度高 10-20%，只重排 Top-50
  - RRF 融合：score = Σ 1/(k+rank)，k=60，向量+BM25 两路合并
  - 置信度三信号：logit_entropy + citation_coverage + retrieval_score
  - 拒答：置信度 < 0.6 拒答转人工，防幻觉最后防线
---

# 【Java 后端架构师】RAG 召回评测、重排与答案置信度

> 适用场景：JD 核心技术。客服 RAG 上线后，发现 20% 的回答"看起来对但引用错了文档"，10% 的问题明明知识库有答案却答非所问。问题不在 LLM，在召回——双塔召回的 Top-5 里有 2 个不相关文档，排序也乱。架构师要从"召回评测、cross-encoder 重排、答案置信度"三个维度把 RAG 质量拉起来。

## 一、概念层：RAG 质量的三层评测

| 层级 | 指标 | 含义 | 目标 |
|------|------|------|------|
| **检索层** | recall@k | Top-K 是否包含相关文档 | > 0.9 |
| **检索层** | MRR | 第一个相关文档的排名倒数 | > 0.7 |
| **检索层** | NDCG@k | 排序质量（靠前相关文档权重高） | > 0.8 |
| **生成层** | faithfulness | 回答是否忠于检索文档 | > 0.95 |
| **生成层** | answer_citation_rate | 回答带引用的比例 | > 0.9 |
| **业务层** | user_feedback_score | 用户点赞/点踩 | > 4.0/5 |
| **业务层** | first_contact_resolution | 首次解决率 | > 0.7 |

## 二、机制层：混合召回 + RRF 融合

```java
@Service
public class HybridRetrievalService {

    private final MilvusClient vectorStore;          // 向量检索
    private final ElasticsearchClient esClient;      // BM25 检索
    private final CrossEncoderReranker reranker;     // 重排

    public List<Chunk> retrieve(String query, UserContext user) {
        // 1. 向量召回 Top-50（语义相关）
        float[] queryVec = embeddingModel.embed(query);
        List<Chunk> vecResults = vectorStore.search(
            SearchParam.builder()
                .vector(queryVec).topK(50)
                .expr(buildAclFilter(user))           // 权限 pre-filter
                .build());

        // 2. BM25 召回 Top-50（关键词匹配）
        List<Chunk> bm25Results = esClient.search(
            s -> s.index("kb_chunks")
                .query(q -> q.match(m -> m.field("content").query(query)))
                .size(50), Chunk.class);

        // 3. RRF 融合（Reciprocal Rank Fusion）
        List<Chunk> merged = rrfFuse(vecResults, bm25Results, 60);

        // 4. cross-encoder 重排 Top-50 → Top-5
        List<Chunk> reranked = reranker.rerank(query, merged, 5);

        return reranked;
    }

    /**
     * RRF 融合：score = Σ 1/(k + rank_i)
     * 不用调权重，对不同检索器的分数分布鲁棒
     */
    private List<Chunk> rrfFuse(List<Chunk> vec, List<Chunk> bm25, int k) {
        Map<String, Double> scores = new HashMap<>();
        Map<String, Chunk> chunkMap = new HashMap<>();

        for (int i = 0; i < vec.size(); i++) {
            Chunk c = vec.get(i);
            scores.merge(c.getChunkId(), 1.0 / (k + i + 1), Double::sum);
            chunkMap.put(c.getChunkId(), c);
        }
        for (int i = 0; i < bm25.size(); i++) {
            Chunk c = bm25.get(i);
            scores.merge(c.getChunkId(), 1.0 / (k + i + 1), Double::sum);
            chunkMap.put(c.getChunkId(), c);
        }
        return scores.entrySet().stream()
            .sorted(Map.Entry.<String, Double>comparingByValue().reversed())
            .map(e -> chunkMap.get(e.getKey()))
            .collect(toList());
    }
}
```

## 三、机制层：cross-encoder 重排

```java
@Service
public class CrossEncoderReranker {

    private final ONNXModel model;    // bge-reranker-large（ONNX 部署）

    /**
     * Cross-encoder：query + doc 拼接过 transformer，输出相关性分数
     * 比双塔精度高 10-20%（捕获 query-doc 交互），但慢 10 倍
     */
    public List<Chunk> rerank(String query, List<Chunk> candidates, int topK) {
        // 1. 构造 query-doc 对
        List< Pair<String, String>> pairs = candidates.stream()
            .map(c -> Pair.of(query, c.getContent()))
            .collect(toList());

        // 2. 批量推理（bge-reranker 输出相关性分数 0-1）
        List<Double> scores = model.scoreBatch(pairs);

        // 3. 按分数排序取 Top-K
        return IntStream.range(0, candidates.size())
            .boxed()
            .sorted(Comparator.comparing(scores::get).reversed())
            .limit(topK)
            .map(candidates::get)
            .collect(toList());
    }
}
```

**为什么 cross-encoder 比双塔准**：
- 双塔：query 和 doc 分别 embedding，最后算余弦。交互信息只在最后点积。
- cross-encoder：`[CLS] query [SEP] doc [SEP]` 拼接后过 transformer，每层 attention 都有 query-doc 交互，能捕获"退货"和"7天无理由"的细粒度关联。

代价：cross-encoder 每对都要过 transformer（O(N) 次），双塔 doc 可预编码（query 只编码 1 次）。所以 cross-encoder 只重排 Top-50，不直接做全库检索。

## 四、机制层：答案置信度与拒答

```java
@Service
public class RagConfidenceService {

    private final ChatClient llm;

    public RagAnswer answerWithConfidence(String query, List<Chunk> context) {
        // 1. 生成答案（要求模型输出 logprobs 评估不确定性）
        LlmResponse response = llm.prompt()
            .system(RAG_SYSTEM_PROMPT)
            .user(buildPrompt(query, context))
            .options(OptionBuilder.logprobs(5))        // 请求 top-5 logprobs
            .call()
            .toLlmResponse();

        // 2. 计算三信号置信度
        double logitConfidence = calcLogitConfidence(response.getLogprobs());
        double citationConfidence = calcCitationCoverage(response.getContent(), context);
        double retrievalConfidence = calcRetrievalScore(context);

        // 3. 融合（加权）
        double confidence = 0.4 * logitConfidence
                          + 0.3 * citationConfidence
                          + 0.3 * retrievalConfidence;

        // 4. 低置信度拒答
        if (confidence < 0.6) {
            metrics.counter("rag.refuse").increment();
            return RagAnswer.refuse("根据现有资料无法回答，已转人工", confidence);
        }

        return RagAnswer.of(response.getContent(), context, confidence);
    }

    /**
     * logit 置信度：模型生成 token 的平均 logprob
     * logprob 高说明模型确定，低说明不确定（可能幻觉）
     */
    private double calcLogitConfidence(List<LogProb> logprobs) {
        double avg = logprobs.stream()
            .mapToDouble(lp -> Math.exp(lp.getLogprob()))
            .average().orElse(0);
        return sigmoid(avg);   // 归一化到 0-1
    }

    /**
     * 引用覆盖率：回答里引用的 doc_id 是否都在检索结果中
     * 引用不存在的文档 = 幻觉
     */
    private double calcCitationCoverage(String answer, List<Chunk> context) {
        Set<String> validDocIds = context.stream()
            .map(Chunk::getDocId).collect(toSet());
        Set<String> citedDocIds = extractCitations(answer);
        if (citedDocIds.isEmpty()) return 0;          // 无引用 = 低置信
        long valid = citedDocIds.stream()
            .filter(validDocIds::contains).count();
        return (double) valid / citedDocIds.size();
    }

    /**
     * 检索分数：Top-1 chunk 的相关性分数
     */
    private double calcRetrievalScore(List<Chunk> context) {
        if (context.isEmpty()) return 0;
        return context.get(0).getScore();              // cross-encoder 分数 0-1
    }
}
```

## 五、实战层：离线评测与在线监控

### 5.1 离线评测集

```java
@Service
public class RagEvalRunner {

    /**
     * 跑标注评测集，算 recall@k / MRR / NDCG
     * 每次 embedding/索引/重排模型变更都跑，指标退化阻断发布
     */
    public EvalReport run(EvalDataset dataset) {
        EvalReport report = new EvalReport();
        for (EvalQuery q : dataset.getQueries()) {
            List<Chunk> results = retrievalService.retrieve(q.getQuery(), q.getUser());
            report.recordRecallAtK(q, results, 10);    // recall@10
            report.recordMRR(q, results);              // MRR
            report.recordNDCG(q, results, 10);         // NDCG@10
        }
        EvalReport summary = report.summarize();
        // recall@10 < 0.9 阻断
        if (summary.getRecallAt10() < 0.9) {
            throw new QualityGateException("recall@10=" + summary.getRecallAt10());
        }
        return summary;
    }
}
```

### 5.2 在线监控指标

```java
// 关键看板指标
// - recall_proxy：用用户反馈反推（点踩的 query 回溯召回，相关文档是否在 Top-K）
// - answer_citation_rate：带引用回答比例
// - refuse_rate：拒答率（过低可能强答幻觉，过高可能阈值太严）
// - avg_confidence：平均置信度，突降说明检索质量退化
// - rerank_latency_p99：重排延迟，cross-encoder 较慢要监控
```

## 六、底层本质：检索质量的三段式优化

RAG 质量问题的根因定位链路：

```
用户反馈"答错了"
  ↓
看 answer_citation_rate 是否下降（生成层问题？）
  ↓ 没降
看 recall@10 是否达标（检索层问题？）
  ↓ recall 低
定位：embedding 模型？chunk 策略？权限过滤误杀？
  ↓ recall 高但排序乱
定位：没上 cross-encoder？或重排模型退化？
  ↓ recall 和排序都好
定位：LLM 幻觉（faithfulness 低）？prompt 不够约束？
```

**三段式优化的本质是"分层归因"**：检索层（recall）→ 排序层（rerank）→ 生成层（faithfulness），每层有独立指标，不混淆。最常见的错误是"回答不好就调 prompt"——如果根因是召回不相关文档，调 prompt 没用，要调检索。

## 七、AI 工程化深挖

1. **怎么建 RAG 评测集不靠人工标注？**
   用 LLM 辅助：从历史 query 日志采样，用强模型（GPT-4）判断每个 query 应该召回哪些文档（LLM-as-judge），人工抽检修正。冷启动用 LLM 生成合成 query（给一个文档生成可能的提问），覆盖长尾。

2. **重排模型怎么调优？**
   通用 bge-reranker 在特定领域（医疗/法律）可能不够准，用领域数据微调（在 bge-reranker 基础上继续训练）。微调数据：query + 正例 doc + 负例 doc（难负例：同主题但不直接回答的 doc）。监控 rerank_lift（重排前后 recall@1 的提升幅度）。

3. **置信度校准怎么做？**
   模型的 logprob 往往过自信（说 0.9 实际只有 0.7 准确率）。用 Platt scaling 或 temperature scaling 校准——在验证集上拟合一个逻辑回归把 raw confidence 映射到真实准确率。校准后的置信度才能作为拒答阈值依据。

4. **多路召回怎么加权融合？**
   RRF 不用调权重但不够灵活。学习排序（LTR）更优——用 XGBoost 训练一个排序模型，特征是各路的分数、文档属性（长度/新鲜度/权威性），输出统一排序分。但需要标注数据，冷启动用 RRF。

5. **RAG 评测怎么集成到 CI/CD？**
   评测集版本化管理（随业务更新）。每次 PR 触发离线评测（recall@10 / faithfulness），指标退化超阈值（如 recall 下降 2%）阻断合并。线上 A/B 测试用同一套指标，保证离线和在线对齐。

## 八、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"recall、rerank、confidence"** 三个词。

- **recall**：双塔召回 Top-50 + BM25 混合，RRF 融合（score=Σ1/(60+rank)）
- **rerank**：cross-encoder（bge-reranker）重排 Top-5，精度高 10-20%，只重排少量
- **confidence**：logit_entropy + citation_coverage + retrieval_score 三信号融合，< 0.6 拒答

### 面试现场 60 秒回答

> RAG 召回我上混合检索——向量召回 Top-50（语义）+ BM25 Top-50（关键词），RRF 融合（公式 score=Σ 1/(60+rank)，不用调权重）。融合后用 cross-encoder（bge-reranker-large）重排 Top-5，cross-encoder 把 query+doc 拼接过 transformer 捕获细粒度交互，比双塔精度高 10-20%，但慢 10 倍所以只重排少量。评测三指标：recall@10（召回率）、MRR（首命中排名）、NDCG（排序质量），离线用标注集跑，recall < 0.9 阻断发布。答案置信度用三信号：logit_entropy（模型不确定性）+ citation_coverage（引用覆盖率）+ retrieval_score（检索分数），加权融合 < 0.6 触发拒答转人工，这是防幻觉最后防线。质量归因分层：recall 低调检索，rerank 后排序还乱调重排，都好但答案差调 prompt 或换 LLM。

## 九、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不直接用更强的 LLM，要优化召回？ | LLM 上限是 context 质量，garbage in garbage out。GPT-4 喂不相关文档也会幻觉。召回是天花板，LLM 是接近天花板的程度。先优化召回再优化 LLM |
| 证据追问 | 怎么证明 cross-encoder 重排有效？ | A/B 对比：无重排 vs 有重排的 recall@1 和 answer_citation_rate。rerank_lift（重排前后 recall@1 提升幅度）是核心指标，通常提 10-20% |
| 边界追问 | RAG 评测解决不了什么？ | 解决不了 query 本身歧义（用户问得不清楚）、知识库没有的答案（recall 再高也没用）、推理类问题（需要多步推理，单次召回不够） |
| 反例追问 | 什么场景不用重排？ | 召回量小（Top-5 已经很准）、延迟敏感（cross-encoder 加 50ms）、简单 FAQ（关键词匹配就够）。过度上重排是浪费 |
| 风险追问 | 置信度拒答的风险？ | 阈值设太高导致大量拒答（用户体验差），设太低漏过幻觉。要校准（Platt scaling）+ 用业务数据调阈值，监控 refuse_rate 在 5-15% 为健康 |
| 验证追问 | 怎么证明评测集有代表性？ | 覆盖真实 query 分布（从日志采样）、覆盖长尾（不只高频 query）、定期更新（业务演进）。用 user_feedback_score 验证——评测集表现好的 query 线上用户也满意 |
| 沉淀追问 | 团队沉淀什么？ | 评测集（版本化）、重排模型微调 pipeline、置信度校准 SOP、RAG 质量看板（recall/citation/confuse_rate）、质量归因 checklist |

## 常见考点

1. **cross-encoder 和双塔区别？**——双塔是 query/doc 独立编码后点积，快但粗；cross-encoder 是拼接后过 transformer，慢但准（捕获交互）。工程上双塔召回 + cross-encoder 重排级联。
2. **RRF 融合为什么不用加权平均？**——不同检索器分数分布不同（向量余弦 0-1，BM25 是 TF-IDF 分数），加权难调。RRF 只用排名（1/(k+rank)），对分数分布鲁棒，k=60 是经验值。
3. **NDCG 怎么算？**——DCG = Σ rel_i / log2(i+1)，NDCG = DCG / IDCG（理想 DCG）。考虑了相关文档的排名位置（靠前权重高）和分级相关性（文档可以"非常相关""一般相关"）。
4. **拒答率多少合适？**——5-15%。过低（< 5%）可能强答幻觉，过高（> 20%）体验差。要结合业务——医疗/法律宁可拒答不可错答，闲聊可以宽松。

## 结构化回答

**30 秒电梯演讲：** RAG 召回评测的本质是用标注好的 query-doc 对量化检索质量——recall@k（Top-K 是否包含相关文档）、MRR（相关文档排名倒数）、NDCG（排序质量）。重排（rerank）是用 cross-encoder 精排双塔召回的粗结果，把语义相关但排序不准修正到准确。答案置信度是让模型自评 + 检索证据支撑度双信号融合，低置信度触发拒答或转人工

**展开框架：**
1. **评测三指标** — recall@k（召回率）、MRR（平均倒数排名）、NDCG（归一化折损累积增益）
2. **重排核心** — cross-encoder（bge-reranker）比双塔精度高 10-20%，但慢 10 倍，只重排 Top-50
3. **RRF 融合** — 向量 + BM25 两路召回用 RRF 合并，score = Σ 1/(k+rank)，k=60

**收尾：** 以上是我的整体思路。您想继续深入聊——cross-encoder 为什么比双塔准？


## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：RAG 召回评测、重排与答案置信度 | "这题核心是——RAG 召回评测的本质是用标注好的 query-doc 对量化检索质量——recall@k（To……" | 开场钩子 |
| 0:15 | 像高考录取——双塔召回是初筛过线（量大但粗）类比图 | "打个比方：像高考录取——双塔召回是初筛过线（量大但粗）。" | 核心类比 |
| 0:40 | 评测三指标示意/对比图 | "recall@k（召回率）、MRR（平均倒数排名）、NDCG（归一化折损累积增益）" | 评测三指标要点 |
| 1:05 | 重排核心示意/对比图 | "cross-encoder（bge-reranker）比双塔精度高 10-20%，但慢 10 倍，只重排 Top-50" | 重排核心要点 |
| 1:30 | RRF 融合示意/对比图 | "向量 + BM25 两路召回用 RRF 合并，score = Σ 1/(k+rank)，k=60" | RRF 融合要点 |
| 1:55 | 总结卡 | "记住：评测三指标。下期见。" | 收尾 |
