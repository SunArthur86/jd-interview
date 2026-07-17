---
id: java-architect-105
difficulty: L4
category: java-architect
subcategory: Java 集合
tags:
- Java 架构师
- Record Pattern
- 模式匹配
- 可维护性
feynman:
  essence: Record Pattern（JEP 440/441，JDK 21 GA）是"用数据形状做控制流"——把 instanceof + 强转 + 字段提取三步合一，让代数数据类型（ADT）在 Java 里第一次可表达。它的工程价值不是"少写两行代码"，而是把"类型分支"从运行时 instanceof（易 NPE、易漏分支）变成编译期穷尽检查（sealed + switch pattern = 穷尽性校验）。
  analogy: 像快递分拣：老 instanceof 是"先看是不是包裹，再拆开看里面是什么"（两步、易拆错）；Record Pattern 是"按盒子形状分拣"——长方形盒子里 3 件就直接取 3 件，圆形盒子里 1 件就直接取 1 件，分拣机（编译器）自动校验所有形状都覆盖了。
  first_principle: 面向对象的"行为多态"（继承 + 重写）解决"同一行为不同实现"，但"数据多态"（同一组数据不同形状）长期靠 instanceof + 强转，编译期不校验穷尽性。Record Pattern + sealed 把 ML/Haskell 的 ADT 引入 Java，让"分支穷尽性"从运行时 NPE 变成编译期错误。
  key_points:
  - Record Pattern（JDK 21 GA）：instanceof 和 switch 都支持
  - 解构：record 的组件类型 + 名称自动提取
  - 嵌套：Record Pattern 可嵌套（Point(Point(int x,_), _)）
  - sealed + switch pattern = 编译期穷尽性校验
  - 工程价值：替代 visitor 模式、简化状态机、消除 instanceof 链
first_principle:
  problem: 怎么让"按数据形状分支"的代码编译期保证穷尽、类型安全、可读，而不是 instanceof + 强转的运行时炸弹？
  axioms:
  - 数据的形状（类型 + 组件）应该和分支控制流统一
  - 类型系统应该能在编译期校验"所有形状都被覆盖"
  - 解构提取应该是声明式的，不是命令式的强转
  rebuild: 用 record 定义不可变数据载体，用 sealed 限定子类型集合（封闭代数），用 Record Pattern 在 instanceof 和 switch 里解构（提取组件）。三者组合：sealed 让编译器知道所有可能形状，switch pattern 强制覆盖所有形状（不覆盖编译错），Record Pattern 自动提取组件（无强转）。这就是 ADT 的 Java 表达，编译期穷尽性是核心收益。
follow_up:
  - Record Pattern 和访问者模式（Visitor）什么关系？——Record Pattern 让 Visitor 在大多数场景过时。Visitor 是为"按类型分发"造的迂回方案，Record Pattern 直接 switch 类型 + 解构，更直观
  - sealed 必须和 record 一起用吗？——不必须，但推荐。sealed class 也可以是普通类或接口，record 是隐式 final 的，配合 sealed 接口实现 ADT
  - Record Pattern 性能怎么样？——编译器优化后和 instanceof + 强转等价，无额外开销。switch pattern 编译成 tableswitch/lookupswitch，性能更好
  - 解构能用在普通 class 上吗？——JDK 21 只支持 record 的解构。普通 class 要等未来 JEP（deconstruction patterns for classes）
  - 和 Kotlin 的 sealed class / when 对比？——语义相近，Java 21 终于追上了。Kotlin 的 when 强制穷尽性更早，Java 21 通过 sealed + switch 实现等价能力
memory_points:
  - Record Pattern（JDK 21 GA）：instanceof + switch 都支持
  - 三件套：record（数据载体）+ sealed（封闭类型）+ pattern switch（穷尽性）
  - 嵌套解构：Point(Point(int x,_), _) 嵌套提取
  - 穷尽性校验：sealed + switch 漏 case 编译错
  - 替代 Visitor 模式：直接 switch 类型 + 解构
  - 工程价值：消除 instanceof 链、提升可读性、编译期类型安全
---

# 【Java 后端架构师】Java 21 Record Pattern 与模式匹配的工程价值

