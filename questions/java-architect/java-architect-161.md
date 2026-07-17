---
id: java-architect-161
difficulty: L2
category: java-architect
subcategory: Agent 工程化
tags:
- Java 架构师
- Human-in-the-loop
- 风险分级
- 审批
feynman:
  essence: Agent 人在回路（HITL）的本质是"按操作风险分级决定审批策略"——低风险操作（查询、只读）自动执行，中风险（修改、发通知）事后审计，高风险（退款、转账、删数据）必须事前人工审批。工程上是"风险评分 + 审批网关 + 超时降级"的组合，用 SLA（如审批 30 分钟未响应）兜底用户体验。
  analogy: 像银行的授权体系——柜员能办小额存取（低风险自动），大额要主管授权（中风险审批），跨境巨额要行长签字（高风险多级审批）。每级有金额阈值和超时机制。
  first_principle: Agent 调用 LLM 决策是非确定的，可能被 prompt injection 诱导执行危险操作。完全自动 = 风险失控，完全人工 = 失去自动化价值。风险分级是平衡点——把有限的人工注意力投到高风险操作上，低风险让 Agent 自动跑。
  key_points:
  - 风险三级：L1 低风险（只读/查询，自动）、L2 中风险（可逆修改，事后审计）、L3 高风险（不可逆/资金，事前审批）
  - 审批网关：Agent 执行前拦截，高风险 pause 任务，推审批工单，人工 approve/reject 后 resume
  - 超时降级：审批超时（如 30 分钟）自动 reject 并通知用户，避免任务无限挂起
  - 审批多级：金额阶梯触发多级审批（500 以下主管，5000 以下总监，以上 VP）
  - 审计留痕：每次审批记录 approver / decision / reason / timestamp，可回溯
first_principle:
  problem: 如何让 Agent 在"自动化效率"和"操作安全"之间找到平衡，既不让危险操作失控，又不让所有操作都卡在人工审批？
  axioms:
  - 操作风险不同：查订单 vs 退款 vs 删库，后果不可同日而语
  - 人工审批是稀缺资源，不能让所有操作都走审批（体验差且人力不够）
  - 不可逆操作（删数据、转账）必须事前拦截，可逆操作可以事后审计
  - 审批不能无限等待，超时要有降级（自动拒绝或自动升级）
  rebuild: 按操作类型和影响面建风险分级矩阵——L1 只读自动执行，L2 可逆修改异步执行 + 事后审计，L3 不可逆操作事前审批。审批走工单系统，带超时降级和多级路由。Agent 执行高风险操作时 pause 任务，审批通过后 resume，全链路审计。
follow_up:
  - 风险怎么自动评估？——规则 + 模型。规则：操作类型（退款高风险、查询低风险）、金额阈值（> 1000 高风险）、数据范围（全表删除高危）。模型：历史事故数据训练风险分类器，输出风险概率。
  - 审批人怎么路由？——按业务线 + 风险等级路由到对应审批人池。用 RBAC + 工作流引擎（如 Camunda）。审批人不可用时自动 backup（副主管）或升级。
  - 紧急情况能不能跳过审批？——有 break-glass 机制（紧急放行），但必须双人确认（申请 + 批准）且事后强制审计。监控 break_glass_rate，过高说明审批流程太慢要优化。
  - Agent 被诱导触发高风险操作怎么办？——即使审批通过也要二次校验（如退款前验证订单真实性、操作人权限），不信任 LLM 的决策理由。审计日志记录完整 tool_call 链路。
  - 审批 SLA 怎么定？——按业务紧急度。退款 30 分钟、删库 2 小时（不紧急且要慎重）、紧急故障处理 5 分钟。超时自动 reject 或升级，不无限等待。
memory_points:
  - 风险三级：L1 只读自动 / L2 可逆事后审计 / L3 不可逆事前审批
  - 审批网关：Agent pause → 推工单 → 人工 approve/reject → resume
  - 超时降级：SLA 超时自动 reject，避免任务挂起
  - 多级审批：金额阶梯路由（主管/总监/VP）
  - break-glass：紧急放行需双人确认 + 事后强制审计
---

