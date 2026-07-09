---
id: pdd-scm-023
difficulty: L4
category: pdd-scm
subcategory: 供应链
tags:
- 拼多多
- 供应链
- 库存中心
- 系统设计
- 高并发
feynman:
  essence: 库存中心是供应链的"账本"，用"Redis 实时扣减 + DB 异步对账 + 分桶防热点"支撑亿级 SKU、高并发扣减，防超卖是底线。
  analogy: 库存中心像银行的账户系统——每个 SKU 一个"账户"（Redis），实时记账（扣减），定期对账（DB），热点账户要分桶（多个子账户分流）。
  first_principle: 库存本质是"可用数量的并发扣减"，Redis 原子操作保证不超卖，DB 做权威对账。
  key_points:
  - Redis 实时扣减（Lua 原子）+ DB 异步持久
  - 多维度库存：现货/预售/在途/冻结
  - 热点 SKU 分桶（100 件拆 10 桶各 10 件）
  - 防超卖：Lua 原子 + 库存校验
first_principle:
  problem: 亿级 SKU、热点 SKU 秒杀万级并发扣减，如何不超卖且高性能？
  axioms:
  - DB 扛不住万级并发写
  - Redis 内存快但需防超卖
  - 热点 SKU 单 key 打爆
  rebuild: Redis Lua 原子扣减 + DB 异步对账 + 热点分桶。
follow_up:
- 热点 SKU 怎么扛？——分桶（库存拆多份，扣减路由不同桶）+ 本地缓存预热
- 库存和 DB 怎么一致？——Redis 扣减成功写 MQ，异步落 DB + 定时对账
- 预售库存怎么算？——独立维度（预售可超卖，按产能补货）
memory_points:
- Redis Lua 原子扣减 + DB 异步持久 + 定时对账
- 库存维度：现货/预售/在途/冻结
- 热点 SKU 分桶（拆多份分散热点）
- 防超卖：Lua 原子 + 库存校验
---

# 【拼多多供应链】设计库存中心（亿 SKU、高并发扣减、防超卖）

> JD 依据："高并发系统开发"。

## 一、库存模型

```
SKU 维度库存:
  可售库存 = 现货库存 - 冻结库存 + 预售库存
  在途库存 = 采购未到货
```

| 类型 | 含义 |
|------|------|
| 现货 | 仓库实际有 |
| 冻结 | 已下单未发货 |
| 预售 | 按产能可超卖 |
| 在途 | 采购在途 |

## 二、整体架构

```
扣减请求 → Redis（Lua 原子扣减）
              ↓ 成功
           MQ（异步）→ DB（持久）+ 库存日志
              ↓
           定时对账（Redis vs DB）
```

## 三、Redis 原子扣减（Lua）

```lua
local stock = tonumber(redis.call("get", KEYS[1]))
if stock and stock >= tonumber(ARGV[1]) then
    redis.call("decrby", KEYS[1], ARGV[1])
    return 1  -- 成功
end
return 0  -- 库存不足
```

Lua 保证"判断+扣减"原子，防超卖。

## 四、热点 SKU 分桶

某爆款秒杀，单 key 被万级并发打爆。**分桶**：
```
SKU=1，库存 1000
  → 拆 10 桶：sku:1:bucket:0..9，各 100
  → 扣减按 uid hash 路由桶
  → 桶不足时从其他桶借调
```

## 五、防超卖的多重保障

1. **Redis Lua**：原子判断+扣减
2. **DB 兜底**：下单时 `UPDATE stock SET qty=qty-1 WHERE qty>=1`（影响行数 0 则失败）
3. **超时回滚**：下单未支付超时，归还冻结库存

## 六、底层本质

库存中心本质是**"高并发下的计数正确性"**：
- Redis 保证实时性（快）+ 原子性（不超卖）
- DB 保证持久性（权威）
- 分桶解决热点（ scalability）

**和银行账户系统同构**——都是"并发记账 + 对账保证一致"。

## 常见考点
1. **Redis 挂了库存怎么办**？——Redis 持久化（AOF）+ DB 兜底校验 + 快速重启从 DB 恢复。
2. **分桶的桶不够怎么办**——动态合并/借调，或单桶直接走 DB（牺牲性能保正确）。
3. **库存负数怎么防**——Lua 扣减前判断 + DB 约束 `CHECK qty >= 0`。
