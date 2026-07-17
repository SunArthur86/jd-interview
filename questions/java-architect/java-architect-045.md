---
id: java-architect-045
difficulty: L2
category: java-architect
subcategory: 中台架构
tags:
- Java 架构师
- DDD
- 领域模型
- 架构
feynman:
  essence: DDD 的落地本质是用"统一语言 + 限界上下文 + 聚合"把业务复杂度圈在可控边界内。技术实现上靠四层架构（Interface/Application/Domain/Infrastructure）把领域逻辑从 ORM、RPC、MQ 里隔离出来，让 Order、Inventory、Payment 这些核心对象的行为由领域规则驱动，而不是由数据库表结构驱动。
  analogy: 像城市规划。限界上下文是行政区（订单区、库存区、支付区各有自己的市政厅和法规），上下文映射是跨区协议（订单区要扣库存得按库存区的接口调用），统一语言是区内居民用的方言（订单区说"下单/履约"，物流区说"揽件/派送"，不混着用）。贫血的 Order 就是个空壳开发区，充血的 Order 才是有人管的真实街区。
  first_principle: 为什么要先建模再写代码？因为业务规则的复杂度在代码里蔓延的成本是非线性的。一个"订单能不能取消"的规则如果散落在 Controller、Service、DAO 三层，每改一次业务就要改三处。DDD 把规则收敛到 Order 聚合根的 cancel() 方法里，规则变化只改一处——这是把"业务规则的物理位置"从分散降到收敛。
  key_points:
  - 战略设计：限界上下文划边界，上下文映射定协作（合作/共享内核/客户-供应商/防腐层）
  - 战术设计：实体（有唯一标识）、值对象（无标识不可变）、聚合（一致性边界）、领域服务（无状态跨聚合逻辑）
  - 四层架构：Interface（RPC/HTTP）→ Application（用例编排/事务）→ Domain（业务规则）→ Infrastructure（DB/MQ/外部RPC）
  - 聚合根是唯一对外入口，外部只能持有聚合根引用，不能直接操作聚合内对象
  - 仓储（Repository）只对聚合根服务，返回的是聚合对象不是 DTO
first_principle:
  problem: 业务规则随需求增长而膨胀，如何让代码结构扛住"规则爆炸"而不变成意大利面？
  axioms:
  - 业务规则的本质是约束（不变量），约束必须被集中保护，不能散落
  - 数据库表是"持久化形态"，不是"业务形态"，两者不能混为一谈
  - 跨上下文协作必然有翻译成本，防腐层（ACL）是显式承担这个成本的地方
  rebuild: 用限界上下文把系统切成业务内聚的块（订单/库存/支付），每块内部用聚合根封装不变量（订单的金额必须等于明细之和），聚合通过仓储持久化（不暴露 SQL），应用层编排用例和事务（下单 = 创建订单 + 锁库存 + 发事件），领域事件解耦上下文（OrderPaid → 触发发货）。这样规则收敛在聚合，协作收敛在事件，数据形态和业务形态解耦。
follow_up:
  - 聚合粒度怎么定？——按"事务一致性边界"定。一个聚合内的所有修改必须在同一个数据库事务里完成。Order 和 OrderItem 通常在同一事务，是一个聚合；Order 和 Inventory 跨服务，不可能同事务，是两个聚合。
  - 领域事件怎么落地？——Spring 用 ApplicationEventPublisher 发本地事件，跨进程用 MQ（RocketMQ 事务消息保证和业务一致）。事件要带版本号和幂等键，消费方幂等。
  - 仓储用 MyBatis 还是 JPA？——JPA 对聚合友好（@OneToMany cascade 自动管理聚合内实体），MyBatis 更灵活但要手写聚合重建逻辑。京东内部多用 MyBatis + 手写 Assembler 把 DO 转成聚合。
  - 贫血模型为什么是反模式？——OrderDO 只有 getter/setter，业务规则散落在 OrderService，规则一改要找遍 Service。充血模型的 cancel() 方法把规则封在对象里，改规则只改 Order.cancel()。
  - DDD 和微服务什么关系？——限界上下文是微服务拆分的天然边界，但不是 1:1。早期一个微服务可承载多个上下文（单体先跑起来），后期再拆。强行 1:1 会过度拆分。
