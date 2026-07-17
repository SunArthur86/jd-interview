---
id: java-architect-130
difficulty: L4
category: java-architect
subcategory: 网关设计
tags:
- Java 架构师
- REST
- 幂等
- 错误码
feynman:
  essence: REST 幂等的本质是"同一请求重复执行结果不变"——GET/PUT/DELETE 天然幂等（语义保证），POST 不幂等（需开发者通过 idempotency key 实现）。幂等的工程实现是"客户端生成唯一 key，服务端按 key 去重 + 返回缓存结果"，覆盖网络重试、用户重复点击、消息重投三个场景。错误码体系设计的核心是"错误码是机器可消费的契约"——HTTP status code 表传输层结果，业务 error code 表业务语义，error message 表人类描述。三者分层，机器按 code 路由（重试/降级/告警），人类按 message 排查。
  analogy: 像银行转账。幂等 key 是"交易凭证号"，你拿同一凭证号去银行转账，银行第一次扣款成功，第二次发现凭证号重复直接返回上次结果，不会重复扣。错误码分层是银行的"状态码 + 业务码 + 描述"——状态码（成功/失败/处理中）、业务码（余额不足/账户冻结/超限额）、描述（详细原因）。
  first_principle: 为什么 POST 要专门做幂等？因为 POST 是非幂等的语义（每次创建新资源），但网络层重试不可避免（超时不知道服务端处理没有）。客户端不知道是该重试（怕重复创建）还是放弃（怕丢失请求），idempotency key 让"重试 = 上次结果"成为可能。
  key_points:
  - 天然幂等：GET/PUT/DELETE（语义保证）；POST 不幂等（需 idempotency key）
  - 幂等 key 三种生成方式：UUID、业务唯一键（订单号+操作）、hash(请求体)
  - 幂等三件套：唯一索引兜底 + Redis SETNX 令牌 + 状态机
  - 错误码三层：HTTP status（传输）+ business code（业务）+ message（描述）
  - 错误码版本化：code 字段值稳定不变，message 可演进，新增 code 不能改老的
first_principle:
  problem: 分布式系统中网络重试不可避免，如何让 POST 这类非幂等操作在重试时不出错（不重复扣款、不重复下单）？
  axioms:
  - 网络超时不知道服务端是否处理过，必须假设"可能处理过"
  - 客户端重试是稳定性必需（不能因一次超时放弃）
  - 重复执行的业务后果（重复扣款）严重到必须避免
  rebuild: 客户端为每个写请求生成唯一 idempotency key（如 req_uuid 或 订单号+操作类型），Header 传递；服务端先查 Redis（key → 结果缓存），命中直接返回，未命中执行业务（用唯一索引兜底防并发），执行完写 Redis。这样无论重试多少次都返回第一次的结果。错误码用 HTTP status + business code 分层，机器按 code 路由（5xx 重试、4xx 不重试、业务码判断降级）。
follow_up:
  - 幂等 key 用什么生成？——前端生成 UUID（每次按钮点击生成一个）；或用业务唯一键（订单号+操作类型）；或 hash(请求体)（适合纯函数式 RPC）。
  - Redis 挂了幂等怎么办？——必须用数据库唯一索引兜底（idempotency_key 表 + unique constraint）。Redis 是性能优化，DB 是正确性兜底。
  - 错误码 5xx 都重试吗？——不是。500/502/503 重试，504（网关超时）慎重重试（可能服务端处理了但响应慢）。业务码层面，如 ORDER_LOCKED 这种业务错误不重试。
  - 错误码怎么国际化？——message 不直出，用 i18n key（如 `error.order.locked`），客户端按用户 locale 翻译。错误码本身语言无关。
  - PATCH 幂等吗？——不一定。PATCH 如果是 atomic replace（PUT 语义）幂等；如果是增量操作（如 amount += 10）不幂等。RFC 7396 的 Merge PATCH 也不幂等。
