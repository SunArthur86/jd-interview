---
id: java-architect-186
difficulty: L3
category: java-architect
subcategory: 数据合规
tags:
- Java 架构师
- 合规
- GDPR
- 数据删除
- 个人信息保护
feynman:
  essence: 合规数据删除的核心是"软删除 + 级联清理 + 异步归档 + 审计追溯"。用户行使删除权（GDPR/个人信息保护法），先软删除标记，再异步级联清理（DB/缓存/ES/对象存储/日志/备份），最后审计追溯记录删除操作。难点是数据散落各处，必须全链路清理。
  analogy: 像办理退学——先在学籍系统标记"已退学"（软删除），再通知图书馆清借书记录、宿舍腾床位、食堂退余额（级联清理），最后存档退学证明（审计追溯）。不能只改一个系统，要全链路。
  first_principle: 合规删除的难点是"数据散落"。用户数据分布在订单/地址/支付/日志/缓存/ES/备份等多处，只删一处不合规。且删除是破坏性操作（删错难恢复），必须软删除 + 审计 + 可追溯。关联数据要级联（删用户连带删地址/订单关联）。
  key_points:
  - 软删除：标记 is_deleted=1，不物理删（可恢复 + 审计）
  - 级联清理：DB（用户表+订单+地址）+ 缓存 + ES + 对象存储 + 日志 + 备份
  - 异步归档：大批量删除走 MQ 异步，避免阻塞主流程
  - 审计追溯：记录删除操作（who/when/what/why），合规审计可查
  - 关联数据：删用户连带删地址/订单关联（按业务规则）
first_principle:
  problem: 用户行使删除权（GDPR/个保法）时，数据散落在 DB/缓存/ES/日志/备份各处，如何全链路清理且可审计可追溯？
  axioms:
  - 数据散落（用户数据在数十张表 + 缓存 + ES + 日志 + 备份）
  - 删除是破坏性操作，删错难恢复
  - 合规要求可审计（证明已删除，被查时拿得出记录）
  - 关联数据要级联（删用户连带地址/订单）
  - 大批量删除不能阻塞主流程
  rebuild: 软删除优先（is_deleted=1 标记，不物理删，可恢复 + 审计）。级联清理走 MQ 异步——删除请求入队，worker 消费逐个系统清理（DB 相关表 + Redis 缓存 + ES 索引 + 对象存储文件 + 日志脱敏 + 标记备份过期）。审计表记录每次删除（who/when/what/why/dataSnapshot）。物理删除延迟（30 天后物理删，防误删 + 合规窗口期）。
follow_up:
  - 为什么软删除不直接物理删？——可恢复（误删能救回）+ 审计（保留记录供查）+ 合规窗口期（30 天内可恢复应对误操作）。
  - 数据散落各处怎么全清理？——级联清理清单。注册一个 DataSubjectDeletionHandler，列出所有涉及用户数据的系统，逐一清理。
  - 缓存怎么删？——Redis 用户相关 key（user:{userId}, session:{userId}）全删。或 key 带版本号，删后版本 + 1 旧缓存自然失效。
  - 日志怎么处理？——日志含 PII（手机号/身份证）要脱敏。不能物理删日志（运维需要），用脱敏替换（maskPhone("138****1234")）。
  - 备份怎么删？——备份不能立即删（影响其他恢复点）。标记"该用户数据在 XX 日期后过期"，备份轮转后自然消失（通常 7-30 天）。
memory_points:
  - 软删除：is_deleted=1 标记，30 天后物理删（合规窗口期）
  - 级联清理：DB + Redis + ES + 对象存储 + 日志脱敏 + 备份标记
  - 异步归档：MQ + worker 逐系统清理，不阻塞主流程
  - 审计追溯：记录 who/when/what/why/dataSnapshot
  - 日志处理：脱敏（maskPhone）不物理删（运维需要）
---

# 【Java 后端架构师】合规数据删除与个人信息保护

> 适用场景：JD 用户注销账号 / GDPR 删除请求 / 个保法合规。用户数据散落在订单/地址/支付/评价/日志/缓存/ES/备份各处。架构师要设计的是"软删除 + 级联清理 + 异步归档 + 审计追溯"的合规删除系统。

## 一、概念层：删除流程

