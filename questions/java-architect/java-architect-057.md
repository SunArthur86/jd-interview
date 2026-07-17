---
id: java-architect-057
difficulty: L3
category: java-architect
subcategory: 交易架构
tags:
- Java 架构师
- 秒杀
- 热点
- 限流
feynman:
  essence: 秒杀系统的核心矛盾是"瞬时万级 QPS vs 资源有限"——10 万人抢 1000 件手机，99% 的请求必须被快速拒绝（不能进核心链路）。架构三板斧：分层削峰（CDN→网关→应用→DB，每层过滤）、异步化（下单请求进 MQ 异步处理，同步只返回"排队中"）、热点隔离（秒杀独立部署，不连累主站）。核心是"让 99% 的请求在前几层就被挡掉，只有真正能成交的请求才到 DB"。
  analogy: 像演唱会抢票。10 万人抢 5000 张票。第一层保安（CDN/前端）劝退没购票资格的（1 万人被劝退）；第二层闸机（网关）限流——每秒只放 1000 人进（9 万人在门外等）；第三层售票窗口（应用）查库存——有票就卖，没票拒绝；第四层金库（DB）只处理真正成交的。最终 5000 张票卖出，其他 95000 人被层层过滤，金库压力可控。
  first_principle: 为什么不能让所有请求直接打到 DB？因为 DB 的连接池和 CPU 是有限的（单机 MySQL 通常千级 QPS）。10 万 QPS 直接到 DB 会打死 DB，连正常业务（订单查询/商品浏览）也受影响。分层削峰的本质是"用每一层的低成本能力过滤请求"——CDN 挡静态、网关限流、Redis 扣库存，只有真正成交的请求（~1%）才到 DB。
  key_points:
  - 分层削峰：前端（按钮防连点）→ CDN（静态缓存）→ 网关（限流）→ Redis（库存扣减）→ MQ（异步）→ DB
  - 异步化：下单请求进 MQ，同步返回"排队中"，消费方异步处理
  - 热点隔离：秒杀独立部署（独立网关/服务/DB），不连累主站
  - 限流三策略：QPS 限流（令牌桶）、库存预检（Redis）、用户限购（一人一件）
  - 热点 key 问题：单 SKU 万级 QPS 到 Redis 单 key，用分桶库存
first_principle:
  problem: 10 万 QPS 抢 1000 件商品，如何保证 DB 不被打死 + 不超卖 + 公平（先到先得）？
  axioms:
  - DB 单机千级 QPS，10 万 QPS 直达必死
  - 99% 的请求注定失败（库存不足），应该尽早拒绝（降低成本）
  - 库存是唯一真实瓶颈，库存扣减必须在原子存储（Redis）完成
  rebuild: 五层削峰。第 1 层前端（按钮防重复提交+验证码过滤机器人），第 2 层 CDN（静态资源缓存，活动页不走应用），第 3 层网关（令牌桶限流，只放万级 QPS 进应用），第 4 层 Redis（Lua 原子扣库存，扣成功的进 MQ），第 5 层 DB（消费 MQ 异步创单，QPS 可控）。热点商品分桶库存。秒杀全链路独立部署（网关/Redis/服务/MQ/DB 独立），不连累主站。
follow_up:
  - 怎么防黄牛？——一人一件（用户限购）+ 验证码（过滤机器人）+ 设备指纹（同设备多账号拦截）+ 实名认证 + 风控规则（新账号/异地/高频）。
  - 异步下单用户体验怎么做？——用户点"抢购"→同步返回"排队中，N 秒后查看结果"→前端轮询订单状态→成功展示订单，失败展示"已抢完"。
  - 秒杀商品怎么预热？——活动前 10 分钟把库存/商品信息加载到 Redis，预热完成做对账（Redis 库存 = DB 库存）。
  - 库存扣减和 MQ 发送怎么保证一致？——Lua 脚本里同时扣库存 + LPUSH 消息到 Redis 列表，异步任务读列表发 MQ（Outbox 模式）。或用 Redis Stream（扣减和入队原子）。
  - 秒杀链路怎么压测？——全链路压测（造 N 万虚拟用户），验证峰值 QPS、RT、超卖率、成功率。生产环境用影子库影子表（不影响真实数据）。
