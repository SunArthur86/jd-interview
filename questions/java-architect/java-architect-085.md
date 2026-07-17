---
id: java-architect-085
difficulty: L4
category: java-architect
subcategory: 系统解耦
tags:
- Java 架构师
- 接口
- 版本化
- 契约测试
feynman:
  essence: 接口兼容性的本质是"在不停止演进的前提下，保证已发布的接口对调用方永远可用"。核心机制是"契约（Schema/语义）+ 版本化（v1/v2 并存）+ 契约测试（Pact 验证消费方期望）"。难点是兼容性分类（向后/向前/完全兼容）的边界、何时该出 v2、如何自动检测破坏性变更。
  analogy: 像手机操作系统升级。旧 App（已发布接口的调用方）必须在新系统（新版服务）上能跑（向后兼容）。新系统不能悄悄删功能（删除字段=破坏性）。新 App 可以用旧系统没有的功能（降级）。系统升级前先跑兼容性测试（契约测试），确保所有 App 不崩。
  first_principle: 服务演进的根本矛盾是"业务要变（加字段、改逻辑）vs 调用方要稳（已上线代码不能改）"。解法是语义化版本（SemVer）+ 兼容性规则——加字段是向后兼容（老调用方忽略新字段），删字段或改语义是破坏性（必须出 v2）。契约测试（Pact）从消费方视角验证：消费方定义期望（请求/响应样例），提供方跑测试确保满足所有消费方的期望，CI 里卡破坏性变更。
  key_points:
  - 兼容性三分类：向后兼容（Backward，老调用方调新服务）、向前兼容（Forward，新调用方调老服务）、完全兼容（两者都满足）
  - 破坏性变更：删字段、改字段类型、改字段语义、改必填性（可选→必填）、收紧校验
  - 非破坏性变更：加可选字段、加新接口、放宽校验、加可选请求参数
  - "版本化策略：URL 版本（/v1/v2）、Header 版本（Accept: application/vnd.foo.v2+json）、协议版本（proto package）"
  - 契约测试：Pact（消费方驱动），CDC 验证提供方满足所有消费方期望
  - API 演进工具：OpenAPI diff、protobuf buf breaking 检测
first_principle:
  problem: 订单服务有 50 个调用方（App、Web、内部服务），每次改接口都可能让某个调用方挂。如何安全演进接口？
  axioms:
  - 已上线的调用方代码不能被强制修改（移动端 App 发版周期 1-2 周）
  - 业务持续演进（加字段、改逻辑不可避免）
  - 破坏性变更（删字段、改语义）必须被检测和阻止
  rebuild: 四层防御——第一，兼容性规则（加字段 OK，删字段/改类型/改必填是破坏性，必须出 v2 并存）。第二，版本化（URL /v1/v2 并存，老版本至少维护 6 个月给调用方迁移）。第三，契约测试（Pact CDC，每个消费方定义期望，提供方 CI 跑测试确保满足，破坏性变更直接卡 CI）。第四，自动化检测（OpenAPI diff 或 protobuf buf breaking，PR 阶段自动标注破坏性变更）。四层组合，接口演进安全可控。
follow_up:
  - 什么时候该出 v2 而不是在 v1 演进？——当变更破坏性且无法兼容（如改核心语义、重构数据模型），或 v1 包袱太重（历史错误决策）无法平滑演进。v2 与 v1 并存，老调用方用 v1，新调用方用 v2，给迁移期（6 个月+）
  - Pact 契约测试和单元测试区别？——单元测试测"提供方自己的逻辑对不对"，Pact 测"提供方是否满足消费方的期望"。消费方定义"我调 /v1/orders 期望返回 {id, amount}"，提供方跑这个 Pact 测试，确保不会删 id 或 amount 字段（删了就违反契约，CI 失败）
  - 移动端 App 怎么做兼容？——App 发版慢（1-2 周审核 + 用户升级率），所以移动端的接口必须严格向后兼容。加字段 OK，删字段/改语义要等所有版本 App 都升级（或占比 <1%）才删。用强制升级兜底（极老版本强制升级）
  - gRPC 的兼容性怎么保证？——protobuf 用 buf 工具检测 breaking change（buf breaking --against）。规则：不能删字段、不能改字段编号、不能改字段类型。加字段用新编号即可。proto package 版本化（foo.v1 vs foo.v2）
  - "如何优雅下线老版本接口？——先标记 @Deprecated（文档 + 日志告警 + Header 提示），监控调用量，调用量低于阈值（如 <1%）后下线。给迁移期（至少 6 个月），联系 TOP 调用方推动迁移"
