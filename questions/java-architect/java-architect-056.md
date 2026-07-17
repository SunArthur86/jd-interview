---
id: java-architect-056
difficulty: L2
category: java-architect
subcategory: 供应链
tags:
- Java 架构师
- 库存
- 超卖
- 预占
feynman:
  essence: 库存扣减的核心挑战是"高并发下的超卖防控"——100 个人抢 10 件商品，必须保证只卖 10 件不多卖。Redis Lua 脚本实现原子扣减（CHECK + DEC 一个脚本内完成，无竞态）。预占释放是"超时未支付的库存回收"——下单时预占库存（frozen+1），支付成功确认扣减（frozen-1, available-1），超时未支付释放（frozen-1, available 不变）。
  analogy: 像酒店订房。available 是"空房数"，frozen 是"已预订未入住"。客人下单预订（frozen+1），入住确认（frozen-1, available-1），取消预订（frozen-1）。超卖就是"订出 11 间但只有 10 间"——客人到店没房，是严重事故。
  first_principle: 为什么 MySQL 的 UPDATE WHERE stock>0 不够？因为高并发下多个请求同时读到 stock=1，都判断 >0 都执行 UPDATE，结果 stock 变成负数（超卖）。MySQL 的行锁可以保证串行化（SELECT FOR UPDATE），但性能差。Redis 单线程模型 + Lua 脚本保证原子性（CHECK + DEC 不可分割），性能远优于 DB 行锁。
  key_points:
  - 库存模型：available（可用）+ frozen（预占）+ sold（已售）
  - Redis Lua 原子扣减：if stock >= n then stock -= n return 1 else return 0
  - 预占三阶段：下单预占（frozen+1）→ 支付确认（frozen-1, sold+1）→ 超时释放（frozen-1）
  - 超卖防控：Lua 脚本 CHECK+DEC 原子，DB 兜底 CHECK 约束（stock >= 0）
  - 分桶库存：热点商品库存分到多个 key（stock_1/stock_2），降低单 key 热点
first_principle:
  problem: 秒杀场景下 1000 人抢 10 件商品，如何保证不多卖（超卖）不少卖（库存有但卖不出），且性能高？
  axioms:
  - MySQL UPDATE WHERE stock>0 在高并发下有竞态（同时读到 stock=1 都 UPDATE）
  - Redis 单线程 + Lua 脚本保证原子性（CHECK 和 DEC 不可分割）
  - 库存有"预占"生命周期（下单预占→支付确认/超时释放），不是简单的 -1
  rebuild: Redis Lua 原子扣减。Lua 脚本里 CHECK（stock >= n）+ DEC（stock -= n）一气呵成，Redis 单线程保证不被打断。库存模型用 available + frozen 双字段——下单时 frozen+1（预占），支付成功 frozen-1 + sold+1（确认），超时 frozen-1（释放）。DB 层加 CHECK 约束（stock >= 0）兜底，即使 Redis 异常也不会超卖。热点商品分桶库存（stock_1 到 stock_10），分散单 key 压力。
follow_up:
  - Redis 和 DB 库存怎么同步？——Redis 是主（扣减在 Redis），DB 是从（异步同步）。Redis 扣减后发 MQ，消费方异步更新 DB。对账兜底（定期比对 Redis 和 DB）。
  - 分桶库存怎么设计？——10 件库存分 5 桶（每桶 2 件），key 为 stock_skuId_1 到 stock_skuId_5。扣减时随机选桶，桶空了换下一桶。降低单 key QPS 压力。
  - 预占超时怎么释放？——下单时记录预占时间，定时任务扫超时预占（> 30 分钟），调释放逻辑（frozen-1, available+1）。或用 Redis 的过期事件（key 带 TTL，过期触发释放）。
  - 库存扣减失败（售罄）怎么优雅返回？——Lua 脚本返回 0（库存不足），应用层转"售罄"提示，前端展示"已抢完"。可以引导用户到"相似商品"或"下次开抢"。
  - 分布式库存（多仓）怎么管？——每个仓独立库存（北京仓 100 + 上海仓 200），扣减时按就近原则选仓。跨仓调拨是异步流程。
