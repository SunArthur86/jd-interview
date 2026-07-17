---
id: java-architect-018
difficulty: L3
category: java-architect
subcategory: 分布式事务
tags:
- 分布式事务
- Saga
- TCC
feynman:
  essence: 分布式事务的本质是"跨多个独立资源管理器（DB/MQ）达成一致"——XA 用两阶段锁定资源（强一致但阻塞），TCC 用业务层 Try/Confirm/Cancel 模拟两阶段（强一致但侵入），Saga 用正向操作+补偿操作序列化执行（最终一致低侵入），可靠消息用本地消息表+幂等消费实现最终一致（最轻量）。选型本质是在"一致性强度"和"性能/侵入性"之间权衡。
  analogy: 像多方签字的合同流程。XA 是"所有人坐一桌，同时签字才生效"（强一致但等人到齐很慢）；TCC 是"每人先签字预留（Try），全部确认后才盖公章（Confirm），任一反悔就撕掉预留（Cancel）"；Saga 是"按顺序签字，谁反悔就倒着走补偿已签的"；可靠消息是"A 签完拍照发群（发消息），B 收到也签，最终大家都签完"（最终一致）。
  first_principle: 为什么分布式事务比单库事务难？因为单库事务靠 redo log + undo log 保证原子性（一个 DB 内），跨库/跨服务时没有统一的日志机制。XA 协议用协调者统一管理，但协调者宕机会阻塞（单点）；TCC/Saga 把两阶段搬到业务层，用业务操作的幂等性和可补偿性替代日志机制。
  key_points:
  - XA：两阶段提交（Prepare + Commit），强一致但阻塞、性能差，协调者宕机会悬挂
  - TCC：Try（资源预留）-Confirm（确认）-Cancel（回滚），业务侵入强，适合资金类强一致
  - Saga：长事务拆成 N 个子事务，每个配补偿操作，失败时倒序执行补偿，最终一致
  - 可靠消息：本地消息表保证"业务+消息"原子，MQ 投递+消费方幂等，最轻量
  - 选型：强一致资金用 TCC，长流程编排用 Saga，异步解耦用可靠消息
first_principle:
  problem: 跨多个独立 DB/服务的业务操作（下单+扣库存+扣款），如何保证要么全成功要么全回滚？
  axioms:
  - 跨库/跨服务没有统一的事务日志（不像单库有 redo/undo）
  - 强一致（XA）需要锁定资源，性能差且协调者单点
  - 业务最终一致（用户可接受几秒延迟）的代价远低于强一致
  rebuild: 按"一致性强度 vs 性能/侵入性"权衡选型。强一致需求（资金）用 TCC——业务层 Try 预留资源、Confirm 确认、Cancel 回滚，三阶段都幂等，协调者记录状态保证可恢复。长流程编排（订单履约链路）用 Saga——拆成 N 个子事务，每个配补偿，失败时倒序补偿，最终一致。异步解耦（积分、通知）用可靠消息——本地消息表保证业务和消息原子，MQ 保证投递，消费方幂等保证不重复处理。XA 几乎不用（性能差、协调者悬挂）。
follow_up:
  - TCC 的 Try 阶段冻结资金怎么实现？——在账户表加 frozen_amount 字段，Try 时 amount -= X, frozen_amount += X（总余额不变）；Confirm 时 frozen_amount -= X（真正扣款）；Cancel 时 frozen_amount -= X, amount += X（解冻）。三阶段都要幂等（带事务 ID 去重）
  - Saga 补偿操作能完全回滚吗？——不一定。如"发短信"这种副作用操作无法撤销（短信已发出）。补偿操作要做"语义撤销"而非"物理撤销"——发短信的补偿是"发一条道歉短信"或"记录异常待人工处理"。所以 Saga 适合"可补偿"的操作，不可补偿的操作放最后
  - 本地消息表怎么保证业务和消息原子？——业务操作和插入消息表记录在同一个数据库事务里（利用单库事务原子性）。事务提交后，异步任务扫描消息表投递到 MQ；投递成功后更新消息状态为"已发送"。消费方处理失败会重投（MQ 重试机制），消费方必须幂等
  - 可靠消息的 MQ 挂了怎么办？——消息表里有记录，MQ 恢复后异步任务继续投递。如果消息已投递但 MQ 还没持久化就宕机，消费方没收到——异步任务查消息状态（未确认）会重新投递（幂等兜底）。关键是消息表是持久化的，不会丢
  - Seata 的 AT 模式是什么？——Seata 自动生成反向 SQL 做补偿（分析 SQL 生成 undo log），业务无感知。但只支持关系型 DB，且全局锁可能影响性能。适合对侵入性敏感但一致性要求不极端的场景