> 适用场景：JD 核心技术。订单领域有 Payment/Coupon/Refund 三种事件，老代码 `if (e instanceof Payment) { ((Payment) e).getAmount(); }` 一长串 instanceof + 强转，新增类型忘记加分支就 NPE。Record Pattern + sealed + switch 让编译器在新增类型时强制提醒，从运行时炸弹变成编译期错误。

## 一、概念层：从 instanceof 链到 ADT

**老式 instanceof 链的痛点**：

```java
// 反例：订单事件处理，新增类型容易漏分支
public String describe(OrderEvent e) {
    if (e instanceof Payment) {
        Payment p = (Payment) e;          // 强转（运行时可能 ClassCastException）
        return "支付 " + p.getAmount();
    } else if (e instanceof Refund) {
        Refund r = (Refund) e;
        return "退款 " + r.getAmount();
    } else if (e instanceof Coupon) {
        Coupon c = (Coupon) e;
        return "用券 " + c.getCode();
    }
    return "未知";                          // 新增 OrderEvent 子类时这里出 bug
}
```

**问题三连**：
1. **类型不安全**：强转可能 ClassCastException
2. **不穷尽**：新增 OrderEvent 子类，编译器不会提醒补分支
3. **啰嗦**：instanceof + 强转 + getter 三步

**Record Pattern + sealed + switch（JDK 21 GA）**：

```java
// 1. 定义 sealed 类型族（封闭 = 编译器知道所有子类型）
sealed interface OrderEvent permits Payment, Refund, Coupon {}

// 2. record 定义数据载体
record Payment(BigDecimal amount, String method) implements OrderEvent {}
record Refund(BigDecimal amount, String reason) implements OrderEvent {}
record Coupon(String code, BigDecimal discount) implements OrderEvent {}

// 3. switch pattern + 解构（编译期穷尽性校验）
public String describe(OrderEvent e) {
    return switch (e) {
        case Payment(BigDecimal amount, String method) -> "支付 " + amount + " via " + method;
        case Refund(BigDecimal amount, String reason)  -> "退款 " + amount + ": " + reason;
        case Coupon(String code, BigDecimal discount)  -> "用券 " + code + " 减 " + discount;
        // 没有 default！新增 OrderEvent 子类时编译器强制补分支
    };
}
```

**收益对比**：

| 维度 | 老 instanceof 链 | Record Pattern + sealed switch |
|------|------------------|-------------------------------|
| 类型安全 | 强转可能 CCE | 编译期保证 |
| 穷尽性 | 不校验（漏分支） | 编译期强制（漏 case 编译错） |
| 代码量 | 5-10 行/分支 | 1 行/分支 |
| 可读性 | 命令式（if + cast + get） | 声明式（按形状匹配 + 解构） |
| 扩展性 | 新增类型编译过、运行时炸 | 新增类型编译错、强制补分支 |

## 二、机制层：instanceof 与 switch 中的 Record Pattern

**instanceof 中的 Record Pattern**：

```java
// JDK 16+ Pattern for instanceof（不带解构）
if (e instanceof Payment p) {
    System.out.println(p.amount());
}

// JDK 21 Record Pattern（带解构）
if (e instanceof Payment(BigDecimal amount, String method)) {
    // 直接拿到 amount 和 method，无需 p.amount()
    System.out.println(amount + " via " + method);
}
```

**嵌套 Record Pattern**（架构师必须能演示）：

```java
// 复杂数据结构
record Point(int x, int y) {}
record Rectangle(Point upperLeft, Point lowerRight) {}
record Shape(String kind, Rectangle bbox) {}

// 嵌套解构
public void printShape(Shape s) {
    if (s instanceof Shape(String kind,
                           Rectangle(Point(int x1, int y1), Point(int x2, int y2)))) {
        System.out.printf("%s at (%d,%d)-(%d,%d)%n", kind, x1, y1, x2, y2);
        // 一行解构 5 个变量：kind, x1, y1, x2, y2
    }
}
```

**switch 中的 Record Pattern + guard**：