```
用户申请删除 → 软删除标记（is_deleted=1）
                    ↓
              发删除事件到 MQ
                    ↓
        worker 消费 → 级联清理：
          ├─ DB 相关表（订单/地址/支付/评价）
          ├─ Redis 缓存（user/session/cart）
          ├─ ES 索引（搜索数据）
          ├─ 对象存储（头像/证件照）
          ├─ 日志脱敏（含 PII 的日志 mask）
          └─ 备份标记过期（轮转后自然消失）
                    ↓
              审计表记录（who/when/what/why）
                    ↓
        30 天后物理删除（合规窗口期）
```

## 二、机制层：软删除与删除请求

```java
/**
 * 用户注销：软删除 + 发删除事件
 */
@Service
@Slf4j
public class AccountDeletionService {

    private final UserRepo userRepo;
    private final KafkaTemplate<String, String> kafka;

    public void requestDeletion(Long userId, String reason) {
        // 1. 软删除标记（is_deleted=1，deleted_at=now）
        userRepo.softDelete(userId, reason);

        // 2. 记录删除前的数据快照（审计用）
        UserSnapshot snapshot = captureSnapshot(userId);
        auditService.recordDeletion(userId, reason, snapshot);

        // 3. 发删除事件（触发级联清理）
        DeletionEvent event = new DeletionEvent(userId, reason,
            System.currentTimeMillis());
        kafka.send("user-deletion-topic", String.valueOf(userId),
            JsonUtils.stringify(event));

        log.info("用户删除请求已提交: userId={} reason={}",
            userId, reason);
    }
}
```

```sql
-- 用户表：软删除字段
ALTER TABLE user ADD COLUMN is_deleted TINYINT DEFAULT 0;
ALTER TABLE user ADD COLUMN deleted_at DATETIME;
ALTER TABLE user ADD COLUMN deletion_reason VARCHAR(200);

-- 所有查询自动过滤已删除（MyBatis 拦截器注入 WHERE is_deleted=0）
-- 或业务层显式判断
```

## 三、机制层：级联清理（注册式）

```java
/**
 * 数据主体删除处理器接口（SPI）
 * 每个涉及用户数据的系统注册一个 handler
 */
public interface DataSubjectDeletionHandler {
    String getSystemName();
    void deleteUserData(Long userId);
}

/**
 * 订单系统：清理用户订单关联
 */
@Component
@Order(1)
public class OrderDeletionHandler implements DataSubjectDeletionHandler {

    @Override
    public String getSystemName() { return "order"; }

    @Override
    public void deleteUserData(Long userId) {
        // 订单软删除（保留交易记录但脱敏用户信息）
        orderRepo.maskUserInfo(userId);
        // UPDATE orders SET user_name='***', user_phone=NULL
        //   WHERE user_id=?
    }
}

/**
 * 地址系统：物理删除用户地址
 */
@Component
@Order(2)
public class AddressDeletionHandler implements DataSubjectDeletionHandler {

    @Override
    public String getSystemName() { return "address"; }

    @Override
    public void deleteUserData(Long userId) {
        // 地址含敏感信息（住址），物理删除
        addressRepo.physicalDeleteByUserId(userId);
    }
}

/**
 * 缓存清理
 */
@Component
@Order(3)
public class CacheDeletionHandler implements DataSubjectDeletionHandler {

    private final RedisTemplate<String, String> redis;

    @Override
    public String getSystemName() { return "cache"; }

    @Override
    public void deleteUserData(Long userId) {
        // 删除所有用户相关 key
        Set<String> keys = redis.keys("user:" + userId + ":*");
        keys.addAll(redis.keys("session:" + userId + ":*"));
        keys.addAll(redis.keys("cart:" + userId + ":*"));
        redis.delete(keys);
    }
}

/**
 * ES 索引清理
 */
@Component
@Order(4)
public class SearchDeletionHandler implements DataSubjectDeletionHandler {

    @Override
    public String getSystemName() { return "search"; }

    @Override
    public void deleteUserData(Long userId) {
        // 删除 ES 中用户相关文档
        esClient.deleteByQuery("user_index",
            QueryBuilders.termQuery("user_id", userId));
        esClient.deleteByQuery("review_index",
            QueryBuilders.termQuery("user_id", userId));
    }
}

/**
 * 对象存储清理（头像/证件照）
 */
@Component
@Order(5)
public class StorageDeletionHandler implements DataSubjectDeletionHandler {

    @Override
    public String getSystemName() { return "storage"; }

    @Override
    public void deleteUserData(Long userId) {
        // 删除头像
        ossClient.delete("avatars/" + userId + ".jpg");
        // 删除证件照
        List<String> docs = docRepo.findPathsByUserId(userId);
        for (String path : docs) {
            ossClient.delete(path);
        }
    }
}

/**
 * 日志脱敏（不物理删，运维需要日志排查）
 */
@Component
@Order(6)
public class LogDeletionHandler implements DataSubjectDeletionHandler {

    @Override
    public String getSystemName() { return "log"; }

    @Override
    public void deleteUserData(Long userId) {
        // 日志含 PII 的做脱敏（mask 手机号/身份证）
        // 不能物理删日志（合规要求保留运维日志 6 个月）
        logMaskService.maskPII(userId);
    }
}
```

