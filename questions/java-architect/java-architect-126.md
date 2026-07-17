---
id: java-architect-126
difficulty: L2
category: java-architect
subcategory: 系统解耦
tags:
- Java 架构师
- OpenAPI
- 契约优先
- 接口治理
feynman:
  essence: API 契约优先设计（Design-First）是指先写 OpenAPI 规范作为"机器可读的契约"，再生成桩代码、Mock、文档、SDK，最后双方按契约并行开发；OpenAPI 治理是在企业内部把"契约版本化、兼容性校验、Linter 规则、Mock/Stub、文档中心、SDK 自动下发"串成一条流水线，让契约成为服务端与客户端、上游与下游协作的唯一真相源（single source of truth）。
  analogy: 像盖楼先出施工图纸（OpenAPI YAML），所有工种（前端、后端、QA、网关、文档）都按同一张图纸作业，不允许私自改承重墙。图纸变了要走变更评审（breaking change check），不兼容变更要发新版本号（v2），旧版本号保留 6 个月兼容期。
  first_principle: 为什么不写完代码再用 swagger 注解生成文档？因为代码生成文档是"事后描述"，已经丢失了"契约约束力"——上游按旧接口调，下游改了字段没通知，集成阶段才发现不兼容。契约优先把"接口"从代码里抽出来变成独立工件，在 PR 阶段就能用 spectral/openapi-diff 拦截破坏性变更。
  key_points:
  - Design-First：OpenAPI YAML 是工件，进 Git，参与 Code Review，先于代码
  - 兼容性三类：non-breaking（加可选字段）、breaking（删字段/改类型/改必填）、risky（语义变化）
  - 治理四件套：Linter（spectral）、Diff（openapi-diff）、Mock（prism/ventus）、SDK 生成（openapi-generator）
  - "版本化：URL 路径版本（/v1/v2）最简单；媒体类型版本（Accept: application/vnd.x.v1+json）更优雅但难调试"
  - 弃用流程：deprecated 标记 → sunset header → 监控调用方 → 邮件/合同通知 → 下线
first_principle:
  problem: 微服务团队如何在不阻塞对方的前提下，保证 API 修改不破坏既有调用方？
  axioms:
  - 任何"代码即文档"的方案都滞后于真实集成——集成在代码完成前就开始了
  - 大多数"线上事故"是隐性契约被破坏（字段必填变可选、枚举值删除、状态机迁移）
  - API 一旦发布就有外部依赖，破坏性变更的成本随调用方数量指数增长
  rebuild: 把 OpenAPI YAML 当作 Git 里的第一公民工件，PR 阶段跑 spectral 规则集（命名、错误码、分页、鉴权）+ openapi-diff 识别破坏性变更，CI 通过后用 prism 起 Mock 让前端先联调，用 openapi-generator 生成多语言 SDK 发到内网 Nexus。契约变更走独立的"契约 PR"，业务 PR 依赖契约 PR 合并。这样把"接口不兼容"从事故降为编译期失败。
follow_up:
  - 为什么不用 GraphQL 替代 OpenAPI？——GraphQL 适合"客户端驱动、字段灵活、聚合多源"场景（如 App 首页），OpenAPI 适合"服务端主导、稳定契约、强类型"场景（如开放平台、内部 RPC）。两者并存，不是替代关系。
  - 破坏性变更怎么平滑迁移？——双端点并行（/v1 和 /v2 共存）+ 流量比例监控 + sunset header + 调用方迁移 checklist + 强制下线日历。JD 开放平台要求 ISV 在 90 天内迁移，否则 sunset 后 401。
  - OpenAPI 怎么跟 gRPC/Protobuf 协同？——内部用 gRPC（proto 是契约），网关用 grpc-gateway 或 buf 生成 OpenAPI 暴露给外部 REST 调用方。proto 是源头，OpenAPI 是派生工件。
  - OpenAPI 文档怎么跟代码不漂移？——Design-First 模式下代码只是契约的实现，CI 跑 contract test（Pact/spring-cloud-contract）保证实现符合契约；Code-First 模式下用 swagger-inline 注解 + CI 校验注解和 YAML 一致。
  - LLM Agent 接 API 用 OpenAPI 还是 Function Calling？——OpenAPI 可以自动转成 Function Calling Schema（如 OpenAI 的 actions / plugins），所以 OpenAPI 是 LLM 时代的"机器可读契约"基础，治理好的企业能直接把 API 喂给 Agent。
