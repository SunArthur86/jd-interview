---
id: java-architect-072
difficulty: L2
category: java-architect
subcategory: 网关设计
tags:
- Java 架构师
- GraphQL
- REST
- gRPC
feynman:
  essence: 三种 API 风格本质是"协议描述能力 vs 传输效率 vs 生态成熟度"的三角取舍。REST 用 HTTP 语义（动词+资源+状态码）换取最大生态和可缓存性；gRPC 用 HTTP/2 + Protobuf 二进制换取低带宽低延迟、强类型契约和双向流；GraphQL 用"客户端声明所需字段"换取"一次往返拿到聚合数据"，代价是服务端解析和 N+1 风险。
  analogy: REST 像去超市按货架（资源 URL）一件件取货；gRPC 像工厂流水线用标准料箱（Protobuf）高速传送；GraphQL 像点一份定制套餐，告诉后厨"只要这些字段"后厨一次配齐送来。
  first_principle: API 是消费方和生产方之间的契约。契约的"描述粒度"决定灵活度（GraphQL 字段级 > REST 资源级 > gRPC 方法级），"传输编码"决定效率（Protobuf 二进制 > JSON 文本），"生态广度"决定接入成本（HTTP/REST 最高）。选型本质是回答：调用方是浏览器/移动端/内部服务？数据形态是聚合读还是简单 CRUD？对延迟和带宽有多敏感？
  key_points:
  - REST：HTTP/1.1 + JSON，资源导向，生态最广，可缓存，适合对外 BFF 和开放平台
  - gRPC：HTTP/2 + Protobuf，强类型 IDL 契约，双向流，适合内部服务间高性能调用
  - GraphQL：单端点 + 客户端声明字段，聚合查询，适合多端（Web/App/小程序）数据聚合
  - 三者常共存：对外 REST/GraphQL（BFF 聚合），对内 gRPC（服务间）
  - gRPC 在网关层做 HTTP→gRPC 协议转换，让前端用 REST 调用，后端用 gRPC 通信
first_principle:
  problem: 一个 API 平台要同时服务浏览器、移动 App、内部微服务三类调用方，单一协议无法同时满足"易接入、高性能、灵活聚合"，如何设计协议组合？
  axioms:
  - 外部调用方要求"易接入、文档友好、跨语言"，内部调用方要求"低延迟、强类型、低带宽"
  - 数据聚合（一个页面要 N 个资源）用多次 REST 往返效率低
  - 强类型契约（IDL）能消除客户端/服务端字段拼写错误，降低联调成本
  rebuild: 分层协议组合——对外暴露 REST/GraphQL 网关（BFF），由 BFF 聚合下游；对内服务间用 gRPC（Protobuf IDL 契约 + HTTP/2 多路复用）。前端多变数据用 GraphQL（按需取字段），简单 CRUD 用 REST。gRPC-Gateway 或 grpc-web 做协议桥接。三种协议都通过同一个网关统一鉴权限流可观测。
follow_up:
  - gRPC 为什么比 REST 快？——HTTP/2 多路复用（一个 TCP 多请求）+ Protobuf 二进制（比 JSON 小 30-50%、解析快 5-10 倍）+ 头部压缩 HPACK。但浏览器原生不支持 gRPC，需 grpc-web 或网关转 HTTP
  - GraphQL 的 N+1 问题怎么解？——一个查询触发 N 个关联查询（如查订单列表再逐个查用户）。解法是 DataLoader：按批次合并查询（收集 N 个 userId 后一次 batch 查 DB）
  - "REST 怎么做版本兼容？——URI 版本（/v1/）、Header 版本（Accept: application/vnd.api+json;version=1）、或字段级 deprecation。生产用 URI 版本最直观，但 Header 版本更 RESTful"
  - gRPC 的 .proto 变更怎么保证兼容？——遵循"只加字段不改字段编号、不删字段（用 reserved）、字段类型兼容（int32→int64）"。破坏性变更用新 service 或新包名
  - GraphQL 怎么限流？——不能按请求次数（一个查询可能查 1 个字段也可能 100 个）。按"查询复杂度"（每个字段算 1 分，嵌套算倍数）限流，超阈值拒绝