```java
public String classify(OrderEvent e) {
    return switch (e) {
        // Pattern + when guard（JDK 21）
        case Payment(BigDecimal amount, _) when amount.compareTo(BigDecimal.valueOf(10000)) > 0 ->
            "大额支付 " + amount;
        case Payment(BigDecimal amount, String method) ->
            "普通支付 " + amount + " via " + method;
        case Refund(BigDecimal amount, _) when amount.compareTo(BigDecimal.ZERO) < 0 ->
            "异常退款";  // 业务规则：负数退款是 bug
        case Refund(BigDecimal amount, String reason) ->
            "退款 " + amount + ": " + reason;
        case Coupon(String code, _) ->
            "用券 " + code;
    };
}
```

**类型模式的 `_` 通配符**（JDK 22+ unnamed pattern）：

```java
// 只关心类型不关心组件
public boolean isPayment(OrderEvent e) {
    return e instanceof Payment(_, _);   // 不提取组件，只匹配类型
}
```

## 三、实战层：替换 Visitor 模式

**老式 Visitor 模式（Java 8 时代的"类型分发"）**：

```java
// 反例：Visitor 模式处理订单事件（迂回、啰嗦）
sealed interface OrderEvent {
    <R> R accept(OrderVisitor<R> v);
}
record Payment(BigDecimal amount) implements OrderEvent {
    public <R> R accept(OrderVisitor<R> v) { return v.visit(this); }
}
record Refund(BigDecimal amount) implements OrderEvent {
    public <R> R accept(OrderVisitor<R> v) { return v.visit(this); }
}

interface OrderVisitor<R> {
    R visit(Payment p);
    R visit(Refund r);
}

// 使用：业务在 Visitor 里写
OrderVisitor<String> visitor = new OrderVisitor<>() {
    public String visit(Payment p) { return "支付 " + p.amount(); }
    public String visit(Refund r) { return "退款 " + r.amount(); }
};
String desc = e.accept(visitor);
```

**Record Pattern 替代 Visitor（清晰）**：

```java
// 直接 switch pattern，无需 Visitor 的间接层
public String describe(OrderEvent e) {
    return switch (e) {
        case Payment(BigDecimal amount) -> "支付 " + amount;
        case Refund(BigDecimal amount) -> "退款 " + amount;
    };
}
```

**收益**：Visitor 模式是为了"在不修改数据类的前提下加新操作"（OCP），但牺牲了"加新数据类型"的便利（每加一个类型要改所有 Visitor）。Record Pattern + sealed 重新选了权衡——加新类型容易（编译期强制补 switch 分支），加新操作也容易（写新的 switch 函数）。这是 ADT 的经典优势。

**状态机实现（架构师常用场景）**：

```java
// 订单状态机
sealed interface OrderState permits Created, Paid, Shipped, Delivered, Cancelled {}
record Created(Instant at) implements OrderState {}
record Paid(Instant at, String txnId) implements OrderState {}
record Shipped(Instant at, String trackingNo) implements OrderState {}
record Delivered(Instant at) implements OrderState {}
record Cancelled(Instant at, String reason) implements OrderState {}

// 状态转移：编译期保证所有状态都被覆盖
public OrderState transition(OrderState current, OrderEvent event) {
    return switch (current) {
        case Created(_, _)            -> switch (event) {
            case Payment(_, _) -> new Paid(Instant.now(), txnId);
            case Cancel        -> new Cancelled(Instant.now(), "用户取消");
            default            -> throw new IllegalStateException("非法转移");
        };
        case Paid(_, _)               -> switch (event) {
            case Ship        -> new Shipped(Instant.now(), trackingNo);
            case Cancel      -> new Cancelled(Instant.now(), "已支付取消");
            default          -> throw new IllegalStateException();
        };
        // ... 每个状态编译期强制覆盖
    };
}
```

## 四、底层本质：为什么 sealed + record pattern = ADT

回到第一性：**为什么 sealed + record + switch pattern 这三件套才是"完整的 ADT"？**

ADT（代数数据类型）的三个要素：

1. **积类型（Product Type）**：类型 = 多个字段的笛卡尔积。`Point = int × int`。Java 用 record 表达。
2. **和类型（Sum Type）**：类型 = 多个子类型的"或"。`Shape = Circle | Rectangle | Triangle`。Java 用 sealed 接口 + permits 表达。
3. **模式匹配 + 穷尽性**：对和类型的分支处理必须覆盖所有子类型。Java 用 switch pattern + sealed 实现（编译器知道 permits 列表，漏 case 编译错）。

