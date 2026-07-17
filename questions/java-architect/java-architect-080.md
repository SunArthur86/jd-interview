---
id: java-architect-080
difficulty: L4
category: java-architect
subcategory: 高可用
tags:
- Java 架构师
- 任务调度
- 幂等
- 补偿
feynman:
  essence: 任务调度"不重不漏"的核心是"幂等执行 + 分片并行 + 失败补偿 + 死信兜底"。幂等保证重复执行无副作用（相同任务 ID 只执行一次），分片让多节点并行处理不同数据（水平扩展），失败补偿重试 + 死信兜底最终一致。XXL-JOB/Elastic-Job 提供分片调度框架，业务层保证幂等。
  analogy: 像快递分拣中心处理包裹。把包裹按邮编分到不同传送带（分片），每个传送带一个分拣员（节点）独立处理。包裹可能被重复扫描（重复触发），但系统只投递一次（幂等）。传送带卡住了重新启动（重试），修不好的人工处理（死信）。
  first_principle: 分布式调度的三大难题——"重复执行"（任务被多个节点抢到）、"遗漏执行"（节点崩溃任务丢失）、"顺序问题"（任务依赖前序完成）。解法：分布式锁/数据库唯一约束保证幂等（重复执行无副作用），任务持久化 + ACK 保证不丢（崩溃后重投），分片广播让多节点并行处理不同数据。
  key_points:
  - 不重：幂等键（业务唯一约束）保证重复执行无副作用
  - 不漏：任务持久化（DB/MQ）+ ACK 机制，崩溃后重投
  - 分片：XXL-JOB ShardingItem，按分片号处理不同数据（水平扩展）
  - 失败补偿：重试策略（固定/指数退避）+ 死信队列
  - 幂等实现：唯一索引、状态机、Token、版本号
first_principle:
  problem: 每天凌晨 2 点跑对账任务处理 1000 万订单，要求不重复处理（不重复扣款）、不遗漏处理（每单都处理），如何设计？
  axioms:
  - 分布式环境下任务可能被重复触发（调度器重试、网络重发）
  - 节点崩溃会导致正在处理的任务状态丢失
  - 1000 万数据单节点处理太慢，必须分片并行
  rebuild: 四层保障——第一层，分片——XXL-JOB 把任务分成 N 片（如 10 片），每个执行器节点处理不同分片（按 orderId % 10 路由），并行加速。第二层，幂等——每条记录有唯一键（orderId），处理前查状态（已处理则跳过）或用唯一索引（重复插入报错捕获）。第三层，不漏——任务状态持久化（pending→processing→done），节点崩溃后调度器发现超时，重投给其他节点。第四层，补偿——失败记录重试（指数退避），重试耗尽进死信表人工处理。定期对账（总数 vs 处理数）验证不重不漏。
follow_up:
  - XXL-JOB 和 Elastic-Job 怎么选？——XXL-JOB 中心化（调度中心 + 执行器），易用、Web 控制台、动态分片。Elastic-Job 去中心化（Zookeeper 协调），更稳定但配置复杂。JD 规模用 XXL-JOB 居多
  - 幂等怎么实现？——四种方式：唯一索引（DB 层保证）、状态机（只允许特定状态流转）、Token（一次性令牌）、版本号（乐观锁）。对账场景用唯一索引最简单
  - 分片怎么保证数据不重叠？——按业务键 hash 分片（orderId % shardTotal == shardIndex），每个分片号处理固定数据。分片总数要 >= 执行器数，分片号 = 执行器序号
  - 任务执行到一半节点挂了怎么办？——任务状态持久化（processing），调度器心跳检测节点失联，标记任务超时，重新调度给其他节点。幂等保证重复执行无副作用
  - 大任务怎么避免超时？——分片把大任务拆小（每片处理 1/10 数据），每片独立超时。或任务内部分批处理（每次处理 1000 条，更新进度），避免单次执行太久
memory_points:
  - 不重：幂等（唯一索引/状态机/Token/版本号）
  - 不漏：任务持久化 + ACK + 崩溃重投
  - 分片：XXL-JOB ShardingItem（hash 路由，并行加速）
  - 补偿：重试（指数退避）+ 死信队列
  - 对账：总数 vs 处理数，验证不重不漏
  - XXL-JOB：调度中心 + 执行器，动态分片
