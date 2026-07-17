---
id: java-architect-079
difficulty: L2
category: java-architect
subcategory: 异步
tags:
- Java 架构师
- 媒体处理
- 异步
- 任务
feynman:
  essence: 图片视频处理是 CPU/GPU 密集型任务（转码、压缩、加水印），不能在 Web 请求线程同步做（阻塞线程、超时、OOM）。架构是"上传触发 + 消息队列 + 工作节点异步处理"。上传后立即返回 URL，处理任务入队，工作节点消费做转码，完成后回调通知。
  analogy: 像餐厅点菜。顾客（用户）点完菜（上传）拿个取餐号（任务 ID）先回座位（不阻塞等待）。后厨（工作节点）按订单做菜（转码），做好了叫号（回调通知）或放取餐柜（CDN）。顾客不用在柜台等 30 分钟。
  first_principle: 媒体处理的特点是"耗时长（几秒到几分钟）+ 资源重（CPU/GPU 密集）"。如果同步处理，HTTP 请求线程被占住（线程池耗尽）、用户等待超时、服务 OOM。异步化的核心是"把耗时任务从请求链路剥离，交给专用工作节点"，Web 线程只做"接收 + 入队 + 返回"。
  key_points:
  - 上传触发：文件上传后发消息到队列，立即返回 URL（原图可用）
  - 异步处理：工作节点消费消息，做转码/压缩/水印/缩略图
  - 任务状态：记录任务状态（pending/processing/done/failed），客户端轮询或回调
  - 工作节点隔离：CPU 密集任务独立节点（不影响 Web 服务），按队列长度自动扩缩
  - CDN 分发：处理后输出多规格（原图/缩略图/水印/不同分辨率），CDN 缓存
first_principle:
  problem: 用户上传 2G 视频后要转码成 720p/1080p/4K 三个版本，转码耗时 10 分钟。如何在 Web 服务不阻塞的前提下完成？
  axioms:
  - 转码是 CPU/GPU 密集（FFmpeg 占满 CPU），不能在 Web 线程做
  - 用户不能等 10 分钟（HTTP 超时）
  - 转码可能失败（源文件损坏、格式不支持），需要重试和告警
  rebuild: 异步流水线——上传完成后发消息到 MQ（带 fileId、源文件 URL、目标规格），Web 立即返回 fileId。转码工作节点（独立部署、CPU 优化型节点）消费消息，用 FFmpeg 转码，输出多规格到 OSS。完成后发回调消息（或更新任务状态），通知客户端。客户端通过任务 ID 查询状态或接收 Webhook。工作节点按队列长度 HPA 自动扩缩。
follow_up:
  - 视频转码用什么工具？——FFmpeg（开源、命令行、支持所有格式）。Java 用 ProcessBuilder 调用，或用 JNI 封装（javacv）。云上用云转码服务（阿里云 MTS、AWS MediaConvert）省运维
  - 缩略图怎么快速生成？——上传后异步用 ImageMagick 或 Thumbnailator 生成多规格（100x100、500x500、原图），CDN 按需分发。也可以用 OSS 的图片处理（IMG）实时裁剪（不用预生成）
  - 任务失败怎么重试？——消息队列的 ACK 机制：处理失败 NACK 重投（延迟队列），重试 3 次仍失败进死信队列人工处理。工作节点崩溃，消息未 ACK 会重投给其他节点
  - 怎么知道任务进度？——工作节点定期更新任务进度（如转码进度 50%）到 Redis 或 DB，客户端轮询查。或用 SSE/WebSocket 推送进度
  - 大量并发转码怎么扩容？——工作节点按 MQ 队列长度 HPA 扩容（队列堆积就加节点）。转码任务按优先级分队列（VIP 优先、普通排队）。限流防突发压垮
memory_points:
  - 上传后异步：消息队列解耦，Web 不阻塞
  - FFmpeg 转码：独立工作节点，CPU/GPU 密集型
  - 任务状态：pending/processing/done/failed，轮询或回调
  - 失败重试：MQ ACK + 延迟重试 + 死信队列
  - HPA 扩缩：按队列长度扩容工作节点
  - 输出多规格：原图/缩略图/多分辨率，CDN 分发
---

# 【Java 后端架构师】图片、视频处理任务的异步架构

