---
id: java-architect-044
difficulty: L2
category: java-architect
subcategory: 压测
tags:
- Java 架构师
- 全链路压测
- 影子库
- 隔离
feynman:
  essence: "全链路压测在生产环境跑，最大风险是污染生产数据（产生假订单、扣真实库存、发假短信）。核心解法是\"压测流量打影子资源\"——压测请求带压测标（HTTP Header / ThreadLocal），全链路识别压测标后路由到影子库（orders_pt）、影子 MQ topic（order_events_pt）、影子 Redis key（pt_:）、影子 ES 索引（orders_pt）。压测流量和真实流量物理隔离，互不污染。"
  analogy: 像 JD 双 11 前全链路压测——真实订单在"真仓库"（生产库），压测订单在"模拟仓库"（影子库）。压测请求贴"压测标"标签，全链路各环节识别标签后把货送到模拟仓库。真实用户和压测流量井水不犯河水。压测结束一键清理模拟仓库（影子表），不影响真仓库。
  first_principle: 生产环境压测最真实（真流量形态、真数据规模、真依赖链），但污染生产数据不可接受。本质矛盾是"用真环境压测"vs"不污染真数据"。解法是"影子资源"——压测流量打影子资源（表/Topic/Key/Index），真流量打真资源。全链路识别压测标后路由分流，物理隔离保证不串台。代价是影子资源要建一套、压测标全链路传递（线程池/MQ/异步要透传）。
  key_points:
  - "压测标：HTTP Header（X-Pressure-Test: true）或 ThreadLocal 标记，全链路透传"
  - 影子表：DB 层 orders → orders_pt，压测流量写影子表
  - 影子 Topic：MQ 层 order_events → order_events_pt
  - 影子 Key：Redis 层 order:123 → pt_order:123（前缀隔离）
  - 影子 Index：ES 层 orders → orders_pt
  - 清理：压测结束一键 DROP/TRUNCATE 影子表、FLUSHDB 影子 key、DELETE 影子 index
first_principle:
  problem: 在生产环境跑全链路压测最真实，但如何避免压测流量污染生产数据（假订单、扣真库存、发假短信）？
  axioms:
  - 生产环境压测最真实（真流量形态、真数据规模、真依赖链路）
  - 但污染生产数据不可接受（假订单、扣真实库存、发虚假短信给真用户）
  - 全链路有多跳（应用 → DB → MQ → 下游应用 → 缓存 → ES），每跳都可能污染
  rebuild: "用\"压测标 + 影子资源\"做物理隔离。压测请求带压测标（HTTP Header X-Pressure-Test: true），网关识别后注入 ThreadLocal 标记。全链路每个环节识别 ThreadLocal 后路由到影子资源——DB 写 orders_pt 表、MQ 发 order_events_pt topic、Redis 写 pt_:key、ES 写 orders_pt 索引。真流量打真资源，压测流量打影子资源，井水不犯河水。难点是压测标全链路透传——线程池切换会丢 ThreadLocal（用 TransmittableThreadLocal）、MQ 消费时消费端也要恢复压测标、异步任务（@Async、定时任务）要透传。压测结束一键清理影子资源。"
follow_up:
  - 压测标怎么全链路透传？——HTTP Header 透传 + ThreadLocal（用 TransmittableThreadLocal 解决线程池丢失）+ MQ 消息属性（properties.put("pressureTest","true")）+ Redis/DB 数据本身带标。每跳都要透传，漏一跳就串台
  - 线程池为什么丢 ThreadLocal？——ThreadLocal 绑定线程，线程池复用线程（任务 A 的 ThreadLocal 残留影响任务 B）。用 TransmittableThreadLocal + TtlExecutors 包装线程池解决
  - 影子表怎么路由？——MyBatis 拦截器或动态数据源，识别 ThreadLocal 压测标后把表名 orders 改成 orders_pt。或 ShardingSphere 的 shadow rule
  - 压测数据怎么清理？——压测前记录影子资源（影子表、影子 key、影子 index），压测结束 TRUNCATE 影子表、FLUSHDB 影子 key、DELETE 影子 index。或用带 TTL 的 key 自动过期
  - 怎么验证压测真没污染生产？——压测后对账（生产订单数 vs 真实订单数，差异 = 0）、用户审计（无真实用户收到压测短信）、库存对账（真实库存无异常扣减）