## 四、机制层：异步清理协调器

```java
/**
 * 删除协调器：按顺序调用所有 handler
 */
@Service
@Slf4j
public class DeletionCoordinator {

    private final List<DataSubjectDeletionHandler> handlers;    // Spring 注入，按 @Order 排序

    @KafkaListener(topics = "user-deletion-topic")
    public void onDeletionRequest(DeletionEvent event) {
        Long userId = event.getUserId();
        log.info("开始级联清理: userId={}", userId);

        List<String> successSystems = new ArrayList<>();
        List<String> failedSystems = new ArrayList<>();

        for (DataSubjectDeletionHandler handler : handlers) {
            try {
                handler.deleteUserData(userId);
                successSystems.add(handler.getSystemName());
                log.info("清理完成: userId={} system={}",
                    userId, handler.getSystemName());
            } catch (Exception e) {
                failedSystems.add(handler.getSystemName());
                log.error("清理失败: userId={} system={}",
                    userId, handler.getSystemName(), e);
                metrics.counter("deletion.failed", "system",
                    handler.getSystemName()).increment();
                // 不中断，继续清理其他系统（失败的单独重试）
            }
        }

        // 记录清理结果
        auditService.recordCleanupResult(userId, successSystems,
            failedSystems);

        // 有失败的：重试（发延迟队列）
        if (!failedSystems.isEmpty()) {
            retryService.scheduleRetry(event, failedSystems);
        }
    }
}
```

## 五、机制层：审计追溯

```sql
-- 删除审计表：记录每次删除操作（合规审计用）
CREATE TABLE deletion_audit (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT NOT NULL,
    reason VARCHAR(200),
    requested_at DATETIME,
    requested_by VARCHAR(50),       -- user/admin/legal
    data_snapshot JSON,             -- 删除前的数据快照
    cleaned_systems JSON,           -- 已清理的系统列表
    failed_systems JSON,            -- 清理失败的系统
    completed_at DATETIME,
    status VARCHAR(20),             -- IN_PROGRESS/COMPLETED/FAILED
    INDEX idx_user (user_id),
    INDEX idx_status (status)
);
```

```java
@Service
public class DeletionAuditService {

    /**
     * 合规审计：被监管查时拿得出证明
     */
    public void recordDeletion(Long userId, String reason,
                                UserSnapshot snapshot) {
        DeletionAudit audit = new DeletionAudit();
        audit.setUserId(userId);
        audit.setReason(reason);
        audit.setRequestedAt(LocalDateTime.now());
        audit.setRequestedBy(TenantContext.getCurrentRole());
        audit.setDataSnapshot(JsonUtils.stringify(snapshot));
        audit.setStatus("IN_PROGRESS");
        auditRepo.save(audit);
    }

    /**
     * 查询删除记录（应对监管检查）
     */
    public DeletionAudit queryDeletion(Long userId) {
        return auditRepo.findByUserId(userId);
    }
}
```

## 六、机制层：物理删除（延迟）

