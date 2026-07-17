---
id: java-architect-110
difficulty: L4
category: java-architect
subcategory: Spring Boot
tags:
- Java 架构师
- GraalVM
- Native Image
- 冷启动
feynman:
  essence: Native Image 是 GraalVM 的 AOT（Ahead-Of-Time）编译——把 Spring Boot 应用编译成原生可执行文件，启动时间从 30 秒降到 50ms，内存占用从 1GB 降到 100MB。代价是失去 JIT 优化（峰值吞吐降 10-30%）、反射/动态代理要配置（reflect-config.json）、构建时间长（5-10 分钟）。它是 Serverless / 函数计算 / CLI 工具的杀手锏，但不是长运行服务的最佳选择。
  analogy: 像把一部汽车（JVM + JIT）拆了重装成自行车（Native Image）：启动快（一脚蹬就跑）、占地小（自行车棚就够），但跑不快（没有 JIT 优化），改装麻烦（要重新设计零件）。短途出行（Serverless）选自行车，长途高速（长运行服务）选汽车。
  first_principle: JVM 启动慢是因为要加载类、初始化、JIT 预热——前 1-2 分钟性能差。Serverless 场景要求冷启动 < 1 秒，JVM 模式做不到。Native Image 在构建时（AOT）完成所有类加载和初始化，把"运行时的工作"前置到构建时，启动只需执行已经编译好的机器码。
  key_points:
  - Native Image（GraalVM）：AOT 编译，启动 < 100ms，内存降 80%
  - 代价：无 JIT（峰值吞吐降 10-30%）、反射/动态代理要配置、构建慢（5-10 分钟）
  - reflect-config.json / resource-config.json / proxy-config.json 配置文件
  - Spring Boot 3 + Spring AOT 自动生成大部分配置
  - 适合：Serverless / Function / CLI / 短生命周期服务
  - 不适合：长运行高吞吐服务、强依赖反射的库（如 Hibernate < 6.2）
first_principle:
  problem: JVM 冷启动慢（30s）、内存大（1GB），怎么让 Java 适合 Serverless / Function 场景？
  axioms:
  - Serverless 要求冷启动 < 1 秒（用户感知）
  - JVM 启动要加载类、初始化、JIT 预热，30 秒起步
  - Serverless 实例短命（几秒到几分钟），JIT 还没热就销毁
  rebuild: 用 AOT 编译替代 JIT 解释启动。构建时：GraalVM 的 native-image 工具扫描应用，做封闭世界分析（closed-world analysis），把所有可达的类、方法、反射都固化进原生二进制。运行时：直接执行机器码（无 JVM 解释、无 JIT 编译），启动只需加载已编译代码到内存。代价：封闭世界假设（运行时不能动态加载新类）、反射要预先配置。
follow_up:
  - Native Image 和 JVM 模式怎么选？——Serverless / Function / CLI / 短生命周期选 Native；长运行高吞吐选 JVM。两者不冲突，可同代码两套构建
  - 反射怎么处理？——封闭世界分析自动检测部分，剩下的要 reflect-config.json 显式配置。Spring Boot 3 的 Spring AOT 自动生成 95% 配置
  - 性能差异多大？——启动 < 100ms vs JVM 30s（百倍）；峰值吞吐 Native 低 10-30%（无 JIT 优化）；首次请求延迟 Native < 1ms vs JVM 几百毫秒（JIT 还没热）
  - 怎么调试？——和 JVM 模式一样，但 Native Image 调试需要 GraalVM 支持（native-image -H:GenerateDebugInfo=true），IDE 支持 Spring Boot 3 的双模式调试
  - 兼容性问题？——动态代理（CGLIB）、反射加载（Class.forName）、运行时字节码生成（ByteBuddy）都需要配置或替换。Hibernate 6.2+ / Spring Boot 3 已支持
memory_points:
  - Native Image（GraalVM AOT）：启动 < 100ms、内存降 80%
  - 代价：无 JIT（峰值吞吐降 10-30%）、反射要配置、构建 5-10 分钟
  - 配置：reflect-config.json / resource-config.json / proxy-config.json
  - Spring Boot 3 + Spring AOT 自动生成 95% 配置
  - 适合：Serverless / Function / CLI / 短生命周期服务
  - 不适合：长运行高吞吐、强依赖反射的库
  - 命令：native-image -jar app.jar app 或 mvn native:compile
