---
id: java-architect-131
difficulty: L2
category: java-architect
subcategory: 安全架构
tags:
- Java 架构师
- OAuth2.1
- OIDC
- SSO
feynman:
  essence: OAuth2.1 是 OAuth2.0 的"整理 + 安全补丁"——强制 PKCE、废弃 implicit/password grant、明确 scope 规范。OIDC（OpenID Connect）是 OAuth2.0 的认证扩展层——OAuth2 解决"授权"（access token 能调什么 API），OIDC 解决"认证"（id token 证明用户是谁）。企业 SSO 用 OIDC 把多个内部系统统一到身份提供商（IdP），用户一次登录拿到 id token，所有系统都信任，不再各自维护账号。
  analogy: 像酒店房卡 + 身份证。OAuth2 是房卡授权（房卡只能进房间，不能进别人房间，scope 限定）；OIDC 是酒店前台发的身份证验证（id token 证明你是张三，所有酒店设施都信任）。SSO 是连锁酒店集团——你在北京分店办了会员（一次登录），上海/广州分店都认（多系统信任）。
  first_principle: 为什么企业需要 SSO？因为员工每天用 10+ 内部系统（HR、OA、工单、监控、CI/CD），每个系统独立账号要记 10 套密码、改密码影响 10 个系统、离职要注销 10 个账号。SSO 把"身份"集中到 IdP，业务系统只信任 IdP 发的 token，离职时 IdP 一关全断。
  key_points:
  - OAuth2.1 强制 PKCE、废弃 implicit 和 password grant、明确 redirect_uri 严格匹配
  - OIDC 三种 flow：Authorization Code（最常用）、Implicit（废弃）、Hybrid（特殊场景）
  - OIDC 三种 token：access_token（调 API）、id_token（认证用户）、refresh_token（续期）
  - id_token 是 JWT，含 sub（用户 ID）、iss（签发方）、aud（受众）、exp（过期）、nonce（防重放）
  - SSO 单点登出（Single Logout）：IdP 登出，所有业务系统通过 back-channel 或 front-channel 同步登出
first_principle:
  problem: 企业有 N 个内部系统，如何让员工一次登录访问所有系统，且离职时统一注销？
  axioms:
  - 每个系统独立账号的密码管理、安全审计、离职注销成本随系统数线性增长
  - 业务系统不应该维护"我是谁"，应该信任专业 IdP
  - 集中化身份管理 = 集中化安全风险（IdP 挂了所有系统登录不了），需要 IdP 高可用
  rebuild: 部署企业 IdP（如 Keycloak、Spring Authorization Server），所有业务系统配置为 IdP 的 OIDC client。员工访问业务系统 → 没 session 跳 IdP 登录 → 登录后 IdP 发 id_token + access_token 回业务系统 → 业务系统验签 id_token 拿到用户身份。第二次访问其他业务系统，IdP 已有 session 直接重定向回带 token，无需再登录。登出时 IdP 通过 back-channel 通知所有业务系统清理 session。
follow_up:
  - access_token 和 id_token 区别？——access_token 是授权令牌（调 API 用，opaque 或 JWT），id_token 是认证令牌（含用户身份信息，JWT 格式），OIDC 才有 id_token。
  - PKCE 在 OAuth2.1 强制吗？——是的。OAuth2.1 所有 client（包括 confidential client）都强制 PKCE，因为 client_secret 在移动端无法安全存储。
  - id_token 的 nonce 怎么用？——客户端发起授权时生成 nonce 存 session，id_token 里带回同 nonce，客户端校验匹配防重放。
  - SLO 怎么保证所有系统都登出？——back-channel logout：IdP 调用每个业务系统的 logout endpoint（带 logout_token）；front-channel logout：IdP 用 iframe 触发每个业务系统登出。back-channel 更可靠。
  - Spring Authorization Server 和 Keycloak 选哪个？——Keycloak 功能完整（开箱即用 UI、用户管理、social login）；Spring Authorization Server 是框架（需要自己写 UI、用户管理），灵活但工作量大。生产用 Keycloak 居多。
