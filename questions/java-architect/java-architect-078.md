---
id: java-architect-078
difficulty: L3
category: java-architect
subcategory: 系统解耦
tags:
- Java 架构师
- 文件上传
- 对象存储
- 断点续传
feynman:
  essence: 大文件上传的核心矛盾是"大文件 + 弱网络 + 不可靠中断"。解法是"分片上传 + 秒传（MD5 去重）+ 断点续传（记录已传分片）"。分片把大文件切成小块独立上传（并行加速、单片失败重传），MD5 秒传避免重复传同一文件，断点续传记录已传分片索引，中断后从未传分片继续。
  analogy: 像搬家运一本书（大文件）。不整本运（容易丢、运不动），撕成页（分片）逐页寄，每页有页码（分片索引）。寄之前先查快递公司有没有这本书的存档（MD5 秒传），有就不用寄了。寄到一半中断了，查哪些页寄到了（断点续传），只补寄缺失的页。
  first_principle: HTTP 上传的瓶颈是"单连接 + 不可中断恢复"。一个 1G 文件在 1Mbps 网络上传 2 小时，中途网络抖动就全部重来。分片解决"重来的代价"（只重传失败分片），并行解决"速度"（多分片多连接并发），秒传解决"重复"（MD5 匹配直接返回已存在对象），断点续传解决"中断恢复"（记录已传分片）。
  key_points:
  - 分片上传：文件切 5-10MB 块，每块独立上传，并行加速，单片失败只重传该块
  - 秒传：上传前算文件 MD5，查对象存储是否已存在，命中则直接返回 URL（不实际传输）
  - 断点续传：服务端记录已传分片索引，客户端中断后查询缺失分片继续传
  - 合并：全部分片上传后，通知对象存储合并（OSS CompleteMultipartUpload）
  - 直传：客户端直传对象存储（STS 临时凭证），不经后端（省带宽）
first_principle:
  problem: 用户上传 2G 视频，网络不稳定，如何保证上传成功、可恢复、不重复传？
  axioms:
  - 大文件单连接上传不可靠（网络抖动全部重来）
  - 重复文件不应重复传输（浪费带宽）
  - 上传中断必须可恢复（不从头来）
  rebuild: 五步流程——第一，客户端算文件 MD5（前端 FileReader + SparkMD5）。第二，秒传检查（MD5 查后端，命中返回已有 URL）。第三，分片（文件切 5MB 块，每块独立编号）。第四，并行上传（多分片多连接，直传 OSS 用 STS 凭证不经后端）。第五，断点续传（中断后客户端查已传分片，只补缺失）。全传完通知 OSS 合并。监控分片完成率、秒传命中率、上传中断率。
follow_up:
  - 分片大小怎么定？——5-10MB 平衡。太小（如 1MB）分片数太多管理开销大；太大（如 100MB）单片失败重传成本高。1G 文件用 5MB 分片 = 200 片，并行 5 个上传约几分钟
  - 秒传的 MD5 怎么算大文件？——不能整文件加载到内存（2G 文件爆内存）。用流式计算（分块读入，SparkMD5 增量计算），或算分片 MD5 组合。大文件秒传可用分片 MD5 组合判断（每个分片 MD5 + 整体 MD5）
  - 直传 OSS 为什么不经后端？——后端转发双倍带宽（客户端→后端→OSS）且增加延迟。用 STS 临时凭证让客户端直传 OSS，后端只发凭证和记录结果。后端省带宽，客户端更快
  - 断点续传的已传分片记录存哪？——存对象存储的元数据（OSS Multipart Upload 记录已传分片），或后端 DB 记录（uploadId + 分片索引列表）。客户端中断重启后查询未传分片
  - 上传完怎么保证文件完整？——合并时校验分片数和顺序（OSS CompleteMultipartUpload 按 partNumber 排序合并）。客户端比对合并后对象的 ETag（MD5）与本地 MD5 一致
memory_points:
  - 分片：5-10MB/块，并行上传，单片失败重传该块
  - 秒传：MD5 查重，命中直接返回 URL
  - 断点续传：记录已传分片，中断后补传缺失
  - 直传：STS 临时凭证，客户端直连 OSS，不经后端
  - 合并：CompleteMultipartUpload，按 partNumber 排序
  - 完整性：ETag（MD5）校验合并后对象
