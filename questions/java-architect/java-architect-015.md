---
id: java-architect-015
difficulty: L4
category: java-architect
subcategory: 网关设计
tags:
- 网关
- 鉴权
- 灰度
feynman:
  essence: 网关的本质是"南北向流量的统一策略执行点"——把鉴权、限流、路由、灰度、协议转换这些横切关注点从后端服务剥离，集中在一个数据平面执行。它用"反向代理 + 过滤器链"模型，每个请求按序穿过 Filter Chain，可前置短路（鉴权失败/限流命中直接返回）也可后置处理（响应改写）。
  analogy: 像写字楼的"大堂安保 + 前台"。访客（请求）先过安保闸机（鉴权）→ 前台登记分流到不同楼层（路由）→ 高峰期货梯限流放行（限流）→ VIP 走专用电梯（灰度）。后端业务（楼层租户）不用关心安保，专心做业务。一旦安保规则变了（鉴权策略调整），只改大堂不用通知每个租户。
  first_principle: 为什么要网关而不是每个服务自己鉴权？因为横切关注点（鉴权/限流/日志/灰度）在每个服务重复实现会导致：代码重复、策略难统一变更、性能开销分散难治理。网关把"非业务策略"集中，让业务服务只关心业务，策略变更一处生效。
  key_points:
  - 数据平面（Gateway/Filter）与控制平面（配置中心/限流规则中心）分离，规则热更新不停机
  - 限流三算法：计数器（固定窗口）、滑动窗口、令牌桶（允许突发）、漏桶（强制匀速）
  - 鉴权前置：JWT 无状态校验在网关完成，业务服务不再解析 token
  - 灰度发布：按 Header/Cookie/IP/UID 路由到灰度实例，金丝雀比例可动态调整
  - 网关本身要高可用：多实例 + 客户端负载均衡，单实例故障秒级摘除
first_principle:
  problem: 如何在一个统一入口集中执行"鉴权、限流、路由、灰度"这些横切策略，同时不成为性能瓶颈和单点故障？
  axioms:
  - 横切策略（鉴权/限流/灰度）与业务逻辑正交，应解耦
  - 策略集中执行便于统一变更、审计、监控
  - 统一入口不能是单点，自身要高可用
  rebuild: 用"反向代理 + 过滤器链"构建网关。每个请求按顺序穿过 Filter Chain（pre→route→post），每个 Filter 执行一类策略（AuthFilter 鉴权、RateLimitFilter 限流、GrayFilter 灰度路由）。数据平面（Filter 执行）和控制平面（规则配置）分离，规则放配置中心热更新。网关本身多实例部署 + 客户端负载均衡（SLB/Nginx 前置），单实例故障秒级摘除。限流用令牌桶做单机限流 + Redis 做集群限流（统一计数）。
follow_up:
  - Spring Cloud Gateway 和 Zuul 区别？——Zuul 1.x 是同步阻塞（Servlet + 每请求一线程），Zuul 2.x 是异步非阻塞（Netty）；SCG 是异步非阻塞（Netty + Reactor），性能比 Zuul 1.x 高 50%+。Spring 官方主推 SCG
  - 网关怎么做集群限流？——单机令牌桶限流会出现"总流量超限但单机没超"的问题。集群限流用 Redis + Lua 原子扣减令牌，或 Sentinel 集群流控（选一台做 Token Server）。代价是多一次 Redis 往返，QPS 上限受 Redis 制约
  - 灰度发布怎么保证会话粘连？——用户首次请求路由到灰度实例后，网关在响应头种 Cookie（如 x-gray=v2），后续请求带该 Cookie 就固定路由到 v2。否则同一用户一会儿 v1 一会儿 v2 体验割裂
  - 网关挂了全站不可用怎么办？——网关是单点强依赖，必须高可用：多实例 + 前置 SLB（如 AWS ALB/阿里 SLB）做健康检查，故障实例秒级摘除；跨可用区部署防机房级故障；降级方案是网关挂时走静态降级页（SLB 配置兜底）
  - 网关为什么用异步非阻塞（Netty）而不是 Tomcat？——网关 IO 密集（大量转发），Tomcat 同步阻塞模型每请求一线程，万级并发要万级线程，内存和上下文切换扛不住。Netty 异步非阻塞少量线程处理大量连接，背压可控
