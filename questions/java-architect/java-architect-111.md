---
id: java-architect-111
difficulty: L3
category: java-architect
subcategory: Spring Boot
tags:
- Java 架构师
- Spring Boot 3
- Jakarta EE
- 升级
feynman:
  essence: Spring Boot 3 强制把 javax.* 全部改成 jakarta.*（Java EE → Jakarta EE 9+ 的命名空间迁移），这是一次"包名变更"，不是"API 行为变更"。但因为 javax.* 在 Java 生态渗透极深（Servlet/JPA/JMS/Validation/...），所有依赖都要同步升级，是事实上的"生态级 break change"。
  analogy: 像把全国所有"长安街"改名"建国街"——街道没变、商店没变，但所有地图、导航、快递地址都要更新。改的不只是地址（包名），还有依赖地址的所有系统（库、框架、文档）。
  first_principle: Java EE 是 Oracle 给 Eclipse Foundation 时要求的"改名条件"——javax.* 是 Oracle 商标，Jakarta 不能继续用。所以 Jakarta EE 9+ 把所有 javax.* 改成 jakarta.*，Spring Boot 3 跟随 Jakarta EE 9，强制升级。
  key_points:
  - Spring Boot 3 强制 javax.* → jakarta.*（命名空间迁移）
  - 影响范围：Servlet/JPA/JMS/Validation/Annotation/WebSocket 全部
  - 依赖联动：所有第三方库要 Jakarta 版本（Hibernate 6+ / Tomcat 10+ / Jersey 3+）
  - 工具：Spring Boot Migrator / OpenRewrite 自动重构
  - 风险：间接依赖的 javax 残留（如老版 JDBC 驱动）
first_principle:
  problem: Spring Boot 3 升级的最大风险点是什么，怎么治理？
  axioms:
  - javax.* → jakarta.* 是 Spring Boot 3 的硬性要求
  - 改名涉及整个 Java EE 生态（Servlet/JPA/JMS/...）
  - 间接依赖（传递依赖）的 javax 残留是最隐蔽的风险
  rebuild: 升级分三步：① 业务代码 javax.* → jakarta.*（IDE 一键替换）；② 直接依赖升级到 Jakarta 版本（Hibernate 6+/Tomcat 10+）；③ 间接依赖排查（mvn dependency:tree 找 javax 残留，替换或排除）。用 Spring Boot Migrator / OpenRewrite 自动化。最后用压测验证行为不变（包名变了 API 不变）。
follow_up:
  - 为什么不改成 javax 保留兼容？——Oracle 商标要求，javax 是 Oracle 资产，Jakarta 不能继续用。Eclipse Foundation 必须改名才能拿到 Java EE 商标授权
  - Jakarta EE 9 之后的 API 行为有变吗？——大多数 API 行为不变（只是包名变），少数 API 有微调（如 Servlet 6 的 Declarative Support 移除）
  - 业务代码改 import 工作量大吗？——一两个服务的代码量可接受，IDE 全局替换 import 即可。但跨服务的 API 契约（如 gRPC/Thrift 生成的代码）要重新生成
  - Spring Boot 2.7 还有 LTS 吗？——Spring Boot 2.7 的 OSS 支持已结束（2023.11），商业支持（VMware Spring Runtime）持续到 2026.8。生产建议尽早升级到 3.x
  - 升级时 Hibernate 5 → 6 有什么坑？——Hibernate 6 的类型系统重构（AttributeConverter）、Criteria API 改动、Schema 生成器变化。要全面回归测试
memory_points:
  - Spring Boot 3 强制 javax.* → jakarta.*（Jakarta EE 9 命名空间迁移）
  - 影响范围：Servlet/JPA/JMS/Validation/Annotation/WebSocket 全部
  - 直接依赖升级：Hibernate 6+ / Tomcat 10+ / Jersey 3+
  - 间接依赖排查：mvn dependency:tree 找 javax 残留
  - 工具：Spring Boot Migrator / OpenRewrite 自动重构
  - JDK 要求：Spring Boot 3 最低 JDK 17
---

# 【Java 后端架构师】Spring Boot 3.x 升级到 Jakarta EE 的风险治理