memory_points:
  - XA = 两阶段（Prepare+Commit），强一致但阻塞，基本不用
  - TCC = Try/Confirm/Cancel，业务侵入强，资金类首选
  - Saga = 正向序列 + 倒序补偿，最终一致，长流程首选
  - 可靠消息 = 本地消息表 + MQ + 消费方幂等，最轻量
  - Seata AT = 自动生成 undo log，业务无感知
  - 选型：资金用 TCC，长链路用 Saga，异步用可靠消息
---

# 【Java 后端架构师】分布式事务 Saga、TCC 与可靠消息

> 适用场景：JD 核心技术。下单扣库存扣款是跨订单/库存/支付三个服务的链路，XA 性能扛不住大促，不做一致性就是超卖/错账。架构师必须能按业务场景选型 TCC/Saga/可靠消息，并说清每个方案的流程图、补偿代码、失败兜底——这是资金类业务的命门。

## 一、概念层：四种方案对比

**分布式事务方案全景**（面试必考选型）：

| 方案 | 一致性 | 性能 | 侵入性 | 适用场景 | 代表实现 |
|------|--------|------|--------|---------|---------|
| **XA（2PC）** | 强一致 | 差（阻塞） | 低（DB 层） | 传统金融、同构 DB | MySQL XA、Atomikos |
| **TCC** | 强一致 | 中 | 高（业务层） | 资金、库存扣减 | Seata TCC、Hmily |
| **Saga** | 最终一致 | 好 | 中（写补偿） | 长流程编排、订单履约 | Seata Saga、Camunda |
| **可靠消息** | 最终一致 | 极好 | 低（消息表） | 异步解耦、积分/通知 | RocketMQ 事务消息、本地消息表 |
| **Seata AT** | 弱强一致 | 中 | 极低（自动） | 单体演进、简单 CRUD | Seata AT |

**核心权衡**：一致性强度 ↑ → 性能 ↓ + 侵入性 ↑。没有银弹，按业务选。

**一致性强度排序**：XA（强） > TCC（强） > Saga（最终） ≈ 可靠消息（最终） > 最大努力通知（弱）。

## 二、机制层：XA 两阶段提交（理解即可，少用）

**XA 2PC 流程**（画图理解）：

```
                    协调者（TM）
                        │
    阶段1：Prepare ─────┼─────────┐
                        │         │
                        ▼         ▼
                    ┌──────┐  ┌──────┐
                    │ DB A │  │ DB B │   各自执行 SQL，锁定资源，写 redo log，不提交
                    └──┬───┘  └──┬───┘
                       │ Yes/No  │ Yes/No
                       ▼         ▼
    阶段2：Commit/Abort
       所有 Yes ──► 协调者发 Commit ──► 两库提交
       任一 No  ──► 协调者发 Abort  ──► 两库回滚
```

**XA 的致命缺陷**（面试必答为什么不用）：

1. **同步阻塞**：Prepare 阶段锁定资源，直到 Commit/Abort 释放。期间整个事务涉及的行/表被锁，并发度极低。
2. **协调者单点**：协调者宕机，参与者收不到 Commit/Abort，资源一直锁定（悬挂）。
3. **数据不一致**：Commit 阶段部分参与者收到 Commit 部分没收到（网络分区），数据不一致。
4. **性能差**：两阶段往返 + 锁定，TPS 通常是单库的 1/10。

**结论**：XA 在互联网高并发场景几乎不用，仅传统金融（低并发强一致）偶用。

## 三、机制层：TCC 业务层两阶段（资金类首选）

**TCC 三阶段流程**（画图必考）：

```
全局事务开始（协调者分配 XID）
    │
    ▼
┌──────── Try 阶段（资源预留）────────┐
│  账户服务：amount -= 100, frozen += 100   （冻结资金）  │
│  库存服务：available -= 1, frozen += 1     （冻结库存）  │
│  订单服务：创建订单（DRAFT 状态）                       │
└─────────────────────────────────────┘
    │
    │ 所有 Try 成功？
    ├── 是 ──► Confirm 阶段
    │           ├─ 账户：frozen -= 100（确认扣款）
    │           ├─ 库存：frozen -= 1（确认扣减）
    │           └─ 订单：状态 DRAFT → CONFIRMED
    │
    └── 否 ──► Cancel 阶段（倒序）
                ├─ 订单：删除/标记取消
                ├─ 库存：frozen -= 1, available += 1（解冻）
                └─ 账户：frozen -= 100, amount += 100（解冻）
```

