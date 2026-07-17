---
id: java-architect-028
difficulty: L2
category: java-architect
subcategory: Redis
tags:
- 分布式锁
- Redis
- 一致性
feynman:
  essence: Redis 分布式锁的本质是"用 SET NX PX 原子命令实现互斥，用过期时间防死锁，用唯一 value（UUID）+ Lua 原子删锁防误删"。正确性挑战有三个边界：锁超时但业务没完成（别人拿到锁导致并发）、主从切换丢锁（异步复制主库宕机）、GC pause 导致锁失效。RedLock 是 Redisson 提出的多节点多数派方案，但有争议（Martin Kleppmann 批评其依赖时钟假设）。
  analogy: 僉公共洗手间的门锁。SET NX 是"敲门没人就进并锁门"，PX 过期是"自动开门防人晕里面出不来了"，UUID 是"每个人有专属钥匙牌（防开错门）"，Lua 删锁是"确认是自己钥匙牌才开门（防误开）"。锁超时是"人没上完厕所门自动开了，别人冲进来"。RedLock 是"多个洗手间同时锁，多数锁上才算成功"（防止单个洗手间门坏了）。
  first_principle: 为什么用 Redis 做锁？因为 Redis 单线程命令原子（SET NX 互斥）、高性能（微秒级）、有过期机制（防死锁）。相比 Zookeeper（强一致但慢）和 DB 锁（性能差），Redis 在性能和正确性之间平衡，适合"高性能但容忍极小概率错误"的场景。
  key_points:
  - 基础锁：SET key value NX PX 30000（原子命令）
  - 解锁：Lua 脚本（判断 value 相等才删，防误删）
  - 锁超时问题：业务超时 → 锁过期 → 别人拿锁 → 并发
  - 看门狗机制（Redisson）：后台线程定期续期，防业务超时
  - RedLock：多节点多数派（5 节点锁 3 个），争议大
  - 强一致需求用 Zookeeper/etcd（CP），Redis 锁是 AP（容忍极小概率错误）
first_principle:
  problem: 在分布式系统中，如何让多个节点互斥访问共享资源（如扣库存、防重复）？
  axioms:
  - 分布式系统没有真正的互斥（不像单机的 synchronized）
  - 锁要满足：互斥（同一时刻只有一个持有）、防死锁（持有者宕机锁要释放）、可重入（同一线程多次加锁不阻塞）
  - Redis 单线程命令原子，适合实现互斥
  rebuild: 用 SET key value NX PX 实现加锁（NX 保证互斥，PX 过期防死锁），value 用 UUID 标识持有者（防误删）。解锁用 Lua 脚本（判断 value 相等才删，保证原子）。业务超时风险用看门狗（Redisson Watchdog 后台续期）。主从切换丢锁风险用 RedLock（多节点多数派），但 RedLock 有争议（依赖时钟、GC pause 问题）。强一致需求（金融）不用 Redis 锁用 Zookeeper/etcd（CP），Redis 锁适合"高性能但容忍极小概率错误"的场景（如防重复提交、限频）。
follow_up:
  - 为什么解锁要 Lua 脚本？——因为"判断 value 相等"和"删除 key"必须是原子的。如果分开（先 GET 判断再 DEL），中间可能锁过期别人拿了新锁，你的 DEL 把别人的锁删了（误删）。Lua 脚本在 Redis 单线程执行保证原子
  - Redisson 看门狗怎么工作？——加锁时启动一个定时任务（每 1/3 TTL 时间，如 TTL 30s 则每 10s），检查业务是否还在执行，是则续期（重置 TTL 到 30s）。业务完成后关闭定时任务。防止业务执行超过 TTL 导致锁过期
  - RedLock 为什么有争议？——Martin Kleppmann 指出两个问题：①依赖时钟假设（锁过期判断依赖各节点时钟一致，NTP 同步有误差）；②GC pause（应用 STW 期间锁过期，恢复后误以为自己还持锁）。Antirez（Redis 作者）反驳说实践中时钟误差可控、GC pause 可避免。学术界无定论，生产慎用 RedLock
  - Redis 锁和 Zookeeper 锁区别？——Redis 锁是 AP（高性能但容忍极小概率错误），主从异步复制可能丢锁。Zookeeper 锁是 CP（强一致），通过临时节点 + Watch 实现锁，客户端宕机临时节点自动删除（无锁过期问题），但性能比 Redis 低
  - 可重入锁怎么实现？——Redisson 用 Hash 结构存锁：key=锁名，field=线程 ID，value=重入次数。同一线程加锁 value+1，解锁 value-1，归零删 key。保证同一线程多次加锁不阻塞
