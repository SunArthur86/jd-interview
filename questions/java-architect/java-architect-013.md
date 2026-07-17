---
id: java-architect-013
difficulty: L2
category: java-architect
subcategory: Spring Boot
tags:
- 自动配置
- starter
- 工程化
feynman:
  essence: 自动配置的本质是"约定优于配置 + 条件化 Bean 注册"——starter 声明一组 Bean 定义，@Conditional 决定哪些生效，Spring Boot 根据类路径/属性/已存在 Bean 自动装配。让业务方加一个依赖就开箱即用。
  analogy: 像宜家家具的"智能套装"：你买一个"卧室套装"（starter），里面包含床、衣柜、床头柜（一组 Bean），但只有你卧室有窗户时才送窗帘（@ConditionalOnProperty），只有你已有床垫时才送床单（@ConditionalOnBean）。Spring Boot 的 AutoConfiguration 就是这套智能套装系统。
  first_principle: 为什么需要自动配置？因为传统 Spring 要写大量 XML/注解配置（DataSource、TransactionManager、MVC），重复且易错。自动配置用"类路径里有 mysql-connector 就自动配 DataSource"的约定，把 80% 的通用配置交给框架，业务只配 20% 个性化部分。
  key_points:
  - "@SpringBootApplication = @SpringBootConfiguration + @EnableAutoConfiguration + @ComponentScan"
  - "@EnableAutoConfiguration 通过 SPI 加载 META-INF/spring.factories（2.7+ 改 spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports）"
  - 条件注解：@ConditionalOnClass/OnBean/OnProperty/OnMissingBean/OnWebApplication
  - starter 设计：autoconfigure 模块（Bean 定义 + 条件）+ starter 模块（仅 pom 聚合依赖）
  - 排除配置：@SpringBootApplication(exclude = XxxAutoConfiguration.class) 或 spring.autoconfigure.exclude
first_principle:
  problem: 如何让 Spring 应用从"写几百行配置"变成"加一个依赖就跑起来"？
  axioms:
  - 80% 的项目配置是通用的（DataSource、MVC、事务），20% 是个性化的
  - 配置可以根据"环境信号"推断（类路径有什么 jar、有什么属性、已存在什么 Bean）
  - 约定优于配置：有合理默认值，只在需要时覆盖
  rebuild: 把通用配置封装成 AutoConfiguration 类（每个含一组 @Bean + @Conditional），打成 starter。@EnableAutoConfiguration 用 SPI 机制加载所有候选 AutoConfiguration，每个 @Conditional 判断是否生效（类路径有 mysql 才配 DataSource）。业务方加 starter 依赖，Spring Boot 自动推断并装配，零配置启动。
follow_up:
  - spring.factories 和 AutoConfiguration.imports 区别？——2.7 之前用 spring.factories（一个文件塞所有）；2.7+ 推 AutoConfiguration.imports（每行一个类，支持 @AutoConfigureBefore/After 排序），3.0 完全废弃 spring.factories
  - "@ConditionalOnMissingBean 为什么重要？——让业务方可以覆盖默认 Bean：框架定义默认 DataSource @ConditionalOnMissingBean，业务方自己 @Bean DataSource 就覆盖框架默认"
  - 怎么排查某个 Bean 是哪个 AutoConfiguration 配的？——启动加 --debug 看.ConditionEvaluationReport，或 actuator 的 /conditions 端点
  - starter 为什么拆 autoconfigure 和 starter 两模块？——autoconfigure 含配置逻辑（可被 exclude），starter 只聚合依赖（业务方加依赖即用），职责分离便于复用
  - 自动配置生效顺序怎么控制？——@AutoConfigureBefore/After/Order，避免依赖顺序问题（如 DataSourceAutoConfiguration 必须在 TransactionAutoConfiguration 前）
memory_points:
  - "@SpringBootApplication 三合一：Configuration + EnableAutoConfiguration + ComponentScan"
  - SPI 加载：spring.factories（2.7 前）/ AutoConfiguration.imports（2.7+）
  - 5 个核心 @Conditional：OnClass/OnBean/OnProperty/OnMissingBean/OnWebApplication
  - "@ConditionalOnMissingBean 是业务覆盖框架默认的扩展点"
  - 排查：--debug 启动日志或 actuator /conditions 端点
---

