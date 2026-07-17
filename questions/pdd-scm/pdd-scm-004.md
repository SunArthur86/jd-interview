---
id: pdd-scm-004
difficulty: L2
category: pdd-scm
subcategory: Spring Boot
tags:
- 拼多多
- 供应链
- Spring Boot
- 自动装配
- Starter
feynman:
  essence: Spring Boot 自动装配通过 spring.factories / AutoConfiguration.imports + @Conditional 系列注解，让"引入依赖即生效"，约定大于配置；风控/供应链的 SDK 都封装成 Starter。
  analogy: 自动装配像宜家家具成套包——买一个厨房套装，橱柜电器灯具按预设配齐，不用一件件挑；@Conditional 像"如果有烤箱就装散热"的按需启用。
  first_principle: 用户只想"引入即用"，框架应该自动配置合理的默认值，又允许用户覆盖。
  key_points:
  - "@SpringBootApplication = @SpringBootConfiguration + @EnableAutoConfiguration + @ComponentScan"
  - "AutoConfiguration.imports（2.7+）声明自动配置类"
  - "@ConditionalOnClass / OnMissingBean / OnProperty 按条件装配"
  - "用户 Bean 优先于自动配置（@ConditionalOnMissingBean 实现）"
first_principle:
  problem: 如何让一个组件引入依赖后自动接入 Spring 容器，又能在用户需要时覆盖默认行为？
  axioms:
  - 用户只想要"引入即用"
  - 不同环境需要不同配置
  - 默认配置要可被覆盖
  rebuild: SPI 声明候选配置类 + @Conditional 按条件启用 + Bean 覆盖优先级（用户 > 自动配置）。
follow_up:
- 写过自定义 Starter 吗？——供应链的 SDK（商品查询、库存扣减）都封装成 Starter
- "@ConditionalOnMissingBean 怎么实现覆盖？——用户 Bean 先注册，自动配置检测到已存在就不注册"
- Spring Boot 3 变化？——spring.factories 弃用，改 AutoConfiguration.imports；JDK 17；Jakarta
memory_points:
- 自动装配 = AutoConfiguration.imports + @Conditional
- "@ConditionalOnClass 有就装、OnMissingBean 没有才装、OnProperty 配置满足才装"
- Starter = 依赖 + 自动配置 + 默认 properties
- 用户 Bean 优先于自动配置 Bean
---

# 【拼多多供应链】Spring Boot 自动装配原理？怎么写自定义 Starter？

> JD 依据："熟悉 Spring Boot/Spring Cloud 等主流开发框架"。

## 一、@SpringBootApplication 干了什么

```java
@SpringBootApplication  // = 三个注解组合
public class ScmApplication { }
```
- `@SpringBootConfiguration`：标记配置类
- `@ComponentScan`：扫描当前包及子包的 @Component
- `@EnableAutoConfiguration`：**自动装配核心**

## 二、自动装配流程

```
@EnableAutoConfiguration
   ↓ @Import(AutoConfigurationImportSelector.class)
加载 META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports
（2.7 前是 spring.factories，3.0 弃用）
   ↓ 获取所有候选配置类（100+）
@Conditional 条件过滤
   ├─ @ConditionalOnClass（类路径有才生效）
   ├─ @ConditionalOnMissingBean（容器没有才生效）
   └─ @ConditionalOnProperty（配置满足才生效）
   ↓
注册通过的配置类为 Bean
```

## 三、自定义 Starter（供应链 SDK 实战）

**场景**：把"商品查询 SDK"封装成 Starter，业务方引入即用。

**目录结构**：
```
pdd-scm-sdk-spring-boot-starter/
├── src/main/java/com/pdd/scm/sdk/autoconfig/
│   └── ScmAutoConfiguration.java
└── src/main/resources/META-INF/spring/
    └── org.springframework.boot.autoconfigure.AutoConfiguration.imports
```

**ScmAutoConfiguration.java**：
```java
@AutoConfiguration
@ConditionalOnProperty(prefix = "scm.sdk", name = "enabled", matchIfMissing = true)
@EnableConfigurationProperties(ScmProperties.class)
public class ScmAutoConfiguration {
    @Bean
    @ConditionalOnMissingBean
    public ProductClient productClient(ScmProperties props) {
        return new DefaultProductClient(props.getAppKey(), props.getTimeout());
    }
}
```

**AutoConfiguration.imports**：
```
com.pdd.scm.sdk.autoconfig.ScmAutoConfiguration
```

**业务方使用**：
```yaml
scm:
  sdk:
    app-key: xxx
    timeout: 3000
```
```java
@Autowired
private ProductClient productClient;  // 自动注入
```

## 四、用户覆盖默认的原理