memory_points:
  - 五层削峰：前端→CDN→网关→Redis→DB
  - 异步化：MQ 削峰，同步返回"排队中"
  - 热点隔离：秒杀独立部署
  - 限流：令牌桶（网关）+ Redis 扣库存（库存预检）
  - 防超卖：Lua 原子 + 分桶库存
---

# 【Java 后端架构师】秒杀系统架构与热点保护

> 适用场景：JD 核心技术。京东双 11 秒杀 iPhone，10 万人抢 1000 台，瞬时 QPS 10 万+。如果用常规架构（请求直达 DB），DB 秒挂，连正常浏览都受影响。秒杀系统的核心是"分层削峰+异步化+热点隔离"，让 99% 的请求在前几层被挡掉。

## 一、概念层：秒杀架构全景

**五层削峰架构**（面试必画）：

```
10 万 QPS 抢购请求
       │
       ▼
┌──────────────────────────────────────────────────────────────┐
│  第 1 层：前端削峰                                             │
│  - 按钮防连点（点击后置灰 3 秒）                                │
│  - 验证码（滑块/点选，过滤机器人，削峰 30%）                    │
│  - 静态页 CDN（商品详情静态化，不走应用）                       │
│  过滤后：~7 万 QPS                                            │
├──────────────────────────────────────────────────────────────┤
│  第 2 层：网关限流                                              │
│  - 令牌桶限流（单 SKU 只放 1 万 QPS 进应用）                   │
│  - 用户级限购（一人一件，查 Redis）                             │
│  - IP 黑名单（刷单 IP 拦截）                                   │
│  过滤后：~1 万 QPS                                            │
├──────────────────────────────────────────────────────────────┤
│  第 3 层：Redis 库存预检（原子扣减）                            │
│  - Lua 脚本：CHECK stock >= 1 then DEC                        │
│  - 扣成功：放行进 MQ                                           │
│  - 扣失败：返回"已抢完"                                        │
│  过滤后：~1000 QPS（只有真有库存的请求）                       │
├──────────────────────────────────────────────────────────────┤
│  第 4 层：MQ 异步削峰                                           │
│  - 扣库存成功的请求进 MQ（RocketMQ）                            │
│  - 同步返回"排队中"                                            │
│  - 消费方按 DB 能力消费（千级 QPS）                             │
├──────────────────────────────────────────────────────────────┤
│  第 5 层：DB 异步创单                                           │
│  - 消费 MQ 创建订单（乐观锁+幂等）                              │
│  - 通知用户（WebSocket/推送）                                   │
│  - DB QPS 可控（千级，不会挂）                                  │
└──────────────────────────────────────────────────────────────┘

最终：10 万 QPS → DB 只承受千级 QPS，不挂；1000 件卖完，不超卖
```

## 二、机制层：网关限流与库存预检

**网关层令牌桶限流**：

```java
@Component
public class SeckillRateLimiter {

    // 每个 SKU 独立令牌桶
    private final Map<String, RateLimiter> skuLimiters = new ConcurrentHashMap<>();

    @PostConstruct
    public void init() {
        // 秒杀 SKU 配置：每秒只放 1 万请求进应用
        configRepo.findSeckillSkus().forEach(sku ->
            skuLimiters.put(sku, RateLimiter.create(10_000))
        );
    }

    public boolean tryAcquire(String skuId) {
        RateLimiter limiter = skuLimiters.get(skuId);
        if (limiter == null) return true;   // 非秒杀商品不限流
        return limiter.tryAcquire();         // 超额返回 false（被限流）
    }
}

// 网关过滤器
@Component
public class SeckillGatewayFilter implements GlobalFilter {

    @Autowired private SeckillRateLimiter limiter;
    @Autowired private RedisTemplate redis;

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
        String path = exchange.getRequest().getPath().value();
        if (!path.startsWith("/seckill/")) return chain.filter(exchange);

        String skuId = parseSkuId(path);
        Long userId = parseUserId(exchange);

        // 1. 用户限购：一人一件
        String userLimitKey = "seckill:user:" + skuId + ":" + userId;
        Boolean firstTry = redis.opsForValue().setIfAbsent(userLimitKey, "1",
            Duration.ofHours(24));
        if (Boolean.FALSE.equals(firstTry)) {
            return reject(exchange, "每人限购一件");
        }

        // 2. QPS 限流
        if (!limiter.tryAcquire(skuId)) {
            monitor.record("rate_limited_count", skuId);
            return reject(exchange, "当前排队人数过多，请稍后重试");
        }

        return chain.filter(exchange);
    }
}
```