memory_points:
  - 基础锁：SET key uuid NX PX 30000（原子加锁 + 过期防死锁）
  - 解锁：Lua 脚本（判断 value 相等才删，原子防误删）
  - 看门狗：Redisson 后台续期，防业务超时
  - RedLock：多节点多数派，有争议（时钟+GC）
  - 选型：高性能容忍小概率错误用 Redis，强一致用 ZK/etcd
---

# 【Java 后端架构师】Redis 分布式锁的正确性与 RedLock 争议

> 适用场景：JD 核心技术。秒杀扣库存、防重复下单、定时任务防重复执行，都需要分布式锁。锁实现错误就是超卖或重复扣款。架构师必须能写正确的 Redis 锁（Lua 解锁、看门狗续期）、理解 RedLock 争议边界、知道什么场景该用 Redis 锁什么场景该用 ZK。

## 一、概念层：分布式锁的要求

**分布式锁三个基本要求**（必背）：

| 要求 | 含义 | 实现 |
|------|------|------|
| **互斥（Mutual Exclusion）** | 同一时刻只有一个客户端持有锁 | SET NX（不存在才设置） |
| **防死锁（Deadlock Free）** | 持有者宕机，锁要能自动释放 | PX 过期时间 |
| **容错（Fault Tolerance）** | 锁服务部分宕机仍能工作 | RedLock 多节点 / ZK 集群 |

**进阶要求**：

| 要求 | 含义 | 实现 |
|------|------|------|
| **解铃还须系铃人** | 谁加的锁谁解（防误删） | value=UUID + Lua 判断 |
| **可重入** | 同一线程多次加锁不阻塞 | Hash 存线程 ID + 重入次数 |
| **公平性** | 按请求顺序获取锁 | 队列实现（Redis 锁默认非公平） |

## 二、机制层：Redis 锁的演进

**第一代：SETNX + EXPIRE（错误，非原子）**

```bash
# 错误示例：SETNX 和 EXPIRE 分两步
SETNX lock:1 "holder"    # 加锁
EXPIRE lock:1 30          # 设过期
# 问题：如果 SETNX 后宕机（没来得及 EXPIRE），锁永不释放（死锁）
```

**第二代：SET NX PX（正确，原子）**

```bash
# Redis 2.6.12+ 支持 SET 的 NX + PX 原子命令
SET lock:1 "holder-uuid" NX PX 30000
# NX：不存在才设置（互斥）
# PX 30000：过期 30 秒（防死锁）
# 原子执行，不会出现"加了锁没设过期"的问题
```

```java
// Java 实现
String lockValue = UUID.randomUUID().toString();
Boolean locked = redisTemplate.opsForValue()
    .setIfAbsent("lock:1", lockValue, 30, TimeUnit.SECONDS);
if (locked != null && locked) {
    try {
        // 业务逻辑
    } finally {
        // 解锁（Lua 脚本，原子）
        unlock("lock:1", lockValue);
    }
}
```

**第三代：Lua 原子解锁（防误删）**

```java
// 解锁必须用 Lua 脚本（判断 value 相等才删）
private static final String UNLOCK_SCRIPT =
    "if redis.call('get', KEYS[1]) == ARGV[1] then " +
    "  return redis.call('del', KEYS[1]) " +
    "else return 0 end";

public boolean unlock(String key, String value) {
    Long result = redisTemplate.execute(
        new DefaultRedisScript<>(UNLOCK_SCRIPT, Long.class),
        Collections.singletonList(key),
        value);
    return result != null && result > 0;
}
```

