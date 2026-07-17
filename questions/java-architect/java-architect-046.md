---
id: java-architect-046
difficulty: L2
category: java-architect
subcategory: 中台架构
tags:
- Java 架构师
- DDD
- 聚合
- 仓储
feynman:
  essence: 聚合是"一致性边界"——一个事务里只能改一个聚合，聚合根是唯一对外入口。仓储是"聚合的集合抽象"——隐藏 SQL/缓存/分库分表，只暴露 findById/save。应用服务是"用例编排者"——开事务、调聚合、存仓储、发事件，但不含业务规则。三者边界清晰的核心是：业务规则在聚合、技术细节在仓储、流程编排在应用服务。
  analogy: 像餐厅后厨。聚合根是厨师（掌握怎么做菜的规则，配料的克数、火候由他说了算），仓储是库管员（厨师要鸡蛋就给鸡蛋，不管鸡蛋是从冰箱还是市场来的），应用服务是服务员（下单给厨师、上菜给客人、结账，但不动手做菜）。客人不能直接进后厨拿菜——必须通过服务员下单。
  first_principle: 为什么聚合只能有一个入口？因为不变量（如"订单金额=明细之和"）需要被保护。如果外部能直接 OrderItem.setQuantity()，就可能改了数量但没同步金额，不变量被破坏。聚合根的 addItem() 方法保证"改数量的同时重算金额"，这是把不变量保护集中到一处。
  key_points:
  - 聚合根三原则：唯一入口、外部只持有根引用、同事务只改一个聚合
  - 仓储的契约：save(aggregate) 持久化整个聚合、findById 返回完整聚合、不暴露 DAO
  - 应用服务薄、领域服务厚：应用服务只编排（开事务/调聚合/发事件），业务规则在聚合或领域服务
  - 跨聚合操作用领域事件最终一致，不用跨聚合事务
  - 仓储 vs DAO：DAO 是表映射（OrderDao），仓储是聚合映射（OrderRepository 返回 Order 不是 OrderDO）
first_principle:
  problem: 聚合内的对象怎么协同修改才能保证不变量？跨聚合的协作怎么避免分布式事务？
  axioms:
  - 不变量必须被原子保护——同事务内要么全改要么全不改
  - 跨聚合（跨服务）不可能同事务，必须用最终一致
  - 持久化细节（SQL/缓存/分表）是变化点，不能污染领域模型
  rebuild: 聚合根封装不变量，所有修改走聚合根方法；仓储抽象掉持久化，领域只面向"聚合的集合"；应用服务开事务边界，一个事务只操作一个聚合（保证不变量原子性），跨聚合通过领域事件异步解耦（最终一致）。DAO 操作表，仓储操作聚合——中间用 Assembler 做对象转换。
follow_up:
  - 一个事务改两个聚合行不行？——理论上不行（破坏聚合边界），但实际"同库的强相关聚合"可以放宽（如 Order 和 OrderPayment 同库，一些团队允许同事务）。跨服务必须分开，靠 Saga。
  - 仓储怎么处理 N+1 查询？——用 fetch join（JPA @EntityGraph）或 MyBatis resultMap 联表，一次查询加载整个聚合。但聚合太大会有性能问题——所以聚合要小。
  - 应用服务能调用别的上下文吗？——可以，但要经过 ACL 或 RPC 接口，不能直接调对方的仓储。调用结果转成本上下文的值对象。
  - 仓储的 save 怎么实现"只更新变更字段"？——JPA 脏检查自动处理；MyBatis 要手写动态 SQL（<set><if>）。或用乐观锁版本号，save 时带上 version。
  - 领域服务和静态方法的区别？——领域服务是无状态 Bean（可注入其他服务），静态方法适合纯计算（如 Money.add）。跨聚合的编排用领域服务，纯函数用静态方法。
memory_points:
  - 聚合根三原则：唯一入口、只持根引用、同事务单聚合
  - 仓储 = 聚合的集合抽象，save/findById 不暴露 SQL
  - 应用服务 = 用例编排（事务/聚合/仓储/事件），不含业务规则
  - DAO vs Repository：前者对表，后者对聚合，中间 Assembler 转换
  - 跨聚合用领域事件最终一致，不用跨聚合事务
