---
id: java-architect-011
difficulty: L2
category: java-architect
subcategory: Spring Boot
tags:
- Spring
- Bean
- 扩展点
feynman:
  essence: Bean 生命周期的本质是"Spring 对一个对象从生到死的全流程管控"——实例化→属性注入→初始化→使用→销毁，每个阶段都开放扩展点（Aware 接口、BeanPostProcessor、InitializingBean）。Spring 之所以强大，就是这套可插拔的扩展机制让框架能整合任何第三方库。
  analogy: 像公务员入职流程：HR 创建档案（实例化）→ 分配办公室和同事（属性注入）→ 培训和宣誓（初始化）→ 上岗工作（使用）→ 退休离职（销毁）。每一步都有对应接口（Aware/PostProcessor）让"相关部门"介入处理。
  first_principle: 为什么需要这么多扩展点？因为 IoC 容器要整合不同来源的 Bean（注解、XML、第三方 jar），每种 Bean 有不同的初始化需求（数据库连接要建池、RPC 要注册服务）。统一的"生命周期 + 扩展点"让 Spring 用一套流程处理所有 Bean，第三方通过实现扩展点接入。
  key_points:
  - 完整生命周期：实例化→属性注入→Aware 回调→BeanPostProcessor 前置→初始化→BeanPostProcessor 后置→使用→销毁
  - 4 类扩展点：Aware（注入容器资源）、BeanPostProcessor（前后置增强）、InitializingBean/disposableBean（初始化/销毁回调）、@PostConstruct/@PreDestroy（注解）
  - BeanFactoryPostProcessor vs BeanPostProcessor：前者改 BeanDefinition（类元数据），后者改 Bean 实例
  - 三级缓存解决循环依赖（singletonObjects/earlySingletonObjects/singletonFactories）
  - Spring Boot 通过 ApplicationContext 启动，refresh() 触发完整流程
first_principle:
  problem: IoC 容器如何用一套统一流程管理千差万别的 Bean，同时支持第三方扩展？
  axioms:
  - Bean 的创建需求各异（注入方式、初始化逻辑、销毁资源）
  - 框架不能为每种 Bean 写定制代码，必须开放扩展点
  - 扩展点要有明确时序，让扩展者知道在哪一步介入
  rebuild: 定义标准生命周期流程（实例化→注入→初始化→销毁），在关键节点开扩展接口：Aware 让 Bean 拿容器资源、BeanPostProcessor 让全局增强 Bean、InitializingBean 让 Bean 自定义初始化。Spring 内置功能（@Autowired、AOP、事务）本身就是通过这些扩展点实现的，第三方同理接入。
follow_up:
  - 循环依赖怎么解决？——三级缓存：singletonObjects（成品）、earlySingletonObjects（半成品）、singletonFactories（ObjectFactory 提前暴露）。A 注入 B、B 注入 A 时，A 实例化后先放三级缓存，B 拿到 A 的早期引用完成注入
  - "@Autowired 和构造器注入区别？——构造器注入不可变（final 字段）、强制依赖、启动时暴露问题；@Autowired 字段注入可变、可选依赖、循环依赖时易踩坑。推荐构造器注入"
  - BeanPostProcessor 和 BeanFactoryPostProcessor 区别？——前者操作 Bean 实例（AOP 代理就是在这步），后者操作 BeanDefinition（改类元数据，如 @ConfigurationProperties 绑定）
  - 为什么 @PostConstruct 比 InitializingBean 好？——注解解耦不依赖 Spring 接口；但需要注解扫描支持
  - "@Lazy 解决什么？——延迟初始化，首次使用才创建 Bean，打破循环依赖或加速启动"
memory_points:
  - 生命周期 8 步：实例化→注入→Aware→前置→初始化→后置→使用→销毁
  - 4 类扩展点：Aware/BeanPostProcessor/InitializingBean/@PostConstruct
  - BeanPostProcessor 后置是 AOP 代理生成点（AbstractAutoProxyCreator）
  - 三级缓存：成品/半成品/ObjectFactory，解决单例循环依赖（构造器循环无解）
  - BeanFactoryPostProcessor 改元数据，BeanPostProcessor 改实例
---

# 【Java 后端架构师】Spring Bean 生命周期与扩展点