memory_points:
  - 库存模型：available（可用）+ frozen（预占）+ sold（已售）
  - Redis Lua 原子扣减：if stock >= n then dec else fail
  - 预占三阶段：下单 frozen+1 → 支付确认 frozen-1/sold+1 → 超时释放 frozen-1
  - DB CHECK 约束兜底：stock >= 0
  - 分桶库存：热点商品分多 key 降单点压力
---

# 【Java 后端架构师】库存扣减、超卖防控与预占释放

> 适用场景：JD 核心技术。京东秒杀（如 iPhone 首发）10000 台库存，10 万人抢购。如果用 MySQL UPDATE 扣库存，高并发下行锁竞争严重且可能超卖。Redis Lua 原子扣减是标配——单线程 + 脚本原子性，保证 10000 台不多卖不少卖。

## 一、概念层：库存模型与生命周期

**库存三态模型**：

```
┌──────────────────────────────────────────────────┐
│  总库存 = available + frozen + sold               │
│                                                   │
│  available: 可售卖（用户能下单的）                  │
│  frozen:    预占（已下单未支付，锁定中）            │
│  sold:      已售（已支付确认）                     │
└──────────────────────────────────────────────────┘

库存流转生命周期：
                                                    超时未支付
  ┌─────────┐  下单预占   ┌─────────┐ 支付确认  ┌─────────┐
  │available │ ─────────► │ frozen  │ ────────► │  sold   │
  │ (可用)   │            │ (预占)  │           │ (已售)  │
  └─────────┘            └────┬────┘           └─────────┘
       ▲                      │ 超时释放              │
       │                      │ (30min 未支付)         │ 退款
       └──────────────────────┘                       │
                          frozen 回退 available        ▼
                                                    退款成功：
                                                 sold-1, available+1
```

## 二、机制层：Redis Lua 原子扣减

**Lua 脚本：预占库存**（CHECK + DEC 原子）：

```lua
-- file: deduct_stock.lua
-- KEYS[1]: 库存 key（stock:sku:12345）
-- ARGV[1]: 扣减数量
-- ARGV[2]: 订单ID（用于关联）
-- 返回: 1=成功, 0=库存不足

local stockKey = KEYS[1]
local quantity = tonumber(ARGV[1])
local orderId = ARGV[1]

-- 获取当前可用库存
local available = tonumber(redis.call('GET', stockKey) or '0')

-- 原子检查 + 扣减（关键：CHECK 和 DEC 在同一脚本，不可被其他命令插入）
if available >= quantity then
    -- 库存足够，扣减
    redis.call('DECRBY', stockKey, quantity)
    -- 记录预占明细（用于超时释放）
    redis.call('HSET', 'frozen:' .. orderId, 'sku', stockKey, 'qty', quantity)
    redis.call('EXPIRE', 'frozen:' .. orderId, 1800)   -- 30 分钟过期
    return 1
else
    -- 库存不足
    return 0
end
```

**Java 调用 Lua 脚本**：