```java
/**
 * 物理删除：软删除 30 天后执行（合规窗口期）
 */
@Service
public class PhysicalDeletionService {

    @Scheduled(cron = "0 0 4 * * ?")       // 每天凌晨 4 点
    public void physicalDeleteExpired() {
        // 查软删除超过 30 天的用户
        LocalDateTime cutoff = LocalDateTime.now().minusDays(30);
        List<User> users = userRepo.findSoftDeletedBefore(cutoff);

        for (User user : users) {
            // 物理删除（DB DELETE）
            userRepo.physicalDelete(user.getId());
            log.info("物理删除完成: userId={}", user.getId());
            metrics.counter("deletion.physical").increment();
        }
    }
}
```

## 七、底层本质：软删除与全链路的本质

**软删除的本质**：物理删除（DELETE）是破坏性的——删错难恢复，审计无记录。软删除（is_deleted=1）只标记不删数据，好处：1) 可恢复（误删能救回）；2) 审计有记录（数据还在可查）；3) 合规窗口期（GDPR/个保法通常给 30 天响应期，软删除期内可撤回）。查询层过滤（WHERE is_deleted=0）。30 天后物理删（彻底清理释放空间）。

**全链路清理的本质**：用户数据散落数十处（DB 数十张表 + Redis + ES + 对象存储 + 日志 + 备份）。只删一处不合规（"数据还在"被查到就是违规）。注册式 handler——每系统注册 DataSubjectDeletionHandler，协调器统一调用。这是**开闭原则**——新增系统只需注册 handler 不改协调器。

**日志脱敏而非删除的本质**：日志含 PII（手机号/身份证/地址），但日志不能物理删（运维排查/合规审计需保留 6 个月）。脱敏（mask）——保留日志结构但替换 PII（138\*\*\*\*1234）。既清除个人身份信息又保留运维价值。这是**数据最小化原则**——保留必要信息，清除个人识别。

**备份延迟清理的本质**：备份（mysqldump/快照）是历史快照，不能立即删（影响其他恢复点）。策略：标记"该用户数据在某日期后应过期"，备份按轮转策略（7-30 天）自然消失。合规上可接受"备份数据在合理轮转周期后清除"。

**审计的本质**：合规要求可证明。监管查"你删了 X 的数据吗"，要拿得出记录（谁/何时/为什么/删了什么）。审计表记录完整删除操作 + 数据快照（证明删了什么）。这是**举证责任倒置**——企业要自证合规，不是监管举证违规。

## 八、AI 工程化深挖

1. **怎么用 AI 发现 PII 散落？** 扫描所有表/字段/日志，AI（NER 命名实体识别）判断哪些含 PII（手机号/身份证/地址）。生成"PII 数据地图"，删除时按图清理不遗漏。

2. **怎么用 LLM 生成合规报告？** 监管检查时 LLM 根据审计表生成"2026 年 Q2 共处理删除请求 1000 个，平均 2 小时完成，涉及系统 N 个"。自动化合规报告。

3. **怎么用 AI 检测删除遗漏？** 删除后 AI 扫描全系统（DB/ES/日志）查是否还有该用户数据残留。有残留告警补删。防级联清理遗漏。

4. **怎么用 LLM 评估隐私风险？** 新功能上线前 LLM 评估"这个功能收集的数据是否符合最小必要原则/是否过度采集"。隐私设计（Privacy by Design）。

5. **怎么用 AI 做数据分类分级？** 不同数据敏感度不同（身份证 > 手机号 > 昵称）。AI 自动分类分级，高敏感数据加密存储 + 严格访问控制。

## 九、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"软删除、级联、脱敏、审计"** 四个词。

- **软删除**：is_deleted=1 标记，30 天后物理删（可恢复 + 审计 + 合规窗口期）
- **级联**：注册式 handler，DB/缓存/ES/对象存储/日志/备份全清理
- **脱敏**：日志含 PII 做 mask（不物理删，运维需保留 6 个月）
- **审计**：记录 who/when/what/why/dataSnapshot，举证责任倒置

### 面试现场 60 秒回答

