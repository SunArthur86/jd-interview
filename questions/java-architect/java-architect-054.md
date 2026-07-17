---
id: java-architect-054
difficulty: L3
category: java-architect
subcategory: 订单
tags:
- Java 架构师
- 订单
- 状态机
- 一致性
feynman:
  essence: 订单状态机的本质是"用有限状态机（FSM）约束订单生命周期"——每个状态有明确的合法后继状态，非法跳转必须被拒绝。一致性设计的核心是"状态变更的原子性"——用乐观锁（version 字段）+ 状态前置条件（WHERE status='WAIT_PAY'）保证并发下只有一个变更成功。订单系统最大的事故来源是"并发状态跳转"（支付和取消同时发生），状态机+乐观锁是兜底。
  analogy: 像地铁闸机。闸机有"关闭"和"打开"两个状态，只有"刷卡成功"能让关闭→打开，只有"人员通过"能让打开→关闭。非法跳转（关闭状态强行通过）被物理阻挡。订单状态机同理——"待支付"状态只能跳到"已支付"或"已取消"，不能直接跳到"已完成"。
  first_principle: 为什么订单要用状态机？因为订单的状态变化有严格的前置条件（只有待支付才能支付，只有已支付才能发货）。如果不用状态机约束，代码里写 if(status==X) 容易遗漏判断，导致"已取消的订单被发货"这种逻辑 bug。状态机把"合法跳转规则"集中声明，运行时强制校验，非法跳转抛异常。
  key_points:
  - 订单状态：待支付→已支付→已发货→已完成（主流程），待支付→已取消（取消）
  - 状态机三要素：当前状态、目标状态、转换条件
  - 并发控制：乐观锁 version + WHERE status=前置状态
  - 非法跳转拦截：数据库层用 UPDATE WHERE status=? 拦截
  - 状态变更 + 副作用（扣库存/退款）要事务一致或事件最终一致
first_principle:
  problem: 订单生命周期有 N 个状态和 M 种跳转，如何防止并发下的非法状态跳转（如支付和取消同时执行）？
  axioms:
  - 订单状态跳转有严格前置条件（只有待支付才能支付）
  - 并发请求可能导致竞态（支付和取消同时到达，都判断为"待支付"都执行）
  - 状态变更必须原子（不能"半个支付"——扣款了但状态没改）
  rebuild: 用状态机声明所有合法跳转（WAIT_PAY→PAID, WAIT_PAY→CANCELLED）。状态变更用乐观锁——UPDATE order SET status='PAID', version=version+1 WHERE id=? AND status='WAIT_PAY' AND version=旧version。并发下只有一个 UPDATE 成功（影响行数=1），另一个失败（影响行数=0，状态已变）。状态变更和副作用（扣库存/发券）用本地事务或领域事件最终一致。
follow_up:
  - 状态机用什么框架？——Spring StateMachine（重），或自研轻量状态机（Enum + Map<当前状态, 允许目标状态>）。京东订单用自研，性能好且可控。
  - 订单状态怎么扩展？——状态用枚举固化，扩展时加新枚举值。历史订单的状态不变，新订单用新状态。状态机配置用版本化（v1 状态机/v2 状态机），按订单类型路由。
  - 已取消订单能恢复吗？——业务上一般不允许（要重新下单）。如果要恢复，加"已取消→待支付"的逆向跳转，但要处理副作用（库存已释放，要重新锁定）。推荐不恢复，重新下单。
  - 状态变更失败怎么补偿？——乐观锁失败重试（指数退避，最多 3 次）；副作用失败（扣库存失败）走 Saga 补偿（回滚订单状态）。
  - 状态机怎么测试？——遍历所有合法跳转（必须成功）+ 所有非法跳转（必须抛异常）。用参数化测试覆盖状态矩阵。
memory_points:
  - 订单状态：待支付→已支付→已发货→已完成（主链）
  - 状态机：Enum + Map<状态, 允许后继>，非法跳转抛异常
  - 并发控制：乐观锁 UPDATE WHERE status=前置 AND version=旧
  - 状态+副作用：本地事务 或 领域事件最终一致
  - 状态变更日志：记录每次状态变化的 from/to/operator/time