---

# 【Java 后端架构师】任务调度系统如何保证不重不漏

> 适用场景：JD 核心技术。每天凌晨跑对账任务处理 1000 万订单、定时清理过期数据、批量发券。架构师必须设计分片并行、幂等执行、失败补偿方案，保证任务不重复执行（不重复扣款）、不遗漏执行（每条数据都处理）。

## 一、概念层：不重不漏的核心机制

**不重不漏的四大保障**：

```
┌─────────────────────────────────────────────────────┐
│                 不重不漏四大保障                       │
├─────────────────────────────────────────────────────┤
│                                                     │
│  不重（幂等）          不漏（可靠）                    │
│  ├─ 唯一索引           ├─ 任务持久化                   │
│  ├─ 状态机             ├─ ACK 机制                    │
│  ├─ Token 令牌         ├─ 崩溃重投                    │
│  └─ 版本号/乐观锁      └─ 超时检测                     │
│                                                     │
│  并行（分片）          兜底（补偿）                    │
│  ├─ XXL-JOB 分片       ├─ 重试（指数退避）             │
│  ├─ hash 路由          ├─ 死信队列                     │
│  └─ 多执行器并行        └─ 定期对账                     │
│                                                     │
└─────────────────────────────────────────────────────┘
```

**幂等实现的四种方式**（面试必答，逐个能写代码）：

| 方式 | 原理 | 适用场景 | 代码核心 |
|------|------|---------|---------|
| **唯一索引** | DB 层保证重复插入报错 | 插入场景（创建订单、发券） | `UNIQUE KEY uk_order(order_id)` |
| **状态机** | 只允许特定状态流转 | 状态更新（支付、发货） | `UPDATE ... WHERE status='INIT'` |
| **Token 令牌** | 一次性令牌，用后失效 | 表单提交、前端防重复 | Redis `SET token NX EX 600` |
| **版本号** | 乐观锁，更新时校验版本 | 并发更新（库存扣减） | `UPDATE ... WHERE version=v+1` |

## 二、机制层：XXL-JOB 分片调度代码

**XXL-JOB 分片任务开发**（核心代码，面试必写）：

```java
@Component
public class ReconcileJob {

    @Autowired private OrderMapper orderMapper;
    @Autowired private ReconcileMapper reconcileMapper;

    /**
     * 对账任务 - 分片广播
     * XXL-JOB 把任务分成 N 片，每个执行器节点处理不同分片
     * shardIndex = 当前分片号（0, 1, 2...）
     * shardTotal = 总分片数（如 10）
     */
    @XxlJob("reconcileJobHandler")
    public void reconcileJob() {
        // 1. 获取当前分片信息
        int shardIndex = XxlJobHelper.getShardIndex();   // 当前节点负责的分片号
        int shardTotal = XxlJobHelper.getShardTotal();   // 总分片数

        XxlJobHelper.log("对账任务启动: 分片 {}/{}", shardIndex, shardTotal);

        // 2. 分片查询数据（按 orderId hash 路由，保证不重叠）
        //    分片 0 处理 orderId % 10 == 0 的订单
        //    分片 1 处理 orderId % 10 == 1 的订单
        int pageSize = 1000;
        int pageNum = 0;
        while (true) {
            // MyBatis 分页 + hash 过滤
            List<Order> orders = orderMapper.selectByShard(
                shardIndex, shardTotal, pageNum * pageSize, pageSize);
            if (orders.isEmpty()) break;

            for (Order order : orders) {
                processOrder(order);    // 幂等处理
            }
            pageNum++;

            // 分批处理，避免单次执行太久（心跳超时）
            XxlJobHelper.log("已处理 {} 批，共 {} 条", pageNum, pageNum * pageSize);
        }

        XxlJobHelper.log("对账任务完成: 分片 {}", shardIndex);
    }

    /**
     * 幂等处理单条订单对账
     * 不重：唯一索引保证重复插入报错，捕获后视为已处理
     * 不漏：状态机保证只处理未对账的订单
     */
    private void processOrder(Order order) {
        try {
            // 方式 1：唯一索引保证幂等
            // reconcile_record 表有 UNIQUE KEY uk_order(order_id)
            // 重复插入会抛 DuplicateKeyException，说明已处理，跳过
            ReconcileRecord record = ReconcileRecord.builder()
                .orderId(order.getOrderId())
                .amount(order.getAmount())
                .status("RECONCILED")
                .reconcileDate(LocalDate.now())
                .build();
            reconcileMapper.insert(record);  // 重复插入报错 → 幂等
            // 如果重复执行（orderId 已存在），插入失败，但业务无副作用

        } catch (DuplicateKeyException e) {
            // 唯一索引冲突 = 已处理过，幂等跳过
            XxlJobHelper.log("订单 {} 已对账，跳过", order.getOrderId());
            return;
        }

        // 方式 2：状态机保证幂等（可选）
        // UPDATE order SET status='RECONCILED' WHERE order_id=? AND status='PENDING'
        // 如果已是 RECONCILED 状态，UPDATE 影响 0 行，幂等
        int updated = orderMapper.updateStatusIfPending(order.getOrderId(), "RECONCILED");
        if (updated == 0) {
            // 状态不是 PENDING（可能已被其他节点处理），幂等跳过
            return;
        }
    }
}
```