> 合规数据删除我用软删除 + 级联清理 + 异步归档 + 审计追溯。用户注销先软删除（is_deleted=1，deleted_at=now），不物理删——可恢复（误删能救回）+ 审计有记录 + 合规窗口期（GDPR/个保法 30 天响应期可撤回）。查询层 MyBatis 拦截器自动注入 WHERE is_deleted=0 过滤。软删除后捕获数据快照（审计用），发删除事件到 MQ。级联清理走异步——DataSubjectDeletionHandler SPI 接口，每系统注册一个 handler（OrderHandler 脱敏用户信息保留交易记录、AddressHandler 物理删地址、CacheHandler 删 Redis 相关 key、SearchHandler 删 ES 索引、StorageHandler 删头像证件照、LogHandler 脱敏日志含 PII 的部分）。协调器按 @Order 顺序调用，单个失败不中断（失败的单独重试）。日志不物理删（运维需保留 6 个月），做脱敏 mask（138****1234 保留结构清身份）。备份不能立即删（影响恢复点），标记过期后按轮转策略（7-30 天）自然消失。审计表记录每次删除（who/when/what/why/dataSnapshot/cleaned_systems/failed_systems）——监管查时举证责任倒置（企业自证合规）。物理删除延迟 30 天（凌晨 4 点定时任务扫软删除超 30 天的物理删）。监控 deletion_completion_rate、deletion_retry_count、pii_residual_count（删除后残留 PII 扫描）。

## 十、苏格拉底追问

| 追问 | 证据/答案 |
|------|-----------|
| 为什么不直接物理删除？ | 软删除可恢复（误删救回）+ 审计有记录 + 合规窗口期（30 天可撤回）。物理删是破坏性的。 |
| 数据散落各处怎么不遗漏？ | 注册式 handler（DataSubjectDeletionHandler SPI），每系统注册。PII 数据地图扫描发现所有含 PII 的系统。 |
| 日志为什么不能物理删？ | 运维需保留 6 个月（合规 + 排障）。做脱敏 mask（保留结构清身份），既清 PII 又保运维价值。 |
| 删除失败怎么办？ | 单个 handler 失败不中断（继续清理其他）。失败的进重试队列。审计表记录 failed_systems，监控告警。 |
| 备份里的数据怎么删？ | 不能立即删（影响恢复点）。标记过期，备份按轮转策略（7-30 天）自然消失。合规接受合理周期。 |

## 十一、常见考点

1. **为什么软删除？**——可恢复（误删救回）+ 审计有记录 + 合规窗口期（30 天可撤回）。物理删是破坏性的，30 天后物理删彻底清理。
2. **怎么保证全链路清理？**——注册式 handler（SPI），每系统注册 DataSubjectDeletionHandler。协调器统一调用。PII 数据地图扫描防遗漏。
3. **日志怎么处理？**——脱敏 mask（138****1234）不物理删。运维需保留 6 个月。保留日志结构清 PII 身份。
4. **审计怎么做？**——审计表记录 who/when/what/why/dataSnapshot/cleaned_systems。举证责任倒置（企业自证合规）。
5. **物理删除什么时候做？**——软删除 30 天后（合规窗口期）。定时任务扫软删除超 30 天的物理删。

## 结构化回答

**30 秒电梯演讲：** 合规数据删除的核心是软删除 + 级联清理 + 异步归档 + 审计追溯。用户行使删除权（GDPR/个人信息保护法），先软删除标记，再异步级联清理（DB/缓存/ES/对象存储/日志/备份），最后审计追溯记录删除操作。难点是数据散落各处，必须全链路清理

**展开框架：**
1. **软删除** — 标记 is_deleted=1，不物理删（可恢复 + 审计）
2. **级联清理** — DB（用户表+订单+地址）+ 缓存 + ES + 对象存储 + 日志 + 备份
3. **异步归档** — 大批量删除走 MQ 异步，避免阻塞主流程

**收尾：** 以上是我的整体思路。您想继续深入聊——为什么软删除不直接物理删？


## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：合规数据删除与个人信息保护 | "这题一句话：合规数据删除的核心是软删除 + 级联清理 + 异步归档 + 审计追溯。" | 开场钩子 |
| 0:15 | 像办理退学——先在学籍系统标记已退学（软删除类比图 | "打个比方：像办理退学——先在学籍系统标记已退学（软删除。" | 核心类比 |
| 0:40 | 软删除示意/对比图 | "标记 is_deleted=1，不物理删（可恢复 + 审计）" | 软删除要点 |
| 1:05 | 级联清理示意/对比图 | "DB（用户表+订单+地址）+ 缓存 + ES + 对象存储 + 日志 + 备份" | 级联清理要点 |
| 1:55 | 总结卡 | "记住：软删除。下期见。" | 收尾 |