memory_points:
  - "压测标：X-Pressure-Test: true Header + ThreadLocal，全链路透传"
  - 影子资源：orders_pt 表 / order_events_pt topic / pt_:key / orders_pt index
  - 线程池丢 ThreadLocal：用 TransmittableThreadLocal（阿里 TTL 框架）
  - 清理：压测结束 TRUNCATE 影子表 + FLUSHDB 影子 key + DELETE 影子 index
  - 验证：压测后对账生产数据，差异 = 0
---

# 【Java 后端架构师】全链路压测如何避免污染生产数据

> 适用场景：JD 双 11 大促前要在生产环境跑全链路压测，验证容量上限。但压测不能污染生产数据（产生假订单、扣真实库存、发虚假短信给真实用户）。架构师必须设计压测流量隔离方案——影子资源 + 压测标全链路透传。

## 一、概念层：全链路压测的数据污染风险

**污染场景**（不加隔离的灾难）：

```
压测请求下单 → 写订单表（生产订单被假订单淹没）
            → 扣库存（真实商品库存被扣光，真用户买不了）
            → 发短信（真实手机号收到"下单成功"短信，用户懵）
            → 调支付（产生真实支付请求，钱被扣）
            → 写 ES（搜索结果混入压测数据）
            → 发 MQ（下游消费者处理压测消息，污染下游）

污染后果：
  - 业务数据脏（订单、库存、用户数据被污染，账对不上）
  - 用户被骚扰（收到压测短信、push）
  - 资金风险（真实支付被触发）
  - 下游连锁污染（MQ 消息污染所有下游）
```

**隔离核心：影子资源 + 压测标透传**：

```
                    压测请求（带 X-Pressure-Test: true）
                              │
                       网关注入压测标
                              │
                       ThreadLocal 标记
                              │
          ┌──────────────┬────┴────┬──────────────┐
          │              │         │              │
       影子表          影子 MQ   影子 Redis    影子 ES
    (orders_pt)  (events_pt)  (pt_:key)   (orders_pt)
          │              │         │              │
    真流量走真表     真流量走真 MQ  真流量走真 key  真流量走真 ES
   压测流量走影子表  压测走影子    压测走 pt_    压测走影子 index
```

**真流量 vs 压测流量路由分流**：

| 资源类型 | 真流量（无压测标） | 压测流量（带压测标） |
|----------|--------------------|----------------------|
| DB 表 | orders | orders_pt |
| MQ Topic | order_events | order_events_pt |
| Redis Key | order:123 | pt_order:123 |
| ES Index | orders | orders_pt |
| 短信/推送 | 真实发送 | 拦截/丢弃（mock） |
| 支付 | 真实支付 | mock 返回成功 |

## 二、机制层：压测标的设计与注入

**压测标的形式**：

```http
HTTP 请求头注入：
GET /order/create HTTP/1.1
Host: api.jd.com
X-Pressure-Test: true          ← 压测标
X-Pressure-Test-TraceId: pt_xxx ← 压测链路追踪
```

**网关注入压测标**（Spring Cloud Gateway）：

```java
@Component
public class PressureTestGatewayFilter implements GlobalFilter, Ordered {

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
        String pressureFlag = exchange.getRequest().getHeaders()
            .getFirst("X-Pressure-Test");

        if ("true".equals(pressureFlag)) {
            // 注入压测上下文到请求属性
            exchange.getAttributes().put("PRESSURE_TEST", Boolean.TRUE);
            // 透传 Header 到下游
            exchange.getRequest().mutate()
                .header("X-Pressure-Test", "true")
                .build();
        }
        return chain.filter(exchange);
    }

    @Override
    public int getOrder() { return -100; }   // 最先执行
}
```