memory_points:
  - 战略 = 限界上下文 + 上下文映射；战术 = 实体/值对象/聚合/领域服务/仓储
  - 四层架构：Interface → Application → Domain → Infrastructure，依赖方向朝内
  - 聚合根是唯一入口，仓储只返回聚合，贫血模型是反模式
  - 领域事件解耦上下文，本地事件用 Spring，跨进程用 MQ + 事务消息
  - DDD 不是银弹：CRUD 为主的管理系统用 DDD 是过度设计
---

# 【Java 后端架构师】领域驱动设计在 Java 架构中的落地

> 适用场景：JD 核心技术。订单、库存、价格、促销这些域的复杂度不在"增删改查"，在"业务规则爆炸"——满减叠加券、多档优惠、跨店凑单、退款逆向流程。DDD 解决的是"规则收敛"和"边界清晰"，不是堆概念。

## 一、概念层：战略设计与战术设计

**战略设计：划边界**（先有边界再写代码）

```
┌─────────────────────────────────────────────────────────────┐
│                     电商平台限界上下文地图                    │
├──────────────┬──────────────┬──────────────┬────────────────┤
│  订单上下文   │  库存上下文   │  支付上下文   │  促销上下文     │
│  Order       │  Inventory   │  Payment     │  Promotion     │
│              │              │              │                │
│  下单/取消    │  锁定/释放    │  支付/退款    │  计算/核销      │
│  履约/售后    │  预占/扣减    │  对账        │  叠加规则       │
└──────┬───────┴──────┬───────┴──────┬───────┴────────┬───────┘
       │              │              │                │
       │  ACL(防腐层)  │  发布领域事件  │  共享内核(User)  │
       └──────────────┴──────────────┴────────────────┘
```

**上下文映射的 5 种关系**（面试要能区分）：

| 关系 | 含义 | 例子 |
|------|------|------|
| **合作（Partnership）** | 两个团队同步演进 | 订单和促销共同设计优惠叠加规则 |
| **共享内核（Shared Kernel）** | 共享一部分领域模型 | User 实体被订单和物流共享 |
| **客户-供应商（Customer-Supplier）** | 下游提需求，上游优先级排期 | 订单（下游）依赖库存（上游） |
| **防腐层（ACL, Anti-Corruption Layer）** | 下游加翻译层隔离上游模型 | 订单调遗留 ERP，加 ACL 转换 |
| **开放主机服务（OHS）+ 发布语言** | 上游提供标准 API+协议 | 支付对外提供 OpenAPI |

**战术设计：填内容**（边界内的核心积木）

| 积木 | 定义 | 例子 |
|------|------|------|
| **实体（Entity）** | 有唯一标识，生命周期内属性可变 | Order（orderId 标识，状态变化） |
| **值对象（Value Object）** | 无标识，不可变，用属性判断相等 | Money（金额+币种）、Address |
| **聚合（Aggregate）** | 一组对象的集合，聚合根是唯一入口 | Order + List<OrderItem>，Order 是根 |
| **领域服务（Domain Service）** | 无状态，承载跨聚合逻辑 | PriceCalculator（算多档优惠） |
| **领域事件（Domain Event）** | 已发生的业务事实，用过去时命名 | OrderPaidEvent、InventoryLockedEvent |
| **仓储（Repository）** | 聚合的持久化抽象，像"聚合的集合" | OrderRepository.findById() |

## 二、机制层：四层架构与代码落地

**四层架构依赖方向**（面试必画，箭头朝内）：

```
┌─────────────────────────────────────────────────┐
│  Interface 层 (Controller/RPC)                   │  ← 接口适配：HTTP、Dubbo、gRPC
│  OrderController.createOrder()                   │
├─────────────────────────────────────────────────┤
│  Application 层 (ApplicationService)             │  ← 用例编排：事务边界、调用领域、发事件
│  OrderApplicationService.createOrder()           │     不含业务规则，只编排
├─────────────────────────────────────────────────┤
│  Domain 层 (Entity/Aggregate/DomainService)      │  ← 业务规则：纯 Java，不依赖框架
│  Order.cancel() / Order.pay()                    │     核心不变量在这里
├─────────────────────────────────────────────────┤
│  Infrastructure 层 (Repository实现/MQ/外部RPC)    │  ← 技术细节：MyBatis、RocketMQ、Redis
│  OrderRepositoryImpl / RocketMQEventPublisher    │
└─────────────────────────────────────────────────┘
         依赖反转：Domain 不依赖 Infrastructure
         Infrastructure 依赖 Domain 的接口
```

