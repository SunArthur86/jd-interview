---
id: java-architect-167
difficulty: L2
category: java-architect
subcategory: 交易架构
tags:
- Java 架构师
- 购物车
- 合并
- 一致性
feynman:
  essence: 购物车架构的核心是"跨端合并 + 按商家分组 + 实时校验"。用户在 App 加购、在 PC 也加购，要合并成一份；不同商家的商品要分组（不同商家不同运费/优惠/发货）。合并逻辑的关键键是 userId+skuId（同一 SKU 合并数量），校验的关键是实时查 SKU 状态（上下架/价格/库存）避免结算时出错。
  analogy: 像超市购物车——你上午推了一车放了牛奶，下午换了个车又放了面包。结账时两个车的商品要合到一起（跨端合并），牛奶和面包按货架分区（商家分组），结账前收银员扫一下条码确认还在卖、价格没变（实时校验）。
  first_principle: 购物车是"用户意图的暂存区"，不是交易数据（没下单前不产生资金/库存变动）。所以存储可用最终一致（Redis 主存 + 异步落 DB），但结算时必须强校验（SKU 状态实时查），因为购物车数据可能过期。
  key_points:
  - 存储选型：Redis Hash 主存（读写快）+ MySQL 异步落盘（持久化）
  - 合并逻辑：同 userId+skuId 合并数量，不同 sku 规格独立存储
  - 商家分组：按 seller_id 分组，影响运费/优惠/拆单
  - 实时校验：结算前查 SKU 状态（上下架/价格/限购/库存）
  - 容量限制：单购物车 SKU 数上限（如 100），防恶意刷
first_principle:
  problem: 用户在多端（App/PC/小程序）加购，如何保证购物车数据一致、合并逻辑正确、结算时不因 SKU 状态变化出错？
  axioms:
  - 购物车数据是"暂存"非"交易"，可用最终一致降低成本
  - 用户跨端加购是常态，必须合并不能各自独立
  - SKU 状态（价格/上下架/库存）可能变化，购物车快照会过期
  - 不同商家的商品运费/优惠/发货不同，必须分组处理
  rebuild: Redis Hash 存购物车（key=cart:userId，field=skuId，value=商品快照），跨端天然共享一份。加购时按 userId+skuId+skuSpec 合并（同规格加数量，不同规格独立条目）。查询时按 seller_id 分组返回前端。结算前实时查 SKU 中心校验状态/价格/限购/库存，过期数据更新或剔除。
follow_up:
  - 未登录购物车怎么处理？——用 device_id 存临时购物车（cart:device:xxx），登录时合并到用户购物车（device 购物车的商品 merge 到 user 购物车，同 skuId 合并数量），合并后清空 device 购物车。
  - 购物车数据放 Redis 还是 MySQL？——Redis 主存（读写快，支持百万级用户同时操作），异步落 MySQL（持久化兜底，Redis 挂了能恢复）。热数据只放 Redis，冷数据（30 天未操作）下沉 MySQL。
  - 加购时要不要锁库存？——不要。购物车只是"意向"，加购不锁库存（否则大量库存被占用）。库存锁定在下单时（创建订单扣减预占库存）。
  - SKU 价格变了购物车怎么显示？——购物车存的是"加购时的价格快照"，展示时实时查 SKU 中心获取当前价格，展示"当前价"并标注"降价/涨价"。结算用当前价，不用快照价。
  - 购物车上限多少？——单车上限 100-200 个 SKU（防恶意刷 + 性能考虑）。超上限提示"已达上限"。
memory_points:
  - 存储：Redis Hash（cart:userId）主存 + MySQL 异步落盘
  - 合并：userId + skuId + skuSpec，同规格加数量，不同规格独立
  - 分组：按 seller_id 分组，影响运费/优惠/拆单
  - 校验：结算前实时查 SKU 状态/价格/限购/库存
  - 未登录：device_id 临时车，登录时 merge 到 user 车