memory_points:
  - 对外 REST/GraphQL（BFF 聚合），对内 gRPC（高性能服务间调用）
  - gRPC 三快：HTTP/2 多路复用、Protobuf 二进制、HPACK 头压缩
  - GraphQL 三坑：N+1（用 DataLoader）、查询复杂度限流、缓存难（POST 单端点）
  - Protobuf 兼容性：只加字段不改编号、用 reserved 标记删除字段
  - 浏览器调 gRPC 要 grpc-web 或网关转 HTTP
---

# 【Java 后端架构师】GraphQL、REST、gRPC 如何选型

> 适用场景：JD 核心技术。商品详情页一个接口要聚合商品、价格、库存、评价、推荐 5 个服务的数据；交易链路服务间调用要求毫秒级延迟；开放平台要给外部商家提供标准化 API。架构师必须能根据调用方、数据形态、性能要求选对协议，并设计协议组合和网关转换。

## 一、概念层：三种协议的本质差异

**对比表**（面试必背，逐行能解释）：

| 维度 | REST | gRPC | GraphQL |
|------|------|------|---------|
| **传输** | HTTP/1.1（也可 HTTP/2） | HTTP/2 | HTTP（通常 POST 单端点） |
| **编码** | JSON（文本） | Protobuf（二进制） | JSON |
| **契约** | OpenAPI/Swagger（可选） | .proto IDL（强类型，编译期校验） | Schema（强类型） |
| **调用模型** | 请求-响应 | 一元 + 服务端流 + 客户端流 + 双向流 | 请求-响应（查询/变更）+ 订阅 |
| **数据粒度** | 服务端定义返回结构 | 服务端定义返回结构 | 客户端声明所需字段（按需取） |
| **性能** | 中（JSON 解析 + HTTP/1.1 头部） | 高（二进制 + HTTP/2 多路复用） | 中低（解析查询 + 聚合开销） |
| **缓存** | HTTP 缓存（ETag/Cache-Control）原生支持 | 难（HTTP/2 + POST） | 难（POST 单端点，需 Apollo Cache） |
| **浏览器** | 原生支持 | 需 grpc-web | 原生支持 |
| **生态** | 最广（所有语言/框架） | 中（Google 主推） | 中（Apollo/GraphQL Java） |
| **典型场景** | 对外 API、BFF、开放平台 | 内部服务间、低延迟链路 | 多端数据聚合、灵活查询 |

**选型决策树**：

```
调用方是谁？
├── 外部（浏览器/移动端/第三方）→ REST 或 GraphQL
│   ├── 数据聚合强（一个页面 N 个资源）→ GraphQL
│   └── 简单 CRUD、要可缓存 → REST
└── 内部（服务间调用）→ gRPC
    ├── 低延迟、高吞吐、强类型 → gRPC
    └── 需要流式（日志/监控推送）→ gRPC 双向流
```

**JD 风格的协议组合**（真实架构）：

```
浏览器/App/小程序
      │  REST（/api/v1/product/123）或 GraphQL（/graphql 单端点）
      ▼
┌─────────────┐
│  BFF 网关    │  聚合下游、协议转换、鉴权限流
└──────┬──────┘
       │  gRPC（HTTP/2 + Protobuf）
       ▼
商品服务 / 价格服务 / 库存服务 / 评价服务 / 推荐服务
       │  gRPC
       ▼
   MySQL / Redis
```

## 二、机制层：gRPC 的性能优势从哪来

**gRPC 四大性能支柱**（面试官会追问"为什么快"）：

```
1. HTTP/2 多路复用
   一个 TCP 连接并发 N 个请求（HTTP/1.1 要排队或开多连接）
   ↓ 减少 TCP 握手和队头阻塞

2. Protobuf 二进制编码
   字段用编号（tag）而非名字，类型固定长度
   ↓ 体积比 JSON 小 30-50%，解析快 5-10 倍

3. HPACK 头部压缩
   静态表 + 动态表，重复头部（如 Content-Type）只传索引
   ↓ 头部从 KB 降到几十字节

4. 强类型 IDL（.proto）
   编译期生成客户端/服务端 stub，字段拼写错误编译就报错
   ↓ 联调成本降低，运行期少反射
```

