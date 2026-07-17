---
id: java-architect-049
difficulty: L2
category: java-architect
subcategory: 数据隔离
tags:
- Java 架构师
- 权限
- RBAC
- ABAC
feynman:
  essence: RBAC 解决"功能权限"（谁能调什么接口），ABAC 解决"数据权限"（谁能看哪条数据）。RBAC 是"用户-角色-权限"三元组，简单稳定；ABAC 是"属性+策略"动态决策，能表达"销售只能看自己负责区域的订单"。企业级系统两者叠加：RBAC 控制能否访问订单菜单，ABAC 控制访问后能看到哪些订单行。
  analogy: 像写字楼的门禁系统。RBAC 是门卡——你有主管卡能进 10 楼（功能权限），没卡连电梯都上不了。ABAC 是楼层内的文件柜锁——同样是 10 楼的主管，张三只能开自己部门的柜子（数据权限），不能开李四部门的。门卡（RBAC）决定你能不能进，柜锁（ABAC）决定你进来后能看什么。
  first_principle: 为什么 RBAC 不够用？因为"功能权限"是粗粒度的（能/不能调订单查询接口），但"数据权限"是细粒度的（同样是订单查询接口，不同人看到不同的订单集合）。如果把数据权限塞进 RBAC，角色会爆炸——每个销售负责的区域不同，就要建 N 个角色。ABAC 用"属性+规则"动态计算，避免角色爆炸。
  key_points:
  - RBAC0：User-Role-Permission 三元组；RBAC1 加角色继承；RBAC2 加职责分离（SoD）
  - ABAC：Subject（主体属性）+ Resource（资源属性）+ Environment（环境属性）+ Policy（策略）
  - 数据权限三要素：行级（WHERE org_id=?）、列级（字段脱敏）、操作级（能查不能改）
  - 数据权限落地：SQL 拦截器自动追加 WHERE 条件（MyBatis Interceptor）
  - 权限缓存：角色权限变化要主动失效，不能用纯 TTL
first_principle:
  problem: 如何在不角色爆炸的前提下，实现"功能权限 + 细粒度数据权限"的统一管控？
  axioms:
  - 功能权限是静态的（菜单/按钮/API），适合用角色固化
  - 数据权限是动态的（每个人看到的数据范围不同），用属性规则计算
  - 数据权限必须落在 SQL 层（WHERE 条件），不能靠业务代码手动 if-else（容易漏）
  rebuild: 功能层用 RBAC——User 绑定 Role，Role 绑定 Permission（API/菜单），启动时加载到内存。数据层用 ABAC——定义策略（如"销售只能看自己负责区域的订单"），运行时 MyBatis 拦截器解析策略，自动在 SQL 追加 WHERE org_id = currentUser.orgId。两层独立但叠加：RBAC 决定能否访问接口，ABAC 决定访问后的数据范围。
follow_up:
  - 角色爆炸怎么办？——避免把"数据维度"塞进角色。角色只管功能（订单管理员/财务管理员），数据维度（负责区域）用 ABAC 动态算。一个用户一个角色 + N 个数据属性，比 N 个角色简单。
  - 数据权限的 SQL 注入怎么做？——MyBatis Interceptor 拦截 SQL，解析表名，根据当前用户的属性追加 WHERE 条件。京东用自研的 DataPermissionInterceptor，配合 @DataScope 注解声明数据范围。
  - 字段级权限怎么实现？——DTO 字段标注 @Sensitive，序列化时根据权限脱敏（手机号显示 138****8888）。用 Jackson 的 JsonSerializer 实现。
  - 权限缓存怎么失效？——用户角色变化时，发事件主动失效该用户的权限缓存。角色权限变化时，失效所有持有该角色的用户缓存。不能纯靠 TTL，否则权限收回有延迟。
  - Spring Security 怎么集成 RBAC？——@PreAuthorize("hasRole('ORDER_ADMIN')") 注解做方法级鉴权，自定义 UserDetailsService 加载用户角色。数据权限用自定义 PermissionEvaluator 或拦截器。
memory_points:
  - RBAC = 功能权限（User-Role-Permission），ABAC = 数据权限（属性+策略）
  - 数据权限三维度：行级（WHERE）、列级（脱敏）、操作级（查/改/删）
  - SQL 拦截器自动追加 WHERE，不靠业务代码 if-else
  - 权限缓存变更主动失效，不能纯 TTL
  - 角色爆炸解法：功能用 RBAC，数据维度用 ABAC
