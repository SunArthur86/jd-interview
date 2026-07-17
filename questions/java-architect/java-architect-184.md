---
id: java-architect-184
difficulty: L2
category: java-architect
subcategory: 灰度发布
tags:
- Java 架构师
- 租户
- 灰度
- 配置隔离
- Feature Flag
feynman:
  essence: 租户级灰度发布的核心是"Feature Flag + 租户路由 + 配置隔离"。功能开关（Feature Flag）控制新功能对哪些租户可见。灰度路由按租户 ID 白名单/百分比分流——部分租户走新版本，其余走老版本。配置隔离让每租户有独立配置（如不同租户不同阈值）。
  analogy: 像商场试营业——新店铺先邀请 VIP 客户体验（白名单灰度），没问题再开放给 10% 顾客（百分比灰度），最后全量开业。每个 VIP 有专属优惠配置（配置隔离）。
  first_principle: 新功能全量上线风险高（bug 影响所有租户）。灰度发布——小范围先上，验证没问题再扩量。租户级灰度比用户级更适合 SaaS（整租户体验一致，不串户）。配置隔离让租户个性化（不同租户不同规则）。
  key_points:
  - Feature Flag：功能开关，控制新功能可见性
  - 灰度路由：白名单（指定租户）+ 百分比（hash(tenantId) % 100 < ratio）
  - 配置隔离：每租户独立配置（Apollo/Nacos namespace per tenant）
  - 灰度策略：白名单 → 5% → 25% → 100%，逐步扩量
  - 快速回滚：关闭 Feature Flag 秒级回滚（不用重新发版）
first_principle:
  problem: SaaS 新功能如何安全上线——小范围验证、整租户体验一致、出问题快速回滚、还要支持租户个性化配置？
  axioms:
  - 新功能全量上线风险高（bug 影响所有租户，事故级别高）
  - 租户级灰度比用户级好（整租户体验一致，不串户）
  - 出问题要快速回滚（重新发版慢，Feature Flag 秒级）
  - 不同租户可能需要不同配置（个性化）
  rebuild: Feature Flag（Apollo/Nacos 配置中心）控制功能开关。灰度策略：白名单（指定租户先试）→ 5%（hash(tenantId) % 100 < 5）→ 25% → 100%，逐步扩量。路由层判断当前租户是否命中灰度（查 flag + 租户白名单 + 百分比）。配置隔离——每租户独立 namespace 或配置 key 带 tenantId 前缀。出问题关闭 flag 秒级回滚（老版本代码还在，只是 flag 关闭走老逻辑）。
follow_up:
  - Feature Flag 怎么实现？——Apollo/Nacos 配置中心。key=feature.xxx.enabled，value=true/false 或租户白名单。应用监听配置变化实时生效。
  - 灰度百分比怎么算？——hash(tenantId) % 100 < ratio。hash 要稳定（同一租户要么一直在灰度要么一直不在）。用 MurmurHash。
  - 配置怎么隔离？——每租户独立 namespace（Apollo）或配置 key 带 tenantId 前缀（config.{tenantId}.threshold）。应用启动时加载本租户配置。
  - 灰度和 AB 测试区别？——灰度是为安全上线（逐步扩量），AB 测试是为数据决策（分流比较指标）。灰度可复用 AB 测试的分流通用能力。
  - 出问题怎么回滚？——关闭 Feature Flag（秒级，配置中心推送）。应用监听到 flag 变化走老逻辑。不用重新发版（老代码保留）。
memory_points:
  - Feature Flag：Apollo/Nacos，key=feature.xxx.enabled
  - 灰度路由：白名单 + hash(tenantId) % 100 < ratio
  - 配置隔离：每租户 namespace 或 config.{tenantId}.xxx
  - 灰度策略：白名单 → 5% → 25% → 100%
  - 回滚：关闭 flag 秒级（老代码保留，flag 关走老逻辑）
---

# 【Java 后端架构师】租户级灰度发布与配置隔离

> 适用场景：JD SaaS 产品新功能上线（如新版报表/新 API）。不能全量上线（风险高），要小范围租户先验证。架构师要设计的是"Feature Flag + 灰度路由 + 配置隔离"的租户级灰度系统。

## 一、概念层：灰度发布架构

```
新功能开发完 → Feature Flag 控制（默认关闭）
                    ↓
灰度策略：白名单（内部租户）→ 5% → 25% → 100%
                    ↓
路由层判断：查 flag + 租户白名单 + hash(tenantId) % 100 < ratio
                    ↓
        命中灰度 → 走新逻辑 / 未命中 → 走老逻辑
                    ↓
配置隔离：每租户独立配置（namespace 或 key 带前缀）
                    ↓
出问题：关闭 flag 秒级回滚（老代码保留）
```

