---
id: java-architect-134
difficulty: L2
category: java-architect
subcategory: 安全架构
tags:
- Java 架构师
- 脱敏
- 加密
- 密钥轮转
feynman:
  essence: 数据脱敏/加密的本质是"按敏感等级分层处理"——展示层脱敏（手机号 138****8888）、传输层 TLS、存储层 AES-256 字段加密、备份层 TDE 透明加密。密钥轮转是"加密强度的时间衰减防御"——即使一个密钥泄露，轮转后旧密钥失活，泄露窗口可控。Java 后端落地三个抓手：(1) 自定义注解 + Jackson Serializer 自动脱敏；(2) AES-GCM 字段加密（DEK + KEK 双层密钥，envelope encryption）；(3) HashiCorp Vault 管理密钥，自动轮转 + 审计。
  analogy: 像物流仓库的"分层防护"。脱敏是出库时贴黑条（用户看不全）；传输加密是运输车带锁（路上安全）；存储加密是仓库保险柜（落库加密）；密钥轮转是定期换保险柜密码（即使旧密码泄露，换后无效）；KMS 是中央密码管理处（统一签发 + 审计 + 销毁）。
  first_principle: 为什么不能只用一个密钥？因为密钥使用越久，泄露概率越大（员工离职、日志泄露、侧信道攻击）。轮转把"长期暴露窗口"切成"N 个短期窗口"，每个窗口结束后旧密钥失活，泄露影响缩小。
  key_points:
  - 脱敏三档：展示脱敏（138****8888）、日志脱敏（不打印 PII）、传输脱敏（HTTPS）
  - 加密三档：传输 TLS、字段 AES-GCM、备份 TDE
  - 信封加密（Envelope Encryption）：DEK 加密数据，KEK 加密 DEK，KEK 存 KMS
  - 密钥版本化：每个密钥有 version，加密时记录 version，解密时按 version 查密钥
  - KMS：HashiCorp Vault / AWS KMS / 阿里云 KMS，统一签发 + 审计 + 轮转
first_principle:
  problem: 数据生命周期中（传输、存储、备份、展示），每一层都面临泄露风险，如何分层防护且密钥可控？
  axioms:
  - 单一防护层必破——传输加密了存储明文、存储加密了备份明文，等于没加密
  - 密钥不能和应用一起存储（同库同泄露），必须独立 KMS
  - 密钥使用越久泄露风险越大，必须定期轮转
  rebuild: 分层防护——传输 TLS（防中间人）+ 字段 AES-GCM（防 DB 拖库）+ 备份 TDE（防备份泄露）+ 展示脱敏（防 UI 泄露）。密钥用信封加密（DEK + KEK），DEK 每条数据独立随机（防批量拖库后批量破解），KEK 由 KMS 集中管理定期轮转（90 天）。所有密钥访问进审计日志，离开 KMS 必须授权 + 双因子。
follow_up:
  - AES-GCM 为什么优于 AES-CBC？——GCM 提供认证加密（AEAD），同时保证机密性 + 完整性；CBC 只机密性，需额外 MAC 防 padding oracle 攻击。GCM 还能并行加速。
  - DEK 怎么生成？——每条数据用 CSPRNG（如 SecureRandom）生成 256 bit 随机 key，加密后存储。绝对不能复用。
  - 密钥轮转时旧数据怎么解？——加密时记录 key_version，解密时按 version 查旧 KEK 解密；轮转是"新数据用新密钥"，旧数据按需 lazy re-encrypt 或后台批量迁移。
  - 脱敏规则怎么配置？——按字段类型（手机号 138****8888、身份证 110***********0010、邮箱 a***@b.com、银行卡 6212**********1234）。
  - 数据库透明加密（TDE）够吗？——不够。TDE 只防"磁盘丢失"（落盘加密），不防"DBA 查数据库"（数据在内存是明文）。敏感字段必须应用层 AES 加密。
