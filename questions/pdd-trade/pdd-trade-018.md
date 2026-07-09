---
id: pdd-trade-018
difficulty: L3
category: pdd-trade
subcategory: ES
tags:
- 拼多多
- 交易
- Elasticsearch
- 搜索
- 倒排索引
feynman:
  essence: ES 用倒排索引（词→文档列表）实现全文检索，BM25 打分相关性，交易系统的订单搜索/商品搜索/日志分析都靠它。
  analogy: 倒排像书后关键词索引——按词找页码，而非按页码找内容。
  first_principle: 关系型 LIKE 全表扫，倒排按词定位 O(命中数)。
  key_points:
  - 倒排：分词→词项→posting list
  - BM25 打分（词频/文档长度/IDF）
  - 中文分词 IK
  - Canal 同步 MySQL→ES
first_principle:
  problem: 全文搜索 LIKE 全表扫不可行，如何高效？
  rebuild: 倒排索引按词定位 + BM25 排序。
follow_up:
- ES 和 MySQL 同步？——Canal 订阅 binlog → Kafka → ES
- 深分页性能差？——search_after 游标
- 中文分词？——IK（ik_smart 粗/ik_max_word 细）
memory_points:
- 倒排：分词→词项→posting list
- BM25：词频高/文档短/词罕见得分高
- IK 中文分词
- Canal 同步 MySQL→ES
---

# 【拼多多交易】ES 怎么做订单/商品搜索？

> JD 依据："熟悉 ES"。

## 一、倒排索引

```
分词 → 词项 → posting list（文档 ID + 词频 + 位置）
搜索"红色连衣裙"：红色 ∩ 连衣裙 → 命中文档
```

## 二、订单搜索实战

```json
POST /order/_search {
  "query": {
    "bool": {
      "must": [{"match": {"title": "手机"}}],
      "filter": [{"term": {"buyer_uid": 500}}, {"range": {"create_time": {"gte": "now-30d"}}}]
    }
  },
  "sort": [{"create_time": "desc"}]
}
```

## 三、Canal 同步

```
MySQL → Canal → Kafka → ES
订单变更自动刷 ES（秒级延迟，业务无感）
```

## 四、深分页

`from+size` 深分页差，用 `search_after`（游标）。

## 五、底层本质

倒排是"用空间换搜索效率"——O(n) LIKE → O(命中数) 倒排。

## 常见考点
1. **ES 比 MySQL LIKE 快**？——倒排按词定位，LIKE 全表扫。
2. **分片设计**？——单分片 < 50GB；按数据量分。
3. **近实时**？——写入 1s（refresh interval）后可搜。