# 【Java 后端架构师】Spring Boot 自动配置原理与 starter 设计

> 适用场景：JD 核心技术。内部中间件（配置中心、监控、链路追踪）都要做成 starter，业务方加一行依赖就接入。架构师必须能从 @EnableAutoConfiguration 推到 @Conditional，并设计出可扩展、可覆盖、可排查的 starter。

## 一、概念层：自动配置的三块拼图

**@SpringBootApplication 解构**：

```java
@SpringBootConfiguration    // = @Configuration（配置类，本身也是个 Bean）
@EnableAutoConfiguration    // 自动配置入口（SPI 加载所有 AutoConfiguration）
@ComponentScan              // 扫描当前包及子包的 @Component/@Service/@Controller
public @interface SpringBootApplication { }
```

**自动配置三步流程**：

```
1. 启动入口
   SpringApplication.run() → 创建 ApplicationContext → refresh()
        │
        ▼
2. @EnableAutoConfiguration 生效
   @Import(AutoConfigurationImportSelector.class)
        │
        ▼
3. AutoConfigurationImportSelector.selectImports()
   ├─ 读取 META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports
   │  （2.7 前：META-INF/spring.factories 的 EnableAutoConfiguration 行）
   ├─ 用 @Conditional 过滤：哪些 AutoConfiguration 类生效
   └─ 返回生效的全限定类名列表 → 注册为 BeanDefinition
        │
        ▼
4. 每个 AutoConfiguration 类内部
   @Configuration + @ConditionalOnXxx + @Bean
   按条件决定哪些 @Bean 真正创建
```

**关键认知**：自动配置不是"无条件加载所有"，而是"声明所有候选 + 按条件过滤"。spring.factories 列出几百个候选 AutoConfiguration，但 @Conditional 让大部分在具体环境下不生效。

## 二、机制层：条件注解家族

**核心 @Conditional 注解**（面试必知）：

| 注解 | 条件 | 典型用途 |
|------|------|---------|
| `@ConditionalOnClass(DataSource.class)` | 类路径有指定类 | 有 MySQL 驱动才配 DataSource |
| `@ConditionalOnMissingClass("...MongoDB")` | 类路径无指定类 | 没装 Mongo 不配 MongoTemplate |
| `@ConditionalOnBean(DataSource.class)` | 容器有指定 Bean | 有 DataSource 才配 JdbcTemplate |
| `@ConditionalOnMissingBean` | 容器**无**指定 Bean | 框架默认配置，业务方可覆盖 |
| `@ConditionalOnProperty(prefix="x", name="enabled")` | 配置属性满足 | spring.datasource.url 配了才生效 |
| `@ConditionalOnWebApplication` | 是 Web 应用 | 是 Servlet 应用才配 MVC |
| `@ConditionalOnNotWebApplication` | 不是 Web 应用 | 批处理服务才配某些组件 |
| `@ConditionalOnExpression("#{...}")` | SpEL 表达式 | 复杂组合条件 |

**@ConditionalOnMissingBean 是核心扩展点**：

```java
@Configuration
@ConditionalOnClass({ DataSource.class, EmbeddedDatabaseType.class })
@EnableConfigurationProperties(DataSourceProperties.class)
public class DataSourceAutoConfiguration {

    @Bean
    @ConditionalOnMissingBean   // 关键！业务方没自己定义 DataSource 时才生效
    public DataSource dataSource(DataSourceProperties props) {
        return props.initializeDataSourceBuilder().build();   // 框架默认
    }
}

// 业务方覆盖（优先级高于框架默认）
@Configuration
public class MyConfig {
    @Bean
    public DataSource dataSource() {
        return new HikariDataSource(...);   // 业务自定义，覆盖框架默认
    }
}
// 因为 @ConditionalOnMissingBean，框架默认不生效，用业务的
```

**配置属性绑定**（@ConfigurationProperties）：

```java
@ConfigurationProperties(prefix = "spring.datasource")
public class DataSourceProperties {
    private String url;
    private String username;
    private int maxActive = 10;   // 默认值（约定）
    // getter/setter
}

// application.yml
// spring:
//   datasource:
//     url: jdbc:mysql://localhost/test
//     username: root
//     max-active: 20   # 覆盖默认值
```

## 三、实战层：手写一个 starter

**starter 工程结构**（推荐拆两模块）：