三者缺一不可：record 没有 sealed + switch，仍然是普通数据类（和 instanceof 链没区别）；sealed 没有 switch pattern，仍然是封闭接口（还要写 instanceof）；switch pattern 没有 sealed，无法穷尽性校验（必须写 default 兜底）。

**编译期穷尽性的本质**：

```
sealed interface Shape permits Circle, Square, Triangle
                                          ↑
                       编译器知道所有子类型 = {Circle, Square, Triangle}

switch (shape) {
    case Circle _ -> ...
    case Square _ -> ...
    // 没有 Triangle！编译器报错：switch 没覆盖 Triangle
}
```

这是面向对象的"开闭原则"重新表述——对扩展开放（加新 Shape 子类容易）、对修改关闭（修改者被迫处理所有分支）。和 Visitor 模式的权衡相反：Visitor 是"加操作容易、加数据类型难"，sealed + record 是"加数据类型容易、加操作时强制处理新类型"。

**与 Kotlin / Scala 的对比**：

| 特性 | Java 21 | Kotlin | Scala 3 |
|------|---------|--------|---------|
| record / data class | record | data class | case class |
| sealed | sealed interface/class | sealed class/interface | enum / sealed trait |
| 模式匹配 | switch pattern | when | match |
| 穷尽性 | when（编译错） | when（编译错） | match（编译错） |
| 解构 | record pattern | componentN | unapply |

Java 21 终于追上 Kotlin/Scala 的 ADT 能力，且因为 sealed 接口的存在，比 Kotlin 的 sealed class 更灵活（接口可多实现）。

## 五、AI 架构师加问：5 个

1. **AI 代码生成用 Record Pattern 替代 Visitor，怎么保证质量？**
   AI 识别 Visitor 模式（接口 + visit 方法 + accept 实现）→ 转 sealed + record + switch。难点是泛型 Visitor（多返回类型）转成 switch 要明确返回类型。AI 输出 diff 人工 review，跑测试验证穷尽性（新增子类型应编译错）。

2. **AI 推理框架的"模型输出类型"（文本/JSON/工具调用）怎么用 Record Pattern？**
   LLM 输出是和类型：`Output = Text(String) | ToolCall(String, Map) | JSON(Object) | Error(String)`。用 sealed + record 定义，AI Agent 的 dispatch 用 switch pattern 处理每种输出。新增"图像输出"时编译器强制所有 dispatch 补分支，避免漏处理。

3. **怎么用 AI 自动把 instanceof 链重构成 Record Pattern？**
   静态分析：扫描 `if (x instanceof T) { ((T) x).m(); }` 模式。如果 T 是 record 或可以转 record，输出重构建议。难点：① 类不是 record 要先转 record（可能影响其他代码）；② 没用 sealed 要先加 sealed（需要确认所有子类型）；③ if-else 链要转 switch。建议分步重构，AI 给建议人工确认。

4. **AI Agent 的工具调用结果（成功/失败/部分成功）用 Record Pattern 怎么建模？**
   sealed interface ToolResult permits Success, Failure, Partial {}
   record Success(Object data) implements ToolResult {}
   record Failure(String error, Throwable cause) implements ToolResult {}
   record Partial(Object partialData, List<String> warnings) implements ToolResult {}
   Agent 处理时 switch pattern 解构，穷尽性保证不漏处理 Partial。比传统的 Result<T> 单类型 + if-else 更类型安全。

5. **AI 代码生成时怎么利用 sealed 的穷尽性强制类型安全？**
   AI 生成 sealed 类型族时自动加 permits 子句，生成 switch 时省略 default 让编译器校验。如果业务新增类型，AI Copilot 在编译时收到错误"switch 没覆盖 NewType"，自动补分支。这是把"类型系统的强制力"引入 AI 代码生成的典型场景——比 AI 写注释说"记得加分支"更可靠。

## 六、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"record + sealed + switch pattern = ADT 三件套"**。

