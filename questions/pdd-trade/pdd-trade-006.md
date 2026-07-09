---
id: pdd-trade-006
difficulty: L3
category: pdd-trade
subcategory: 用户
tags:
- 拼多多
- 交易
- 登录鉴权
- JWT
- Session
feynman:
  essence: 登录鉴权用 JWT（无状态，适合微服务）或 Session+Redis（有状态，可强控），交易系统需"登录+权限+风控"三重校验。
  analogy: JWT 像自带照片的身份证（自证身份），Session 像派出所户籍（中心化管理）。
  first_principle: 微服务下鉴权要无状态（JWT）便于水平扩展，或集中存储（Session+Redis）便于管控。
  key_points:
  - JWT：Header.Payload.Signature，无状态，签名防篡改
  - Session：服务端存储，Redis 集中，可控可踢
  - 权限：RBAC（角色-权限模型）
  - 风控：异地登录/频次校验
first_principle:
  problem: 微服务多实例下如何高效安全地鉴权？
  axioms:
  - 多实例无共享 Session（除非 Redis）
  - 每次请求都要鉴权
  - 需要可控（踢人/封号）
  rebuild: JWT（无状态）或 Session+Redis（集中管控）+ RBAC 权限 + 风控校验。
follow_up:
- JWT 怎么主动失效？——Redis 黑名单 + 短有效期 + Refresh Token
- Session 怎么分布式共享？——Spring Session + Redis
- 拼多多怎么防撞库？——风控（频次/IP/设备指纹）+ 验证码
memory_points:
- JWT 无状态（签名自证）/ Session 有状态（Redis 集中）
- RBAC：角色-权限模型
- JWT 主动失效：黑名单 + 短期 + Refresh
- 三重校验：登录+权限+风控
---

# 【拼多多交易】登录鉴权怎么做？JWT 和 Session 怎么选？

> JD 依据："用户平台登录、鉴权"。

## 一、JWT vs Session

| 维度 | JWT（无状态） | Session+Redis（有状态） |
|------|-------------|---------------------|
| 存储 | 客户端 | 服务端 Redis |
| 扩展 | 好（无状态） | 中（依赖 Redis） |
| 主动失效 | 难（需黑名单） | 易（删 Redis） |
| 性能 | 好（无需查） | 中（查 Redis） |

**拼多多选 Session+Redis**（强管控，可踢人/封号）。

## 二、JWT 实现

```java
// 签发
String jwt = Jwts.builder()
    .setSubject(uid)
    .setExpiration(new Date(System.currentTimeMillis() + 3600000))
    .signWith(Keys.hmacShaKeyFor(secret))
    .compact();

// 校验
Claims claims = Jwts.parserBuilder()
    .setSigningKey(Keys.hmacShaKeyFor(secret))
    .build().parseClaimsJws(jwt).getBody();
```

## 三、Session + Redis

```java
// 登录
@PostMapping("/login")
public String login(String phone, String code) {
    if (!verifyCode(phone, code)) throw new AuthException();
    User user = userService.findByPhone(phone);
    String sessionId = UUID.randomUUID().toString();
    redisTemplate.opsForValue().set("session:" + sessionId, user, 7, DAYS);
    return sessionId;  // Cookie 下发
}

// 拦截器校验
User user = (User) redisTemplate.opsForValue().get("session:" + sessionId);
if (user == null) throw new AuthException();
```

## 四、RBAC 权限

```
用户 → 角色 → 权限
张三 → 买家 → [下单, 支付, 评价]
李四 → 商家 → [上架, 发货, 结算]
```

## 五、风控校验

- 异地登录：换城市需二次验证
- 频次：1 分钟登录失败 5 次锁 30 分钟
- 设备：新设备需验证码

## 六、底层本质

鉴权本质是**"证明你是谁 + 你能干什么"**：
- 认证（你是谁）：JWT/Session
- 授权（你能干）：RBAC
- 风控（你可疑吗）：频次/设备/行为

## 常见考点
1. **JWT 怎么主动失效**？——Redis 黑名单 + 短有效期 + Refresh Token。
2. **Session 分布式怎么共享**？——Spring Session + Redis（透明）。
3. **Token 放哪**？——HttpOnly Cookie（防 XSS）+ Secure + SameSite。