> 适用场景：JD 核心技术。商家上传商品视频要转码成多分辨率（720p/1080p/4K），商品图片要生成缩略图和加水印。转码耗时几分钟，架构师必须设计异步处理流水线，保证 Web 服务不阻塞、任务可靠执行、失败可重试。

## 一、概念层：异步处理流水线全景

**同步 vs 异步对比**：

| 维度 | 同步处理（错误做法） | 异步处理（正确做法） |
|------|---------------------|---------------------|
| 用户体验 | 等 10 分钟才返回（超时） | 立即返回 fileId，后台处理 |
| Web 线程 | 被转码占住（线程池耗尽） | 只做入队，毫秒级释放 |
| 资源 | Web 节点 CPU 被占满 | 转码节点独立扩缩 |
| 可靠性 | 转码失败请求失败 | 失败重试，不影响用户 |
| 扩展性 | 加 Web 节点（浪费） | 加转码节点（精准） |

**异步处理完整链路**（面试必画）：

```
┌──────┐    1.上传文件     ┌──────────┐  2.存OSS + 发消息  ┌───────┐
│ 用户  │────────────────> │ Web 服务  │─────────────────> │  MQ   │
└──────┘                  └────┬─────┘                   └───┬───┘
                               │                             │
                          3.立即返回 fileId                    │ 4.消费消息
                               │                             ▼
                               │                      ┌──────────────┐
                               │                      │ 转码工作节点  │
                               │                      │  (CPU 型 Pod) │
                               │                      └──────┬───────┘
                               │                             │
                               │                    5.FFmpeg 转码
                               │                    生成 720p/1080p/4K
                               │                             │
                               │                    6.输出到 OSS + CDN
                               │                             │
                               │                    7.更新任务状态 / 回调
                               │                             ▼
                               │<─────────────────────────────┤
                               │                      ┌──────────────┐
                               │                      │  任务状态 DB  │
                               │                      │ (Redis/MySQL)│
                               │                      └──────────────┘
                               │
                          8.用户查询进度/收通知
```

**任务状态机**（核心设计）：

```
PENDING → PROCESSING → DONE
              │
              ├─→ RETRYING → PROCESSING（重试中）
              │
              └─→ FAILED（重试耗尽，进死信）

状态流转：
  PENDING：消息已入队，等待处理
  PROCESSING：工作节点正在转码
  DONE：转码完成，输出可用
  RETRYING：处理失败，重试中（最多 3 次）
  FAILED：重试耗尽，进死信队列人工处理
```

## 二、机制层：消息驱动异步处理代码

**上传服务：发消息触发转码**：

```java
@Service
public class MediaUploadService {

    @Autowired private OSSClient ossClient;
    @Autowired private RocketMQTemplate mqTemplate;
    @Autowired private TaskStatusMapper taskStatusMapper;

    public UploadResult upload(MultipartFile file, String userId) {
        // 1. 存源文件到 OSS
        String fileId = UUID.randomUUID().toString();
        String sourceKey = "media/source/" + fileId + "/" + file.getOriginalFilename();
        ossClient.putObject(bucketName, sourceKey, new ByteArrayInputStream(file.getBytes()));

        // 2. 创建任务记录（PENDING）
        TaskStatus task = TaskStatus.builder()
            .taskId(fileId)
            .userId(userId)
            .sourceUrl(ossClient.getUrl(bucketName, sourceKey).toString())
            .status("PENDING")
            .targetProfiles(Arrays.asList("720p", "1080p", "4K"))
            .createTime(new Date())
            .build();
        taskStatusMapper.insert(task);

        // 3. 发消息到转码队列（立即返回，不等待转码）
        TranscodeMessage msg = TranscodeMessage.builder()
            .taskId(fileId)
            .sourceUrl(task.getSourceUrl())
            .targetProfiles(task.getTargetProfiles())
            .build();
        mqTemplate.asyncSend("transcode-topic", msg, new SendCallback() {
            @Override public void onSuccess(SendResult r) { log.info("任务入队: {}", fileId); }
            @Override public void onException(Throwable e) {
                // 发送失败，标记任务 FAILED，稍后补偿
                taskStatusMapper.updateStatus(fileId, "FAILED", "MQ 发送失败");
            }
        });

        // 4. 立即返回（用户不等转码）
        return UploadResult.builder()
            .fileId(fileId)
            .sourceUrl(task.getSourceUrl())  // 原图/原视频立即可用
            .status("PENDING")
            .build();
    }
}
```