**充血模型代码示例**（订单聚合根）：

```java
// Domain 层：聚合根 Order（充血，业务规则封在对象内）
public class Order extends BaseAggregate {
    private OrderId id;
    private UserId userId;
    private List<OrderItem> items;          // 聚合内实体
    private Money totalAmount;              // 值对象
    private OrderStatus status;             // 枚举状态机
    private LocalDateTime createdAt;

    // 业务规则 1：计算金额（不变量：总金额 = 明细金额之和）
    public Money calculateTotal() {
        return items.stream()
            .map(OrderItem::getSubTotal)
            .reduce(Money.ZERO, Money::add);
    }

    // 业务规则 2：支付（状态机校验 + 金额校验 + 发事件）
    public OrderPaidEvent pay(PaymentMethod method) {
        // 不变量保护：只有待支付订单能支付
        if (status != OrderStatus.WAIT_PAY) {
            throw new OrderStateException(
                "订单状态[" + status + "]不允许支付，order_id=" + id);
        }
        // 不变量保护：支付金额必须等于订单金额
        if (method.getAmount().compareTo(totalAmount) != 0) {
            throw new AmountMismatchException(
                "支付金额" + method.getAmount() + "不等于订单金额" + totalAmount);
        }
        this.status = OrderStatus.PAID;
        // 发布领域事件（由 Application 层实际投递）
        return new OrderPaidEvent(id, userId, totalAmount, Instant.now());
    }

    // 业务规则 3：取消（含逆向规则）
    public OrderCancelledEvent cancel(CancelReason reason) {
        if (status == OrderStatus.SHIPPED || status == OrderStatus.COMPLETED) {
            throw new OrderStateException("已发货/已完成订单不可取消");
        }
        if (status == OrderStatus.PAID) {
            // 已支付需触发退款（事件驱动）
            this.status = OrderStatus.CANCELLING;
            return new OrderCancelledEvent(id, reason, true);
        }
        this.status = OrderStatus.CANCELLED;
        return new OrderCancelledEvent(id, reason, false);
    }
}

// 值对象 Money（不可变，用属性判等）
public final class Money {
    private final BigDecimal amount;
    private final String currency;
    public Money add(Money other) {
        if (!currency.equals(other.currency)) throw new IllegalArgumentException();
        return new Money(amount.add(other.amount), currency);
    }
}

// Application 层：编排用例（不含业务规则）
@Service
public class OrderApplicationService {
    @Transactional
    public void payOrder(Long orderId, PaymentMethod method) {
        Order order = orderRepo.findById(new OrderId(orderId));   // 仓储返回聚合
        OrderPaidEvent event = order.pay(method);                 // 聚合根执行规则
        orderRepo.save(order);                                    // 仓储持久化整个聚合
        eventPublisher.publish(event);                            // 发事件触发下游
    }
}
```

**贫血模型反模式对比**（面试官会问为什么充血好）：

```java
// 反模式：贫血 OrderDO（只有 getter/setter）
public class OrderDO {
    private Long id;
    private Integer status;
    // 一堆 getter/setter，没有行为
}
// 规则散落在 Service
public class OrderService {
    public void pay(Long orderId) {
        OrderDO order = orderDao.getById(orderId);
        if (order.getStatus() != 0) throw new RuntimeException();  // 魔法数字
        order.setStatus(1);                                        // 状态机散落
        orderDao.update(order);
    }
}
// 问题：规则改一处，代码改十处；新人不知道"1"是什么状态
```

## 三、实战层：领域事件落地

**领域事件的两段式发布**（保证业务和事件一致）：

