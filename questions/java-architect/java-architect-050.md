---
id: java-architect-050
difficulty: L4
category: java-architect
subcategory: 数据隔离
tags:
- Java 架构师
- 多租户
- 隔离
- 安全
feynman:
  essence: 多租户隔离有三种物理形态：独立数据库（隔离最强成本最高）、共享数据库独立 Schema（中间态）、共享数据库共享 Schema（在表里加 tenant_id 字段，成本最低但隔离最弱）。SaaS 系统通常混合用——大客户独立库，中小客户共享库加 tenant_id。核心机制是"路由层 + 数据层"：路由层根据请求识别租户，数据层保证租户间数据物理或逻辑隔离。
  analogy: 像写字楼出租。独立数据库是"独栋别墅"（一个租户一栋，私密最强但贵）；独立 Schema 是"同楼不同层"（一栋楼里租一层，电梯分卡）；共享 Schema 是"开放式工位"（同一层不同工位，靠工位号区分）。小公司租工位（共享 Schema），大公司包一层（独立 Schema），超大户买独栋（独立数据库）。
  first_principle: 为什么要多租户？因为 SaaS 服务的多个客户共享同一套代码，但数据必须隔离。独立数据库的隔离成本是"每个租户一套 DB 实例"（贵但安全），共享 Schema 的成本是"每条数据带 tenant_id 且查询必须过滤"（便宜但隔离弱）。选型本质是在"隔离强度"和"成本"之间权衡。
  key_points:
  - 三种隔离模式：DB-per-tenant / Schema-per-tenant / Shared-DB-with-tenant_id
  - 租户识别：域名（acme.saas.com）/ 请求头（X-Tenant-Id）/ JWT 中的 tenant claim
  - 数据层隔离：MyBatis 拦截器自动追加 WHERE tenant_id=?，或动态数据源路由
  - 资源配额：每个租户的存储/请求/算力上限，防止大租户挤占小租户
  - 邻居噪音问题（Noisy Neighbor）：共享资源下一个租户的高负载影响其他租户
first_principle:
  problem: SaaS 服务 N 个租户，如何用最低成本保证租户间数据绝对隔离？
  axioms:
  - 租户数据隔离是合规底线（GDPR/等保要求），泄露是严重事故
  - 独立 DB 隔离最强但成本随租户线性增长（万级租户不可行）
  - 共享 DB + tenant_id 成本最低但隔离靠应用层保证（拦截器不能漏）
  rebuild: 分层隔离。大客户（KA，< 5%）用独立数据库，合规要求高且付费得起；腰部客户（20%）用独立 Schema，同库不同 Schema 隔离；长尾客户（75%）共享 Schema + tenant_id 字段，成本最优。租户识别在网关层（从域名/JWT 解析 tenant_id 放入上下文），数据隔离在 MyBatis 拦截器（自动 WHERE tenant_id），资源隔离在中间件（每租户限流配额）。
follow_up:
  - tenant_id 泄露（跨租户访问）怎么防？——MyBatis 拦截器强制注入 WHERE tenant_id，所有 SQL 必须经过拦截器。定期扫描"没有 tenant_id 条件的查询"（用 SQL 审计）。测试用"租户 A 的 token 查租户 B 的数据"必须返回空。
  - 独立 Schema 怎么做动态切换？——动态数据源（AbstractRoutingDataSource），每次请求根据 tenant_id 路由到对应的 DataSource。或用 Schema 切换（SET search_path TO tenant_acme）。
  - 多租户的备份和恢复怎么做？——共享 Schema 按 tenant_id 条件导出（SELECT * FROM order WHERE tenant_id=?）；独立 Schema 直接备份 Schema。恢复时不能覆盖其他租户数据。
  - 租户迁移（从共享迁到独立）怎么做？——双写期（新老都写）→ 数据同步（历史迁移）→ 切读（读新库）→ 停老。中间做数据校验。
  - 多租户和分库分表怎么结合？——分片键通常用 tenant_id（大租户独占分片），或 tenant_id + 业务 ID 复合分片。保证同一租户数据在同一分片，跨租户查询（平台运营）走专用通道。