# 【Java 后端架构师】Agent 人在回路审批与风险分级设计

> 适用场景：JD 核心技术。智能客服 Agent 能自动处理退款、改地址、取消订单——但这些是涉及资金和库存的高风险操作。如果 Agent 被诱导给所有用户退款 1000 元，后果不堪设想。架构师要设计的是一套"按风险分级、自动 + 审批结合、全链路审计"的 HITL 框架。

## 一、概念层：操作风险分级矩阵

| 风险等级 | 操作特征 | 示例 | 策略 | SLA |
|---------|---------|------|------|-----|
| **L1 低风险** | 只读、无副作用 | 查订单、查物流、查 FAQ | 自动执行，不拦截 | 即时 |
| **L2 中风险** | 可逆修改、影响单用户 | 改收货地址、改备注、发通知 | 自动执行 + 事后审计 | 即时 |
| **L3 高风险** | 不可逆、涉及资金/库存 | 退款、取消订单、批量删除 | 事前人工审批 | 30 分钟 |
| **L4 极高危** | 影响多用户/系统级 | 批量退款、删库、改权限 | 多级审批（主管+总监） | 2 小时 |

**核心原则**：把有限的人工注意力投到高风险操作上。低风险全自动，中风险事后抽审，高风险事前拦截。

## 二、机制层：风险评分与审批网关

### 2.1 风险评分引擎

```java
@Service
public class RiskScorer {

    /**
     * 综合规则 + 历史模型评估操作风险
     */
    public RiskScore evaluate(ToolCall call, UserContext user) {
        int score = 0;

        // 1. 操作类型基础分（规则）
        score += baseScoreByOperation(call.getToolName());
        // 查询 +0, 修改地址 +20, 退款 +60, 删除 +80

        // 2. 金额加权
        if (call.hasParam("amount")) {
            BigDecimal amount = new BigDecimal(call.getParam("amount"));
            if (amount.compareTo(BigDecimal.valueOf(1000)) > 0) score += 30;
            if (amount.compareTo(BigDecimal.valueOf(10000)) > 0) score += 30;
        }

        // 3. 影响范围
        if (call.getParam("target") != null) {
            score += scopeScore(call);  // 单用户 +0, 批量 +40, 全局 +80
        }

        // 4. 用户信任度（历史行为）
        score -= userTrustBonus(user);  // VIP 用户减分，新用户不减

        // 5. ML 模型补充（历史事故特征）
        score += mlModel.predict(call.getFeatures());

        RiskLevel level = classify(score);   // L1/L2/L3/L4
        return new RiskScore(score, level);
    }

    private RiskLevel classify(int score) {
        if (score < 20) return RiskLevel.L1;
        if (score < 50) return RiskLevel.L2;
        if (score < 80) return RiskLevel.L3;
        return RiskLevel.L4;
    }
}
```

### 2.2 审批网关（Agent 执行前拦截）

