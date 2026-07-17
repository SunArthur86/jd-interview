---
id: java-architect-036
difficulty: L3
category: java-architect
subcategory: ES
tags:
- Java 架构师
- Elasticsearch
- 索引
- 搜索
feynman:
  essence: ES 是倒排索引的分布式实现——写入时分词建倒排（term → doc list），查询时按 term 倒排召回。索引建模的核心是"按查询设计 mapping"（哪些字段索引、哪些分词、哪些聚合）、分片数决定并行度、refresh_interval 决定实时性。
  analogy: 像 JD 图书检索：正排索引是"按书号找书"（O(1) 但要遍历所有书找关键词），倒排索引是"按关键词找书号清单"（关键词 → [书1,书5,书9]，O(1) 召回）。ES 是后者，所以搜索快但写入慢（要先分词建倒排）。
  first_principle: 为什么不用 MySQL LIKE 做搜索？因为 B+Tree 是按字段值排序，LIKE '%关键词%' 用不上索引（全表扫描）。倒排索引把"文档包含哪些词"预先算好，查询时直接查词的文档清单，O(1) 召回。代价是写入时要做分词 + 建倒排，所以 ES 写比 MySQL 慢。
  key_points:
  - 倒排索引：Analysis 分词 → 建倒排（term → doc list），是 ES 搜索快的根因
  - mapping 设计：text（分词）vs keyword（不分词，精确匹配/聚合），按查询模式选
  - 分片数 = 数据量 / 单分片推荐 30-50GB；副本数 = 1（高可用）+ 动态调整
  - refresh_interval 默认 1s（近实时），写入密集场景调大（30s）省 CPU
  - 深分页用 search_after 替代 from/size（避免 heap 爆炸）
first_principle:
  problem: 海量文档（亿级商品）下如何实现毫秒级全文检索 + 多维聚合？
  axioms:
  - 关系数据库 B+Tree 不适合全文检索（LIKE 用不上索引）
  - 倒排索引（term → doc list）是全文检索的数学最优解
  - 单机存不下 + 单机算不动，必须分布式（分片 + 副本）
  rebuild: ES 用倒排索引做召回（毫秒级），用分片做水平扩展（每个分片是一个 Lucene 索引），用副本做高可用。索引建模按"查询模式"设计——精确匹配用 keyword、全文搜索用 text+分词器、聚合用 doc_values。写入时 Analysis 分词建倒排，查询时按分词结果召回。refresh_interval 控制"近实时"程度（默认 1s 可见），写入密集时调大省 CPU。
follow_up:
  - text 和 keyword 区别？——text 会被 Analysis 分词建倒排（适合全文搜索），keyword 不分词整个值作为 term（适合精确匹配、排序、聚合）。一个字段常同时定义 text + keyword 子字段
  - 分片数怎么定？——单分片推荐 30-50GB，分片数 = 总数据量 / 50GB。分片数创建后不能改（只能 reindex），要预留增长
  - 为什么深分页慢？——from + size 会从每个分片取 from+size 条，协调节点合并排序。from=10000 size=10 要拉 10 万条到 heap 排序，OOM 风险。用 search_after 替代
  - refresh_interval 调大有什么好处？——默认 1s 每次 refresh 创建新 segment，写入密集时频繁 refresh 烧 CPU 且 segment 太多。调到 30s 减少 segment 数，写入吞吐提升 5-10 倍
  - ES 和 MySQL 数据怎么同步？——Canal 监听 MySQL binlog → MQ → ES 消费端写入。或用 Logstash JDBC input 定时拉。实时性要求高用前者
memory_points:
  - 倒排索引：分词建 term→doc list，是 ES 搜索快的根因
  - text 分词、keyword 精确匹配；按查询模式选 mapping
  - 分片数 = 数据量 / 50GB，创建后不能改
  - refresh_interval 默认 1s，写入密集调 30s
  - 深分页用 search_after，不用 from/size
