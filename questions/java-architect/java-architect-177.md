---
id: java-architect-177
difficulty: L3
category: java-architect
subcategory: IM 系统
tags:
- Java 架构师
- IM
- 已读未读
- 多端同步
- BitMap
feynman:
  essence: IM 已读未读的核心是"BitMap 压缩计数 + sequence number 多端同步"。每个会话维护一个 BitMap（每位对应用户是否已读），统计未读数用 BitCount。多端同步靠全局递增的 sequence number，客户端上报 lastSeq，服务端返回 > lastSeq 的消息。
  analogy: 像群通知——班长的本子上每人一栏打勾（BitMap 位图，1=已读 0=未读），数未交作业的人用 BitCount（O(1) 统计位为 0 的数）。多端同步像快递单号——每个包裹有序号（seq），你换手机登录只要说"我收到 100 号"，服务端补发 101 号之后的。
  first_principle: IM 难点是"群消息的写放大"（一条群消息要算 N 个人的未读）。传统做法每人一个计数器（写放大 N 次）。BitMap 反转思路——一个会话一个 BitMap，N 位对应 N 个用户，统计未读用 BitCount O(1)。多端同步靠 sequence number 保证幂等。
  key_points:
  - 已读未读：Redis BitMap（key=conv:read:{convId}，offset=userId）
  - 未读数：BitCount（统计位为 0 的数）+ 会话级未读聚合
  - 多端同步：全局递增 sequence number，客户端上报 lastSeq
  - 消息投递：在线走长连接推送，离线走离线消息表
  - 群消息扩散：写扩散（小群）vs 读扩散（大群）
first_principle:
  problem: 千人群发一条消息，怎么让每个人看到正确的未读数？用户换手机登录怎么同步历史消息？
  axioms:
  - 群消息写扩散：一条消息要更新 N 个人的未读数 = N 次写
  - 多端登录（手机+PC+Web）要消息一致，不能漏不能重
  - 已读状态要实时（秒级同步到其他端）
  - 离线用户的消息不能丢，上线要补发
  rebuild: 用 BitMap 反转——一个会话一个 BitMap（key=conv:read:{convId}，offset=userId），发消息时把所有用户的位清 0（未读），用户读时把自己的位置 1（已读）。未读数 = BitCount 位为 0 的数 O(1)。多端同步靠 sequence number——每条消息有全局递增 seq，客户端上报 lastSeq，服务端返回 seq > lastSeq 的消息。这是增量同步。
follow_up:
  - BitMap 怎么存？——Redis BitMap。SETBIT conv:read:{convId} userId 1（标记已读），GETBIT 查某用户状态，BITCOUNT 统计已读数，未读数 = 群成员数 - 已读数。
  - sequence number 怎么生成？——Redis INCR 全局递增（每条消息一个 seq）。或 Snowflake 改造（时间戳 + 自增）。客户端持久化 lastSeq。
  - 多端怎么同步已读状态？——已读事件走 MQ 广播。某端标记已读后，发 MQ 事件，其他端收到后同步本地未读数。
  - 离线消息怎么存？——离线消息表（user_id, msg_id, seq），用户上线时查 seq > lastSeq 的消息。定期清理 30 天前的。
  - 群消息用写扩散还是读扩散？——小群（< 500 人）写扩散（每人 inbox 推一份），大群读扩散（成员读时实时拉）。
memory_points:
  - 已读未读：BitMap（conv:read:{convId}，offset=userId，1=已读）
  - 未读数：群成员数 - BitCount（已读数）
  - 多端同步：全局 seq，客户端上报 lastSeq，返回 seq > lastSeq
  - 消息投递：在线长连接推，离线消息表补发
  - 群扩散：小群（<500）写扩散，大群读扩散
---

# 【Java 后端架构师】IM 消息已读未读与多端同步

> 适用场景：JD IM（客服/商家沟通/直播私聊）。千人群发一条消息，每个成员要看到正确的未读数。用户手机和 PC 同时登录要消息一致。架构师要设计的是"BitMap 已读未读 + sequence number 多端同步"的 IM 系统。

