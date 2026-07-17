---
id: java-architect-192
difficulty: L3
category: java-architect
subcategory: 中台架构
tags:
- Java 架构师
- 模块化
- 领域边界
- 治理
feynman:
  essence: 单体系统的死法不是"太大"，而是"边界混乱"——所有模块互相依赖、共享数据库、改一处动全身。模块化的核心是"用强制的物理边界（Java Module System / Maven 多模块 / Spring Modulith）替代自觉的逻辑边界"，让"领域边界"从约定变成编译期约束。能编译通过 ≠ 边界清晰，能防止跨领域乱调用的边界才是真模块化。
  analogy: 像合租房子——大家共用客厅厨房（共享 DB）迟早因为"谁洗碗"吵架。模块化是"改成独立公寓"（各自有完整厨房卫生间），虽然总平米数大了，但边界清晰、互不干扰。Spring Modulith 是"软隔断"（屏风），JPMS 是"硬隔断"（承重墙）。
  first_principle: 模块化的第一性是"用强制边界降低耦合"。自觉遵守的边界（包名规范、注释）会被业务压力冲垮——"这个紧急需求跨领域调一下"。强制边界（编译期检查、ArchUnit 测试、模块隔离）让"违规调用"变成编译失败或测试失败，把"边界"从道德约束升为工程约束。
  key_points:
  - 三种实现：Maven 多模块（构建隔离）、Spring Modulith（逻辑模块+验证）、JPMS（JDK 9+ 强制模块）
  - 领域边界用 DDD 限界上下文划分，一个模块 = 一个限界上下文
  - 模块间只通过公开 API 交互，禁止跨模块直接访问内部类/表
  - ArchUnit 做架构守护测试，CI 检查边界违规
  - 数据库边界：每个模块拥有自己的表，禁止跨模块直接 JOIN
first_principle:
  problem: 如何让单体系统在不拆微服务的前提下，实现"领域边界清晰、模块独立演进、改一处不波及全局"？
  axioms:
  - 自觉遵守的边界（注释/规范）会被业务压力冲垮
  - 共享 DB 是最大的耦合源——跨领域 JOIN 让表结构无法独立演进
  - 模块化要"强制"才有效——编译期/测试期约束 > 运行期约定
  - 模块化是微服务的前置条件——单体内部都划不清边界，拆成微服务只会更乱
  rebuild: 用 DDD 限界上下文划分领域（订单/库存/支付/营销），每个领域是一个模块。模块间通过公开 API（interface）交互，内部实现（implementation）对外不可见。物理隔离用 Maven 多模块（构建隔离）+ Spring Modulith（逻辑模块 + 自动文档）+ JPMS（JDK 9+ 编译期强制）。数据库按模块拆表归属，禁止跨模块 JOIN，跨模块查询走 API。ArchUnit 做架构守护测试，CI 阻断边界违规。
follow_up:
  - Maven 多模块和 JPMS 区别？——Maven 是构建期隔离（依赖管理），JPMS 是编译期+运行期强制（module-info.java）。JPMS 更强但侵入性高
  - Spring Modulith 是什么？——Spring 官方的模块化框架，用 package 约定划分模块，提供边界验证、模块文档自动生成、事件发布机制
  - 为什么禁止跨模块 JOIN？——跨模块 JOIN 让表结构耦合（改 A 表影响 B 模块查询）。跨模块查询走 API（B 模块提供查询接口）或 CQRS（物化视图）
  - 模块化一定要拆微服务吗？——不。模块化单体（Modular Monolith）是优于微服务的中间态——保留单体的部署/事务简单性，又有模块的边界清晰性。适合 50 人以下的团队
  - 怎么防止模块化退化为"大泥球"？——ArchUnit 架构测试 + CI 阻断 + 评审 checklist。边界违规一次都不能放过，否则破窗效应
