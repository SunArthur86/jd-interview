---
id: java-architect-052
difficulty: L2
category: java-architect
subcategory: 网关设计
tags:
- Java 架构师
- OAuth2
- JWT
- 认证
feynman:
  essence: OAuth2 是"授权协议"（让第三方应用拿用户授权的令牌访问资源），JWT 是"令牌格式"（自包含的 JSON 签名 token）。两者常混用但定位不同：OAuth2 定义了授权码、密码、客户端凭证四种 Grant Type，JWT 是 Access Token 的一种编码格式。会话治理的核心是"令牌生命周期管理"——签发、刷新、撤销、续期，既保证安全（令牌泄露可撤销）又保证体验（用户无感续期）。
  analogy: OAuth2 是酒店房卡的"授权流程"——你（资源所有者）授权前台（认证服务器）给朋友（第三方应用）一张房卡（Access Token），朋友只能进你授权的房间（scope），不能进其他房间。JWT 是房卡本身的"编码方式"——卡上刻着你的名字、房间号、有效期，刷卡时门锁自己验签名（不用查前台）。会话治理是"房卡管理"——丢了要挂失（撤销），快过期了要续（刷新）。
  first_principle: 为什么 OAuth2 不直接给用户名密码？因为第三方应用拿到密码就能冒充用户做任何事（全权限），且密码泄露后改密码影响所有应用。OAuth2 用"令牌"替代密码——令牌有 scope（限定权限）、有有效期（降低泄露风险）、可撤销（随时吊销）。这是"最小权限 + 可控风险"的设计。
  key_points:
  - OAuth2 四种 Grant Type：授权码（最安全，Web 应用）、密码（信任的客户端）、客户端凭证（服务间）、隐式（已废弃，用 PKCE 替代）
  - JWT 三段：Header（算法）.Payload（声明）.Signature（签名）
  - JWT 无状态：服务端不存储，靠签名验证；缺点是无法主动撤销（除非黑名单）
  - 会话治理：Access Token 短期（15 分钟）+ Refresh Token 长期（7 天），刷新时滚动续期
  - PKCE 解决授权码拦截：动态 challenge-verify，移动端/SPA 必用
first_principle:
  problem: 第三方应用需要访问用户资源，如何不给用户名密码、限定权限范围、可随时撤销？
  axioms:
  - 用户名密码是"全权限凭证"，泄露后危害大且改密码影响所有应用
  - 第三方应用的可信度不同（官方应用 vs 不知名小应用），需要分级授权
  - 令牌需要有生命周期（短期降低泄露风险）+ 可撤销（泄露后吊销）
  rebuild: OAuth2 用授权码流程——用户在认证服务器登录并授权，认证服务器给第三方应用一个短时 Access Token（带 scope 限定权限）。Access Token 用 JWT 编码（无状态，服务端验签名）。Access Token 短期（15 分钟）配合 Refresh Token（7 天）——Access Token 过期用 Refresh Token 换新的，用户无感续期。泄露时撤销 Refresh Token，Access Token 自然过期失效。
follow_up:
  - JWT 怎么主动撤销？——维护黑名单（Redis 存被撤销的 token jti），每次验 token 先查黑名单。代价是失去"无状态"优势（要查 Redis）。折中：只对"主动登出"的 token 加黑名单，其他靠自然过期。
  - Refresh Token 存哪里？——HttpOnly + Secure Cookie（防 XSS 偷取）或服务端 Session（更安全）。不能存 localStorage（XSS 可读）。
  - 授权码流程为什么安全？——授权码通过前端重定向传递（URL 参数），即使被拦截，还需要 client_secret 换 token（拦截者没有 secret）。PKCE 补充了"无 secret 场景"（移动端）的安全性。
  - JWT 签名用什么算法？——HS256（对称，简单但密钥管理难）或 RS256（非对称，公钥验签，适合微服务）。RS256 更安全——签发用私钥（认证中心独有），验签用公钥（所有服务可持有）。
  - Token 泄露怎么检测？——异常 IP/设备使用同一 token、token 在多地同时使用（不可能的旅行）、高频刷新 token。风控层识别。