**应用层压测上下文**（ThreadLocal 透传）：

```java
// 压测上下文（用 TransmittableThreadLocal，解决线程池透传问题）
public class PressureTestContext {
    // 关键：用 TransmittableThreadLocal 而非 ThreadLocal
    // 否则线程池复用线程时压测标丢失
    private static final TransmittableThreadLocal<Boolean> FLAG =
        new TransmittableThreadLocal<>();

    public static void set(boolean isPressure) {
        FLAG.set(isPressure);
    }

    public static boolean isPressure() {
        return Boolean.TRUE.equals(FLAG.get());
    }

    public static void clear() {
        FLAG.remove();
    }
}

// Web 拦截器：从 HTTP Header 恢复压测标到 ThreadLocal
@Component
public class PressureTestInterceptor implements HandlerInterceptor {

    @Override
    public boolean preHandle(HttpServletRequest req, HttpServletResponse resp, Object h) {
        String flag = req.getHeader("X-Pressure-Test");
        PressureTestContext.set("true".equals(flag));
        return true;
    }

    @Override
    public void afterCompletion(HttpServletRequest req, HttpServletResponse resp,
                                 Object h, Exception e) {
        PressureTestContext.clear();   // 清理，防 ThreadLocal 泄漏
    }
}
```

## 三、机制层：线程池压测标透传（核心难点）

**问题：线程池复用线程丢 ThreadLocal**：

```java
// 错误：普通 ThreadLocal 在线程池下会丢失
// 线程池线程复用，任务 A 的压测标残留可能污染任务 B
ExecutorService pool = Executors.newFixedThreadPool(10);
pool.submit(() -> {
    // ThreadLocal 可能为 null（任务被另一线程执行）
    // 或残留上次任务的值（污染）
    Boolean flag = PressureTestContext.get();   // 不可靠！
});
```

**解法 1：TransmittableThreadLocal（阿里 TTL 框架）**：

```java
// 用 TransmittableThreadLocal + TtlExecutors 包装线程池
import com.alibaba.ttl.TransmittableThreadLocal;
import com.alibaba.ttl.threadpool.TtlExecutors;

// 压测标用 TransmittableThreadLocal（见上文 PressureTestContext）

// 线程池用 TtlExecutors 包装
ExecutorService pool = TtlExecutors.getTtlExecutorService(
    Executors.newFixedThreadPool(10)
);

// 现在 submit 任务时，TransmittableThreadLocal 会自动透传
pool.submit(() -> {
    Boolean flag = PressureTestContext.isPressure();   // 正确透传！
});
```

**解法 2：@Async 异步任务的透传**：

```java
@Configuration
@EnableAsync
public class AsyncConfig implements AsyncConfigurer {

    @Override
    public Executor getAsyncExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(10);
        // 关键：用 TtlExecutors 包装
        executor.setTaskDecorator(runnable ->
            TtlRunnable.get(runnable)   // 包装 Runnable，透传 TTL
        );
        executor.initialize();
        return executor;
    }
}

// 业务代码无感，@Async 自动透传压测标
@Async
public void asyncProcess() {
    Boolean flag = PressureTestContext.isPressure();   // 正确！
}
```

## 四、机制层：影子资源路由

**影子表路由**（MyBatis 拦截器）：