**为什么解锁要 Lua**（画图理解）：

```
错误示例（先 GET 判断再 DEL）：
  T1: GET lock:1 → "uuid-1"（是自己的）
  ── 此时锁过期，T2 拿到锁 ──
  T2: SET lock:1 "uuid-2" NX PX 30000 → 成功
  T1: DEL lock:1 → 删了 T2 的锁！（误删）

正确（Lua 原子）：
  T1: 执行 Lua：GET 判断 == "uuid-1"？是 → DEL（原子，中间不会插入 T2）
  ── 单线程 Redis 保证 Lua 执行期间无其他命令 ──
```

## 三、机制层：锁超时与看门狗

**锁超时问题**（核心风险）：

```
场景：业务执行超过锁 TTL
  T1: 加锁 lock:1 TTL=30s
  T1: 业务执行（耗时 40s）
  ── 第 30s 锁过期 ──
  T2: 加锁 lock:1 成功（T1 的锁已过期）
  T2: 业务执行
  ── 现在 T1 和 T2 都在执行，锁失效！──
  T1: 业务完成，解锁（Lua 判断 value，T1 的 value 已被 T2 覆盖，解锁失败）
  ── 但 T1 和 T2 已经并发执行了，造成数据问题 ──
```

**Redisson 看门狗机制**（解决方案）：

```java
// Redisson 分布式锁（自带看门狗）
RLock lock = redissonClient.getLock("lock:1");
try {
    // 加锁（不传 TTL，启动看门狗自动续期）
    lock.lock();
    // 业务逻辑（即使超时，看门狗会续期）
    doBusiness();
} finally {
    lock.unlock();
}
```

**看门狗原理**：

```
Redisson 加锁时（不传 leaseTime）：
  1. SET lock:1 uuid NX PX 30000（默认 30s TTL）
  2. 启动定时任务（每 10s 执行一次，1/3 TTL）
  3. 定时任务检查：当前线程还持有锁吗？
     是 → 续期（EXPIRE lock:1 30000，重置 30s）
     否 → 关闭定时任务
  4. 业务完成 unlock() 时关闭定时任务

效果：只要业务还在执行（没宕机），锁不会过期
风险：如果业务 hang 住（不宕机但不结束），锁一直续期，其他线程拿不到锁
```

**Redisson 可重入锁**：

```java
// 同一线程多次加锁（可重入）
RLock lock = redissonClient.getLock("lock:1");
lock.lock();    // 第一次，Redis 存 Hash: lock:1 → {thread-id: 1}
lock.lock();    // 第二次，重入，Hash: lock:1 → {thread-id: 2}
lock.unlock();  // 重入次数 -1
lock.unlock();  // 重入次数归零，删除 key

// Redisson 用 Hash 结构实现可重入：
// HSET lock:1 <thread-id> <count>
// 每次加锁 count+1，解锁 count-1，归零删除
```

## 四、机制层：RedLock 算法与争议

**RedLock 算法**（Redisson 实现，5 节点示例）：

```
客户端获取锁：
  1. 记录当前时间 T1
  2. 依次向 5 个 Redis 节点发 SET NX PX 加锁请求
     （每个节点独立部署，不是主从集群）
  3. 记录当前时间 T2
  4. 满足以下条件才算加锁成功：
     a. 至少 3 个节点（N/2+1 = 5/2+1）加锁成功
     b. T2 - T1 < 锁有效期（如 30s，说明没超时）
  5. 计算实际锁有效期 = 设置TTL - (T2-T1)（减去加锁耗时）

解锁：
  向所有 5 个节点发 DEL（无论是否加锁成功，都尝试解锁）

容错：
  3 节点宕机（2 节点存活）不影响加锁（仍能拿到多数派）
  但如果是 2 节点存活，刚好 N/2+1=3 不满足，无法加锁（需多数派）
```

**RedLock 解决的问题**：主从异步复制丢锁——单 Redis 主从，主库加锁后异步同步到从库，主库宕机切换从库为新主，从库没有锁数据，其他客户端能拿到锁（两个客户端同时持锁）。RedLock 用多独立节点多数派避免单点。

