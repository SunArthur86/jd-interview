---
id: java-architect-064
difficulty: L2
category: java-architect
subcategory: 搜索架构
tags:
- Java 架构师
- 搜索
- 召回
- 排序
- 架构分层
feynman:
  essence: 搜索是电商的"流量入口"——用户搜"手机"，系统要在亿级商品中毫秒级返回最相关的结果。核心挑战是"召回（找候选）和排序（定顺序）的平衡"——召回太多排序慢，召回太少漏好货。架构解法是"漏斗式分层：召回（百万）→ 粗排（万）→ 精排（千）→ 重排（百）"，每层过滤越多但计算越精细，最终给用户最相关的几十个。
  analogy: 像招聘筛选。10 万份简历（全量商品），HR 先粗筛（召回，按学历/经验筛掉明显不符的，剩 1 万）→ 部门初筛（粗排，按技能匹配打分，剩 1000）→ 面试（精排，深度评估，剩 100）→ 终面排序（重排，按综合排名，给 offer 的前 10）。每层筛选更严但成本更高，漏斗式过滤。
  first_principle: 为什么不一次性排序所有商品？因为精排模型（深度学习）计算慢，给百万商品打分要几秒。解法是漏斗——先用便宜的召回（倒排索引，毫秒）从亿级找百万候选，再用粗排（轻量模型）筛到万级，最后精排（重模型）排千级。每一层减少数据量，让重的计算只跑少量数据。
  key_points:
  - 召回（Recall）：从亿级找百万候选，多路（文本/向量/行为），求并集
  - 粗排（Coarse Rank）：轻量模型（双塔/FWDL），百万→万级
  - 精排（Fine Rank）：重模型（DeepFM/DIN），万级→千级，精准打分
  - 重排（Re-rank）：业务规则（多样性/去重/商业），千级→最终展示
  - 索引：倒排（文本）+ 向量（语义）+ 属性（筛选）
first_principle:
  problem: 亿级商品，用户搜一个词，怎么在 100ms 内返回最相关的几十个？
  axioms:
  - 精排模型计算慢（深度学习，单条毫秒级），不能全量精排
  - 召回必须高覆盖率（相关商品不能漏），但要快
  - 用户耐心有限（100ms 内无结果会流失）
  - 商业因素（广告/自营/促销）需融入排序
  rebuild: 漏斗式四层架构。召回层——多路并行（倒排文本召回+向量语义召回+行为召回），求并集得百万候选，毫秒级。粗排层——轻量模型（双塔 DSSM）给百万打分，取 TOP 万。精排层——重模型（DeepFM）给万级打分，取 TOP 千。重排层——业务规则（多样性打散+商业加权+去重），输出最终几十个。全链路 < 100ms。
follow_up:
  - 召回怎么保证不漏好货？——多路召回（文本/向量/行为/类目），各路互补，求并集。监控 recall_coverage（召回覆盖率）。
  - 向量召回怎么做？——商品和查询都 Embedding 成向量，向量近邻搜索（FAISS/HNSW），找语义相近的。
  - 排序模型怎么训练？——点击日志（用户搜了什么点了什么）做训练数据，预估点击率/转化率，按预估排序。
  - 搜索结果怎么做多样性（不全是一个品牌）？——重排层打散（同品牌间隔展示，类目分散），避免单调。
  - 搜索实时性（新商品能搜到）？——增量索引（商品上架实时同步 ES），近实时（秒级）。
memory_points:
  - 漏斗四层：召回→粗排→精排→重排
  - 召回多路：文本/向量/行为，求并集
  - 粗排轻量（双塔），精排重量（DeepFM）
  - 重排业务：多样性/去重/商业加权
  - 索引：倒排+向量+属性
---

# 【Java 后端架构师】搜索召回、排序与架构分层

> 适用场景：JD 搜索核心。用户搜"手机"，亿级商品库，要在 100ms 内返回最相关的结果。不是简单查数据库，而是"召回候选→粗排过滤→精排打分→重排业务"四层漏斗。每一层减少数据量、增加计算精度，最终给用户最可能买的几十个商品。

## 一、概念层：搜索漏斗架构

**四层漏斗架构**（面试必画）：