> 适用场景：JD 核心技术。订单中心要从 Spring Boot 2.7 升级到 3.x（拿虚拟线程、Native Image、JDK 21 特性），但代码里 javax.servlet / javax.persistence 漫山遍野，间接依赖还有 javax 残留。架构师必须能用工具治理升级、保证线上行为不变。

## 一、概念层：javax → jakarta 改名的来龙去脉

**改名的根本原因**：

```
2017：Oracle 把 Java EE 交给 Eclipse Foundation
       ↓
       Oracle 要求：javax.* 是 Oracle 商标，Jakarta 不能继续用
       ↓
2019：Jakarta EE 8（最后一份用 javax.* 的版本）
       ↓
2020：Jakarta EE 9（命名空间迁移：javax.* → jakarta.*）
       ↓
2022：Spring Boot 3（基于 Jakarta EE 9+，强制改名）
```

**影响范围**（这张表面试必问）：

| 包名（javax.* → jakarta.*） | 用途 | 升级后版本 |
|-----------------------------|------|-----------|
| javax.servlet.* | Servlet API | Servlet 6.0（Tomcat 10+） |
| javax.persistence.* | JPA / Hibernate | JPA 3.1（Hibernate 6+） |
| javax.validation.* | Bean Validation | Validation 3.0 |
| javax.annotation.* | 注解（@PostConstruct 等） | Annotation 2.0 |
| javax.jms.* | Java Message Service | JMS 3.1 |
| javax.ws.rs.* | JAX-RS（REST） | JAX-RS 3.1（Jersey 3+） |
| javax.websocket.* | WebSocket | WebSocket 2.0 |
| javax.transaction.* | JTA 事务 | JTA 2.0 |

**直接代码影响**（业务侧）：

```java
// Spring Boot 2.x（javax）
import javax.servlet.http.HttpServletRequest;
import javax.persistence.Entity;
import javax.validation.constraints.NotNull;
import javax.annotation.PostConstruct;

// Spring Boot 3.x（jakarta）
import jakarta.servlet.http.HttpServletRequest;
import jakarta.persistence.Entity;
import jakarta.validation.constraints.NotNull;
import jakarta.annotation.PostConstruct;
```

## 二、机制层：升级路径与依赖联动

**Spring Boot 2.7 → 3.x 升级路径**：

```
Step 1: JDK 升级（17+）
        ↓ （Spring Boot 3 最低 JDK 17）
Step 2: Spring Boot 升级（2.7 → 3.x）
        ↓ （pom.xml 父 pom 改版本）
Step 3: 业务代码 javax.* → jakarta.*
        ↓ （IDE 全局替换 import）
Step 4: 直接依赖升级到 Jakarta 版本
        ↓ （Hibernate 6+ / Tomcat 10+ / Validation 3.0）
Step 5: 间接依赖排查（javax 残留）
        ↓ （mvn dependency:tree）
Step 6: 行为验证（压测、回归）
        ↓ （API 行为不变，只是包名变）
```

**直接依赖升级**（pom.xml 关键变更）：

```xml
<!-- Spring Boot 3 父 pom -->
<parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.2.0</version>      <!-- 原 2.7.x -->
</parent>

<!-- Java 版本 -->
<properties>
    <java.version>17</java.version>   <!-- 原 8 或 11 -->
</properties>

<!-- 关键依赖升级（Spring Boot 3 已自动管理版本） -->
<dependencies>
    <!-- Servlet API（自动 jakarta） -->
    <dependency>
        <groupId>jakarta.servlet</groupId>
        <artifactId>jakarta.servlet-api</artifactId>
        <!-- 不写版本，Spring Boot 3 管理 -->
    </dependency>

    <!-- JPA / Hibernate 6（自动 jakarta） -->
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-data-jpa</artifactId>
        <!-- Hibernate 6+ 内置 jakarta.persistence -->
    </dependency>

    <!-- Validation（jakarta.validation） -->
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-validation</artifactId>
        <!-- 自动 jakarta.validation.constraints.NotNull -->
    </dependency>
</dependencies>
```

**间接依赖排查**（最隐蔽的风险）：