`@ConditionalOnMissingBean` 让用户可覆盖：
```java
// 用户自定义（覆盖默认）
@Bean
public ProductClient productClient() {
    return new MyCustomProductClient();  // 自动配置的就不生效了
}
```

## 五、调试自动装配

```bash
java -jar scm-app.jar --debug
# 输出 Positive matches（生效）/ Negative matches（未生效）报告
```

## 六、底层本质：约定优于配置 + SPI

自动装配的两个底层思想：
1. **约定优于配置**：合理默认值（多数人不用改）+ 命名约定（application.yml）
2. **SPI 解耦**：组件方声明（imports 文件），框架加载

**和供应链 DDD 的关系**：DDD 关注业务建模，Starter 关注技术组件复用，二者正交——DDD 划业务边界，Starter 划技术组件边界。

## 常见考点
1. **自动装配怎么实现**？——@Import ImportSelector + 加载 imports 文件 + @Conditional 过滤。
2. **写 Starter 最佳实践**？——命名 `xxx-spring-boot-starter`；用 @AutoConfiguration；提供 properties 类；用 @ConditionalOnMissingBean 允许覆盖。
3. **Spring Boot 3 的变化**？——spring.factories 弃用；JDK 17 基线；javax→jakarta。

## 苏格拉底式面试追问

> 这组追问不是背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：你把商品查询 SDK 封装成 Starter，业务方引入依赖就能用。为什么不直接给个 Jar 包让他们自己 new 对象？Starter 比裸 Jar 好在哪？**

好三点：
1. **配置统一**——裸 Jar 的话，10 个业务方会有 10 种超时配置（有的 1s 有的 30s），出问题难排查。Starter 通过 `@ConfigurationProperties` 把 `scm.sdk.timeout` 收敛到一份配置，统一治理。
2. **依赖收敛**——Starter 把 HTTP 客户端（OkHttp）、序列化（Jackson）、监控（Micrometer）都锁版本打包，业务方不会因为自己引了冲突版本（如 Jackson 2.13 vs 2.15）出 `NoSuchMethodError`。
3. **可观测性内置**——Starter 在装配时自动给 ProductClient 加 Micrometer 指标（`product.query.count`、`product.query.latency`），裸 Jar 业务方各自埋点，数据格式不一致。

### 第二层：证据与定位

**Q：业务方反馈"引入了你的 Starter 但 ProductClient 注入失败，报 NoSuchBeanDefinitionException"。你怎么定位是哪一步出了问题？**

用 Spring Boot 的 `--debug` 报告 + 条件日志：
1. **启动加 `--debug`**——看 Conditions Evaluation Report，搜 `ScmAutoConfiguration`，如果它在 Negative matches 里，会写明被哪个条件排除（如 `@ConditionalOnProperty scm.sdk.enabled=false` 或 `@ConditionalOnClass 找不到 Xxx`）。
2. **看 AutoConfiguration.imports 是否被加载**——`actuator/conditions` 端点能看到所有候选配置类的匹配情况，如果 ScmAutoConfiguration 压根没出现在列表，说明 imports 文件路径不对（必须是 `META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports`）或类全限定名拼错。
3. **看 Bean 是否被覆盖**——如果 Positive matches 有，但注入还是失败，可能是 `@ConditionalOnMissingBean` 逻辑反了，或者业务方自己定义了同名 Bean 但类型不符。

### 第三层：根因深挖

**Q：定位后发现 ScmAutoConfiguration 在 Negative matches，原因是 `@ConditionalOnClass` 找不到 `OkHttpClient`。但你的依赖树里明明有 OkHttp，为什么 ConditionalOnClass 失败？**

根因是**Starter 的依赖 scope 写错了**。OkHttp 在 pom 里写成了 `<scope>provided</scope>` 或 `<scope>optional</scope>`，导致它不会被传递给业务方——业务方的类路径里没有 OkHttp，`@ConditionalOnClass(OkHttpClient.class)` 判定为 false，整个配置类被跳过。`@ConditionalOnClass` 是用 ASM 读字节码判断类是否在类路径，不是运行时 `Class.forName`，所以 scope 漏传它就感知不到。修复是把 OkHttp 改成 `compile`（默认）scope，让依赖正常传递。

**Q：那为什么不直接去掉 @ConditionalOnClass，让它一定生效？**

去掉会有更严重的启动失败。如果业务方真的没引 OkHttp（比如他们用 Apache HttpClient），去掉条件后 Spring 会尝试加载 ScmAutoConfiguration，`productClient()` 方法里 `new OkHttpClient()` 直接抛 `NoClassDefFoundError`，整个 Spring 上下文初始化失败，应用起不来。`@ConditionalOnClass` 的意义就是"优雅降级"——没有依赖就跳过配置（让业务方用其他方式），而不是硬启动失败。这是"约定优于配置"的容错设计。