---

# 【Java 后端架构师】订单系统状态机与一致性设计

> 适用场景：JD 核心技术。京东订单每天千万级，状态从"待支付"到"已完成"经历 N 次跳转。最常见的生产事故是"并发状态冲突"——用户点取消的同时支付回调到达，两个操作都判断当前是"待支付"都执行，结果订单状态错乱（已取消但扣了款）。状态机+乐观锁是这类事故的根治方案。

## 一、概念层：订单状态机定义

**订单状态与合法跳转**（面试必画）：

```
                         ┌──────────┐
                    ┌───►│ CANCELLED │ (已取消)
                    │    └──────────┘
                    │
┌─────────┐ pay()  │   ┌──────┐ ship()  ┌────────┐ deliver() ┌───────────┐
│WAIT_PAY │───────►├──►│ PAID │────────►│SHIPPED │──────────►│ COMPLETED │
│(待支付) │        │   │(已支付)│        │(已发货) │           │ (已完成)   │
└─────────┘        │   └──────┘        └────────┘           └───────────┘
       ▲           │       │                │
       │ cancel()  │       │ refund()       │ return()
       └───────────┘       ▼                ▼
                      ┌──────────┐     ┌────────────┐
                      │REFUNDING │     │ RETURNING  │
                      │ (退款中)  │     │ (退货中)    │
                      └────┬─────┘     └─────┬──────┘
                           │ refund_ok()     │ return_ok()
                           ▼                 ▼
                      ┌──────────┐     ┌────────────┐
                      │ REFUNDED │     │ RETURNED   │
                      │(已退款)   │     │(已退货)     │
                      └──────────┘     └────────────┘

合法跳转矩阵（有限部分）：
  WAIT_PAY → PAID          (支付)
  WAIT_PAY → CANCELLED     (取消)
  PAID     → SHIPPED       (发货)
  PAID     → REFUNDING     (申请退款)
  SHIPPED  → COMPLETED     (确认收货)
  SHIPPED  → RETURNING     (申请退货)

非法跳转（必须拒绝）：
  WAIT_PAY → SHIPPED       (未支付不能直接发货)
  CANCELLED → PAID         (已取消不能恢复支付)
  COMPLETED → CANCELLED    (已完成不能取消)
```

## 二、机制层：状态机代码实现

**自研轻量状态机**：

```java
// 状态枚举
public enum OrderStatus {
    WAIT_PAY,     // 待支付
    PAID,         // 已支付
    SHIPPED,      // 已发货
    COMPLETED,    // 已完成
    CANCELLED,    // 已取消
    REFUNDING,    // 退款中
    REFUNDED,     // 已退款
    RETURNING,    // 退货中
    RETURNED      // 已退货
}

// 状态机配置（声明合法跳转）
public enum OrderEvent {
    PAY,           // 支付
    CANCEL,        // 取消
    SHIP,          // 发货
    DELIVER,       // 确认收货
    REQUEST_REFUND,// 申请退款
    REFUND_OK,     // 退款成功
    REQUEST_RETURN,// 申请退货
    RETURN_OK      // 退货成功
}

@Configuration
public class OrderStateMachineConfig {

    // 合法跳转表：Map<当前状态, Map<事件, 目标状态>>
    @Bean
    public Map<OrderStatus, Map<OrderEvent, OrderStatus>> transitions() {
        Map<OrderStatus, Map<OrderEvent, OrderStatus>> map = new HashMap<>();
        // WAIT_PAY + PAY → PAID
        transition(map, WAIT_PAY, PAY, PAID);
        transition(map, WAIT_PAY, CANCEL, CANCELLED);
        transition(map, PAID, SHIP, SHIPPED);
        transition(map, PAID, REQUEST_REFUND, REFUNDING);
        transition(map, SHIPPED, DELIVER, COMPLETED);
        transition(map, SHIPPED, REQUEST_RETURN, RETURNING);
        transition(map, REFUNDING, REFUND_OK, REFUNDED);
        transition(map, RETURNING, RETURN_OK, RETURNED);
        return Collections.unmodifiableMap(map);   // 不可变，防止运行时篡改
    }

    private void transition(Map map, OrderStatus from, OrderEvent event, OrderStatus to) {
        map.computeIfAbsent(from, k -> new HashMap<>()).put(event, to);
    }
}
```

