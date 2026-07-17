---
id: java-architect-139
difficulty: L2
category: java-architect
subcategory: 队列
tags:
- Java 架构师
- 延迟队列
- 时间轮
- 任务
feynman:
  essence: 延迟队列的本质是"消息在指定时间后才被消费"——支付 30 分钟未支付自动取消、订单 7 天后自动确认收货、优惠券到期提醒。三种实现：(1) Redis ZSet（score=到期时间戳，定时扫过期）；(2) 时间轮（HashedWheelTimer，把任务挂在轮盘的 slot 上，指针扫到就触发）；(3) RocketMQ 延迟等级 / Kafka + Delay Topic（基于特定延迟等级或分区策略）。时间轮是最高效的——O(1) 插入和触发，适合海量短延迟任务。
  analogy: 像餐厅的"叫号系统"。Redis ZSet 是按"取餐时间"排序的列表，服务员定期扫"到时间的订单"叫号；时间轮是"传送带"——每个格子放一批订单，传送带每秒转一格，转到对应格子时叫那批订单；RocketMQ 延迟等级是"预设档位的传送带"（5s/10s/30s/1m...）。
  first_principle: 为什么不用 Thread.sleep？因为 sleep 占线程，1 万个延迟任务要 1 万个线程，资源不可承受。延迟队列的本质是"用 1 个调度线程管理 N 个延迟任务"，关键是数据结构——ZSet 用排序（O(logN) 查找），时间轮用 hash + 链表（O(1) 插入）。
  key_points:
  - Redis ZSet：score=到期时间戳，ZRANGEBYSCORE 扫描过期，简单通用
  - 时间轮（HashedWheelTimer）：O(1) 插入和触发，海量短延迟任务首选
  - RocketMQ 延迟等级：18 档（1s/5s/10s/30s/1m/2m/.../2h），开箱即用
  - 多层时间轮：秒轮 + 分轮 + 时轮，处理跨层级长延迟（如时钟机制）
  - 选型：短延迟 < 1h 用时间轮或 Redis ZSet；长延迟用 RocketMQ 或 DB 扫表
first_principle:
  problem: 海量延迟任务（千万级）如何高效调度，避免线程资源耗尽？
  axioms:
  - 每个任务一个 timer/sleep 是不可行的（线程资源限制）
  - 定时扫表（DB SELECT WHERE expire_at < NOW()）压力随数据量增长
  - 任务可能取消、修改、批量到期（同一时刻 100 万任务到期）
  rebuild: 用 Redis ZSet（轻量，score 排序）或时间轮（高效，O(1)）。时间轮把"到期时间"hash 到轮盘 slot，每个 slot 是任务链表；调度线程每 tick（如 100ms）推进一格，触发当前 slot 所有任务。多层时间轮处理长延迟（秒轮满进分轮）。海量任务用 Netty HashedWheelTimer 或自研分层时间轮。
follow_up:
  - Redis ZSet 怎么扫过期？——ZRANGEBYSCORE key 0 now LIMIT 0 100，循环拉取已到期任务。注意原子性（ZRANGEBYSCORE + ZREM 要 Lua）。
  - 时间轮怎么处理长延迟？——单层时间轮有限（如 3600 slot × 1s = 1 小时）。超过用多层（时钟机制）：秒轮满转一圈，任务降级到分轮对应 slot。
  - 时间轮任务取消怎么做？——任务对象持有 cancel 标志，调度线程触发时检查标志跳过；或维护任务到 slot 的反向索引，O(1) 移除。
  - 同一时刻大量任务到期（如秒杀）怎么处理？——批量触发，但执行要异步（丢线程池），避免调度线程阻塞导致后续 tick 延迟。
  - 延迟队列怎么持久化？——Redis ZSet 自带持久化（AOF）；时间轮是内存数据结构，重启丢任务，要配合 DB 持久化（任务表）。
