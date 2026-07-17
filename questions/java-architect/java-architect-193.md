---
id: java-architect-193
difficulty: L2
category: java-architect
subcategory: 系统解耦
tags:
- Java 架构师
- API版本
- 兼容
- 废弃
feynman:
  essence: API 版本兼容的核心是"向前兼容（新增不破坏旧客户端）+ 向后兼容（新客户端能用旧 API）"。机制上用语义化版本（SemVer）+ Sunset Header + @Deprecated 渐进废弃 + OpenAPI diff 自动检测破坏性变更。废弃不是"通知一声就下线"，而是"Sunset Header 预告 → 监控调用方迁移 → 联系未迁移者 → 灰度下线"的完整流程，否则就是事故。
  analogy: 像 PCI DSS 升级——不是"明天换新版本，旧版本不能用"（商家全挂），而是"V1 还能用 2 年，V2 同步发布，Sunset Header 告诉你 V1 什么时候下线，监控你迁移了没，没迁移的主动联系"。API 兼容性就是给调用方"迁移时间"和"迁移信号"。
  first_principle: API 是契约，调用方依赖契约工作。破坏性变更（删字段、改类型、改语义）会让调用方崩溃。版本兼容的第一性是"把破坏性变更变成渐进式、可观测、可回退的流程"——用 SemVer 标识变更严重程度，用 OpenAPI diff 自动检测破坏性变更，用 Sunset Header 通知调用方，用监控追踪迁移进度，用灰度下线降低风险。
  key_points:
  - 语义化版本（SemVer）：MAJOR.MINOR.PATCH，MAJOR 变更=破坏性
  - 兼容性原则：新增字段兼容（可选）、删字段/改类型不兼容（要新版本）
  - "@Deprecated 标注 + Sunset Header 通知废弃时间表"
  - OpenAPI diff 自动检测破坏性变更（CI 阻断）
  - 废弃流程：Sunset 预告 → 监控迁移 → 联系未迁移者 → 灰度下线
first_principle:
  problem: 如何在 API 演进（加功能、改字段、废弃旧版本）时，既不破坏现有调用方，又能推进新版本 adoption，避免"一改 API 全网炸"或"老 API 永远不敢下线"？
  axioms:
  - API 是契约，破坏性变更（删字段/改类型）让调用方崩溃
  - 调用方迁移需要时间，不能一刀切下线
  - 「通知一声就下线」= 事故，必须监控迁移进度
  - 破坏性变更要自动检测（OpenAPI diff），不能靠人 review
  rebuild: 用 SemVer 标识变更（MAJOR=破坏性，MINOR=新增兼容，PATCH=修复）。破坏性变更必须升 MAJOR 版本（v1→v2），旧版本保留过渡期。OpenAPI diff 在 CI 自动检测：新增字段/可选字段变更=兼容（绿灯），删字段/改类型/改必填=破坏性（红灯阻断）。废弃走完整流程：@Deprecated 标注 + Sunset Header（预告下线日期）→ 监控调用方迁移进度 → 主动联系未迁移者 → 灰度下线（先 5% 流量摘除，观察，再全下）。
follow_up:
  - SemVer 三段是什么？——MAJOR.MINOR.PATCH。MAJOR=破坏性变更，MINOR=向后兼容新增，PATCH=bug 修复
  - Sunset Header 是什么？——HTTP 标准草案，响应头里告知"这个 API/版本将在 X 日期下线"。调用方可读 Header 提前迁移
  - OpenAPI diff 怎么自动检测？——对比新旧 OpenAPI spec，新增端点/可选字段=兼容，删端点/改类型/加必填=破坏性。CI 阻断破坏性变更
  - 同时维护多个版本怎么办？——版本越多维护成本越高。原则：最多维护 2 个版本（N 和 N-1），用版本废弃流程压缩旧版本
  - "API 版本在 URL 还是 Header？——URL 版本（/v1/api）更直观、易路由、易缓存，业界主流。Header 版本（Accept: application/vnd.jd.v1+json）更 RESTful 但调试难"
