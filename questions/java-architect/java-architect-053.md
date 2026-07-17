---
id: java-architect-053
difficulty: L2
category: java-architect
subcategory: 风控系统
tags:
- Java 架构师
- 签名
- 防重放
- 安全
feynman:
  essence: 接口签名解决"防篡改"（请求内容不能被中间人改），防重放解决"防复用"（截获的请求不能被重发）。签名用 HMAC-SHA256（密钥+请求体+时间戳算摘要），防重放用 nonce（一次性随机数）+ timestamp（时间窗口）。敏感数据保护用 TLS 传输加密 + 字段级加密（AES）+ 脱敏存储（手机号哈希）。
  analogy: 像签合同+骑缝章+一次性密码。签名是"签合同"（内容哈希+私钥签名，改一个字签名失效）；防重放是"骑缝章+一次性密码"（每张合同有唯一编号+时间戳，用过作废，不能复印重用）；敏感数据加密是"密封信封"（信件内容用密码锁信封，中途看不到）。
  first_principle: 为什么 HTTPS 还要接口签名？因为 HTTPS 只防"传输层篡改"（网络中间人），防不了"应用层伪造"（客户端被逆向，密钥被提取）。接口签名在应用层再加一道——即使攻击者抓包成功，没有密钥也无法伪造签名；即使拿到合法请求，因 nonce+timestamp 也无法重放。
  key_points:
  - 签名算法：HMAC-SHA256(secret, method+path+body+timestamp+nonce)
  - 防重放三要素：timestamp（5 分钟窗口）+ nonce（一次性）+ signature（防篡改）
  - nonce 存 Redis（key=nonce，TTL=时间窗口），重复 nonce 拒绝
  - 敏感数据保护：TLS 传输 + AES-256 字段加密 + 字段脱敏存储
  - 密钥管理：定期轮换，不能用硬编码（用 KMS）
first_principle:
  problem: 开放 API 如何防止请求被篡改（改金额/改收款方）和被重放（截获合法请求重复提交）？
  axioms:
  - HTTPS 防网络层中间人，但不防应用层伪造（客户端密钥泄露）
  - 请求一旦被截获，如果没有防重放机制，攻击者可重复提交
  - 敏感数据（身份证/银行卡）明文传输是合规违规
  rebuild: 签名+防重放组合。客户端用密钥对请求（method+path+body+timestamp+nonce）算 HMAC-SHA256 签名，服务端验签。timestamp 限定 5 分钟窗口（超时拒绝），nonce 是一次性随机数存 Redis（重复拒绝）。这样防篡改（改内容签名失效）+ 防重放（nonce 用过作废+timestamp 过期作废）。敏感数据字段级 AES 加密，密钥用 KMS 管理定期轮换。
follow_up:
  - 签名密钥怎么分发？——线下安全渠道（开发者中心下载，邮件加密），或 OAuth2 token 模式（动态获取）。绝对不能明文 URL 传。
  - nonce 存 Redis 性能够吗？——够。每次请求 SETNX nonce（TTL 5 分钟），O(1) 操作。亿级 QPS 下 Redis 集群可扛。注意 nonce 要全局唯一（UUID 或 雪花 ID）。
  - 时间不同步怎么办？——客户端和服务端 NTP 同步。timestamp 容忍 ±5 分钟窗口（处理时钟漂移）。超 5 分钟拒绝（防止长期重放）。
  - 文件上传怎么签名？——大文件签名 body 不现实。对文件算 SHA256 摘要，签摘要+文件名+大小。或用 multipart 签名（只签非文件部分+文件摘要）。
  - 国密算法（SM2/SM3/SM4）什么时候用？——政务/金融/国企强制用国密。SM2 替代 RSA，SM3 替代 SHA256，SM4 替代 AES。京东金融部分场景用国密合规。
memory_points:
  - 签名 = HMAC-SHA256(secret, method+path+body+timestamp+nonce)
  - 防重放 = timestamp(5min窗口) + nonce(一次性, Redis SETNX)
  - 敏感数据 = TLS传输 + AES-256字段加密 + 脱敏存储
  - 密钥管理 = KMS + 定期轮换
  - 国密 = SM2/SM3/SM4（政务金融强制）
---

# 【Java 后端架构师】接口签名、防重放与敏感数据保护