**Redis 库存预检**（Lua 原子扣减 + MQ 投递）：

```java
@Service
public class SeckillService {

    @Autowired private RedisTemplate redis;
    @Autowired private RocketMQTemplate mqTemplate;

    private DefaultRedisScript<Long> seckillScript;

    @PostConstruct
    public void init() {
        // Lua 脚本：扣库存 + 入队，原子完成
        String script =
            "local stockKey = KEYS[1] " +
            "local queueKey = KEYS[2] " +
            "local userId = ARGV[1] " +
            "local skuId = ARGV[2] " +
            // 1. 检查库存
            "local stock = tonumber(redis.call('GET', stockKey) or '0') " +
            "if stock <= 0 then return 0 end " +             -- 售罄
            // 2. 扣减库存
            "redis.call('DECR', stockKey) " +
            // 3. 写入队列（供消费方异步创单）
            "redis.call('LPUSH', queueKey, cjson.encode({userId=userId, skuId=skuId, time='" + Instant.now() + "'})) " +
            "return 1";
        seckillScript = new DefaultRedisScript<>(script, Long.class);
    }

    /**
     * 秒杀下单：原子扣库存 + 入队
     */
    public SeckillResult seckill(Long userId, String skuId) {
        String stockKey = "seckill:stock:" + skuId;
        String queueKey = "seckill:queue:" + skuId;

        Long result = (Long) redis.execute(seckillScript,
            Arrays.asList(stockKey, queueKey),
            userId.toString(), skuId);

        if (result == 1L) {
            monitor.record("seckill_success", skuId, userId);
            // 返回"排队中"，用户前端轮询
            return SeckillResult.queuing(generateTicket(userId, skuId));
        } else {
            monitor.record("seckill_sold_out", skuId);
            return SeckillResult.soldOut("已抢完");
        }
    }
}
```

## 三、机制层：异步创单与用户通知

**MQ 异步消费创单**：

```java
@Component
@RocketMQMessageListener(topic = "seckill-order", consumerGroup = "seckill-consumer")
public class SeckillOrderConsumer implements RocketMQListener<SeckillMessage> {

    @Autowired private OrderService orderService;

    @Override
    @Transactional
    public void onMessage(SeckillMessage msg) {
        try {
            // 幂等检查（防重复消费）
            if (orderService.existsBySeckillTicket(msg.getTicket())) {
                return;
            }
            // 创建订单
            Order order = orderService.createSeckillOrder(
                msg.getUserId(), msg.getSkuId(), msg.getSeckillPrice()
            );
            // 通知用户（WebSocket/推送）
            notifyService.send(msg.getUserId(), "抢购成功！订单号: " + order.getId());
            monitor.record("seckill_order_created", order.getId());
        } catch (Exception e) {
            log.error("秒杀创单失败，退还库存", e);
            // 创单失败：退还库存（补偿）
            inventoryService.addBack(msg.getSkuId(), 1);
            notifyService.send(msg.getUserId(), "抢购失败，请重试");
        }
    }
}
```

**前端轮询订单状态**：