**MyBatis 分片查询 SQL**：

```xml
<!-- 按 hash 分片查询，保证每个分片处理不同数据 -->
<select id="selectByShard" resultType="Order">
    SELECT * FROM orders
    WHERE status = 'COMPLETED'
      AND MOD(order_id, #{shardTotal}) = #{shardIndex}
    LIMIT #{offset}, #{pageSize}
</select>
<!-- 分片 0：MOD(order_id, 10) = 0 → orderId 尾号 0 -->
<!-- 分片 1：MOD(order_id, 10) = 1 → orderId 尾号 1 -->
<!-- 10 个分片不重叠，并行处理 -->
```

**XXL-JOB 执行器配置**：

```java
@Configuration
public class XxlJobConfig {

    @Bean
    public XxlJobSpringExecutor xxlJobExecutor() {
        XxlJobSpringExecutor executor = new XxlJobSpringExecutor();
        executor.setAdminAddresses("http://xxl-job-admin:8080/xxl-job-admin");
        executor.setAccessToken("xxl-job-token");
        executor.setAppname("reconcile-executor");
        executor.setPort(9999);          // 执行器端口
        executor.setLogPath("/data/xxl-job/logs");
        executor.setLogRetentionDays(30); // 日志保留 30 天
        return executor;
    }
}
```

## 三、机制层：幂等实现的代码细节

**唯一索引幂等**（最常用）：

```java
// 方案 A：唯一索引（推荐，DB 层保证）
// 建表：
// CREATE TABLE reconcile_record (
//   id BIGINT PRIMARY KEY,
//   order_id BIGINT,            -- 业务唯一键
//   amount DECIMAL(10,2),
//   status VARCHAR(20),
//   UNIQUE KEY uk_order(order_id)  -- 唯一索引保证幂等
// );

@Service
public class ReconcileService {

    @Autowired private ReconcileMapper mapper;

    public void reconcile(Order order) {
        try {
            mapper.insert(buildRecord(order));  // 正常插入
        } catch (DuplicateKeyException e) {
            // order_id 已存在 = 重复执行，幂等跳过
            log.debug("订单 {} 已对账", order.getOrderId());
        }
    }
}
```

**状态机幂等**（适合状态流转场景）：

```java
// 状态机：INIT → PAID → SHIPPED → DELIVERED
// 只允许正向流转，重复执行（相同状态）无副作用

public void payOrder(Long orderId) {
    // UPDATE 只在 status='INIT' 时生效
    // 如果已经是 PAID（重复执行），UPDATE 影响 0 行，幂等
    int updated = orderMapper.updateStatus(orderId, "PAID", "INIT");
    // SQL: UPDATE orders SET status='PAID' WHERE id=? AND status='INIT'

    if (updated == 0) {
        // 可能 1：订单已是 PAID（重复执行，幂等）
        // 可能 2：订单是 CANCELLED（非法状态）
        Order order = orderMapper.findById(orderId);
        if ("PAID".equals(order.getStatus())) {
            log.debug("订单 {} 已支付，幂等", orderId);
            return;   // 幂等
        }
        throw new IllegalStateException("非法状态: " + order.getStatus());
    }
}
```