memory_points:
  - OAuth2 = 授权协议，JWT = 令牌格式
  - 四种 Grant：授权码（Web）、密码（可信）、客户端凭证（服务间）、PKCE（移动端）
  - JWT 三段：Header.Payload.Signature，无状态验签
  - Access Token 15min + Refresh Token 7d，滚动续期
  - JWT 撤销靠黑名单（Redis），PKCE 防授权码拦截
---

# 【Java 后端架构师】OAuth2、JWT 与会话治理

> 适用场景：JD 核心技术。京东开放平台让第三方 ISV 接入，ISV 需要代商家操作订单（读订单/发货）。不能给 ISV 商家的密码（安全风险），用 OAuth2 授权码流程——商家授权 ISV 一个限定 scope 的 Access Token，ISV 用 token 代操作。Token 泄露只影响授权范围，撤销即失效。

## 一、概念层：OAuth2 四种授权流程

**Grant Type 选型矩阵**（面试必考）：

| Grant Type | 适用场景 | 安全性 | 典型流程 |
|-----------|---------|--------|---------|
| **授权码（Authorization Code）** | Web 应用（有后端） | 最高 | 用户跳转登录→回调授权码→后端换 token |
| **PKCE** | 移动端/SPA（无后端） | 高 | 授权码+动态 challenge，无需 client_secret |
| **密码（Password）** | 官方第一方应用 | 中 | 用户直接给客户端密码（需高度信任） |
| **客户端凭证（Client Credentials）** | 服务间调用（M2M） | 中 | client_id+client_secret 直接换 token |
| ~~隐式（Implicit）~~ | 已废弃 | 低 | 不推荐，用 PKCE 替代 |

**授权码流程详解**（面试必画）：

```
用户 ──► ISV 应用（第三方）
              │
              │ 1. 跳转到认证中心
              ▼
         京东认证中心
              │
              │ 2. 用户登录 + 授权页面
              │    "ISV 应用申请：读取订单、发货"
              │
              │ 3. 用户同意授权
              │
              │ 4. 重定向回 ISV，带授权码 code
              │    https://isv.com/callback?code=AUTH_CODE
              ▼
ISV 后端 ──── 5. 用 code + client_secret 换 token ────►  认证中心
                                                            │
         ◄── 6. 返回 Access Token + Refresh Token ────────┘

ISV 后端 ──── 7. 带 Access Token 调京东 API ────►  京东 API
                                                    │
                                                    │ 验证 token 签名+scope
                                                    │
         ◄── 8. 返回订单数据 ──────────────────────
```

## 二、机制层：JWT 结构与验签

**JWT 三段结构**：

```
eyJhbGciOiJSUzI1NiJ9.    ← Header（算法 RS256）
eyJzdWIiOiIxMjM0NTY3O   ← Payload（声明 claims）
8IkpXVCJ9.e30.Xxxxxx     ← Signature（签名）

Header 解码:
{
  "alg": "RS256",      // 签名算法
  "typ": "JWT",
  "kid": "key-2024-1"  // 密钥 ID（多密钥轮换）
}

Payload 解码:
{
  "sub": "1234567890",        // 用户 ID
  "iss": "https://auth.jd.com",  // 签发方
  "aud": ["order-service"],   // 目标受众
  "scope": "read:order",      // 权限范围
  "iat": 1700000000,          // 签发时间
  "exp": 1700000900,          // 过期时间（15 分钟后）
  "jti": "uuid-xxx"           // 唯一 ID（撤销用）
}
```

**JWT 签发与验证代码**（RS256 非对称）：