```java
@Service
public class InventoryService {

    @Autowired private RedisTemplate redis;
    private DefaultRedisScript<Long> deductScript;

    @PostConstruct
    public void init() {
        deductScript = new DefaultRedisScript<>();
        deductScript.setLocation(new ClassPathResource("lua/deduct_stock.lua"));
        deductScript.setResultType(Long.class);
    }

    /**
     * 预占库存（下单时调用）
     */
    public boolean deduct(String skuId, int quantity, String orderId) {
        String stockKey = "stock:sku:" + skuId;
        Long result = (Long) redis.execute(
            deductScript,
            Collections.singletonList(stockKey),
            String.valueOf(quantity),
            orderId
        );
        if (result == 1L) {
            monitor.record("stock_deduct_success", skuId);
            return true;
        } else {
            monitor.record("stock_deduct_fail_oversell", skuId);
            return false;   // 库存不足
        }
    }

    /**
     * 确认扣减（支付成功时调用）
     * frozen → sold，available 不变（下单时已减）
     */
    public boolean confirm(String orderId) {
        String frozenKey = "frozen:" + orderId;
        Map<Object, Object> frozen = redis.opsForHash().entries(frozenKey);
        if (frozen.isEmpty()) {
            return false;   // 预占已过期或不存在
        }
        // 删除预占记录（已转为 sold）
        redis.delete(frozenKey);
        // sold 计数（可选，用于统计）
        redis.opsForValue().increment("sold:sku:" + frozen.get("sku"),
            Long.parseLong(frozen.get("qty").toString()));
        return true;
    }

    /**
     * 释放库存（取消/超时）
     * frozen → available（加回去）
     */
    public boolean release(String orderId) {
        String frozenKey = "frozen:" + orderId;
        // 用 Lua 原子释放（防止重复释放）
        String script =
            "local frozen = redis.call('HGETALL', KEYS[1]) " +
            "if #frozen == 0 then return 0 end " +              -- 已释放
            "local qty = tonumber(frozen[4]) " +                -- hash 里 qty 的值
            "local sku = frozen[2] " +                          -- hash 里 sku 的值
            "redis.call('INCRBY', 'stock:sku:' .. sku, qty) " + -- 库存加回
            "redis.call('DEL', KEYS[1]) " +                     -- 删预占记录
            "return 1";
        Long result = (Long) redis.execute(
            new DefaultRedisScript<>(script, Long.class),
            Collections.singletonList(frozenKey)
        );
        return result == 1L;
    }
}
```

## 三、机制层：DB 层兜底与分桶库存

**MySQL 兜底 CHECK 约束**（即使 Redis 异常也不超卖）：

```sql
-- 库存表
CREATE TABLE t_inventory (
    sku_id VARCHAR(50) PRIMARY KEY,
    available INT NOT NULL DEFAULT 0,
    frozen INT NOT NULL DEFAULT 0,
    sold INT NOT NULL DEFAULT 0,
    version INT NOT NULL DEFAULT 0,
    -- CHECK 约束：库存不能为负（兜底超卖）
    CHECK (available >= 0 AND frozen >= 0 AND sold >= 0)
);

-- 异步同步 Redis 扣减到 DB（乐观锁）
UPDATE t_inventory
SET available = available - #{qty},
    frozen = frozen + #{qty},
    version = version + 1
WHERE sku_id = #{skuId}
  AND available >= #{qty}        -- DB 层兜底：available 不能变负
  AND version = #{expectedVersion};
-- 如果 available < qty（超卖），affected_rows = 0，报错回滚 Redis
```

**热点商品分桶库存**（降低单 key QPS）：

```java
@Service
public class BucketInventoryService {

    // 热点商品库存分 N 桶，分散单 key 压力
    private static final int BUCKET_COUNT = 10;

    /**
     * 初始化库存：10000 件分 10 桶，每桶 1000
     */
    public void initStock(String skuId, int total) {
        int perBucket = total / BUCKET_COUNT;
        for (int i = 0; i < BUCKET_COUNT; i++) {
            String key = "stock:sku:" + skuId + ":" + i;
            redis.opsForValue().set(key, String.valueOf(perBucket));
        }
    }

    /**
     * 扣减：随机选桶，空了换下一桶
     */
    public boolean deduct(String skuId, int quantity, String orderId) {
        int startBucket = ThreadLocalRandom.current().nextInt(BUCKET_COUNT);
        for (int i = 0; i < BUCKET_COUNT; i++) {
            int bucket = (startBucket + i) % BUCKET_COUNT;   // 轮询所有桶
            String key = "stock:sku:" + skuId + ":" + bucket;
            Long result = (Long) redis.execute(deductScript,
                Collections.singletonList(key),
                String.valueOf(quantity), orderId);
            if (result == 1L) {
                return true;   // 这个桶扣成功
            }
            // 当前桶不足，试下一桶
        }
        return false;   // 所有桶都不足
    }
    // 100 个请求同时扣减，分散到 10 个桶，单桶 QPS 降 10 倍
}
```