## 二、机制层：Feature Flag 配置

```java
/**
 * Feature Flag 配置（Apollo/Nacos 配置中心）
 */
@Configuration
@RefreshScope
public class FeatureFlags {

    // 简单开关
    @Value("${feature.newReport.enabled:false}")
    private boolean newReportEnabled;

    // 灰度百分比（0-100）
    @Value("${feature.newReport.rolloutPercent:0}")
    private int newReportRolloutPercent;

    // 白名单租户
    @Value("${feature.newReport.whitelistTenantIds:}")
    private String whitelistTenantIds;

    // 是否启用配置（true 才判断灰度）
    public boolean isNewReportEnabledFor(Long tenantId) {
        if (!newReportEnabled) return false;

        // 1. 白名单租户直接放行
        if (isWhitelisted(tenantId)) return true;

        // 2. 百分比灰度（hash 稳定）
        int hash = Math.abs(tenantId.hashCode()) % 100;
        return hash < newReportRolloutPercent;
    }

    private boolean isWhitelisted(Long tenantId) {
        Set<Long> whitelist = parseLongSet(whitelistTenantIds);
        return whitelist.contains(tenantId);
    }
}
```

Apollo 配置示例：
```yaml
# application.yml（Apollo namespace）
feature:
  newReport:
    enabled: true
    rolloutPercent: 5          # 5% 租户灰度
    whitelistTenantIds: 1001,1002,1003   # 内部测试租户
```

## 三、机制层：灰度路由

```java
/**
 * 灰度路由：判断租户是否命中灰度
 */
@Service
public class GrayRouter {

    private final FeatureFlags flags;

    public boolean isGray(Long tenantId, String featureKey) {
        // 统一入口：查各 feature 的灰度状态
        switch (featureKey) {
            case "newReport":
                return flags.isNewReportEnabledFor(tenantId);
            case "newApi":
                return flags.isNewApiEnabledFor(tenantId);
            default:
                return false;
        }
    }
}

/**
 * 业务层：根据灰度走不同逻辑
 */
@Service
public class ReportService {

    private final GrayRouter grayRouter;
    private final OldReportService oldService;
    private final NewReportService newService;

    public Report generate(Long tenantId, ReportRequest req) {
        if (grayRouter.isGray(tenantId, "newReport")) {
            // 命中灰度：走新逻辑
            return newService.generate(tenantId, req);
        } else {
            // 未命中：走老逻辑
            return oldService.generate(tenantId, req);
        }
    }
}
```

## 四、机制层：网关层灰度（路由到不同服务）

```java
/**
 * 网关层灰度：租户命中灰度路由到新版本服务
 */
@Component
public class GrayGatewayFilter implements GlobalFilter {

    private final GrayRouter grayRouter;

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
        Long tenantId = extractTenantId(exchange.getRequest());

        if (grayRouter.isGray(tenantId, "newReport")) {
            // 命中灰度：加 header 路由到新版本服务
            ServerHttpRequest req = exchange.getRequest().mutate()
                .header("X-Gray-Version", "v2")
                .build();
            return chain.filter(exchange.mutate().request(req).build());
        }

        return chain.filter(exchange);
    }
}
```

```yaml
# 网关路由配置（按 header 路由到不同服务）
spring:
  cloud:
    gateway:
      routes:
        - id: report-service-v1
          uri: lb://report-service-v1
          predicates:
            - Path=/api/report/**
            - Header=!X-Gray-Version, v2    # 没有 v2 header 走老版本
        - id: report-service-v2
          uri: lb://report-service-v2
          predicates:
            - Path=/api/report/**
            - Header=X-Gray-Version, v2     # 有 v2 header 走新版本
```

## 五、机制层：配置隔离（每租户独立配置）