```java
// 认证中心签发（私钥）
@Service
public class TokenService {

    @Value("${jwt.private-key}")
    private RSAPrivateKey privateKey;

    public String issueAccessToken(Long userId, List<String> scopes) {
        return Jwts.builder()
            .subject(userId.toString())
            .claim("scope", String.join(" ", scopes))
            .issuer("https://auth.jd.com")
            .issuedAt(new Date())
            .expiration(new Date(System.currentTimeMillis() + 15 * 60 * 1000))  // 15 分钟
            .id(UUID.randomUUID().toString())   // jti
            .signWith(privateKey, SignatureAlgorithm.RS256)
            .compact();
    }

    public String issueRefreshToken(Long userId) {
        return Jwts.builder()
            .subject(userId.toString())
            .claim("type", "refresh")
            .issuedAt(new Date())
            .expiration(new Date(System.currentTimeMillis() + 7 * 24 * 60 * 60 * 1000))  // 7 天
            .id(UUID.randomUUID().toString())
            .signWith(privateKey, SignatureAlgorithm.RS256)
            .compact();
    }
}

// 资源服务验签（公钥，所有微服务持有）
@Service
public class TokenValidator {

    @Value("${jwt.public-key}")
    private RSAPublicKey publicKey;

    @Autowired private RedisTemplate redis;

    public UserContext validate(String token) {
        try {
            Jws<Claims> jws = Jwts.parserBuilder()
                .setSigningKey(publicKey)
                .requireIssuer("https://auth.jd.com")
                .build()
                .parseClaimsJws(token);   // 验签名+验过期

            Claims claims = jws.getBody();

            // 检查黑名单（主动撤销的 token）
            String jti = claims.getId();
            if (Boolean.TRUE.equals(redis.hasKey("jwt:blacklist:" + jti))) {
                throw new TokenRevokedException("Token 已被撤销");
            }

            return new UserContext(
                Long.parseLong(claims.getSubject()),
                claims.get("scope", String.class)
            );
        } catch (ExpiredJwtException e) {
            throw new TokenExpiredException("Token 已过期");
        } catch (JwtException e) {
            throw new InvalidTokenException("Token 无效");
        }
    }
}
```

## 三、机制层：会话治理——刷新与撤销

**Access Token + Refresh Token 滚动续期**：

```java
@RestController
public class AuthController {

    @Autowired private TokenService tokenService;
    @Autowired private RefreshTokenRepo refreshTokenRepo;

    // 刷新 token
    @PostMapping("/oauth/token/refresh")
    public TokenResponse refresh(@RequestBody RefreshRequest req) {
        // 1. 验证 Refresh Token 签名
        Claims claims = tokenService.parseRefreshToken(req.getRefreshToken());

        // 2. 检查 Refresh Token 是否在服务端有效（未撤销）
        String storedJti = refreshTokenRepo.findJtiByUserId(claims.getSubject());
        if (!claims.getId().equals(storedJti)) {
            throw new TokenRevokedException("Refresh Token 已失效");
        }

        // 3. 签发新的 Access Token
        Long userId = Long.parseLong(claims.getSubject());
        List<String> scopes = scopeService.getUserScopes(userId);
        String newAccessToken = tokenService.issueAccessToken(userId, scopes);

        // 4. 滚动续期 Refresh Token（可选：每次刷新签发新 Refresh Token）
        String newRefreshToken = tokenService.issueRefreshToken(userId);
        refreshTokenRepo.save(userId, parseJti(newRefreshToken));   // 覆盖旧的

        return new TokenResponse(newAccessToken, newRefreshToken);
    }

    // 主动撤销（登出）
    @PostMapping("/oauth/logout")
    public void logout(@RequestHeader("Authorization") String authHeader) {
        String accessToken = authHeader.replace("Bearer ", "");

        // 1. Access Token 加入黑名单（直到自然过期）
        Claims claims = tokenService.parseAccessToken(accessToken);
        long ttl = claims.getExpiration().getTime() - System.currentTimeMillis();
        redis.opsForValue().set("jwt:blacklist:" + claims.getId(), "1",
            ttl, TimeUnit.MILLISECONDS);

        // 2. 删除服务端的 Refresh Token
        refreshTokenRepo.deleteByUserId(claims.getSubject());
    }
}
```