memory_points:
  - Design-First：YAML 先行，PR 拦截 breaking change
  - 治理流水线：spectral（lint）→ openapi-diff（兼容性）→ prism（mock）→ openapi-generator（SDK）
  - 兼容性三档：non-breaking / breaking / risky；breaking 必须 bump version
  - 版本策略：URL 路径版本（/v2）最常用，Sunset header 配合 90 天弃用窗口
  - 工具链：Stoplight Studio / Redocly / Apifox 是商业方案，spectral/prism/openapi-generator 是开源
---

# 【Java 后端架构师】API 契约优先设计与 OpenAPI 治理

> 适用场景：JD 核心技术。京东开放平台对外暴露 3000+ OpenAPI，ISV、商家工具、自营 App 都依赖这些接口；一次破坏性变更（如把 sku_id 从 Long 改成 String）会让数万个 ISV 应用集体挂掉。架构师面试不是问"OpenAPI 是什么"，而是看你能不能把契约做成 PR 期拦截的工件、把 breaking change 治理成可度量可下线的流程。

## 一、概念层

**契约优先（Design-First）vs 代码优先（Code-First）**：

| 维度 | Code-First（旧） | Design-First（推荐） |
|------|-----------------|-------------------|
| 工件来源 | Spring `@RestController` + swagger 注解生成 | 手写 OpenAPI YAML，再生成接口 stub |
| 评审时机 | 代码合并后（已落地，难改） | YAML PR 阶段（轻量、易改） |
| Mock 可用性 | 必须等服务启动 | YAML 一确定 prism 立刻起 Mock |
| 兼容性校验 | 事后发现 | openapi-diff 在 CI 拦截 |
| 客户端 SDK | 手写或脚手架 | openapi-generator 自动多语言 |
| 文档漂移 | 注解和 YAML 容易不一致 | YAML 是唯一真相源 |

**OpenAPI 3.1 的关键能力**（面试加分）：
- 3.1 完全对齐 JSON Schema 2020-12（之前是 OpenAPI 自定义子集）
- 支持 `webhooks`（服务端推送契约）
- 支持 `nullable` 已废弃，改用 `type: ["string", "null"]`
- 支持 `oneOf/anyOf/allOf` 复杂建模

## 二、机制层：OpenAPI YAML 完整示例

**一份符合治理规范的 OpenAPI YAML**（JD 风格的订单查询接口）：

```yaml
openapi: 3.1.0
info:
  title: JD Order OpenAPI
  version: 2.1.0
  contact: { email: order-openapi@jd.com }
  license: { name: JD-Internal }

servers:
  - url: https://api.jd.com/order/v2
    description: prod

tags:
  - name: Order
    description: 订单查询与状态流转

paths:
  /orders/{orderId}:
    get:
      operationId: getOrderById
      tags: [Order]
      summary: 查询订单详情
      parameters:
        - name: orderId
          in: path
          required: true
          schema: { type: string, pattern: '^JD\d{18}$' }
        - name: X-Trace-Id
          in: header
          required: true
          schema: { type: string, minLength: 8 }
      responses:
        '200':
          description: 成功
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Order' }
        '400': { $ref: '#/components/responses/BadRequest' }
        '401': { $ref: '#/components/responses/Unauthorized' }
        '404': { $ref: '#/components/responses/NotFound' }
        '429': { $ref: '#/components/responses/RateLimited' }
      security: [ { apiKeyAuth: [] } ]
      deprecated: false

components:
  securitySchemes:
    apiKeyAuth:
      type: apiKey
      in: header
      name: X-JD-Access-Token
  responses:
    BadRequest:
      description: 参数错误
      content:
        application/json:
          schema: { $ref: '#/components/schemas/Error' }
    RateLimited:
      description: 限流
      headers:
        X-RateLimit-Limit: { schema: { type: integer } }
        X-RateLimit-Remaining: { schema: { type: integer } }
        Sunset: { schema: { type: string } }
  schemas:
    Order:
      type: object
      required: [orderId, status, amount]
      properties:
        orderId: { type: string }
        status:
          type: string
          enum: [CREATED, PAID, SHIPPED, DELIVERED, CLOSED]
        amount:
          type: number
          format: double
          minimum: 0
        items:
          type: array
          items: { $ref: '#/components/schemas/OrderItem' }
    OrderItem:
      type: object
      required: [skuId, quantity]
      properties:
        skuId: { type: string }
        quantity: { type: integer, minimum: 1 }
    Error:
      type: object
      required: [code, message, traceId]
      properties:
        code: { type: string, example: 'ORDER_NOT_FOUND' }
        message: { type: string }
        traceId: { type: string }
```

