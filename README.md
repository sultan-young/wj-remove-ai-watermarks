# GPU 图片处理服务

TypeScript + Fastify API，常驻 Python Worker 调用 `remove-ai-watermarks==0.47.1`。支持**直接上传图片、HTTP(S) URL 输入、环境变量控制并发**。不依赖 ComfyUI、Mastra、Redis 或数据库。

> 本项目负责封装计算服务，不改变上游的像素重建算法。文字、图案和材质可能变化；执行成功不代表通过厂商隐形水印验证。`mock` 模式只测试通信和队列，不做去水印。

## 当前优云智算实例：最快部署

你已有可用环境 `/root/raiw-test/.venv` 和模型缓存 `/root/raiw-test/model-cache`。请保留它们。

1. 将整个项目解压到 `/root/gpu-image-service`。
2. 运行环境需要 nvm。`.nvmrc` 锁定 Node.js **24.22.1**。`npm run start` 会加载 nvm：已安装就切换，没有就先 `nvm install`，然后再启动。
3. 执行：

```bash
cd /root/gpu-image-service
bash scripts/install.sh
```

安装脚本使用 `npm ci`、编译 TS，并首次创建 `.env` 和随机 API 密钥；不会重装 Torch、删除缓存或重新下载模型。

4. 编辑 `.env`，确认：

```dotenv
PYTHON_BIN=/root/raiw-test/.venv/bin/python
HF_HOME=/root/raiw-test/model-cache
WORKER_MODE=real
MODEL_OFFLINE=true
ENABLED_PIPELINES=qwen-zimage,sdxl-zimage,chroma-zimage,auto
WORKER_CONCURRENCY=1
GPU_DEVICES=0
```

`.env` 内有安装脚本生成的 `API_KEY`，请将同一密钥配置到无界后端。不要放到浏览器代码。

5. 启动服务（PM2 守护，单实例 fork，崩溃自动重启）：

```bash
npm ci          # 若还没装过依赖 / 刚 pull 了含 pm2 的版本
npm run build
npm run start
```

`npm run start` 会按 `.nvmrc` 切换 Node，用 PM2 拉起 `gpu-image-service`，前台刷日志直到 `/health/ready` 成功才回到提示符。进程由 PM2 守护，掉线自动拉起。再次 `npm run start` 会先删掉旧实例再启动。

```bash
npm run logs    # 看 PM2 日志
npm run stop    # 停止并移除该应用
npm run dev     # 前台开发（不走 PM2）
```

`MODEL_OFFLINE=true` 时缺少模型会启动失败并触发 PM2 重启退避；不会自动在线下载。

6. 测试真实图片：

```bash
npm run smoke -- /root/raiw-test/input.png /root/gpu-image-service/output-service.png
```

也支持 URL：

```bash
npm run smoke -- 'https://your-storage.example/input.png' output-service.png
```

进程由 PM2 单实例 fork 管理（`ecosystem.config.cjs`），`autorestart` 开启；不用 cluster。一个 DATA_DIR 只供一个服务实例使用。

## 对外访问

服务默认监听 `0.0.0.0:8000`。在优云智算配置容器端口映射/防火墙后，使用控制台提供的外网地址及**外部端口**访问。你终端中的 `10-*` 是内网地址，不能默认拿来公网调用。

无界浏览器 → 你的无界后端 → GPU API。公网生产入口配置 HTTPS（平台 HTTPS 访问地址或反向代理），API_KEY 只保存在后端。

## 并发和显存

```dotenv
# 一张 4090 24GB，建议从这里开始
WORKER_CONCURRENCY=1
GPU_DEVICES=0
```

`WORKER_CONCURRENCY` 是**实际同时运行的图片数**。每个 Worker 是一个独立 Python 进程，各自加载模型，因此调高会增加显存、RAM 占用，不等于免费加速。

```dotenv
# 两张兼容 GPU，每卡一个 Worker
WORKER_CONCURRENCY=2
GPU_DEVICES=0,1
```

Worker 按 GPU_DEVICES 轮询分配；并发为 2、只写 `GPU_DEVICES=0` 就会让两个模型进程共用同一张卡。卡编号指**实例当前可见设备**，也支持 GPU UUID。改变这些环境变量需要重启服务，重启会丢失队列。

## 参数与任务