---

# 【Java 后端架构师】权限模型 RBAC、ABAC 与数据权限

> 适用场景：JD 核心技术。京东商家后台，张三（服饰类目销售）登录后能看到订单菜单，但只能看自己负责的服饰商家订单，看不到电子类目的订单。这是两层权限：RBAC 决定张三能进订单菜单，ABAC 决定他看到哪些订单行。

## 一、概念层：RBAC 与 ABAC 的分工

**两层权限矩阵**（面试必画）：

```
┌─────────────────────────────────────────────────────────┐
│  功能权限（RBAC）                                         │
│  User → Role → Permission                                │
│  张三 → 销售 → [订单查询, 订单导出, 客户管理]              │
│  李四 → 财务 → [对账查询, 退款审批, 报表导出]              │
├─────────────────────────────────────────────────────────┤
│  数据权限（ABAC）                                         │
│  Subject: {userId, role, orgId, region}                  │
│  Resource: {table: order, columns: [amount, phone]}      │
│  Environment: {time: work_hour, ip: 内网}                │
│  Policy:                                                  │
│    - 销售只能看自己区域的订单（行级）                      │
│    - 销售看不到订单的客户手机号（列级脱敏）                 │
│    - 非工作时间禁止导出（操作级）                          │
└─────────────────────────────────────────────────────────┘

张三调用"订单查询"接口：
  RBAC 判断：张三有"订单查询"权限？✓ 通过
  ABAC 判断：自动在 SQL 追加 WHERE region = '服饰'
  结果：张三只看到服饰类目的订单，且手机号脱敏
```

**RBAC 的四个层级**：

| 层级 | 名称 | 能力 | 典型场景 |
|------|------|------|---------|
| RBAC0 | 基础 | User-Role-Permission 三元组 | 小系统 |
| RBAC1 | 层级 | 角色继承（销售经理继承销售） | 组织架构 |
| RBAC2 | 约束 | 职责分离（制单人和审批人不能同一人） | 财务/审计 |
| RBAC3 | 完整 | RBAC1 + RBAC2 | 大型企业 |

## 二、机制层：RBAC 的表结构与代码

**RBAC 数据库表设计**（经典五表）：

```sql
-- 用户表
CREATE TABLE sys_user (
    user_id BIGINT PRIMARY KEY,
    username VARCHAR(50),
    org_id BIGINT,           -- 所属组织（数据权限用）
    region VARCHAR(50)       -- 负责区域（数据权限用）
);

-- 角色表
CREATE TABLE sys_role (
    role_id BIGINT PRIMARY KEY,
    role_code VARCHAR(50),    -- 如 ORDER_ADMIN
    role_name VARCHAR(50),
    parent_id BIGINT          -- 父角色（RBAC1 继承）
);

-- 权限表（功能权限：菜单/按钮/API）
CREATE TABLE sys_permission (
    perm_id BIGINT PRIMARY KEY,
    perm_code VARCHAR(100),   -- 如 order:query
    perm_type VARCHAR(20),    -- MENU / BUTTON / API
    resource VARCHAR(100)     -- 资源标识（URL/方法路径）
);

-- 用户-角色关联
CREATE TABLE sys_user_role (
    user_id BIGINT,
    role_id BIGINT,
    PRIMARY KEY (user_id, role_id)
);

-- 角色-权限关联
CREATE TABLE sys_role_permission (
    role_id BIGINT,
    perm_id BIGINT,
    PRIMARY KEY (role_id, perm_id)
);
```

**RBAC 鉴权代码**（Spring Security）：