memory_points:
  - 脱敏：展示（138****8888）+ 日志（不打印 PII）+ 传输（HTTPS）
  - 加密：传输 TLS + 字段 AES-GCM + 备份 TDE
  - 信封加密：DEK 加数据 + KEK 加 DEK，KMS 管 KEK
  - 密钥轮转：90 天 KEK + 每条独立 DEK
  - KMS：Vault / AWS KMS，统一签发 + 审计 + 轮转
---

# 【Java 后端架构师】数据脱敏、加密与密钥轮转架构

> 适用场景：JD 核心技术。京东用户表 5 亿条，含手机号、身份证、银行卡、地址等 PII。一次 DB 拖库（如内鬼导出）就泄露全部用户信息——监管罚款 + 用户客诉 + 品牌损失。引入字段加密 + 信封加密 + 密钥轮转后，即使 DB 被拖库，数据是密文无法直接读。

## 一、概念层

**数据生命周期分层防护**：

| 层 | 威胁 | 防护 |
|----|------|------|
| 输入 | 客户端篡改 | HTTPS（TLS 1.3）+ 签名 |
| 处理 | 内存泄露 | 最小化保留时间、用完即清 |
| 存储 | DB 拖库 | 字段 AES-GCM 加密 + 信封加密 |
| 备份 | 备份盘丢失 | TDE（Transparent Data Encryption） |
| 传输 | 中间人 | mTLS（服务间）+ HTTPS（外） |
| 展示 | UI 截图泄露 | 字段脱敏（手机号 138****8888） |
| 日志 | 日志聚合泄露 | 不打印 PII / 自动脱敏 |
| 销毁 | 数据残留 | 安全删除（多次覆写）+ 密钥销毁（密文永久不可解） |

**敏感数据分级**：

| 等级 | 例子 | 处理 |
|------|------|------|
| 极敏感（L4） | 密码、密钥、私钥 | 不可逆哈希（密码）+ KMS 托管（密钥） |
| 高敏（L3） | 身份证、银行卡、生物特征 | AES-GCM 加密 + 信封 + KMS |
| 中敏（L2） | 手机号、邮箱、地址 | AES 加密或字段脱敏 |
| 低敏（L1） | 用户名、注册时间 | 不加密，按需脱敏 |

## 二、机制层：脱敏实现

**自定义注解 + Jackson Serializer**：

```java
// 1. 脱敏注解
@Target(ElementType.FIELD)
@Retention(RetentionPolicy.RUNTIME)
@JacksonAnnotationsInside
@JsonSerialize(using = MaskingSerializer.class)
public @interface Sensitive {
    SensitiveType value();
}

public enum SensitiveType {
    PHONE, ID_CARD, EMAIL, BANK_CARD, ADDRESS, NAME
}

// 2. 自定义 Serializer
public class MaskingSerializer extends JsonSerializer<String>
        implements ContextualSerializer {

    private SensitiveType type;

    @Override
    public void serialize(String value, JsonGenerator gen, SerializerProvider provider)
            throws IOException {
        gen.writeString(mask(value, type));
    }

    @Override
    public JsonSerializer<?> createContextual(SerializerProvider prov, BeanProperty prop) {
        Sensitive ann = prop.getAnnotation(Sensitive.class);
        MaskingSerializer s = new MaskingSerializer();
        s.type = ann.value();
        return s;
    }

    private String mask(String value, SensitiveType type) {
        if (value == null) return null;
        switch (type) {
            case PHONE:      // 138****8888
                return value.length() == 11
                    ? value.substring(0,3) + "****" + value.substring(7)
                    : "****";
            case ID_CARD:    // 110***********0010
                return value.length() >= 14
                    ? value.substring(0,3) + "***********" + value.substring(value.length()-4)
                    : "****";
            case EMAIL:      // a***@b.com
                int at = value.indexOf("@");
                return at > 0
                    ? value.charAt(0) + "***" + value.substring(at)
                    : "****";
            case BANK_CARD:  // 6212**********1234
                return value.length() >= 8
                    ? value.substring(0,4) + "**********" + value.substring(value.length()-4)
                    : "****";
            case NAME:       // 张*
                return value.length() > 0 ? value.charAt(0) + "*".repeat(value.length()-1) : "*";
            case ADDRESS:    // 北京市朝阳区****
                return value.length() > 6 ? value.substring(0,6) + "****" : "****";
            default: return "****";
        }
    }
}

// 3. 使用
public class UserVO {
    private Long id;

    @Sensitive(SensitiveType.NAME)
    private String name;

    @Sensitive(SensitiveType.PHONE)
    private String phone;

    @Sensitive(SensitiveType.ID_CARD)
    private String idCard;

    @Sensitive(SensitiveType.EMAIL)
    private String email;
}
// 返回前端自动脱敏：{id:1, name:"张*", phone:"138****8888", idCard:"110***********0010"}
```