## 四、机制层：预占超时释放

**定时任务释放超时预占**：

```java
@Component
public class StockReleaseScheduler {

    @Autowired private InventoryService inventoryService;
    @Autowired private OrderService orderService;

    // 每 1 分钟扫描超时未支付的预占
    @Scheduled(fixedDelay = 60_000)
    public void releaseTimeoutFrozen() {
        // 查询超时预占（下单超过 30 分钟未支付）
        List<Order> timeoutOrders = orderService.findTimeoutFrozen(
            Instant.now().minus(30, ChronoUnit.MINUTES),
            500   // 每批 500 个
        );

        for (Order order : timeoutOrders) {
            try {
                // 释放库存
                boolean released = inventoryService.release(order.getId());
                if (released) {
                    // 取消订单
                    orderService.autoCancel(order.getId(), "超时未支付自动取消");
                    monitor.record("stock_release_timeout", order.getId());
                }
            } catch (Exception e) {
                log.error("释放库存失败: orderId={}", order.getId(), e);
            }
        }
    }
}
```

**Redis 过期事件释放**（替代定时任务）：

```java
// 用 Redis Keyspace Notifications 监听过期事件
@Configuration
public class RedisExpireConfig {
    @Bean
    public RedisMessageListenerContainer container(RedisConnectionFactory factory) {
        RedisMessageListenerContainer container = new RedisMessageListenerContainer();
        container.setConnectionFactory(factory);
        // 监听过期事件
        container.addMessageListener(new KeyExpiredListener(),
            new PatternTopic("__keyevent@0__:expired"));
        return container;
    }
}

public class KeyExpiredListener implements MessageListener {
    @Override
    public void onMessage(Message message, byte[] pattern) {
        String expiredKey = message.toString();
        if (expiredKey.startsWith("frozen:")) {
            String orderId = expiredKey.substring("frozen:".length());
            // 预占过期，触发释放（HSET 里记录了 sku 和 qty）
            // 注意：过期时 hash 可能已被删，要在 Lua 里先 HGET 再 INCRBY 再 DEL
            inventoryService.releaseOnExpire(orderId);
            orderService.autoCancel(Long.parseLong(orderId), "预占过期自动取消");
        }
    }
}
// 优点：实时性好（过期立即释放）；缺点：Redis 重启可能丢事件（要定时任务兜底）
```

## 五、底层本质：原子性是超卖防控的命门

回到第一性：**超卖的根本原因是"CHECK 和 DEC 不原子"——两个请求同时 CHECK 通过（都读到 stock=1），然后都 DEC（stock 变成 -1）**。

- **MySQL UPDATE WHERE stock>0**：看似原子（一条 SQL），但 InnoDB 的行锁机制下，多个事务同时 UPDATE 同一行会串行化（行锁），性能差。且如果用"先 SELECT 再 UPDATE"（应用层逻辑），中间有间隙，必然超卖。
- **MySQL SELECT FOR UPDATE**（悲观锁）：强行串行化，安全但极慢（秒杀场景万级 QPS 不可行）。
- **Redis Lua 脚本**：Redis 单线程执行，Lua 脚本执行期间不被其他命令打断。CHECK（GET stock）和 DEC 在同一脚本，原子完成。性能极高（10 万+ QPS）。

