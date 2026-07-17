---
id: java-architect-162
difficulty: L3
category: java-architect
subcategory: Agent 工程化
tags:
- Java 架构师
- Agent
- 状态机
- 补偿
feynman:
  essence: Agent 多步骤任务的本质是"有限状态机 + Saga 补偿"——每个步骤是一个状态，步骤间有明确流转规则，任何一步失败都要能从上一个 checkpoint 恢复或反向补偿已执行的副作用。和分布式事务的 Saga 模式同构，区别是 Agent 的步骤由 LLM 动态决策而非预先编排。
  analogy: 像一个会自主规划的旅行团导游——他决定先去 A 景点再去 B 酒店（动态规划），但如果 B 酒店订满了，他要能取消 A 景点的门票（补偿）或改订 C 酒店（重试）。每一步都有备案，不会卡死在半路。
  first_principle: Agent 多步执行有三个工程难点：(1) 中间失败要恢复不能从头重来（已执行的副作用不能重复）；(2) 步骤间有数据依赖（B 步骤要 A 的结果）；(3) LLM 决策可能跳步或回退。状态机解决流转约束，checkpoint 解决恢复，Saga 解决副作用补偿。
  key_points:
  - 状态机：CREATED → RUNNING → PAUSED → SUCCEEDED / FAILED，每步有明确前驱后继
  - checkpoint：每步执行后持久化（taskId + step + state + history），失败从最近 checkpoint 恢复
  - Saga 补偿：每个步骤注册补偿动作（refund 的补偿是 reverse_refund），失败时反向执行已成功步骤的补偿
  - 幂等：每个步骤必须幂等（重复执行无副作用），靠 idempotency_key 兜底
  - 恢复策略：重试（瞬时失败）、补偿（业务失败）、人工介入（无法自动恢复）
first_principle:
  problem: Agent 执行一个跨 5 个工具调用的多步任务，第 4 步失败，前 3 步已产生副作用（扣了库存、发了券），怎么恢复一致性？
  axioms:
  - 从头重来会重复执行前 3 步的副作用（重复扣库存、重复发券）
  - 不恢复会留下不一致状态（库存扣了但订单没建成）
  - 每个步骤的副作用可能是不可逆的（退款已到账无法撤回）
  - 恢复时间窗口有限（用户不会等 30 分钟）
  rebuild: 把任务建模为状态机 + Saga。每个步骤有前置条件和补偿动作，状态每步 checkpoint。第 4 步失败时，反向执行第 3、2、1 步的补偿（反向用券、回滚库存），恢复到初始状态；或暂停任务人工介入。对不可逆操作（已退款）标记为"需人工处理"，不自动补偿。
follow_up:
  - Saga 补偿和分布式事务的 TCC 区别？——TCC 是 TRY-CONFIRM-CANCEL 三阶段，资源预留；Saga 是正向执行 + 反向补偿，不预留。Agent 适合 Saga（步骤由 LLM 动态决策，无法预知全部步骤）。
  - 怎么知道哪些步骤需要补偿？——所有有副作用的步骤都要注册补偿动作。执行时把 (step, action, compensateAction) 记录到 saga_log，失败时按逆序执行 compensateAction。
  - 补偿也失败了怎么办？——补偿失败重试 3 次，仍失败标记为"需人工介入"，告警并暂停任务。人工处理后标记任务为 SUCCEEDED_MANUAL 或 FAILED。
  - LLM 决策跳步怎么办？——状态机强制校验前置条件。LLM 想从 step1 跳到 step4，但 step4 的前置是 step3，状态机拒绝跳转并提示 LLM"必须先执行 step3"。
  - checkpoint 存什么？——taskId、currentStep、stepResults（每步的输出）、history（完整对话）、sagaLog（已执行的副作用及补偿动作）。history 要完整存，因为 LLM 恢复后需要上下文继续决策。
memory_points:
  - 状态机：CREATED → RUNNING → PAUSED → SUCCEEDED/FAILED，每步前置校验
  - checkpoint：每步持久化（taskId+step+history+sagaLog），失败恢复
  - Saga 补偿：有副作用的步骤注册 compensateAction，失败逆序执行
  - 幂等：idempotency_key 兜底，重复执行无副作用
  - 恢复策略：重试（瞬时）/补偿（业务）/人工（不可逆）