---

# 【Java 后端架构师】Native Image 与 JVM 模式如何选型

> 适用场景：JD 核心技术。函数计算场景（如大促期间的图片处理函数）冷启动要 < 1 秒，JVM Spring Boot 启动 30 秒被用户感知为超时。Native Image 把启动降到 50ms，但要处理反射配置、Hibernate 兼容、构建时间长等问题。架构师必须能选型 + 落地 + 排查兼容性。

## 一、概念层：Native Image 的本质与代价

**Native Image vs JVM 模式对比**（这张表面试必问）：

| 维度 | JVM 模式 | Native Image |
|------|---------|--------------|
| **启动时间** | 10-30 秒 | < 100ms |
| **内存占用** | 1-2GB | 100-300MB |
| **首次请求延迟** | 几百毫秒（JIT 未热） | < 1ms |
| **峰值吞吐** | 高（JIT 优化后） | 低 10-30%（无 JIT） |
| **构建时间** | 几十秒（编译 + 打包） | 5-10 分钟（封闭世界分析） |
| **二进制大小** | 50MB（jar） | 100-200MB（含运行时） |
| **GC** | G1/ZGC 等可选 | Serial GC（默认）/ G1（GraalVM 23+） |
| **反射/动态代理** | 完全支持 | 要配置（reflect-config.json） |
| **运行时类加载** | 支持（Class.forName） | 不支持（封闭世界） |
| **调试** | 完整（JVM 调试协议） | 受限（GraalVM 调试支持） |

**适用场景对比**：

| 场景 | JVM 模式 | Native Image | 选择 |
|------|---------|--------------|------|
| Serverless / Function | 启动 30s 致命 | 启动 50ms | **Native** |
| CLI 工具 | 启动慢被吐槽 | 启动即响应 | **Native** |
| 短生命周期任务（< 1 分钟） | JIT 没热就退出 | 即时编译完成 | **Native** |
| 长运行高吞吐服务 | JIT 优化充分 | 吞吐低 10-30% | **JVM** |
| 复杂反射/动态字节码 | 完全支持 | 配置复杂 | **JVM** |
| 微服务（K8s 长跑） | 标准选择 | 内存小但吞吐低 | JVM / Native 看场景 |

## 二、机制层：AOT 编译与配置文件

**Native Image 构建流程**：

```
源码（Spring Boot 3 + Spring AOT）
        │
        ▼
Maven/Gradle 编译 → .class 文件
        │
        ▼
Spring AOT 处理（生成 Bean 定义、解析反射）
        │
        ▼
GraalVM native-image 工具（封闭世界分析）
        │
        ├── 扫描所有可达类和方法
        ├── 检测反射 / 动态代理 / 资源加载
        ├── 应用 reflect-config.json 等配置
        │
        ▼
原生可执行文件（含运行时 + GC + 应用代码）
```

**构建命令**：

```bash
# 方式 1：GraalVM native-image 直接编译
native-image -jar target/app.jar app
./app                      # 直接运行

# 方式 2：Maven 插件（Spring Boot 3 推荐）
<plugin>
    <groupId>org.graalvm.buildtools</groupId>
    <artifactId>native-maven-plugin</artifactId>
</plugin>
mvn native:compile -Pnative  # 编译成原生二进制
target/app                   # 直接运行

# 方式 3：Spring Boot 3 + Buildpacks（云原生构建）
<plugin>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-maven-plugin</artifactId>
    <configuration>
        <image>
            <builder>paketobuildpacks/builder:tiny</builder>
            <env>
                <BP_NATIVE_IMAGE>true</BP_NATIVE_IMAGE>
            </env>
        </image>
    </configuration>
</plugin>
mvn spring-boot:build-image   # 构建原生镜像
```

**三大配置文件**（架构师必须能写）：

**1. reflect-config.json（反射配置）**：

```json
{
  "reflectionconfig": [
    {
      "name": "com.jd.OrderDTO",
      "allDeclaredConstructors": true,
      "allPublicConstructors": true,
      "allDeclaredMethods": true,
      "allPublicMethods": true,
      "fields": [
        {"name": "orderId"},
        {"name": "userId"},
        {"name": "amount"}
      ]
    },
    {
      "name": "com.jd.OrderService",
      "methods": [
        {"name": "createOrder", "parameterTypes": ["com.jd.OrderDTO"]}
      ]
    }
  ]
}
```