**Token 令牌幂等**（适合前端防重复提交）：

```java
// 前端先获取 Token，提交时带上，服务端校验+删除
public class TokenIdempotentService {

    @Autowired private StringRedisTemplate redis;

    // 1. 前端获取 Token
    public String generateToken(String userId) {
        String token = UUID.randomUUID().toString();
        redis.opsForValue().set("idempotent:" + token, "1", 10, TimeUnit.MINUTES);
        return token;
    }

    // 2. 提交时校验 Token（原子删除，防并发）
    public boolean validateAndRemove(String token) {
        // Lua 脚本原子操作：存在则删除，不存在返回 0
        String lua = "if redis.call('get',KEYS[1]) then " +
                     "return redis.call('del',KEYS[1]) " +
                     "else return 0 end";
        Long result = redis.execute(
            (RedisCallback<Long>) conn -> conn.eval(lua.getBytes(),
            ReturnType.INTEGER, 1, ("idempotent:" + token).getBytes()));
        return result != null && result > 0;
    }
}
```

## 四、实战层：失败补偿与对账

**失败补偿机制**（指数退避重试 + 死信）：

```java
@Component
public class FailureCompensator {

    @Autowired private FailedTaskMapper failedTaskMapper;

    /**
     * 处理失败的任务
     * 指数退避：第 1 次重试等 1 分钟、第 2 次 5 分钟、第 3 次 30 分钟
     * 超过 3 次进死信表，人工处理
     */
    @Scheduled(fixedRate = 60000)    // 每分钟扫描失败任务
    @SchedulerLock(name = "compensate", lockAtMostFor = "5m")  // 分布式锁防多节点重复
    public void retryFailedTasks() {
        List<FailedTask> tasks = failedTaskMapper.selectRetryable();
        for (FailedTask task : tasks) {
            try {
                retryTask(task);
                task.setStatus("DONE");
            } catch (Exception e) {
                task.setRetryCount(task.getRetryCount() + 1);
                if (task.getRetryCount() >= 3) {
                    task.setStatus("DEAD_LETTER");   // 进死信
                    alertService.sendAlert("任务死信: " + task.getTaskId());
                } else {
                    // 指数退避：下次重试时间 = now + base * 2^retryCount
                    long delay = (long) (Math.pow(5, task.getRetryCount()) * 60000);
                    task.setNextRetryTime(new Date(System.currentTimeMillis() + delay));
                }
            }
            failedTaskMapper.update(task);
        }
    }
}
```

**定期对账验证不重不漏**：

```java
/**
 * 对账验证：总数 vs 处理数
 * 不重：处理记录数 <= 总订单数（不重复）
 * 不漏：已处理订单数 >= 总订单数（不遗漏）
 */
@XxlJob("reconcileCheckJob")
public void verifyReconcile() {
    // 总订单数（待对账的）
    int totalOrders = orderMapper.countByStatus("COMPLETED");

    // 已对账记录数（reconcile_record 表）
    int reconciled = reconcileMapper.countByDate(LocalDate.now());

    // 校验
    if (reconciled > totalOrders) {
        // 处理数 > 总数 → 有重复！（应该不会，唯一索引保证）
        alertService.sendCritical("对账重复! total=" + totalOrders + " reconciled=" + reconciled);
    }
    if (reconciled < totalOrders) {
        // 处理数 < 总数 → 有遗漏！
        int missing = totalOrders - reconciled;
        log.warn("对账遗漏 {} 条，触发补偿", missing);
        // 找出遗漏的订单，重新调度
        List<Long> missedOrderIds = reconcileMapper.findMissingOrders();
        for (Long orderId : missedOrderIds) {
            compensateTaskScheduler.schedule(orderId);
        }
    }
    if (reconciled == totalOrders) {
        log.info("对账完成，不重不漏: {} 条", totalOrders);
    }
}
```

## 五、底层本质：为什么分布式调度这么难

回到第一性：**分布式调度的难点是"网络不可靠 + 节点会崩溃 + 任务会重复"三重不确定性**。