**预占的本质是"乐观锁定"**：下单时不立即扣减真实库存（available），而是预占（frozen）。用户 30 分钟内支付则确认（frozen→sold），超时则释放（frozen→available）。这样避免了"扣减后用户不支付导致库存虚耗"——预占的库存别人不能买（available 不含 frozen），但超时能回收。这是"用时间换确定性"的设计——给用户支付时间，超时回收库存。

**分桶的本质是"降低锁竞争"**：单 key 库存在万级 QPS 下成为热点（Redis 单线程处理，该 key 成为瓶颈）。分 10 桶后，请求分散到 10 个 key，单 key QPS 降 10 倍。类似 ConcurrentHashMap 的分段锁思想——降低并发冲突。

## 六、AI 架构师加问：5 个

1. **用 AI 预测库存热点，怎么做？**
   AI 分析商品的关注度（加购/收藏/页面浏览）、历史销量、营销活动排期。预测某 SKU 将成为热点（秒杀），提前分桶库存 + 预热到 Redis。避免秒杀开始时 DB 被打挂。

2. **AI 辅助库存分配（多仓），怎么做？**
   AI 根据用户地址、各仓库存、物流时效、调拨成本，推荐最优发货仓。用运筹优化算法（如线性规划）求解。但实时扣减走确定性逻辑（就近原则），AI 做批量优化（离线计算调拨计划）。

3. **AI Agent 管库存，怎么防超卖？**
   Agent 的库存操作走标准 Lua 脚本（原子扣减），不能绕过。Agent 做决策（何时补货/调拨），不做扣减（扣减是确定性原子操作）。Agent 的补货建议人工审批后执行。

4. **库存系统接入 RAG，知识库放什么？**
   库存模型文档（available/frozen/sold 三态）、Lua 脚本说明、历史超卖事故分析、多仓调拨规则。AI 查询"为什么库存是负数"时，RAG 返回 CHECK 约束说明+排查步骤。

5. **用 AI 检测超卖风险，怎么做？**
   AI 实时监控 available 字段——如果接近 0 或变负，告警。分析扣减日志，发现"某 SKU 的扣减频率异常高"（可能是刷单/攻击），自动触发限流或下架。用异常检测（Z-score）识别库存异常波动。

## 七、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"Lua 原子扣减、三态库存模型、预占超时释放、分桶降热点"**。

- **Lua 原子**：CHECK（stock>=n）+ DEC 在一脚本，Redis 单线程不打断
- **三态模型**：available（可用）+ frozen（预占）+ sold（已售）
- **预占三阶段**：下单 frozen+1 → 支付确认 frozen-1/sold+1 → 超时释放 frozen-1/available+1
- **DB 兜底**：CHECK 约束 stock >= 0
- **分桶库存**：热点商品分 N key，降单点 QPS

### 面试现场 60 秒回答

> 库存扣减用 Redis Lua 脚本保证原子性——脚本里 CHECK（stock >= quantity）+ DEC（stock -= quantity）一气呵成，Redis 单线程执行不被打断，防超卖。库存三态模型：available（可售卖）+ frozen（预占）+ sold（已售）。下单时预占（available-1, frozen+1），支付成功确认（frozen-1, sold+1），超时 30 分钟未支付释放（frozen-1, available+1）。MySQL 做兜底——CHECK 约束 stock >= 0，即使 Redis 异常 DB 层拒绝负库存。热点商品（秒杀）用分桶库存——10000 件分 10 桶每桶 1000，扣减时随机选桶，单 key QPS 降 10 倍。预占超时释放用定时任务（每分钟扫超时预占）或 Redis 过期事件。最容易翻车的是"先 SELECT 再 UPDATE"——中间间隙导致超卖，必须用 Lua 原子或 DB 乐观锁兜底。