```
用户查询"手机"
       │
       ▼
┌──────────────────────────────────────────────────────────┐
│ 第 1 层：召回（Recall）—— 从亿级找百万候选                  │
│                                                            │
│  多路并行召回（求并集）：                                   │
│  ┌─ 文本召回：ES 倒排索引，"手机"匹配标题/类目              │
│  ├─ 向量召回：查询 Embedding 找语义相近商品                 │
│  ├─ 行为召回：用户历史点击/购买的相关商品                   │
│  └─ 类目召回：直接取手机类目热销                            │
│                                                            │
│  结果：百万级候选商品（宁多勿漏）                           │
│  耗时：< 30ms（各路并行）                                   │
├──────────────────────────────────────────────────────────┤
│ 第 2 层：粗排（Coarse Rank）—— 百万→万级                   │
│                                                            │
│  轻量模型打分（双塔 DSSM）：                                │
│  - 查询塔：查询 → Embedding                                 │
│  - 商品塔：商品特征 → Embedding                             │
│  - 内积相似度 = 粗排得分                                    │
│                                                            │
│  取 TOP 1万，淘汰尾部                                       │
│  耗时：< 20ms                                               │
├──────────────────────────────────────────────────────────┤
│ 第 3 层：精排（Fine Rank）—— 万级→千级                     │
│                                                            │
│  重模型打分（DeepFM/DIN）：                                 │
│  - 特征：商品属性 + 用户画像 + 查询词 + 上下文               │
│  - 预估：点击率（CTR）× 转化率（CVR）× 价格                 │
│  - 目标：GMV 最大化（最可能买的排前面）                     │
│                                                            │
│  取 TOP 1000                                               │
│  耗时：< 30ms                                               │
├──────────────────────────────────────────────────────────┤
│ 第 4 层：重排（Re-rank）—— 业务规则                        │
│                                                            │|
│  - 多样性打散：同品牌间隔展示（避免全 Apple）               │
│  - 商业加权：广告/自营/促销加权                             │
│  - 去重过滤：已看过的降权                                   │
│  - 分页：取第 1 页（60 个）                                 │
│                                                            │
│  最终展示给用户                                             │
└──────────────────────────────────────────────────────────┘

全链路 < 100ms，返回最可能成交的 60 个商品
```

**为什么分层**（不分层的问题）：

| 方案 | 问题 |
|------|------|
| 直接精排亿级 | DeepFM 单条 10ms，亿级要 1000 秒，不可行 |
| 只用召回+精排 | 召回百万直接精排，百万 × 10ms = 1000 秒 |
| 召回+粗排+精排 | 粗排把百万筛到万，万 × 10ms = 100 秒（还慢） |
| 召回+粗排+精排（千级） | 精排只跑千级，千 × 10ms = 10 秒... 需粗排更狠 |

实际：召回百万→粗排取万→精排取千→重排取百，精排只跑千级（千 × 10ms = 10 秒？不对，精排是批量并行，GPU 千条 < 1 秒）。

## 二、机制层：多路召回实现

**召回服务（多路并行）**：

```java
@Service
public class RecallService {

    @Autowired private TextRecaller textRecaller;
    @Autowired private VectorRecaller vectorRecaller;
    @Autowired private BehaviorRecaller behaviorRecaller;

    /**
     * 多路召回：并行 + 合并去重
     */
    public List<RecallItem> recall(SearchQuery query, UserProfile user) {
        // 四路并行召回
        CompletableFuture<List<RecallItem>> textFuture =
            CompletableFuture.supplyAsync(() -> textRecaller.recall(query));
        CompletableFuture<List<RecallItem>> vectorFuture =
            CompletableFuture.supplyAsync(() -> vectorRecaller.recall(query));
        CompletableFuture<List<RecallItem>> behaviorFuture =
            CompletableFuture.supplyAsync(() -> behaviorRecaller.recall(query, user));

        // 等所有路完成（超时 50ms）
        try {
            CompletableFuture.allOf(textFuture, vectorFuture, behaviorFuture)
                .get(50, TimeUnit.MILLISECONDS);
        } catch (TimeoutException e) {
            log.warn("部分召回超时，用已完成的结果");
        }

        // 合并去重
        Set<Long> recalled = new HashSet<>();
        List<RecallItem> all = new ArrayList<>();
        for (CompletableFuture<List<RecallItem>> f : Arrays.asList(
                textFuture, vectorFuture, behaviorFuture)) {
            if (f.isDone()) {
                for (RecallItem item : f.join()) {
                    if (recalled.add(item.getSkuId())) {   // 去重
                        all.add(item);
                    }
                }
            }
        }

        monitor.record("recall_count", query.getQuery(), all.size());
        return all;   // 百万级
    }
}
```

