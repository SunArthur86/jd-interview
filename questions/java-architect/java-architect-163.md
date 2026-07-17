---
id: java-architect-163
difficulty: L2
category: java-architect
subcategory: Agent 架构
tags:
- Java 架构师
- LLM
- 确定性
- 业务流程
feynman:
  essence: LLM 输出进入业务流程的本质是"把非确定的生成结果约束成确定的结构化决策"——LLM 只负责"理解意图 + 提取参数 + 推荐方案"，真正改变业务状态的动作（扣款、改库存、发券）由确定性代码执行。核心模式是"LLM 输出 JSON → schema 校验 → 业务规则校验 → 确定性执行"，绝不让 LLM 直接操作数据库。
  analogy: 像医院的 AI 分诊——AI 负责听病人描述、理解症状、推荐科室（非确定），但开药、做手术由医生和确定性医疗流程执行（确定）。AI 的建议要经过医生确认才执行。
  first_principle: LLM 是概率模型，同样的输入可能输出不同的结果，可能幻觉（编造不存在的订单号）、可能格式错（该输出 JSON 输出了散文）。业务流程要求确定性（扣款必须精确到分、库存必须精确到件）。两者之间必须有"schema 校验 + 规则校验 + 幂等执行"的转换层。
  key_points:
  - 转换层模式：LLM 输出 → JSON schema 校验 → 业务规则校验 → 确定性执行
  - 结构化输出：function calling / JSON mode / structured output（OpenAI 的 response_format）
  - 双轨校验：LLM 自校验（"你确定吗？"）+ 代码硬校验（schema + 规则）
  - 幂等执行：LLM 可能重复输出，业务侧用 idempotency_key 兜底
  - 可回退：LLM 决策错误时能撤销（soft delete + audit log）
first_principle:
  problem: 如何让 LLM 的非确定输出安全地驱动资金、库存等确定性业务流程？
  axioms:
  - LLM 输出非确定（幻觉、格式错、数值错）
  - 业务流程要求精确（金额精确到分、状态机不可乱跳）
  - 不可逆操作（转账、删数据）一旦执行无法撤回
  - LLM 不应该直接持有数据库连接或业务权限
  rebuild: 建转换层——LLM 用 function calling 输出结构化决策（intent + parameters），代码层做三道校验（JSON schema 校验格式、业务规则校验合理性、权限校验合法性），全部通过后由确定性 Service 执行。LLM 的输出视为"建议"而非"指令"，执行权在代码。
follow_up:
  - 怎么保证 LLM 输出 JSON 格式对？——用 function calling（OpenAI tool_use）或 response_format=json_object，模型层面约束输出。再加 jsonschema 校验兜底（ajv/java-jsonschema）。格式错重试 2 次，仍失败降级人工。
  - LLM 幻觉出不存在的订单号怎么办？——业务规则校验层查数据库验证 orderId 真实存在且属于当前用户，不存在直接拒绝。不信任 LLM 的任何参数。
  - 数值类输出（金额、数量）怎么保证精确？——LLM 输出字符串而非数字（避免浮点），业务层解析为 BigDecimal 精确计算。关键数值二次校验（"退款金额 1200 元，请确认"）。
  - LLM 决策和规则引擎冲突怎么办？——规则引擎优先（确定性）。LLM 推荐"给用户退款"，但规则校验"超退货时效"，拒绝。LLM 的输出始终是建议，规则是硬约束。
  - 怎么回退 LLM 的错误决策？——所有 LLM 驱动的操作用 soft delete（标记而非物理删除）+ 审计日志（记录 LLM 原始输出 + 执行结果）。发现错误可回溯撤销。
memory_points:
  - 转换层：LLM 输出 → JSON schema → 业务规则 → 确定性执行
  - 结构化输出：function calling / response_format=json_object
  - 双轨校验：LLM 自校验 + 代码硬校验（schema + 规则 + 权限）
  - 幂等：idempotency_key 兜底重复输出
  - 可回退：soft delete + 审计日志，LLM 输出视为建议非指令
---

# 【Java 后端架构师】LLM 输出如何进入确定性业务流程

> 适用场景：JD 核心技术。智能客服 LLM 听到"帮我退订单 888 的货"，理解意图后要触发退货退款流程——但 LLM 可能听错订单号（888 还是 8888？）、可能算错金额、可能跳过退货时效校验。架构师要设计的是一道"非确定到确定"的转换闸门，让 LLM 的理解能力赋能业务，但不让它的不确定性污染业务状态。

## 一、概念层：LLM 与业务流程的边界

