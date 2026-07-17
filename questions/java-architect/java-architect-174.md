---
id: java-architect-174
difficulty: L3
category: java-architect
subcategory: 搜索架构
tags:
- Java 架构师
- 搜索索引
- 延迟
- 一致性
feynman:
  essence: 搜索索引双写一致性的本质是"MySQL（主库）和 Elasticsearch（索引）是两个独立系统，写入要么都成功要么都失败"。解法是"同步双写（事务）或异步 CDC（最终一致）"——同步双写用事务/补偿保证强一致但性能差，异步 CDC 用 binlog 监听保证最终一致但有延迟。核心权衡是"一致性 vs 性能"。
  analogy: 像超市的货架和库存系统——你在收银台买了东西（MySQL），货架标签（ES 索引）也要更新。同步是收银时同时改标签（慢但准），异步是收银后派人去改标签（快但有几秒延迟）。
  first_principle: MySQL 是 OLTP（事务强一致），ES 是搜索（全文检索倒排索引）。两者数据模型和存储不同，不能共用。写入 MySQL 后要同步到 ES 供搜索。双写的问题是"网络/故障下两个系统可能不一致"。
  key_points:
  - 三种同步模式：同步双写（事务）、异步 MQ（最终一致）、CDC binlog（解耦最终一致）
  - 延迟来源：MQ 投递 + ES 刷新（refresh interval，默认 1 秒）
  - 一致性策略：写 MySQL → 发 MQ → 消费写 ES，失败重试 + 死信
  - 补偿对账：T+1 比对 MySQL 和 ES 数据，差异补偿
  - ES refresh_interval：默认 1 秒（写入到可搜索的延迟），实时要求高可调小但性能降
first_principle:
  problem: 商品数据写入 MySQL 后如何保证 Elasticsearch 索引最终一致，且延迟可控、故障可恢复？
  axioms:
  - MySQL 和 ES 是独立系统，无法用分布式事务保证强一致（性能代价高）
  - 网络故障/服务宕机可能导致双写一个成功一个失败
  - ES 的 refresh_interval 导致写入到可搜索有固有延迟（默认 1 秒）
  - 搜索场景允许秒级延迟（不像交易要强一致）
  rebuild: 异步 CDC 方案——MySQL 写入后，Debezium 监听 binlog 发到 Kafka，消费端写 ES。失败重试 + 死信队列 + T+1 对账兜底。ES refresh_interval 按业务调（实时搜索 200ms，离线 30s）。
follow_up:
  - 同步双写和异步 CDC 怎么选？——核心交易用同步双写（事务保证），搜索/推荐用异步 CDC（秒级延迟可接受）。JD 商品搜索用 CDC。
  - ES 写入失败怎么办？——消费 MQ 失败重试（指数退避），重试 3 次进死信队列人工处理。T+1 对账发现 MySQL 有但 ES 没有的数据补偿写入。
  - binlog 乱序怎么处理？——Debezium 保留 binlog 顺序，Kafka 单分区有序。消费端按 productId hash 到同一分区保证同商品顺序。
  - 怎么减少 ES 写入延迟？——bulk 批量写入（一次 100-1000 条），refresh_interval 调大（30s）攒批量刷新。实时要求高的用 1s 或手动 refresh。
  - 双写后搜索不到怎么办？——ES refresh 延迟（默认 1s），写入后立即搜可能搜不到。解决：用 GET by id（实时），不用 search（等 refresh）。或强制 refresh（性能差）。
memory_points:
  - 三模式：同步双写（事务）/异步 MQ / CDC binlog（解耦）
  - 延迟：MQ 投递 + ES refresh_interval（默认 1s）
  - CDC：Debezium 监听 binlog → Kafka → 消费写 ES
  - 失败：重试 + 死信 + T+1 对账补偿
  - ES refresh：默认 1s，实时可调 200ms，离线 30s
---

# 【Java 后端架构师】搜索索引延迟与双写一致性

> 适用场景：JD 核心技术。商品上架写入 MySQL 后，用户搜索要能搜到——但 ES 索引同步有延迟，用户反馈"刚上架的商品搜不到"。双写时 MySQL 成功了 ES 写失败怎么办？架构师要设计一套"最终一致、延迟可控、故障可恢复"的 MySQL→ES 同步方案。

## 一、概念层：三种同步模式对比

| 模式 | 一致性 | 延迟 | 性能 | 解耦 | 适用 |
|------|--------|------|------|------|------|
| **同步双写** | 强（事务） | 0 | 差（两次 RTT） | 低 | 核心交易 |
| **异步 MQ** | 最终 | 秒级 | 中 | 中 | 通用 |
| **CDC binlog** | 最终 | 秒级 | 高（不影响主库） | 高 | 搜索/推荐 |