**文本召回（ES 倒排索引）**：

```java
@Service
public class TextRecaller {

    /**
     * 文本召回：ES 倒排匹配
     */
    public List<RecallItem> recall(SearchQuery query) {
        BoolQueryBuilder bool = QueryBuilders.boolQuery();

        // 标题匹配（权重高）
        bool.should(QueryBuilders.matchQuery("title", query.getQuery())
            .boost(3.0f));
        // 类目匹配
        bool.should(QueryBuilders.termQuery("category_name", query.getQuery())
            .boost(2.0f));
        // 品牌匹配
        bool.should(QueryBuilders.termQuery("brand_name", query.getQuery())
            .boost(2.0f));

        SearchRequest request = SearchRequest.of(s -> s
            .index("product")
            .query(bool)
            .size(10000));   // 取 1 万

        return esClient.search(request)
            .hits().hits().stream()
            .map(h -> new RecallItem(Long.valueOf(h.id()), h.score()))
            .collect(Collectors.toList());
    }
}
```

**向量召回（语义近邻）**：

```java
@Service
public class VectorRecaller {

    /**
     * 向量召回：查询 Embedding + 近邻搜索
     */
    public List<RecallItem> recall(SearchQuery query) {
        // 1. 查询转向量（用 Embedding 模型）
        float[] queryVector = embeddingService.encode(query.getQuery());

        // 2. 向量近邻搜索（FAISS/HNSW）
        List<VectorSearchResult> neighbors = vectorIndex.search(
            queryVector, 10000);   // 找 1 万最近邻

        return neighbors.stream()
            .map(n -> new RecallItem(n.getId(), n.getSimilarity()))
            .collect(Collectors.toList());
    }
}
```

## 三、机制层：粗排与精排

**粗排（双塔模型）**：

```java
@Service
public class CoarseRankService {

    /**
     * 粗排：双塔模型，查询塔 + 商品塔，内积打分
     */
    public List<RankItem> rank(List<RecallItem> candidates, SearchQuery query) {
        // 1. 查询塔：查询 → Embedding（一次计算，复用）
        float[] queryEmb = queryTowerModel.predict(query);

        // 2. 商品塔：商品特征 → Embedding（预计算，查询时直接取）
        // 实际商品 Embedding 离线算好存索引，这里直接批量取
        List<float[]> itemEmbs = itemEmbeddingCache.batchGet(
            candidates.stream().map(RecallItem::getSkuId).collect(Collectors.toList()));

        // 3. 内积打分（向量点积，超快）
        List<RankItem> ranked = new ArrayList<>();
        for (int i = 0; i < candidates.size(); i++) {
            float score = dotProduct(queryEmb, itemEmbs.get(i));
            ranked.add(new RankItem(candidates.get(i), score));
        }

        // 4. 取 TOP 1 万
        ranked.sort((a, b) -> Float.compare(b.getScore(), a.getScore()));
        List<RankItem> top = ranked.subList(0, Math.min(10000, ranked.size()));

        monitor.record("coarse_rank_count", query.getQuery(), top.size());
        return top;
    }

    private float dotProduct(float[] a, float[] b) {
        float sum = 0;
        for (int i = 0; i < a.length; i++) sum += a[i] * b[i];
        return sum;
    }
}
```

**精排（DeepFM 模型预估）**：