---

# 【Java 后端架构师】Agent 多步骤任务的状态机与补偿

> 适用场景：JD 核心技术。客服 Agent 处理"帮我退货退款"——查订单 → 校验退货资格 → 生成退货单 → 退款 → 释放库存，跨 5 个工具调用。第 4 步退款失败，前 3 步已生成退货单、已通知仓库。架构师要设计的是一套"可恢复、可补偿、可审计"的多步骤任务框架。

## 一、概念层：Agent 任务的状态机

```
                       ┌──────────┐
                       │ CREATED  │ (任务创建)
                       └────┬─────┘
                            │ start()
                            ▼
    ┌──────────────────────────────────────────┐
    │              RUNNING                      │
    │  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐ │
    │  │STEP_1│→ │STEP_2│→ │STEP_3│→ │STEP_4│ │  (LLM 决策每步)
    │  └──┬───┘  └──┬───┘  └──┬───┘  └──┬───┘ │
    │     │ckpt     │ckpt     │ckpt     │ckpt  │  (每步 checkpoint)
    └─────┼─────────┼─────────┼─────────┼─────┘
          │         │         │         │
          ▼         ▼         ▼         ▼
    ┌──────────┐  ┌──────────┐  ┌──────────────┐
    │ PAUSED   │  │ FAILED   │  │  SUCCEEDED   │
    │ (等审批)  │  │ (已补偿)  │  │  (任务完成)   │
    └──────────┘  └──────────┘  └──────────────┘
```

## 二、机制层：状态机与 checkpoint 实现

### 2.1 任务状态持久化

```java
@Entity
@Table(name = "t_agent_task")
public class AgentTask {
    @Id
    private String taskId;
    private String userId;
    private String intent;                    // 用户意图（退货退款）
    private TaskStatus status;                // CREATED/RUNNING/PAUSED/SUCCEEDED/FAILED
    private int currentStep;
    private int stepCount;
    private Instant startTime;
    private Instant lastActiveTime;

    @Lob
    private String history;                   // 完整对话历史（JSON）
    @Lob
    private String stepResults;               // 每步输出（JSON）

    @OneToMany(cascade = ALL)
    private List<SagaStep> sagaLog;           // 已执行的副作用步骤（含补偿动作）

    private String pendingApprovalId;
    private Integer version;                  // 乐观锁
}

public enum TaskStatus {
    CREATED, RUNNING, PAUSED_APPROVAL, PAUSED_ERROR, SUCCEEDED, FAILED, COMPENSATED
}
```

### 2.2 Saga 步骤记录（补偿依据）

```java
@Entity
@Table(name = "t_saga_step")
public class SagaStep {
    @Id
    private String stepId;
    private String taskId;
    private int stepOrder;                    // 执行顺序
    private String toolName;                  // 执行的工具（如 refundService）
    private String action;                    // 正向动作
    @Lob
    private String actionInput;               // 动作输入参数
    private String compensateAction;          // 补偿动作（如 reverseRefund）
    @Lob
    private String compensateInput;           // 补偿参数
    private StepStatus status;                // EXECUTED / COMPENSATED / FAILED
    private Instant executeTime;
}
```

### 2.3 状态机流转与 checkpoint

