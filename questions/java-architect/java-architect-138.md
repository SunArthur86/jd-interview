---
id: java-architect-138
difficulty: L3
category: java-architect
subcategory: 队列
tags:
- Java 架构师
- 消息积压
- 扩容
- 降级
feynman:
  essence: 消息积压的本质是"生产速率 > 消费速率"，治理三板斧：定位（找瓶颈）、扩容（提消费速率）、降级（降生产速率）。定位要先分"分区倾斜"还是"全局慢"——前者是热点 key（如大商家订单），后者是消费者处理慢或上游突增。扩容按"消费者数 ≤ 分区数"扩，超出无效。降级包括"上游限流 + 下游跳过非核心处理 + 死信转移"。
  analogy: 像超市收银台排队。生产是顾客进店速率，消费是收银台处理速率。积压是队伍越来越长。定位：是某个收银台慢（分区倾斜）还是全部慢（消费者慢）？扩容：开更多收银台（加消费者）。降级：限制进店（限流）、跳过会员积分登记（跳过非核心）、引导顾客离店（死信）。
  first_principle: 为什么积压不可避免？因为流量有突发（大促、营销活动），而消费能力是固定的（机器固定）。治理不是"消灭积压"而是"让积压可控、可恢复、不影响核心 SLA"。
  key_points:
  - 定位三板斧：看 lag 分布（分区倾斜 vs 全局慢）、看消费者 GC/慢 SQL、看上游突增
  - 扩容：消费者数 ≤ 分区数；扩消费者前先确认分区数够
  - 降级三招：上游限流、跳过非核心、死信队列
  - 监控：consumer_lag 按分区维度、produce_rate vs consume_rate、consumer_latency_p99
  - 告警阈值：lag > 10 万、lag 持续增长 5 分钟、rebalance 频率
first_principle:
  problem: 流量突发或消费者故障时，消息积压如何快速恢复，避免业务雪崩？
  axioms:
  - 流量突发不可避免（大促、营销、依赖故障）
  - 消费者数受分区数限制（一个分区只能给一个消费者）
  - 慢消费路径会拖垮整个链路（如慢 SQL、外部 API 超时）
  rebuild: 三层防御。第一层，监控——按分区维度的 lag + produce/consume 速率对比，5 分钟持续增长告警。第二层，扩容——分区倾斜加消费者或重新分区；全局慢加消费者实例（前提分区数够）+ 跳过非核心处理（如不写 ES）。第三层，降级——上游限流（保护消费者）、死信队列（隔离毒消息）、流量调度（大促前预热 + 资源预留）。
follow_up:
  - 分区倾斜怎么治？——按 hash(key) 重新分区（避免热点 key 集中），或对大 key（如大商家）单独分区。临时方案是"打散"——把热点 key 加随机后缀分到多分区。
  - 消费者扩容没分区用怎么办？——只能加分区（Kafka 只能加不能减），或临时把消费组拆成多个消费组（每个消费不同 key 范围）。
  - 怎么判断是消费者慢还是上游突增？——对比 produce_rate 和 consume_rate：produce_rate >> consume_rate 是上游突增；produce_rate ≈ consume_rate 但都涨了是流量双增；produce_rate 涨但 consume_rate 不涨是消费者卡。
  - 死信队列怎么设计？——处理失败 N 次（如 3 次）后转发到 DLQ topic，DLQ 单独消费组（人工或定时任务处理）。注意 DLQ 也要监控，避免无限堆积。
  - 积压期间业务怎么办？——核心业务（支付）走降级路径（同步调核心 API，不依赖消息）；非核心（push/通知）容忍延迟。
memory_points:
  - 定位：分区倾斜 vs 全局慢（看 lag 分布）
  - 扩容：消费者数 ≤ 分区数，加分区只能加不能减
  - 降级三招：上游限流、跳过非核心、死信队列
  - 监控：lag 按分区、produce/consume 速率对比、5 分钟持续增长告警
  - 雪崩防范：积压期间核心业务降级路径（同步直调）
---

# 【Java 后端架构师】消息队列积压的定位、扩容与降级