memory_points:
  - 兼容三分类：向后（老调新）、向前（新调老）、完全（两者）
  - 破坏性变更：删字段、改类型、改必填、收紧校验
  - 非破坏性：加可选字段、加接口、放宽校验
  - 版本化：URL /v1/v2 并存，老版本维护 6 个月
  - 契约测试：Pact CDC，消费方定义期望，提供方 CI 验证
  - 自动检测：OpenAPI diff、protobuf buf breaking
---

# 【Java 后端架构师】接口兼容性、版本化与契约测试

> 适用场景：JD 核心技术。订单服务有 50 个调用方（App、Web、内部服务），每次改接口都可能让某个调用方挂。架构师必须设计兼容性规则、版本化策略、契约测试，让接口安全演进。

## 一、概念层：兼容性分类与演进规则

**兼容性三分类**（面试必答）：

| 类型 | 定义 | 例子 | 难度 |
|------|------|------|------|
| 向后兼容（Backward） | 老调用方能调新服务（新版服务不破坏老调用方） | 新服务加了字段，老调用方忽略新字段正常解析 | 常见，易实现 |
| 向前兼容（Forward） | 新调用方能调老服务（老服务对新调用方不报错） | 新调用方发了老服务不认识的字段，老服务忽略不报错 | 需设计（宽松反序列化） |
| 完全兼容（Full） | 向后 + 向前都兼容 | 加可选字段、加可选请求参数 | 理想状态 |

**变更分类矩阵**（什么改动安全，什么必须出 v2）：

| 变更类型 | 例子 | 兼容性 | 处理方式 |
|---------|------|-------|---------|
| 加可选响应字段 | response 加 `couponAmount`（可选） | 向后兼容 | v1 内演进，OK |
| 加可选请求字段 | request 加 `couponId`（可选） | 完全兼容 | v1 内演进，OK |
| 加新接口 | 新增 `/v1/orders/refund` | 完全兼容 | v1 内演进，OK |
| 放宽校验 | 必填改可选、长度限制放宽 | 向后兼容 | v1 内演进，OK |
| 删字段 | 删 response 的 `legacyField` | 破坏性 | 出 v2 或渐进下线 |
| 改字段类型 | `amount` 从 int 改 String | 破坏性 | 出 v2 |
| 改字段语义 | `status=1` 从"已支付"改"已发货" | 破坏性 | 出 v2 或加新枚举值 |
| 改必填性 | 可选改必填 | 破坏性 | 出 v2 或渐进 |
| 收紧校验 | 长度限制从 100 改 50 | 破坏性 | 出 v2 或渐进 |
| 改字段编号（protobuf） | field 5 改 field 6 | 破坏性 | 出新 proto package |

## 二、机制层：版本化策略

**三种版本化方式对比**：

| 方式 | 示例 | 优点 | 缺点 | 适用场景 |
|------|------|------|------|---------|
| URL 版本 | `/v1/orders`、`/v2/orders` | 直观、易路由、缓存友好 | 改版本要改 URL | RESTful API（最常用） |
| Header 版本 | `Accept: application/vnd.jd.v2+json` | URL 不变、内容协商 | 不直观、难调试 | 资源稳定的 API |
| 协议版本 | protobuf `package jd.order.v2;` | 协议层内置、类型安全 | 仅适用 gRPC/protobuf | gRPC 微服务 |

**Spring Boot 多版本 URL 实现**：

