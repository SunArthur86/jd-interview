---
id: biopharm-009
difficulty: L3
category: biopharm
subcategory: API 服务
tags:
- 生物医药
- AI 全栈
- API 服务
- RESTful
- 流式
- 限流
- 鉴权
feynman:
  essence: "AI 产品的 API 工程本质是'把模型能力变成可被业务调用的标准服务'——RESTful 设计 + 流式响应 + 鉴权限流 + 版本管理 + 可观测，让 AI 像普通后端服务一样可靠可治理。"
  analogy: "像自来水公司——水源（模型）再好，也要经过水厂（API 网关）净化、计量（鉴权限流）、管网（路由）、水表（监控），用户拧龙头（API）才能稳定出可饮用水。AI API 就是这层'水厂'。"
  first_principle: "LLM 是无状态、慢响应、贵、会出错的生成器。要被企业系统稳定调用，必须用 API 工程把它包装成：有契约（RESTful）、能流式（低延迟体感）、可控（鉴权限流）、可演进（版本）、可观测（监控）的标准服务。"
  key_points:
  - "RESTful 设计：资源化 URL + 语义化 HTTP 方法 + 状态码"
  - "流式响应（SSE/WebSocket）：LLM 边生成边返回，首字延迟低"
  - "鉴权限流：API Key/OAuth + 按租户/模型限流 + 配额"
  - "异步任务 API：长任务提交 task_id + 轮询/Webhook 取结果"
  - "版本与契约：API 版本化 + OpenAPI 文档 + 向后兼容"
  socratic:
  - "直接把 LLM 的 SDK 暴露给业务方调用，会有什么问题？"
  - "LLM 生成一个完整答案要 10 秒，用户盯着空白页等，体验怎么救？"
  - "一个租户突然狂调你的 API，把 GPU 占满，怎么办？"
  - "一个文档解析任务要跑 5 分钟，HTTP 请求挂 5 分钟合理吗？"
  - "API 改了字段，老客户端全报错，怎么避免？"
first_principle:
  problem: "如何把无状态、慢、贵、会出错的 LLM 包装成企业可稳定调用的标准 API 服务？"
  axioms:
  - "LLM 慢响应（秒级）、贵、可能失败"
  - "企业调用要求契约稳定、可控、可观测、可演进"
  - "多租户共享资源必须隔离和限流"
  rebuild: "用 RESTful 设计定契约，SSE/WebSocket 流式降低体感延迟，鉴权限流控成本防滥用，异步任务 API 承载长任务，版本化保证演进兼容，把 LLM 包装成标准可治理服务。"
follow_up:
- "SSE 和 WebSocket 怎么选？——SSE 单向服务器推送够用（LLM 流式输出）、轻；WebSocket 双向（多轮交互/工具中间态），重。AI 流式首选 SSE。"
- "限流算法？——令牌桶（允许突发）/漏桶（匀速）/滑动窗口（精准）；多租户按 key 限流 + 全局熔断。"
- "API 版本怎么管？——URL 版本（/v1/）/Header 版本，废弃策略（旧版 N 个月后下线+提前通知）。"
memory_points:
- "RESTful 契约 + 流式（SSE）体感"
- "鉴权限流控成本防滥用"
- "长任务用异步 API（task_id+轮询/Webhook）"
- "版本化保兼容，OpenAPI 定契约"
---

# 【生物医药 AI】AI 产品的 RESTful API 服务怎么设计？

> JD 依据："AI 产品前后端开发：API 服务；RESTful API、异步编程。"

## 一、为什么 AI 需要专门 API 工程

```
裸暴露 LLM SDK：
  - 无契约（参数随便变）
  - 慢（业务方同步等 10 秒）
  - 无限流（一个租户打爆全局）
  - 无鉴权（谁都能调）
  - 不可观测（出问题查不到）

→ 用 API 工程包装成标准服务
```

## 二、RESTful 设计（契约）

```
POST   /v1/chat/completions      创建对话（流式/非流式）
GET    /v1/knowledgebases/{id}   查知识库
POST   /v1/agents/{id}/run       启动 Agent
GET    /v1/tasks/{id}            查异步任务状态
DELETE/v1/documents/{id}         删除文档
```
- 资源化 URL + 语义化方法（GET/POST/PUT/DELETE）。
- 标准状态码（200/201/202/400/401/429/500）。
- OpenAPI/Swagger 文档化，自动生成 SDK。

## 三、流式响应（体感关键）

LLM 完整答案要 5-10 秒，同步等体验差。**SSE 流式**：
```
POST /v1/chat/completions  {stream: true}

data: {"delta": "阿"}      ← 首字 200ms 返回
data: {"delta": "司"}
data: {"delta": "匹林"}
data: [DONE]
```
- **首字延迟**从 10 秒降到 200ms，体感质的飞跃。
- SSE（Server-Sent Events）单向推送，够用且轻；多轮交互用 WebSocket。