**Protobuf vs JSON 编码对比**（真实字节）：

```protobuf
// .proto 定义
message Product {
  int64 id = 1;          // 字段编号 1
  string name = 2;       // 字段编号 2
  int32 price = 3;       // 字段编号 3
}
// 实例：id=123, name="手机", price=9999
// Protobuf 编码（二进制）：
//   08 7B 12 06 E6 89 8B E6 9C BA 18 8F 4E
//   （约 13 字节）
// JSON 编码（文本）：
//   {"id":123,"name":"手机","price":9999}
//   （约 35 字节，字段名占大头）
```

**Protobuf 字段兼容性规则**（生产必背）：

```
向后兼容（旧客户端能读新服务）：
  ✓ 新增字段（旧客户端忽略未知字段）
  ✓ 字段类型扩展（int32 → int64）
  ✗ 删除字段（改用 reserved 占位，不能复用编号）
  ✗ 修改字段编号（破坏二进制布局）

破坏性变更：用新 service 或新包名（package v2）
```

**gRPC 流式调用四种模式**：

```java
// 1. 一元调用（Unary）——最常用，类似 REST
Product product = stub.getProduct(GetProductRequest.newBuilder().setId(123L).build());

// 2. 服务端流（Server Streaming）——推送、大结果集分批
Iterator<Order> orders = stub.streamOrders(request);  // 服务端分批发
while (orders.hasNext()) { process(orders.next()); }

// 3. 客户端流（Client Streaming）——批量上传
StreamObserver<UploadChunk> requestObserver = stub.uploadChunks(responseObserver);
requestObserver.onNext(chunk1);
requestObserver.onNext(chunk2);
requestObserver.onCompleted();

// 4. 双向流（Bidirectional Streaming）——聊天、实时同步
StreamObserver<ChatMessage> chat = stub.chat(new StreamObserver<>() {
    @Override public void onNext(ChatMessage msg) { display(msg); }
    // ...
});
chat.onNext(myMessage);
```

## 三、机制层：GraphQL 的按需取字段与 N+1

**GraphQL 查询示例**（前端声明所需字段）：

```graphql
# 前端只要这些字段，后端必须返回这些字段（不多不少）
query ProductDetail($id: ID!) {
  product(id: $id) {
    id
    name
    price
    inventory {
      available     # 只取库存可用量，不取仓库地址
    }
    reviews(first: 3) {
      content
      rating
      user { name }   # 嵌套查询用户名
    }
  }
}
```

**N+1 问题与 DataLoader 解法**（GraphQL 最大坑）：

```java
// 问题：查询 10 个订单，每个订单要查用户名
// 坏实现：触发 1（订单）+ 10（用户）= 11 次 DB 查询

// 用 DataLoader 批量合并
@Bean
public BatchLoader<Long, User> userBatchLoader() {
    return userIds -> {
        // 收集所有 userId 后一次 batch 查询
        return CompletableFuture.supplyAsync(() ->
            userService.findByIds(userIds));  // 1 次 IN 查询
    };
}

// 在 DataFetcher 中使用 DataLoader
@DataFetcher
public CompletableFuture<User> user(Order order, DataLoaderRegistry registry) {
    DataLoader<Long, User> loader = registry.getDataLoader("userLoader");
    return loader.load(order.getUserId());  // 异步，自动 batch
}
// 结果：1（订单）+ 1（用户 batch）= 2 次查询
```

**GraphQL 查询复杂度限流**（不能按请求次数限流）：