```java
@RestController
@RequestMapping({"/v1/orders", "/v2/orders"})
public class OrderController {

    // v1 接口（老调用方）
    @GetMapping(value = "/{id}", headers = "X-API-Version=1")
    @Deprecated   // 标记弃用，文档 + 日志告警
    public OrderV1Response getOrderV1(@PathVariable Long id) {
        log.warn("调用已弃用的 v1 接口 orderId={}, caller={}", id, getCaller());
        Order order = orderService.findById(id);
        return OrderV1Response.from(order);   // 不含 couponAmount（v1 没这字段）
    }

    // v2 接口（新调用方，多了 couponAmount）
    @GetMapping(value = "/{id}", headers = "X-API-Version=2")
    public OrderV2Response getOrderV2(@PathVariable Long id) {
        Order order = orderService.findById(id);
        return OrderV2Response.from(order);   // 含 couponAmount
    }

    // 默认走 v1（向后兼容老调用方）
    @GetMapping("/{id}")
    public OrderV1Response getOrderDefault(@PathVariable Long id) {
        return getOrderV1(id);
    }
}
```

**gRPC protobuf 版本化**（proto package）：

```protobuf
// v1 proto（老调用方，package v1）
syntax = "proto3";
package jd.order.v1;

service OrderService {
    rpc GetOrder (GetOrderRequest) returns (OrderResponse);
}

message OrderResponse {
    int64 id = 1;
    int64 amount = 2;       // 单位：分
    int32 status = 3;
    // 不能删字段，加字段用新编号
}

// v2 proto（新调用方，package v2）
syntax = "proto3";
package jd.order.v2;

service OrderService {
    rpc GetOrder (GetOrderRequest) returns (OrderResponse);
}

message OrderResponse {
    int64 id = 1;
    string amount = 2;      // 改类型：分 → 字符串（避免精度问题）
    int32 status = 3;
    int64 coupon_amount = 4;   // 新增字段用新编号
    string currency = 5;       // 新增
}
```

## 三、机制层：契约测试（Pact CDC）

**契约测试流程**（消费方驱动 Contract Driven）：

```
消费方 A（App）          消费方 B（Web）          提供方（订单服务）
     │                       │                        │
     │ 1.定义期望             │ 1.定义期望              │
     │ (请求+响应样例)        │ (请求+响应样例)         │
     │                       │                        │
     │ 2.生成 Pact 文件      │ 2.生成 Pact 文件       │
     │ (JSON 契约)           │ (JSON 契约)            │
     │                       │                        │
     │ 3.推送到 Pact Broker  │ 3.推送到 Pact Broker   │
     │───────────────────────────────────────────────>│
     │                       │                        │
     │                       │  4.CI 拉 Pact 文件     │
     │                       │  5.对提供方跑测试      │
     │                       │  (验证满足所有消费方期望)│
     │                       │  6.破坏性变更 CI 失败   │
```

**消费方定义 Pact 契约**（App 端 Java 代码）：

```java
// 消费方（App）定义对订单服务的期望
@PactTestFor(providerName = "order-service", port = "8080")
public class OrderServicePactTest {

    @Pact(consumer = "mobile-app")
    public RequestResponsePact getOrderPact(PactDslWithProvider builder) {
        return builder
            .given("订单 123 存在")    // 提供方设置测试数据
            .uponReceiving("查询订单")
                .path("/v1/orders/123")
                .method("GET")
                .headers("X-API-Version", "1")
            .willRespondWith()
                .status(200)
                .body(new PactDslJsonBody()
                    .integerType("id", 123)            // 必须有 id
                    .integerType("amount", 9900)       // 必须有 amount
                    .integerType("status")             // 必须有 status（值任意）
                    // 注意：不定义 couponAmount，因为 App 不关心这字段
                    // 即使提供方加了 couponAmount，App 的 Pact 也能通过
                )
            .toPact();
    }

    @Test
    @PactTestFor
    void testGetOrder(MockServer mockServer) {
        // 消费方用 MockServer 测试自己的调用逻辑
        OrderClient client = new OrderClient(mockServer.getUrl());
        Order order = client.findById(123L);
        assertNotNull(order.getId());
        assertNotNull(order.getAmount());
    }
}
```

**提供方验证 Pact 契约**（订单服务 CI 跑测试）：