memory_points:
  - OAuth2.1：强制 PKCE、废弃 implicit/password、redirect_uri 严格匹配
  - OIDC：OAuth2 + id_token，解决认证问题
  - 三 token：access_token（授权）+ id_token（认证）+ refresh_token（续期）
  - SSO：IdP 集中身份，业务系统信任 id_token
  - SLO：back-channel logout 比 front-channel 可靠
---

# 【Java 后端架构师】OAuth2.1、OIDC 与企业 SSO 集成

> 适用场景：JD 核心技术。京东内部有 500+ 业务系统（HR、OA、工单、监控、CI/CD、运维平台...），员工每天要访问 10+ 系统。SSO 前每系统独立账号密码，离职注销漏一个就是安全漏洞。引入 OIDC SSO 后，所有业务系统接入 IdP（Keycloak），员工一次登录全通行，离职 IdP 一关全断。

## 一、概念层

**OAuth2.0 vs OAuth2.1 vs OIDC 关系**（必背）：

| 协议 | 解决问题 | 关键点 |
|------|---------|--------|
| OAuth2.0 | 授权（让第三方应用拿 token 调 API） | 四种 grant，PKCE 可选，implicit 允许 |
| OAuth2.1 | OAuth2.0 的安全补丁 + 整理 | 强制 PKCE、废弃 implicit/password、redirect_uri 严格匹配、明确 bearer token 安全要求 |
| OIDC | 认证（基于 OAuth2.0 扩展） | 加 id_token、userinfo endpoint、standard scopes（openid/profile/email） |

**OAuth2.1 关键变化**（必背）：

| 变化 | OAuth2.0 | OAuth2.1 |
|------|----------|----------|
| PKCE | 推荐但可选（移动端建议） | **强制**所有 client |
| Implicit grant | 允许 | **废弃**（用 PKCE + Authorization Code 替代） |
| Password grant | 允许（信任的客户端） | **废弃**（用设备码或 PKCE 替代） |
| redirect_uri | 通配匹配 | **严格全字符串匹配** |
| bearer token | 未明确存储 | **明确禁止 localStorage** |

## 二、机制层：OIDC Authorization Code Flow

**完整 OIDC 授权码流程**（必画）：

```
┌── 用户 ──┐                                          ┌── IdP（Keycloak）──┐
│         │                                          │                    │
│  访问   │  1. 跳转 IdP                              │                    │
│  业务   │     https://idp.jd.com/auth?              │                    │
│  系统   │       response_type=code&                 │                    │
│         │       client_id=hr-system&                │                    │
│         │       redirect_uri=https://hr.jd.com/cb&  │                    │
│         │       scope=openid profile email&         │                    │
│         │       state=xyz&                          │                    │
│         │       nonce=abc&                          │                    │
│         │       code_challenge=SHA256(verifier)&    │ ◄── PKCE          │
│         │       code_challenge_method=S256          │                    │
│         │ ───────────────────────────────────────► │                    │
│         │                                          │  2. 检查 IdP session│
│         │                                          │     没 session 显示 │
│         │                                          │     登录页          │
│         │                                          │                    │
│         │  3. 用户输入账号密码 + MFA                 │                    │
│         │ ───────────────────────────────────────► │                    │
│         │                                          │  4. 验证账号 + MFA  │
│         │                                          │     生成 code      │
│         │  5. 重定向回业务系统                       │     存 session     │
│         │     https://hr.jd.com/cb?                 │                    │
│         │       code=AUTH_CODE&                     │                    │
│         │       state=xyz                           │                    │
│         │ ◄─────────────────────────────────────── │                    │
│         │                                          │                    │
│  业务   │  6. 业务系统后端用 code 换 token           │                    │
│  后端   │     POST /token                           │                    │
│         │       grant_type=authorization_code       │                    │
│         │       code=AUTH_CODE                      │                    │
│         │       redirect_uri=...                    │                    │
│         │       client_id=hr-system                 │                    │
│         │       code_verifier=verifier              │ ◄── PKCE verify   │
│         │ ───────────────────────────────────────► │                    │
│         │                                          │  7. 验证 code、PKCE│
│         │                                          │     签发 token     │
│         │  8. 返回                                  │                    │
│         │     access_token (JWT)                   │                    │
│         │     id_token (JWT) ← OIDC 核心            │                    │
│         │     refresh_token                        │                    │
│         │     expires_in=900                        │                    │
│         │ ◄─────────────────────────────────────── │                    │
└─────────┘                                          └────────────────────┘
```