```bash
# 1. 查所有 javax 残留
mvn dependency:tree | grep -i javax

# 2. 排查关键残留（如老版 JDBC 驱动）
mvn dependency:tree -Dincludes=javax.persistence:*

# 输出示例：
# [INFO] com.jd:order-service:jar:1.0.0
# [INFO] +- org.apache.commons:commons-lang3:jar:3.12.0
# [INFO] +- javax.mail:mailapi:jar:1.6.0   ← javax 残留！
# [INFO] |  \- javax.activation:activation:jar:1.1

# 3. 替换为 Jakarta 版本
<dependency>
    <groupId>jakarta.mail</groupId>           <!-- 原 javax.mail -->
    <artifactId>jakarta.mail-api</artifactId>
    <version>2.1.0</version>
</dependency>

# 4. 或者排除 javax 残留
<dependency>
    <groupId>some.library</groupId>
    <artifactId>legacy-lib</artifactId>
    <exclusions>
        <exclusion>
            <groupId>javax.servlet</groupId>     <!-- 排除 javax.servlet -->
            <artifactId>servlet-api</artifactId>
        </exclusion>
    </exclusions>
</dependency>
```

## 三、实战层：用工具自动化升级

**Spring Boot Migrator（官方工具）**：

```bash
# 1. 下载 Spring Boot Migrator
git clone https://github.com/spring-projects/spring-boot-migrator
cd spring-boot-migrator
./mvnw clean install

# 2. 启动 GUI
java -jar target/spring-boot-migrator.jar
# 或命令行
java -jar target/spring-boot-migrator.jar --batch \
  --app-path /path/to/your/app \
  --migration javax-to-jakarta

# 3. 自动重构（生成 diff）
# - javax.servlet.* → jakarta.servlet.*
# - javax.persistence.* → jakarta.persistence.*
# - 自动升级 Hibernate 5 → 6
# - 自动升级 Tomcat 9 → 10
```

**OpenRewrite（更强大的重构工具）**：

```xml
<!-- pom.xml 加 OpenRewrite 插件 -->
<plugin>
    <groupId>org.openrewrite.maven</groupId>
    <artifactId>rewrite-maven-plugin</artifactId>
    <version>5.0.0</version>
    <configuration>
        <activeRecipes>
            <recipe>org.openrewrite.java.spring.boot3.UpgradeSpringBoot_3_0</recipe>
            <recipe>org.openrewrite.java.migrate.jakarta.JavaxMigrationToJakarta</recipe>
        </activeRecipes>
    </configuration>
    <dependencies>
        <dependency>
            <groupId>org.openrewrite.recipe</groupId>
            <artifactId>rewrite-spring</artifactId>
            <version>5.0.0</version>
        </dependency>
        <dependency>
            <groupId>org.openrewrite.recipe</groupId>
            <artifactId>rewrite-migrate-java</artifactId>
            <version>2.0.0</version>
        </dependency>
    </dependencies>
</plugin>
```

```bash
# 执行升级
mvn rewrite:run        # 应用所有 recipe，自动重构代码
mvn rewrite:dryRun     # 预览变更（生成 rewrite.patch）
```

**IDE 全局替换**（手动兜底）：

```
IntelliJ IDEA:
  Edit → Find in Files → Replace in Files
  搜索：import javax\.(servlet|persistence|validation|annotation|jms|ws\.rs|websocket|transaction)\.
  替换：import jakarta.$1.

  注意：javax.crypto.* / javax.sql.* / javax.net.* 是 JDK 自带，不要替换！
```

**升级回归测试**：

```bash
# 1. 单元测试（同代码两套构建跑）
mvn test -Pboot2     # Spring Boot 2.7
mvn test -Pboot3     # Spring Boot 3.x
# 对比测试结果，行为应一致

# 2. 集成测试（API 契约）
# - 同一接口在 Boot 2 和 Boot 3 行为应一致
# - 重点关注：Multipart 文件上传、Annotation 处理、Validation 行为

# 3. 压测对比
wrk -t8 -c100 -d60s http://order-service-boot2/api/orders
wrk -t8 -c100 -d60s http://order-service-boot3/api/orders
# QPS / P99 应基本一致（Jakarta 升级不引入性能变化）
```

## 四、底层本质：为什么改名这么麻烦

回到第一性：**为什么 javax → jakarta 这种"只是改名"的变更会引发大量工作？**

