---
id: pdd-trade-004
difficulty: L3
category: pdd-trade
subcategory: 分布式事务
tags:
- 拼多多
- 交易
- 分布式事务
- Seata
- TCC
- 本地消息表
feynman:
  essence: 交易跨服务（订单+库存+支付+积分）需分布式事务，用"本地消息表（最终一致）+ TCC（强一致核心场景）+ Seata（框架）"组合，强一致太慢用柔性事务。
  analogy: 强一致像签三方合同同时盖章（贵慢），柔性事务像各签各的+事后对账（快但短暂不一致）。
  first_principle: 跨服务事务无法单库 ACID，CAP 下要么牺牲可用（XA）要么牺牲强一致（柔性）。
  key_points:
  - 本地消息表：业务+消息同事务，定时投递 MQ，下游幂等
  - TCC：Try-Confirm-Cancel，强一致，业务侵入大
  - Seata：AT 模式（自动生成回滚 SQL）/ TCC / Saga
  - 交易用：本地消息表（最终一致）+ TCC（核心扣款）
first_principle:
  problem: 下单跨订单/库存/支付/积分多服务，如何保证最终一致？
  axioms:
  - 单库 ACID 不跨服务
  - XA 太慢
  - 业务可容忍秒级最终一致
  rebuild: 本地消息表（异步通知）+ TCC（核心扣款强一致）+ 幂等消费。
follow_up:
- TCC 三阶段怎么实现？——Try 预留资源、Confirm 确认、Cancel 回滚
- 本地消息表和事务消息区别？——本地消息表自建；RocketMQ 事务消息原生支持
- 下单全链路怎么一致？——订单+库存（TCC 扣减）+ 积分（本地消息表异步）
memory_points:
- 本地消息表：业务+消息同事务，定时投递
- TCC：Try/Confirm/Cancel（强一致，业务侵入大）
- Seata AT 模式：自动回滚 SQL
- 交易组合：核心 TCC + 非核心消息表
---

# 【拼多多交易】分布式事务怎么解决？下单跨服务怎么一致？

> JD 依据："分布式事务框架和原理"。

## 一、方案对比

| 方案 | 一致性 | 性能 | 适用 |
|------|--------|------|------|
| XA（2PC） | 强 | 差 | 传统金融（少用） |
| TCC | 强 | 中 | 核心扣款 |
| Saga | 最终 | 好 | 长流程 |
| 本地消息表 | 最终 | 好 | 异步通知 |

## 二、下单全链路一致性

```
订单服务 createOrder()
   ├─ 订单 DB（订单表 + 消息表，同事务）
   ├─ ↓ MQ
   ├─ 库存服务：TCC 扣减（Try 冻结→Confirm 扣减/Cancel 解冻）
   ├─ 支付服务：生成支付单
   └─ 积分服务：异步加积分（本地消息表）
```

## 三、TCC 实战（扣款）

```java
// Try：冻结额度
@TwoPhaseBusinessAction(name = "deduct")
public boolean tryDeduct(BusinessActionContext ctx, long uid, long amount) {
    accountDao.freeze(uid, amount);  // 冻结
    return true;
}
// Confirm：扣减冻结
public boolean confirmDeduct(BusinessActionContext ctx) {
    accountDao.deductFrozen(ctx.getActionContext("uid"), ctx.getActionContext("amount"));
    return true;
}
// Cancel：解冻
public boolean cancelDeduct(BusinessActionContext ctx) {
    accountDao.unfreeze(ctx.getActionContext("uid"), ctx.getActionContext("amount"));
    return true;
}
```

## 四、本地消息表

```java
@Transactional
public void createOrder(OrderReq req) {
    orderDao.insert(order);
    outboxDao.insert(new Outbox("OrderCreated", toJson(order)));  // 同事务
}
// 定时扫 outbox 投递 MQ
```

## 五、Seata AT 模式（自动补偿）

```java
@GlobalTransactional
public void createOrder(OrderReq req) {
    orderService.create(req);       // 订单库
    storageService.deduct(req);     // 库存库
    // Seata 自动生成回滚 SQL，任一失败全局回滚
}
```

## 六、底层本质

分布式事务本质是 **CAP 取舍**：
- 强一致（XA）：锁久，牺牲可用
- 最终一致（柔性）：异步，牺牲一致性窗口

交易选混合：核心扣款 TCC（强一致）+ 非核心本地消息表（最终一致）。