memory_points:
  - 三种实现：Maven 多模块（构建隔离）/Spring Modulith（逻辑+验证）/JPMS（编译期强制）
  - 领域边界用 DDD 限界上下文，一个模块 = 一个限界上下文
  - 模块间只通过公开 API 交互，禁止跨模块访问内部类/表
  - ArchUnit 做架构守护测试，CI 阻断边界违规
  - 数据库按模块拆表，禁止跨模块 JOIN（走 API 或物化视图）
---

# 【Java 后端架构师】单体系统模块化与领域边界治理

> 适用场景：JD 核心技术。一个订单单体跑了 5 年，30 万行代码，订单/库存/支付/营销全在一个工程里，共享一个 DB。改一个营销规则要回归整个下单链路，新人 3 个月不敢动代码。直接拆微服务成本太高、事务复杂度爆炸，模块化是中间态——保留单体部署简单性，用强制边界实现领域隔离。

## 一、概念层：模块化的三种实现与边界强度

| 实现 | 边界强度 | 机制 | 适用场景 |
|------|---------|------|---------|
| **Maven 多模块** | 弱（构建期） | 父 POM 管理依赖，子模块独立 jar | 团队小、边界靠自觉 |
| **Spring Modulith** | 中（测试期） | package 约定 + ArchUnit 验证 + 自动文档 | Spring 生态、中等团队 |
| **JPMS（Java Module System）** | 强（编译期+运行期） | module-info.java 显式导出/依赖 | JDK 9+、需要强制隔离 |

**核心区别**：
- Maven 多模块：依赖管理工具，不强制边界（A 模块能 import B 模块的任何类，只要依赖了）
- Spring Modulith：约定 package 命名（`com.jd.order` 是模块根，`com.jd.order.internal` 是内部），ArchUnit 验证"外部模块不能访问 internal"
- JPMS：`module-info.java` 里 `exports com.jd.order.api` 只导出 API 包，其他包对其他模块不可见（编译失败）

## 二、机制层：Spring Modulith 实战

### 2.1 模块化单体结构（Spring Modulith）

```
order-system/
├── src/main/java/com/jd/ordersystem/
│   ├── OrderSystemApplication.java       # 启动类
│   │
│   ├── order/                            # 订单模块（限界上下文）
│   │   ├── OrderApi.java                 # 公开 API（其他模块可调用）
│   │   ├── OrderService.java             # 公开 API 实现
│   │   ├── internal/                     # 内部实现（其他模块禁止访问）
│   │   │   ├── OrderInternalService.java
│   │   │   ├── OrderRepository.java
│   │   │   └── OrderEntity.java
│   │   └── package-info.java             # 模块声明
│   │
│   ├── inventory/                        # 库存模块
│   │   ├── InventoryApi.java             # 公开 API
│   │   ├── InventoryService.java
│   │   └── internal/
│   │       ├── InventoryRepository.java
│   │       └── InventoryEntity.java
│   │
│   ├── payment/                          # 支付模块
│   │   ├── PaymentApi.java
│   │   └── internal/
│   │
│   └── marketing/                        # 营销模块
│       ├── MarketingApi.java
│       └── internal/
│
├── src/test/java/
│   └── ArchitectureTest.java             # ArchUnit 架构守护测试
```

### 2.2 模块声明（package-info.java）

```java
// com.jd.ordersystem.order.package-info.java
@org.springframework.modulith.ApplicationModule(
    allowedDependencies = {"inventory", "payment::api"}  // 显式声明依赖
)
package com.jd.ordersystem.order;
```

**allowedDependencies 的价值**：显式声明"订单模块只能依赖库存和支付的 api"。如果订单模块依赖了营销模块，ArchUnit 测试失败——强制边界。

### 2.3 公开 API vs 内部实现