```java
// 1. Application 层：业务事务内，把事件存到"事件表"（同事务）
@Transactional
public void payOrder(Long orderId, PaymentMethod method) {
    Order order = orderRepo.findById(new OrderId(orderId));
    OrderPaidEvent event = order.pay(method);
    orderRepo.save(order);
    // 关键：事件和业务在同一事务落库（本地消息表思想）
    outboxRepo.save(new OutboxMessage(event));
}

// 2. 定时任务 / CDC（Debezium 读 binlog）扫描 outbox 表，投递到 MQ
@Scheduled(fixedDelay = 500)
public void dispatchOutbox() {
    List<OutboxMessage> pending = outboxRepo.findPending(100);
    for (OutboxMessage msg : pending) {
        try {
            rocketMQTemplate.send("order-paid", msg.getPayload());
            msg.markSent();
        } catch (Exception e) {
            msg.incrRetry();
            if (msg.getRetryCount() > 5) msg.markFailed();   // 告警
        }
        outboxRepo.save(msg);
    }
}
```

**上下文映射的防腐层代码**（订单调遗留 ERP）：

```java
// ACL：把外部 ERP 的响应翻译成订单领域能理解的对象
public class ErpOrderAdapter {
    public OrderStatus queryErpStatus(String erpOrderCode) {
        ErpResponse resp = erpClient.query(erpOrderCode);   // 外部 DTO
        // 翻译：外部状态码 → 内部枚举
        return switch (resp.getStatusCode()) {
            case "S1" -> OrderStatus.CREATED;
            case "S2" -> OrderStatus.SHIPPED;
            case "S3" -> OrderStatus.COMPLETED;
            default -> throw new IllegalStateException("未知 ERP 状态: " + resp.getStatusCode());
        };
    }
}
```

## 四、底层本质：为什么 DDD 能扛复杂度

回到第一性：**业务规则的复杂度是客观的，DDD 解决的是"规则在代码里的分布"**。

- **不用 DDD（贫血）**：规则散落在 Service 的 N 个方法里，改一个规则要 grep 全代码库找 N 处。复杂度 = 规则数 × 散落点数，是乘法关系。
- **用 DDD（充血）**：规则收敛在聚合根的方法里（Order.cancel 封装取消规则），改一个规则只改一处。复杂度 = 规则数，是加法关系。

**聚合的一致性边界本质是"事务边界"**：一个聚合内的修改必须原子完成（同事务），所以聚合不能太大（跨网络的事务不存在）。这是为什么 Order 和 Inventory 是两个聚合而非一个——它们在不同服务，不可能同事务。

**防腐层的本质是"显式承担翻译成本"**：跨上下文协作必然有模型差异（订单的 User 和物流的 Consignee 是同一人的不同视角），ACL 把差异收在一个 Adapter 类里，避免污染订单领域的纯净。

## 五、AI 架构师加问：5 个

1. **用 AI 辅助 DDD 建模，AI 接管哪段？**
   AI 擅长从需求文档抽取候选实体、动词、状态，生成初版领域模型草案和限界上下文图。但聚合边界和不变量的确定要架构师结合业务事务边界判断——AI 容易把"语义相关"和"事务一致"混淆。

2. **AI Agent 调用多服务，怎么对应 DDD 的上下文映射？**
   Agent 编排本质是应用层，每调用一个工具（对应一个上下文的能力）就是跨上下文协作。Agent 用 function schema 做 ACL（把外部 API 翻译成 Agent 能理解的语义），工具的 result schema 是开放主机服务。

3. **AI 推理结果回写领域模型，怎么保证不变量？**
   AI 的输出不能直接持久化到聚合，必须经过聚合根的领域方法（如 Order.applyAiSuggestion()）做不变量校验。AI 建议"把已支付订单改回待支付"必须被聚合根拒绝，而不是 AI 绕过规则直改 DB。

4. **让 AI 识别代码里的贫血模型，怎么设计？**
   静态分析规则：实体类只有 getter/setter、Service 类里出现 if(status==X) 判断业务状态、DO 类被 Controller 直接返回（未转 DTO）。AI 训练样本：贫血代码 vs 充血代码对照集，识别"规则散落"模式。

5. **AI 生成领域事件，怎么保证不漏不变量？**
   AI 生成事件时必须绑定"触发事件的领域方法"——Order.pay() 内部发 OrderPaidEvent，不能在 Application 层手动发。Code Review 检查点：所有领域事件必须在聚合根方法内 return，不能在外部 new。

## 六、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"战略划界、战术填肉、四层依赖朝内、充血守不变量、事件解耦上下文"**。

