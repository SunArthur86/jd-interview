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

## 苏格拉底式面试追问

> 这组追问不背答案，模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：你们设计的 pdd-llm-starter 为什么要用 `@ConditionalOnMissingBean` 让用户能覆盖默认的 LlmClient，而不是直接用 `@Primary` 标注你们的优势？这样不是让用户更容易踩坑吗？**

Starter 的设计哲学是"约定优于配置，但允许 escape hatch"。大部分业务方用默认 LlmClient（指向默认 endpoint）就够了，20% 的业务方有定制需求（比如要加自定义的重试逻辑、或指向自部署的 LLM 集群）。用 `@Primary` 强制优先，用户想覆盖就要想办法排除 Bean（`@SpringBootApplication(exclude=...)`），侵入性强。`@ConditionalOnMissingBean` 是"如果你没定义我就提供默认，你定义了我就让位"，符合"开箱即用 + 可扩展"的平衡。踩坑的根因不是这个注解，而是用户不知道默认 Bean 的全限定名——这个通过文档和 `spring-boot-configuration-processor` 生成的元数据解决。

### 第二层：证据与定位

**Q：业务方反馈引入了 pdd-llm-starter 后 `@Autowired LlmClient` 注入失败，报 `NoSuchBeanDefinitionException`。你怎么排查？**

启动时加 `--debug` 参数（或 `--logging.level.org.springframework.boot.autoconfigure=DEBUG`），Spring Boot 会打印 `Conditions Evaluation Report`，列出所有 AutoConfiguration 类和每个 `@Conditional` 的匹配结果。重点看：第一，`LlmAutoConfiguration` 是否出现在 report 里——如果没出现，说明 `AutoConfiguration.imports` 文件没被扫描到（路径错了，应该在 `META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports`）。第二，如果出现了但标记为 `NEGATIVE_MATCH`，看具体哪个条件没满足——`@ConditionalOnClass(TritonClient.class)` 如果是 `false`，说明 starter 的依赖没引入（pom 缺 `triton-client`）；`@ConditionalOnProperty(prefix="pdd.llm", name="enabled", havingValue="true")` 如果是 `false`，说明业务方的 application.yml 里 `pdd.llm.enabled` 没设或设成了 false（注意 `matchIfMissing=true` 才能默认生效）。第三，如果 AutoConfiguration 生效了但 Bean 还是没注入，用 Actuator 的 `/beans` 端点看容器里到底有没有 `llmClient`。

### 第三层：根因深挖

**Q：Conditions Evaluation Report 显示 LlmAutoConfiguration 是 POSITIVE_MATCH，但 LlmClient 还是没注入。业务方说他们确实定义了一个同名的 Bean。这是什么问题？**

这是 Bean 覆盖冲突。业务方定义了自己的 `llmClient` Bean（可能是同名或同类型），Spring 容器里有两个同类型的 Bean，`@Autowired` 按类型注入会报 `NoUniqueBeanDefinitionException`。但如果业务方的 Bean 名字也叫 `llmClient`，而我们的 `@ConditionalOnMissingBean` 没生效（因为加载顺序问题——业务方的 `@Configuration` 先于我们的 AutoConfiguration 被处理，但 `@ConditionalOnMissingBean` 是在 AutoConfiguration 解析时判断的，此时业务 Bean 可能还没注册）。根因是 `@ConditionalOnMissingBean` 的判断时机——它在当前 AutoConfiguration 类被处理时检查容器，如果业务方的 `@Configuration` 加载顺序在我们之后，`@ConditionalOnMissingBean` 会误判为"没有"而注册默认 Bean，导致冲突。

**Q：那为什么不用 `@AutoConfigureBefore` 强制让我们的 AutoConfiguration 在业务的之前/之后处理，解决顺序问题？**

`@AutoConfigureBefore/After` 只能控制 AutoConfiguration 之间的顺序，不能控制用户 `@Configuration` 和 AutoConfiguration 的顺序——用户的 `@Configuration`（被 `@ComponentScan` 扫到）总是在 AutoConfiguration 之前处理（因为 `@ComponentScan` 在 `refresh` 的早期，AutoConfiguration 在后期通过 `AutoConfigurationImportSelector` 注入）。正确的解法是：第一，用 `@ConditionalOnMissingBean` 时加 `value = LlmClient.class` 明确指定类型（不只是方法名匹配）。第二，Spring Boot 2.1+ 默认禁止 Bean 覆盖（`spring.main.allow-bean-definition-overriding=false`），如果冲突会直接报错而不是静默覆盖，业务方会及早发现。第三，文档里明确写"如果你想覆盖默认 LlmClient，请定义一个返回 `LlmClient` 类型的 @Bean"，避免同名歧义。

### 第四层：方案权衡

