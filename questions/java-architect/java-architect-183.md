---
id: java-architect-183
difficulty: L3
category: java-architect
subcategory: 多租户 SaaS
tags:
- Java 架构师
- 多租户
- SaaS
- 套餐
- 配额
- 限流
feynman:
  essence: 多租户 SaaS 的核心是"tenant_id 隔离 + 套餐配额 + 限流降级"。所有表带 tenant_id 字段实现逻辑隔离（共享 DB 共享 Schema）。套餐（免费/基础/企业）决定配额（用户数/API 调用/存储）。配额用 Redis 计数器实时统计，超限拒绝或降级。
  analogy: 像写字楼——所有公司共用一栋楼（共享 DB），每家公司有独立门牌（tenant_id 隔离）。免费套餐用公共会议室（限流），企业套餐有专属电梯（高配额）。超员了保安拦住（配额超限）。
  first_principle: 多租户的核心矛盾是"资源隔离 vs 成本"。物理隔离（每租户独立 DB）安全但成本高。逻辑隔离（共享 DB + tenant_id）成本低但要防数据串户（A 租户看到 B 租户数据）。配额防单租户耗尽共享资源（"吵闹的邻居"问题）。
  key_points:
  - tenant_id 隔离：所有表带 tenant_id，MyBatis 拦截器自动注入 WHERE tenant_id=?
  - 套餐定义：免费/基础/企业，定义配额（用户数/API/存储/功能）
  - 配额统计：Redis 计数器（日/月维度），实时 incr + 判断
  - 限流：单租户 QPS 限流（令牌桶），超限返回 429
  - 降级：配额耗尽降级（如免费套餐用户超限后只读）
first_principle:
  problem: 多租户 SaaS 如何实现数据隔离（防串户）、按套餐配额计费、防单租户耗尽资源？
  axioms:
  - 物理隔离（独立 DB）成本高，逻辑隔离（共享 DB + tenant_id）成本低
  - 逻辑隔离要防数据串户（SQL 漏 WHERE tenant_id 会导致 A 看 B 数据）
  - 不同套餐配额不同（免费 100 用户，企业 10000 用户）
  - 单租户可能耗尽共享资源（"吵闹的邻居"），必须配额限流
  rebuild: 所有表带 tenant_id 字段，MyBatis 拦截器自动注入 WHERE tenant_id=?（防漏写）。套餐表定义配额（plan_id → 用户数/API/存储上限）。Redis 计数器实时统计用量（tenant:quota:{tenantId}:{resource}:{period}），每次操作 incr + 判断超限。令牌桶限流（单租户 QPS），超限返回 429。配额耗尽降级（免费套餐超限转只读或拒绝）。
follow_up:
  - 怎么防数据串户？——MyBatis 拦截器自动注入 WHERE tenant_id。ThreadLocal 存当前 tenantId（从 token 解析），所有 SQL 自动加 tenant_id 条件。开发不用手写。
  - 套餐配额怎么存？——plan 表定义各套餐上限（用户数/API/存储）。租户订阅套餐（tenant → planId）。配额用 Redis 计数器实时统计（incr + 过期）。
  - 配额超限怎么办？——拒绝（创建用户失败/API 返回 429）或降级（免费套餐超限转只读）。结合套餐策略，企业套餐可超额付费。
  - 怎么限流？——令牌桶。单租户 QPS 限流（如免费 10 QPS，企业 1000 QPS）。Redis + Lua 实现令牌桶。超限返回 429 + Retry-After。
  - 怎么计费？——按用量计费。统计 API 调用次数/存储量/用户数，月底出账单。Redis 计数器数据持久化到 DB 做对账。
memory_points:
  - tenant_id 隔离：所有表带字段，MyBatis 拦截器自动注入 WHERE
  - 套餐：plan 表（免费/基础/企业），定义配额上限
  - 配额统计：Redis 计数器 tenant:quota:{tenantId}:{resource}:{period}
  - 限流：令牌桶（单租户 QPS），超限返回 429
  - 降级：配额耗尽转只读或拒绝，企业可超额付费
---

# 【Java 后端架构师】多租户 SaaS 的套餐、配额与限流

> 适用场景：JD SaaS 产品（如京东商家开放平台 SaaS 版）。多个企业租户共享一套系统，按套餐（免费/基础/企业）提供不同配额。架构师要设计的是"tenant_id 隔离 + 套餐配额 + 限流降级"的多租户系统。

## 一、概念层：多租户架构