```java
@Service
@Slf4j
public class AgentTaskExecutor {

    private final StateMachine<AgentTask> stateMachine;
    private final AgentTaskRepository taskRepo;
    private final SagaCompensator compensator;

    private static final int MAX_STEPS = 20;
    private static final int MAX_RETRY = 3;

    public TaskResult execute(AgentTask task) {
        stateMachine.transition(task, RUNNING);

        while (task.notFinished()) {
            // 1. 上限检查
            checkLimits(task, MAX_STEPS);

            try {
                // 2. LLM 决策下一步工具调用
                ToolCall call = llm.decideNextStep(task.getHistory(),
                    task.getStepResults());

                // 3. 执行（注册补偿动作）
                SagaStep step = executeWithCompensation(call, task);
                task.getSagaLog().add(step);
                task.setCurrentStep(task.getCurrentStep() + 1);

                // 4. checkpoint（关键：每步持久化）
                taskRepo.checkpoint(task);

                // 5. 判断是否完成
                if (llm.isTaskComplete(task)) {
                    stateMachine.transition(task, SUCCEEDED);
                    return TaskResult.success(task.getStepResults());
                }

            } catch (RetryableException e) {
                // 瞬时失败：重试
                if (task.getRetryCount() < MAX_RETRY) {
                    task.incrementRetry();
                    sleep(backoff(task.getRetryCount()));
                    continue;
                }
                // 重试耗尽：触发补偿
                return handleFailure(task, e);

            } catch (BusinessException e) {
                // 业务失败：不可重试，直接补偿
                return handleFailure(task, e);
            }
        }
        return TaskResult.failure("超出步数上限");
    }

    /**
     * 执行工具调用并注册补偿动作
     */
    private SagaStep executeWithCompensation(ToolCall call, AgentTask task) {
        // 注册补偿（执行前准备好，防执行后崩溃无法补偿）
        SagaStep step = SagaStep.builder()
            .stepId(generateStepId())
            .taskId(task.getTaskId())
            .toolName(call.getName())
            .action(call.getName())
            .actionInput(toJson(call.getArguments()))
            .compensateAction(registry.getCompensateAction(call.getName()))
            .compensateInput(buildCompensateInput(call))
            .build();

        // 幂等执行
        ToolResult result = toolExecutor.executeIdempotent(call,
            idempotencyKey(task.getTaskId(), step.getStepId()));

        step.setStatus(StepStatus.EXECUTED);
        step.setExecuteTime(Instant.now());
        return step;
    }

    /**
     * 失败处理：反向补偿已执行的步骤
     */
    private TaskResult handleFailure(AgentTask task, Exception e) {
        log.error("任务失败，触发补偿 taskId={}", task.getTaskId(), e);

        List<SagaStep> executed = task.getSagaLog().stream()
            .filter(s -> s.getStatus() == EXECUTED)
            .sorted(Comparator.comparing(SagaStep::getStepOrder).reversed())  // 逆序
            .collect(toList());

        boolean allCompensated = true;
        for (SagaStep step : executed) {
            try {
                compensator.compensate(step);            // 执行补偿
                step.setStatus(StepStatus.COMPENSATED);
            } catch (Exception ex) {
                log.error("补偿失败 step={}", step.getStepId(), ex);
                step.setStatus(StepStatus.FAILED);
                allCompensated = false;
                // 补偿失败：告警人工介入
                alertService.send("补偿失败 taskId=" + task.getTaskId()
                    + " step=" + step.getStepId());
            }
        }

        if (allCompensated) {
            stateMachine.transition(task, COMPENSATED);
            return TaskResult.compensated("任务失败已自动回滚");
        } else {
            stateMachine.transition(task, PAUSED_ERROR);
            return TaskResult.needsManualIntervention("部分补偿失败，需人工处理");
        }
    }
}
```

### 2.4 补偿动作注册表

```java
@Component
public class CompensateActionRegistry {

    private final Map<String, CompensateAction> actions = new HashMap<>();

    public CompensateActionRegistry(RefundService refundService,
                                     InventoryService inventoryService,
                                     CouponService couponService) {
        // 每个有副作用的工具注册补偿
        register("refund", "reverseRefund", refundService::reverse);
        register("deductInventory", "rollbackInventory", inventoryService::rollback);
        register("useCoupon", "releaseCoupon", couponService::release);
        register("createShipment", "cancelShipment", shipmentService::cancel);
        // 无副作用的工具无需补偿
        // register("queryOrder", null, null);  -- 不注册
    }

    public String getCompensateAction(String toolName) {
        CompensateAction a = actions.get(toolName);
        return a != null ? a.actionName : null;
    }
}
```

## 三、机制层：幂等执行

```java
@Service
public class IdempotentToolExecutor {

    private final RedisTemplate<String, String> redis;
    private final ToolRegistry toolRegistry;

    public ToolResult executeIdempotent(ToolCall call, String idempotencyKey) {
        // 1. 幂等检查：key 已存在直接返回缓存结果
        String cached = redis.opsForValue().get("idem:" + idempotencyKey);
        if (cached != null) {
            return fromJson(cached);                // 重复执行返回上次结果
        }

        // 2. 抢占 key（SETNX，TTL 24h）
        Boolean acquired = redis.opsForValue().setIfAbsent(
            "idem:" + idempotencyKey, "PROCESSING", Duration.ofHours(24));
        if (Boolean.FALSE.equals(acquired)) {
            // 其他线程正在执行，等待
            return waitForResult(idempotencyKey);
        }

        // 3. 执行工具
        try {
            ToolResult result = toolRegistry.execute(call);
            redis.opsForValue().set("idem:" + idempotencyKey,
                toJson(result), Duration.ofHours(24));
            return result;
        } catch (Exception e) {
            redis.delete("idem:" + idempotencyKey);  // 失败释放 key 允许重试
            throw e;
        }
    }
}
```