- **重复执行的根源**：调度器发送任务后，执行器处理完成但 ACK 丢失（网络抖动），调度器以为没执行又重发。或调度器主备切换，主备都触发了一次。解法是幂等——无论执行多少次结果一致。幂等的核心是"用业务唯一键识别重复"，DB 唯一索引是最可靠的（数据库层保证，不依赖应用逻辑）。
- **遗漏执行的根源**：执行器收到任务但崩溃了（还没处理完），任务状态丢失。如果任务不持久化，这个任务就丢了。解法是任务状态持久化（DB 记录 pending→processing→done），调度器检测执行器超时（心跳失联），重新调度。幂等保证重新调度不会重复处理。
- **分片的本质**：1000 万数据单节点处理要几小时，不可接受。分片把数据按 hash 切成 N 份（orderId % N），N 个节点并行处理不同数据，总时间降到 1/N。关键是分片不重叠（hash 路由保证每条数据只属于一个分片）且分片数 >= 节点数（动态扩容时新节点接管多余分片）。XXL-JOB 的分片广播让所有执行器同时触发，各自用 shardIndex 处理自己的数据。
- **幂等的成本**：幂等不是免费的。唯一索引需要 DB 查询（判断是否已存在），状态机需要读取当前状态。高 QPS 场景幂等检查可能成为瓶颈。优化：用 Redis 缓存已处理标记（处理后在 Redis 标记，下次先查 Redis），减少 DB 压力。但 Redis 缓存不能完全替代 DB 唯一索引（Redis 可能丢），是性能优化层。

**对账是最终保障**：即使有幂等、分片、重试，仍可能有极端情况遗漏（如 DB 主从切换丢数据）。定期对账（总数 vs 处理数）是"事后验证"——发现遗漏触发补偿。这是最终一致性兜底。

## 六、AI 架构师加问：5 个

1. **AI 能预测任务执行时间，优化调度吗？**
   能。AI 分析历史任务执行时间、数据量、资源占用，预测下次任务耗时。调度器据此优化——大任务提前启动、避免高峰重叠。但调度执行（启动、分片）是确定性的，AI 只做"预测+建议"，不直接执行调度。

2. **AI 自动发现遗漏的任务并补偿？**
   能。AI 分析任务执行日志和对账数据，发现"哪些数据未被处理"（对账差异），自动生成补偿任务。比规则对账更智能——能发现规则没覆盖的遗漏模式（如某类特殊订单被过滤条件遗漏）。

3. **AI Agent 调度的任务怎么保证不重不漏？**
   AI Agent 发起的任务也要走幂等框架（唯一索引、状态机）。Agent 的工具调用要带唯一 request_id，服务端用 request_id 幂等。Agent 可能重复调用同一工具（幻觉），幂等保证重复调用无副作用。

4. **AI 推理任务（批量 embedding）怎么调度？**
   批量 embedding 是 GPU 密集任务，用分片调度——按数据量分片，多 GPU 节点并行。每个 batch 的 embedding 结果有唯一键（数据 ID），幂等写入向量库。失败重试（GPU OOM 是常见失败原因，重试时减小 batch size）。

5. **让 AI 决定任务优先级，风险在哪？**
   AI 能根据业务重要性动态调整优先级（VIP 任务插队、低优先级延后）。但优先级误判会让低优先级任务饿死（永远排队）。解法：AI 建议优先级，规则兜底（任务超时自动提升优先级）。监控 task_starvation_count（饿死任务数）。

## 七、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"幂等、分片、重试、对账"**。

- **幂等（不重）**：唯一索引、状态机、Token、版本号
- **分片（并行）**：XXL-JOB ShardingItem，hash 路由不重叠
- **重试（不漏）**：任务持久化 + ACK + 崩溃重投 + 指数退避
- **对账（兜底）**：总数 vs 处理数，发现遗漏触发补偿
- **死信**：重试耗尽进死信表，人工处理

### 拟人化理解

把任务调度想成**快递分拣中心**。包裹（任务）按邮编分到不同传送带（分片），每个传送带一个分拣员（节点）独立处理。包裹可能被重复扫描（重复触发），但系统只投递一次（幂等——查投递记录）。传送带卡住重新启动（重试），修不好的人工处理（死信）。每天晚上对账——包裹总数 vs 投递记录，发现漏投的补投（对账补偿）。

### 面试现场 60 秒回答