```
my-spring-boot-starter/
├── my-spring-boot-autoconfigure/        # 配置逻辑模块
│   ├── src/main/java/com/jd/autoconf/
│   │   ├── MyService.java              # 自动配置的 Bean
│   │   ├── MyProperties.java           # @ConfigurationProperties
│   │   └── MyAutoConfiguration.java    # @Configuration + @Conditional
│   └── src/main/resources/
│       └── META-INF/
│           └── spring/
│               └── org.springframework.boot.autoconfigure.AutoConfiguration.imports
│                   （内容：com.jd.autoconf.MyAutoConfiguration）
│
└── my-spring-boot-starter/              # 依赖聚合模块（仅 pom）
    └── pom.xml                          # 依赖 autoconfigure + 第三方库
```

**MyAutoConfiguration 实现**：

```java
@Configuration
@ConditionalOnClass(MyService.class)                    // 类路径有 MyService
@EnableConfigurationProperties(MyProperties.class)       // 启用属性绑定
@ConditionalOnProperty(prefix = "my", name = "enabled", havingValue = "true", matchIfMissing = true)
public class MyAutoConfiguration {

    @Bean
    @ConditionalOnMissingBean                            // 业务方没定义才生效
    public MyService myService(MyProperties props) {
        return new MyService(props.getEndpoint(), props.getTimeout());
    }

    @Bean
    @ConditionalOnBean(MyService.class)                  // 有 MyService 才配
    public MyHealthIndicator myHealthIndicator(MyService service) {
        return new MyHealthIndicator(service);
    }
}
```

**AutoConfiguration.imports 文件**（2.7+）：

```
# src/main/resources/META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports
com.jd.autoconf.MyAutoConfiguration
```

**2.7 前用 spring.factories**：

```
# src/main/resources/META-INF/spring.factories
org.springframework.boot.autoconfigure.EnableAutoConfiguration=\
  com.jd.autoconf.MyAutoConfiguration
```

**业务方使用**：

```xml
<!-- 只需加一个依赖 -->
<dependency>
    <groupId>com.jd</groupId>
    <artifactId>my-spring-boot-starter</artifactId>
</dependency>
<!-- application.yml -->
<!-- my: -->
<!--   endpoint: http://api.jd.com -->
<!--   timeout: 5000 -->
<!-- 零配置，开箱即用 -->
```

## 四、实战层：排查与高级特性

**排查自动配置**（生产必会）：

```bash
# 1. 启动加 --debug，打印 ConditionEvaluationReport
java -jar app.jar --debug
# 输出：
#   Positive matches: XxxAutoConfiguration matched (生效的)
#   Negative matches: YyyAutoConfiguration did not match (未生效 + 原因)
#   Unconditional classes: ZzzAutoConfiguration (无条件加载)

# 2. actuator /conditions 端点（生产推荐）
curl http://localhost:8080/actuator/conditions | jq
# 返回每个 AutoConfiguration 的生效状态和原因

# 3. 排除某个自动配置
@SpringBootApplication(exclude = {DataSourceAutoConfiguration.class})
# 或
spring.autoconfigure.exclude=com.zaxxer.hikari.HikariAutoConfiguration
```

**控制 AutoConfiguration 顺序**（解决依赖问题）：

```java
@AutoConfigureBefore(DataSourceAutoConfiguration.class)   // 在某配置前
@AutoConfigureAfter(TransactionAutoConfiguration.class)    // 在某配置后
@AutoConfigureOrder(100)                                    // 数字越小优先级越高
public class MyAutoConfiguration { }
```

**外部化配置优先级**（从高到低，高优先级覆盖低）：

```
1. 命令行参数（--server.port=9090）
2. 环境变量（SPRING_DATASOURCE_URL）
3. application-{profile}.yml（外部）
4. application.yml（外部）
5. application-{profile}.yml（内部）
6. application.yml（内部）
7. @PropertySource
8. 默认值（@ConfigurationProperties 字段默认）
```

## 五、底层本质：为什么是 SPI + Conditional

回到第一性：**自动配置要解决"如何让框架自动装配，又允许业务覆盖"**。