- **record**：积类型（数据载体，不可变）
- **sealed permits**：和类型（封闭子类型集合）
- **switch pattern**：模式匹配 + 解构（穷尽性校验）
- **嵌套解构**：Point(Point(int x,_), _)
- **guard**：case ... when condition
- **替代 Visitor**：sealed + record + switch 比 Visitor 更简洁
- **版本**：JDK 21 GA（Record Pattern JEP 440/441）

### 拟人化理解

把 Record Pattern 想成**快递分拣系统**。老 instanceof 是"先看是不是包裹，再拆开看里面是什么"——两步、易拆错、易漏种类。Record Pattern 是"按盒子形状分拣"——长方形盒子里 3 件就直接取 3 件，圆形盒子里 1 件就直接取 1 件，分拣机（编译器）自动校验所有形状都覆盖了。sealed 是"快递种类白名单"（圆通、顺丰、京东），新加种类编译器强制分拣机升级。

### 面试现场 60 秒回答

> Record Pattern（JDK 21 JEP 440 GA）的工程价值不是少写代码，是把 ADT 引入 Java——record 表达积类型、sealed 表达和类型、switch pattern 表达穷尽性匹配。三者组合让"按数据形状分支"从运行时 instanceof + 强转（易 CCE、易漏分支）变成编译期穷尽性校验。典型场景：替换订单事件处理的 Visitor 模式（5 行 if-else 缩成 1 行 switch）、实现状态机（编译期保证所有状态都被处理）。嵌套解构让复杂数据（Point in Rectangle in Shape）一行提取。新增子类型时编译器强制补 switch 分支，从运行时炸弹变编译期错误。

### 反问面试官

> 贵司 JDK 版本是 21+？业务里 instanceof 链多吗（订单事件、消息类型、API 响应）？用 Visitor 模式吗？这决定我聊 Record Pattern 替代 instanceof 还是替代 Visitor。

## 七、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 已经有 instanceof + 强转了，为什么搞 Record Pattern？ | 三痛点：强转可能 CCE、不穷尽（漏分支运行时炸）、啰嗦。Record Pattern + sealed 让编译器在新增类型时强制提醒。证明：重构订单事件后新增 Payment 子类，编译器报错"switch 没覆盖"，老代码会运行时 NPE |
| 证据追问 | 怎么证明 Record Pattern 真的提升了可维护性？ | 代码行数（少 50%+）、Bug 率（新增类型导致的 NPE 降为 0）、Code Review 时间（pattern 比 if 链快读）、编译期错误 vs 运行时错误比例 |
| 边界追问 | Record Pattern 能完全替代 Visitor 吗？ | 大多数场景可以。Visitor 还有一席之地：① 数据类型跨包不能 sealed；② 操作很多但数据类型稳定（Visitor 加操作不改数据类）；③ 第三方库要求访问者接口。多数业务场景 sealed + record + switch 更优 |
| 反例追问 | 什么场景不该用 Record Pattern？ | 数据类型经常变（sealed 加子类型要改 permits + 所有 switch）、跨模块共享数据（sealed 不能跨包）、性能极致（record 有微弱开销）、JDK < 21 |
| 风险追问 | 引入 Record Pattern 最大风险？ | ① JDK 版本（21 GA，更早版本预览）；② record 不可变（业务代码改数据时要重建对象）；③ sealed 跨包限制（permits 子类必须同模块或显式 opens）。治法：评估 JDK 21+、设计数据时考虑不可变、模块边界 |
| 验证追问 | 怎么证明重构后业务行为不变？ | 单元测试覆盖每个 switch case；编译期穷尽性保证不漏分支；mutation testing（自动注入"漏分支"看测试是否抓到）。线上灰度：业务指标对比 |
| 沉淀追问 | 团队推广 Record Pattern 沉淀什么？ | record + sealed + switch 的代码模板（订单事件、API 响应、状态机）、Visitor → Record Pattern 重构 checklist、JDK 21 升级指南（包含 sealed 跨包规则）、Code Review checklist（穷尽性、不可变性） |

### 现场对话示例

**面试官**：订单有 Payment/Refund/Coupon 三种事件，老代码 if-else instanceof 一长串，怎么重构？