**id_token JWT 结构**（OIDC 核心）：

```json
{
  "iss": "https://idp.jd.com",          // 签发方
  "sub": "user-12345",                  // 用户唯一 ID
  "aud": ["hr-system"],                 // 受众（业务系统 client_id）
  "exp": 1700000900,                    // 过期时间
  "iat": 1700000000,                    // 签发时间
  "nonce": "abc",                       // 防重放（必须匹配步骤 1）
  "auth_time": 1700000050,              // 用户认证时间（用于强制重新认证判断）
  "acr": "urn:mace:incommon:iap:silver",// 认证上下文（MFA 级别）
  "amr": ["pwd", "otp"],                // 认证方式（密码 + OTP）
  "email": "zhangsan@jd.com",
  "name": "张三",
  "department": "技术部",
  "roles": ["developer", "oncall"]
}
```

## 三、机制层：Spring Authorization Server 配置

**Spring Authorization Server（OAuth2.1 兼容）配置**：

```java
@Configuration
@EnableWebSecurity
public class SecurityConfig {

    @Bean
    @Order(1)
    public SecurityFilterChain authorizationServerChain(HttpSecurity http) throws Exception {
        OAuth2AuthorizationServerConfiguration.applyDefaultSecurity(http);
        http.getConfigurer(OAuth2AuthorizationServerConfigurer.class)
            .oidc(Customizer.withDefaults());  // 启用 OIDC
        http.exceptionHandling(e -> e.defaultAuthenticationEntryPointFor(
            new LoginUrlEntryPoint("/login"),
            new MediaTypeRequestMatcher(MediaType.TEXT_HTML)
        ));
        return http.build();
    }

    @Bean
    @Order(2)
    public SecurityFilterChain appSecurity(HttpSecurity http) throws Exception {
        http
            .authorizeHttpRequests(auth -> auth
                .requestMatchers("/hr/**").authenticated()
                .anyRequest().permitAll()
            )
            .oauth2Login(Customizer.withDefaults())     // 启用 OAuth2/OIDC 登录
            .oauth2Client(Customizer.withDefaults())
            .logout(logout -> logout
                .logoutSuccessHandler(oidcLogoutSuccessHandler())
            );
        return http.build();
    }

    @Bean
    public RegisteredClientRepository registeredClientRepository() {
        return new InMemoryRegisteredClientRepository(
            RegisteredClient.withId(UUID.randomUUID().toString())
                .clientId("hr-system")
                .clientAuthenticationMethod(ClientAuthenticationMethod.CLIENT_SECRET_BASIC)
                .authorizationGrantType(AuthorizationGrantType.AUTHORIZATION_CODE)
                .authorizationGrantType(AuthorizationGrantType.REFRESH_TOKEN)
                .redirectUri("https://hr.jd.com/login/oauth2/code/hr-system")  // OAuth2.1 严格匹配
                .postLogoutRedirectUri("https://hr.jd.com")
                .scope(OidcScopes.OPENID)
                .scope(OidcScopes.PROFILE)
                .scope(OidcScopes.EMAIL)
                .scope("hr.read")
                .scope("hr.write")
                .clientSettings(ClientSettings.builder()
                    .requireAuthorizationConsent(true)         // 显示授权同意页
                    .requireProofKey(true)                      // OAuth2.1 强制 PKCE
                    .setting("settings.client.jwk", ...)
                    .build())
                .tokenSettings(TokenSettings.builder()
                    .accessTokenTimeToLive(Duration.ofMinutes(15))
                    .refreshTokenTimeToLive(Duration.ofDays(7))
                    .idTokenSignatureAlgorithm(SignatureAlgorithm.RS256)
                    .reuseRefreshTokens(false)                  // 每次刷新签发新 refresh token
                    .build())
                .build()
        );
    }

    @Bean
    public JWKSource<SecurityContext> jwkSource() {
        RSAKey rsaKey = generateRsa();
        JWKSet jwkSet = new JWKSet(rsaKey);
        return (selector, ctx) -> selector.select(jwkSet);
    }

    private static RSAKey generateRsa() {
        try {
            KeyPairGenerator gen = KeyPairGenerator.getInstance("RSA");
            gen.initialize(2048);
            KeyPair pair = gen.generateKeyPair();
            return new RSAKey.Builder(JWK.parse(pair.getPublic()))
                .privateKey(pair.getPrivate())
                .keyID(UUID.randomUUID().toString())
                .build();
        } catch (Exception e) { throw new RuntimeException(e); }
    }

    @Bean
    public OAuth2TokenCustomizer<JwtEncodingContext> tokenCustomizer() {
        return context -> {
            if (context.getTokenType().equals(OAuth2TokenType.ACCESS_TOKEN)
                && context.getAuthorizationGrantType().equals(
                    AuthorizationGrantType.AUTHORIZATION_CODE)) {
                // 自定义 claim
                context.getClaims().claim("department", "技术部");
            }
            if (OidcParameterNames.ID_TOKEN.equals(context.getTokenType().getValue())) {
                // id_token 自定义 claim
                context.getClaims().claim("roles", List.of("developer"));
            }
        };
    }
}
```