```java
// 提供方（订单服务）验证满足所有消费方的期望
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ProviderTest(value = "order-service", pactVerification = true)
public class OrderProviderPactTest {

    @LocalServerPort
    private int port;

    @TestTemplate
    @ExtendWith(PactVerificationInvocationContextProvider.class)
    void testPact(PactVerificationContext context) {
        // 设置提供方地址
        context.setTarget(HttpTestTarget.fromPort(new URL("http://localhost"), port));
        // 跑所有消费方的 Pact 验证
        context.verifyInteraction();
    }

    // 提供方设置测试数据（@State 对应 Pact 的 given）
    @State("订单 123 存在")
    public void order123Exists() {
        // 插入测试数据
        orderRepository.save(new Order(123L, 9900, 1));
    }
}
```

**Pact Broker + CI 集成**（破坏性变更自动检测）：

```yaml
# 订单服务的 CI（GitHub Actions）——拉所有消费方 Pact 验证
name: order-service-ci
on: [pull_request]

jobs:
  contract-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: 验证所有消费方契约
        run: |
          # 从 Pact Broker 拉所有消费方的 Pact 文件
          mvn pact:verify \
            -Dpact.broker.url=https://pact-broker.jd.com \
            -Dpact.verifier.publishResults=true

      - name: 检查破坏性变更（can-i-deploy）
        run: |
          # 检查能否安全部署（不破坏任何消费方）
          pact-broker can-i-deploy \
            --pacticipant order-service \
            --version ${{ github.sha }} \
            --to prod
          # 如果有消费方会被破坏，CI 失败，阻止合并
```

## 四、机制层：自动化检测破坏性变更

**OpenAPI diff 检测**（REST API）：

```yaml
# CI 中自动对比 OpenAPI 规范变更
name: api-compatibility-check
on: [pull_request]

jobs:
  openapi-diff:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
        with:
          fetch-depth: 0   # 拉全历史用于对比

      - name: OpenAPI Diff
        run: |
          # 对比 main 分支和当前 PR 的 OpenAPI 文件
          docker run --rm \
            -v $(pwd):/spec openapitools/openapi-diff:latest \
            /spec/main-openapi.yaml \
            /spec/pr-openapi.yaml \
            --markdown diff-report.md

      - name: 检查破坏性变更
        run: |
          if grep -q "API is BROKEN" diff-report.md; then
            echo "检测到破坏性变更！"
            cat diff-report.md
            exit 1   # CI 失败
          fi
          # 检测到破坏性变更的例子：
          # - 删除了响应字段
          # - 改了字段类型（int → string）
          # - 可选改必填
```

**Protobuf buf breaking 检测**（gRPC）：

```bash
# buf 工具检测 protobuf 破坏性变更
buf breaking --against '.git#branch=main'

# 检测规则：
# - FIELD_DELETED：删除了字段（消费方还在用）
# - FIELD_TYPE_CHANGED：改了字段类型
# - FIELD_NUMBER_CHANGED：改了字段编号
# - RPC_DELETED：删除了方法
# - RPC_REQUEST_TYPE_CHANGED：改了请求类型

# 输出示例：
# src/proto/order/v2/order.proto:10:3:
# Previously present field "amount" on message OrderResponse was deleted.
# 输出即 CI 失败，阻止破坏性变更合并
```

## 五、底层本质：为什么接口演进这么难

回到第一性：**接口演进的矛盾是"业务要变 vs 调用方要稳"**。

- **调用方不可控**：移动端 App 发版要审核（1-2 周），用户升级率慢（一个月才 80%）。如果删了 App 依赖的字段，没升级的 App 崩溃。Web 相对可控（部署即生效），但也有缓存（CDN、浏览器缓存）。内部服务可控（能推动改造），但 50 个调用方改造周期长。所以接口演进必须假设"老调用方永远存在"。
- **破坏性变更的危害**：删字段（老调用方反序列化报错）、改类型（int 改 String，老调用方类型不匹配）、改必填（可选改必填，老调用方没传被拒）、改语义（status=1 从"已支付"改"已发货"，老调用方业务逻辑错乱）。这些变更在生产环境会让调用方崩溃，且难以快速回滚（App 发版不可撤回）。
- **版本化的代价**：v1 v2 并存意味着两套代码维护（Controller、Service、DTO）。维护期长（6 个月到几年），技术债累积。所以版本化是"必要之恶"——能用兼容性规则演进就不出 v2。出 v2 的场景：核心语义变更（如改数据模型）、v1 设计错误无法修补、重大架构调整。
- **契约测试的本质**：传统测试（单元/集成）从提供方视角测"我的逻辑对不对"。契约测试从消费方视角测"我期望的响应你还满足吗"。消费方定义期望（我只用 id 和 amount），提供方跑 Pact 验证（确保不删 id 和 amount）。当提供方想删 amount，Pact 失败，CI 卡住——强制提供方要么不删（兼容），要么协调消费方改契约（沟通）后删。契约测试把"破坏性变更检测"自动化。
- **为什么用 Pact 而非 Postman/集成测试**：集成测试要求"提供方和消费方一起跑"（50 个调用方一起跑测试，复杂、慢、易碎）。Pact 解耦——消费方各自定义契约（独立），提供方拉所有契约跑验证（独立）。契约文件存在 Pact Broker，版本化、可追溯。can-i-deploy 检查"这次变更会不会破坏任何消费方"，CI 集成自动化。