---

# 【Java 后端架构师】大文件上传、断点续传与对象存储

> 适用场景：JD 核心技术。商家上传商品视频（2G）、用户上传高清图片、批量导入商品数据（Excel 几百 MB）。架构师必须设计分片上传、秒传去重、断点续传方案，保证大文件在弱网下可靠上传。

## 一、概念层：大文件上传的四大能力

**四大能力对比**：

| 能力 | 解决的问题 | 实现机制 |
|------|-----------|---------|
| **分片上传** | 大文件单连接不可靠、速度慢 | 切 5-10MB 块，并行多连接上传 |
| **秒传** | 重复文件浪费带宽 | MD5 查重，命中不实际传输 |
| **断点续传** | 中断后从头重来 | 记录已传分片，补传缺失 |
| **直传** | 后端转发双倍带宽 | STS 凭证，客户端直连 OSS |

**完整上传流程**（面试必画）：

```
┌─────────┐                    ┌─────────┐               ┌─────────┐
│ 客户端   │                    │ 后端API  │               │  OSS    │
│(浏览器) │                    │(Java)   │               │(对象存储)│
└────┬────┘                    └────┬────┘               └────┬────┘
     │                              │                         │
     │ 1. 算文件 MD5（SparkMD5）    │                         │
     │                              │                         │
     │ 2. 秒传检查（传 MD5）        │                         │
     ├─────────────────────────────>│                         │
     │                              │ 2a. 查 DB：该 MD5 是否已存在│
     │<──── 命中：返回已有 URL ──────┤                         │
     │     （秒传成功，不传输）       │                         │
     │                              │                         │
     │ 3. 未命中：申请 STS + uploadId│                         │
     ├─────────────────────────────>│                         │
     │                              │ 3a. 向 OSS 初始化 Multipart │
     │                              ├────────────────────────>│
     │                              │<──── uploadId ──────────┤
     │<── STS 凭证 + uploadId ──────┤                         │
     │                              │                         │
     │ 4. 分片并行直传 OSS（不经后端）│                         │
     │─── PUT part 1 (5MB) ──────────────────────────────────>│
     │─── PUT part 2 (5MB) ──────────────────────────────────>│
     │─── PUT part 3 (5MB) ──────────────────────────────────>│  （并行）
     │<── ETag × 3 ───────────────────────────────────────────┤
     │                              │                         │
     │ 5. 中断！网络断了             │                         │
     │    重连后查已传分片            │                         │
     │─── GET 已传分片列表 ──────────────────────────────────>│
     │<── [part1✓, part2✓, part3✗] ──────────────────────────┤
     │                              │                         │
     │ 6. 补传缺失分片（断点续传）    │                         │
     │─── PUT part 3 ────────────────────────────────────────>│
     │<── ETag ──────────────────────────────────────────────┤
     │                              │                         │
     │ 7. 全部传完，通知合并          │                         │
     ├─────────────────────────────>│                         │
     │                              │ 7a. CompleteMultipartUpload│
     │                              ├────────────────────────>│
     │                              │  （OSS 按 partNumber 合并）│
     │                              │<── final ETag ──────────┤
     │                              │ 7b. 记录 MD5→URL（供秒传）│
     │<── 上传成功，返回 URL ────────┤                         │
```

## 二、机制层：分片上传 + MD5 校验代码

**客户端分片与 MD5 计算**（前端核心代码）：