> 适用场景：JD 核心技术。写一个 starter、集成一个中间件、做一个 AOP 切面、排查循环依赖——这些场景都要求架构师把 Bean 生命周期刻进肌肉记忆。Spring 的强大不在 IoC 本身，在这套可插拔的扩展机制。

## 一、概念层：Bean 生命周期完整流程

**Bean 从生到死的 8 个阶段**：

```
1. 实例化（Instantiation）
   └─ createBeanInstance() → 调构造函数创建对象（此时还是"毛坯"）
        │
        ▼
2. 属性注入（Populate Properties）
   └─ @Autowired / @Value / setter 注入（"装修"）
        │
        ▼
3. Aware 接口回调
   └─ BeanNameAware.setBeanName / BeanFactoryAware / ApplicationContextAware
        │
        ▼
4. BeanPostProcessor.postProcessBeforeInitialization（前置增强）
   └─ 所有 BeanPostProcessor 依次调用（@PostConstruct 就在这步被 CommonAnnotationBeanPostProcessor 处理）
        │
        ▼
5. 初始化
   ├─ @PostConstruct 注解方法
   ├─ InitializingBean.afterPropertiesSet()
   └─ 自定义 init-method
        │
        ▼
6. BeanPostProcessor.postProcessAfterInitialization（后置增强）
   └─ AOP 代理就在这步生成（AbstractAutoProxyCreator.postProcessAfterInitialization）
        │
        ▼
7. 使用（Bean 就绪，放入单例池）
        │
        ▼
8. 销毁
   ├─ @PreDestroy 注解方法
   ├─ DisposableBean.destroy()
   └─ 自定义 destroy-method
```

**关键认知**：第 6 步（后置增强）是 AOP 的关键——返回的对象可能已经不是原始 Bean，而是代理对象（CGLIB/JDK Proxy）。这就是为什么 `@Transactional` 在同类内部调用失效（代理对象的方法调用才触发拦截）。

## 二、机制层：4 类扩展点详解

**扩展点 1：Aware 接口（注入容器资源）**

```java
@Component
public class MyBean implements BeanNameAware, ApplicationContextAware {
    private String name;
    private ApplicationContext ctx;

    @Override
    public void setBeanName(String name) { this.name = name; }   // 知道自己在容器里的名字

    @Override
    public void setApplicationContext(ApplicationContext ctx) {  // 拿到容器引用
        this.ctx = ctx;
    }
}
// 用途：Bean 需要主动查其他 Bean、读配置、发事件时
```

**扩展点 2：BeanPostProcessor（全局前后置增强）**

```java
@Component
public class MyPostProcessor implements BeanPostProcessor {
    @Override
    public Object postProcessBeforeInitialization(Object bean, String name) {
        // 所有 Bean 初始化前调用
        if (bean instanceof DataSource) {
            System.out.println("DataSource 即将初始化");
        }
        return bean;
    }

    @Override
    public Object postProcessAfterInitialization(Object bean, String name) {
        // 所有 Bean 初始化后调用，AOP 代理在这步生成
        if (bean instanceof UserService) {
            return Proxy.newProxyInstance(...);   // 返回代理对象替代原 Bean
        }
        return bean;
    }
}
```

**扩展点 3：InitializingBean / @PostConstruct（初始化回调）**

```java
@Component
public class MyBean implements InitializingBean {
    @PostConstruct                          // 1. 最先执行（注解）
    public void init() { ... }

    @Override
    public void afterPropertiesSet() { ... } // 2. 其次（接口）

    // 3. @Bean(initMethod = "customInit")  最后（自定义方法）
    public void customInit() { ... }
}
```

**扩展点 4：BeanFactoryPostProcessor（改 BeanDefinition 元数据）**

```java
@Component
public class MyFactoryPostProcessor implements BeanFactoryPostProcessor {
    @Override
    public void postProcessBeanFactory(ConfigurableListableBeanFactory factory) {
        // 比 BeanPostProcessor 早执行，操作的是 BeanDefinition（类元数据）不是实例
        BeanDefinition bd = factory.getBeanDefinition("userService");
        bd.setPropertyValues(new MutablePropertyValues().add("timeout", 5000));
    }
}
// 用途：启动时改配置、注册新 BeanDefinition、@ConfigurationProperties 绑定
```

**时序对比**（面试必画）：