memory_points:
  - Redis ZSet：score=时间戳，ZRANGEBYSCORE + ZREM（Lua 原子）
  - 时间轮：O(1) 插入触发，海量短延迟首选（Netty HashedWheelTimer）
  - 多层时间轮：秒轮+分轮+时轮，处理长延迟（时钟机制）
  - RocketMQ 延迟等级：18 档开箱即用，不适合任意延迟
  - 选型：短延迟用时间轮，长延迟用 RocketMQ/DB
---

# 【Java 后端架构师】延迟队列与时间轮任务的架构设计

> 适用场景：JD 核心技术。京东支付"30 分钟未支付自动取消订单"，每天 1000 万订单，每秒约 100 单到期取消。如果用 Thread.sleep 1 个任务 1 个线程要 100 线程；用 DB 扫表要扫 1000 万行；用 Redis ZSet 或时间轮能轻松处理。架构师必须能根据延迟时长、任务量、可靠性要求选型。

## 一、概念层

**三种实现对比**：

| 实现 | 优势 | 劣势 | 适用 |
|------|------|------|------|
| **Redis ZSet** | 简单、持久化、跨实例 | 扫描压力随任务量增长 | 中量任务（< 100 万） |
| **时间轮** | O(1) 高效、海量任务 | 内存数据结构、重启丢 | 海量短延迟（< 1 小时） |
| **RocketMQ 延迟等级** | 开箱即用、可靠 | 18 档固定、不能任意延迟 | 业务延迟消息 |
| **DB 扫表** | 强持久化、可审计 | 扫描慢、压力随数据增长 | 长延迟、低频任务 |
| **Kafka + Delay Topic** | 高吞吐 | 自研复杂 | 定制延迟场景 |

**业务场景延迟时长分类**：

| 场景 | 延迟 | 推荐 |
|------|------|------|
| 支付超时取消 | 30 分钟 | Redis ZSet / 时间轮 |
| 订单自动确认收货 | 7 天 | DB 扫表 / RocketMQ |
| 优惠券到期提醒 | 1 小时前 | Redis ZSet |
| 短信验证码失效 | 5 分钟 | Redis TTL |
| 秒杀订单延迟释放库存 | 5 秒 | 时间轮 |
| 定时任务调度 | cron | Quartz / XXL-Job |

## 二、机制层：Redis ZSet 延迟队列

**完整实现**：

```java
@Service
public class RedisZSetDelayQueue {

    @Autowired private StringRedisTemplate redis;
    @Autowired private TaskExecutor executor;

    private static final String QUEUE_KEY = "delay:queue:order_cancel";

    // 生产：添加延迟任务
    public void schedule(String taskId, Object payload, long delayMs) {
        long expireAt = System.currentTimeMillis() + delayMs;
        redis.opsForZSet().add(QUEUE_KEY,
            JSON.toJSONString(Map.of("id", taskId, "payload", payload)),
            expireAt);   // score = 到期时间戳
    }

    // 取消任务
    public void cancel(String taskId) {
        // 需要遍历找到对应 task（或维护额外索引）
        redis.opsForZSet().removeRangeByScore(QUEUE_KEY,
            0, Long.MAX_VALUE);  // 简化版，实际要按 taskId 精确删
    }

    // 消费：定时扫描到期任务
    @Scheduled(fixedDelay = 500)  // 每 500ms 扫一次
    public void consume() {
        long now = System.currentTimeMillis();

        // 原子操作：ZRANGEBYSCORE + ZREM（用 Lua 防并发重复消费）
        String lua = """
            local tasks = redis.call('ZRANGEBYSCORE', KEYS[1], 0, ARGV[1], 'LIMIT', 0, 100)
            if #tasks > 0 then
                redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, ARGV[1])
                return tasks
            end
            return {}
            """;

        List<String> tasks = redis.execute(
            new DefaultRedisScript<>(lua, List.class),
            List.of(QUEUE_KEY),
            String.valueOf(now)
        );

        if (tasks != null) {
            for (String taskJson : tasks) {
                // 异步执行（避免阻塞调度线程）
                executor.execute(() -> processTask(taskJson));
            }
        }
    }

    private void processTask(String taskJson) {
        try {
            Map<String, Object> task = JSON.parseObject(taskJson, Map.class);
            String taskId = (String) task.get("id");
            // 业务处理（幂等！）
            orderService.cancelIfUnpaid(taskId);
        } catch (Exception e) {
            log.error("Process delay task failed: " + taskJson, e);
            // 失败重试或落 DLQ
        }
    }
}
```