```java
// 每个字段算复杂度分，超阈值拒绝
@Component
public class ComplexityCalculator {
    public int calculate(Document query) {
        // 基础字段 1 分，嵌套 ×2，列表 ×first 参数
        // reviews(first: 3) { user { name } } = 3 × 2 = 6 分
        int complexity = analyze(query);
        if (complexity > MAX_COMPLEXITY) {  // 如 1000 分
            throw new GraphQLException("query too complex: " + complexity);
        }
    }
}
```

## 四、实战层：协议组合与网关转换

**生产架构：gRPC 内部 + REST 对外**（gRPC-Gateway 方案）：

```protobuf
// product.proto 同时定义 gRPC 和 REST 映射
syntax = "proto3";
package product.v1;

import "google/api/annotations.proto";

service ProductService {
  rpc GetProduct(GetProductRequest) returns (Product) {
    option (google.api.http) = {
      get: "/api/v1/products/{id}"   // REST 路径映射
    };
  }
  rpc CreateProduct(CreateProductRequest) returns (Product) {
    option (google.api.http) = {
      post: "/api/v1/products"
      body: "*"
    };
  }
}
// protoc 生成 gRPC stub + HTTP handler（gRPC-Gateway）
// 网关层：前端发 HTTP，Gateway 转 gRPC 调后端
```

**Spring Boot 集成 gRPC**（服务端）：

```java
@GrpcService                    // grpc-spring-boot-starter
public class ProductGrpcService extends ProductServiceGrpc.ProductServiceImplBase {

    @Autowired private ProductRepository repo;

    @Override
    public void getProduct(GetProductRequest req, StreamObserver<Product> responseObserver) {
        Product product = repo.findById(req.getId())
            .orElseThrow(() -> Status.NOT_FOUND.withDescription("product not found").asRuntimeException());
        responseObserver.onNext(product);
        responseObserver.onCompleted();
    }
}

// application.yml
grpc:
  server:
    port: 9090
  client:
    GLOBAL:
      negotiation-type: plaintext
      max-inbound-message-size: 4MB
```

**gRPC 客户端调用 + 拦截器**（鉴权、trace、超时）：

```java
ManagedChannel channel = ManagedChannelBuilder.forAddress("product-svc", 9090)
    .usePlaintext()
    .keepAliveTime(30, TimeUnit.SECONDS)
    .build();

ProductServiceGrpc.ProductServiceBlockingStub stub = ProductServiceGrpc.newBlockingStub(channel)
    .withCallCredentials(JwtCallCredentials.from(token))     // 鉴权拦截器
    .withDeadlineAfter(500, TimeUnit.MILLISECONDS)           // 超时
    .withInterceptor(new TraceClientInterceptor());          // trace 注入

Product product = stub.getProduct(GetProductRequest.newBuilder().setId(123L).build());
```

**性能实测对比**（同环境，单实例）：

```
接口：查询商品（id, name, price）
数据量：100 字节
并发：1000 QPS

REST (HTTP/1.1 + JSON):
  平均延迟：8ms，P99：25ms，带宽：120 KB/s

gRPC (HTTP/2 + Protobuf):
  平均延迟：3ms，P99：10ms，带宽：45 KB/s

结论：gRPC 延迟低 60%，带宽省 60%（JD 内部服务间首选）
```

## 五、底层本质：契约描述力 vs 传输效率的权衡

回到第一性：**API 是契约，契约的核心矛盾是"描述灵活度"和"传输效率"**。

- **REST 选择 HTTP 语义最大化生态**：用标准动词（GET/POST/PUT/DELETE）和状态码，任何 HTTP 客户端都能调。代价是 JSON 文本编码效率低、HTTP/1.1 队头阻塞、契约弱（OpenAPI 是后补的，编译期不校验）。REST 的本质是"用效率换生态"。
- **gRPC 选择二进制 + HTTP/2 最大化效率**：Protobuf 字段用编号编码（比 JSON 字段名短），HTTP/2 多路复用（一个 TCP 并发多请求），强类型 IDL 编译期校验。代价是浏览器不支持（需 grpc-web 或网关转换）、调试不直观（抓包看二进制）、生态不如 REST。gRPC 的本质是"用生态换效率"。
- **GraphQL 选择客户端声明字段最大化灵活度**：前端按需取字段（一个接口拿聚合数据），解决移动端多次往返浪费流量问题。代价是服务端解析查询开销、N+1 问题、缓存难（POST 单端点无法用 HTTP 缓存）。GraphQL 的本质是"把数据组装权交给前端，代价是服务端复杂度上升"。