```java
@Intercepts({
    @Signature(type = StatementHandler.class, method = "prepare",
               args = {Connection.class, Integer.class})
})
public class ShadowTableInterceptor implements Interceptor {

    // 影子表映射：真表 → 影子表
    private static final Map<String, String> SHADOW_TABLES = Map.of(
        "orders", "orders_pt",
        "order_items", "order_items_pt",
        "inventory", "inventory_pt"
    );

    @Override
    public Object intercept(Invocation invocation) throws Throwable {
        if (!PressureTestContext.isPressure()) {
            return invocation.proceed();   // 真流量，不改 SQL
        }

        // 压测流量，改写 SQL 中的表名为影子表
        StatementHandler handler = (StatementHandler) invocation.getTarget();
        BoundSql boundSql = handler.getBoundSql();
        String sql = boundSql.getSql();

        // 简单示例：替换表名（生产用 SQL Parser 更严谨）
        for (Map.Entry<String, String> entry : SHADOW_TABLES.entrySet()) {
            sql = sql.replaceAll("\\b" + entry.getKey() + "\\b", entry.getValue());
        }

        // 反射修改 BoundSql 的 sql
        Field field = boundSql.getClass().getDeclaredField("sql");
        field.setAccessible(true);
        field.set(boundSql, sql);

        return invocation.proceed();
    }
}
```

**或用 ShardingSphere Shadow Rule**（更标准）：

```yaml
# ShardingSphere 影子规则配置
rules:
- !SHADOW
  dataSources:
    shadowDataSource:
      sourceDataSourceName: production_ds   # 真数据源
      shadowDataSourceName: shadow_ds       # 影子数据源
  tables:
    orders:
      dataSourceNames:
        - shadowDataSource
      shadowAlgorithmNames:
        - pressure-test-algorithm
  shadowAlgorithms:
    pressure-test-algorithm:
      type: REGEX_MATCH
      props:
        operation: insert|update|delete|select
        # 根据 Hint（ThreadLocal）路由
```

**影子 Redis Key**：

```java
@Component
public class PressureTestRedisTemplate {

    @Autowired
    private RedisTemplate<String, Object> redisTemplate;

    private static final String PT_PREFIX = "pt_";

    public void set(String key, Object value) {
        String realKey = PressureTestContext.isPressure()
            ? PT_PREFIX + key    // 压测：加 pt_ 前缀
            : key;               // 真流量：原 key
        redisTemplate.opsForValue().set(realKey, value);
    }

    public Object get(String key) {
        String realKey = PressureTestContext.isPressure()
            ? PT_PREFIX + key
            : key;
        return redisTemplate.opsForValue().get(realKey);
    }
}
```

**影子 MQ Topic**：

```java
// 生产端：压测流量发影子 topic
@Component
public class OrderEventProducer {

    @Autowired
    private RocketMQTemplate mqTemplate;

    public void sendOrderEvent(OrderEvent event) {
        String topic = PressureTestContext.isPressure()
            ? "order_events_pt"   // 影子 topic
            : "order_events";     // 真 topic

        Message<OrderEvent> msg = MessageBuilder.withPayload(event).build();

        // 关键：MQ 消息也带压测标（消费端恢复 ThreadLocal）
        if (PressureTestContext.isPressure()) {
            msg = MessageBuilder.withPayload(event)
                .setHeader("X-Pressure-Test", "true")
                .build();
        }

        mqTemplate.send(topic, msg);
    }
}

// 消费端：从 MQ 消息恢复压测标到 ThreadLocal
@RocketMQMessageListener(topic = {"order_events", "order_events_pt"})
public class OrderEventConsumer implements RocketMQListener<MessageExt> {

    @Override
    public void onMessage(MessageExt message) {
        try {
            // 从消息属性恢复压测标
            String ptFlag = message.getUserProperty("X-Pressure-Test");
            PressureTestContext.set("true".equals(ptFlag));

            // 业务处理（自动路由到影子资源）
            processOrderEvent(message.getBody());
        } finally {
            PressureTestContext.clear();
        }
    }
}
```

## 五、机制层：外部副作用的 mock

**短信/推送/支付等外部调用必须拦截**：