## 四、实战层：失败恢复场景

**场景**：Agent 退货退款任务，5 个步骤，第 4 步退款失败

```
Step 1: queryOrder(orderId=888)         → 已执行（无副作用，无需补偿）
Step 2: checkReturnEligibility(orderId)  → 已执行（无副作用）
Step 3: createReturnOrder(orderId)       → 已执行（有副作用，补偿=cancelReturnOrder）
Step 4: refund(orderId, amount=1200)     → 失败（网络超时）
Step 5: releaseInventory(orderId)        → 未执行
```

**补偿流程**：
```java
// handleFailure 触发，逆序补偿 EXECUTED 且有 compensateAction 的步骤
// Step 3 的补偿：cancelReturnOrder(orderId) → 退货单标记取消
// Step 1/2 无 compensateAction，跳过
// 补偿完成，任务状态 COMPENSATED，通知用户"退货退款失败，已取消退货单，请稍后重试"
```

**如果补偿也失败**（cancelReturnOrder 超时）：
- 重试 3 次
- 仍失败标记 PAUSED_ERROR，告警人工
- 人工在后台手动取消退货单，标记任务 FAILED_MANUAL_RESOLVED

## 五、底层本质：状态机 + Saga 是把非确定过程约束成可控系统

Agent 的多步执行和分布式事务（Saga）同构，但有三个特殊点：

1. **步骤动态决策**：传统 Saga 步骤预先编排，Agent 步骤由 LLM 每步动态决定。所以补偿动作不能预编译，要运行时注册（工具白名单里每个工具有对应补偿）。

2. **非确定重试**：LLM 决策可能失败后换工具（退款失败改用优惠券），不一定走补偿。要给 LLM 选择权——补偿 or 换路径，但都在状态机约束内。

3. **长任务中断恢复**：Agent 任务可能跑几分钟，期间服务重启。checkpoint 保证重启后能加载状态继续，但已执行的副作用要先查当前状态（退款是否真的没成功），避免重复执行或误补偿。

**核心设计原则**：每步执行前注册补偿（防执行后崩溃）、每步 checkpoint（防重启丢失）、工具幂等（防重试副作用）、补偿可重试（防补偿自身失败）。

## 六、AI 工程化深挖

1. **怎么用 LLM 辅助决策"补偿还是重试"？**
   失败后把错误信息喂给 LLM，让它判断是瞬时故障（网络超时 → 重试）还是业务失败（余额不足 → 补偿或换路径）。LLM 输出决策（retry/compensate/abort），状态机执行。但高敏操作（资金）仍走规则，不信任 LLM 的"重试"建议。

2. **多 Agent 协作的 Saga 怎么设计？**
   多个 Agent 各负责一段流程（客服 Agent + 仓库 Agent + 财务 Agent），用分布式 Saga。每个 Agent 的任务有自己的 saga_log，全局协调者记录跨 Agent 的补偿链。一致性靠最终一致 + 对账兜底，不用强一致分布式事务。

3. **怎么评估 Agent 任务的可靠性？**
   核心指标：task_completion_rate（成功率）、compensation_rate（触发补偿的比例，过高说明工具不稳）、compensation_success_rate（补偿自身成功率）、manual_intervention_rate（需人工介入的比例）、recovery_time（平均恢复时间）。

4. **Agent 任务跑太久怎么处理？**
   硬超时（如 10 分钟）强制终止 + 补偿。对于确实需要长时间的任务（如批量处理），拆成子任务 + 异步执行，用回调通知用户而非让用户等。监控 task_duration_p99，超阈值告警。