```java
@Service
public class AuthService {

    @Cacheable(value = "userPerms", key = "#userId")
    public Set<String> getUserPermissions(Long userId) {
        // 查询用户的角色（含继承的角色）
        Set<Long> roleIds = roleRepo.findRoleIdsByUserId(userId);
        // 递归加载父角色（RBAC1）
        Set<Long> allRoleIds = loadParentRoles(roleIds);
        // 查询角色的权限
        return permRepo.findPermCodesByRoleIds(allRoleIds);
    }

    public boolean hasPermission(Long userId, String permCode) {
        return getUserPermissions(userId).contains(permCode);
    }
}

// Controller 鉴权
@RestController
public class OrderController {

    @Autowired private AuthService authService;

    @GetMapping("/orders")
    @PreAuthorize("@authService.hasPermission(#userId, 'order:query')")
    public List<Order> listOrders(@RequestAttribute Long userId) {
        return orderService.list();
    }
}

// 权限变化时主动失效缓存
@EventListener
public void onRoleChanged(RoleChangedEvent event) {
    // 失效所有持有该角色的用户权限缓存
    List<Long> userIds = userRoleRepo.findUserIdsByRoleId(event.getRoleId());
    userIds.forEach(uid -> cacheManager.getCache("userPerms").evict(uid));
}
```

## 三、机制层：ABAC 数据权限落地

**MyBatis 拦截器自动追加 WHERE**（核心机制）：

```java
@Intercepts(@Signature(type = StatementHandler.class,
    method = "prepare", args = {Connection.class, Integer.class}))
public class DataPermissionInterceptor implements Interceptor {

    @Override
    public Object intercept(Invocation invocation) throws Throwable {
        // 1. 获取当前登录用户
        UserContext user = UserContextHolder.get();
        if (user == null) return invocation.proceed();  // 未登录不过滤

        // 2. 获取当前 SQL
        StatementHandler handler = (StatementHandler) invocation.getTarget();
        BoundSql boundSql = handler.getBoundSql();
        String sql = boundSql.getSql();

        // 3. 获取 Mapper 方法上的 @DataScope 注解
        Method method = getMapperMethod(handler);
        DataScope scope = method.getAnnotation(DataScope.class);
        if (scope == null) return invocation.proceed();  // 无注解不过滤

        // 4. 根据注解和数据权限规则，追加 WHERE 条件
        String dataFilter = buildDataFilter(user, scope);
        String newSql = injectWhere(sql, dataFilter);

        // 5. 替换 SQL
        MetaObject metaObject = SystemMetaObject.forObject(boundSql);
        metaObject.setValue("sql", newSql);
        return invocation.proceed();
    }

    private String buildDataFilter(UserContext user, DataScope scope) {
        // 策略：销售只能看自己区域的订单
        if (user.hasRole("SALES")) {
            return scope.table() + ".region = '" + user.getRegion() + "'";
        }
        // 策略：销售经理看自己管理的所有销售区域
        if (user.hasRole("SALES_MANAGER")) {
            List<String> regions = manageRegionRepo.findByManagerId(user.getUserId());
            return scope.table() + ".region IN ('" +
                String.join("','", regions) + "')";
        }
        // 策略：管理员看全部
        return "1=1";
    }
}

// Mapper 方法标注数据范围
@Mapper
public interface OrderMapper {
    @DataScope(table = "o")   // 表别名 o
    @Select("SELECT * FROM t_order o WHERE o.status = #{status}")
    List<Order> findByStatus(@Param("status") String status);
}
// 原始 SQL: SELECT * FROM t_order o WHERE o.status = 'PAID'
// 拦截后:   SELECT * FROM t_order o WHERE o.status = 'PAID' AND o.region = '服饰'
// 张三（销售-服饰）只能看服饰区域的已支付订单
```

**列级权限（字段脱敏）**：

```java
// 敏感字段标注
public class OrderVO {
    private String orderId;
    private String customerName;

    @Sensitive(type = SensitiveType.PHONE)
    private String customerPhone;   // 13812345678 → 138****5678

    @Sensitive(type = SensitiveType.AMOUNT, permCode = "order:amount:view")
    private BigDecimal amount;      // 无权限时返回 null
}

// Jackson 序列化器，序列化时脱敏
public class SensitiveSerializer extends JsonSerializer<String>
        implements ContextualSerializer {
    private SensitiveType type;
    private String permCode;

    @Override
    public void serialize(String value, JsonGenerator gen, SerializerProvider sp) {
        UserContext user = UserContextHolder.get();
        if (permCode != null && !authService.hasPermission(user.getUserId(), permCode)) {
            gen.writeNull();   // 无权限返回 null
            return;
        }
        gen.writeString(desensitize(value, type));   // 脱敏
    }
}
```

## 四、实战层：职责分离与权限审计

**RBAC2 的职责分离**（SoD, Separation of Duties）：

