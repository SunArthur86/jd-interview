---
id: java-architect-127
difficulty: L2
category: java-architect
subcategory: 系统解耦
tags:
- Java 架构师
- 契约测试
- CDC
- 兼容性
feynman:
  essence: Consumer-Driven Contract（CDC）测试是把"接口是否符合预期"的检验权交给消费方——每个消费方写一份 Pact 契约（描述"我调用你的什么接口、给什么参数、期望什么响应"），提供方在自己的 CI 跑所有消费方的契约，任何破坏性变更当场红。本质是把"接口集成测试"从"端到端测试"降级到"单机单元测试"——速度快、可定位、可在 PR 期拦截。
  analogy: 像装修签合同：业主（消费方）写一份装修需求清单（Pact 契约），施工方（提供方）每改一个施工方案就跑一遍需求清单，任何不满足立刻返工。验收时不用真把业主喊来现场（端到端），看清单通过即可。
  first_principle: 为什么不写端到端测试而要写 CDC？因为端到端测试要起完整环境（消费方 + 提供方 + 中间件 + 数据库），慢、贵、不稳定（flaky）、定位困难。CDC 把"消费方的预期"抽出来变成可重放的 JSON 工件，提供方单独跑，10 秒出结果，失败当场定位到字段。
  key_points:
  - Pact 是 CDC 主流实现（Pact-JVM、Pact-Broker、Pact-Go）
  - 消费方写 Pact（expected request + minimal response）→ 上传 Broker
  - 提供方拉 Pact → 用 Verifier 回放 → 失败则 PR 红
  - 「消费者驱动」的精髓：契约由消费方定义，提供方被动适配（话语权反转）
  - Pact-Broker 的 can-i-deploy 矩阵：发布前查「我的版本对哪些消费方通过」
first_principle:
  problem: 微服务团队如何在不阻塞对方的前提下，保证 API 修改不破坏所有消费方？
  axioms:
  - 端到端测试环境是脆弱的、慢的、跨团队的，无法在 PR 期跑
  - 提供方不知道自己有多少消费方、各自依赖哪些字段
  - 大多数集成 bug 来自隐性契约（字段语义、状态机迁移）而非语法错误
  rebuild: 让每个消费方用 Pact 写下自己真实使用的请求和最小化响应期望，存到 Pact-Broker。提供方 PR 时拉所有契约 replay，任何一个失败就阻止合并。发布前用 can-i-deploy 检查"当前版本在 Broker 上的 verify 结果"，绿灯才能发。这套机制让"提供方不知情破坏消费方"变得不可能。
follow_up:
  - "Pact 怎么处理动态字段（时间戳、UUID）？——用 matchers（type matching 而非 value matching），如 `like(123)` 只校验是数字、`eachLike({id: like(1)})` 校验数组每项结构。"
  - Pact 和 OpenAPI diff 有什么区别？——OpenAPI diff 是"结构兼容性"（删字段算 breaking），Pact 是"行为兼容性"（消费方实际怎么用）。两者互补：OpenAPI 治整体契约，Pact 治具体调用。
  - 消费方不写 Pact 怎么办？——治理上把"上传 Pact"作为服务接入的强制门槛；提供方 PR 卡 can-i-deploy；从最关键的 1-2 个消费方试点扩散。
  - 跨语言（Java 提供方、Go 消费方）能跑 Pact 吗？——能。Pact 是语言无关的 JSON 工件，Pact-JVM/Go/JS/Rust/Python 互通，统一存 Pact-Broker。
  - Pact 能测消息驱动（Kafka）吗？——能。Pact 支持消息契约（V4 spec），消费方定义"我期望收到什么消息"，提供方跑 verifier 校验自己发的消息格式。
memory_points:
  - CDC：契约由消费方写，提供方跑 verify
  - Pact 三件套：Consumer test（写契约）→ Broker（存契约）→ Provider verify（跑契约）
  - can-i-deploy：发布前查矩阵，绿灯才发
  - matchers：用 type matching 处理动态字段，避免 flaky
  - 与 OpenAPI 互补：OpenAPI 是接口契约，Pact 是行为契约
---

# 【Java 后端架构师】Consumer Driven Contract 测试如何落地

> 适用场景：JD 核心技术。订单服务有 20 个下游消费方（履约、营销、风控、客服、BI...），任何一次订单接口改动都需要跨 20 个团队回归测试，集成阶段 bug 数高、上线周期 2 周。引入 Pact CDC 后，消费方各自写契约上传 Broker，订单服务 PR 阶段跑 20 份契约，5 分钟出结果，破坏性变更当场拦截，上线周期压到 2 天。

