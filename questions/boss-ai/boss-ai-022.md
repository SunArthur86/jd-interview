---
id: boss-ai-022
difficulty: L3
category: boss-ai
subcategory: LLM 接入工程
tags:
- 巨剧核
- AI 陪伴
- LLM 接入工程
- 多模型 SDK
- 统一接口
- 错误处理
feynman:
  essence: "LLM 接入工程化是把'直接调某家 API'升级为'统一抽象 + 多模型适配 + 健壮错误处理 + 可观测'的 SDK 层，让上层业务不感知模型差异，模型可热切换。"
  analogy: "像一个万能充电转接头——不同手机厂商充电协议不同（OpenAI/通义/Claude），转接头统一接口输出标准电，手机不用关心背后是哪家电，还能自动切到能充的那家。"
  first_principle: "不同 LLM 厂商 API 协议、参数、能力、计费各不相同，业务直接对接 = 强耦合、难切换、难统一治理。必须抽象统一 SDK 层，让上层只面对标准接口，下层适配各家。"
  key_points:
  - "统一抽象：消息/调用/流式/工具调用/嵌入的标准化接口"
  - "适配器：每家厂商一个 adapter，转协议"
  - "错误处理：超时/限流/失败/fallback，业务无感"
  - "可观测：调用日志/成本归因/质量监控"
  - "特性差异化：标记各模型特有能力，业务可查询"
  socratic:
  - "业务代码直接调 OpenAI SDK，过两个月要换成 Claude，要改多少代码？"
  - "不同模型的流式输出格式不一样，怎么给业务统一接口？"
  - "OpenAI 突然挂了，业务直接报错崩溃，怎么让业务无感切换？"
  - "Claude 支持 100k 上下文，GPT-4 只支持 8k，统一接口怎么体现这种差异？"
  - "怎么知道这次调用花了多少钱、用了多久、哪家模型？业务看得到吗？"
first_principle:
  problem: "如何让上层业务摆脱对具体 LLM 厂商的耦合，用统一接口调多模型，并具备错误恢复、可观测、可治理能力？"
  axioms:
  - "不同厂商 API 协议/能力/计费差异巨大"
  - "业务直接对接 = 强耦合，难切换难治理"
  - "模型会挂、会变、会出新，业务不能每次改代码"
  rebuild: "抽象统一 LLM 网关/SDK 层：标准接口（消息/流式/工具/嵌入）+ 多家适配器 + 错误处理（fallback）+ 可观测（成本/质量/调用），上层业务只对接标准接口，下层模型可热切换。"
follow_up:
- "工具调用接口怎么统一？——OpenAI function calling、Claude tools、通义 plugins 协议不同；统一抽象成 tools 字段，adapter 做协议转换。"
- "流式输出怎么统一？——定义标准 chunk 流（delta + role + finish_reason），各家 adapter 把自家流格式转成标准流。"
- "自部署模型怎么接？——vLLM/TGI 提供 OpenAI 兼容 API，可直接用 OpenAI adapter；非兼容的要单独 adapter。"
memory_points:
- "统一接口：消息/流式/工具/嵌入"
- "适配器：每家厂商一个"
- "fallback：业务无感切换"
- "可观测：成本/质量/调用"
---

# 【巨剧核 AI 陪伴】LLM 接入工程化怎么做（统一接口/多模型/错误处理）？

> JD 依据："熟悉 LLM 接入、多模型 SDK；多模型编排经验。"

## 一、为什么需要工程化

```
裸做法（业务直接调厂商 SDK）：
  - 业务代码里出现 OpenAI SDK 调用
  - 换 Claude 要改业务代码
  - 每家协议不一样（消息格式/流式/工具/计费）
  - 错误处理散落各处
  - 没有统一监控和成本归因

问题：强耦合、难切换、难治理
```

工程化目标：业务面对**统一接口**，模型层可热切换、可治理。

## 二、统一抽象

```python
class LLMClient:
    def chat(messages: list[Message], **opts) -> ChatResponse
    def stream_chat(messages: list[Message], **opts) -> Iterator[Chunk]
    def embed(text: str) -> list[float]
    def tool_call(messages, tools) -> ToolCallResult

Message = { role: "system|user|assistant|tool", content, tool_calls, ... }
ChatResponse = { content, tool_calls, usage, finish_reason, ... }
Chunk = { delta, finish_reason, ... }
```

业务只面对这些标准类型。

## 三、适配器（Adapter）

```
LLMClient 接口
   ├─ OpenAIAdapter     （调 OpenAI/GPT）
   ├─ ClaudeAdapter     （调 Claude）
   ├─ QwenAdapter       （调通义千问）
   ├─ WenxinAdapter     （调文心）
   ├─ VLLMAdapter       （调自部署 vLLM）
   └─ ...

每个 adapter 职责：
  - 把标准 Message 转成该厂商格式
  - 调用该厂商 API
  - 把响应/流式转回标准格式
  - 处理该厂商特有错误码
```

加新模型 = 加一个 adapter，业务代码零改动。

## 四、特性差异化处理

不同模型能力不同，统一接口怎么体现？