**为什么向后兼容容易向前兼容难**：向后兼容（老调新）——新服务加字段，老调用方反序列化时忽略新字段（Jackson 默认行为），简单。向前兼容（新调老）——新调用方发了老服务不认识的字段，老服务必须"忽略未知字段而非报错"（Jackson 配置 FAIL_ON_UNKNOWN_PROPERTIES=false）。默认 Jackson 对未知字段报错（向前不兼容），要配置才兼容。

## 六、AI 架构师加问：5 个

1. **AI 自动检测破坏性变更？**
   能做且有效。AI 分析 API 变更（OpenAPI diff），标注哪些是破坏性。比规则工具（openapi-diff）更准——能识别"语义破坏性"（字段名没变但语义改了，如 status 枚举值含义变）。但修复（怎么兼容）要人工设计。

2. **AI 生成兼容性测试？**
   AI 能根据接口定义生成边界测试（新增字段老调用方能否解析、改类型能否降级）。比手写测试覆盖全。但消费方的真实期望（用哪些字段）要消费方定义，AI 只能猜。

3. **AI 预测接口演进的兼容性影响？**
   AI 分析 50 个调用方的使用日志（调了哪些字段、频率），预测删某字段会影响几个调用方。辅助下线决策（影响 <1% 再下线）。但调用方代码逻辑（字段语义依赖）AI 看不到。

4. **AI Agent 作为接口调用方的兼容性？**
   Agent 调用 API 时自适应——拿到响应动态解析（不依赖固定 schema）。比传统调用方更容错（字段名变了 Agent 能理解）。但 Agent 的输出格式要稳定（给用户的结果不能变）。

5. **大模型 API 的版本化怎么做？**
   LLM API（如 GPT-4）用模型版本（gpt-4-0613、gpt-4-1106）做版本化。老模型版本保留（调用方固定版本号）。新版本可能行为不同（输出风格变），调用方测试后迁移。比传统 API 版本化更粗粒度（整个模型版本而非字段级）。

## 七、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"三分类、三破坏、四防御"**。

- **三分类**：向后兼容（老调新）、向前兼容（新调老）、完全兼容（两者）
- **三破坏**：删字段、改类型、改必填（必须出 v2）
- **四防御**：兼容性规则 → 版本化（v1/v2 并存）→ 契约测试（Pact CDC）→ 自动检测（openapi-diff/buf breaking）

### 拟人化理解

把接口演进想成**操作系统升级**。旧 App（老调用方）必须在新系统（新服务）上能跑（向后兼容）。新系统不能悄悄删功能（删字段=破坏性）。新 App 可以用旧系统没有的功能（降级）。系统升级前先跑兼容性测试（契约测试），确保所有 App 不崩。实在要大改（破坏性），出 v2 系统（新 OS 版本），老 App 用老系统，新 App 用新系统，给迁移期。

### 面试现场 60 秒回答