```java
/**
 * 配置隔离：每租户独立配置
 * 方案1：Apollo namespace per tenant（重）
 * 方案2：配置 key 带 tenantId 前缀（轻）
 */
@Service
public class TenantConfigService {

    private final ConfigService apolloConfig;

    /**
     * 获取租户配置：先查租户级配置，没有则用默认
     */
    public String getConfig(Long tenantId, String configKey) {
        // 1. 查租户级配置（config.{tenantId}.threshold）
        String tenantKey = "config." + tenantId + "." + configKey;
        String value = apolloConfig.getProperty(tenantKey, null);

        if (value != null) return value;

        // 2. 没有租户级配置，用默认值
        return apolloConfig.getProperty("config.default." + configKey,
            getDefault(configKey));
    }

    /**
     * 示例：不同租户不同订单超时时间
     * 租户 1001：config.1001.orderTimeout = 7200（2 小时）
     * 租户 1002：config.1002.orderTimeout = 1800（30 分钟）
     * 默认：config.default.orderTimeout = 3600（1 小时）
     */
    public int getOrderTimeout(Long tenantId) {
        return Integer.parseInt(getConfig(tenantId, "orderTimeout"));
    }
}
```

## 六、机制层：灰度扩量流程

```java
/**
 * 灰度扩量：白名单 → 5% → 25% → 100%
 */
@Service
@Slf4j
public class RolloutService {

    private final ApolloClient apolloClient;

    /**
     * 扩量灰度百分比
     */
    public void expand(String featureKey, int newPercent) {
        log.info("灰度扩量: feature={} percent={}",
            featureKey, newPercent);

        // 更新 Apollo 配置
        apolloClient.setProperty("feature." + featureKey
            + ".rolloutPercent", String.valueOf(newPercent));

        // 监控灰度租户的错误率
        scheduleRolloutMonitor(featureKey, newPercent);
    }

    /**
     * 监控：错误率超阈值自动回滚
     */
    @Scheduled(fixedDelay = 60_000)
    public void monitor() {
        for (String feature : getRollingFeatures()) {
            double errorRate = getErrorRate(feature);
            if (errorRate > 0.05) {        // 错误率 > 5% 自动回滚
                log.error("灰度错误率超阈值，自动回滚: feature={} rate={}",
                    feature, errorRate);
                rollback(feature);
            }
        }
    }

    public void rollback(String featureKey) {
        apolloClient.setProperty("feature." + featureKey
            + ".rolloutPercent", "0");
        apolloClient.setProperty("feature." + featureKey
            + ".enabled", "false");
        metrics.counter("rollout.rollback", "feature", featureKey)
            .increment();
    }
}
```

## 七、底层本质：灰度与配置隔离的本质

**Feature Flag 的本质**：解耦"代码部署"和"功能上线"。代码部署到生产环境（多次发布），但功能是否对用户可见由 flag 控制。这是**开闭原则**在运维层面的体现——代码部署是"开"（新增），flag 控制是"闭"（关闭）。好处：1) 出问题秒级回滚（关 flag，不用重新发版）；2) 新功能开发完先部署不开（等业务时机）。

**灰度路由的本质**：按租户 ID 的稳定 hash 分流。hash 要稳定（同一租户要么一直在灰度要么一直不在，不能时在时不在导致体验混乱）。MurmurHash 比 hashCode 分布更均匀。白名单（指定租户先试）+ 百分比（hash % 100 < ratio）是经典灰度策略。

**配置隔离的本质**：每租户独立配置。两种方案——namespace per tenant（Apollo 原生支持，但 namespace 多管理重）或 key 带 tenantId 前缀（config.{tenantId}.xxx，轻量但 key 散乱）。通常用后者 + 默认值兜底（查租户级，没有用默认）。

**灰度 vs AB 测试的区别**：
- **灰度**：为安全上线。逐步扩量（5% → 25% → 100%），发现问题回滚。目标是风险控制。
- **AB 测试**：为数据决策。固定分流（50% A vs 50% B），比较指标（CTR/转化率）。目标是验证假设。

技术上都用分流通用能力（hash 路由），但目的不同。灰度出错要回滚，AB 测试不能随意回滚（破坏实验有效性）。

**回滚的本质**：关 flag 秒级生效（配置中心推送）。老版本代码保留（只是 flag 关闭走老逻辑），不用重新发版。这是 Feature Flag 相比蓝绿部署/金丝雀部署的优势——回滚成本最低。

## 八、AI 工程化深挖

1. **怎么用 AI 决定灰度扩量？** 分析灰度租户的错误率/性能/业务指标，AI 判断"是否可以扩量"或"需要回滚"。比人工判断更客观及时。

2. **怎么用 AI 预测灰度风险？** 新功能上线前，AI 根据代码变更（diff）/依赖/历史 bug 预测风险等级。高风险的灰度更保守（1% 起步）。

3. **怎么用 LLM 生成灰度报告？** 灰度期间 LLM 总结"本次灰度覆盖 100 租户，错误率 0.5%（低于阈值），响应时间 +10ms，建议扩量"。自动化决策。