## 一、概念层

**传统集成测试 vs CDC 契约测试**：

| 维度 | 端到端集成测试 | CDC 契约测试 |
|------|---------------|-------------|
| 测试环境 | 全套环境（消费方+提供方+中间件+DB） | 单机跑（提供方独立 verify 契约） |
| 速度 | 分钟级（环境启动+数据准备） | 秒级（HTTP mock replay） |
| 稳定性 | 易 flaky（依赖网络、数据状态） | 稳定（输入输出固化） |
| 跨团队协作 | 高（联调需多方对齐） | 低（消费方独立写 Pact） |
| 失败定位 | 困难（端到端链路长） | 精准（直接指出哪个字段不匹配） |
| 拦截时机 | 集成阶段（已晚） | PR 阶段（早） |

**Pact 核心术语**：
- **Consumer（消费方）**：调用 API 的一方
- **Provider（提供方）**：被调用的一方
- **Pact（契约）**：JSON 文件，描述 consumer 期望的 request 和 provider 应返回的 minimal response
- **Pact-Broker**：契约中央仓库，存储契约 + verify 结果 + 版本矩阵
- **can-i-deploy**：发布前查询工具，检查当前版本是否对所有 consumer verify 通过

## 二、机制层：Pact 完整流程图

```
┌──────────────── 消费方 CI ────────────────┐    ┌────────── Pact Broker ──────────┐
│                                          │    │                                 │
│  1. Consumer 写 Pact 测试                │    │   pact-jvm-producer-xyz.json    │
│     (mock provider + 期望 response)      │    │   pact-go-consumer-abc.json     │
│                                          │───►│   ...                           │
│  2. 跑测试通过 → 生成 Pact JSON          │    │                                 │
│                                          │    │   verify 矩阵：                 │
│  3. 上传 Pact JSON 到 Broker             │    │   provider 1.2.3 × consumer 2.x │
│                                          │    │   ✓ verified                    │
└──────────────────────────────────────────┘    └────────────────┬────────────────┘
                                                                 │
                                                                 ▼
┌──────────────── 提供方 CI ────────────────────────────────────┐
│                                                               │
│  4. Provider 拉所有 Pact JSON                                │
│                                                               │
│  5. 启动本地 Provider                                         │
│                                                               │
│  6. Pact Verifier replay 每个 Pact 的 request                │
│     → 校验 Provider 实际返回的 response 是否符合契约          │
│                                                               │
│  7. 任何失败 → PR 红 + 上传 verify result 到 Broker          │
│                                                               │
│  8. can-i-deploy 检查 → 绿灯才允许发布                       │
└───────────────────────────────────────────────────────────────┘
```

## 三、机制层：Pact 代码实战

**消费方写 Pact（Java + Pact-JVM）**：

```java
// 消费方：订单履约服务调用订单查询接口
@ExtendWith(PactConsumerTestExt.class)
@PactTestFor(providerName = "order-service", port = "8080")
public class OrderFulfillmentPactTest {

    @Pact(consumer = "fulfillment-service")
    public RequestResponsePact queryOrderPact(PactDslWithProvider builder) {
        return builder
            .given("订单 JD001 已存在且已支付")
            .uponReceiving("查询订单详情")
                .path("/orders/JD001")
                .method("GET")
                .headers("X-Trace-Id", "trace-abc")
            .willRespondWith()
                .status(200)
                .matchHeader("Content-Type", "application/json")
                .body(new PactDslJsonBody()
                    .stringType("orderId", "JD001")
                    .stringValue("status", "PAID")
                    .decimalType("amount", 99.50)
                    .minArrayLike("items", 1,
                        new PactDslJsonBody()
                            .stringType("skuId")
                            .integerType("quantity", 1),
                        1))
            .toPact();
    }

    @Test
    @PactTestFor(pactMethod = "queryOrderPact")
    public void testQueryOrder(MockServer mockServer) throws IOException {
        OrderClient client = new OrderClient(mockServer.getUrl());
        Order order = client.query("JD001");
        assertEquals("PAID", order.getStatus());
        assertFalse(order.getItems().isEmpty());
    }
}
```

**提供方跑 verify**：