**业务系统接入 OIDC（OIDC Client）**：

```java
// 业务系统 application.yml
spring:
  security:
    oauth2:
      client:
        registration:
          jd-idp:
            provider: jd-idp
            client-id: hr-system
            client-secret: ${HR_CLIENT_SECRET}
            scope: openid, profile, email, hr.read
            redirect-uri: "{baseUrl}/login/oauth2/code/{registrationId}"
            client-authentication-method: client_secret_basic
            authorization-grant-type: authorization_code
        provider:
          jd-idp:
            issuer-uri: https://idp.jd.com
            user-name-attribute: sub

// 业务系统取用户信息
@GetMapping("/hr/profile")
public String profile(@AuthenticationPrincipal OidcUser user) {
    String name = user.getFullName();          // 从 id_token 取
    String email = user.getEmail();
    String dept = user.getClaim("department"); // 自定义 claim
    List<String> roles = user.getClaim("roles");
    return "...";
}
```

## 四、机制层：SSO 单点登出（SLO）

**Back-Channel Logout（推荐）**：

```
用户在 IdP 登出
   │
   ▼
IdP 给每个业务系统的 back-channel logout endpoint 发请求
   POST https://hr.jd.com/logout/backchannel
   Body: logout_token (JWT)
     {
       "iss": "https://idp.jd.com",
       "sub": "user-12345",
       "aud": "hr-system",
       "iat": 1700001000,
       "jti": "uuid",
       "events": {"http://schemas.openid.net/event/backchannel-logout": {}},
       "sub": "user-12345",
       "sid": "session-abc"   // session ID
     }
   │
   ▼
业务系统验 logout_token 签名 → 清理对应 session
```

**Spring 实现 back-channel logout**：

```java
@Bean
public OidcLogoutSuccessHandler oidcLogoutSuccessHandler() {
    OidcClientInitiatedLogoutSuccessHandler handler =
        new OidcClientInitiatedLogoutSuccessHandler(clientRegistrationRepository);
    handler.setPostLogoutRedirectUri("https://hr.jd.com");
    return handler;
}

// 接收 back-channel logout
@Controller
public class BackChannelLogoutController {

    @Autowired private SessionRegistry sessionRegistry;

    @PostMapping("/logout/backchannel")
    public ResponseEntity<Void> backChannelLogout(@RequestBody String logoutToken) {
        // 1. 验 JWT 签名
        Jwt jwt = jwtDecoder.decode(logoutToken);

        // 2. 验 events claim
        // 3. 验 sub 或 sid 存在
        // 4. 验 jti 防重放
        String sid = jwt.getClaim("sid");
        String sub = jwt.getClaim("sub");

        // 5. 清理 session
        sessionRegistry.removeSessionBySid(sid);
        return ResponseEntity.ok().build();
    }
}
```

## 五、实战层/选型：IdP 选型矩阵