## 三、机制层：治理流水线四件套

```
开发者写 YAML ─┬─► spectral lint（规则集校验）
               │
               ├─► openapi-diff（识别 breaking change，CI 失败）
               │
               ├─► prism mock（前端立刻联调）
               │
               └─► openapi-generator（生成 Java/Go/TS SDK，发 Nexus）
```

**1. Spectral Lint 规则集**（强制规范）：

```yaml
# .spectral.yaml
extends: [[spectral:oas, all]]
rules:
  jd-operation-id-required:
    description: 必须 operationId
    given: $.paths.*.*.operationId
    severity: error
    then: { function: truthy }
  jd-error-response:
    description: 4xx/5xx 必须用 Error schema
    given: $.paths.*.*.responses.[*].content.*.schema
    severity: error
    then:
      function: schema
      functionOptions:
        $ref: '#/components/schemas/Error'
  jd-naming-kebab-case:
    description: path 用 kebab-case
    given: $.paths.*~
    severity: warn
    then: { function: pattern, functionOptions: { match: '^(/[a-z0-9-]+|/{[^}]+})+$' } }
```

```bash
spectral lint order-openapi.yaml
# 输出：3 errors, 1 warning → CI 失败，PR 拒绝合并
```

**2. openapi-diff 识别破坏性变更**：

```bash
oasdiff breaking old.yaml new.yaml
# 输出：
# - BREAKING: Removed property 'Order.amount' (required)
# - BREAKING: Changed type of 'OrderItem.skuId' from integer to string
# - NON-BREAKING: Added optional property 'Order.couponCode'
```

破坏性变更分类（这是治理的核心，必须能背）：

| 变更类型 | 例子 | 处理 |
|---------|------|------|
| Breaking（必须 bump version） | 删字段、改类型、required 变化、删 enum 值、改 URL 路径 | 新版本 v2，旧版本保留 90 天 |
| Non-breaking | 加可选字段、加新接口、加 enum 值 | 同版本迭代即可 |
| Risky（人工评审） | 字段语义变化（status 含义改了）、限流阈值降低 | 标记并通知调用方 |

**3. Prism Mock 起本地联调**：

```bash
prism mock order-openapi.yaml --port 4010
# 前端立刻能调 http://localhost:4010/orders/JD001，返回 example 数据
# 还能用 prism proxy 录制真实请求做 contract test
```

**4. openapi-generator 生成多语言 SDK**：

```bash
openapi-generator-cli generate \
  -i order-openapi.yaml \
  -g java \
  -o sdk-java \
  --additional-properties=useJakartaEe=true,library=resttemplate

# CI 自动发到内网 Nexus：
# <dependency>
#   <groupId>com.jd.openapi</groupId>
#   <artifactId>order-sdk</artifactId>
#   <version>2.1.0</version>
# </dependency>
```

## 四、实战层/选型：版本化与弃用流程

**版本化策略对比**：

| 策略 | 例子 | 优点 | 缺点 |
|------|------|------|------|
| URL 路径版本（最常用） | `/orders/v2/{id}` | 直观、易路由、CDN 缓存友好 | 版本污染 URL |
| Header 版本 | `Accept: application/vnd.jd.v2+json` | URL 干净 | 难调试、CDN 不友好 |
| Query 版本 | `?version=2` | 简单 | 易被忽略、缓存坑 |
| 日期版本（AWS 风格） | `?api-version=2024-01-15` | 自带发布日期 | 学习成本 |

JD 开放平台用 URL 路径版本，原因是 ISV 接入文档更直观。

**弃用（Sunset）流程**（RFC 8594）：