**为什么内部用 gRPC 而对外用 REST**：内部调用方是可控的服务（语言一致、可强制用 stub、网络稳定），适合用 gRPC 榨干性能。对外调用方是浏览器/第三方（语言多样、网络不可控、要可缓存），必须用 REST/HTTP。BFF 网关做协议转换，让前端调 REST，后端调 gRPC。

**GraphQL 适合的场景**：多端（Web/App/小程序）数据需求差异大（App 只要核心字段省流量，Web 要全字段）。一个商品详情页 REST 要调 5 个接口，GraphQL 一次查询搞定。代价是后端要建 DataLoader 防 N+1、做复杂度限流防恶意查询。

## 六、AI 架构师加问：5 个

1. **AI 推理服务对外暴露用哪种协议？**
   内部推理用 gRPC（Triton/vLLM 原生支持 gRPC，低延迟）；对外用 REST（兼容 OpenAI API 格式）；流式输出用 SSE（Server-Sent Events，HTTP 长连接）或 gRPC 服务端流。LangChain/OpenAI SDK 都基于 REST + SSE。

2. **GraphQL 怎么配合 AI Agent 的工具调用？**
   AI Agent 的工具用 REST 或 gRPC 暴露（强类型 schema 便于 AI 理解参数），GraphQL 不适合工具调用（查询语言太灵活，AI 难以稳定生成）。Function Calling 用 JSON Schema 描述工具参数，与 OpenAPI/Protobuf 可互转。

3. **gRPC 的 Protobuf 能不能直接喂给 AI 做契约校验？**
   能。把 .proto 或生成的 JSON Schema 作为 AI 的上下文，让 AI 检查代码是否符合契约、生成符合契约的调用代码。但 AI 生成 Protobuf 要做编译期校验（protoc），不能只信 AI 输出。

4. **让 AI 自动生成 GraphQL 查询，风险在哪？**
   AI 可能生成超复杂查询（嵌套太深）打爆 DB。必须做查询复杂度分析 + 深度限制 + 字段级权限校验。AI 生成的查询要走和用户查询一样的限流和权限链路。

5. **AI 微服务之间用 gRPC 还是 REST？**
   推理、embedding、向量检索等高频内部调用用 gRPC（低延迟、Protobuf 传 tensor 高效）；模型管理、配置等低频管理用 REST。大模型流式输出用 gRPC 双向流或 HTTP SSE。

## 七、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"对外 REST/GraphQL，对内 gRPC，三协议同一网关"**。

- **REST**：HTTP+JSON，生态最广，对外 BFF、开放平台，可缓存
- **gRPC**：HTTP/2+Protobuf，内部高性能，强类型契约，四快（多路复用/二进制/HPACK/IDL）
- **GraphQL**：单端点按需取字段，多端聚合，坑是 N+1（DataLoader 解）+ 复杂度限流
- **组合**：gRPC-Gateway 做 HTTP→gRPC 转换，前端调 REST，后端调 gRPC
- **Protobuf 兼容**：只加字段不改编号，删除用 reserved

### 拟人化理解

把 API 协议想成**快递服务**。REST 是普通快递（谁都能寄，包装标准化，但慢且占地方）；gRPC 是工业物流（标准料箱 Protobuf，流水线传送带 HTTP/2，快但只给签约客户）；GraphQL 是按需点餐（你说要什么字段，后厨一次配齐，但后厨要忙不过来时用 DataLoader 批量做）。

### 面试现场 60 秒回答

