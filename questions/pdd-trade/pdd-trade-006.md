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

## 苏格拉底式面试追问

> 这组追问不背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：拼多多选了 Session+Redis 而不是 JWT，但很多大厂用 JWT，你做这个选择的动机是什么？**

核心动机是"可控性"——拼多多是电商，有大量需要主动失效的场景：用户被封号、商家违规清退、密码改了要踢下线、风控检测到异地登录要强制重新认证。JWT 是无状态的，签发后服务端无法撤销（除非维护黑名单，但黑名单又把无状态变成有状态了）。Session+Redis 天然支持"删 Redis key 立即失效"，踢人/封号是电商运营的日常操作。代价是每次请求要查 Redis（多 1ms），但拼多多 Redis 集群扛得住。如果是一个纯 API 服务、不需要主动失效，JWT 更合适。选择不是看谁更先进，是看业务是否需要"集中管控"。

### 第二层：证据与定位

**Q：有用户反馈"刚登录就提示登录失效，反复登录都进不去"，你怎么定位是 Session 没写进去，还是校验逻辑有问题，还是 Redis 的问题？**

按请求链路逐步排查。三步：
1. 让用户复现时抓包看 Cookie——`session_id` 是否正确下发（登录接口的 Set-Cookie）。如果 Cookie 没带上，是 `SameSite/Secure` 配置问题（HTTPS 下 Secure Cookie 在 HTTP 回退时丢）。
2. 如果 Cookie 带了，登录服务的日志看 `redisTemplate.set("session:"+sessionId)` 是否成功——看是否抛 `RedisConnectionFailureException`（Redis 连不上）或 `JedisDataException`（OOM 拒绝写入）。
3. `redis-cli -h xxx keys "session:<sessionId>"` 直接查——如果 key 不存在，可能是 TTL 设错了（比如配成 7 秒而不是 7 天），或被别的清理任务删了；如果 key 在但校验失败，是反序列化问题（User 类改了字段导致 ClassCastException）。关键是顺着"下发 Cookie → 写 Redis → 读 Redis"三步找断点。

### 第三层：根因深挖

**Q：你查到是 Redis 内存满了导致 Session 写不进去（OOM），根因是什么？光是扩容 Redis 就行吗？**

扩容是治标。根因要看 Redis 内存被什么占满：
1. `INFO memory` 看 `used_memory` 和 `maxmemory`——如果 used 接近 max，且淘汰策略是 `noeviction`（不淘汰，写直接失败），就是配错了。
2. `MEMORY STATS` 和 `redis-cli --bigkeys` 找大 key——拼多多这种量级，最常见是某个业务把大对象（如商品详情 JSON 几 MB）当 value 存 Redis，几个大 key 吃掉大半内存。
3. Session 本身的 TTL 没生效——如果 `set` 时没传 TTL 或 TTL 单位错（传成毫秒当秒用），Session 永不过期，日积月累撑爆。治本是给 Session 强制设 TTL（SDK 层兜底，不允许无 TTL 写入）+ Redis 淘汰策略改成 `allkeys-lru`（满了淘汰最久没用的，保证写入不失败）。

**Q：那为什么不直接用 JWT，不就不用担心 Redis OOM 了吗？**

JWT 确实不占服务端内存，但前面说过——拼多多的核心诉求是"主动失效"。JWT 失效只能靠黑名单，黑名单存哪？还是 Redis。所以"为了躲 Redis OOM 换 JWT"最后还是要用 Redis 存黑名单，问题没解决，反而多了 JWT 的复杂性（短有效期 + Refresh Token 续期逻辑）。正确思路是治 Redis 的根因（大 key + TTL + 淘汰策略），而不是绕开 Redis。Redis OOM 是运维和容量规划问题，不是技术选型问题。

### 第四层：方案权衡

**Q：你的 Session TTL 设了 7 天，但用户反馈"每次打开 App 都要重新登录"，体验差。延长到 30 天又怕安全，你怎么权衡？**