**TCC 代码示例（扣款场景）**：

```java
// 账户表：amount（可用余额）, frozen_amount（冻结金额）
// 不变量：amount + frozen_amount = 总余额

@LocalTCC     // Seata TCC 注解
public interface AccountTccAction {

    @TwoPhaseBusinessAction(name = "deductAccount",
        commitMethod = "confirm", rollbackMethod = "cancel")
    boolean tryDeduct(BusinessActionContext ctx,
                      @BusinessActionContextParameter(paramName = "userId") Long userId,
                      @BusinessActionContextParameter(paramName = "amount") BigDecimal amount);

    boolean confirm(BusinessActionContext ctx);   // Confirm
    boolean cancel(BusinessActionContext ctx);     // Cancel
}

public class AccountTccActionImpl implements AccountTccAction {

    @Override
    public boolean tryDeduct(BusinessActionContext ctx, Long userId, BigDecimal amount) {
        // 幂等检查：xid 是否已处理
        if (isProcessed(ctx.getXid(), "try")) return true;
        // 业务检查：余额是否足够
        Account account = accountRepo.findById(userId);
        if (account.getAmount().compareTo(amount) < 0) {
            throw new InsufficientBalanceException();
        }
        // 资源预留：冻结资金（不真正扣款）
        account.setAmount(account.getAmount().subtract(amount));
        account.setFrozenAmount(account.getFrozenAmount().add(amount));
        accountRepo.save(account);
        // 记录事务日志（幂等用）
        recordTxLog(ctx.getXid(), "try", userId, amount);
        return true;
    }

    @Override
    public boolean confirm(BusinessActionContext ctx) {
        if (isProcessed(ctx.getXid(), "confirm")) return true;   // 幂等
        Long userId = ctx.getActionContext("userId");
        BigDecimal amount = ctx.getActionContext("amount");
        // 真正扣款：从冻结金额扣
        Account account = accountRepo.findById(userId);
        account.setFrozenAmount(account.getFrozenAmount().subtract(amount));
        accountRepo.save(account);
        recordTxLog(ctx.getXid(), "confirm", userId, amount);
        return true;
    }

    @Override
    public boolean cancel(BusinessActionContext ctx) {
        if (isProcessed(ctx.getXid(), "cancel")) return true;   // 幂等
        // 空回滚处理：Try 没执行就收到 Cancel（Try 超时）
        if (!isProcessed(ctx.getXid(), "try")) {
            recordTxLog(ctx.getXid(), "cancel", null, null);   // 记录空回滚标记
            return true;
        }
        Long userId = ctx.getActionContext("userId");
        BigDecimal amount = ctx.getActionContext("amount");
        // 解冻：资金退回可用余额
        Account account = accountRepo.findById(userId);
        account.setAmount(account.getAmount().add(amount));
        account.setFrozenAmount(account.getFrozenAmount().subtract(amount));
        accountRepo.save(account);
        recordTxLog(ctx.getXid(), "cancel", userId, amount);
        return true;
    }
}
```

**TCC 三大坑（面试必答）**：

1. **幂等**：Confirm/Cancel 可能被重试（协调者重发），必须去重（事务日志表记录 XID）。
2. **空回滚**：Try 没执行（如超时）就收到 Cancel，Cancel 要能处理（检查 Try 是否执行，没执行就记录空回滚标记直接返回）。
3. **悬挂**：Cancel 先于 Try 到达（网络乱序），Try 后到会预留资源但永远等不到 Confirm/Cancel。解法：Try 前检查是否已 Cancel，是则跳过。

## 四、机制层：Saga 长流程编排

**Saga 流程（编排式 vs 协同式）**：

```
编排式（Orchestration，有中心协调器，推荐）：
    Saga 协调器
        │
        ├─1. 调 创建订单 ──► 成功
        ├─2. 调 扣库存   ──► 成功
        ├─3. 调 扣款     ──► 失败 ✗
        │
        └─补偿（倒序）：
              ├─ 补偿 扣库存（释放库存）
              └─ 补偿 创建订单（取消订单）

协同式（Choreography，事件驱动，无中心）：
    订单服务 ──OrderCreated──► 库存服务
                              │
                              ──InventoryLocked──► 支付服务
                                                   │
                                                   ──PaymentFailed──► 库存服务（补偿）
                                                                     │
                                                                     ──InventoryReleased──► 订单服务（补偿）
```