memory_points:
  - SCG = Route（路由）+ Predicate（断言）+ Filter（过滤器）三要素
  - 限流算法：固定窗口（简单有临界突发）、滑动窗口（平滑）、令牌桶（允许突发）、漏桶（强制匀速）
  - 鉴权 JWT 无状态校验放网关，业务服务不再解析 token
  - 灰度路由维度：Header/Cookie/IP/UID/权重
  - 集群限流 = Redis + Lua 原子扣减令牌，或 Sentinel 集群流控
  - 网关自身高可用：多实例 + SLB + 跨 AZ + 降级页
---

# 【Java 后端架构师】网关鉴权、路由、限流与灰度发布

> 适用场景：JD 核心技术。大促秒杀 QPS 从日常 1 万飙到 50 万，没有网关统一限流就是后端被直接打爆。新功能上线要灰度验证（1% 流量先试），靠网关按 UID 路由。架构师必须能设计过滤器链、写限流算法代码、设计灰度路由规则、保证网关自身高可用——这是所有南北向流量的咽喉。

## 一、概念层：网关的四大职责与选型

**网关核心职责**：

| 职责 | 作用 | JD 场景 |
|------|------|---------|
| **鉴权（Auth）** | JWT 校验、签名验签、黑白名单 | 用户登录态校验、开放平台签名验签 |
| **限流（Rate Limit）** | 保护后端不被打爆 | 秒杀限流、API 配额管控 |
| **路由（Routing）** | 按规则转发到目标服务 | 路径前缀路由、灰度路由 |
| **协议转换** | 异构协议互转 | HTTP→gRPC、HTTP→Dubbo（Dubbo 网关） |
| **熔断降级** | 后端故障时快速失败 | Sentinel 集成 |
| **日志监控** | 统一访问日志、链路追踪 | 全链路 traceId 注入 |

**网关选型对比**（面试必考）：

| 网关 | 底层 | 编程模型 | 性能 | 适用 |
|------|------|---------|------|------|
| **Spring Cloud Gateway** | Netty | Reactor 异步非阻塞 | 高（万级 RPS/核） | Spring Cloud 生态首选 |
| **Zuul 2.x** | Netty | 异步非阻塞 | 高 | Netflix 生态（已少用） |
| **Nginx + Lua** | Nginx | 协程（OpenResty） | 极高（十万级 RPS/核） | 高性能场景、CDN 边缘 |
| **APISIX / Kong** | Nginx + Lua/Go | 插件化 | 极高 | 云原生、多插件、多协议 |
| **Dubbo 网关** | Netty | 异步 | 高 | HTTP→Dubbo 协议转换 |

**Spring Cloud Gateway 三要素**（SCG 核心，必背）：

```
Route（路由）= Predicate（断言）+ Filter（过滤器）+ URI（目标）
  │
  ├─ Predicate：匹配条件（Path、Header、Cookie、Method、Query、时间）
  ├─ Filter：前置/后置处理（鉴权、限流、改写、日志）
  └─ URI：目标地址（lb://service-name 走注册中心负载均衡）
```

## 二、机制层：SCG 过滤器链执行流程

**请求处理全链路**（画图必考）：

```
Client Request
    │
    ▼
RoutePredicateHandlerMapping   ── 按 Predicate 匹配路由
    │ （匹配不到 → 404）
    ▼
FilteringWebHandler            ── 组装 Filter Chain（Global + Route Specific）
    │
    ▼
┌─────────── Pre Filters（前置，按 order 升序）───────────┐
│ 1. MetricsFilter（埋点）                                  │
│ 2. TraceFilter（注入 traceId）                            │
│ 3. AuthFilter（JWT 校验，失败直接返回 401）               │
│ 4. RateLimitFilter（限流，命中返回 429）                  │
│ 5. GrayFilter（灰度路由，改写 URI/Header）                │
│ 6. LoggingFilter（记录访问日志）                          │
└─────────────────────────────────────────────────────────┘
    │
    ▼
NettyRoutingFilter（或 LoadBalancerClientFilter）── 转发到后端
    │
    ▼
┌─────────── Post Filters（后置，按 order 降序）──────────┐
│ 7. ResponseLoggingFilter（记录响应）                     │
│ 8. MetricsFilter（记录耗时/状态码）                      │
└─────────────────────────────────────────────────────────┘
    │
    ▼
Client Response
```

