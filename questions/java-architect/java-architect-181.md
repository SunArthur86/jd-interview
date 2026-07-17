---
id: java-architect-181
difficulty: L2
category: java-architect
subcategory: 文件存储
tags:
- Java 架构师
- 文件上传
- 秒传
- 分片上传
- 病毒扫描
feynman:
  essence: 文件上传的核心是"MD5 秒传 + 分片上传断点续传 + 异步病毒扫描"。秒传——上传前算 MD5 查库，命中则直接复用已有文件（不重复传）。分片上传——大文件切片并行传，支持断点续传。病毒扫描——上传后异步调 ClamAV 扫描，感染文件隔离。
  analogy: 像快递入库——先查条码（MD5 秒传），已有的直接备注"已有库存"不用重新入库。大件拆包分批入库（分片），某批失败只重传那批（断点续传）。入库后过安检（病毒扫描），违禁品隔离。
  first_principle: 大文件上传慢（GB 级要几分钟）且可能失败（网络中断）。秒传避免重复传相同文件（省带宽）。分片上传支持并行 + 断点续传（失败重传某片而非全部）。病毒扫描防恶意文件（必须在用户可访问前完成）。
  key_points:
  - 秒传：上传前算 MD5，查 file 表命中则复用 fileId 不重复传
  - 分片上传：大文件切 5MB 片，并行上传，支持断点续传
  - 断点续传：记录已传分片，失败重传缺失的片
  - 病毒扫描：异步调 ClamAV，扫描中文件不可访问，感染隔离
  - 合并：全部分片上传完触发合并（或对象存储 compose）
first_principle:
  problem: GB 级大文件上传慢易失败，重复文件浪费带宽，恶意文件有安全风险，怎么解决？
  axioms:
  - 大文件单次上传耗时长（分钟级）且网络中断要重传全部
  - 相同文件重复上传浪费带宽和存储（用户传过/别人传过）
  - 恶意文件（病毒/木马）不能让用户访问
  - 并行上传分片可加速，但合并要保证一致性
  rebuild: 秒传——上传前客户端算文件 MD5，查 file 表（md5 → fileId），命中直接返回 fileId 不传文件。分片上传——大文件切 5MB 片，每片独立上传（可并行），记录已传分片到 upload_chunk 表，失败重传缺失的片。全部分片上传完触发合并（对象存储 compose API 或应用层合并）。病毒扫描——合并后异步调 ClamAV，扫描中文件状态=SCANNING 不可访问，感染的状态=INFECTED 隔离。
follow_up:
  - MD5 碰撞怎么办？——用 SHA-256（更安全）或 MD5 + 文件大小双校验。MD5 碰撞概率极低（2^128），商业场景 MD5 够用，高安全用 SHA-256。
  - 分片大小怎么定？——5MB（经验值）。太小（如 1MB）请求数多开销大，太大（如 100MB）单片失败重传成本高。5MB 平衡。
  - 断点续传怎么实现？——上传前查 upload_chunk 表已传哪些片，客户端只传缺失的片。每片上传成功记录到表。
  - 病毒扫描同步还是异步？——异步。扫描慢（秒级），同步会让上传接口超时。上传完立即返回"扫描中"，后台扫描完通知用户。
  - 合并怎么保证一致性？——对象存储 compose（原子操作）或应用层合并后校验 MD5。合并完删分片。
memory_points:
  - 秒传：客户端算 MD5 查库，命中复用 fileId
  - 分片：5MB/片，并行上传，断点续传（upload_chunk 表）
  - 合并：全片传完触发（对象存储 compose 或应用层合并）
  - 病毒扫描：异步 ClamAV，SCANNING 状态不可访问，感染隔离
  - 安全：SHA-256 替代 MD5 或 MD5 + size 双校验
---

# 【Java 后端架构师】文件秒传、分片上传与病毒扫描

> 适用场景：JD 文件上传（商品图片/视频/商家资质/用户头像）。商家上传商品视频可能 GB 级，相同商品图重复上传浪费带宽。架构师要设计的是"MD5 秒传 + 分片上传断点续传 + 异步病毒扫描"的文件系统。

## 一、概念层：上传流程

```
客户端算 MD5 → 查 file 表（秒传检查）
    ↓ 命中：返回 fileId（秒传，不传文件）
    ↓ 未命中：
    大文件 → 分片（5MB/片）→ 并行上传 → 记录 upload_chunk
                                       ↓
                          全片传完 → 合并（compose）→ 异步病毒扫描
                                                        ↓
                                              干净：file 状态=READY
                                              感染：file 状态=INFECTED（隔离）
```

## 二、机制层：秒传（MD5 查库）