```javascript
// 使用 SparkMD5 流式计算大文件 MD5（不爆内存）
async function calculateMD5(file) {
    return new Promise((resolve) => {
        const blobSlice = File.prototype.slice || File.prototype.mozSlice || File.prototype.webkitSlice;
        const chunkSize = 5 * 1024 * 1024;   // 5MB 分片
        const chunks = Math.ceil(file.size / chunkSize);
        const spark = new SparkMD5.ArrayBuffer();
        const fileReader = new FileReader();
        let currentChunk = 0;

        fileReader.onload = (e) => {
            spark.append(e.target.result);    // 增量计算
            currentChunk++;
            if (currentChunk < chunks) {
                loadNext();
            } else {
                resolve(spark.end());          // 最终 MD5
            }
        };

        function loadNext() {
            const start = currentChunk * chunkSize;
            const end = Math.min(start + chunkSize, file.size);
            fileReader.readAsArrayBuffer(blobSlice.call(file, start, end));
        }
        loadNext();
    });
}

// 分片上传
async function uploadFile(file) {
    // 1. 算 MD5
    const md5 = await calculateMD5(file);

    // 2. 秒传检查
    const checkResp = await fetch('/api/upload/check', {
        method: 'POST',
        body: JSON.stringify({ md5, fileName: file.name, size: file.size })
    });
    const checkResult = await checkResp.json();
    if (checkResult.instantHit) {
        return checkResult.url;   // 秒传成功，直接返回
    }

    // 3. 获取 STS + uploadId
    const initResp = await fetch('/api/upload/init', {
        method: 'POST',
        body: JSON.stringify({ md5, fileName: file.name, size: file.size })
    });
    const { stsToken, uploadId, bucket, objectKey } = await initResp.json();

    // 4. 分片并行上传（直传 OSS）
    const chunkSize = 5 * 1024 * 1024;
    const chunks = Math.ceil(file.size / chunkSize);
    const uploadedParts = checkResult.uploadedParts || [];  // 断点续传：已传分片

    const promises = [];
    for (let i = 0; i < chunks; i++) {
        const partNumber = i + 1;
        // 跳过已传分片（断点续传）
        if (uploadedParts.includes(partNumber)) continue;

        const start = i * chunkSize;
        const end = Math.min(start + chunkSize, file.size);
        const chunk = file.slice(start, end);

        promises.push(uploadPart(stsToken, bucket, objectKey, uploadId, partNumber, chunk));
    }

    const etags = await Promise.all(promises);

    // 5. 通知后端合并
    await fetch('/api/upload/complete', {
        method: 'POST',
        body: JSON.stringify({ uploadId, objectKey, md5 })
    });
}
```

**后端 API（Java + OSS SDK）**：

```java
@RestController
@RequestMapping("/api/upload")
public class UploadController {

    @Autowired private OSS ossClient;
    @Autowired private FileRecordMapper fileRecordMapper;

    // 1. 秒传检查
    @PostMapping("/check")
    public CheckResult check(@RequestBody CheckRequest req) {
        // 查 DB：该 MD5 是否已存在
        FileRecord record = fileRecordMapper.findByMd5(req.getMd5());
        if (record != null) {
            // 秒传命中
            return CheckResult.builder()
                .instantHit(true)
                .url(record.getUrl())
                .build();
        }
        // 未命中，返回已传分片（断点续传）
        List<Integer> uploadedParts = getUploadedParts(req.getMd5());
        return CheckResult.builder()
            .instantHit(false)
            .uploadedParts(uploadedParts)
            .build();
    }

    // 2. 初始化分片上传
    @PostMapping("/init")
    public InitResult init(@RequestBody InitRequest req) {
        String objectKey = "uploads/" + req.getMd5() + "/" + req.getFileName();

        // 向 OSS 初始化 Multipart Upload
        InitiateMultipartUploadRequest initReq = new InitiateMultipartUploadRequest(
            bucketName, objectKey);
        InitiateMultipartUploadResult initResult = ossClient.initiateMultipartUpload(initReq);

        // 生成 STS 临时凭证（让客户端直传 OSS）
        STSToken stsToken = stsService.generateUploadToken(objectKey);

        return InitResult.builder()
            .stsToken(stsToken)
            .uploadId(initResult.getUploadId())
            .bucket(bucketName)
            .objectKey(objectKey)
            .build();
    }

    // 3. 合并分片
    @PostMapping("/complete")
    public CompleteResult complete(@RequestBody CompleteRequest req) {
        // 列出已传分片（OSS 记录的）
        ListPartsRequest listReq = new ListPartsRequest(
            bucketName, req.getObjectKey(), req.getUploadId());
        PartListing listing = ossClient.listParts(listReq);

        // 按 partNumber 排序合并
        List<PartETag> partETags = listing.getParts().stream()
            .map(p -> new PartETag(p.getPartNumber(), p.getETag()))
            .sorted(Comparator.comparingInt(PartETag::getPartNumber))
            .collect(Collectors.toList());

        CompleteMultipartUploadRequest completeReq = new CompleteMultipartUploadRequest(
            bucketName, req.getObjectKey(), req.getUploadId(), partETags);
        CompleteMultipartUploadResult result = ossClient.completeMultipartUpload(completeReq);

        // 校验合并后 ETag
        String finalETag = result.getETag();
        if (!finalETag.contains(req.getMd5())) {
            throw new RuntimeException("MD5 校验失败，文件可能损坏");
        }

        // 记录 MD5 → URL（供下次秒传）
        String url = "https://" + bucketName + ".oss.jd.com/" + req.getObjectKey();
        fileRecordMapper.insert(new FileRecord(req.getMd5(), url));

        return CompleteResult.builder().url(url).build();
    }
}
```