memory_points:
  - SemVer：MAJOR（破坏性）.MINOR（新增兼容）.PATCH（修复）
  - 兼容性：新增可选字段兼容，删字段/改类型/改必填=破坏性
  - "@Deprecated + Sunset Header 通知废弃时间表"
  - OpenAPI diff CI 阻断破坏性变更
  - 废弃流程：Sunset 预告 → 监控迁移 → 联系未迁移者 → 灰度下线
---

# 【Java 后端架构师】平台 API 如何做版本兼容与废弃策略

> 适用场景：JD 核心技术。一个开放平台 API 被几百个外部商家调用，某天开发删了一个"废弃字段"，结果第二天 30% 商家下单失败。API 兼容性不是"我觉得没人用"，而是"用 SemVer + OpenAPI diff + Sunset Header + 监控迁移"的工程流程。

## 一、概念层：SemVer 与兼容性原则

### 1.1 语义化版本（SemVer）

SemVer（Semantic Versioning）用三段数字标识变更严重程度：

```
MAJOR.MINOR.PATCH
  1     .2    .3
  │      │     │
  │      │     └── PATCH：bug 修复，完全兼容（1.2.3 → 1.2.4）
  │      └──────── MINOR：新增功能，向后兼容（1.2.3 → 1.3.0）
  └─────────────── MAJOR：破坏性变更，不兼容（1.2.3 → 2.0.0）
```

| 变更类型 | 例子 | 版本升级 | 兼容性 |
|---------|------|---------|--------|
| 新增可选字段 | response 加 `couponInfo`（可选） | MINOR (1.2→1.3) | 向前兼容（旧客户端忽略新字段）|
| 新增端点 | 加 `GET /api/v1/orders/search` | MINOR | 兼容 |
| 删字段 | 删 response 的 `deprecatedField` | MAJOR (1.x→2.0) | 破坏性（旧客户端断）|
| 改字段类型 | `price` 从 int 改 string | MAJOR | 破坏性 |
| 加必填字段 | request 加 `userId`（必填） | MAJOR | 破坏性（旧客户端没传）|
| 改语义 | `status=1` 含义从"成功"改成"处理中" | MAJOR | 破坏性（最阴险）|

### 1.2 兼容性原则（向前 + 向后）

```
向前兼容（Forward Compatible）：新增不破坏旧客户端
  旧客户端调用新 API → 能正常工作（忽略新字段）
  实现：新增字段必须是可选（optional），不能加必填

向后兼容（Backward Compatible）：新客户端能用旧 API
  新客户端调用旧 API → 能正常工作（降级处理）
  实现：新功能在旧 API 不可用时降级

破坏性变更（Breaking Change）：必须升 MAJOR 版本
  - 删字段（response 少了字段，旧客户端解析崩）
  - 改字段类型（int→string，反序列化失败）
  - 加必填字段（旧客户端没传，校验失败）
  - 改语义（字段还在但含义变了，逻辑错误）
```

## 二、机制层：版本管理 + 自动检测 + 废弃流程

### 2.1 API 版本在 URL（业界主流）

```java
// Spring Boot 实现 URL 版本路由
@RestController
@RequestMapping("/api/v1/orders")
public class OrderControllerV1 {
    @GetMapping("/{id}")
    public OrderResponseV1 getOrder(@PathVariable Long id) {
        return orderService.queryV1(id);
    }
}

@RestController
@RequestMapping("/api/v2/orders")
public class OrderControllerV2 {
    @GetMapping("/{id}")
    public OrderResponseV2 getOrder(@PathVariable Long id) {
        return orderService.queryV2(id);  // V2 加了新字段
    }
}

// V1 的 response（旧）
public class OrderResponseV1 {
    private Long id;
    private BigDecimal amount;
    private String status;
}

// V2 的 response（新增 couponInfo 字段，向前兼容）
public class OrderResponseV2 {
    private Long id;
    private BigDecimal amount;
    private String status;
    private CouponInfo couponInfo;  // 新增，旧客户端忽略
}
```