| IdP | 优势 | 劣势 | 适用 |
|-----|------|------|------|
| **Keycloak** | 功能完整、UI 开箱即用、支持 SAML/OIDC/LDAP/social | Java 写、内存吃、集群配置复杂 | 中大型企业内部 SSO |
| **Spring Authorization Server** | Spring 生态、灵活、框架级 | 需要自己写 UI、用户管理 | Spring 技术栈定制需求 |
| **Auth0** | 托管、零运维、文档优秀 | 收费、数据出境合规 | SaaS、国际化业务 |
| **Okta** | 企业级、AD/LDAP 集成强 | 贵、配置繁琐 | 大企业、AD 集成 |
| **Casdoor/Casbin** | 国产、轻量 | 生态小 | 中小企业、国产化 |

**JD 实战选 Keycloak**：开箱即用、支持 LDAP 对接京东 AD、UI 定制方便、集群方案成熟（infinispan cache）。

## 六、底层本质：身份集中化的权衡

回到第一性：**SSO 的本质是"身份从分散到集中"，集中带来效率也带来单点风险**。

- **集中化的收益**：员工一次登录全通行、离职一键注销、安全策略集中下发（如强制 MFA）、审计日志集中。
- **集中化的风险**：IdP 挂了所有系统登录瘫痪。所以 IdP 必须高可用——多副本部署、跨机房容灾、监控告警。
- **OAuth2.1 强制 PKCE 的本质**：移动端和 SPA 无法安全存储 client_secret（反编译可读），PKCE 用动态 challenge 替代 secret 的作用，让无后端的客户端也能安全走授权码流程。OAuth2.1 把"安全实践"从"建议"升级为"强制"。
- **OIDC id_token 的本质**：access_token 是给机器消费的（调 API），id_token 是给业务系统消费的（解析用户身份）。OIDC 把"认证"从"授权"里拆出来，让业务系统不用自己实现身份验证逻辑——只验 id_token 签名即可。

**为什么 OIDC 而不是 SAML**：
- SAML 是 XML、复杂、企业老系统用
- OIDC 是 JSON、轻量、互联网新系统用
- 大型企业两者并存：内部新系统 OIDC，对接外部 SAML 系统（如对接政府/银行）

## 七、AI 架构师加问：5 个

1. **LLM Agent 调内部 API，怎么接 SSO？**
   Agent 用 client_credentials grant 拿 service-to-service token，不用用户 token。高危操作（如修改用户数据）要求 token 带用户授权上下文（user_assertion 或 token exchange）。

2. **用 LLM 检测异常登录怎么做？**
   LLM 读 IdP 登录日志（IP、设备、时间、地理位置、MFA 通过率），识别"不可能的旅行"（北京 9:00 + 纽约 9:30）、新设备、异常时段登录，触发风控（强制重新 MFA 或锁定账号）。

3. **LLM Agent 之间互相调用怎么认证？**
   Agent-to-Agent 用 OAuth2 token exchange（RFC 8693）：Agent A 拿自己的 token 换一个代表"Agent A 调用 Agent B"的降级 token，scope 限定。比直接传 token 安全（最小权限）。

4. **OIDC 在 LLM/RAG 场景的新角色？**
   RAG 访问用户私有数据时，AI 服务用 OIDC 拿用户 id_token + access_token，调数据 API 时带 token，数据 API 验签后按 user_id 过滤返回数据。OIDC 是"AI 访问用户数据的授权层"。

5. **IdP 怎么用 LLM 辅助权限管理？**
   LLM 读用户角色 + 申请资源 → 推荐最小权限 scope；读访问日志 → 识别"过度授权"（用户有 scope 但 6 个月没用）→ 建议回收。让权限管理从静态分配变成动态审计。

## 八、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"OAuth2.1 强制 PKCE、OIDC 三 token、SSO 集中身份、SLO back-channel"**。

- **OAuth2.1**：强制 PKCE、废弃 implicit/password、redirect_uri 严格匹配
- **OIDC 三 token**：access_token（授权）+ id_token（认证）+ refresh_token（续期）
- **SSO**：IdP 集中身份，业务系统信任 id_token，一次登录全通行
- **SLO**：back-channel logout（IdP 主动通知业务系统清 session）
- **选型**：Keycloak（功能完整）、Spring AS（灵活）、Auth0（托管）

### 拟人化理解