## 三、机制层：STS 直传与断点续传

**STS 临时凭证生成**（让客户端直传 OSS）：

```java
@Service
public class StsService {

    public STSToken generateUploadToken(String objectKey) {
        // 生成 STS 临时凭证，只允许 PutObject 到指定路径
        Policy policy = new Policy()
            .addAction("oss:PutObject")
            .addResource("acs:oss:*:" + bucketName + ":" + objectKey + "*")
            .setExpireSeconds(3600);   // 1 小时有效

        AssumeRoleRequest request = new AssumeRoleRequest()
            .setRoleArn("acs:ram::123456:role/upload-role")
            .setRoleSessionName("client-upload")
            .setPolicy(policy.toJson());

        AssumeRoleResponse response = stsClient.getAssumeRole(request);
        AssumeRoleResponse.Credentials creds = response.getCredentials();

        return STSToken.builder()
            .accessKeyId(creds.getAccessKeyId())
            .accessKeySecret(creds.getAccessKeySecret())
            .securityToken(creds.getSecurityToken())
            .expiration(creds.getExpiration())
            .build();
    }
}
// 客户端用 STS 凭证直接 PUT 到 OSS，不经后端（省带宽）
```

**断点续传的已传分片查询**：

```java
// 查询 OSS 某个 uploadId 已传了哪些分片
public List<Integer> getUploadedParts(String md5) {
    String objectKey = "uploads/" + md5 + "/";
    String uploadId = fileRecordMapper.findUploadIdByMd5(md5);
    if (uploadId == null) return Collections.emptyList();

    ListPartsRequest listReq = new ListPartsRequest(bucketName, objectKey, uploadId);
    PartListing listing = ossClient.listParts(listReq);

    return listing.getParts().stream()
        .map(PartSummary::getPartNumber)
        .collect(Collectors.toList());
    // 客户端拿到已传分片列表，只补传缺失的
}
```

## 四、实战层：上传监控与可靠性

**上传监控指标**（核心 SLI）：

```yaml
# Prometheus 指标
groups:
  - name: upload
    rules:
      - alert: UploadInterruptionRate
        expr: |
          rate(upload_aborted_total[5m]) / rate(upload_started_total[5m]) > 0.1
        for: 5m
        annotations:
          summary: "上传中断率 > 10%，检查网络或 OSS 稳定性"

      - alert: InstantHitRateLow
        expr: |
          rate(upload_instant_hit_total[5m]) / rate(upload_check_total[5m]) < 0.3
        for: 30m
        annotations:
          summary: "秒传命中率 < 30%，可能有大量重复文件未命中缓存"

      - alert: ChunkCompletionLow
        expr: |
          avg(upload_chunk_completion_rate) < 0.95
        for: 10m
        annotations:
          summary: "分片平均完成率 < 95%，上传体验差"
```

**可靠性保障**：

```
分片级：
  - 每分片上传后 OSS 返回 ETag（该分片 MD5），客户端校验
  - 分片失败自动重试（3 次），重试只重传失败分片

文件级：
  - 合并时 OSS 校验分片数和顺序
  - 合并后 final ETag 包含整体 MD5，客户端比对
  - 不一致则删除重新上传

元数据级：
  - uploadId、已传分片记录持久化到 DB（不只依赖 OSS）
  - DB 与 OSS 分片列表定期对账（防不一致）
```

## 五、底层本质：为什么大文件上传这么复杂

