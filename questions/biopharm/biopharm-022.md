---
id: biopharm-022
difficulty: L3
category: biopharm
subcategory: LLM 接入工程
tags:
- 生物医药
- AI 全栈
- LLM 接入工程
- 多模型 SDK
- 错误处理
- 重试
- 统一接口
feynman:
  essence: "LLM 应用工程化是'把 N 个模型的差异屏蔽成一个统一接口'——多模型 SDK 统一协议、错误分类处理、退避重试、fallback 切换、可观测计量，让上层像用一个模型一样用所有模型。"
  analogy: "像万能充电器——不同手机（模型）充电口不同（协议不同），万能充电器（统一 SDK）一转，用户只管插一个口。偶尔停电（错误）有备用电源（fallback），电压不稳（限流）自动调。"
  first_principle: "各模型 API 协议、参数、错误码、限流策略都不同，若业务直连各家，会写成 N 套适配、改一处动全身。LLM 接入工程化的本质是'把异构模型的差异收敛到统一 SDK，让上层无感切换'，同时提供可靠性（错误处理/重试/fallback）和可观测性。"
  key_points:
  - "统一接口：OpenAI 兼容协议 + 适配各供应商"
  - "错误分类：可重试（超时/限流）/不可重试（参数错/鉴权）"
  - "重试策略：指数退避+抖动+上限+幂等"
  - "fallback：主模型挂自动切备模型，对上层透明"
  - "可观测与计量：每次调用记录模型/token/耗时/费用"
  socratic:
  - "业务代码里到处是 if openai else if 通义 else if 文心，有什么问题？"
  - "不同模型的错误码都不一样，怎么统一处理？"
  - "LLM 调用偶尔超时，是该重试还是放弃？怎么决定？"
  - "OpenAI 突然挂了，业务还在调，怎么不让用户感知到？"
  - "怎么知道每个模型的实际耗时和成本，做优化决策？"
first_principle:
  problem: "如何屏蔽多模型异构性，提供统一、可靠、可观测的 LLM 接入层？"
  axioms:
  - "各模型 API/参数/错误/限流各异"
  - "业务直连会导致 N 套适配、强耦合"
  - "模型会挂/限流，需可靠性和 fallback"
  rebuild: "建统一 SDK——OpenAI 兼容协议屏蔽差异、错误分类决定重试与否、退避重试抗抖动、fallback 链容灾、全调用计量可观测，让上层用一个接口透明用所有模型。"
follow_up:
- "怎么统一不同模型的参数？——抽 common params（messages/temperature/max_tokens/stream）+ extra_args 透传特有参数；能力差异用 capability flag 标注。"
- "流式怎么 fallback？——流式中途断切模型，重新生成（用户可能感知到重头）；或预先双发取先到。"
- "怎么选开源网关？——LiteLLM（Python/多供应商）/ one-api（Go/中文社区），或自研；按栈和定制需求选。"
memory_points:
- "统一接口（OpenAI 兼容）屏蔽异构"
- "错误分类：可重试 vs 不可重试"
- "退避重试 + fallback 容灾"
- "全调用计量可观测"
---

# 【生物医药 AI】LLM 应用怎么工程化接入（多模型 SDK/错误处理/重试）？

> JD 依据："LLM 应用开发；AI 产品前后端开发：多模型路由、缓存。"

## 一、为什么要统一 SDK

```
直连各模型：
  if provider == "openai": resp = openai.chat(...)
  elif provider == "qwen": resp = dashscope.call(...)
  elif provider == "wenxin": resp = qianfan.chat(...)
  → N 套适配、强耦合、改协议全改、无统一可靠性

统一 SDK：
  resp = llm.chat(messages, model="auto")  # SDK 内部路由+适配+容灾
```

## 二、统一接口设计

```python
class UnifiedLLM:
    def chat(self, messages, model, temperature, stream=False, **extra):
        provider = self._route(model)        # 路由到供应商
        adapter = self._adapters[provider]    # 选适配器
        resp = self._call_with_resilience(adapter, ...)
        return resp
```
- **OpenAI 兼容协议**（chat/completions/embeddings）作通用契约。
- 每个供应商写 adapter 适配差异（参数名/流式格式/工具调用格式）。
- 能力差异用 capability flag（如是否支持 tool/vision/json_mode）。

## 三、错误分类与处理

```python
class LLMError:
    RETRYABLE = [Timeout, RateLimit, ServiceUnavailable, ConnectionError]
    FATAL = [InvalidParam, AuthFailed, ContentFilter]

def handle(error):
    if error in RETRYABLE:
        return retry_or_fallback()
    if error in FATAL:
        return fail_fast()  # 不重试，直接报错
```
| 类型 | 例子 | 处理 |
|------|------|------|
| 可重试 | 超时/限流/5xx | 退避重试或 fallback |
| 不可重试 | 参数错/鉴权失败/内容审核 | 立即失败，修正后重试 |