---

# 【Java 后端架构师】Elasticsearch 索引建模与搜索性能

> 适用场景：JD 核心技术。商品搜索（亿级 SKU）、订单查询、日志检索（ELK）、风控特征——这些场景架构师必须能设计 mapping、调优 query DSL、配置分片副本、解决深分页和写入瓶颈。

## 一、概念层：倒排索引与 ES 架构

**倒排索引是 ES 的灵魂**：

```
文档：                           倒排索引（Term → Doc List）：
  Doc1: "JD 手机 5G"               "JD"    → [Doc1, Doc3]
  Doc2: "华为 笔记本"              "手机"  → [Doc1, Doc3]
  Doc3: "5G 手机 JD"               "5G"    → [Doc1, Doc3]
                                  "华为"  → [Doc2]
查询 "JD 手机"：                   "笔记本" → [Doc2]
  分词 → [JD, 手机]
  倒排召回 → Doc1, Doc3 都含 JD 和 手机
  → 返回 Doc1, Doc3
```

**ES 分布式架构**：

```
Cluster
  └── Node（节点，一个 JVM 实例）
       ├── Master Node（管理元数据、分片分配）
       ├── Data Node（存数据、执行查询）
       ├── Coordinating Node（接收请求、分发聚合）
       └── Ingest Node（写入前预处理）

Index（逻辑索引，如 product）
  ├── Primary Shard 0（主分片，一个 Lucene 实例）
  │     └── Replica Shard 0（副本，主挂顶上）
  ├── Primary Shard 1
  │     └── Replica Shard 1
  └── ...
```

**正排 vs 倒排 vs doc_values**（面试常被问）：

| 数据结构 | 用途 | 何时用 |
|---------|------|--------|
| **倒排索引** | 按 term 找 doc | 搜索召回（must/should/filter） |
| **doc_values** | 按 doc 找字段值 | 排序、聚合、script（默认开启） |
| **_source** | 原始 JSON | 返回文档内容（默认开启） |

## 二、机制层：Mapping 设计实战

**商品搜索 mapping 模板**（JD 风格）：

```json
PUT /product
{
  "settings": {
    "number_of_shards": 10,           // 分片数（按数据量算，亿级商品用 10-20）
    "number_of_replicas": 1,          // 副本数（高可用，写入密集可临时设 0）
    "refresh_interval": "1s",         // 默认 1s（写入密集调 30s）
    "analysis": {
      "analyzer": {
        "ik_smart_analyzer": {         // 中文分词
          "type": "custom",
          "tokenizer": "ik_smart",
          "filter": ["lowercase", "asciifolding"]
        },
        "pinyin_analyzer": {           // 拼音搜索
          "type": "custom",
          "tokenizer": "pinyin_tokenizer"
        }
      }
    }
  },
  "mappings": {
    "properties": {
      "product_id": { "type": "keyword" },              // 精确匹配，不分词
      "title": {
        "type": "text",                                  // 全文搜索，分词
        "analyzer": "ik_smart_analyzer",
        "fields": {
          "keyword": { "type": "keyword", "ignore_above": 256 },  // 排序/聚合用
          "pinyin": { "type": "text", "analyzer": "pinyin_analyzer" }  // 拼音搜索
        }
      },
      "category_id": { "type": "keyword" },              // 分类，聚合用
      "price": {
        "type": "scaled_float",                          // 价格，scaled_float 比 double 省空间
        "scaling_factor": 100                            // 价格 ×100 存整数（123.45 → 12345）
      },
      "brand": { "type": "keyword" },
      "tags": { "type": "keyword" },                     // 标签数组，聚合用
      "description": {
        "type": "text",
        "analyzer": "ik_smart_analyzer",
        "index_options": "freqs"                         // 只存词频不存位置，省空间
      },
      "status": { "type": "keyword" },                   // 上架状态，精确匹配
      "create_time": { "type": "date", "format": "epoch_millis" },
      "spec": {                                          // 动态规格（颜色、内存等）
        "type": "nested",                                // nested 支持嵌套查询
        "properties": {
          "name": { "type": "keyword" },
          "value": { "type": "keyword" }
        }
      }
    }
  }
}
```

