---
id: pdd-trade-024
difficulty: L4
category: pdd-trade
subcategory: 交易架构
tags:
- 拼多多
- 交易
- 对账
- 财务
- 分布式
feynman:
  essence: 对账系统是"对账平账的离线兜底"——T+1 把平台账（订单/支付）和通道账（微信/支付宝）双向比对，发现差异（长款/短款）自动或人工处理。
  analogy: 对账像"月度查账"——你记的流水和银行对账单比对，多记/少记的标出来，差错处理。
  first_principle: 资金相关不能错，但实时不可能 100% 一致（网络/重试/掉单），需 T+1 兜底。
  key_points:
  - 三方对账：平台订单 ↔ 支付流水 ↔ 通道账单
  - 差错类型：长款（平台有通道无）/短款（通道有平台无）
  - 自动平账：小额自动补/退，大额人工
  - 监控：差错率/未平账金额
first_principle:
  problem: 平台交易和支付通道数据可能不一致（掉单/重试），如何兜底资金正确？
  axioms:
  - 网络有抖动、可能掉单
  - 重试可能导致重复
  - 资金必须准确
  rebuild: T+1 双向对账 + 差错处理 + 自动平账规则。
follow_up:
  - 长款怎么处理？——可能通道延迟，挂账 3 天再退
  - 短款怎么处理？——主动查通道+补单或退款
  - 大促对账怎么做？——增量对账（每小时）+ 全量 T+1
memory_points:
  - 三方对账：订单↔支付↔通道
  - 差错：长款（平台多）/短款（平台少）
  - 自动平账：小额自动/大额人工
  - 监控：差错率/未平账金额
---

# 【拼多多交易】对账系统怎么设计？

> JD 依据："交易系统技术升级"、"基础电商业务架构"。

## 一、对账流程

```
T+1 凌晨：
  1. 下载通道账单（微信/支付宝/银行 SFTP/API）
  2. 抽取平台流水（订单表/支付表）
  3. 双向比对（按订单号/支付号）
  4. 差错处理（自动/人工）
  5. 出对账报表
```

## 二、三方对账

```
平台订单 ──┐
           ├─→ 比对引擎 ──→ 差错表 ──→ 处理
支付流水 ──┤
通道账单 ──┘
```

| 类型 | 表现 | 可能原因 | 处理 |
|------|------|----------|------|
| 平账 | 三方一致 | 正常 | 无 |
| 长款 | 平台有/通道无 | 通道延迟/重复记账 | 挂账观察 |
| 短款 | 通道有/平台无 | 掉单 | 补单/查通道 |
| 金额错 | 金额不一致 | 退款/部分退款 | 退款流水核对 |

## 三、核心代码

```java
public class ReconcileJob {
    public void run(LocalDate day) {
        // 1. 加载三方数据
        List<Order> orders = orderDao.listByDay(day);
        List<PayRecord> pays = payDao.listByDay(day);
        List<ChannelBill> bills = channelDao.listByDay(day);

        // 2. 按支付号 join
        Map<String, PayRecord> payMap = pays.stream()
            .collect(toMap(PayRecord::getTradeNo, p -> p));

        for (ChannelBill bill : bills) {
            PayRecord pay = payMap.get(bill.getTradeNo());
            if (pay == null) {
                saveError(SHORT, bill);  // 短款
            } else if (!pay.getAmount().equals(bill.getAmount())) {
                saveError(AMOUNT_MISMATCH, bill);
            } else {
                markMatched(pay);        // 平账
            }
        }
        // 3. 平台有通道无（长款）
        for (PayRecord pay : pays) {
            if (!bills.contains(pay.getTradeNo())) {
                saveError(LONG, pay);
            }
        }
        // 4. 自动平账规则
        autoResolve();
    }
}
```

## 四、自动平账规则

```
长款 < 1 元：自动忽略（噪声）
长款 1-100 元：挂账 3 天，仍无通道记录则退款
短款：立即查通道 API 确认，确认后补单
金额错：触发退款流水核对
```

## 五、拼多多特色

- **多通道对账**：微信/支付宝/银联/Apple Pay 各有账单格式，统一适配器
- **退款对账**：退款和正向订单分开对（避免混淆）
- **商户分账**：平台抽佣+商户结算，三方（平台/商户/通道）核对
- **大促小时对**：双 11 改成每小时增量对账，T+1 全量兜底

## 六、底层本质

对账本质是**"用离线全量比对兜底实时一致性"**——实时可能有掉单/重复，离线 T+1 全量核对保证资金最终正确。这是分布式系统 CAP 之外的"业务级最终一致"保障。

## 常见考点
1. **大促对账怎么做**？——每小时增量对账+T+1 全量，分布式任务（ElasticJob）扛规模。
2. **对账数据量大怎么办**？——按通道/时间分片并行+Spark 大数据对账。
3. **差错处理 SLA**？——长款挂账 3 天/短款实时告警人工介入/金额差错 1 小时内确认。
