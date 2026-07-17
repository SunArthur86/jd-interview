---
id: java-architect-003
difficulty: L3
category: java-architect
subcategory: JVM
tags:
- 类加载
- SPI
- 插件化
feynman:
  essence: 类加载的本质是"把字节码变成 Class 对象 + 隔离命名空间"。双亲委派是为了安全（核心类不被篡改），SPI/打破委派是为了扩展（让框架能加载用户实现）——两者看似矛盾，实则是"安全"与"开放"在同一个 ClassLoader 层级的平衡。
  analogy: 像公司审批：双亲委派是"先报上级批"——上级能批的就不用自己签，防止下级乱盖章（伪造 java.lang.String）；SPI 是"上级发了个招标公告，让外部供应商把方案投到指定信箱（META-INF/services）"，上级用专门的快递员（ContextClassLoader）去取，绕开层层上报。
  first_principle: 一个类的唯一性由 ClassLoader + 类全限定名共同决定。这个"二元标识"让 Java 天然支持命名空间隔离——同一份字节码在不同 ClassLoader 下是两个不同的 Class。所有插件化、模块化、热部署都建立在这个公理上。
  key_points:
  - 加载流程：加载→验证→准备→解析→初始化（5 阶段）
  - 双亲委派：先委派父加载器，父加载不到才自己加载
  - 打破委派的三个经典场景：SPI（JDBC）、OSGi、Tomcat WebApp 隔离
  - JDK 9+ 模块化（jigsaw）改变了 Bootstrap 找类的方式
  - 线上排查：-verbose:class / jcmd VM.classloader_stats 看加载来源
first_principle:
  problem: 如何让 Java 既能安全地加载不可信核心类，又能灵活地加载用户扩展实现？
  axioms:
  - 类的唯一性 = ClassLoader 实例 + 全限定名（不是单纯全限定名）
  - 核心类（java.*）必须由 Bootstrap 唯一加载，否则类型系统崩溃
  - 扩展类（用户实现）的可见性受限于"父 ClassLoader 看不到子 ClassLoader 加载的类"
  rebuild: 用双亲委派保证核心类的单一来源（安全），用 ContextClassLoader/SPI 机制让父加载器能"反向"调用子加载器加载扩展实现（开放）。安全与扩展通过"委派链 + 线程上下文"分层实现。
follow_up:
  - 为什么 JDBC 用 SPI 而不是直接 new？——因为 DriverManager 在 rt.jar（Bootstrap 加载），而 MySQL 驱动在 classpath（AppClassLoader），父看不到子，必须用 ContextClassLoader 反向加载
  - Tomcat 是怎么隔离多个 Web 应用的？——每个 WebApp 一个 WebappClassLoader，违反双亲委派：先自己加载（避免应用间类污染），加载不到再委派
  - OSGi 的网状加载怎么实现的？——每个 bundle 一个 ClassLoader，按导出/导入包做网状委派，打破树形结构
  - JDK 9 模块化后双亲委派还在吗？——还在，但层级变成 平台类加载器/应用类加载器，且模块边界（module-info）参与查找
  - 线上 ClassNotFound 怎么排查？——jcmd VM.classloader_stats 看每个 ClassLoader 加载了哪些 jar，确认 jar 是否真的在 classpath/WEB-INF/lib
memory_points:
  - 类唯一性 = ClassLoader + 全限定名，这是插件化/热部署的基石
  - 双亲委派三句话：收到加载请求→委派父加载器→父加载不到自己加载
  - 打破委派三场景：SPI（ContextClassLoader 反向）、Tomcat（先自己后父亲）、OSGi（网状委派）
  - JDK 9+ 加载器层级：Bootstrap（C++）→ PlatformClassLoader（原 Extension）→ AppClassLoader
  - 排查命令：-verbose:class、jcmd VM.classloader_stats、-Xlog:class+load
---

# 【Java 后端架构师】类加载机制、双亲委派与 SPI 扩展

> 适用场景：JD 核心技术。插件化风控规则、SPI 多云 SDK、热部署配置中心——这些场景的底层都是类加载。架构师必须能说清楚"为什么这样设计"而不只是"规则是什么"。

## 一、概念层：类加载的 5 个阶段与双亲委派

**类加载完整流程**（JVM 规范，面试必背）：

```
.class 文件
    │
    ▼
[加载 Loading] ──► 找到二进制字节流 → 生成方法区数据结构 → 生成 Class 对象
    │
    ▼
[验证 Verification] ──► 字节码格式/语义/符号引用合法性校验
    │
    ▼
[准备 Preparation] ──► 为静态变量分配内存并赋零值（int=0，不是代码里的初始值）
    │
    ▼
[解析 Resolution] ──► 常量池符号引用 → 直接引用（可延迟到首次使用）
    │
    ▼
[初始化 Initialization] ──► 执行 <clinit>，静态变量赋真实值 + static 块
```

