---
id: pdd-content-019
difficulty: L2
category: pdd-content
subcategory: 中台
tags:
- 拼多多
- 内容
- Java IO
- Netty
- 网络
- 直播
feynman:
  essence: Java IO 演进 BIO→NIO→AIO，对应"一连接一线程→多路复用→异步回调"；直播/弹幕长连接用 Netty（NIO+Reactor）扛百万并发。
  analogy: BIO 像每桌一服务员（贵）；NIO 像一个服务员轮询多桌（多路复用）；AIO 像扫码点餐（完成回调）。
  first_principle: 连接数大时一对一分配线程不现实，需复用线程。
  key_points:
  - BIO：一连接一线程（连接少可用）
  - NIO：Channel+Selector 多路复用（连接多用）
  - AIO：异步回调（Windows 实现好/Linux epoll 模拟）
  - Netty：NIO 封装+Reactor 模式
first_principle:
  problem: 连接数大（百万）时如何用少量线程处理？
  axioms:
  - 线程是稀缺资源
  - 大多数连接空闲
  - 内核事件通知高效
  rebuild: IO 多路复用（NIO/Netty）。
follow_up:
  - Netty 怎么扛百万连接？——Boss/Worker Reactor + Epoll
  - 零拷贝是什么？——sendfile/mmap 避免内核态到用户态拷贝
  - Netty 怎么处理半包/粘包？——LengthFieldBasedFrameDecoder 等解码器
memory_points:
  - BIO：一连接一线程
  - NIO：Selector 多路复用
  - AIO：异步回调
  - Netty：Reactor+Epoll
---

# 【拼多多内容】Java IO 模型与 Netty 直播网关？

> JD 依据："IO/多线程/网络"、"直播"。

## 一、三种 IO 模型

**1. BIO（Blocking IO）**：
```
ServerSocket.accept()   阻塞等连接
Socket.getInputStream() 阻塞等数据
```
- 一连接一线程
- 连接少（<几百）可用
- Tomcat BIO（已淘汰）

**2. NIO（Non-blocking / Multiplexing）**：
```
Selector selector = Selector.open();              // 多路复用器
channel.configureBlocking(false);
channel.register(selector, SelectionKey.OP_READ); // 注册感兴趣的事件
while (selector.select() > 0) {                   // 阻塞直到有事件
    for (SelectionKey key : selector.selectedKeys()) {
        if (key.isReadable()) { /* 读 */ }
        if (key.isWritable()) { /* 写 */ }
    }
}
```
- 单线程管理多连接（多路复用）
- 内核 epoll/kqueue 通知就绪事件

**3. AIO（Asynchronous IO）**：
```
AsynchronousSocketChannel channel = ...
channel.read(buffer, null, new CompletionHandler<>() {
    public void completed(Integer n, Object att) { /* 完成 */ }
    public void failed(Throwable e, Object att) { /* 失败 */ }
});
```
- 真正异步（完成回调）
- Linux 用 epoll 模拟（性能未超 NIO）
- Windows IOCP 原生支持

## 二、演进本质

```
BIO：1 线程 → 1 连接（连接多则线程爆炸）
NIO：1 线程 → N 连接（多路复用，事件驱动）
AIO：1 线程 → N 连接（完成时回调，无需 select）
```

## 三、Netty（直播网关首选）

**主从 Reactor 模式**：
```
BossGroup（1 线程）   接受连接
    ↓
WorkerGroup（N 线程） 处理 IO（默认 CPU 核*2）
    ↓
Handler（业务）        通过 EventLoop 异步执行
```

```java
EventLoopGroup boss = new NioEventLoopGroup(1);
EventLoopGroup worker = new NioEventLoopGroup();

ServerBootstrap b = new ServerBootstrap();
b.group(boss, worker)
 .channel(NioServerSocketChannel.class)
 .childHandler(new ChannelInitializer<SocketChannel>() {
     protected void initChannel(SocketChannel ch) {
         ch.pipeline()
           .addLast(new LengthFieldBasedFrameDecoder(...))  // 解码（半包/粘包）
           .addLast(new StringDecoder())
           .addLast(new DanmakuHandler());                   // 业务
     }
 }).bind(8080).sync();
```

## 四、Netty 关键技术

**1. 零拷贝**：
- `FileRegion` 包装 `FileChannel.transferTo`（sendfile）
- `CompositeByteBuf` 合并多个 Buffer 不拷贝
- `Unpooled.wrappedBuffer` 共享数组

**2. 内存池**：
- PooledByteBufAllocator（jemalloc 思路）
- 减少 GC，避免 Direct 内存分配开销

**3. 半包/粘包**：
```
TCP 是流，无消息边界 → 半包（一条消息分多次）/粘包（多条粘一起）
解码器：
  - LineBasedFrameDecoder（按 \n）
  - LengthFieldBasedFrameDecoder（按长度字段）
  - DelimiterBasedFrameDecoder（按分隔符）
```

**4. IdleStateHandler**（心跳）：
```java
ch.pipeline().addLast(new IdleStateHandler(30, 0, 0, SECONDS));
// 30s 没读触发事件 → 发心跳/关闭
```

## 五、直播弹幕网关（实战）

```
百万 WebSocket 连接 → Netty 网关
  ├─ 单机支撑 50w+ 连接（Linux 调内核参数）
  ├─ Boss 1 线程接连接
  ├─ Worker 32 线程处理 IO
  └─ 业务线程池（不阻塞 IO 线程）

弹幕流：
  观众 WebSocket → Netty 网关 → Kafka → 业务处理 → 网关下发
```

**关键参数调优**（百万连接）：
```bash
# Linux 文件句柄
ulimit -n 1100000
# TCP 缓冲区
sysctl -w net.ipv4.tcp_max_syn_backlog=65535
# Netty 参数
.option(ChannelOption.SO_BACKLOG, 8192)
.option(ChannelOption.TCP_NODELAY, true)
```

## 六、为什么用 Netty 不用 NIO

```
原生 NIO 问题：
  - API 复杂（Selector 空轮询 bug）
  - 自己处理半包粘包/重连
  - 线程模型需自设计
  
Netty 优势：
  - 简洁 API（Channel/Pipeline/Handler）
  - 解决 NIO 已知 bug
  - Reactor 模式开箱即用
  - 丰富的解码器/编解码
```

## 七、底层本质

IO 模型本质是**"用多路复用让少量线程处理大量连接"**——BIO 一对一、NIO 多路复用、AIO 异步回调；Netty 把 NIO 工程化，是直播网关的首选。

## 常见考点
1. **select/poll/epoll 区别**？——select 1024 限制/遍历；poll 无限制/遍历；epoll 事件驱动 O(1)。
2. **Netty 怎么避免内存泄漏**？——ByteBuf 引用计数+池化+泄漏检测（PARANOID 级别）。
3. **WebSocket 和 HTTP 长轮询区别**？——WebSocket 全双工一次握手；长轮询是 HTTP 反复请求。