**前端无感续期**（拦截 401 自动刷新）：

```javascript
// 前端 Axios 拦截器
axios.interceptors.response.use(null, async (error) => {
    if (error.response?.status === 401 && !error.config._retry) {
        error.config._retry = true;
        // 用 Refresh Token 换新 Access Token
        const { accessToken } = await refreshTokenAPI(getRefreshToken());
        setAccessToken(accessToken);
        // 重放原请求
        error.config.headers.Authorization = `Bearer ${accessToken}`;
        return axios(error.config);
    }
    return Promise.reject(error);
});
// 用户无感：请求 401 → 自动刷新 → 重放成功，用户不察觉
```

## 四、机制层：PKCE 防授权码拦截

**PKCE 流程**（移动端/SPA 必用）：

```
1. 客户端生成 code_verifier（随机串）+ code_challenge（verifier 的 SHA256）
   code_verifier = "abc123random"
   code_challenge = SHA256(code_verifier) = "xyz789hash"

2. 跳转认证中心，带 code_challenge
   GET /authorize?code_challenge=xyz789hash&code_challenge_method=S256

3. 认证中心回调授权码
   callback?code=AUTH_CODE

4. 换 token 时带 code_verifier
   POST /token
     code=AUTH_CODE
     code_verifier=abc123random

5. 认证中心验证 SHA256(code_verifier) == 之前存的 code_challenge
   匹配则发 token，不匹配拒绝

# 安全性：即使攻击者拦截了 AUTH_CODE，没有 code_verifier 也换不到 token
```

```java
// PKCE 签发端验证
@PostMapping("/oauth/token")
public TokenResponse exchangeCode(@RequestBody CodeExchangeRequest req) {
    // 1. 验证授权码有效
    AuthorizationCode authCode = codeRepo.findById(req.getCode());
    if (authCode == null || authCode.isExpired()) {
        throw new InvalidCodeException();
    }

    // 2. PKCE 验证：SHA256(code_verifier) == code_challenge
    if (authCode.getCodeChallenge() != null) {
        String computedChallenge = sha256(req.getCodeVerifier());
        if (!computedChallenge.equals(authCode.getCodeChallenge())) {
            throw new PkceVerificationException("PKCE 验证失败");
        }
    }

    // 3. 签发 token
    return issueToken(authCode.getUserId());
}
```

## 五、底层本质：无状态 vs 有状态的权衡

回到第一性：**会话治理的核心矛盾是"无状态性能" vs "有状态可控"**。

- **JWT 无状态**：服务端不存 token，靠签名验证。优势是水平扩容无状态同步问题，验签在本地（< 1ms）。劣势是**无法主动撤销**（签发后到过期前一直有效），泄露后只能等自然过期。
- **Session 有状态**：服务端存 session，每次查 Redis/DB。优势是可主动撤销（删 session 即可）。劣势是每次请求查存储（增加 RT），多实例要 session 同步。

**Access Token + Refresh Token 的折中**：Access Token 用 JWT（无状态，15 分钟短期，即使泄露风险有限）；Refresh Token 有状态（服务端存储，7 天长期，泄露可撤销）。这样日常请求验 Access Token（快，无状态），泄露风险靠短期控制；登出/撤销只操作 Refresh Token（有状态可控），Access Token 自然过期。这是"用短期无状态换性能，用长期有状态换可控"的工程平衡。

**OAuth2 的本质是"权限委托"**：用户把权限委托给第三方应用，但通过 scope 限定范围（最小权限）、通过有效期控制风险（短期令牌）、通过撤销机制兜底（吊销 token）。这是"可控授权"替代"全权密码"的安全升级。