**ClassLoader 层级（JDK 8 vs JDK 9+）**：

| JDK 8 | JDK 9+ | 加载内容 |
|-------|--------|---------|
| Bootstrap ClassLoader（C++） | Bootstrap（C++） | `java.*` 核心 rt.jar / java.base 模块 |
| Extension ClassLoader | Platform ClassLoader | `javax.*`、扩展 jar / java.** 模块 |
| Application ClassLoader | Application ClassLoader | classpath / classpath 模块 |

**双亲委派模型**（Parent Delegation）：

```
收到 loadClass("com.jd.User") 请求
        │
        ▼
1. 先 findLoadedClass：是否已加载过？是→返回
        │ 否
        ▼
2. 委派 parent.loadClass(name)
        │
        ▼
3. 父加载器递归向上，直到 Bootstrap
        │ Bootstrap 找不到
        ▼
4. 自己 findClass(name)：从自己管辖的路径找 .class
```

**为什么这样设计**（第一性）：保证 `java.lang.String` 永远由 Bootstrap 加载，攻击者写的同名类无法被加载，类型系统安全。同时避免重复加载（同一个类只加载一次）。

## 二、机制层：SPI 与打破双亲委派的本质

**SPI 场景的矛盾**：JDBC 的 `DriverManager` 在 `rt.jar`（Bootstrap 加载），但 MySQL/Oracle 驱动在应用的 classpath（AppClassLoader 加载）。父加载器**看不到**子加载器的类——这是双亲委派的天然限制。

**解决方案：线程上下文类加载器（TCCL）**

```java
// DriverManager.getConnection 内部（简化）
public static Connection getConnection(String url) {
    // 不能直接 Class.forName("com.mysql.cj.jdbc.Driver")
    // 因为 Bootstrap 加载不到 AppClassLoader 的类
    ClassLoader cl = Thread.currentThread().getContextClassLoader(); // AppClassLoader
    // 通过 TCCL 反向调用子加载器
    for (Driver d : drivers) { ... }  // drivers 通过 SPI 自动注册
}
```

**SPI 自动发现机制**（ServiceLoader）：

```java
// 加载所有 META-INF/services/java.sql.Driver 文件里写的实现类
ServiceLoader<Driver> loaders = ServiceLoader.load(Driver.class);
// MySQL 驱动 jar 里：
//   META-INF/services/java.sql.Driver
//   内容：com.mysql.cj.jdbc.Driver
// ServiceLoader 内部用 TCCL 加载这些实现类，绕过双亲委派
```

**打破双亲委派的三个经典场景**：

| 场景 | 机制 | 为什么打破 |
|------|------|-----------|
| **JDBC SPI** | TCCL 反向加载 | 父（Bootstrap）要用子（App）加载的驱动实现 |
| **Tomcat** | WebappClassLoader 先自己后父亲 | 多 Web 应用隔离，避免 A 应用的类污染 B |
| **OSGi** | Bundle 间网状委派 | 模块化，每个 bundle 独立 ClassLoader，按导出包互查 |

**Tomcat 打破委派的逻辑**（架构师常考）：

```java
// WebappClassLoader.loadClass 简化
protected Class<?> loadClass(String name) {
    // 1. 自己已加载？返回
    // 2. JVM 缓存？返回
    // 3. java.* 必须委派 Bootstrap（安全底线）
    if (name.startsWith("java.")) return parent.loadClass(name);
    // 4. 先自己加载（打破点！普通类不走双亲委派）
    try { return findClass(name); } catch (ClassNotFoundException e) {}
    // 5. 自己加载不到，再委派父
    return super.loadClass(name);
}
```

这样两个 Web 应用各自有不同版本的 fastjson，互不冲突。

## 三、实战层：插件化架构与线上排查

**场景**：风控规则引擎，需要支持运营在线配置新规则类并热加载（不重启服务）。

```java
// 每次加载用新的 ClassLoader，实现热部署
public class RuleClassLoader extends URLClassLoader {
    public RuleClassLoader(URL[] urls, ClassLoader parent) {
        super(urls, parent);
    }
}

// 热加载：丢弃旧 ClassLoader → 旧 Class 被 GC → 加载新版本
public Rule loadRule(File ruleJar) {
    URL[] urls = { ruleJar.toURI().toURL() };
    try (RuleClassLoader cl = new RuleClassLoader(urls,
            Thread.currentThread().getContextClassLoader())) {
        Class<?> clazz = cl.loadClass("com.jd.rule.NewRule");
        return (Rule) clazz.getDeclaredConstructor().newInstance();
    }
    // 注意：旧 ClassLoader 必须释放，否则 Metaspace OOM
}
```