```java
@Service
public class FineRankService {

    @Autowired private RankModelClient modelClient;   // Python 模型服务（gRPC）

    /**
     * 精排：DeepFM 预估 CTR×CVR×Price，按 GMV 排序
     */
    public List<RankItem> rank(List<RankItem> candidates, SearchQuery query,
                                UserProfile user) {
        // 1. 构建特征（批量）
        List<FeatureVector> features = candidates.stream()
            .map(item -> buildFeatures(item, query, user))
            .collect(Collectors.toList());

        // 2. 批量调模型（gRPC，GPU 并行算）
        List<Prediction> predictions = modelClient.batchPredict(features);

        // 3. 计算 GMV 分数 = CTR × CVR × Price
        for (int i = 0; i < candidates.size(); i++) {
            Prediction pred = predictions.get(i);
            BigDecimal gmvScore = pred.getCtr()
                .multiply(pred.getCvr())
                .multiply(candidates.get(i).getPrice());
            candidates.get(i).setScore(gmvScore.doubleValue());
        }

        // 4. 排序取 TOP 1000
        candidates.sort((a, b) -> Double.compare(b.getScore(), a.getScore()));
        List<RankItem> top = candidates.subList(0, Math.min(1000, candidates.size()));

        monitor.record("fine_rank_count", query.getQuery(), top.size());
        return top;
    }

    private FeatureVector buildFeatures(RankItem item, SearchQuery query, UserProfile user) {
        FeatureVector feat = new FeatureVector();
        // 商品特征
        feat.add("price", item.getPrice());
        feat.add("brand", item.getBrandId());
        feat.add("category", item.getCategoryId());
        feat.add("sales_30d", item.getSales30d());     // 近 30 天销量
        feat.add("rating", item.getRating());           // 评分
        // 查询特征
        feat.add("query_len", query.getQuery().length());
        feat.add("query_category", query.getPredictedCategory());
        // 用户特征
        feat.add("user_age", user.getAge());
        feat.add("user_purchase_power", user.getPurchasePower());
        feat.add("user_brand_pref", user.getBrandPreference());
        // 交叉特征
        feat.add("user_item_match", userCategoryMatchScore(user, item));
        return feat;
    }
}
```

## 四、机制层：重排（业务规则）

```java
@Service
public class ReRankService {

    /**
     * 重排：业务规则调整最终顺序
     */
    public List<SearchResult> reRank(List<RankItem> ranked, SearchContext ctx) {
        List<SearchResult> results = ranked.stream()
            .map(SearchResult::from).collect(Collectors.toList());

        // 1. 商业加权（广告/自营/促销）
        for (SearchResult r : results) {
            if (r.isAd()) r.setScore(r.getScore() * 1.5);        // 广告加权
            if (r.isSelfRun()) r.setScore(r.getScore() * 1.2);   // 自营加权
            if (r.hasPromotion()) r.setScore(r.getScore() * 1.1);// 促销加权
        }

        // 2. 多样性打散（同品牌间隔，避免全 Apple）
        results = diversify(results);

        // 3. 去重降权（用户看过的降权）
        Set<Long> viewed = ctx.getUser().getViewedItems();
        for (SearchResult r : results) {
            if (viewed.contains(r.getSkuId())) {
                r.setScore(r.getScore() * 0.7);   // 看过的降权
            }
        }

        // 4. 过滤（无库存/已下架）
        results = results.stream()
            .filter(r -> r.getStock() > 0)
            .filter(r -> r.isAvailable())
            .collect(Collectors.toList());

        // 5. 重新排序 + 分页
        results.sort((a, b) -> Double.compare(b.getScore(), a.getScore()));
        int pageSize = ctx.getPageSize();
        int from = (ctx.getPage() - 1) * pageSize;

        monitor.record("search_result_count", ctx.getQuery(),
            Math.min(pageSize, results.size() - from));
        return results.subList(from, Math.min(from + pageSize, results.size()));
    }

    /**
     * 多样性打散：DPF（Deterministic Probabilistic Fairness）
     * 简化版：同品牌连续不超过 2 个
     */
    private List<SearchResult> diversify(List<SearchResult> ranked) {
        List<SearchResult> result = new ArrayList<>();
        Map<Long, Integer> brandCount = new HashMap<>();   // 当前页品牌计数
        Queue<SearchResult> pending = new LinkedList<>(ranked);

        while (!pending.isEmpty() && result.size() < 60) {
            SearchResult item = pending.poll();
            int count = brandCount.getOrDefault(item.getBrandId(), 0);
            if (count < 2) {   // 同品牌不超过 2 个连续
                result.add(item);
                brandCount.merge(item.getBrandId(), 1, Integer::sum);
            } else {
                // 暂存，稍后重试
                pending.add(item);
            }
        }
        return result;
    }
}
```

## 五、底层本质：搜索的本质是"相关性 × 效率 × 商业"

回到第一性：**搜索的本质是"在海量商品中找到用户最可能买的，同时兼顾效率和商业目标"**。