```
启动 → refresh()
  │
  ▼
invokeBeanFactoryPostProcessors   ◄── BeanFactoryPostProcessor（改元数据）
  │
  ▼
registerBeanPostProcessors        ◄── 注册 BeanPostProcessor
  │
  ▼
finishBeanFactoryInstantiation    ◄── 实例化所有单例 Bean
  │  对每个 Bean：
  │  ├─ 实例化
  │  ├─ 属性注入
  │  ├─ Aware 回调
  │  ├─ BeanPostProcessor.before
  │  ├─ 初始化（@PostConstruct/afterPropertiesSet）
  │  └─ BeanPostProcessor.after  ◄── AOP 代理生成
  ▼
容器就绪
```

## 三、机制层：三级缓存与循环依赖

**循环依赖场景**：

```java
@Service
public class A {
    @Autowired private B b;   // A 依赖 B
}
@Service
public class B {
    @Autowired private A a;   // B 依赖 A
}
// 创建 A → 注入 B → 创建 B → 注入 A → A 还没创建完 → 死循环？
```

**三级缓存解法**（Spring 内部）：

```java
// DefaultSingletonBeanRegistry 的三个 Map
Map<String, Object> singletonObjects = new ConcurrentHashMap<>();       // 一级：成品单例
Map<String, Object> earlySingletonObjects = new ConcurrentHashMap<>(); // 二级：半成品（已实例化未注入完）
Map<String, ObjectFactory<?>> singletonFactories = new HashMap<>();    // 三级：ObjectFactory（能生成早期引用）
```

**工作流程**（A↔B 循环）：

```
1. 创建 A：实例化 A（毛坯），把 A 的 ObjectFactory 放入三级缓存
2. 注入 B：从容器找 B，B 不存在 → 创建 B
3. 创建 B：实例化 B，注入 A → 从一级找 A（没有）→ 二级（没有）→ 三级（有 ObjectFactory）
   调用 ObjectFactory.getObject() 得到 A 的早期引用，放二级缓存
4. B 注入完成，B 初始化完成，放一级缓存
5. 回到 A：注入 B（已成品），A 初始化完成，放一级缓存，清二三级
```

**为什么需要三级而非两级？**——为了处理 AOP。如果 A 被 AOP 代理，三级缓存的 ObjectFactory 会提前生成代理对象（而不是原始对象），保证 B 拿到的是代理后的 A。

**循环依赖的限制**（必答）：
- 只能解决**单例 + setter/字段注入**的循环。
- **构造器循环无解**（实例化阶段就卡死，Spring 直接抛 BeanCurrentlyInCreationException）。
- **原型（prototype）循环无解**（每次都新建，无法缓存）。

## 四、实战层：写一个自定义扩展点

**场景**：实现一个 @RateLimit 注解，在 Bean 初始化后扫描方法自动加限流。

```java
// 1. 定义注解
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
public @interface RateLimit {
    int qps() default 100;
}

// 2. 用 BeanPostProcessor 在初始化后扫描并生成代理
@Component
public class RateLimitPostProcessor implements BeanPostProcessor {
    @Override
    public Object postProcessAfterInitialization(Object bean, String name) {
        Class<?> clazz = bean.getClass();
        boolean hasRateLimit = Arrays.stream(clazz.getMethods())
            .anyMatch(m -> m.isAnnotationPresent(RateLimit.class));
        if (!hasRateLimit) return bean;   // 没注解不处理

        // 用 CGLIB 生成代理，方法拦截器实现限流
        Enhancer enhancer = new Enhancer();
        enhancer.setSuperclass(clazz);
        enhancer.setCallback((MethodInterceptor) (obj, method, args, proxy) -> {
            RateLimit rl = method.getAnnotation(RateLimit.class);
            if (rl != null && !tryAcquire(rl.qps())) {
                throw new RuntimeException("Rate limited");
            }
            return proxy.invokeSuper(obj, args);
        });
        return enhancer.create();
    }
}

// 3. 使用
@Service
public class OrderService {
    @RateLimit(qps = 50)
    public void createOrder() { ... }
}
```

这就是 Spring 内置 `@Transactional`、`@Async`、`@Cacheable` 的实现套路——BeanPostProcessor 后置生成代理 + 方法拦截器。