**日志脱敏**（Logback 配置）：

```xml
<!-- logback.xml - 用 Pattern 替换 -->
<pattern>
  %replace(%msg){'phone":"(\d{3})\d{4}(\d{4})', 'phone":"$1****$2'}
</pattern>
```

或者用 Logstash Logback Encoder 自定义 Converter：

```java
public class PiiMaskingConverter extends CompositeConverter<ILoggingEvent> {
    private static final Pattern PHONE = Pattern.compile("(1[3-9])\\d{9}");
    private static final Pattern ID_CARD = Pattern.compile("(\\d{17}[\\dXx])");

    @Override
    protected String transform(ILoggingEvent event, String in) {
        String s = PHONE.matcher(in).replaceAll("$1********");
        return ID_CARD.matcher(s).replaceAll("******************");
    }
}
```

## 三、机制层：AES-GCM 字段加密 + 信封加密

**信封加密流程**（必画）：

```
数据加密流程：
  1. 应用向 KMS 申请 KEK（Key Encryption Key）的当前版本
  2. 应用生成随机 DEK（Data Encryption Key，256 bit AES）
  3. 用 DEK 加密数据：ciphertext = AES-GCM(plaintext, DEK, nonce)
  4. 用 KEK 加密 DEK：encrypted_dek = AES-GCM(DEK, KEK)
  5. 存储：{ciphertext, encrypted_dek, kek_version, nonce}

数据解密流程：
  1. 读 {ciphertext, encrypted_dek, kek_version, nonce}
  2. 向 KMS 申请 kek_version 对应的 KEK
  3. 用 KEK 解 encrypted_dek 得到 DEK
  4. 用 DEK + nonce 解 ciphertext 得到 plaintext
  5. 用完即清 DEK（不在内存久留）
```

**Java 实现**：