**关键点**：Filter 通过 `order` 控制执行顺序；`GatewayFilter` 是路由级（配置在 Route 内），`GlobalFilter` 是全局级（所有路由生效）；短路返回（鉴权/限流失败）直接 write 响应，不再向下执行。

## 三、实战层：四大功能代码实现

### 1. 路由配置（YAML 声明式）

```yaml
spring:
  cloud:
    gateway:
      routes:
        - id: trade-service
          uri: lb://trade-service          # lb:// 走注册中心负载均衡
          predicates:
            - Path=/trade/**               # 路径匹配
            - Method=GET,POST              # 方法匹配
            - Header=X-Version, v\d+       # Header 正则匹配
          filters:
            - StripPrefix=1                # 转发时去掉第一段前缀 /trade/create → /create
            - AddRequestHeader=X-Gateway, scg
            - name: RequestRateLimiter     # 限流过滤器
              args:
                redis-rate-limiter.replenishRate: 100    # 令牌填充速率（每秒 100）
                redis-rate-limiter.burstCapacity: 200   # 桶容量（允许突发 200）
                key-resolver: "#{@userKeyResolver}"     # 限流 key（按用户）

        - id: product-service
          uri: lb://product-service
          predicates:
            - Path=/product/**
```

### 2. 鉴权 Filter（JWT 校验）

```java
@Component
@Order(-100)   // 越小越先执行，鉴权要前置
public class AuthFilter implements GlobalFilter {

    @Autowired
    private JwtVerifier jwtVerifier;   // JWT 校验器

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
        ServerHttpRequest request = exchange.getRequest();
        String path = request.getURI().getPath();

        // 1. 白名单放行（登录、健康检查）
        if (isWhiteList(path)) {
            return chain.filter(exchange);
        }

        // 2. 取 token
        String token = request.getHeaders().getFirst("Authorization");
        if (token == null || !token.startsWith("Bearer ")) {
            return unauthorized(exchange, "missing token");
        }
        token = token.substring(7);

        // 3. 校验 JWT（签名 + 过期时间）
        try {
            Claims claims = jwtVerifier.verify(token);
            // 4. 注入用户信息到 Header，下游服务直接用
            ServerHttpRequest mutated = request.mutate()
                .header("X-User-Id", claims.getSubject())
                .header("X-User-Role", claims.get("role", String.class))
                .build();
            return chain.filter(exchange.mutate().request(mutated).build());
        } catch (JwtException e) {
            return unauthorized(exchange, "invalid token: " + e.getMessage());
        }
    }

    private Mono<Void> unauthorized(ServerWebExchange exchange, String msg) {
        exchange.getResponse().setStatusCode(HttpStatus.UNAUTHORIZED);
        exchange.getResponse().getHeaders().setContentType(MediaType.APPLICATION_JSON);
        String body = "{\"code\":401,\"message\":\"" + msg + "\"}";
        DataBuffer buffer = exchange.getResponse().bufferFactory().wrap(body.getBytes());
        return exchange.getResponse().writeWith(Mono.just(buffer));
    }
}
```

### 3. 限流算法代码（令牌桶）

**令牌桶核心算法**（单机版）：

```java
public class TokenBucket {
    private final long capacity;        // 桶容量
    private final long refillRate;      // 每秒填充令牌数
    private final AtomicReference<TokenState> state;

    public boolean tryAcquire(int permits) {
        long now = System.currentTimeMillis();
        while (true) {
            TokenState current = state.get();
            long elapsed = now - current.lastRefillNanos;
            // 1. 计算填充的令牌（不超过容量）
            long refill = (elapsed / 1000) * refillRate;
            long newTokens = Math.min(capacity, current.tokens + refill);
            // 2. 尝试扣减
            if (newTokens < permits) return false;   // 不足拒绝
            TokenState next = new TokenState(newTokens - permits, now);
            if (state.compareAndSet(current, next)) return true;
            // CAS 失败重试
        }
    }
}
```

