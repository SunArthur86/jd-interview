---
id: java-architect-132
difficulty: L3
category: java-architect
subcategory: 安全架构
tags:
- Java 架构师
- 零信任
- mTLS
- 最小权限
feynman:
  essence: 零信任的核心是"Never trust, always verify"——不再有"内网默认可信"假设。每个请求（无论来自内网还是外网）都要经过身份认证、设备验证、策略授权三道关。Java 后端落地三个抓手：(1) 服务间 mTLS 双向证书认证（替代 IP 白名单）；(2) 每个请求带 JWT/OAuth2 token，业务系统按 token + 上下文做策略授权（OPA/Cedar）；(3) 最小权限——默认拒绝，按需授权，定期回收。
  analogy: 传统安全像"城堡护城河"——外敌进不来，城堡内畅通无阻。零信任像"机场安检"——不论你是机长还是乘客，每个登机口都要验票、查证件、过 X 光。城堡模型一旦内网被渗透（如钓鱼员工），攻击者畅通；零信任每个跳转都重新验，攻击者拿一个 token 只能做一个事。
  first_principle: 为什么"内网默认可信"假设失效？因为云原生时代服务间调用复杂、移动办公、第三方集成、容器化部署——内网边界早已模糊。一个被钓鱼的员工笔记本就是内网跳板。零信任放弃"位置信任"，转向"身份 + 设备 + 上下文"信任。
  key_points:
  - 三道关：身份（Identity）+ 设备（Device）+ 上下文（Context/Policy）
  - 服务间认证：mTLS（双向 TLS，证书由内部 CA 签发）
  - 用户认证：OAuth2/OIDC token，每次请求验签
  - 授权策略：OPA/Cedar 策略引擎，按属性（ABAC）而非角色（RBAC）
  - 最小权限：默认拒绝、按需授权、定期审计回收
first_principle:
  problem: 在云原生时代，如何让"被钓鱼的员工笔记本"不能横向移动到核心交易系统？
  axioms:
  - 内网边界早已模糊（云、容器、移动办公、第三方集成）
  - 位置（IP）不等于身份，身份不等于权限
  - 单点凭证泄露是不可避免的，要靠"每跳验证 + 最小权限"限制爆炸半径
  rebuild: 服务间全部 mTLS（证书由内部 CA 签发，证书带 service identity），每个请求带 OAuth2/JWT token（验签 + 验 scope），授权用 OPA 策略引擎按 user+resource+context 三元组判定。默认拒绝，所有 allow 必须显式策略授权。证书自动化签发和轮转（SPIFFE/SPIRE 或 Istio）。这样攻击者拿到一个 token 只能做一个事，拿到一个证书只能伪装一个服务，爆炸半径被收敛。
follow_up:
  - mTLS 证书怎么签发和轮转？——内部 CA（如 cfssl、HashiCorp Vault）签发，SPIFFE/SPIRE 自动化注入；Istio/Linkerd 通过控制面自动签发和轮转（默认 24 小时轮转）。
  - 内网服务调内网服务也要 mTLS？——是的，这是零信任核心。即使内网也要 mTLS，因为"内网不可信"。
  - 零信任对性能影响？——mTLS 握手有开销（首次 RTT），但 TLS 1.3 + session resumption + 长连接复用能降到纳秒级；策略引擎 OPA 决策 < 1ms（in-process）。
  - 怎么渐进式落地零信任？——从敏感服务（资金、用户数据）开始，逐步扩散；先 mTLS（基础设施层），再 OAuth2（应用层），最后 OPA（策略层）；不一次重构。
  - OPA 和 Cedar 怎么选？——OPA（Rego 语言）生态成熟、复杂场景强；Cedar（AWS 推出）语法简洁、易学；新项目选 Cedar，存量选 OPA。
memory_points:
  - 三道关：Identity + Device + Policy
  - mTLS：服务间双向认证，内部 CA 签发
  - 每个请求验 JWT：scope + audience + expiration
  - 策略引擎 OPA/Cedar：ABAC 优于 RBAC
  - 最小权限：默认拒绝 + 按需授权 + 定期回收
---

# 【Java 后端架构师】零信任架构在 Java 后端中的落地