**URL 版本 vs Header 版本**：
- URL 版本（`/api/v1/`）：直观、易路由（网关按 URL 路由）、易缓存（URL 是缓存 key）、调试方便（curl 直接测）。业界主流（GitHub/Twilio/Stripe 都用）
- Header 版本（`Accept: application/vnd.jd.v1+json`）：更 RESTful（URL 不变），但调试难、缓存复杂。适合 API 网关统一管理版本的场景

### 2.2 @Deprecated 标注废弃

```java
// 标注 V1 废弃
@RestController
@RequestMapping("/api/v1/orders")
public class OrderControllerV1 {
    
    @Deprecated  // Java 注解，IDE 会划掉调用
    @GetMapping("/{id}")
    @ResponseStatus(HttpStatus.OK)
    public OrderResponseV1 getOrder(
        @PathVariable Long id,
        HttpServletResponse response
    ) {
        // Sunset Header 通知下线时间（RFC 8594 草案）
        response.setHeader("Sunset", "Wed, 30 Sep 2026 00:00:00 GMT");
        response.setHeader("Link", "</api/v2/orders/{id}>; rel=\"successor-version\"");
        return orderService.queryV1(id);
    }
}
```

**Sunset Header 的价值**：调用方每次请求都收到"这个 API 什么时候下线"的信号。聪明的 SDK 会解析 Sunset Header 提前告警，不需要平台主动通知。这是"被动通知"的标准机制。

### 2.3 OpenAPI diff 自动检测破坏性变更（CI 阻断）

```yaml
# CI 流程：PR 提交时对比 OpenAPI spec
steps:
  - name: Generate OpenAPI spec
    run: ./gradlew generateOpenApiDocs -o openapi-new.yaml
  
  - name: OpenAPI diff check
    uses: OpenAPITools/openapi-diff@master
    with:
      old-spec: openapi-main.yaml        # 主分支的 spec
      new-spec: openapi-new.yaml         # PR 的 spec
      fail-on: breaking                  # 破坏性变更 fail
  
  # openapi-diff 输出：
  # - 新增端点/可选字段 → OK（兼容）
  # - 删端点/改类型/加必填 → ERROR（破坏性，CI fail）
```

**自动检测的价值**：破坏性变更不用人 review（容易漏），openapi-diff 自动识别。PR 合并前 CI 阻断——"你删了 `deprecatedField`，这是破坏性变更，必须：(1) 恢复字段，或 (2) 升 MAJOR 版本到 v2"。

```java
// openapi-diff 识别的破坏性变更示例
// ❌ 删 response 字段（破坏性）
public class OrderResponse {
    // private String deprecatedField;  // 删了 → CI fail
}

// ✅ 标注 @Deprecated 但保留（兼容）
public class OrderResponse {
    @Deprecated
    private String deprecatedField;  // 保留，标注废弃
}

// ✅ 新增可选字段（兼容）
public class OrderResponse {
    private String deprecatedField;
    private String newField;  // 新增，Jackson 默认忽略未知字段
}
```

### 2.4 废弃流程（不是通知一声就下线）

```
阶段 1: 废弃预告（Sunset Header + 文档）
  ┌─────────────────────────────────┐
  │ 在 V1 response 加 Sunset Header │
  │ Sunset: Wed, 30 Sep 2026 GMT    │
  │ 发布废弃公告（提前 6 个月）       │
  └─────────────────────────────────┘
                 │
                 ▼
阶段 2: 监控迁移进度（持续 3-6 个月）
  ┌─────────────────────────────────┐
  │ 监控 V1 调用量趋势               │
  │ 按调用方（appKey）统计谁还在用 V1 │
  │ 迁移进度看板：已迁移 X% / 未迁移 Y%│
  └─────────────────────────────────┘
                 │
                 ▼
阶段 3: 主动联系未迁移者（下线前 2 个月）
  ┌─────────────────────────────────┐
  │ 对未迁移的 appKey 发邮件/工单     │
  │ 提供迁移文档 + 技术支持           │
  │ 对重点客户（VIP 商家）1v1 对接    │
  └─────────────────────────────────┘
                 │
                 ▼
阶段 4: 灰度下线（下线月）
  ┌─────────────────────────────────┐
  │ 先摘 5% 流量（返回 410 Gone）     │
  │ 观察 1 周无问题 → 摘 50%          │
  │ 观察 1 周 → 摘 100%（完全下线）   │
  └─────────────────────────────────┘
                 │
                 ▼
阶段 5: 下线后观察（1 个月）
  ┌─────────────────────────────────┐
  │ 保留兜底（小流量还能用，返回警告） │
  │ 观察 1 个月无问题 → 物理删除      │
  └─────────────────────────────────┘
```