```java
@Component
public class SmsService {

    public void sendSms(String phone, String content) {
        if (PressureTestContext.isPressure()) {
            // 压测流量：不发真短信，只记日志
            log.info("[PT] mock sendSms to {}: {}", phone, content);
            return;
        }
        // 真流量：调真实短信网关
        smsGateway.send(phone, content);
    }
}

@Component
public class PaymentService {

    public PayResult pay(Order order) {
        if (PressureTestContext.isPressure()) {
            // 压测流量：mock 支付成功
            return PayResult.success("pt_mock_payment_" + order.getId());
        }
        // 真流量：调真实支付网关
        return realPaymentGateway.pay(order);
    }
}
```

## 六、机制层：压测数据清理

**清理脚本**（压测结束后执行）：

```bash
#!/bin/bash
# 压测数据清理脚本

echo "=== 1. 清理影子表 ==="
mysql -h production-db <<'EOF'
TRUNCATE TABLE orders_pt;
TRUNCATE TABLE order_items_pt;
TRUNCATE TABLE inventory_pt;
TRUNCATE TABLE payment_records_pt;
EOF

echo "=== 2. 清理影子 Redis Key（pt_ 前缀）==="
redis-cli --scan --pattern 'pt_*' | xargs -L 1000 redis-cli DEL

echo "=== 3. 清理影子 ES Index ==="
curl -X DELETE "http://es:9200/orders_pt"
curl -X DELETE "http://es:9200/products_pt"

echo "=== 4. 清理影子 MQ 消息（等消费完）==="
# 影子 topic 的消息消费完即清空，不需手动删

echo "=== 清理完成 ==="

# 验证：生产数据无污染
echo "=== 5. 对账验证 ==="
mysql -h production-db <<'EOF'
-- 生产订单数应与真实订单数一致（无压测订单混入）
SELECT COUNT(*) AS real_order_count FROM orders WHERE create_time >= '压测开始';
-- 影子表应为空
SELECT COUNT(*) AS shadow_remaining FROM orders_pt;
EOF
```

## 七、底层本质：为什么用影子资源而非独立环境

回到第一性：**全链路压测要在生产环境跑最真实，但不能污染生产数据，影子资源是物理隔离的工程解**。

**为什么不在测试环境压测**：测试环境的数据规模（几万条）、流量形态（手造流量）、依赖链（mock 的下游）都不真实，压出来的容量数据不可信。生产环境的真实数据规模（亿级订单）、真实流量形态（高峰长尾分布）、真实依赖链（几十个下游、真实网络延迟）才能压出真实瓶颈。所以全链路压测必须在生产环境跑，但必须隔离压测数据，影子资源是解法。

**为什么用影子资源而非独立环境**：独立压测环境要复制全套生产（DB、MQ、Redis、ES + 所有下游），成本极高且依赖链不真实（下游还是 mock）。影子资源是"逻辑隔离"——同一套物理资源，用压测标区分真/压测流量，路由到影子表/影子 topic/影子 key。真流量打真资源、压测流量打影子资源，物理隔离互不污染。代价是压测标要全链路透传（漏一跳就串台），但这比独立环境成本低得多。

**为什么 ThreadLocal 会丢**：Java 的 ThreadLocal 绑定线程，线程池复用线程（核心线程不销毁，任务排队执行）。任务 A 在线程 1 设了 ThreadLocal，任务 A 执行完线程 1 不销毁，下一个任务 B 也用线程 1——但 B 看到的是 A 残留的 ThreadLocal（脏数据），或者如果 B 不设则 B 拿到 null（丢失）。压测标透传时，压测任务和真任务可能复用同一线程，ThreadLocal 不可靠。TransmittableThreadLocal（阿里 TTL）在任务提交时快照当前 TTL 值，任务执行时恢复，任务完成后清理——正确解决线程池透传。