```
方案 1：能力标记
  client.capabilities(model) → { max_tokens, supports_tools, supports_vision, supports_stream, ... }
  业务按能力查询，选择调用方式

方案 2：分级接口
  基础接口：所有模型都支持（chat）
  扩展接口：可选（vision / tool_call / long_context）
  业务可降级处理（不支持就用替代方案）

方案 3：参数标准化
  temperature/max_tokens 标准化（不同厂商范围不同，adapter 转换）
```

## 五、错误处理

```
LLMClient 内置（业务无感）：
  - 超时：连接/读取分级
  - 重试：幂等 + 指数退避 + 上限
  - 限流：429 自动退避重试
  - fallback：主失败切备（按 fallback 链）
  - 熔断：错误率超阈值快速失败

业务可见：
  - 最终错误（fallback 全失败）→ 业务降级
  - 标准错误码（统一各家厂商错误码）
```

## 六、可观测

每次调用埋点：
```
{
  trace_id, user_id, role_id,
  provider, model,
  prompt_tokens, completion_tokens,
  latency, cost,
  status, error,
  tool_calls, audit_result,
  prompt_version
}
```

衍生报表：
- 各模型成本占比
- 错误率/延迟分布
- 路由命中率
- 质量回归（A/B）

## 七、配置与治理

```
模型注册表（配置中心）：
  gpt-4o:
    provider: openai
    api_key: ${SECRET}
    capabilities: {vision, tools, 128k_context}
    cost: {input: 5/1M, output: 15/1M}
    rate_limit: 1000 rpm
  claude-sonnet:
    ...

路由策略：
  - 默认按业务场景选模型
  - 灰度切换（新模型先 10% 流量）
  - 故障切换（熔断后切）
  - 成本控制（超预算切便宜）

热更新：配置改了不用发版
```

## 八、工具调用统一

各家工具调用协议不同：
```
OpenAI: function calling（functions 参数）
Claude: tools 字段（不同格式）
通义: plugins
```

统一抽象：
```python
tools = [
  { name: "weather", description: "...", parameters: {...} }
]
result = client.tool_call(messages, tools)
# result.tool_calls = [{ name, args }]
# 业务执行后，结果回填继续对话
```

adapter 做协议转换，业务面对统一格式。

## 九、底层本质

LLM 接入工程化的本质是**"用抽象层隔离业务和模型，让模型成为可替换、可治理、可观测的资源"**：

- 统一接口 = 业务解耦
- 适配器 = 模型可换
- 错误处理 = 业务无感
- 可观测 = 可治理
- 配置化 = 可热切

这是把'调 API'升级为'运营模型资源池'——是 AI 工程的基础设施。这也是 LangChain/LiteLLM/自研 LLM Gateway 的共同价值。

## 常见考点

1. **统一接口会不会丢功能？**——基础不丢（chat/stream/tool/embed 通用）；特有功能用扩展接口（如 Claude 的 prompt caching 单独 API）；要在抽象充分和实用性间平衡。
2. **LiteLLM/LangChain vs 自研？**——LiteLLM 适合快速起步（多模型统一）；LangChain 偏编排；深度定制（路由/审核/计费/合规）自研 LLM Gateway，大厂多自研。
3. **怎么测 adapter 正确性？**——契约测试（标准输入→预期标准输出）+ 各厂商真实 API 集成测试 + 回归测试（接入新模型不破坏现有）。


## 结构化回答

**30 秒电梯演讲：** 聊到LLM 接入工程化怎么做（统一接口/多模型/错误处理），我的理解是——LLM 接入工程化是把'直接调某家 API'升级为'统一抽象 + 多模型适配 + 健壮错误处理 + 可观测'的 SDK 层，让上层业务不感知模型差异，模型可热切换。打个比方，像一个万能充电转接头——不同手机厂商充电协议不同（OpenAI/通义/Claude），转接头统一接口输出标准电，手机不用关心背后是哪家电，还能自动切到能充的那家。

**展开框架：**
1. **统一抽象** — 消息/调用/流式/工具调用/嵌入的标准化接口
2. **适配器** — 每家厂商一个 adapter，转协议
3. **错误处理** — 超时/限流/失败/fallback，业务无感

**收尾：** 这块我在项目里也踩过坑——想深入的话，可以接着聊：工具调用接口怎么统一？您更想看哪个方向？

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡 | "LLM 接入工程化怎么做（统一接口/多模型/错误处理）——这道题面试官到底想考什么？我用 30 秒给你讲透。" | 开场钩子 |
| 0:15 | 模型训练流程图 | 先说核心：LLM 接入工程化是把'直接调某家 API'升级为'统一抽象 + 多模型适配 + 健壮错误处理 + 可观测'的 SDK 层，让上层业务不感知模型差异，模型可热切换。 | 核心定义 |
| 0:40 | 概念结构示意图 | 每家厂商一个 adapter，转协议。 | 适配器 |
| 1:05 | 流程图 | 超时/限流/失败/fallback，业务无感。 | 错误处理 |
| 2:30 | 总结卡 | 一句话记忆：统一接口：消息/流式/工具/嵌入。 下期可以接着聊：工具调用接口怎么统一。 | 收尾总结 |