> 适用场景：JD 核心技术。京东内部 5000+ 微服务，传统"内网默认可信 + IP 白名单"模式在云原生环境下崩溃——一个被钓鱼的员工笔记本就是内网跳板，能横向移动到支付系统。零信任落地后，服务间 mTLS + 每请求 JWT + OPA 策略授权，攻击者拿到一个 token 只能做一个事，爆炸半径收敛到单点。

## 一、概念层

**传统城堡模型 vs 零信任模型**：

| 维度 | 城堡模型（旧） | 零信任模型（新） |
|------|---------------|----------------|
| 信任边界 | 内网可信，外网不可信 | 无边界，每跳验证 |
| 认证粒度 | 网络层（IP 白名单） | 应用层（身份 + 设备 + 上下文） |
| 一旦被渗透 | 内网横向移动畅通 | 每跳重新验，爆炸半径收敛 |
| 授权方式 | RBAC（基于角色） | ABAC（基于属性，更细粒度） |
| 默认策略 | 默认允许（白名单拒绝） | 默认拒绝（白名单允许） |
| 证书管理 | 单向 TLS（服务端证） | 双向 mTLS（双方互证） |

**零信任的"三道关"**（NIST SP 800-207）：

```
请求（来自任何地方） ──► 1. Identity 验证（你是谁）
                              │ JWT/OAuth2 token + MFA
                              ▼
                        2. Device 验证（你的设备可信吗）
                              │ 设备证书 + 健康度（patch level）
                              ▼
                        3. Policy 授权（你能做什么）
                              │ OPA/Cedar 策略引擎
                              ▼
                          允许 / 拒绝
```

## 二、机制层：mTLS 服务间认证

**Istio 自动 mTLS 配置**：

```yaml
# PeerAuthentication: 强制整个 mesh 使用 mTLS
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: default
  namespace: payment
spec:
  mtls:
    mode: STRICT         # STRICT = 强制 mTLS，PERMISSIVE = 兼容期
---
# AuthorizationPolicy: 限定谁能调支付服务
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: payment-policy
  namespace: payment
spec:
  selector:
    matchLabels:
      app: payment-service
  action: ALLOW
  rules:
    # 只允许 order-service 调用支付服务
    - from:
        - source:
            principals: ["cluster.local/ns/订单/sa/order-service"]
            # SPIFFE ID：服务身份标识
      to:
        - operation:
            methods: ["POST"]
            paths: ["/payment/charge"]
      when:
        - key: request.auth.claims[scope]
          values: ["payment.write"]   # 还要 token scope 匹配
```

**SPIFFE ID 格式**（必背）：

```
spiffe://<trust-domain>/<path>
例：
spiffe://cluster.local/ns/payment/sa/payment-service
        │                │            │
        trust domain     namespace    service account
```

每个服务在 mesh 内有唯一 SPIFFE ID，mTLS 证书带这个 ID，调用方知道"对面真的是 payment-service"。

**Java 应用层获取 mTLS 上下文**：

```java
// 通过 Istio 注入的 header 获取调用方身份
@Component
public class PeerAuthFilter extends OncePerRequestFilter {

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse resp,
                                     FilterChain chain) throws ServletException, IOException {
        // Istio 注入 mTLS 证书信息
        String callerSpiffe = req.getHeader("X-Forwarded-Client-Cert");
        // XFCC header 包含 SPIFFE ID、证书指纹、SAN 等

        if (!validateCaller(callerSpiffe)) {
            resp.setStatus(403);
            return;
        }

        // 同时验证 JWT（用户/客户端 token）
        String auth = req.getHeader("Authorization");
        if (auth == null || !auth.startsWith("Bearer ")) {
            resp.setStatus(401);
            return;
        }
        Jwt jwt = jwtDecoder.decode(auth.substring(7));

        // 把身份信息塞到请求上下文
        req.setAttribute("callerService", extractServiceId(callerSpiffe));
        req.setAttribute("userContext", new UserContext(jwt));

        chain.doFilter(req, resp);
    }
}
```

## 三、机制层：OPA 策略引擎授权

**OPA Rego 策略代码**（按属性授权）：