**Martin Kleppmann 的批评**（面试高频）：

```
批评 1：依赖时钟假设
  RedLock 判断"锁是否有效"依赖各节点时钟一致（T2-T1 计算）。
  但分布式系统时钟无法完全同步（NTP 有误差，可能跳变）。
  如果某节点时钟快了，锁提前过期，导致多个客户端持锁。

批评 2：GC pause 问题
  客户端加锁成功后，发生长 GC pause（STW）。
  pause 期间锁过期，其他客户端拿到锁。
  GC 恢复后，原客户端以为还持锁，继续操作 → 并发。
  这不是 RedLock 特有问题，所有 TTL 锁都有，但 RedLock 没解决。

Antirez 反驳：
  - 时钟：生产用 NTP 同步，误差可控（毫秒级）
  - GC：启动业务前检查锁是否还有效（fencing token）
  - 实践中 RedLock 工作良好

结论：学术争议未定论。生产建议——强一致用 ZK/etcd，高性能容忍小概率错误用 Redis 单实例 + 看门狗，RedLock 是折中但争议大
```

**Fencing Token 方案**（解决 GC pause）：

```
锁服务每次发锁时附带递增的 token（1, 2, 3, ...）
  T1 拿锁 token=1，开始操作
  T1 GC pause，锁过期
  T2 拿锁 token=2，开始操作，写 DB 时带上 token=2
  T1 GC 恢复，写 DB 时带 token=1
  DB 检查 token：1 < 2（当前存储的 token），拒绝 T1 的写
  ── 即使 T1 误以为持锁，DB 层用 fencing token 防止过期写 ──

要求存储层支持 token 校验（如 Zookeeper 的版本号、etcd 的 mod_revision）
Redis 本身不支持 fencing token（这是 RedLock 的弱点）
```

## 五、实战层：Redisson 完整用法

**Redisson 配置**：

```yaml
spring:
  redis:
    redisson:
      config: |
        singleServerConfig:
          address: "redis://127.0.0.1:6379"
          database: 0
        # 或集群模式
        # clusterServersConfig:
        #   nodeAddresses: ["redis://node1:6379", "redis://node2:6379"]
```

**Redisson 锁用法**：

```java
@Service
public class StockService {

    @Autowired
    private RedissonClient redissonClient;

    // 基本用法（看门狗自动续期）
    public boolean deductStock(Long skuId, int quantity) {
        RLock lock = redissonClient.getLock("stock:lock:" + skuId);
        try {
            // tryLock：尝试加锁，最多等待 5 秒，锁自动续期（看门狗）
            boolean locked = lock.tryLock(5, TimeUnit.SECONDS);
            if (!locked) {
                return false;   // 没拿到锁，快速失败
            }
            // 业务逻辑
            return doDeduct(skuId, quantity);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        } finally {
            if (lock.isHeldByCurrentThread()) {
                lock.unlock();
            }
        }
    }

    // 指定 TTL（不启动看门狗）
    public boolean deductWithTTL(Long skuId, int quantity) {
        RLock lock = redissonClient.getLock("stock:lock:" + skuId);
        try {
            // tryLock(等待时间, 锁TTL, 单位)：明确 TTL，不启动看门狗
            boolean locked = lock.tryLock(5, 30, TimeUnit.SECONDS);
            if (!locked) return false;
            return doDeduct(skuId, quantity);
        } finally {
            if (lock.isHeldByCurrentThread()) {
                lock.unlock();
            }
        }
    }

    // 公平锁（按请求顺序）
    public void fairLock() {
        RLock lock = redissonClient.getFairLock("fair:lock");
        lock.lock();
        try { ... } finally { lock.unlock(); }
    }

    // 联锁（多个锁同时持有才算成功）
    public void multiLock() {
        RLock lock1 = redissonClient.getLock("lock1");
        RLock lock2 = redissonClient.getLock("lock2");
        RLock multiLock = redissonClient.getMultiLock(lock1, lock2);
        multiLock.lock();
        try { ... } finally { multiLock.unlock(); }
    }
}
```