---

# 【Java 后端架构师】电商购物车架构与合并逻辑

> 适用场景：JD 核心技术。用户手机上加了 3 件商品，电脑上又加了 2 件，刷新后应该看到 5 件。不同商家的商品要分组展示（自营/第三方）。购物车里的商品可能已下架或改价，结算前必须校验。架构师要设计的是一套"跨端合并、商家分组、实时校验"的购物车系统。

## 一、概念层：购物车数据模型

```
用户购物车（cart:userId，Redis Hash）
  ├─ skuId=1001 → {skuSpec: "红色64G", quantity: 2, sellerId: S001, addTime: ...}
  ├─ skuId=1001 → {skuSpec: "蓝色128G", quantity: 1, sellerId: S001, addTime: ...}  # 同 SKU 不同规格独立
  ├─ skuId=2002 → {skuSpec: "默认", quantity: 1, sellerId: S002, addTime: ...}
  └─ skuId=3003 → {skuSpec: "默认", quantity: 3, sellerId: S001, addTime: ...}

按商家分组展示：
  商家 S001（自营）：
    - SKU 1001 红色64G × 2
    - SKU 1001 蓝色128G × 1
    - SKU 3003 × 3
  商家 S002（第三方）：
    - SKU 2002 × 1
```

## 二、机制层：加购与合并逻辑

### 2.1 数据结构（Redis Hash）

```java
@Data
public class CartItem {
    private String skuId;
    private String skuSpec;          // 规格标识（红色64G / 蓝色128G）
    private Integer quantity;
    private String sellerId;         // 商家 ID（分组用）
    private Boolean checked = true;  // 是否勾选
    private Long addTime;            // 加购时间（排序用）
    // 注意：不存价格/库存（这些实时查 SKU 中心）
}

// Redis Hash 存储结构
// key: cart:user:{userId}
// field: {skuId}_{skuSpec}（合并键）
// value: CartItem JSON
```

### 2.2 加购合并逻辑

```java
@Service
@Slf4j
public class CartService {

    private final RedisTemplate<String, String> redis;
    private final SkuCenterClient skuClient;

    private static final int MAX_CART_SIZE = 100;

    /**
     * 加购：同 userId + skuId + skuSpec 合并数量
     */
    public void addToCart(String userId, AddCartRequest req) {
        String cartKey = "cart:user:" + userId;
        String fieldKey = req.getSkuId() + "_" + req.getSkuSpec();

        // 1. 容量校验（防恶意刷）
        Long size = redis.opsForHash().size(cartKey);
        if (size >= MAX_CART_SIZE && !redis.opsForHash().hasKey(cartKey, fieldKey)) {
            throw new CartLimitException("购物车已满（上限 " + MAX_CART_SIZE + " 件）");
        }

        // 2. 校验 SKU 状态（加购前查一下是否在售）
        SkuInfo sku = skuClient.getSku(req.getSkuId());
        if (sku == null || !sku.isOnSale()) {
            throw new SkuNotAvailableException("商品已下架");
        }

        // 3. 合并逻辑：同 skuId+skuSpec 合并数量，否则新增
        String existing = (String) redis.opsForHash().get(cartKey, fieldKey);
        CartItem item;
        if (existing != null) {
            // 已存在：合并数量（加购 2 个 + 原有 1 个 = 3 个）
            item = JsonUtils.parse(existing, CartItem.class);
            int newQty = item.getQuantity() + req.getQuantity();
            // 限购校验
            if (sku.getLimitPerUser() != null && newQty > sku.getLimitPerUser()) {
                throw new LimitExceedException("超过限购数量 " + sku.getLimitPerUser());
            }
            item.setQuantity(newQty);
        } else {
            // 新增
            item = new CartItem();
            item.setSkuId(req.getSkuId());
            item.setSkuSpec(req.getSkuSpec());
            item.setQuantity(req.getQuantity());
            item.setSellerId(sku.getSellerId());
            item.setChecked(true);
            item.setAddTime(System.currentTimeMillis());
        }

        // 4. 写入 Redis（field = skuId_spec）
        redis.opsForHash().put(cartKey, fieldKey, JsonUtils.stringify(item));

        // 5. 异步落 MySQL（持久化兜底）
        eventPublisher.publish(new CartUpdatedEvent(userId));
    }
}
```