**Saga 补偿代码示例**：

```java
// Saga 定义（编排式，用 Seata Saga）
@SagaOrchStateful(name = "createOrderSaga")
public class CreateOrderSaga {

    @SagaStep(compensate = "cancelOrder")
    public Order createOrder(CreateOrderCmd cmd) {
        return orderService.create(cmd);
    }

    @SagaStep(compensate = "releaseInventory")
    public void deductInventory(Long orderId, List<OrderItem> items) {
        inventoryService.deduct(items);   // 正向操作
    }

    @SagaStep(compensate = "refundPayment")
    public void deductPayment(Long orderId, BigDecimal amount) {
        paymentService.deduct(orderId, amount);
    }

    // 补偿操作
    public void cancelOrder(Long orderId) { orderService.cancel(orderId); }
    public void releaseInventory(Long orderId, List<OrderItem> items) {
        inventoryService.release(items);   // 释放库存
    }
    public void refundPayment(Long orderId, BigDecimal amount) {
        paymentService.refund(orderId, amount);
    }
}
```

**Saga 补偿的语义撤销**（关键认知）：

```java
// 不可物理撤销的操作要做语义补偿
public class ShipmentService {
    // 正向：发货（已发出快递，物理不可撤销）
    public void ship(Long orderId) {
        // 调用物流接口发出快递
        logisticsApi.createShipment(orderId);
    }

    // 补偿：不能"召回快递"，只能拦截+记录
    public void compensateShip(Long orderId) {
        // 1. 尝试拦截（如果还在仓库）
        logisticsApi.tryIntercept(orderId);
        // 2. 拦截失败则记录待人工处理
        manualTaskRepo.save(new ManualTask(orderId, "SHIPPED_BUT_CANCELLED"));
        // 3. 通知用户
        notifyService.notifyUser(orderId, "订单已取消，已发货商品请拒收");
    }
}
```

**Saga 设计原则**：
- 不可补偿的操作（如发货、发短信）放最后，前面失败不触发它们。
- 每个补偿操作必须幂等（协调器可能重试补偿）。
- 补偿操作要快速（不要做长耗时操作，避免补偿链路超时）。

## 五、机制层：可靠消息最终一致（最轻量）

**本地消息表模式**（画图必考）：

```
订单服务（业务库）                         MQ                       积分服务
┌─────────────────────────┐          ┌──────────┐          ┌──────────────────┐
│ 事务 T1:                │          │          │          │                  │
│   1. INSERT orders      │          │          │          │                  │
│   2. INSERT msg_table   │ 同一事务 │          │          │                  │
│      (status=PENDING)   ├──────────┤          │          │                  │
│                          │          │          │          │                  │
│ 异步任务（定时扫描）：    │          │          │          │                  │
│   扫描 PENDING 消息      │          │          │          │                  │
│       │                  │          │          │          │                  │
│       ▼ 投递             │          │          │          │                  │
│   send to MQ ──────────────► topic ◄───────────── consume │                  │
│       │                  │          │          │   │幂等检查│                 │
│   投递成功                │          │          │   ▼     │                  │
│   UPDATE msg_table       │          │          │ 加积分   │                  │
│      status=SENT         │          │          │   │     │                  │
│                          │          │          │   ACK──┤                  │
└─────────────────────────┘          └──────────┘          └──────────────────┘
```

**本地消息表代码**：