回到第一性：**HTTP 上传的物理限制是"带宽 × 时间 = 文件大小"，大文件需要长时间稳定传输，而网络是不可靠的**。

- **单连接不可靠**：1G 文件在 10Mbps 带宽传 800 秒，这期间任何网络抖动（移动网络切换、WiFi 丢包）都会断开，单连接 HTTP 无法恢复只能从头来。分片解决——每片 5MB 传几秒，失败概率低，失败也只重传这一片。
- **并行加速**：单连接受 TCP 窗口和拥塞控制限制，带宽利用率低（尤其高延迟网络）。多分片多连接并行能占满带宽（HTTP/2 或多路复用）。5 个并行连接比单连接快 3-5 倍。
- **重复传输浪费**：100 个用户上传同一个安装包，如果都实际传输，浪费 100 倍带宽。秒传（MD5 查重）让第一个传完后，后续 99 个直接返回 URL。在团队协作、公共资源场景秒传命中率很高。
- **后端转发的带宽成本**：客户端 → 后端 → OSS 双倍带宽，后端成为瓶颈。直传（STS 凭证）让客户端直连 OSS，后端只做凭证签发和元数据记录，带宽成本降到 1/100。代价是信任客户端（STS 权限最小化，只允许 PutObject 到指定路径）。
- **断点续传的状态管理**：记录"传了哪些分片"需要服务端状态。OSS 的 Multipart Upload 天然支持——每个 uploadId 对应一组分片，listParts 能查已传分片。客户端中断重启后查询，只补缺失。关键状态（uploadId、MD5）持久化到 DB，不只依赖内存或 OSS。

**分片大小的权衡**：太小（1MB）分片数多（1G = 1000 片），管理开销大（1000 个 HTTP 请求）；太大（100MB）单片失败重传成本高。5-10MB 是平衡点——1G 文件 100-200 片，单片几秒传完，失败重传成本可接受。

## 六、AI 架构师加问：5 个

1. **AI 能自动调整分片大小吗？**
   能。AI 根据网络质量（RTT、丢包率、历史上传速度）动态调整分片大小——好网络用大分片（10MB，减少请求数），差网络用小分片（2MB，降低单片失败成本）。但调整要在上传前定（不能中途变），且分片大小要和 OSS 兼容。

2. **AI 辅助上传失败的根因分析？**
   AI 分析上传日志（失败分片号、HTTP 状态码、网络指标），归因到"客户端网络问题/OSS 限流/STS 过期/MD5 不匹配"。比人工 grep 快。但修复（如重新签发 STS）要确定性逻辑。

3. **AI 推理服务的模型文件怎么上传？**
   模型文件大（几 G 到几十 G）、上传频率低（部署时）。用 OSS 分片上传 + 直传。上传后校验 SHA256（比 MD5 更安全）。模型文件不涉及秒传（每个版本不同），但可以用分片 MD5 做增量更新（只传变化的层）。

4. **用 AI 做上传内容的合规审核？**
   上传后（OSS 合并完成）异步触发 AI 审核图片/视频——OCR 文字、图像识别违禁内容、视频关键帧分析。不合格的标记删除或人工复审。审核是异步的（不阻塞上传），用回调通知结果。

5. **AI Agent 上传文件怎么做权限控制？**
   Agent 用独立 STS 凭证，权限最小化（只能 PutObject 到 agent 工作目录），TTL 短（5 分钟）。每次上传审计记录（哪个 Agent、传了什么、大小）。防 Agent 失控批量上传——按 Agent 设配额（每天上传量上限）。

## 七、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"分片、秒传、断点续传、直传 STS、合并校验"**。

- **分片**：5-10MB/块，并行上传，单片失败重传该块
- **秒传**：MD5 查重，命中直接返回 URL
- **断点续传**：记录已传分片，中断后补传缺失
- **直传**：STS 临时凭证，客户端直连 OSS 不经后端
- **合并**：CompleteMultipartUpload 按 partNumber 排序，ETag 校验完整性

### 拟人化理解

把大文件上传想成**搬家寄书**。不整本寄（容易丢、运不动），撕成页（分片）逐页寄，每页有页码（分片编号）。寄之前先查快递公司有没有这本书的存档（MD5 秒传），有就不用寄了。寄到一半中断，查哪些页到了（断点续传），只补寄缺失的页。不用自己运到快递站再让快递站转寄（直传省去后端转发），直接用临时通行证（STS）放进快递柜（OSS）。

