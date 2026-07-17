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

## 苏格拉底式面试追问

> 这组追问不是背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：商品搜索你用 ES，但商品的核心数据（价格/库存）存在 MySQL。为什么不直接在 MySQL 上做 LIKE 搜索，要引入 ES 增加一套存储？**

三个动机：
1. **LIKE 性能差**——MySQL `LIKE '%红色%'` 是全表扫，1 亿商品表要扫十几秒，B+ 树索引帮不上（前导模糊 `%` 开头无法用索引）。ES 倒排索引按词定位，毫秒级返回。
2. **相关性排序**——MySQL LIKE 返回的是主键顺序，ES 用 BM25 打分（词频/罕见度/文档长度），搜"红色连衣裙"时标题完全匹配的排前面，用户体验好。
3. **多维度筛选**——用户搜商品要按"类目 + 价格区间 + 品牌 + 销量"组合筛选，ES 的 `bool + filter + agg` 一次查询完成，MySQL 要多条 SQL 组合且无法用索引高效命中。
代价是数据同步（Canal→ES）和一致性延迟，但商品搜索容忍秒级不一致。

### 第二层：证据与定位

**Q：用户反馈搜"连衣裙"搜不到某商品（明明标题里有这个词）。你怎么定位是分词问题、索引没同步，还是 BM25 排序太靠后？**

三步排查：
1. **验证分词**——`POST /product/_analyze { "analyzer": "ik_max_word", "text": "商品标题原文" }`，看分词结果是否包含"连衣裙"这个词项。如果不包含（如被切成"连衣/裙"），是分词器问题，词典漏词。
2. **验证索引**——`GET /product/_doc/{商品id}`，确认该文档确实在 ES 里，且 `title` 字段内容正确。如果文档不存在，是 Canal 同步延迟或丢消息（看 `consumer_lag`）。
3. **验证命中**——`POST /product/_search { "query": {"match": {"title": "连衣裙"}}, "explain": true }`，用 `explain` 看该商品的 BM25 打分和排名。如果命中但排在 1000 名开外（size=20 没展示），是相关性问题（标题匹配度低或销量低），不是 bug。

### 第三层：根因深挖

**Q：分词验证发现"连衣裙"被 IK 切成了"连衣/裙"，根因是词典没这个词。你加了词典，但旧数据还是搜不到，为什么？**

根因是**已有索引的分词不会自动更新**。ES 的倒排索引是写入时分词的，加新词到 IK 词典只影响新写入的文档，旧文档的倒排索引还是按旧分词（"连衣/裙"）。要让旧数据生效必须 **reindex**：
```bash
POST /_reindex {
  "source": { "index": "product" },
  "dest": { "index": "product_new" }
}
```
重建索引让所有文档按新词典重新分词。线上操作用 alias 切换：先 reindex 到 `product_new`，切 alias 指向新索引，零停机。千万级商品 reindex 约 30 分钟。

**Q：那为什么不直接用 ES 的 update_by_query 重建，而要 reindex 到新索引？**

`update_by_query` 能重新分词，但有三个坑：
1. **不可控**——update_by_query 是原地更新，过程中老索引被改，如果有查询进来会看到"一半新一半旧"的混合状态。
2. **失败难恢复**——中途失败（OOM、节点挂）已改的部分无法回滚，索引处于半坏状态。
3. **性能冲击**——update_by_query 对原索引大量随机写，触发 segment merge，影响在线查询性能。
reindex 到新索引是"copy-on-write"思路，原索引不动，新索引建好后用 alias 一次性原子切换，失败就删新索引重来，零风险。ES 生态的标准做法。

### 第四层：方案权衡

**Q：商品搜索的深分页，你用 search_after 替代 from+size。但 search_after 不支持随机跳页（只能下一页），运营后台要跳转到第 50 页怎么办？**