**Q：你们 starter 用 `@ConfigurationProperties` 绑定配置，业务方在 yml 里配 `pdd.llm.endpoint` 没有代码提示。为什么不直接用 `@Value`？**

`@Value` 没有类型安全（配错类型启动时才报错）、不支持松散绑定（`default-model` 要写成 `defaultModel`）、不支持校验。`@ConfigurationProperties` 配合 `spring-boot-configuration-processor`（编译时生成 `additional-spring-configuration-metadata.json`）能让 IDE（IntelliJ）自动补全和文档提示。业务方没看到提示，是因为我们 starter 的 pom 里漏了 `configuration-processor` 依赖（它是 optional 的，不主动加就没有）。加上之后重新发版，业务方就能在 yml 里看到每个配置项的默认值、类型和说明。

**Q：为什么不把 LlmClient 直接 new 出来放在 `@ComponentScan` 能扫到的包里，非要用 AutoConfiguration + Starter 这套复杂机制？**

直接 `@ComponentScan` 扫描的问题是"包路径耦合"——业务方必须把 starter 的包加入扫描范围（`@ComponentScan("com.pdd.ai.llm")`），否则扫不到。而且如果多个 starter 都这么做，包冲突和意外扫描很常见。Starter + AutoConfiguration 机制是 Spring Boot 官方的"模块化 Bean 注册"标准——通过 `META-INF/spring/...imports` 声明配置类，Spring Boot 统一加载，业务方只需要引入 Maven 依赖，不需要关心包路径。这套机制虽然理解成本高，但解耦彻底、符合生态约定。复杂度换的是可维护性和标准化。

### 第五层：验证与沉淀

**Q：你怎么证明 starter 的自动装配在业务方真的生效了？线上没报错不代表用了你们的 LlmClient。**

三个验证手段。第一，让业务方开启 Actuator 的 `/conditions` 端点（`management.endpoints.web.exposure.include=conditions`），访问 `GET /actuator/conditions`，搜索 `LlmAutoConfiguration`，确认 `positiveMessage` 和哪些 `@Bean` 被注册。第二，在 LlmClient 初始化时打一行 INFO 日志（`log.info("PddLlmClient initialized, endpoint={}", endpoint)`），业务方启动日志里应该能看到——如果没看到说明 Bean 没创建。第三，在 LlmClient 的所有调用方法里埋点上报到 Prometheus（`counter{starter="pdd-llm", app="xxx"}`），如果监控里某个业务的调用量是 0，说明它没真正用起来（可能 `@Autowired` 了但没调用，或绕过走自建了）。

**Q：怎么让团队设计 starter 时不再踩 @ConditionalOnMissingBean 顺序坑？**

沉淀成 starter 设计规范。第一，所有 `@Bean` 方法必须加 `@ConditionalOnMissingBean(value=具体类型.class)`，不能只靠方法名。第二，`AutoConfiguration.imports` 文件路径和类名要在 README 里明确写，新人 copy-paste 不会错。第三，starter 必须集成 `spring-boot-configuration-processor`，CI 里检查 `additional-spring-configuration-metadata.json` 是否生成。第四，写一个 `StarterTest`——用 `ApplicationContextRunner` 自动化测试 starter 在"用户没定义 Bean""用户定义了 Bean""配置缺省"三种场景下的行为，作为回归测试。第五，每次 starter 发版，在测试环境用 `--debug` 看 Conditions Evaluation Report，确认没有意外的 NEGATIVE_MATCH。

## 结构化回答

**30 秒电梯演讲：** 怎么让框架"开箱就是用"且能按需装配？简单说就是——Spring Boot 自动装配是"约定优于配置"。spring.factories（旧）/AutoConfiguration.imports（2.7…；@ConditionalOnXxx 控制装配条件。

**展开框架：**
1. **@Sprin** — @SpringBootApplication 三合一
2. **spring** — spring.factories（旧）/AutoConfiguration.imports（2.7+）
3. **@Condi** — @ConditionalOnXxx 控制装配条件

**收尾：** 您想继续往深里聊吗——比如「怎么排查 Bean 没装配？」

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：Spring Boot 自动装配原理与模型服务 Starter 怎么设计？ | 今天聊「Spring Boot 自动装配原理与模型服务 Starter 怎么设计？」。一句话：Spring Boot 自动装配是"约定优于配置" | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：@SpringBootApplication 三合一 | 核心概念 |
| 1:04 | 能力/参数拆解表 | 要点是：spring.factories（旧）/AutoConfiguration.imports（2.7+） | 能力拆解 |
| 1:56 | 流程图：输入→处理→输出 | 要点是：@ConditionalOnXxx 控制装配条件 | 关键机制 |
| 3:00 | 总结卡 + 下期预告 | 记住这些核心点就够了。下期我们接着聊——怎么排查 Bean 没装配？。 | 收尾 |