memory_points:
  - GET/PUT/DELETE 天然幂等，POST 必须做幂等
  - 幂等三件套：idempotency key header + Redis SETNX + DB 唯一索引兜底
  - 错误码三层：HTTP status（传输）+ business code（业务）+ message（描述）
  - 5xx 重试、4xx 不重试；业务码判断降级 vs 重试 vs 告警
  - 错误码是契约：code 值稳定，message 可变，新增不改老
---

# 【Java 后端架构师】REST 幂等语义与错误码体系设计

> 适用场景：JD 核心技术。京东支付单笔交易金额动辄上万，用户因网络抖动重复点击"确认支付"或支付网关重试，如果不做幂等会导致重复扣款（用户客诉 + 资损）。错误码体系决定下游（前端、网关、ISV、对账）如何自动处理错误——5xx 自动重试、4xx 不重试、业务码决定降级或告警。

## 一、概念层

**HTTP 方法天然幂等性**（必背）：

| 方法 | 幂等 | 安全（不修改资源） | 说明 |
|------|------|------------------|------|
| GET | ✓ | ✓ | 读，多次执行结果不变 |
| POST | ✗ | ✗ | 创建，每次产生新资源 |
| PUT | ✓ | ✗ | 整体替换，多次执行结果一致 |
| DELETE | ✓ | ✗ | 删除，删除已删除的也是 200/404 |
| PATCH | 不一定 | ✗ | 取决于 patch 语义（replace 幂等，increment 不幂等） |
| HEAD/OPTIONS | ✓ | ✓ | 元数据查询 |

**幂等性三种工程场景**：

```
场景 1：网络重试
  Client ──► POST /pay ──► 超时（不知道服务端处理没有）
    │
    └─► 重试 ──► POST /pay + Idempotency-Key: uuid-1
                            │
                            ▼
              服务端查 Redis：uuid-1 已存在 → 返回上次结果（不重复扣款）

场景 2：用户重复点击
  用户 ──► 点击"确认支付"（生成 uuid-1） ──► 服务端处理中
  用户 ──► 焦虑再点（生成 uuid-2）        ──► 服务端发现 uuid-2 是新 key，但订单已 lock
                                                返回 429 ORDER_IN_PROGRESS

场景 3：消息重投
  MQ ──► 投递 msg_id=abc ──► 消费者处理中
  MQ ──► 重投 msg_id=abc（消费者没 ack） ──► 消费者按 msg_id 幂等跳过
```

## 二、机制层：幂等实现代码

**幂等三件套**（前端 + 服务端 + 数据库兜底）：

