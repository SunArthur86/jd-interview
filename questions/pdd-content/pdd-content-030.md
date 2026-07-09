---
id: pdd-content-030
difficulty: L4
category: pdd-content
subcategory: 可观测性
tags:
- 拼多多
- 内容
- 可观测性
- 监控
- 日志
- 链路
- 治理
- 跨团队
feynman:
  essence: 可观测性是"日志+指标+链路"三支柱+告警；内容社区跨团队治理用统一规范（traceId/SLO）+协同机制（on-call/复盘）保证。
  analogy: 可观测性像医院监护仪——指标是心率（实时数）、日志是病历（细节）、链路是检查流程（追踪），跨团队是会诊。
  first_principle: 分布式系统黑盒难调，需把内部状态暴露出来+跨团队协作。
  key_points:
  - 三支柱：Logging/Metrics/Tracing
  - 告警：阈值+趋势+异常检测
  - SLO：服务等级目标（可用性/延迟）
  - 跨团队：规范统一+on-call+复盘
first_principle:
  problem: 分布式系统黑盒难调，如何暴露状态+跨团队协作？
  axioms:
  - 系统复杂（多服务跨团队）
  - 故障需快速定位
  - 跨团队依赖多
  rebuild: 三支柱+SLO+协同机制。
follow_up:
  - 三支柱怎么关联？——traceId 串联日志/指标/链路
  - SLO 怎么定？——可用性 99.9%+延迟 P99 <200ms
  - 跨团队故障怎么定责？——联合复盘+无指责文化+SLO 兜底
memory_points:
  - 三支柱：Logging/Metrics/Tracing
  - 关联：traceId 串联
  - SLO：可用性+延迟
  - 协同：on-call+复盘
---

# 【拼多多内容】可观测性与跨团队治理？

> JD 依据："监控"、"稳定性建设"、"和算法同学挖掘业务问题"。

## 一、三支柱

**1. Logging（日志）**：
- ELK（Elasticsearch+Logstash+Kibana）
- 结构化日志（JSON）
- 分级（DEBUG/INFO/WARN/ERROR）

```java
log.info("submit_review|uid={}|productId={}|reviewId={}|cost={}ms",
    uid, productId, reviewId, cost);
// 结构化便于检索
```

**2. Metrics（指标）**：
- Prometheus + Grafana
- 四大黄金信号：延迟/流量/错误/饱和度
- RED 方法：Rate/Error/Duration

```
review_submit_total{result="success"}    # 计数
review_submit_duration_seconds           # 直方图（P50/P90/P99）
review_service_cpu_usage                 # 饱和度
```

**3. Tracing（链路）**：
- SkyWalking / Jaeger / Zipkin
- traceId 全链路透传
- span 看每段耗时

```
请求 → 网关 span → 评价服务 span → DB span
                    ↓ → ES span
                    ↓ → Kafka span
traceId=abc 串联所有
```

## 二、traceId 串联三支柱

```
请求进来 → MDC 注入 traceId
  ↓
日志带 traceId（每行日志能定位到请求）
  ↓
Metrics 标签带 traceId（异常时关联日志）
  ↓
Tracing spanId 关联（看耗时分布）
```

```java
@Component
public class TraceInterceptor implements HandlerInterceptor {
    public boolean preHandle(HttpServletRequest req, ...) {
        String traceId = req.getHeader("X-Trace-Id");
        if (traceId == null) traceId = UUID.randomUUID().toString();
        MDC.put("traceId", traceId);      // 日志框架读取
        return true;
    }
}
```

## 三、告警

**告警分级**：
- P0（电话+短信）：核心服务挂/数据错乱
- P1（短信+钉钉）：核心功能异常率超阈值
- P2（钉钉）：非核心功能异常
- P3（邮件）：观察项

**告警原则**：
- 基于症状（用户影响）而非原因
- 阈值合理（不要狼来了）
- 收敛（一个故障不要触发 100 条告警）
- 可执行（告警含排查指引）

```yaml
# Prometheus 告警规则
- alert: ReviewServiceHighErrorRate
  expr: |
    rate(review_submit_total{result="error"}[5m])
    / rate(review_submit_total[5m]) > 0.05
  for: 5m
  labels:
    severity: P1
  annotations:
    summary: "评价服务错误率超 5%"
    runbook: "https://wiki/.../review-troubleshoot"
```

## 四、SLO（Service Level Objective）

**SLI（指标）**：
- 可用性：成功请求数/总请求数
- 延迟：P99 < 200ms
- 正确性：数据一致率

**SLO（目标）**：
```
评价服务 SLO：
  可用性 ≥ 99.9%（每月宕机 < 43 分钟）
  延迟 P99 < 200ms
  写入成功率 ≥ 99.5%

直播服务 SLO：
  可用性 ≥ 99.95%
  起播时间 < 2s
  卡顿率 < 5%
```

**Error Budget（错误预算）**：
```
99.9% 可用性 → 每月 43 分钟故障预算
用完 → 停止新功能发布，专注稳定性
```

## 五、跨团队治理

**统一规范**：
- 日志格式（key=value）
- 指标命名（service_action_total）
- traceId 透传（HTTP Header）
- 错误码统一

**协同机制**：
- **on-call 轮值**：每团队值班，故障第一响应
- **联合复盘**：跨团队故障，无指责文化
- **变更通知**：跨团队依赖变更要通知
- **依赖注册**：上游知道下游依赖（影响评估）

**复盘（Postmortem）**：
```
故障复盘模板：
  - 时间线（什么时候发现/处理/恢复）
  - 影响范围（用户/业务）
  - 根因（5 why 追问）
  - 改进项（短期/长期）
  - 责任人 + deadline
无指责文化：对事不对人，重点改系统而非追责
```

## 六、内容场景实战

**评价服务监控**：
```
Metrics：
  - review_submit_qps（写入 QPS）
  - review_query_p99（查询延迟）
  - review_audit_delay（审核延迟）
  - review_rating_drift（评分漂移，定时校准对比）

Logging：
  - 提交/审核/上下架日志
  - 反作弊命中日志

Tracing：
  - 用户提交评价 → 写库 → 发 Kafka → 审核 → 同步 ES → 推送
```

**直播监控**（特别实时）：
```
- 同时在线数（Redis 实时）
- 弹幕 QPS（Kafka 流量）
- 推流码率/帧率
- CDN 命中率/带宽
- 端到端延迟
- 观众卡顿率（客户端上报）
```

**跨团队协同**：
- 评价服务依赖：商品/订单/搜索/推荐/通知
- 直播依赖：CDN/转码/审核/推荐/计费
- 故障时多方协同（联合群+电话会议）

## 七、与算法同学协作

```
监控模型效果（与算法同学）：
  - 推荐模型 CTR/停留时长
  - 审核模型准确率/召回率
  - 评分聚合异常（业务问题反馈算法）

数据驱动：
  - 业务问题（如评价质量下降）→ 算法优化
  - 算法效果 → 业务指标
```

## 八、底层本质

可观测性本质是**"把分布式黑盒变成白盒"**——三支柱（日志/指标/链路）+traceId 串联+SLO 量化+跨团队协同；治理的本质是统一规范+协同机制+无指责文化。

## 常见考点
1. **三大支柱怎么关联**？——traceId 贯穿日志/指标/链路。
2. **告警怎么避免狼来了**？——基于症状+合理阈值+收敛+可执行。
3. **跨团队故障怎么处理**？——on-call 第一响应+联合复盘+改进项跟进。