## 六、AI 架构师加问：5 个

1. **AI Agent 调用 API 怎么认证？**
   Agent 用服务账号（client_credentials 模式）获取 Access Token，不用用户密码。Token 的 scope 限定 Agent 能调的接口。Agent 的每次调用带 token，API 验签+验 scope。高危操作（写数据）要求 user_assertion（用户显式授权）。

2. **AI 推理服务用 JWT 还是 API Key？**
   内部服务间用 JWT（有 scope 和过期，安全）；对外开发者用 API Key（长期有效，方便）。AI 推理服务通常内部调用，用 JWT + client_credentials。API Key 适合开放给第三方开发者（简化接入）。

3. **用 AI 检测 token 异常使用，怎么做？**
   监控每个 token 的使用模式——IP 变化、调用频率、操作类型。异常模式（token 突然从新 IP 高频调用）触发风控。AI 用孤立森林/序列异常检测识别"token 行为偏离基线"，自动冻结可疑 token。

4. **OAuth2 + RAG，AI 怎么访问用户私有数据？**
   用户授权 AI 读取其数据（OAuth2 授权码流程，scope=read:user_data）。AI 拿到 Access Token 调用数据 API，获取用户数据作为 RAG 上下文。Token 的 scope 限定 AI 只能读不能写。用户可随时撤销授权（撤销 token）。

5. **AI 生成 token 签发策略，怎么防过度授权？**
   AI 根据应用场景推荐最小 scope（如只读订单就不给写权限）。Code Review 检查 scope 是否最小化。scope 申请走审批——高敏感 scope（资金操作）必须人工确认。AI 输出策略草案，安全管理员 review。

## 七、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"OAuth2 授权协议、JWT 令牌格式、双 Token 续期"**。

- **四种 Grant**：授权码（Web）、PKCE（移动端）、密码（可信）、客户端凭证（服务间）
- **JWT 三段**：Header.Payload.Signature，RS256 公钥验签
- **双 Token**：Access Token 15min（无状态快）+ Refresh Token 7d（有状态可控）
- **撤销**：JWT 黑名单（Redis 存 jti），Refresh Token 服务端删除
- **PKCE**：code_verifier + code_challenge，防授权码拦截

### 面试现场 60 秒回答

> OAuth2 是授权协议，JWT 是令牌格式，两者常配合用。OAuth2 四种 Grant Type——Web 应用用授权码流程（最安全，用户跳转认证中心授权，后端用 code+secret 换 token），移动端用 PKCE（动态 challenge 防 code 拦截），服务间用客户端凭证（client_id+secret 直接换 token）。JWT 三段：Header（算法）.Payload（声明 sub/scope/exp/jti）.Signature（RS256 签名），验签用公钥，微服务各自验不发网络请求。会话治理用双 Token——Access Token 15 分钟无状态（快，即使泄露风险有限），Refresh Token 7 天有状态存服务端（可撤销）。前端无感续期：请求 401 自动用 Refresh Token 换新 Access Token，重放原请求。登出时 Access Token 加黑名单（Redis 存 jti 直到过期），Refresh Token 服务端删除。JWT 最大缺点是"签发后无法主动撤销"，靠短期+黑名单缓解。

