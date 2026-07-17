---
id: ant-risk-014
difficulty: L2
category: ant-risk
subcategory: Spring Boot
tags:
- 蚂蚁
- 风控
- Spring Boot
- 自动装配
- SPI
- Conditional
feynman:
  essence: Spring Boot 自动装配通过 spring.factories（或 AutoConfiguration.imports）+ @Conditional 系列注解，让"引入依赖即生效"，约定大于配置。
  analogy: 自动装配像宜家家具的"成套包"——你买一个厨房套装，里面的橱柜、电器、灯具按预设自动配齐，不用你一件件挑。@Conditional 像判断条件（"如果有烤箱就装散热"），按需启用。
  first_principle: Spring 时代要手写一堆 XML/Java 配置才能用组件；自动装配把"组件需要什么 Bean、什么条件启用"封装到 starter 里，引入依赖即按约定装配。
  key_points:
  - "spring.factories（2.7 前）/ AutoConfiguration.imports（2.7+）声明自动配置类"
  - "@ConditionalOnClass / OnMissingBean / OnProperty 按条件装配"
  - "Starter 模式：依赖 + 自动配置 + 默认配置"
  - "@EnableAutoConfiguration → AutoConfigurationImportSelector → 加载配置"
first_principle:
  problem: 如何让一个组件引入依赖后自动接入 Spring 容器，又能在用户需要时覆盖默认行为？
  axioms:
  - 用户只想要"引入即用"
  - 不同环境需要不同配置（如有没有 Redis）
  - 默认配置要可被覆盖
  rebuild: 用 SPI 机制声明候选配置类 + @Conditional 按条件启用 + Bean 覆盖优先级（用户 > 自动配置）。
follow_up:
- 你写过自定义 Starter 吗？——风控的 SDK 都封装成 Starter，引入即用
- "@ConditionalOnMissingBean 怎么实现用户覆盖默认？——用户 Bean 先注册，自动配置 Bean 检测到已存在就不注册"
- "Spring Boot 3 有什么变化？——spring.factories 弃用，改用 AutoConfiguration.imports 文件"
memory_points:
- "自动装配 = spring.factories / AutoConfiguration.imports + @Conditional"
- "@ConditionalOnClass 类路径有就生效、OnMissingBean 没有就生效、OnProperty 配置满足就生效"
- "Starter = 依赖 + 自动配置 + 默认 properties"
- "用户 Bean 优先于自动配置 Bean（@ConditionalOnMissingBean 实现）"
---

# 【蚂蚁风控】Spring Boot 自动装配原理？@SpringBootApplication 干了什么？

> JD 依据："Spring Cloud"（Spring Boot 是基础）。理解自动装配是写风控 SDK 的前提。

## 一、表面层：什么是自动装配

**传统 Spring**：
```xml
<!-- 手写一堆 bean 配置 -->
<bean id="dataSource" class="...HikariDataSource">...</bean>
<bean id="sqlSessionFactory" class="...SqlSessionFactoryBean">...</bean>
<!-- ... 几十行 -->
```

**Spring Boot**：
```yaml
# application.yml
spring:
  datasource:
    url: jdbc:mysql://...
    username: root
```
引入 `mybatis-spring-boot-starter` 依赖，自动配置生效。

## 二、@SpringBootApplication 干了什么

```java
@SpringBootApplication  // = @SpringBootConfiguration + @EnableAutoConfiguration + @ComponentScan
public class RiskApp { ... }
```

三个核心注解：
1. **@SpringBootConfiguration**：标记配置类（容器入口）
2. **@ComponentScan**：扫描当前包及子包的 @Component/@Service/@Controller
3. **@EnableAutoConfiguration**：自动装配（关键）

## 三、@EnableAutoConfiguration 的实现

```java
@Import(AutoConfigurationImportSelector.class)
public @interface EnableAutoConfiguration { }
```

`AutoConfigurationImportSelector.selectImports()` 的核心流程：
```
1. 加载 META-INF/spring.factories（或 2.7+ 的 AutoConfiguration.imports）
   获取所有 EnableAutoConfiguration 的候选类（通常 100+ 个）

2. 过滤（@Conditional 条件判断）：
   - @ConditionalOnClass：类路径有这个类才生效
   - @ConditionalOnMissingBean：容器没有这个 Bean 才生效
   - @ConditionalOnProperty：配置满足才生效

3. 把通过的配置类注册为 Bean
```