## 一、概念层：整体架构

```
发消息 → 分配 seq → 存消息表 → 写收件箱（写扩散小群）
                                  ↓
                            更新 BitMap（清 0 标记未读）
                                  ↓
              在线用户：长连接推送 / 离线用户：存离线表
                                  ↓
用户读消息 → SETBIT 标记已读 → 计算未读数 → MQ 广播给其他端

多端同步：客户端上报 lastSeq → 服务端返回 seq > lastSeq 的消息
```

## 二、机制层：BitMap 已读未读

```java
@Service
@Slf4j
public class ReadStatusService {

    private final RedisTemplate<String, String> redis;

    /**
     * 发群消息：把所有成员的已读位置 0（标记未读）
     * BitMap: key=conv:read:{convId}, offset=userId, value=0/1
     */
    public void onMessageSent(String convId, List<Long> memberIds) {
        String key = "conv:read:" + convId;
        // 批量清 0（标记所有人未读）
        redis.executePipelined((RedisCallback<Object>) connection -> {
            for (Long userId : memberIds) {
                connection.stringCommands().setBit(key.getBytes(),
                    userId, false);
            }
            return null;
        });
    }

    /**
     * 用户读消息：把自己的位置 1（标记已读）
     */
    public void markRead(String convId, Long userId) {
        String key = "conv:read:" + convId;
        redis.opsForValue().setBit(key, userId, true);

        // 广播已读事件给其他端
        ReadEvent event = new ReadEvent(convId, userId,
            System.currentTimeMillis());
        mqSend("im-read-event", event);
    }

    /**
     * 查用户在某会话的未读数
     * 未读数 = 群成员数 - 已读数（BitCount）
     */
    public int getUnreadCount(String convId, Long userId) {
        String key = "conv:read:" + convId;
        Long readCount = redis.opsForValue().size(key);    // 已读位数
        Long totalMembers = (long) getMemberCount(convId);
        // 该用户是否已读
        Boolean isRead = redis.opsForValue().getBit(key, userId);
        if (Boolean.TRUE.equals(isRead)) return 0;

        // 未读数 = 该用户收到的消息数 - 已读数（简化：返回消息级未读）
        return getMessageUnread(convId, userId);
    }

    /**
     * 查用户所有会话的总未读数
     */
    public int getTotalUnread(Long userId) {
        List<String> convIds = getUserConvs(userId);
        int total = 0;
        for (String convId : convIds) {
            total += getMessageUnread(convId, userId);
        }
        return total;
    }
}
```

### 消息级未读数（基于 seq）

```java
@Service
public class MessageSeqService {

    /**
     * 用户级 seq：记录用户在该会话已读到的 seq
     * key=user:readseq:{userId}:{convId}
     */
    public void markRead(Long userId, String convId, long readSeq) {
        String key = "user:readseq:" + userId + ":" + convId;
        // CAS 更新（只增不减）
        redis.execute("LUA_MARKREAD", Arrays.asList(key),
            String.valueOf(readSeq));
    }

    /**
     * 未读数 = 会话最大 seq - 用户已读 seq
     */
    public int getUnread(Long userId, String convId) {
        long maxSeq = getConvMaxSeq(convId);
        long readSeq = getUserReadSeq(userId, convId);
        return (int) Math.max(0, maxSeq - readSeq);
    }
}
```

## 三、机制层：sequence number 多端同步