**订单聚合根的状态变更方法**（DDD 充血）：

```java
public class Order {
    private Long id;
    private OrderStatus status;
    private Integer version;      // 乐观锁版本号
    private BigDecimal amount;
    private List<OrderItem> items;

    @Autowired
    private Map<OrderStatus, Map<OrderEvent, OrderStatus>> transitions;

    // 状态变更：校验合法性
    public void transition(OrderEvent event) {
        Map<OrderEvent, OrderStatus> allowed = transitions.get(this.status);
        if (allowed == null || !allowed.containsKey(event)) {
            // 非法跳转，抛异常并记录监控
            throw new IllegalStateTransitionException(
                "非法状态跳转: " + this.status + " + " + event +
                ", order_id=" + this.id);
        }
        OrderStatus oldStatus = this.status;
        this.status = allowed.get(event);
        // 记录状态变更日志（审计）
        this.addStateChangeLog(oldStatus, this.status, event);
    }

    // 业务方法：支付
    public OrderPaidEvent pay() {
        transition(OrderEvent.PAY);   // 状态机校验
        return new OrderPaidEvent(this.id, this.amount);
    }

    // 业务方法：取消
    public OrderCancelledEvent cancel() {
        transition(OrderEvent.CANCEL);
        return new OrderCancelledEvent(this.id);
    }
}
```

## 三、机制层：并发控制与非法跳转拦截

**乐观锁 SQL**（数据库层拦截）：

```java
@Mapper
public interface OrderMapper {

    // 乐观锁更新：WHERE status=前置状态 AND version=旧版本
    @Update("UPDATE t_order SET status = #{newStatus}, " +
            "version = version + 1, update_time = NOW() " +
            "WHERE id = #{orderId} " +
            "AND status = #{expectedStatus} " +
            "AND version = #{expectedVersion}")
    int optimisticUpdate(@Param("orderId") Long orderId,
                         @Param("newStatus") String newStatus,
                         @Param("expectedStatus") String expectedStatus,
                         @Param("expectedVersion") Integer expectedVersion);
}

// 应用层使用
@Service
public class OrderApplicationService {

    @Transactional
    public void payOrder(Long orderId) {
        Order order = orderRepo.findById(orderId);
        OrderStatus oldStatus = order.getStatus();

        try {
            order.pay();   // 状态机校验（应用层）
        } catch (IllegalStateTransitionException e) {
            // 应用层校验失败，记录非法跳转
            monitor.record("order_state_conflict", orderId, oldStatus, "PAY");
            throw e;
        }

        // 乐观锁更新（数据库层兜底）
        int affected = orderMapper.optimisticUpdate(
            orderId,
            order.getStatus().name(),
            oldStatus.name(),        // 期望的旧状态
            order.getVersion()       // 期望的旧版本
        );

        if (affected == 0) {
            // 更新失败：并发冲突（其他请求已改状态）
            Order current = orderRepo.findById(orderId);
            monitor.record("order_state_conflict", orderId, oldStatus,
                current.getStatus().name());
            throw new ConcurrentStateConflictException(
                "订单状态并发冲突: orderId=" + orderId +
                ", expected=" + oldStatus + ", actual=" + current.getStatus());
        }
    }
}
```

**非法状态跳转拦截 SQL**（更严格的约束）：