**关键点**：
- `ZRANGEBYSCORE` + `ZREM` 用 Lua 保证原子（防多消费者重复拉取）
- 扫描间隔 500ms（延迟精度 500ms）
- 异步执行任务（避免阻塞扫描线程）
- 任务幂等（取消订单前检查状态）

## 三、机制层：时间轮（HashedWheelTimer）

**时间轮原理**（必画）：

```
单层时间轮（8 slot，tickDuration=1s）：

       slot0  slot1  slot2  slot3
        │      │      │      │
        ▼      ▼      ▼      ▼
      [T1,T5] [T2]   [T3]   [T4]
        │      │      │      │
        ▼      ▼      ▼      ▼
       slot7  slot6  slot5  slot4
        │      │      │      │
        ▼      ▼      ▼      ▼
       [T8]   [T7]   [T6]   [T5']

指针每秒前进一格：slot0 → slot1 → slot2 → ...

任务 T1（延迟 0s）：挂 slot0
任务 T2（延迟 1s）：挂 slot1
任务 T3（延迟 2s）：挂 slot2
任务 T4（延迟 3s）：挂 slot3
任务 T5（延迟 8s）：挂 slot0（一圈后再触发）
任务 T8（延迟 7s）：挂 slot7

每 tick 指针走到某 slot，触发该 slot 所有任务。
插入：O(1)（hash(到期时间) % slot 数）
触发：O(1)（指针走到 slot）
```

**Netty HashedWheelTimer 使用**：

```java
// 创建时间轮
HashedWheelTimer wheelTimer = new HashedWheelTimer(
    Executors.defaultThreadFactory(),   // 线程工厂
    100,                                // tickDuration：100ms 一格
    TimeUnit.MILLISECONDS,
    512                                 // wheelSize：512 slot（512 × 100ms = 51.2s 单轮）
);

// 提交延迟任务（5 秒后执行）
Timeout timeout = wheelTimer.newTimeout(task -> {
    orderService.cancelIfUnpaid("JD001");
}, 5, TimeUnit.SECONDS);

// 取消任务
timeout.cancel();

// 应用关闭时停止
@PreDestroy
public void shutdown() {
    wheelTimer.stop();
}
```

**自研分层时间轮（处理长延迟）**：

```java
// 多层时间轮：秒轮（512 slot × 100ms）+ 分轮（60 slot × 51s）+ 时轮（24 slot × 51min）
public class HierarchicalWheelTimer {

    private final Wheel secondWheel = new Wheel(512, 100, TimeUnit.MILLISECONDS);
    private final Wheel minuteWheel = new Wheel(60, 51200, TimeUnit.MILLISECONDS);  // 51.2s
    private final Wheel hourWheel = new Wheel(24, 3072000, TimeUnit.MILLISECONDS);  // 51.2min

    public Timeout schedule(Runnable task, long delay, TimeUnit unit) {
        long delayMs = unit.toMillis(delay);

        if (delayMs < secondWheel.maxDelay()) {
            return secondWheel.schedule(task, delayMs);
        } else if (delayMs < minuteWheel.maxDelay()) {
            return minuteWheel.schedule(() -> {
                // 分轮到期后，重新计算塞入秒轮
                long remain = delayMs - minuteWheel.maxDelay();
                secondWheel.schedule(task, remain);
            }, delayMs);
        } else {
            return hourWheel.schedule(() -> {
                long remain = delayMs - hourWheel.maxDelay();
                minuteWheel.schedule(() -> {
                    secondWheel.schedule(task, remain % secondWheel.maxDelay());
                }, remain);
            }, delayMs);
        }
    }
}
```