---

# 【Java 后端架构师】DDD 聚合、仓储与应用服务边界

> 适用场景：JD 核心技术。订单域下单时，要改订单、改库存、发优惠券、记积分——这些操作的边界怎么划？放在一个事务里太大，放在一个 Service 里太乱。聚合/仓储/应用服务的边界，决定了一个需求改 3 处还是改 30 处。

## 一、概念层：三者的职责切片

**职责分配表**（面试必答）：

| 组件 | 职责 | 不该做什么 | 代码示例 |
|------|------|-----------|---------|
| **聚合根** | 保护不变量、执行业务规则 | 不做持久化、不发 MQ | `Order.cancel()` 校验状态 + 改状态 |
| **仓储** | 聚合的持久化、重建 | 不含业务规则、不返回 DTO | `orderRepo.save(order)` |
| **应用服务** | 用例编排、事务边界 | 不含业务规则、不写 SQL | `@Transactional payOrder()` |
| **领域服务** | 跨聚合的无状态业务逻辑 | 不持久化 | `PriceCalculator.calc(items, promos)` |
| **DAO/Mapper** | 单表 CRUD | 不返回聚合、不做业务判断 | `OrderMapper.selectById()` |

**关键边界**（红线）：

```
外部请求
  │
  ▼
应用服务（@Transactional）─────── 不含业务规则，只编排
  │
  ├──► 仓储.findById() ──► 返回聚合（不是 DO）
  │
  ├──► 聚合.业务方法() ──► 业务规则在这里执行
  │
  ├──► 仓储.save(聚合) ──► 持久化整个聚合
  │
  └──► 事件发布 ──► 跨聚合最终一致
```

## 二、机制层：聚合根代码实现

**聚合根的三原则落地**：

```java
// ============ 1. 聚合根 Order ============
@Entity
@Table(name = "t_order")
public class Order {
    @Id
    private Long id;
    private Long userId;
    private OrderStatus status;
    private BigDecimal totalAmount;

    // 聚合内实体：OrderItem（外部不能直接持有 OrderItem 引用）
    @OneToMany(cascade = CascadeType.ALL, orphanRemoval = true)
    @JoinColumn(name = "order_id")
    private List<OrderItem> items = new ArrayList<>();

    // 原则 1：唯一入口——外部通过 addItem 修改明细，不能直接 items.add()
    public void addItem(Long skuId, int quantity, BigDecimal price) {
        if (status != OrderStatus.DRAFT) {
            throw new OrderStateException("非草稿状态不能加明细");
        }
        if (quantity <= 0 || quantity > 99) {
            throw new IllegalArgumentException("数量非法: " + quantity);
        }
        // 不变量保护：同 SKU 合并数量
        items.stream()
            .filter(i -> i.getSkuId().equals(skuId))
            .findFirst()
            .ifPresentOrElse(
                i -> i.increaseQuantity(quantity),
                () -> items.add(new OrderItem(skuId, quantity, price))
            );
        recalculateTotal();   // 不变量：明细变化必须重算总额
    }

    // 原则 2：不变量保护——总额 = 明细之和
    private void recalculateTotal() {
        this.totalAmount = items.stream()
            .map(i -> i.getPrice().multiply(BigDecimal.valueOf(i.getQuantity())))
            .reduce(BigDecimal.ZERO, BigDecimal::add);
    }

    // 原则 3：状态机——状态变更校验
    public void confirm() {
        if (status != OrderStatus.DRAFT) {
            throw new OrderStateException("当前状态[" + status + "]不能确认");
        }
        if (items.isEmpty()) {
            throw new IllegalStateException("空订单不能确认");
        }
        this.status = OrderStatus.CONFIRMED;
    }
}

// ============ 2. 聚合内实体 OrderItem（无外部入口）============
@Entity
@Table(name = "t_order_item")
public class OrderItem {
    @Id
    private Long id;
    private Long skuId;
    private Integer quantity;
    private BigDecimal price;

    // 包级可见——外部包不能直接调，只有 Order 能调
    void increaseQuantity(int qty) {
        if (this.quantity + qty > 99) {
            throw new IllegalArgumentException("单品数量不能超过99");
        }
        this.quantity += qty;
    }
}
```