**为什么必须清理影子数据**：压测产生海量影子数据（亿级订单_pt），不清理会撑爆存储、影响性能、后续压测混入旧数据。清理要彻底——影子表 TRUNCATE、影子 Redis key DEL、影子 ES index DELETE。带 TTL（pt_ key 设过期时间）能自动过期，但表和 index 需手动清理。清理后要对账验证生产数据无污染（生产订单数 = 真实订单数，差异 = 0）。

## 八、AI 架构师加问：5 个 AI 相关问题

1. **AI 怎么生成更真实的压测流量？**
   传统压测脚本（Gatling/JMeter）的流量形态是手造的，不真实。AI 分析历史真实流量（订单高峰、长尾分布、用户行为路径），生成接近真实的压测流量。AI 还能生成"对抗性流量"（异常请求、边界 case），压测系统的异常处理能力。

2. **AI 怎么自动识别压测数据污染？**
   压测后 AI 对比生产数据特征——订单分布、用户行为模式、库存波动。如果生产数据出现异常（如凌晨突增大量小额订单），AI 标记为"疑似压测污染"，自动告警。比人工对账更快、覆盖更全。

3. **AI Agent 的压测标透传怎么做？**
   Agent 的多步骤任务可能跨多次调用（HTTP + MQ + 异步），压测标要全程透传。Agent 框架（LangGraph、Spring AI）要在每步调用的上下文（Context）里持久化压测标，调用下游时透传到 Header。Agent 的记忆（短期/长期）也要区分真/压测（压测记忆存影子记忆库）。

4. **AI 怎么优化压测资源配置？**
   压测要消耗大量资源（影子表、影子 topic）。AI 分析历史压测数据，预测本次压测需要的影子资源规模（表大小、topic 吞吐），自动扩容。压测后 AI 分析资源使用率，优化下次配置（避免过度分配）。

5. **AI 推理服务怎么压测？**
   AI 推理贵（GPU 资源），压测要算成本。影子 GPU（独立的推理实例）、影子模型（小模型 mock 大模型输出）。压测 prompt 流量打影子实例，不污染真模型的缓存（KV Cache）。AI 推理的压测标在 prompt 元数据里（system_prompt 注入 "PT" 标记），路由层识别后分发。

## 九、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"压测标透传、影子资源隔离、外部副作用 mock、压测后清理"**。

- **压测标**：X-Pressure-Test: true Header + TransmittableThreadLocal，全链路透传
- **影子资源**：orders_pt 表 / order_events_pt topic / pt_:key / orders_pt index
- **线程池透传**：用 TransmittableThreadLocal（阿里 TTL）+ TtlExecutors 包装
- **外部副作用**：短信/推送/支付 mock（压测标识别后不调真实网关）
- **清理**：压测结束 TRUNCATE 影子表 + DEL pt_*:key + DELETE 影子 index

### 拟人化理解

把全链路压测想成 **JD 双 11 演习**。真实订单在"真仓库"（生产库），压测订单在"模拟仓库"（影子库）。压测请求贴"压测标"标签（HTTP Header + ThreadLocal），全链路每个分拣员（应用、DB、MQ、Redis）识别标签后把货送到模拟仓库。真实用户和压测流量井水不犯河水。但有个陷阱——压测标是"胸牌"，员工换班（线程池复用）时胸牌可能摘错（ThreadLocal 丢失），要用"防丢胸牌"（TransmittableThreadLocal）保证换班不丢牌。压测结束一键清空模拟仓库（影子表 TRUNCATE），真仓库不受影响。

### 面试现场 60 秒回答

> 全链路压测要在生产跑最真实，但污染生产数据不可接受。核心方案是影子资源 + 压测标透传。压测请求带 X-Pressure-Test: true Header，网关注入后用 TransmittableThreadLocal 标记（不用 ThreadLocal，线程池会丢）。全链路每个环节识别压测标后路由到影子资源——MyBatis 拦截器改表名到 orders_pt、Redis 加 pt_ 前缀、MQ 发 order_events_pt topic、ES 写 orders_pt index。外部副作用（短信、支付）mock 返回。难点是压测标全链路透传——线程池用 TtlExecutors 包装、MQ 消息带 Header 消费端恢复、@Async 用 TtlRunnable 包装。压测结束 TRUNCATE 影子表 + DEL pt_ key + DELETE 影子 index 清理，对账验证生产数据差异 = 0。