```java
@Service
public class FieldEncryptionService {

    @Autowired private KmsClient kmsClient;
    @Autowired private SecureRandom random = new SecureRandom();

    // 加密
    public EncryptedField encrypt(String plaintext) throws Exception {
        // 1. 生成随机 DEK
        byte[] dek = new byte[32];  // 256-bit AES
        random.nextBytes(dek);

        // 2. 生成 nonce
        byte[] nonce = new byte[12];  // GCM 推荐 12 字节
        random.nextBytes(nonce);

        // 3. 用 DEK 加密数据
        SecretKey dekKey = new SecretKeySpec(dek, "AES");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, dekKey, new GCMParameterSpec(128, nonce));
        byte[] ciphertext = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));

        // 4. 从 KMS 拿当前 KEK，加密 DEK
        KeyVersion kekVersion = kmsClient.getCurrentKeyVersion("user-data-kek");
        byte[] encryptedDek = kmsClient.encrypt("user-data-kek", dek);

        // 5. 立刻清内存
        Arrays.fill(dek, (byte) 0);

        return new EncryptedField(
            Base64.getEncoder().encodeToString(ciphertext),
            Base64.getEncoder().encodeToString(encryptedDek),
            Base64.getEncoder().encodeToString(nonce),
            kekVersion.getVersion()
        );
    }

    // 解密
    public String decrypt(EncryptedField field) throws Exception {
        // 1. 从 KMS 解密 DEK
        byte[] encryptedDek = Base64.getDecoder().decode(field.getEncryptedDek());
        byte[] dek = kmsClient.decrypt("user-data-kek", field.getKekVersion(), encryptedDek);

        // 2. 用 DEK 解密数据
        SecretKey dekKey = new SecretKeySpec(dek, "AES");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, dekKey,
            new GCMParameterSpec(128, Base64.getDecoder().decode(field.getNonce())));
        byte[] plaintext = cipher.doFinal(Base64.getDecoder().decode(field.getCiphertext()));

        // 3. 立刻清内存
        Arrays.fill(dek, (byte) 0);
        return new String(plaintext, StandardCharsets.UTF_8);
    }
}

// Entity
@Entity
public class User {
    @Id private Long id;
    private String name;
    @Convert(converter = EncryptedStringConverter.class)
    private String phone;           // 存储为密文
    @Convert(converter = EncryptedStringConverter.class)
    private String idCard;
}

// JPA Converter 自动加解密
@Converter
public class EncryptedStringConverter implements AttributeConverter<String, String> {

    @Autowired private FieldEncryptionService encryptor;  // 静态注入

    @Override
    public String convertToDatabaseColumn(String plaintext) {
        try { return JSON.toJSONString(encryptor.encrypt(plaintext)); }
        catch (Exception e) { throw new RuntimeException(e); }
    }

    @Override
    public String convertToEntityAttribute(String dbValue) {
        try {
            EncryptedField field = JSON.parseObject(dbValue, EncryptedField.class);
            return encryptor.decrypt(field);
        } catch (Exception e) { throw new RuntimeException(e); }
    }
}
```

## 四、机制层：KMS 集成与密钥轮转

**HashiCorp Vault 配置**（必背）：

```bash
# 启动 Vault dev 模式（生产用 Raft storage + auto-unseal）
vault server -dev -dev-root-token-id="root"

# 启用 transit engine（加密即服务）
vault secrets enable transit

# 创建 KEK（user-data-kek），自动轮转 90 天
vault write -f transit/keys/user-data-kek \
    type=aes256-gcm96 \
    auto_rotate_period=2160h \
    exportable=false \
    allow_plaintext_backup=false

# 加密 DEK（应用调用）
vault write transit/encrypt/user-data-kek plaintext=$(base64 <<< "$DEK")

# 解密 DEK
vault write transit/decrypt/user-data-kek ciphertext="$ENC_DEK"

# 手动轮转（强制）
vault write -f transit/keys/user-data-kek/rotate

# 查看版本
vault read transit/keys/user-data-kek
# 输出：latest_version 2, ...
```

**Java Vault 客户端**：

```java
@Service
public class VaultKmsClient implements KmsClient {

    @Autowired private VaultTemplate vault;

    @Override
    public byte[] encrypt(String keyName, byte[] plaintext) {
        String b64 = Base64.getEncoder().encodeToString(plaintext);
        VaultResponse resp = vault.write("transit/encrypt/" + keyName,
            Map.of("plaintext", b64));
        String ciphertext = (String) resp.getRequiredData().get("ciphertext");
        return ciphertext.getBytes();
    }

    @Override
    public byte[] decrypt(String keyName, int version, byte[] ciphertext) {
        String ct = new String(ciphertext);
        VaultResponse resp = vault.write("transit/decrypt/" + keyName,
            Map.of("ciphertext", ct));
        String b64 = (String) resp.getRequiredData().get("plaintext");
        return Base64.getDecoder().decode(b64);
    }

    @Override
    public KeyVersion getCurrentKeyVersion(String keyName) {
        VaultResponseSupport<KeyMetadata> resp = vault.read("transit/keys/" + keyName);
        return new KeyVersion(resp.getRequiredData().getLatestVersion());
    }
}
```

**轮转策略**：

| 密钥类型 | 轮转周期 | 原因 |
|---------|---------|------|
| **DEK** | 每条数据独立 | 防批量拖库后批量破解 |
| **KEK** | 90 天 | 减少长期暴露窗口 |
| **TLS 证书** | 90 天（Let's Encrypt 风格） | 减少私钥泄露影响 |
| **JWT 签名密钥** | 30 天 | 配合 kid 标识版本 |