**mapping 设计原则**：

1. **按查询模式选类型**：精确匹配用 keyword、全文搜索用 text、数值范围用 long/scaled_float、时间用 date
2. **多字段（multi-field）**：title 同时定义 text（搜索）和 keyword（排序）子字段
3. **关闭不需要的功能**：`"index": false`（不索引，只 _source 返回）、`"doc_values": false`（不聚合）
4. **nested 替代 object**：object 会扁平化（spec.color=红 + spec.size=L 会错误匹配），nested 保留边界
5. **动态 mapping 关掉**：`"dynamic": "strict"` 防字段污染

## 三、机制层：Query DSL 实战

**商品搜索完整 DSL**（多条件 + 排序 + 聚合）：

```json
POST /product/_search
{
  "query": {
    "bool": {
      "must": [
        { "match": { "title": { "query": "5G 手机", "operator": "and", "minimum_should_match": "75%" } } }
      ],
      "filter": [
        { "term": { "status": "ON_SHELF" } },                    // 上架状态（filter 不打分，快）
        { "terms": { "category_id": ["1001", "1002"] } },        // 分类筛选
        { "range": { "price": { "gte": 1000, "lte": 5000 } } },  // 价格区间
        { "term": { "brand": "华为" } }
      ],
      "should": [
        { "term": { "tags": { "value": "新品", "boost": 2 } } }   // 加权
      ]
    }
  },
  "sort": [
    { "_score": { "order": "desc" } },
    { "sales_count": { "order": "desc" } },                      // 销量二级排序
    { "price": { "order": "asc" } }
  ],
  "from": 0,
  "size": 20,
  "aggs": {                                                       // 聚合（按品牌、价格区间）
    "brand_agg": {
      "terms": { "field": "brand", "size": 20 }
    },
    "price_range": {
      "range": {
        "field": "price",
        "ranges": [
          { "to": 1000 },
          { "from": 1000, "to": 3000 },
          { "from": 3000, "to": 5000 },
          { "from": 5000 }
        ]
      }
    }
  },
  "highlight": {                                                  // 高亮
    "fields": { "title": {} }
  }
}
```

**filter vs must 的关键区别**：

```
filter：不打分（不计算 _score），可缓存（query cache），适合精确过滤
  → status=ON_SHELF、price range、category

must/match：打分（计算 _score），不缓存，适合相关性排序
  → title 全文搜索
```

**filter 比 query 快 10 倍**（不打分 + 缓存），能用 filter 就用 filter。

## 四、实战层：深分页与写入性能调优

**深分页问题**（面试高频）：

```json
// 反面：from + size 深分页
POST /product/_search
{ "query": {...}, "from": 10000, "size": 10 }
// 协调节点要从每个分片取 10010 条，10 分片 = 10 万条到 heap 排序，OOM 风险
// ES 默认 max_result_window = 10000，超过报错

// 正面：search_after（基于上一页最后一条的 sort 值）
POST /product/_search
{
  "query": {...},
  "size": 10,
  "sort": [
    { "sales_count": { "order": "desc" } },
    { "product_id": { "order": "asc" } }    // 必须有唯一字段保证排序稳定
  ],
  "search_after": [9999, "SKU12345"]        // 上一页最后一条的 sort 值
}
// 每次只取 size 条，无 heap 压力

// 滚动全量导出用 scroll（适合 reindex、备份）
POST /product/_search?scroll=5m
{ "query": {...}, "size": 1000 }
```

**写入性能调优**（JD 大促索引商品场景）：