```sql
-- 方法 1：乐观锁（推荐）
UPDATE t_order
SET status = 'PAID', version = version + 1, update_time = NOW()
WHERE id = 12345
  AND status = 'WAIT_PAY'       -- 前置状态条件
  AND version = 5;               -- 乐观锁版本

-- 如果 status 已不是 WAIT_PAY（被取消），affected_rows = 0，支付失败

-- 方法 2：CHECK 约束（MySQL 8.0+ 支持）
ALTER TABLE t_order
ADD CONSTRAINT chk_status_transition
CHECK (
    NOT (status = 'PAID' AND OLD.status = 'CANCELLED')  -- 已取消不能变已支付
    -- 注意：MySQL 的 CHECK 不能引用 OLD，这里用触发器替代
);

-- 方法 3：触发器（强制状态机规则）
DELIMITER //
CREATE TRIGGER before_order_status_update
BEFORE UPDATE ON t_order
FOR EACH ROW
BEGIN
    -- 非法跳转检查
    IF OLD.status = 'CANCELLED' AND NEW.status = 'PAID' THEN
        SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = '非法状态跳转: CANCELLED → PAID';
    END IF;
    IF OLD.status = 'COMPLETED' AND NEW.status = 'CANCELLED' THEN
        SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = '非法状态跳转: COMPLETED → CANCELLED';
    END IF;
END//
DELIMITER ;
```

## 四、机制层：状态变更日志与一致性

**状态变更日志表**（审计必备）：

```sql
CREATE TABLE t_order_state_log (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    order_id BIGINT NOT NULL,
    from_status VARCHAR(20) NOT NULL,
    to_status VARCHAR(20) NOT NULL,
    event VARCHAR(20) NOT NULL,         -- 触发事件（PAY/CANCEL）
    operator VARCHAR(50),               -- 操作人（用户/系统/管理员）
    operator_type VARCHAR(20),          -- USER/SYSTEM/ADMIN
    remark VARCHAR(200),
    create_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_order (order_id, create_time)
);

-- 每次状态变更记录一条
INSERT INTO t_order_state_log (order_id, from_status, to_status, event, operator)
VALUES (12345, 'WAIT_PAY', 'PAID', 'PAY', 'system_callback');
```

**状态变更与副作用的一致性**：

```java
@Service
public class OrderApplicationService {

    // 场景：支付成功后扣库存（跨聚合）
    @Transactional
    public void onPaymentSuccess(Long orderId) {
        // 1. 本地事务：状态变更 + 日志
        Order order = orderRepo.findById(orderId);
        order.pay();
        int affected = orderMapper.optimisticUpdate(...);
        if (affected == 0) throw new ConcurrentStateConflictException();

        // 2. 扣库存：跨服务调用（不在同一事务）
        try {
            inventoryClient.deduct(order.getItems());
        } catch (Exception e) {
            // 扣库存失败：发补偿事件，后续 Saga 回滚支付
            eventPublisher.publish(new InventoryDeductFailedEvent(orderId));
            throw e;
        }

        // 3. 发领域事件（Outbox 模式，同事务）
        outboxRepo.save(new OutboxMessage(new OrderPaidEvent(orderId)));
    }
}

// 补偿 Saga：支付成功但扣库存失败 → 退款 + 取消订单
@EventListener
public class OrderCompensationSaga {

    @Async
    public void onInventoryDeductFailed(InventoryDeductFailedEvent event) {
        Long orderId = event.getOrderId();
        // 1. 退款
        paymentClient.refund(orderId);
        // 2. 取消订单
        orderApplicationService.cancelOrder(orderId, "库存不足自动取消");
        // 3. 告警
        alertService.send("订单" + orderId + "扣库存失败已自动退款取消");
    }
}
```

## 五、底层本质：状态机是业务不变量的固化

回到第一性：**订单状态机的本质是"把业务规则（状态跳转约束）从代码里固化到数据结构里"**。

- **不用状态机（if-else 散落）**：每个 Service 方法手动判断 `if (order.status == WAIT_PAY)`，10 个方法 10 处判断，漏一处就出 bug（如发货方法忘了判断状态，把已取消的订单发了）。
- **用状态机（集中声明）**：合法跳转集中在 Map 里，所有状态变更走 `transition(event)` 方法，非法跳转自动抛异常。新增状态只改 Map，不改业务方法。