**集群限流（Redis + Lua）**：

```lua
-- key: 限流标识（如 userId）  rate: 填充速率  capacity: 桶容量  now: 当前时间
-- tokens_key 存当前令牌数，ts_key 存上次填充时间
local tokens = tonumber(redis.call("get", tokens_key) or capacity)
local last_ts = tonumber(redis.call("get", ts_key) or now)
local refill = math.min(capacity, tokens + (now - last_ts) / 1000 * rate)
if refill < 1 then
    return 0   -- 拒绝
else
    redis.call("set", tokens_key, refill - 1, "EX", 60)
    redis.call("set", ts_key, now, "EX", 60)
    return 1   -- 放行
end
```

**限流维度**：

```java
// 按用户限流
@Bean
public KeyResolver userKeyResolver() {
    return exchange -> Mono.just(
        exchange.getRequest().getHeaders().getFirst("X-User-Id"));
}

// 按 IP 限流（防爬虫）
@Bean
public KeyResolver ipKeyResolver() {
    return exchange -> Mono.just(
        exchange.getRequest().getRemoteAddress().getAddress().getHostAddress());
}

// 按 API 限流（不同接口不同配额）
@Bean
public KeyResolver apiKeyResolver() {
    return exchange -> Mono.just(
        exchange.getRequest().getURI().getPath());
}
```

### 4. 灰度发布 Filter

```java
@Component
@Order(-50)
public class GrayFilter implements GlobalFilter {

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
        ServerHttpRequest request = exchange.getRequest();
        String uid = request.getHeaders().getFirst("X-User-Id");
        String version = request.getHeaders().getFirst("X-Version");

        // 1. 显式指定版本（白名单用户强制走 v2）
        if (version != null) {
            addGrayMetadata(exchange, version);
            return chain.filter(exchange);
        }

        // 2. 按权重灰度（10% 流量走 v2）
        int hash = Math.abs(uid.hashCode()) % 100;
        if (hash < grayPercent) {   // grayPercent 从配置中心读，可动态调
            addGrayMetadata(exchange, "v2");
        } else {
            addGrayMetadata(exchange, "v1");
        }

        // 3. 种 Cookie 保证会话粘连
        exchange.getResponse().getCookies().add("x-gray",
            ResponseCookie.from("x-gray", version).maxAge(3600).build());
        return chain.filter(exchange);
    }

    private void addGrayMetadata(ServerWebExchange exchange, String version) {
        // SCG 通过 LbContext 传给 LoadBalancer，LoadBalancer 按 version 过滤实例
        exchange.getAttributes().put("lb_filter_metadata_version", version);
    }
}
```

**LoadBalancer 配合灰度**：

```java
public class GrayLoadBalancer implements ReactorServiceInstanceLoadBalancer {
    @Override
    public Mono<Response<ServiceInstance>> choose(Request request) {
        String version = (String) request.getContext().get("version");
        List<ServiceInstance> instances = provider.getInstances();
        // 按 metadata.version 过滤
        List<ServiceInstance> matched = instances.stream()
            .filter(i -> version.equals(i.getMetadata().get("version")))
            .collect(Collectors.toList());
        List<ServiceInstance> candidates = matched.isEmpty() ? instances : matched;
        return Mono.just(new DefaultResponse(random(candidates)));
    }
}
```

## 四、实战层：网关高可用部署

**生产部署架构**：