```java
// 制单人和审批人不能是同一人
public class SoDValidator {
    public void validate(Long userId, String action, String bizId) {
        if ("approve".equals(action)) {
            Long creatorId = bizRepo.findCreatorId(bizId);
            if (userId.equals(creatorId)) {
                throw new SoDViolationException("制单人不能审批自己的单据");
            }
        }
    }
}
// 防止贪污：张三创建了退款单，不能自己审批通过
```

**权限审计日志**（合规必备）：

```java
@Aspect
@Component
public class PermissionAuditAspect {

    @Autowired private AuditLogRepo auditRepo;

    @AfterReturning("@annotation(auditLog)")
    public void audit(JoinPoint jp, AuditLog auditLog) {
        UserContext user = UserContextHolder.get();
        AuditRecord record = new AuditRecord();
        record.setUserId(user.getUserId());
        record.setAction(jp.getSignature().toShortString());
        record.setResource(auditLog.resource());
        record.setResult("SUCCESS");
        record.setIp(user.getIp());
        record.setTimestamp(Instant.now());
        auditRepo.save(record);   // 审计日志独立存储，只追加不删除
    }
}

// 审计日志表
CREATE TABLE audit_log (
    id BIGINT PRIMARY KEY,
    user_id BIGINT,
    action VARCHAR(100),       -- OrderService.approve
    resource VARCHAR(100),     -- ORDER:12345
    result VARCHAR(20),        -- SUCCESS / DENIED
    ip VARCHAR(50),
    create_time TIMESTAMP,
    INDEX idx_user_time (user_id, create_time)   -- 按人查行为
);
```

## 五、底层本质：权限的本质是策略求值

回到第一性：**权限的本质是"给定主体(S)+资源(R)+环境(E)，求值策略(P)返回允许/拒绝"**。

- **RBAC 的策略是静态的**：S.role ∈ R.permissions。预编译，查集合，简单高效。
- **ABAC 的策略是动态的**：P(S.attrs, R.attrs, E.attrs) → bool。每次请求求值，表达力强但有计算成本。
- **数据权限是 ABAC 的特例**：策略求值结果转换成 SQL 的 WHERE 条件，让数据库做行级过滤。

**为什么不把数据权限写在业务代码里**？因为人不可靠——开发者忘了加 `if (user.region == order.region)` 就越权了。MyBatis 拦截器在框架层统一处理，开发者只需标注 `@DataScope`，拦截器自动注入条件。这是"把安全下沉到框架层"的实践，类似 Linux 的 SELinux——应用无感知，系统层强制。

## 六、AI 架构师加问：5 个

1. **用 AI 检测越权漏洞，怎么做？**
   静态扫描：Mapper 方法是否有 @DataScope 注解（没有的可能漏了数据权限）；动态测试：用不同角色的 token 调同一接口，对比返回数据范围是否符合策略。AI 训练样本：历史越权事故 + 正常权限配置。

2. **AI 辅助生成权限策略，怎么防误授权？**
   AI 生成的策略必须经过"最小权限"校验——默认拒绝，逐条放行。高危策略（如"允许查看所有用户的手机号"）必须人工审批。AI 不直接落库，输出策略草案，安全管理员 review 后生效。

3. **AI Agent 调用接口，怎么鉴权？**
   Agent 用 service account（不是真人），绑定专属角色（如 AI_AGENT_ROLE），权限最小化（只能调读接口）。Agent 的每次工具调用继承 service account 的权限，ABAC 同样生效（Agent 只能看它该看的数据）。

4. **权限系统接入 RAG，知识库放什么？**
   角色权限矩阵（谁有什么权限）、数据权限策略文档、历史权限变更工单、越权事故案例。AI 查询"张三能不能查订单"时，RAG 返回角色定义+数据范围策略。

5. **用 AI 做权限异常检测，怎么设计？**
   监控每个用户的权限使用模式（正常工作时间、正常数据范围、正常调用频率）。偏离基线的行为告警（如凌晨3点批量导出、突然访问其他区域数据）。用孤立森林算法检测异常，输出 risk_score，超阈值冻结账号待人工审核。

## 七、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"RBAC 管功能、ABAC 管数据、拦截器注 WHERE、缓存变更失效"**。