```javascript
// 用户点"抢购"后
async function seckill(skuId) {
    // 1. 调秒杀接口（同步返回"排队中"）
    const result = await api.post('/seckill', { skuId });
    if (result.status === 'SOLD_OUT') {
        showToast('已抢完');
        return;
    }
    // 2. 返回"排队中"，前端轮询
    showToast('排队中，请稍候...');
    const ticket = result.ticket;

    // 3. 每 2 秒轮询订单状态，最多 30 秒
    for (let i = 0; i < 15; i++) {
        await sleep(2000);
        const status = await api.get('/seckill/status', { ticket });
        if (status.orderId) {
            // 成功，跳转订单页
            location.href = '/order/' + status.orderId;
            return;
        }
        if (status.failed) {
            showToast('抢购失败');
            return;
        }
    }
    showToast('排队超时');
}
```

## 四、机制层：热点隔离与防刷

**秒杀全链路独立部署**：

```
主站链路（日常业务）              秒杀链路（独立部署）
┌──────────────┐                ┌──────────────┐
│ 主站网关      │                │ 秒杀网关      │ ← 独立网关实例
│ (浏览/搜索)   │                │ (秒杀专用)    │
├──────────────┤                ├──────────────┤
│ 主站服务      │                │ 秒杀服务      │ ← 独立应用实例
├──────────────┤                ├──────────────┤
│ 主站 Redis    │                │ 秒杀 Redis    │ ← 独立 Redis 集群
├──────────────┤                ├──────────────┤
│ 主站 DB       │                │ 秒杀 DB       │ ← 独立 DB 实例
└──────────────┘                └──────────────┘

隔离目的：秒杀流量暴涨时，只打爆秒杀链路，主站正常业务不受影响
秒杀失败降级：秒杀 DB 挂了，主站 DB 不受影响，用户还能正常浏览购物
```

**防黄牛规则链**：

```java
@Service
public class SeckillAntiFraud {

    public FraudResult check(Long userId, String skuId, String deviceFingerprint) {
        // 规则 1：新账号不能秒杀（注册 < 7 天）
        if (userRepo.getAccountAgeDays(userId) < 7) {
            return FraudResult.reject("新账号不可参与秒杀");
        }

        // 规则 2：同设备多账号（黄牛批量注册）
        List<Long> accountsOnDevice = deviceService.findAccounts(deviceFingerprint);
        if (accountsOnDevice.size() > 3) {
            return FraudResult.reject("设备异常");
        }

        // 规则 3：历史秒杀命中率异常（黄牛）
        double hitRate = seckillHistoryService.calcHitRate(userId);
        if (hitRate > 0.8 && seckillHistoryService.getCount(userId) > 10) {
            return FraudResult.challenge("需要人脸验证");
        }

        // 规则 4：异地登录（账号被盗用）
        LoginRecord lastLogin = loginRepo.findLast(userId);
        if (lastLogin != null && isRemoteCity(lastLogin.getCity(), userRepo.getCity(userId))) {
            return FraudResult.challenge("需要短信验证");
        }

        return FraudResult.pass();
    }
}
```

## 五、底层本质：削峰的本质是"用资源换稳定"

回到第一性：**秒杀系统的本质是"用分层资源过滤 99% 注定失败的请求，让有限的 DB 资源只服务 1% 成功的请求"**。

- **前端削峰**：成本最低（浏览器算力，不耗服务端），过滤防连点/机器人。
- **CDN 削峰**：成本极低（静态资源不发到应用），过滤静态请求。
- **网关限流**：成本低（网关内存计算令牌桶），过滤超额流量。
- **Redis 扣库存**：成本中（Redis 单线程但有分桶），过滤没库存的请求。
- **MQ 削峰**：成本中（消息存储），把同步变异步，削平峰值。
- **DB 创单**：成本最高（连接池/CPU/IO），只处理真实成交。

每一层的单位成本递增，处理能力递减。10 万 QPS 经五层削峰，到 DB 只剩千级——DB 能承受。这就是"金字塔削峰"——越往上越宽（处理多），越往下越窄（处理少），底层最贵但负载可控。

**异步化的本质是"解耦请求接收和业务处理"**：用户请求"抢购"，系统同步返回"排队中"（1ms 内），用户感知"已提交"。实际创单在 MQ 消费方异步处理（秒级）。这样即使创单慢（DB 写入），用户也不用等——前端轮询拿结果。代价是用户体验从"即时反馈"变成"延迟反馈"（排队 3-10 秒），但避免了同步等待导致的超时和雪崩。