**时间轮的优化点**：
- **取消任务**：任务对象持有 slot 引用，O(1) 移除
- **批量到期**：slot 是链表，遍历执行
- **任务执行异步**：调度线程只触发，执行丢线程池（避免阻塞 tick）

## 四、机制层：RocketMQ 延迟等级

**RocketMQ 延迟消息**（开箱即用）：

```java
// Producer
Message msg = new Message("order_topic",
    "JD001".getBytes(),
    "JD001");
msg.setDelayTimeLevel(3);  // 第 3 级 = 10s
// 18 档：1s 5s 10s 30s 1m 2m 3m 4m 5m 6m 7m 8m 9m 10m 20m 30m 1h 2h

producer.send(msg);
// 10s 后消费者才能收到
```

**RocketMQ 5.x 任意延迟**（新特性）：

```java
Message msg = new Message("order_topic", "JD001".getBytes());
msg.setDeliverTimeMs(System.currentTimeMillis() + 30000);  // 30s 后
producer.send(msg);
```

**Kafka + 自研延迟 topic**（用时间轮思想）：

```java
// 按 delay 分桶：delay_1s, delay_5s, delay_30s, delay_1m ...
// 每个桶一个 Kafka topic + 消费者
// 消费者按桶的固定延迟处理

public void sendDelay(String key, String value, long delayMs) {
    String topic = selectTopic(delayMs);   // delay_5s
    producer.send(new ProducerRecord<>(topic, key,
        JSON.toJSONString(Map.of("value", value, "expire_at",
            System.currentTimeMillis() + delayMs))
    ));
}

// 消费者（delay_5s topic）
@KafkaListener(topics = "delay_5s")
public void consume(ConsumerRecord<String, String> record) {
    DelayMessage msg = JSON.parseObject(record.value(), DelayMessage.class);
    long remain = msg.getExpireAt() - System.currentTimeMillis();
    if (remain > 100) {
        // 还没到时间，丢回时间轮等
        wheelTimer.newTimeout(() -> process(msg), remain, TimeUnit.MILLISECONDS);
    } else {
        process(msg);
    }
}
```

## 五、实战层/选型：可靠性保证

**延迟任务可靠性**（不能丢）：

```java
// 时间轮是内存数据结构，重启丢任务，必须配合持久化
@Service
public class ReliableDelayService {

    @Autowired private DelayTaskRepo repo;     // DB 持久化
    @Autowired private HashedWheelTimer wheel;

    // 提交任务：DB + 时间轮双写
    @Transactional
    public void schedule(String taskId, Runnable task, long delayMs) {
        // 1. DB 持久化（防重启丢）
        DelayTask entity = new DelayTask();
        entity.setTaskId(taskId);
        entity.setExpireAt(Instant.now().plusMillis(delayMs));
        entity.setStatus("PENDING");
        repo.save(entity);

        // 2. 时间轮触发
        wheel.newTimeout(() -> {
            execute(taskId, task);
        }, delayMs, TimeUnit.MILLISECONDS);
    }

    // 启动时恢复未完成任务
    @PostConstruct
    public void recover() {
        List<DelayTask> pending = repo.findPending();
        for (DelayTask t : pending) {
            long remain = Duration.between(Instant.now(), t.getExpireAt()).toMillis();
            if (remain <= 0) {
                // 已过期，立即执行
                execute(t.getTaskId(), loadTask(t.getTaskId()));
            } else {
                wheel.newTimeout(() -> execute(t.getTaskId(), loadTask(t.getTaskId())),
                    remain, TimeUnit.MILLISECONDS);
            }
        }
    }

    private void execute(String taskId, Runnable task) {
        try {
            task.run();
            repo.updateStatus(taskId, "DONE");
        } catch (Exception e) {
            log.error("Task failed: " + taskId, e);
            repo.updateStatus(taskId, "FAILED");
        }
    }
}
```

## 六、底层本质：时间轮为什么高效

回到第一性：**时间轮的核心是"用空间换时间 + hash 索引"**。