- **RBAC**：User-Role-Permission，功能权限（菜单/按钮/API）
- **ABAC**：Subject+Resource+Environment+Policy，数据权限
- **数据权限三维度**：行级（WHERE org_id=?）、列级（脱敏）、操作级（查/改）
- **SQL 拦截器**：MyBatis Interceptor 自动注 WHERE，@DataScope 注解声明
- **缓存失效**：角色变化主动失效，不能纯 TTL

### 面试现场 60 秒回答

> 权限分两层：功能权限用 RBAC，User-Role-Permission 三元组，决定能不能调订单查询接口；数据权限用 ABAC，Subject+Resource+Policy 动态求值，决定调了之后看到哪些订单。数据权限落地在 MyBatis 拦截器——Mapper 方法标注 @DataScope，拦截器自动在 SQL 注入 WHERE region = 用户区域。这样开发者不用手动 if-else，框架层统一兜底。列级权限用 Jackson 序列化器脱敏（@Sensitive 注解，无权限返回 null）。权限缓存不能纯 TTL——用户角色变更要主动失效，否则权限收回有延迟窗口。RBAC2 的职责分离保证制单人不能审批自己的单（防贪污）。角色爆炸的解法：功能用 RBAC 固化角色，数据维度用 ABAC 动态算，避免每个区域建一个角色。

## 八、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不直接在业务代码里 if-else 判断权限？ | 用越权事故率说话：业务代码判断容易遗漏（开发者忘加），框架层拦截器强制生效。用 unauthorized_access_count（越权访问次数）和 permission_bug_count（权限相关 bug 数）量化，拦截器方案应趋近 0 |
| 证据追问 | 怎么证明数据权限生效了？ | 自动化测试：用不同角色的 token 调同一接口，断言返回数据范围符合策略；SQL 日志审计：记录拦截器注入的 WHERE 条件，定期扫描是否有遗漏 @DataScope 的 Mapper |
| 边界追问 | 拦截器能覆盖所有 SQL 吗？ | 不能。原生 JDBC、动态表名、跨库 JOIN 可能绕过拦截器。解法：禁止业务代码原生 JDBC，强制走 MyBatis；跨库查询在应用层做数据范围过滤（先查 ID 再按 ID 查） |
| 反例追问 | 什么时候 RBAC 够用不需要 ABAC？ | 内部管理系统（无数据范围差异）、个人中心（用户只看自己的数据，user_id 条件硬编码）、功能单一的工具系统。这些场景数据权限简单，RBAC 够用 |
| 风险追问 | 权限系统最大的风险是什么？ | 主动点出：权限缓存不一致（角色变更后 TTL 内仍用旧权限，要主动失效）、拦截器遗漏（部分 Mapper 没标 @DataScope 导致越权）、超级账号滥用（admin 绕过所有权限，要审计） |
| 验证追问 | 怎么保证权限变更及时生效？ | 权限变更事件驱动——角色变化时发布事件，监听器失效该角色所有用户的权限缓存，下次请求重新加载。测试：改角色后 1 秒内生效，用 permission_propagation_delay 衡量 |
| 沉淀追问 | 权限系统沉淀什么？ | 数据权限拦截器框架（@DataScope）、脱敏注解库（@Sensitive）、权限审计大盘（谁访问了什么）、越权检测自动化测试框架、最小权限原则 Code Review checklist |

### 现场对话示例

**面试官**：数据权限拦截器怎么知道当前 SQL 查的是哪张表？

**候选人**：两种方式。第一种，注解显式声明——Mapper 方法上加 @DataScope(table = "o")，告诉拦截器要对别名 o 的表追加 WHERE 条件，这是最可靠的方式。第二种，SQL 解析——用 JSqlParser 解析 SQL 的 AST，提取表名和别名，但这种方式对复杂 SQL（子查询、UNION）容易出错，京东内部推荐用注解。拦截器拿到表名后，根据当前用户的属性（region/orgId）和数据权限策略，生成 WHERE 条件，注入到原 SQL。注意要处理原始 SQL 已有 WHERE 和没有 WHERE 两种情况——已有 WHERE 追加 AND，没有 WHERE 加 WHERE。另外 JOIN 场景要小心——如果是 SELECT * FROM order o JOIN customer c，要追加的可能是 o.region 不是 c.region，所以注解里要明确表别名。

**面试官**：用户角色变了，权限缓存怎么失效？