```java
@Service
public class OrderService {

    @Transactional   // 业务 + 消息表在同一事务
    public void createOrder(CreateOrderCmd cmd) {
        // 1. 业务操作
        Order order = orderFactory.create(cmd);
        orderRepo.save(order);

        // 2. 插入消息表（同一事务，原子性保证）
        LocalMessage msg = new LocalMessage();
        msg.setBizId(order.getId());
        msg.setTopic("order-created");
        msg.setPayload(JSON.toJSONString(new OrderCreatedEvent(order)));
        msg.setStatus("PENDING");
        msg.setRetryCount(0);
        messageRepo.save(msg);
        // 事务提交后，业务和消息都持久化
    }
}

// 定时任务扫描投递
@Component
public class MessageDispatcher {

    @Scheduled(fixedDelay = 1000)   // 每秒扫描
    public void dispatch() {
        List<LocalMessage> pending = messageRepo.findPending(100);
        for (LocalMessage msg : pending) {
            try {
                rocketMQTemplate.asyncSend(msg.getTopic(), msg.getPayload(), callback);
                msg.setStatus("SENT");
                messageRepo.save(msg);
            } catch (Exception e) {
                msg.incrRetry();
                if (msg.getRetryCount() > MAX_RETRY) {
                    msg.setStatus("FAILED");   // 告警人工处理
                }
                messageRepo.save(msg);
            }
        }
    }
}

// 消费方幂等处理
@Component
@RocketMQMessageListener(topic = "order-created")
public class PointsListener implements RocketMQListener<OrderCreatedEvent> {

    @Override
    @Transactional
    public void onMessage(OrderCreatedEvent event) {
        // 1. 幂等检查（bizId 去重）
        if (pointsRepo.existsByBizId(event.getOrderId())) {
            return;   // 已处理，幂等返回
        }
        // 2. 加积分
        pointsService.add(event.getUserId(), event.getPoints());
        // 3. 记录 bizId（幂等用）
        pointsRepo.saveBizId(event.getOrderId());
    }
}
```

**RocketMQ 事务消息**（替代本地消息表）：

```java
// RocketMQ 原生支持事务消息，省去自己维护消息表
@Transactional
public void createOrder(CreateOrderCmd cmd) {
    Order order = orderRepo.save(orderFactory.create(cmd));
    // 发送半消息（对消费者不可见）
    rocketMQTemplate.sendMessageInTransaction(
        "order-created", new OrderCreatedEvent(order), order.getId());
}

// 事务回查接口（Broker 来问"业务到底成没成"）
@Override
public void checkLocalTransaction(MessageExt msg) {
    Long orderId = parseOrderId(msg);
    // 查订单是否创建成功
    if (orderRepo.existsById(orderId)) {
        return LocalTransactionState.COMMIT_MESSAGE;   // 提交消息（消费者可见）
    }
    return LocalTransactionState.ROLLBACK_MESSAGE;     // 回滚消息（丢弃）
}
```

## 六、底层本质：一致性光谱与工程取舍

回到第一性：**分布式事务的本质是"在多个独立资源管理器之间达成一致"，一致性强度和性能/可用性是根本矛盾**。

- **强一致（XA/TCC）**：所有参与者在同一时刻看到同样的状态。代价是锁定资源（XA）或业务侵入（TCC），并发度低。适合资金类业务（错账不可接受）。
- **最终一致（Saga/可靠消息）**：系统在一段时间后收敛到一致状态，期间可能有短暂不一致。代价是用户要容忍延迟（几秒到几分钟），补偿逻辑复杂。适合大部分互联网业务（订单/库存/积分）。
- **为什么 XA 在互联网不用**：互联网高并发（万级 TPS）下，XA 的锁定会让 TPS 降到几百，且协调者单点风险大。BASE 理论（基本可用、软状态、最终一致）就是为了绕开 XA 的强一致约束，用业务层补偿换性能。
- **TCC 的本质**：把 XA 的"DB 资源锁定"换成"业务资源预留"（冻结金额/库存）。锁定由 DB 层（悲观锁）上移到业务层（字段标记），减少了锁竞争时间（只在 Try 短暂锁定），但要求业务实现三个方法且保证幂等。
- **可靠消息的本质**：用"本地事务 + 异步投递 + 幂等消费"模拟跨服务事务。本地事务保证业务和消息原子，异步投递保证最终送达，幂等消费保证重复不副作用。这是 CAP 中选择 AP（可用+分区容忍）后用最终一致补强的典型实践。

## 七、AI 架构师加问：5 个 AI 相关问题

1. **AI 推理结果落库 + 触发下游，怎么保证一致？**
   推理服务把结果写入业务库（本地事务）+ 写本地消息表（同事务）→ 异步发消息触发下游（计费、通知）。推理本身耗时（秒级），不能放事务内——先推理得到结果，再开短事务落库 + 发消息。下游消费幂等保证不重复处理。

2. **AI Agent 多步骤工具调用怎么保证事务性？**
   Agent 编排本质是 Saga——每个工具调用是一个子事务，失败时倒序补偿。Agent 记录每步的 checkpoint（已调用工具及结果），重启可恢复。不可补偿的工具（如已发送邮件）放最后，或用"待发送队列"延迟执行（Agent 成功后才真正发送）。