- **传统定时器**（堆、红黑树）：插入 O(logN)，触发 O(logN)，N 个任务扫一次 O(N)。海量任务下堆调整成本高。
- **时间轮**：插入 O(1)（hash 到 slot），触发 O(1)（指针走到 slot）。1 亿任务也只扫描当前 slot 的任务链表（通常 < 1000）。
- **多层时间轮**：解决"单层 slot 数有限"——长延迟任务先放高层轮，高层轮到期降级到低层轮（时钟机制，类似水表的多级齿轮）。

**为什么时间轮适合海量短延迟**：
- 短延迟（< 1 小时）任务量大（千万级），时间轮 O(1) 优势明显
- 长延迟任务量小（万级），用 DB 扫表 + Redis ZSet 够

**Redis ZSet vs 时间轮的本质区别**：
- ZSet 用"排序"找过期（O(logN) + 范围扫描）
- 时间轮用"hash"找过期（O(1) + slot 链表）
- 小数据量（< 10 万）ZSet 简单够用；大数据量（> 100 万）时间轮高效

**为什么不用 Java DelayQueue**：
- DelayQueue 是单 JVM 内存结构，重启丢
- 任务量大时堆调整开销
- 跨实例无法共享
- 适合进程内少量任务，不适合分布式海量任务

## 七、AI 架构师加问：5 个

1. **LLM 推理任务延迟调度用哪个？**
   推理请求延迟（如 5 秒后重试）用进程内时间轮（单实例）；推理结果延迟推送（如 10 分钟后通知）用 Redis ZSet（跨实例、持久化）。

2. **AI Agent 任务延迟编排怎么做？**
   Agent 工作流用 Temporal/Saga 内置的 timer（基于 DB 持久化 + 工作流引擎调度），不直接用时间轮或 Redis ZSet。Temporal 的 timer 支持任意延迟 + 工作流上下文。

3. **LLM 怎么辅助延迟任务调度优化？**
   LLM 读历史任务执行日志（任务量分布、执行时长、失败率），推荐调度参数（时间轮 slot 数、扫描间隔、超时阈值）。但参数调整要灰度。

4. **AI 推理服务的限流用延迟队列吗？**
   不直接。限流用令牌桶/漏桶（见 144 题），延迟队列是"定时触发"。但限流的"延迟拒绝"（429 + Retry-After）可以配合延迟队列（5 秒后允许重试）。

5. **用 LLM 自动检测延迟任务异常？**
   LLM 读任务执行日志识别异常（如某任务类型失败率突增、执行时长 P99 抖动、堆积数量异常），触发告警。但调度本身是确定性的，LLM 做异常归因不是决策。

## 八、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"Redis ZSet、时间轮 O(1)、多层时间轮、RocketMQ 18 档"**。

- **Redis ZSet**：score=时间戳，ZRANGEBYSCORE + ZREM Lua 原子
- **时间轮**：O(1) 插入触发，海量短延迟首选（Netty HashedWheelTimer）
- **多层时间轮**：秒轮+分轮+时轮，处理长延迟（时钟机制）
- **RocketMQ 延迟等级**：18 档（1s 到 2h），开箱即用
- **可靠性**：时间轮内存数据结构，重启丢，必须 DB 持久化 + 启动恢复

### 拟人化理解

把延迟队列想成**餐厅叫号系统**。Redis ZSet 是按"取餐时间"排序的列表，服务员每分钟扫"到时间的订单"叫号；时间轮是"传送带"——每个格子放一批订单，传送带每秒转一格，转到对应格子时叫那批订单；多层时间轮是"传送带 + 大时钟"——短时间订单放传送带，长时间订单（如 1 小时后取）先放大时钟，时针走到时降级到传送带；RocketMQ 延迟等级是"预设档位的传送带"（5s/10s/30s/1m...档位固定）。

### 面试现场 60 秒回答