> 适用场景：JD 核心技术。京东开放平台给 ISV 提供 API，ISV 调"创建订单"接口时，如果请求没签名，中间人可以篡改金额（100 元改成 1 元）；如果没防重放，攻击者截获合法请求重复提交（重复下单/重复扣款）。签名+防重放是开放 API 的安全底线。

## 一、概念层：三个安全目标

**安全目标矩阵**：

| 威胁 | 防护手段 | 机制 |
|------|---------|------|
| **篡改**（改请求内容） | 签名（HMAC-SHA256） | 改任何字段签名不匹配 |
| **重放**（重复提交合法请求） | nonce + timestamp | nonce 用过作废，timestamp 过期作废 |
| **窃听**（偷看敏感数据） | TLS + 字段加密 | 传输层加密 + 应用层字段加密 |
| **伪造**（冒充合法客户端） | 密钥签名 | 无密钥无法生成合法签名 |

**签名+防重放请求结构**：

```
POST /api/v1/order/create
Headers:
  X-App-Key: isv_12345          ← 应用标识
  X-Timestamp: 1700000000       ← 时间戳（秒）
  X-Nonce: a1b2c3d4e5f6         ← 一次性随机数
  X-Signature: base64(hmac_sha256(secret, payload))

Body:
  {"userId": 123, "skuId": 456, "quantity": 1, "amount": 99.9}

签名串 = POST\n/api/v1/order/create\n1700000000\na1b2c3d4e5f6\n{"userId":...}
signature = HMAC-SHA256(appSecret, 签名串)
```

## 二、机制层：签名算法与验签

**客户端签名代码**：

```java
public class ApiClient {

    private String appKey;
    private String appSecret;   // 密钥（从安全配置读取，不硬编码）

    public HttpResponse post(String path, Object body) throws Exception {
        String timestamp = String.valueOf(System.currentTimeMillis() / 1000);
        String nonce = UUID.randomUUID().toString().replace("-", "");

        // 序列化 body（保证客户端和服务端序列化结果一致）
        String bodyJson = JSON.toJSONString(body);

        // 构造签名串
        String signPayload = buildSignPayload("POST", path, timestamp, nonce, bodyJson);

        // HMAC-SHA256 签名
        String signature = hmacSha256(appSecret, signPayload);

        // 发请求
        return httpClient.post(path)
            .header("X-App-Key", appKey)
            .header("X-Timestamp", timestamp)
            .header("X-Nonce", nonce)
            .header("X-Signature", signature)
            .body(bodyJson)
            .send();
    }

    private String buildSignPayload(String method, String path,
                                     String timestamp, String nonce, String body) {
        // 签名串格式：method\npath\ntimestamp\nnonce\nbody
        return String.join("\n", method, path, timestamp, nonce, body);
    }

    private String hmacSha256(String secret, String payload) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        byte[] hash = mac.doFinal(payload.getBytes(StandardCharsets.UTF_8));
        return Base64.getEncoder().encodeToString(hash);
    }
}
```

**服务端验签代码**（网关/拦截器）：

```java
@Component
public class SignatureInterceptor implements HandlerInterceptor {

    @Autowired private AppKeyService appKeyService;
    @Autowired private RedisTemplate redis;

    @Override
    public boolean preHandle(HttpServletRequest req, HttpServletResponse resp, Object handler) {
        String appKey = req.getHeader("X-App-Key");
        String timestamp = req.getHeader("X-Timestamp");
        String nonce = req.getHeader("X-Nonce");
        String signature = req.getHeader("X-Signature");

        // 1. 参数完整性检查
        if (StringUtils.isAnyBlank(appKey, timestamp, nonce, signature)) {
            resp.setStatus(401);
            return false;
        }

        // 2. 时间窗口校验（防重放：超 5 分钟拒绝）
        long requestTime = Long.parseLong(timestamp);
        long now = System.currentTimeMillis() / 1000;
        if (Math.abs(now - requestTime) > 300) {   // 5 分钟
            resp.setStatus(401);
            return false;
        }

        // 3. nonce 一次性校验（防重放：重复 nonce 拒绝）
        String nonceKey = "api:nonce:" + appKey + ":" + nonce;
        // SETNX：不存在才设置成功（返回 true），已存在返回 false
        Boolean isFirst = redis.opsForValue().setIfAbsent(nonceKey, "1",
            Duration.ofSeconds(300));
        if (Boolean.FALSE.equals(isFirst)) {
            resp.setStatus(401);   // nonce 已用过，拒绝
            return false;
        }

        // 4. 查询密钥（从安全配置/KMS）
        String appSecret = appKeyService.getSecret(appKey);
        if (appSecret == null) {
            resp.setStatus(401);
            return false;
        }

        // 5. 读取 body（注意：InputStream 只能读一次，用 ContentCachingRequestWrapper 缓存）
        String body = readBody(req);
        String path = req.getRequestURI();
        String method = req.getMethod();

        // 6. 重新构造签名串并验签
        String signPayload = String.join("\n", method, path, timestamp, nonce, body);
        String expectedSig = hmacSha256(appSecret, signPayload);

        if (!signature.equals(expectedSig)) {
            resp.setStatus(401);   // 签名不匹配
            return false;
        }

        // 7. 验签通过，记录 appKey 到上下文
        req.setAttribute("appKey", appKey);
        return true;
    }
}
```