**热点隔离的本质是"故障域隔离"**：秒杀是高危场景（流量暴涨可能导致系统挂），必须和主站隔离。秒杀链路独立部署（独立网关/Redis/DB），即使秒杀把秒杀 DB 打挂，主站 DB 不受影响——用户还能正常浏览购物。这是"把爆炸控制在局部"的工程实践。

## 六、AI 架构师加问：5 个

1. **用 AI 预测秒杀流量，提前扩容，怎么做？**
   AI 分析商品热度（加购/收藏/浏览）、营销力度、历史秒杀数据，预测 QPS 峰值。预测准确率 > 80% 时提前 30 分钟自动扩容秒杀链路（网关/Redis/服务实例）。预测偏低有风险（扩容不够），偏高浪费资源——AI 持续学习校准。

2. **AI 实时识别黄牛，怎么做？**
   AI 用设备指纹 + 行为序列 + 账号画像综合评分。黄牛的特征：批量注册账号、秒杀命中率异常高、设备指纹聚集、下单后快速转售。AI 用异常检测模型（孤立森林/LOF）识别"偏离正常用户分布"的账号，实时拦截。

3. **AI 辅助动态限流阈值，怎么做？**
   传统令牌桶阈值固定（如 1 万 QPS），AI 根据系统负载（CPU/RT/错误率）动态调整——系统闲时放宽阈值（多放请求进），系统忙时收紧（保护系统）。类似 TCP 拥塞控制的 AIMD（加性增，乘性减）。

4. **秒杀接入 AI 推荐替代固定秒杀页，怎么做？**
   AI 根据用户画像推荐"最可能抢到"的商品（热度低/库存多的优先推荐），提高用户成功率。但这改变了秒杀的"公平性"（AI 干预了抢购对象），需要产品决策。

5. **用 AI 生成秒杀压测流量，怎么做？**
   AI 模拟真实用户行为（浏览→加购→秒杀→支付），生成压测流量。比固定 QPS 压测更真实（覆盖用户行为路径）。压测流量带"压测标"，走影子库影子表不影响真实数据。

## 七、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"五层削峰、异步削峰、热点隔离、Lua 防超卖"**。

- **五层削峰**：前端（防连点）→ CDN（静态）→ 网关（限流）→ Redis（扣库存）→ MQ（异步）→ DB（创单）
- **异步化**：同步返回"排队中"，MQ 异步创单，前端轮询结果
- **热点隔离**：秒杀独立部署（网关/Redis/DB 独立），不连累主站
- **Lua 防超卖**：原子 CHECK+DEC，分桶库存降单 key 压力
- **防黄牛**：新账号拦截 + 设备指纹 + 限购 + 验证码

### 面试现场 60 秒回答

> 秒杀架构核心是五层削峰。第一层前端（按钮防连点+验证码过滤机器人），第二层 CDN（活动页静态化不走应用），第三层网关（令牌桶限流+一人一件限购），第四层 Redis（Lua 原子扣库存，扣成功的进 MQ），第五层 DB（MQ 异步消费创单）。10 万 QPS 经五层削峰到 DB 只剩千级，DB 不会挂。库存扣减用 Redis Lua 脚本——CHECK（stock>=1）+ DEC 原子完成，分桶库存（1000 件分 10 桶）降单 key QPS。异步化削峰——用户点抢购同步返回"排队中"（1ms 内），MQ 异步创单（秒级），前端轮询拿结果。热点隔离——秒杀全链路独立部署（网关/Redis/DB 独立），秒杀打爆不影响主站正常业务。防黄牛四件套：新账号拦截、设备指纹、一人一件、验证码。最关键的是"让 99% 注定失败的请求在前几层被挡掉，只有真成交的 1% 到 DB"。