**2. resource-config.json（资源文件配置）**：

```json
{
  "resources": {
    "includes": [
      {"pattern": ".*\\.properties$"},
      {"pattern": ".*\\.yml$"},
      {"pattern": "META-INF/spring.factories"},
      {"pattern": "templates/.*\\.html"}
    ]
  }
}
```

**3. proxy-config.json（动态代理配置）**：

```json
{
  "proxies": [
    {
      "interfaces": [
        "com.jd.OrderRepository",
        "org.springframework.aop.SpringProxy",
        "org.springframework.aop.framework.Advised"
      ]
    }
  ]
}
```

**Spring Boot 3 + Spring AOT 自动生成**：

```bash
# Spring Boot 3 的 AOT 引擎自动分析 Bean 定义，生成大部分配置
mvn compile -Pnative        # 触发 AOT 处理

# 生成的配置在 target/spring-aot/main/resources/META-INF/native-image/
# ├── reflect-config.json
# ├── resource-config.json
# ├── proxy-config.json
# └── jni-config.json

# 95% 的配置 Spring AOT 自动生成，剩下的 5%（第三方库的反射）要手写
```

## 三、实战层：Serverless 场景落地

**场景：大促期间的图片处理函数**

```yaml
# Knative Service（K8s Serverless）
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: image-processor
spec:
  template:
    metadata:
      annotations:
        autoscaling.knative.dev/class: keda.autoscaling.knative.dev
        autoscaling.knative.dev/minScale: "0"      # 缩到 0
        autoscaling.knative.dev/maxScale: "100"
    spec:
      containerConcurrency: 1
      containers:
        - image: registry.jd.com/image-processor:native
          resources:
            limits:
              cpu: "1"
              memory: "256Mi"     # 原 JVM 模式要 1GB，Native 只要 256MB
```

**性能对比**：

```
JVM 模式：
  冷启动：15 秒（Spring Boot + 类加载 + JIT 预热）
  内存：1GB
  首次请求延迟：800ms（JIT 未热）
  峰值吞吐：1000 QPS（JIT 优化充分）

Native Image 模式：
  冷启动：50ms
  内存：200MB
  首次请求延迟：< 5ms
  峰值吞吐：800 QPS（无 JIT，比 JVM 低 20%）

收益：冷启动快 300 倍，内存省 80%，峰值吞吐低 20%
适用：大促期间突发流量、缩到 0 后再起的场景
```

**兼容性处理（最常见的坑）**：

```java
// 坑 1：Hibernate 反射（升级到 6.2+ 自动支持）
// 老版本（< 6.2）：需要手动配置 reflect-config
// 新版本：Hibernate 6.2+ 内置 GraalVM 支持

// 坑 2：CGLIB 动态代理（替换成 ByteBuddy）
// Spring Boot 3 已经替换，无需处理

// 坑 3：Class.forName 动态加载（不支持）
// 反例：
Class<?> clazz = Class.forName(config.getClassName());   // Native 报错
// 修复：用 Spring 的 BeanFactory 或预注册

// 坑 4：序列化（Jackson 已支持）
ObjectMapper mapper = new ObjectMapper();
// Jackson 2.13+ 自动生成 reflect-config，无需手动配置

// 坑 5：第三方库的 SPI（ServiceLoader）
// resource-config.json 要包含 META-INF/services/*
```

**调试技巧**：

```bash
# 1. 用 Tracing Agent 自动生成配置（运行 JVM 模式时收集）
java -agentlib:native-image-agent=config-output-dir=src/main/resources/META-INF/native-image \
     -jar target/app.jar
# 跑业务，所有反射/资源/代理调用被记录
# 生成的配置文件直接用于 Native Image 构建

# 2. 构建时验证
native-image --report-unsupported-elements-at-runtime \
             --initialize-at-build-time=com.jd \
             -jar app.jar app
# --initialize-at-build-time：构建时初始化（启动更快）

# 3. 调试信息
native-image -H:GenerateDebugInfo=true -jar app.jar app
gdb ./app       # GDB 调试
```

## 四、底层本质：封闭世界假设与 JIT 的取舍

回到第一性：**为什么 Native Image 启动这么快，但峰值吞吐低？**

