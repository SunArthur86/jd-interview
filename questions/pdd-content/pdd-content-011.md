---
id: pdd-content-011
difficulty: L4
category: pdd-content
subcategory: ES
tags:
- 拼多多
- 内容
- ES
- 倒排索引
- 搜索
- 评价
feynman:
  essence: ES 用"倒排索引（分词→文档列表）"实现全文搜索；评价/直播搜索场景按关键词/类目/分值多维过滤+排序，配合分词器与相关性算分。
  analogy: 倒排索引像书后索引——按词查页码，比逐页翻（正排）快。
  first_principle: 全文搜索需"词→文档"的倒排，正排扫表太慢；分词是关键。
  key_points:
  - 倒排索引：分词→Postings（文档列表+位置）
  - 分词器：中文用 IK（细粒度/智能）
  - 相关性：TF-IDF / BM25
  - 过滤+聚合：filter（cache）/aggs
first_principle:
  problem: 海量文本如何按关键词+多维条件快速检索？
  axioms:
  - 全表扫描慢
  - 关键词需分词
  - 多条件组合过滤
  rebuild: 倒排索引 + 分词 + BM25 算分。
follow_up:
  - ES 和 MySQL 区别？——ES 倒排擅长搜索/聚合，MySQL 正排擅长事务
  - 深度分页怎么办？——scroll/search_after（不用 from+size）
  - 怎么保证 ES 和 DB 一致？——canal 同步 binlog + 版本号去重
memory_points:
  - 倒排：分词→Postings
  - 分词：IK 中文
  - 算分：BM25
  - 深分页：search_after
---

# 【拼多多内容】ES 原理与评价搜索场景？

> JD 依据："分布式/缓存/消息/搜索"、"评价"。

## 一、倒排索引

```
正排（MySQL）：  doc_id → 内容         全表扫描慢
倒排（ES）：     词 → [doc_id 列表]    按词定位快

例：
  doc1: "拼多多评价真不错"
  doc2: "评价物流快"
倒排：
  拼多多 → [doc1]
  评价   → [doc1, doc2]
  不错   → [doc1]
  物流   → [doc2]
  快     → [doc2]
```

**Postings 结构**：
```
词 → 文档列表 + 词频 + 位置（用于短语查询）
```

## 二、分词器

**中文分词**：IK Analyzer
- `ik_smart`：粗粒度（搜索用）
- `ik_max_word`：细粒度（索引用）

```json
PUT /review {
  "settings": {
    "analysis": {
      "analyzer": {
        "ik_smart_analyzer": { "type": "custom", "tokenizer": "ik_smart" },
        "ik_max_analyzer":   { "type": "custom", "tokenizer": "ik_max_word" }
      }
    }
  }
}
```

字段映射：
```json
"properties": {
  "content": {
    "type": "text",
    "analyzer": "ik_max_word",        // 索引时细
    "search_analyzer": "ik_smart"     // 搜索时粗
  }
}
```

## 三、相关性算分

**BM25**（默认）：
```
score = IDF(词) * TF(词,d) * (k1+1) / (TF + k1*(1 - b + b*|d|/avgdl))
  IDF：词在多少文档出现（罕见词权重高）
  TF：词在文档出现次数（出现越多权重越高）
  |d|/avgdl：文档长度归一化
```

## 四、评价搜索查询

```json
POST /review/_search {
  "query": {
    "bool": {
      "must": [
        { "match": { "content": "拼多多 物流" } }      // 全文搜索
      ],
      "filter": [
        { "term":  { "productId": 100 } },              // 等值过滤
        { "range": { "score":   { "gte": 4 } } },        // 范围过滤
        { "term":  { "status":  1 } }                    // 已通过
      ]
    }
  },
  "sort": [
    { "_score": "desc" },
    { "createTime": { "order": "desc" } }
  ],
  "from": 0, "size": 10,
  "aggs": {
    "score_dist": { "terms": { "field": "score" } }     // 分值分布聚合
  }
}
```

**关键技巧**：
- `filter` 不算分且会被缓存（比 must 快）
- `must` 用于全文相关性
- `should` 用于 OR 提升（minimum_should_match）

## 五、直播搜索场景

```
直播间搜索：
  Query: keyword + 主播名 + 类目
  Filter: 状态=直播中 / 地区 / 在线人数>10
  Sort: 在线数 desc, _score desc
  Aggs: 按类目分布（侧边筛选）

直播回放搜索：
  全文搜弹幕/标题
```

## 六、深度分页

```
from + size：默认上限 10000（深分页要算 from+size 个 doc score，贵）
search_after：用上一页最后一条的 sort 值继续查（推荐，无上限）
scroll：快照遍历全量（适合导出，不适合实时翻页）
```

```json
// search_after
"sort": [{ "createTime": "desc" }, { "_id": "asc" }],
"search_after": [1700000000000, "abc"]   // 上一页最后值
```

## 七、ES 与 DB 一致性

```
DB → 写评价
canal 监听 binlog → MQ → ES 消费者更新 ES（带版本号去重）
```

**注意**：
- ES 更新是异步，有秒级延迟（搜索场景可接受）
- 用 `version` 或 `seq_no` 防止旧数据覆盖新

## 八、底层本质

ES 本质是**"用倒排索引让全文搜索 O(1) 定位+分词降维+BM25 算相关"**——搜索/聚合强，但不支持事务，与 MySQL 互补。

## 常见考点
1. **ES 写入流程**？——写主分片+translog+refresh（1s 可见）+flush（落盘）。
2. **ES 怎么扩容**？——分片（shard）+副本（replica），分片数建索引时定。
3. **倒排索引为什么用跳表**？——多个 Postings 合并（AND/OR）时跳表 O(log N)。