## 三、机制层：仓储的抽象与实现

**仓储接口定义在领域层，实现在基础设施层**（依赖反转）：

```java
// Domain 层：仓储接口（领域定义契约）
public interface OrderRepository {
    Order findById(OrderId id);
    Order findByOrderNo(String orderNo);
    void save(Order order);
    void remove(Order order);
}

// Infrastructure 层：JPA 实现
@Repository
public class JpaOrderRepository implements OrderRepository {
    @Autowired
    private OrderDao orderDao;          // DAO 操作表
    @Autowired
    private OrderItemDao orderItemDao;
    @Autowired
    private OrderAssembler assembler;   // DO ↔ 聚合 转换器

    @Override
    public Order findById(OrderId id) {
        OrderDO orderDO = orderDao.findByIdWithItems(id.getValue())   // fetch join 避免 N+1
            .orElseThrow(() -> new OrderNotFoundException(id));
        return assembler.toAggregate(orderDO);    // DO 转 聚合
    }

    @Override
    @Transactional
    public void save(Order order) {
        OrderDO orderDO = assembler.toDO(order);  // 聚合 转 DO
        orderDao.save(orderDO);                    // JPA cascade 自动存 items
        // 关键：仓储负责整个聚合的持久化（Order + Items 原子保存）
    }
}

// Assembler：DO 和聚合的转换器（隔离持久化形态和领域形态）
@Component
public class OrderAssembler {
    public Order toAggregate(OrderDO DO) {
        Order order = new Order();
        // 反射或拷贝基本字段，再把 OrderItemDO 列表转成聚合内实体
        // 这一层把"表结构"和"领域模型"解耦
        return order;
    }
    public OrderDO toDO(Order order) { /* 反向 */ }
}
```

**仓储 vs DAO 的区别**（面试必答）：

| 维度 | DAO | Repository |
|------|-----|-----------|
| 操作对象 | 单表（t_order） | 聚合（Order + OrderItem） |
| 返回类型 | DO（OrderDO） | 聚合（Order） |
| 抽象层级 | 数据访问 | 领域对象的集合 |
| 业务语义 | `selectById` | `findById`（像操作内存集合） |
| 适用场景 | 简单 CRUD | DDD 聚合持久化 |

## 四、机制层：应用服务与领域服务的边界

**应用服务（薄）——只编排，不含规则**：

```java
@Service
public class OrderApplicationService {

    @Autowired private OrderRepository orderRepo;
    @Autowired private InventoryClient inventoryClient;
    @Autowired private DomainEventPublisher eventPublisher;

    // 用例：下单
    @Transactional
    public OrderResult createOrder(CreateOrderCmd cmd) {
        // 1. 仓储查询（返回聚合，不是 DO）
        // 2. 工厂创建聚合
        Order order = orderFactory.create(cmd.getUserId(), cmd.getItems());

        // 3. 调聚合的业务方法（规则在聚合内）
        order.confirm();

        // 4. 调用其他上下文（经过 ACL）
        inventoryClient.lock(order.getItems());

        // 5. 仓储持久化整个聚合
        orderRepo.save(order);

        // 6. 发布领域事件（Outbox 同事务）
        eventPublisher.publish(new OrderCreatedEvent(order.getId()));

        return OrderResult.of(order);
    }

    // 用例：取消（含跨聚合协调）
    @Transactional
    public void cancelOrder(Long orderId, CancelReason reason) {
        Order order = orderRepo.findById(new OrderId(orderId));
        // 业务规则在聚合内
        OrderCancelledEvent event = order.cancel(reason);
        orderRepo.save(order);
        // 跨聚合通过事件（库存释放、退款由各自上下文消费事件）
        eventPublisher.publish(event);
    }
}
```

**领域服务（厚）——跨聚合的业务逻辑**：