## 三、实战层：JD 开放平台 API 治理

### 3.1 API 变更评审 checklist

```markdown
# API 变更评审 checklist（每次 API 改动必过）

## 兼容性检查
- [ ] 新增字段是否都是可选（optional）？
- [ ] 是否删除/重命名了现有字段？（破坏性！）
- [ ] 是否修改了字段类型？（破坏性！）
- [ ] 是否加了必填字段？（破坏性！）
- [ ] 字段语义是否变化？（最阴险，需业务确认）

## 版本管理
- [ ] 破坏性变更是否升了 MAJOR 版本？
- [ ] 新版本是否和老版本并行（不是替换）？
- [ ] 新版本 URL 是否符合规范（/api/v2/）？

## 废弃流程（如果是废弃）
- [ ] 是否加了 @Deprecated 注解？
- [ ] 是否设置了 Sunset Header？
- [ ] 是否监控了调用方迁移进度？
- [ ] 是否联系了未迁移的重点客户？
- [ ] 是否走灰度下线（不是一刀切）？

## 文档与 SDK
- [ ] OpenAPI spec 是否更新？
- [ ] 变更日志（Changelog）是否发布？
- [ ] 官方 SDK 是否同步更新？
- [ ] 迁移指南是否提供？
```

### 3.2 API 监控看板（迁移追踪）

```markdown
# API 版本监控看板

## 版本分布（最近 30 天）
| 版本 | 日调用量 | 占比 | 趋势 | 调用方数 |
|------|---------|------|------|---------|
| v2 | 8,000w | 80% | ↑ | 450 |
| v1 | 2,000w | 20% | ↓ | 120 | ← 废弃中，需联系

## V1 未迁移调用方 Top 10（按调用量）
| appKey | 商家名 | 日调用量 | 联系状态 |
|--------|--------|---------|---------|
| ABC123 | XX旗舰店 | 50w | 已联系，迁移中 |
| DEF456 | YY超市 | 30w | 邮件未回复 |
| ... | ... | ... | ... |

## 迁移进度
- 已迁移：450 个调用方（80%）
- 未迁移：120 个（20%），其中 VIP 商家 5 个
- 预计下线日期：2026-09-30
- 风险：5 个 VIP 未迁移，需 1v1 对接
```

### 3.3 API 变更日志（Changelog）

```markdown
# API Changelog

## v2.3.0 (2026-07-13)
### Added（新增，兼容）
- `GET /api/v2/orders/{id}/coupon` 新增查询订单券信息端点
- OrderResponse 新增 `couponInfo` 字段（可选）

### Deprecated（废弃，仍可用）
- `OrderResponse.deprecatedField` 废弃，Sunset: 2026-09-30
  迁移到 `OrderResponse.newField`

## v2.0.0 (2026-06-01)
### Breaking（破坏性变更）
- `price` 字段类型从 int 改为 BigDecimal（精度提升）
- `status` 枚举值新增 `PROCESSING` 状态
- 迁移指南：https://open.jd.com/docs/migration-v2
```

## 四、底层本质：为什么 API 兼容性是平台的生命线

**API 是契约，契约的破坏就是事故**。开放平台的 API 被几百上千个外部系统调用，这些系统不受平台控制——你不能"通知一声就改"，因为调用方的迭代周期、发布节奏、技术栈都不同。破坏性变更会让调用方崩溃（下单失败、对账错误、数据丢失），直接造成商家经济损失和平台信誉崩塌。