> 选型核心是看调用方和数据形态。对外（浏览器/移动端/第三方）用 REST 或 GraphQL——REST 适合简单 CRUD 和可缓存场景，GraphQL 适合多端数据聚合（一个页面要 N 个资源，前端按需取字段）。对内服务间用 gRPC——HTTP/2 多路复用 + Protobuf 二进制 + HPACK 头压缩，延迟比 REST 低 60%，还有强类型 IDL 契约编译期校验。生产架构是分层组合：BFF 网关对外暴露 REST/GraphQL，对内用 gRPC 调下游服务，gRPC-Gateway 做协议转换。GraphQL 最大的坑是 N+1 问题，用 DataLoader 批量合并查询解决；还要做查询复杂度限流防恶意查询。Protobuf 变更遵循只加字段不改编号保证向后兼容。

### 反问面试官

> 贵司内部服务间是 REST 还是 gRPC？前端和后端的协议怎么对接（BFF 聚合还是直连）？有没有用 GraphQL？这决定我聊协议转换和聚合层的深度。

## 八、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不全部用 REST，要引入 gRPC？ | 用延迟和带宽数据说话：内部调用 REST 平均 8ms，gRPC 3ms，P99 差 2.5 倍；带宽省 60%。高 QPS 链路（交易核心调用 50+ 服务）累计延迟差几百毫秒，影响 SLA |
| 证据追问 | 你怎么证明 gRPC 真的比 REST 快？ | 同等环境压测对比：wrk/ghz 压 REST 和 gRPC，对比 QPS、P99、CPU、带宽。线上灰度：一个服务切 gRPC，对比调用耗时分布（rpc_client_duration_seconds） |
| 边界追问 | gRPC 能完全替代 REST 吗？ | 不能。浏览器原生不支持（需 grpc-web）、调试不直观（抓包是二进制）、第三方系统对接（开放平台）必须 REST、需要 HTTP 缓存的场景 REST 更合适 |
| 反例追问 | 什么场景不该用 GraphQL？ | 简单 CRUD（REST 更直观）、强缓存场景（GraphQL POST 无法 HTTP 缓存）、团队无 GraphQL 运维能力（DataFetcher/复杂度治理复杂）、超低延迟（查询解析有开销） |
| 风险追问 | gRPC 上线最大风险？ | 主动点出：.proto 不兼容变更导致线上调用失败（改了字段编号）、HTTP/2 连接耗尽（keep-alive 配置不当）、浏览器不支持（前端用 grpc-web 但兼容性有限）、gRPC 拦截器漏配导致鉴权失效 |
| 验证追问 | 协议迁移怎么验证？ | 灰度切流：先影子流量（复制请求到 gRPC 不返回），对比结果 diff；再 1% 灰度看 rpc_error_rate、rpc_p99；全量后看 rpc_throughput 是否提升。指标：grpc_server_handled_total、grpc_server_msg_received_total |
| 沉淀追问 | 团队协议规范沉淀什么？ | .proto 命名规范（包名 v1/v2、字段命名）、API 设计规范（RESTful 或 RPC 风格）、gRPC 拦截器模板（鉴权/trace/超时/重试）、gRPC-Gateway 配置模板、契约测试（Pact/grpcurl） |

### 现场对话示例

**面试官**：你说 gRPC 比 REST 快，具体快在哪？

**候选人**：三个层面。第一，传输层 gRPC 用 HTTP/2 多路复用，一个 TCP 连接并发多个请求，REST 在 HTTP/1.1 要开多个连接或排队。第二，编码层 Protobuf 是二进制，字段用编号不用名字（JSON 的 "productId":123 在 Protobuf 是 tag+value 几个字节），体积小 30-50%，解析不用字符串匹配快 5-10 倍。第三，头压缩 HPACK，重复的 Content-Type 等头部只传索引。实测同接口 gRPC 延迟低 60%、带宽省 60%。但代价是浏览器不支持、调试要抓包看二进制、生态不如 REST。所以内部用 gRPC，对外用 REST。

**面试官**：GraphQL 的 N+1 怎么彻底解决？