```java
@Service
public class UploadService {

    private final FileRepo fileRepo;

    /**
     * 秒传检查：客户端先算 MD5，查库命中则直接复用
     */
    public UploadResponse checkInstantUpload(String md5, long size) {
        // 1. 查 file 表：md5 → fileId
        FileMeta existing = fileRepo.findByMd5AndSize(md5, size);
        if (existing != null && existing.getStatus() == FileStatus.READY) {
            // 秒传成功：直接返回 fileId，不传文件
            return UploadResponse.instantSuccess(existing.getFileId());
        }

        // 2. 未命中：返回需要上传
        return UploadResponse.needUpload(md5, size);
    }
}
```

```sql
-- file 表：MD5 唯一索引支持秒传
CREATE TABLE file_meta (
    file_id VARCHAR(64) PRIMARY KEY,
    md5 CHAR(32) NOT NULL,
    sha256 CHAR(64),
    size BIGINT NOT NULL,
    storage_path VARCHAR(512),        -- 对象存储路径
    status VARCHAR(20),               -- UPLOADING/SCANNING/READY/INFECTED
    create_time DATETIME,
    UNIQUE KEY uk_md5_size (md5, size)   -- 秒传查库用
);
```

## 三、机制层：分片上传

```java
@Service
@Slf4j
public class ChunkUploadService {

    private final ObjectStorageClient ossClient;       // OSS/S3/MinIO
    private final UploadChunkRepo chunkRepo;
    private static final long CHUNK_SIZE = 5 * 1024 * 1024;   // 5MB

    /**
     * 初始化分片上传：分配 uploadId，返回分片清单
     */
    public InitResponse initChunkUpload(String md5, long size) {
        String fileId = generateFileId();
        int chunkCount = (int) Math.ceil((double) size / CHUNK_SIZE);

        // 对象存储初始化分片上传
        String uploadId = ossClient.initMultipartUpload(fileId);

        // 记录上传任务
        UploadTask task = new UploadTask(fileId, uploadId, md5, size,
            chunkCount, UploadStatus.INITIALIZED);
        taskRepo.save(task);

        return new InitResponse(fileId, uploadId, chunkCount,
            CHUNK_SIZE);
    }

    /**
     * 上传单个分片（可并行调用）
     */
    public ChunkResponse uploadChunk(String fileId, String uploadId,
                                      int chunkIndex, byte[] data) {
        // 1. 上传到对象存储
        String eTag = ossClient.uploadPart(fileId, uploadId,
            chunkIndex, data);

        // 2. 记录已传分片（断点续传用）
        chunkRepo.save(new UploadChunk(fileId, uploadId, chunkIndex,
            eTag, data.length));

        return new ChunkResponse(chunkIndex, eTag);
    }

    /**
     * 断点续传：查询已传分片，客户端只传缺失的
     */
    public List<Integer> getMissingChunks(String fileId) {
        UploadTask task = taskRepo.findByFileId(fileId);
        Set<Integer> uploaded = chunkRepo.findChunkIndexes(fileId);

        List<Integer> missing = new ArrayList<>();
        for (int i = 0; i < task.getChunkCount(); i++) {
            if (!uploaded.contains(i)) {
                missing.add(i);
            }
        }
        return missing;
    }

    /**
     * 合并分片（全部分片上传完后调用）
     */
    public void completeUpload(String fileId, String uploadId) {
        // 1. 查所有分片
        List<UploadChunk> chunks = chunkRepo.findByFileId(fileId);
        chunks.sort(Comparator.comparingInt(UploadChunk::getChunkIndex));

        // 2. 对象存储合并（compose，原子操作）
        List<PartETag> parts = chunks.stream()
            .map(c -> new PartETag(c.getChunkIndex(), c.getETag()))
            .collect(toList());
        ossClient.completeMultipartUpload(fileId, uploadId, parts);

        // 3. 更新文件状态为"扫描中"
        fileRepo.updateStatus(fileId, FileStatus.SCANNING);

        // 4. 触发异步病毒扫描
        mqSend("file-scan-topic", new ScanTask(fileId));

        // 5. 清理分片记录
        chunkRepo.deleteByFileId(fileId);
    }
}
```

## 四、机制层：断点续传

```java
/**
 * 客户端续传逻辑（前端实现，后端提供查询接口）
 */
// 伪代码：
// 1. 上传前调 getMissingChunks(fileId) 查缺失分片
// 2. 只上传缺失的分片
// 3. 全部传完调 completeUpload

// 前端示例：
// async function resumeUpload(file, fileId) {
//     const missing = await api.getMissingChunks(fileId);
//     for (const chunkIndex of missing) {
//         const start = chunkIndex * CHUNK_SIZE;
//         const chunk = file.slice(start, start + CHUNK_SIZE);
//         await api.uploadChunk(fileId, chunkIndex, chunk);
//     }
//     await api.completeUpload(fileId);
// }
```

