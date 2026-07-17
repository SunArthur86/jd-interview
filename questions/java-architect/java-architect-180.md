---
id: java-architect-180
difficulty: L4
category: java-architect
subcategory: 分布式调度
tags:
- Java 架构师
- 分布式调度
- 失效转移
- 幂等
- 故障恢复
feynman:
  essence: 分布式调度的失效转移核心是"心跳探活 + 任务重分配 + 幂等重试"。调度中心通过心跳检测执行器存活，超时标记失效，任务重新分配到健康节点。幂等保证重试不产生副作用（重复扣款/重复发货）。
  analogy: 像快递调度——调度中心每分钟问每个快递员"在吗"（心跳），没回应的（失效）把他负责的包裹重新分给别人（重分配）。重新投递时检查"这个包裹送过没"（幂等），避免重复投递。
  first_principle: 分布式系统中节点故障是常态（网络抖动/宕机/OOM）。调度系统必须能检测故障（心跳）+ 自动恢复（任务重分配）。但重分配可能导致任务重复执行（原节点没死只是慢），幂等是安全网。
  key_points:
  - 心跳探活：调度中心定期 ping 执行器，N 次超时标记失效
  - 任务重分配：失效节点的任务重新调度到健康节点（failover）
  - 幂等执行：业务幂等键（唯一约束/CAS），重试安全
  - 至少一次 vs 恰好一次：调度层至少一次（at-least-once），业务幂等实现恰好一次效果
  - 任务版本号：乐观锁防并发执行同一任务
first_principle:
  problem: 调度系统中执行器节点故障时，如何自动检测并重新分配任务，同时保证任务不重复执行不产生副作用？
  axioms:
  - 节点故障是常态（宕机/网络抖动/OOM/Full GC 假死）
  - 心跳可能误判（网络抖动导致超时，但节点其实活着）
  - 任务重分配可能导致重复执行（原节点没死只是慢）
  - 某些任务不能重复执行（如扣款/发货，重复有副作用）
  rebuild: 调度中心定期（30 秒）心跳探活执行器，连续 3 次超时（90 秒）标记失效。失效节点的正在执行任务重新入队，分配到健康节点（failover）。幂等保证重试安全——业务幂等键（唯一约束/状态机 CAS），相同请求只生效一次。调度层至少一次（at-least-once）+ 业务幂等 = 恰好一次效果。任务版本号（乐观锁）防多节点并发抢同一任务。
follow_up:
  - 怎么判断节点失效？——心跳。调度中心每 30 秒 ping 执行器，连续 3 次超时（90 秒无响应）标记失效。超时阈值要调（太短误判，太长恢复慢）。
  - 失效节点的任务怎么办？——重新入队。正在执行的任务标记为"待重试"，调度中心分配到其他健康节点。幂等保证重试安全。
  - 幂等怎么实现？——业务层。幂等键（唯一约束）：如订单退款用 refund_request_id 唯一索引。状态机 CAS：UPDATE WHERE status='PENDING'。分布式锁：SETNX lock:task:{taskId}。
  - 怎么避免任务重复执行？——任务版本号。UPDATE task SET version=version+1, executor=me WHERE id=? AND version=?. 只有一个节点能成功（CAS）。
  - 脑裂（split-brain）怎么办？——两个调度中心都以为自己是 leader。用 ZK/etcd 选主，只有 leader 能调度。或调度中心无状态 + 分布式锁。
memory_points:
  - 心跳探活：30 秒 ping，3 次超时（90 秒）标记失效
  - 任务重分配：失效节点的任务重新入队，分配到健康节点
  - 幂等：幂等键（唯一约束）+ 状态机 CAS + 分布式锁
  - 至少一次：调度层 at-least-once + 业务幂等 = 恰好一次
  - 任务版本号：乐观锁 CAS 防并发抢任务
---

# 【Java 后端架构师】分布式调度的失效转移与幂等执行

