---
id: pdd-scm-010
difficulty: L3
category: pdd-scm
subcategory: ES
tags:
- 拼多多
- 供应链
- Elasticsearch
- 搜索
- 倒排索引
feynman:
  essence: Elasticsearch 用"倒排索引"实现全文检索（词→文档列表），分词 + 相关性打分（BM25）+ 聚合分析，供应链的商品搜索、评价搜索、日志分析都靠它。
  analogy: 正排索引像按书号找内容（B+ 树），倒排索引像书后的关键词索引（按词找页码）——搜索"红色连衣裙"时直接定位含这些词的商品。
  first_principle: 关系型数据库的 LIKE '%xx%' 是全表扫，无法用索引；倒排索引对文本分词建"词→文档"映射，让文本搜索 O(1) 定位。
  key_points:
  - 倒排索引：分词 → 词项 → posting list（文档 ID + 词频 + 位置）
  - BM25 打分：词频 + 文档长度 + IDF
  - 分词器：中文用 IK（pdd_keyword / pdd_smart）
  - 聚合：terms（分类）、sum（金额）、histogram（价格段）
first_principle:
  problem: 海量商品文本搜索（"红色连衣裙"），关系型 LIKE 全表扫不可行，如何高效？
  axioms:
  - 文本搜索需要"按词找文档"
  - 关系型 LIKE 无法用 B+ 树索引
  - 用户关心相关性排序
  rebuild: 倒排索引（分词→词项→posting list）+ BM25 打分（词频/长度/IDF）+ 聚合分析。
follow_up:
- ES 和 MySQL 怎么同步？——Canal 订阅 binlog → Kafka → ES 写入（最终一致）
- ES 分片怎么设计？——按数据量，单分片 < 50GB；商品索引按月滚动
- 深分页（from + size）性能差？——用 search_after（游标）
memory_points:
- 倒排索引：分词 → 词项 → posting list
- BM25 打分：词频高、文档短、词罕见的得分高
- 中文分词：IK（pdd_keyword 细粒度 / pdd_smart 智能）
- 深分页用 search_after，不用 from+size
---

# 【拼多多供应链】ES 怎么做商品搜索？倒排索引原理？

> JD 依据："熟悉 ES 等主流存储引擎"。

## 一、倒排索引（核心）

**正排**（MySQL B+ 树）：文档 ID → 内容
**倒排**（ES）：词 → 文档 ID 列表

```
文档1: "拼多多红色连衣裙"
文档2: "红色连衣裙新款"
文档3: "拼多多百亿补贴"

分词后:
  拼多多 → [1, 3]
  红色   → [1, 2]
  连衣裙 → [1, 2]
  百亿   → [3]
  补贴   → [3]

搜索 "红色连衣裙":
  红色 ∩ 连衣裙 → [1, 2]（两个都含）
```

posting list 存：文档 ID + 词频 + 位置（用于短语匹配）+ 偏移（高亮）。

## 二、BM25 相关性打分

```
score = IDF(词) × ( tf × (k1 + 1) / (tf + k1 × (1 - b + b × docLen/avgDocLen)) )

- tf：词频（出现多分高）
- IDF：词罕见度高（罕见词匹配更相关）
- docLen：文档长度（短文档匹配更相关）
```

## 三、中文分词

ES 内置分词器对中文支持差（按字分）。用 **IK 分词器**：
- `ik_smart`：粗粒度（"拼多多"整体）
- `ik_max_word`：细粒度（"拼多多/拼多/多多"）

```json
PUT /product {
  "mappings": {
    "properties": {
      "title": {
        "type": "text",
        "analyzer": "ik_max_word",       // 索引时细粒度
        "search_analyzer": "ik_smart"    // 搜索时粗粒度
      }
    }
  }
}
```

## 四、商品搜索实战

```json
POST /product/_search {
  "query": {
    "bool": {
      "must": [
        { "match": { "title": "红色连衣裙" } }      // 全文匹配
      ],
      "filter": [
        { "term": { "category_id": 100 } },          // 精确过滤
        { "range": { "price": { "gte": 100, "lte": 500 } } }
      ]
    }
  },
  "sort": [
    { "_score": "desc" },                              // 相关性
    { "sales": "desc" }                                // 销量
  ],
  "aggs": {                                            // 聚合
    "price_range": { "histogram": { "field": "price", "interval": 50 } }
  },
  "from": 0, "size": 20
}
```

## 五、ES 和 MySQL 同步

```
MySQL（主存储）→ Canal（订阅 binlog）→ Kafka → ES Sink（写入 ES）
```

- 商品上下架、改价、改库存 → binlog → 自动刷 ES
- 最终一致（秒级延迟）
- 业务代码无感知

## 六、深分页优化

`from + size` 在深分页时性能差（ES 要取 from+size 条再排序截取）。用 **search_after**（游标）：
```json
// 第一页
POST /product/_search { "size": 20, "sort": [{"sales":"desc"}, {"_id":"asc"}] }
// 记录最后一条的 sort 值
// 下一页
POST /product/_search {
  "size": 20,
  "sort": [{"sales":"desc"}, {"_id":"asc"}],
  "search_after": [上次最后的sales值, "上次最后_id"]  // 游标
}
```

## 七、底层本质

倒排索引是**"用空间换搜索效率"**：
- 正排：按文档找内容（O(1) 取，但 LIKE 全扫）
- 倒排：按词找文档（O(1) 定位含词的文档）

这是搜索引擎的基础——把"全文搜索"从 O(n) 降到 O(命中数)。

## 常见考点
1. **ES 为什么比 MySQL LIKE 快**？——倒排索引按词定位，LIKE 全表扫。
2. **ES 分片和副本**？——分片（水平拆分，单分片 < 50GB）；副本（高可用，至少 1）。
3. **ES 写入实时吗**？——近实时（1s 刷新，refresh interval），写入后 1s 内可搜到。