```rego
# policy.rego - 支付服务授权策略
package payment.authz

# 默认拒绝
default allow := false

# 主授权规则
allow {
    # 输入：user + resource + action + context
    input.action == "payment.charge"
    input.resource.service == "payment-service"

    # 规则 1：用户必须有 payment.write scope
    token.scope[_] == "payment.write"

    # 规则 2：用户只能操作自己的订单
    token.sub == resource.owner_id

    # 规则 3：金额超过 10000 需要额外审核
    input.amount <= 10000
}

# 或者：大额需要 manager 审批
allow {
    input.action == "payment.charge"
    input.amount > 10000
    token.roles[_] == "manager"     # 大额必须 manager
    token.scope[_] == "payment.write"
}

# 紧急情况：风控角色可以阻止任何支付
deny {
    input.action == "payment.charge"
    token.roles[_] == "risk_control"
    input.risk_level == "HIGH"
}

# 输出 helper
reason[msg] {
    not allow
    msg := "默认拒绝：不满足授权策略"
}

reason[msg] {
    deny
    msg := "风控拒绝：高风险交易"
}
```

**Java 集成 OPA**（每次请求查询策略）：

```java
@Service
public class AuthzService {

    @Autowired private OpaClient opaClient;

    public void check(UserContext user, String action, Resource resource, Map<String, Object> ctx) {
        // 构造 OPA 输入
        Map<String, Object> input = Map.of(
            "action", action,
            "resource", Map.of(
                "service", resource.getService(),
                "owner_id", resource.getOwnerId()
            ),
            "token", Map.of(
                "sub", user.getUserId(),
                "scope", user.getScopes(),
                "roles", user.getRoles()
            ),
            "amount", ctx.getOrDefault("amount", 0),
            "risk_level", ctx.getOrDefault("risk_level", "LOW")
        );

        // 查询 OPA（in-process 或 HTTP）
        OpaDecision decision = opaClient.query("payment/authz/allow", input);

        if (!decision.isAllow()) {
            throw new AccessDeniedException(decision.getReason());
        }
    }
}

// 切面拦截
@Aspect
@Component
public class AuthzAspect {

    @Autowired private AuthzService authzService;

    @Around("@annotation(authz)")
    public Object check(ProceedingJoinPoint pjp, RequireAuthz authz) throws Throwable {
        UserContext user = currentUser();
        authzService.check(user, authz.action(), extractResource(pjp), buildContext(pjp));
        return pjp.proceed();
    }
}

// 使用
@RequireAuthz(action = "payment.charge")
@PostMapping("/payment/charge")
public ChargeResponse charge(@RequestBody ChargeRequest req) {
    // ...
}
```

## 四、机制层：最小权限 + 默认拒绝

**默认拒绝的策略实现**：

```java
// Spring Security 配置：任何请求默认拒绝
@Configuration
@EnableWebSecurity
public class ZeroTrustSecurityConfig {

    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
        http
            // 默认拒绝所有请求
            .authorizeHttpRequests(auth -> auth
                .anyRequest().authenticated()        // 默认拒绝匿名
            )
            .oauth2ResourceServer(oauth2 -> oauth2
                .jwt(jwt -> jwt.decoder(jwtDecoder()))  // 强制 JWT 验证
            )
            // 强制 HTTPS
            .requiresChannel(channel -> channel.anyRequest().requiresSecure())
            // 安全 headers
            .headers(headers -> headers
                .contentSecurityPolicy(csp -> csp.policyDirectives("default-src 'self'"))
                .frameOptions(fo -> fo.deny())
                .httpStrictTransportSecurity(hsts -> hsts
                    .includeSubDomains(true)
                    .maxAgeInSeconds(31536000)
                )
            )
            // CSRF（state-changing 请求必须带 CSRF token）
            .csrf(csrf -> csrf.csrfTokenRepository(CookieCsrfTokenRepository.withHttpOnlyFalse()))
            // rate limit
            .addFilterBefore(rateLimitFilter(), UsernamePasswordAuthenticationFilter.class);
        return http.build();
    }
}
```

**权限定期审计与回收**（自动化）：

