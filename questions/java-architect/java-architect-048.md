---
id: java-architect-048
difficulty: L3
category: java-architect
subcategory: 网关设计
tags:
- Java 架构师
- BFF
- API
- 聚合
feynman:
  essence: BFF（Backend for Frontend）本质是"为每种客户端定制一个后端"——App、小程序、Web 各有自己的 BFF，BFF 负责聚合下游 N 个微服务的 API、裁剪字段、适配端侧格式。核心价值是"端侧只发一个请求拿到首屏所有数据"，避免移动端为渲染一个首页发 10 次 HTTP 请求（每次 RTT 100-300ms）。
  analogy: 像旅行社的全包服务。游客（App）说"我要去东京玩"，旅行社（BFF）自己订机票（调机票 API）、订酒店（调酒店 API）、订餐厅（调餐厅 API），最后给游客一个"东京 5 日游"的完整方案。游客不用自己分别联系 N 个供应商——BFF 就是那个旅行社。
  first_principle: 为什么要为每种端做 BFF？因为不同端的"首屏数据需求"不同——App 首页要商品+促销+广告+消息，Web 首页可能只要商品+促销。如果没有 BFF，App 要发 4 次请求串行调 4 个服务，总 RT = 4 × RTT。BFF 在服务端并行聚合，RT ≈ max(各下游 RT) + 聚合开销，通常 < 单次 RTT 的 1.5 倍。
  key_points:
  - BFF 的三种聚合：字段裁剪（去掉端侧不需要的）、多源合并（商品+库存+价格合成视图）、协议适配（REST 转 GraphQL）
  - 并行聚合用 CompletableFuture/Reactor，串行依赖用 thenCompose
  - BFF 是"薄层"，不含业务逻辑，只做编排和适配
  - 熔断兜底：BFF 聚合时部分下游失败要降级（返回默认值或部分数据），不能整页空白
  - GraphQL vs REST BFF：GraphQL 灵活但学习成本高，REST BFF 简单但接口固定
first_principle:
  problem: 移动端首屏渲染需要聚合 N 个微服务的数据，如何最小化端侧请求数和延迟？
  axioms:
  - 移动端每次 HTTP 请求 RTT 100-300ms，串行 N 次的总延迟不可接受
  - 不同端（App/Web/小程序）的首屏字段需求不同，强统一导致字段冗余传输
  - 微服务后端不应该为"某个端的某个页面"定制接口（违反服务复用）
  rebuild: 在端和微服务之间加 BFF 层。BFF 按端拆分（App-BFF/Web-BFF），接收端的"首屏请求"（单个请求），内部并行调 N 个微服务，聚合裁剪后返回端侧需要的精确字段。BFF 不含业务逻辑，只做编排（并行/串行）、裁剪（按端去字段）、适配（格式转换）。熔断降级保证部分下游失败不影响整页。
follow_up:
  - BFF 该用 Node.js 还是 Java？——Node.js 适合 IO 密集的聚合（异步友好、前端全栈），Java 适合已有 JVM 生态的团队（复用 Spring Cloud）。京东内部用 Java（Node.js 团队少）。
  - BFF 和网关（Gateway）什么关系？——网关是通用入口（鉴权/限流/路由），BFF 是业务聚合层。网关在前，BFF 在后。一个 BFF 可能经过网关。
  - BFF 怎么做缓存？——请求级缓存（同一请求内聚合时复用）、CDN 缓存（静态数据）、Redis 缓存（热点聚合结果）。注意缓存失效——下游数据变化要主动失效。
  - GraphQL BFF 的 N+1 问题？——用 DataLoader 批量查询（DataLoader.batchLoader 把 N 次单查合并成 1 次批量查）。否则 GraphQL 解析嵌套字段会触发 N 次 DB 查询。
  - BFF 团队归属前端还是后端？——通常归"端架构团队"（既懂前端又懂后端）。前端写 BFF（Node.js 场景）效率高（端侧需求直接改），但微服务调用和治理需要后端能力。
memory_points:
  - BFF = 为每种端定制的后端聚合层
  - 三种聚合：字段裁剪、多源合并、协议适配
  - 并行用 CompletableFuture，熔断降级保证部分失败不空白
  - BFF 是薄层，不含业务逻辑
  - GraphQL vs REST：灵活 vs 简单
---

# 【Java 后端架构师】BFF、API 聚合与前后端协作