```java
@Service
@Slf4j
public class ApprovalGateway {

    private final RiskScorer riskScorer;
    private final ApprovalService approvalService;
    private final AgentStateRepository stateRepo;

    /**
     * Agent 执行工具前的审批拦截
     * 返回 APPROVED 直接执行，PENDING 则暂停任务等审批
     */
    public ApprovalResult checkAndApprove(ToolCall call, AgentTask task) {
        RiskScore risk = riskScorer.evaluate(call, task.getUserContext());

        switch (risk.getLevel()) {
            case L1:
                metrics.counter("agent.risk", "level", "L1").increment();
                return ApprovalResult.autoApproved();      // 自动执行

            case L2:
                metrics.counter("agent.risk", "level", "L2").increment();
                auditLogger.logAfter(call, task);          // 事后审计
                return ApprovalResult.autoApproved();

            case L3:
            case L4:
                metrics.counter("agent.risk", "level", risk.getLevel().name()).increment();
                return requestHumanApproval(call, task, risk);
        }
        return ApprovalResult.autoApproved();
    }

    private ApprovalResult requestHumanApproval(ToolCall call, AgentTask task, RiskScore risk) {
        // 1. 创建审批工单
        ApprovalTicket ticket = ApprovalTicket.builder()
            .taskId(task.getTaskId())
            .toolCall(call)
            .riskLevel(risk.getLevel())
            .riskScore(risk.getScore())
            .reason(buildApprovalReason(call, risk))
            .applicant(task.getUserId())
            .approvers(routeApprovers(risk))              // 路由审批人
            .sla(risk.getLevel() == RiskLevel.L4 ?
                Duration.ofHours(2) : Duration.ofMinutes(30))
            .build();

        approvalService.create(ticket);

        // 2. 暂停 Agent 任务
        task.pauseForApproval(ticket.getId());
        stateRepo.checkpoint(task);

        // 3. 通知审批人（IM/邮件/工单系统）
        notifyApprovers(ticket);

        return ApprovalResult.pending(ticket.getId());
    }

    /**
     * 审批结果回调后恢复 Agent
     */
    public void onApprovalResult(String ticketId, boolean approved, String approver, String reason) {
        ApprovalTicket ticket = approvalService.findById(ticketId);
        AgentTask task = stateRepo.findById(ticket.getTaskId());

        auditLogger.log(ApprovalEvent.builder()
            .ticketId(ticketId)
            .decision(approved ? APPROVED : REJECTED)
            .approver(approver)
            .reason(reason)
            .build());

        if (approved) {
            task.resumeFromApproval(ticketId, true);
            agentExecutor.execute(task);     // 继续执行
        } else {
            task.resumeFromApproval(ticketId, false);
            agentExecutor.execute(task);     // Agent 收到拒绝，走替代方案或告知用户
        }
    }
}
```

### 2.3 超时降级

```java
@Service
public class ApprovalTimeoutScheduler {

    /**
     * 审批超时自动 reject，避免任务无限挂起
     */
    @Scheduled(fixedDelay = 60_000)
    public void checkTimeout() {
        List<ApprovalTicket> timeouts = approvalService.findTimeoutExceeded();
        for (ApprovalTicket ticket : timeouts) {
            // 超时 = 隐式拒绝（保守策略，宁可不做不可做错）
            approvalService.autoReject(ticket.getId(), "SLA 超时自动拒绝");
            notifyUser(ticket, "您的请求审批超时已自动取消，如需处理请重新提交");
            metrics.counter("approval.timeout").increment();
        }
    }
}
```

### 2.4 多级审批路由

```java
@Service
public class ApproverRouter {

    /**
     * 按风险等级和金额路由审批人
     */
    public List<String> routeApprovers(RiskScore risk, ToolCall call) {
        List<String> approvers = new ArrayList<>();

        BigDecimal amount = call.getAmount();
        if (risk.getLevel() == RiskLevel.L3) {
            approvers.add(findSupervisor(call.getBusinessLine()));   // 主管
            if (amount != null && amount.compareTo(BigDecimal.valueOf(5000)) > 0) {
                approvers.add(findDirector(call.getBusinessLine())); // 总监
            }
        } else if (risk.getLevel() == RiskLevel.L4) {
            approvers.add(findDirector(call.getBusinessLine()));
            approvers.add(findVP(call.getBusinessLine()));           // VP
        }
        return approvers;
    }
}
```

## 三、实战层：break-glass 紧急放行

```java
@Service
public class BreakGlassService {

    /**
     * 紧急放行：跳过审批，但需双人确认（申请 + 批准）
     * 事后强制审计，监控使用率
     */
    @Transactional
    public void breakGlass(String ticketId, String requester, String approver, String emergencyReason) {
        // 1. 双人确认（申请人和批准人不能是同一人）
        if (requester.equals(approver)) {
            throw new BreakGlassException("申请人和批准人必须不同");
        }

        // 2. 强审计
        auditLogger.log(BreakGlassEvent.builder()
            .ticketId(ticketId)
            .requester(requester)
            .approver(approver)
            .reason(emergencyReason)
            .timestamp(Instant.now())
            .build());

        // 3. 立即放行
        approvalService.forceApprove(ticketId, "BREAK_GLASS:" + emergencyReason);

        // 4. 告警（break_glass_rate 过高要复盘）
        metrics.counter("approval.break_glass").increment();
        alertService.send("Break-glass 使用: " + ticketId + " by " + requester);

        // 5. 事后强制审计（48 小时内补审批记录）
        auditScheduler.schedulePostAudit(ticketId, Duration.ofHours(48));
    }
}
```