| 层级 | 角色 | 确定性 | 示例 |
|------|------|--------|------|
| **LLM 层** | 意图理解 + 参数提取 + 方案推荐 | 非确定 | "用户要退货订单 888，推荐退款流程" |
| **转换层** | schema 校验 + 规则校验 + 权限校验 | 确定 | "orderId 格式合法？订单存在？属于用户？" |
| **业务层** | 状态机 + 事务 + 副作用执行 | 确定 | 退款 1200 元（精确到分）、释放库存 |

**核心原则**：LLM 只负责"理解"和"建议"，业务层负责"执行"。两者之间有确定性的转换层兜底。

## 二、机制层：转换层实现

### 2.1 结构化输出（function calling）

```java
@Service
public class IntentParser {

    private final ChatClient llm;

    private static final String SYSTEM_PROMPT = """
        你是订单客服助手。分析用户意图，输出结构化决策。
        必须通过 function calling 返回，不要输出自然语言。
        可用工具：applyRefund, cancelOrder, modifyAddress, queryOrder。
        """;

    /**
     * LLM 理解意图 → 输出结构化 tool_call
     */
    public ToolCall parse(String userInput, UserContext user) {
        LlmResponse response = llm.prompt()
            .system(SYSTEM_PROMPT)
            .user(userInput)
            .tools(List.of(refundToolSchema, cancelToolSchema, ...))
            .options(OptionBuilder.temperature(0))      // temperature=0 降低随机性
            .call()
            .toLlmResponse();

        if (!response.hasToolCalls()) {
            return ToolCall.clarify("我无法确定您的需求，请说明具体要做什么");
        }
        return response.getToolCalls().get(0);
    }
}
```

### 2.2 三道校验闸门

```java
@Service
@Slf4j
public class LlmToBusinessGateway {

    private final JsonSchemaValidator schemaValidator;
    private final BusinessRuleValidator ruleValidator;
    private final PermissionValidator permValidator;

    /**
     * 转换层：LLM 输出 → 确定性业务执行
     * 三道校验全过才执行
     */
    public BusinessResult execute(ToolCall llmOutput, UserContext user) {
        // 第一道：JSON schema 校验（格式对不对）
        try {
            schemaValidator.validate(llmOutput.getArguments(), llmOutput.getSchema());
        } catch (SchemaException e) {
            metrics.counter("llm.schema_fail").increment();
            log.warn("LLM 输出格式错 toolCall={} err={}", llmOutput, e.getMessage());
            return BusinessResult.retry("参数格式错误，正在重新理解");
        }

        // 第二道：业务规则校验（合不合理）
        BusinessRuleResult ruleResult = ruleValidator.validate(llmOutput, user);
        if (!ruleResult.isPass()) {
            metrics.counter("llm.rule_fail", "rule", ruleResult.getViolatedRule()).increment();
            return BusinessResult.reject(ruleResult.getReason());
            // 例："订单 888 已超过 7 天退货时效"
        }

        // 第三道：权限校验（合不合法）
        if (!permValidator.canExecute(user, llmOutput)) {
            metrics.counter("llm.perm_fail").increment();
            return BusinessResult.reject("无权执行此操作");
        }

        // 全过：确定性执行
        return executeDeterministically(llmOutput, user);
    }
}
```

### 2.3 业务规则校验器

```java
@Service
public class BusinessRuleValidator {

    /**
     * 校验 LLM 输出是否符合业务规则
     */
    public BusinessRuleResult validate(ToolCall call, UserContext user) {
        Map<String, Object> args = call.getArguments();

        switch (call.getName()) {
            case "applyRefund":
                return validateRefund(args, user);
            case "cancelOrder":
                return validateCancel(args, user);
            default:
                return BusinessRuleResult.reject("未知操作");
        }
    }

    private BusinessRuleResult validateRefund(Map<String, Object> args, UserContext user) {
        String orderId = (String) args.get("orderId");

        // 规则1：订单必须真实存在（不信任 LLM 的 orderId）
        Order order = orderRepo.findById(orderId);
        if (order == null) {
            return BusinessRuleResult.reject("订单 " + orderId + " 不存在");
        }

        // 规则2：订单必须属于当前用户（防越权）
        if (!order.getUserId().equals(user.getUserId())) {
            return BusinessRuleResult.reject("无权操作此订单");
        }

        // 规则3：退货时效校验
        if (order.getCreateTime().isBefore(LocalDateTime.now().minusDays(7))) {
            return BusinessRuleResult.reject("订单已超过 7 天退货时效");
        }

        // 规则4：订单状态必须是已签收
        if (order.getStatus() != OrderStatus.DELIVERED) {
            return BusinessRuleResult.reject("订单状态 " + order.getStatus() + " 不可退货");
        }

        // 规则5：金额校验（LLM 输出的 amount 必须和订单实际金额一致）
        BigDecimal llmAmount = new BigDecimal(args.get("amount").toString());
        if (llmAmount.compareTo(order.getPayAmount()) != 0) {
            log.warn("LLM 金额 {} 与实际 {} 不符", llmAmount, order.getPayAmount());
            return BusinessRuleResult.reject("退款金额校验失败");
        }

        return BusinessRuleResult.pass();
    }
}
```