## 三、机制层：敏感数据保护

**字段级加密**（AES-256-GCM）：

```java
public class SensitiveDataCrypto {

    private final SecretKey aesKey;   // 从 KMS 获取

    // 加密（如身份证号写入 DB 前加密）
    public String encrypt(String plainText) throws Exception {
        byte[] iv = new byte[12];   // GCM 推荐 12 字节 IV
        SecureRandom.getInstanceStrong().nextBytes(iv);

        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, aesKey,
            new GCMParameterSpec(128, iv));
        byte[] cipherText = cipher.doFinal(plainText.getBytes(UTF_8));

        // IV + 密文一起存储（IV 不是秘密，但要每次不同）
        byte[] combined = new byte[iv.length + cipherText.length];
        System.arraycopy(iv, 0, combined, 0, iv.length);
        System.arraycopy(cipherText, 0, combined, iv.length, cipherText.length);
        return Base64.getEncoder().encodeToString(combined);
    }

    // 解密（从 DB 读出后解密）
    public String decrypt(String encrypted) throws Exception {
        byte[] combined = Base64.getDecoder().decode(encrypted);
        byte[] iv = Arrays.copyOfRange(combined, 0, 12);
        byte[] cipherText = Arrays.copyOfRange(combined, 12, combined.length);

        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, aesKey, new GCMParameterSpec(128, iv));
        return new String(cipher.doFinal(cipherText), UTF_8);
    }
}
```

**字段脱敏存储**（单向哈希，不可逆）：

```java
// 手机号存储：明文用于业务，哈希用于检索
public class PhoneStorage {

    // 存储两份：加密的明文（业务用）+ SHA256 哈希（检索用）
    public PhoneRecord store(String phone) {
        return new PhoneRecord(
            crypto.encrypt(phone),                    // 加密明文
            DigestUtils.sha256Hex(phone + salt)       // 哈希（检索用，不可逆）
        );
    }

    // 按手机号查询：先哈希再比对（不用解密全部数据）
    public PhoneRecord findByPhone(String phone) {
        String hash = DigestUtils.sha256Hex(phone + salt);
        return repo.findByPhoneHash(hash);   // 用索引查哈希
    }

    // 展示脱敏：13812345678 → 138****5678
    public String mask(String phone) {
        return phone.replaceAll("(\\d{3})\\d{4}(\\d{4})", "$1****$2");
    }
}
```

**密钥管理（KMS）**：

```java
@Service
public class KmsKeyService {

    // 密钥不硬编码，从 KMS（如 AWS KMS / 阿里 KMS / 自研）获取
    @Cacheable(value = "dataKey", key = "'current'")
    public SecretKey getDataKey() {
        // 1. 从 KMS 请求数据密钥（加密后的）
        EncryptedKey encrypted = kmsClient.generateDataKey("master-key-id");
        // 2. KMS 返回明文密钥（只在内存，不落盘）
        return new SecretKeySpec(encrypted.getPlainText(), "AES");
    }

    // 密钥轮换（每 90 天）
    @Scheduled(cron = "0 0 0 1 */3 ?")   // 每季度 1 号
    public void rotateKey() {
        SecretKey oldKey = getDataKey();
        SecretKey newKey = generateNewKey();
        // 重新加密历史数据（异步，分批）
        reEncryptHistory(oldKey, newKey);
        // 切换密钥
        cacheManager.getCache("dataKey").put("current", newKey);
    }
}
```

