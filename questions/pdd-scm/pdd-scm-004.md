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