> 适用场景：JD 核心技术。京东大促期间订单 topic 峰值 50 万 QPS，正常消费能力 30 万 QPS，积压从 0 涨到 1000 万只用了 5 分钟。如果没有"定位 + 扩容 + 降级"三板斧，积压会持续膨胀导致 DB 被打爆（消费重试）、用户超时（订单状态延迟）、连锁雪崩。

## 一、概念层

**积压定位决策树**（必画）：

```
告警：consumer_lag > 10 万
   │
   ▼
看 lag 分布（按分区）
   │
   ├── lag 集中在某几个分区（分区倾斜）
   │      │
   │      ▼
   │   根因：热点 key（如大商家订单集中到同分区）
   │   解法：重新分区 / 热点 key 打散
   │
   ├── lag 均匀分布在所有分区（全局慢）
   │      │
   │      ▼
   │   对比 produce_rate vs consume_rate
   │      │
   │      ├── produce >> consume：上游突增
   │      │      解法：扩消费者 + 上游限流
   │      │
   │      ├── produce ≈ consume 但都涨了：流量双增
   │      │      解法：扩消费者（前提分区够）
   │      │
   │      └── produce 涨但 consume 不涨：消费者卡
   │             解法：看消费者 GC / 慢 SQL / rebalance
   │
   └── 部分消费者 lag 涨（消费者故障）
          解法：看消费者实例健康度 / 重启 / 扩容
```

**积压的影响**：
- 用户感知：订单状态延迟更新、通知收不到、操作超时
- 系统压力：消费重试打 DB、消费者内存涨（buffer 消息）、依赖连锁故障
- 数据一致性：最终一致窗口拉长（如订单和库存对不上）

## 二、机制层：定位三板斧

**1. 看 lag 分布（按分区）**：

```bash
# Kafka
kafka-consumer-groups.sh --bootstrap-server broker:9092 \
    --describe --group order_consumer_group

# 输出：
# TOPIC    PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG  CONSUMER-ID
# orders   0          1000000         1100000         100000  consumer-1
# orders   1          1000000         1500000         500000  consumer-2
# orders   2          1000000         1050000         50000   consumer-3
# ...
# 看分布：分区 1 lag 50 万，其他 < 10 万 → 分区倾斜（热点 key）

# Redis Stream
XINFO STREAM orders
XINFO GROUPS orders
XPENDING orders order_group
```

**2. 看消费者健康度**：

```bash
# 看消费者实例
kafka-consumer-groups.sh --bootstrap-server broker:9092 \
    --describe --group order_consumer_group --members --verbose
# 看 CONSUMER-ID 列表是否完整、是否有空实例

# 看消费者 GC（jstat）
jstat -gcutil <pid> 1000
# 关注 FGC（Full GC 次数）、GCT（GC 总耗时）
# 频繁 Full GC = 消费者卡

# 看消费者慢日志
# MySQL slow_query_log
# 业务日志的 P99 延迟

# 看消费者是否频繁 rebalance
kafka-consumer-groups.sh --describe --group order_consumer_group --state
# 看 GROUP STATE 变化频率
```

**3. 看上游突增**：

```bash
# Kafka 看 produce 速率
kafka.run-class.sh kafka.tools.GetOffsetShell \
    --broker-list broker:9092 --topic orders --time -1
# 多次采样算每秒 offset 增量

# 监控大盘：produce_rate / consume_rate / lag 三条线对比
# 突增标志：produce_rate 突然从 10 万跳到 50 万
```

## 三、机制层：扩容方案

**扩容决策矩阵**：

| 场景 | 扩容方式 | 限制 |
|------|---------|------|
| 消费者数 < 分区数 | 加消费者实例（最直接） | 受分区数上限 |
| 消费者数 = 分区数 | 加分区（Kafka 只能加） | 历史数据不动 |
| 分区倾斜 | 热点 key 重新分区 | 改 producer 路由 |
| 消费者卡 | 重启 + 优化代码 | - |

**扩消费者代码**（注意分区数限制）：

```java
// Kafka 消费者配置
props.put("group.id", "order_consumer_group");
props.put("max.poll.records", "500");           // 单次拉 500 条
props.put("max.poll.interval.ms", "300000");    // 5 分钟处理时间
props.put("session.timeout.ms", "30000");
props.put("fetch.min.bytes", "1024");           // 攒批
props.put("fetch.max.wait.ms", "500");

// 假设分区数 = 12，启动 12 个消费者实例 = 满并行
// 启动 13 个没用（第 13 个闲置）
// 扩容到 24 个要先加分区到 24
```