**SPI 机制**：Spring Boot 启动时扫描所有 jar 的 `META-INF/spring.factories`（或 2.7+ 的 imports 文件），收集所有候选 AutoConfiguration。这是"开箱即用"的基础——加个 starter 依赖，它的 AutoConfiguration 就被自动发现。SPI 解耦了"框架"和"配置提供方"，第三方 starter 无需修改 Spring Boot 源码就能接入。

**Conditional 机制**：候选 AutoConfiguration 多达几百个，但每个环境只需一部分。@ConditionalOnClass/OnBean/OnProperty 让每个 AutoConfiguration 自己判断"我该不该生效"——有 MySQL 驱动才配 DataSource，是 Web 应用才配 MVC。这是"按需装配"的基础。

**@ConditionalOnMissingBean 是扩展点**：框架定义的 Bean 都加这个注解，业务方一旦定义同名 Bean 就覆盖框架默认。这是"可覆盖"的基础——80% 用默认，20% 个性化覆盖，不用改框架。

这套设计是"开闭原则"+"约定优于配置"的工程化典范：对扩展开放（业务覆盖），对修改封闭（不用改框架源码），合理默认（约定）+ 显式覆盖（配置）。Spring Boot 能让 Spring 从"重配置"变成"开箱即用"，根因在这套自动配置机制。

## 六、AI 架构师加问：5 个 AI 相关问题

1. **AI SDK 怎么做成 Spring Boot starter？**
   打成 autoconfigure + starter 两模块，AutoConfiguration 里 @ConditionalOnClass(ChatClient.class) + @Bean ChatClient 用 @ConfigurationProperties 绑定 API key/model 参数，@ConditionalOnMissingBean 允许业务覆盖。业务方加依赖 + 配 application.yml 即用。

2. **让 AI 排查 Bean 没装配，AI 接管哪段？**
   AI 解析 --debug 启动日志的 ConditionEvaluationReport，找未生效的 AutoConfiguration 和原因（缺类、属性没配、OnBean 条件不满足）；或调 actuator /conditions 端点。推荐修复（加依赖、配属性、调顺序），人工 review。

3. **AI Agent 的工具（function）怎么用自动配置注册？**
   starter 里定义 FunctionCallback Bean，@ConditionalOnClass(Tool.class) + @ConditionalOnProperty(my.tools.enabled)。业务方加依赖，工具自动注册到 ChatClient；业务方可 @ConditionalOnMissingBean 覆盖。

4. **AI 模型多版本（GPT/Claude/本地）怎么用条件装配？**
   每个模型一个 AutoConfiguration：@ConditionalOnProperty(my.ai.provider=gpt) 配 GPT，=claude 配 Claude，=local 配本地。业务方改一个属性切模型，零代码改动。

5. **怎么防 AI 生成的 starter 配置有坑？**
   强制 @ConditionalOnMissingBean（允许覆盖）、强制 @ConfigurationProperties（外部化配置）、写 META-INF 描述文件、单测覆盖生效/不生效场景。AI 生成的 starter 要用 spring-boot-starter-test 的 ApplicationContextRunner 测试条件逻辑。

## 七、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"三合一、SPI 加载、Conditional 过滤、OnMissingBean 覆盖、imports 文件"**。

- **三合一**：@SpringBootApplication = Configuration + EnableAutoConfiguration + ComponentScan
- **SPI 加载**：spring.factories（2.7 前）/ AutoConfiguration.imports（2.7+）
- **Conditional 过滤**：OnClass/OnBean/OnProperty/OnWebApplication 按条件生效
- **OnMissingBean 覆盖**：业务自定义 Bean 优先于框架默认
- **排查**：--debug 启动日志或 actuator /conditions 端点

### 拟人化理解

把自动配置想成**宜家智能套装**。你买"卧室套装"（starter），含床、衣柜、床头柜（一组 Bean）。但只有卧室有窗户才送窗帘（@ConditionalOnProperty），只有已有床垫才送床单（@ConditionalOnBean）。Spring Boot 的 AutoConfiguration 就是这套智能套装系统——SPI 是"所有可能的套装清单"，@Conditional 是"按你房间实际情况挑哪些真送"，@ConditionalOnMissingBean 是"你已经有的不重复送"。

### 面试现场 60 秒回答