```java
@Service
public class SeqService {

    private final RedisTemplate<String, String> redis;

    /**
     * 分配全局递增 seq（每条消息一个）
     */
    public long nextSeq(String convId) {
        // 会话级 seq（每个会话独立递增）
        return redis.opsForValue().increment("conv:seq:" + convId);
    }

    /**
     * 客户端同步：上报 lastSeq，返回 seq > lastSeq 的消息
     */
    public List<Message> sync(String convId, Long userId, long lastSeq) {
        // 查 seq > lastSeq 的消息
        List<Message> messages = messageRepo.findByConvIdAndSeqGreaterThan(
            convId, lastSeq, 500);   // 最多 500 条

        // 更新客户端的 lastSeq（客户端收到后上报）
        return messages;
    }

    /**
     * 多端登录：每个端独立维护 lastSeq
     * PC 端 lastSeq=100，手机端 lastSeq=105
     * 各自同步各自的增量
     */
    public SyncResponse multiDeviceSync(Long userId, String deviceId,
                                         long lastSeq) {
        // 1. 查该用户所有会话
        List<String> convIds = getUserConvs(userId);

        // 2. 每个会话返回 seq > lastSeq 的消息
        Map<String, List<Message>> result = new HashMap<>();
        for (String convId : convIds) {
            List<Message> msgs = messageRepo.findByConvIdAndSeqGreaterThan(
                convId, lastSeq, 100);
            if (!msgs.isEmpty()) {
                result.put(convId, msgs);
            }
        }

        // 3. 返回新的 maxSeq
        long newMaxSeq = getMaxSeq(result);
        return new SyncResponse(result, newMaxSeq);
    }
}
```

## 四、机制层：消息投递（在线/离线）

```java
@Service
@Slf4j
public class MessageDeliveryService {

    private final SessionManager sessionManager;       // 长连接 session
    private final OfflineMessageRepo offlineRepo;

    /**
     * 投递消息：在线推 + 离线存
     */
    public void deliver(Message message) {
        Long receiverId = message.getReceiverId();

        // 1. 查在线 session（多端）
        List<WebSocketSession> sessions = sessionManager
            .getByUser(receiverId);

        if (sessions.isEmpty()) {
            // 离线：存离线消息表
            offlineRepo.save(new OfflineMessage(message));
            return;
        }

        // 2. 在线：推送到所有端
        for (WebSocketSession session : sessions) {
            try {
                session.sendMessage(new TextMessage(
                    JsonUtils.stringify(message)));
            } catch (IOException e) {
                // 推送失败：存离线
                offlineRepo.save(new OfflineMessage(message));
                sessionManager.remove(session.getId());
            }
        }

        // 3. 记录投递状态（ack 机制）
        message.setDelivered(true);
        messageRepo.save(message);
    }

    /**
     * 用户上线：补发离线消息
     */
    public void onUserOnline(Long userId, WebSocketSession session) {
        List<OfflineMessage> offlineMsgs = offlineRepo.findByUserId(userId);
        for (OfflineMessage msg : offlineMsgs) {
            session.sendMessage(new TextMessage(
                JsonUtils.stringify(msg)));
        }
        offlineRepo.deleteByUserId(userId);
    }
}
```

## 五、机制层：群消息扩散策略

```java
@Service
public class GroupMessageService {

    private static final int WRITE_FANOUT_THRESHOLD = 500;   // 500 人以下写扩散

    /**
     * 群消息：按群大小选写扩散/读扩散
     */
    public void send(GroupMessage message) {
        int memberCount = getMemberCount(message.getGroupId());

        if (memberCount <= WRITE_FANOUT_THRESHOLD) {
            // 小群：写扩散（每人 inbox 推一份）
            writeFanout(message);
        } else {
            // 大群：读扩散（成员读时实时拉）
            readFanout(message);
        }
    }

    /**
     * 写扩散：推到每个成员的 inbox
     */
    private void writeFanout(GroupMessage message) {
        List<Long> memberIds = getMemberIds(message.getGroupId());
        long seq = seqService.nextSeq("conv:" + message.getGroupId());

        // 批量写 inbox（Redis List）
        redis.executePipelined((RedisCallback<Object>) connection -> {
            for (Long memberId : memberIds) {
                String inboxKey = "inbox:" + memberId;
                connection.listCommands().lPush(inboxKey.getBytes(),
                    message.getId().getBytes());
            }
            return null;
        });
    }

    /**
     * 读扩散：只写群 outbox，成员读时拉
     */
    private void readFanout(GroupMessage message) {
        long seq = seqService.nextSeq("conv:" + message.getGroupId());
        message.setSeq(seq);
        messageRepo.save(message);     // 存群消息表
    }
}
```