**加分区（Kafka）**：

```bash
# 加分区（只能加，不能减）
kafka-topics.sh --bootstrap-server broker:9092 \
    --alter --topic orders --partitions 24

# 注意：历史数据不重新分区，新分区只接收新消息
# producer 路由 hash(key) % partitions 会变，破坏现有顺序保证
```

**分区倾斜临时方案**（热点 key 打散）：

```java
// 原本：hash(merchant_id) % partitions → 大商家集中到同分区
// 打散：merchant_id + "_" + random.nextInt(10) → 分散到 10 个分区

public String routeKey(String merchantId) {
    if (isHotKey(merchantId)) {
        return merchantId + "_" + ThreadLocalRandom.current().nextInt(10);
    }
    return merchantId;
}
// 消费时按 merchantId 聚合（去重），不依赖分区顺序
```

## 四、机制层：降级三招

**1. 上游限流（保护消费者）**：

```java
// 上游 producer 限流（如 Sentinel）
@SentinelResource(value = "sendOrderEvent", blockHandler = "blockHandler")
public void sendOrderEvent(OrderEvent event) {
    producer.send(new ProducerRecord<>("orders", event.getUserId(),
        JSON.toJSONString(event)));
}

public void blockHandler(OrderEvent event, BlockException ex) {
    // 限流后落到本地队列 + 持久化（如 SQLite/LevelDB），稍后补发
    localBuffer.offer(event);
    log.warn("Producer rate limited, buffered locally");
}
```

**2. 跳过非核心处理（保核心 SLA）**：

```java
@Service
public class OrderConsumer {

    @Value("${feature.es-write-enabled:true}")
    private boolean esWriteEnabled;

    @Value("${feature.notification-enabled:true}")
    private boolean notificationEnabled;

    public void consume(OrderEvent event) {
        // 核心：更新订单状态（必做）
        orderService.updateStatus(event);

        // 非核心 1：写 ES 搜索索引（积压时关闭）
        if (esWriteEnabled) {
            esService.index(event);
        }

        // 非核心 2：发通知（积压时关闭）
        if (notificationEnabled) {
            notifyService.send(event);
        }
    }
}

// 配置中心动态切换（不重启）
// POST /config { "feature.es-write-enabled": false }
```

**3. 死信队列（隔离毒消息）**：

```java
@Service
public class OrderConsumer {

    @Autowired private KafkaTemplate<String, String> kafka;

    public void consume(ConsumerRecord<String, String> record) {
        String msgId = record.key();
        int retryCount = getRetryCount(msgId);

        try {
            process(record.value());
            clearRetry(msgId);
        } catch (Exception e) {
            if (retryCount >= 3) {
                // 进死信队列
                kafka.send("orders.DLQ", msgId,
                    JSON.toJSONString(Map.of(
                        "original_value", record.value(),
                        "error", e.getMessage(),
                        "retry_count", retryCount,
                        "timestamp", System.currentTimeMillis()
                    )));
                log.error("Message moved to DLQ: " + msgId, e);
            } else {
                // 重试（指数退避）
                scheduleRetry(msgId, retryCount + 1, backoff(retryCount));
                throw e;  // 不 ack，Kafka 重投
            }
        }
    }

    private long backoff(int retry) {
        return (long) Math.pow(2, retry) * 1000;  // 1s, 2s, 4s
    }
}
```

## 五、实战层/选型：积压应急 SOP

**积压应急标准操作流程**：

```
触发告警：lag > 10 万 持续 5 分钟
   │
   ▼
1. 立即定位（5 分钟内）
   - 看 lag 分布（分区倾斜 vs 全局慢）
   - 看 produce/consume 速率对比
   - 看消费者 GC、慢 SQL、rebalance
   │
   ▼
2. 应急动作（10 分钟内）
   - 分区倾斜 → 热点 key 打散
   - 全局慢 → 扩消费者实例（前提分区够）
   - 消费者卡 → 重启 + 关闭非核心处理
   - 上游突增 → 限流 + 资源临时扩容
   │
   ▼
3. 持续观察（15-30 分钟）
   - lag 是否下降？
   - 是 → 持续到清空
   - 否 → 进入 4
   │
   ▼
4. 升级响应（30 分钟未恢复）
   - 加分区（Kafka）
   - 启动备用消费组（双消费组分担）
   - 上游全局限流
   - 业务降级（核心走同步直调）
   │
   ▼
5. 复盘
   - 根因（容量评估错误？热点 key 没识别？）
   - 改进（加监控、调阈值、优化代码、预案演练）
```