3. **怎么用 AI 辅助选型分布式事务方案？**
   AI 分析业务特征：强一致需求（资金→TCC）、长流程（订单履约→Saga）、异步解耦（积分→可靠消息）。AI 还能静态分析代码检测"跨服务调用但无事务保障"的风险点。但最终选型要架构师结合业务容忍度判断。

4. **AI 生成补偿代码怎么验证正确性？**
   补偿代码必须测试：正向操作 + 模拟失败 + 触发补偿 + 验证数据回到初始状态。AI 生成的补偿代码要人工 review——特别是"语义撤销"场景（如发货的补偿是拦截不是召回）。用混沌工程注入故障（kill 服务），验证补偿链路完整执行。

5. **AI 推理服务 crash，扣费怎么保证不重复？**
   扣费用 TCC——Try 阶段冻结额度（推理前），推理成功后 Confirm（真正扣款），推理失败/超时 Cancel（解冻）。即使推理服务 crash，协调器（TCC Manager）会根据全局事务状态触发 Cancel。配合幂等（事务 ID 去重）保证 Confirm/Cancel 重试安全。

## 八、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"四种方案、TCC 三阶段三坑、Saga 倒序补偿、本地消息表"**。

- **四种方案**：XA（强一致不用）、TCC（资金）、Saga（长流程）、可靠消息（异步）
- **TCC**：Try 预留/Confirm 确认/Cancel 回滚，三坑=幂等+空回滚+悬挂
- **Saga**：正向序列 + 倒序补偿，补偿是语义撤销（发货拦截不是召回）
- **本地消息表**：业务+消息表同事务，异步投递 + 消费方幂等
- **选型**：资金 TCC，长流程 Saga，异步可靠消息

### 拟人化理解

把分布式事务想成**多方合同签字**。XA 是"所有人坐一桌同时签字"（强一致但要等人到齐，慢）；TCC 是"每人先签字预留位（Try），全员确认后盖公章（Confirm），任一反悔撕掉预留（Cancel）"——预留是冻结资金/库存；Saga 是"按顺序签字（创建订单→扣库存→扣款），谁反悔就倒着找前面已签的人撤销（补偿）"；可靠消息是"A 签完拍照发微信群（发消息），B 收到也签（消费），最终都签完（最终一致）"。TCC 三个坑：重复确认（幂等）、没预留就被要求撤销（空回滚）、撤销先于预留到（悬挂）。

### 面试现场 60 秒回答

> 分布式事务四种方案按一致性强度选型。XA 两阶段提交强一致但阻塞、协调者单点，互联网基本不用。TCC 用业务层 Try（冻结资源）/Confirm（确认）/Cancel（解冻）模拟两阶段，强一致但侵入强，适合资金扣款。TCC 三大坑：幂等（Confirm/Cancel 重试去重）、空回滚（Try 没执行就 Cancel）、悬挂（Cancel 先于 Try 到）。Saga 把长事务拆成子事务序列，每个配补偿，失败倒序补偿，补偿是语义撤销（发货的补偿是拦截不是召回），适合订单履约长流程。可靠消息用本地消息表（业务+消息表同事务）+ MQ 投递 + 消费方幂等，最轻量适合异步解耦（积分、通知）。选型：资金用 TCC，长链路用 Saga，异步用可靠消息。

### 反问面试官

> 贵司资金类业务（支付/退款）用的是 TCC 还是 Seata AT？长流程订单履约是 Saga 还是可靠消息？有没有自研的事务中间件？遇到过补偿失败需要人工介入的场景吗？如果有，我会聊补偿幂等和兜底告警。

