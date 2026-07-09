---
id: pdd-scm-033
difficulty: L4
category: pdd-scm
subcategory: Agent 工程化
tags:
- 拼多多
- 供应链
- AI Harness
- LLM 网关
- 推理优化
feynman:
  essence: AI Harness 把"调 LLM API"升级为"工程化系统"——LLM 网关（多模型路由+限流+成本）+ 推理优化（vLLM/量化）+ 工具管理（MCP）+ 评估闭环，让 LLM 在供应链生产环境可靠运行。
  analogy: AI Harness 像 LLM 的"操作系统"——管理模型资源、调度推理、提供工具、监控运行，让上层 Agent 不操心底层。
  first_principle: 单个 LLM 调用简单，但生产要兼顾成本/性能/稳定/安全，必须工程化。
  key_points:
  - LLM 网关：多模型路由、限流、成本控制、降级
  - 推理优化：vLLM/PagedAttention、量化
  - 工具管理：MCP Server 注册发现
  - 评估闭环：决策回流→标注→迭代
first_principle:
  problem: LLM 从 demo 到生产面临成本爆炸、延迟不稳、幻觉、版本混乱，如何系统化治理？
  axioms:
  - 推理慢且贵
  - 多模型多版本并存
  - 必须可监控可评估
  rebuild: AI Harness 平台（网关+推理+工具+监控+评估）。
follow_up:
- LLM 网关做什么？——多模型路由、限流、成本控制、降级、审计
- vLLM 为什么快？——PagedAttention（显存利用率 30%→90%）+ Continuous Batching
- 怎么评估 LLM 效果？——离线测试集 + 在线 A/B + 人工标注
memory_points:
- AI Harness = LLM 网关 + 推理优化 + 工具管理 + 监控评估
- vLLM PagedAttention 提升吞吐 5-10 倍
- LLM 网关：路由/限流/成本/降级/审计
- 评估闭环：决策回流→标注→微调→上线
---

# 【拼多多供应链】AI Harness 怎么工程化？让 LLM 生产级运行

> JD 依据：JD 9 大模型工程师对应。

## 一、AI Harness 架构

```
上层（Agent/应用）
   ↓
AI Harness 平台
  ├─ LLM 网关（多模型路由+限流+成本）
  ├─ 推理服务（vLLM 集群）
  ├─ 工具市场（MCP Server）
  ├─ 可观测（Trace/Metrics）
  └─ 评估平台（离线+在线）
   ↓
基础设施（GPU 集群、向量库、知识库）
```

## 二、LLM 网关

```java
public class LLMGateway {
    public Completion complete(Request req) {
        String model = router.select(req.getScenario());  // 场景路由
        rateLimiter.tryAcquire(req.getUserId());            // 限流
        quotaChecker.check(req);                            // 配额
        try {
            return callWithFallback(model, req);            // 带降级
        } catch (Exception e) {
            return fallback(req);                           // 降级规则
        }
    }
}
```

- 路由：简单场景 → 便宜模型；复杂 → 强模型
- 成本：实时 token 统计 + 预算告警
- 降级：主模型挂 fallback 到备模型

## 三、推理优化

- **vLLM/PagedAttention**：KV cache 分页管理，吞吐 5-10 倍
- **量化**：INT8/INT4，速度 +2-3 倍
- **批处理**：Continuous Batching，GPU 持续满载

## 四、工具管理（MCP）

```yaml
tools:
  - name: query_inventory
    mcp_server: scm-tools
  - name: create_purchase
    mcp_server: scm-tools
```

Agent 按需调用，统一注册发现。

## 五、评估闭环

```
LLM 决策 → 落库 → 人工标注（对/错）→ 微调 → 灰度上线
```

## 六、底层本质

AI Harness 是 LLM 时代的"操作系统"——上层（Agent）不关心底层（模型/GPU/工具），底层细节由 Harness 管理。

## 常见考点
1. **LLM 推理最有效优化**？——vLLM/PagedAttention（吞吐 5-10 倍）+ 量化。
2. **多模型怎么路由**？——按场景（简单/复杂）+ 成本（便宜/贵）+ 可用性。
3. **怎么评估 LLM 决策质量**？——人工标注测试集 + A/B + 业务指标。