```java
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@Provider("order-service")
@PactBroker(
    url = "https://pact-broker.jd.com",
    authentication = @PactBrokerAuth(token = "${PACT_BROKER_TOKEN}")
)
public class OrderServicePactVerifyTest {

    @LocalServerPort int port;

    @TestTemplate
    @ExtendWith(PactVerificationSpringProvider.class)
    void verifyPact(PactVerificationContext context) {
        context.verifyInteraction();
    }

    @BeforeEach
    void beforeEach(PactVerificationContext context) {
        context.setTargetHttpClient(new SpringBootHttpTarget("http://localhost:" + port));
    }

    @State("订单 JD001 已存在且已支付")
    public void orderJd001Paid() {
        orderRepo.save(new Order("JD001", "PAID", 99.50,
            List.of(new OrderItem("SKU1", 1))));
    }
}
```

**can-i-deploy 检查（CI 必跑）**：

```bash
pact-broker can-i-deploy \
  --pacticipant order-service \
  --version 1.2.3 \
  --to-environment production \
  --broker-base-url=https://pact-broker.jd.com

# 成功输出：
# Computer says yes \o\0
# CONCLUSIONS: All verification results are passing

# 失败输出：
# Computer says no
# order-service 1.2.3 x fulfillment-service latest
#   FAIL: expected status PAID but got PENDING
```

## 四、实战层/选型：matchers 与动态字段处理

**matchers 四种**（处理动态字段，避免 flaky）：

| matcher | 含义 | 场景 |
|---------|------|------|
| `like(value)` | 同类型即可（value 只是占位） | id、name 不关心具体值 |
| `eachLike(obj)` | 数组每项结构匹配 | items 列表 |
| `match(regex, value)` | 正则匹配 | orderId 用 `^JD\d{18}$` |
| `datetime(format, value)` | ISO 日期匹配 | createdAt 不关心具体时间 |

**踩坑：value matching 导致 flaky**：

```java
// 错误：硬编码 value，CI 时间戳一变就 flaky
.stringValue("createdAt", "2024-01-01T10:00:00Z")

// 正确：type matching 或 datetime matcher
.datetime("yyyy-MM-dd'T'HH:mm:ss'Z'")
```

**Pact 与 OpenAPI 协同**：

```
OpenAPI（结构契约） ──► 描述所有可能的请求和响应
                         │
Pact（行为契约）    ──► 描述消费方实际使用的子集
                         │
                         ▼
              OpenAPI 检查"接口结构有没有破坏"
              Pact 检查"消费方的实际调用有没有破坏"
              互补不冲突
```

## 五、底层本质：话语权反转

回到第一性：**CDC 的精髓是"话语权反转"——传统架构里提供方说了算，CDC 把契约的定义权交给消费方**。

- **传统架构**：提供方设计接口 → 通知消费方适配 → 消费方被动接受。提供方改接口，消费方在集成期才发现，事故。
- **CDC 架构**：消费方写下"我依赖什么"，提供方必须保证这些依赖不被破坏。提供方可以新增字段、新增接口，但不能改/删消费方在用的字段。

这种反转的本质是"**契约的稳定性由弱者定义**"——消费方往往是数量多、议价弱的一方（如 20 个下游团队），CDC 给他们一个统一的"发声机制"（Pact 契约），让提供方无法忽视任何一方的依赖。

**为什么 Pact 比录制实际流量更优**：录制流量（如 wiremock 录制）只能捕获"发生过"的调用，捕获不到边界场景；Pact 是消费方主动写"我期望什么"，包含边界场景（如空数组、错误码）。而且 Pact 是文档——新人读 Pact 就知道这个接口的消费方依赖哪些字段。

## 六、AI 架构师加问：5 个

1. **用 LLM 自动生成 Pact 契约可行吗？**
   部分可行。LLM 读消费方代码（调用 order-service 的地方）+ OpenAPI YAML，能生成 Pact 草案。但边界场景（错误码、空数组）需要人工补全。落地：LLM 生成 80% 基础 Pact，人工补 20% 边界。

2. **Pact 失败时 LLM 怎么辅助定位？**
   LLM 读 Pact 失败 diff（expected vs actual）+ Provider 代码变更 diff，输出"哪行代码改坏了哪个 Pact"。但这只能做建议，真正修要人工判断是改代码还是改 Pact（消费方协商）。

3. **AI Agent 微服务架构下 Pact 怎么演进？**
   Agent 调用是动态的（Tool Use），不适合写死 Pact。演进方向：Agent 调用走 OpenAPI 契约 + 运行时校验（每次 tool call 后校验 response 符合 schema），而不是 Pact 这种编译期契约。