```
1. 新版本上线 v2，旧版本 v1 标记 deprecated: true
2. v1 响应头加 Sunset: Sat, 31 Dec 2025 23:59:59 GMT
3. 监控 v1 调用方列表（按 appKey 维度统计）
4. 邮件 + 控制台告警通知未迁移 ISV
5. 90 天后下线 v1，返回 410 Gone
```

**Spring 服务端实现契约**（用 springdoc 强制 Design-First）：

```java
// 不允许写 @RestController 后再用 @Operation 注解生成文档
// 必须先有 YAML，再用接口 stub 实现

// openapi-generator 生成的 stub：
@Generated
public interface OrderApi {
    @GetMapping(value = "/orders/{orderId}")
    Order getOrderById(@PathVariable String orderId,
                       @RequestHeader("X-Trace-Id") String traceId);
}

// 业务实现：
@RestController
public class OrderController implements OrderApi {
    @Autowired private OrderService orderService;

    @Override
    public Order getOrderById(String orderId, String traceId) {
        return orderService.query(orderId);
    }
}
```

## 五、底层本质：契约即权力分配

回到第一性：**API 契约的本质是组织协作的"权力分配工具"**。

- **没有契约治理**：服务端团队单方面改接口，客户端被动适配，事故在集成阶段爆发，责任不清。
- **有契约治理**：契约变更走 PR 评审，破坏性变更必须 bump version，调用方有 90 天窗口迁移。契约成了"双方签字的合同"。

**为什么 OpenAPI 比 GraphQL/Thrift IDL/Protobuf 在外部开放场景更主流**：因为 OpenAPI 用 JSON/YAML 描述、生态最大（生成器、Linter、文档、Mock、API 网关、APM 全部原生支持）、HTTP 兼容性最好（ISV 用 curl 都能调）。Protobuf 是内部 RPC 高效契约，但外部开放场景的"通用语言"仍是 OpenAPI。

**LLM 时代的新角色**：OpenAPI YAML 现在可以直接转成 Function Calling 的 JSON Schema（OpenAI Plugins、Anthropic Tool Use 都支持），所以治理好的 OpenAPI 库 = LLM Agent 可以即插即用的工具集。这是为什么 OpenAPI 治理在 2024 后突然变成 AI Infra 的基础。

## 六、AI 架构师加问：5 个

1. **把 OpenAPI 喂给 LLM Agent 当工具集，最大风险是什么？**
   Prompt Injection 让 Agent 调用未授权接口（如把 query 误当成 delete）。治理：OpenAPI 里给每个 operation 打 `x-llm-safe: query-only` 标签，Agent 网关只暴露 safe 接口；写操作必须走人工确认。

2. **用 LLM 自动生成 OpenAPI YAML，可行吗？**
   可行但必须人工 review。LLM 擅长从已有接口反推契约，但不擅长捕捉业务语义（枚举值含义、必填业务规则）。落地：LLM 生成草案 → spectral lint 自动校验 → 资深工程师 review 业务语义。

3. **OpenAPI → Function Calling 的转换怎么处理枚举和大 schema？**
   枚举直接转 enum 字段；大 schema（>32KB）需要拆分或用 JSON Schema `$ref` + 工具调用前先调 `/describe` 拉取。OpenAI 当前单次 tool schema 限制 32K tokens，要给 LLM 一个"API 目录"接口让它按需拉。

4. **LLM Agent 调 OpenAPI 怎么做鉴权？**
   Agent 用 client_credentials 拿 Access Token，scope 限定可调接口。高危操作（资金、删除）要求 user_assertion（用户显式授权一次）。所有 Agent 调用进 audit log，关联 traceId + tool_call_id。

5. **怎么用 LLM 检测 OpenAPI 契约的"语义破坏性变更"？**
   oasdiff 只能检测结构破坏，检测不了语义破坏（status=PAID 含义变了）。LLM 读 commit message + 字段注释 + 业务文档，对比新旧版本语义差异，输出"语义变更风险报告"供人工 review。

## 七、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"Design-First、四件套、兼容性三档、弃用 Sunset"**。

- **Design-First**：YAML 先于代码，PR 阶段就评审
- **四件套**：spectral（lint）→ openapi-diff（兼容性）→ prism（mock）→ openapi-generator（SDK）
- **兼容性三档**：non-breaking 同版本、breaking bump version、risky 人工评审
- **弃用**：deprecated 标记 → Sunset header → 90 天迁移 → 410 Gone