### 2.3 未登录购物车合并

```java
@Service
public class CartMergeService {

    /**
     * 登录时合并：device 购物车 → user 购物车
     */
    public void mergeOnLogin(String deviceId, String userId) {
        String deviceCartKey = "cart:device:" + deviceId;
        String userCartKey = "cart:user:" + userId;

        Map<Object, Object> deviceItems = redis.opsForHash().entries(deviceCartKey);
        if (deviceItems.isEmpty()) return;

        for (Map.Entry<Object, Object> entry : deviceItems.entrySet()) {
            String fieldKey = (String) entry.getKey();
            CartItem deviceItem = JsonUtils.parse((String) entry.getValue(), CartItem.class);

            String existing = (String) redis.opsForHash().get(userCartKey, fieldKey);
            if (existing != null) {
                // 合并：取较大数量（避免重复加）
                CartItem userItem = JsonUtils.parse(existing, CartItem.class);
                userItem.setQuantity(Math.max(userItem.getQuantity(), deviceItem.getQuantity()));
                redis.opsForHash().put(userCartKey, fieldKey, JsonUtils.stringify(userItem));
            } else {
                redis.opsForHash().put(userCartKey, fieldKey, JsonUtils.stringify(deviceItem));
            }
        }

        // 清空 device 购物车
        redis.delete(deviceCartKey);
        metrics.counter("cart.merge", "device", deviceId).increment();
    }
}
```

## 三、机制层：查询与商家分组

```java
@Service
public class CartQueryService {

    /**
     * 查询购物车：按商家分组返回，实时查 SKU 状态
     */
    public CartView getCart(String userId) {
        String cartKey = "cart:user:" + userId;
        Map<Object, Object> raw = redis.opsForHash().entries(cartKey);

        List<CartItem> items = raw.values().stream()
            .map(v -> JsonUtils.parse((String) v, CartItem.class))
            .sorted(Comparator.comparing(CartItem::getAddTime).reversed())  // 按加购时间倒序
            .collect(toList());

        // 批量查 SKU 实时状态（价格/库存/上下架）
        List<String> skuIds = items.stream().map(CartItem::getSkuId).distinct().collect(toList());
        Map<String, SkuInfo> skuMap = skuClient.batchGet(skuIds);

        // 标记失效商品（下架/无库存）
        List<CartItemView> validItems = new ArrayList<>();
        List<CartItemView> invalidItems = new ArrayList<>();
        for (CartItem item : items) {
            SkuInfo sku = skuMap.get(item.getSkuId());
            CartItemView view = buildView(item, sku);
            if (sku == null || !sku.isOnSale() || sku.getStock() <= 0) {
                view.setInvalid(true);
                view.setInvalidReason(sku == null ? "商品不存在" :
                    !sku.isOnSale() ? "已下架" : "无库存");
                invalidItems.add(view);
            } else {
                view.setInvalid(false);
                validItems.add(view);
            }
        }

        // 按商家分组
        Map<String, List<CartItemView>> bySeller = validItems.stream()
            .collect(groupingBy(CartItemView::getSellerId));

        return CartView.builder()
            .sellerGroups(bySeller.entrySet().stream()
                .map(e -> new SellerGroup(e.getKey(),
                    sellerService.getName(e.getKey()),
                    e.getValue()))
                .collect(toList()))
            .invalidItems(invalidItems)
            .build();
    }
}
```

## 四、机制层：结算前校验

