# 技术设计及边界

## 进程与状态

一个 Node.js/Fastify 进程负责所有 HTTP 接口、内存队列、幂等映射、TTL 清理；N 个 Python 子进程各自持有一个模型引擎。N = WORKER_CONCURRENCY。无 SQLite、Redis，无自动跨机器调度。

Node 通过 child_process.spawn 启动 Python；stdin 传 JSON Lines 命令，FD 3 返回版本化 JSON Lines 事件，stdout/stderr 收集库日志。图片本身保存在服务生成的 UUID 目录内，只向 Worker 传服务生成的绝对路径。调用者不能指定服务器输入/输出路径或 Python 命令。

Linux Worker 设置父进程退出信号，减少 Node 异常退出后的孤立模型进程。Node 正常退出先终止 Worker；超时升级 SIGKILL。服务进程重启会清空记录，不恢复任务。Python Worker 单独异常不清空 Node 队列。

## 数据流

1. 验证认证密钥，预留 intake 容量（计入关机状态）。
2. 流式保存上传文件，或执行受限 URL 下载。
3. 完整解码验证：格式、单帧、像素数；保留原文件字节和来源元数据。
4. 按真实格式重命名输入文件，保存参数及可选文字清单。
5. 计算输入/规范化参数/清单指纹；原子检查内存幂等键。
6. 创建任务，进入内存 FIFO 队列，响应 202。
7. 空闲 Worker 领取任务；配置变化则重启这个 Worker 并加载模型。
8. 写临时 PNG；TS 完整解码检查格式与显示尺寸，计算 SHA-256，原子重命名后标记成功。
9. 调用方下载、可靠保存并校验 hash，显式 ack。
10. 到期删除文件；较晚删除历史记录和关联幂等键。

下载 URL 的提交不是“零等待”：先获取并验证输入，才产生任务。提交超时后用同一个 Idempotency-Key 重试；若远端 URL 的图片内容发生变化，则返回冲突，而非复用旧任务。

## 调度与生命周期

- FIFO 分派；并发大于 1 时，不保证任务完成顺序。
- 一张卡可分配多个 Worker，但每个 Worker 都加载一套权重，显存不足将初始化失败或任务 CUDA_OOM。默认为 1。
- 排队容量、记录数量、上传字节、像素、URL 总下载时间、初始化时间、执行时间都有上限。
- QUEUE_TIMEOUT_SECONDS 防止 Worker 一直不就绪时无限排队；记录 QUEUE_TIMEOUT，不自动重算。
- 服务关闭或 drain 期间不接受新任务；drain 保留并执行已有队列，属于可逆的维护模式。
- safe_to_stop 仅反映本服务状态，不等于云平台已关机。
- 运行中取消、任务超时、协议损坏或 CUDA_OOM 会结束对应 Worker，因此需要重新加载模型。Python 已返回的业务失败不会结束 Worker。不会恢复推理中间状态。
- 队列和幂等映射只在当前会话有效，TTL/手动删除后对应幂等保护结束。跨重启的业务去重由无界后端决定。

## 参数约束

Zod 定义参数及默认值，并导出 JSON Schema 供无界生成表单。Python adapter 将字段显式映射到原项目调用；不向底层直接透传任意 JSON kwargs。TS 持有公开协议，Python 只处理经过服务验证的任务。

API 使用 snake_case 对齐原项目。服务限制范围可比底层更窄，capabilities 明确标记为服务资源限制。hf_token 仅来自部署环境。

force 默认 true；调用者已明确提交处理请求。vendor auto 从原文件识别，显式 vendor 覆盖。requested 与 effective 分别保存，默认强度不会被 TS 猜测或替换。

上游内部 pipeline=auto 由原项目路由；它可能触发不同模型的加载，不承诺 consumer GPU 上混用多种模型具有固定耗时或相同显存占用。当前部署只启用已经跑通的 sdxl-zimage。

## 文件及恢复

每个服务会话使用独立 run 目录，避免重启把旧任务当成新任务。旧目录在所有者停止/退出且超过 TTL 后清理；Linux 检查进程启动标识以减少 PID 复用误判。一个 DATA_DIR 只供一个服务实例使用，模型缓存可按平台能力共享。

Node 任务记录不持久化；无法根据旧文件重建任务和下载接口。最终结果需要及时取回并由无界保存。无界后续 EXIF 处理不在 GPU 服务内，调用方 ack 使用下载原始文件的 hash。

## 部署契约

- Node.js 24.22.1（`.nvmrc`），Python 3.12，NVIDIA CUDA PyTorch 环境。
- 默认复用用户已验证的 torch 2.13/cu132 venv 与模型缓存；服务不默认升级这些依赖。
- npm package-lock.json 固定 Node 依赖；Python 上游固定 0.47.1。实例导出 freeze 与私有镜像固定实际完整 GPU 环境。
- 正常启动离线加载，模型准备作为管理员显式步骤。开机不执行 npm install/pip install。
- 只有就绪后才调度任务；服务初始化阶段可以保存有界队列。
- 对外只开放 HTTP API 端口，Python 无公网端口。无界后端保管 API_KEY。
- 可迁移到兼容 GPU，但需要验证驱动、架构、显存、RAM、磁盘和网络入口。更快硬件不自动意味着相同数值像素或线性提速。

## 第一版不包含

无界 UI、云平台实例管理、云端对象存储 SDK、EXIF 模板、可见水印节点、AI 分类器或厂商水印验证器。它们可以在无界侧接入，不影响这里的计算接口。