## 四、底层本质：风险分级是注意力分配

HITL 的本质是"用风险分级把有限的人工注意力分配到最高价值的审批节点"。如果把所有操作都走审批，审批人会被低风险操作淹没，高风险操作反而得不到充分审查（注意力稀释）。如果把所有操作都自动，风险失控。

**风险分级的经济学基础**：人工审批的成本（审批人时间 + 用户等待体验）必须小于操作失控的预期损失（P(事故) × 损失金额）。低风险操作的预期损失低，不值得人工审批；高风险操作的预期损失高，人工审批的成本远小于潜在损失。

这也解释了为什么风险评分要"规则 + 模型"结合——规则保证可解释和稳定（退款一定高风险），模型补充历史事故特征（某些 query 模式历史上常出事）。

## 五、AI 工程化深挖

1. **Agent 审批怎么和 LLM 的不确定性对齐？**
   不只看操作类型，还看 LLM 的决策置信度。LLM 对"是否要退款"不确定（logprob 低）时，即使金额低也走审批。置信度高且金额低才自动。把 LLM uncertainty 作为风险评分的一个特征。

2. **怎么用 LLM 辅助审批决策？**
   审批人面对大量工单，LLM 可以做摘要（"用户要退订单 888，金额 1200 元，原因是商品损坏，Agent 已查询物流确认签收"）、做风险提示（"该用户近 7 天退款 5 次，疑似羊毛党"）。LLM 只做建议，审批决策权在人。

3. **审批工单怎么避免 prompt injection？**
   Agent 的决策理由（"用户要求退款"）不可信，可能被注入。审批工单里要显示原始证据——聊天记录、订单状态、物流信息，不只显示 LLM 的摘要。审批人看到的是原始数据 + LLM 摘要，而非只信 LLM。

4. **批量 Agent 操作怎么审批？**
   批量操作（如批量退款 100 个订单）不能逐个审批（审批人累死）。方案：按批次风险审批（整批一个工单），但执行时分批执行 + 中间校验（执行 10 个后暂停检查有无异常）。批次大小按风险定。

5. **怎么评估 HITL 的效果？**
   核心指标：approval_throughput（审批吞吐）、approval_latency_p99（审批延迟）、auto_approve_rate（自动通过率，过低说明风险阈值太严）、break_glass_rate（紧急放行率，过高说明审批太慢）、post_audit_violation_rate（事后审计违规率，过高说明自动通过太松）。

## 六、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"分级、网关、超时、放行"** 四个词。

- **分级**：L1 只读自动 / L2 可逆事后审计 / L3 不可逆事前审批 / L4 多级审批
- **网关**：Agent 执行前拦截，高风险 pause 任务推工单，approve 后 resume
- **超时**：SLA 超时（30 分钟/2 小时）自动 reject，不无限等待
- **放行**：break-glass 紧急放行需双人确认 + 事后强制审计

### 面试现场 60 秒回答

> Agent 的 HITL 我按风险三级设计。L1 只读操作（查订单）自动执行；L2 可逆修改（改地址）自动执行 + 事后审计；L3 不可逆操作（退款、取消）事前人工审批。风险评分用规则 + ML 模型——操作类型基础分（退款 +60）+ 金额加权（> 1000 加 30）+ 影响范围 + 用户信任度，分级到 L1/L2/L3/L4。审批网关在 Agent 执行工具前拦截，高风险 pause 任务推审批工单，按业务线和金额路由审批人（主管/总监/VP），审批通过后 resume 继续。SLA 超时（退款 30 分钟）自动 reject 避免挂起。紧急情况有 break-glass 机制，但必须双人确认（申请+批准）且事后强制审计，监控 break_glass_rate 过高要复盘审批流程是否太慢。审批工单显示原始证据不只信 LLM 摘要，防 prompt injection 误导审批人。