## 八、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不直接用用户名密码调用 API，非要 OAuth2？ | 用密码泄露影响面说话：密码泄露=全权限泄露（攻击者可做任何操作），且改密码影响所有应用。OAuth2 的 token 有 scope（最小权限）+ 有效期（降低风险）+ 可撤销（吊销）。用 token_breach_impact（令牌泄露影响范围）和 password_breach_impact（密码泄露影响范围）量化 |
| 证据追问 | 怎么证明 token 机制安全？ | 攻击拦截率（伪造 token 被拒率应 100%）、token 泄露事故数（应 0）、撤销生效延迟（应 < 1 秒）、刷新成功率（应 > 99.9%）。安全渗透测试覆盖 token 伪造/重放/窃取 |
| 边界追问 | JWT 无状态能主动撤销吗？ | 不能纯无状态撤销（签发后到过期前一直有效）。解法是黑名单——撤销的 token 的 jti 放 Redis，验 token 时查黑名单。代价是失去纯无状态（要查 Redis），所以只对"主动登出"的加黑名单 |
| 反例追问 | 什么场景不适合 JWT？ | 需要主动踢人下线（管理员封禁用户，所有 token 立即失效）、需要单设备登录（同账号只能一个 token 有效）、token 数量极大（每个请求验签+查黑名单开销）。这些场景用 Session 更合适 |
| 风险追问 | OAuth2 + JWT 最大的风险？ | 主动点出：token 泄露（XSS 偷 localStorage 的 token）、Refresh Token 存储不当（不能存 localStorage，用 HttpOnly Cookie）、授权码拦截（无 PKCE 时可被中间人截获）、密钥泄露（RS256 私钥泄露所有 token 可伪造） |
| 验证追问 | 怎么验证 token 没被篡改？ | 签名验证——RS256 用公钥验签，篡改任何一段（Header/Payload）签名不匹配。密钥轮换测试：换密钥后旧 token 应失效。渗透测试：用篡改的 token 调 API 必须被拒 |
| 沉淀追问 | 认证授权系统沉淀什么？ | OAuth2 网关框架（四种 Grant Type 开箱即用）、JWT 签发验证组件（密钥轮换+黑名单）、统一登录中心（SSO）、token 监控大盘（签发量/刷新量/撤销量） |

### 现场对话示例

**面试官**：JWT 无状态，怎么实现"管理员封禁用户，立即踢下线"？

**候选人**：纯 JWT 做不到"立即生效"——因为 JWT 无状态，签发后服务端不存储，所有微服务只靠验签判断有效性，封禁用户后他的 JWT 在过期前仍然有效。三种解法。第一种，黑名单——封禁用户的 token 的 jti 加 Redis 黑名单，所有微服务验 token 时查黑名单。但封禁时不知道用户当前有哪些 token（可能多设备登录），所以更激进的是按 userId 黑名单（封禁 userId，所有该用户的 token 都拒绝）。第二种，短 Access Token + 风控拦截——Access Token 只有 5 分钟有效期，封禁后最多 5 分钟 token 自然过期。期间风控层加规则"封禁用户的请求一律拒绝"。第三种，混合模式——Access Token 用 JWT（无状态快），但加一个"Session 检查"标记，每隔 N 次请求查一次 Session 服务（Redis 标记用户是否封禁），类似"间歇性验态"。京东的做法：关键操作（下单/支付）每次都查 Session 状态（封禁立即生效），非关键操作（浏览商品）靠 Access Token 短期自然过期，最多 15 分钟延迟。

**面试官**：PKCE 具体解决什么问题？

**候选人**：PKCE 解决"授权码拦截"攻击。场景：移动端 App 跳转认证中心时，用自定义 scheme（如 myapp://callback）接收授权码。攻击者可以注册同样的 scheme 拦截回调，拿到授权码。如果没有 PKCE，攻击者用授权码+client_secret 换 token——但移动端 App 无法安全存储 client_secret（反编译可见），所以攻击者能换到 token。PKCE 的解法：App 生成 code_verifier（随机串），计算 code_challenge = SHA256(code_verifier)。跳转时带 code_challenge，换 token 时带 code_verifier。认证中心验证 SHA256(code_verifier) == code_challenge。攻击者拦截了授权码，但没有 code_verifier（App 内存里的随机串，不通过网络传），换不到 token。PKCE 让"无 client_secret 的客户端"（移动端/SPA）也能安全用授权码流程。OAuth2.1 已经把 PKCE 设为必选（所有客户端都要用）。

**面试官**：Refresh Token 存哪里最安全？