```java
// 订单模块的公开 API（其他模块可调用）
// com.jd.ordersystem.order.OrderApi.java
public interface OrderApi {
    OrderInfo queryOrder(Long orderId);
    OrderCreateResult createOrder(OrderCreateCommand cmd);
}

// 订单模块的内部实现（其他模块禁止访问）
// com.jd.ordersystem.order.internal.OrderInternalService.java
class OrderInternalService {  // package-private，其他模块访问不了
    // 复杂的订单状态机、规则引擎、缓存逻辑
    // 这些是实现细节，不应该暴露给其他模块
}
```

**关键原则**：公开 API 是 interface（稳定契约），内部实现是 package-private class（可自由重构）。其他模块只依赖 API interface，不依赖实现类——这是模块化的"依赖倒置"。

### 2.4 ArchUnit 架构守护测试

```java
// src/test/java/ArchitectureTest.java
@AnalyzeClasses(packages = "com.jd.ordersystem")
class ArchitectureTest {
    
    // 规则 1: 模块间只能通过 *Api 接口调用，不能直接访问 internal 包
    @ArchTest
    static final ArchRule modules_should_not_access_internal =
        noClasses().that().resideOutsidePackage("com.jd.ordersystem.order..")
            .should().accessClassesThat().resideInAPackage("com.jd.ordersystem.order.internal..");
    
    // 规则 2: 模块只能依赖显式声明的模块
    @ArchTest
    static final ArchRule modules_should_respect_dependencies =
        layeredArchitecture().consideringOnlyDependenciesInLayers()
            .layer("order").definedBy("..order..")
            .layer("inventory").definedBy("..inventory..")
            .layer("payment").definedBy("..payment..")
            .layer("marketing").definedBy("..marketing..")
            .whereLayer("order").mayOnlyBeAccessedByLayers("order")  // 谁能调订单
            .whereLayer("inventory").mayOnlyBeAccessedByLayers("order", "inventory");
    
    // 规则 3: 禁止跨模块直接访问 Repository（数据库边界）
    @ArchTest
    static final ArchRule no_cross_module_repository_access =
        noClasses().that().resideInAPackage("..order..")
            .should().accessClassesThat().resideInAPackage("..inventory.internal..InventoryRepository");
}
```

**ArchUnit 的价值**：架构规则写成可执行测试，CI 自动跑。边界违规不是"评审时被发现"，而是"CI 失败，PR 合并不了"——把边界从"自觉遵守"升为"强制约束"。

## 三、机制层：JPMS 强制隔离（更激进）

### 3.1 module-info.java（JDK 9+）

```java
// src/main/java/module-info.java
module com.jd.ordersystem.order {
    // 导出：其他模块只能用这些包
    exports com.jd.ordersystem.order.api;
    
    // 不导出的包（internal）对其他模块完全不可见（编译失败）
    // com.jd.ordersystem.order.internal 不在 exports 里
    
    // 依赖
    requires com.jd.ordersystem.inventory;  // 只能依赖库存模块
    requires spring.context;
    requires java.sql;
}
```

**JPMS vs Spring Modulith**：
- JPMS 是编译期+运行期强制（其他模块访问 internal 直接编译失败）
- Spring Modulith 是测试期验证（ArchUnit 跑测试才检查）
- JPMS 更强但侵入性高（所有依赖都要在 module-info 声明，第三方库没模块化会麻烦）
- 实践：团队成熟用 JPMS，否则用 Spring Modulith（Spring 官方推荐）

### 3.2 数据库边界（最难的隔离）

```
模块化单体最大的挑战：DB 怎么分？

错误做法（大泥球）：
  订单模块直接 JOIN 库存表：
  SELECT o.*, i.stock FROM orders o JOIN inventory i ON o.sku_id = i.sku_id
  → 订单和库存表结构耦合，改库存表影响订单查询

正确做法（API 调用）：
  订单查询 → 调 InventoryApi.queryStock(skuId) → 库存模块返回库存
  → 表结构解耦，但失去 JOIN 性能

折中做法（CQRS 物化视图）：
  库存变更时发事件 → 订单模块维护一个"订单+库存"物化视图
  → 读取时直接查物化视图（性能好），写入时各管各的
```