```java
@Service
public class CartCheckoutValidator {

    /**
     * 结算前强校验：防止购物车快照过期导致下单错误
     */
    public CheckoutResult validate(String userId, List<String> selectedFields) {
        String cartKey = "cart:user:" + userId;
        List<CartItem> items = new ArrayList<>();

        for (String field : selectedFields) {
            String json = (String) redis.opsForHash().get(cartKey, field);
            if (json == null) {
                // 购物车已无此项（可能被其他端删除）
                return CheckoutResult.fail("购物车数据已变化，请刷新");
            }
            items.add(JsonUtils.parse(json, CartItem.class));
        }

        // 批量查最新 SKU 状态
        Map<String, SkuInfo> skuMap = skuClient.batchGet(
            items.stream().map(CartItem::getSkuId).collect(toList()));

        for (CartItem item : items) {
            SkuInfo sku = skuMap.get(item.getSkuId());
            if (sku == null || !sku.isOnSale()) {
                return CheckoutResult.fail("商品 " + item.getSkuId() + " 已下架");
            }
            // 价格校验（前端展示的价格可能已变）
            if (sku.getPrice().compareTo(item.getLastSeenPrice()) != 0) {
                return CheckoutResult.priceChanged(sku.getPrice());
            }
            // 库存校验
            if (sku.getStock() < item.getQuantity()) {
                return CheckoutResult.fail("商品 " + item.getSkuId() + " 库存不足");
            }
            // 限购校验
            if (sku.getLimitPerUser() != null && item.getQuantity() > sku.getLimitPerUser()) {
                return CheckoutResult.fail("超过限购数量");
            }
        }

        return CheckoutResult.ok(items);
    }
}
```

## 五、底层本质：购物车是"最终一致的意向暂存区"

购物车和订单系统的本质区别：

| 维度 | 购物车 | 订单 |
|------|--------|------|
| 一致性 | 最终一致（Redis 主存） | 强一致（MySQL + 事务） |
| 持久性 | 可丢（Redis 挂了从 MySQL 恢复） | 不可丢（资金/履约依据） |
| 库存 | 不锁 | 锁定（预占） |
| 价格 | 快照 + 实时查展示 | 下单时锁定 |

**设计启示**：购物车数据用最终一致降低成本（Redis 读写快），但结算时必须强校验（实时查 SKU）。这是"读时校验"（read-time validation）模式——存储时宽松（允许过期数据），使用时严格（使用前验证有效性）。

**跨端合并的本质**：用 userId 作为唯一 key（登录后），Redis 天然共享。不同端（App/PC/小程序）操作同一 Redis key，数据自然一致。未登录用 deviceId 临时存，登录时 merge。

## 六、AI 工程化深挖

1. **怎么用 LLM 优化购物车的"猜你喜欢"？**
   购物车页面有"为你推荐"位。传统用协同过滤（买了 A 的人也买了 B）。LLM 增强：分析购物车里的商品组合，生成"搭配建议"（"你加了牛奶，试试这个麦片"）。但推荐走专门的推荐系统，LLM 只做文案生成。

2. **怎么用 AI 预测购物车转化率？**
   分析购物车数据特征（商品数、价格分布、停留时长、加购到结算间隔），预测转化概率。低转化用户触发营销（优惠券推送）。但这要和增长实验平台结合，做 A/B 验证。

3. **加购时的反欺诈怎么做？**
   异常模式：秒级加购大量 SKU（刷接口）、加购后立即删除（探测系统）、加购天价商品（试探）。规则 + ML 模型识别，触发限流或验证码。监控 add_cart_anomaly_rate。

4. **购物车数据怎么做 RAG？**
   购物车不是 RAG 的典型场景。但"智能导购"可以用 RAG——用户问"这个购物车里的商品能不能一起用优惠券"，LLM 检索优惠规则知识库回答。购物车数据作为 context 喂给 LLM。