```json
// 1. 批量写入（bulk API）
POST /_bulk
{ "index": { "_index": "product", "_id": "SKU1" } }
{ "product_id": "SKU1", "title": "...", ... }
{ "index": { "_index": "product", "_id": "SKU2" } }
{ "product_id": "SKU2", "title": "...", ... }
// bulk 比 single index 快 10-100 倍

// 2. 写入密集时调整参数
PUT /product/_settings
{
  "refresh_interval": "30s",          // 默认 1s，调大减少 segment 数
  "number_of_replicas": 0             // 写入时临时设 0（写完恢复 1），省同步开销
}

// 3. 写完恢复
PUT /product/_settings
{
  "refresh_interval": "1s",
  "number_of_replicas": 1
}

// 4. 强制 merge（减少 segment 数，提升查询）
POST /product/_forcemerge?max_num_segments=1
```

**Java 客户端写入代码**：

```java
// 批量写入
BulkRequest bulkRequest = new BulkRequest();
for (Product p : products) {
    IndexRequest req = new IndexRequest("product")
        .id(p.getProductId())
        .source(JSON.toJSONString(p), XContentType.JSON);
    bulkRequest.add(req);
}
BulkResponse response = restHighLevelClient.bulk(bulkRequest, RequestOptions.DEFAULT);

// search_after 深分页
SearchRequest searchRequest = new SearchRequest("product");
SearchSourceBuilder sourceBuilder = new SearchSourceBuilder();
sourceBuilder.query(boolQuery)
    .size(20)
    .sort("sales_count", SortOrder.DESC)
    .sort("product_id", SortOrder.ASC);   // 唯一字段保稳定
if (lastSortValues != null) {
    sourceBuilder.searchAfter(lastSortValues);   // 上一页最后的 sort 值
}
```

## 五、实战层：诊断命令速查

**ES 运维必备命令**（面试加分）：

```bash
# 集群健康
GET /_cluster/health
# 关注：status (green/yellow/red)、unassigned_shards、pending_tasks

# 节点状态（CPU、heap、磁盘）
GET /_cat/nodes?v
# 关注：heap.percent（>75% 危险）、disk.used_percent（>85% 危险）

# 索引列表（文档数、大小）
GET /_cat/indices?v
# 关注：docs.count、store.size、health

# 分片分布（哪个分片在哪个节点）
GET /_cat/shards/product?v
# 关注：prirep（p 主 r 副本）、state（STARTED/UNASSIGNED）、unassigned.reason

# segment 信息（看 segment 数量、是否需要 force merge）
GET /_cat/segments/product?v
# 关注：segment 数（>50 考虑 force merge）

# 慢查询日志
GET /product/_settings
PUT /product/_settings
{
  "index.search.slowlog.threshold.query.warn": "2s",     // 慢查询阈值
  "index.search.slowlog.threshold.query.info": "1s",
  "index.indexing.slowlog.threshold.index.warn": "1s"    // 慢写入阈值
}

# 任务积压
GET /_cat/pending_tasks?v
# 关注：priority、time_in_queue_millis（>10s 是问题）
```

## 六、底层本质：为什么是倒排索引 + 分布式分片

回到第一性：**全文检索的数学最优解是倒排索引，海量数据的物理解是分布式**。

**为什么倒排索引优于 B+Tree**：B+Tree 按字段值排序，查询 `LIKE '%手机%'` 无法用索引（前缀通配放弃索引），只能全表扫描。倒排索引预先把"文档包含哪些词"算好，查询"手机"直接查 term 的 doc list，O(1) 召回。代价是写入时要分词建倒排（慢），所以 ES 写比 MySQL 慢但搜索快。

**为什么分片**：单机存不下亿级文档（单机磁盘 TB 级上限），单机算不动亿级检索（CPU 上限）。分片把一个索引切成 N 份分布到 N 台机器，查询并行执行 N 份再合并，吞吐随分片数线性扩展。代价是分片数创建后不能改（只能 reindex），所以要按未来 2-3 年数据量预留。