**JD 大促前的容量预留**：

```yaml
# 大促前预案
capacity_planning:
  expected_peak_qps: 500000
  consume_capacity_per_instance: 5000
  required_instances: 100
  reserved_instances: 120           # 20% 余量
  partitions: 150                   # 分区数 > 消费者数留扩容空间

alerting:
  lag_threshold: 100000
  lag_growth_alert: "5min continuous growth"
  produce_consume_gap: "ratio > 1.5 for 3min"

degradation:
  auto_disable_es_write: "lag > 500000"
  auto_disable_notification: "lag > 1M"
  upstream_rate_limit: "lag > 2M"
```

## 六、底层本质：流量与容量的博弈

回到第一性：**积压是"流量峰值"和"消费容量"的博弈结果**。

- **流量本质是突发的**：大促、营销、依赖故障导致流量瞬间跳变。流量曲线是尖刺，不是平滑的。
- **消费容量本质是固定的**：机器固定、分区数固定、消费逻辑固定。容量曲线是水平线。
- **积压 = 流量峰值 > 消费容量**，时间窗口内的累积差值。

**为什么不能"无脑扩容"**：
- 扩容有上限（分区数限制消费者数）
- 扩容有延迟（启动实例、加载缓存、预热需要时间）
- 扩容有成本（机器要钱，平时闲置浪费）

**治理的本质**：让积压"可控、可恢复、不影响核心 SLA"。
- 可控：监控告警让积压第一时间发现
- 可恢复：扩容 + 降级让积压能消化
- 不影响核心：核心业务（支付）走降级路径（同步直调），不依赖消息

**雪崩防范的本质**：积压期间消费者处理慢 → 重试打 DB → DB 慢 → 消费者更慢 → 雪崩。防范：
- 重试有上限（3 次进死信）
- 死信单独处理（不打主 DB）
- 核心业务绕过消息（同步直调，避免依赖）

## 七、AI 架构师加问：5 个

1. **LLM 推理服务积压怎么处理？**
   推理请求积压时按"优先级 + 超时降级"处理：高优先级（付费用户）走专用队列，低优先级（免费）延后或拒绝；超过 N 秒的请求直接返回降级结果（如缓存答案或 default）。

2. **用 LLM 预测积压风险？**
   LLM 读历史流量模式 + 大促日历 + 依赖健康度，预测"明天 X 时段可能积压"，提前扩容。但预测只是建议，扩容决策人工确认。

3. **LLM 自动定位积压根因？**
   LLM 读 lag 分布 + GC 日志 + 慢 SQL + traceId，分类根因（分区倾斜、消费者卡、上游突增、依赖故障），给修复建议。这是确定性归因，LLM 擅长模式匹配。

4. **AI Agent 调用 Kafka 工具治理积压，怎么授权？**
   只读命令（lag 查询、describe）免审批；写命令（create topic、alter partition、restart consumer）必须人工审批 + 审计日志 + dry-run 预演。高危命令（delete topic）二次确认。

5. **用 LLM 自动生成降级策略？**
   LLM 读业务拓扑（哪些是非核心路径）→ 推荐降级顺序（先关 ES 写、再关通知、最后限流）。但策略上线前必须人工 review，避免误关核心。

## 八、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"定位三看、扩容分区限、降级三招"**。

- **定位三看**：看 lag 分布（分区倾斜 vs 全局慢）、看消费者健康（GC/慢SQL/rebalance）、看上游速率（突增）
- **扩容**：消费者数 ≤ 分区数；加分区只能加不能减；分区倾斜先打散热点 key
- **降级三招**：上游限流、跳过非核心（动态开关）、死信队列
- **雪崩防范**：重试有上限、死信单独处理、核心业务绕过消息
- **容量预留**：大促前分区数 > 消费者数，留扩容空间