**真实场景**：JD 内部 starter（如监控、链路追踪、配置中心 SDK）都是通过 BeanPostProcessor 在 Bean 初始化后注入横切逻辑，业务方零感知。

## 五、底层本质：为什么是这套可插拔扩展机制

回到第一性：**IoC 容器的价值不只是"帮你 new 对象"，而是"用统一流程 + 扩展点整合任何库"**。

如果没有扩展点，Spring 要为每种 Bean 写定制代码：DataSource 要建池、RpcService 要注册、@Transactional 要代理——代码爆炸，第三方也无法接入。

有了扩展点：
- Spring 自身功能（@Autowired、AOP、事务）通过 BeanPostProcessor 实现，和第三方扩展走同一套机制。
- 第三方库（MyBatis、Dubbo、Kafka）写自己的 BeanPostProcessor 或 BeanFactoryPostProcessor 接入，业务方零感知。
- starter 的本质就是"打包一组 Bean 定义 + 扩展点实现 + 自动配置"，开箱即用。

这套设计是"开闭原则"在框架层的典范：对扩展开放（实现接口），对修改封闭（核心流程不变）。Spring 能成为 Java 生态事实标准，根因在这套可插拔架构。

## 六、AI 架构师加问：5 个 AI 相关问题

1. **AI starter 怎么用 Bean 生命周期？**
   AI SDK（如 LangChain4j）写自己的 BeanPostProcessor，在 ChatClient Bean 初始化后自动注入 prompt 模板、工具调用注册、memory 组件。业务方加依赖即用，零配置。

2. **AI 模型配置动态更新怎么接入 Spring？**
   用 EnvironmentPostProcessor 或 @ConfigurationProperties + ConfigurableEnvironment，配合 Apollo/Nacos 监听 beanFactoryPostProcessor 重新绑定配置。模型权重变化触发 Bean 重建（用 @RefreshScope）。

3. **让 AI 排查 Bean 创建失败，AI 接管哪段？**
   AI 解析启动日志找 BeanCreationException，识别是哪个 Bean、缺哪个依赖、循环依赖链；推荐修复（加 @Lazy、改构造器为 setter、补 @ComponentScan）。改代码人工 review。

4. **AI Agent 注册为 Bean 怎么处理？**
   Agent 是有状态对象（含对话历史），不适合单例。用 @Scope("prototype") 每次新建，或用 FactoryBean 动态创建；Agent 的工具（function）通过 BeanPostProcessor 自动扫描 @Tool 注解注册。

5. **AI 推理服务用 Spring 还是原生？**
   高性能推理用原生（Netty/gRPC，避免 Spring 启动开销和反射）；业务编排用 Spring（生态成熟、扩展点丰富）。GraalVM Native Image + Spring AOT 可兼顾启动速度和 Spring 生态。

## 七、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"8 步生命周期、4 类扩展点、AOP 在后置、三级缓存、BFPP 改元数据"**。

- **8 步**：实例化→注入→Aware→前置→初始化→后置→使用→销毁
- **4 类扩展点**：Aware（拿容器资源）、BeanPostProcessor（全局增强）、InitializingBean（初始化）、@PostConstruct（注解）
- **AOP 在后置**：BeanPostProcessor.postProcessAfterInitialization 生成代理
- **三级缓存**：singletonObjects/earlySingletonObjects/singletonFactories 解决单例循环依赖
- **BFPP vs BPP**：BeanFactoryPostProcessor 改 BeanDefinition 元数据，BeanPostProcessor 改 Bean 实例

### 拟人化理解

把 Bean 生命周期想成**公务员入职**：HR 创建档案（实例化）→ 分配办公室和同事（属性注入）→ 培训（Aware 学公司规章制度）→ 部门审批（前置增强）→ 宣誓上岗（初始化）→ 体检换证（后置增强，AOP 在这步把你"包装"成有权限的代理）→ 正式上班（使用）→ 退休（销毁）。每一步都有接口让"相关部门"介入。

### 面试现场 60 秒回答