**DB 边界规则**：
1. 每个模块拥有自己的表（`order_*` 归订单，`inventory_*` 归库存）
2. 禁止跨模块直接 JOIN（CI 检查 SQL，跨表 JOIN 阻断）
3. 跨模块查询走 API（运行时调用）或物化视图（CQRS）
4. 共享数据（如用户信息）走共享只读库或缓存

## 四、实战层：模块化改造路径

### 4.1 从大泥球到模块化的渐进改造

```
阶段 1: 逻辑分层（不改包结构）
  - 用注释/文档标识领域边界
  - 团队自觉遵守"不要跨领域调用"
  - 问题：约束靠自觉，业务压力下会被打破
  
阶段 2: 包结构重整（改包名）
  - 按 DDD 限界上下文重新组织 package
  - com.jd.order / com.jd.inventory / com.jd.payment
  - 引入 ArchUnit 测试（先警告不阻断）
  
阶段 3: Maven 多模块（拆构建）
  - 每个领域一个 Maven module
  - 显式声明模块间依赖
  - ArchUnit 升级为 CI 阻断
  
阶段 4: Spring Modulith / JPMS（强制边界）
  - 引入 package-info / module-info
  - internal 包对其他模块不可见
  - 公开 API 用 interface
  
阶段 5（可选）: 拆微服务
  - 当模块化单体的某个领域需要独立扩缩容/独立发版时
  - 模块化让拆分成本低（边界已经清晰）
```

### 4.2 领域边界识别（DDD 限界上下文）

```markdown
# 领域边界识别工作坊（事件风暴法）

## 步骤
1. 列出所有业务事件（订单创建/库存扣减/支付成功/营销发券）
2. 按业务语义聚类（订单相关事件归订单上下文）
3. 识别上下文之间的依赖（订单依赖库存的扣减能力）
4. 定义上下文接口（库存对订单暴露 deductStock API）

## 示例：JD 订单系统的限界上下文

订单上下文（核心域）：
  - 聚合根：Order
  - 实体：OrderItem, OrderStatus
  - 值对象：Address, OrderId
  - 业务规则：订单状态机、金额计算

库存上下文（支撑域）：
  - 聚合根：Inventory
  - 实体：StockItem
  - 业务规则：库存扣减、回滚、预警

支付上下文（核心域）：
  - 聚合根：Payment
  - 业务规则：支付渠道选择、退款

营销上下文（支撑域）：
  - 聚合根：Promotion, Coupon
  - 业务规则：券计算、活动匹配

## 上下文映射（Context Map）
订单 → 库存：客户/供应商关系（订单调库存 API）
订单 → 支付：客户/供应商关系
营销 → 订单：客户/供应商关系（营销调订单查商品）
```

## 五、底层本质：为什么模块化是微服务的前置条件

**模块化单体（Modular Monolith）是优于微服务的中间态**。很多团队直接从大泥球跳到微服务，结果是"分布式大泥球"——边界没划清，拆成 N 个服务互相乱调用，还引入了网络延迟、分布式事务、调试困难。

**为什么强制边界比自觉边界重要**：自觉边界（注释、规范、评审）会被业务压力冲垮——"这个紧急需求，营销模块临时调一下订单内部方法"。一次破例就有第二次，破窗效应后边界名存实亡。强制边界（ArchUnit 测试、JPMS 编译检查）让违规变成 CI 失败——业务压力压不动代码合并规则。这是"机制 > 自觉"的工程哲学。

**为什么数据库边界是最难的**：应用层边界可以用 ArchUnit 强制（package 隔离），但 DB 边界靠 SQL 检查（难）。跨模块 JOIN 是性能诱惑——一次 JOIN 比 N 次 API 调用快。但跨模块 JOIN 让表结构耦合（改库存表影响订单查询），最终回到大泥球。解法：CI 检查 SQL（SQL 解析器识别跨表 JOIN，阻断），跨模块查询走 API 或 CQRS 物化视图。