```
所有租户 → 共享 DB（共享 Schema）→ 表带 tenant_id 字段
                                        ↓
                              MyBatis 拦截器自动注入 WHERE tenant_id=?
                                        ↓
套餐（plan）→ 配额定义（用户数/API/存储）
                                        ↓
                              Redis 计数器实时统计用量
                                        ↓
                    超限拒绝（429）或降级（转只读）
```

## 二、机制层：tenant_id 隔离

```java
/**
 * 租户上下文：ThreadLocal 存当前租户
 */
public class TenantContext {
    private static final ThreadLocal<Long> TENANT_ID = new ThreadLocal<>();

    public static void set(Long tenantId) {
        TENANT_ID.set(tenantId);
    }

    public static Long get() {
        return TENANT_ID.get();
    }

    public static void clear() {
        TENANT_ID.remove();
    }
}

/**
 * 拦截器：从 token 解析 tenantId 存入 ThreadLocal
 */
@Component
public class TenantInterceptor implements HandlerInterceptor {

    @Override
    public boolean preHandle(HttpServletRequest req, HttpServletResponse
            resp, Object handler) {
        String token = req.getHeader("Authorization");
        Claims claims = JwtUtil.parse(token);
        Long tenantId = claims.get("tenantId", Long.class);
        TenantContext.set(tenantId);
        return true;
    }

    @Override
    public void afterCompletion(HttpServletRequest req, HttpServletResponse
            resp, Object handler, Exception ex) {
        TenantContext.clear();      // 防内存泄漏
    }
}
```

```java
/**
 * MyBatis 拦截器：自动注入 WHERE tenant_id=?
 * 开发不用手写 tenant_id 条件，防漏写导致串户
 */
@Intercepts(@Signature(type = Executor.class, method = "query",
    args = {MappedStatement.class, Object.class, RowBounds.class,
            ResultHandler.class}))
public class TenantInterceptor implements Interceptor {

    @Override
    public Object intercept(Invocation invocation) throws Throwable {
        Long tenantId = TenantContext.get();
        if (tenantId == null) return invocation.proceed();

        // 获取原始 SQL，注入 WHERE tenant_id=?
        Object[] args = invocation.getArgs();
        MappedStatement ms = (MappedStatement) args[0];
        BoundSql boundSql = ms.getBoundSql(args[1]);
        String sql = boundSql.getSql();

        // 简化：用 SQL 解析器（JSqlParser）注入 tenant_id 条件
        String newSql = injectTenantId(sql, tenantId);

        // 替换 SQL（反射改 BoundSql）
        Field field = boundSql.getClass().getDeclaredField("sql");
        field.setAccessible(true);
        field.set(boundSql, newSql);

        return invocation.proceed();
    }

    private String injectTenantId(String sql, Long tenantId) {
        // 用 JSqlParser 解析 SQL，在 WHERE 子句加 tenant_id = ?
        // 实际项目用 MyBatis-Plus TenantLineInnerInterceptor
        return sql.replaceAll("(?i)WHERE",
            "WHERE tenant_id = " + tenantId + " AND ");
    }
}
```

## 三、机制层：套餐定义

```sql
-- 套餐定义：各套餐配额上限
CREATE TABLE plan (
    plan_id VARCHAR(20) PRIMARY KEY,
    name VARCHAR(50),
    max_users INT,                  -- 最大用户数
    max_api_calls_daily INT,        -- 每日 API 调用上限
    max_storage_gb INT,             -- 存储上限 GB
    max_qps INT,                    -- QPS 上限
    features JSON,                  -- 功能开关（如高级报表）
    price_monthly DECIMAL(10,2)
);

INSERT INTO plan VALUES
('FREE', '免费版', 10, 1000, 1, 10,
 '{"advanced_report":false}', 0),
('BASIC', '基础版', 100, 10000, 10, 100,
 '{"advanced_report":false}', 299),
('ENTERPRISE', '企业版', 10000, 1000000, 100, 1000,
 '{"advanced_report":true}', 2999);

-- 租户订阅套餐
CREATE TABLE tenant (
    tenant_id BIGINT PRIMARY KEY,
    name VARCHAR(100),
    plan_id VARCHAR(20),
    status VARCHAR(20),            -- ACTIVE/SUSPENDED
    create_time DATETIME
);
```

## 四、机制层：配额统计与检查（Redis 计数器）