> Bean 生命周期 8 步：实例化、属性注入、Aware 回调、BeanPostProcessor 前置、初始化（@PostConstruct/afterPropertiesSet）、BeanPostProcessor 后置、使用、销毁。4 类扩展点：Aware 拿容器资源、BeanPostProcessor 全局前后置增强、InitializingBean 自定义初始化、@PostConstruct 注解。AOP 代理在 BeanPostProcessor 后置生成（AbstractAutoProxyCreator）。循环依赖用三级缓存解决——singletonObjects 成品、earlySingletonObjects 半成品、singletonFactories ObjectFactory，只对单例 setter 注入有效，构造器循环无解。BeanFactoryPostProcessor 改 BeanDefinition 元数据，比 BeanPostProcessor 早执行。Spring 自身功能（@Autowired、事务、AOP）都是通过这些扩展点实现的，starter 本质就是 Bean 定义 + 扩展点。

### 反问面试官

> 贵司有没有自研 starter 或中间件集成需求？如果有，我重点讲扩展点设计；如果是业务开发，我会确保团队理解循环依赖和 AOP 失效场景，避免常见坑。

## 八、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么 @Autowired 字段注入 Spring 也支持，还要推构造器注入？ | 不可变性（final 字段线程安全）、强制依赖（启动暴露缺失依赖）、避免循环依赖陷阱、单元测试好 mock。Spring 4.3+ 推荐构造器注入 |
| 证据追问 | 你怎么知道 Bean 初始化卡在哪？ | 启动日志看 BeanCreationException 栈；加 -DEBUG 看完整创建链；arthas 在 createBean 打断点；看 BeanCurrentlyInCreationException 判断循环依赖 |
| 边界追问 | Bean 生命周期能处理所有初始化需求吗？ | 不能处理：启动顺序强依赖（用 @DependsOn）、异步初始化（用 @Lazy + 事件）、动态 Bean（用 BeanDefinitionRegistryPostProcessor 运行时注册） |
| 反例追问 | 什么时候不该用 BeanPostProcessor？ | 只针对单个 Bean（直接用 @PostConstruct）；需要顺序保证（多 BPP 顺序不可控）；性能敏感（BPP 对所有 Bean 生效，开销大）。用 @Bean(initMethod) 更精准 |
| 风险追问 | BeanPostProcessor 上线最大风险？ | 主动点出：BPP 对所有 Bean 生效，bug 影响全局；AOP 代理导致 this 调用失效（@Transactional 内部调用不生效）；循环依赖 + AOP 可能产生早期代理不一致；启动慢（BPP 链长） |
| 验证追问 | 怎么证明自定义扩展点工作正常？ | 单测：ApplicationContext 启动后断言 Bean 状态；集成测试：调用代理方法验证拦截生效；线上：启动日志看 BPP 是否执行、AOP 代理类是否生成（APRINT） |
| 沉淀追问 | 团队用 Spring 扩展点，沉淀什么？ | 扩展点选型表（Aware/BPP/InitializingBean 适用场景）、循环依赖排查 SOP、AOP 失效场景清单（this 调用、final 类、构造器内）、starter 编写规范 |

### 现场对话示例

**面试官**：详细讲讲 Bean 生命周期。

**候选人**：8 步。第一步实例化，调构造函数创建对象，此时属性还是 null。第二步属性注入，@Autowired/@Value 把依赖塞进去。第三步 Aware 回调，如果 Bean 实现了 BeanNameAware 等接口，Spring 注入容器资源。第四步 BeanPostProcessor 前置，所有 BPP 的 postProcessBeforeInitialization 依次调用，@PostConstruct 注解就是在这步被 CommonAnnotationBeanPostProcessor 处理。第五步初始化，依次调 @PostConstruct、InitializingBean.afterPropertiesSet、自定义 init-method。第六步 BeanPostProcessor 后置，AOP 代理在这步生成。第七步 Bean 放入单例池，可使用。第八步容器关闭时销毁，调 @PreDestroy、DisposableBean.destroy。关键点是第六步——如果 Bean 被 AOP 增强，后续容器里存的是代理对象不是原始对象。

**面试官**：循环依赖怎么解决？

**候选人**：三级缓存。singletonObjects 存成品单例，earlySingletonObjects 存半成品（实例化但没注入完），singletonFactories 存 ObjectFactory 能生成早期引用。A 依赖 B、B 依赖 A：创建 A 实例化后把 ObjectFactory 放三级缓存，注入 B 时去创建 B，B 注入 A 时从三级缓存的 ObjectFactory 拿到 A 的早期引用放二级缓存，B 完成后放一级缓存，回到 A 拿到成品 B 完成注入。三级而非两级是为了 AOP——ObjectFactory 可以提前生成代理对象，保证 B 拿到的是代理后的 A。限制是只对单例 setter/字段注入有效，构造器循环和 prototype 循环无解。