4. **跨团队契约治理，LLM 怎么帮忙做沟通？**
   Pact-Broker 输出的"break matrix"是冷冰冰的 JSON，LLM 可以转成"自然语言变更说明 + 影响分析报告"，自动发邮件给受影响的消费方 owner，附迁移建议代码。

5. **Pact 测试覆盖度怎么用 AI 评估？**
   LLM 分析消费方代码里所有调用 order-service 的地方，对比 Pact 契约覆盖度，输出"未覆盖的调用路径"报告。例如"order-service.deleteOrder 被 fulfillment 调用但没有 Pact，建议补充"。

## 七、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"消费方写、提供方跑、Broker 居中、can-i-deploy 守门"**。

- **消费方写 Pact**：定义 request + minimal response
- **提供方 verify**：拉所有 Pact replay，失败 PR 红
- **Broker**：契约中央仓库 + verify 矩阵
- **can-i-deploy**：发布前查矩阵，绿灯才发
- **matchers**：type matching 处理动态字段，避免 flaky

### 拟人化理解

把 Pact 想象成**装修签合同**。业主（消费方）写"我要三室一厅、客厅朝南、厨房带岛台"的需求清单（Pact 契约），施工方（提供方）每改一次方案就对着清单检查。Pact-Broker 是住建委的合同备案系统，所有合同都存这里，发布前查"我的方案对哪些业主通过"。can-i-deploy 是住建委的"竣工验收章"。

### 面试现场 60 秒回答

> 我们用 Pact 做 CDC。消费方在单测里用 PactDslJsonBody 写期望的 request 和 minimal response（用 matcher 而非 value 处理动态字段），跑通后 Pact-JVM 生成 JSON 工件上传到 Pact-Broker。提供方 CI 拉 Broker 上所有契约，启动本地服务后用 PactVerificationSpringProvider replay，任何一个契约失败就阻止 PR 合并。发布前必跑 can-i-deploy 检查 verify 矩阵，绿灯才允许上 prod。这套机制让我们订单服务的 20 个下游消费方契约都能在 PR 期拦截破坏性变更，集成期 bug 下降 60%，上线周期从 2 周压到 2 天。最大坑是 provider state 数据准备——要为每个 Pact 的 given 场景造测试数据，建议用 testcontainers + flyway 自动化。

### 反问面试官

> 贵司的微服务契约测试覆盖率多少？有没有用 Pact 或 spring-cloud-contract？消费方团队配合度怎么样？如果不配合，强制的卡点在哪里？

## 八、苏格拉底式面试追问（7 层表格 + 现场对话）

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么 CDC 比端到端测试更适合微服务？ | 用速度和稳定性说话：端到端分钟级且 flaky，CDC 秒级稳定。微服务核心痛点是"提供方不知情破坏消费方"，CDC 把契约变成可量化工件 |
| 证据追问 | 怎么证明 CDC 真的拦住了事故？ | blocked_pr_count（PR 被 Pact 失败拦截的次数）、integration_bug_decline（集成期 bug 数下降比例）、release_cycle_shorten（发布周期缩短天数） |
| 边界追问 | Pact 能测什么，测不了什么？ | 能测 HTTP/同步 RPC、消息契约（V4）。测不了：性能、安全、跨多个 Pact 的复杂流程（还是要少量 E2E）。所以 Pact 是补充不是替代 |
| 反例追问 | 什么场景不推荐 Pact？ | 调用方极少（1-2 个）、接口变化极频繁（POC 阶段）、消费方不配合——Pact 治理成本大于收益。这时 OpenAPI lint + 少量 E2E 更划算 |
| 风险追问 | Pact 上线最大风险是什么？ | Provider state 数据准备成本高（每个 Pact 都要造数据），团队抵触。治理上要从 1-2 个核心消费方试点，提供 testcontainers 模板降低门槛 |
| 验证追问 | 怎么证明 Pact 覆盖度够？ | Pact-Broker 自带 consumer coverage 报告；LLM 辅助分析"消费方代码里所有调用 vs Pact 覆盖的调用"差距 |
| 沉淀追问 | 团队 Pact 治理规范沉淀什么？ | Pact-Broker 部署 + 鉴权、Pact-JVM 模板代码、provider state testcontainers 最佳实践、can-i-deploy 集成到 CI 的标准 pipeline、新人接入文档 |

### 现场对话示例

**面试官**：消费方团队不配合写 Pact 怎么办？