> 适用场景：JD 核心技术。京东 App 首页要展示商品列表、促销 banner、个性化推荐、消息红点、购物车数量——5 个数据来自 5 个微服务。如果没有 BFF，App 要发 5 次请求，首屏 3 秒起步。BFF 在服务端并行聚合，首屏 500ms 内完成。

## 一、概念层：为什么需要 BFF

**没有 BFF 的痛点**（端侧直连微服务）：

```
App 首页渲染流程（无 BFF）：
    Step 1: GET /products          → 100ms  (商品服务)
    Step 2: GET /promotions        → 120ms  (促销服务)
    Step 3: GET /recommendations   → 200ms  (推荐服务)
    Step 4: GET /messages/unread   → 80ms   (消息服务)
    Step 5: GET /cart/count        → 90ms   (购物车服务)
    总计串行：590ms（5 次 RTT，移动端可能 1.5s+）

问题：
1. 端侧要发 5 次请求，RTT 累积延迟高
2. 每个接口返回完整字段，App 只用其中 20%，带宽浪费
3. Web 和 App 的字段需求不同，但调同一个接口（冗余字段）
4. 某个服务挂了，整页空白（无降级）
```

**有 BFF 的方案**：

```
App 首页渲染流程（有 BFF）：
    App ──GET /homepage──► App-BFF
                              │
                              ├──并行──► 商品服务     (100ms)
                              ├──并行──► 促销服务     (120ms)
                              ├──并行──► 推荐服务     (200ms)
                              ├──并行──► 消息服务     (80ms)
                              └──并行──► 购物车服务   (90ms)
                              │
                              ▼ 聚合 + 裁剪
    App ◄──精确字段响应─── App-BFF

    总计：max(200ms) + 聚合开销(20ms) ≈ 220ms（1 次 RTT）
    降级：推荐服务挂了，返回空数组，首页仍可渲染
```

## 二、机制层：BFF 并行聚合代码

**CompletableFuture 并行聚合**：

```java
@RestController
@RequestMapping("/api/app")
public class AppHomepageBFF {

    @Autowired private ProductClient productClient;
    @Autowired private PromotionClient promotionClient;
    @Autowired private RecommendClient recommendClient;
    @Autowired private MessageClient messageClient;
    @Autowired private CartClient cartClient;

    @GetMapping("/homepage")
    public CompletableFuture<HomepageVO> homepage(@RequestHeader Long userId) {
        // 并行发起 5 个下游调用
        CompletableFuture<List<ProductVO>> productsFuture =
            productClient.getProducts(userId)
                .orTimeout(200, TimeUnit.MILLISECONDS)               // 单独超时
                .exceptionally(ex -> Collections.emptyList());        // 降级：返回空

        CompletableFuture<List<PromotionVO>> promosFuture =
            promotionClient.getPromotions(userId)
                .orTimeout(200, TimeUnit.MILLISECONDS)
                .exceptionally(ex -> Collections.emptyList());

        CompletableFuture<List<ProductVO>> recommendFuture =
            recommendClient.recommend(userId, 10)
                .orTimeout(300, TimeUnit.MILLISECONDS)               // 推荐可慢一点
                .exceptionally(ex -> Collections.emptyList());

        CompletableFuture<Integer> unreadFuture =
            messageClient.getUnreadCount(userId)
                .orTimeout(100, TimeUnit.MILLISECONDS)
                .exceptionally(ex -> 0);                              // 降级：返回 0

        CompletableFuture<Integer> cartCountFuture =
            cartClient.getCount(userId)
                .orTimeout(100, TimeUnit.MILLISECONDS)
                .exceptionally(ex -> 0);

        // 合并所有结果
        return CompletableFuture.allOf(
                productsFuture, promosFuture, recommendFuture,
                unreadFuture, cartCountFuture
            ).thenApply(v -> {
                HomepageVO vo = new HomepageVO();
                vo.setProducts(productsFuture.join());
                vo.setPromotions(promosFuture.join());
                vo.setRecommendations(recommendFuture.join());
                vo.setUnreadCount(unreadFuture.join());
                vo.setCartCount(cartCountFuture.join());
                return vo;
            })
            .orTimeout(500, TimeUnit.MILLISECONDS);    // 整体超时兜底
    }
}
```

**串行依赖的场景**（先查商品再查价格）：