- **相关性**：返回的商品必须和查询相关（搜"手机"不能返回袜子）。召回层保证相关性——倒排索引精确匹配、向量召回语义相近、行为召回用户偏好。相关性是"召回率"——好货不漏。
- **效率**：100ms 内返回（用户耐心有限）。漏斗式分层让重计算只跑少量数据——精排模型只跑千级，不是百万。效率是"响应时间"——快。
- **商业**：平台要赚钱（广告/自营优先）、用户体验要好（多样性/去重）。重排层融合商业因素——广告加权、多样性打散。商业是"平台目标"——GMV 最大化。

**漏斗式分层的本质是"计算成本的递进"**：召回用索引（倒排/向量），成本极低（毫秒级扫亿级）；粗排用轻量模型（双塔内积），成本低（批量内积超快）；精排用重模型（DeepFM），成本高（GPU 推理）；重排用规则，成本低。每一层减少数据量，让贵的计算只跑少量数据。这是"成本分层"——用便宜的方法先过滤，贵的方法精处理。

**多路召回的本质是"互补"**：单路召回必然有盲区——文本召回漏语义相关（搜"手机"漏"智能手机"的同义词）、向量召回漏精确匹配（搜"iPhone 15"可能返回"iPhone 14"）、行为召回对新用户无效（无历史）。多路并行求并集，各路互补，提高覆盖率。这是"不把鸡蛋放一个篮子"——降低单路失效的风险。

**CTR×CVR×Price 排序的本质是"GMV 最大化"**：不是按点击率排序（点了不买无用），而是按"预期贡献的 GMV"排序——CTR（会不会点）× CVR（点了会不会买）× Price（买了多少钱）。三者乘积是预期成交金额，最大化 GMV 是电商平台的核心目标。这是"商业目标函数化"——把"最可能成交"量化为可排序的分数。

## 六、AI 架构师加问：5 个

1. **用大模型（LLM）理解查询意图，怎么做？**
   传统搜索靠分词匹配，LLM 能理解语义——"适合老人用的手机"LLM 解析为"大字体/大音量/操作简单的手机"，转化为属性筛选。京东"语义搜索"：LLM 改写查询（扩展同义词、补充属性），提升召回相关性。

2. **用向量数据库（Milvus/Pinecone）替代 ES 做召回，怎么做？**
   纯语义召回用向量库（FAISS 索引、HNSW 算法），性能比 ES 的向量插件好。但文本精确匹配仍需 ES。混合方案——向量库做语义召回，ES 做属性筛选，结果取交集。

3. **用强化学习优化排序（用户反馈实时学习），怎么做？**
   传统排序模型离线训练（用历史日志），强化学习在线学习——用户点击/购买的实时反馈调整模型，适应用户偏好变化。但训练不稳定，需和离线模型集成（保底）。

4. **AI 做个性化搜索（千人千面），怎么做？**
   精排模型加用户特征（画像/历史/偏好），同样的查询不同用户结果不同——价格敏感用户推低价、品质用户推高端。京东"千人千面"搜索：用户特征进精排模型，CTR/CVR 个性化预估。

5. **用多模态搜索（文字搜图/图搜图），怎么做？**
   文字搜图——文字和图片都 Embedding 到统一向量空间，近邻匹配。图搜图——用户上传图片，CNN 提取特征向量，近邻找相似商品图片。京东"拍照搜"：多模态 Embedding + 向量检索，准确率 85%+。

## 七、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"四层漏斗召回粗排精排重排、多路召回求并集、CTR×CVR×Price 排 GMV"**。

- **四层漏斗**：召回（亿→百万）→ 粗排（百万→万）→ 精排（万→千）→ 重排（千→60）
- **多路召回**：文本（ES 倒排）+ 向量（语义）+ 行为（用户历史），并行求并集
- **粗排**：双塔模型（DSSM），查询塔+商品塔，内积打分，批量超快
- **精排**：DeepFM/DIN，预估 CTR×CVR×Price，按 GMV 排序
- **重排**：商业加权（广告/自营）+ 多样性打散 + 去重降权
- **全链路 < 100ms**

### 面试现场 60 秒回答