### 反问面试官

> 贵司压测是生产环境全链路压测还是独立压测环境？影子资源怎么管理（手动建 vs 自动化）？压测标透传框架是自研还是用 TTL？压测后清理自动化程度？

## 十、苏格拉底式面试追问

每一问先回答"为什么"，再"怎么做"，最后"如何证明"。

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不在测试环境压测，非要生产环境？ | 测试环境数据规模、流量形态、依赖链都不真实，压出来的容量数据不可信。生产环境有真实亿级数据、真实流量分布、真实下游依赖，才能压出真实瓶颈。代价是必须隔离压测数据，影子资源是工程解 |
| 证据追问 | 怎么证明压测真没污染生产？ | 压测后对账——生产订单数 = 真实订单数（差异 = 0）、库存对账（真实库存无异常扣减）、用户审计（无真实用户收到压测短信）、支付对账（无真实支付被触发）。监控生产数据特征（订单分布），AI 异常检测 |
| 边界追问 | 压测标透传最易在哪一跳丢？ | 线程池——ThreadLocal 绑线程，线程池复用线程会丢或污染。用 TransmittableThreadLocal + TtlExecutors 解决。MQ 消费——消息属性带 Header，消费端恢复 ThreadLocal。异步任务——@Async 用 TtlRunnable 包装 |
| 反例追问 | 影子资源方案有什么缺点？ | ①影子表要建一套（DB、MQ、Redis、ES 都要影子），资源成本；②压测标透传复杂，漏一跳就串台；③影子资源规模要预估（太小压不准、太大浪费）；④清理要彻底，残留影响下次压测 |
| 风险追问 | 压测标串台（真流量被当成压测）会怎样？ | 灾难——真订单被写进影子表（生产丢数据）、真用户收到 mock 短信（用户投诉）。防御：压测标只在网关注入（业务代码不能设）、压测流量来源 IP 白名单、监控生产订单异常突降（被路由到影子表） |
| 验证追问 | 影子表路由怎么验证生效？ | 压测时监控——影子表 orders_pt 行数增长（应随压测流量增长）、生产表 orders 行数不增（无污染）、Redis pt_ key 数量增长、影子 topic 消息数增长。对账影子表数据 = 压测订单数 |
| 沉淀追问 | 团队压测规范沉淀什么？ | 压测标透传规范（TTL 框架使用）、影子资源建表 SOP、压测流量注入工具（GoReplay/Gatling + Header 注入）、清理脚本自动化、压测后对账报告模板、压测污染事故复盘案例 |

### 现场对话示例

**面试官**：全链路压测怎么避免污染生产数据？

**候选人**：核心是影子资源 + 压测标全链路透传。压测请求带 X-Pressure-Test: true Header，网关注入后用 TransmittableThreadLocal 标记到上下文。全链路每个环节识别压测标后路由到影子资源——MyBatis 拦截器把表名 orders 改成 orders_pt、Redis 加 pt_ 前缀、MQ 发 order_events_pt topic、ES 写 orders_pt index。真流量打真资源、压测流量打影子资源，物理隔离。外部副作用（短信、支付、推送）mock 返回，不调真实网关。压测结束 TRUNCATE 影子表 + DEL pt_ key + DELETE 影子 index 清理，对账验证生产数据差异 = 0。

**面试官**：压测标透传最易出问题的是哪？