## 五、底层本质：信封加密为什么这样设计

回到第一性：**信封加密（Envelope Encryption）解决"性能 + 安全 + 可用性"三角**。

- **为什么不用 KEK 直接加密数据**：KMS 在远端，每次加解密都调 KMS 网络开销大（10-50ms）。直接 KEK 加密每条数据都要调 KMS，性能不可接受。
- **为什么用 DEK 加密数据，KEK 加密 DEK**：DEK 在应用本地生成和使用（性能），加密后的 DEK 通过 KMS 解（安全）。这样网络开销只有"DEK 加密"一次（< 1ms），数据加解密在本地（AES 硬件加速）。
- **为什么每条数据独立 DEK**：如果所有数据共用一个 DEK，DEK 泄露所有数据裸奔。每条独立 DEK 让"泄露一条 = 泄露一条"，不会批量爆炸。
- **为什么 KEK 轮转**：KEK 长期使用泄露风险累积。轮转后新数据用新 KEK 加密 DEK，旧数据保留旧 encrypted_dek（带 key_version），轮转不影响旧数据可解。轮转的本质是"切短暴露窗口"。

**密钥销毁 = 终极删除**：传统"删除数据"是删行，磁盘残留可恢复。密文数据要"真删"，只需销毁对应 KEK 版本——所有用该 KEK 加密的 DEK 永久不可解，密文变垃圾。这是 GDPR"被遗忘权"的工程实现。

## 六、AI 架构师加问：5 个

1. **LLM 训练数据怎么脱敏？**
   训练前 NLP 流水线识别 PII（手机号、身份证、邮箱）→ 替换为占位符（如 [PHONE]）→ 训练。推理时 LLM 不输出原始 PII，输出时按规则脱敏。RAG 场景检索的 PII 必须脱敏后才能进 prompt。

2. **LLM 怎么自动识别敏感字段？**
   NER 模型（如 spaCy、LLM 函数调用）识别 PII 实体（PER、PHONE、EMAIL、ID_CARD）。结合字段名启发式（如 `phone`、`id_card` 列名）。但识别准确率 95%+，剩下 5% 要人工 review。

3. **AI 服务调 KMS 怎么鉴权？**
   AI 服务用 service account JWT 向 Vault 鉴权，scope 限定能用哪个 key、能 encrypt 还是 decrypt。所有 KMS 调用进 audit log（谁、什么时候、用了哪个 key、加解密什么）。

4. **用 LLM 辅助密钥轮转决策？**
   LLM 读密钥使用日志 + 泄露新闻（如某 CVE 暴露）+ 业务量，推荐轮转时机（如"密钥用了 80 天 + 最近有内鬼事件 → 立即轮转"）。但决策落地必须人工确认。

5. **AI 推理结果的敏感信息怎么处理？**
   LLM 输出做 PII 检测（NER 模型扫描输出），发现敏感信息自动脱敏（如把生成的回复里的真实手机号改成 ***）。或者用 prompt 约束"不要输出真实手机号"。

## 七、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"分层防护、信封加密、Vault 管 KEK、90 天轮转"**。

- **分层防护**：传输 TLS + 字段 AES-GCM + 备份 TDE + 展示脱敏
- **信封加密**：DEK 加数据（本地快）+ KEK 加 DEK（KMS 安全）
- **KMS（Vault）**：KEK 集中签发 + 审计 + 90 天自动轮转
- **每条独立 DEK**：防批量拖库后批量破解
- **密钥销毁 = 终极删除**：删 KEK 让密文永久不可解

### 拟人化理解

把数据防护想成**物流仓库分层防护**。脱敏是出库贴黑条（用户看不到全貌）；传输加密是运输车带锁；存储加密是仓库保险柜；备份加密是异地仓库的保险柜；密钥轮转是定期换保险柜密码；KMS 是中央密码管理处（统一签发 + 审计 + 销毁）。信封加密是"运输时把保险柜密码锁在更高级的保险柜里"——开外层保险柜（KMS）拿内层密码（DEK），开内层密码拿货物。