## 四、重试策略

```python
def call_with_retry(adapter, req, max_retry=3):
    for i in range(max_retry):
        try:
            return adapter.call(req)
        except RETRYABLE as e:
            delay = min(2**i + random(), 30)  # 指数退避+抖动+上限
            sleep(delay)
    raise  # 重试用尽 → fallback
```
- **指数退避**：1s,2s,4s...（给下游恢复）。
- **随机抖动**：防重试风暴。
- **上限**：不无限重试。
- **幂等**：重试带 request_id 防重复扣费。

## 五、fallback 链（容灾）

```python
def call_with_fallback(req):
    chain = ["claude", "gpt-4o", "qwen-max", "local-7b"]
    for model in chain:
        try:
            return call_with_retry(model, req)
        except AllRetryExhausted:
            continue
    return rule_based_fallback()  # 兜底规则回复
```
- 主模型挂 → 备 → 自部署 → 规则兜底。
- 对上层透明，业务无感知。

## 六、可观测与计量

```python
log_every_call(
    request_id, model, provider,
    input_tokens, output_tokens, latency_ms,
    cost, status, retry_count, fallback_chain
)
```
- 每次调用全记录 → 监控/计费/优化依据。
- 按 [模型][租户][场景] 聚合统计。

## 七、流式处理

```
流式响应统一格式：
  data: {"delta": "..."}  （SSE）
不同供应商流式 chunk 格式不同 → adapter 归一化
流式中断 → 重连或 fallback 重新生成
```

## 八、工具调用归一化

```
不同模型 tool calling 格式不同（OpenAI function/Anthropic tool/Claude xml）
→ adapter 归一化为统一 schema：
  tools: [{name, description, parameters}]
  model 返回：{name, arguments}
统一后上层逻辑一套。
```

## 九、底层本质

LLM 接入工程化本质是**"把多模型异构性收敛成统一、可靠、可观测的接入层"**。统一协议屏蔽差异，错误分类决定重试，退避重试抗抖动，fallback 容灾，计量可观测。

**这是 AI 应用从'能调通'到'可规模化运维'的基础** —— 没有这层，每加一个模型、每次供应商抖动都是事故。

## 常见考点

1. **重试和 fallback 什么时候用？**——可重试错误（瞬时）先退避重试同模型；重试用尽或非瞬时错误走 fallback 切模型；不可重试错误（参数错）立即失败。
2. **怎么统一各模型能力差异？**——capability flag 标注（tool/vision/json），SDK 暴露能力查询，上层按能力选模型；不支持的能力自动 fallback 到支持的。
3. **怎么避免重复扣费？**——幂等键（request_id）+ 供应商侧幂等 + 重试前查是否已成功；计量以供应商返回的实际 token 为准。


## 结构化回答

**30 秒电梯演讲：** 聊到LLM 应用怎么工程化接入（多模型 SDK/错误处理/重试），我的理解是——LLM 应用工程化是'把 N 个模型的差异屏蔽成一个统一接口'——多模型 SDK 统一协议、错误分类处理、退避重试、fallback 切换、可观测计量，让上层像用一个模型一样用所有模型。打个比方，像万能充电器——不同手机（模型）充电口不同（协议不同），万能充电器（统一 SDK）一转，用户只管插一个口。偶尔停电（错误）有备用电源（fallback），电压不稳（限流）自动调。

**展开框架：**
1. **统一接口** — OpenAI 兼容协议 + 适配各供应商
2. **错误分类** — 可重试（超时/限流）/不可重试（参数错/鉴权）
3. **重试策略** — 指数退避+抖动+上限+幂等

**收尾：** 这块我在项目里也踩过坑——想深入的话，可以接着聊：怎么统一不同模型的参数？您更想看哪个方向？

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡 | "LLM 应用怎么工程化接入——这道题面试官到底想考什么？我用 30 秒给你讲透。" | 开场钩子 |
| 0:15 | 模型训练流程图 | 先说核心：LLM 应用工程化是'把 N 个模型的差异屏蔽成一个统一接口'——多模型 SDK 统一协议、错误分类处理、退避重试、fallback 切换、可观测计量，让上层像用一个模型一样用。 | 核心定义 |
| 0:40 | 概念结构示意图 | 可重试（超时/限流）/不可重试（参数错/鉴权）。 | 错误分类 |
| 1:05 | 流程图 | 指数退避+抖动+上限+幂等。 | 重试策略 |
| 2:30 | 总结卡 | 一句话记忆：统一接口（OpenAI 兼容）屏蔽异构。 下期可以接着聊：怎么统一不同模型的参数。 | 收尾总结 |