- **战略**：限界上下文划边界，上下文映射定协作（ACL/OHS/共享内核）
- **战术**：实体/值对象/聚合/领域服务/仓储/领域事件
- **四层**：Interface → Application → Domain → Infrastructure，依赖反转
- **充血**：业务规则封在聚合根方法，贫血是反模式
- **事件**：Outbox 模式保证业务和事件一致，MQ 跨进程

### 面试现场 60 秒回答

> DDD 落地分战略和战术。战略是划限界上下文——订单、库存、支付各有边界，跨上下文用 ACL 防腐或领域事件解耦。战术是填内容——用聚合根封装不变量，Order.pay() 方法里校验状态机和金额，规则收敛在一处；值对象用 Money 这种不可变类型避免金额被乱改。架构上用四层：Interface 适配协议、Application 编排用例、Domain 放业务规则、Infrastructure 落地技术。关键原则是依赖朝内——Domain 不依赖 MyBatis 或 MQ，仓储接口定义在 Domain，实现在 Infrastructure。领域事件用 Outbox 模式，业务和事件同事务落库，异步投递到 MQ 保证最终一致。最容易翻车的是贫血模型——规则散落在 Service，一改改十处。

## 七、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 你为什么选 DDD 而不是继续用三层架构？ | 用代码规模和规则复杂度说话：当 Service 方法超过 500 行、状态判断散落超 20 处、新需求改动文件数 > 5，三层架构的维护成本爆炸。用 domain_change_lead_time（领域变更交付周期）和 rule_scatter_count（规则散落点数）量化 |
| 证据追问 | 你怎么证明 DDD 落地后真的改善？ | 对比贫血 vs 充血的 rule_scatter_count（单条规则涉及的代码处数）、bug_escape_rate（规则相关 bug 漏测率）、onboarding_time（新人上手时长）。比如取消规则散落从 8 处降到 1 处 |
| 边界追问 | DDD 能解决所有架构问题吗？ | 不能。解决不了跨服务一致性（要靠 Saga/TCC）、解决不了性能（聚合重建慢要靠 CQRS 读写分离）、解决不了报表（要靠数仓）。CRUD 为主的系统用 DDD 是过度设计 |
| 反例追问 | 什么场景不该用 DDD？ | 简单 CRUD（用户管理、配置后台）、技术中间件（网关、限流器）、生命周期短的项目（活动页）。这些场景的复杂度不在业务规则，强行 DDD 增加认知负担 |
| 风险追问 | DDD 落地最大的坑是什么？ | 主动点出：聚合粒度失控（一个聚合关联 10 张表，加载慢、事务长）、过度设计（简单 CRUD 套 DDD 四层）、领域事件丢失（没用 Outbox 导致业务成功事件丢失）、贫血实体（名义 DDD 实际还是 setter 改数据） |
| 验证追问 | 怎么证明领域模型设计对了？ | 代码层面：聚合根方法覆盖率 > 90%、贫血 DO 类比例 < 10%；业务层面：rule_scatter_count 下降、需求交付周期缩短；组织层面：产品、研发、测试用同一套术语（统一语言落地） |
| 沉淀追问 | 让团队持续用 DDD，沉淀什么？ | 领域建模 SOP（事件风暴工作坊）、聚合设计 checklist（事务边界、聚合大小）、Code Review 模板（检查贫血、检查领域逻辑泄露到 Infrastructure）、限界上下文地图维护规范 |

### 现场对话示例

**面试官**：聚合粒度怎么定？Order 和 OrderItem 是一个聚合还是两个？

**候选人**：按事务一致性边界定。OrderItem 的修改（加明细、改数量）必须和 Order 在同一事务，否则订单金额和明细就不一致了——所以 OrderItem 是 Order 聚合内的实体，Order 是聚合根，外部不能直接持有 OrderItem 引用，必须通过 Order.addItem() 修改。但 Order 和 Inventory 是两个聚合，因为它们在不同服务，不可能同一事务——锁库存失败要靠 Saga 补偿已创建的订单。一个判断标准：如果 A 和 B 的修改必须原子完成，它们就在同一聚合；如果只是业务关联但允许最终一致，就是两个聚合。京东订单域里，Order + OrderItem + OrderPayment 是一个聚合（同库同事务），但 Order 和 Logistics（物流）是两个聚合（跨服务）。