```java
// 首页推荐：先调推荐服务拿商品 ID，再调价格服务查价格
@GetMapping("/recommend-with-price")
public CompletableFuture<List<RecommendItem>> recommendWithPrice(Long userId) {
    return recommendClient.recommend(userId, 10)                    // Step 1: 推荐商品 ID
        .thenCompose(items -> {
            List<Long> skuIds = items.stream().map(Item::getSkuId).toList();
            return priceClient.batchQuery(skuIds)                   // Step 2: 批量查价格
                .thenApply(prices -> {
                    // 合并商品和价格
                    return items.stream().map(item -> {
                        item.setPrice(prices.get(item.getSkuId()));
                        return item;
                    }).toList();
                });
        });
}
```

## 三、机制层：字段裁剪与协议适配

**字段裁剪**（按端裁掉多余字段）：

```java
// 商品服务返回完整字段（30+ 字段）
public class ProductDTO {
    private Long skuId;
    private String title;
    private BigDecimal price;
    private String description;        // 长文本
    private List<String> images;       // 多图
    private String brand;
    private String category;
    private Integer stock;
    private Double weight;
    private String origin;
    private List<Attribute> attrs;     // 扩展属性
    // ... 还有 20 个字段
}

// App 首页只需要精简字段（列表展示）
public class ProductListItemVO {
    private Long skuId;
    private String title;
    private BigDecimal price;
    private String mainImage;          // 只取第一张图
    // 只有 4 个字段，App 渲染够用

    public static ProductListItemVO from(ProductDTO dto) {
        ProductListItemVO vo = new ProductListItemVO();
        vo.setSkuId(dto.getSkuId());
        vo.setTitle(dto.getTitle());
        vo.setPrice(dto.getPrice());
        vo.setMainImage(dto.getImages().isEmpty() ? null : dto.getImages().get(0));
        return vo;
    }
}

// BFF 聚合时裁剪
List<ProductListItemVO> items = productsFuture.join().stream()
    .map(ProductListItemVO::from)
    .toList();
// 响应体从 30KB 降到 5KB，移动端带宽节省 80%
```

**GraphQL BFF**（按需查询字段）：

```graphql
# App 首页查询（只要 4 个字段）
query Homepage {
  products(userId: "123", limit: 10) {
    skuId
    title
    price
    mainImage
  }
  promotions(userId: "123") {
    id
    title
  }
}

# 详情页查询（要全部字段）
query Detail($skuId: ID!) {
  product(skuId: $skuId) {
    skuId
    title
    price
    description
    images
    brand
    category
    stock
    attrs {
      name
      value
    }
  }
}
# 同一个 GraphQL 接口，端侧按需查询字段，BFF 动态解析
```

**DataLoader 解决 GraphQL N+1**：

```java
// 反例：查询 10 个商品的评论，触发 10 次 DB 查询
@SchemaMapping
public Comment comment(Product product) {
    return commentService.findBySkuId(product.getSkuId());  // N+1 问题
}

// 正解：DataLoader 批量查询
@SchemaMapping
public CompletableFuture<Comment> comment(Product product, DataLoaderContext dlc) {
    DataLoader<Long, Comment> loader = dlc.getDataLoader("commentLoader");
    return loader.load(product.getSkuId());   // GraphQL 收集所有 skuId 后批量查
}

// DataLoader 定义
@Bean
public DataLoader<Long, Comment> commentLoader(CommentService service) {
    return DataLoader.newMappedDataLoader(skuIds ->
        CompletableFuture.supplyAsync(() ->
            service.batchFindByIds(skuIds)   // 一次查 10 个
        )
    );
}
```

## 四、实战层：BFF 的熔断与降级

**降级策略**（部分失败不空白）：

```java
@Component
public class RecommendClientFallback implements RecommendClient {

    @Override
    public List<ProductVO> recommend(Long userId, int limit) {
        // 推荐服务挂了，降级到"热门商品"（从本地缓存或 Redis 取）
        return redisTemplate.opsForList().range("hot_products", 0, limit - 1)
            .stream()
            .map(json -> JSON.parseObject(json, ProductVO.class))
            .toList();
    }
}

// Sentinel 熔断配置
@SentinelResource(
    value = "recommend",
    fallback = "recommendFallback",
    blockHandler = "recommendBlockHandler"
)
public List<ProductVO> recommend(Long userId, int limit) {
    return recommendClient.recommend(userId, limit);
}
```

**舱壁隔离**（防止慢调用耗尽线程）：