**为什么 refresh_interval 是近实时的根因**：ES 写入先写 translog（持久化）+ in-memory buffer（不可查询），每 refresh_interval（默认 1s）把 buffer 刷成 segment 文件（可查询）。所以 ES 是"近实时"（1s 延迟），不是"实时"。写入密集时调大 refresh_interval 减少刷盘次数，吞吐提升 5-10 倍，代价是查询延迟变长。

**doc_values 的本质**：倒排索引按 term 找 doc 快，但按 doc 找字段值（排序、聚合）要遍历倒排，慢。doc_values 是列式存储（按 doc 找字段值），排序聚合时直接用，避免遍历倒排。默认开启，不要关（除非纯搜索不聚合）。

## 七、AI 架构师加问：5 个 AI 相关问题

1. **AI 向量检索（RAG）用 ES 还是专用向量库？**
   小规模（百万级文档）用 ES 8.x 的 dense_vector + kNN（一套系统管文本和向量）。大规模（亿级）用 Milvus/Pinecone（专用向量库，性能优 10 倍）。混合检索（向量召回 + 关键词过滤）用 ES 更方便。

2. **AI 商品推荐如何用 ES 做多路召回？**
   ES 做关键词召回（match query）+ 属性过滤（filter），向量库做语义召回（embedding kNN），合并去重后给排序模型。ES 的 bool query 能做多条件组合，是召回阶段的事实标准。

3. **让 AI 自动诊断 ES 慢查询，AI 接管哪段？**
   AI 解析 _cat/segments、慢查询日志、_cluster/health，分类根因（segment 太多、mapping 不合理、深分页、filter 没用）。AI 出建议（force merge、改 mapping 用 keyword、search_after、filter 替代 query），人工 review。

4. **AI 知识库的 ES mapping 怎么设计？**
   doc_id (keyword)、title (text + 分词)、content (text + 分词 + 向量子字段)、tags (keyword)、embedding (dense_vector dim=1536)。混合查询：全文 match + kNN 向量召回，加权合并。监控 recall@k 看召回效果。

5. **AI 推理结果如何高效写入 ES？**
   bulk API 批量写（一批 1000 条）、refresh_interval 调 30s、副本临时设 0、写完 force merge。监控 indexing_rate 和 bulk_rejection（线程池满拒绝）。

## 八、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"倒排索引、text/keyword、分片 50GB、refresh 1s、search_after 深分页"**。

- **倒排索引**：分词建 term→doc list，搜索快写慢，是 ES 灵魂
- **mapping**：text 分词搜索、keyword 精确匹配聚合、nested 保边界、scaled_float 省空间
- **分片**：单分片 30-50GB，分片数创建后不能改，按未来数据量预留
- **refresh_interval**：默认 1s 近实时，写入密集调 30s + 副本设 0 提升吞吐
- **深分页**：search_after 替代 from/size，scroll 适合全量导出

### 拟人化理解

把 ES 想成 **JD 图书馆检索系统**。倒排索引是"关键词 → 书号清单"（按词找书快，但要预先建索引）。正排（doc_values）是"按书号找书内容"（排序、聚合用）。分片是把图书馆分成 N 个分馆（每分馆独立检索，合并结果）。refresh_interval 是"新书上架间隔"（默认 1 秒，太频繁烧人力，调大省事）。深分页是从第 1 万本开始翻——直接翻要先把前 1 万本搬出来（heap 爆炸），search_after 是"从上一本旁边继续翻"。

### 面试现场 60 秒回答

> ES 核心是倒排索引——写入时分词建 term→doc list，查询按 term 召回，毫秒级搜亿级文档。mapping 按查询模式设计：text 分词做全文搜索、keyword 精确匹配和聚合、nested 保嵌套边界、scaled_float 省空间。分片数按数据量算（单分片 30-50GB），创建后不能改要预留。refresh_interval 默认 1s 近实时，写入密集调 30s + 副本设 0 提升吞吐 5-10 倍。深分页用 search_after 替代 from/size 避免 heap 爆炸。filter 比 query 快 10 倍（不打分 + 缓存），能用 filter 就用 filter。诊断用 _cat/indices、_cat/segments、_cluster/health。