memory_points:
  - 三种隔离：独立 DB（最强贵）/ 独立 Schema（中间）/ 共享 Schema+tenant_id（便宜弱）
  - 租户识别：域名 / 请求头 / JWT claim
  - 数据隔离：MyBatis 拦截器自动 WHERE tenant_id
  - 资源隔离：每租户限流配额，防 Noisy Neighbor
  - 混合策略：KA 独立库，长尾共享库
---

# 【Java 后端架构师】多租户架构与数据隔离策略

> 适用场景：JD 核心技术。京东云上的 SaaS 服务（如商家开放平台）服务百万商家，每个商家是一个租户。A 商家的订单数据绝不能泄露给 B 商家——这不仅是技术问题，是法律底线（数据安全法）。多租户隔离的核心是"成本 vs 隔离强度"的权衡。

## 一、概念层：三种隔离模式对比

**隔离模式全景**（面试必考选型）：

| 模式 | 隔离强度 | 成本 | 运维复杂度 | 适用场景 |
|------|---------|------|-----------|---------|
| **独立数据库** | 最强 | 高（每租户一实例） | 高（万级实例难管） | KA 客户、金融、政务 |
| **独立 Schema** | 中 | 中（共享实例） | 中（Schema 管理） | 腰部客户、中型企业 |
| **共享 Schema + tenant_id** | 弱（靠应用层） | 低 | 低 | 长尾客户、小微企业 |

**成本对比示例**（1 万租户）：

```
独立数据库：1 万个 MySQL 实例 × 200 元/月 = 200 万/月（不可行）
独立 Schema：100 个实例 × 1 万 Schema/实例 × 200 元 = 2 万/月（可行）
共享 Schema：10 个实例 × 200 元 = 2000 元/月（最省）

京东商家开放平台的实践：
  - KA 商家（Top 100，如联想、华为）：独立数据库
  - 腰部商家（Top 1 万）：独立 Schema（共享实例）
  - 长尾商家（100 万+）：共享 Schema + tenant_id
```

## 二、机制层：租户识别与上下文传递

**租户识别的三种方式**：

```java
// 方式 1：域名解析（acme.saas.com → tenant=acme）
@Component
public class DomainTenantResolver implements TenantResolver {
    @Override
    public String resolve(HttpServletRequest request) {
        String host = request.getServerName();   // acme.saas.com
        String subdomain = host.split("\\.")[0]; // acme
        return tenantMappingService.getTenantId(subdomain);
    }
}

// 方式 2：请求头（X-Tenant-Id: 12345）
@Component
public class HeaderTenantResolver implements TenantResolver {
    @Override
    public String resolve(HttpServletRequest request) {
        String tenantId = request.getHeader("X-Tenant-Id");
        if (tenantId == null) throw new TenantNotFoundException("缺少租户标识");
        return tenantId;
    }
}

// 方式 3：JWT Claim（token 里带 tenant_id）
@Component
public class JwtTenantResolver implements TenantResolver {
    @Override
    public String resolve(HttpServletRequest request) {
        String token = extractToken(request);
        Claims claims = jwtParser.parse(token).getBody();
        return claims.get("tenant_id", String.class);   // 从 JWT 解析
    }
}
```

**租户上下文透传**（ThreadLocal + RPC 透传）：