### 面试现场 60 秒回答

> 我们用分层防护：传输 HTTPS + mTLS 服务间；字段 AES-GCM 加密（手机号、身份证、银行卡）+ 信封加密（每条数据独立 DEK，KEK 加密 DEK 存 KMS）；备份用 MySQL TDE；展示用 @Sensitive 注解 + Jackson Serializer 自动脱敏（138****8888）；日志用 Logback Converter 扫 PII。密钥管理用 HashiCorp Vault，KEK 90 天自动轮转，所有 KMS 调用进 audit log。信封加密的核心是"DEK 本地加解密（性能）+ KEK 集中托管（安全）"——KMS 调用只有 DEK 加解密一次（< 1ms），数据加解密在本地。轮转时新数据用新 KEK，旧数据按 key_version 解，不影响存量。"密钥销毁 = 终极删除"——删 KEK 让密文永久不可解，这是 GDPR 被遗忘权的工程实现。

### 反问面试官

> 贵司 PII 数据加密用什么方案？字段加密还是数据库 TDE？KMS 用 Vault 还是云厂商？密钥轮转周期多久？

## 八、苏格拉底式面试追问（7 层表格 + 现场对话）

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不用数据库 TDE 就够了？ | 用威胁模型说话：TDE 只防"磁盘丢失"，不防"DBA 拖库"（数据在内存明文）。字段加密防 DBA 直接 select 拿明文，是纵深防御 |
| 证据追问 | 怎么证明加密有效？ | 模拟拖库：DBA 直接 select 看到的是密文；渗透测试：尝试在内存 dump 找明文（应只在调用瞬间存在）；密钥审计：所有 KMS 调用有日志 |
| 边界追问 | 加密能解决什么，不能解决什么？ | 解决：拖库泄露、磁盘丢失、备份泄露。不能解决：应用被攻破后内存里取明文（需要运行时保护）、密钥本身被泄露（需要 KMS 治理） |
| 反例追问 | 什么场景不做字段加密？ | 公开数据（如商品名）、低敏数据（注册时间）、查询性能要求极高（加密后无法索引）。这些场景直存明文 |
| 风险追问 | 加密上线最大风险？ | 主动点出：密钥丢失导致数据永久不可解（必须密钥备份）、性能下降（加解密开销 1-2ms）、查询受限（密文无法 LIKE 查询）、轮转失败导致业务中断 |
| 验证追问 | 怎么验证密钥轮转不影响业务？ | 灰度切流：先新数据用新 KEK，旧数据按 version 解；监控解密成功率（应 100%）；故障演练：杀 KMS 实例，业务降级（缓存 DEK） |
| 沉淀追问 | 团队数据加密治理沉淀什么？ | 字段加密 starter（注解 + Converter）、Vault 部署 SOP、密钥轮转流程、加密字段清单、脱敏规则库、安全审计 dashboards |

### 现场对话示例

**面试官**：字段加密后怎么查询？比如按手机号查用户。

**候选人**：这是字段加密的最大痛点。三种方案。第一，盲索引（Blind Index）——用一个固定密钥的 HMAC 把手机号 hash 出来单独存一列 `phone_hash`，建索引。查询时 `WHERE phone_hash = HMAC(查询手机号)`。HMAC 不可逆，但能等值查询。第二，确定性加密（Deterministic Encryption）——同样明文加密成同样密文（用固定 IV），可以等值查询但安全性弱（同密文攻击）。第三，敏感度低就别加密（手机号低敏可直接存）。京东的实操：手机号用盲索引（HMAC-SHA256），身份证完全加密（不查询，按 user_id 关联），邮箱确定性加密（可等值查但加 salt 防 rainbow table）。

**面试官**：密钥轮转时旧数据怎么办？