```java
@Service
@Slf4j
public class QuotaService {

    private final RedisTemplate<String, String> redis;
    private final PlanRepo planRepo;

    /**
     * 检查并消费配额（原子操作）
     * 返回 true 表示配额充足，false 表示超限
     */
    public boolean tryConsume(Long tenantId, ResourceType type, int amount) {
        Plan plan = getTenantPlan(tenantId);
        int limit = getLimit(plan, type);

        // 按日统计（key 带 yyyyMMdd）
        String date = LocalDate.now().format(YYYYMMDD);
        String key = "tenant:quota:" + tenantId + ":" + type + ":" + date;

        // Lua 原子操作：incr + 判断超限
        String lua = "local current = redis.call('incrby', KEYS[1], ARGV[1]) "
            + "if current == tonumber(ARGV[1]) then "
            + "  redis.call('expire', KEYS[1], 86400) "
            + "end "
            + "if current > tonumber(ARGV[2]) then "
            + "  redis.call('incrby', KEYS[1], -ARGV[1]) "
            + "  return 0 "
            + "end "
            + "return 1";

        Long result = redis.execute(new DefaultRedisScript<>(lua,
            Long.class), Collections.singletonList(key),
            String.valueOf(amount), String.valueOf(limit));

        if (result == 0) {
            log.warn("配额超限: tenant={} type={} current={}/{}",
                tenantId, type, getCurrent(key), limit);
            metrics.counter("quota.exceeded", "tenant",
                String.valueOf(tenantId), "type", type.name())
                .increment();
            return false;
        }
        return true;
    }

    private int getLimit(Plan plan, ResourceType type) {
        switch (type) {
            case API_CALL: return plan.getMaxApiCallsDaily();
            case STORAGE: return plan.getMaxStorageGb();
            case USER: return plan.getMaxUsers();
            default: throw new IllegalArgumentException();
        }
    }
}

/**
 * 配额检查注解 + AOP
 */
@Aspect
@Component
public class QuotaAspect {

    @Around("@annotation(quotaCheck)")
    public Object check(ProceedingJoinPoint pjp, QuotaCheck quotaCheck)
            throws Throwable {
        Long tenantId = TenantContext.get();
        if (!quotaService.tryConsume(tenantId,
                quotaCheck.type(), 1)) {
            throw new QuotaExceededException("配额超限，请升级套餐");
        }
        return pjp.proceed();
    }
}

// 使用：
@QuotaCheck(type = ResourceType.API_CALL)
@PostMapping("/api/orders")
public Order createOrder(@RequestBody OrderRequest req) {
    // 自动检查 API 调用配额
    return orderService.create(req);
}
```

## 五、机制层：租户限流（令牌桶）

```java
/**
 * 租户级 QPS 限流：令牌桶
 */
@Service
public class TenantRateLimiter {

    private final RedisTemplate<String, String> redis;

    public boolean tryAcquire(Long tenantId) {
        Plan plan = getTenantPlan(tenantId);
        int qps = plan.getMaxQps();

        String key = "ratelimit:tenant:" + tenantId;
        long now = System.currentTimeMillis();

        // Lua 令牌桶：按 QPS 补充令牌，消费一个
        String lua = "local key = KEYS[1] "
            + "local capacity = tonumber(ARGV[1]) "
            + "local now = tonumber(ARGV[2]) "
            + "local tokens = tonumber(redis.call('get', key..':tokens') or capacity) "
            + "local last = tonumber(redis.call('get', key..':last') or now) "
            + "local delta = math.max(0, now - last) * capacity / 1000 "
            + "tokens = math.min(capacity, tokens + delta) "
            + "if tokens < 1 then return 0 end "
            + "tokens = tokens - 1 "
            + "redis.call('set', key..':tokens', tokens) "
            + "redis.call('set', key..':last', now) "
            + "redis.call('expire', key..':tokens', 60) "
            + "return 1";

        Long result = redis.execute(new DefaultRedisScript<>(lua,
            Long.class), Collections.singletonList(key),
            String.valueOf(qps), String.valueOf(now));

        return result == 1;
    }
}

/**
 * 限流过滤器：所有 API 请求先限流
 */
@Component
public class RateLimitFilter extends OncePerRequestFilter {

    @Override
    protected void doFilterInternal(HttpServletRequest req,
            HttpServletResponse resp, FilterChain chain)
            throws ServletException, IOException {
        Long tenantId = TenantContext.get();
        if (!rateLimiter.tryAcquire(tenantId)) {
            resp.setStatus(429);
            resp.setHeader("Retry-After", "1");
            resp.getWriter().write("{\"error\":\"rate limit exceeded\"}");
            return;
        }
        chain.doFilter(req, resp);
    }
}
```

## 六、机制层：配额耗尽降级