5. **AI Agent 帮用户管理购物车怎么保证安全？**
   Agent 修改购物车（加/删/改数量）必须走标准 CartService API，带 userId 权限校验。Agent 不能直改 Redis（绕过校验）。高敏操作（清空购物车）走人工确认。审计记录 Agent 的每次修改。

## 七、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"Hash 存储、规格合并、商家分组、结算校验"** 四个词。

- **Hash 存储**：Redis Hash（cart:userId），field=skuId_spec，跨端共享
- **规格合并**：同 userId+skuId+spec 合并数量，不同 spec 独立
- **商家分组**：按 seller_id 分组，影响运费/优惠/拆单
- **结算校验**：实时查 SKU 状态/价格/库存/限购，防快照过期

### 面试现场 60 秒回答

> 购物车我用 Redis Hash 主存（key=cart:user:userId，field=skuId_skuSpec，value=商品 JSON），跨端（App/PC/小程序）天然共享一份。加购合并逻辑：同 userId+skuId+skuSpec 合并数量（加购 2 个 + 原有 1 个 = 3 个），不同规格独立存储（红色 64G 和蓝色 128G 是两条）。容量上限 100 件防恶意刷。未登录用 device_id 临时车，登录时 merge 到 user 车（同 skuId 取较大数量）。查询时按 seller_id 分组返回（自营/第三方），实时批量查 SKU 中心标记失效商品（下架/无库存）。结算前强校验——实时查 SKU 状态/价格/库存/限购，购物车快照过期则提示刷新。价格展示用当前价不用快照价，标注涨/降价。异步落 MySQL 持久化兜底，Redis 挂了能恢复。加购不锁库存（只是意向），库存锁定在下单时。

## 常见考点

1. **购物车为什么用 Redis 不用 MySQL？**——读写频繁（加/删/改/查），Redis Hash 读写快。MySQL 异步落盘兜底。热数据 Redis，冷数据（长期未操作）下沉 MySQL。
2. **跨端怎么合并？**——登录后用 userId 作 key，多端操作同一 Redis key 自然一致。未登录用 deviceId，登录时 merge。
3. **加购时锁库存吗？**——不锁。购物车是意向不是交易，加购不占库存。锁库存导致大量库存被占用（用户加了不买）。库存锁定在下单时。
4. **购物车商品下架了怎么办？**——查询时实时查 SKU 状态，失效商品单独分组标记"已失效"，不允许结算。用户可一键清失效。

## 结构化回答

**30 秒电梯演讲：** 购物车架构的核心是跨端合并 + 按商家分组 + 实时校验。用户在 App 加购、在 PC 也加购，要合并成一份；不同商家的商品要分组（不同商家不同运费/优惠/发货）。合并逻辑的关键键是 userId+skuId（同一 SKU 合并数量），校验的关键是实时查 SKU 状态（上下架/价格/库存）避免结算时出错

**展开框架：**
1. **存储选型** — Redis Hash 主存（读写快）+ MySQL 异步落盘（持久化）
2. **合并逻辑** — 同 userId+skuId 合并数量，不同 sku 规格独立存储
3. **商家分组** — 按 seller_id 分组，影响运费/优惠/拆单

**收尾：** 以上是我的整体思路。您想继续深入聊——未登录购物车怎么处理？


## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：电商购物车架构与合并逻辑 | "这题一句话：购物车架构的核心是跨端合并 + 按商家分组 + 实时校验。" | 开场钩子 |
| 0:15 | 存储选型示意/对比图 | "Redis Hash 主存（读写快）+ MySQL 异步落盘（持久化）" | 存储选型要点 |
| 0:40 | 合并逻辑示意/对比图 | "同 userId+skuId 合并数量，不同 sku 规格独立存储" | 合并逻辑要点 |
| 1:25 | 总结卡 | "记住：存储。下期见。" | 收尾 |