**防重复提交（锁的典型应用）**：

```java
@RestController
public class OrderController {

    @PostMapping("/order/submit")
    public Result submit(@RequestBody OrderDTO dto,
                         @RequestHeader("X-User-Id") Long userId) {
        String lockKey = "order:submit:" + userId + ":" + dto.getRequestId();
        RLock lock = redissonClient.getLock(lockKey);
        try {
            // 尝试加锁（不等待，拿不到说明重复提交）
            boolean locked = lock.tryLock(0, 60, TimeUnit.SECONDS);
            if (!locked) {
                return Result.fail("请勿重复提交");
            }
            return orderService.create(dto);
        } finally {
            if (lock.isHeldByCurrentThread()) lock.unlock();
        }
    }
}
```

## 六、底层本质：AP 锁的边界

回到第一性：**Redis 分布式锁是 AP 系统（可用优先），在极小概率下可能失效，这是它的固有边界**。

- **为什么 Redis 锁可能失效**：Redis 主从异步复制，主库加锁后宕机，从库没同步到锁数据就提升为新主，其他客户端能拿到锁——两个客户端同时持锁。这是 AP 系统的固有缺陷（牺牲一致换可用）。
- **看门狗解决业务超时，不解决锁丢失**：看门狗防业务超过 TTL 导致锁过期，但防不了主从切换丢锁。主从切换是 Redis 层面的问题，应用层看门狗管不到。
- **RedLock 是多节点多数派方案**：用多个独立 Redis 节点（不是主从），多数派加锁成功才算获取锁。容忍少数节点宕机。但争议在于时钟假设和 GC pause。
- **强一致需求用 CP 系统**：Zookeeper/etcd 是 CP（一致优先）。ZK 用临时节点（客户端宕机节点自动删除，无 TTL 过期问题）+ Watch（锁释放通知）。但性能比 Redis 低（共识协议开销）。
- **工程实践**：大部分场景（防重复、限频、非关键互斥）用 Redis 单实例 + Redisson 看门狗足够（容忍极小概率错误）。资金类强一致（扣款、库存）用 ZK 或 DB 乐观锁，不用 Redis 锁。

**选型矩阵**：

| 场景 | 一致性要求 | 推荐 |
|------|-----------|------|
| 防重复提交 | 最终一致 | Redis 锁 |
| 定时任务防重复 | 最终一致 | Redis 锁 / DB 唯一约束 |
| 限频（每秒 N 次） | 最终一致 | Redis 计数器 |
| 秒杀扣库存 | 强一致 | DB 乐观锁 / Redis + Lua 原子扣减 |
| 资金扣款 | 强一致 | DB 事务 + 乐观锁 |
| 分布式选主 | 强一致 | ZK / etcd |

## 七、AI 架构师加问：5 个 AI 相关问题

1. **AI Agent 并发执行工具，怎么用锁防冲突？**
   Agent 调用共享资源（如同一用户的数据库）前加 Redis 锁（key=user_id），防止多个 Agent 并发修改同一用户数据。锁用 Redisson 看门狗（Agent 执行可能慢，需要续期）。强一致操作（如扣款）用 DB 锁不用 Redis 锁。

2. **让 AI 管理锁的 TTL，怎么设计？**
   AI 监控业务执行时长 → 动态调整锁 TTL（长业务配长 TTL）。但 AI 不直接改锁（风险高），而是推荐 TTL 值，人工或规则引擎决策。看门狗机制已经是动态续期，AI 可以优化续期策略（如预测业务剩余时间）。

3. **AI 推理服务的限频怎么用锁实现？**
   每用户每分钟限 N 次推理——用 Redis 计数器（INCR + EXPIRE）。每次推理前 INCR，超 N 拒绝。不是用分布式锁（锁是互斥，限频是计数）。锁用于"互斥访问"，限频用"滑动窗口或令牌桶"。

4. **怎么用 AI 检测锁异常？**
   AI 分析锁监控指标（锁等待时长、锁持有时长、加锁失败率）→ 异常检测（如锁等待时长飙升可能死锁）→ 推荐排查。AI 还能识别"长持锁"（某业务持有锁超过 1 分钟，可能有问题）。