## 五、机制层：病毒扫描（ClamAV）

```java
/**
 * 异步病毒扫描：ClamAV
 */
@Service
@Slf4j
public class VirusScanService {

    private final ClamAVClient clamAV;
    private final FileRepo fileRepo;

    /**
     * 监听扫描任务
     */
    @KafkaListener(topics = "file-scan-topic")
    public void scan(ScanTask task) {
        String fileId = task.getFileId();
        try {
            // 1. 下载文件（从对象存储）
            InputStream input = ossClient.download(fileId);

            // 2. 调 ClamAV 扫描
            ScanResult result = clamAV.scan(input);

            if (result.isInfected()) {
                // 感染：隔离文件（移动到 quarantine 目录）
                log.error("检测到病毒: fileId={} virus={}",
                    fileId, result.getVirusName());
                fileRepo.updateStatus(fileId, FileStatus.INFECTED);
                quarantineFile(fileId);
                notifySecurity(fileId, result.getVirusName());
            } else {
                // 干净：标记 READY 可访问
                fileRepo.updateStatus(fileId, FileStatus.READY);
            }
        } catch (Exception e) {
            log.error("扫描失败: fileId={}", fileId, e);
            // 扫描失败：标记 SCAN_FAILED，人工介入
            fileRepo.updateStatus(fileId, FileStatus.SCAN_FAILED);
        }
    }

    /**
     * 隔离感染文件
     */
    private void quarantineFile(String fileId) {
        // 移动到隔离目录（用户不可访问）
        ossClient.move(fileId, "quarantine/" + fileId);
        // 记录隔离日志
        quarantineRepo.save(new QuarantineRecord(fileId,
            System.currentTimeMillis()));
    }
}
```

## 六、机制层：文件访问控制（扫描中不可访问）

```java
/**
 * 文件访问：检查状态
 */
@Service
public class FileAccessService {

    public String getAccessUrl(String fileId) {
        FileMeta file = fileRepo.findByFileId(fileId);

        switch (file.getStatus()) {
            case UPLOADING:
                throw new BizException("文件上传中");
            case SCANNING:
                throw new BizException("文件安全扫描中，请稍后");
            case INFECTED:
                throw new BizException("文件已被隔离");
            case SCAN_FAILED:
                throw new BizException("文件扫描失败，联系管理员");
            case READY:
                // 生成临时访问 URL（签名，有效期 1 小时）
                return ossClient.generatePresignedUrl(fileId,
                    Duration.ofHours(1));
            default:
                throw new BizException("文件状态异常");
        }
    }
}
```

## 七、底层本质：秒传与分片的本质

**秒传的本质**：文件内容 → MD5 哈希（固定 32 位）。相同内容 MD5 相同，所以 MD5 可作为文件指纹。上传前查库——如果 MD5 已存在，说明这个文件（或内容相同的文件）已传过，直接复用 fileId，省去上传带宽。MD5 碰撞概率 2^128，商业场景可忽略。高安全场景用 SHA-256（2^256，抗碰撞更强）或 MD5 + 文件大小双校验（不同文件同 MD5 但大小不同的概率更低）。

**分片上传的本质**：大文件切小片并行传。好处：1) 并行加速（N 片并发传比串行快 N 倍）；2) 断点续传（某片失败只重传该片，不重传全部）；3) 内存友好（流式处理，不一次性加载 GB 文件）。分片大小是 trade-off：太小（1MB）请求数多开销大，太大（100MB）单片失败重传成本高。5MB 是经验值（平衡请求数和重传成本）。

**断点续传的本质**：上传过程可能中断（网络/客户端崩溃）。恢复时查已传分片（upload_chunk 表），只传缺失的。这要求每片上传成功后立即记录（持久化），不能等全部传完再记录（崩溃丢失记录）。

**病毒扫描异步的本质**：扫描慢（ClamAV 扫 100MB 要几秒），同步会让上传接口超时（用户等待）。异步上传完立即返回"扫描中"，后台扫描完通知用户。文件在扫描中不可访问（状态 SCANNING），防止用户访问到感染文件。这是**状态机控制可见性**——只有 READY 状态的文件才能生成访问 URL。

## 八、AI 工程化深挖

1. **怎么用 AI 做内容审核？** 病毒扫描（ClamAV）只查已知病毒签名。AI 内容审核（图片/视频）查违规内容（色情/暴力/政治敏感）。CNN 模型 + LLM 多模态。比规则（像素分析）更准。