> 适用场景：JD 分布式任务调度（XXL-Job/Elastic-Job）。亿级订单的定时关闭、积分结算、库存对账。执行器节点故障时必须自动恢复，且重试不能产生副作用（重复扣款/重复发货）。架构师要设计的是"心跳探活 + 任务重分配 + 幂等执行"的高可用调度系统。

## 一、概念层：失效转移架构

```
调度中心（Leader，ZK 选主）
    ↓ 30 秒心跳探活
执行器集群（N 节点）
    ↓ 健康节点：正常执行任务
    ↓ 失效节点（3 次超时）：标记失效
    ↓ 失效节点的任务：重新入队 → 分配到健康节点（failover）

幂等保证：业务幂等键 + 状态机 CAS，重试安全
任务版本号：乐观锁防并发抢任务
```

## 二、机制层：心跳探活与失效检测

```java
/**
 * 调度中心：心跳探活执行器
 */
@Service
@Slf4j
public class HealthCheckService {

    private final Map<String, Long> lastHeartbeat = new ConcurrentHashMap<>();
    private static final long HEARTBEAT_INTERVAL = 30_000;     // 30 秒一次
    private static final int MAX_FAIL_COUNT = 3;               // 3 次失败
    private final Map<String, AtomicInteger> failCounter
        = new ConcurrentHashMap<>();

    @Scheduled(fixedRate = HEARTBEAT_INTERVAL)
    public void heartbeat() {
        for (String executor : executorRegistry.getAll()) {
            try {
                // ping 执行器
                boolean alive = pingExecutor(executor);
                if (alive) {
                    lastHeartbeat.put(executor, System.currentTimeMillis());
                    failCounter.get(executor).set(0);
                } else {
                    onFail(executor);
                }
            } catch (Exception e) {
                onFail(executor);
            }
        }
    }

    private void onFail(String executor) {
        int count = failCounter.computeIfAbsent(executor,
            k -> new AtomicInteger()).incrementAndGet();
        log.warn("执行器心跳失败: executor={} count={}", executor, count);

        if (count >= MAX_FAIL_COUNT) {
            // 连续 3 次失败（90 秒）：标记失效，触发 failover
            markExecutorDead(executor);
        }
    }

    private void markExecutorDead(String executor) {
        log.error("执行器失效，触发 failover: {}", executor);
        executorRegistry.markDead(executor);

        // 重新分配该执行器的任务
        List<Task> runningTasks = taskRepo.findByExecutorAndStatus(
            executor, TaskStatus.RUNNING);
        for (Task task : runningTasks) {
            reassignTask(task);
        }

        metrics.counter("schedule.failover").increment();
    }
}
```

## 三、机制层：任务重分配（Failover）

```java
/**
 * 任务重分配：失效节点的任务重新入队
 */
@Service
@Slf4j
public class TaskReassignService {

    /**
     * 重新分配任务到健康节点
     */
    public void reassignTask(Task task) {
        // 1. 任务标记为"待重试"（版本号 + 1，乐观锁）
        String lua = "UPDATE task SET status='PENDING', "
            + "retry_count=retry_count+1, version=version+1, "
            + "executor=NULL WHERE id=? AND version=?";
        int updated = taskRepo.updateWithVersion(task.getId(),
            task.getVersion());
        if (updated == 0) {
            // 版本号变了：任务已被其他线程处理，跳过
            log.info("任务已被处理，跳过 reassign: taskId={}", task.getId());
            return;
        }

        // 2. 分配到健康节点
        String healthyExecutor = selectHealthyExecutor();
        assignTask(task.getId(), healthyExecutor);

        log.info("任务重分配: taskId={} from={} to={}",
            task.getId(), task.getExecutor(), healthyExecutor);
        metrics.counter("task.reassign").increment();
    }

    /**
     * 选健康节点（负载最低的）
     */
    private String selectHealthyExecutor() {
        List<String> healthy = executorRegistry.getHealthy();
        // 选当前负载最低的
        return healthy.stream()
            .min(Comparator.comparingInt(this::getLoad))
            .orElseThrow(() -> new BizException("无可用执行器"));
    }
}
```