5. **AI Agent 编排里的"资源预约"怎么实现？**
   Agent 预约共享资源（如 GPU）用分布式锁——Agent 开始任务前加锁（key=resource_id），完成后释放。如果 Agent crash，锁靠 TTL 过期释放（其他 Agent 可拿）。看门狗续期要谨慎（Agent hang 住会一直占资源），加最大持有时间限制。

## 八、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"SET NX PX、Lua 解锁、看门狗续期、RedLock 争议、CP 用 ZK"**。

- **加锁**：SET key uuid NX PX 30000（原子 + 过期防死锁）
- **解锁**：Lua 脚本（判断 value 相等才删，防误删）
- **看门狗**：Redisson 后台每 1/3 TTL 续期，防业务超时
- **锁超时风险**：业务超 TTL → 锁过期 → 并发（看门狗解决）
- **RedLock**：多节点多数派，争议（时钟 + GC pause）
- **选型**：高性能容忍小概率错误用 Redis，强一致用 ZK/etcd

### 拟人化理解

把 Redis 锁想成**公共洗手间门锁**。SET NX 是"敲门没人就进并锁门"（互斥），PX 过期是"自动开门防人晕里面"（防死锁），UUID 是"每人专属钥匙牌"（防开错门），Lua 解锁是"确认是自己钥匙牌才开门"（防误开）。锁超时是"人没上完门自动开了，别人冲进来"（并发风险）——看门狗是"里面有人就延长计时"（续期防过早开门）。RedLock 是"多个洗手间同时锁，多数锁上才算成功"（防单个门坏了）。争议是"多洗手间的时钟可能不准，有人以为自己锁了其实没锁"（时钟假设 + GC pause）。强一致需求（如金库）不用公共洗手间，用专用更衣室（ZK 临时节点，人走自动解锁）。

### 面试现场 60 秒回答

> Redis 分布式锁的核心：加锁用 SET key uuid NX PX 30000（原子命令，NX 互斥 + PX 过期防死锁），解锁用 Lua 脚本（判断 value 相等才删，防误删别人的锁）。value 用 UUID 标识持有者。锁超时风险（业务超过 TTL 导致锁过期并发）用 Redisson 看门狗解决——后台每 1/3 TTL 续期，业务完成关闭。可重入锁用 Hash 结构（key 存线程 ID 和重入次数）。RedLock 是多节点多数派方案（5 节点锁 3 个），解决主从异步复制丢锁，但有争议——Martin Kleppmann 批评其依赖时钟假设和 GC pause 问题。选型：防重复、限频等容忍小概率错误用 Redis 锁；资金扣款、库存等强一致用 ZK 临时节点或 DB 乐观锁。Redis 锁是 AP，ZK 锁是 CP。

### 反问面试官

> 贵司分布式锁用 Redisson 还是自研？资金类业务（扣款/库存）用 Redis 锁还是 DB 锁？有没有遇到过锁失效事故（主从切换丢锁）？对 RedLock 争议怎么看？