### 拟人化理解

把 OpenAPI 治理想象成 **建筑设计院的施工图纸管理**。YAML 是图纸，进版本控制系统（Git）。每次改图纸要走过审（spectral）和结构审查（oasdiff），破坏性改动（拆承重墙）必须出新版图（v2）。旧版图纸保留 90 天，让施工队有时间切换。Mock 是按图纸搭的样板房，前端先住进去体验。SDK 是按图纸预制的构件，运到工地直接拼装。

### 面试现场 60 秒回答

> 我们走 Design-First：OpenAPI YAML 进 Git，PR 阶段跑 spectral lint（命名规范、必填 operationId、统一 Error schema）+ openapi-diff 识别 breaking change。CI 通过后 prism 起 Mock 让前端并行联调，openapi-generator 自动生成 Java/Go/TS SDK 发到 Nexus。兼容性分三档：non-breaking 同版本迭代，breaking 必须 bump version（URL 路径版本最直观），risky 人工评审。弃用流程严格按 RFC 8594：标 deprecated → Sunset header → 90 天迁移 → 410 Gone。最大的坑是 Code-First 模式下注解和契约漂移，所以强制 stub 模式——controller 必须 implements 生成的接口，编译器保证契约一致。

### 反问面试官

> 贵司内部服务间用 gRPC 还是 REST？对外用 OpenAPI 暴露还是用 GraphQL？如果两个都有，怎么保证 proto 和 OpenAPI 不漂移？是 grpc-gateway 自动转还是双份维护？

## 八、苏格拉底式面试追问（7 层表格 + 现场对话）

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 你为什么坚持 Design-First 而不是 Code-First？ | 用集成阶段返工成本说话：Code-First 在集成期才发现不兼容，返工成本 = 前后端工时 + 测试工时；Design-First 在 PR 阶段拦截，成本只是改 YAML。JD 实测：Design-First 让 OpenAPI 集成期 bug 数下降 60% |
| 证据追问 | 怎么证明治理流水线有效？ | contract_violation_count（CI 拦截的破坏性变更数）应该 > 0 才证明规则有效；mock_first_ratio（前端是否先调 mock 再调真实接口）应 > 80%；sdk_auto_generated_ratio 应 100% |
| 边界追问 | OpenAPI 能描述异步回调、长任务、流式吗？ | 3.1 支持 webhooks（服务端推送契约）；流式用 `text/event-stream` 但没有 schema 描述，需要 OpenAI 风格的额外约定。所以 OpenAPI 不是万能，复杂异步场景要配 AsyncAPI |
| 反例追问 | 什么场景你不推荐 Design-First？ | 创业期 POC 阶段、内部单体应用、调用方只有自己团队——契约约束的收益小于写 YAML 的成本。这种场景 Code-First + 注解生成文档更高效 |
| 风险追问 | 治理流水线最大风险是什么？ | LLM 时代新风险：开发者让 AI 生成 YAML 跳过 spectral 规则集，导致规范形同虚设。要给 AI 输入规则集 + CI 强制二次校验 |
| 验证追问 | 怎么证明 contract test 真的覆盖了所有路径？ | 用 schema coverage 工具（如 schemathesis）自动基于 OpenAPI 生成测试用例，报告覆盖率；contract_violation_count 应随时间下降 |
| 沉淀追问 | 团队治理规范沉淀什么？ | 公共 components（Error、Pagination、TraceId）、spectral 规则集、openapi-generator 配置模板、SDK 发布流水线、API 文档门户（Redocly/Stoplight）、弃用流程 SOP |

### 现场对话示例

**面试官**：你说 Design-First 好，但写 YAML 比写代码慢多了，怎么说服团队？

**候选人**：我会算三笔账。第一，集成返工账：Code-First 模式下我们统计过 OpenAPI 类项目的集成 bug 平均 1.4 个/接口，每个返工 0.5 人天；Design-First 下降到 0.5 个/接口。第二，并行开发账：YAML 一确定 prism 立刻起 Mock，前端不用等后端实现，前后端能并行 2-3 周。第三，治理账：现在不写 YAML，未来 breaking change 是定时炸弹。具体落地我不让团队从零写 YAML——给他们 IDE 插件（Stoplight Studio 可视化编辑）+ 模板（脚手架生成基础 YAML）+ AI 辅助（LLM 根据自然语言描述生成草案）。把单接口的 YAML 撰写时间从 30 分钟压到 5 分钟。