**候选人**：事件驱动失效。用户角色变更时（如管理员把张三从"销售"改成"销售经理"），权限服务发布 RoleChangedEvent，监听器收到事件后，查出所有持有该角色的用户 ID，批量失效他们的权限缓存（userPerms:userId）。下次张三请求时，缓存未命中，重新从 DB 加载新角色的权限。关键是要失效所有相关用户——一个角色可能被 N 个用户持有，改角色影响这 N 个用户。不能用纯 TTL（如 30 分钟自动失效），因为权限收回（撤销敏感权限）必须在秒级生效，TTL 30 分钟意味着张三在 30 分钟内仍有旧权限，这是安全风险。京东的做法是权限变更事件通过 RocketMQ 广播到所有应用实例，各实例本地缓存失效，Redis 缓存删除，确保 1 秒内全网生效。

**面试官**：超级管理员（admin）绕过所有权限，怎么管控？

**候选人**：admin 账号是权限系统的最大风险点——它绕过所有 RBAC/ABAC 检查。管控措施：第一，admin 账号数量最小化（全公司不超过 3 个，且专人专用）。第二，admin 操作全程审计——所有 admin 的操作记录独立存储（audit_log_admin 表），只追加不删除，定期 review。第三，admin 登录多因素认证（密码+动态口令+IP 白名单）。第四，admin 不能直接操作生产数据，必须走"审批工单"流程——admin 提交变更工单，另一个 admin 审批，系统执行。第五，定期轮换 admin 密码（如每 90 天）。京东的做法是 admin 账号由安全管理团队托管，业务团队需要 admin 操作时走工单审批，admin 只在审批通过后临时授权（1 小时有效），过期自动收回。

## 常见考点

1. **RBAC 和 ACL 区别？**——ACL（访问控制列表）是直接给用户分配权限（User-Permission），用户多了难管理；RBAC 加了角色中间层（User-Role-Permission），用户按角色分组，角色变权限变，用户自动继承。
2. **数据权限怎么做行级过滤？**——MyBatis 拦截器拦截 SQL，根据当前用户属性追加 WHERE 条件。配合 @DataScope 注解声明哪个表需要过滤。不能靠业务代码 if-else（容易遗漏）。
3. **权限和租户什么关系？**——多租户系统中，租户隔离是第一道权限（A 租户不能看 B 租户数据），权限系统是第二道（同一租户内不同角色看不同数据）。两者叠加。
4. **OAuth2 的 scope 和 RBAC 的 permission 什么关系？**——scope 是 OAuth2 的授权范围（如 read:order），permission 是应用内的功能权限。scope 控制令牌能访问哪些 API，permission 控制访问后能做什么。两者层级不同。

## 结构化回答

**30 秒电梯演讲：** RBAC 解决功能权限（谁能调什么接口），ABAC 解决数据权限（谁能看哪条数据）。RBAC 是用户-角色-权限三元组，简单稳定；ABAC 是属性+策略动态决策，能表达销售只能看自己负责区域的订单。企业级系统两者叠加：RBAC 控制能否访问订单菜单，ABAC 控制访问后能看到哪些订单行

**展开框架：**
1. **RBAC0** — User-Role-Permission 三元组；RBAC1 加角色继承；RBAC2 加职责分离（SoD）
2. **ABAC** — Subject（主体属性）+ Resource（资源属性）+ Environment（环境属性）+ Policy（策略）
3. **数据权限三要素** — 行级（WHERE org_id=?）、列级（字段脱敏）、操作级（能查不能改）

**收尾：** 以上是我的整体思路。您想继续深入聊——角色爆炸怎么办？


## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：权限模型 RBAC、ABAC 与数据权限 | "这题一句话：RBAC 解决功能权限（谁能调什么接口），ABAC 解决数据权限（谁能看哪条数据）。" | 开场钩子 |
| 0:15 | RBAC0示意/对比图 | "User-Role-Permission 三元组；RBAC1 加角色继承；RBAC2 加职责分离（SoD）" | RBAC0要点 |
| 0:40 | ABAC示意/对比图 | "Subject（主体属性）+ Resource（资源属性）+ Environment（环境属性）+ Policy（策略）" | ABAC要点 |
| 1:25 | 总结卡 | "记住：RBAC = 功能权限。下期见。" | 收尾 |