## 九、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不用 synchronized 或 ReentrantLock？ | 用作用域说话：synchronized 是单机锁（JVM 内），分布式系统多个 JVM 互不感知。分布式锁要跨 JVM 互斥，必须用共享存储（Redis/ZK/DB）。Redis 单线程命令原子适合实现互斥 |
| 证据追问 | 怎么知道锁有问题（失效/死锁）？ | 监控锁等待时长（长可能是死锁）、锁持有时长（长可能业务异常）、加锁失败率（高可能并发过大）。业务层对账（库存超卖说明锁失效）。压测模拟主从切换验证锁正确性 |
| 边界追问 | Redis 锁能保证绝对互斥吗？ | 不能。主从异步复制丢锁（主宕从没同步）、GC pause 导致锁过期后误以为持锁、时钟跳变（RedLock）。Redis 锁是 AP 容忍极小概率错误。要绝对互斥用 ZK（CP）或 DB 锁 |
| 反例追问 | 什么场景不该用 Redis 锁？ | 强一致需求（资金扣款、库存超卖不可接受）、长时间持锁（看门狗续期风险）、高竞争热点（锁等待严重）。这些场景用 DB 乐观锁或 ZK |
| 风险追问 | Redis 锁上线后最大风险？ | 主动点出：主从切换丢锁（并发）、业务超时锁过期（看门狗解决）、锁误删（Lua 解决）、死锁（TTL 解决）、RedLock 时钟依赖。要理解每个风险的边界 |
| 验证追问 | 怎么证明锁真的有效？ | 压测高并发验证互斥（同一资源并发访问应串行）；混沌工程 kill Redis 主库验证主从切换后锁行为；对账验证数据一致（库存数 vs 订单数） |
| 沉淀追问 | 团队分布式锁治理规范，沉淀什么？ | 锁使用规范（必须 Lua 解锁、必须看门狗或显式 TTL）、选型 SOP（强一致用 DB/ZK）、锁监控大盘（等待/持有/失败率）、锁治理（避免长持锁、避免热点锁） |

### 现场对话示例

**面试官**：Redis 锁主从切换时为什么会丢锁？

**候选人**：因为 Redis 主从复制是异步的。客户端在主库加锁（SET NX PX），主库异步把锁数据同步到从库。如果主库在同步完成前宕机，从库没有这把锁的数据。哨兵/Cluster 选新主时，新主（原从库）没有锁记录，其他客户端可以加锁成功。这时两个客户端都以为持有锁——原客户端（主库宕机前加的锁）和新客户端（新主加的锁），导致并发。这是 AP 系统的固有问题——Redis 选可用（主宕快速切换），牺牲一致（异步复制可能丢锁）。RedLock 试图解决这个问题——用多个独立 Redis 节点（不是主从），多数派加锁成功才算获取锁，少数节点宕机不影响。但 RedLock 引入新争议（时钟假设 + GC pause）。生产实践：容忍小概率错误的场景（防重复）用单 Redis + Redisson 看门狗足够，强一致场景（资金）不用 Redis 锁用 ZK（CP，临时节点 + Watch）或 DB 乐观锁（version 字段）。

**面试官**：看门狗机制有什么风险？

**候选人**：看门狗的核心风险是"业务 hang 住导致锁一直续期"。如果业务线程卡死（如死锁、IO 阻塞、GC），但进程还活着，看门狗会持续续期，锁一直不释放，其他线程拿不到锁。这等于变相死锁。解法：第一，给业务加超时（如 RPC 调用设超时，避免无限等待）。第二，限制看门狗最大续期次数（Redisson 默认无限续，可配置上限）。第三，监控锁持有时长（超阈值告警，可能业务异常）。第四，关键场景用显式 TTL（lock.tryLock(waitTime, leaseTime, unit)），不启动看门狗——锁最多持有 leaseTime，到时强制释放。生产建议：短业务用看门狗（自动续期方便），长业务用显式 TTL（强制超时防卡死）。另外看门狗依赖客户端进程存活——进程 crash 后看门狗线程也没了，锁靠 TTL 过期释放，这是正常的。

**面试官**：RedLock 的 GC pause 问题具体是什么？

**候选人**：GC pause 问题是 Martin Kleppmann 提出的 RedLock 致命缺陷。场景：客户端 1 加锁成功（锁 TTL 30 秒），然后发生长 GC STW（Stop-The-World，如 35 秒）。GC 期间客户端 1 暂停执行，锁在 30 秒时过期。客户端 2 在第 30 秒加锁成功。第 35 秒客户端 1 GC 恢复，它不知道自己 STW 了 35 秒，以为还持锁（代码逻辑上 lock() 返回 true 后继续执行），继续操作共享资源——此时客户端 1 和客户端 2 都在操作，并发了。这个问题不是 RedLock 特有（所有 TTL 锁都有），但 RedLock 没有解决它。解法是 fencing token——锁服务每次发锁时附带递增 token，存储层校验 token（拒绝过期 token 的写）。但 Redis 不原生支持 fencing token（这是 RedLock 的弱点）。ZK 可以用 zxid 或版本号实现 fencing。所以 Kleppmann 的结论是：要真正安全用分布式锁，要么用 ZK（带 fencing），要么用 DB 的 CAS（version 字段）。Redis 锁只适合"容忍极小概率并发错误"的场景。