> 延迟队列按延迟时长和任务量选型。短延迟 < 1 小时 + 海量任务用时间轮（Netty HashedWheelTimer），O(1) 插入和触发，512 slot × 100ms 单轮 51 秒，长延迟用多层时间轮（秒轮+分轮+时轮，时钟机制）。中量任务 < 100 万用 Redis ZSet，score=到期时间戳，ZRANGEBYSCORE + ZREM 用 Lua 原子防并发重复消费，500ms 扫一次精度 500ms。业务延迟消息用 RocketMQ 延迟等级（18 档开箱即用）或 5.x 任意延迟。时间轮是内存数据结构重启丢任务，必须 DB 持久化（任务表）+ 启动恢复未完成任务。任务执行要异步（丢线程池），避免阻塞调度线程导致后续 tick 延迟。任务幂等（如取消订单前检查状态），失败重试或落 DLQ。京东支付 30 分钟未付取消用 Redis ZSet（1000 万订单/日，每秒 100 单到期，500ms 扫描精度够）。

### 反问面试官

> 贵司延迟队列用什么实现？时间轮还是 RocketMQ？延迟精度要求多少？任务量多大？

## 九、苏格拉底式面试追问（7 层表格 + 现场对话）

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不用 DB 扫表实现延迟？ | 用压力说话：DB 扫表 SELECT WHERE expire_at < NOW() 数据量 1000 万时扫一次几百 ms，扫频繁 DB 压力大；时间轮 O(1) 不打 DB |
| 证据追问 | 怎么证明时间轮高效？ | 压测：1 亿任务插入 + 触发，时间轮内存 < 10GB、CPU < 50%；同等任务量 Redis ZSet 内存 50GB+、扫描延迟 P99 > 100ms |
| 边界追问 | 时间轮能做长延迟（7 天）吗？ | 不适合。多层时间轮理论可以但内存浪费。长延迟用 RocketMQ 延迟等级（7 天内）或 DB 扫表（cron 任务定期扫） |
| 反例追问 | 什么场景不用时间轮？ | 长延迟（> 1 天）、强持久化要求（重启不能丢）、跨实例共享任务——用 RocketMQ/DB/Redis ZSet |
| 风险追问 | 延迟队列最大风险？ | 主动点出：内存数据结构重启丢任务（必须持久化）、调度线程阻塞（任务执行要异步）、任务堆积（slot 链表过长要分批）、时区/时间同步（NTP 偏差） |
| 验证追问 | 怎么验证延迟精度？ | 压测：提交 1000 个延迟 5s 任务，统计触发时间分布，P99 应在 5s ± 100ms 内；故障演练：杀进程重启，未完成任务应被恢复 |
| 沉淀追问 | 团队延迟队列治理沉淀什么？ | 时间轮/Redis ZSet starter、延迟任务持久化 SOP、监控大盘（任务量/触发延迟/失败率）、延迟等级配置（RocketMQ） |

### 现场对话示例

**面试官**：时间轮任务执行阻塞怎么办？

**候选人**：调度线程只负责"触发"（取出 slot 任务），不负责"执行"。具体：调度线程遍历 slot 链表，对每个任务丢到线程池异步执行（executor.execute(task)）。这样调度线程立刻进入下一个 tick，不阻塞。如果任务执行慢（如调外部 API），不影响其他 slot 的触发。但要注意：(1) 线程池满了要拒绝策略（如 CallerRunsPolicy 让调度线程执行会阻塞，不推荐；用 DiscardPolicy 丢任务并告警）；(2) 任务执行失败要重试或落 DLQ；(3) 任务幂等避免重试重复执行。京东的实操：调度线程池 200 个线程，任务异步执行，失败的进 DLQ 由定时任务处理。

**面试官**：同一时刻 100 万任务到期（如秒杀），怎么处理？