**转码工作节点：FFmpeg 处理**：

```java
@Component
@RocketMQMessageListener(
    topic = "transcode-topic",
    consumerGroup = "transcode-worker",
    consumeMode = ConsumeMode.CONCURRENTLY
)
public class TranscodeWorker implements RocketMQListener<TranscodeMessage> {

    @Override
    public void onMessage(TranscodeMessage msg) {
        String taskId = msg.getTaskId();
        try {
            // 1. 更新状态为 PROCESSING
            taskStatusMapper.updateStatus(taskId, "PROCESSING", null);

            // 2. 下载源文件到本地临时目录
            File sourceFile = downloadFromOSS(msg.getSourceUrl(), "/tmp/" + taskId);

            // 3. 按目标规格转码（FFmpeg）
            Map<String, String> outputs = new HashMap<>();
            for (String profile : msg.getTargetProfiles()) {
                String outputKey = "media/output/" + taskId + "/" + profile + ".mp4";
                File outputFile = new File("/tmp/" + taskId + "_" + profile + ".mp4");

                // FFmpeg 转码（不同 profile 不同参数）
                ffmpegTranscode(sourceFile, outputFile, profile);

                // 上传转码结果到 OSS
                ossClient.putObject(bucketName, outputKey, outputFile);
                outputs.put(profile, ossClient.getUrl(bucketName, outputKey).toString());
            }

            // 4. 更新状态为 DONE
            taskStatusMapper.updateResult(taskId, "DONE", outputs);

            // 5. 发回调通知（可选）
            notifyCallback(taskId, "DONE", outputs);

        } catch (Exception e) {
            log.error("转码失败 taskId={}", taskId, e);
            handleFailure(msg, e);
        }
    }

    // FFmpeg 转码（ProcessBuilder 调用）
    private void ffmpegTranscode(File input, File output, String profile) throws IOException, InterruptedException {
        List<String> cmd = new ArrayList<>();
        cmd.add("ffmpeg");
        cmd.add("-i"); cmd.add(input.getAbsolutePath());

        // 按目标规格设置参数
        switch (profile) {
            case "720p":
                cmd.add("-vf"); cmd.add("scale=1280:720");
                cmd.add("-b:v"); cmd.add("2M");        // 码率 2Mbps
                break;
            case "1080p":
                cmd.add("-vf"); cmd.add("scale=1920:1080");
                cmd.add("-b:v"); cmd.add("5M");
                break;
            case "4K":
                cmd.add("-vf"); cmd.add("scale=3840:2160");
                cmd.add("-b:v"); cmd.add("15M");
                cmd.add("-preset"); cmd.add("slow");   // 4K 用慢速压缩
                break;
        }
        cmd.add("-c:a"); cmd.add("aac");              // 音频 AAC
        cmd.add("-movflags"); cmd.add("+faststart");   // 支持流式播放
        cmd.add(output.getAbsolutePath());

        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.redirectErrorStream(true);
        Process process = pb.start();

        // 读取 FFmpeg 输出（进度解析）
        try (BufferedReader reader = new BufferedReader(
            new InputStreamReader(process.getInputStream()))) {
            String line;
            while ((line = reader.readLine()) != null) {
                // 解析 frame= 时间= 估算进度
                updateProgress(taskId, parseProgress(line));
            }
        }

        int exitCode = process.waitFor();
        if (exitCode != 0) {
            throw new RuntimeException("FFmpeg 失败: " + exitCode);
        }
    }
}
```

**失败重试与死信处理**：

```java
private void handleFailure(TranscodeMessage msg, Exception e) {
    int retryCount = msg.getRetryCount() + 1;
    if (retryCount <= 3) {
        // 重试：发延迟消息（30 秒后重试）
        msg.setRetryCount(retryCount);
        mqTemplate.syncSend("transcode-topic", msg, 3000, 3);  // delayLevel=3
        taskStatusMapper.updateStatus(msg.getTaskId(), "RETRYING",
            "第 " + retryCount + " 次重试");
    } else {
        // 重试耗尽，进死信队列
        taskStatusMapper.updateStatus(msg.getTaskId(), "FAILED", e.getMessage());
        mqTemplate.sendOneWay("transcode-dlq-topic", msg);  // 死信
        alertService.sendAlert("转码失败 taskId=" + msg.getTaskId());
    }
}
```