```java
/**
 * 降级策略：免费套餐配额耗尽，转只读模式
 */
@Service
public class DegradeService {

    public void onQuotaExceeded(Long tenantId, Plan plan) {
        if ("FREE".equals(plan.getPlanId())) {
            // 免费套餐：超限后降级为只读
            tenantRepo.updateStatus(tenantId, TenantStatus.READONLY);
            notifyTenant(tenantId, "配额已用尽，当前为只读模式，升级套餐恢复");
        } else if ("BASIC".equals(plan.getPlanId())) {
            // 基础套餐：允许超额（下月账单扣费）
            log.info("基础套餐超额，允许并计费: tenant={}", tenantId);
        } else {
            // 企业套餐：直接允许
        }
    }
}
```

## 七、底层本质：隔离与配额的本质

**逻辑隔离的本质**：所有表带 tenant_id，SQL 加 WHERE tenant_id=? 过滤。成本低（共享 DB 共享 Schema）但要防漏写 tenant_id 导致串户。MyBatis 拦截器自动注入（开发不手写）+ 代码审查 + 测试（专用测试查"无 tenant_id 的 SQL"）。物理隔离（独立 DB）最安全但成本高（每租户一套 DB），适合金融/医疗等强合规场景。

**"吵闹的邻居"问题**：共享资源（DB/CPU/带宽）中，单租户可能耗尽资源影响其他租户。配额（用户数/API/存储）+ 限流（QPS）防单租户独占。这是多租户的核心治理问题——既要共享降成本，又要隔离保质量。

**配额统计的本质**：实时统计用量（Redis incr），判断是否超套餐上限。key 设计按维度（tenant:quota:{tenantId}:{resource}:{period}），period 是日/月。Lua 保证 incr + 判断原子（否则并发下多消费）。计数器有过期时间（日级 key 24 小时过期，月级 30 天）。

**令牌桶限流的本质**：按 QPS 补充令牌（如 100 QPS = 每秒补 100 个），请求消费一个令牌。桶有容量上限（突发流量缓冲）。Redis + Lua 实现原子（令牌补充 + 消费）。超限返回 429 + Retry-After。

**降级策略的本质**：配额耗尽后的处理因套餐而异——免费套餐严格（降级只读或拒绝，促付费转化），基础套餐弹性（允许超额下月扣费），企业套餐宽松（直接允许，月度对账）。这是**商业策略**在技术上的体现。

## 八、AI 工程化深挖

1. **怎么用 AI 预测租户用量？** 历史用量 + 业务周期训练模型，预测"租户 A 本月 API 调用将达 120%，建议升级套餐"。主动外呼提升续费率。

2. **怎么用 AI 检测异常租户？** 异常模式：某租户突然 API 调用暴增（可能被攻击/爬数据）、存储异常增长（可能滥用）。AI 检测 + 告警 + 限流。

3. **怎么用 LLM 做租户客服？** 租户工单接入 LLM（带租户的配置/数据上下文），自动回复常见问题（"怎么升级套餐/加用户"）。降低人工客服成本。

4. **怎么用 AI 智能定价？** 根据租户用量/行业/规模，AI 推荐最适合的套餐（"您当前用量适合基础版，每年省 2000 元"）。提升转化。

5. **怎么用 AI 做配额推荐？** 分析租户历史用量，AI 推荐最佳配额配置（"您的 API 用量稳定在 5000/天，建议配 8000 留余量"）。平衡成本和体验。

## 九、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"tenant_id、套餐、配额、限流"** 四个词。

- **tenant_id**：所有表带字段，MyBatis 拦截器自动注入 WHERE tenant_id=?
- **套餐**：plan 表定义配额上限（用户数/API/存储/QPS/功能）
- **配额**：Redis 计数器 tenant:quota:{tenantId}:{type}:{period}，Lua 原子 incr+判断
- **限流**：令牌桶（单租户 QPS），超限返回 429 + Retry-After

### 面试现场 60 秒回答