**坑（必答）**：自定义 ClassLoader 不释放会导致 Metaspace OOM——每次加载生成新的 Class 对象进入 Metaspace，GC 回收要求"ClassLoader 实例本身被回收"，必须断开所有引用链。

**线上排查命令**：

```bash
# 1. 看每个 ClassLoader 加载了多少类（Metaspace OOM 必查）
jcmd <pid> VM.classloader_stats
# 输出：ClassLoader 类型、parent、已加载类数、字节数
# 如果看到几百个 URLClassLoader 实例 → 类加载泄漏

# 2. 启动时打印每个类的加载来源
java -verbose:class -jar app.jar | grep "com.jd"
# [Loaded com.jd.User from file:/app/lib/user.jar]

# JDK 9+ 用统一日志
java -Xlog:class+load=info:file=classload.log -jar app.jar

# 3. MAT 分析：找 ClassLoader GC Root 链
# jmap -dump:format=b,file=heap.hprof <pid>
# MAT → List Objects → incoming references，看谁持有 ClassLoader
```

**JDK 9 模块化的变化**（架构师要会答）：

- 加载器层级改名：Extension → Platform ClassLoader
- `rt.jar` 拆成 `java.base` 等模块，Bootstrap 按模块查找
- 模块边界（`module-info.java`）参与类查找：非 `exports` 的包对外不可见
- 双亲委派仍在，但查找路径多了"模块层（ModuleLayer）"

## 四、底层本质：为什么是 ClassLoader + 全限定名

回到第一性原理：**为什么类的唯一性不是全限定名，而是 ClassLoader + 全限定名？**

因为 JVM 要支持"同一份字节码在不同上下文是不同类型"的语义。考虑 OSGi 的两个 bundle 都依赖 fastjson v1 和 v2：

- 如果按全限定名判断，`com.alibaba.fastjson.JSON` 只能存在一个——版本冲突无解。
- 按 `ClassLoader + 全限定名` 判断，bundle A 的 ClassLoader 加载的 JSON 和 bundle B 的 ClassLoader 加载的 JSON 是**两个不同的 Class**，互相隔离。

这个公理推导出：插件化（每个插件独立 ClassLoader）、热部署（新 ClassLoader 加载新版本）、应用隔离（Tomcat 多 WebApp）——都建立在"ClassLoader 是命名空间边界"上。

双亲委派是在这个公理上加的"安全约束"：核心类强制走 Bootstrap，保证 `java.lang.Object` 全局唯一。SPI/TCCL 是为了在安全约束下打开一个"扩展口"。两者不矛盾，是同一层级的不同需求分层。

## 五、AI 架构师加问：5 个 AI 相关问题

1. **AI 插件化规则引擎怎么用类加载？**
   AI 推理出的规则 DSL 编译成字节码 → 新 ClassLoader 加载 → 隔离执行。AI 只生成 DSL，编译+加载走确定性代码，防止 AI 直接生成恶意字节码（必须经过校验器）。

2. **让 AI 排查 Metaspace OOM，AI 接管哪段？**
   AI 解析 `jcmd VM.classloader_stats` 输出，识别异常增长的 ClassLoader 实例 + 定位泄漏引用（MAT incoming references）；改代码必须人工 review，因为类加载泄漏往往涉及生命周期设计。

3. **AI 多租户隔离怎么用 ClassLoader？**
   每个租户独立 ClassLoader + 独立线程池 + 独立配置，AI 模型按租户 ClassLoader 加载定制逻辑。注意：AI 模型本身（GB 级权重）不该放 Metaspace，应放堆外内存或独立服务。

4. **RAG 知识库加载动态文档怎么避免 Metaspace 膨胀？**
   不要把动态内容编译成 Class——用结构化数据（JSON/向量）+ 解释执行；必须用 ClassLoader 时配 `-XX:MaxMetaspaceSize` 上限 + 定期卸载，监控 `jcmd VM.classloader_stats` 的实例数。

5. **怎么防止 AI 生成的插件类引入安全风险？**
   字节码校验器（Verifier）必过 + SecurityManager/模块边界限制权限 + 沙箱 ClassLoader（parent 限制可见类）+ 审计每次 `defineClass` 来源。AI 输出的字节码走和用户上传 jar 相同的安全链路。

