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