**为什么模块化让微服务拆分更容易**：模块化单体的领域边界已经清晰（限界上下文、公开 API、DB 归属），拆微服务只是"把模块边界变成服务边界"。而没有模块化的单体拆微服务，要先在单体内部划清边界（痛苦的领域建模），同时引入微服务的复杂性（网络、事务、调试），难度叠加。先模块化单体（沉淀边界），再按需拆微服务（按扩缩容/发版频率需求），是最稳的演进路径。

## 六、AI 架构师加问：5 个

1. **AI 怎么辅助模块化改造？**
   AI 负责代码分析（识别现有调用链、依赖图，发现跨领域耦合点）、领域建模建议（"这些类语义相近，建议归订单上下文"）、ArchUnit 规则生成（从现有依赖反向生成架构规则）。决策（怎么划边界）在人。

2. **AI 能自动识别限界上下文吗？**
   AI 通过代码聚类（类名/包名/调用关系）给出候选上下文，但最终边界要领域专家确认。AI 不懂业务语义（"库存"和"商品"在 JD 业务里是两个上下文还是一个，AI 判断不了）。AI 辅助，人决策。

3. **AI 怎么检测边界违规？**
   比 ArchUnit 更智能：ArchUnit 只检查 package 模式，AI 能语义级判断（"订单模块调了营销模块的 calculateCoupon，虽然走了 API 但语义上耦合了，建议改为事件驱动"）。AI 补充语义级检测，ArchUnit 做规则级检测。

4. **模块化单体接入 LLM 做代码理解，怎么设计？**
   把模块结构、API 契约、ArchUnit 规则做成 RAG 知识库。新人提问"订单怎么调库存"，AI 检索返回 OrderApi 调 InventoryApi 的示例，并提示"不能直接访问 InventoryRepository（边界违规）"。比新人翻代码高效。

5. **AI 能预测"这个改动会破坏边界吗"？**
   静态分析：PR 提交时 AI 扫描改动文件，识别是否引入跨模块直接依赖（import 跨模块 internal 包）。结合 ArchUnit 规则，AI 给出"这个 PR 破坏了订单→营销的边界，建议改为事件"的提示。CI 阻断 + AI 建议，双重保障。

## 七、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"三种实现、API/内部、ArchUnit、DB 归属、模块化先行"** 五个词。

- **三种实现**：Maven 多模块（构建隔离）/ Spring Modulith（逻辑+验证）/ JPMS（编译期强制）
- **API/内部**：公开 API 是 interface，内部实现是 package-private，依赖倒置
- **ArchUnit**：架构规则写成测试，CI 阻断边界违规
- **DB 归属**：每个模块拥有自己的表，禁止跨模块 JOIN，走 API 或物化视图
- **模块化先行**：模块化单体是微服务前置条件，先内部划清边界再拆服务

### 拟人化理解

把模块化想成 **合租改独栋**。大家共用客厅厨房（共享 DB）迟早因为"谁洗碗"吵架（边界冲突）。模块化是"改成独立公寓"——各自有完整厨房卫生间（每个模块有自己的表和 API），虽然总平米数大了（代码量增加），但边界清晰、互不干扰。Spring Modulith 是"软隔断"（屏风，能翻但 ArchUnit 会告警），JPMS 是"硬隔断"（承重墙，翻不过去编译失败）。ArchUnit 是物业检查（CI 跑测试，违规罚款）。

### 面试现场 60 秒回答

> 单体模块化的核心是"用强制边界替代自觉边界"。三种实现：Maven 多模块（构建期隔离）、Spring Modulith（package 约定 + ArchUnit 验证）、JPMS（module-info.java 编译期强制）。我用 DDD 限界上下文划分领域——订单/库存/支付/营销各是一个模块。每个模块只暴露 API interface（OrderApi），内部实现 package-private 对外不可见。模块间只能通过 API 调用，禁止跨模块访问 internal 包。ArchUnit 把架构规则写成测试，CI 阻断边界违规——让边界从"自觉遵守"升为"工程约束"。DB 边界最难：每个模块拥有自己的表，禁止跨模块 JOIN（走 API 或 CQRS 物化视图）。模块化单体是微服务前置条件——内部都划不清边界，拆微服务只会更乱。先模块化沉淀边界，再按需拆服务。