- **启动快的原因**：
  - 所有类加载和初始化在构建时完成（AOT），运行时直接执行机器码
  - 不需要 JVM 解释器（C1/C2 编译器、解释器都内嵌进二进制）
  - Spring AOT 把 Bean 定义预生成（运行时不扫描 Bean 注解）
  - 资源文件预加载到二进制（无文件 IO）

- **峰值吞吐低的原因**：
  - 无 JIT 动态优化：JVM 的 C2 编译器基于运行时 profile 优化（内联、逃逸分析、虚方法调用优化），Native Image 是 AOT 静态编译，没有 profile 数据
  - GC 简化：Native Image 默认用 Serial GC（单线程），吞吐不如 G1/ZGC。GraalVM 23+ 支持 G1 GC
  - 内联策略保守：AOT 不知道哪些方法高频，内联策略比 JIT 保守

- **封闭世界假设**（closed-world assumption）：
  - Native Image 在构建时扫描所有可达代码，把"可能用到的类/方法"全部固化
  - 运行时不能动态加载新类（Class.forName 失败）、不能用未配置的反射
  - 这与 JVM 的"开放世界"（运行时任意加载）相反

**Profile-Guided Optimization（PGO）**：GraalVM 支持 PGO 缓解 AOT 的性能劣势：

```bash
# 1. 构建 instrumented binary（收集 profile）
native-image --pgo-instrument -jar app.jar app-instrumented

# 2. 跑业务，收集 profile（默认写入 ~/profile.iprof）
./app-instrumented

# 3. 用 profile 重新构建优化版
native-image --pgo=profile.iprof -jar app.jar app-optimized
# 性能提升 10-15%，接近 JVM 80% 吞吐
```

## 五、AI 架构师加问：5 个

1. **AI 推理服务用 Native Image 合适吗？**
   不直接合适。AI 推理依赖 JNI 调用 GPU/ONNX 库（如 DJL、ONNX Runtime），这些 native 库的反射和动态加载需要复杂配置。但 AI 服务的网关层（接收请求、转发、鉴权）可以用 Native Image（启动快、内存小）。建议：网关 Native，推理 JVM，两者解耦。

2. **AI Copilot 自动生成 reflect-config 怎么设计？**
   用 Tracing Agent（native-image-agent）跑业务，自动收集所有反射调用，生成 reflect-config.json。AI 优化生成的配置：去重、合并相似条目、按 Spring AOT 风格整理。误报控制：跑完整业务路径（覆盖所有反射分支），避免遗漏。AI 输出后人工 review，重点关注第三方库的反射。

3. **Native Image 在 K8s 长运行微服务有优势吗？**
   看场景。优势：内存小（200MB vs 1GB），同样节点能跑更多副本；启动快，HPA 扩容秒级生效。劣势：吞吐低 10-30%（无 JIT），峰值场景要更多副本。计算：内存省 80% vs 吞吐降 20%，如果内存是瓶颈（节点密度）选 Native，如果 CPU 是瓶颈（吞吐）选 JVM。

4. **大模型推理框架（vLLM、TensorRT-LLM）的 Python 代码和 Java Native Image 能类比吗？**
   不直接类比，但理念相似。vLLM 用 C++/CUDA 实现（编译成原生），启动快、无 GIL，类似 Native Image 的"原生二进制"。Python 是解释执行（类似 JVM 模式）。AI 推理走的是"性能关键部分原生，业务逻辑 Python"的混合，Java 也可以"推理 JNI 原生，业务 Native Image"。

5. **怎么用 AI 评估 Native Image 迁移的成本收益？**
   静态分析：扫描代码的反射/动态代理/Class.forName 用法，评估配置文件复杂度。运行时：Tracing Agent 收集实际反射调用，估算配置覆盖率。结合业务场景（冷启动频率、内存压力、吞吐需求）输出迁移评分。低于 70 分（配置太复杂或兼容性差）建议保留 JVM，高于 90 分推荐 Native。

## 六、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"AOT 编译、封闭世界、3 个配置文件、Spring AOT 自动 95%、场景选型"**。

- **本质**：AOT 编译替代 JIT，启动 < 100ms，内存降 80%
- **代价**：无 JIT（吞吐低 10-30%）、反射要配置、构建 5-10 分钟
- **配置**：reflect-config.json / resource-config.json / proxy-config.json
- **Spring AOT**：Spring Boot 3 自动生成 95% 配置
- **Tracing Agent**：JVM 模式跑业务自动收集配置
- **适合**：Serverless / Function / CLI / 短生命周期
- **不适合**：长运行高吞吐、强依赖反射的库