> 不重不漏靠四层保障。不重——幂等，用唯一索引（DB 层保证重复插入报错，捕获后跳过）或状态机（UPDATE WHERE status='INIT'，重复执行影响 0 行）。不漏——任务持久化到 DB（pending→processing→done），调度器检测执行器心跳超时后重投，崩溃不丢。并行——XXL-JOB 分片广播，按 orderId % shardTotal 路由，10 个节点各处理 1/10 数据，互不重叠。补偿——失败任务指数退避重试（1 分钟→5 分钟→30 分钟），3 次进死信表人工处理。最终兜底——定期对账，总订单数 vs 已处理数，发现遗漏触发补偿任务。1000 万订单 10 分片并行，每个节点处理 100 万，约 30 分钟完成。幂等成本：每条记录查一次状态，高 QPS 用 Redis 缓存已处理标记优化。

### 反问面试官

> 贵司任务调度用 XXL-JOB 还是 Elastic-Job？有没有遇到过任务重复执行或遗漏？对账是实时还是 T+1？这决定我聊分片调度还是幂等设计。

## 八、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不用 Java 的 @Scheduled + 分布式锁？ | @Scheduled 是单机的（每节点都触发），分布式锁只能保证单节点执行（无并行），1000 万数据单节点太慢。XXL-JOB 分片广播让多节点并行，hash 路由保证不重叠，吞吐高 N 倍 |
| 证据追问 | 怎么证明任务真的不重不漏？ | 对账：总数据数 vs 处理记录数，相等则不重不漏。监控 duplicate_execution_count（重复执行次数，幂等拦截的）、missing_record_count（遗漏数）。抽样验证：随机取 100 条数据，检查是否都处理且只处理一次 |
| 边界追问 | 幂等能保证 100% 不重复吗？ | DB 唯一索引能 100% 保证不重复插入。但"不重复执行副作用"取决于幂等设计是否完整——如果除了插记录还有其他副作用（如发 MQ、调下游），这些也要幂等。分布式事务场景（多步操作）要用 TCC/Saga 保证整体幂等 |
| 反例追问 | 什么场景不适合分片调度？ | 任务有严格顺序依赖（A 必须在 B 前）、数据量小（< 1 万条，分片开销 > 收益）、任务间有共享状态（分片后竞争）。这类用单节点顺序调度 |
| 风险追问 | 调度系统最大风险？ | ① 调度中心单点故障（XXL-JOB 高可用 + DB 持久化）；② 分片不均（数据 hash 倾斜，某分片数据多，用一致性 hash 或动态分片）；③ 任务积压（数据量突增，分片处理不过来，用动态扩分片）；④ 幂等设计不完整（DB 幂等了但下游调用没幂等） |
| 验证追问 | 怎么证明幂等设计正确？ | 单元测试：重复调用同一方法 N 次，验证结果一致。混沌测试：故意重复触发任务（手动调两次），验证无副作用。线上监控：duplicate_execution_count > 0 时检查是否正确跳过 |
| 沉淀追问 | 团队调度规范沉淀什么？ | XXL-JOB 任务开发模板（分片代码 + 幂等 + 重试）、幂等设计 checklist（唯一索引/状态机选择）、对账脚本模板、死信处理 SOP、任务监控大盘（执行时长/成功率/重复率/遗漏率） |

### 现场对话示例

**面试官**：XXL-JOB 分片任务，一个节点挂了，那一片数据没人处理怎么办？

**候选人**：XXL-JOB 的分片是动态的——调度中心感知执行器节点数变化后，重新分配分片。假设原来 10 个节点 10 个分片，节点 3 挂了，调度中心发现只剩 9 个节点，下次触发时分片重新分配——分片 3 可能被分配给节点 4（节点 4 处理分片 3 和 4）。但这个重新分配有个延迟（下次触发才生效），挂掉那一刻正在执行的那一轮分片 3 可能没处理完。解法：任务幂等 + 定期对账。对账发现分片 3 的数据遗漏，重新调度。或者用 Elastic-Job 的失效转移（failover）——节点挂了，它负责的分片立即转移给其他节点继续。XXL-JOB 也有失效转移机制，但默认需要手动开启。

**面试官**：幂等用唯一索引，但如果下游调用（如发券）也要幂等怎么办？