## 八、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不用 MySQL 直接扣减，非要 Redis？ | 用性能说话：MySQL 行锁下单 SKU 千级 QPS（行锁串行化），Redis Lua 10 万+ QPS。秒杀场景 MySQL 扛不住。用 oversell_count（超卖次数，应=0）和 stock_deduct_rt_p99（扣减 RT，应<5ms）量化 |
| 证据追问 | 怎么证明没超卖？ | 压测：1000 并发抢 10 件，断言只成功 10 个；生产监控：oversell_count（超卖次数，必为 0）、stock_deduct_fail_count（库存不足失败数）、reconcile_diff（Redis 和 DB 库存差异，应=0） |
| 边界追问 | Redis 挂了库存怎么办？ | Redis 主从+哨兵保证高可用。极端情况 Redis 宕机，降级到 DB 乐观锁扣减（性能差但不超卖）。或拒绝下单（保护性降级）。Redis 恢复后从 DB 同步库存到 Redis |
| 反例追问 | 什么场景分桶库存没用？ | 库存很少（如 5 件分 10 桶每桶 0-1 件，反而增加跨桶查询）、非热点商品（QPS 低单 key 够用）。分桶只对万级 QPS 的热点商品有效 |
| 风险追问 | 库存系统最大的风险？ | 主动点出：超卖（Lua 脚本 bug 或 Redis 异常）、预占泄漏（超时未释放导致库存虚耗）、Redis-DB 不一致（异步同步丢失）、重复释放（并发释放同一预占） |
| 验证追问 | 怎么验证 Lua 脚本正确？ | 单元测试：mock Redis，验证 CHECK+DEC 原子性（并发 100 线程，断言不超卖）；压力测试：10 万 QPS 扣减，监控 available 不变负；混沌测试：kill Redis，验证降级到 DB 不超卖 |
| 沉淀追问 | 库存系统沉淀什么？ | Lua 脚本库（扣减/确认/释放）、分桶库存框架、库存对账系统（Redis-DB 比对）、预占超时释放框架、超卖监控告警 |

### 现场对话示例

**面试官**：Redis Lua 扣减后，MySQL 怎么同步？

**候选人**：异步同步。Redis 扣减成功后，发 MQ 消息（StockDeductedEvent），消费方异步更新 MySQL。这样 Redis 主导扣减（高性能），MySQL 异步落库（持久化）。问题：异步同步可能延迟或丢失（MQ 消息丢）。兜底措施：第一，定时对账——每 5 分钟比对 Redis 和 MySQL 的库存，差异超过阈值告警并修复（以 Redis 为准，因为 Redis 是主）。第二，T+1 全量对账——每日凌晨跑全量库存比对，发现历史差异。第三，MQ 用事务消息（RocketMQ）保证不丢——扣减和消息发放在同一"事务"（Lua 脚本里 LPUSH 到本地列表，异步任务读列表发 MQ）。极端情况（Redis 和 DB 都异常），以支付网关的实际交易为准（每笔支付对应一次库存扣减，逆向对账）。京东库存的实践：Redis 扣减 + 异步 MQ 同步 DB，每 5 分钟增量对账，T+1 全量对账，对账差异率 < 0.001%。发现差异以 Redis 为准修复 DB（因为 Redis 是扣减的权威源）。

**面试官**：分桶库存扣减时，某桶不足但其他桶有，怎么处理？

**候选人**：轮询所有桶。扣减时随机选起始桶（避免所有请求都从桶 0 开始），如果当前桶库存不足（Lua 返回 0），切到下一桶继续尝试，直到所有桶都试过。这样最大化利用库存——不会因为某桶空了而拒绝请求（其他桶还有）。但有个问题：跨桶查询增加 RT（最坏情况试 10 个桶）。优化：第一，记录每桶的库存水位（本地缓存或 Redis），优先选库存充足的桶。第二，动态均衡——发现某桶空了，后台任务从其他桶"搬运"库存（桶间再平衡），保持各桶水位均匀。第三，桶数不宜过多——10 桶够用（单桶 QPS 降到原来的 1/10），太多桶增加管理复杂度。京东秒杀的实践：10 桶 + 动态均衡，单 SKU 10 万 QPS 下单桶 QPS 1 万，Redis 单实例扛住。