### 反问面试官

> 贵司 ES 是单集群还是多集群（按业务隔离）？数据量级和查询 QPS？是否需要中文分词和拼音搜索？这决定我 mapping 和分片方案。

## 九、苏格拉底式面试追问

每一问先回答"为什么"，再"怎么做"，最后"如何证明"。

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不用 MySQL 全文索引，要用 ES？ | MySQL FULLTEXT 索引分词弱（不支持中文 IK 分词）、不支持复杂聚合、亿级数据性能崩。ES 倒排索引 + 分布式专为搜索设计。证明：亿级商品 MySQL LIKE 搜索 10s，ES match 查询 50ms |
| 证据追问 | 怎么证明 ES 查询慢是 segment 太多？ | _cat/segments 看 segment 数（>50 是问题）、慢查询日志看 query time、_nodes/stats 看 segment memory。force merge 后对比查询 P99 应下降 |
| 边界追问 | ES 能做事务吗？ | 不能。ES 不支持 ACID 事务（无跨文档事务），只能单文档级别原子。需要事务的场景用 MySQL，ES 只做搜索召回，结果回查 MySQL 取最新数据 |
| 反例追问 | 什么场景不用 ES？ | 强一致事务（用 MySQL）、低延迟 KV（用 Redis）、固定查询 B+Tree 高效（用 MySQL 索引）、数据量小（< 百万，MySQL 够）。ES 是搜索/聚合专用，不是通用存储 |
| 风险追问 | mapping 设计错的最大风险？ | text/keyword 混用（该精确匹配的用了 text 分词，聚合结果错乱）、nested 漏用（object 扁平化错误匹配）、字段过多（mapping explosion 撑爆 heap）。mapping 上线难改（要 reindex），必须设计评审 |
| 验证追问 | 怎么证明分片数定的合理？ | 单分片 store.size 30-50GB（_cat/indices 看）、查询延迟 P99 < 100ms、写入吞吐满足业务、节点磁盘使用率 < 70%。分片倾斜（某分片远大于其他）说明路由 key 不均 |
| 沉淀追问 | 团队 ES 规范沉淀什么？ | mapping 设计规范（命名、类型、必填）、分片数计算公式、index template 模板、慢查询阈值、_cat 诊断 SOP、reindex 升级流程、索引生命周期管理（ILM） |

### 现场对话示例

**面试官**：title 字段为什么要同时定义 text 和 keyword？

**候选人**：因为查询模式不同。text 类型会被 Analysis 分词建倒排，适合全文搜索（用户搜"5G 手机"能匹配 title 含这些词的商品）。但 text 不能用于排序和聚合（分词后的多个 term 无法排序）。keyword 类型不分词，整个值作为单一 term，适合精确匹配、排序、聚合（按 title 排序、按 title 聚合统计）。所以一个字段常同时定义 text（搜索）和 keyword（排序聚合）子字段，用 title.keyword 访问后者。这是 ES 的 multi-field 设计模式。

**面试官**：深分页为什么慢？

**候选人**：from + size 的实现机制是——协调节点把请求分发到每个分片，每个分片取 from+size 条（不是 size 条！）返回协调节点，协调节点合并所有分片的结果排序后取 from 到 from+size。所以 from=10000 size=10 时，10 个分片每个要返回 10010 条，协调节点要合并 10 万条到 heap 排序。这有两个问题：① heap 爆炸 OOM；② 排序 10 万条慢。ES 默认 max_result_window=10000 拦截。解法是 search_after——基于上一页最后一条的 sort 值继续查，每次只取 size 条，无 heap 压力。代价是不能跳页（只能上一页下一页），但实际深分页用户极少跳页，可接受。

