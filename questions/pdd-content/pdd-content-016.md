---
id: pdd-content-016
difficulty: L4
category: pdd-content
subcategory: 直播
tags:
- 拼多多
- 内容
- 直播
- 高并发
- 弹幕
- 推流
feynman:
  essence: 直播系统是"推流（主播端 RTMP）→ 转码（多档位）→ CDN 分发（观众端）+ 信令服务（弹幕/礼物/连麦）"的全链路；技术难点是低延迟、百万并发、弹幕洪峰。
  analogy: 直播像电视台——主播是记者（推流）、转码是剪辑（多档位）、CDN 是信号塔（分发）、弹幕是观众短信（信令）。
  first_principle: 直播核心是"音视频流低延迟分发 + 实时互动信令"，对带宽/延迟/并发要求高。
  key_points:
  - 推流：RTMP/SRT → 中心
  - 转码：HLS/FLV 多档位
  - 分发：CDN 边缘节点
  - 信令：WebSocket 弹幕/礼物/连麦
  - 弹幕削峰：Kafka + 限流 + 聚合
first_principle:
  problem: 怎么让百万观众低延迟看直播+实时互动？
  axioms:
  - 音视频流大（带宽贵）
  - 实时性要求高（<3s）
  - 弹幕洪峰突发
  rebuild: 推流+转码+CDN 分发+信令服务+弹幕削峰。
follow_up:
  - 怎么降延迟？——WebRTC（<500ms）/LL-HLS（2-5s）/RTMP（3-10s）
  - 弹幕怎么削峰？——Kafka+服务端限流+前端节流渲染
  - 直播卡顿怎么排查？——CDN 命中率/带宽/播放端 buffer
memory_points:
  - 推流：RTMP → 中心
  - 转码：HLS/FLV 多档
  - 分发：CDN 边缘
  - 信令：WebSocket
  - 弹幕：Kafka+限流+节流
---

# 【拼多多内容】直播系统架构与弹幕削峰？

> JD 依据："直播短视频"、"高并发大流量"、"IO/多线程/网络"。

## 一、直播全链路

```
                推流                       信令
  ┌────────┐   RTMP/SRT   ┌────────┐   WebSocket   ┌────────┐
  │ 主播端  │ ──────────▶ │ 直播中心 │ ◀──────────▶ │ 观众端  │
  │ 推流 SDK│             │ 转码/录制│              │ 播放器  │
  └────────┘             └────┬─────┘              │ 弹幕 UI │
                              │                    └────────┘
                              ▼ HTTP-FLV/HLS
                       ┌──────────┐
                       │   CDN    │ 边缘节点分发
                       │ 边缘节点  │
                       └──────────┘
```

## 二、核心组件

**1. 推流**：
- 主播端用 SDK（OBS/自研）按 RTMP 协议推流到直播中心
- 协议：RTMP（推流常用）/SRT（弱网好）/WebRTC（连麦超低延迟）

**2. 转码**：
- 一路源流 → 多档位（1080p/720p/480p/360p）适配网络
- 编码：H.264/H.265/AV1
- 协议转换：RTMP → HLS（切片 ts）/HTTP-FLV（流式）

**3. CDN 分发**：
- 观众就近访问边缘节点
- 命中率 >95% 才省钱省带宽

**4. 信令服务**（弹幕/礼物/连麦）：
- 长连接（WebSocket/TCP）
- 消息广播：单直播间百万级订阅

## 三、信令架构（百万并发）

```
观众 ────WebSocket──── 长连接网关（百万级）
                          ↓
                       消息总线（Kafka）  ← 弹幕生产者
                          ↓
                       广播服务（按 liveId 路由）
                          ↓
                       房间订阅树（Redis ZSet 存在线用户）
```

**单直播间弹幕广播**：
```java
// 1. 接收弹幕
@MessageMapping("/danmaku/{liveId}")
public void sendDanmaku(Danmaku d) {
    // 风控+敏感词过滤
    if (auditService.isBlocked(d)) return;
    // 投 Kafka
    kafkaTemplate.send("live-danmaku-" + (d.getLiveId() % 32), d);
}

// 2. 消费 + 广播
@KafkaListener(topicPattern = "live-danmaku-.*")
public void broadcast(Danmaku d) {
    Set<Long> uids = onlineUsers.get(d.getLiveId());
    // 批量推到网关，网关下发到每个连接
    gatewayPusher.broadcast(d.getLiveId(), d);
}
```

## 四、弹幕削峰（关键）

**痛点**：百万直播间×每秒千条弹幕 = 百万 QPS，网关和带宽扛不住。

**多层削峰**：
```
1. 服务端：
   - Kafka 削峰（弹幕先进 MQ）
   - 消费者按容量限速（每秒 N 条）
   - 同类聚合（"哈哈哈"合并显示）
   - 优先级（VIP/付费弹幕优先）

2. 网关：
   - 每个连接限流（用户 N/s）
   - 房间级限流（每房间 M/s 下发）

3. 客户端：
   - 节流渲染（按帧合并）
   - 队列丢弃（旧的丢，新的显）
```

```java
// 房间级限流
RateLimiter limiter = RateLimiter.create(500);   // 每房间 500/s
if (limiter.tryAcquire()) {
    gatewayPusher.broadcast(liveId, danmaku);
} else {
    // 拥挤弹幕提示（不真发）
    gatewayPusher.broadcast(liveId, NoticeMessage.crowded());
}
```

## 五、连麦（超低延迟）

```
主播 A ←─WebRTC─→ 媒体服务器（SFU）←─WebRTC─→ 主播 B
                       ↓
                    混流 → CDN 分发（普通观众看 HLS）
```

WebRTC 走 UDP + SRTP，延迟 <500ms；观众仍走 CDN（成本低）。

## 六、监控

```
质量监控：
  - 推流码率/帧率
  - 转码耗时
  - CDN 命中率
  - 观众端卡顿率/起播时间
  - 端到端延迟

业务监控：
  - 同时在线数（Redis 在线 Set）
  - 弹幕量（Kafka 流量）
  - 礼物收入（事件计数）
```

## 七、底层本质

直播本质是**"音视频流低延迟分发 + 实时互动信令削峰"**——核心是带宽（CDN）+ 延迟（协议选择）+ 并发（信令削峰）。

## 常见考点
1. **怎么降低直播延迟**？——WebRTC/SRT 替代 RTMP；LL-HLS 切片更小。
2. **百万并发弹幕怎么扛**？——长连接网关+Kafka 削峰+限流+客户端节流。
3. **直播录制怎么实现**？——转码旁路录制为切片（ts）→ 合成 MP4 → 对象存储。