### 拟人化理解

把消息积压想成**超市收银台排队**。生产是顾客进店速率，消费是收银速率。积压是队伍变长。定位：是某个收银台慢（分区倾斜，某个顾客买太多）还是全部慢（消费者慢）？扩容：开更多收银台（加消费者，但收银台数量受限于分区数）。降级：限制进店（上游限流）、跳过会员积分登记（跳过非核心）、引导顾客离店（死信）。雪崩防范：收银台故障时让 VIP 走快速通道（核心业务同步直调，不等收银）。

### 面试现场 60 秒回答

> 积压治理三板斧：定位、扩容、降级。定位先看 lag 分布——分区倾斜是热点 key（大商家订单集中），全局慢是消费者卡或上游突增；对比 produce_rate 和 consume_rate 判断。扩容按"消费者数 ≤ 分区数"扩，加分区只能加不能减；分区倾斜先打散热点 key（key 加随机后缀）。降级三招：上游限流（保护消费者）、跳过非核心处理（动态配置关 ES 写、关通知）、死信队列（处理失败 N 次隔离）。雪崩防范：重试有上限（3 次进 DLQ）、死信单独处理、核心业务（支付）走同步直调绕过消息。大促前预案：分区数 > 消费者数留扩容空间、监控告警（lag > 10 万 + 持续 5 分钟）、自动降级开关（lag > 50 万关 ES）。最大坑是分区数定少了——大促时分区满了消费者扩不动。

### 反问面试官

> 贵司核心 topic 分区数多少？大促时积压阈值告警怎么设？有没有自动降级开关？死信队列怎么处理？

## 九、苏格拉底式面试追问（7 层表格 + 现场对话）

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不直接"加机器"解决积压？ | 用分区数限制说话：消费者数 ≤ 分区数，分区满了加机器没用；加分区历史数据不动 + 破坏顺序；机器启动有延迟（启动到满消费要几分钟） |
| 证据追问 | 怎么证明积压治理有效？ | MTTR（平均恢复时间）应 < 30 分钟；积压峰值 / 持续时间；积压期间核心 SLA 是否保持；扩容响应时间（告警到扩容生效） |
| 边界追问 | 积压能完全消灭吗？ | 不能。流量突发 > 容量是常态。治理目标是"可控可恢复不影响核心"，不是"零积压"。零积压需要容量 = 峰值，成本不可承受 |
| 反例追问 | 什么场景不该扩容？ | 分区倾斜（扩容没用，要先打散热点）；消费者卡（扩容只是多几个卡的实例，要先修代码）；上游突增是临时（等流量下来自然恢复） |
| 风险追问 | 积压治理最大风险？ | 主动点出：分区数定少了（扩容天花板）、降级误关核心（开关命名/分级混乱）、死信队列堆积（DLQ 也要监控）、rebalance 风暴（扩容时频繁 rebalance） |
| 验证追问 | 怎么验证降级真的生效？ | 故障演练：人工制造积压（暂停消费者），观察降级开关是否自动触发；压测：模拟大促流量看扩容是否能消化；监控 produce/consume/lag 三条线 |
| 沉淀追问 | 团队积压治理沉淀什么？ | 应急 SOP（定位→扩容→降级）、监控大盘（lag 按分区 + 速率对比 + 告警阈值）、降级开关分级（核心/非核心）、大促容量评估模板、热点 key 识别工具 |

### 现场对话示例

**面试官**：积压期间核心业务怎么办？

**候选人**：核心业务（支付、下单）不能依赖消息最终一致，要走同步降级路径。具体：消息消费的是"事件分发"，核心逻辑（订单创建、支付扣款）走同步 RPC，消息只是异步通知（如给营销系统发事件）。积压期间，营销系统慢一点没关系（用户感知不到），但用户下单/支付必须秒级响应。京东实操：订单服务同步处理（写 DB + 立即返回），同时发 Kafka 事件给下游（营销、风控、BI）。下游消费慢是下游的事，不影响用户下单。如果下游是强依赖（如风控决策），那同步调（RPC + 超时熔断），不走消息。

**面试官**：分区倾斜怎么治？