### 拟人化理解

把 Native Image 想成**把汽车拆了改装成自行车**。汽车（JVM）启动慢（要热车、点火、JIT 预热）、占地大（1GB），但跑起来快（JIT 优化）。自行车（Native Image）启动快（一脚蹬就跑）、占地小（200MB 车棚就够），但跑不快（无 JIT）。短途（Serverless / CLI）选自行车，长途高速（长运行高吞吐）选汽车。改装（AOT）时要把汽车所有零件（反射、动态代理、资源）固化到自行车上（配置文件），否则零件丢失（运行时报错）。

### 面试现场 60 秒回答

> Native Image 是 GraalVM 的 AOT 编译，把 Spring Boot 应用编译成原生二进制——启动从 30s 降到 50ms、内存从 1GB 降到 200MB，代价是无 JIT 优化（峰值吞吐降 10-30%）、反射要配置（reflect-config.json）、构建 5-10 分钟。封闭世界假设：构建时扫描所有可达代码固化，运行时不能动态加载。Spring Boot 3 + Spring AOT 自动生成 95% 配置，剩下 5%（第三方库反射）用 Tracing Agent 收集。适合 Serverless / Function / CLI / 短生命周期服务，不适合长运行高吞吐、强依赖反射的库（如 Hibernate < 6.2）。选型：冷启动频率高 + 内存敏感选 Native，吞吐敏感 + 长运行选 JVM。

### 反问面试官

> 贵司有没有 Serverless / Function 场景？现在的冷启动表现怎么样？业务是吞吐敏感（长运行微服务）还是延迟敏感（CLI / Function）？这决定我聊 Native Image 落地还是 JVM 调优。

## 七、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不直接用 Go / Rust 写 Serverless，要 Java Native Image？ | 团队栈、生态成熟（Spring Boot）、复用现有 Java 代码。Go/Rust 启动也快但团队要重学，Java Native Image 是"零迁移成本拿 Serverless 收益"。证明：用 Java Native Image 的团队 1 周落地，换 Go 要 3 个月重写 |
| 证据追问 | 怎么证明 Native Image 真的有收益？ | 启动时间对比（50ms vs 30s）、内存对比（200MB vs 1GB）、K8s HPA 扩容时效（Native 秒级扩容 vs JVM 几十秒）、冷启动频率（Serverless 场景每天万次冷启动，节省的时间累计可观） |
| 边界追问 | Native Image 能完全替代 JVM 吗？ | 不能。长运行高吞吐服务（JIT 优势）、复杂反射/动态字节码（配置成本高）、需要运行时类加载（封闭世界不允许）、调试复杂场景（Native 调试受限）。互补，不替代 |
| 反例追问 | 什么场景不要用 Native Image？ | 长运行高吞吐（JIT 优势大）、强依赖反射的库（如老版 Hibernate）、需要运行时加载插件、调试频繁（Native 调试慢）、构建时间敏感（5-10 分钟太长） |
| 风险追问 | 迁移到 Native Image 最大风险？ | ① 兼容性（第三方库反射未配置，运行时报错）；② 性能（吞吐降 10-30% 可能不够）；③ 构建慢（CI/CD 时间翻倍）；④ 调试受限（IDE 支持 Native 模式调试较弱）。治法：用 Tracing Agent 收集配置、压测验证吞吐、并行构建 |
| 验证追问 | 怎么证明 Native Image 落地后没引入新问题？ | 单元测试（同代码两套构建都跑）、压测（启动时间、吞吐、内存）、灰度（同服务 JVM 和 Native 双跑，业务指标对比）、监控（错误率、P99 RT） |
| 沉淀追问 | 团队推广 Native Image 沉淀什么？ | Spring Boot 3 + Native 构建模板、reflect-config 维护指南、第三方库兼容清单（已验证支持的库）、Tracing Agent 使用 SOP、JVM/Native 双模式构建脚本 |

### 现场对话示例

**面试官**：为什么 Serverless 要用 Native Image，不能直接用 JVM 启动优化一下？

**候选人**：JVM 启动慢的根因是设计层面——加载类、初始化 Bean、JIT 预热都依赖运行时。即使做了 Spring Boot 启动优化（懒加载、CRaC 快照恢复），最好也是 2-3 秒。Native Image 在构建时完成所有这些工作，运行时直接执行机器码，启动 50ms。对于 Knative 缩到 0 后再起的场景（用户感知冷启动），50ms vs 3s 是用户体验的质变。另外内存省 80%，同样节点能跑更多实例。