## 三、机制层：进度查询与回调通知

**客户端进度查询**：

```java
@RestController
@RequestMapping("/api/media")
public class MediaQueryController {

    @GetMapping("/task/{taskId}")
    public TaskStatus queryTask(@PathVariable String taskId) {
        return taskStatusMapper.findById(taskId);
        // 返回 { status: "PROCESSING", progress: 65, outputs: null }
    }

    // SSE 推送进度（比轮询实时）
    @GetMapping(value = "/task/{taskId}/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter streamProgress(@PathVariable String taskId) {
        SseEmitter emitter = new SseEmitter(600000L);  // 10 分钟超时
        // 定期推送进度
        scheduledExecutor.scheduleAtFixedRate(() -> {
            TaskStatus task = taskStatusMapper.findById(taskId);
            try {
                emitter.send(SseEmitter.event().data(task));
                if ("DONE".equals(task.getStatus()) || "FAILED".equals(task.getStatus())) {
                    emitter.complete();
                }
            } catch (IOException ex) {
                emitter.completeWithError(ex);
            }
        }, 0, 2, TimeUnit.SECONDS);
        return emitter;
    }
}
```

**Webhook 回调通知**（转码完成通知业务系统）：

```java
@Service
public class CallbackService {

    public void notifyCallback(String taskId, String status, Map<String, String> outputs) {
        TaskStatus task = taskStatusMapper.findById(taskId);
        if (task.getCallbackUrl() == null) return;

        CallbackPayload payload = CallbackPayload.builder()
            .taskId(taskId)
            .status(status)
            .outputs(outputs)
            .timestamp(System.currentTimeMillis())
            .build();

        // HTTP 回调（带重试）
        webClient.post().uri(task.getCallbackUrl())
            .bodyValue(payload)
            .retrieve()
            .bodyToMono(String.class)
            .retryWhen(Retry.fixedDelay(3, Duration.ofSeconds(5)))  // 失败重试 3 次
            .doOnError(e -> log.error("回调失败 taskId={}", taskId, e))
            .subscribe();
    }
}
```

## 四、实战层：工作节点扩缩与资源治理

**工作节点 K8s 部署**（独立于 Web 服务）：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: transcode-worker
spec:
  replicas: 5    # 基础副本
  template:
    spec:
      containers:
        - name: worker
          image: registry.jd.com/transcode-worker:1.0.0
          resources:
            requests:
              cpu: "4000m"     # 4 核（转码 CPU 密集）
              memory: "8Gi"
            limits:
              cpu: "8000m"     # 8 核
              memory: "16Gi"
          env:
            - name: JAVA_OPTS
              value: >-
                -XX:+UseG1GC
                -XX:MaxRAMPercentage=70
                -XX:+UseContainerSupport
---
# HPA：按 MQ 队列长度自动扩缩
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: transcode-worker-hpa
spec:
  scaleTargetRef:
    kind: Deployment
    name: transcode-worker
  minReplicas: 5
  maxReplicas: 50          # 高峰扩到 50 个转码节点
  metrics:
    - type: External
      external:
        metric:
          name: rocketmq_queue_depth    # MQ 队列堆积量
          selector:
            matchLabels:
              topic: transcode-topic
        target:
          type: AverageValue
          averageValue: "10"    # 每副本处理 10 条消息，堆积就扩容
```

**图片处理（Thumbnailator）**：

```java
// 图片缩略图生成（比视频转码快，但仍异步）
@Component
@RocketMQMessageListener(topic = "image-process-topic", consumerGroup = "image-worker")
public class ImageProcessWorker implements RocketMQListener<ImageMessage> {