```java
// 每个下游用独立线程池，避免互相拖垮
@Configuration
public class BFFThreadPoolConfig {
    @Bean("productPool")
    public ExecutorService productPool() {
        return ThreadPoolBuilder.newBuilder()
            .corePoolSize(20).maxPoolSize(50)
            .workQueue(new ArrayBlockingQueue<>(100))
            .threadNamePrefix("bff-product-")
            .build();
    }
    @Bean("recommendPool")
    public ExecutorService recommendPool() {
        return ThreadPoolBuilder.newBuilder()
            .corePoolSize(10).maxPoolSize(30)
            .workQueue(new ArrayBlockingQueue<>(50))
            .threadNamePrefix("bff-recommend-")
            .build();
    }
}

// BFF 调用时指定线程池
productsFuture = CompletableFuture.supplyAsync(
    () -> productClient.getProducts(userId),
    productPool       // 用商品专属线程池
);
recommendFuture = CompletableFuture.supplyAsync(
    () -> recommendClient.recommend(userId, 10),
    recommendPool     // 推荐慢只占推荐池，不影响商品查询
);
```

## 五、底层本质：BFF 解决的矛盾

回到第一性：**BFF 解决的是"端侧的聚合需求"和"微服务的单一职责"之间的矛盾**。

- **微服务原则**：每个服务只管自己的领域（商品服务不管促销）。这是服务复用的前提。
- **端侧需求**：首屏要一次性拿到 N 个领域的数据。如果端侧直连 N 个服务，RTT 累积不可接受。
- **矛盾**：不能为了端侧让微服务做聚合（破坏单一职责），也不能为了微服务让端侧发 N 次请求（延迟爆炸）。

BFF 是矛盾的解：它在端和微服务之间加一层，专门做聚合。微服务保持纯粹（单一职责），端侧保持简单（一次请求），BFF 承担聚合的复杂度。这是"用一层间接性解耦两端约束"的经典架构模式。

**BFF 为什么按端拆分**？因为 App 和 Web 的首屏需求不同——App 受限于屏幕和带宽要精简字段，Web 可以展示更多信息。如果共用一个 BFF，要么字段是所有端的并集（冗余），要么字段是最小交集（功能缺失）。按端拆分，每个 BFF 只服务一种端，字段精确。

## 六、AI 架构师加问：5 个

1. **BFF 聚合用 AI 做智能降级，怎么做？**
   AI 根据下游服务的历史可用性、当前 RT、错误率动态选择降级策略。推荐服务 RT 突增时，AI 自动切换到缓存降级。但"降级决策"必须确定性可解释（记录为什么降级），不能是黑盒。

2. **AI Agent 本身就是 BFF 吗？**
   有相似处——Agent 也聚合多工具调用。但 BFF 是"确定性的编排"（代码写死调哪几个服务），Agent 是"动态编排"（LLM 决定调哪些工具）。对首屏这种固定场景，BFF 更高效（无 LLM 推理开销）；对开放对话场景，Agent 更灵活。

3. **用 AI 生成 BFF 聚合代码，怎么验证？**
   黄金样本：N 个端侧请求 + 期望的聚合结果。AI 生成的 BFF 代码必须对样本 100% 通过。边界场景：下游超时/失败时的降级行为必须和预期一致（推荐服务挂了返回空数组，不是整页报错）。

4. **BFF 接入 RAG，知识库放什么？**
   放"端侧页面字段需求清单"（App 首页要哪几个字段、Web 详情页要哪几个字段）、"下游微服务 API 文档"、历史降级案例。AI 查询时按端+页面过滤，返回该页面的聚合方案。

5. **AI 推理服务要不要走 BFF？**
   不要。AI 推理是单次深度调用（不是多源聚合），直连推理服务更高效。BFF 适合"N 个快 RPC 的并行聚合"，AI 推理 RT 长（秒级），放 BFF 里会拖慢整个聚合——应该异步化（端侧发推理请求，结果通过 WebSocket/SSE 推送）。

## 七、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"按端拆分、并行聚合、字段裁剪、熔断降级"**。

- **按端拆分**：App-BFF / Web-BFF 各自服务一种端
- **并行聚合**：CompletableFuture 并行调下游，RT ≈ max(下游)
- **字段裁剪**：BFF 按端需求返回精确字段，不传冗余
- **熔断降级**：单服务挂了降级返回默认值，不整页空白
- **GraphQL**：字段按需查询，DataLoader 解决 N+1

### 面试现场 60 秒回答