4. **怎么用 AI 智能配置推荐？** 分析租户历史用量/业务模式，AI 推荐最佳配置（"您是电商租户，建议订单超时 30 分钟"）。降低配置门槛。

5. **怎么用 AI 检测配置异常？** 某租户配置偏离正常范围（如超时设 999 秒），AI 检测告警。防配置错误。

## 九、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"Flag、灰度、隔离、回滚"** 四个词。

- **Flag**：Feature Flag（Apollo），控制功能可见性，解耦部署和上线
- **灰度**：白名单 + hash(tenantId) % 100 < ratio，逐步扩量
- **隔离**：config.{tenantId}.xxx（租户级）+ config.default.xxx（默认兜底）
- **回滚**：关 flag 秒级（老代码保留），不用重新发版

### 面试现场 60 秒回答

> 租户级灰度我用 Feature Flag + 灰度路由 + 配置隔离。Feature Flag（Apollo 配置中心）控制功能可见性——key=feature.newReport.enabled + rolloutPercent + whitelistTenantIds，应用 @RefreshScope 监听配置变化实时生效。这解耦了"代码部署"和"功能上线"——代码部署到生产但 flag 关着功能不可见，出问题关 flag 秒级回滚（老代码保留走老逻辑，不用重新发版）。灰度路由——判断租户是否命中灰度：白名单（指定内部租户先试）+ 百分比（hash(tenantId) % 100 < ratio，MurmurHash 稳定，同一租户要么一直在灰度要么一直不在）。业务层 if-else 分流（命中走 NewReportService，未命中走 OldReportService），或网关层加 X-Gray-Version header 路由到不同版本服务。灰度策略：白名单 → 5% → 25% → 100% 逐步扩量，每步监控错误率，超 5% 自动回滚（关 flag）。配置隔离——key 带 tenantId 前缀（config.{tenantId}.orderTimeout），查租户级配置没有则用默认（config.default.orderTimeout），让不同租户不同个性化配置。灰度 vs AB 测试——灰度为安全上线（逐步扩量风险控制），AB 测试为数据决策（固定分流比较指标）。技术都用 hash 分流通用能力，目的不同。监控 rollout_error_rate、gray_tenant_count、rollback_count。

## 十、常见考点

1. **Feature Flag 是什么？**——配置中心控制功能开关（enabled + rolloutPercent + whitelist）。解耦部署和上线，出问题关 flag 秒级回滚（不用重新发版，老代码保留）。
2. **灰度怎么分流？**——白名单（指定租户先试）+ 百分比（hash(tenantId) % 100 < ratio）。hash 要稳定（MurmurHash），同一租户要么在要么不在。
3. **配置怎么隔离？**——key 带 tenantId 前缀（config.{tenantId}.xxx）+ 默认值兜底（config.default.xxx）。查租户级没有用默认。
4. **灰度怎么扩量？**——白名单 → 5% → 25% → 100%。每步监控错误率，超阈值（5%）自动回滚（关 flag）。
5. **灰度和 AB 测试区别？**——灰度为安全上线（逐步扩量风险控制），AB 测试为数据决策（固定分流比较指标）。技术都用 hash 分流，目的不同。

## 结构化回答

**30 秒电梯演讲：** 租户级灰度发布的核心是Feature Flag + 租户路由 + 配置隔离。功能开关（Feature Flag）控制新功能对哪些租户可见。灰度路由按租户 ID 白名单/百分比分流——部分租户走新版本，其余走老版本。配置隔离让每租户有独立配置（如不同租户不同阈值）

**展开框架：**
1. **Feature Flag** — 功能开关，控制新功能可见性
2. **灰度路由** — 白名单（指定租户）+ 百分比（hash(tenantId) % 100 < ratio）
3. **配置隔离** — 每租户独立配置（Apollo/Nacos namespace per tenant）

**收尾：** 以上是我的整体思路。您想继续深入聊——Feature Flag 怎么实现？


## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：租户级灰度发布与配置隔离 | "这题一句话：租户级灰度发布的核心是Feature Flag + 租户路由 + 配置隔离。" | 开场钩子 |
| 0:15 | Feature Flag示意/对比图 | "功能开关，控制新功能可见性" | Feature Flag要点 |
| 0:40 | 灰度路由示意/对比图 | "白名单（指定租户）+ 百分比（hash(tenantId) % 100 < ratio）" | 灰度路由要点 |
| 1:25 | 总结卡 | "记住：Feature Flag。下期见。" | 收尾 |