2. **怎么用 AI 智能分片？** 传统固定 5MB。AI 根据网络质量（带宽/延迟/丢包率）动态调整分片大小——好网络用大片（减少请求数），差网络用小片（重传成本低）。

3. **怎么用 AI 预测文件是否重复？** 秒传依赖完整 MD5（客户端要读全文件算 MD5）。AI 根据文件名/大小/来源预测是否可能重复，可能重复的才让客户端算 MD5，不可能的跳过秒传检查（省客户端计算）。

4. **怎么用 LLM 做文件分类？** 上传后 LLM 根据文件名/内容/元数据自动分类（商品图/资质文件/用户头像），打标签用于搜索推荐。比规则更灵活。

5. **怎么用 AI 检测异常上传？** 异常模式：单账号高频上传/大量相同 MD5（刷量）/异常文件类型。训练检测模型，命中限流或人工审核。

## 九、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"秒传、分片、断点、扫描"** 四个词。

- **秒传**：客户端算 MD5 查库（md5+size 唯一索引），命中复用 fileId
- **分片**：5MB/片，并行上传，对象存储 multipart API
- **断点**：upload_chunk 表记录已传片，续传查缺失片
- **扫描**：异步 ClamAV，SCANNING 状态不可访问，感染隔离

### 面试现场 60 秒回答

> 文件上传我用秒传 + 分片 + 病毒扫描。秒传——客户端上传前先算文件 MD5，调 checkInstantUpload 查 file 表（md5+size 唯一索引），命中说明文件已存在（自己或别人传过），直接返回 fileId 不传文件，省带宽。MD5 碰撞概率 2^128 可忽略，高安全场景用 SHA-256 或 MD5+size 双校验。分片上传——大文件切 5MB 片（经验值，太小请求数多太大重传成本高），用对象存储 multipart API（initMultipartUpload → uploadPart → completeMultipartUpload），并行上传加速。断点续传——每片上传成功记 upload_chunk 表（fileId+chunkIndex+eTag），中断恢复时查已传片只传缺失的。合并——全片传完调 compose（对象存储原子操作），合并完更新状态为 SCANNING。病毒扫描——异步调 ClamAV（同步会让上传接口超时），扫描中文件状态 SCANNING 不可访问（getAccessUrl 检查状态），感染的状态 INFECTED 移到 quarantine 目录隔离。扫描通过状态 READY 生成签名 URL（有效期 1 小时）。监控 scan_duration、infection_rate、instant_upload_rate。

## 十、常见考点

1. **秒传怎么实现？**——客户端算 MD5 查 file 表（md5+size 唯一索引）。命中复用 fileId 不传文件。MD5 碰撞 2^128 可忽略，高安全用 SHA-256。
2. **分片上传为什么用 5MB？**——经验值。太小请求数多开销大，太大单片失败重传成本高。5MB 平衡。可根据网络质量动态调。
3. **断点续传怎么实现？**——upload_chunk 表记录已传片（fileId+chunkIndex+eTag）。恢复时查缺失片只传缺失的。每片上传成功立即记录（防崩溃丢失）。
4. **病毒扫描同步还是异步？**——异步。扫描慢（秒级），同步超时。上传完立即返回"扫描中"，后台扫描完通知。SCANNING 状态不可访问。
5. **怎么保证文件不被访问到病毒？**——状态机控制可见性。只有 READY 状态生成访问 URL。SCANNING/INFECTED 不可访问。getAccessUrl 检查状态。

## 结构化回答

**30 秒电梯演讲：** 文件上传的核心是MD5 秒传 + 分片上传断点续传 + 异步病毒扫描。秒传——上传前算 MD5 查库，命中则直接复用已有文件（不重复传）。分片上传——大文件切片并行传，支持断点续传。病毒扫描——上传后异步调 ClamAV 扫描，感染文件隔离

**展开框架：**
1. **秒传** — 上传前算 MD5，查 file 表命中则复用 fileId 不重复传
2. **分片上传** — 大文件切 5MB 片，并行上传，支持断点续传
3. **断点续传** — 记录已传分片，失败重传缺失的片

**收尾：** 以上是我的整体思路。您想继续深入聊——MD5 碰撞怎么办？


## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：文件秒传、分片上传与病毒扫描 | "这题一句话：文件上传的核心是MD5 秒传 + 分片上传断点续传 + 异步病毒扫描。" | 开场钩子 |
| 0:15 | 秒传示意/对比图 | "上传前算 MD5，查 file 表命中则复用 fileId 不重复传" | 秒传要点 |
| 0:40 | 分片上传示意/对比图 | "大文件切 5MB 片，并行上传，支持断点续传" | 分片上传要点 |
| 1:25 | 总结卡 | "记住：秒传。下期见。" | 收尾 |