```
                    Client
                      │
                      ▼
              ┌───────────────┐
              │  DNS / CDN    │  （智能解析、就近接入）
              └───────┬───────┘
                      │
                      ▼
              ┌───────────────┐
              │  SLB / ELB    │  （四层负载、健康检查、DDoS 防护）
              │  (跨 AZ 冗余) │
              └───────┬───────┘
                      │
        ┌─────────────┼─────────────┐
        ▼             ▼             ▼
   ┌─────────┐   ┌─────────┐   ┌─────────┐
   │ Gateway │   │ Gateway │   │ Gateway │   （多实例无状态，水平扩容）
   │ node-1  │   │ node-2  │   │ node-3  │
   └────┬────┘   └────┬────┘   └────┬────┘
        │             │             │
        └─────────────┼─────────────┘
                      │
                      ▼
              ┌───────────────┐
              │   后端服务群   │  （Nacos 注册中心）
              └───────────────┘
```

**高可用要点**：
- 网关无状态（所有配置走配置中心），任意实例可替换
- 多实例 + SLB 健康检查，故障实例秒级摘除
- 跨可用区部署（至少 3 个 AZ），防机房级故障
- 网关挂时 SLB 配置静态降级页（返回"系统繁忙"而非 502）
- 配置热更新（规则变更不停机），用 Nacos/Apollo 推送

**性能调优**：

```yaml
server:
  netty:
    connection-timeout: 3s
    idle-timeout: 60s
spring:
  cloud:
    gateway:
      httpclient:
        connect-timeout: 2000         # 连后端超时
        response-timeout: 30s         # 响应超时
        pool:
          type: elastic               # 弹性连接池（JDK 21+ 用 virtual thread）
          max-connections: 10000      # 单实例最大连接
          pending-acquire-timeout: 60s # 获取连接超时
```

## 五、底层本质：为什么是异步非阻塞 + 过滤器链

回到第一性：**网关的两个根本需求——高吞吐转发 + 横切策略集中执行**。

- **异步非阻塞（Netty）**：网关是 IO 密集型（大量转发），每请求一线程的同步模型（Tomcat）在万级并发时要万级线程，内存（每线程 1MB 栈）和上下文切换扛不住。Netty 少量 EventLoop 线程处理大量连接，IO 等待时线程不阻塞（用 Callback/Reactor），吞吐量高 10 倍以上。代价是编程模型复杂（Reactor 链式），调试困难。
- **过滤器链**：横切策略（鉴权/限流/日志）与业务正交，用过滤器链解耦。每个 Filter 一个职责，按 order 执行，可前置短路（鉴权失败直接返回）。新增策略只要加 Filter 不改现有代码（开闭原则）。代价是 Filter 链过长会增加延迟（每 Filter 一次方法调用 + Reactor 包装），要控制 Filter 数量和 order 设计。
- **数据/控制平面分离**：数据平面（Filter 执行）追求高性能无状态，控制平面（规则配置）追求灵活变更。规则放配置中心，数据平面订阅热更新，不重启。这是"策略可变、执行不变"的设计。

**限流的本质**：限流是"用拒绝换系统存活"。令牌桶允许突发（桶里攒的令牌），适合有波峰的业务（秒杀）；漏桶强制匀速，适合保护脆弱后端（强制平滑）。集群限流用 Redis 集中计数，代价是多一次网络往返，QPS 受 Redis 制约（万级）。

## 六、AI 架构师加问：5 个 AI 相关问题

1. **AI 推理服务怎么通过网关对外暴露？**
   推理服务（Triton/vLLM）注册到 Nacos，网关路由 `/ai/infer/*` 到推理服务。鉴权用 API Key（放 Header）+ 配额管控（按 API Key 限流，如每分钟 100 次）。流式输出（SSE）需要网关支持长连接透传，SCG 原生支持 `text/event-stream`。

2. **让 AI 动态调整限流阈值，怎么设计？**
   AI 监控后端 CPU/RT/QPS → 通过配置中心下发新的 replenishRate/burstCapacity → 网关 Filter 热生效。AI 决策要做容量预测（基于历史大促数据），不能反应式被动调。变更走"AI 建议→人工审批→灰度单实例→全量"闭环，监控限流命中率（过高说明阈值太低）。

3. **AI 网关（如 LiteLLM、OneAPI）和业务网关的区别？**
   AI 网关专注 LLM 协议（OpenAI/Anthropic 兼容）、多模型路由（按 capability/cost 选模型）、Token 计费、Prompt 缓存、内容安全过滤。业务网关（SCG/Kong）专注 HTTP 路由和业务鉴权。两者可串联：业务网关做鉴权限流 → AI 网关做模型路由和计费 → 真实模型服务。