**候选人**：先承认这是治理问题不是技术问题。三层推进。第一层，技术门槛降低——给标准模板和 AI 辅助生成，让写 Pact 的工作量从半天压到半小时。第二层，激励机制——把 Pact 覆盖度纳入服务健康度评分，影响团队的 SLO 考核。第三层，强制卡点——提供方在 can-i-deploy 拒绝任何未上传 Pact 的消费方发布。但强制之前必须给 1-2 个月的过渡期和培训。京东的实操：先让订单、营销、风控三个核心服务接入（覆盖 70% 调用量），半年后扩到全公司。

**面试官**：Pact 怎么测消息驱动场景（Kafka）？

**候选人**：Pact V4 spec 支持 message pact。消费方写"我期望收到什么消息"（包含 body、metadata、content type），提供方跑 verifier 时不是发 HTTP，而是调用消息生成函数校验输出符合契约。Java 代码示例：消费方用 `MessagePactBuilder`，提供方用 `@PactVerifyProvider` 标注消息生成方法。复杂场景如顺序消息、重试消息，Pact 不擅长，还是要配 stream 测试。

**面试官**：Pact 和 OpenAPI lint 重复吗？

**候选人**：不重复，互补。OpenAPI lint 检查"契约本身符合规范"（命名、错误码、必填字段），是结构层面的；Pact 检查"消费方实际调用是否符合契约"，是行为层面的。举例：OpenAPI 写了 10 个字段，但某个消费方只用其中 3 个——OpenAPI lint 不知道，Pact 知道。提供方删第 4 个字段，OpenAPI 报 breaking change（误报），Pact 不报（这个消费方不用）。所以 Pact 能让提供方做出更精准的兼容性判断。

## 常见考点

1. **Pact 和 WireMock 区别？**——WireMock 是 stub server（消费方 mock 提供方），Pact 是双向契约（消费方 mock 同时生成契约工件给提供方 verify）。WireMock 不会把 mock 固化成可重放工件。
2. **provider state 是什么？**——Pact 里的 `given("订单 JD001 已存在")` 子句，提供方 verify 时需要按 state 准备测试数据。这是 Pact 的"数据驱动"特性。
3. **Pact 怎么处理双向兼容？**——Pact 主要是"消费方约束提供方"，但 Pact-Broker 也支持"提供方 pending 契约"（新消费方写契约，提供方还未实现，标记 pending 不阻塞发布）。
4. **Pact-JVM 和 Spring Cloud Contract 区别？**——SCC 是 Spring 生态的 CDC 实现，契约用 Groovy DSL 写，生成 stub jar 给消费方依赖；Pact 是语言无关的 JSON 工件存 Broker。SCC 更 Spring 化，Pact 更通用。
5. **can-i-deploy 失败怎么办？**——查 Broker 矩阵看哪个 consumer 没通过 → 要么修 provider 代码（恢复兼容）、要么 bump version（新接口）、要么和 consumer 协商改 Pact。

## 结构化回答

**30 秒电梯演讲：** Consumer-Driven Contract（CDC）测试是把接口是否符合预期的检验权交给消费方——每个消费方写一份 Pact 契约（描述我调用你的什么接口、给什么参数、期望什么响应），提供方在自己的 CI 跑所有消费方的契约，任何破坏性变更当场红。本质是把接口集成测试从端到端测试降级到单机单元测试——速度快、可定位、可在 PR 期拦截

**展开框架：**
1. **Pact 是 CDC 主流实现（Pact** — JVM、Pact-Broker、Pact-Go）
2. **消费方写 Pact** — 消费方写 Pact（expected request + minimal response）→ 上传 Broker
3. **提供方拉 Pact →** — 提供方拉 Pact → 用 Verifier 回放 → 失败则 PR 红

**收尾：** 以上是我的整体思路。您想继续深入聊——Pact 怎么处理动态字段（时间戳、UUID）？


## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：Consumer Driven Contract | "这题核心是——Consumer-Driven Contract（CDC）测试是把接口是否符合预期的检验权交给消……" | 开场钩子 |
| 0:15 | Pact 是 CDC 主流实现（示意/对比图 | "JVM、Pact-Broker、Pact-Go）" | Pact 是 CDC 主流实现（要点 |
| 0:40 | 消费方写 Pact示意/对比图 | "消费方写 Pact（expected request + minimal response）→ 上传 Broker" | 消费方写 Pact要点 |
| 1:25 | 总结卡 | "记住：CDC。下期见。" | 收尾 |