```java
// 领域服务：跨聚合的价格计算（订单聚合 + 促销聚合）
@Service
public class PriceCalculator {

    /**
     * 计算订单最终价格（跨订单和促销两个聚合）
     * 为什么不放 Order？——因为依赖 Promotion 聚合，Order 不应依赖 Promotion
     */
    public Money calculate(Order order, List<Promotion> promotions) {
        Money baseAmount = order.getTotalAmount();

        // 规则：按优先级应用促销（满减 > 券 > 折扣）
        Money afterPromotion = baseAmount;
        for (Promotion promo : promotions.stream()
                .sorted(Comparator.comparing(Promotion::getPriority).reversed())
                .toList()) {
            afterPromotion = promo.apply(afterPromotion);
        }
        return afterPromotion;
    }
}
```

**应用服务调用领域服务的边界**：

```java
// 应用服务编排领域服务
@Transactional
public void applyPromotion(Long orderId, Long promotionId) {
    Order order = orderRepo.findById(new OrderId(orderId));
    Promotion promo = promoRepo.findById(promotionId);

    // 业务规则委托给领域服务（因为跨聚合）
    Money finalPrice = priceCalculator.calculate(order, promo);

    // 把结果写回聚合（聚合内的方法）
    order.updateFinalPrice(finalPrice);
    orderRepo.save(order);
}
```

## 五、底层本质：为什么要切这三层边界

回到第一性：**这三层边界切的是"变化速率不同的东西"**。

- **业务规则变化最快**（促销规则、取消策略三天两头改）→ 放在聚合根，独立单元测试。
- **用例编排中等变化**（下单流程偶尔加步骤）→ 放在应用服务，改一处影响一个用例。
- **技术细节变化最慢但有迁移成本**（从 MyBatis 换 JPA、从 MySQL 换 TiDB）→ 放在仓储实现，换实现不改领域。

如果混在一起（贫血的 OrderService 同时含规则、编排、SQL），任何一层变化都要动这个"上帝类"，牵一发动全身。分开后，改促销规则只动 PriceCalculator，换数据库只动 Repository 实现，互不影响。

**聚合边界的本质是"事务成本"**：一个聚合 = 一个事务 = 一个一致性单元。跨聚合协作的事务成本（分布式事务）极高，所以用最终一致（事件）换取可承受的成本。

## 六、AI 架构师加问：5 个

1. **用 AI 生成聚合根代码，怎么校验不变量？**
   AI 生成 Order 类后，自动生成"破坏不变量"的测试用例（addItem 不重算总额、状态机跳转）。用 PIT 突变测试验证：把 recalculateTotal() 删掉，测试必须失败。AI 容易漏掉不变量重算，靠变异测试兜底。

2. **AI Agent 调用应用服务，怎么保证用例边界？**
   Agent 的每次工具调用对应一个应用服务方法（createOrder/cancelOrder），不直接调聚合或仓储。Agent 的 system prompt 明确"只能调 ApplicationService 的 public 方法"，类似 CQRS 的 command 侧。

3. **让 AI 识别"应用服务泄露业务规则"，怎么设计？**
   静态分析：ApplicationService 类里出现 `if (order.getStatus() == X)` 的业务状态判断、出现计算金额的逻辑、出现跨聚合的数据校验。这些应该下沉到聚合或领域服务。

4. **AI 推理结果通过仓储写聚合，怎么防 AI 绕过规则？**
   仓储的 save 方法断言"聚合必须通过业务方法修改过"——用 dirty flag 标记，只有调过业务方法才能 save。AI 直改字段没触发业务方法，save 时被拒绝。

5. **AI 辅助聚合重构（拆分大聚合），怎么评估风险？**
   AI 分析聚合的加载耗时（findById 的 P99）、事务执行时长、并发冲突率。如果聚合加载 > 50ms、事务 > 200ms、锁冲突频繁，建议拆分。拆分后用 Outbox 事件保证两部分最终一致。

## 七、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"聚合守不变量、仓储藏持久化、应用服务做编排"**。

- **聚合根**：唯一入口，外部只持根引用，业务规则在方法里，同事务单聚合
- **仓储**：聚合的集合抽象，findById/save，不暴露 SQL/DAO，用 Assembler 转 DO
- **应用服务**：薄编排（事务/聚合/仓储/事件），不含业务规则
- **领域服务**：跨聚合的无状态业务逻辑（价格计算）
- **边界红线**：应用服务不写 SQL，仓储不做业务判断，聚合不持久化