## 常见考点

1. **Redisson 的锁和手写 SET NX 有什么区别？**——Redisson 封装了看门狗（自动续期）、可重入（Hash 结构）、Lua 解锁、公平锁、联锁等高级特性。手写 SET NX 要自己实现这些（容易出错）。生产推荐 Redisson 而不是手写。
2. **锁和数据库乐观锁什么区别？**——Redis 锁是"先加锁再操作"（悲观），DB 乐观锁是"操作时校验版本号"（乐观）。Redis 锁适合复杂业务逻辑（多步操作要原子），乐观锁适合简单更新（单行 UPDATE WHERE version=?）。强一致需求优先乐观锁（DB 保证），不用 Redis 锁。
3. **Zookeeper 分布式锁原理？**——创建临时顺序节点（/lock/seq-001），判断自己是否最小节点（是则获锁，不是则 Watch 前一个节点）。客户端宕机临时节点自动删除（无 TTL 过期问题）。Watch 通知前一个节点释放（公平锁）。CP 强一致但性能比 Redis 低（共识协议 + Watch 通知延迟）。
4. **分布式锁的性能优化？**——减小锁粒度（按 user_id 分锁而不是全局锁）、缩短持锁时间（业务逻辑移出锁范围）、锁分离（读写锁）、无锁化（CAS/乐观锁）。热点 key 的锁是瓶颈，考虑分片（如库存按 SKU 分锁）。


## 结构化回答

**30 秒电梯演讲：** 聊到Redis 分布式锁的正确性与 RedLock 争议，我的理解是——Redis 分布式锁的本质是"用 SET NX PX 原子命令实现互斥，用过期时间防死锁，用唯一 value（UUID）+ Lua 原子删锁防误删"。正确性挑战有三个边界：锁超时但业务没完成（别人拿到锁导致并发）、主从切换丢锁（异步复制主库宕机）、GC pause 导致锁失效。RedLock 是 Redisson 提出的多节点多数派方案，但有争议（Martin Kleppmann 批评其依赖时钟假设）。打个比方，僉公共洗手间的门锁。SET NX 是"敲门没人就进并锁门"，PX 过期是"自动开门防人晕里面出不来了"，UUID 是"每个人有专属钥匙牌（防开错门）"，Lua 删锁是"确认是自己钥匙牌才开门（防误开）"。锁超时是"人没上完厕所门自动开了，别人冲进来"。RedLock 是"多个洗手间同时锁，多数锁上才算成功"（防止单个洗手间门坏了）。

**展开框架：**
1. **基础锁** — SET key value NX PX 30000（原子命令）
2. **解锁** — Lua 脚本（判断 value 相等才删，防误删）
3. **锁超时问题** — 业务超时 → 锁过期 → 别人拿锁 → 并发

**收尾：** 这块我在项目里也踩过坑——想深入的话，可以接着聊：为什么解锁要 Lua 脚本？您更想看哪个方向？

## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡 | "Redis 分布式锁的正确性与 RedLock 争议——这道题面试官到底想考什么？我用 30 秒给你讲透。" | 开场钩子 |
| 0:15 | 锁状态转换图 | 先说核心：Redis 分布式锁的本质是"用 SET NX PX 原子命令实现互斥，用过期时间防死锁，用唯一 value（UUID）+ Lua 原子删锁防误删"。正确性挑战有三个边界：锁超。 | 核心定义 |
| 0:30 | Redis 数据结构图 | Lua 脚本（判断 value 相等才删，防误删）。 | 解锁 |
| 1:30 | 总结卡 | 一句话记忆：基础锁：SET key uuid NX PX 30000（原子加锁 + 过期防死锁）。 下期可以接着聊：为什么解锁要 Lua 脚本。 | 收尾总结 |