```java
// 服务端：幂等拦截器
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class IdempotencyInterceptor implements HandlerInterceptor {

    @Autowired private StringRedisTemplate redis;
    @Autowired private IdempotencyRecordMapper dbMapper;

    private static final String HEADER = "Idempotency-Key";
    private static final String KEY_PREFIX = "idem:";

    @Override
    public boolean preHandle(HttpServletRequest req, HttpServletResponse resp, Object handler) {
        // 1. 只对 POST/PATCH 做幂等
        if (!"POST".equals(req.getMethod()) && !"PATCH".equals(req.getMethod())) {
            return true;
        }

        String idemKey = req.getHeader(HEADER);
        if (StringUtils.isBlank(idemKey)) {
            // 不带 key 的 POST：业务侧自行幂等（如订单号唯一索引），拦截器不强制
            return true;
        }

        // 2. 校验 key 格式（防注入）
        if (!idemKey.matches("^[a-zA-Z0-9\\-]{8,64}$")) {
            resp.setStatus(400);
            throw new BizException("INVALID_IDEMPOTENCY_KEY");
        }

        // 3. Redis 查缓存（处理中 / 已完成）
        String cacheKey = KEY_PREFIX + idemKey;
        String cached = redis.opsForValue().get(cacheKey);
        if (cached != null) {
            IdempotencyRecord record = JSON.parseObject(cached, IdempotencyRecord.class);
            if ("PROCESSING".equals(record.getStatus())) {
                // 上一次还在处理，返回 409 防止并发重复
                resp.setStatus(409);
                throw new BizException("REQUEST_IN_PROGRESS");
            }
            // 已完成，重放原响应
            resp.setStatus(record.getHttpStatus());
            resp.setContentType("application/json");
            resp.getWriter().write(record.getResponseBody());
            return false;  // 不进 controller
        }

        // 4. Redis 没命中，DB 查（兜底，Redis 可能挂）
        IdempotencyRecord dbRecord = dbMapper.selectByIdempotencyKey(idemKey);
        if (dbRecord != null) {
            if ("PROCESSING".equals(dbRecord.getStatus())) {
                resp.setStatus(409);
                throw new BizException("REQUEST_IN_PROGRESS");
            }
            // DB 命中，回填 Redis 并重放
            redis.opsForValue().set(cacheKey, JSON.toJSONString(dbRecord), 24, TimeUnit.HOURS);
            resp.setStatus(dbRecord.getHttpStatus());
            resp.setContentType("application/json");
            resp.getWriter().write(dbRecord.getResponseBody());
            return false;
        }

        // 5. 新请求，标记 PROCESSING，放行
        IdempotencyRecord processing = new IdempotencyRecord();
        processing.setIdempotencyKey(idemKey);
        processing.setStatus("PROCESSING");
        processing.setCreatedAt(new Date());
        try {
            dbMapper.insert(processing);   // DB 唯一索引兜底防并发
        } catch (DuplicateKeyException e) {
            // 并发竞态，另一个线程先插了
            resp.setStatus(409);
            throw new BizException("REQUEST_IN_PROGRESS");
        }
        redis.opsForValue().set(cacheKey, JSON.toJSONString(processing), 24, TimeUnit.HOURS);

        // 用 wrapper 包装 response，拦截 controller 输出存入 DB
        req.setAttribute("idemKey", idemKey);
        return true;
    }

    @Override
    public void afterCompletion(HttpServletRequest req, HttpServletResponse resp,
                                 Object handler, Exception ex) {
        String idemKey = (String) req.getAttribute("idemKey");
        if (idemKey == null) return;

        // 完成（或异常），更新 DB + Redis
        IdempotencyRecord done = new IdempotencyRecord();
        done.setIdempotencyKey(idemKey);
        done.setStatus(ex != null ? "FAILED" : "COMPLETED");
        done.setHttpStatus(resp.getStatus());
        done.setResponseBody(captureBody(resp));
        done.setCompletedAt(new Date());
        dbMapper.updateByIdempotencyKey(done);
        redis.opsForValue().set("idem:" + idemKey,
            JSON.toJSONString(done), 24, TimeUnit.HOURS);
    }
}
```

**DB 唯一索引兜底**（不能少）：

```sql
CREATE TABLE idempotency_record (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    idempotency_key VARCHAR(64) NOT NULL,
    status VARCHAR(20) NOT NULL,    -- PROCESSING / COMPLETED / FAILED
    http_status INT,
    response_body TEXT,
    created_at DATETIME NOT NULL,
    completed_at DATETIME,
    UNIQUE KEY uk_idem_key (idempotency_key)  -- 兜底防并发
);
```

**为什么 Redis + DB 双写**：
- Redis 是性能优化（快速命中，不打 DB）
- DB 唯一索引是正确性兜底（Redis 挂了或缓存击穿）
- DB record 留存 24 小时，超时清理（cron 任务）

## 三、机制层：错误码三层架构

**错误响应标准格式**：

```json
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "code": "ORDER_AMOUNT_INVALID",
  "message": "订单金额必须大于 0",
  "traceId": "trace-abc-123",
  "timestamp": "2026-07-13T10:00:00Z",
  "details": [
    { "field": "amount", "issue": "must_be_positive" }
  ],
  "docUrl": "https://dev.jd.com/errors/ORDER_AMOUNT_INVALID"
}
```

**三层错误码定位**：