**候选人**：用 sealed + record + switch pattern。第一步，把 OrderEvent 改成 sealed interface permits Payment, Refund, Coupon，编译器知道所有子类型。第二步，每个子类型改 record（不可变数据载体）。第三步，业务代码改成 switch pattern + 解构，`case Payment(BigDecimal amount, String method) -> ...`，直接提取组件无需强转。第四步，删掉 default——编译器强制覆盖所有 sealed 子类型，新增 PaymentRefunded 时编译错"switch 没覆盖"，强制补分支。代码行数从 20 行降到 5 行，新增类型的 bug 从运行时 NPE 变编译期错误。

**面试官**：原来用的 Visitor 模式不是也能解决吗？

**候选人**：Visitor 模式是 JDK 5 时代没有 sealed 时的迂回方案。它解决了"按类型分发"但代价大：① 数据类要写 accept 方法（侵入）；② 每个 Visitor 接口加新类型要改所有 Visitor 实现；③ 泛型 Visitor 写起来啰嗦。Record Pattern + sealed 直接 switch，没有 accept 间接层，加新数据类型编译期强制处理。Java 21 后绝大多数 Visitor 模式可以淘汰。

**面试官**：嵌套解构什么时候用？

**候选人**：数据结构嵌套时。比如 Shape 包含 Rectangle，Rectangle 包含两个 Point。`case Shape(String kind, Rectangle(Point(int x1,int y1), Point(int x2,int y2))) -> ...` 一行提取 5 个变量。比传统 `Shape s = (Shape) obj; Rectangle r = s.bbox(); Point p1 = r.upperLeft(); int x1 = p1.x();` 五步合一。可读性更高，编译期保证类型安全。

## 常见考点

1. **Record Pattern 是什么？**——JDK 21（JEP 440/441）GA 的模式匹配，在 instanceof 和 switch 中解构 record 组件。`case Payment(BigDecimal amount, _)` 直接提取组件。
2. **sealed + record + switch pattern 的组合价值？**——构成完整 ADT：record 是积类型、sealed 是和类型、switch pattern 是穷尽性匹配。编译期保证分支覆盖。
3. **和 Visitor 模式对比？**——Visitor 是迂回方案（accept + visit），Record Pattern 直接 switch + 解构更简洁。Visitor 适合操作稳定、数据类型稳定场景；Record Pattern 适合数据类型可扩展场景。
4. **穷尽性怎么保证？**——sealed 让编译器知道所有子类型，switch 不写 default 时编译器校验所有 case 都覆盖，漏一个编译错。
5. **性能怎么样？**——switch pattern 编译成 tableswitch/lookupswitch（和 switch int 性能等价），解构是字段访问无开销。整体和 instanceof + 强转等价或更快。

## 结构化回答

**30 秒电梯演讲：** Record Pattern（JEP 440/441，JDK 21 GA）是用数据形状做控制流——把 instanceof + 强转 + 字段提取三步合一，让代数数据类型（ADT）在 Java 里第一次可表达。它的工程价值不是少写两行代码，而是把类型分支从运行时 instanceof（易 NPE、易漏分支）变成编译期穷尽检查（sealed + switch pattern = 穷尽性校验）

**展开框架：**
1. **Record Patte** — Record Pattern（JDK 21 GA）：instanceof 和 switch 都支持
2. **解构** — record 的组件类型 + 名称自动提取
3. **嵌套** — Record Pattern 可嵌套（Point(Point(int x,_), _)）

**收尾：** 以上是我的整体思路。您想继续深入聊——Record Pattern 和访问者模式（Visitor）什么关系？


## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：Java 21 Record Pattern 与 | "这题核心是——Record Pattern（JEP 440/441，JDK 21 GA）是用数据形状做控制流—……" | 开场钩子 |
| 0:15 | 像快递分拣：老 instanceof 是先看是类比图 | "打个比方：像快递分拣：老 instanceof 是先看是。" | 核心类比 |
| 0:40 | Record Patte示意/对比图 | "Record Pattern（JDK 21 GA）：instanceof 和 switch 都支持" | Record Patte要点 |
| 1:05 | 解构示意/对比图 | "record 的组件类型 + 名称自动提取" | 解构要点 |
| 1:30 | 嵌套示意/对比图 | "Record Pattern 可嵌套（Point(Point(int x,_), _)）" | 嵌套要点 |
| 1:55 | 总结卡 | "记住：Record Pattern。下期见。" | 收尾 |