**面试官**：BeanPostProcessor 和 BeanFactoryPostProcessor 区别？

**候选人**：执行时机和操作对象不同。BeanFactoryPostProcessor 在所有 Bean 实例化之前执行，操作的是 BeanDefinition（类元数据，如类名、属性、作用域），可以改配置、注册新 Bean。BeanPostProcessor 在每个 Bean 实例化之后、初始化前后执行，操作的是 Bean 实例本身，可以做 AOP 代理。简单记：BFPP 改"图纸"，BPP 改"产品"。@ConfigurationProperties 的绑定靠 BFPP，@Transactional 的代理靠 BPP。

## 常见考点

1. **@Autowired 和构造器注入怎么选？**——推荐构造器注入：不可变（final 字段线程安全）、强制依赖（启动暴露问题）、避免循环依赖陷阱、单元测试好 mock。字段注入适合可选依赖（@Autowired(required=false)）。
2. **@PostConstruct、afterPropertiesSet、init-method 执行顺序？**——@PostConstruct（注解，最先）→ InitializingBean.afterPropertiesSet（接口）→ @Bean(initMethod)（自定义方法）。推荐用 @PostConstruct 解耦不依赖 Spring 接口。
3. **Bean 作用域有哪些？**——singleton（默认，单例）、prototype（每次新建）、request（HTTP 请求）、session（HTTP 会话）、application（ServletContext）。Web 作用域需要 RequestContextListener 或 DispatcherServlet 支持。
4. **@Lazy 的作用？**——延迟初始化，首次使用才创建 Bean。用途：打破循环依赖（@Lazy 注入代理）、加速启动（不常用 Bean 延迟加载）、避免启动失败（依赖未就绪时延迟）。


## 结构化回答

**30 秒电梯演讲：** 聊到Spring Bean 生命周期与扩展点，我的理解是——Bean 生命周期的本质是"Spring 对一个对象从生到死的全流程管控"——实例化→属性注入→初始化→使用→销毁，每个阶段都开放扩展点（Aware 接口、BeanPostProcessor、InitializingBean）。Spring 之所以强大，就是这套可插拔的扩展机制让框架能整合任何第三方库。打个比方，像公务员入职流程：HR 创建档案（实例化）→ 分配办公室和同事（属性注入）→ 培训和宣誓（初始化）→ 上岗工作（使用）→ 退休离职（销毁）。每一步都有对应接口（Aware/PostProcessor）让"相关部门"介入处理。

**展开框架：**
1. **完整生命周期** — 实例化→属性注入→Aware 回调→BeanPostProcessor 前置→初始化→BeanPostProcessor 后置→使用→销毁
2. **4 类扩展点** — Aware（注入容器资源）、BeanPostProcessor（前后置增强）、InitializingBean/disposableBean（初始化/销毁回调）、@PostConstruct/@PreDestroy（注解）
3. **BeanFactoryPostPro** — BeanFactoryPostProcessor vs BeanPostProcessor：前者改 BeanDefinition（类元数据），后者改 Bean 实例

**收尾：** 这块我在项目里也踩过坑——想深入的话，可以接着聊：循环依赖怎么解决？您更想看哪个方向？

## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡 | "Spring Bean 生命周期与扩展点——这道题面试官到底想考什么？我用 30 秒给你讲透。" | 开场钩子 |
| 0:15 | Spring Bean 生命周期图 | 先说核心：Bean 生命周期的本质是"Spring 对一个对象从生到死的全流程管控"——实例化→属性注入→初始化→使用→销毁，每个阶段都开放扩展点（Aware 接口、BeanPostPr。 | 核心定义 |
| 0:30 | 概念结构示意图 | Aware（注入容器资源）、BeanPostProcessor（前后置增强）。 | 4 类扩展点 |
| 1:30 | 总结卡 | 一句话记忆：生命周期 8 步：实例化→注入→Aware→前置→初始化→后置→使用→销毁。 下期可以接着聊：循环依赖怎么解决。 | 收尾总结 |