```java
// 每周扫描用户 scope，回收未使用的
@Scheduled(cron = "0 0 2 * * MON")
public void auditAndRevokeStaleScopes() {
    List<UserScope> allScopes = scopeRepo.findAllActive();

    for (UserScope scope : allScopes) {
        // 6 个月未使用的 scope 标记为 stale
        LocalDateTime lastUsed = auditLogService.findLastUse(scope);
        if (lastUsed.isBefore(LocalDateTime.now().minusMonths(6))) {
            scope.setStatus("STALE");
            notifyOwner(scope);  // 邮件通知 owner
            // 30 天无响应自动回收
            scheduleRevoke(scope, 30);
        }
    }
}
```

## 五、实战层/选型：渐进式落地路径

**零信任落地四阶段**：

| 阶段 | 内容 | 周期 |
|------|------|------|
| 1. 资产清点 | 梳理服务、调用关系、数据流、权限矩阵 | 1 月 |
| 2. 身份统一 | 部署 IdP，所有系统接入 OIDC SSO | 2 月 |
| 3. 服务间 mTLS | 部署 Service Mesh（Istio），逐步切 mTLS | 3 月 |
| 4. 策略授权 | 部署 OPA，关键服务接入策略引擎 | 持续 |

**关键决策点**：

| 决策 | 选项 | 推荐 |
|------|------|------|
| Mesh 选型 | Istio / Linkeder / 自研 | Istio（生态最大） |
| 证书 CA | cfssl / Vault / SPIRE | Vault（密钥管理一体） |
| 策略引擎 | OPA / Cedar / 自研 | OPA（生态成熟） |
| IdP | Keycloak / Auth0 / 自研 | Keycloak（开源可控） |

## 六、底层本质：信任的重新定义

回到第一性：**零信任不是"不信任"，而是"信任基于持续验证而非位置假设"**。

- **位置信任失效的本质**：云原生时代"内网"边界模糊——K8s pod、混合云、VPN、第三方集成。员工笔记本 + VPN 就是内网，但笔记本被钓鱼就成跳板。位置（IP）不等于身份。
- **mTLS 替代 IP 白名单的本质**：IP 白名单是"网络层信任"（IP 对就放行），mTLS 是"应用层信任"（证书证明服务身份）。前者易伪造（IP 欺骗），后者需要私钥（破解成本高）。
- **最小权限的本质**：默认拒绝让"攻击者拿到凭证的爆炸半径"最小化。如果默认允许，攻击者一个 token 能调所有接口；默认拒绝，一个 token 只能做策略明确允许的事。
- **OPA ABAC vs RBAC**：RBAC（基于角色）颗粒度粗（manager 能看所有订单）；ABAC（基于属性）能表达"manager 只能看自己部门的订单"这种细粒度策略。

**零信任的代价**：复杂度上升（mTLS + OAuth2 + OPA 三层）、性能开销（首次握手延迟）、运维成本（证书轮转、策略维护）。所以不是所有场景都要上零信任——低风险内部系统可以"轻量零信任"（只 OAuth2，不做 mTLS）。

## 七、AI 架构师加问：5 个

1. **LLM Agent 调内部 API，零信任怎么管？**
   Agent 用 service account 拿 token（client_credentials），scope 限定能调的接口；高危操作（修改数据）要 user-in-loop（用户显式授权一次）。所有 Agent 调用进审计日志，关联 traceId + tool_call_id。

2. **用 LLM 自动生成 OPA 策略？**
   LLM 读业务规则（如"manager 只能审批 1 万以下的支付"）→ 生成 Rego 策略草案。需要人工 review 业务语义。LLM 擅长结构化翻译，不擅长捕捉隐性规则。

3. **零信任 + RAG，AI 怎么访问用户私有数据？**
   AI 服务用 OAuth2 token exchange（RFC 8693）拿用户降级 token，scope 限定 read:user_data。AI 调数据 API 时带 token，数据 API 验签后按 user_id 过滤返回。AI 不能跨用户读数据。

4. **用 LLM 检测异常授权模式？**
   LLM 读 OPA 决策日志（allow/deny + user + resource），识别异常模式（如某用户突然开始访问大量敏感资源、非工作时间访问），触发风控（强制重新 MFA 或临时吊销）。