ES 深分页的根本矛盾——from+size 在 `from=10000` 后性能骤降（ES 要取 10000+size 条再排序截取，内存爆炸），所以有 `max_result_window=10000` 限制。三种方案权衡：
1. **C 端用 search_after**——用户连续翻页，游标足够。配合"只能翻 100 页"的产品限制（拼多多就是这样，搜不到说明筛选条件太宽，让用户加筛选）。
2. **后台用 scroll**——`POST /product/_search?scroll=1m`，适合"导出全部匹配结果"的批量场景，但不适合交互式跳页（scroll 是快照，实时性差）。
3. **后台跳页用"限制 + 搜索"**——运营要找特定商品，用 SKU/名称精确搜，而不是翻 50 页。从产品层面消除"跳转到第 50 页"的需求。

**Q：为什么不直接把 from+size 的限制调到 100000（max_result_window=100000），让它支持深分页？**

调大 `max_result_window` 是危险操作：
1. **内存爆炸**——`from=100000, size=20`，ES 协调节点要从所有分片各取 100020 条（假设 5 分片 × 100020 = 50 万条），在内存里排序再截取，单次查询占几 GB 内存，高并发直接 OOM。
2. **CPU 飙升**——50 万条排序 CPU 密集，拖慢整个节点。
3. **掩盖问题**——需要翻 100000 条说明搜索不够精准，正确做法是优化筛选条件（加 filter）缩小结果集，而不是调大翻页上限。
所以 ES 官方默认 10000 是合理的硬限制，业务侧应该用 search_after 或 scroll 绕开，而不是调参数。

### 第五层：验证与沉淀

**Q：你怎么证明 Canal→ES 的同步链路没丢数据、搜索结果是完整的？**

两个对账手段：
1. **数量对账**——定时任务（每小时）对比 MySQL 和 ES：`SELECT COUNT(*) FROM product WHERE status=1` vs `POST /product/_count {"query":{"term":{"status":1}}}`，差值 > 0.01% 告警。
2. **内容抽样对账**——每小时随机抽 100 个商品，对比 MySQL 的 `title/price/stock` 和 ES 的 `_source`，任何一个字段不一致记 `es_mysql_diff_count`，> 0 告警。拼多多就是用这个"内容巡检"发现 Canal 链路的 bug。

**Q：怎么让团队的 ES 使用规范统一（分词器、映射、同步策略）？**

沉淀三件事：
1. **ES 索引模板**——用 Index Template 统一 mapping（中文字段强制 `ik_max_word`、数值字段用 keyword 精确匹配、时间字段格式），新建索引自动套用。
2. **同步 SDK**——封装 Canal→Kafka→ES Sink 的标准链路，业务方只声明"哪个表同步到哪个索引"，框架自动处理 binlog 解析、幂等写入、失败重试。
3. **查询规范**——禁用 `from+size > 10000` 的深分页（代码扫描器拦截），C 端强制 search_after，后台导出用 scroll。

## 结构化回答

**30 秒电梯演讲：** 海量商品文本搜索（"红色连衣裙"），关系型 LIKE 全表扫不可行，如何高效？简单说就是——Elasticsearch 用"倒排索引"实现全文检索（词→文档列表），分词 + 相关性打分（BM25）+ 聚合分析，供应链的商品搜索、评价搜索、日志分析都靠它。

**展开框架：**
1. **倒排索引** — 倒排索引：分词 → 词项 → posting list（文档 ID + 词频 + 位置）
2. **BM25 打分** — BM25 打分：词频 + 文档长度 + IDF
3. **分词器** — 分词器：中文用 IK（pdd_keyword / pdd_smart）

**收尾：** 您看这块要不要再展开聊聊？

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：ES 怎么做商品搜索？倒排索引原理？ | 今天聊「ES 怎么做商品搜索？倒排索引原理？」。一句话：Elasticsearch 用"倒排索引"实现全文检索（词→文档列表），分词 + 相关性打分（BM25）+ 聚合分析 | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：倒排索引：分词 → 词项 → posting list（文档 ID + 词频 + 位置） | 核心概念 |
| 1:04 | 能力/参数拆解表 | 要点是：BM25 打分：词频 + 文档长度 + IDF | 能力拆解 |
| 1:56 | 流程图：输入→处理→输出 | 要点是：分词器：中文用 IK（pdd_keyword / pdd_smart） | 关键机制 |
| 3:00 | 总结卡 + 下期预告 | 记住核心要点就够了。下期见。 | 收尾 |