- **Java EE 生态渗透深**：javax.* 是 Java 早期就有的命名空间，从 Servlet 2.x（2000 年）到 JPA 2.x（2010 年）渗透了 20 年。所有 Java Web 应用都有 javax 依赖，所有教程、文档、库都假设 javax。
- **依赖图复杂**：一个 Spring Boot 2.7 应用的依赖树有几百个，其中几十个直接或间接依赖 javax.*。即使你升级了直接依赖（Hibernate 6），间接依赖（如某个工具库依赖 Hibernate 5）仍可能引入 javax。
- **JDK 自带的 javax 不能动**：javax.crypto.* / javax.sql.* / javax.net.* / javax.naming.* 是 JDK 自带的（rt.jar / java.xml 模块），不要替换。只有 Java EE 的 javax 要改。这要求工具能区分（OpenRewrite 已处理）。

**为什么不能 javax 和 jakarta 并存**：
- 同一个类（如 User）的字节码里如果引用 javax.persistence.Entity，运行时找不到这个类（jakarta.persistence.Entity 是不同的全限定名），抛 ClassNotFoundException
- 所以必须 100% 迁移，不能半迁移

**Spring Boot 3 的硬性要求**：
- JDK 17+（最低要求，因为 Spring 6 用了 record、sealed、pattern matching）
- Jakarta EE 9+（命名空间迁移）
- Hibernate 6+（JPA 3.1）
- Tomcat 10+（Servlet 6.0）

**Spring Boot 2.7 的支持状态**：
- OSS 支持已结束（2023 年 11 月）
- 商业支持（VMware Spring Runtime）持续到 2026 年 8 月
- 生产建议：2026 年前升级到 3.x

## 五、AI 架构师加问：5 个

1. **AI 自动化升级 Spring Boot 2.7 → 3.x，怎么设计？**
   AI 调用 OpenRewrite / Spring Boot Migrator 做基础重构（包名替换、依赖升级）。AI 增量价值：处理工具无法覆盖的间接依赖（分析 mvn dependency:tree）、识别 javax 残留的库并推荐替代、生成回归测试用例。输出升级 PR + 风险评估，人工 review。

2. **AI 推理服务的 Spring Boot 升级要特殊处理吗？**
   AI 服务的特殊性在依赖（PyTorch / DJL / ONNX Runtime 的 Java binding）。这些 JNI 库的 javax 依赖可能没 Jakarta 版本。解法：保留 javax 版本但 scope=provided（编译时用，运行时 JNI 自己加载）；或隔离到独立模块不参与 Spring Boot 3 的 Jakarta 强制。

3. **AI 怎么评估升级的风险点？**
   静态分析：mvn dependency:tree 找所有 javax 残留、扫描代码的 import 找工具识别不到的用法（如 Class.forName("javax.persistence.Entity")）。结合历史升级事故库（哪些库常出问题），输出 Top N 风险库 + 验证方法。误报控制：JDK 自带的 javax 不要标记。

4. **大模型生成的代码可能同时有 javax 和 jakarta，怎么治理？**
   AI Copilot 训练数据混了 javax 和 jakarta（早期文档是 javax，新文档是 jakarta），生成代码可能两个都用。解法：Code Review 工具（Checkstyle / SpotBugs）配置规则强制 jakarta，AI 出错就告警；CI 流水线加 javax 检测脚本，发现就 fail。

5. **升级后怎么证明业务行为不变？**
   契约测试（Pact / Spring Cloud Contract）：升级前后 API 响应对比；端到端测试（同业务场景跑 Boot 2 和 Boot 3，diff 结果）；金丝雀发布（Boot 2 和 Boot 3 双版本灰度，对比错误率、P99 RT）；业务对账（关键业务如订单一致性，升级前后差错率对比）。

## 六、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"javax → jakarta、依赖联动、间接残留、工具自动化、行为不变"**。

- **本质**：javax.* → jakarta.* 命名空间迁移（Oracle 商标要求）
- **影响**：Servlet/JPA/JMS/Validation/Annotation/WebSocket 全部
- **直接依赖**：Hibernate 6+ / Tomcat 10+ / Jersey 3+
- **间接残留**：mvn dependency:tree 找 javax，替换或排除
- **工具**：Spring Boot Migrator / OpenRewrite 自动重构
- **JDK**：Spring Boot 3 最低 JDK 17
- **验证**：包名变但 API 行为不变，回归 + 压测