```java
// 租户上下文（ThreadLocal 存储）
public class TenantContext {
    private static final ThreadLocal<String> CONTEXT = new ThreadLocal<>();

    public static void setTenantId(String tenantId) { CONTEXT.set(tenantId); }
    public static String getTenantId() {
        String tenantId = CONTEXT.get();
        if (tenantId == null) throw new IllegalStateException("未设置租户");
        return tenantId;
    }
    public static void clear() { CONTEXT.remove(); }
}

// Web 过滤器设置租户上下文
@Component
public class TenantFilter implements Filter {
    @Autowired private TenantResolver resolver;

    @Override
    public void doFilter(ServletRequest req, ServletResponse resp, FilterChain chain) {
        HttpServletRequest request = (HttpServletRequest) req;
        try {
            String tenantId = resolver.resolve(request);
            TenantContext.setTenantId(tenantId);
            chain.doFilter(req, resp);
        } finally {
            TenantContext.clear();   // 关键：清理 ThreadLocal 防泄露
        }
    }
}

// RPC 透传（Dubbo Filter 把 tenant_id 放到 RPC context）
@Activate(group = CommonConstants.CONSUMER)
public class TenantRpcFilter implements Filter {
    @Override
    public Result invoke(Invoker<?> invoker, Invocation invocation) {
        // 消费端：把当前租户放入 RPC 附件
        String tenantId = TenantContext.getTenantId();
        invocation.setAttachment("tenant_id", tenantId);
        return invoker.invoke(invocation);
    }
}

@Activate(group = CommonConstants.PROVIDER)
public class TenantRpcProviderFilter implements Filter {
    @Override
    public Result invoke(Invoker<?> invoker, Invocation invocation) {
        // 提供端：从 RPC 附件恢复租户上下文
        String tenantId = invocation.getAttachment("tenant_id");
        TenantContext.setTenantId(tenantId);
        try {
            return invoker.invoke(invocation);
        } finally {
            TenantContext.clear();
        }
    }
}
```

## 三、机制层：共享 Schema 的数据隔离

**MyBatis 拦截器自动注入 tenant_id**（核心机制）：

```java
@Intercepts(@Signature(type = StatementHandler.class,
    method = "prepare", args = {Connection.class, Integer.class}))
public class TenantInterceptor implements Interceptor {

    @Override
    public Object intercept(Invocation invocation) throws Throwable {
        StatementHandler handler = (StatementHandler) invocation.getTarget();
        BoundSql boundSql = handler.getBoundSql();
        String sql = boundSql.getSql();

        // 检查是否是多租户表（有 tenant_id 字段的表）
        String tableName = parseTableName(sql);
        if (!isMultiTenantTable(tableName)) {
            return invocation.proceed();   // 非多租户表不过滤
        }

        // 获取当前租户
        String tenantId = TenantContext.getTenantId();

        // 用 JSqlParser 解析 SQL，注入 tenant_id 条件
        Statement stmt = CCJSqlParserUtil.parse(sql);
        Select select = (Select) stmt;
        PlainSelect plainSelect = (PlainSelect) select.getSelectBody();

        EqualsTo tenantCondition = new EqualsTo(
            new Column(tableName + ".tenant_id"),
            new StringLiteral(tenantId)
        );

        Expression where = plainSelect.getWhere();
        if (where == null) {
            plainSelect.setWhere(tenantCondition);
        } else {
            plainSelect.setWhere(new AndExpression(where, tenantCondition));
        }

        // 替换 SQL
        MetaObject metaObject = SystemMetaObject.forObject(boundSql);
        metaObject.setValue("sql", stmt.toString());
        return invocation.proceed();
    }
}

// 原 SQL: SELECT * FROM t_order WHERE status = 'PAID'
// 拦截后: SELECT * FROM t_order WHERE status = 'PAID' AND t_order.tenant_id = 'acme'

// INSERT 自动填充 tenant_id
@Intercepts(@Signature(type = Executor.class, method = "update",
    args = {MappedStatement.class, Object.class}))
public class TenantInsertInterceptor implements Interceptor {
    @Override
    public Object intercept(Invocation invocation) throws Throwable {
        Object entity = invocation.getArgs()[1];
        if (entity instanceof MultiTenant) {
            MultiTenant mt = (MultiTenant) entity;
            if (mt.getTenantId() == null) {
                mt.setTenantId(TenantContext.getTenantId());  // 自动填充
            } else if (!mt.getTenantId().equals(TenantContext.getTenantId())) {
                throw new SecurityException("租户 ID 不匹配，疑似越权");  // 防篡改
            }
        }
        return invocation.proceed();
    }
}
```

## 四、机制层：独立 Schema 的动态数据源

**AbstractRoutingDataSource 动态路由**：