**面试官**：领域事件丢了怎么办？

**候选人**：用 Outbox 模式兜底。Order.pay() 的业务事务里，同时往 outbox 表插一条 OrderPaidEvent 记录，两者同库同事务保证原子。一个独立的定时任务（或用 Debezium 监听 binlog）扫描 outbox 表，把未发送的事件投递到 RocketMQ，投递成功后标记为 SENT。投递失败会重试，超过阈值告警。消费方做幂等（event_id 去重）。这样即使业务成功但 MQ 暂时不可用，事件也不会丢——它在 outbox 表里，MQ 恢复后会补发。关键是业务和事件必须在同一本地事务，不能先做业务再发事件（中间崩了就丢）。

**面试官**：贫血模型有什么具体危害？举个例子。

**候选人**：举取消订单的例子。贫血模式下，OrderDO 只有 setStatus()，取消逻辑散落在 OrderCancelService、OrderRefundService、OrderNotifyService 三处，每处都判断 status == PAID。一旦业务规则变化（比如"已发货但未签收可以拦截取消"），要改三处，漏一处就出 bug。充血模式下，Order.cancel() 是唯一入口，规则变化只改这一处，编译器还能帮你保证调用方都走这个方法。我们落地 DDD 后，取消规则的 rule_scatter_count 从 8 降到 1，相关 bug 每月从 5 个降到 0。

## 常见考点

1. **聚合和实体的区别？**——实体是"有唯一标识的对象"，聚合是"一组对象的一致性边界"，聚合根是"聚合的入口实体"。OrderItem 是实体但不是聚合根（外部不能直接访问 OrderItem，必须通过 Order）。
2. **值对象怎么持久化？**——可以做成单独表（OrderItem 表），也可以序列化成 JSON 存在聚合根表的一个字段（Address 存成 JSON）。JPA 用 @Embeddable，MyBatis 用 TypeHandler。
3. **领域服务和应用服务的区别？**——领域服务承载业务规则（无状态，如 PriceCalculator），应用服务编排用例（有事务边界，如 OrderApplicationService）。应用服务不含业务规则，只负责调聚合、调仓储、发事件。
4. **CQRS 和 DDD 什么关系？**——CQRS（命令查询职责分离）是 DDD 的扩展。写侧用聚合保证一致性，读侧直接查 DB 或 ES（不走聚合重建）。适合读多写少、读写模型差异大的场景（订单列表 vs 订单详情）。

## 结构化回答

**30 秒电梯演讲：** DDD 的落地本质是用统一语言 + 限界上下文 + 聚合把业务复杂度圈在可控边界内。技术实现上靠四层架构（Interface/Application/Domain/Infrastructure）把领域逻辑从 ORM、RPC、MQ 里隔离出来，让 Order、Inventory、Payment 这些核心对象的行为由领域规则驱动，而不是由数据库表结构驱动

**展开框架：**
1. **战略设计** — 限界上下文划边界，上下文映射定协作（合作/共享内核/客户-供应商/防腐层）
2. **战术设计** — 实体（有唯一标识）、值对象（无标识不可变）、聚合（一致性边界）、领域服务（无状态跨聚合逻辑）
3. **四层架构** — Interface（RPC/HTTP）→ Application（用例编排/事务）→ Domain（业务规则）→ Infrastructure（DB/MQ/……

**收尾：** 以上是我的整体思路。您想继续深入聊——聚合粒度怎么定？


## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：领域驱动设计在 Java 架构中的落地 | "这题一句话：DDD 的落地本质是用统一语言 + 限界上下文 + 聚合把业务复杂度圈在可控边界内。" | 开场钩子 |
| 0:15 | 战略设计示意/对比图 | "限界上下文划边界，上下文映射定协作（合作/共享内核/客户-供应商/防腐层）" | 战略设计要点 |
| 0:40 | 战术设计示意/对比图 | "实体（有唯一标识）、值对象（无标识不可变）、聚合（一致性边界）、领域服务（无状态跨聚合逻辑）" | 战术设计要点 |
| 1:25 | 总结卡 | "记住：战略 = 限界上下文 + 上。下期见。" | 收尾 |