## 四、机制层：幂等执行

```java
/**
 * 幂等执行器：保证重试不产生副作用
 */
@Service
@Slf4j
public class IdempotentTaskExecutor {

    /**
     * 方案1：唯一约束（数据库唯一索引）
     * 适用于扣款/发货等有副作用且需强一致的任务
     */
    public void executeWithUniqueKey(Task task) {
        String idempotentKey = task.getJobId() + ":" + task.getId();
        try {
            // INSERT 唯一键约束：重复执行会抛 DuplicateKeyException
            taskLogRepo.insert(new TaskLog(idempotentKey,
                task.getId(), "EXECUTING"));
        } catch (DuplicateKeyException e) {
            log.info("任务已执行过，跳过: taskId={}", task.getId());
            return;
        }

        try {
            doBusiness(task);
            taskLogRepo.updateStatus(idempotentKey, "SUCCESS");
        } catch (Exception e) {
            taskLogRepo.updateStatus(idempotentKey, "FAILED");
            throw e;
        }
    }

    /**
     * 方案2：状态机 CAS（乐观锁）
     * 适用于订单/任务等有状态流转的业务
     */
    public void executeWithCAS(OrderTimeoutTask task) {
        // UPDATE WHERE status='PENDING'：只有 PENDING 状态能改成 CLOSED
        int updated = orderRepo.updateStatus(
            task.getOrderId(),
            OrderStatus.PENDING,       // 期望状态
            OrderStatus.CLOSED         // 目标状态
        );

        if (updated == 0) {
            // 已被处理（状态不再是 PENDING）
            log.info("订单已处理，跳过: orderId={}", task.getOrderId());
            return;
        }

        // 执行副作用（回滚库存、释放优惠券）
        inventoryService.rollback(task.getOrderId());
        couponService.release(task.getOrderId());
    }

    /**
     * 方案3：分布式锁
     * 适用于无状态的计算任务（聚合/统计）
     */
    public void executeWithLock(Task task) {
        String lockKey = "lock:task:" + task.getId();
        String requestId = UUID.randomUUID().toString();

        try {
            Boolean locked = redis.opsForValue().setIfAbsent(lockKey,
                requestId, Duration.ofMinutes(30));
            if (!Boolean.TRUE.equals(locked)) {
                log.info("任务被其他节点执行中，跳过: taskId={}",
                    task.getId());
                return;
            }
            doBusiness(task);
        } finally {
            releaseLock(lockKey, requestId);
        }
    }
}
```

## 五、机制层：任务版本号（防并发抢占）

```java
/**
 * 任务表：版本号字段防多节点并发抢同一任务
 */
// DDL:
// CREATE TABLE task (
//   id BIGINT PRIMARY KEY,
//   job_id VARCHAR(64),
//   status VARCHAR(20),      -- PENDING/RUNNING/SUCCESS/FAILED
//   executor VARCHAR(64),    -- 当前执行的节点
//   version INT DEFAULT 0,   -- 乐观锁版本号
//   retry_count INT DEFAULT 0,
//   INDEX idx_status_executor (status, executor)
// );

@Service
public class TaskClaimService {

    /**
     * 抢占任务（CAS：版本号 + 状态）
     * 多节点并发抢，只有一个成功
     */
    public boolean claimTask(Long taskId, String executor) {
        // 先查任务
        Task task = taskRepo.findById(taskId);
        if (task.getStatus() != TaskStatus.PENDING) return false;

        // CAS 抢占：UPDATE WHERE id=? AND version=? AND status='PENDING'
        int updated = taskRepo.claimWithCAS(taskId, task.getVersion(),
            executor);
        return updated > 0;
    }
}
```

```xml
<!-- MyBatis：CAS 抢占 -->
<update id="claimWithCAS">
    UPDATE task
    SET status = 'RUNNING',
        executor = #{executor},
        version = version + 1,
        start_time = NOW()
    WHERE id = #{taskId}
      AND version = #{version}
      AND status = 'PENDING'
</update>
```