**候选人**：线程池。ThreadLocal 绑定线程，线程池复用线程——任务 A（压测）设了 ThreadLocal，执行完线程不销毁，任务 B（真流量）复用同一线程，可能读到 A 残留的压测标（污染）或 null（丢失）。解法是 TransmittableThreadLocal（阿里 TTL 框架）——任务提交时快照当前 TTL，任务执行时恢复，完成后清理。线程池用 TtlExecutors.getTtlExecutorService 包装，@Async 用 TtlRunnable 包装。MQ 消费也要透传——生产端消息带 X-Pressure-Test Header，消费端 onMessage 时从 Header 恢复 ThreadLocal。漏一跳就串台，所以压测标透传是全链路压测最易出 bug 的地方。

**面试官**：怎么验证压测真没污染生产？

**候选人**：三层验证。第一层实时监控——压测时盯生产表 orders 的写入速率（应不随压测增长）、影子表 orders_pt 的行数（应随压测增长）、Redis 真 key vs pt_ key 的数量比、ES 真 index vs 影子 index 的文档数。如果生产表突增，立即停压测排查。第二层压测后对账——生产订单数 vs 真实业务订单数（差异 = 0）、库存对账（真实库存无异常扣减）、支付对账（无真实支付被触发）。第三层用户审计——抽查真实用户是否收到压测短信/push（应为 0）。任一层发现问题立即排查，严重的回滚（恢复生产数据快照）。

## 常见考点

1. **全链路压测为什么要在生产环境跑？**——测试环境的数据规模、流量形态、依赖链不真实，压出来的容量数据不可信。生产环境有真实亿级数据、真实流量分布、真实下游，才能压出真实瓶颈。
2. **压测标怎么全链路透传？**——HTTP Header + TransmittableThreadLocal（不用 ThreadLocal，线程池会丢）。线程池用 TtlExecutors 包装、MQ 消息带 Header 消费端恢复、@Async 用 TtlRunnable。
3. **影子资源有哪些？**——影子表（orders_pt）、影子 MQ topic（order_events_pt）、影子 Redis key（pt_:）、影子 ES index（orders_pt）。真流量打真资源、压测流量打影子资源。
4. **压测数据怎么清理？**——TRUNCATE 影子表、DEL pt_ 前缀的 Redis key、DELETE 影子 ES index。压测前记录影子资源清单，压测后按清单清理。对账验证生产数据差异 = 0。
5. **外部副作用（短信/支付）怎么处理？**——压测流量识别压测标后 mock 返回（不发真短信、不调真支付网关），只记日志。避免骚扰真实用户和产生真实资金风险。

## 结构化回答

**30 秒电梯演讲：** 全链路压测在生产环境跑，最大风险是污染生产数据（产生假订单、扣真实库存、发假短信）。核心解法是\压测流量打影子资源\——压测请求带压测标（HTTP Header / ThreadLocal），全链路识别压测标后路由到影子库（orders_pt）、影子 MQ topic（order_events_pt）、影子 Redis key（pt_:）、影子 ES 索引（orders_pt）。压测流量和真实流量物理隔离，互不污染

**展开框架：**
1. **压测标** — HTTP Header（X-Pressure-Test: true）或 ThreadLocal 标记，全链路透传"
2. **影子表** — DB 层 orders → orders_pt，压测流量写影子表
3. **影子 Topic** — MQ 层 order_events → order_events_pt

**收尾：** 以上是我的整体思路。您想继续深入聊——压测标怎么全链路透传？


## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：全链路压测如何避免污染生产数据 | "这题一句话：全链路压测在生产环境跑，最大风险是污染生产数据（产生假订单、扣真实库存、发假短信）。" | 开场钩子 |
| 0:15 | 压测标示意/对比图 | "HTTP Header（X-Pressure-Test: true）或 ThreadLocal 标记，全链路透传" | 压测标要点 |
| 0:40 | 影子表示意/对比图 | "DB 层 orders → orders_pt，压测流量写影子表" | 影子表要点 |
| 1:25 | 总结卡 | "记住：压测标。下期见。" | 收尾 |