**为什么 SemVer 是行业标准**：SemVer 把变更严重程度编码进版本号——MAJOR 变更=破坏性，调用方看到 MAJOR 升级就知道要评估兼容性。这是机器可读的契约（CI 可以解析版本号判断），让"破坏性变更"从模糊的"我觉得可能不兼容"变成明确的"MAJOR 升级=不兼容"。

**为什么 OpenAPI diff 比人 review 可靠**：人 review 会漏（"我以为删这个字段没人用"），openapi-diff 自动对比 spec，精确识别破坏性变更（删字段/改类型/加必填）。CI 阻断让破坏性变更无法无意中上线——这是工程保障，不是靠人的自觉。

**为什么废弃要走完整流程**：废弃不是"通知一声就下线"。调用方迁移需要时间（理解变更、改代码、测试、发布）。如果不给迁移时间，调用方会在下线当天崩溃。Sunset Header 是被动通知（每次请求都收到），监控迁移进度是主动追踪（知道谁还没迁），主动联系是兜底（重点客户 1v1）。灰度下线是最后一道保险（先摘 5%，观察，再放大）——即使迁移监控漏了，灰度下线也能在影响扩大前发现。

## 五、AI 架构师加问：5 个

1. **AI 怎么辅助 API 兼容性管理？**
   AI 负责 OpenAPI diff 自动归因（"这个破坏性变更是删了 OrderResponse.deprecatedField"）、迁移进度预测（"按当前迁移速度，9-30 前 V1 还有 5% 调用量，建议推迟下线或主动联系"）、迁移指南生成（从 V1/V2 spec diff 自动生成迁移文档）。决策（升不升 MAJOR、什么时候下线）在人。

2. **AI 能自动判断"这个变更是不是破坏性"？**
   能，且比人可靠。openapi-diff 是规则判断（删字段=破坏性），AI 补充语义判断（"字段名没变但含义变了"）。结合规则+语义双重检测。但 AI 判断结果仍需人确认（AI 可能误判）。

3. **AI 怎么帮调用方迁移？**
   AI 读取 V1→V2 的 spec diff + 调用方现有代码，生成迁移 PR 草稿（"你的代码用了 V1 的 deprecatedField，V2 改为 newField，这是修改建议"）。AI 辅助起草，调用方 review 合并。降低迁移人力成本。

4. **怎么用 AI 预测"哪些调用方不会按时迁移"？**
   历史数据训练：哪些调用方的历史迁移行为滞后（迭代慢、技术债重、无活跃 SDK 维护）。AI 综合调用方画像（公司规模/技术栈/历史迁移速度/当前 API 调用模式），预测迁移风险，平台提前对接高风险调用方。

5. **AI 时代的 API 设计有什么新挑战？**
   LLM Agent 调用 API 的比例上升，Agent 对 API 变更的"适应"和人类调用方不同——Agent 看到 Sunset Header 不会主动迁移，需要 SDK/工具层处理。API 设计要考虑机器可读（schema 清晰、错误码规范），Sunset 流程要兼顾 Agent 调用方（通过 SDK 强制升级而非靠人通知）。

## 六、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"SemVer、兼容原则、OpenAPI diff、Sunset、灰度下线"** 五个词。

- **SemVer**：MAJOR（破坏性）.MINOR（新增兼容）.PATCH（修复）
- **兼容原则**：新增可选字段兼容，删字段/改类型/加必填=破坏性
- **OpenAPI diff**：CI 自动检测破坏性变更，PR 阻断
- **Sunset**：Header 预告下线 + 监控迁移 + 联系未迁移者
- **灰度下线**：先 5% → 50% → 100%，不一刀切

### 拟人化理解

把 API 兼容性想成 **银行换卡**。银行不能"明天旧卡全失效"（客户买不了东西），而是"新卡发放 + 旧卡还能用 6 个月 + 短信通知 + 网点协助换卡 + 最后才注销旧卡"。API 版本兼容就是给调用方"迁移时间"（Sunset 预告）和"迁移信号"（监控+主动联系），最后"灰度下线"（先停 5% 观察）。

### 面试现场 60 秒回答