## 六、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"五阶段、三层级、委派三句话、打破三场景、排查两命令"**。

- **五阶段**：加载→验证→准备→解析→初始化
- **三层级**：Bootstrap → Platform/Extension → App
- **委派三句话**：收到请求→委派父亲→父亲加载不到自己上
- **打破三场景**：SPI（TCCL）、Tomcat（先自己后父亲）、OSGi（网状）
- **排查两命令**：`-verbose:class` 看来源、`jcmd VM.classloader_stats` 看泄漏

### 拟人化理解

把 ClassLoader 想成**公司盖章流程**。双亲委派是"先报上级批"——上级能批的就不用下级盖，防止下级伪造公章（假 java.lang.String）。SPI 是"上级发招标公告（META-INF/services），让外部供应商投方案，上级用专门的快递员（TCCL）去取件"——因为上级按规定看不到外部供应商（父看不到子），必须借快递员的手。

### 面试现场 60 秒回答

> 类加载是 JVM 把字节码变 Class 对象的过程，分加载验证准备解析初始化五步。双亲委派是安全设计：先委派父加载器，保证 java.* 核心类唯一。但它有局限——父加载器看不到子加载器的类，所以 JDBC 这种 SPI 场景要用线程上下文类加载器反向加载。Tomcat 多 WebApp 隔离也是打破双亲委派，每个应用独立 ClassLoader 先自己加载。类的唯一性是 ClassLoader + 全限定名，这是插件化、热部署的基石。线上 Metaspace OOM 我会用 `jcmd VM.classloader_stats` 看有没有泄漏的 ClassLoader，再 dump 用 MAT 找 GC Root。

### 反问面试官

> 贵司有没有需要热部署或插件化的场景？如果有，我重点关注 ClassLoader 生命周期管理；如果是普通单体，我会确保团队理解双亲委派避免 SPI 坑就够了，不引入过度复杂度。

## 七、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 你为什么要自定义 ClassLoader，普通 ClassLoader 不行吗？ | 用场景说话：插件化（每个插件独立隔离）、热部署（新版本不重启）、多版本共存（OSGi），这些用单一 ClassLoader 做不到——证明是需求驱动不是炫技 |
| 证据追问 | 你怎么证明发生了类加载泄漏？ | `jcmd VM.classloader_stats` 看 ClassLoader 实例数是否持续增长，`jstat -gc <pid>` 看 M（Metaspace）是否逼近上限，`jmap -dump` + MAT 找持有 ClassLoader 的 GC Root（常见是 Thread/静态字段/缓存） |
| 边界追问 | 双亲委派能保证所有类不被篡改吗？ | 不能：自定义 ClassLoader 可以重写 loadClass 跳过委派（Tomcat 就这么做）。JVM 的底线是 `java.*` 核心包强校验，自定义类打破委派是允许的，但要自己保证安全 |
| 反例追问 | 什么场景你会避免自定义 ClassLoader？ | 简单业务用 SPI 就够（ServiceLoader）；没有隔离/热部署需求时自定义只会增加 Metaspace 风险和调试难度；优先用模块化（JDK 9 jigsaw）或容器隔离 |
| 风险追问 | 自定义 ClassLoader 上线后最大风险？ | 主动点出：Metaspace OOM（ClassLoader 不释放）、`ClassCastException`（同名类不同 ClassLoader 加载是不同类型）、内存泄漏（Thread/静态字段持有 ClassLoader）；要有 `-XX:MaxMetaspaceSize` 上限 + 卸载机制 + 监控 |
| 验证追问 | 怎么证明热部署真的生效？ | `-verbose:class` 看新版本类是否被新 ClassLoader 加载，`jcmd VM.classloader_stats` 确认旧 ClassLoader 实例数下降，业务验证规则版本号是否更新，`jstat -gc` 看 Metaspace 是否稳定不增长 |
| 沉淀追问 | 团队用类加载，沉淀什么？ | 自定义 ClassLoader 必须配 try-with-resources 或显式 close、`MaxMetaspaceSize` 必设、`jcmd VM.classloader_stats` 纳入巡检、ClassCastException 排查 SOP（对比两个 Class 的 ClassLoader 实例） |

### 现场对话示例

**面试官**：你说 JDBC 用 SPI 打破双亲委派，具体怎么打破的？