5. **怎么回放 Agent 任务排查问题？**
   checkpoint 完整保存 history（每步 LLM 的 thought + action + observation）和 saga_log。排查时按 taskId 加载完整轨迹，逐步重放看 LLM 决策链。traceId 贯穿所有工具调用，能下钻到下游服务。

## 七、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"状态机、checkpoint、Saga 补偿、幂等"** 四个词。

- **状态机**：CREATED → RUNNING → PAUSED → SUCCEEDED/FAILED/COMPENSATED
- **checkpoint**：每步持久化（history + sagaLog），失败从最近点恢复
- **Saga 补偿**：有副作用工具注册 compensateAction，失败逆序补偿
- **幂等**：idempotency_key 兜底，重复执行无副作用

### 面试现场 60 秒回答

> Agent 多步任务我用状态机 + Saga 补偿。状态机是 CREATED → RUNNING → PAUSED → SUCCEEDED/FAILED/COMPENSATED，每步有前置校验防 LLM 跳步。每步执行后 checkpoint 到数据库（taskId + currentStep + history + sagaLog），服务重启能从最近 checkpoint 恢复。每个有副作用的工具注册补偿动作（refund 的补偿是 reverseRefund），执行前先注册到 sagaLog 防执行后崩溃无法补偿。第 4 步失败时，逆序补偿已执行的步骤（cancelReturnOrder），补偿失败重试 3 次仍失败告警人工。工具调用用 idempotency_key 幂等（SETNX Redis），重复执行返回上次结果不重复扣库存。失败策略分三档：瞬时失败重试（指数退避）、业务失败补偿、不可逆失败人工介入。核心指标 task_completion_rate、compensation_rate、manual_intervention_rate。

## 常见考点

1. **Saga 和 TCC 区别？**——TCC 是 TRY-CONFIRM-CANCEL 三阶段预留资源；Saga 是正向执行 + 反向补偿不预留。Agent 适合 Saga（步骤动态决策无法预知全部步骤）。
2. **补偿动作怎么保证执行？**——补偿失败重试 + 死信队列 + 告警人工。补偿动作本身要幂等（重复 cancelReturnOrder 不报错）。
3. **checkpoint 太频繁影响性能怎么办？**——异步 checkpoint（执行不阻塞，写 DB 异步）。或每 N 步一次 checkpoint（牺牲恢复粒度换性能）。关键里程碑必 checkpoint。
4. **Agent 决策跳步怎么拦？**——状态机强制前置校验。LLM 想 step1→step4，但 step4 前置是 step3，拒绝并提示"必须先完成 step3"。状态机配置 Map<step, prerequisites>。

## 结构化回答

**30 秒电梯演讲：** Agent 多步骤任务的本质是有限状态机 + Saga 补偿——每个步骤是一个状态，步骤间有明确流转规则，任何一步失败都要能从上一个 checkpoint 恢复或反向补偿已执行的副作用。和分布式事务的 Saga 模式同构，区别是 Agent 的步骤由 LLM 动态决策而非预先编排

**展开框架：**
1. **状态机** — CREATED → RUNNING → PAUSED → SUCCEEDED / FAILED，每步有明确前驱后继
2. **checkpoint** — 每步执行后持久化（taskId + step + state + history），失败从最近 checkpoint 恢复
3. **Saga 补偿** — 每个步骤注册补偿动作（refund 的补偿是 reverse_refund），失败时反向执行已成功步骤的补偿

**收尾：** 以上是我的整体思路。您想继续深入聊——Saga 补偿和分布式事务的 TCC 区别？


## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：Agent 多步骤任务的状态机与补偿 | "这题核心是——Agent 多步骤任务的本质是有限状态机 + Saga 补偿——每个步骤是一个状态，步骤间有明确……" | 开场钩子 |
| 0:15 | 像一个会自主规划的旅行团导游——他决定先去 A类比图 | "打个比方：像一个会自主规划的旅行团导游——他决定先去 A。" | 核心类比 |
| 0:40 | 状态机示意/对比图 | "CREATED → RUNNING → PAUSED → SUCCEEDED / FAILED，每步有明确前驱后继" | 状态机要点 |
| 1:05 | checkpoint示意/对比图 | "每步执行后持久化（taskId + step + state + history），失败从最近 checkpoint 恢复" | checkpoint要点 |
| 1:55 | 总结卡 | "记住：状态机。下期见。" | 收尾 |