**乐观锁的本质是"检测并发冲突而非阻止"**：悲观锁（SELECT FOR UPDATE）在事务开始就锁行，阻止并发；乐观锁不锁行，UPDATE 时用 WHERE version=旧 检测——如果 version 变了说明有人改过，本次 UPDATE 失败。乐观锁适合"冲突少"的场景（订单状态变更不是超高并发），性能比悲观锁好（不持有锁）。

**并发冲突的典型场景**：用户点"取消订单"和支付网关回调"支付成功"几乎同时到达。两个请求都读到 `status=WAIT_PAY`，都尝试更新。乐观锁保证只有一个成功：
- 请求 A（取消）：UPDATE SET status='CANCELLED' WHERE status='WAIT_PAY' AND version=5 → 成功（version→6）
- 请求 B（支付）：UPDATE SET status='PAID' WHERE status='WAIT_PAY' AND version=5 → 失败（status 已是 CANCELLED）

支付失败的请求走补偿——通知支付网关该订单已取消，触发退款。这就是为什么支付回调要幂等+可补偿。

## 六、AI 架构师加问：5 个

1. **用 AI 检测订单状态机漏洞，怎么做？**
   AI 分析代码里的所有状态变更点，对比状态机配置，找出"绕过 transition() 方法直接 setStatus() 的代码"。静态扫描 + 人工 review。历史事故样本训练 AI 识别常见漏洞模式。

2. **AI 辅助设计订单状态机，怎么用？**
   AI 从需求文档抽取状态和事件，生成状态机配置草案（Map<状态, Map<事件, 目标>>）。但复杂业务（退款逆向、售后分支）要人工补充——AI 容易漏掉边界场景。生成后用状态矩阵测试覆盖所有合法/非法跳转。

3. **AI Agent 操作订单，怎么过状态机？**
   Agent 调用 OrderApplicationService 的标准方法（payOrder/cancelOrder），走状态机校验。Agent 不能绕过状态机直改 DB。Agent 的操作记录到 state_log（operator=AI_AGENT），可追溯。

4. **用 AI 预测订单状态冲突概率，怎么做？**
   AI 分析订单的并发请求模式——同订单的多请求时间间隔、用户操作习惯（点取消后多快收到支付回调）。高冲突概率的订单加悲观锁（SELECT FOR UPDATE），低冲突用乐观锁。

5. **AI 推理修改订单状态，怎么保证安全？**
   AI 的推理结果不能直接 UPDATE 订单状态，必须调聚合根的 transition() 方法，走状态机校验。Code Review 检查：任何修改 status 字段的代码必须经过 transition()，禁止直接 order.setStatus()。

## 七、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"状态机声明跳转、乐观锁防并发、状态日志留审计、事件解耦副作用"**。

- **状态机**：Map<状态, Map<事件, 目标>>，transition(event) 校验合法性
- **乐观锁**：UPDATE WHERE status=前置 AND version=旧，affected=0 则冲突
- **状态日志**：t_order_state_log 记录 from/to/event/operator
- **一致性**：状态变更本地事务，副作用（扣库存）用领域事件最终一致
- **非法跳转**：应用层 transition() 校验 + 数据库层 WHERE status=? 双重兜底

### 面试现场 60 秒回答

> 订单状态机用自研轻量实现——状态枚举（WAIT_PAY/PAID/SHIPPED/COMPLETED）+ 事件枚举（PAY/CANCEL/SHIP），合法跳转声明在 Map<状态, Map<事件, 目标>> 里。订单聚合根的 pay() 方法调 transition(PAY) 校验合法性，非法跳转抛 IllegalStateTransitionException。并发控制用乐观锁——UPDATE SET status='PAID', version=version+1 WHERE id=? AND status='WAIT_PAY' AND version=旧，affected_rows=0 说明并发冲突（状态已被其他请求改了）。比如取消和支付同时到达，都读到 WAIT_PAY，乐观锁保证只有一个 UPDATE 成功，另一个 affected=0 走补偿。状态变更日志记录每次 from/to/event/operator，审计用。副作用（扣库存/发券）用领域事件解耦——本地事务只管状态变更，扣库存跨服务走事件最终一致，失败走 Saga 补偿。最容易翻车的是直接 order.setStatus() 绕过状态机——Code Review 强制所有状态变更走 transition()。