> 接口演进四层防御。第一层兼容性规则——加可选字段和加接口是非破坏性（v1 内演进 OK），删字段、改类型、改必填、改语义是破坏性（必须出 v2）。第二层版本化——URL 版本（/v1/v2 并存）最直观，老版本至少维护 6 个月给调用方迁移。移动端 App 发版慢，接口必须严格向后兼容。第三层契约测试 Pact CDC——消费方定义期望（我调 /v1/orders 期望返回 id+amount），生成 Pact 契约推到 Broker。提供方 CI 拉所有消费方契约验证，破坏性变更（如删 amount）Pact 失败、CI 卡住。第四层自动检测——OpenAPI diff 对比 PR 和 main 的接口变更，标注破坏性；protobuf 用 buf breaking 检测字段删除/类型变更/编号变更。四层组合：演进时遵循规则，破坏性变更自动检测，契约测试卡 CI，版本化保并存。关键：把破坏性变更检测自动化，不依赖人工 review。

### 反问面试官

> 贵司接口是 REST 还是 gRPC？有没有契约测试体系（Pact）？接口数量和调用方数量？这决定我聊 REST 的 OpenAPI diff 还是 gRPC 的 buf breaking，以及是否要建设 Pact CDC 体系。

## 八、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不直接改接口，要搞这么复杂？ | 用故障成本说话：删一个字段可能让 50 个调用方中的 10 个挂，生产事故。移动端 App 崩了不可逆（发版撤回不了）。兼容性的复杂度是"保护调用方"的代价。如果是内部服务且调用方可控（能协调改造），简单很多 |
| 证据追问 | 怎么证明接口是兼容的？ | 契约测试通过率（所有消费方 Pact 验证通过）、can-i-deploy 检查（不破坏任何消费方）、openapi-diff 无破坏性变更、生产监控（升级后调用方 error_rate 未上升、特定字段的反序列化异常数=0） |
| 边界追问 | 兼容性能保证 100% 不出问题吗？ | 不能。语义变更（status 枚举值含义改）契约测试检测不到（字段还在、类型没变，但语义变了）。业务逻辑变更（如校验从宽松改严格）可能让原来通过的请求被拒。这类要人工 review + 灰度发布 + 监控 |
| 反例追问 | 什么场景不适合版本化？ | 内部微服务（调用方可控，能协调改造）、新接口（没历史调用方，随意改）、实验性接口（明确标注 unstable，不承诺兼容）。这些直接改比维护多版本高效 |
| 风险追问 | 接口演进最大风险？ | ① 语义变更契约测不出来（字段还在但含义变，调用方业务逻辑错）；② 老版本永不退役（技术债累积，维护成本高）；③ 契约测试覆盖不全（消费方没定义某个字段的期望，提供方删了 Pact 不报错）；④ protobuf 字段编号冲突（手动管理编号易错） |
| 验证追问 | 怎么验证契约测试有效？ | 故障注入——故意做破坏性变更（删字段），验证 Pact 是否检测到（CI 失败）。消费方覆盖率（所有调用方都定义了 Pact 契约）。Pact 契约的字段覆盖（消费方用到的字段都定义了期望） |
| 沉淀追问 | 团队接口演进规范？ | 兼容性规则文档（什么变更破坏性）、版本化 SOP（何时出 v2、老版本维护多久、下线流程）、Pact CDC 集成 CI（PR 卡破坏性变更）、API 评审机制（破坏性变更需架构师 review + 调用方确认） |

### 现场对话示例

**面试官**：契约测试和集成测试有什么区别？

**候选人**：视角不同。集成测试从提供方视角——"我的服务调依赖的服务，整条链路对不对"。要起所有服务（提供方 + 消费方一起跑），复杂、慢、易碎（一个挂全挂）。契约测试从消费方视角——"消费方定义对提供方的期望（请求/响应样例），生成契约文件（Pact）。提供方独立拉所有消费方契约验证（不需要消费方在线）。"关键区别：集成测试是"一起跑测全链路"，契约测试是"解耦验证契约"。Pact 模式下，50 个消费方各自定义契约（独立），提供方 CI 拉 50 个契约跑验证（独立），不需要 50 个服务一起跑。效率高、稳定。还能 can-i-deploy 检查"我的变更会不会破坏某个消费方"，CI 自动卡。

**面试官**：删了一个字段，怎么保证调用方不挂？