### 面试现场 60 秒回答

> 聚合、仓储、应用服务三者职责严格分开。聚合根封装不变量——Order.addItem() 改数量时同步重算总额，外部不能直接操作 OrderItem，必须通过聚合根方法。仓储是聚合的持久化抽象——findById 返回完整聚合（Order+Items），save 持久化整个聚合，底层用 DAO+Assembler 做 DO 和聚合转换，领域层只见接口不见 SQL。应用服务做用例编排——createOrder 方法里开事务、调工厂创建聚合、调聚合的 confirm() 方法执行规则、调仓储 save、发事件——但它不含任何业务规则，规则都在聚合或领域服务里。跨聚合操作（订单+促销算价）放领域服务，跨上下文操作走事件最终一致。最容易翻车的是应用服务变厚——把业务规则写在 ApplicationService 里，又回到贫血模型。

## 八、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不让 Service 直接调 DAO，非要套仓储？ | 用持久化迁移成本说话：从 MyBatis 换 JPA，仓储接口不变，只换实现；没有仓储的话所有 Service 都要改。用 aggregate_load_p99（聚合加载耗时）、persistence_migration_cost（持久化迁移工作量）量化 |
| 证据追问 | 你怎么证明边界划对了？ | code review 统计 rule_leak_count（规则泄露到应用服务的处数，应=0）、n_plus_one_count（N+1 查询数，靠 fetch join 降为 0）、aggregate_transaction_p99（聚合事务耗时）|
| 边界追问 | 聚合大了怎么办？ | 拆分。Order 含 ShippingInfo 和 PaymentInfo，如果加载慢，拆成 Order 主聚合 + Shipping 子聚合 + Payment 子聚合，通过 orderId 关联，用事件保证一致。拆分标准：加载 P99 > 50ms 或事务 > 200ms |
| 反例追问 | 什么场景不该用仓储模式？ | 纯报表查询（不走聚合重建，直接 SQL 查）、批量 ETL（千万级数据加载）、简单配置 CRUD（仓储增加抽象成本无收益）。这些用 DAO 直接查更高效 |
| 风险追问 | 应用服务最大的坑是什么？ | 主动点出：应用服务变厚（业务规则泄露）、跨聚合事务（一个事务改 Order 和 Inventory，破坏聚合边界）、仓储返回 DO（绕过 Assembler，领域层污染） |
| 验证追问 | 怎么证明聚合的不变量没被绕过？ | 单元测试：addItem 后断言 totalAmount = sum(items.subTotal)；状态机测试：所有非法跳转必须抛 OrderStateException；字节码扫描：检查是否有代码绕过聚合根直接 new OrderItem() 并修改 |
| 沉淀追问 | 团队落地 DDD，沉淀什么？ | 聚合设计 checklist（事务边界/聚合大小/不变量列表）、Assembler 模板（DO↔聚合）、Code Review 规则（应用服务禁出现业务状态判断）、聚合单元测试模板（覆盖所有不变量） |

### 现场对话示例

**面试官**：一个事务里改 Order 和 OrderPayment，算不算破坏聚合边界？

**候选人**：看 Order 和 OrderPayment 是不是一个聚合。如果 OrderPayment 是 Order 聚合内的实体（@OneToMany cascade=ALL），一个事务改两者是正常的——聚合内的修改本来就是原子的。如果 OrderPayment 是独立聚合（有自己的仓储 OrderPaymentRepository），一个事务改两个聚合就破坏边界了——应该用领域事件，Order.pay() 发 OrderPaidEvent，Payment 上下文消费事件创建 OrderPayment。实际项目中，如果 Order 和 OrderPayment 在同一个库且强相关，很多团队会放宽——把它们设计成一个聚合，OrderPayment 作为聚合内实体，一个事务改是允许的。判断标准是：它们的不变量是否需要原子保护。如果"Order 支付后必须有对应的 OrderPayment"是强不变量，就放一个聚合；如果允许短暂不一致（支付记录延迟生成可接受），就拆两个聚合用事件。

**面试官**：仓储的 findById 返回聚合，如果聚合很大（10 个 OrderItem + 关联地址 + 物流信息），加载性能差怎么办？