5. **AI 在零信任里的新角色？**
   "持续验证"用 AI 增强——传统零信任是"每次请求验一次"，AI 能做"持续行为分析"（用户/服务的访问模式偏离基线时自动降权）。这就是自适应零信任（Adaptive Zero Trust）。

## 八、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"三道关、mTLS 服务互信、OPA 策略授权、默认拒绝"**。

- **三道关**：Identity + Device + Policy
- **mTLS**：服务间双向认证，内部 CA 签发，SPIFFE ID 标识服务身份
- **每请求 JWT**：scope + audience + expiration
- **OPA/Cedar**：ABAC 策略引擎，按 user+resource+context 授权
- **最小权限**：默认拒绝 + 按需授权 + 定期审计回收

### 拟人化理解

把零信任想成**机场安检**。传统城堡模型是"进了大门就畅通"，零信任是"每个登机口都重新验票"。Identity 是机票（JWT 证明你是谁），Device 是身份证（mTLS 证明你的飞机注册过），Policy 是登机牌（OPA 判定你能上这个航班）。默认拒绝是"不在登机名单上的不让上"，最小权限是"经济舱的不能进商务舱休息室"。

### 面试现场 60 秒回答

> 零信任的核心是"Never trust, always verify"——放弃"内网默认可信"假设。我们落地三道关：(1) 服务间 mTLS（Istio 自动签发证书，SPIFFE ID 标识服务身份），(2) 每个请求带 OAuth2 JWT，业务系统验签拿用户身份和 scope，(3) 授权走 OPA 策略引擎，按 user + resource + context 三元组判定，默认拒绝。最小权限靠两条：策略默认 deny all（所有 allow 必须显式）+ 周期审计回收 6 个月未用的 scope。落地分四阶段：资产清点 → OIDC SSO → mTLS mesh → OPA 接入。最大坑是性能（mTLS 握手开销），用 TLS 1.3 + session resumption + 长连接复用降到纳秒级。渐进式落地从敏感服务（支付/用户数据）开始，不一次重构。

### 反问面试官

> 贵司有 Service Mesh 基础吗？mTLS 全 mesh 还是部分？OPA 还是自研策略引擎？落地节奏怎么样，先从哪类服务切？

## 九、苏格拉底式面试追问（7 层表格 + 现场对话）

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么传统 IP 白名单不够？ | 用钓鱼攻击场景说话：员工被钓鱼笔记本成内网跳板，IP 白名单看 IP 对就放行，攻击者横向移动畅通；零信任每跳重新验身份，爆炸半径收敛 |
| 证据追问 | 怎么证明零信任有效？ | 模拟钓鱼演练：拿被钓鱼员工凭证尝试横向访问核心系统，应被拒绝；MTTD（攻击检测时间）应从天级降到分钟级；事故爆炸半径（受影响服务数）应 < 3 |
| 边界追问 | 零信任能完全防住吗？ | 不能。零信任收敛爆炸半径，不能阻止"凭证泄露 + 政策允许范围内的操作"。所以还要配合 UEBA（用户行为分析）、动态降权、审计告警 |
| 反例追问 | 什么场景不上零信任？ | 创业初期服务少（< 10 个）、纯外部 API（用 API Key 更简单）、低风险内部工具（轻量 OAuth2 即可，不做 mTLS） |
| 风险追问 | 零信任最大风险？ | 主动点出：复杂度上升导致运维出错（一条策略配错全挂）；性能开销（mTLS 握手）；Mesh 故障（Istio 控制面挂了所有 mTLS 失败） |
| 验证追问 | 怎么验证 mTLS 真的生效？ | 抓包看 TLS 握手是否双向证书；用未授权服务尝试调用应被拒绝（403）；定期跑"零信任合规扫描"（每个服务是否强制 mTLS、是否在 OPA 后面） |
| 沉淀追问 | 团队零信任治理沉淀什么？ | Mesh 部署 SOP、OPA 策略库（公共规则集）、证书轮转流程、策略审计 dashboards、零信任接入 checklist |

### 现场对话示例

**面试官**：mTLS 证书怎么管理？总不能手动签发吧？

