---
id: pdd-ai-005
difficulty: L3
category: pdd-ai
subcategory: Spring Boot
tags:
- 拼多多
- AI 中台
- Spring Boot
- 自动装配
- Starter
- 模型服务
feynman:
  essence: Spring Boot 自动装配是"约定优于配置"——引入 Starter 依赖，Spring 通过 SPI（spring.factories / AutoConfiguration.imports）自动注册 Bean，业务零配置即用。
  analogy: 像买精装房——开发商（Starter）按标准装好水电（Bean），你拎包入住（直接用），不用自己拉线装管。
  first_principle: 配置多了人容易错、易遗漏；约定优于配置 + 自动扫描注册能消除样板代码。
  key_points:
  - '@SpringBootApplication = 配置 + 启动 + 组件扫描'
  - '@EnableAutoConfiguration 读 spring.factories（2.7-）/AutoConfiguration.imports（2.7+）'
  - '@Conditional 决定是否装配（OnClass/OnBean/OnProperty）'
  - Starter 工程：依赖 + AutoConfig + properties 配置类
first_principle:
  problem: 怎么让框架"开箱即用"且能按需装配？
  axioms:
  - 依赖存在说明要用
  - 配置类能自己声明何时生效（条件）
  - 默认约定能覆盖 80% 场景
  rebuild: Starter（打包依赖）+ AutoConfiguration（条件注册 Bean）+ properties（可覆盖默认）。
follow_up:
  - 怎么排查 Bean 没装配？——启动 --debug 看条件报告 / 看 spring.factories 是否扫描
  - 怎么覆盖默认配置？——application.yml 配 properties / @Primary 自定义 Bean
  - 2.7 为什么改 AutoConfiguration.imports？——spring.factories 全扫描慢，新方案更精简
memory_points:
  - '@SpringBootApplication 三合一'
  - spring.factories（旧）/AutoConfiguration.imports（2.7+）
  - '@ConditionalOnXxx 控制装配条件'
  - Starter = 依赖 + AutoConfig + properties
---

# 【拼多多 AI 中台】Spring Boot 自动装配原理与模型服务 Starter 怎么设计？

> JD 依据："Java + 微服务、模型服务"。

## 一、@SpringBootApplication 三合一

```java
@SpringBootApplication  // = 以下三个
@SpringBootConfiguration  // 配置类（@Configuration）
@EnableAutoConfiguration  // 自动装配入口
@ComponentScan            // 组件扫描（当前包及子包）
public class App { public static void main(String[] args) { SpringApplication.run(App.class, args); } }
```

## 二、自动装配流程

```
1. @EnableAutoConfiguration
   ↓ 通过 @Import(AutoConfigurationImportSelector.class)
2. AutoConfigurationImportSelector.selectImports()
   ↓ 读配置文件（SPI）
   2.7 之前：META-INF/spring.factories
       key=EnableAutoConfiguration，value=配置类列表
   2.7+：META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports
       一行一个配置类（更精简）
3. 对每个候选 AutoConfiguration 类，按 @Conditional 决定是否生效
4. 生效的 AutoConfiguration 里的 @Bean 被注册到容器
```

## 三、@Conditional 条件族

| 注解 | 条件 |
|------|------|
| `@ConditionalOnClass` | 类路径存在某类 |
| `@ConditionalOnMissingBean` | 容器中无某 Bean（用户没自定义才用默认） |
| `@ConditionalOnBean` | 容器中有某 Bean |
| `@ConditionalOnProperty` | 配置某 key（如 `prefix.enabled=true`） |
| `@ConditionalOnWebApplication` | 是 Web 应用 |
| `@ConditionalOnExpression` | SpEL 表达式 |

```java
@Configuration
@ConditionalOnClass(TritonClient.class)              // 有这个类才装配
@ConditionalOnProperty(prefix = "pdd.triton", name = "enabled", havingValue = "true", matchIfMissing = true)
@EnableConfigurationProperties(TritonProperties.class)
public class TritonAutoConfiguration {

    @Bean
    @ConditionalOnMissingBean                          // 用户没自定义才注册
    public TritonClient tritonClient(TritonProperties props) {
        return new TritonClient(props.getEndpoint(), props.getTimeout());
    }
}
```

## 四、设计一个模型服务 Starter

**目录**：
```
pdd-llm-starter/
├── src/main/java/com/pdd/ai/llm/
│   ├── LlmAutoConfiguration.java        // 自动装配
│   ├── LlmProperties.java                // 配置类
│   ├── LlmClient.java                    // 核心客户端
│   └── LlmTemplate.java                  // 模板封装
├── src/main/resources/
│   └── META-INF/spring/
│       └── org.springframework.boot.autoconfigure.AutoConfiguration.imports
└── pom.xml
```

**配置类**：
```java
@ConfigurationProperties(prefix = "pdd.llm")
public class LlmProperties {
    private String endpoint = "http://localhost:8080";
    private int timeout = 30000;
    private String defaultModel = "qwen-72b";
    private boolean enabled = true;
    // getter/setter
}
```

**AutoConfiguration.imports 内容**：
```
com.pdd.ai.llm.LlmAutoConfiguration
```

**业务方使用**（零配置）：
```xml
<dependency>
    <groupId>com.pdd.ai</groupId>
    <artifactId>pdd-llm-starter</artifactId>
</dependency>
```
```java
@Autowired LlmClient llmClient;
String ans = llmClient.chat("你好");
```

可选覆盖：
```yaml
pdd:
  llm:
    endpoint: http://llm-gateway.pdd.com
    default-model: glm-4
```

## 五、自动装配 vs XML 配置对比

| 维度 | XML 配置 | 自动装配 |
|------|----------|----------|
| 配置量 | 多（手写 Bean） | 少（约定默认） |
| 错误排查 | 直白 | 隐晦（要 debug 报告） |
| 灵活性 | 高（任何 Bean） | 受 Conditional 约束 |
| 开发效率 | 低 | 高 |

## 六、底层本质

Spring Boot 自动装配本质是**"用 SPI + 条件注解实现按需装配"**——框架在 ClassPath/META-INF 声明能力，运行时根据条件自动注册 Bean，业务方引入依赖即用。这是"约定优于配置"思想的工程落地，是中台/平台化（统一封装能力给业务）的核心机制。

## 常见考点

1. **怎么排查 Bean 没装配**？——启动加 `--debug`，看 `Conditions Evaluation Report`，确认 Conditional 是否满足。
2. **Starter 的 properties 怎么有提示**？——加 `spring-boot-configuration-processor`，编译时生成 `additional-spring-configuration-metadata.json`，IDE 自动补全。
3. **多个 AutoConfiguration 怎么排序**？——`@AutoConfigureBefore/After/@Order`，避免循环依赖。