## 四、异步任务 API（长任务）

```
POST /v1/documents/parse        → 202 Accepted {task_id: "..."}
GET  /v1/tasks/{task_id}        → {status: "running"/"done", result: ...}
Webhook 回调：done 后 POST 业务方 callback_url
```
- 文档解析、批量推理、训练等长任务用异步。
- 前端轮询或 Webhook 取结果，不阻塞 HTTP。

## 五、鉴权与限流

### 鉴权
```
Authorization: Bearer {api_key}
  → 识别租户/用户 → 权限校验 → 配额检查
```
- API Key / OAuth2 / JWT。
- 按租户隔离数据和模型权限。

### 限流
```
租户级：每分钟 100 次（令牌桶）
模型级：GPU 推理并发上限
全局：熔断保护
超限 → 429 Too Many Requests + Retry-After
```
- 多租户公平性 + 防 GPU 被打爆。

## 六、版本与演进

- URL 版本（`/v1/` `/v2/`）隔离破坏性变更。
- 向后兼容：新字段可选、旧字段保留。
- 废弃策略：旧版标记 deprecated → 通知 → N 月后下线。

## 七、错误处理与可观测

- **统一错误格式**：`{code, message, request_id}`，便于排查。
- **request_id 全链路追踪**：从 API → Agent → 工具 → 模型，串起来。
- **监控**：QPS、P99 延迟、错误率、token 消耗、限流命中、队列堆积。

## 八、完整 API 请求生命周期

```
请求 → [鉴权] → [限流/配额] → [路由/模型选择] → [执行（检索/工具/LLM）]
     → [流式/异步返回] → [日志/计量] → [监控]
```

## 九、底层本质

AI API 工程本质是**"把模型能力工程化为可被企业可靠调用的服务"**。RESTful 定契约，流式优体感，鉴权限流控风险，异步承载长任务，版本保演进，可观测保治理。

**模型决定能力，API 工程决定能不能被企业用起来** —— 很多团队能调通 LLM，但做不出一个企业敢接的 API 服务，差距就在这层工程。

## 常见考点

1. **SSE 流式怎么实现？**——后端用 StreamingResponse（FastAPI）持续 yield chunk，Content-Type: text/event-stream；注意反向代理别 buffer（X-Accel-Buffering: no）。
2. **怎么计量计费？**——按 token（输入+输出）+ 请求次数 + 存储用量，记录到计量表，按周期出账；流式按累计 token。
3. **API 幂等怎么做？**——客户端传 Idempotency-Key，服务端去重，避免重试导致重复扣费/重复执行。


## 结构化回答

**30 秒电梯演讲：** 聊到AI 产品的 RESTful API 服务怎么设计，我的理解是——AI 产品的 API 工程本质是'把模型能力变成可被业务调用的标准服务'——RESTful 设计 + 流式响应 + 鉴权限流 + 版本管理 + 可观测，让 AI 像普通后端服务一样可靠可治理。打个比方，像自来水公司——水源（模型）再好，也要经过水厂（API 网关）净化、计量（鉴权限流）、管网（路由）、水表（监控），用户拧龙头（API）才能稳定出可饮用水。AI API 就是这层'水厂'。

**展开框架：**
1. **RESTful 设计** — 资源化 URL + 语义化 HTTP 方法 + 状态码
2. **流式响应（SSE/WebSocket）** — LLM 边生成边返回，首字延迟低
3. **鉴权限流** — API Key/OAuth + 按租户/模型限流 + 配额

**收尾：** 这块我在项目里也踩过坑——想深入的话，可以接着聊：SSE 和 WebSocket 怎么选？您更想看哪个方向？

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡 | "AI 产品的 RESTful API 服务怎么设计——这道题面试官到底想考什么？我用 30 秒给你讲透。" | 开场钩子 |
| 0:15 | 限流算法对比图 | 先说核心：AI 产品的 API 工程本质是'把模型能力变成可被业务调用的标准服务'——RESTful 设计 + 流式响应 + 鉴权限流 + 版本管理 + 可观测，让 AI 像普通后端服务。 | 核心定义 |
| 0:40 | Elasticsearch 倒排索引图 | LLM 边生成边返回，首字延迟低。 | 流式响应（SSE/WebSocket） |
| 1:05 | 概念结构示意图 | API Key/OAuth + 按租户/模型限流 + 配额。 | 鉴权限流 |
| 2:30 | 总结卡 | 一句话记忆：RESTful 契约 + 流式（SSE）体感。 下期可以接着聊：SSE 和 WebSocket 怎么选。 | 收尾总结 |