**面试官**：怎么处理 ISV 强烈反对的 breaking change？

**候选人**：分情况。如果是安全/合规原因（如鉴权升级），强制执行 + 给 90 天迁移窗口 + 提供自动化迁移工具。如果是业务演进（如拆分接口），我会先做"双写"——新接口 v2 上线，v1 内部转发到 v2 再转换格式，ISV 无感知。如果是 ISV 主动要求的，给申请通道。Sunset 之前必须有三个信号：v1 调用量下降到阈值以下、邮件确认所有头部 ISV 已迁移、灰度关闭 v1 一周观察无客诉。任何一项不满足就推迟下线。

**面试官**：OpenAPI 和 GraphQL 怎么选？

**候选人**：不是二选一。OpenAPI 是服务端主导契约，适合"对外稳定承诺、强类型、有 SLA"的场景（开放平台、内部核心 RPC、合规审计）。GraphQL 是客户端驱动契约，适合"字段灵活、聚合多源、App 首页动态化"场景。京东的实际做法是：内部服务用 gRPC（proto 是契约），网关用 grpc-gateway 转出 OpenAPI 给 ISV 用，App 首页这种聚合场景用 BFF 层包 GraphQL。三者各司其职，OpenAPI 是外部契约的语言。

## 常见考点

1. **OpenAPI 3.0 vs 3.1 区别？**——3.1 完全对齐 JSON Schema 2020-12，支持 `type: ["string","null"]` 替代 `nullable: true`，支持 webhooks，支持 const 编码枚举。
2. **breaking change 判定规则？**——加必填字段、删字段、改类型、收紧 enum、删 response code 都是 breaking；加可选字段、加 enum 值、加新接口都是 non-breaking。
3. **Linter 规则集怎么设计？**——三层：语法层（spectral:oas 内置）、规范层（公司命名/错误码/分页规范）、安全层（必填鉴权、禁用 query 传敏感字段）。
4. **OpenAPI 怎么描述分页？**——用 `nextCursor` 游标分页（避免 offset 大表性能问题），response 里 `x-page-next` 字段；或在 header 用 `Link: <url>; rel="next"`。
5. **怎么自动生成 SDK？**——openapi-generator-cli 支持 50+ 语言，CI 流水线拉 YAML → generate → publish 到 Nexus/npm/PyPI。版本号和 OpenAPI version 一一对应。

## 结构化回答

**30 秒电梯演讲：** API 契约优先设计（Design-First）是指先写 OpenAPI 规范作为机器可读的契约，再生成桩代码、Mock、文档、SDK，最后双方按契约并行开发；OpenAPI 治理是在企业内部把契约版本化、兼容性校验、Linter 规则、Mock/Stub、文档中心、SDK 自动下发串成一条流水线，让契约成为服务端与客户端、上游与下游协作的唯一真相源（single source of truth）

**展开框架：**
1. **Design-First** — OpenAPI YAML 是工件，进 Git，参与 Code Review，先于代码
2. **兼容性三类** — non-breaking（加可选字段）、breaking（删字段/改类型/改必填）、risky（语义变化）
3. **治理四件套** — Linter（spectral）、Diff（openapi-diff）、Mock（prism/ventus）、SDK 生成（openapi-generato……

**收尾：** 以上是我的整体思路。您想继续深入聊——为什么不用 GraphQL 替代 OpenAPI？


## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：API 契约优先设计与 OpenAPI 治理 | "这题核心是——API 契约优先设计（Design-First）是指先写 OpenAPI 规范作为机器可读的契约……" | 开场钩子 |
| 0:15 | Design-First示意/对比图 | "OpenAPI YAML 是工件，进 Git，参与 Code Review，先于代码" | Design-First要点 |
| 0:40 | 兼容性三类示意/对比图 | "non-breaking（加可选字段）、breaking（删字段/改类型/改必填）、risky（语义变化）" | 兼容性三类要点 |
| 1:25 | 总结卡 | "记住：Design-First。下期见。" | 收尾 |