### 拟人化理解

把 javax → jakarta 想成**全国"长安街"改名"建国街"**。街道没变（API 行为）、商店没变（业务逻辑），但所有地图（依赖图）、导航（IDE 引用）、快递地址（import 语句）都要更新。改名本身不难（IDE 一键替换），难的是"间接地址"——比如某个老牌商店（第三方库）的招牌还写着"长安街分店"（依赖 javax.servlet），要么换招牌（升级到 Jakarta 版本），要么关店（排除依赖）。

### 面试现场 60 秒回答

> Spring Boot 3 强制 javax.* → jakarta.*，是 Jakarta EE 9 命名空间迁移（Oracle 商标要求）。影响 Servlet/JPA/JMS/Validation/Annotation 等 Java EE 全套。升级分四步：① JDK 升到 17+；② 业务代码 IDE 全局替换 import（javax.servlet → jakarta.servlet，但 javax.crypto/sql/net 是 JDK 自带不能动）；③ 直接依赖升 Jakarta 版本（Hibernate 6+ / Tomcat 10+）；④ 间接依赖排查 mvn dependency:tree 找 javax 残留，替换或排除。工具用 Spring Boot Migrator / OpenRewrite 自动化。验证：包名变但 API 行为不变，跑回归 + 压测对比 Boot 2 和 Boot 3 行为一致。最大风险是间接依赖的 javax 残留（如老版 JDBC 驱动、邮件库），导致运行时 ClassNotFoundException。

### 反问面试官

> 贵司当前 Spring Boot 版本？有没有升级计划？业务里 Hibernate 用得深吗（Criteria API / 类型系统）？间接依赖有自研或老库吗？这决定我聊 Jakarta 升级路径还是 Hibernate 6 兼容性深挖。

## 七、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么必须升级 Spring Boot 3，2.7 不能继续用？ | 2.7 的 OSS 支持已结束（2023.11），商业支持 2026.8 截止。3.x 的虚拟线程、Native Image、JDK 21 特性是性能拐点。安全补丁只给 3.x。证明：升级后拿虚拟线程 QPS 翻倍、Native Image 启动快 300 倍 |
| 证据追问 | 怎么证明升级后行为不变？ | 单元测试对比（Boot 2/3 跑同样用例）、API 契约测试（Pact）、压测对比（QPS/P99 一致）、金丝雀发布（双版本灰度，错误率 diff）、业务对账（订单一致性差错率不升） |
| 边界追问 | 升级能解决所有问题吗？ | 不能。解决的是命名空间和 Spring 6 特性；解决不了业务逻辑 bug、性能调优、架构问题。升级后仍要单独评估 GC、JVM、容器参数 |
| 反例追问 | 什么场景不要升级 Spring Boot 3？ | 业务代码用大量 javax 第三方库（无 Jakarta 版本）、强依赖 JDK 8（无法升 17）、稳定运行无新需求（升级 ROI 低）、内部框架未支持 Jakarta（如自研 ORM）。这些场景先评估依赖兼容性再决定 |
| 风险追问 | 升级最大风险？ | ① 间接依赖 javax 残留（运行时 ClassNotFoundException）；② Hibernate 5→6 类型系统变化（AttributeConverter 行为差异）；③ Spring Security 配置变更（WebSecurityConfigurerAdapter 移除）。治法：dependency:tree 全排查、Hibernate 6 单独验证、Security 配置重构 |
| 验证追问 | 怎么证明升级真的成功？ | 同代码 Boot 2/3 双构建测试通过；金丝雀灰度双版本对比错误率、P99；业务对账无差异；JFR/JStack 监控无异常类加载 |
| 沉淀追问 | 团队升级沉淀什么？ | Spring Boot 3 升级 SOP（含 dependency:tree 检查清单）、OpenRewrite recipe 配置、Jakarta 第三方库兼容清单、回归测试模板、JDK 17 升级指南 |

### 现场对话示例

**面试官**：升级 Spring Boot 3 最大坑是什么？