> 搜索架构核心是四层漏斗。第一层召回——多路并行（文本召回 ES 倒排匹配、向量召回语义近邻、行为召回用户历史），求并集得百万候选，宁多勿漏，耗时 < 30ms。第二层粗排——双塔模型（DSSM），查询 Embedding 和商品 Embedding 内积打分，批量超快，百万筛到万级，耗时 < 20ms。第三层精排——DeepFM 重模型，预估 CTR（点击率）× CVR（转化率）× Price（价格），按预期 GMV 排序，万级取 TOP 千，耗时 < 30ms。第四层重排——业务规则调整，商业加权（广告 1.5 倍/自营 1.2 倍）、多样性打散（同品牌不超过 2 个连续）、已看过降权、过滤无库存，最终取首页 60 个。全链路 < 100ms。多路召回是互补——文本精确匹配、向量语义相近、行为用户偏好，各路盲区不同，并集提高覆盖率。精排用 GMV 而非 CTR 排序——目标是成交金额最大化（CTR×CVR×Price），不是点击率。监控 search_latency_p99（搜索延迟，< 100ms）、recall_coverage（召回覆盖率）、ctr（点击率）、cvr（转化率）。最关键的是"漏斗式分层让重计算只跑少量数据"——亿级商品 100ms 返回的本质是成本递进的工程优化。

## 八、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么精排不用更准的模型（要粗排先用轻量的）？ | 精排模型（DeepFM）单条 10ms，百万商品全精排要 1000 秒。粗排先用双塔（内积超快，毫秒）筛到万级，精排只跑万级（10 秒？批量 GPU 并行 < 1 秒）。用 rank_latency（排序延迟）和 model_cost（计算成本）量化 |
| 证据追问 | 怎么证明搜索结果好（相关性高）？ | 人工标注（抽样标注相关性，算 NDCG）+ 点击日志分析（CTR/CVR）+ A/B 测试（新旧模型对比）。监控 ndcg@10（前 10 相关性）、ctr（点击率，应提升）、zero_result_rate（零结果率，应低） |
| 边界追问 | 漏斗式搜索能处理所有查询吗？ | 不能。长尾查询（生僻词）召回少，需查询改写（同义词扩展）；新商品无行为数据，冷启动靠文本/属性召回；实时热点（突发事件）需实时索引更新 |
| 反例追问 | 什么场景不需要四层（简化）？ | 小规模数据（B 端搜索，商品少）——召回+精排够用，不需要粗排；精确查询（SKU 编码直查）——直接查不需要召回 |
| 风险追问 | 搜索系统最大风险？ | 主动点出：召回漏好货（相关商品没召回）、排序偏差（商业过度干预相关性）、索引延迟（新商品搜不到）、模型退化（数据分布变化）。靠多路召回 + 相关性监控 + 增量索引 + 模型迭代 |
| 验证追问 | 怎么验证排序模型有效？ | 离线评估（AUC/NDCG 提升）+ 在线 A/B（新模型 vs 旧模型，比 CTR/CVR/GMV）+ 长期监控（模型效果是否退化）。监控 model_auc（模型 AUC，应 > 0.7）和 ab_lift（A/B 提升，应正向） |
| 沉淀追问 | 搜索系统沉淀什么？ | 多路召回框架、排序模型训练平台、特征工程库、A/B 测试框架、搜索监控大盘（延迟/点击率/转化率/零结果率/召回覆盖率） |

### 现场对话示例

**面试官**：用户搜"适合学生用的笔记本电脑"，传统搜索召回效果差（"适合学生"匹配不到商品），怎么优化？

**候选人**：这是"语义查询"场景，传统倒排索引（关键词匹配）失效。三层优化。第一层，查询理解——LLM 或规则解析查询意图，"适合学生用的笔记本"转化为属性筛选（价格 < 5000、重量 < 2kg、续航 > 8 小时、性价比高）。第二层，向量召回——查询和商品都 Embedding 到语义空间，"学生笔记本"和"轻薄本/入门本"语义相近，向量近邻召回。这绕过了关键词匹配，直接语义匹配。第三层，知识增强——商品打"使用场景"标签（学生本/商务本/游戏本），查询理解时映射到场景标签，按标签召回。京东"语义搜索"：LLM 改写查询（"适合学生用的笔记本"→"轻薄本 5000 元以下 学生"），传统召回 + 向量召回结合，准确率提升 30%。监控 semantic_search_ctr（语义搜索点击率）vs keyword_search_ctr（关键词搜索点击率），语义版应更高。