> 多租户 SaaS 我用 tenant_id 逻辑隔离 + 套餐配额 + 限流降级。隔离——所有表带 tenant_id 字段，TenantContext（ThreadLocal）存当前租户（从 JWT 解析），MyBatis 拦截器（TenantLineInnerInterceptor）自动注入 WHERE tenant_id=?（开发不手写，防漏写串户）。共享 DB 共享 Schema（成本低），物理隔离（独立 DB）只在强合规场景用。套餐——plan 表定义各套餐上限（FREE/BASIC/ENTERPRISE，配用户数/API/存储/QPS/功能），租户订阅套餐（tenant → planId）。配额统计——Redis 计数器 key=tenant:quota:{tenantId}:{type}:{yyyyMMdd}，Lua 原子 incr+判断（防并发多消费），日级 key 24 小时过期。@QuotaCheck 注解 + AOP 自动检查（如 API 调用每次 incr 1，超 max_api_calls_daily 返回配额超限）。限流——令牌桶（Redis+Lua 实现），按套餐 QPS 补充令牌（FREE 10 QPS，ENTERPRISE 1000 QPS），超限返回 429 + Retry-After。降级策略——免费套餐配额耗尽降级只读（促付费转化），基础套餐允许超额下月扣费，企业套餐直接允许。这是"吵闹邻居"问题的治理——共享资源下防单租户独占。监控 quota_exceeded_rate、ratelimit_429_count、tenant_usage_growth。

## 十、苏格拉底追问

| 追问 | 证据/答案 |
|------|-----------|
| 为什么不用独立 DB（物理隔离）？ | 成本高（万租户 = 万 DB）。逻辑隔离（共享 DB + tenant_id）成本低，配合拦截器防串户够用。强合规（金融）才用物理隔离。 |
| MyBatis 拦截器漏注入怎么办？ | 三层防护：拦截器自动注入 + 代码审查（查无 tenant_id 的 SQL）+ 测试（专用测试查跨租户访问）。 |
| 配额并发超消费怎么办？ | Lua 原子操作（incr + 判断 + 回滚在一个 Lua 脚本）。不用 Lua 的话并发下多个请求同时判断"未超限"都通过，导致超额。 |
| 配额耗尽怎么降级？ | 按套餐策略——免费降级只读（促付费），基础允许超额扣费，企业允许。商业策略在技术上的体现。 |
| 怎么计费？ | 按用量。Redis 计数器数据持久化到 DB，月底出账单。计数器和 DB 对账（防 Redis 丢失）。 |

## 十、常见考点

1. **多租户怎么隔离？**——逻辑隔离（共享 DB + tenant_id 字段）。MyBatis 拦截器自动注入 WHERE tenant_id=?（开发不手写）。物理隔离（独立 DB）成本高，强合规才用。
2. **套餐配额怎么实现？**——plan 表定义上限，Redis 计数器实时统计（Lua 原子 incr+判断）。@QuotaCheck 注解 + AOP 自动检查。日级 key 24 小时过期。
3. **怎么防"吵闹的邻居"？**——配额（用户/API/存储上限）+ 限流（QPS 令牌桶）。单租户不能耗尽共享资源影响其他租户。
4. **限流怎么实现？**——令牌桶（Redis+Lua）。按套餐 QPS 补充令牌（FREE 10 QPS，ENTERPRISE 1000 QPS），超限返回 429 + Retry-After。
5. **配额耗尽怎么办？**——降级策略因套餐而异。免费降级只读（促付费），基础允许超额扣费，企业允许。

## 结构化回答

**30 秒电梯演讲：** 多租户 SaaS 的核心是tenant_id 隔离 + 套餐配额 + 限流降级。所有表带 tenant_id 字段实现逻辑隔离（共享 DB 共享 Schema）。套餐（免费/基础/企业）决定配额（用户数/API 调用/存储）。配额用 Redis 计数器实时统计，超限拒绝或降级

**展开框架：**
1. **tenant_id 隔离** — 所有表带 tenant_id，MyBatis 拦截器自动注入 WHERE tenant_id=?
2. **套餐定义** — 免费/基础/企业，定义配额（用户数/API/存储/功能）
3. **配额统计** — Redis 计数器（日/月维度），实时 incr + 判断

**收尾：** 以上是我的整体思路。您想继续深入聊——怎么防数据串户？


## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：多租户 SaaS 的套餐、配额与限流 | "这题一句话：多租户 SaaS 的核心是tenant_id 隔离 + 套餐配额 + 限流降级。" | 开场钩子 |
| 0:15 | 像写字楼——所有公司共用一栋楼（共享 DB）类比图 | "打个比方：像写字楼——所有公司共用一栋楼（共享 DB）。" | 核心类比 |
| 0:40 | tenant_id 隔离示意/对比图 | "所有表带 tenant_id，MyBatis 拦截器自动注入 WHERE tenant_id=?" | tenant_id 隔离要点 |
| 1:05 | 套餐定义示意/对比图 | "免费/基础/企业，定义配额（用户数/API/存储/功能）" | 套餐定义要点 |
| 1:55 | 总结卡 | "记住：tenant_id 隔离。下期见。" | 收尾 |