### 2.4 确定性执行（幂等）

```java
@Service
public class DeterministicExecutor {

    /**
     * 幂等执行：LLM 可能重复输出相同决策，用 idempotency_key 兜底
     */
    public BusinessResult executeDeterministically(ToolCall call, UserContext user) {
        String idempotencyKey = buildKey(user.getUserId(), call);

        return idempotentExecutor.execute(idempotencyKey, () -> {
            // 走标准业务流程（状态机 + 事务）
            switch (call.getName()) {
                case "applyRefund":
                    RefundResult result = refundService.process(
                        (String) call.getArg("orderId"),
                        (String) call.getArg("reason"),
                        user.getUserId());
                    // 审计：记录 LLM 触发了此操作
                    auditLogger.log(LLM_TRIGGERED, call, result, user);
                    return BusinessResult.success(result);
                // ...
            }
        });
    }

    private String buildKey(String userId, ToolCall call) {
        // 用户 + 操作 + 参数 hash → 同一用户同一操作幂等
        return userId + ":" + call.getName() + ":" + hash(call.getArguments());
    }
}
```

## 三、实战层：数值精度与可回退

### 3.1 数值类输出的精确处理

```java
// LLM 输出金额用字符串，业务层解析为 BigDecimal
public class MoneyParser {
    public static BigDecimal parseLlmAmount(Object llmAmount) {
        String str = llmAmount.toString().replaceAll("[^0-9.]", "");
        BigDecimal amount = new BigDecimal(str)
            .setScale(2, RoundingMode.HALF_UP);       // 精确到分
        if (amount.compareTo(BigDecimal.ZERO) <= 0) {
            throw new BusinessException("金额必须大于 0");
        }
        if (amount.compareTo(MAX_AMOUNT) > 0) {
            throw new BusinessException("金额超上限");
        }
        return amount;
    }
}
```

### 3.2 可回退机制（soft delete + 审计）

```sql
-- LLM 驱动的操作用软删除，可回溯撤销
CREATE TABLE t_llm_action_log (
    id BIGINT PRIMARY KEY,
    action_id VARCHAR(64) UNIQUE,           -- 幂等键
    user_id VARCHAR(32),
    llm_output JSON,                        -- LLM 原始输出（可追溯）
    tool_name VARCHAR(50),
    executed_result JSON,                   -- 执行结果
    status VARCHAR(20),                     -- EXECUTED / REVERTED
    create_time TIMESTAMP,
    revert_time TIMESTAMP,
    revert_reason VARCHAR(200)
);

-- 发现 LLM 决策错误，撤销
UPDATE t_llm_action_log SET status='REVERTED',
    revert_time=NOW(), revert_reason='LLM 误判订单号'
WHERE action_id = 'xxx';
-- 同时执行业务回滚（退款撤销、库存恢复）
```

## 四、底层本质：概率模型和确定性系统的契约

LLM 是概率模型（生成下一个 token 的概率分布），业务系统是确定性状态机（每个状态转换有严格规则）。两者能协作的根本是"契约"——LLM 输出必须符合预定义的 schema（function calling 的 JSON Schema），转换层把概率输出"坍缩"为确定性指令。

**类比量子力学**：LLM 是叠加态（多种意图的可能性），function calling + 校验层是"观测"（坍缩为确定的一种意图），业务层是经典物理（确定性执行）。观测的过程就是 schema + 规则 + 权限三道校验。

**工程启示**：
1. LLM 的输出永远是"建议"，不是"指令"
2. 校验层的规则是硬约束，LLM 的推理理由不能绕过
3. 所有 LLM 驱动的操作必须可审计、可回退
4. temperature=0 降低随机性，但仍有 5-10% 的格式错误率，必须代码兜底

## 五、AI 工程化深挖

1. **怎么降低 LLM 输出的不确定性？**
   temperature=0（贪心解码）+ function calling（强 schema）+ few-shot 示例（给典型 case）+ system prompt 约束（"必须通过 tool 返回，不要自由发挥"）。实测：function calling + temp=0 的格式错误率 < 2%，纯文本输出 + temp=0 约 10%。

2. **LLM 决策和规则引擎怎么协同？**
   LLM 负责"模糊地带"（意图理解、方案推荐），规则引擎负责"硬约束"（时效、金额、权限）。两者顺序：LLM 推荐 → 规则校验 → 通过则执行。规则是兜底，LLM 是赋能。新业务规则先在规则引擎固化，再让 LLM 学习遵守。