## 八、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不用悲观锁（SELECT FOR UPDATE），乐观锁够吗？ | 用冲突频率说话：订单状态变更不是超高并发（单订单 QPS < 10），乐观锁冲突率 < 1%，重试即可。悲观锁持有锁时间长影响吞吐。用 order_state_conflict_count（状态冲突次数）和 lock_wait_timeout_count（锁等待超时）量化 |
| 证据追问 | 怎么证明状态机没漏洞？ | 自动化测试：遍历所有合法跳转（必须成功）+ 所有非法跳转（必须抛异常）；监控 order_state_conflict_count（应该低，高说明状态变更逻辑有问题）；非法跳转日志扫描（IllegalStateTransitionException 应该趋近 0） |
| 边界追问 | 状态机能防所有异常吗？ | 不能。防不了"业务逻辑错误"（如扣款金额错误但状态正常变更）、防不了"跨服务不一致"（状态变了但库存没扣）、防不了"运维误操作"（DBA 直改 DB）。这些要靠对账和审计 |
| 反例追问 | 什么场景状态机过度设计？ | 简单 CRUD（配置表无状态流转）、单状态对象（只有"有效/无效"两态）、一次性流程（如导入任务跑完即弃）。这些用 if-else 更简单 |
| 风险追问 | 订单状态机最大的风险？ | 主动点出：绕过状态机直改 DB（DBA 操作或代码漏洞）、状态机和业务逻辑不同步（状态变了但副作用没执行）、状态爆炸（N 个状态 M 个跳转，配置复杂）、历史订单状态不兼容新状态机版本 |
| 验证追问 | 怎么验证乐观锁有效？ | 并发测试：N 个线程同时支付同一订单，断言只有一个成功；压力测试：单订单 1000 TPS 状态变更，统计冲突率和成功率；混沌测试：kill 某个服务，验证状态一致性（状态变了的订单是否正确回滚） |
| 沉淀追问 | 订单状态机沉淀什么？ | 状态机框架（Map 配置+transition 校验+日志）、状态矩阵测试模板、状态变更监控大盘（order_state_conflict_count 非法跳转告警）、状态机版本化规范 |

### 现场对话示例

**面试官**：用户点取消和支付回调同时到达，乐观锁怎么保证不混乱？

**候选人**：乐观锁在数据库层保证"只有一个成功"。两个请求几乎同时到达，都读到 status=WAIT_PAY, version=5。请求 A（取消）先执行 UPDATE SET status='CANCELLED', version=6 WHERE id=? AND status='WAIT_PAY' AND version=5，成功，affected=1，version 变成 6。请求 B（支付）随后执行 UPDATE SET status='PAID', version=6 WHERE id=? AND status='WAIT_PAY' AND version=5，但因为 status 已经是 CANCELLED（不再是 WAIT_PAY），WHERE 条件不匹配，affected=0。这时请求 B 知道并发冲突，走补偿——通知支付网关"该订单已取消，请退款"。这就是为什么支付回调必须幂等+可补偿——回调成功不代表订单最终支付成功，可能被并发取消。京东订单的实践：支付回调先乐观锁更新状态，失败则查当前状态——如果已取消，触发退款（资金回流）；如果已支付（重复回调），幂等返回成功。监控 order_state_conflict_count 指标，冲突率高时排查是否状态变更逻辑有问题。

**面试官**：已取消的订单能改回待支付吗？

**候选人**：业务上一般不允许。已取消意味着库存已释放、优惠券已退回，要"恢复"就得重新锁定库存+重新用券，逻辑复杂且容易出错。京东的做法是已取消订单不可恢复，用户要重新下单。但有一种场景需要"类似恢复"——超时取消后用户又想支付。这时不是恢复原订单，而是创建新订单（复用原订单的商品和地址），走完整下单流程。如果一定要做"恢复"，状态机里加 CANCELLED → WAIT_PAY 的逆向跳转，但要处理副作用——重新锁定库存（可能已售罄）、重新核销优惠券（可能已过期）。复杂度高且容易出 bug，不推荐。状态机设计原则：正向流转简单，逆向流转要慎重——每个逆向都要考虑副作用回滚。