### 面试现场 60 秒回答

> 大文件上传四板斧：分片、秒传、断点续传、直传。第一步客户端用 SparkMD5 流式算文件 MD5（不爆内存）。第二步秒传检查——MD5 查后端 DB，命中直接返回已有 URL，不实际传输。第三步未命中则分片——文件切 5-10MB 块，每块独立编号。第四步直传 OSS——后端签发 STS 临时凭证，客户端多分片并行直连 OSS 上传（不经后端省带宽）。第五步断点续传——中断后客户端查 OSS 已传分片列表（listParts），只补传缺失分片。全传完通知后端调 CompleteMultipartUpload 合并，OSS 按 partNumber 排序合并，返回 final ETag。客户端比对 ETag 的 MD5 校验完整性。监控分片完成率（每分片平均成功率）、秒传命中率（MD5 命中比例）、上传中断率（abort/started 比）。

### 反问面试官

> 贵司对象存储用 OSS/S3/MinIO？上传走后端转发还是 STS 直传？最大单文件多大？这决定我聊分片策略还是直传架构。

## 八、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不让后端接收文件再传 OSS？ | 用带宽成本说话：后端转发双倍带宽（客户端→后端→OSS），后端成为瓶颈（带宽+CPU）。直传让客户端直连 OSS，后端只签发 STS 凭证，带宽成本降 99%。代价是信任客户端（STS 最小权限 + TTL 短） |
| 证据追问 | 怎么证明秒传真的省了带宽？ | 监控 instant_hit_rate（MD5 命中比例）和 bandwidth_saved（省的带宽 = 命中文件大小总和）。命中率 30% 意味着 30% 的上传流量被省了。按文件类型分——公共资源（头像、表情包）命中率高 |
| 边界追问 | 分片上传能处理所有文件场景吗？ | 不能。小文件（< 1MB）不值得分片（管理开销 > 收益），直接单次上传。超大文件（> 5G）分片数太多（OSS 限制 10000 片），要调大分片大小。加密文件（上传前加密）秒传 MD5 会变（除非用加密前 MD5） |
| 反例追问 | 什么场景不该用秒传？ | 用户私密文件（照片、文档）——即使是相同内容，用户期望"自己的文件"而不是别人的引用。内容随时变的文件（如带时间戳的截图）。秒传适合公共资源（安装包、模板） |
| 风险追问 | 大文件上传最大风险？ | ① 分片丢失（OSS 存储故障，需要重传）；② MD5 碰撞（极低概率，关键场景用 SHA256）；③ STS 泄漏（TTL 短 + 最小权限降低风险）；④ 合并失败（分片顺序错、数量不对，需要重试）；⑤ 秒传误判（不同文件 MD5 相同，极罕见） |
| 验证追问 | 怎么证明上传后文件完整？ | 分片级——每片 ETag 校验。文件级——合并后 final ETag 包含 MD5，客户端比对。定期抽检——随机下载已上传文件，算 MD5 比对存储记录。监控 upload_integrity_check_failure_rate |
| 沉淀追问 | 团队上传规范沉淀什么？ | 分片大小标准（5-10MB）、STS 权限策略模板、秒传 DB 设计（MD5 索引）、断点续传状态管理 SOP、上传监控大盘（分片完成率/秒传命中率/中断率）、文件完整性校验规范 |

### 现场对话示例

**面试官**：分片上传中断了，怎么知道哪些分片传成功了？

**候选人**：两层数据源。第一，OSS 的 Multipart Upload 天然记录——每个 uploadId 对应一组分片，调 listParts 能查已传分片的 partNumber 和 ETag。客户端中断重连后查 listParts，对比总分片数，只补缺失的。第二，后端 DB 记录 uploadId 和已传分片索引（每次分片上传成功后更新 DB），作为 OSS 的镜像。DB 和 OSS 定期对账（防 listParts 延迟或丢失）。客户端逻辑：重连后先调后端 /check 接口传 MD5，后端返回 uploadId 和 uploadedParts 列表，客户端跳过已传的只传缺失的。

