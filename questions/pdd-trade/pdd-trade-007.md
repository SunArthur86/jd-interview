---
id: pdd-trade-007
difficulty: L4
category: pdd-trade
subcategory: 交易架构
tags:
- 拼多多
- 交易
- 秒杀
- 高并发
- 系统设计
feynman:
  essence: 秒杀系统核心是"层层削峰"——前端限流+CDN静态化+Redis 预扣库存+MQ 异步下单+DB 最终一致，把百万瞬时并发转成稳定处理流。
  analogy: 秒杀像演唱会售票——先官网限流（前端）、CDN 缓存（静态）、Redis 抢号（预扣）、后台慢慢出票（异步）。
  first_principle: 秒杀是瞬时极高并发（百万 QPS），单靠后端扛不住，必须从前到后层层削峰。
  key_points:
  - 前端：按钮防抖、答题验证、CDN 静态化
  - 网关：限流（令牌桶）、黑名单
  - Redis：预扣库存（Lua 原子）、防超卖
  - MQ：异步下单（削峰）
  - DB：最终一致（异步落库）
first_principle:
  problem: 百亿补贴秒杀瞬时百万 QPS，如何不超卖、不压垮、用户体验好？
  axioms:
  - 库存有限（秒杀商品少）
  - 瞬时并发极高
  - 不能超卖
  rebuild: 前端削峰 + CDN 静态化 + Redis 预扣 + MQ 异步 + DB 最终一致。
follow_up:
- 怎么防超卖？——Redis Lua 原子扣减（判断+扣减原子）
- 怎么防黄牛？——答题验证、设备指纹、UID 限购
- 库存预热怎么保证准确？——活动开始前从 DB 加载到 Redis + 校验
memory_points:
- 层层削峰：前端→CDN→网关→Redis→MQ→DB
- Redis Lua 原子预扣（防超卖）
- MQ 异步下单（削峰）
- 防黄牛：答题/设备/UID 限购
---

# 【拼多多交易】百亿补贴秒杀怎么设计？

> JD 依据："高并发系统开发"。

## 一、层层削峰架构

```
用户 → CDN（静态资源）
   ↓ 动态请求
网关（限流 + 黑名单）
   ↓
Redis（预扣库存，Lua 原子）
   ↓ 成功
MQ（异步下单，削峰）
   ↓ 消费
订单服务（DB 落库）
   ↓
用户轮询查结果
```

## 二、前端优化

- 按钮防抖（点击后置灰）
- 答题验证（防机器人）
- 页面静态化（CDN 缓存）
- 倒计时（不到点按钮不可点）

## 三、Redis 预扣库存（防超卖核心）

```lua
-- Lua 原子：判断 + 扣减
local stock = tonumber(redis.call("get", KEYS[1]))
local bought = tonumber(redis.call("sismember", KEYS[2], ARGV[1]))  -- 是否买过
if bought == 1 then return -1 end  -- 已抢过
if stock and stock >= 1 then
    redis.call("decr", KEYS[1])
    redis.call("sadd", KEYS[2], ARGV[1])  -- 标记已买
    return 1  -- 成功
end
return 0  -- 售罄
```

## 四、MQ 异步下单

```
Redis 扣减成功 → 发 MQ 消息（含 uid/skuId）
   ↓ 消费者稳定处理（如 1万/s）
订单服务：创建订单 + DB 落库 + 通知用户
```

用户端：抢到"排队中" → 轮询查订单结果（通常 1-3 秒）。

## 五、防黄牛

- UID 限购（每人 1 件，Redis Set 标记）
- 设备指纹（一设备 N 账号拒绝）
- 答题验证（增加机器人成本）
- IP 频控

## 六、底层本质

秒杀本质是**"瞬时洪峰的层层削峰"**——每层过滤一部分，把百万 QPS 转成后端可承受的稳定流。关键是不超卖（Redis Lua 原子）和不压垮（异步削峰）。

## 常见考点
1. **怎么保证不超卖**？——Redis Lua 原子扣减（判断+扣减原子）+ DB 兜底校验。
2. **MQ 消息丢了怎么办**？——Redis 扣减成功但 MQ 丢 → 定时对账补偿。
3. **热点 key 怎么处理**？——分桶（库存拆多份）+ 本地缓存。