## 四、@Conditional 系列注解（关键）

| 注解 | 条件 |
|------|------|
| `@ConditionalOnClass(Xxx.class)` | 类路径有 Xxx 才生效 |
| `@ConditionalOnMissingClass` | 类路径没有才生效 |
| `@ConditionalOnBean(Xxx.class)` | 容器有 Xxx Bean 才生效 |
| `@ConditionalOnMissingBean` | 容器没有才生效（用户覆盖默认的关键） |
| `@ConditionalOnProperty(prefix="x", name="y")` | 配置满足才生效 |
| `@ConditionalOnWebApplication` | 是 Web 应用才生效 |

**示例**：
```java
@Configuration
@ConditionalOnClass({SqlSessionFactory.class, SqlSessionFactoryBean.class})
@ConditionalOnBean(DataSource.class)
@EnableConfigurationProperties(MybatisProperties.class)
public class MybatisAutoConfiguration {

    @Bean
    @ConditionalOnMissingBean  // ← 用户没定义才注册（用户可覆盖）
    public SqlSessionFactory sqlSessionFactory(DataSource ds) throws Exception {
        SqlSessionFactoryBean factory = new SqlSessionFactoryBean();
        factory.setDataSource(ds);
        return factory.getObject();
    }
}
```

## 五、用户覆盖默认的原理

`@ConditionalOnMissingBean` 让用户可以覆盖自动配置：
```java
// 用户自定义（覆盖默认）
@Configuration
public class MyConfig {
    @Bean
    public SqlSessionFactory sqlSessionFactory(DataSource ds) {
        // 用户自定义实现
    }
}
// → MybatisAutoConfiguration 的 sqlSessionFactory 因 @ConditionalOnMissingBean 不生效
```

**Bean 加载顺序**：用户配置 > 自动配置。Spring Boot 通过 `AutoConfigurationOrder` 控制顺序。

## 六、自定义 Starter（风控 SDK 实战）

风控的 SDK 通常封装成 Starter：

**目录结构**：
```
risk-sdk-spring-boot-starter/
├── pom.xml  (依赖 risk-sdk-core)
└── src/main/
    ├── java/com/ant/risk/sdk/autoconfig/
    │   └── RiskAutoConfiguration.java
    └── resources/
        └── META-INF/
            └── spring/
                └── org.springframework.boot.autoconfigure.AutoConfiguration.imports
                (或 2.7 前: spring.factories)
```

**RiskAutoConfiguration.java**：
```java
@AutoConfiguration
@ConditionalOnProperty(prefix = "risk.sdk", name = "enabled", havingValue = "true", matchIfMissing = true)
@EnableConfigurationProperties(RiskProperties.class)
public class RiskAutoConfiguration {

    @Bean
    @ConditionalOnMissingBean
    public RiskClient riskClient(RiskProperties props) {
        return new DefaultRiskClient(props);
    }
}
```

**AutoConfiguration.imports**（2.7+）：
```
com.ant.risk.sdk.autoconfig.RiskAutoConfiguration
```

业务方使用：
```yaml
# application.yml
risk:
  sdk:
    enabled: true
    appkey: xxx
    timeout: 3000
```
```java
@Autowired
private RiskClient riskClient;  // 自动注入
```

## 七、调试自动装配

```bash
# 启动加 --debug 看自动装配报告
java -jar risk-app.jar --debug
```
输出：
```
Positive matches:（生效的）
   MybatisAutoConfiguration matched:
      - @ConditionalOnClass found required classes (OnClassCondition)
      - @ConditionalOnBean found DataSource (OnBeanCondition)

Negative matches:（未生效的）
   RedisAutoConfiguration:
      - @ConditionalOnClass did not find required class 'redis' (OnClassCondition)

Unconditional classes:（无条件生效的）
   ...
```

## 八、底层本质：约定优于配置 + SPI

自动装配的两个底层思想：