**面试官**：搜索响应时间 200ms（超 SLA 100ms），怎么排查优化？

**候选人**：先定位瓶颈在四层哪一层。加全链路追踪（每层耗时打点）——recall_rt、coarse_rank_rt、fine_rank_rt、rerank_rt。可能瓶颈：召回（多路并行慢，某路超时）、精排（模型推理慢，GPU 队列拥堵）、网络（服务间调用延迟）。优化措施——召回超时控制（每路 50ms 超时，慢的丢弃用快的）、精排批量化（一次 gRPC 调用批量预估，减少网络开销）、模型优化（模型压缩/量化，推理加速）、缓存（相同查询缓存结果，TTL 1 分钟）、预热（热门查询预计算）。京东实践：搜索 RT 从 200ms 优化到 50ms（召回超时控制 + 精排批量化 + 缓存），双 11 峰值 10 万 QPS 稳定。监控 search_latency_p99（< 100ms 是 SLA，超了告警）和 latency_breakdown（各层耗时占比，定位瓶颈）。

**面试官**：新商品上架后搜不到（索引延迟），怎么办？

**候选人**：索引延迟是常见问题（商品上架到 ES 索引可搜有延迟）。根因——全量索引是定时的（每小时一次），增量索引有延迟（消息队列+消费+索引构建）。优化——第一，实时增量索引，商品上架发 MQ，ES 消费者近实时索引（秒级延迟）。第二，双写（MySQL 写入同时写 ES，但牺牲一致性）。第三，强制刷新（重要商品上架后手动触发索引刷新）。京东实践：增量索引秒级（商品上架 5 秒内可搜），全量索引每日（凌晨重建保证一致性）。监控 index_lag（索引延迟，< 10 秒）和新_product_searchable_rate（新商品可搜率，应 > 99%）。极端情况——ES 集群故障导致索引积压，降级方案是 MySQL 临时查（牺牲性能保可用）。

## 常见考点

1. **搜索和推荐的区别？**——搜索是"用户主动表达需求"（输入查询），推荐是"系统推测需求"（基于行为）。搜索有明确 query，推荐无 query。但底层都用到召回+排序。
2. **ES 和 Solr 的区别？**——ES 分布式原生（易扩展）、近实时（秒级索引）、生态丰富（ELK）。Solr 全文检索强（复杂查询）。电商大多选 ES。
3. **怎么做搜索的 A/B 测试？**——按用户分流（hash userId % 100），A 组用旧模型，B 组用新模型，对比 CTR/CVR/GMV。统计显著性检验（p < 0.05 才有效）。
4. **搜索的零结果率怎么降？**——查询改写（同义词扩展）、模糊匹配（拼写纠错）、类目泛化（具体词→类目词）、推荐替代（零结果时推相关商品）。

## 结构化回答

**30 秒电梯演讲：** 搜索是电商的流量入口——用户搜手机，系统要在亿级商品中毫秒级返回最相关的结果。核心挑战是召回（找候选）和排序（定顺序）的平衡——召回太多排序慢，召回太少漏好货。架构解法是漏斗式分层：召回（百万）→ 粗排（万）→ 精排（千）→ 重排（百），每层过滤越多但计算越精细，最终给用户最相关的几十个

**展开框架：**
1. **召回（Recall）** — 从亿级找百万候选，多路（文本/向量/行为），求并集
2. **粗排（Coarse Rank）** — 轻量模型（双塔/FWDL），百万→万级
3. **精排（Fine Rank）** — 重模型（DeepFM/DIN），万级→千级，精准打分

**收尾：** 以上是我的整体思路。您想继续深入聊——召回怎么保证不漏好货？


## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：搜索召回、排序与架构分层 | "这题一句话：搜索是电商的流量入口——用户搜手机，系统要在亿级商品中毫秒级返回最相关的结果。" | 开场钩子 |
| 0:15 | 召回（Recall）示意/对比图 | "从亿级找百万候选，多路（文本/向量/行为），求并集" | 召回（Recall）要点 |
| 0:40 | 粗排（Coarse Rank）示意/对比图 | "轻量模型（双塔/FWDL），百万→万级" | 粗排（Coarse Rank）要点 |
| 1:25 | 总结卡 | "记住：漏斗四层。下期见。" | 收尾 |