> BFF 是为每种端定制的后端聚合层。京东 App 首页要商品+促销+推荐+消息+购物车 5 个数据，没 BFF 时 App 发 5 次请求串行 RT 累积 600ms+。BFF 接收端侧一个请求，内部用 CompletableFuture 并行调 5 个微服务，RT 降到 max(200ms)+聚合开销。每个下游配独立超时和降级——推荐服务挂了返回空数组，首页仍可渲染，不整页空白。字段裁剪：商品服务返回 30 字段，App 首页只要 4 字段，BFF 裁剪后响应体从 30KB 降到 5KB，移动端带宽省 80%。协议层 REST BFF 简单固定，GraphQL BFF 灵活（端侧按需查字段），但 GraphQL 要用 DataLoader 批量查解决 N+1。BFF 是薄层不含业务逻辑，只做编排和适配。

## 八、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不让微服务直接提供聚合接口，非要加 BFF？ | 用微服务复用率说话：商品服务为 App 首页聚合促销数据后，这个接口就不能被其他端复用了。BFF 让微服务保持纯粹（单一职责），聚合在 BFF 层。用 service_reuse_rate 和 client_side_p99 衡量 |
| 证据追问 | BFF 的收益怎么量化？ | 对比有无 BFF 的首屏 RT（client_side_p99 从 1.5s 降到 500ms）、端侧请求数（从 5 降到 1）、响应体大小（30KB 降到 5KB）、首屏渲染完成率（page_ready_rate 提升） |
| 边界追问 | BFF 能做业务逻辑吗？ | 不能。BFF 是薄编排层，业务规则应在微服务里。BFF 只做聚合/裁剪/适配/降级。如果 BFF 有了业务逻辑（如计算订单总价），说明微服务设计有问题（能力没下沉） |
| 反例追问 | 什么场景不该用 BFF？ | 单一端的简单应用（一个端+一个服务，无需聚合）、内部管理系统（不关心 RTT）、微服务数 < 3（聚合收益低于 BFF 建设成本）。这些直连更简单 |
| 风险追问 | BFF 最大的风险是什么？ | 主动点出：BFF 变厚（业务逻辑泄露进 BFF）、单点故障（BFF 挂了所有端都挂，要集群+多机房）、级联超时（下游慢导致 BFF 线程耗尽，要用舱壁隔离）、缓存不一致（BFF 缓存未及时失效） |
| 验证追问 | 怎么证明 BFF 聚合正确？ | 契约测试：BFF 的响应 schema 和端侧期望一致；混沌测试：kill 某个下游，验证降级行为；性能压测：聚合 RT P99 < 目标（如 500ms）；字段覆盖率：端侧实际使用的字段率 > 80%（裁剪不过度） |
| 沉淀追问 | BFF 团队沉淀什么？ | 聚合编排框架（CompletableFuture 封装+超时+降级模板）、字段裁剪规范（按端定义 VO）、降级策略库（每个下游的降级方案）、端侧页面字段需求清单 |

### 现场对话示例

**面试官**：BFF 里并行调 5 个服务，有个服务特别慢（2 秒），怎么办？

**候选人**：三层防护。第一层，每个下游调用配独立超时——比如推荐服务配 300ms 超时，超时就返回降级值（空数组或热门商品缓存）。这样即使推荐服务慢到 2 秒，BFF 的整体 RT 不受影响（300ms 内降级返回）。第二层，熔断——用 Sentinel 配置推荐服务的熔断规则，如果最近 10 秒内慢调用比例 > 50%，直接熔断（不走网络，立即降级），避免请求堆积。第三层，舱壁隔离——BFF 调用每个下游用独立的线程池（或信号量），推荐服务慢只占用自己的线程池，不影响其他 4 个服务的调用。这样即使推荐服务彻底挂了，首页的商品、促销、消息、购物车照常返回，只是推荐位显示空或降级内容。京东 App 首页的实践：推荐位有"热门商品"兜底缓存（Redis，TTL 5 分钟），推荐服务异常时 30ms 内返回兜底数据，用户几乎无感。

**面试官**：BFF 该用 Node.js 还是 Java？