**候选人**：核心矛盾是 DriverManager 在 rt.jar，由 Bootstrap 加载，但 MySQL 驱动在应用 classpath，由 AppClassLoader 加载。Bootstrap 是 AppClassLoader 的"祖父"，按双亲委派它看不到孙子的类。JDK 的解法是线程上下文类加载器——DriverManager 内部调用 `Thread.currentThread().getContextClassLoader()`，拿到 AppClassLoader，再用它去加载驱动类。ServiceLoader.load 内部也是用 TCCL 加载 `META-INF/services` 里声明的实现类。本质是给父加载器开了一个"反向通道"。

**面试官**：为什么不直接把驱动放到 rt.jar？

**候选人**：因为驱动是第三方实现，会变化，不应该和 JDK 核心耦合。如果放进 rt.jar，每次换驱动要改 JDK。SPI 机制把"接口"和"实现"解耦——JDK 只提供 DriverManager 接口，实现由各厂商通过 META-INF/services 注册，运行时发现。这是开闭原则在类加载层的落地。

**面试官**：那你怎么排查线上 Metaspace OOM？

**候选人**：先 `jcmd VM.classloader_stats` 看哪些 ClassLoader 实例数异常多——如果看到几百个相同类型的 URLClassLoader，基本就是泄漏。然后 `jmap -dump` 用 MAT 打开，对某个泄漏的 ClassLoader 做 List Objects → incoming references，看是谁持有它。常见根因：Thread 没销毁持有 ClassLoader、静态 Map 缓存了 Class 实例、日志框架的 Appender 没关闭。修复后我会加 `-XX:MaxMetaspaceSize` 上限做兜底，防止再次发生。

## 常见考点

1. **为什么静态变量在准备阶段是零值？**——准备只分配内存赋零值（int=0、引用=null），真正的赋值在初始化阶段执行 `<clinit>`。所以 `static int x = 42` 准备后 x=0，初始化后才变成 42。
2. **一个类的 `<clinit>` 什么时候执行？**——首次主动使用时：new、调用静态方法、访问静态字段、反射、子类初始化触发父类初始化。被动使用（通过子类访问父类静态字段）不触发子类初始化。
3. **`forName` 和 `loadClass` 区别？**——`Class.forName` 会触发初始化（执行 `<clinit>`），`ClassLoader.loadClass` 只加载不初始化。JDBC 注册驱动用 forName 是为了触发 static 块注册 Driver。
4. **JDK 9 模块化对类加载的影响？**——加载器层级改名（Extension→Platform），rt.jar 拆模块，模块边界参与类查找，非 exports 包对外不可见（即使全限定名相同）。双亲委派仍在但查询路径变复杂。


## 结构化回答

**30 秒电梯演讲：** 聊到类加载机制、双亲委派与 SPI 扩展，我的理解是——类加载的本质是"把字节码变成 Class 对象 + 隔离命名空间"。双亲委派是为了安全（核心类不被篡改），SPI/打破委派是为了扩展（让框架能加载用户实现）——两者看似矛盾，实则是"安全"与"开放"在同一个 ClassLoader 层级的平衡。打个比方，像公司审批：双亲委派是"先报上级批"——上级能批的就不用自己签，防止下级乱盖章（伪造 java.lang.String）；SPI 是"上级发了个招标公告，让外部供应商把方案投到指定信箱（META-INF/services）"，上级用专门的快递员（ContextClassLoader）去取，绕开层层上报。

**展开框架：**
1. **加载流程** — 加载→验证→准备→解析→初始化（5 阶段）
2. **双亲委派** — 先委派父加载器，父加载不到才自己加载
3. **打破委派的三个经典场景** — SPI（JDBC）、OSGi、Tomcat WebApp 隔离

**收尾：** 这块我在项目里也踩过坑——想深入的话，可以接着聊：为什么 JDBC 用 SPI 而不是直接 new？您更想看哪个方向？

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡 | "类加载机制、双亲委派与 SPI 扩展——这道题面试官到底想考什么？我用 30 秒给你讲透。" | 开场钩子 |
| 0:15 | JVM 内存分代图 | 先说核心：类加载的本质是"把字节码变成 Class 对象 + 隔离命名空间"。双亲委派是为了安全（核心类不被篡改），SPI/打破委派是为了扩展（让框架能加载用户实现）——两者看似矛盾，实。 | 核心定义 |
| 0:40 | 概念结构示意图 | 先委派父加载器，父加载不到才自己加载。 | 双亲委派 |
| 1:05 | 流程图 | SPI（JDBC）、OSGi、Tomcat WebApp 隔离。 | 打破委派的三个经典场景 |
| 2:30 | 总结卡 | 一句话记忆：类唯一性 = ClassLoader + 全限定名，这是插件化/热部署的基石。 下期可以接着聊：为什么 JDBC 用 SPI 而不是直接 new。 | 收尾总结 |