**候选人**：四道防线。第一，契约测试——消费方 Pact 定义了"我期望返回 amount 字段"，提供方删 amount 后 Pact 验证失败，CI 卡住，PR 合并不了。第二，openapi-diff——自动对比 OpenAPI 规范，标注"FIELD_DELETED"，CI 失败。第三，监控——老版本（含 amount 字段）和新版本（删了 amount）灰度并存，监控调用方的反序列化异常数，异常上升立即回滚。第四，下线流程——即使要删，先标记 @Deprecated（文档 + 日志告警 + Header 提示），监控调用量，调用量 <1% 且联系所有 TOP 调用方确认后，才真正删（给 6 个月迁移期）。四道防线组合，删字段不会让调用方挂。

**面试官**：移动端 App 发版慢，接口怎么兼容？

**候选人**：移动端最严格。App 发版审核 1-2 周，用户升级率慢（一个月 80%），所以接口必须严格向后兼容。规则：只加字段不删字段（老 App 依赖的字段永远保留），加可选字段（老 App 忽略新字段），绝不改类型和必填。极端情况（如老 App 有 bug 必须通过服务端兜底）——服务端做版本识别（Header 或 Token 带 App 版本），对老版本走兼容逻辑（如返回老格式）。超老版本（如 <1% 且发布超过 1 年）用强制升级（App 启动检查版本，过低弹窗强制升级）。接口演进对移动端的约束是"假设老 App 永远存在"，除非强制升级清场。

## 常见考点

1. **向后兼容和向前兼容区别？**——向后是老调新（新服务加字段，老调用方忽略），向前是新调老（老服务忽略新调用方的未知字段）。向后易实现（默认行为），向前需配置（FAIL_ON_UNKNOWN_PROPERTIES=false）。
2. **什么是破坏性变更？**——删字段、改字段类型、改字段语义、改必填性（可选→必填）、收紧校验。这些必须出 v2 版本，不能在 v1 内演进。
3. **Pact 契约测试怎么工作？**——消费方定义期望（请求/响应样例）生成 Pact 契约，推到 Broker。提供方 CI 拉所有消费方契约验证，破坏性变更 Pact 失败 CI 卡住。消费方驱动（CDC）。
4. **版本化策略怎么选？**——URL 版本（/v1/v2）最直观常用，Header 版本 URL 不变但难调试，protobuf 用 package 版本化。老版本至少维护 6 个月给迁移。
5. **如何自动检测破坏性变更？**——REST 用 openapi-diff 对比规范，gRPC 用 buf breaking 检测。集成 CI，PR 阶段自动标注破坏性变更，CI 失败阻止合并。

## 结构化回答

**30 秒电梯演讲：** 接口兼容性的本质是在不停止演进的前提下，保证已发布的接口对调用方永远可用。核心机制是契约（Schema/语义）+ 版本化（v1/v2 并存）+ 契约测试（Pact 验证消费方期望）。难点是兼容性分类（向后/向前/完全兼容）的边界、何时该出 v2、如何自动检测破坏性变更

**展开框架：**
1. **兼容性三分类** — 向后兼容（Backward，老调用方调新服务）、向前兼容（Forward，新调用方调老服务）、完全兼容（两者都满足）
2. **破坏性变更** — 删字段、改字段类型、改字段语义、改必填性（可选→必填）、收紧校验
3. **非破坏性变更** — 加可选字段、加新接口、放宽校验、加可选请求参数

**收尾：** 以上是我的整体思路。您想继续深入聊——什么时候该出 v2 而不是在 v1 演进？


## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：接口兼容性、版本化与契约测试 | "这题一句话：接口兼容性的本质是在不停止演进的前提下，保证已发布的接口对调用方永远可用。" | 开场钩子 |
| 0:15 | 像手机操作系统升级类比图 | "打个比方：像手机操作系统升级。" | 核心类比 |
| 0:40 | 兼容性三分类示意/对比图 | "向后兼容（Backward，老调用方调新服务）、向前兼容（Forward，新调用方调老服务）、完全兼容（两者都满足）" | 兼容性三分类要点 |
| 1:05 | 破坏性变更示意/对比图 | "删字段、改字段类型、改字段语义、改必填性（可选→必填）、收紧校验" | 破坏性变更要点 |
| 1:30 | 非破坏性变更示意/对比图 | "加可选字段、加新接口、放宽校验、加可选请求参数" | 非破坏性变更要点 |
| 1:55 | 总结卡 | "记住：兼容三分类。下期见。" | 收尾 |