| 层 | 含义 | 谁消费 | 例 |
|----|------|--------|-----|
| **HTTP status** | 传输/服务端处理结果 | 网关、客户端 SDK | 200/400/401/404/500/502/503 |
| **business code** | 业务语义（机器路由） | 业务系统、降级框架 | ORDER_NOT_FOUND、BALANCE_INSUFFICIENT |
| **message** | 人类可读描述 | 开发者、用户、客服 | "余额不足" |

**HTTP status 选择策略**：

| status | 含义 | 用法 |
|--------|------|------|
| **200** | 成功 | 业务正常返回 |
| **400** | 客户端错误（参数错） | 业务校验失败 |
| **401** | 未认证 | token 无效或缺失 |
| **403** | 无权限 | 鉴权通过但无权访问 |
| **404** | 资源不存在 | 查询的 ID 不存在 |
| **409** | 冲突 | 资源状态冲突（如重复创建、状态机非法跳转） |
| **422** | 业务校验失败 | 参数格式对但业务规则不通过 |
| **429** | 限流 | rate limit 触发 |
| **500** | 服务端内部错误 | 异常未捕获（应该监控告警） |
| **502** | 网关错误 | 上游服务返回异常 |
| **503** | 不可用 | 服务降级 |
| **504** | 网关超时 | 上游响应超时 |

**业务错误码命名规范**（必背）：

```
<DOMAIN>_<ENTITY>_<REASON>

例：
ORDER_AMOUNT_INVALID              订单金额非法
ORDER_STATUS_ILLEGAL_TRANSITION   订单状态机非法跳转
PAYMENT_BALANCE_INSUFFICIENT      支付余额不足
USER_FROZEN                       用户被冻结
RATE_LIMIT_EXCEEDED               限流
```

**好处**：
- 字符串 code 跨语言稳定（不依赖数字枚举）
- 域前缀方便分类检索（ORDER/PAYMENT/USER）
- 错误码自带文档（code 自解释）

## 四、实战层/选型：客户端重试策略

**重试矩阵**（必背）：

| 场景 | 是否重试 | 重试次数 | 退避策略 |
|------|---------|---------|---------|
| 5xx（500/502/503） | ✓ | 3 次 | 指数退避（1s, 2s, 4s） |
| 504 网关超时 | 慎重 | 1 次 | 5s 后重试一次（防服务端已处理） |
| 429 限流 | ✓ | 5 次 | 看 Retry-After header |
| 408 请求超时 | ✓ | 3 次 | 指数退避 |
| 4xx（除 408/429） | ✗ | 0 | - |
| 业务码 ORDER_NOT_FOUND | ✗ | 0 | - |
| 业务码 BALANCE_INSUFFICIENT | ✗ | 0 | - |
| 业务码 INVENTORY_LOCKED | ✓ | 3 次 | 短退避（100ms, 200ms） |

**Spring Retry 代码**：

```java
@Retryable(
    value = {ResourceAccessException.class, HttpServerErrorException.class},
    maxAttempts = 3,
    backoff = @Backoff(delay = 1000, multiplier = 2, maxDelay = 5000)
)
public Order createOrder(OrderRequest req) {
    HttpHeaders headers = new HttpHeaders();
    headers.set("Idempotency-Key", UUID.randomUUID().toString());  // 每次重试同一 key
    HttpEntity<OrderRequest> entity = new HttpEntity<>(req, headers);
    return restTemplate.postForObject("/orders", entity, Order.class);
}

@Recover
public Order recover(Exception e, OrderRequest req) {
    // 重试用尽，降级
    log.error("Create order failed after retries", e);
    throw new OrderCreateFailedException(req);
}
```

**关键：重试必须带同一 Idempotency-Key**。重试是同一逻辑请求的多次物理调用，必须用同一 key 让服务端去重。所以 key 不能在 `createOrder` 内部生成（每次重试生成新 key），要么外部传入，要么用 req 业务唯一键。

## 五、底层本质：幂等 vs 重试 vs 一致性的关系

回到第一性：**幂等是分布式系统的"重试许可证"**。