**候选人**：N+1 的根因是 DataFetcher 逐条查询。比如查 10 个订单的用户名，默认触发 1+10 次 DB 查询。解法是 DataLoader——它收集同一 tick 内所有 load 调用，批量合并成一次 IN 查询。`loader.load(userId)` 返回 CompletableFuture，DataFetcher 不阻塞，等 batch 完成后统一返回。关键是 DataLoader 的 dispatchTiming，要在请求结束时触发。还能加缓存（同一 userId 同请求内只查一次）。生产上还要监控 batch_size 分布，太小（接近 1）说明 batch 没生效，太大可能压 DB。

**面试官**：gRPC 的 .proto 变更怎么保证不挂线上？

**候选人**：遵循 Protobuf 兼容性规则。第一，只加字段不改编号——新增字段用新编号，旧客户端收到未知字段忽略（向后兼容）。第二，不删字段——要"删"用 reserved 标记编号，防止后续复用。第三，类型兼容——int32 能安全扩成 int64，但 string 不能改成 int。破坏性变更（改字段编号、改字段类型到不兼容类型）必须用新包名（package v2）或新 service，灰度迁移。上线前用 buf breaking 做兼容性检查（对比当前 .proto 和上一个版本的兼容性），CI 里强制跑。

## 常见考点

1. **gRPC 和 REST 区别？**——gRPC 用 HTTP/2 + Protobuf（二进制、多路复用、头压缩、强类型 IDL），延迟低、带宽省、契约强；REST 用 HTTP/1.1 + JSON，生态广、可缓存、易调试。内部用 gRPC，对外用 REST。
2. **GraphQL 解决什么问题？**——多端数据聚合（前端按需取字段，一个接口拿 N 个资源数据，避免多次往返）。代价是 N+1（DataLoader 解）、查询复杂度限流、缓存难。
3. **Protobuf 怎么保证兼容？**——只加字段不改编号、删除用 reserved、类型兼容扩展（int32→int64）。破坏性变更新包名。用 buf breaking 做 CI 兼容性检查。
4. **gRPC 浏览器怎么调？**——用 grpc-web（代理模式或 envoy 转发），或网关层用 gRPC-Gateway 转 HTTP。grpc-web 不支持所有流式模式。
5. **三种协议怎么共存？**——分层：BFF 网关对外 REST/GraphQL，对内 gRPC。网关做协议转换（gRPC-Gateway 的 google.api.http 注解）。三种协议共享同一套鉴权/限流/可观测基础设施。

## 结构化回答

**30 秒电梯演讲：** 三种 API 风格本质是协议描述能力 vs 传输效率 vs 生态成熟度的三角取舍。REST 用 HTTP 语义（动词+资源+状态码）换取最大生态和可缓存性；gRPC 用 HTTP/2 + Protobuf 二进制换取低带宽低延迟、强类型契约和双向流；GraphQL 用客户端声明所需字段换取一次往返拿到聚合数据，代价是服务端解析和 N+1 风险

**展开框架：**
1. **REST** — HTTP/1.1 + JSON，资源导向，生态最广，可缓存，适合对外 BFF 和开放平台
2. **gRPC** — HTTP/2 + Protobuf，强类型 IDL 契约，双向流，适合内部服务间高性能调用
3. **GraphQL** — 单端点 + 客户端声明字段，聚合查询，适合多端（Web/App/小程序）数据聚合

**收尾：** 以上是我的整体思路。您想继续深入聊——gRPC 为什么比 REST 快？


## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：GraphQL、REST、gRPC 如何选型 | "这题一句话：三种 API 风格本质是协议描述能力 vs 传输效率 vs 生态成熟度的三角取舍。" | 开场钩子 |
| 0:15 | REST示意/对比图 | "HTTP/1.1 + JSON，资源导向，生态最广，可缓存，适合对外 BFF 和开放平台" | REST要点 |
| 0:40 | gRPC示意/对比图 | "HTTP/2 + Protobuf，强类型 IDL 契约，双向流，适合内部服务间高性能调用" | gRPC要点 |
| 1:25 | 总结卡 | "记住：对外 REST/GraphQ。下期见。" | 收尾 |