> API 版本兼容我用 SemVer——MAJOR（破坏性）/MINOR（新增兼容）/PATCH（修复）。破坏性变更（删字段/改类型/加必填）必须升 MAJOR 版本，新版本和旧版本并行。OpenAPI diff 在 CI 自动检测破坏性变更，PR 合并前阻断——不靠人 review。废弃走完整流程：@Deprecated 注解 + Sunset Header（预告下线日期，RFC 8594）→ 监控调用方迁移进度（按 appKey 统计谁还在用 V1）→ 主动联系未迁移的重点客户 → 灰度下线（先摘 5%，观察，再 50%，再 100%）。核心原则：API 是契约，破坏性变更就是事故。给调用方迁移时间（Sunset）和迁移信号（监控），不一刀切。

### 反问面试官

> 贵司 API 是开放平台（外部调用）还是内部服务？版本在 URL 还是 Header？有 OpenAPI spec 自动检测吗？这决定我推兼容性策略的强度——外部 API 要更严格的废弃流程和迁移监控。

## 七、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不所有变更都升 MAJOR 版本，最安全？ | MAJOR 版本越多维护成本越高（N 个版本并行）。新增字段、加端点这些兼容性变更没必要升 MAJOR，直接 MINOR。只有破坏性变更（删字段/改类型）才升 MAJOR。版本数控制在 2 个（N 和 N-1）|
| 证据追问 | 怎么证明这次变更是兼容的？ | OpenAPI diff 报告：新增端点/可选字段=兼容（绿灯），删字段/改类型=破坏性（红灯）。CI 通过即证明兼容。再配合自动化测试（旧客户端用旧 SDK 调新 API，断言不崩）|
| 边界追问 | 兼容性能保证 100% 不出事吗？ | 不能。兼容性是"字段层面"的（删字段检测得到），但"语义变更"（字段还在但含义变了）难检测。如 status=1 从"成功"改成"处理中"，类型没变但逻辑错了。这种要业务 review + Changelog 显式说明 |
| 反例追问 | 什么 API 不需要严格版本管理？ | 内部服务间调用（团队可控，发版同步改）。开放平台 API（外部调用方不受控）才需要严格版本。内部可以用 feature flag 灰度，不必 SemVer |
| 风险追问 | 废弃老版本最大的风险？ | 调用方没迁移就下线=事故。防法：Sunset Header 预告、监控迁移进度（按 appKey 统计）、主动联系未迁移者（特别是 VIP）、灰度下线（先 5% 摘流量观察）。绝不一刀切 |
| 验证追问 | 怎么证明废弃流程有效？ | 看迁移完成率（下线前应 95%+）、下线事故数（应为 0）、迁移周期（从废弃预告到下线的平均时长，应缩短）。如果下线前还有大量调用方，说明流程有问题（通知不到位/支持不够）|
| 沉淀追问 | 团队 API 规范沉淀什么？ | SemVer 规范、OpenAPI spec 模板、openapi-diff CI 配置、@Deprecated + Sunset Header 规范、废弃流程 Runbook、API Changelog 模板、迁移指南模板、调用方迁移监控看板 |

### 现场对话示例

**面试官**：你说 OpenAPI diff 自动检测，但"语义变更"（字段含义变了）怎么检测？

**候选人**：语义变更确实最难检测——字段名没变、类型没变，但含义变了（status=1 从"成功"变成"处理中"）。openapi-diff 检测不到（spec 没变）。三个补充机制：(1) 业务 review——API 变更评审时业务方确认语义；(2) Changelog 显式说明——"v2.0: status=1 含义从'成功'改为'处理中'"；(3) 枚举值变更走破坏性——新增枚举值是兼容的（旧客户端不识别新值会降级），但改枚举含义是破坏性的，必须升 MAJOR。这是最阴险的变更，要特别警惕。

**面试官**：调用方一直不迁移，怎么办？