**候选人**：批量触发是大挑战。100 万任务挂同一 slot，调度线程遍历慢。三种解法。第一，slot 内分桶——slot 维护多个 sub-bucket（按任务到期 ms 精度细分），调度线程按 ms 顺序触发 sub-bucket，平滑爆发。第二，多线程并行——调度线程发现 slot 任务数 > 阈值（如 1 万），起多个工作线程并行触发。第三，业务侧削峰——秒杀场景下单时不要每个订单都加延迟任务，而是用一个"批量释放"任务（5 秒后扫所有未支付订单批量释放）。京东秒杀用方案 3，避免 100 万任务同时到期。

**面试官**：Redis ZSet 扫描任务怎么避免多消费者重复消费？

**候选人**：ZRANGEBYSCORE + ZREM 必须原子。两个方案。第一，Lua 脚本——把 ZRANGEBYSCORE + ZREMRANGEBYSCORE 放一个 Lua 脚本，Redis 单线程执行保证原子。第二，ZPOPMIN——Redis 6.2+ 支持 ZPOPMIN（弹出最小 score 元素），原子弹出。生产推荐 Lua（兼容性好）。多消费者场景：每个消费者用 Lua 拉 + 删，拉到的任务不会被其他消费者重复拉。注意 LIMIT（如 100）防一次拉太多内存爆。

## 常见考点

1. **时间轮和 Kafka 分区有什么关系？**——没关系。时间轮是单实例内存调度，Kafka 分区是分布式消息存储。但可以结合——Kafka 按 delay 分桶，每个桶消费者用时间轮处理精确延迟。
2. **DelayQueue（JUC）和时间轮区别？**——DelayQueue 基于堆（PriorityQueue），插入 O(logN)；时间轮基于 hash，插入 O(1)。海量任务时间轮快，少量任务 DelayQueue 简单。
3. **多层时间轮怎么实现降级？**——高层轮 slot 到期时，遍历该 slot 任务，按剩余延迟重新计算塞入低层轮。类似时钟：分针走一圈，时针前进一格，分针归零重新计秒。
4. **延迟队列怎么做监控？**——任务总数（ZSet ZCARD / 时间轮任务计数）、到期未触发数（扫描延迟告警）、执行失败率、堆积量。阈值告警：未触发 > 1 万、扫描延迟 > 1s。
5. **Quartz 和延迟队列区别？**——Quartz 是 cron 调度（按时间规则触发，如每小时），延迟队列是相对延迟（5 秒后）。Quartz 适合定时任务，延迟队列适合业务延迟（如订单超时取消）。

## 结构化回答

**30 秒电梯演讲：** 延迟队列的本质是消息在指定时间后才被消费——支付 30 分钟未支付自动取消、订单 7 天后自动确认收货、优惠券到期提醒。三种实现：(1) Redis ZSet（score=到期时间戳，定时扫过期）；(2) 时间轮（HashedWheelTimer，把任务挂在轮盘的 slot 上，指针扫到就触发）；(3) RocketMQ 延迟等级 / Kafka + Delay Topic（基于特定延迟等级或分区策略）。时间轮是最高效的——O(1) 插入和触发，适合海量短延迟任务

**展开框架：**
1. **Redis ZSet** — score=到期时间戳，ZRANGEBYSCORE 扫描过期，简单通用
2. **时间轮（HashedWheelTimer）** — O(1) 插入和触发，海量短延迟任务首选
3. **RocketMQ 延迟等级** — 18 档（1s/5s/10s/30s/1m/2m/.../2h），开箱即用

**收尾：** 以上是我的整体思路。您想继续深入聊——Redis ZSet 怎么扫过期？


## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：延迟队列与时间轮任务的架构设计 | "这题核心是——延迟队列的本质是消息在指定时间后才被消费——支付 30 分钟未支付自动取消、订单 7 天后自动确……" | 开场钩子 |
| 0:15 | Redis ZSet示意/对比图 | "score=到期时间戳，ZRANGEBYSCORE 扫描过期，简单通用" | Redis ZSet要点 |
| 0:40 | 时间轮（HashedWheelT示意/对比图 | "O(1) 插入和触发，海量短延迟任务首选" | 时间轮（HashedWheelT要点 |
| 1:25 | 总结卡 | "记住：Redis ZSet。下期见。" | 收尾 |