- POST `/v1/jobs` 使用 multipart 的 `file + options`，或 JSON 的 `url + options`，二选一。
- 立即进入异步计算队列；URL 提交会先完成受限下载和图片验证，再返回任务 ID，因此提交请求本身最长可能需要 URL_TIMEOUT_MS。
- 处理参数的名字、默认值和取值与上游 0.47.1 一致，服务不改写后再交给引擎。`force` 默认 false。没写 `pipeline` 时是 `qwen-zimage`。`strength`、`seed`、`adaptive_polish` 省略时分别是 null、null、null，由上游自己决定。
- `invisible` 在 `force=false`、无本地信号时以 `NO_SIGNAL` 失败，不生成扩散结果（显式 vendor 只决定强度，不跳过检测）。`all` 仍会先去掉可见水印；没有隐形信号时任务成功，`effective.invisible` 为 `no-signal`。
- `mode=visible` 使用上游的 `mark`、`sensitivity`、`detect`、`backend`。没有去掉标记时返回 `NO_VISIBLE_MARK`，不交付原图。`detect=false` 且 `mark=auto` 时与上游命令一样回落到 gemini。
- 支持 PNG/JPEG/WebP 单帧图片；保留上传字节，不在上传阶段重新编码。输出 PNG，恢复按 EXIF 正向显示的输入尺寸。
- pipeline、controlnet_conditioning_scale、cpu_offload 改变时，重启对应 Worker 再加载模型；同配置任务复用引擎。
- `auto` 使用上游来源路由；可能需要多个模型缓存，建议先逐个准备并验证具体 pipeline，再启用 auto。
- `text_manifest` 原样交给上游。需要上游的 text-restoration 额外依赖；服务不改清单、不另设开关。
- 返回 requested options 与 effective 参数，便于复现。`progress` 没有准确数据时为 null。

完整接口及示例：[docs/API.md](docs/API.md)。Node.js 客户端：[examples/client.mjs](examples/client.mjs)。

## 模型准备与离线启动

你的现有无脸测试已成功，不代表人脸模型也已缓存。生产需要哪些路径，就提前准备哪些路径。保持服务停止，在已配置 `.env` 后执行：

```bash
# 明确的在线准备操作，正常服务启动不执行这一步。
node --input-type=module -e 'import "dotenv/config"; import {spawnSync} from "node:child_process"; const r=spawnSync(process.env.PYTHON_BIN,["python/prepare_models.py","--pipeline","sdxl-zimage","--include-face"],{stdio:"inherit",env:process.env}); process.exit(r.status??1)'
```

不需要人脸路径时可以省略 `--include-face`。首次准备可能下载大量文件；确认磁盘容量，不要重复启动多个准备进程。`prepare_models.py` 会导出缓存 snapshot 版本清单。

全新环境才使用 `scripts/install-python.sh`，它要求当前基础 Python 已有可用 CUDA Torch。当前 raiw-test 用户无需执行。

## 自启动、打包与迁移

```bash
bash scripts/install-autostart.sh
bash scripts/export-environment.sh
```

- 自启动脚本安装到 `/start.d/90-gpu-image-service.sh`，不会立刻启动服务。
- 导出实际实例的 Python 全部依赖版本、Torch/CUDA/GPU 信息。交付包固定 Node 依赖及上游版本；完整 GPU 依赖以**你验证通过的实例导出清单和私有镜像**为准，不把未运行的环境假称为已锁定验证。
- 模型准备完成、任务停止、结果取回后制作优云智算私有镜像。
- 保存服务、编译产物、node_modules、Python 环境、模型缓存及自启动脚本。模型若在外部挂载盘，不会因为系统镜像而自动迁移，需要单独挂载/复制。
- 新实例配置独立的 API_KEY、网络入口，并测试 readiness 和一张真实图片。不要把在线生产密钥作为镜像分发凭证。
- 兼容的 NVIDIA/CUDA GPU 可复用环境；不承诺任意 GPU/驱动/架构无条件兼容。

镜像启动仍需模型加载时间，不代表瞬间就绪。切换 GPU 不会自动改变强度和画质策略。

## 内存状态、保留时间与关机

不使用 SQLite。整个服务重启后队列和任务记录清空；旧任务 ID 返回 404，不自动重算。

Python Worker 单独崩溃：当前任务失败，排队任务保留，Worker 恢复后继续。任务超时和运行中取消会结束该 Worker 并重新加载模型；其他 Worker 不受影响。取消以终态查询为准，不保证 GPU 立即释放。

结果默认保留 1 小时；过期文件清理、结果返回 410。记录默认最多保留 2 倍 TTL，达到 MAX_TASK_RECORDS 时需要删除已完成任务或等待清理。重启留下的旧目录在到期且无活动所有者时清理。

安全关机建议：停止接单 → 等待任务完成 → 下载并校验文件 → 你自己的后端确认保存 → 调用 ack → `/v1/status.safe_to_stop=true` → 无界后端调用平台 Stop API。drain 模式会继续处理已经接受的排队任务。下载响应完成不等于文件已被你的后端可靠保存，因此**只下载不会自动 ack**。

## 测试

```bash
npm ci
npm run check
npm test
npm run build
```

Python 单元测试与 mock Worker 需要 Pillow；开发机没有时可以建立 venv 安装 `python/requirements-mock.txt`，并使用该 Python 运行测试（测试默认调用 python3）。测试会启动本地 HTTP fixture。

mock 模式的 capabilities、任务结果和下载响应头会标明 mock。它仅复制图片，不用于效果验证。

测试范围与剩余验证项：[docs/TESTING.md](docs/TESTING.md)。

## 配置完整说明

见 `.env.example`。服务端图片/参数限制用于控制资源，不代表上游数学边界。模型下载密钥 HF_TOKEN 仅作为服务器环境变量配置，不接受普通调用者通过任务传入。

许可证：[LICENSE](LICENSE)。上游项目及依赖保留各自许可证，见 [THIRD_PARTY.md](THIRD_PARTY.md)。