## 二、机制层：CDC binlog 方案（推荐）

```java
// Debezium 监听 MySQL binlog，变更发到 Kafka
// 配置示例（connect 配置）
{
  "name": "mysql-product-connector",
  "config": {
    "connector.class": "io.debezium.connector.mysql.MySqlConnector",
    "database.hostname": "mysql-primary",
    "database.server.id": "184054",
    "database.include.list": "jd_product",
    "table.include.list": "jd_product.t_product,jd_product.t_sku",
    "database.server.name": "products",
    "database.history.kafka.topic": "schema-changes.products",
    "database.history.kafka.bootstrap.servers": "kafka:9092"
  }
}
// 输出到 Kafka topic: products.jd_product.t_sku
// 消息格式：{"before": {...}, "after": {...}, "op": "u/c/d"}
```

```java
// 消费端：binlog 变更 → ES 索引更新
@Component
@Slf4j
public class EsSyncConsumer {

    private final ElasticsearchClient esClient;
    private final BulkRequestPool bulkPool;       // 批量写入池

    /**
     * 消费 binlog 变更，批量写 ES
     * 按 productId hash 到同一分区保证顺序
     */
    @KafkaListener(topics = "products.jd_product.t_sku")
    public void onSkuChange(List<ChangeRecord> records,
                            Acknowledgment ack) {
        BulkRequest.Builder bulk = new BulkRequest.Builder();

        for (ChangeRecord record : records) {
            String skuId = record.getAfter().get("sku_id");
            Operation op = record.getOp();

            if (op == DELETE) {
                bulk.operations(op -> op.delete(
                    d -> d.index("sku_search").id(skuId)));
            } else {
                // INSERT / UPDATE：构建 ES 文档
                Map<String, Object> doc = buildEsDoc(record.getAfter());
                bulk.operations(op -> op.index(
                    i -> i.index("sku_search").id(skuId).document(doc)));
            }
        }

        try {
            // 批量写入（一次 100-500 条，性能远超单条）
            BulkResponse response = esClient.bulk(bulk.build());

            // 处理部分失败
            if (response.errors()) {
                for (BulkResponseItem item : response.items()) {
                    if (item.error() != null) {
                        log.error("ES 写入失败 id={} error={}",
                            item.id(), item.error().reason());
                        // 失败的记录投递到重试队列
                        retryQueue.send(item.id());
                    }
                }
            }

            ack.acknowledge();   // 成功才提交 offset
            metrics.increment("es.sync.success", records.size());

        } catch (Exception e) {
            log.error("ES 批量写入异常", e);
            // 不 ack，Kafka 会重试消费
            throw e;
        }
    }

    private Map<String, Object> buildEsDoc(Map<String, Object> row) {
        return Map.of(
            "sku_id", row.get("sku_id"),
            "title", row.get("title"),
            "category", row.get("category_id"),
            "price", row.get("price"),
            "status", row.get("status"),
            "seller_id", row.get("seller_id"),
            "updated_at", Instant.now().toEpochMilli()
        );
    }
}
```

## 三、机制层：同步双写（事务方案）

```java
@Service
public class ProductService {

    /**
     * 同步双写：MySQL 和 ES 在同一事务（用 Outbox 模式）
     * 适用：核心数据（价格/库存）要求强一致
     */
    @Transactional
    public void updateProduct(Product product) {
        // 1. 写 MySQL（主事务）
        productRepo.save(product);

        // 2. 写 Outbox 表（同事务，保证原子）
        outboxRepo.save(new OutboxMessage("product_update",
            JsonUtils.stringify(product)));

        // 3. 异步任务扫 Outbox → 发 MQ → 写 ES
        // Outbox 保证"MySQL 写成功则 ES 最终会写"
    }
}

// Outbox 消费者
@Component
public class OutboxPublisher {

    @Scheduled(fixedDelay = 100)
    public void publish() {
        List<OutboxMessage> pending = outboxRepo.findPending(100);
        for (OutboxMessage msg : pending) {
            try {
                kafka.send("es.sync", msg.getPayload());
                outboxRepo.markPublished(msg.getId());
            } catch (Exception e) {
                log.error("Outbox 发布失败", e);
            }
        }
    }
}
```

## 四、机制层：ES 延迟优化

```json
// ES 索引设置：refresh_interval 控制写入到可搜索的延迟
PUT sku_search {
  "settings": {
    "refresh_interval": "1s",          // 默认 1s（写入后 1s 可搜）
    "number_of_shards": 5,
    "number_of_replicas": 1
  }
}

// 实时要求高：调小 refresh_interval（性能下降）
PUT sku_search/_settings {
  "refresh_interval": "200ms"          // 200ms 可搜，但写入性能降 30%
}

// 批量导入场景：临时关闭 refresh（导入完再开）
PUT sku_search/_settings {
  "refresh_interval": "-1"             // 导入期间不刷新
}
// 导入完成后
PUT sku_search/_settings {
  "refresh_interval": "1s"
}
```