## 七、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不让所有操作都走审批，更安全？ | 人工是稀缺资源，全审批会淹没审批人（注意力稀释）且用户体验差（等审批）。风险分级把注意力投到高风险，效率和安全兼顾 |
| 证据追问 | 怎么证明风险分级合理？ | 看历史数据：L1 自动通过的操作事故率应 < 0.01%，L3 审批拦截的操作中 reject 率应 10-30%（说明阈值有效）。事故集中在哪一级要复盘 |
| 边界追问 | HITL 解决不了什么？ | 解决不了审批人疏忽（看走眼 approve 了错误操作）、解决不了 LLM 被诱导伪造证据、解决不了审批人串通。这些要靠事后审计 + 多人复核 |
| 反例追问 | 什么场景不需要 HITL？ | 低风险全自动场景（客服 FAQ 查询）、延迟敏感（< 1s 响应）、内部工具可信度高。这些上审批是过度设计 |
| 风险追问 | Agent 被诱导触发 L3 操作怎么办？ | 即使审批通过也要二次校验（退款前验证订单真实性和操作人权限），不信任 LLM 决策理由。审计日志记录完整 tool_call 链路，事后能追溯 |
| 验证追问 | 怎么验证审批网关有效？ | 故障演练：注入诱导 prompt 看是否触发 L3 审批、注入超阈值金额看路由是否正确、注入 break-glass 看双人确认是否生效。监控 auto_approve_rate 和 violation_rate |
| 沉淀追问 | 团队沉淀什么？ | 风险评分规则库（可配置）、审批路由矩阵、break-glass SOP、HITL 监控看板（审批吞吐/延迟/违规率）、Agent 操作 Code Review checklist |

## 常见考点

1. **风险分级怎么设计？**——按操作类型（读/写/删）+ 影响面（单用户/批量）+ 金额 + 可逆性综合评分，分 L1-L4。规则保证稳定可解释，ML 模型补充历史特征。
2. **审批超时怎么办？**——SLA 内未响应自动 reject（保守策略），通知用户重新提交。不无限等待避免任务挂起。监控 approval_latency_p99。
3. **break-glass 怎么防滥用？**——双人确认（申请+批准不同人）、强制审计（48 小时内补记录）、监控使用率（过高告警复盘）、事后追责机制。
4. **Agent 任务暂停后怎么恢复？**——状态 checkpoint 到数据库（taskId/status/pendingApproval），审批通过后 loadState + resume，继续 Agent 循环。配合 saga 模式处理已执行的副作用。

## 结构化回答

**30 秒电梯演讲：** Agent 人在回路（HITL）的本质是按操作风险分级决定审批策略——低风险操作（查询、只读）自动执行，中风险（修改、发通知）事后审计，高风险（退款、转账、删数据）必须事前人工审批。工程上是风险评分 + 审批网关 + 超时降级的组合，用 SLA（如审批 30 分钟未响应）兜底用户体验

**展开框架：**
1. **风险三级** — L1 低风险（只读/查询，自动）、L2 中风险（可逆修改，事后审计）、L3 高风险（不可逆/资金，事前审批）
2. **审批网关** — Agent 执行前拦截，高风险 pause 任务，推审批工单，人工 approve/reject 后 resume
3. **超时降级** — 审批超时（如 30 分钟）自动 reject 并通知用户，避免任务无限挂起

**收尾：** 以上是我的整体思路。您想继续深入聊——风险怎么自动评估？


## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：Agent 人在回路审批与风险分级设计 | "这题核心是——Agent 人在回路（HITL）的本质是按操作风险分级决定审批策略——低风险操作（查询、只读）自……" | 开场钩子 |
| 0:15 | 风险三级示意/对比图 | "L1 低风险（只读/查询，自动）、L2 中风险（可逆修改，事后审计）、L3 高风险（不可逆/资金，事前审批）" | 风险三级要点 |
| 0:40 | 审批网关示意/对比图 | "Agent 执行前拦截，高风险 pause 任务，推审批工单，人工 approve/reject 后 resume" | 审批网关要点 |
| 1:25 | 总结卡 | "记住：风险三级。下期见。" | 收尾 |