**候选人**：分布式场景下，幂等要贯穿整条链路。对账任务处理一条订单要：插对账记录（唯一索引幂等）+ 调券服务发券（券服务也要幂等）。券服务的幂等——发券记录表有 UNIQUE KEY uk(order_id, coupon_type)，重复发券报错跳过。如果对账记录插入成功但发券失败（网络问题），任务会重试——重试时对账记录已存在（幂等跳过），但发券要重试。关键：每一步独立幂等，重试时跳过已成功的步骤。更稳妥用本地消息表——对账记录和发券消息在同一事务，发券异步消费保证最终一致。幂等不是单一技术，是"唯一索引 + 状态机 + 本地消息表"的组合，覆盖全链路。

**面试官**：1000 万订单对账，怎么知道处理到哪了？

**候选人**：三个维度。第一，XXL-JOB 的执行日志——XxlJobHelper.log() 记录每批处理进度，Web 控制台能看。第二，任务进度表——处理过程中更新 progress（如已处理 500 万 / 总 1000 万 = 50%），客户端能查。第三，分片级监控——每个分片处理了多少条，Prometheus 指标 job_processed_records{shard="0"}。关键设计：任务分批处理（每批 1000 条），每批后更新进度和日志，避免单次执行太久被调度器判定超时。如果任务确实很长（几小时），用"子任务拆分"——主任务拆成 100 个子任务（每个 10 万数据），子任务独立调度独立超时，主任务汇总。这样单次执行不会太久。

## 常见考点

1. **XXL-JOB 分片怎么用？**——@XxlJob 注解 + XxlJobHelper.getShardIndex()/getShardTotal()。按 orderId % shardTotal == shardIndex 路由，每节点处理不同分片。分片不重叠（hash 保证），并行加速。
2. **幂等怎么实现？**——四种：唯一索引（DB 保证重复插入报错）、状态机（UPDATE WHERE status）、Token（Redis 一次性令牌）、版本号（乐观锁）。对账用唯一索引最简单。
3. **任务执行到一半节点挂了？**——任务状态持久化（processing），调度器检测心跳超时，重新调度。幂等保证重复执行无副作用。Elastic-Job 有失效转移，XXL-JOB 需配置开启。
4. **失败怎么重试？**——指数退避（1 分钟→5 分钟→30 分钟），3 次进死信表人工处理。重试时幂等跳过已成功的步骤。
5. **怎么验证不重不漏？**——对账：总数据数 vs 处理记录数相等。监控 duplicate_execution_count（重复执行被幂等拦截的）、missing_record_count（遗漏触发补偿的）。

## 结构化回答

**30 秒电梯演讲：** 任务调度不重不漏的核心是幂等执行 + 分片并行 + 失败补偿 + 死信兜底。幂等保证重复执行无副作用（相同任务 ID 只执行一次），分片让多节点并行处理不同数据（水平扩展），失败补偿重试 + 死信兜底最终一致。XXL-JOB/Elastic-Job 提供分片调度框架，业务层保证幂等

**展开框架：**
1. **不重** — 幂等键（业务唯一约束）保证重复执行无副作用
2. **不漏** — 任务持久化（DB/MQ）+ ACK 机制，崩溃后重投
3. **分片** — XXL-JOB ShardingItem，按分片号处理不同数据（水平扩展）

**收尾：** 以上是我的整体思路。您想继续深入聊——XXL-JOB 和 Elastic-Job 怎么选？


## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：任务调度系统如何保证不重不漏 | "这题一句话：任务调度不重不漏的核心是幂等执行 + 分片并行 + 失败补偿 + 死信兜底。" | 开场钩子 |
| 0:15 | 像快递分拣中心处理包裹类比图 | "打个比方：像快递分拣中心处理包裹。" | 核心类比 |
| 0:40 | 不重示意/对比图 | "幂等键（业务唯一约束）保证重复执行无副作用" | 不重要点 |
| 1:05 | 不漏示意/对比图 | "任务持久化（DB/MQ）+ ACK 机制，崩溃后重投" | 不漏要点 |
| 1:30 | 分片示意/对比图 | "XXL-JOB ShardingItem，按分片号处理不同数据（水平扩展）" | 分片要点 |
| 1:55 | 总结卡 | "记住：不重。下期见。" | 收尾 |