## 九、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不用 XA 一把梭，要搞这么复杂？ | 用性能说话：XA 在万级 TPS 下锁定资源会让 TPS 降到几百，协调者单点宕机会让参与者悬挂（资源永久锁定）。互联网业务宁愿用最终一致换性能，只有传统金融（低并发强一致）才用 XA |
| 证据追问 | 分布式事务到底有没有生效，你怎么证明？ | Seata 控制台看全局事务状态（Committed/Rollbacked）；各服务的 undo log 表看补偿是否执行；业务对账（订单数 vs 扣款数 vs 库存扣减数应一致）；混沌工程注入故障验证补偿链路完整 |
| 边界追问 | TCC 能解决所有分布式事务吗？ | 不能。解决不了不可补偿操作（发短信/邮件已发出无法撤销）、解决不了高并发热点（TCC 仍需锁定资源，热点账户仍是瓶颈）、解决不了跨语言服务（TCC 需要各服务实现三方法，跨语言集成复杂）。不可补偿操作放 Saga 末端或异步队列 |
| 反例追问 | 什么场景不该用 TCC？ | 业务不复杂（本地事务够用，引入 TCC 是过度设计）、高频热点（锁定资源仍是瓶颈，用可靠消息异步削峰）、非关键业务（积分/通知用可靠消息，不值得 TCC 的侵入成本）、遗留系统（改造三方法成本高，用 AT 模式自动补偿） |
| 风险追问 | 分布式事务上线后最大风险？ | 主动点出：补偿失败（补偿操作本身异常导致数据不一致，要有告警 + 人工介入）、协调者单点（Seata TC 要集群）、全局锁性能瓶颈（AT 模式的全局锁影响并发）、补偿不完整（漏写补偿导致无法回滚） |
| 验证追问 | 怎么证明事务链路可靠？ | 压测注入故障（kill 某服务）验证全局回滚；对账系统持续校验跨服务数据一致（订单 vs 扣款 vs 库存）；监控补偿成功率（应 > 99.99%）；混沌工程定期演练（模拟网络分区、服务超时） |
| 沉淀追问 | 团队分布式事务治理规范，沉淀什么？ | 选型 SOP（按业务类型选方案）、TCC 三方法实现规范（幂等/空回滚/悬挂处理）、补偿操作清单（每个正向操作配补偿）、对账系统（跨服务数据校验 + 告警）、故障演练 SOP（定期注入故障验证补偿） |

### 现场对话示例

**面试官**：TCC 的 Try 阶段冻结资金，Confirm 失败了怎么办？

**候选人**：Confirm 失败有两种情况。第一种，Confirm 调用业务异常（如账户被冻结），这时 TCC 协调器（Seata TC）会重试 Confirm（指数退避），因为 Confirm 和 Cancel 不会同时发生（全局事务要么全 Confirm 要么全 Cancel）。如果重试多次仍失败，说明是业务异常需要人工介入（告警）。第二种，Confirm 调用超时（网络问题），协调器也会重试——这就是为什么 Confirm 必须幂等（用 XID 去重，已执行的 Confirm 重复调用直接返回成功）。关键认知是：TCC 不会从 Confirm 回滚到 Cancel，因为进入 Confirm 阶段说明所有 Try 都成功了，全局事务决定提交（Confirm）。所以 Confirm 失败就是不停重试直到成功或人工介入。这也是 TCC 比 XA 强的地方——XA 的 Commit 阶段失败会导致部分参与者提交部分没提交（数据不一致），TCC 的 Confirm 可重试（幂等保证）。

**面试官**：Saga 的补偿操作失败了呢？

**候选人**：Saga 补偿失败比 TCC Confirm 失败更麻烦，因为补偿是"撤销"——补偿失败意味着数据无法回到初始状态。处理策略三层：第一层，重试（指数退避，补偿操作必须幂等）。第二层，重试 N 次仍失败，Saga 协调器把该 Saga 标记为"需人工介入"，触发告警。第三层，人工介入修复——通常是对账系统发现数据不一致，人工执行补偿 SQL 或业务操作。设计原则是：补偿操作要尽量简单可靠（不要在补偿里做复杂逻辑），补偿操作要幂等（可重试）。对于"物理不可撤销"的操作（如已发货），补偿做"语义撤销"（拦截快递 + 记录异常单 + 通知用户），而不是强行回滚。所以 Saga 适合"大部分操作可补偿"的场景，不可补偿操作放最后。

**面试官**：本地消息表的消息投递失败了怎么办？

**候选人**：消息表里有记录就是兜底。投递失败分两种：第一种，MQ 暂时不可用（网络抖动），异步任务下次扫描会重新投递（消息状态还是 PENDING）。第二种，MQ 收到了但没持久化就宕机，消费方没收到——异步任务查消息状态还是"未确认"，会重新投递。关键点是消息表是持久化在业务库的（和业务在同一事务），不会丢。消费方收到重复消息时靠幂等处理（bizId 去重）。还有个细节：投递成功后要把消息状态改为 SENT，但"投递成功"的确认要可靠——用 MQ 的发送回调（ack），回调成功才更新状态。如果回调失败但消息实际已投递，下次扫描会重复投递（消费方幂等兜底）。RocketMQ 的事务消息机制更进一步——Broker 事务回查接口让 Broker 主动问业务方"事务成没成"，省去自己维护消息表的复杂度。