**1. 约定优于配置（Convention over Configuration）**：
- 默认值合理（多数人不需要改）
- 命名约定（application.yml、META-INF/spring.factories）
- 减少配置项

**2. SPI（Service Provider Interface）**：
- Java SPI：`META-INF/services/接口全限定名` 列出实现
- Spring Boot 的 SPI：`META-INF/spring.factories` 列出自动配置类
- 解耦：组件提供方声明，框架加载

**和微服务的关系**：Spring Cloud 的一堆组件（Nacos/Sentinel/Feign）都是 Starter 模式，引入即用。风控系统通过组合这些 Starter 快速搭起微服务架构。

## 九、Spring Boot 3 的变化

- `spring.factories` 弃用（仍兼容），改用 `META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports`
- JDK 17+ 基线
- Jakarta EE（javax → jakarta）

**为什么改**：spring.factories 一个文件装所有 SPI（EnableAutoConfiguration / ApplicationListener / ...），耦合；新方式只管自动配置类，更清晰。

## 常见考点
1. **自动装配怎么实现的**？——@Import ImportSelector + 加载 spring.factories/AutoConfiguration.imports + @Conditional 过滤。
2. **用户配置和自动配置的优先级**？——用户优先，@ConditionalOnMissingBean 实现覆盖。
3. **写 Starter 的最佳实践**？——命名 `xxx-spring-boot-starter`（官方）/ `spring-boot-starter-xxx`（非官方）；用 @AutoConfiguration；提供配置类 + properties。

**代码示例**（自定义 Condition）：
```java
// 自定义条件：仅在风控集群环境生效
public class OnRiskClusterCondition implements Condition {
    @Override
    public boolean matches(ConditionContext context, AnnotatedTypeMetadata md) {
        String env = context.getEnvironment().getProperty("risk.env");
        return "cluster".equals(env);
    }
}

@Configuration
@Conditional(OnRiskClusterCondition.class)
public class RiskClusterConfig { ... }
```

## 苏格拉底式面试追问

> 这组追问不是背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：风控的 SDK 你封装成了 Starter（risk-sdk-spring-boot-starter）让业务方引入即用。为什么不用纯 SDK（jar 包 + 手动 new 对象）？Starter 的价值到底是什么？**

纯 SDK 让每个业务方自己写初始化代码——`RiskClient client = new RiskClient(); client.setAppkey(...); client.setTimeout(...);`，几十个业务方写几十遍，配置项不一致（有的设 timeout=1000、有的设 3000）、初始化方式不一致（有的手动 new、有的塞进 Spring）、升级时每个业务方改代码。Starter 把这些统一起来——引入依赖自动装配 RiskClient Bean，配置走 application.yml（`risk.sdk.timeout=3000`），默认值由 SDK 团队统一维护，升级时只改 SDK 版本号。价值是"配置收口 + 升级无感"。决策依据是治理成本——纯 SDK 模式下 SDK 团队每周要帮 3-5 个业务方排查"为什么初始化错"，Starter 模式后降到每月 1 个。

### 第二层：证据与定位

**Q：业务方反馈引入 risk-sdk-spring-boot-starter 后 RiskClient 没注入（@Autowired 报 NoSuchBeanDefinitionException）。你怎么定位是 Starter 没生效还是别的？**

三步定位：
1. 让业务方启动时加 `--debug` 参数——Spring Boot 会打印自动装配报告（AutoConfiguration Report）。搜 `RiskAutoConfiguration`，如果在 "Negative matches" 里，会显示哪个 @Conditional 没满足。常见是 `@ConditionalOnProperty(prefix="risk.sdk", name="enabled")` 没配（业务方漏了 `risk.sdk.enabled=true`），或 `@ConditionalOnClass` 找不到类（依赖冲突导致 risk-sdk-core 没引入）。
2. 检查 AutoConfiguration.imports 文件——`jar tf risk-sdk-spring-boot-starter.jar | grep AutoConfiguration.imports`，确认 `META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports` 存在且内容是 `com.ant.risk.sdk.autoconfig.RiskAutoConfiguration`。如果文件缺失或路径错（如放成 spring.factories 但用 Spring Boot 3），Starter 不被加载。
3. 检查包扫描——如果 RiskAutoConfiguration 在 `com.ant.risk.sdk` 包，但业务方的 @SpringBootApplication 在 `com.ant.biz` 且没扫到，且没走 AutoConfiguration.imports（走了 @ComponentScan），会漏。自动配置类应该走 imports 声明，不依赖 @ComponentScan。用 arthas `sc com.ant.risk.sdk.autoconfig.RiskAutoConfiguration` 看类是否被加载。