```java
public class TenantRoutingDataSource extends AbstractRoutingDataSource {

    @Override
    protected Object determineCurrentLookupKey() {
        return TenantContext.getTenantId();   // 返回当前租户 ID 作为路由键
    }
}

// 配置：每个租户一个 DataSource
@Configuration
public class DataSourceConfig {
    @Bean
    @Primary
    public DataSource dataSource() {
        TenantRoutingDataSource routing = new TenantRoutingDataSource();
        Map<Object, Object> targets = new HashMap<>();
        // KA 租户独立数据源
        targets.put("lenovo", buildDataSource("jdbc:mysql://db-lenovo:3306/lenovo"));
        targets.put("huawei", buildDataSource("jdbc:mysql://db-huawei:3306/huawei"));
        // 共享租户走默认数据源
        routing.setDefaultTargetDataSource(buildDataSource("jdbc:mysql://db-shared:3306/saas"));
        routing.setTargetDataSources(targets);
        return routing;
    }
}
```

## 五、实战层：资源隔离与 Noisy Neighbor 防护

**租户级限流**（防一个租户打挂所有租户）：

```java
@Component
public class TenantRateLimiter {
    // 每个租户独立的令牌桶
    private final Map<String, RateLimiter> limiters = new ConcurrentHashMap<>();

    @PostConstruct
    public void init() {
        // 从配置加载每租户的 QPS 配额
        tenantConfigRepo.findAll().forEach(config -> {
            limiters.put(config.getTenantId(),
                RateLimiter.create(config.getMaxQps()));   // 如 KA: 1000 QPS，免费版: 10 QPS
        });
    }

    public void check(String tenantId) {
        RateLimiter limiter = limiters.get(tenantId);
        if (limiter == null) limiter = limiters.get("default");  // 默认配额
        if (!limiter.tryAcquire()) {
            throw new RateLimitException("租户[" + tenantId + "]超过 QPS 配额");
        }
    }
}

// 网关层拦截
@Component
public class TenantRateLimitFilter implements Filter {
    @Autowired private TenantRateLimiter limiter;

    @Override
    public void doFilter(ServletRequest req, ServletResponse resp, FilterChain chain) {
        String tenantId = TenantContext.getTenantId();
        limiter.check(tenantId);   // 超额直接拒绝
        chain.doFilter(req, resp);
    }
}
```

**存储配额**（防一个租户塞满共享库）：

```java
// 租户存储用量监控
@Scheduled(cron = "0 0 2 * * ?")   // 每天凌晨统计
public void checkTenantStorageQuota() {
    for (String tenantId : allTenantIds) {
        long used = storageMetricService.getTenantStorageBytes(tenantId);
        long quota = tenantConfigRepo.findById(tenantId).getStorageQuota();
        if (used > quota * 0.9) {
            alertService.send("租户[" + tenantId + "]存储使用率达 90%");
        }
        if (used > quota) {
            // 超额：禁止写入（INSERT/UPDATE 返回错误）
            tenantConfigRepo.updateStatus(tenantId, "STORAGE_EXCEEDED");
        }
    }
}
```

## 六、底层本质：隔离的成本曲线

回到第一性：**多租户隔离的本质是"用多少成本保证多大的隔离强度"**。

```
隔离强度
  ↑
  │  独立 DB ───────────────  最强（物理隔离），成本随租户线性增长
  │
  │  独立 Schema ──────────  中（逻辑隔离），成本共享实例
  │
  │  共享 Schema+tenant_id   弱（应用层隔离），成本最优
  │
  └──────────────────────→ 租户数量
```

- **独立 DB 的成本是 O(租户数)**：每个租户一个实例，万级租户不可行。但隔离最强（物理隔离，不存在应用层 bug 导致泄露的可能）。
- **共享 Schema 的成本是 O(1)**：所有租户共享一套 DB，成本固定。但隔离靠应用层（MyBatis 拦截器），一旦拦截器有 bug 或遗漏，就跨租户泄露。

**为什么混合模式是实践最优**：5% 的 KA 客户贡献 80% 收入，用独立 DB 保证合规和安全；75% 的长尾客户共享 Schema，成本最优。中间 20% 用独立 Schema 平衡。这是"按价值分配成本"的工程经济学——花钱在重要的地方。