**候选人**：间接依赖的 javax 残留。直接依赖升级简单（pom.xml 改版本），但 mvn dependency:tree 会发现一堆间接依赖还在引 javax.servlet 或 javax.persistence。比如某个工具库依赖 Hibernate 5，自动拉 javax.persistence:hibernate-jpa-2.1-api，运行时和 Hibernate 6 的 jakarta.persistence 冲突。解法：要么升级工具库到 Jakarta 版本，要么 exclusion 排除 javax 依赖，要么隔离到独立模块。这是升级最耗时的部分。

**面试官**：javax.crypto 和 javax.servlet 都要改吗？

**候选人**：不一样。javax.servlet / javax.persistence / javax.validation 是 Java EE 的，要改成 jakarta。但 javax.crypto / javax.sql / javax.net / javax.naming 是 JDK 自带的（rt.jar / java.xml 模块），不要改！工具（OpenRewrite）已经识别这点，只改 Java EE 的 javax。手动 IDE 替换要小心，避免误改 JDK 自带的 javax。

**面试官**：Hibernate 5 → 6 有什么坑？

**候选人**：三个主要变化。第一，类型系统重构——Hibernate 6 重新设计了 Type 系统，AttributeConverter 的注册方式变了，自定义类型可能要适配。第二，Criteria API 微调——某些 deprecated 方法移除，编译过但运行时报错。第三，Schema 生成器变化——ddl-auto 的生成 SQL 可能和 Hibernate 5 略不同，要 diff 验证不影响生产 schema。建议：升级前单独跑 Hibernate 5/6 的单元测试对比 SQL 输出，确保 ORM 行为一致。

## 常见考点

1. **Spring Boot 3 为什么强制 Jakarta EE？**——Oracle 把 Java EE 交给 Eclipse Foundation 时要求改名（javax 是 Oracle 商标）。Jakarta EE 9 把 javax.* → jakarta.*，Spring Boot 3 跟随。
2. **javax.* 和 jakarta.* 区别？**——包名不同（语义相同）。javax 是 Java EE 老命名，jakarta 是新命名。Spring Boot 3 强制 jakarta。
3. **怎么自动升级？**——Spring Boot Migrator（官方 GUI）或 OpenRewrite（Maven 插件，可集成 CI）。自动重构包名 + 升级直接依赖。
4. **间接依赖的 javax 残留怎么排查？**——mvn dependency:tree | grep javax，找到残留后升级到 Jakarta 版本或 exclusion 排除。
5. **JDK 自带的 javax 要改吗？**——不要！javax.crypto / javax.sql / javax.net / javax.naming 是 JDK 自带，不属于 Java EE，保持原样。

## 结构化回答

**30 秒电梯演讲：** Spring Boot 3 强制把 javax.* 全部改成 jakarta.*（Java EE → Jakarta EE 9+ 的命名空间迁移），这是一次包名变更，不是API 行为变更。但因为 javax.* 在 Java 生态渗透极深（Servlet/JPA/JMS/Validation/...），所有依赖都要同步升级，是事实上的生态级 break change

**展开框架：**
1. **Spring Boot** — Spring Boot 3 强制 javax.* → jakarta.*（命名空间迁移）
2. **影响范围** — Servlet/JPA/JMS/Validation/Annotation/WebSocket 全部
3. **依赖联动** — 所有第三方库要 Jakarta 版本（Hibernate 6+ / Tomcat 10+ / Jersey 3+）

**收尾：** 以上是我的整体思路。您想继续深入聊——为什么不改成 javax 保留兼容？


## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：Spring Boot 3.x 升级到 Jaka | "这题核心是——Spring Boot 3 强制把 javax.* 全部改成 jakarta.*（Java EE →……" | 开场钩子 |
| 0:15 | 像把全国所有长安街改名建国街——街道没变类比图 | "打个比方：像把全国所有长安街改名建国街——街道没变。" | 核心类比 |
| 0:40 | Spring Boot示意/对比图 | "Spring Boot 3 强制 javax.* → jakarta.*（命名空间迁移）" | Spring Boot要点 |
| 1:05 | 影响范围示意/对比图 | "Servlet/JPA/JMS/Validation/Annotation/WebSocket 全部" | 影响范围要点 |
| 1:55 | 总结卡 | "记住：Spring Boot 3。下期见。" | 收尾 |