把 SSO 想成**酒店集团会员**。OAuth2.1 是入会规则（必须 PKCE 验证、不再发临时会员卡）；OIDC 是会员证（id_token 证明你是张三，所有设施都认）；SSO 是"北京办会员，全国通用"——你在 IdP（北京分店）登录一次，所有业务系统（上海/广州分店）都信任你的会员身份，不用重复办。SLO 是"集团黑名单"——你在 IdP 一注销，全国分店立刻不认你。

### 面试现场 60 秒回答

> OAuth2.1 是 OAuth2.0 的安全补丁——强制 PKCE、废弃 implicit 和 password grant、redirect_uri 严格全字符串匹配。OIDC 是 OAuth2 的认证扩展层，加了 id_token（JWT 含用户身份信息）。我们用 Keycloak 做 IdP，500+ 业务系统接入为 OIDC client。员工访问业务系统，没 session 跳 IdP 登录 + MFA，IdP 发 id_token + access_token + refresh_token，业务系统验签 id_token 拿到用户身份（sub、roles、department）。第二次访问其他系统，IdP 已有 session 直接重定向回带 token，无需再登录。登出走 back-channel logout，IdP 调用每个业务系统的 logout endpoint 通知清理 session，保证单点登出可靠。id_token 用 RS256 签名，业务系统用公钥验签，不需要每次调 IdP 校验。

### 反问面试官

> 贵司 IdP 用 Keycloak 还是自研？SSO 接入了多少系统？MFA 强制还是可选？有没有遇到过 IdP 故障导致全公司登录瘫痪？

## 九、苏格拉底式面试追问（7 层表格 + 现场对话）

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不上 SSO？ | 用离职注销漏账号的安全事故说话：500 系统独立账号，离职注销漏一个就是后门；密码策略无法统一（有的系统弱密码）；员工每天记 10 套密码效率低 |
| 证据追问 | 怎么证明 SSO 有效？ | 平均登录次数（从 10+ 降到 1）、离职注销完整率（100%）、MFA 覆盖率（100%）、账号盗用事故数（应 0） |
| 边界追问 | SSO 能解决什么，解决不了什么？ | 解决：单点登录、统一注销、集中权限。解决不了：业务系统的细粒度授权（如"用户 A 能看哪些订单"），这要业务系统自己做 RBAC |
| 反例追问 | 什么场景不适合 SSO？ | 离线系统（无法跳 IdP）、超低延迟（跳转有几百 ms 开销）、对外开发者 API（用 API Key 更方便） |
| 风险追问 | SSO 上线最大风险？ | 主动点出：IdP 单点故障（必须多副本 + 跨机房）、id_token 签名密钥泄露（必须 HSM/KMS 管理 + 定期轮转）、PKCE 实现错误导致安全漏洞 |
| 验证追问 | 怎么验证 SLO 可靠？ | 渗透测试：在 IdP 登出后立即用业务系统 cookie 访问，应被拒绝；back-channel logout 失败时业务系统的兜底（定期调 IdP 校验 session） |
| 沉淀追问 | 团队 SSO 治理沉淀什么？ | IdP 部署 SOP、业务系统接入文档、OIDC client 配置模板、密钥轮转流程、SLO 测试脚本、IdP 监控大盘（登录成功率/MFA 通过率/响应延迟） |

### 现场对话示例

**面试官**：OAuth2.1 强制 PKCE，那 confidential client 还需要 client_secret 吗？

**候选人**：需要，两者不互斥。client_secret 是"客户端身份认证"（证明客户端是 hr-system），PKCE 是"授权码防拦截"（证明这次授权码是这个客户端发起的）。confidential client（有后端）两者都用——后端用 secret 认证 + PKCE 防授权码被中间人截获。public client（移动端/SPA）只用 PKCE（无 secret 因为存储不安全）。OAuth2.1 强制 PKCE 的原因是"防御纵深"——即使 secret 泄露，攻击者拿不到 code_verifier 也换不了 token。

**面试官**：id_token 和 access_token 都用 JWT，区别在哪？