3. **怎么评估转换层的有效性？**
   核心指标：schema_pass_rate（格式通过率，应 > 98%）、rule_pass_rate（规则通过率，反映 LLM 推荐质量）、llm_triggered_error_rate（LLM 决策导致的业务错误率，应 < 传统人工错误率）、revert_rate（事后撤销率，应 < 1%）。

4. **LLM 改变了业务状态怎么对账？**
   每天 T+1 跑对账：LLM 驱动的操作日志 vs 业务系统实际状态，发现不一致（LLM 说退了但实际没退）自动补偿。监控对账差异率，超阈值告警。这和传统系统对账一样，只是数据源多了 LLM 日志。

5. **怎么防止 prompt injection 让 LLM 执行恶意操作？**
   转换层不信任 LLM 的任何输出——schema 校验防格式注入、规则校验防逻辑越权（"给我退款 100 万"被金额规则拦）、权限校验防身份越权（LLM 不能替别的用户操作）。高敏操作还要人工确认（HITL）。

## 六、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"结构化、三校验、幂等、可回退"** 四个词。

- **结构化**：function calling / response_format=json，LLM 输出 JSON
- **三校验**：schema（格式）+ 规则（合理）+ 权限（合法）
- **幂等**：idempotency_key 兜底重复输出
- **可回退**：soft delete + 审计日志，LLM 输出是建议非指令

### 面试现场 60 秒回答

> LLM 输出进业务流程我建一道转换闸门。LLM 用 function calling 输出结构化决策（intent + parameters），temperature=0 降低随机性。转换层三道校验：schema 校验格式（ajv 验证 JSON Schema）、业务规则校验合理性（订单存在/属于用户/退货时效/金额一致）、权限校验合法性。三道全过才走确定性 Service 执行。关键是"不信任 LLM"——orderId 要查库验证、金额要用 BigDecimal 精确解析、用户要校验归属。幂等用 idempotency_key（userId + operation + paramsHash），LLM 重复输出返回上次结果。所有 LLM 驱动的操作用 soft delete + 审计日志，发现误判可回溯撤销。LLM 的输出始终是建议，规则引擎是硬约束，冲突时规则优先。最容易翻车的是"让 LLM 直接操作数据库"——一旦 prompt injection 诱导，业务全线崩。

## 常见考点

1. **为什么不能让 LLM 直接执行 SQL？**——LLM 可能幻觉出不存在的条件（DELETE FROM orders）、可能被 prompt injection 诱导（"删除所有订单"）。必须走确定性 Service + 状态机 + 权限校验。Text-to-SQL 只在分析场景用且只读账号。
2. **function calling 比 prompt 输出 JSON 好在哪？**——function calling 是模型层面约束（训练时学过），格式错误率 < 2%；prompt 要求输出 JSON 是提示层面约束，模型可能输出多余文本或格式错，错误率约 10%。
3. **LLM 输出的数值怎么处理？**——字符串接收（避免 JSON 浮点精度丢失），BigDecimal 解析（精确到分），业务规则二次校验（和订单实际金额比对）。
4. **怎么回退 LLM 的错误决策？**——操作前写 LLM action log（含原始输出），操作用 soft delete。发现错误时标记 REVERTED + 业务回滚（退款撤销/库存恢复）。监控 revert_rate < 1%。

## 结构化回答

**30 秒电梯演讲：** LLM 输出进入业务流程的本质是把非确定的生成结果约束成确定的结构化决策——LLM 只负责理解意图 + 提取参数 + 推荐方案，真正改变业务状态的动作（扣款、改库存、发券）由确定性代码执行。核心模式是LLM 输出 JSON → schema 校验 → 业务规则校验 → 确定性执行，绝不让 LLM 直接操作数据库

**展开框架：**
1. **转换层模式** — LLM 输出 → JSON schema 校验 → 业务规则校验 → 确定性执行
2. **结构化输出** — function calling / JSON mode / structured output（OpenAI 的 response_format）
3. **双轨校验** — LLM 自校验（"你确定吗？"）+ 代码硬校验（schema + 规则）

**收尾：** 以上是我的整体思路。您想继续深入聊——怎么保证 LLM 输出 JSON 格式对？


## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：LLM 输出如何进入确定性业务流程 | "这题核心是——LLM 输出进入业务流程的本质是把非确定的生成结果约束成确定的结构化决策——LLM 只负责理解……" | 开场钩子 |
| 0:15 | 转换层模式示意/对比图 | "LLM 输出 → JSON schema 校验 → 业务规则校验 → 确定性执行" | 转换层模式要点 |
| 0:40 | 结构化输出示意/对比图 | "function calling / JSON mode / structured output（OpenAI 的 response_format）" | 结构化输出要点 |
| 1:25 | 总结卡 | "记住：转换层。下期见。" | 收尾 |