4. **AI Agent 的工具调用如何用网关统一管控？**
   每个工具（搜索、数据库、API）注册为独立服务，Agent 通过网关调用（不是直连）。网关统一鉴权（防 Agent 越权调用敏感工具）、限流（防 Agent 循环调用打爆工具）、审计（记录每次 tool_call 供回溯）、熔断（工具故障快速失败不让 Agent 卡死）。

5. **怎么防 AI 误改网关规则导致全站故障？**
   规则变更强 schema 校验（路由必须有 URI、限流必须有 key）；走配置中心灰度发布（新规则先推 1 个实例验证）；监控变更后 5 分钟内的 5xx 率和限流命中率，超阈值自动回滚；保留上一版本配置支持秒级回滚；AI 只能改"限流阈值、灰度比例"等参数，不能改路由结构。

## 七、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"三要素、四算法、Filter 链、灰度路由、高可用部署"**。

- **三要素**：Route = Predicate + Filter + URI
- **四限流算法**：固定窗口（临界突发）、滑动窗口（平滑）、令牌桶（允许突发）、漏桶（强制匀速）
- **Filter 链**：pre 鉴权限流灰度 → route 转发 → post 日志监控，按 order 排序
- **灰度路由**：按 Header/Cookie/IP/UID/权重，配 LoadBalancer 按 metadata 过滤实例
- **高可用**：多实例 + SLB + 跨 AZ + 配置热更新 + 降级页

### 拟人化理解

把网关想成**写字楼大堂**。访客（请求）进门先过闸机（鉴权 Filter），刷卡通过才能进；高峰期货梯限流放行（令牌桶），没拿到号牌的等下一批；前台根据访客目的分流到不同楼层（路由 Predicate 匹配）；VIP 客户走专用电梯（灰度路由按 UID）。后端业务（楼层租户）不用关心大堂规则，专心做业务。规则变了（鉴权策略调整）只改大堂，不用通知每个租户改门禁。

### 面试现场 60 秒回答

> 网关四大职责：鉴权、限流、路由、灰度，本质是南北向流量的统一策略执行点。选型上 Spring Cloud 生态首选 SCG，基于 Netty 异步非阻塞，性能比 Zuul 1.x 高 50%+。三要素：Route = Predicate（匹配条件）+ Filter（前置后置处理）+ URI（目标）。限流四种算法：固定窗口有临界突发问题、滑动窗口平滑、令牌桶允许突发（秒杀场景）、漏桶强制匀速（保护脆弱后端）。单机用令牌桶，集群用 Redis + Lua 原子扣减。鉴权 JWT 无状态校验放网关，业务服务不再解析 token。灰度按 Header/Cookie/UID 路由，配 LoadBalancer 按 metadata.version 过滤实例。网关自身高可用：多实例无状态 + SLB 健康检查 + 跨 AZ 部署 + 配置中心热更新 + SLB 降级页兜底。

### 反问面试官

> 贵司网关是自研还是用开源（SCG/APISIX）？峰值 QPS 多少？限流是单机还是集群（Redis/Sentinel Token Server）？有没有遇到过网关成为瓶颈（如大促推送风暴）？如果有，我会聊连接池调优和水平扩容。