**候选人**：自动化是必须的。Istio 控制面（istiod）内置 CA，自动给每个 pod 签发证书，默认 24 小时轮转一次。pod 启动时通过 SDS（Secret Discovery Service）从 istiod 拉证书，证书轮转也是 SDS 自动推。这样开发者完全不感知证书存在。如果不用 Istio，用 SPIFFE/SPIRE 做服务身份，Vault 做密钥管理，配合 cron job 自动轮转。证书短生命周期（24h）的好处是：即使私钥泄露，24 小时后自动失效。

**面试官**：OPA 策略维护会不会爆炸？

**候选人**：会，这是零信任落地的最大痛点。治理上：(1) 策略代码化，进 Git，PR 评审；(2) 策略分层——通用规则（所有服务共用）+ 业务规则（业务团队自己写）；(3) 策略测试——每个策略配 unit test，CI 强制；(4) 策略 dry-run——新策略先 dry-run 模式跑（只记录决策不拦截），观察一段时间再切 enforce。京东有 100+ 通用策略 + 1000+ 业务策略，分层管理才能持续运维。

**面试官**：mTLS 性能开销多大？值得吗？

**候选人**：性能开销主要在握手——首次 RTT 比 TCP 多 1-2 个 RTT（TLS 1.3 优化到 1 个）。但 mTLS 长连接复用 + session resumption 能让后续请求零握手开销。我们测过：Istio mTLS 全 mesh 开启后，业务 P99 延迟增加约 0.5-1ms（主要是代理层），可接受。值得不值得看场景——金融、医疗等高敏感场景 1ms 完全可换安全；普通内部工具不一定值。所以落地要分优先级，先敏感服务。

## 常见考点

1. **mTLS 和 TLS 区别？**——TLS 只验服务端证书（客户端匿名）；mTLS 双方互验证书（服务端 + 客户端都签发证书）。
2. **零信任必须用 Service Mesh 吗？**——不是必须，但 Mesh 大幅简化 mTLS 落地（自动签发、轮转、策略）。不用 Mesh 要在应用层手动集成证书管理（如 Spring Boot + cfssl）。
3. **SPIFFE 是什么？**——Service Identity 框架，定义服务身份格式（SPIFFE ID）和证书规范（SPIFFE SVID）。SPIRE 是 SPIFFE 的开源实现。
4. **OPA 在请求路径上有性能影响吗？**——in-process 模式（OPA 作为 Java 库嵌入）决策 < 1ms；HTTP 模式（独立 OPA 服务）有网络开销（约 5ms）。生产推荐 in-process。
5. **BeyondCorp 是什么？**——Google 的零信任实现，业界最早大规模落地的零信任架构。核心思想：从"VPN + 内网"转向"每次访问基于身份 + 设备 + 上下文决策"。

## 结构化回答

**30 秒电梯演讲：** 零信任的核心是Never trust, always verify——不再有内网默认可信假设。每个请求（无论来自内网还是外网）都要经过身份认证、设备验证、策略授权三道关。Java 后端落地三个抓手：(1) 服务间 mTLS 双向证书认证（替代 IP 白名单）；(2) 每个请求带 JWT/OAuth2 token，业务系统按 token + 上下文做策略授权（OPA/Cedar）；(3) 最小权限——默认拒绝，按需授权，定期回收

**展开框架：**
1. **三道关** — 身份（Identity）+ 设备（Device）+ 上下文（Context/Policy）
2. **服务间认证** — mTLS（双向 TLS，证书由内部 CA 签发）
3. **用户认证** — OAuth2/OIDC token，每次请求验签

**收尾：** 以上是我的整体思路。您想继续深入聊——mTLS 证书怎么签发和轮转？


## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：零信任架构在 Java 后端中的落地 | "这题一句话：零信任的核心是Never trust, always verify——不再有内网默认可信假设。" | 开场钩子 |
| 0:15 | 传统安全像城堡护城河——外敌进不来类比图 | "打个比方：传统安全像城堡护城河——外敌进不来。" | 核心类比 |
| 0:40 | 三道关示意/对比图 | "身份（Identity）+ 设备（Device）+ 上下文（Context/Policy）" | 三道关要点 |
| 1:05 | 服务间认证示意/对比图 | "mTLS（双向 TLS，证书由内部 CA 签发）" | 服务间认证要点 |
| 1:55 | 总结卡 | "记住：三道关。下期见。" | 收尾 |