## 六、底层本质：写放大的数学

群消息的写放大问题：千人群发一条消息，传统做法要更新 1000 个人的未读计数器 = 1000 次写。BitMap 反转思路——一个会话一个 BitMap（1000 位），发消息时不需要更新（默认 0 = 未读），只在用户读时 setBit 1（1 次写）。未读数靠 BitCount 统计。**写从 O(N) 降到 O(1)**。

**seq 多端同步的本质**：每条消息有全局递增 seq，客户端持久化 lastSeq（最后收到的 seq）。同步时上报 lastSeq，服务端返回 seq > lastSeq 的消息。这是**增量同步**——不传全量，只传 delta。多端各自维护 lastSeq，互不干扰。

**为什么 seq 而不是时间戳？** 时间戳有时钟漂移（多机器时钟不同步），可能丢消息（后发的消息时间戳更小）。seq 是全局递增的单调整数，无歧义。客户端只要持久化 lastSeq，换设备登录也能从断点续传。

**写扩散 vs 读扩散的 trade-off**：写扩散（小群）——发消息时推到每人 inbox，读时 O(1) 查 inbox。读扩散（大群）——发消息只存一份，读时 O(1) 查群消息表（按 seq 范围）。小群（< 500）写扩散划算（写 N 次但读快），大群读扩散划算（写 1 次但每次读聚合）。

## 七、AI 工程化深挖

1. **IM 怎么用 AI 做智能客服？** 客服会话接入 LLM——用户消息先过意图识别（售后/物流/商品咨询），简单问题 LLM 直接答，复杂的转人工。LLM 需要知识库（FAQ + 商品信息）做 RAG。监控 ai_resolve_rate（AI 解决率）。

2. **怎么用 LLM 做消息摘要？** 长会话（几百条消息）用户不想全看，LLM 生成摘要（"商家说快递明天到，你问了尺码问题"）。离线批量生成而非实时（省成本）。

3. **怎么用 AI 检测垃圾/诈骗消息？** 规则（关键词）+ LLM 兜底。LLM 判断"是否广告/诈骗/骚扰"。命中的限制发送或封号。注意隐私——LLM 推理前脱敏（手机号/身份证替换）。

4. **怎么用 AI 做消息推荐回复？** 像微信的"快捷回复"——LLM 根据上下文生成 3 个候选回复，用户点选。降低输入成本。监控 suggestion_accept_rate。

5. **客服会话怎么用 AI 提质检？** 传统人工抽检客服对话（1%）。LLM 全量自动质检——判断客服态度/专业度/是否违规。生成质检报告。监控 qa_coverage。

## 八、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"BitMap、seq、扩散、离线"** 四个词。

- **BitMap**：conv:read:{convId}，offset=userId，1=已读，未读数=成员数-BitCount
- **seq**：全局递增，客户端上报 lastSeq，返回 seq > lastSeq 的增量
- **扩散**：小群（<500）写扩散（inbox 推），大群读扩散（outbox 拉）
- **离线**：离线消息表存，上线补发

### 面试现场 60 秒回答

> IM 已读未读我用 BitMap 压缩。每个会话一个 BitMap（key=conv:read:{convId}，offset=userId，1=已读 0=未读）。发群消息时不需要更新（默认 0），用户读时 SETBIT 1（1 次写）。未读数靠 BitCount 统计——写从 O(N) 降到 O(1)。消息级未读用 seq——每条消息有会话级递增 seq，用户已读 seq 存 user:readseq:{userId}:{convId}，未读数 = 会话最大 seq - 用户已读 seq。多端同步靠 seq——客户端持久化 lastSeq，同步时上报，服务端返回 seq > lastSeq 的增量（增量同步，不传全量）。多端各自维护 lastSeq 互不干扰。消息投递：在线走长连接推送所有 session（手机+PC+Web），离线存离线消息表，上线补发。群消息按大小选策略——小群（< 500）写扩散（推每人 inbox，读快），大群读扩散（只存一份，读时拉）。seq 用 Redis INCR 全局递增（不用时间戳有时钟漂移）。已读事件走 MQ 广播给其他端同步未读数。监控 sync_latency、unread_count_accuracy、offline_msg_backlog。