**Noisy Neighbor 的本质**：共享资源下，一个租户的高负载消耗共享资源（CPU/IO/连接池），影响其他租户。解法是资源隔离——每租户独立的限流配额（QPS）、独立的连接池、独立的线程池。极端情况下用容器级隔离（每租户独立 Pod）。

## 七、AI 架构师加问：5 个

1. **用 AI 检测多租户越权漏洞，怎么做？**
   静态扫描：所有 Mapper SQL 是否经过 TenantInterceptor（有 SQL 绕过 MyBatis 原生 JDBC 就是风险）；动态测试：用租户 A 的 token 查租户 B 的数据 ID，断言返回空。AI 训练样本：历史跨租户泄露事故 + 正常多租户配置。

2. **AI 辅助租户资源配置（动态配额），怎么做？**
   AI 根据租户历史 QPS、存储增长、付费等级动态调整配额。付费用户高峰期自动扩容（不影响其他租户），免费用户严控配额。但调整要有边界（不能超过物理容量），且要人工确认大额调整。

3. **多租户 AI 推理，怎么隔离？**
   模型共享（同一模型服务所有租户），但数据隔离——推理请求带 tenant_id，特征数据按租户隔离存储，结果缓存按 tenant_id 分 key。模型的 prompt 模板按租户定制（KA 客户私有模板）。

4. **多租户系统接入 RAG，知识库怎么隔离？**
   向量库按 tenant_id 分 namespace（或分 collection），检索时强制带 tenant_id 过滤。通用知识库（产品文档）所有租户共享，私有知识库（租户上传）严格隔离。AI 检索前先做租户鉴权。

5. **AI 监测 Noisy Neighbor，怎么设计？**
   监控每租户的资源使用（CPU/IO/连接数），用异常检测（如 Z-score）识别"突增"租户。一个租户的 QPS 突然涨 10 倍可能是异常（压测/攻击），AI 自动降级该租户的配额，保护其他租户。

## 八、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"三种隔离、拦截器注 tenant_id、资源配额防邻居噪音"**。

- **三种模式**：独立 DB（强贵）/ 独立 Schema（中）/ 共享 Schema+tenant_id（弱省）
- **租户识别**：域名/请求头/JWT claim，ThreadLocal 透传 + RPC 附件
- **数据隔离**：MyBatis 拦截器自动 WHERE tenant_id，INSERT 自动填充
- **资源隔离**：每租户限流配额（QPS/存储/连接池），防 Noisy Neighbor
- **混合策略**：KA 独立库，长尾共享库

### 面试现场 60 秒回答

> 多租户三种隔离模式：独立数据库（隔离最强成本最高，适合 KA 金融客户）、独立 Schema（中间态，腰部客户）、共享 Schema + tenant_id 字段（成本最优，长尾客户）。京东商家平台混合用——Top 100 商家独立库，腰部 1 万商家独立 Schema，100 万长尾商家共享 Schema。租户识别在网关层从域名/JWT 解析 tenant_id 放入 ThreadLocal，RPC 调用通过 Dubbo Filter 透传。数据隔离用 MyBatis 拦截器——SELECT 自动追加 WHERE tenant_id，INSERT 自动填充 tenant_id，业务代码无感。资源隔离每租户独立限流配额（KA 1000 QPS，免费版 10 QPS），防 Noisy Neighbor。最容易翻车的是拦截器遗漏——某条 SQL 绕过 MyBatis 原生 JDBC 导致跨租户泄露，所以要定期扫描 SQL 日志，所有查询必须带 tenant_id 条件。

