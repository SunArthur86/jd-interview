---
id: pdd-trade-031
difficulty: L4
category: pdd-trade
subcategory: Agent 改造
tags:
- 拼多多
- 交易
- AI Agent
- LLM
- 工程化
feynman:
  essence: 用 AI Agent 改造交易系统是"把规则硬编码的业务决策换成 LLM 推理+工具调用"——客服/退款/异常处置等长尾场景用 Agent 自主决策，核心交易仍走规则保证确定性和性能。
  analogy: 像客服升级——传统是 IVR 按键（规则），AI Agent 是真人助理（理解+调用工具），但收银台（核心交易）还是 POS 机（确定性）。
  first_principle: 规则能覆盖标准路径，长尾场景（用户咨询/异常订单/复杂退款）靠人，Agent 把 LLM 理解+工具调用自动化长尾。
  key_points:
  - 分层：核心交易走规则（确定性），边缘长尾走 Agent（灵活）
  - Agent = LLM + 工具（查订单/退款/发券）+ 记忆
  - 安全：人工兜底+审计日志+额度限制
  - 落地：客服/退款审核/异常处置优先
first_principle:
  problem: 交易系统有大量长尾场景靠人工，如何用 AI 自动化又不影响核心确定性？
  axioms:
  - 核心交易需确定性（不能 LLM 幻觉）
  - 长尾场景灵活（规则难穷举）
  - LLM 有幻觉风险
  rebuild: 分层架构——核心规则化，长尾 Agent 化，Agent 受工具+额度+人工兜底约束。
follow_up:
  - Agent 怎么调交易系统？——Function Calling，封装 API 为 tool（查订单/退款）
  - Agent 幻觉怎么办？——工具校验+额度限制+人工审核高额
  - 核心交易能用 Agent 吗？——不建议，性能（秒级）和确定性（不能错）不满足
memory_points:
  - 分层：核心规则化，长尾 Agent 化
  - Agent = LLM + 工具 + 记忆
  - 安全：工具校验+额度+人工兜底
  - 落地优先：客服/退款/异常处置
---

# 【拼多多交易】用 AI Agent 怎么改造交易系统？

> JD 依据："用 AI Agent 改造交易系统"。

## 一、分层改造策略

```
核心交易（下单/支付/库存）→ 保持规则化（确定性、性能）
长尾场景（客服/退款/异常）→ Agent 化（灵活、自动化）
```

| 场景 | 传统 | Agent 化 | 收益 |
|------|------|----------|------|
| 客服咨询 | IVR/人工 | LLM 对话+查单工具 | 人力降 60% |
| 退款审核 | 人工审 | Agent 审+人工复核高额 | 处理提速 10x |
| 异常订单 | 人工排查 | Agent 自主查+处置 | MTTR 降 70% |
| 风控复核 | 人工 | Agent 辅助 | 效率提升 |

## 二、Agent 架构

```
用户输入 → LLM（推理）→ Function Call（调工具）→ 结果 → LLM 总结 → 输出
            ↑                                              ↓
            └──── 记忆（对话历史/用户画像）←──────────────┘
```

**工具定义**（封装交易 API）：
```java
@Tool(name = "queryOrder", desc = "查询用户订单状态")
public Order queryOrder(@Param("orderId") Long id) {
    return orderService.get(id);
}

@Tool(name = "refundOrder", desc = "退款，需额度校验")
public RefundResult refundOrder(@Param("orderId") Long id, @Param("amount") BigDecimal amt) {
    if (amt.compareTo(MAX_AUTO_REFUND) > 0) {
        return RefundResult.needHumanReview();  // 大额转人工
    }
    return refundService.refund(id, amt);
}
```

**Agent 主循环**（ReAct 模式）：
```python
def agent_loop(user_input):
    messages = [{"role": "user", "content": user_input}]
    for step in range(MAX_STEPS):
        response = llm.chat(messages, tools=TOOLS)
        if response.is_final:
            return response.content
        tool_result = execute_tool(response.tool_call)
        messages.append({"role": "tool", "content": tool_result})
    return "需人工介入"
```

## 三、安全护栏

```
1. 工具校验：每个 tool 内置参数校验+权限校验
2. 额度限制：单 Agent 单日退款 < 1 万元
3. 高风险转人工：退款 > 500 元/异常订单触发审核
4. 审计日志：每次 tool call 留痕，可回溯
5. 兜底：Agent N 步无解 → 转人工
```

## 四、落地优先级

```
P0 客服（Q&A + 查单）：低风险，数据积累充分
P1 退款审核：中等风险，工具+额度兜底
P2 异常订单处置：高风险，Agent 建议+人工确认
P3 风控辅助：Agent 出建议，人工决策
```

## 五、拼多多场景

- **百亿补贴客服**：Agent 自动解释规则、查补贴进度
- **拼团异常**：未成团自动退款、咨询自动应答
- **物流异常**：Agent 主动联系物流+通知用户+补偿券

## 六、底层本质

Agent 改造本质是**"把规则无法穷举的长尾场景用 LLM 推理+工具调用自动化"**——核心保确定性（规则），长尾求灵活性（Agent），安全靠工具校验+额度+人工兜底。

## 常见考点
1. **Agent 和传统 RPA 区别**？——RPA 固定流程，Agent 自主决策（LLM 推理）。
2. **怎么防 Agent 乱退款**？——tool 内额度校验+大额人工+审计回溯。
3. **Function Calling 怎么实现**？——LLM 输出结构化 JSON（tool_name+args），工程层解析调用。