## 六、机制层：选主与脑裂防护

```java
/**
 * 调度中心选主：ZK/etcd 保证只有一个 leader 调度
 * 防脑裂（两个调度中心都以为自己是 leader）
 */
@Component
public class LeaderElection {

    private final CuratorFramework zkClient;
    private LeaderSelectorListener listener;
    private volatile boolean isLeader = false;

    @PostConstruct
    public void init() {
        LeaderSelector selector = new LeaderSelector(zkClient,
            "/scheduler/leader", listener);
        selector.autoRequeue();
        selector.start();
    }

    /**
     * 只有 leader 能调度任务
     */
    public boolean canSchedule() {
        return isLeader;
    }
}
```

## 七、底层本质：CAP 与幂等的本质

**失效转移的本质**：分布式系统中节点故障是常态。调度系统要保证任务不丢——失效节点的任务被重新分配。关键是怎么检测失效——心跳（主动探活）。心跳间隔和失败阈值是 trade-off：太短误判（网络抖动误杀），太长恢复慢（任务延迟）。30 秒间隔 + 3 次失败（90 秒）是经验值。

**幂等的本质**：调度层只能保证 at-least-once（至少一次），因为网络不可靠——任务执行成功但响应丢了，调度中心以为失败重试。业务层幂等把 at-least-once 转成 exactly-once 效果。三种方案：
1. **唯一约束**：数据库唯一索引，重复 INSERT 抛异常。强一致，适合扣款/发货。
2. **状态机 CAS**：UPDATE WHERE status='PENDING'，状态流转天然幂等。适合订单/任务。
3. **分布式锁**：SETNX 锁，同一时间只一个执行。适合无状态计算任务。

**版本号的本质**：乐观锁。多节点并发抢同一任务时，CAS（UPDATE WHERE version=?）保证只有一个成功。比悲观锁（SELECT FOR UPDATE）性能好（无锁等待），但失败要重试。

**脑裂的本质**：分布式调度中心如果多副本，可能脑裂——两个都以为自己是 leader 同时调度。用 ZK/etcd 选主（Paxos/Raft 共识），保证唯一 leader。或调度中心无状态 + 分布式锁（同一时刻只有一个能调度）。

**at-least-once vs at-most-once vs exactly-once**：
- at-least-once：任务至少执行一次，可能重复。调度层默认。
- at-most-once：任务最多执行一次，可能丢。简单但不可靠。
- exactly-once：恰好一次。需要业务幂等 + 两阶段提交。成本高，通常用 at-least-once + 幂等近似。

## 八、AI 工程化深挖

1. **怎么用 AI 预测节点故障？** 分析节点历史指标（CPU/内存/GC/心跳抖动），LSTM 预测"该节点 1 小时内故障概率 > 80%"，提前把任务迁移走。主动 failover 比被动快。

2. **怎么用 AI 智能选执行器？** 传统选负载最低的。AI 综合考虑任务特性（CPU 密集/IO 密集）+ 节点能力（CPU/内存/网络），匹配最优执行器。降低任务执行时间 20%。

3. **怎么用 LLM 分析故障？** 任务失败时 LLM 分析日志/堆栈/上下文，给出"失败原因：DB 连接超时" + "建议：检查连接池配置"。运维提效。

4. **怎么用 AI 预测任务执行时间？** 历史数据训练模型，预测本次任务耗时。超阈值（如 > 1 小时）告警或拆分。避免长任务拖垮系统。

5. **怎么用 AI 智能重试策略？** 传统固定重试 3 次。AI 根据失败原因（网络抖动重试有用，业务异常重试无用）动态决定是否重试、重试间隔。降低无效重试。

## 九、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"心跳、重分配、幂等、版本号"** 四个词。

- **心跳**：30 秒 ping，3 次超时（90 秒）标记失效
- **重分配**：失效节点的任务重新入队，分配到健康节点（failover）
- **幂等**：唯一约束（扣款）+ 状态机 CAS（订单）+ 分布式锁（计算）
- **版本号**：乐观锁 CAS 防多节点并发抢任务