### 第三层：根因深挖

**Q：你发现是业务方的 application.yml 里 `risk.sdk.enabled=false`（误配），导致 RiskAutoConfiguration 的 @ConditionalOnProperty 不满足。根因是配置项默认值不友好？为什么不默认开启？**

这要看 Starter 设计哲学。`risk.sdk.enabled` 默认 false（matchIfMissing=false）是"显式启用"策略，防止业务方"不知情引入"。但风控 SDK 是核心依赖（不引入就没法接入风控），默认 false 反而制造坑——业务方以为引入依赖就生效，实际还要配 enabled=true。根因是"配置项默认值设计与业务场景不匹配"。正确做法是分场景：核心能力默认开启（matchIfMissing=true，引入即用），可选能力默认关闭（如风险审计日志，默认关，要审计的业务方显式开）。我们的 `risk.sdk.enabled` 应该 matchIfMissing=true（默认开），想关闭的业务方显式配 `risk.sdk.enabled=false`。改完后统计 enabled 配置错误导致的工单应降到 0。

**Q：根因是默认值设计。那为什么不直接去掉 enabled 配置项？反正核心能力都要开。**

去掉更简洁，但失去了"紧急关闭"的能力。风控 SDK 偶发有 bug 时，业务方需要快速关闭风控调用（走降级），这时 `risk.sdk.enabled=false` 一行配置（配合配置中心热更新）就能关，不用改代码重新发布。如果去掉 enabled，关闭要走"注释代码 + 重新打包 + 发布"，慢。所以保留 enabled 但默认开启（matchIfMissing=true）是最优——平时开、紧急时一行配置关。这是"逃生通道"的设计，类似熔断器的"手动强制 OPEN"开关。

### 第四层：方案权衡

**Q：你的 RiskAutoConfiguration 用 @ConditionalOnMissingBean 让业务方可以覆盖默认 RiskClient。但业务方覆盖后出问题（如他们 new 的 RiskClient 配错参数），SDK 团队要背锅。怎么权衡可扩展性和可控性？**

权衡方案是"开放扩展点但限定边界"。@ConditionalOnMissingBean 完全开放（业务方可以 new 任何 RiskClient），失控风险大。更稳的做法是提供"策略接口 + 默认实现"——SDK 定义 `RiskClientCustomizer` 接口，业务方实现它来定制（如改 timeout、加拦截器），而不是直接替换整个 RiskClient。RiskAutoConfiguration 注入所有 Customizer，在创建默认 RiskClient 时应用它们。这样业务方能定制（满足个性化），但 RiskClient 的创建和初始化仍由 SDK 控制（保证核心逻辑不被破坏）。代价是定制能力受限（只能改 SDK 暴露的点），但对风控 SDK 这种"核心逻辑敏感"的场景，可控性比灵活性重要。只有当业务方确实需要完全替换（如用 mock 做测试），才用 @ConditionalOnMissingBean 兜底。

**Q：为什么不直接把 RiskClient 设成 final 类 + 构造器注入，禁止业务方覆盖？最简单可控。**

final 类 + 构造器注入确实最可控，但完全封闭会逼业务方"绕过 SDK"（如自己发 HTTP 调风控接口），反而失控。风控场景的真实需求：大部分业务方用默认配置即可（80%），少数大客户要定制（如银行客户要加自己的签名逻辑、加审计日志）。完全封闭会让这 20% 的大客户无法接入，流失业务。所以"核心逻辑封闭（RiskClient 内部流程不变）+ 扩展点开放（Customizer 接口定制行为）"是平衡——80% 用默认、20% 通过扩展点定制、0% 绕过 SDK（因为 SDK 足够灵活）。

### 第五层：验证与沉淀

**Q：你怎么验证 Starter 在不同业务方的 Spring Boot 版本（2.4/2.7/3.0）都能正确装配？怎么自动化测试？**