## 苏格拉底式面试追问

> 这组追问不是背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：评价搜索你选 ES 而不是 MySQL 的 FULLTEXT 索引，为什么不直接用 MySQL？少维护一个组件不是更好吗？**

MySQL FULLTEXT 索引对中文支持弱（需要 ngram 分词器），且只支持基础的全文匹配，无法做 BM25 算分、多字段加权、聚合分析。拼多多评价搜索的核心诉求是"用户搜'物流快'能按相关性 + 点赞数 + 时效排序"，这需要 ES 的 bool query（全文 + filter 组合）+ function_score（自定义算分）+ aggs（按类目/分值聚合）。MySQL 做这些要么做不到，要么全表扫。ES 的代价是多维护一个组件（集群 + 数据同步），但内容搜索是 C 端核心体验，这点运维成本换的是"搜索体验质的飞跃"。

### 第二层：证据与定位

**Q：评价搜索 P99 从 50ms 涨到 500ms，你怎么确认是 ES 慢还是查询 DSL 写得差？**

三路定位：
1. ES 慢查询日志（`indices.query.query_string slowlog`，阈值设 100ms）——grep 出慢查询，看 `took` 字段（ES 实际耗时）和 `hits.total`（命中数）。如果 took >100ms 且命中几百万条，说明 query 没用好 filter 或算分范围太大。
2. `_cat/indices?v` 看索引健康——`docs.count` 是否异常大（索引膨胀）、`store.size` 是否超预期、`health` 是否 yellow/red（分片未分配）。
3. Kibana 的 Search Profiler——把 DSL 贴进去，看每个 query/filter 子句的耗时和 score 计算，定位是哪个子句慢。

### 第三层：根因深挖

**Q：你发现某个查询 `took=800ms`，但 query 只是 `match content: "拼多多"`，为什么一个 match 这么慢？**

match 看似简单，实际链路很深。根因排查：
1. 看 `content` 的分词——"拼多多"被 IK 分成"拼""多""多"或"拼多多"，如果是前者，"多"这个单字在千万级评价里出现频率极高（IDF 低），Postings 列表几百万长，遍历慢。解决：用 `ik_smart` 避免过度分词，或用 `match_phrase` 要求连续匹配。
2. 看 `from + size`——如果是 `from: 10000, size: 10`，ES 要算 10010 条的 score 再取后 10 条，深分页极慢。解决：改 `search_after`。
3. 看 `fielddata`——如果对 text 字段排序或聚合，ES 要把全量倒排加载到堆内存（fielddata），OOM 风险 + 慢。解决：text 字段加 `.keyword` 子字段（doc_values）用于排序/聚合。

### 第四层：方案权衡

**Q：评价搜索要加"按点赞数排序"，你用 `function_score` 还是单独存一个 `likeCount` 字段排序？两者对性能影响差多少？**

两种方案的权衡：
1. **单独字段排序**——`sort: [{likeCount: desc}, {_score: desc}]`，简单快，但"相关性"和"热度"是独立排序（非加权融合），热门但无关的内容排前面。
2. **function_score 加权**——`function_score: { query: match, field_value_factor: { field: likeCount, modifier: log1p } }`，把点赞数作为 score 的乘子，相关性和热度融合。代价是算分贵（每条都要算 field_value_factor），比纯 sort 慢 2-3 倍。
评价搜索选 function_score——用户体验上"物流快 + 点赞高"比"点赞高但无关"更有价值。性能优化：用 `query_score_mode: multiply` + 限制 `max_boost` 防止热度淹没相关性。

### 第五层：验证与沉淀

**Q：你把 ES 索引从 from+size 改成 search_after 深分页，怎么验证改对了且性能提升？**

search_after 的正确性验证：
1. 数据完整性——翻完所有页，对比拿到的 id 总数 vs `POST /review/_count` 的 count，必须相等。
2. 无重复无遗漏——search_after 依赖上一页最后一条的 sort 值，必须用唯一字段（如 `_id` 或 `_uid`）做 tiebreaker，否则 create_time 相同会漏或重。压测造 10 万条相同 create_time 的数据，验证不漏不重。
3. 性能——`took` 应该稳定在 <50ms 不随页数增长，对比 from+size 在 from=10000 时 took 飙到 500ms+。
沉淀：禁止 `from > 10000`（ES 默认上限，强开 `index.max_result_window` 是治标）；查询 DSL 必须 code review（filter vs must、是否深分页）；`_cat/indices` 健康度（segment 数 >50 触发 force merge）纳入监控。

## 结构化回答


**30 秒电梯演讲：** 倒排索引像书后索引——按词查页码，比逐页翻（正排）快。

**展开框架：**
1. **倒排索引** — 分词→Postings（文档列表+位置）
2. **分词器** — 中文用 IK（细粒度/智能）
3. **相关性** — TF-IDF / BM25

**收尾：** ES 和 MySQL 区别？


## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：ES 原理与评价搜索场景？ | 今天聊「ES 原理与评价搜索场景？」。一句话：ES 用"倒排索引（分词→文档列表）"实现全文搜索；评价/直播搜索场景按关键词/类目/分值多维过滤+排序，配合分词器与… | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：倒排：分词→Postings | 核心概念 |
| 0:51 | 能力/参数拆解表 | 要点是：分词：IK 中文 | 能力拆解 |
| 1:30 | 流程图：输入→处理→输出 | 要点是：算分：BM25 | 关键机制 |
| 2:09 | 代码片段 + 注释高亮 | 要点是：深分页：search_after | 实战要点 |
| 3:00 | 总结卡 + 下期预告 | 记住这些核心点就够了。下期我们接着聊——ES 和 MySQL 区别？。 | 收尾 |