**面试官**：订单状态变更和扣库存不在一个事务，怎么保证一致？

**候选人**：用领域事件+最终一致+Saga 补偿。支付成功后，订单状态变更（UPDATE status=PAID）在本地事务，同事务写 Outbox 表（OrderPaidEvent）。事务提交后，异步任务扫 Outbox 投递事件到 MQ，库存服务消费 OrderPaidEvent 扣库存。如果扣库存失败（库存不足），库存服务发 InventoryDeductFailedEvent，订单服务的 Saga 监听器收到后执行补偿——退款 + 取消订单。这样订单状态和扣库存最终一致（可能短暂不一致：订单已支付但库存还没扣，但最终收敛）。关键点：状态变更是"已提交"的本地事务，不会回滚；扣库存失败靠补偿（退款+取消）恢复一致。这比分布式事务（XA/TCC）侵入性低，适合订单这种长流程。如果资金零差错要求，扣库存可以放支付前（下单时锁定库存），这样支付时库存已锁定，不会出现"支付成功但没货"。

## 常见考点

1. **Spring StateMachine 和自研怎么选？**——Spring StateMachine 功能全（嵌套状态/守卫/动作）但重，学习成本高。自研（Enum+Map）轻量可控，适合简单状态流转。京东订单用自研，复杂度可控且性能好。
2. **状态机和流程引擎（BPMN）什么关系？**——状态机是"状态视角"（订单在什么状态），流程引擎是"流程视角"（订单走到第几步）。简单订单用状态机，复杂履约流程（多部门协作）用流程引擎（如 Camunda）。
3. **乐观锁和悲观锁怎么选？**——冲突少选乐观锁（不持锁，性能好），冲突多选悲观锁（避免重试风暴）。订单状态变更冲突少（单订单低频），用乐观锁。库存扣减冲突多（热点商品），用悲观锁或 Redis 原子操作。
4. **状态变更日志和审计日志区别？**——状态变更日志专门记录订单状态变化（from/to/event），是业务级审计；审计日志记录所有操作（查询/修改/删除），是安全级审计。两者互补。

## 结构化回答

**30 秒电梯演讲：** 订单状态机的本质是用有限状态机（FSM）约束订单生命周期——每个状态有明确的合法后继状态，非法跳转必须被拒绝。一致性设计的核心是状态变更的原子性——用乐观锁（version 字段）+ 状态前置条件（WHERE status='WAIT_PAY'）保证并发下只有一个变更成功。订单系统最大的事故来源是并发状态跳转（支付和取消同时发生），状态机+乐观锁是兜底

**展开框架：**
1. **订单状态** — 待支付→已支付→已发货→已完成（主流程），待支付→已取消（取消）
2. **状态机三要素** — 当前状态、目标状态、转换条件
3. **并发控制** — 乐观锁 version + WHERE status=前置状态

**收尾：** 以上是我的整体思路。您想继续深入聊——状态机用什么框架？


## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：订单系统状态机与一致性设计 | "这题一句话：订单状态机的本质是用有限状态机（FSM）约束订单生命周期——每个状态有明确的合法后继状态，非法跳转必须被拒绝。" | 开场钩子 |
| 0:15 | 像地铁闸机。闸机有关闭和打开两个状态类比图 | "打个比方：像地铁闸机。闸机有关闭和打开两个状态。" | 核心类比 |
| 0:40 | 订单状态示意/对比图 | "待支付→已支付→已发货→已完成（主流程），待支付→已取消（取消）" | 订单状态要点 |
| 1:05 | 状态机三要素示意/对比图 | "当前状态、目标状态、转换条件" | 状态机三要素要点 |
| 1:55 | 总结卡 | "记住：订单状态。下期见。" | 收尾 |