## 四、底层本质：纵深防御的层次

回到第一性：**接口安全的本质是"纵深防御"——单层都不够，多层叠加才安全**。

```
攻击者视角的防御层次：

第 1 层：TLS（HTTPS）
  ├─ 防网络中间人窃听/篡改
  └─ 攻破方式：客户端被 Root/越狱，中间人代理（Charles + 信任证书）

第 2 层：应用层签名（HMAC-SHA256）
  ├─ 防请求篡改（改内容签名失效）
  └─ 攻破方式：客户端密钥被逆向提取（反编译 APK）

第 3 层：防重放（nonce + timestamp）
  ├─ 防请求复用（截获后重发）
  └─ 攻破方式：无（nonce 用过作废，无法绕过）

第 4 层：字段加密（AES-256）
  ├─ 防敏感数据泄露（即使拿到数据也是密文）
  └─ 攻破方式：密钥泄露（靠 KMS 管理）

第 5 层：风控（行为分析）
  ├─ 防合法身份的异常行为
  └─ 攻破方式：模仿正常行为（成本极高）
```

**为什么 HTTPS 不够**：HTTPS 防的是"网络传输过程中的中间人"——在传输层加密，路由器/网关看不到明文。但防不了"客户端自身的风险"——如果客户端 App 被 Root，攻击者可以用 Charles 抓 HTTPS 包（信任自签证书），看到明文请求。这时签名和字段加密是补充防线——即使看到明文，没有密钥无法伪造签名；即使拿到数据，没有 AES 密钥无法解密敏感字段。

**nonce 的本质是"一次性凭证"**：合法客户端每次请求生成新 nonce，服务端记录已用 nonce（Redis SETNX + TTL）。攻击者截获请求后重放，nonce 相同，服务端发现已用过，拒绝。nonce 的 TTL 等于 timestamp 窗口（5 分钟）——超过 5 分钟 timestamp 过期，nonce 也自然失效，Redis 自动清理。这样 nonce 存储不会无限增长。

## 五、AI 架构师加问：5 个

1. **用 AI 检测签名绕过漏洞，怎么做？**
   AI 分析历史请求日志，识别"签名校验异常"模式——同一 AppKey 的签名失败率突增（可能在暴力破解密钥）、不同 AppKey 的 nonce 冲突（密钥泄露后伪造）。异常告警安全团队。

2. **AI 辅助密钥管理，怎么做？**
   AI 监控密钥使用频率、加密数据量、轮换周期。密钥接近使用上限或超期未轮换，AI 提醒轮换。AI 不直接操作密钥（太敏感），只做提醒和合规检查。

3. **AI Agent 调用 API 怎么签名？**
   Agent 的每次 API 调用走标准签名流程（HMAC-SHA256 + nonce + timestamp）。Agent 持有密钥（从配置中心安全获取），密钥定期轮换。Agent 的请求被风控监控（高频调用告警）。

4. **签名机制接入 RAG，AI 怎么学？**
   知识库放签名算法文档、密钥管理规范、常见签名 bug 案例。AI 查询"这个接口怎么签名"时，RAG 返回签名算法+示例代码+注意事项（如 body 序列化要和服务端一致）。

5. **AI 生成签名代码，怎么验证正确性？**
   黄金样本：已知密钥+请求+正确签名的测试集。AI 生成的签名代码必须对样本 100% 通过。边界场景：空 body、特殊字符 body（中文/emoji）、大 body（流式签名）。AI 容易在"序列化一致性"上出错（JSON 字段顺序、空格）。

## 六、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"签名防篡改、nonce 防重放、字段加密防泄露、KMS 管密钥"**。

- **签名**：HMAC-SHA256(secret, method+path+timestamp+nonce+body)
- **防重放**：timestamp 5 分钟窗口 + nonce Redis SETNX 一次性
- **字段加密**：AES-256-GCM（IV 每次不同），手机号哈希+明文双存
- **密钥管理**：KMS 托管，定期轮换（90 天），不硬编码
- **纵深防御**：TLS + 签名 + 防重放 + 字段加密 + 风控

### 面试现场 60 秒回答