    @Override
    public void onMessage(ImageMessage msg) {
        try {
            BufferedImage source = readFromOSS(msg.getSourceUrl());

            // 生成多规格缩略图
            Map<String, String> thumbnails = new HashMap<>();
            for (String size : Arrays.asList("100x100", "300x300", "800x800")) {
                BufferedImage thumb = Thumbnailator.of(source)
                    .scale(Thumbnailator.scaleForSize(size))
                    .asBufferedImage();

                String key = "media/thumb/" + msg.getImageId() + "/" + size + ".jpg";
                ossClient.putObject(bucketName, key, imageToInputStream(thumb));
                thumbnails.put(size, ossClient.getUrl(bucketName, key).toString());
            }

            // 加水印（大图才加）
            if (msg.isWatermark()) {
                BufferedImage watermarked = addWatermark(source, msg.getWatermarkText());
                uploadToOSS(watermarked, "media/watermark/" + msg.getImageId() + ".jpg");
            }

            taskStatusMapper.updateResult(msg.getImageId(), "DONE", thumbnails);
        } catch (Exception e) {
            handleFailure(msg, e);
        }
    }
}
```

## 五、底层本质：为什么媒体处理必须异步

回到第一性：**媒体处理是"长耗时 + 重资源"任务，与 Web 请求的"短耗时 + 轻资源"模型根本冲突**。

- **线程模型冲突**：Web 服务用线程池处理请求（如 200 线程），每个请求几毫秒到几百毫秒。转码一个视频要几分钟到几十分钟，如果一个转码占一个线程 10 分钟，200 个并发转码就耗尽线程池，Web 服务对外不可用。异步化把转码从 Web 线程剥离，Web 只做"入队 + 返回"（毫秒级）。
- **资源模型冲突**：Web 服务是 IO 密集（等数据库、等下游），CPU 利用率低（10-30%）。转码是 CPU 密集（FFmpeg 占满 CPU）。把转码放 Web 节点，CPU 被占满影响所有请求的响应时间。独立转码节点（CPU 优化型）隔离资源，互不影响。
- **可靠性冲突**：转码可能失败（源文件损坏、格式不支持、OOM）。同步处理失败会导致 HTTP 请求失败（用户重试又转一次）。异步化用 MQ 的重试 + 死信机制保证可靠——失败自动重试 3 次，重试耗尽进死信人工处理，用户感知的是"处理中"而非"失败"。
- **扩缩模型冲突**：Web 流量按 QPS 扩缩（HPA 基于 CPU/QPS）。转码按任务量扩缩（HPA 基于 MQ 队列长度）。混在一起扩缩不准——Web QPS 低但转码任务堆积时，按 QPS 扩容不够。独立工作节点按队列长度扩缩，精准匹配。

**为什么用 MQ 而不是线程池**：线程池内的任务在进程内（进程崩溃任务丢失），MQ 做持久化（消息不丢），工作节点崩溃消息重投给其他节点。MQ 还天然支持削峰（突发上传高峰，消息排队不压垮工作节点）、优先级（VIP 用户优先）、重试和死信。

## 六、AI 架构师加问：5 个

1. **AI 能自动选视频转码参数吗？**
   能。AI 分析视频内容（运动场景用高码率、静态画面用低码率）、分辨率、时长，推荐最优转码参数（码率、帧率、preset）。比固定参数省 30-50% 存储和带宽。VMAF 评分保证质量。

2. **AI 辅助媒体内容审核怎么做？**
   上传后异步触发 AI 审核——图片识别违禁内容（色情、暴力、政治敏感）、视频关键帧分析、OCR 文字审核、音频转文字审核。不合格标记删除或人工复审。审核是异步流水线的一环，不阻塞上传返回。

3. **AI 生成缩略图（智能裁剪）怎么做？**
   AI 识别图片主体（人脸、商品、关键区域），智能裁剪保留主体。比固定居中裁剪质量高（人脸不会裁掉）。用 salience map 或人脸检测确定裁剪区域。电商场景特别有用（商品主体居中）。

4. **AI 推理服务的模型上传后怎么处理？**
   模型文件（.pt/.onnx）上传后验证完整性（SHA256）、转换格式（PyTorch→ONNX→TensorRT）、量化（FP32→INT8）。这些是异步处理任务，和视频转码架构一样（MQ + 工作节点）。完成后部署到推理服务。

5. **让 AI 管理转码任务的调度，风险在哪？**
   AI 能做任务优先级调整（VIP 任务插队）、资源预测（高峰前预热扩容）。但调度决策（哪个任务先跑）影响 SLA，AI 误判会让低优先级任务饿死。解法：AI 建议优先级，确定性规则兜底（超时任务强制提升优先级）。

## 七、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"上传入队、异步转码、状态轮询、失败重试、HPA 扩缩"**。

- **入队**：上传后发 MQ 消息，立即返回 fileId（不阻塞 Web）
- **转码**：独立工作节点用 FFmpeg，CPU 优化型 Pod
- **状态**：PENDING→PROCESSING→DONE/FAILED，客户端轮询或 SSE 推送
- **重试**：MQ ACK + 延迟重试 3 次 + 死信队列
- **扩缩**：HPA 按 MQ 队列长度扩缩工作节点

### 拟人化理解

把媒体处理想成**餐厅点菜**。顾客（用户）点完菜（上传）拿取餐号（fileId）先回座位（不等）。后厨（转码节点）按订单做菜（FFmpeg 转码），做好了叫号（回调）或放取餐柜（CDN）。高峰期排队（MQ 削峰），后厨忙不过来加人（HPA 扩容）。菜做坏了重做（重试），重做几次还坏报经理（死信告警）。

### 面试现场 60 秒回答

> 媒体处理必须异步——转码是 CPU 密集（FFmpeg 占满 CPU），同步处理会耗尽 Web 线程池、用户等超时。架构是上传触发 + MQ + 工作节点。用户上传后 Web 服务存 OSS、发 MQ 消息、立即返回 fileId（原图立即可用）。转码工作节点（独立 CPU 型 Pod）消费消息，用 FFmpeg 按目标规格（720p/1080p/4K）转码，输出多版本到 OSS + CDN。任务状态机 PENDING→PROCESSING→DONE，客户端轮询查询或 SSE 推送进度。失败用 MQ 的 ACK + 延迟重试（3 次），重试耗尽进死信队列人工处理。工作节点用 HPA 按 MQ 队列长度自动扩缩（堆积就加节点，高峰扩到 50 副本）。转码节点和 Web 服务隔离部署，互不影响资源。

### 反问面试官

> 贵司转码是自建 FFmpeg 还是用云服务（阿里 MTS/AWS MediaConvert）？峰值转码并发多大？有没有 GPU 加速？这决定我聊工作节点架构还是云服务集成。

## 八、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不用更大的 Web 线程池同步转码？ | 用资源说话：转码占满 CPU，Web 节点 CPU 被转码占满后所有请求变慢。加 Web 节点成本高（Web 节点通常内存型，转码要 CPU 型）。异步分离让 Web 和转码各自按需扩缩，成本最优 |
| 证据追问 | 怎么证明异步比同步好？ | 对比 Web 服务的 P99（异步不阻塞，同步转码时 P99 飙升）、线程池利用率（异步低，同步被占满）、转码吞吐（独立节点按队列扩缩，吞吐高 5-10 倍）。监控 transcode_queue_depth（队列堆积）、transcode_success_rate |
| 边界追问 | 异步处理能保证转码一定成功吗？ | 不能。源文件损坏、格式不支持、OOM 等会导致转码失败。异步保证的是"失败可重试、可追溯、不影响用户"。重试耗尽进死信，人工介入。关键场景（如付费视频）有 SLA，失败要告警 |
| 反例追问 | 什么场景适合同步处理？ | 小图片缩略图（几十毫秒，值得同步做省 MQ 开销）、实时滤镜（用户等结果）、OCR 文字识别（API 调用快）。判断标准：处理时间 < 1 秒且资源轻，可以同步 |
| 风险追问 | 异步处理最大风险？ | ① 工作节点全挂（MQ 堆积，用户等不到结果，要有容量预案）；② MQ 消息丢失（消息没持久化，用 RocketMQ 同步刷盘）；③ 任务状态不一致（DB 说 DONE 但 OSS 没文件，要分布式事务或对账）；④ 死信积压（失败任务无人处理） |
| 验证追问 | 怎么证明转码质量没问题？ | 抽检：随机下载转码后视频，用 VMAF 评分（> 7 为合格）。自动化：CI 里跑转码测试用例（各种格式输入，验证输出）。监控 transcode_quality_score、transcode_failure_rate（按失败原因聚类） |
| 沉淀追问 | 团队媒体处理规范沉淀什么？ | 转码规格标准（720p/1080p/4K 参数模板）、工作节点部署模板（CPU 型 + HPA）、任务状态机设计规范、死信处理 SOP、转码质量监控大盘、FFmpeg 命令行最佳实践 |

### 现场对话示例

**面试官**：转码工作节点怎么扩容？

**候选人**：按 MQ 队列长度 HPA 扩缩。监控 transcode-topic 的队列深度（rocketmq_queue_depth），当堆积超过阈值（如每副本 10 条）就扩容。基础 5 副本，高峰扩到 50。缩容要慢（stabilizationWindow 10 分钟），防止抖动——转码任务可能几分钟，缩容太快把正在转码的节点杀了导致任务重试。转码节点是 CPU 型（8 核 16G），和 Web 服务（内存型 4 核 8G）规格不同，独立节点池部署。FFmpeg 是 CPU 密集，8 核节点并行转 2-3 个任务（每任务占 2-3 核）。GPU 加速（NVENC）能快 5-10 倍但成本高，只给 VIP 或 4K 任务用。

**面试官**：转码到一半工作节点挂了，任务怎么办？

**候选人**：RocketMQ 的 ACK 机制保证——工作节点消费消息但没 ACK（还没转完），节点挂了消息会重投给其他节点。重投的消息从头开始转码（没有断点续转，因为 FFmpeg 中间状态难保存）。重试次数累加，超过 3 次进死信队列。为了减少重试浪费，工作节点收到消息后先更新状态为 PROCESSING，转码中定期写进度。如果同一个 taskId 被重复消费（如重投），工作节点检查状态——如果已经在 PROCESSING（说明上次还没超时），可以拒绝重复处理（幂等）。关键设计：转码输出用临时文件，完成后原子 rename，避免半成品被当成成品。

**面试官**：用户怎么知道转码进度？

**候选人**：两种方式。轮询——客户端每 2-3 秒查一次 /task/{taskId} 接口，返回状态和进度百分比。简单但有延迟和轮询开销。SSE 推送——客户端建立 SSE 长连接，服务端每 2 秒推送进度更新，实时性好。工作节点转码时解析 FFmpeg 输出（frame= time=），估算进度（已处理时长 / 总时长），更新到 Redis。查询接口或 SSE 从 Redis 读进度。进度不是精确的（FFmpeg 输出只有已处理帧数），但对用户足够（看到进度条在动）。转码完成后推送 DONE 事件，客户端拿到多分辨率 URL 播放。

## 常见考点

1. **为什么媒体处理要异步？**——转码 CPU 密集且耗时长（几分钟），同步处理阻塞 Web 线程池、用户等超时。异步用 MQ 解耦，Web 只入队，工作节点独立处理。
2. **FFmpeg 怎么用？**——Java 用 ProcessBuilder 调 FFmpeg 命令行，设置分辨率（-vf scale）、码率（-b:v）、preset。或用云转码服务（阿里 MTS/AWS MediaConvert）。GPU 加速用 NVENC。
3. **转码失败怎么重试？**——RocketMQ ACK 机制：消费失败 NACK 重投（延迟队列），重试 3 次进死信队列。工作节点崩溃，未 ACK 消息重投给其他节点。
4. **工作节点怎么扩缩？**——HPA 按 MQ 队列长度（rocketmq_queue_depth）扩缩。转码节点是 CPU 型（8 核+），独立于 Web 服务。缩容要慢（防抖动）。
5. **进度怎么通知用户？**——轮询（客户端定时查 /task/{taskId}）或 SSE 推送（长连接实时推送）。工作节点解析 FFmpeg 输出估算进度，写 Redis。

## 结构化回答

**30 秒电梯演讲：** 图片视频处理是 CPU/GPU 密集型任务（转码、压缩、加水印），不能在 Web 请求线程同步做（阻塞线程、超时、OOM）。架构是上传触发 + 消息队列 + 工作节点异步处理。上传后立即返回 URL，处理任务入队，工作节点消费做转码，完成后回调通知

**展开框架：**
1. **上传触发** — 文件上传后发消息到队列，立即返回 URL（原图可用）
2. **异步处理** — 工作节点消费消息，做转码/压缩/水印/缩略图
3. **任务状态** — 记录任务状态（pending/processing/done/failed），客户端轮询或回调

**收尾：** 以上是我的整体思路。您想继续深入聊——视频转码用什么工具？


## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：图片、视频处理任务的异步架构 | "这题核心是——图片视频处理是 CPU/GPU 密集型任务（转码、压缩、加水印），不能在 Web 请求线程同步做（阻……" | 开场钩子 |
| 0:15 | 上传触发示意/对比图 | "文件上传后发消息到队列，立即返回 URL（原图可用）" | 上传触发要点 |
| 0:40 | 异步处理示意/对比图 | "工作节点消费消息，做转码/压缩/水印/缩略图" | 异步处理要点 |
| 1:25 | 总结卡 | "记住：上传后异步。下期见。" | 收尾 |