**候选人**：看团队和场景。Node.js 的优势是 IO 密集的聚合场景异步友好（事件循环），且前端能全栈写 BFF（端侧需求直接改，减少前后端协作成本），Netflix 和阿里早期大量用 Node.js BFF。Java 的优势是已有 JVM 生态（复用 Spring Cloud 的服务发现/熔断/链路追踪），且团队通常是 Java 背景，京东内部用 Java BFF 居多。我的选择标准：如果团队前端强且 BFF 主要是 IO 聚合（无复杂业务），用 Node.js；如果团队是 Java 且需要复用已有微服务体系（Dubbo/Spring Cloud），用 Java。语言不是关键，BFF 的设计原则（薄层/并行/降级）才是。另外 GraalVM 和虚拟线程（JDK 21）让 Java 在 IO 密集场景的性能大幅提升，Java BFF 的 IO 瓶颈已经不是问题。

**面试官**：GraphQL BFF 的 N+1 问题具体怎么解？

**候选人**：N+1 场景：GraphQL 查询 10 个商品，每个商品都要查评论，如果代码里对每个商品单独查评论，就是 10 次 DB 查询（1 次查商品 + 10 次查评论 = N+1）。解法是 DataLoader——GraphQL 引擎在解析时，把所有商品的评论请求收集起来，传给 DataLoader 的 batchLoader，batchLoader 一次批量查（SELECT * FROM comment WHERE sku_id IN (...)）。代码上，每个字段的 resolver 不直接查 DB，而是调 DataLoader.load(id)，GraphQL 引擎在执行批次时统一调用 batchLoader。DataLoader 还内置了请求级缓存（同一请求内相同 id 只查一次）。京东推荐详情页用 GraphQL + DataLoader，N+1 从 100+ 次查询降到 5-8 次批量查询，RT 降 60%。关键是要为每个可能 N+1 的字段都配 DataLoader，不能遗漏。

## 常见考点

1. **BFF 和 API 网关区别？**——网关是通用入口（鉴权/限流/路由），不针对特定端；BFF 是业务聚合层，针对特定端（App/Web）。网关在前，BFF 在后，一个 BFF 通常在网关后面。
2. **BFF 会成为单点吗？**——会，所以要集群部署+多机房容灾。BFF 是无状态服务（缓存用外部 Redis），水平扩容即可。京东 App-BFF 部署 50+ 实例，分 3 机房。
3. **BFF 怎么做版本兼容？**——和微服务一样，URL 版本化（/v1/homepage）。端侧发版有周期，老版本 App 可能用 v1 接口，新版本用 v2，BFF 要并行支持多个版本，老的给兼容期。
4. **GraphQL 一定比 REST 好吗？**——不一定。GraphQL 灵活但学习成本高（团队要懂 Schema/Resolver/DataLoader），且 N+1 问题需要额外处理。REST 简单固定，适合接口稳定、字段需求明确的场景。京东大部分 BFF 用 REST，只有推荐详情页（字段需求多变）用 GraphQL。

## 结构化回答

**30 秒电梯演讲：** BFF（Backend for Frontend）本质是为每种客户端定制一个后端——App、小程序、Web 各有自己的 BFF，BFF 负责聚合下游 N 个微服务的 API、裁剪字段、适配端侧格式。核心价值是端侧只发一个请求拿到首屏所有数据，避免移动端为渲染一个首页发 10 次 HTTP 请求（每次 RTT 100-300ms）

**展开框架：**
1. **BFF 的三种聚合** — 字段裁剪（去掉端侧不需要的）、多源合并（商品+库存+价格合成视图）、协议适配（REST 转 GraphQL）
2. **并行聚合用 Comple** — 并行聚合用 CompletableFuture/Reactor，串行依赖用 thenCompose
3. **BFF 是薄层** — 不含业务逻辑，只做编排和适配

**收尾：** 以上是我的整体思路。您想继续深入聊——BFF 该用 Node.js 还是 Java？


## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：BFF、API 聚合与前后端协作 | "这题核心是——BFF（Backend for Frontend）本质是为每种客户端定制一个后端——App、小程……" | 开场钩子 |
| 0:15 | 像旅行社的全包服务类比图 | "打个比方：像旅行社的全包服务。" | 核心类比 |
| 0:40 | BFF 的三种聚合示意/对比图 | "字段裁剪（去掉端侧不需要的）、多源合并（商品+库存+价格合成视图）、协议适配（REST 转 GraphQL）" | BFF 的三种聚合要点 |
| 1:05 | 并行聚合用 Comple示意/对比图 | "并行聚合用 CompletableFuture/Reactor，串行依赖用 thenCompose" | 并行聚合用 Comple要点 |
| 1:55 | 总结卡 | "记住：BFF = 为每种端定制的后。下期见。" | 收尾 |