## 常见考点
1. **TCC 和 2PC 区别**？——2PC 资源层（DB 锁）；TCC 业务层（业务实现三阶段）。
2. **Seata AT 怎么自动回滚**？——解析 SQL 生成 before/after image，失败时用 image 反向回滚。
3. **幂等为什么必须**？——柔性事务可能重试，消费端必须幂等（业务唯一键）。

## 苏格拉底式面试追问

> 这组追问不背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：下单链路你用"核心 TCC + 非核心本地消息表"的混合方案，为什么不统一用一种？**

因为不同环节对一致性的容忍度不同，统一用强一致（TCC）会让非核心链路承担不必要的性能代价，统一用最终一致（消息表）又会让核心扣款有短暂不一致的资损风险。具体说：库存扣减和账户扣款涉及"超卖"和"超扣"，必须强一致——库存 Try 冻结失败就不能下单，这是钱的事；而积分、通知、风控异步复核，晚几秒到账用户无感，用本地消息表异步就行，成本低。混合方案的动机是"按业务语义分级"，把贵的强一致只用在刀刃上。

### 第二层：证据与定位

**Q：线上有用户投诉"下单成功但积分没到账"，你怎么定位是 TCC 链路的问题，还是本地消息表（积分）的问题？**

先区分是哪条链路。积分走的是本地消息表，三步定位：
1. 查订单服务的 `outbox` 表——这笔订单的 `OrderCreated` 消息是否生成、状态是 `PENDING/SENT/CONSUMED` 哪个。如果 outbox 里没记录，说明订单事务里没插消息（代码 bug 或事务回滚）。
2. 如果 outbox 是 `SENT` 但积分表没记录，查 MQ 的消费日志——消费者是不是抛异常了？看消费者日志的 `exception` 和 `retry_count`。
3. 如果 outbox 是 `PENDING` 一直没投递，查定时扫描任务——是不是扫描线程挂了（jstack 看线程状态），或者扫描 SQL 的 `WHERE status='PENDING' AND create_time < now()-30s` 条件没命中（时区问题）。
关键是顺着 outbox 状态机一路查，每一步都有明确的状态标记，能精确定位卡在哪。

### 第三层：根因深挖

**Q：你查到是 outbox 扫描任务的线程卡死了，根因是什么？光是重启扫描任务就行吗？**

重启只是恢复，根因要看 jstack 卡在哪。常见两种：
1. 扫描线程在调 `mqProducer.send()` 时同步等待 MQ broker 响应，broker 慢了或挂了，线程阻塞在 `socketRead`。根因是"投递 MQ 同步等待"——应该改成异步发送（send 回调）或带超时（`sendTimeout=3000ms`），超时就跳过这条，下一轮重试。
2. outbox 表数据堆积（百万级 PENDING），一次性 `LIMIT 1000` 扫描导致大事务+长连接。根因是扫描批量太大或频率太低——改成小批量（100 条）+ 高频（每 5 秒），并给 outbox 加 `status + create_time` 联合索引，避免全表扫。

**Q：那为什么不直接用 RocketMQ 的事务消息，而要自己维护本地消息表？**

两者本质一样（都是"业务+消息原子化"），但取舍不同。RocketMQ 事务消息原生支持，不用维护 outbox 表，但它绑死 RocketMQ——如果库存/支付走 Kafka，事务消息用不了。本地消息表是中间件无关的，任何 MQ 都能接，且 outbox 表本身就是审计证据（哪条消息什么时候发的，DB 里查得到）。代价是多一张表 + 定时扫描任务。拼多多这种多 MQ 共存的场景（交易用 RocketMQ、数据同步用 Kafka），本地消息表的解耦更值。如果系统只用 RocketMQ 且不想自建扫描任务，事务消息是更轻的选择。

### 第四层：方案权衡

**Q：库存扣减你用 TCC，但如果 Try 阶段冻结库存后，订单服务挂了没触发 Confirm/Cancel，库存一直被冻结，你怎么权衡这种"悬挂"？**

TCC 的经典问题叫"悬挂"（Try 到了但 Confirm/Cancel 没到，资源一直占用）。权衡方案是"超时 + 状态表"：
1. 防悬挂表——库存服务记录每个 `xid`（全局事务 id）的状态，Try 插入 `TRYING`，Confirm 改 `CONFIRMED`，Cancel 改 `CANCELLED`。如果 Cancel 来了发现没有 Try 记录，先记下来（防 Try 后到），下次 Try 来了直接拒绝。
2. 超时自动 Cancel——Try 记录带时间戳，定时任务扫超过 5 分钟没 Confirm/Cancel 的 Try，自动调 Cancel 解冻。本质是给 TCC 加"兜底超时"，不依赖 TC（事务协调器）一定能通知到。