```java
// 实时读取：GET by id 不受 refresh_interval 影响（实时）
// 搜索：受 refresh_interval 影响（等刷新）
@Service
public class SearchService {

    public Product getById(String skuId) {
        // GET by id 实时（不依赖 refresh）
        return esClient.get(g -> g.index("sku_search").id(skuId),
            Product.class).source();
    }

    public List<Product> search(String keyword) {
        // search 依赖 refresh（有 refresh_interval 延迟）
        return esClient.search(s -> s
            .index("sku_search")
            .query(q -> q.match(m -> m.field("title").query(keyword))),
            Product.class).hits().hits();
    }
}
```

## 五、机制层：T+1 对账补偿

```java
@Service
public class SearchReconciliation {

    /**
     * T+1 对账：MySQL 主数据 vs ES 索引
     * 发现差异补偿
     */
    @Scheduled(cron = "0 0 4 * * ?")
    public void reconcile() {
        long mysqlCount = productRepo.count();
        long esCount = esClient.count(c -> c.index("sku_search")).count();

        if (mysqlCount != esCount) {
            log.warn("数据量不一致 MySQL={} ES={}", mysqlCount, esCount);
            // 分批比对
            int pageSize = 10000;
            for (long offset = 0; offset < mysqlCount; offset += pageSize) {
                List<Product> mysqlBatch = productRepo.findBatch(offset, pageSize);
                List<String> ids = mysqlBatch.stream()
                    .map(Product::getSkuId).collect(toList());
                Map<String, Product> esBatch = esClient.multiGet(ids);

                for (Product mysql : mysqlBatch) {
                    Product es = esBatch.get(mysql.getSkuId());
                    if (es == null) {
                        // ES 缺失，补偿写入
                        esClient.index(i -> i.index("sku_search")
                            .id(mysql.getSkuId()).document(mysql));
                        metrics.counter("reconcile.es_missing").increment();
                    } else if (!mysql.getUpdatedAt().equals(es.getUpdatedAt())) {
                        // 版本不一致，以 MySQL 为准更新 ES
                        esClient.index(i -> i.index("sku_search")
                            .id(mysql.getSkuId()).document(mysql));
                        metrics.counter("reconcile.version_diff").increment();
                    }
                }
            }
        }
        metrics.gauge("reconcile.diff_rate", diffCount / total);
    }
}
```

## 六、底层本质：CAP 在搜索场景的取舍

MySQL→ES 同步本质是跨系统数据复制，受 CAP 约束：
- **强一致（CP）**：同步双写 + 事务，但性能差（两次 RTT + 事务开销），且 ES 不支持分布式事务
- **最终一致（AP）**：异步 CDC，秒级延迟，但搜索场景可接受
- **可用性（A）**：ES 挂了搜索不可用，降级到 MySQL LIKE（慢但可用）

搜索场景选 AP——延迟秒级可接受（用户不会感知"刚上架 1 秒搜不到"），但性能和解耦重要（不能让 ES 故障拖垮交易主链路）。所以 CDC binlog 是主流方案。

**Outbox 模式的本质**：解决"本地事务 + 消息发送"的原子性。直接"写 MySQL + 发 MQ"可能 MySQL 成功 MQ 失败（数据丢）。Outbox 把消息写入同事务的表（保证和业务数据原子提交），独立任务扫 Outbox 发 MQ。这是"用数据库事务保证消息可靠"的经典模式。

**ES refresh_interval 的本质**：ES 写入后数据先到 translog（持久化）和 index buffer（内存），refresh 操作把 buffer 刷新成可搜索的 segment。默认 1 秒刷新一次，所以写入到可搜索有 1 秒延迟。调小延迟但频繁 refresh 性能差（segment 太多）。GET by id 直接读 translog 所以实时。

## 七、AI 工程化深挖

1. **搜索相关性怎么用 AI 优化？**
   传统 ES 用 BM25（关键词匹配）。AI 增强：用 embedding 向量做语义搜索（ES 8.x dense_vector），或用 LLM 做 query 改写（"便宜手机" → "低价智能手机"）。但向量搜索要单独维护索引，和 BM25 混合检索。

2. **怎么做搜索的实时性优化？**
   对于"刚上架立即要搜到"的场景（如秒杀商品），用同步双写 + 手动 refresh（写入后强制 refresh）。但只对少量关键商品，否则性能崩。监控 index_to_search_latency。

3. **LLM 辅助搜索意图理解怎么做？**
   用户搜"iPhone 15"，LLM 理解意图（品牌+型号），扩展 query（加"苹果手机"），调整搜索权重（title 权重高于 description）。但 LLM 改写有延迟（200ms+），要缓存或异步。