**候选人**：虽然都是 JWT，定位不同。id_token 是给业务系统消费的（解析用户身份），claim 包含 sub/email/name/roles，audience 是业务系统 client_id。access_token 是给资源 API 消费的（鉴权），claim 包含 scope/client_id，audience 是资源服务。区别：(1) 内容不同——id_token 含 PII，access_token 含 scope；(2) 受众不同——id_token 给业务系统，access_token 给 API；(3) 用途不同——id_token 用于建立 session，access_token 用于调 API。实践中 access_token 可以用 opaque（不透明字符串，每次校验调 IdP introspection endpoint），但 id_token 必须是 JWT（业务系统要解析内容）。

**面试官**：SSO 单点登出怎么保证所有系统都登出？

**候选人**：两种机制。Front-channel logout——IdP 登出后，用 iframe 加载每个业务系统的 logout URL，浏览器 side 触发业务系统登出。缺点是依赖浏览器，用户关 tab 就失效。Back-channel logout——IdP 服务器端直接调业务系统的 back-channel logout endpoint，传 logout_token（JWT 含 sid 和 sub），业务系统验签后清 session。这是 server-to-server 通信，可靠。生产推荐 back-channel，配合 front-channel 兜底。还有最严格的：业务系统每次请求都查 IdP session 状态（cache 短期 1 分钟），这样即使 back-channel 失败也能在 1 分钟内感知登出。

## 常见考点

1. **OAuth2.1 废弃了什么 grant？**——implicit grant（用 PKCE 替代）、password grant（用 device code 或 PKCE 替代）、弱化的 redirect_uri 通配匹配（强制全字符串匹配）。
2. **OIDC 的 nonce 怎么防重放？**——客户端发起授权时生成 nonce 存 session，IdP 把 nonce 放入 id_token 返回，客户端校验 id_token 的 nonce 与 session 中一致才信任。
3. **scope=openid 是 OIDC 标志？**——是的。OIDC client 必须请求 openid scope，IdP 才会发 id_token。其他 scope（profile/email）控制 id_token 里包含哪些 claim。
4. **refresh_token 续期怎么处理 SSO？**——access_token 过期用 refresh_token 续，不需要用户重新登录（保持 SSO）。但 refresh_token 也有过期时间（如 7 天），过期后用户要重新登录。
5. **IdP 高可用怎么部署？**——多副本部署（K8s 多 pod）+ 共享存储（数据库 + infinispan/redis cache session）+ 负载均衡 + 跨机房容灾。session 不能存本地（粘性会限制水平扩展）。

## 结构化回答

**30 秒电梯演讲：** OAuth2.1 是 OAuth2.0 的整理 + 安全补丁——强制 PKCE、废弃 implicit/password grant、明确 scope 规范。OIDC（OpenID Connect）是 OAuth2.0 的认证扩展层——OAuth2 解决授权（access token 能调什么 API），OIDC 解决认证（id token 证明用户是谁）。企业 SSO 用 OIDC 把多个内部系统统一到身份提供商（IdP），用户一次登录拿到 id token，所有系统都信任，不再各自维护账号

**展开框架：**
1. **OAuth2.1 强制** — OAuth2.1 强制 PKCE、废弃 implicit 和 password grant、明确 redirect_uri 严格匹配
2. **OIDC 三种 flow** — Authorization Code（最常用）、Implicit（废弃）、Hybrid（特殊场景）
3. **OIDC 三种 token** — access_token（调 API）、id_token（认证用户）、refresh_token（续期）

**收尾：** 以上是我的整体思路。您想继续深入聊——access_token 和 id_token 区别？


## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：OAuth2.1、OIDC 与企业 SSO 集成 | "这题核心是——OAuth2.1 是 OAuth2.0 的整理 + 安全补丁——强制 PKCE、废弃 impli……" | 开场钩子 |
| 0:15 | OAuth2.1 强制示意/对比图 | "OAuth2.1 强制 PKCE、废弃 implicit 和 password grant、明确 redirect_uri 严格匹配" | OAuth2.1 强制要点 |
| 0:40 | OIDC 三种 flow示意/对比图 | "Authorization Code（最常用）、Implicit（废弃）、Hybrid（特殊场景）" | OIDC 三种 flow要点 |
| 1:25 | 总结卡 | "记住：OAuth2.1。下期见。" | 收尾 |