### 反问面试官

> 贵司单体系统是 Maven 多模块还是一体式？有架构守护测试吗？DB 是共享还是按领域分库？这决定我推模块化的切入点——没分模块先推 Maven 多模块，分了模块但没 ArchUnit 就加架构测试。

## 八、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不直接拆微服务，要先模块化？ | 微服务要解决网络/事务/调试复杂性，前提是边界清晰。从大泥球直接拆微服务，边界没划清只会变成"分布式大泥球"。模块化单体先沉淀边界，再按需拆服务，是最稳路径 |
| 证据追问 | 怎么证明模块化有效？ | (1) ArchUnit 测试通过率（边界违规数下降）；(2) 改动影响面（一个改动涉及的模块数下降）；(3) 团队并行开发效率（不同模块可独立迭代）；(4) 新人上手时间（看 API 契约就懂模块边界）|
| 边界追问 | 模块化能解决所有单体问题吗？ | 不能。模块化解决"边界清晰"，不解决"独立扩缩容/独立发版/技术栈异构"。这些需要微服务。模块化单体是中间态，当某个领域需要独立部署时再拆 |
| 反例追问 | 什么系统不该模块化？ | 5 人小团队、单一产品、快速试错——模块化是过度设计，直接一体式开发更快。模块化适合 20+ 人、多领域协作的中等规模系统 |
| 风险追问 | 模块化最大的风险？ | (1) 边界划错（领域建模不准，频繁重构）；(2) DB 边界难守（跨模块 JOIN 的性能诱惑）；(3) 退化为大泥球（ArchUnit 不严格执行）。对策：领域工作坊、CI 强制、评审 checklist |
| 验证追问 | 怎么防止模块化退化？ | ArchUnit CI 阻断（违规 PR 合并不了）、架构评审（跨模块调用必须评审）、定期架构 review（季度检查模块健康度）。一次都不能放过边界违规，否则破窗效应 |
| 沉淀追问 | 团队模块化规范沉淀什么？ | DDD 限界上下文工作坊方法、ArchUnit 规则模板、模块 API 契约规范、DB 归属规则、模块化改造 Runbook、新人模块导航文档 |

### 现场对话示例

**面试官**：你说禁止跨模块 JOIN，但跨模块查询性能怎么办？

**候选人**：三个方案按场景选：(1) 简单查询走 API——订单查库存，调 InventoryApi.queryStock(skuId)，虽然比 JOIN 慢（多次调用）但边界清晰；(2) 高频查询用缓存——查库存结果缓存到订单模块本地（Caffeine），减少 API 调用；(3) 复杂报表用 CQRS 物化视图——库存变更发事件，订单模块维护一个"订单+库存"物化视图表，报表查物化视图（一次查询，性能好）。方案 3 适合"读多写少+复杂聚合"场景，但增加同步复杂度（事件丢失/延迟）。默认用方案 1（API 调用），性能不够再上方案 2 或 3。

**面试官**：ArchUnit 测试会不会被绕过（比如不跑测试就合并）？

**候选人**：CI 强制。我们的 CI 流程是 PR 合并前必须跑全部测试（含 ArchUnit），ArchUnit 失败阻断合并。不能跳过测试——CI 配置不允许 `-[skip] ci`。另外，ArchUnit 规则本身要 review（防止有人改规则放宽）。关键架构规则放在独立仓库（platform-team 维护），业务团队不能改，只能遵守。这样边界违规在 CI 就被拦截，不会进生产。

**面试官**：模块化单体最终要不要拆微服务？