### 面试现场 60 秒回答

> 分布式调度的失效转移我用心跳探活 + 任务重分配 + 幂等执行。调度中心每 30 秒 ping 执行器，连续 3 次超时（90 秒）标记失效——这个阈值是 trade-off，太短误判（网络抖动），太长恢复慢。失效节点的正在执行任务重新入队（UPDATE status='PENDING' retry_count+1 version+1），分配到负载最低的健康节点（failover）。幂等保证重试安全——调度层只能保证 at-least-once（任务执行成功但响应丢了会重试），业务层幂等转成 exactly-once 效果。三种方案：唯一约束（INSERT 唯一键，重复抛 DuplicateKeyException，适合扣款/发货）+ 状态机 CAS（UPDATE WHERE status='PENDING'，适合订单流转）+ 分布式锁（SETNX，适合无状态计算）。任务版本号（乐观锁）防多节点并发抢同一任务——CAS UPDATE WHERE version=? 只有一个成功。脑裂防护用 ZK 选主（LeaderSelector），只有 leader 能调度。调度中心无状态 + ZK 共识保证唯一 leader。监控 failover_count、retry_success_rate、task_claim_conflict_rate。这是 at-least-once + 业务幂等近似 exactly-once，比真 exactly-once（两阶段提交）成本低。

## 十、常见考点

1. **怎么检测节点失效？**——心跳探活。30 秒 ping，3 次超时（90 秒）标记失效。阈值是 trade-off，太短误判太长恢复慢。
2. **失效节点的任务怎么办？**——重新入队。UPDATE status='PENDING' retry_count+1，分配到健康节点（failover）。幂等保证重试安全。
3. **幂等怎么实现？**——三种：唯一约束（扣款/发货）+ 状态机 CAS（订单流转）+ 分布式锁（无状态计算）。业务层幂等是 at-least-once 转 exactly-once 的关键。
4. **怎么避免任务重复执行？**——任务版本号（乐观锁 CAS）。UPDATE WHERE id=? AND version=? AND status='PENDING'，多节点并发抢只有一个成功。
5. **脑裂怎么防？**——ZK/etcd 选主，只有 leader 能调度。或调度中心无状态 + 分布式锁。Paxos/Raft 共识保证唯一 leader。

## 结构化回答

**30 秒电梯演讲：** 分布式调度的失效转移核心是心跳探活 + 任务重分配 + 幂等重试。调度中心通过心跳检测执行器存活，超时标记失效，任务重新分配到健康节点。幂等保证重试不产生副作用（重复扣款/重复发货）

**展开框架：**
1. **心跳探活** — 调度中心定期 ping 执行器，N 次超时标记失效
2. **任务重分配** — 失效节点的任务重新调度到健康节点（failover）
3. **幂等执行** — 业务幂等键（唯一约束/CAS），重试安全

**收尾：** 以上是我的整体思路。您想继续深入聊——怎么判断节点失效？


## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：分布式调度的失效转移与幂等执行 | "这题一句话：分布式调度的失效转移核心是心跳探活 + 任务重分配 + 幂等重试。" | 开场钩子 |
| 0:15 | 像快递调度——调度中心每分钟问每个快递员在吗类比图 | "打个比方：像快递调度——调度中心每分钟问每个快递员在吗。" | 核心类比 |
| 0:40 | 心跳探活示意/对比图 | "调度中心定期 ping 执行器，N 次超时标记失效" | 心跳探活要点 |
| 1:05 | 任务重分配示意/对比图 | "失效节点的任务重新调度到健康节点（failover）" | 任务重分配要点 |
| 1:30 | 幂等执行示意/对比图 | "业务幂等键（唯一约束/CAS），重试安全" | 幂等执行要点 |
| 1:55 | 总结卡 | "记住：心跳探活。下期见。" | 收尾 |
