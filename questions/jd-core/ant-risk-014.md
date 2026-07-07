---
id: ant-risk-014
difficulty: L2
category: jd-core
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