**候选人**：分区倾斜的根因是热点 key（如大商家 merchant_id 集中到同分区）。三种治法。第一，重新分区——按 hash(merchant_id + salt) 路由，salt 是随机数（如 0-9），让大商家订单分散到 10 个分区。代价：消费时按 merchantId 聚合（去重），不依赖分区顺序。第二，热点 key 单独 topic——大商家订单发到独立 topic（如 orders_hot），普通订单发到 orders。代价：消费方要订阅两个 topic。第三，业务侧削峰——大商家订单不是每条都发，按时间窗口聚合（如每秒一条 summary）。京东实操：用方案 1（salt 打散），消费端按 merchantId + orderId 幂等聚合。

**面试官**：死信队列怎么设计？

**候选人**：DLQ 设计要点：(1) 隔离——DLQ 用独立 topic（如 orders.DLQ），主消费组不读；(2) 限次——主消费者重试 3 次失败后转发 DLQ；(3) 元数据——DLQ 消息含原消息 + 错误原因 + 重试次数 + 时间戳；(4) 监控——DLQ 也要监控堆积，超过阈值告警；(5) 处理——人工或定时任务处理 DLQ（修复后重新入主队列或丢弃）。坑：DLQ 无限堆积（要定期清理或归档），DLQ 消费失败再次进 DLQ（要防递归，DLQ 失败直接落 DB 人工处理）。

## 常见考点

1. **积压和延迟的区别？**——积压是"消息堆积"（lag 数量），延迟是"消息处理慢"（P99 时间）。积压可能延迟正常（消费者快但流量大），延迟可能积压正常（消费者慢但流量小）。
2. **rebalance 风暴怎么治？**——session.timeout.ms 调大（30s）、max.poll.interval.ms 调大（5min）、max.poll.records 调小（少拉快处理）、用 CooperativeStickyAssignor（增量 rebalance）、优雅停机主动退组。
3. **死信队列和延迟队列区别？**——DLQ 是"处理失败的消息隔离区"；延迟队列是"指定时间后才能消费的消息"。两者用途不同，但实现可以复用（如 RocketMQ 的延迟等级）。
4. **怎么避免消费雪崩？**——重试有上限（不无限重试打 DB）、超时降级（外部 API 超时返回默认）、熔断下游（Hystrix/Sentinel）、异步化（非核心异步处理）。
5. **积压期间能不能加分区？**——能加（Kafka 支持），但历史数据不动、顺序可能破坏（hash 路由变）。加分区是应急动作，不是首选（首选扩消费者）。

## 结构化回答

**30 秒电梯演讲：** 消息积压的本质是生产速率 > 消费速率，治理三板斧：定位（找瓶颈）、扩容（提消费速率）、降级（降生产速率）。定位要先分分区倾斜还是全局慢——前者是热点 key（如大商家订单），后者是消费者处理慢或上游突增。扩容按消费者数 ≤ 分区数扩，超出无效。降级包括上游限流 + 下游跳过非核心处理 + 死信转移

**展开框架：**
1. **定位三板斧** — 看 lag 分布（分区倾斜 vs 全局慢）、看消费者 GC/慢 SQL、看上游突增
2. **扩容** — 消费者数 ≤ 分区数；扩消费者前先确认分区数够
3. **降级三招** — 上游限流、跳过非核心、死信队列

**收尾：** 以上是我的整体思路。您想继续深入聊——分区倾斜怎么治？


## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：消息队列积压的定位、扩容与降级 | "这题一句话：消息积压的本质是生产速率 > 消费速率，治理三板斧：定位（找瓶颈）、扩容（提消费速率）、降级（降生产速率）。" | 开场钩子 |
| 0:15 | 像超市收银台排队类比图 | "打个比方：像超市收银台排队。" | 核心类比 |
| 0:40 | 定位三板斧示意/对比图 | "看 lag 分布（分区倾斜 vs 全局慢）、看消费者 GC/慢 SQL、看上游突增" | 定位三板斧要点 |
| 1:05 | 扩容示意/对比图 | "消费者数 ≤ 分区数；扩消费者前先确认分区数够" | 扩容要点 |
| 1:55 | 总结卡 | "记住：定位。下期见。" | 收尾 |