- **没有幂等的重试是灾难**：POST /pay 没幂等，重试一次扣两次款。
- **有幂等的重试是稳定的**：POST /pay + Idempotency-Key，重试 N 次都返回第一次结果。
- **幂等的代价是状态存储**：服务端必须存 idempotency key → result 映射（Redis + DB），有存储成本。
- **幂等的边界**：只能解决"重试导致重复执行"，不能解决"业务并发"（如 A 和 B 同时下单抢库存，这是并发控制不是幂等）。

**错误码体系的本质**：错误码是"机器可消费的契约"。
- 早期 RPC 框架（如 Dubbo）用 int code，跨语言但语义模糊。
- 现代 REST 用 HTTP status + 字符串 business code，机器按 status 决定重试/降级，按 code 决定业务处理，按 message 给人看。
- LLM 时代新角色：错误码是 Agent 的"决策信号"——Agent 读 code 自动决定 retry / fallback / ask user。

**错误码 vs 异常**：
- 异常是开发者视角（栈追踪、类型）
- 错误码是接口契约（稳定、可枚举、文档化）
- 一个异常对应一个错误码，但错误码可能对应多个异常实现细节

## 六、AI 架构师加问：5 个

1. **LLM Agent 读错误码做决策，怎么设计？**
   Agent 收到 `429 RATE_LIMIT_EXCEEDED` 自动等 Retry-After 重试；`400 ORDER_AMOUNT_INVALID` 不重试，向用户报告；`503 SERVICE_UNAVAILABLE` 自动切到 fallback provider。错误码就是 Agent 的策略输入。

2. **LLM 自动从异常生成错误码？**
   LLM 读异常类名 + stack trace + 业务上下文，建议错误码命名（如 `PaymentTimeoutException → PAYMENT_TIMEOUT`）和 HTTP status 映射。但要人工 review，避免错误码膨胀。

3. **错误码文档怎么自动生成？**
   枚举类标 javadoc + OpenAPI annotation（`@ApiResponse(responseCode = "400", description = "...")`），用 springdoc 或 redocly 自动渲染成错误码字典网页，跟 OpenAPI 同步。

4. **LLM 怎么辅助幂等设计？**
   LLM 读 controller 代码识别非幂等写操作（POST/PATCH），自动建议加 `@Idempotency` 注解 + Idempotency-Key header 强制；识别并发风险（如先查后写），建议加 DB 唯一索引或分布式锁。

5. **错误码国际化怎么做？**
   message 用 i18n key（如 `error.order.locked`），前端按用户 locale 翻译；docUrl 指向多语言文档站点；code 本身语言无关（英文枚举值）。

## 七、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"GET/PUT/DELETE 天然幂等、POST 三件套、错误码三层"**。

- **天然幂等**：GET/PUT/DELETE，POST/PATCH 必须做
- **幂等三件套**：Idempotency-Key header + Redis SETNX + DB 唯一索引兜底
- **错误码三层**：HTTP status（传输）+ business code（业务）+ message（描述）
- **重试矩阵**：5xx 重试、4xx 不重试、504 慎重、429 看 Retry-After
- **错误码是契约**：code 稳定，message 可变，新增不改老

### 拟人化理解

把幂等想成**银行转账凭证号**。你拿同一凭证号去银行转账，银行第一次扣款成功，第二次发现凭证号重复直接返回上次结果——凭证号 = Idempotency-Key，银行系统 = 服务端去重逻辑。错误码分层是银行的"状态码 + 业务码 + 描述"——状态码（成功/失败/处理中）= HTTP status，业务码（余额不足/账户冻结）= business code，描述（详细原因）= message。机器按状态码和业务码路由（重试/不重试/告警），人按描述排查。

### 面试现场 60 秒回答