权衡方案是"滑动过期 + 活跃续期"：
1. Session 设绝对过期时间（如 30 天）+ 每次请求滑动续期（活跃用户一直续，30 天不用才失效）。实现是拦截器里 `redisTemplate.expire("session:"+id, 7, DAYS)`，每次访问刷 TTL。这样活跃用户无感，长期不用的自动清理。
2. 对敏感操作（支付/改密码）要求"近期登录"——即使用户 Session 还在，如果距离上次登录超过 24 小时，支付时要重新输密码（二次校验）。把"Session 有效期"和"敏感操作信任期"解耦，体验和安全都兼顾。

**Q：为什么不直接用永久 Token（不过期），靠 Refresh Token 续期？**

永久 Token 一旦泄露（XSS 偷到、日志记下来）就是永久后门，直到主动失效。Refresh Token 机制本身要求 Access Token 短期（如 2 小时），过期后用 Refresh Token 换新的，Refresh Token 长期但只能用来换 Access Token（不能直接访问业务接口），且 Refresh Token 单设备唯一（换设备登录会让旧的失效）。这套机制比"永久 Token"安全得多，代价是续期逻辑复杂。拼多多如果纯 Session 方案，Session 本身就承担了 Access Token 的角色（短期 + 活跃续期），不需要 Refresh Token；如果走 JWT 路线，Refresh Token 是必须的。

### 第五层：验证与沉淀

**Q：你怎么验证 Session 校验逻辑在各种边界场景下都正确，比如 Redis 故障降级时不会"放任何人进来"？**

Session 降级是高危场景，必须有测试和预案：
1. 单元测试覆盖——正常 Session 通过、Session 过期、Session 被踢（Redis 删 key）、Redis 连不上（降级）。重点是 Redis 连不上时的行为：正确做法是"拒绝访问"（返回 401 或降级页），绝不能"放行"（否则等于鉴权失效）。Chaos 测试里注入 Redis 网络分区，验证所有接口都返回 401 而非 200。
2. 黑名单/白名单机制——Redis 故障时，对核心接口（下单/支付）必须拒绝；对非核心（浏览商品）可以降级放行。这个策略要显式配置，不能靠"恰好 Redis 挂了业务也挂了"。
3. 监控——`session_redis_error_rate` 告警，一旦 Redis 错误率上升，立即触发"鉴权降级"预案（甚至主动限流），而不是等用户反馈。

**Q：怎么沉淀登录鉴权的能力，让新业务线接入不踩坑（比如忘了加拦截器导致接口裸奔）？**

靠框架强制，不靠人记：
1. 统一鉴权 SDK——所有业务服务强制继承 `BaseAuthFilter`，默认所有接口都要登录，白名单接口（如健康检查/商品详情）要显式 `@Anonymous` 注解。新接口默认受保护，不是默认开放。
2. CI 安全扫描——扫描所有 Controller 方法，没有 `@Anonymous` 且不在白名单的，必须有鉴权拦截器覆盖，否则 CI 挂掉。
3. 红蓝对抗——安全团队定期扫描内部接口，发现裸奔接口直接通报。拼多多这种规模，靠人工 review 几千个接口不现实，必须框架默认安全 + 自动扫描兜底。

## 结构化回答

**30 秒电梯演讲：** 微服务多实例下如何高效安全地鉴权？简单说就是——登录鉴权用 JWT（无状态，适合微服务）或 Session+Redis（有状态，可强控），交易系统需"登录+权限+风控"三重校验。

**展开框架：**
1. **JWT** — JWT：Header.Payload.Signature，无状态，签名防篡改
2. **Session** — Session：服务端存储，Redis 集中，可控可踢
3. **权限** — 权限：RBAC（角色-权限模型）

**收尾：** 您看这块要不要再展开聊聊？

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：登录鉴权怎么做？JWT 和 Session 怎么选？ | 今天聊「登录鉴权怎么做？JWT 和 Session 怎么选？」。一句话：登录鉴权用 JWT（无状态，适合微服务）或 Session+Redis（有状态 | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：JWT：Header.Payload.Signature，无状态，签名防篡改 | 核心概念 |
| 1:04 | 能力/参数拆解表 | 要点是：Session：服务端存储，Redis 集中，可控可踢 | 能力拆解 |
| 1:56 | 流程图：输入→处理→输出 | 要点是：权限：RBAC（角色-权限模型） | 关键机制 |
| 3:00 | 总结卡 + 下期预告 | 记住核心要点就够了。下期见。 | 收尾 |