> 接口安全三层：签名防篡改、nonce 防重放、字段加密防泄露。签名用 HMAC-SHA256——客户端用密钥对 method+path+timestamp+nonce+body 算签名，服务端验签，改任何字段签名失效。防重放用 nonce + timestamp——timestamp 限 5 分钟窗口（防长期重放），nonce 是一次性随机数存 Redis（SETNX 保证唯一，重复拒绝）。敏感数据字段级 AES-256-GCM 加密（IV 每次不同），手机号等检索字段用 SHA256 哈希+加密明文双存。密钥用 KMS 托管定期轮换（90 天），绝对不硬编码。HTTPS 是底层防线但不够——客户端被 Root 后 HTTPS 可被代理抓包，签名和字段加密是补充。纵深防御五层：TLS 防网络中间人，签名防应用层篡改，nonce 防重放，字段加密防数据泄露，风控防异常行为。

## 七、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么 HTTPS 还要接口签名，不是重复吗？ | 用攻防场景说话：HTTPS 防网络中间人，但客户端被 Root 后可用代理抓 HTTPS 明文包。签名在应用层再加一道——即使抓到明文，没密钥无法伪造。用 signature_breach_count（签名绕过事故数）和 replay_attack_blocked（重放攻击拦截数）量化 |
| 证据追问 | 怎么证明签名机制有效？ | 渗透测试：篡改请求体（改金额）必须被拒（签名不匹配）；重放请求（相同 nonce）必须被拒；伪造签名（无密钥）必须被拒。安全扫描：密钥未硬编码、nonce 存储正确 |
| 边界追问 | 签名机制能防所有攻击吗？ | 不能。防不了客户端密钥被逆向提取（Root 后反编译拿密钥），解法是密钥动态下发（每次登录从服务端取临时密钥）+ 代码混淆。防不了社工攻击（骗用户自己签名转账） |
| 反例追问 | 什么场景不需要签名？ | 内部微服务间调用（网络可信，用 mTLS 足够）、开发测试环境（简化）、纯读的公开数据 API（无敏感操作）。这些场景签名的复杂度收益低于成本 |
| 风险追问 | 签名机制最大的风险？ | 主动点出：密钥泄露（客户端逆向提取）、nonce 存储失效（Redis 故障导致 nonce 检查跳过，重放攻击得逞）、时钟不同步（timestamp 窗口设太小导致正常请求被拒）、签名算法降级（MD5 已不安全） |
| 验证追问 | 怎么保证 nonce 检查不遗漏？ | Redis 必须可用（降级策略：Redis 挂了拒绝所有请求，不能跳过 nonce 检查）；压测验证 SETNX 在高并发下正确（并发同 nonce 只有一个成功）；混沌测试：kill Redis，验证请求被拒而非放行 |
| 沉淀追问 | 接口安全沉淀什么？ | 签名 SDK（多语言：Java/Go/Python）、签名验证网关组件、密钥管理平台（KMS+轮换）、安全测试工具（篡改/重放/伪造自动化测试） |

### 现场对话示例

**面试官**：nonce 存 Redis，Redis 挂了怎么办？

**候选人**：这是个关键问题。两种策略，取决于业务容忍度。第一种，Fail-Closed（关闭式降级）——Redis 挂了，nonce 检查无法执行，直接拒绝所有请求（返回 503）。这样安全（不会放过重放攻击），但影响可用性（Redis 挂了服务不可用）。适合安全敏感场景（支付/资金）。第二种，Fail-Open（开放式降级）——Redis 挂了，跳过 nonce 检查，只靠 timestamp 窗口防重放（5 分钟外的请求拒绝，5 分钟内的可能被重放）。这样可用（服务继续），但有 5 分钟的重放窗口风险。适合可用性敏感场景（商品浏览）。京东支付接口用 Fail-Closed（宁可不可用不可不安全），商品查询接口用 Fail-Open（短暂降级可接受）。另外，Redis 要做高可用——主从+哨兵+集群，单点 Redis 故障概率极低。即使故障，Fail-Closed 的窗口很短（Redis 恢复后立即恢复服务），业务影响可控。监控上，nonce 检查失败率告警，Redis 延迟告警，确保及时发现。

**面试官**：客户端密钥被逆向提取了怎么办？