**候选人**：按需，不是必须。拆微服务的触发条件：(1) 某个模块需要独立扩缩容（如营销大促要扩容，订单不需要）；(2) 团队规模超过 50 人，模块化单体的协作成本上升；(3) 某个模块需要独立发版频率（如营销每周发，订单每月发）。模块化让拆分成本低——边界已经清晰（API 契约、DB 归属），拆服务只是把模块边界变成服务边界，加个 RPC 层。如果没这些触发条件，模块化单体够用，没必要为了微服务而微服务。

## 常见考点

1. **Maven 多模块和 JPMS 区别？**——Maven 是构建期依赖管理（A 模块依赖 B 模块的 jar，能 import 任何 public 类），JPMS 是编译期+运行期强制（module-info.java 的 exports 控制，未导出的包对其他模块完全不可见，编译失败）。JPMS 更强但侵入性高。
2. **Spring Modulith 是什么？**——Spring 官方模块化框架。用 package 约定划分模块（`com.jd.order` 是模块根，`internal` 是内部），提供 ArchUnit 边界验证、模块文档自动生成、跨模块事件机制。比 JPMS 轻，比 Maven 多模块强。
3. **为什么禁止跨模块 JOIN？**——跨模块 JOIN 让表结构耦合（改 A 表影响 B 模块查询），破坏模块独立性。跨模块查询走 API（运行时调用，边界清晰）或 CQRS 物化视图（事件驱动同步，读性能好）。CI 检查 SQL 跨表 JOIN 阻断。
4. **ArchUnit 怎么用？**——把架构规则写成可执行测试。如"订单模块不能访问库存模块的 internal 包"，CI 自动跑。违规 PR 合并不了。规则包括：模块间依赖、分层（Controller 不直接调 Repository）、命名规范（*Api 是公开接口）。
5. **模块化单体 vs 微服务？**——模块化单体保留单体部署/事务简单性，又有模块边界清晰性，适合 20-50 人团队。微服务解决独立扩缩容/发版/技术栈，但引入网络/事务/调试复杂性。模块化是微服务前置条件——内部边界都划不清，拆服务只会更乱。先模块化沉淀边界，再按需拆服务。

## 结构化回答

**30 秒电梯演讲：** 单体系统的死法不是太大，而是边界混乱——所有模块互相依赖、共享数据库、改一处动全身。模块化的核心是用强制的物理边界（Java Module System / Maven 多模块 / Spring Modulith）替代自觉的逻辑边界，让领域边界从约定变成编译期约束。能编译通过 ≠ 边界清晰，能防止跨领域乱调用的边界才是真模块化

**展开框架：**
1. **三种实现** — Maven 多模块（构建隔离）、Spring Modulith（逻辑模块+验证）、JPMS（JDK 9+ 强制模块）
2. **领域边界用 DDD 限界上下文划分** — 一个模块 = 一个限界上下文
3. **模块间只通过公开 API 交互** — 禁止跨模块直接访问内部类/表

**收尾：** 以上是我的整体思路。您想继续深入聊——Maven 多模块和 JPMS 区别？


## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：单体系统模块化与领域边界治理 | "这题一句话：单体系统的死法不是太大，而是边界混乱——所有模块互相依赖、共享数据库、改一处动全身。" | 开场钩子 |
| 0:15 | 像合租房子——大家共用客厅厨房（共享 DB）迟早类比图 | "打个比方：像合租房子——大家共用客厅厨房（共享 DB）迟早。" | 核心类比 |
| 0:40 | 三种实现示意/对比图 | "Maven 多模块（构建隔离）、Spring Modulith（逻辑模块+验证）、JPMS（JDK 9+ 强制模块）" | 三种实现要点 |
| 1:05 | 领域边界用 DDD 限界上下文划示意/对比图 | "一个模块 = 一个限界上下文" | 领域边界用 DDD 限界上下文划要点 |
| 1:55 | 总结卡 | "记住：三种实现。下期见。" | 收尾 |