### 第四层：方案权衡

**Q：你的 Starter 用 @ConditionalOnMissingBean 让业务方能覆盖默认 ProductClient。但业务方覆盖后，你 Starter 里内置的 Micrometer 监控就丢了，怎么办？**

这是覆盖机制的副作用。解法是把"监控"和"客户端实现"分离：
1. **用 BeanPostProcessor 而非 @Bean**——不要在 `productClient()` 上加监控，而是写个 `MonitorBeanPostProcessor`，在 `postProcessAfterInitialization` 里对所有 `ProductClient` 类型的 Bean 包一层代理（加计时埋点）。这样不管业务方覆盖成什么实现，代理都会生效。
2. **用 AOP 切面**——`@Aspect` 切 `ProductClient.*(..)` 方法，业务方换实现只要还是 ProductClient 接口，切面照常织入。推荐用 BeanPostProcessor，因为它不依赖 Spring AOP（有些项目关 AOP 代理）。

**Q：为什么不用 @Primary 强制让 Starter 的 Bean 优先？**

`@Primary` 会让业务方永远无法覆盖——它表示"多个同类型 Bean 时优先选我"，业务方就算自己定义了也会被 @Primary 盖过去。这违背了"用户优先于自动配置"的 Spring Boot 核心原则。Starter 的设计哲学是"提供合理默认，但永远让用户能 override"，`@ConditionalOnMissingBean`（容器里没有才注册）才是正确姿势，`@Primary`（强制选我）是反模式。

### 第五层：验证与沉淀

**Q：你的 Starter 发给 20 个业务方用了，怎么保证某个 Starter 版本升级后不会把大家的启动搞挂？**

三道防线：
1. **Spring Boot 版本兼容矩阵测试**——CI 里跑 Spring Boot 2.7/3.0/3.2 三个版本 × JDK 11/17/21 三个版本，每个组合都能启动 + 注入 ProductClient。
2. **@ConditionalOnClass 演进策略**——新版 Starter 要换底层库（如 OkHttp→Apache HttpClient），必须保留旧 Conditional 让旧用户无感；新增功能用 `@ConditionalOnProperty enabled=false` 默认关，用户主动开。
3. **启动契约测试**——用 Spring Boot Test 的 `@SpringBootTest` 写最小启动用例，每个 release 跑一遍，保证 ApplicationContext 能正常启动、核心 Bean 可注入。

**Q：怎么让团队写 Starter 时遵循最佳实践，而不是各写各的？**

沉淀一份 Starter 脚手架 + 规范：
1. **脚手架模板**——`archetype:generate` 生成标准目录（`autoconfig/`、`META-INF/spring/...imports`、`@ConfigurationProperties`、`@ConditionalOnMissingBean`），新人基于模板改，不会漏关键注解。
2. **命名规范**——官方 Starter 叫 `spring-boot-starter-xxx`（官方命名），第三方叫 `xxx-spring-boot-starter`，强制用后者避免混淆。
3. **Starter 准入清单**——CR 检查项：必须有 `@AutoConfiguration`、必须用 `AutoConfiguration.imports`（不能退回 spring.factories）、必须提供 properties 类、必须有集成测试证明可注入。

## 结构化回答

**30 秒电梯演讲：** 如何让一个组件引入依赖后自动接入 Spring 容器，又能在用户需要时覆盖默认行为？简单说就是——Spring Boot 自动装配通过 spring.factories / AutoConfiguration.imports + @Conditional 系列注解，让"引入依…。

**展开框架：**
1. **@Sprin** — @SpringBootApplication = @SpringBootConfiguration + @EnableAutoConfiguration + …
2. **AutoCo** — AutoConfiguration.imports（2.7+）声明自动配置类
3. **@Condi** — @ConditionalOnClass / OnMissingBean / OnProperty 按条件装配

**收尾：** 您看这块要不要再展开聊聊？

## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：Spring Boot 自动装配原理？怎么写自定义 Starter？ | 今天聊「Spring Boot 自动装配原理？怎么写自定义 Starter？」。一句话：Spring Boot 自动装配通过 spring.factories / AutoConfiguration.imp… | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：@SpringBootApplication = @SpringBootConfiguration + @EnableAutoConfig… | 核心概念 |
| 1:00 | 能力/参数拆解表 | 要点是：AutoConfiguration.imports（2.7+）声明自动配置类 | 能力拆解 |
| 2:00 | 总结卡 + 下期预告 | 记住核心要点就够了。下期见。 | 收尾 |