**Q：为什么不直接用 Seata AT 模式，它不是自动回滚吗，业务不用写三阶段？**

AT 模式确实省事，但它在高并发扣库存场景有致命问题——AT 靠"全局锁"保证事务隔离，扣库存时多个全局事务争抢同一行的全局锁，并发度上不去，且锁等待会让 RT 飙高。实测库存扣减 AT 模式 QPS 比 TCC 低 5-10 倍。另外 AT 模式的回滚靠 before/after image 反向 SQL，如果业务有复杂逻辑（如"扣减后不能小于 0"），image 回滚可能不满足业务约束。TCC 虽然业务侵入大（要写三个方法），但锁粒度可控（业务层冻结而非 DB 全局锁）、回滚逻辑业务自己保证。核心扣减场景，TCC 的性能和正确性更值。

### 第五层：验证与沉淀

**Q：你怎么验证这套混合事务方案在各种故障下都能最终一致，而不是"平时没事，故障就乱"？**

必须做故障注入的混沌测试，覆盖几个关键场景：
1. 下单中途kill 订单服务——验证库存的 Try 会不会被超时 Cancel 解冻（查 `freeze_log` 是否回滚）。
2. MQ broker 挂掉 5 分钟——验证 outbox 表堆积但恢复后能投递、积分最终到账（查 outbox 状态从 PENDING → SENT → CONSUMED）。
3. 消费者重复消费同一条消息——验证积分只加了一次（查 `point_flow` 的幂等键唯一）。
每个场景都要有明确的"一致性断言"：最终订单状态、库存余量、积分余额、账户余额满足业务不变式。比如"订单 PAID 的，库存一定扣减、积分一定到账、账户一定扣款"。用对账脚本跑这个不变式，不满足就告警。

**Q：怎么让新人不写出破坏一致性的事务代码？**

沉淀成框架约束和规范：
1. 本地消息表强制 SDK——封装 `@TransactionalWithOutbox` 注解，业务只写业务逻辑，消息自动同事务插入 outbox，禁止业务自己操作 outbox 表。
2. TCC 三方法强制成对——CI 扫描所有 `@TwoPhaseBusinessAction`，必须有 try/confirm/cancel 三个方法且都有幂等校验，少一个 CI 挂掉。
3. 事务边界规范——明确文档"哪些场景必须强一致（钱/库存），哪些可最终一致（积分/通知）"，新人设计评审时必须标注每个跨服务调用的一致性级别，由交易域 owner review。靠框架和规范，不是靠人记。

## 结构化回答

**30 秒电梯演讲：** 下单跨订单/库存/支付/积分多服务，如何保证最终一致？简单说就是——交易跨服务（订单+库存+支付+积分）需分布式事务，用"本地消息表（最终一致）+ TCC（强一致核心场景）+ Seata（框架）"组合，强一致太慢用柔性事务。

**展开框架：**
1. **本地消息表** — 本地消息表：业务+消息同事务，定时投递 MQ，下游幂等
2. **TCC** — TCC：Try-Confirm-Cancel，强一致，业务侵入大
3. **Seata** — Seata：AT 模式（自动生成回滚 SQL）/ TCC / Saga

**收尾：** 您看这块要不要再展开聊聊？

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：分布式事务怎么解决？下单跨服务怎么一致？ | 今天聊「分布式事务怎么解决？下单跨服务怎么一致？」。一句话：交易跨服务（订单+库存+支付+积分）需分布式事务，用"本地消息表（最终一致）+ TCC（强一致核心场景）+ Seata… | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：本地消息表：业务+消息同事务，定时投递 MQ，下游幂等 | 核心概念 |
| 1:04 | 能力/参数拆解表 | 要点是：TCC：Try-Confirm-Cancel，强一致，业务侵入大 | 能力拆解 |
| 1:56 | 流程图：输入→处理→输出 | 要点是：Seata：AT 模式（自动生成回滚 SQL）/ TCC / Saga | 关键机制 |
| 3:00 | 总结卡 + 下期预告 | 记住核心要点就够了。下期见。 | 收尾 |