**候选人**：两种策略。第一，lazy re-encrypt——旧数据按 key_version 解密时，顺手用新 KEK 重新加密 DEK 写回。这样轮转是无感的，旧数据被读到时才升级。第二，批量迁移——后台 job 扫描所有旧 version 数据批量 re-encrypt，适合数据量小或必须强制升级的场景。生产推荐 lazy 模式（零停机）+ 定期 batch 迁移（清理遗留）。轮转流程：(1) 新 KEK 上线，新数据用新 version；(2) 旧 KEK 保留可解（不能删，否则旧数据不可读）；(3) lazy 或 batch 升级；(4) 所有数据升级后旧 KEK 标记 deprecated，但保留 90 天再销毁（兜底）。

**面试官**：KMS 挂了怎么办？

**候选人**：这是关键风险。三层保护。第一，KMS 高可用部署——Vault 多副本 + Raft storage + auto-unseal（用云 KMS 做 unseal key）。第二，应用本地缓存 DEK——解密后的 DEK 在内存 cache（TTL 5 分钟），KMS 短暂故障不影响已 cache 的数据。第三，降级策略——KMS 完全不可用时只允许读已有缓存（不加密新数据），或 fallback 到应急密钥（保险柜备份的纸质密钥，仅灾难启用）。京东的实操：Vault 3 副本跨机房，应用 cache DEK 5 分钟，从未因 KMS 故障影响业务。

## 常见考点

1. **AES-GCM 为什么优于 CBC？**——GCM 提供 AEAD（认证加密），同时保证机密性 + 完整性；CBC 只机密性需额外 MAC。GCM 还能并行加速。
2. **加密索引怎么建？**——盲索引（HMAC 单独列建索引）支持等值查询；范围查询不友好（要么不加密，要么用 OPE 同态加密但安全性弱）。
3. **TDE 和字段加密冲突吗？**——不冲突，互补。TDE 防磁盘丢失，字段加密防 DBA 拖库。两者叠加是纵深防御。
4. **密钥怎么安全备份？**——KMS 用 Shamir's Secret Sharing 拆成 N 份分给 N 个人，需要 K（K < N）份才能恢复。物理备份在保险柜。
5. **GDPR 被遗忘权怎么实现？**——加密数据删除行 + 删除对应 KEK 版本（密文永久不可解）。这是"加密即删除"的工程实现。

## 结构化回答

**30 秒电梯演讲：** 数据脱敏/加密的本质是按敏感等级分层处理——展示层脱敏（手机号 138****8888）、传输层 TLS、存储层 AES-256 字段加密、备份层 TDE 透明加密。密钥轮转是加密强度的时间衰减防御——即使一个密钥泄露，轮转后旧密钥失活，泄露窗口可控。Java 后端落地三个抓手：(1) 自定义注解 + Jackson Serializer 自动脱敏；(2) AES-GCM 字段加密（DEK + KEK 双层密钥，envelope encryption）；(3) HashiCorp Vault 管理密钥，自动轮转 + 审计

**展开框架：**
1. **脱敏三档** — 展示脱敏（138****8888）、日志脱敏（不打印 PII）、传输脱敏（HTTPS）
2. **加密三档** — 传输 TLS、字段 AES-GCM、备份 TDE
3. **信封加密** — 信封加密（Envelope Encryption）：DEK 加密数据，KEK 加密 DEK，KEK 存 KMS

**收尾：** 以上是我的整体思路。您想继续深入聊——AES-GCM 为什么优于 AES-CBC？


## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：数据脱敏、加密与密钥轮转架构 | "这题核心是——数据脱敏/加密的本质是按敏感等级分层处理——展示层脱敏（手机号 138****8888）、传输层……" | 开场钩子 |
| 0:15 | 脱敏三档示意/对比图 | "展示脱敏（138****8888）、日志脱敏（不打印 PII）、传输脱敏（HTTPS）" | 脱敏三档要点 |
| 0:40 | 加密三档示意/对比图 | "传输 TLS、字段 AES-GCM、备份 TDE" | 加密三档要点 |
| 1:25 | 总结卡 | "记住：脱敏。下期见。" | 收尾 |