**候选人**：三种解法。第一，fetch join 一次性加载——JPA 用 @EntityGraph 或 JOIN FETCH，MyBatis 用 resultMap 联表，一次 SQL 把聚合内所有表查出来，避免 N+1。第二，延迟加载——JPA 关联字段用 FetchType.LAZY，用到时才查，但容易触发 LazyInitializationException，要配合 @Transactional。第三，也是我推荐的——重构聚合。如果聚合大到加载慢（P99 > 50ms），说明聚合边界划大了，应该拆。Order 的物流信息（收货地址、物流单号）拆成独立的 Shipping 聚合，通过 orderId 关联，详情页才加载，列表页不需要。聚合应该小而精，只包含强一致性要求的对象。京东订单域的实践：Order 聚合只含 OrderItem 和金额字段，地址、物流、发票都是独立聚合，通过 orderId 关联。

**面试官**：应用服务里能调 RPC 吗？比如下单时同步调库存服务锁库存。

**候选人**：可以，但要区分场景。如果是强依赖（锁库存失败就要回滚订单），应用服务里同步调 RPC，RPC 失败抛异常，事务回滚——这是合理的。但要注意 RPC 必须在事务内，超时设置要短（< 200ms），避免事务长时间占用连接。如果是弱依赖（加积分、发通知），不要在事务内同步调，改成发事件异步处理。判断标准：这个下游失败会不会导致本事务回滚？会就同步调，不会就发事件。下单锁库存是强依赖，同步调；下单后发积分是弱依赖，发事件。还有一种折中——事务内写 Outbox 表，事务提交后异步调 RPC（库存锁定失败再发补偿事件回滚订单）。这避免了长事务，但增加了最终一致的复杂度。

## 常见考点

1. **聚合根和聚合的区别？**——聚合是一组对象的集合（Order+OrderItem），聚合根是聚合的入口实体（Order）。外部只持有聚合根引用，不能直接拿 OrderItem。
2. **仓储为什么要定义接口在领域层？**——依赖反转。领域层不依赖具体的持久化技术（JPA/MyBatis），只依赖仓储接口。实现在基础设施层，换持久化技术只换实现不改领域。
3. **领域事件在应用服务发还是聚合根发？**——聚合根 return 事件（不直接 publish，保持纯净），应用服务接收后调 eventPublisher.publish()。这样聚合根不依赖事件发布器，保持可测试性。
4. **一个用例跨多个聚合怎么办？**——用 Saga 或领域事件。应用服务操作主聚合（Order），主聚合发事件（OrderCreated），其他聚合（Inventory）消费事件各自更新。不能用一个事务跨聚合。

## 结构化回答

**30 秒电梯演讲：** 聚合是一致性边界——一个事务里只能改一个聚合，聚合根是唯一对外入口。仓储是聚合的集合抽象——隐藏 SQL/缓存/分库分表，只暴露 findById/save。应用服务是用例编排者——开事务、调聚合、存仓储、发事件，但不含业务规则。三者边界清晰的核心是：业务规则在聚合、技术细节在仓储、流程编排在应用服务

**展开框架：**
1. **聚合根三原则** — 唯一入口、外部只持有根引用、同事务只改一个聚合
2. **仓储的契约** — save(aggregate) 持久化整个聚合、findById 返回完整聚合、不暴露 DAO
3. **应用服务薄、领域服务厚** — 应用服务只编排（开事务/调聚合/发事件），业务规则在聚合或领域服务

**收尾：** 以上是我的整体思路。您想继续深入聊——一个事务改两个聚合行不行？


## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：DDD 聚合、仓储与应用服务边界 | "这题一句话：聚合是一致性边界——一个事务里只能改一个聚合，聚合根是唯一对外入口。" | 开场钩子 |
| 0:15 | 聚合根三原则示意/对比图 | "唯一入口、外部只持有根引用、同事务只改一个聚合" | 聚合根三原则要点 |
| 0:40 | 仓储的契约示意/对比图 | "save(aggregate) 持久化整个聚合、findById 返回完整聚合、不暴露 DAO" | 仓储的契约要点 |
| 1:25 | 总结卡 | "记住：聚合根三原则。下期见。" | 收尾 |