## 八、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不让每个服务自己鉴权限流，要集中到网关？ | 用成本说话：每个服务重复实现鉴权限流导致代码重复、策略难统一变更（改一次要发版所有服务）、性能开销分散难治理。集中到网关后策略一处生效、统一监控、统一审计。代价是网关成为单点强依赖，要高可用兜底 |
| 证据追问 | 网关到底限没限住、转发对不对，你怎么证明？ | 网关访问日志（access log）看状态码分布（429 占比=限流命中率）、Prometheus 看 gateway_request_total/gateway_request_duration、Arthas watch Filter 看 Filter 链执行顺序和耗时、压测验证令牌桶参数（burst 不足会误杀） |
| 边界追问 | 网关能解决所有流量问题吗？ | 不能。解决不了东西向流量（服务间调用，用 Service Mesh）；解决不了客户端到网关的延迟（CDN/网络）；解决不了后端真实容量不足（限流只是保护，不能扩容）；解决不了业务级限流（如每用户每天 3 次，要业务层实现） |
| 反例追问 | 什么场景不该用网关？ | 服务间内部调用（用 Mesh 或直连，少一跳延迟）；超低延迟场景（高频交易，网关增加几毫秒不可接受）；内部运维接口（直接访问，不经网关暴露） |
| 风险追问 | 网关上线后最大风险？ | 主动点出：网关单点故障（全站不可用，要高可用兜底）、Filter 链性能瓶颈（Filter 过多增加延迟）、限流参数误配（误杀正常流量或没限住）、配置变更误操作（路由改错全站 404）、连接池耗尽（后端慢导致网关连接堆积） |
| 验证追问 | 怎么证明网关容量规划合理？ | 压测单实例极限（CPU 80% 时的 RPS），按 SLA 倒推实例数（峰值 RPS / 单实例 RPS × 冗余系数 1.5）；线上监控 CPU/内存/连接数/RT，峰值不超 70%；故障演练（kill 实例验证 SLB 摘除时效） |
| 沉淀追问 | 团队网关治理规范，沉淀什么？ | Filter 开发规范（order 规划、异常处理、超时设置）、限流配置 SOP（按 API 分级配额）、灰度发布 SOP（比例渐进 1%→10%→100%）、监控大盘（4xx/5xx/RT/限流命中率）、降级预案（网关挂时的静态页切换） |

### 现场对话示例

**面试官**：你说网关用令牌桶限流，为什么不用固定窗口？

**候选人**：固定窗口有临界突发问题。假设每秒限 100，窗口边界（第 0.9s 到 1.0s）来了 100 个请求，下一窗口（1.0s 到 1.1s）又来 100 个，0.2 秒内放过 200 个，是限流阈值的 2 倍，后端可能被打爆。令牌桶解决这个——令牌匀速填充（每秒 100 个），桶容量限制突发（如 100），瞬间最多放 100 个，之后按填充速率放行。滑动窗口也解决临界问题，但它统计的是"过去 N 秒的请求数"，不能像令牌桶那样允许突发。漏桶强制匀速输出，适合保护脆弱后端（强制平滑），但不适合有自然波峰的业务。秒杀场景用令牌桶（允许突发），保护 DB 用漏桶（强制匀速）。

**面试官**：集群限流怎么做，有什么坑？

**候选人**：单机令牌桶的问题——假设 10 台网关每台限 100，总限流是 1000，但实际总流量 800 时单机可能已经超 100 被限。集群限流用 Redis + Lua 原子扣减令牌，所有网关实例共享一个计数器。坑有三个：第一，多一次 Redis 往返，QPS 受 Redis 制约（万级，十万级要分片）；第二，Redis 宕机会导致限流失效（要有兜底，如降级到单机限流）；第三，时钟不同步导致令牌填充计算不准（用 Redis 服务端时间）。Sentinel 的集群流控方案是选一台做 Token Server，避免 Redis 往返，但 Token Server 又是单点。生产实践：核心 API 用 Redis 集群限流，非核心用单机限流。

**面试官**：网关挂了怎么办？

**候选人**：网关是单点强依赖，必须高可用。三层兜底：第一层，网关多实例无状态部署，前置 SLB（如阿里 SLB/AWS ALB）做四层负载和健康检查，故障实例秒级摘除。第二层，跨可用区部署（至少 3 个 AZ），防机房级故障——一个 AZ 挂了 SLB 自动切到其他 AZ。第三层，SLB 配置静态降级页，网关全挂时返回"系统繁忙"而不是 502，至少给用户一个友好提示。此外网关本身要做配置热更新（Nacos/Apollo 推送），规则变更不停机；连接池调优（max-connections 要够）；监控 CPU/RT/连接数，峰值不超 70%。

## 常见考点