## 八、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不直接扩容 DB 扛 10 万 QPS？ | 用成本说话：DB 扩容到 10 万 QPS 需要分库分表+大量实例（成本 10 倍+），且秒杀只在高峰期几分钟，平时资源浪费。分层削峰用低成本资源（Redis/MQ）扛峰值，DB 保持经济规模。用 db_qps_peak（DB 峰值 QPS，应 < 5000）和 cost_per_order（单订单成本）量化 |
| 证据追问 | 怎么证明秒杀架构扛得住？ | 全链路压测：造 10 万虚拟用户压测，验证 QPS 峰值/RT/超卖率/成功率；生产监控：rate_limited_count（限流数）、redis_lua_rt_p99（Lua 执行延迟，应 < 5ms）、mq_backlog（MQ 积压）、oversell_count（超卖数，必为 0） |
| 边界追问 | 分层削峰能防所有故障吗？ | 不能。防不了 Redis 宕机（库存数据丢失）、MQ 积压（创单延迟超用户容忍）、网络抖动（请求超时）。这些靠主从+哨兵（Redis 高可用）、消费方扩容（MQ）、重试+降级（网络）兜底 |
| 反例追问 | 什么场景不适合异步化（同步更好）？ | 库存极少的秒杀（5 件），异步排队体验差（用户等很久才知道结果）；B 端抢购（用户少，同步够用）。这些场景同步返回结果更合适 |
| 风险追问 | 秒杀系统最大的风险？ | 主动点出：超卖（Lua 脚本 bug 或 Redis 异常）、MQ 积压（消费方处理慢，用户等太久）、Redis 热点（单 SKU 单 key 打爆）、雪崩（秒杀失败连带主站挂——靠热点隔离防） |
| 验证追问 | 怎么验证不超卖？ | 压测：1000 并发抢 10 件，断言只成功 10 个；生产监控：oversell_count 必为 0；对账：活动结束后 Redis 库存 = 0，DB 订单数 = 初始库存，两者一致 |
| 沉淀追问 | 秒杀系统沉淀什么？ | 五层削峰框架（每层可配置）、Lua 库存脚本库、异步创单框架、防黄牛规则引擎、秒杀监控大盘（QPS/RT/超卖/成功率/限流率） |

### 现场对话示例

**面试官**：秒杀的库存扣减和 MQ 投递怎么保证原子（扣了库存但 MQ 发送失败怎么办）？

**候选人**：用 Outbox 模式。Lua 脚本里同时做两件事——扣库存（DECR）+ 写入 Redis 队列（LPUSH），两者在同一 Lua 脚本内原子完成（Redis 单线程保证不被打断）。然后一个独立的异步任务从 Redis 队列读消息投递到 RocketMQ。投递成功后从队列删除（RPOP），投递失败下次重试。这样"扣库存"和"入队"是原子的（不会扣了库存没入队），"入队"到"投递 MQ"是异步的（即使 MQ 暂时不可用，消息在 Redis 队列里不丢）。极端情况 Redis 宕机——主从复制保证队列数据不丢（Redis 持久化+AOF）。如果 Redis 彻底挂了，降级方案是拒绝秒杀（保护性，不超卖不漏单）。京东秒杀的实践：Redis Stream 替代 List（Stream 支持消费确认，更可靠），Lua 脚本里 XADD 入队 + DECR 扣库存原子，消费方消费成功后 XACK 确认，未确认的消息可重投。

**面试官**：秒杀时 Redis 被打爆（单 SKU 万级 QPS 到单 key），怎么办？

**候选人**：分桶库存。1000 件库存分 10 桶，每桶 100 件，key 为 stock:sku:1234:0 到 stock:sku:1234:9。扣减时随机选起始桶，当前桶不足试下一桶。这样单 key QPS 降到原来的 1/10。Redis 单实例 10 万 QPS 没问题，但单个 key 的命令是串行的（Redis 单线程），该 key 成为瓶颈。分桶后 10 个 key 并行处理，吞吐提升 10 倍。另外可以做"本地缓存预扣"——应用实例本地缓存库存副本（Caffeine），大部分请求在本地预扣成功（不查 Redis），只有本地库存用完才查 Redis。极端情况本地缓存和 Redis 短暂不一致，但通过"本地预扣 + Redis 最终一致 + 超卖 DB 兜底"保证不超卖。京东双 11 的实践：分桶 10 个 + 本地缓存预扣（每实例预分配 50 件），单 SKU 支撑百万 QPS。