**面试官**：秒传的 MD5 怎么算 2G 的大文件？

**候选人**：不能整文件加载到内存算（2G 文件爆内存）。用流式增量计算——前端用 SparkMD5.ArrayBuffer，分块读取文件（每块 5MB），增量 append 到 spark，最后 end() 得到整体 MD5。这个过程和分片读取是同一套逻辑（都是按 chunkSize 读），所以可以在分片的同时算 MD5，不用额外遍历。后端收到 MD5 后查 DB，如果该 MD5 已有记录（之前传过），直接返回 URL，不实际传输。注意：前端算 MD5 有时间成本（2G 文件几秒到十几秒），可以加 loading 提示。大文件秒传命中率一般不高（用户文件多为唯一内容），公共资源（安装包、模板）命中率高。

**面试官**：直传 OSS 用 STS，安全性怎么保证？

**候选人**：三点。第一，STS 权限最小化——Policy 只允许 PutObject 到指定路径（acs:oss:*:bucket:uploads/md5/*），不能 ListObject、DeleteObject、访问其他路径。第二，TTL 短——临时凭证有效期 1 小时（大文件足够），过期自动失效，泄漏窗口短。第三，后端审计——每次签发 STS 记录（哪个用户、哪个文件、何时），异常签发（短时间大量请求）告警。STS 泄漏的最坏情况是攻击者在 TTL 内往指定路径上传垃圾文件，不能访问其他资源。配合 OSS 的配额限制（每用户存储量上限）和内容审核（上传后异步审核），风险可控。

## 常见考点

1. **分片大小怎么定？**——5-10MB 平衡。太小分片数多管理开销大，太大单片失败重传成本高。1G 文件用 5MB = 200 片。OSS 限制最多 10000 片，5G 以上文件要调大分片。
2. **秒传怎么实现？**——客户端算文件 MD5（SparkMD5 流式计算），查后端 DB 是否已存在该 MD5。命中直接返回已有 URL，不实际传输。公共资源命中率高。
3. **断点续传状态存哪？**——OSS 的 Multipart Upload 记录已传分片（listParts 查询），后端 DB 镜像记录（uploadId + 分片索引）。客户端中断后查询缺失分片补传。
4. **为什么直传不经后端？**——后端转发双倍带宽（客户端→后端→OSS）。STS 临时凭证让客户端直连 OSS，后端只签发凭证，带宽成本降 99%。STS 最小权限 + TTL 短保证安全。
5. **怎么校验文件完整性？**——分片级每片 ETag（MD5）校验。合并时 OSS 按 partNumber 排序。合并后 final ETag 含整体 MD5，客户端比对。定期抽检下载校验。

## 结构化回答

**30 秒电梯演讲：** 大文件上传的核心矛盾是大文件 + 弱网络 + 不可靠中断。解法是分片上传 + 秒传（MD5 去重）+ 断点续传（记录已传分片）。分片把大文件切成小块独立上传（并行加速、单片失败重传），MD5 秒传避免重复传同一文件，断点续传记录已传分片索引，中断后从未传分片继续

**展开框架：**
1. **分片上传** — 文件切 5-10MB 块，每块独立上传，并行加速，单片失败只重传该块
2. **秒传** — 上传前算文件 MD5，查对象存储是否已存在，命中则直接返回 URL（不实际传输）
3. **断点续传** — 服务端记录已传分片索引，客户端中断后查询缺失分片继续传

**收尾：** 以上是我的整体思路。您想继续深入聊——分片大小怎么定？


## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：大文件上传、断点续传与对象存储 | "这题一句话：大文件上传的核心矛盾是大文件 + 弱网络 + 不可靠中断。" | 开场钩子 |
| 0:15 | 像搬家运一本书（大文件）类比图 | "打个比方：像搬家运一本书（大文件）。" | 核心类比 |
| 0:40 | 分片上传示意/对比图 | "文件切 5-10MB 块，每块独立上传，并行加速，单片失败只重传该块" | 分片上传要点 |
| 1:05 | 秒传示意/对比图 | "上传前算文件 MD5，查对象存储是否已存在，命中则直接返回 URL（不实际传输）" | 秒传要点 |
| 1:55 | 总结卡 | "记住：分片。下期见。" | 收尾 |