1. **Spring Cloud Gateway 和 Zuul 区别？**——Zuul 1.x 同步阻塞（Servlet + 每请求一线程），性能低；Zuul 2.x 异步非阻塞（Netty）但 Netflix 内部用得多；SCG 异步非阻塞（Netty + Reactor），Spring 官方主推，性能比 Zuul 1.x 高 50%+，与 Spring Cloud 生态集成最好。
2. **限流算法怎么选？**——固定窗口（简单但有临界突发，不推荐生产）；滑动窗口（平滑，适合大多数场景）；令牌桶（允许突发，适合有波峰的业务如秒杀）；漏桶（强制匀速，适合保护脆弱后端如 DB）。生产用令牌桶最多。
3. **灰度发布怎么保证会话粘连？**——网关首次路由到灰度实例时，响应种 Cookie（如 x-gray=v2），后续请求带该 Cookie 网关固定路由到 v2。否则同一用户一会儿 v1 一会儿 v2 体验割裂（如购物车数据不一致）。也可以用 sticky session（SLB 层按 Cookie hash）。
4. **网关为什么用 Netty 而不是 Tomcat？**——网关是 IO 密集型（大量转发），Tomcat 同步阻塞每请求一线程，万级并发要万级线程（内存和上下文切换扛不住）。Netty 异步非阻塞少量 EventLoop 线程处理大量连接，吞吐量高 10 倍。代价是编程模型复杂（Reactor 链式，调试困难）。


## 结构化回答

**30 秒电梯演讲：** 聊到网关鉴权、路由、限流与灰度发布，我的理解是——网关的本质是"南北向流量的统一策略执行点"——把鉴权、限流、路由、灰度、协议转换这些横切关注点从后端服务剥离，集中在一个数据平面执行。它用"反向代理 + 过滤器链"模型，每个请求按序穿过 Filter Chain，可前置短路（鉴权失败/限流命中直接返回）也可后置处理（响应改写）。打个比方，像写字楼的"大堂安保 + 前台"。访客（请求）先过安保闸机（鉴权）→ 前台登记分流到不同楼层（路由）→ 高峰期货梯限流放行（限流）→ VIP 走专用电梯（灰度）。后端业务（楼层租户）不用关心安保，专心做业务。一旦安保规则变了（鉴权策略调整），只改大堂不用通知每个租户。

**展开框架：**
1. **数据平面（Gateway/Filter）** — 数据平面（Gateway/Filter）与控制平面（配置中心/限流规则中心）分离，规则热更新不停机
2. **限流三算法** — 计数器（固定窗口）、滑动窗口、令牌桶（允许突发）、漏桶（强制匀速）
3. **鉴权前置** — JWT 无状态校验在网关完成，业务服务不再解析 token

**收尾：** 这块我在项目里也踩过坑——想深入的话，可以接着聊：Spring Cloud Gateway 和 Zuul 区别？您更想看哪个方向？

## 视频脚本

> 预计时长：4 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡 | "网关鉴权、路由、限流与灰度发布——这道题面试官到底想考什么？我用 30 秒给你讲透。" | 开场钩子 |
| 0:15 | 限流算法对比图 | 先说核心：网关的本质是"南北向流量的统一策略执行点"——把鉴权、限流、路由、灰度、协议转换这些横切关注点从后端服务剥离，集中在一个数据平面执行。它用"反向代理 + 过滤器链"模型，每个请。 | 核心定义 |
| 0:50 | API 网关架构图 | 计数器（固定窗口）、滑动窗口、令牌桶（允许突发）、漏桶（强制匀速）。 | 限流三算法 |
| 1:20 | 概念结构示意图 | JWT 无状态校验在网关完成，业务服务不再解析 token。 | 鉴权前置 |
| 1:50 | 流程图 | 按 Header/Cookie/IP/UID 路由到灰度实例，金丝雀比例可动态调整。 | 灰度发布 |
| 3:30 | 总结卡 | 一句话记忆：SCG = Route（路由）+ Predicate（断言）+ Filter（过滤器）三要素。 下期可以接着聊：Spring Cloud Gateway 和 Zuul 区别。 | 收尾总结 |