> @SpringBootApplication 三合一：SpringBootConfiguration + EnableAutoConfiguration + ComponentScan。自动配置靠 @EnableAutoConfiguration 触发，通过 @Import(AutoConfigurationImportSelector) 用 SPI 机制加载 META-INF/spring.factories（2.7+ 改 AutoConfiguration.imports）里声明的所有候选 AutoConfiguration，每个再按 @Conditional 决定是否生效——OnClass 类路径有才装、OnBean 容器有才装、OnProperty 配了才装、OnMissingBean 业务没自定义才装框架默认。starter 设计拆 autoconfigure（配置逻辑）和 starter（依赖聚合）两模块，@ConditionalOnMissingBean 是业务覆盖框架默认的扩展点。排查用 --debug 看 ConditionEvaluationReport 或 actuator /conditions 端点。

### 反问面试官

> 贵司有没有自研中间件或 SDK 要做成 starter？如果有，我重点讲 autoconfigure 模块设计和 @Conditional 的最佳实践；如果是业务开发，我确保团队理解自动配置机制和排查方法。

## 八、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不直接 @ComponentScan 扫描所有包，要搞自动配置？ | @ComponentScan 扫描的是业务包，不能扫描第三方 jar（依赖 jar 不该被业务扫描）；自动配置用 SPI 跨 jar 发现配置类，解耦框架与业务。且 @Conditional 提供按需装配，@ComponentScan 做不到 |
| 证据追问 | 你怎么知道某个 Bean 是哪个 AutoConfiguration 配的？ | --debug 启动看 ConditionEvaluationReport 的 Positive matches；actuator /conditions 端点 JSON 输出；IDEA Spring Boot 插件可视化；查 AutoConfiguration.imports 文件 |
| 边界追问 | 自动配置能处理所有场景吗？ | 不能：动态 Bean（运行时根据数据决定，用 BeanDefinitionRegistryPostProcessor）、条件极其复杂的装配（写代码逻辑）、跨 starter 强依赖顺序（要 @AutoConfigureBefore/After） |
| 反例追问 | 什么时候不该写自动配置？ | 单一项目内部 Bean（直接 @Component）、配置逻辑极简（直接 @Bean）、只为一个业务定制（不是复用场景）。自动配置是为"复用 starter"设计的 |
| 风险追问 | starter 用错最大风险？ | 主动点出：@Conditional 配错导致该装的没装、starter 间顺序依赖冲突（@AutoConfigureBefore 没设）、@ConditionalOnMissingBean 漏写导致业务无法覆盖、默认值不合理（如 HikariCP 默认池大小）、版本兼容（starter 与 Spring Boot 版本不匹配） |
| 验证追问 | 怎么证明 starter 工作正常？ | 用 ApplicationContextRunner 写条件测试（测生效/不生效两种）；集成测试在真实 Spring Boot 应用里验证 Bean 存在；README 给最小示例；CI 跑多版本 Spring Boot 兼容矩阵 |
| 沉淀追问 | 团队写 starter，沉淀什么？ | autoconfigure/starter 模块拆分模板、@ConditionalOnMissingBean 强制规范、@ConfigurationProperties 外部化配置、ApplicationContextRunner 测试模板、版本兼容矩阵、actuator /conditions 排查 SOP |

### 现场对话示例

**面试官**：详细讲讲自动配置原理。

**候选人**：@SpringBootApplication 包含 @EnableAutoConfiguration，它 @Import(AutoConfigurationImportSelector)。启动时 selectImports 方法被调用，读取所有 jar 里的 META-INF/spring.factories（2.7+ 改 AutoConfiguration.imports）文件，收集所有声明的候选 AutoConfiguration 类名。然后用 @Conditional 过滤——对每个候选类，Spring 评估它的 @ConditionalOnClass/OnBean/OnProperty 注解，条件满足才真正注册为 BeanDefinition，进入正常 Bean 生命周期。所以自动配置不是"全加载"，而是"声明所有候选 + 按条件过滤"。比如 DataSourceAutoConfiguration 只有类路径有 MySQL 驱动且没业务自定义 DataSource 时才生效。

**面试官**：@ConditionalOnMissingBean 为什么重要？

**候选人**：它是"业务覆盖框架默认"的扩展点。框架的 AutoConfiguration 定义 Bean 时都加 @ConditionalOnMissingBean，表示"业务方没自己定义这个 Bean 我才提供默认实现"。如果业务方在自己 @Configuration 里 @Bean 同类型 Bean，框架默认就不生效，用业务的。这是 Spring Boot 可扩展性的核心——80% 场景用框架默认（零配置），20% 个性化场景业务自定义覆盖。DataSourceAutoConfiguration、RestTemplateAutoConfiguration 都是这个套路。