> 幂等的本质是"重试许可证"。GET/PUT/DELETE 天然幂等，POST 必须做幂等。我们用三件套：客户端生成 UUID 或用业务唯一键作 Idempotency-Key 放 header，服务端 Redis SETNX 拦截重复 + DB idempotency_record 表唯一索引兜底防并发。处理中标记 PROCESSING，并发同 key 返回 409。错误码三层：HTTP status 表传输结果（5xx 重试、4xx 不重试）、business code 表业务语义（机器按 code 路由降级或告警）、message 表人类描述。重试必须用同一 Idempotency-Key 让服务端去重，否则重试一次扣两次款。错误码是契约——code 值稳定不变，message 可演进，新增不改老。

### 反问面试官

> 贵司的错误码体系是 HTTP status 为主还是 business code 为主？有没有统一的错误码字典？幂等是强制所有 POST 必须做，还是按业务（如支付）选择性做？

## 八、苏格拉底式面试追问（7 层表格 + 现场对话）

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么 GET 幂等 POST 不幂等？ | 用 RFC 7231 语义说话：GET 是 safe method（不修改资源），多次执行副作用为 0；POST 是创建新资源，每次执行副作用不同（产生新 ID） |
| 证据追问 | 怎么证明幂等设计有效？ | 重复请求去重率（Redis 命中率应 > 99%）；重复扣款事故数（应 0）；并发同 key 拦截数（DuplicateKeyException 计数）；压测模拟 1000 并发同 key 应只成功 1 次 |
| 边界追问 | 幂等能解决什么，解决不了什么？ | 解决：重试导致重复执行。解决不了：业务并发（A 和 B 同时抢库存）、长流程的中间状态（钱扣了但下单失败需要补偿） |
| 反例追问 | 什么场景不适合做全局幂等？ | 查询接口（GET 本来幂等）、内部可信调用（不会重试）、低风险写（如点赞，重复点赞靠业务层去重，不值得引入幂等 key 基础设施） |
| 风险追问 | 幂等上线最大风险？ | 主动点出：idempotency_key 表成为热点（高频写入）、Redis 挂了导致幂等失效（必须 DB 兜底）、key 设计不当（用自增 ID 导致重试用新 key 失效） |
| 验证追问 | 怎么验证错误码体系合理？ | 错误码覆盖率（每个异常都有对应 code，不应有 UnknownError 兜底）；错误码文档化（每个 code 有 i18n + 文档页）；机器可消费（SDK 按代码生成枚举） |
| 沉淀追问 | 团队错误码规范沉淀什么？ | 错误码命名规范、错误响应统一格式、HTTP status 选择 SOP、重试矩阵模板、幂等拦截器 starter、错误码字典自动生成流水线 |

### 现场对话示例

**面试官**：用户点了"确认支付"，网络慢他再点一次，怎么保证不重复扣款？

**候选人**：三层防护。第一层，前端按钮防抖——点击后立刻 disable 按钮 + loading，等响应才能再点。这层防"用户焦虑重复点击"。第二层，Idempotency-Key——前端在用户进入支付页时生成一个 uuid，存在 sessionStorage，每次点"确认支付"用同一 key，重试也用同一 key。服务端收到带 key 的请求，先查 Redis（key → 结果），命中 PROCESSING 返回 409 提示"处理中"，命中 COMPLETED 返回上次结果。第三层，DB 兜底——idempotency_record 表 UNIQUE(idempotency_key)，并发同 key 时只有一个 insert 成功，其他抛 DuplicateKeyException 返回 409。即使 Redis 挂了或缓存击穿，DB 唯一索引保证不会重复扣款。这三层叠加，几乎不可能重复扣款。

**面试官**：网络超时了，客户端不知道扣没扣，怎么办？

**候选人**：超时是分布式系统最复杂的场景。客户端策略：用 Idempotency-Key 重试，因为重试 = 上次结果（要么服务端处理完了返回成功，要么没处理完重新执行）。服务端策略：处理支付时记录"开始处理"和"完成"两个时间点，重试请求过来如果服务端处理到一半（钱扣了但订单没更新），返回 409 PROCESSING 让客户端短退避再查。最终一致性兜底：对账系统 T+1 跑，对比支付流水和订单状态，发现差异自动补偿（退款或补单）。所以幂等不是孤立的，要和对账系统配合。