## 九、苏格拉底追问

| 追问 | 证据/答案 |
|------|-----------|
| 千人群发一条消息，传统计数器要写多少次？ | 1000 次（每人一个计数器）。BitMap 只写 0 次（默认未读），读时 setBit 1。 |
| 用户换手机登录怎么不丢消息？ | 客户端持久化 lastSeq。新设备登录上报 lastSeq，服务端返回 seq > lastSeq 的消息补发。 |
| 为什么 seq 不用时间戳？ | 时间戳有时钟漂移（多机器不同步），可能丢消息。seq 单调递增无歧义。 |
| 大群为什么用读扩散？ | 写扩散要推 N 次（万人群 = 万次写），读扩散只存 1 次，读时聚合 O(1)。 |
| 已读状态怎么多端同步？ | 已读事件走 MQ 广播。某端标记已读发 MQ，其他端收到同步本地未读数。 |
| 离线消息存多久？ | 30 天。超期的清理。重要消息可延长到 90 天。 |

## 十、常见考点

1. **已读未读怎么实现？**——BitMap（conv:read:{convId}，offset=userId）。发消息不更新（默认 0=未读），读时 SETBIT 1。未读数 = 成员数 - BitCount。写 O(1)。
2. **多端怎么同步？**——sequence number。每条消息全局递增 seq，客户端持久化 lastSeq，同步上报 lastSeq 返回 seq > lastSeq 的增量。多端各自 lastSeq。
3. **群消息写扩散还是读扩散？**——小群（< 500）写扩散（推 inbox，读快），大群读扩散（存一份，读时拉）。按群大小选。
4. **离线消息怎么处理？**——离线时存离线消息表（user_id, msg_id, seq），上线时查 seq > lastSeq 补发。定期清理 30 天前。
5. **seq 怎么生成？**——Redis INCR 会话级递增。不用时间戳（时钟漂移）。客户端持久化 lastSeq 支持断点续传。

## 结构化回答

**30 秒电梯演讲：** IM 已读未读的核心是BitMap 压缩计数 + sequence number 多端同步。每个会话维护一个 BitMap（每位对应用户是否已读），统计未读数用 BitCount。多端同步靠全局递增的 sequence number，客户端上报 lastSeq，服务端返回 > lastSeq 的消息

**展开框架：**
1. **已读未读** — Redis BitMap（key=conv:read:{convId}，offset=userId）
2. **未读数** — BitCount（统计位为 0 的数）+ 会话级未读聚合
3. **多端同步** — 全局递增 sequence number，客户端上报 lastSeq

**收尾：** 以上是我的整体思路。您想继续深入聊——BitMap 怎么存？


## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：IM 消息已读未读与多端同步 | "这题一句话：IM 已读未读的核心是BitMap 压缩计数 + sequence number 多端同步。" | 开场钩子 |
| 0:15 | 像群通知——班长的本子上每人一栏打勾（BitMa类比图 | "打个比方：像群通知——班长的本子上每人一栏打勾（BitMa。" | 核心类比 |
| 0:40 | 已读未读示意/对比图 | "Redis BitMap（key=conv:read:{convId}，offset=userId）" | 已读未读要点 |
| 1:05 | 未读数示意/对比图 | "BitCount（统计位为 0 的数）+ 会话级未读聚合" | 未读数要点 |
| 1:55 | 总结卡 | "记住：已读未读。下期见。" | 收尾 |