**面试官**：2.7 之后 spring.factories 废弃了？

**候选人**：对。2.7 之前用 spring.factories 的 EnableAutoConfiguration 行声明 AutoConfiguration，但它一个文件塞所有类型（还用于 ApplicationListener、EnvironmentPostProcessor 等），混乱。2.7 引入 META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports，每行一个 AutoConfiguration 类，专用清晰。3.0 完全废弃 spring.factories 里的 EnableAutoConfiguration 行，只认 imports 文件。还支持 @AutoConfigureBefore/After 排序注解更清晰。迁移就是新建 imports 文件把类名搬过去。

## 常见考点

1. **starter 为什么拆 autoconfigure 和 starter 两模块？**——autoconfigure 含配置逻辑（@Configuration + @Conditional），可以被业务 exclude 或覆盖；starter 仅 pom 聚合依赖，业务方加依赖即用。拆分便于 autoconfigure 被其他 starter 复用（不强制带入依赖）。
2. **@ConfigurationProperties 和 @Value 区别？**——@ConfigurationProperties 批量绑定前缀下所有属性到 POJO（类型安全、有 IDE 提示、可校验）；@Value 单个注入（`${key}`，灵活但不类型安全）。推荐 @ConfigurationProperties。
3. **怎么禁用某个自动配置？**——`@SpringBootApplication(exclude = XxxAutoConfiguration.class)`、`spring.autoconfigure.exclude=com.xxx.XxxAutoConfiguration`（配置文件）、或 `@EnableAutoConfiguration(exclude = ...)`。
4. **application.yml 和 application.properties 哪个好？**——yml 层级清晰（适合复杂配置）、支持 Profile；properties 简单无格式坑、性能略好。现代项目多选 yml。注意 yml 不支持 @PropertySource 直接加载（要自定义）。


## 结构化回答

**30 秒电梯演讲：** 聊到Spring Boot 自动配置原理与 starter 设计，我的理解是——自动配置的本质是"约定优于配置 + 条件化 Bean 注册"——starter 声明一组 Bean 定义，@Conditional 决定哪些生效，Spring Boot 根据类路径/属性/已存在 Bean 自动装配。让业务方加一个依赖就开箱即用。打个比方，像宜家家具的"智能套装"：你买一个"卧室套装"（starter），里面包含床、衣柜、床头柜（一组 Bean），但只有你卧室有窗户时才送窗帘（@ConditionalOnProperty），只有你已有床垫时才送床单（@ConditionalOnBean）。Spring Boot 的 AutoConfiguration 就是这套智能套装系统。

**展开框架：**
1. **@SpringBootApplica** — @SpringBootApplication = @SpringBootConfiguration + @EnableAutoConfiguration + @ComponentScan
2. **@EnableAutoConfigu** — @EnableAutoConfiguration 通过 SPI 加载 META-INF/spring.factories（2.7+ 改 spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports）
3. **条件注解** — @ConditionalOnClass/OnBean/OnProperty/OnMissingBean/OnWebApplication

**收尾：** 这块我在项目里也踩过坑——想深入的话，可以接着聊：spring.factories 和 AutoConfiguration.imports 区别？您更想看哪个方向？

## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡 | "Spring Boot 自动配置原理与 starte——这道题面试官到底想考什么？我用 30 秒给你讲透。" | 开场钩子 |
| 0:15 | Spring Bean 生命周期图 | 先说核心：自动配置的本质是"约定优于配置 + 条件化 Bean 注册"——starter 声明一组 Bean 定义，@Conditional 决定哪些生效，Spring Boot 根据类。 | 核心定义 |
| 0:30 | 概念结构示意图 | @EnableAutoConfiguration 通过 SPI 加载 META-INF/spring.factories（2.7+ 改 spring/org。 | @EnableAutoConfigu |
| 1:30 | 总结卡 | 一句话记忆：@SpringBootApplication 三合一：Configuration + EnableAutoConfiguration + ComponentScan。 下期可以接着聊：spring.factories 和 AutoConfiguration.imports 区别。 | 收尾总结 |