**面试官**：错误码为什么不用数字而用字符串？

**候选人**：三个原因。第一，可读性——`ORDER_AMOUNT_INVALID` 比 `40001` 自解释，开发者读 code 就知道错在哪。第二，跨语言稳定——数字 code 容易冲突（不同团队都从 1000 开始分配），字符串 code 自带命名空间（DOMAIN_ENTITY_REASON）。第三，可演进——字符串 code 可以无歧义新增，数字 code 一旦分配就难调整。OpenAPI/JSON API 规范都推荐字符串。Dubbo 早期用 int 是为了传输效率，现代场景字符串开销可忽略（错误响应本来就不频繁）。

## 常见考点

1. **幂等和分布式锁区别？**——幂等是"重复执行结果不变"（多次调用安全），分布式锁是"同一时刻只有一个执行"（防并发）。幂等防重试，锁防并发。两者常配合：支付接口用幂等防重试 + 锁防同一账户并发。
2. **PATCH 幂等吗？**——不一定。RFC 5789 PATCH 的语义由 Content-Type 决定：JSON Merge Patch（RFC 7396）不幂等（增量操作），JSON Patch（RFC 6902）的 replace 操作幂等。
3. **错误码 422 和 400 区别？**——400 表"请求语法错误"（如 JSON 格式错），422 表"语义错误"（如 amount=负数）。两者都是 4xx，但 422 更精确表达"格式对但业务规则不通过"。
4. **怎么避免错误码爆炸？**——按域+实体+原因三段命名，强制 review；定义常用错误码（INVALID_PARAM、NOT_FOUND、UNAUTHORIZED）复用；少用精细化错误（如不要为每个字段单独定义错误码）。
5. **HTTP status 500 应该重试吗？**——可以但谨慎。500 表"服务端未捕获异常"，可能是 bug 或数据问题，重试不一定有效。建议：未知 500 重试 1 次（防偶发），如果连续 500 告警人工介入。

## 结构化回答

**30 秒电梯演讲：** REST 幂等的本质是同一请求重复执行结果不变——GET/PUT/DELETE 天然幂等（语义保证），POST 不幂等（需开发者通过 idempotency key 实现）。幂等的工程实现是客户端生成唯一 key，服务端按 key 去重 + 返回缓存结果，覆盖网络重试、用户重复点击、消息重投三个场景。错误码体系设计的核心是错误码是机器可消费的契约——HTTP status code 表传输层结果，业务 error code 表业务语义，error message 表人类描述。三者分层，机器按 code 路由（重试/降级/告警），人类按 message 排查

**展开框架：**
1. **天然幂等** — GET/PUT/DELETE（语义保证）；POST 不幂等（需 idempotency key）
2. **幂等 key 三种生成方式** — UUID、业务唯一键（订单号+操作）、hash(请求体)
3. **幂等三件套** — 唯一索引兜底 + Redis SETNX 令牌 + 状态机

**收尾：** 以上是我的整体思路。您想继续深入聊——幂等 key 用什么生成？


## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：REST 幂等语义与错误码体系设计 | "这题核心是——REST 幂等的本质是同一请求重复执行结果不变——GET/PUT/DELETE 天然幂等（语义保……" | 开场钩子 |
| 0:15 | 像银行转账。幂等 key 是交易凭证号，类比图 | "打个比方：像银行转账。幂等 key 是交易凭证号，。" | 核心类比 |
| 0:40 | 天然幂等示意/对比图 | "GET/PUT/DELETE（语义保证）；POST 不幂等（需 idempotency key）" | 天然幂等要点 |
| 1:05 | 幂等 key 三种生成方式示意/对比图 | "UUID、业务唯一键（订单号+操作）、hash(请求体)" | 幂等 key 三种生成方式要点 |
| 1:30 | 幂等三件套示意/对比图 | "唯一索引兜底 + Redis SETNX 令牌 + 状态机" | 幂等三件套要点 |
| 1:55 | 总结卡 | "记住：GET/PUT/DELETE。下期见。" | 收尾 |