**候选人**：分情况。如果是小调用方（调用量小、非核心），按公告时间下线，影响可承受。如果是 VIP（大商家、核心合作伙伴），不能硬下线——影响平台信誉。措施：(1) 1v1 技术对接，协助迁移；(2) 下线延期（VIP 没迁完就推迟下线日期）；(3) 兜底代理（平台侧把 V1 调用转 V2，让调用方无感）。核心是"不要用下线威胁调用方"，而是"帮助调用方迁移"。长期看，调用方迁移慢说明 API 设计/文档/SDK 有问题，要改进平台能力。

**面试官**：同时维护 V1/V2/V3 三个版本，运维成本太高怎么办？

**候选人**：原则：最多维护 2 个版本（N 和 N-1）。三个版本就太多了。压缩旧版本的方法：(1) 缩短废弃周期（从 6 个月降到 3 个月）；(2) 强制迁移条款（API 服务协议里写明"旧版本支持期 1 年，之后下线"）；(3) 内部统一适配层（V1/V2 在网关层转 V3，业务代码只维护 V3）。如果业务必须长期支持多版本（如金融行业合规要求），考虑"适配层"——业务代码只写最新版本，旧版本通过适配层转换，降低维护成本。

## 常见考点

1. **SemVer 三段是什么？**——MAJOR.MINOR.PATCH。MAJOR=破坏性变更（不兼容，调用方要改），MINOR=向后兼容新增（调用方无需改），PATCH=bug 修复（完全兼容）。业界标准，CI 可解析版本号判断变更严重度。
2. **什么是破坏性变更？**——删字段（response 少了字段，旧客户端解析崩）、改字段类型（int→string，反序列化失败）、加必填字段（旧客户端没传，校验失败）、改语义（字段含义变了，逻辑错误）。必须升 MAJOR 版本。
3. **Sunset Header 是什么？**——HTTP 标准草案（RFC 8594），response 头告知"这个 API/版本将在 X 日期下线"。调用方每次请求都收到信号，可提前迁移。是废弃流程的被动通知机制。
4. **OpenAPI diff 怎么用？**——CI 对比主分支和 PR 的 OpenAPI spec，自动识别破坏性变更（删字段/改类型/加必填）。破坏性变更 PR 合并被阻断，强制开发者升 MAJOR 版本或恢复字段。比人 review 可靠（不漏）。
5. **废弃流程怎么走？**——(1) @Deprecated 注解 + Sunset Header 预告（提前 6 个月）；(2) 监控调用方迁移进度（按 appKey 统计）；(3) 主动联系未迁移者（VIP 1v1）；(4) 灰度下线（5%→50%→100%，不一刀切）；(5) 下线后观察 1 个月再物理删除。

## 结构化回答

**30 秒电梯演讲：** API 版本兼容的核心是向前兼容（新增不破坏旧客户端）+ 向后兼容（新客户端能用旧 API）。机制上用语义化版本（SemVer）+ Sunset Header + @Deprecated 渐进废弃 + OpenAPI diff 自动检测破坏性变更。废弃不是通知一声就下线，而是Sunset Header 预告 → 监控调用方迁移 → 联系未迁移者 → 灰度下线的完整流程，否则就是事故

**展开框架：**
1. **语义化版本（SemVer）** — MAJOR.MINOR.PATCH，MAJOR 变更=破坏性
2. **兼容性原则** — 新增字段兼容（可选）、删字段/改类型不兼容（要新版本）
3. **@Deprecated** — "@Deprecated 标注 + Sunset Header 通知废弃时间表"

**收尾：** 以上是我的整体思路。您想继续深入聊——SemVer 三段是什么？


## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：平台 API 如何做版本兼容与废弃策略 | "这题一句话：API 版本兼容的核心是向前兼容（新增不破坏旧客户端）+ 向后兼容（新客户端能用旧 API）。" | 开场钩子 |
| 0:15 | 语义化版本（SemVer）示意/对比图 | "MAJOR.MINOR.PATCH，MAJOR 变更=破坏性" | 语义化版本（SemVer）要点 |
| 0:40 | 兼容性原则示意/对比图 | "新增字段兼容（可选）、删字段/改类型不兼容（要新版本）" | 兼容性原则要点 |
| 1:25 | 总结卡 | "记住：SemVer。下期见。" | 收尾 |