## 常见考点

1. **Seata AT 模式原理？**——Seata 拦截 SQL，自动分析生成 undo log（反向 SQL）。第一阶段执行业务 SQL + 记录 undo log + 记录行锁（防脏写），在同一本地事务提交。第二阶段 Commit 删除 undo log 和行锁；Rollback 用 undo log 反向执行回滚。业务无感知但只支持关系型 DB，全局锁影响并发。
2. **分布式事务和 @Transactional 什么关系？**——@Transactional 是单库事务（Spring AOP），管不了跨库/跨服务。跨服务要用分布式事务方案（TCC/Saga/可靠消息）。Seata 的 @GlobalTransactional 是分布式事务注解，底层用 AT/TCC 模式协调多个服务的本地事务。
3. **幂等在分布式事务里为什么重要？**——因为协调器可能重试 Confirm/Cancel/补偿操作（网络超时重发）。如果这些操作不幂等，重试会产生副作用（重复扣款/重复解冻）。幂等保证"f(x) 执行多次等价于一次"，是重试安全的前提。详见 017 题。
4. **为什么不用 2PC 的变体（3PC）？**——3PC（Three-Phase Commit）引入 CanCommit 阶段 + 超时机制，解决 2PC 的协调者单点和阻塞问题。但 3PC 仍有数据不一致风险（网络分区时参与者超时提交但协调者要回滚），且多一轮往返性能更差。实际工程中 3PC 几乎不用，互联网用 TCC/Saga 替代。


## 结构化回答

**30 秒电梯演讲：** 聊到分布式事务 Saga、TCC 与可靠消息，我的理解是——分布式事务的本质是"跨多个独立资源管理器（DB/MQ）达成一致"——XA 用两阶段锁定资源（强一致但阻塞），TCC 用业务层 Try/Confirm/Cancel 模拟两阶段（强一致但侵入），Saga 用正向操作+补偿操作序列化执行（最终一致低侵入），可靠消息用本地消息表+幂等消费实现最终一致（最轻量）。选型本质是在"一致性强度"和"性能/侵入性"之间权衡。打个比方，像多方签字的合同流程。XA 是"所有人坐一桌，同时签字才生效"（强一致但等人到齐很慢）；TCC 是"每人先签字预留（Try），全部确认后才盖公章（Confirm），任一反悔就撕掉预留（Cancel）"；Saga 是"按顺序签字，谁反悔就倒着走补偿已签的"；可靠消息是"A 签完拍照发群（发消息），B 收到也签，最终大家都签完"（最终一致）。

**展开框架：**
1. **XA** — 两阶段提交（Prepare + Commit），强一致但阻塞、性能差，协调者宕机会悬挂
2. **TCC** — Try（资源预留）-Confirm（确认）-Cancel（回滚），业务侵入强，适合资金类强一致
3. **Saga** — 长事务拆成 N 个子事务，每个配补偿操作，失败时倒序执行补偿，最终一致

**收尾：** 这块我在项目里也踩过坑——想深入的话，可以接着聊：TCC 的 Try 阶段冻结资金怎么实现？您更想看哪个方向？

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡 | "分布式事务 Saga、TCC 与可靠消息——这道题面试官到底想考什么？我用 30 秒给你讲透。" | 开场钩子 |
| 0:15 | 分布式架构图 | 先说核心：分布式事务的本质是"跨多个独立资源管理器（DB/MQ）达成一致"——XA 用两阶段锁定资源（强一致但阻塞），TCC 用业务层 Try/Confirm/Cancel 模拟两阶段（。 | 核心定义 |
| 0:40 | 事务隔离级别对比表 | Try（资源预留）-Confirm（确认）-Cancel（回滚），业务侵入强，适合资金类强一致。 | TCC |
| 1:05 | 概念结构示意图 | 长事务拆成 N 个子事务，每个配补偿操作，失败时倒序执行补偿，最终一致。 | Saga |
| 2:30 | 总结卡 | 一句话记忆：XA = 两阶段（Prepare+Commit），强一致但阻塞，基本不用。 下期可以接着聊：TCC 的 Try 阶段冻结资金怎么实现。 | 收尾总结 |