4. **怎么做搜索结果的个性化？**
   基础搜索用 ES（关键词召回），个性化用推荐模型重排。用户特征（历史点击/品类偏好）从特征平台读，模型对 ES 召回结果重排。这是"召回（ES）→ 重排（模型）"的两段式。

5. **怎么用 AI 检测索引质量？**
   监控搜索无结果率（zero_result_rate）——用户搜了但没结果，可能是索引不全或分词问题。AI 分析无结果 query 推荐优化（加同义词、改分词器）。

## 八、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"CDC binlog、Outbox、批量 bulk、T+1 对账"** 四个词。

- **CDC**：Debezium 监听 binlog → Kafka → 消费写 ES，解耦不影响主库
- **Outbox**：本地事务 + Outbox 表 + 异步发 MQ，保证原子
- **bulk 批量**：100-500 条批量写 ES，性能远超单条
- **T+1 对账**：MySQL count vs ES count，差异补偿

### 面试现场 60 秒回答

> MySQL→ES 同步我用 CDC binlog 方案——Debezium 监听 MySQL binlog 变更发到 Kafka（按 productId hash 分区保证顺序），消费端批量 bulk 写 ES（100-500 条/批，性能远超单条）。失败重试指数退避，3 次进死信队列人工处理。ES refresh_interval 默认 1s（写入到可搜索延迟），实时要求高的场景调 200ms（性能降 30%）或用 GET by id（不受 refresh 影响，实时读）。强一致要求的场景（价格/库存）用 Outbox 模式——写 MySQL 同事务写 Outbox 表（保证原子），独立任务扫 Outbox 发 MQ。T+1 对账兜底：比对 MySQL count 和 ES count，MySQL 有 ES 没有的补偿写入。搜索场景选 AP（秒级延迟可接受），不选同步双写（性能差且 ES 不支持分布式事务）。监控 index_to_search_latency、es_write_failure_rate、reconcile_diff_rate。

## 九、常见考点

1. **CDC 和 MQ 双写区别？**——CDC 监听 binlog（对业务无侵入，主库写完才触发）；MQ 双写是业务代码发 MQ（侵入业务，但可控制消息内容）。CDC 更解耦，JD 搜索用 CDC。
2. **ES refresh_interval 为什么有延迟？**——ES 写入先进 translog（持久化）和 index buffer（内存），refresh 把 buffer 刷成可搜索 segment。默认 1s 刷一次。GET by id 读 translog 实时，search 读 segment 有延迟。
3. **双写一个成功一个失败怎么办？**——CDC 方案靠 binlog 重放（MySQL 成功后 binlog 有记录，消费失败重试即可）。同步双写用 Outbox（保证 MySQL 和 Outbox 原子，Outbox 发 MQ 失败重试）。
4. **ES 写入性能怎么优化？**——bulk 批量写（100-500 条）、调大 refresh_interval（30s）、减少副本数（导入时 0，完成后恢复）、用 ES 自动生成的 id（不用外部 id 避免版本检查）。

## 结构化回答

**30 秒电梯演讲：** 搜索索引双写一致性的本质是MySQL（主库）和 Elasticsearch（索引）是两个独立系统，写入要么都成功要么都失败。解法是同步双写（事务）或异步 CDC（最终一致）——同步双写用事务/补偿保证强一致但性能差，异步 CDC 用 binlog 监听保证最终一致但有延迟。核心权衡是一致性 vs 性能

**展开框架：**
1. **三种同步模式** — 同步双写（事务）、异步 MQ（最终一致）、CDC binlog（解耦最终一致）
2. **延迟来源** — MQ 投递 + ES 刷新（refresh interval，默认 1 秒）
3. **一致性策略** — 写 MySQL → 发 MQ → 消费写 ES，失败重试 + 死信

**收尾：** 以上是我的整体思路。您想继续深入聊——同步双写和异步 CDC 怎么选？


## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：搜索索引延迟与双写一致性 | "这题核心是——搜索索引双写一致性的本质是MySQL（主库）和 Elasticsearch（索引）是两个独立系统，……" | 开场钩子 |
| 0:15 | 像超市的货架和库存系统——你在收银台买了东西（M类比图 | "打个比方：像超市的货架和库存系统——你在收银台买了东西（M。" | 核心类比 |
| 0:40 | 三种同步模式示意/对比图 | "同步双写（事务）、异步 MQ（最终一致）、CDC binlog（解耦最终一致）" | 三种同步模式要点 |
| 1:05 | 延迟来源示意/对比图 | "MQ 投递 + ES 刷新（refresh interval，默认 1 秒）" | 延迟来源要点 |
| 1:55 | 总结卡 | "记住：三模式。下期见。" | 收尾 |