矩阵式自动化测试：
1. 多版本兼容性测试——在 CI 里建一个测试矩阵，针对 Spring Boot 2.4/2.7/3.0 + JDK 8/11/17 各组合，用 testcontainers 起一个最小 Spring Boot 应用，引入 risk-sdk-spring-boot-starter，启动后断言 `RiskClient` Bean 存在（`@SpringBootTest` + `@Autowired RiskClient`）。任何组合装配失败，CI 红灯。重点测 spring.factories（2.4-2.6）和 AutoConfiguration.imports（2.7+）的兼容。
2. 条件覆盖测试——用 ApplicationContextRunner（Spring Boot 的测试工具）模拟各种条件（有/无配置、有/无类），断言 @Conditional 的行为。如 `new ApplicationContextRunner().withPropertyValues("risk.sdk.enabled=false").run(context -> assertThat(context).doesNotHaveBean(RiskClient.class))`。
3. 自动装配报告校验——启动测试应用时加 --debug，解析自动装配报告，断言 RiskAutoConfiguration 在 "Positive matches"（正常）或验证特定条件下在 "Negative matches"。

**Q：怎么让团队的 Starter 都规范、不踩坑？**

沉淀成规范和模板：
1. Starter 脚手架——提供 risk-sdk-starter-template 脚手架项目，包含标准目录结构、AutoConfiguration 模板、properties 类、AutoConfiguration.imports 文件、多版本兼容测试。新 Starter 基于模板创建，强制规范。
2. 命名规范——官方 Starter 命名 `risk-xxx-spring-boot-starter`（第三方格式），禁止用 `spring-boot-starter-xxx`（官方保留格式）。CI 校验 artifactId 命名。
3. 配置项规范——所有配置项必须有默认值（properties 类里 @DefaultValue）、必须文档化（properties 类的 Javadoc 自动生成配置文档）、核心开关默认开（matchIfMissing=true）、可选开关默认关。
4. 自动装配报告 review——Starter 发布前，在示例应用跑 --debug，review 自动装配报告，确认 RiskAutoConfiguration 的 @Conditional 合理（不要因为无关条件误触发或误不触发）。
5. 故障复盘——把这次"enabled 默认 false 导致业务方 NoSuchBeanDefinition"的自动装配报告截图、配置项规范存知识库，作为"Starter 配置项默认值设计"的案例。


## 结构化回答

**30 秒电梯演讲：** 聊到Spring Boot 自动装配原理，我的理解是——Spring Boot 自动装配通过 spring.factories（或 AutoConfiguration.imports）+ @Conditional 系列注解，让"引入依赖即生效"，约定大于配置。打个比方，自动装配像宜家家具的"成套包"——你买一个厨房套装，里面的橱柜、电器、灯具按预设自动配齐，不用你一件件挑。@Conditional 像判断条件（"如果有烤箱就装散热"），按需启用。

**展开框架：**
1. **spring.factories（2.7 前）** — spring.factories（2.7 前）/ AutoConfiguration.imports（2.7+）声明自动配置类
2. **@ConditionalOnClas** — @ConditionalOnClass / OnMissingBean / OnProperty 按条件装配
3. **Starter 模式** — 依赖 + 自动配置 + 默认配置

**收尾：** 这块我在项目里也踩过坑——想深入的话，可以接着聊：你写过自定义 Starter 吗？您更想看哪个方向？

## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡 | "Spring Boot 自动装配原理——这道题面试官到底想考什么？我用 30 秒给你讲透。" | 开场钩子 |
| 0:15 | Spring Bean 生命周期图 | 先说核心：Spring Boot 自动装配通过 spring.factories（或 AutoConfiguration.imports）+ @Conditional 系列注解，让"引入。 | 核心定义 |
| 0:30 | 概念结构示意图 | @ConditionalOnClass / OnMissingBean / OnProperty 按条件装配。 | @ConditionalOnClas |
| 1:30 | 总结卡 | 一句话记忆：自动装配 = spring.factories / AutoConfiguration.imports + @Conditional。 下期可以接着聊：你写过自定义 Starter 吗。 | 收尾总结 |