**面试官**：写入性能怎么优化？

**候选人**：四板斧。① bulk 批量写，一批 1000-5000 条，比单条写快 10-100 倍。② refresh_interval 调到 30s（甚至 -1 完全关闭），减少 segment 刷盘次数。③ number_of_replicas 临时设 0（写完恢复 1），省副本同步开销——这步要小心，副本设 0 期间单点故障会丢数据，只在大批量导入时用。④ 写完 force merge 成 1 个 segment，提升后续查询性能（segment 数少了，查询要合并的 segment 就少）。监控 indexing_rate 和 bulk_rejection（线程池满会拒绝）。

## 常见考点

1. **text 和 keyword 区别？**——text 分词建倒排（全文搜索）、keyword 不分词整个值作 term（精确匹配/排序/聚合）。常同时定义 multi-field。
2. **分片数怎么定？**——单分片 30-50GB，分片数 = 总数据量 / 50GB，按未来 2-3 年预留。创建后不能改（只能 reindex）。
3. **深分页怎么办？**——search_after 替代 from/size（避免 heap 爆炸）、scroll 适合全量导出（reindex/备份）。
4. **refresh_interval 调大有什么好处？**——减少 segment 刷盘次数，写入吞吐提升 5-10 倍。代价是查询延迟变长（数据 30s 后才可见）。
5. **filter 和 query 区别？**——filter 不打分（不计算 _score）可缓存，快 10 倍；query 打分排序，不缓存。能用 filter 就用 filter。


## 结构化回答

**30 秒电梯演讲：** 聊到Elasticsearch 索引建模与搜索性能，我的理解是——ES 是倒排索引的分布式实现——写入时分词建倒排（term → doc list），查询时按 term 倒排召回。索引建模的核心是"按查询设计 mapping"（哪些字段索引、哪些分词、哪些聚合）、分片数决定并行度、refresh_interval 决定实时性。打个比方，像 JD 图书检索：正排索引是"按书号找书"（O(1) 但要遍历所有书找关键词），倒排索引是"按关键词找书号清单"（关键词 → [书1,书5,书9]，O(1) 召回）。ES 是后者，所以搜索快但写入慢（要先分词建倒排）。

**展开框架：**
1. **倒排索引** — Analysis 分词 → 建倒排（term → doc list），是 ES 搜索快的根因
2. **mapping 设计** — text（分词）vs keyword（不分词，精确匹配/聚合），按查询模式选
3. **分片数 = 数据量 / 单分片推荐** — 分片数 = 数据量 / 单分片推荐 30-50GB；副本数 = 1（高可用）+ 动态调整

**收尾：** 这块我在项目里也踩过坑——想深入的话，可以接着聊：text 和 keyword 区别？您更想看哪个方向？

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡 | "Elasticsearch 索引建模与搜索性能——这道题面试官到底想考什么？我用 30 秒给你讲透。" | 开场钩子 |
| 0:15 | B+ 树索引结构图 | 先说核心：ES 是倒排索引的分布式实现——写入时分词建倒排（term → doc list），查询时按 term 倒排召回。索引建模的核心是"按查询设计 mapping"（哪些字段索引、。 | 核心定义 |
| 0:40 | Elasticsearch 倒排索引图 | text（分词）vs keyword（不分词，精确匹配/聚合），按查询模式选。 | mapping 设计 |
| 1:05 | 搜索引擎架构图 | 分片数 = 数据量 / 单分片推荐 30-50GB；副本数 = 1（高可用）+ 动态调整。 | 分片数 = 数据量 / 单分片推荐 |
| 2:30 | 总结卡 | 一句话记忆：倒排索引：分词建 term→doc list，是 ES 搜索快的根因。 下期可以接着聊：text 和 keyword 区别。 | 收尾总结 |
