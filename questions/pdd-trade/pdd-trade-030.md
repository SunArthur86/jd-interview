---
id: pdd-trade-030
difficulty: L4
category: pdd-trade
subcategory: 可观测性
tags:
- 拼多多
- 交易
- 可观测性
- 跨团队治理
- 稳定性
feynman:
  essence: 可观测性是"系统的眼睛"——Metrics（聚合数字）+ Logs（明细事件）+ Traces（链路因果）三支柱，跨团队治理需统一标准（traceId/SLO/告警收敛）。
  analogy: 可观测性像医院的"监护系统"——Metrics 是心率血压（数字）、Logs 是病历（事件明细）、Traces 是会诊记录（跨科室因果链）。
  first_principle: 复杂系统无法事前穷举所有故障，必须通过外部表现（指标/日志/链路）反推内部状态。
  key_points:
  - 三支柱：Metrics（Prometheus）/Logs（ELK）/Traces（SkyWalking）
  - 跨团队：统一 traceId 透传 + SLO 协议 + 告警收敛
  - SLO：错误预算驱动优先级
  - 治理：可观测性作为基础能力，标准化接入
first_principle:
  problem: 微服务/多团队下，如何快速定位故障、定义责任、收敛告警？
  axioms:
  - 复杂系统黑盒，需外部观测
  - 跨团队需统一协议
  - 告警过多会麻木
  rebuild: 三支柱 + 统一协议（traceId/SLO） + 告警治理。
follow_up:
  - traceId 怎么跨进程透传？——HTTP header/Kafka header 透传
  - 告警风暴怎么收敛？——按根因聚合+降噪+分级值班
  - SLO 怎么定？——核心接口 RT p99 < 200ms、可用性 99.99%
memory_points:
  - 三支柱：Metrics/Logs/Traces
  - 跨团队：统一 traceId + SLO
  - 错误预算驱动优先级
  - 治理：标准化接入
---

# 【拼多多交易】可观测性怎么治理跨团队？

> JD 依据："高可用"、"稳定性治理"。

## 一、三支柱

```
Metrics（指标）: Prometheus + Grafana，聚合数字（QPS/RT/错误率）
Logs（日志）   : ELK/Loki，明细事件（错误日志/业务流水）
Traces（链路） : SkyWalking/Jaeger，跨服务因果（一次请求全链路）
```

三支柱互补：
- Metrics 快速发现（告警触发）
- Traces 定位因果（哪个服务慢）
- Logs 查明细（错误堆栈）

## 二、统一协议（跨团队关键）

**traceId 全链路透传**：
```java
// HTTP 入口（网关）
String traceId = req.getHeader("X-Trace-Id");
MDC.put("traceId", traceId);

// 跨服务调用（Feign）
@Bean
public RequestInterceptor traceInterceptor() {
    return template -> template.header("X-Trace-Id", MDC.get("traceId"));
}

// 跨 Kafka
@KafkaListener(topics = "order")
public void on(ConsumerRecord<String, String> record) {
    MDC.put("traceId", record.headers().lastHeader("X-Trace-Id").value());
}
```

**日志格式统一**：所有团队 JSON 结构化日志，含 traceId/spanId/uid/接口。
```json
{"ts":"2026-07-08T12:00:00","traceId":"abc123","uid":"123","api":"createOrder","level":"ERROR","msg":"库存不足"}
```

## 三、SLO 驱动治理

**SLO 定义**（核心接口）：
```
下单接口：可用性 99.99%，p99 RT < 300ms
支付接口：可用性 99.99%，p99 RT < 500ms
```

**错误预算**：
```
30 天 99.99% 可用性 → 允许 4.3 分钟不可用
错误预算耗尽 → 冻结新功能发布，全力稳定性
```

**跨团队责任划分**：
- SLO 达标：负责团队 OK
- SLO 不达标：必须修复，不可推诿
- 跨团队故障：用 traceId 定位根因，按 SLO 协议定责

## 四、告警治理（防风暴）

```
原始告警（10万/天）
  ├─ 聚合（同根因合并）
  ├─ 降噪（已知问题/维护期）
  ├─ 分级（P0 电话/P1 钉钉/P2 邮件）
  └─ 值班（轮值，避免单人）
→ 有效告警（100/天）
```

```java
// AlertManager 告警收敛规则
groups:
  - name: trade-rt
    rules:
      - alert: TradeRtHigh
        condition: rt_p99 > 500ms for 2m
        annotations:
          summary: "交易 RT 高，traceId 见关联链路"
```

## 五、可观测性平台化

```
业务团队 → 接入 SDK（自动埋点）→ 可观测性平台
                                  ├─ Metrics 看板
                                  ├─ Logs 查询
                                  ├─ Traces 链路
                                  └─ 告警/预案联动
```

标准化：所有 Java 服务引 SDK 自动埋点，业务无感接入。

## 六、拼多多实战

- **全链路追踪**：SkyWalking，一次请求跨 30+ 服务，秒级定位慢点
- **SLO 平台**：核心接口 200+ SLO，错误预算驱动版本节奏
- **告警收敛**：从 10 万/天降到 100/天，值班不再麻木
- **大促作战室**：实时大盘（订单/支付/RT/错误率），异常秒级告警

## 七、底层本质

可观测性本质是**"用外部表现反推内部状态"**——三支柱覆盖数字/明细/因果，跨团队靠统一协议（traceId/SLO），治理靠错误预算和告警收敛。本质是把"黑盒系统"变"白盒"。

## 常见考点
1. **Metrics 和 Logs 区别**？——Metrics 聚合数字（便宜，适合告警），Logs 明细（贵，适合查因）。
2. **traceId 怎么保证全局唯一**？——网关生成（雪花/UUID），下游透传，Kafka header 携带。
3. **SLO 和 SLA 区别**？——SLO 内部目标（99.99%），SLA 对外承诺（赔款条款）。