**面试官**：用户点抢购后"排队中"等了 10 秒还没结果，怎么处理？

**候选人**：分两种情况。第一种，真的还在排队——MQ 积压，消费方处理慢。前端轮询继续等，但同时后端要扩容消费方实例（加快消费速度）。监控 mq_backlog（积压量），积压超阈值自动扩容。用户侧提示"前方排队 N 人，请耐心等待"。第二种，创单失败了（消费方异常），但没通知用户。消费方 catch 异常时要退还库存 + 发通知（WebSocket/推送）。前端轮询超时（30 秒无结果）后，调"查询订单状态"接口最终确认——如果确实没订单，提示"抢购失败，请重试"。另外要防"假排队"——用户抢到了（库存扣成功）但创单失败（DB 异常），这时库存已扣但订单没建，属于"丢单"。补偿机制：定时对账——Redis 已扣库存但 DB 无订单的记录，自动补单或退还库存。京东秒杀的 SLA：99% 的用户 5 秒内拿到结果，99.9% 的用户 30 秒内拿到结果，超时走补偿。

## 常见考点

1. **秒杀和普通下单架构有什么区别？**——秒杀是"读多写少+瞬时高并发"，核心是削峰（过滤99%请求）；普通下单是"写多+稳定并发"，核心是一致性（事务/幂等）。秒杀用异步化，普通下单用同步。
2. **令牌桶和漏桶限流区别？**——令牌桶允许突发（桶里攒的令牌可瞬间用完），漏桶平滑输出（恒定速率）。秒杀用令牌桶（允许瞬时放一批进，但总量受控）。
3. **秒杀怎么保证公平（先到先得）？**——MQ 是先进先出（FIFO），先扣库存成功的先入队，消费方按顺序创单。但网络延迟可能导致"先到的后入队"，公平性是相对的。绝对公平要用"排队号"（发号器）。
4. **秒杀商品怎么和正常商品共用库存？**——通常秒杀商品独立库存（专供秒杀活动），不和正常销售共用。共用的话秒杀会把库存抢光，正常用户买不到。秒杀活动结束后剩余库存回归正常池。

## 结构化回答

**30 秒电梯演讲：** 秒杀系统的核心矛盾是瞬时万级 QPS vs 资源有限——10 万人抢 1000 件手机，99% 的请求必须被快速拒绝（不能进核心链路）。架构三板斧：分层削峰（CDN→网关→应用→DB，每层过滤）、异步化（下单请求进 MQ 异步处理，同步只返回排队中）、热点隔离（秒杀独立部署，不连累主站）。核心是让 99% 的请求在前几层就被挡掉，只有真正能成交的请求才到 DB

**展开框架：**
1. **分层削峰** — 前端（按钮防连点）→ CDN（静态缓存）→ 网关（限流）→ Redis（库存扣减）→ MQ（异步）→ DB
2. **异步化** — 下单请求进 MQ，同步返回"排队中"，消费方异步处理
3. **热点隔离** — 秒杀独立部署（独立网关/服务/DB），不连累主站

**收尾：** 以上是我的整体思路，您想从哪个角度继续深入？


## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：秒杀系统架构与热点保护 | "这题核心是——秒杀系统的核心矛盾是瞬时万级 QPS vs 资源有限——10 万人抢 1000 件手机，99% ……" | 开场钩子 |
| 0:15 | 像演唱会抢票类比图 | "打个比方：像演唱会抢票。" | 核心类比 |
| 0:40 | 分层削峰示意/对比图 | "前端（按钮防连点）→ CDN（静态缓存）→ 网关（限流）→ Redis（库存扣减）→ MQ（异步）→ DB" | 分层削峰要点 |
| 1:05 | 异步化示意/对比图 | "下单请求进 MQ，同步返回排队中，消费方异步处理" | 异步化要点 |
| 1:55 | 总结卡 | "记住：五层削峰。下期见。" | 收尾 |