**面试官**：反射配置很麻烦吧？

**候选人**：Spring Boot 3 之前确实麻烦，要手写 reflect-config.json。Spring Boot 3 + Spring AOT 引擎自动生成 95% 配置——它分析所有 Bean 定义，知道哪些类要反射、哪些方法要调用、哪些代理要生成。剩下的 5%（第三方库的反射，如 Jackson、Hibernate）用 Tracing Agent 收集：JVM 模式跑完整业务，agent 自动记录所有反射调用生成配置。Hibernate 6.2+ 内置 GraalVM 支持，Jackson 2.13+ 也支持，主流生态已经成熟。

**面试官**：峰值吞吐低 20% 怎么办？

**候选人**：三个解法。第一，GraalVM 的 PGO（Profile-Guided Optimization）：先构建 instrumented 版本收集 profile，再用 profile 重新构建，吞吐接近 JVM 的 80-90%。第二，加副本：Native 内存省 80%，同样节点能跑 4 倍副本，总吞吐可能超 JVM。第三，业务选型：Serverless 场景吞吐不是首要（每个实例处理少量请求），启动和内存更重要。如果是吞吐敏感的长运行服务，还是选 JVM 模式。

## 常见考点

1. **Native Image 是什么？**——GraalVM 的 AOT 编译，把 Java 应用编译成原生二进制。启动 < 100ms，内存降 80%，代价是无 JIT（吞吐降 10-30%）、反射要配置。
2. **Native Image 和 JVM 模式怎么选？**——Serverless / Function / CLI / 短生命周期选 Native；长运行高吞吐、强反射选 JVM。看场景。
3. **reflect-config.json 怎么生成？**——Spring Boot 3 + Spring AOT 自动生成 95%；剩余 5% 用 Tracing Agent（native-image-agent）跑 JVM 模式业务收集。
4. **为什么启动这么快？**——AOT 编译在构建时完成类加载、Bean 初始化、代码编译，运行时直接执行机器码。封闭世界假设让所有可达代码固化。
5. **峰值吞吐为什么低？**——无 JIT 动态优化（JVM 的 C2 基于 profile 优化，Native 是 AOT 静态编译）；默认 Serial GC（GraalVM 23+ 支持 G1）。可用 PGO 缓解。

## 结构化回答

**30 秒电梯演讲：** Native Image 是 GraalVM 的 AOT（Ahead-Of-Time）编译——把 Spring Boot 应用编译成原生可执行文件，启动时间从 30 秒降到 50ms，内存占用从 1GB 降到 100MB。代价是失去 JIT 优化（峰值吞吐降 10-30%）、反射/动态代理要配置（reflect-config.json）、构建时间长（5-10 分钟）。它是 Serverless / 函数计算 / CLI 工具的杀手锏，但不是长运行服务的最佳选择

**展开框架：**
1. **Native Image（GraalVM）** — AOT 编译，启动 < 100ms，内存降 80%
2. **代价** — 无 JIT（峰值吞吐降 10-30%）、反射/动态代理要配置、构建慢（5-10 分钟）
3. **reflect** — config.json / resource-config.json / proxy-config.json 配置文件

**收尾：** 以上是我的整体思路。您想继续深入聊——Native Image 和 JVM 模式怎么选？


## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：Native Image 与 JVM 模式如何选 | "这题核心是——Native Image 是 GraalVM 的 AOT（Ahead-Of-Time）编译——把 S……" | 开场钩子 |
| 0:15 | 像把一部汽车（JVM + JIT）拆了重装成自行类比图 | "打个比方：像把一部汽车（JVM + JIT）拆了重装成自行。" | 核心类比 |
| 0:40 | Native示意/对比图 | "AOT 编译，启动 < 100ms，内存降 80%" | Native要点 |
| 1:05 | 代价示意/对比图 | "无 JIT（峰值吞吐降 10-30%）、反射/动态代理要配置、构建慢（5-10 分钟）" | 代价要点 |
| 1:30 | reflect示意/对比图 | "config.json / resource-config.json / proxy-config.json 配置文件" | reflect要点 |
| 1:55 | 总结卡 | "记住：Native Image。下期见。" | 收尾 |