**候选人**：Refresh Token 是长期凭证（7 天），泄露后可无限刷新 Access Token，存储安全性至关重要。绝对不能存 localStorage——XSS 攻击可以读 localStorage 偷走。推荐存 HttpOnly + Secure + SameSite=Strict 的 Cookie——HttpOnly 防 XSS（JS 读不到），Secure 只在 HTTPS 传输，SameSite 防 CSRF。服务端额外存储 Refresh Token 的 jti（Redis/DB），刷新时验证 jti 一致（防止伪造）。对于高安全场景（金融），Refresh Token 绑定设备指纹——只有签发时的设备能用，换设备必须重新登录。另外，Refresh Token 要做到"单点有效"——每次刷新签发新 Refresh Token 并失效旧的（滚动续期），这样即使旧 Refresh Token 泄露，攻击者用旧 token 刷新时，合法用户的新刷新会让旧的失效。京东 App 的 Refresh Token 存在 HttpOnly Cookie + 设备绑定，卸载重装需要重新登录。

## 常见考点

1. **OAuth2 和 OpenID Connect 什么关系？**——OAuth2 是授权协议（authorization），OpenID Connect 是认证协议（authentication）基于 OAuth2 扩展。OIDC 在 OAuth2 基础上加了 ID Token（包含用户身份信息），解决 OAuth2 "只授权不认证"的问题。
2. **JWT 和 Session 怎么选？**——微服务无状态架构选 JWT（服务端不存储，水平扩容无同步问题）；需要主动管理会话（踢人下线/单设备登录）选 Session。混合用：Access Token 用 JWT，Refresh Token 走 Session。
3. **Token 过期了前端怎么处理？**——Axios 拦截器捕获 401，自动用 Refresh Token 刷新，重放原请求。如果 Refresh Token 也过期，跳转登录页。注意并发刷新（多个请求同时 401，只刷新一次）。
4. **SSO 用 OAuth2 还是 CAS？**——企业内部 SSO 常用 CAS（Central Authentication Service），跨组织 SSO 用 OAuth2/OIDC。两者本质相似（票据换 token），OAuth2 更通用（互联网标准）。

## 结构化回答

**30 秒电梯演讲：** OAuth2 是授权协议（让第三方应用拿用户授权的令牌访问资源），JWT 是令牌格式（自包含的 JSON 签名 token）。两者常混用但定位不同：OAuth2 定义了授权码、密码、客户端凭证四种 Grant Type，JWT 是 Access Token 的一种编码格式。会话治理的核心是令牌生命周期管理——签发、刷新、撤销、续期，既保证安全（令牌泄露可撤销）又保证体验（用户无感续期）

**展开框架：**
1. **OAuth2 四种 Grant Type** — 授权码（最安全，Web 应用）、密码（信任的客户端）、客户端凭证（服务间）、隐式（已废弃，用 PKCE 替代）
2. **JWT 三段** — Header（算法）.Payload（声明）.Signature（签名）
3. **JWT 无状态** — 服务端不存储，靠签名验证；缺点是无法主动撤销（除非黑名单）

**收尾：** 以上是我的整体思路。您想继续深入聊——JWT 怎么主动撤销？


## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：OAuth2、JWT 与会话治理 | "这题核心是——OAuth2 是授权协议（让第三方应用拿用户授权的令牌访问资源），JWT 是令牌格式（自包含……" | 开场钩子 |
| 0:15 | OAuth2 四种 Grant 示意/对比图 | "授权码（最安全，Web 应用）、密码（信任的客户端）、客户端凭证（服务间）、隐式（已废弃，用 PKCE 替代）" | OAuth2 四种 Grant 要点 |
| 0:40 | JWT 三段示意/对比图 | "Header（算法）.Payload（声明）.Signature（签名）" | JWT 三段要点 |
| 1:25 | 总结卡 | "记住：OAuth2 = 授权协议。下期见。" | 收尾 |