**面试官**：预占释放时，Redis 和 DB 都要释放，怎么保证一致？

**候选人**：释放和扣减一样，Redis 主导。释放逻辑：Lua 脚本里 HGET 预占记录（sku + qty）→ INCRBY available → DEL 预占记录，一气呵成。释放后发 MQ 消息，消费方异步更新 DB（frozen-1, available+1）。注意"重复释放"问题——并发场景下，定时任务和用户主动取消可能同时释放同一预占。Lua 脚本里先判断预占记录是否存在（HGETALL 为空说明已释放），已释放直接返回 0，不重复加库存。DB 层也用乐观锁（WHERE version=旧）兜底。还有一个边界：预占已过期（TTL 到了被 Redis 自动删除），此时用户来支付，发现预占没了。处理：支付回调时检查预占记录，如果不存在（已过期释放），尝试重新扣减（如果还有库存则成功，没库存则触发退款）。京东的实践：预占 TTL 30 分钟，定时任务每分钟扫即将超时的预占提前释放（避免 Redis 过期事件丢失），支付回调时预占不存在则重试扣减。

## 常见考点

1. **Redis 扣减和 DB 扣减哪个是主？**——Redis 是主（扣减实时在 Redis），DB 是从（异步同步）。对账时以 Redis 为准。原因：Redis 性能高，是扣减的执行点；DB 是持久化兜底。
2. **库存扣减和订单创建怎么保证一致？**——先扣库存再创订单（扣失败不创订单）。或用 TCC（Try 预占库存+创建订单草稿 → Confirm 确认 → Cancel 释放）。详见 018 题分布式事务。
3. **多仓库存怎么扣？**——每仓独立库存，扣减时按就近原则选仓（用户地址最近的仓）。跨仓调拨是异步流程（A 仓缺货从 B 仓调）。总库存 = 各分仓之和。
4. **库存预热怎么做？**——秒杀前把库存从 DB 加载到 Redis（避免秒杀开始时 Redis miss 回源 DB 打挂）。预热提前量（如秒杀前 10 分钟），预热后 DB 和 Redis 对账确认一致。

## 结构化回答

**30 秒电梯演讲：** 库存扣减的核心挑战是高并发下的超卖防控——100 个人抢 10 件商品，必须保证只卖 10 件不多卖。Redis Lua 脚本实现原子扣减（CHECK + DEC 一个脚本内完成，无竞态）。预占释放是超时未支付的库存回收——下单时预占库存（frozen+1），支付成功确认扣减（frozen-1, available-1），超时未支付释放（frozen-1, available 不变）

**展开框架：**
1. **库存模型** — available（可用）+ frozen（预占）+ sold（已售）
2. **Redis Lua 原子扣减** — if stock >= n then stock -= n return 1 else return 0
3. **预占三阶段** — 下单预占（frozen+1）→ 支付确认（frozen-1, sold+1）→ 超时释放（frozen-1）

**收尾：** 以上是我的整体思路。您想继续深入聊——Redis 和 DB 库存怎么同步？


## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：库存扣减、超卖防控与预占释放 | "这题一句话：库存扣减的核心挑战是高并发下的超卖防控——100 个人抢 10 件商品，必须保证只卖 10 件不多卖。" | 开场钩子 |
| 0:15 | 库存模型示意/对比图 | "available（可用）+ frozen（预占）+ sold（已售）" | 库存模型要点 |
| 0:40 | Redis Lua 原子扣减示意/对比图 | "if stock >= n then stock -= n return 1 else return 0" | Redis Lua 原子扣减要点 |
| 1:25 | 总结卡 | "记住：库存模型。下期见。" | 收尾 |