## 九、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不直接给每个租户一套独立系统（连应用都独立）？ | 用成本说话：万级租户各一套应用 = 万套运维（监控/部署/升级成本爆炸）。共享应用 + 数据隔离是 SaaS 的成本优势所在。用 tenant_cost_ratio（每租户均摊成本）和 isolation_breach_count（隔离泄露次数）衡量 |
| 证据追问 | 怎么证明租户隔离真的生效？ | 自动化测试：租户 A 的 token 查租户 B 的数据 ID 必须返回空/403；SQL 审计：扫描所有生产 SQL，没有 tenant_id 条件的查询必须告警；渗透测试：定期做跨租户越权测试 |
| 边界追问 | 共享 Schema 能保证绝对隔离吗？ | 不能。靠应用层（拦截器）有遗漏风险（原生 JDBC/动态 SQL/DBA 手动查）。绝对隔离要独立 DB。但独立 DB 成本高，实践中用"共享 Schema + 严格拦截器 + 定期审计"达到 99.99% 隔离 |
| 反例追问 | 什么场景必须用独立 DB？ | 金融/医疗（合规要求物理隔离）、KA 客户合同要求独立部署、数据量极大（单租户 TB 级，共享库装不下）、定制化需求（租户要自定义字段/索引） |
| 风险追问 | 多租户最大的风险是什么？ | 主动点出：跨租户数据泄露（拦截器 bug 或遗漏，是 P0 事故）、Noisy Neighbor（一个租户打挂所有）、租户数据迁移风险（迁错覆盖其他租户）、DBA 误操作（手动 SQL 忘加 tenant_id） |
| 验证追问 | 怎么保证拦截器没遗漏？ | 静态扫描：所有 Mapper 必须经过拦截器；动态审计：慢查询日志解析，所有 SQL 必须含 tenant_id 条件（不含的告警）；混沌测试：故意用原生 JDBC 写查询，验证是否被拒绝 |
| 沉淀追问 | 多租户系统沉淀什么？ | 租户隔离拦截器框架（TenantInterceptor）、租户识别组件库（域名/JWT/Header resolver）、租户配额管理平台、跨租户越权自动化测试框架、租户数据迁移工具 |

### 现场对话示例

**面试官**：共享 Schema 模式下，DBA 要手动查数据排查问题，忘了加 tenant_id 怎么办？

**候选人**：这是多租户系统的高频事故点。三层防护。第一层，DB 账号权限——给 DBA 的账号设置行级安全策略（如 PostgreSQL 的 Row Security Policy），即使 DBA 忘加 tenant_id，DB 层自动过滤。MySQL 没有原生 RLS，可以用视图替代——DBA 只能查 v_order 视图（视图里硬编码 tenant_id 条件或通过 session 变量）。第二层，SQL 审计——慢查询日志和 binlog 解析，扫描所有手动执行的 SQL，不含 tenant_id 条件的告警，DBA 被通知补上。第三层，流程规范——DBA 查生产数据必须走工单审批，工单模板预置 tenant_id 条件，DBA 只填租户 ID 和业务条件。京东的做法是生产库 DBA 只读账号强制走 SQL 代理网关，网关自动注入 tenant_id（类似应用层的拦截器），DBA 绕不开。另外，定期做"越权演练"——用 A 租户的身份尝试查 B 租户数据，验证所有通道都隔离。

**面试官**：大客户要从共享 Schema 迁到独立库，怎么平滑迁移？

**候选人**：四步走。第一步，双写期——应用层写入时同时写共享库和独立库（双写），读还是读共享库。双写用异步消息保证最终一致，不影响主链路 RT。第二步，数据同步——把历史数据从共享库迁移到独立库，用 DataX 或自研工具按 tenant_id 过滤导出，导入独立库。导入后做数据校验（count 对比、关键字段 checksum）。第三步，切读——灰度切读流量到独立库（先 1% 观察，再 10%，再全量）。读切换期保持双写（万一独立库有问题可回滚读）。第四步，停老——全量读切到独立库后，观察 1-2 周稳定，停止向共享库写入，清理共享库该租户的数据（标记已迁移，延迟删除防回滚）。关键是每一步都可回滚——双写期出问题切回单写，切读期出问题切回读共享库。京东商家平台每年有几十次大客户迁移，整套流程工具化，平均 2 周完成一个客户迁移。

**面试官**：Noisy Neighbor 问题具体怎么防？