**候选人**：这是移动端安全的痛点——APK/IPA 可被反编译，硬编码的密钥能被提取。多层防护。第一层，代码混淆——用 ProGuard/DexGuard 混淆代码，增加逆向难度（不是不可逆，是提高成本）。第二层，密钥动态下发——客户端不存固定密钥，每次启动从服务端获取临时密钥（基于设备指纹+登录态签发），密钥只在内存，退出即销毁。逆向拿到的是某次会话的临时密钥，过期失效。第三层，白盒加密——把密钥"融入"算法（密钥不再独立存在，而是打散到查找表里），即使拿到查找表也难以还原密钥。第四层，服务端监控异常——某密钥的调用模式异常（高频/异地/异常接口），风控冻结该密钥。第五层，硬件级防护——用 Android Keystore / iOS Secure Enclave 把密钥存在安全区，软件层拿不到。京东 App 的核心密钥用动态下发+白盒加密+设备绑定，逆向提取的密钥只能在一台设备上短时有效，批量伪造成本极高。

**面试官**：大文件上传怎么签名？

**候选人**：大文件（如 100MB 图片）直接签 body 不现实——序列化整个 body 算签名耗时且占内存。三种方案。第一种，文件摘要签名——客户端先算文件的 SHA256 摘要，只签摘要+文件名+大小+其他元数据。服务端验签元数据，接收文件后重新算摘要对比。这样签名只签元数据（小），文件完整性靠摘要保证。第二种，分片签名——大文件切片（如每 5MB 一片），每片单独签名，服务端逐片验签。支持断点续传（某片失败重传该片）。第三种，预签名 URL——客户端先调 API 获取上传凭证（签名后的 URL），直接 PUT 到对象存储（OSS/S3），不经过业务服务。业务服务只签凭证不传文件。京东商家上传商品图片用第三种——客户端获取 OSS 预签名 URL，直传 OSS，上传成功后回调通知业务服务。这样文件不经过业务服务（省带宽），签名只签凭证（轻量）。

## 常见考点

1. **HMAC 和普通签名（RSA）什么区别？**——HMAC 是对称签名（双方共享密钥），速度快但密钥分发难；RSA 是非对称（私钥签公钥验），安全性高但慢。API 签名常用 HMAC（性能好），数字证书用 RSA（非对称安全）。
2. **nonce 为什么不用自增 ID？**——自增 ID 可预测，攻击者能猜出下一个 nonce，伪造请求。nonce 必须随机（UUID/加密随机数），不可预测。
3. **时间戳为什么用秒不用毫秒？**——秒级精度足够（5 分钟窗口），且不同语言/系统的时间戳单位一致（Java 毫秒，Go 秒），秒级避免单位混乱。
4. **国密算法什么时候用？**——政务/金融/国企合规要求用国密（SM2/SM3/SM4）。SM2 替代 RSA（非对称），SM3 替代 SHA256（哈希），SM4 替代 AES（对称）。京东金融部分接口支持国密。

## 结构化回答

**30 秒电梯演讲：** 接口签名解决防篡改（请求内容不能被中间人改），防重放解决防复用（截获的请求不能被重发）。签名用 HMAC-SHA256（密钥+请求体+时间戳算摘要），防重放用 nonce（一次性随机数）+ timestamp（时间窗口）。敏感数据保护用 TLS 传输加密 + 字段级加密（AES）+ 脱敏存储（手机号哈希）

**展开框架：**
1. **签名算法** — HMAC-SHA256(secret, method+path+body+timestamp+nonce)
2. **防重放三要素** — timestamp（5 分钟窗口）+ nonce（一次性）+ signature（防篡改）
3. **nonce 存 Redi** — nonce 存 Redis（key=nonce，TTL=时间窗口），重复 nonce 拒绝

**收尾：** 以上是我的整体思路。您想继续深入聊——签名密钥怎么分发？


## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：接口签名、防重放与敏感数据保护 | "这题一句话：接口签名解决防篡改（请求内容不能被中间人改），防重放解决防复用（截获的请求不能被重发）。" | 开场钩子 |
| 0:15 | 签名算法示意/对比图 | "HMAC-SHA256(secret, method+path+body+timestamp+nonce)" | 签名算法要点 |
| 0:40 | 防重放三要素示意/对比图 | "timestamp（5 分钟窗口）+ nonce（一次性）+ signature（防篡改）" | 防重放三要素要点 |
| 1:25 | 总结卡 | "记住：签名 = HMAC-SHA2。下期见。" | 收尾 |