**候选人**：多层级防护。第一层，网关层限流——每租户独立令牌桶，按付费等级配 QPS（KA 1000 QPS，免费版 10 QPS），超额直接拒绝。第二层，应用层隔离——每租户独立的线程池或信号量（如 Semaphore），大租户的请求不会占满全局线程池。第三层，DB 层隔离——共享库给每租户独立的 DB 账号，账号配置资源组（如 MySQL 的 resource_group）限制 CPU/IO。第四层，连接池隔离——每租户独立的连接池（或 HikariCP 的 maxPoolSize 按租户分），防止一个租户耗尽所有连接。第五层，监控告警——实时监控每租户的 RT/QPS/错误率，某租户 RT 突增时自动降级（如自动降低其配额）。极端情况下（某租户持续异常），自动熔断该租户的所有请求（返回 503），保护其他租户。京东云的实践：每个租户的请求带 tenant_id 标签，Kubernetes 的 NetworkPolicy 按 label 限流，Prometheus 按租户分维度监控，Grafana 大盘可下钻到单租户。

## 常见考点

1. **多租户和分库分表什么关系？**——分库分表是"水平拆分"（按 sharding key 分散数据），多租户是"逻辑隔离"（按 tenant_id 隔离）。两者可叠加——用 tenant_id 作为分片键，大租户独占分片，小租户共享分片。
2. **GDPR 对多租户的要求？**——数据可携带（用户要求导出数据，必须按 tenant_id 过滤）、被遗忘权（删除某用户数据，不能影响其他租户）、数据驻留（欧盟用户数据存在欧盟的 DB，可能需要按租户地域分库）。
3. **多租户怎么做数据备份恢复？**——独立 DB 直接备份实例；共享 Schema 按 tenant_id 条件导出（mysqldump --where="tenant_id='acme'"）。恢复时不能覆盖其他租户——只能恢复到临时库，再按 tenant_id 迁移到生产库。
4. **租户配置（每租户不同的业务规则）怎么存？**——独立的 tenant_config 表（tenant_id, config_key, config_value），应用启动或请求时加载该租户的配置。或用配置中心（Apollo/Nacos）按租户分 namespace。

## 结构化回答

**30 秒电梯演讲：** 多租户隔离有三种物理形态：独立数据库（隔离最强成本最高）、共享数据库独立 Schema（中间态）、共享数据库共享 Schema（在表里加 tenant_id 字段，成本最低但隔离最弱）。SaaS 系统通常混合用——大客户独立库，中小客户共享库加 tenant_id。核心机制是路由层 + 数据层：路由层根据请求识别租户，数据层保证租户间数据物理或逻辑隔离

**展开框架：**
1. **三种隔离模式** — DB-per-tenant / Schema-per-tenant / Shared-DB-with-tenant_id
2. **租户识别** — 域名（acme.saas.com）/ 请求头（X-Tenant-Id）/ JWT 中的 tenant claim
3. **数据层隔离** — MyBatis 拦截器自动追加 WHERE tenant_id=?，或动态数据源路由

**收尾：** 以上是我的整体思路。您想继续深入聊——tenant_id 泄露（跨租户访问）怎么防？


## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：多租户架构与数据隔离策略 | "这题核心是——多租户隔离有三种物理形态：独立数据库（隔离最强成本最高）、共享数据库独立 Schema（中间态）、共……" | 开场钩子 |
| 0:15 | 像写字楼出租类比图 | "打个比方：像写字楼出租。" | 核心类比 |
| 0:40 | 三种隔离模式示意/对比图 | "DB-per-tenant / Schema-per-tenant / Shared-DB-with-tenant_id" | 三种隔离模式要点 |
| 1:05 | 租户识别示意/对比图 | "域名（acme.saas.com）/ 请求头（X-Tenant-Id）/ JWT 中的 tenant claim" | 租户识别要点 |
| 1:30 | 数据层隔离示意/对比图 | "MyBatis 拦截器自动追加 WHERE tenant_id=?，或动态数据源路由" | 数据层隔离要点 |
| 1:55 | 总结卡 | "记住：三种隔离。下期见。" | 收尾 |
