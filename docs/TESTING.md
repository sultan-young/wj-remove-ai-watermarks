# 测试记录与验证边界

日期：2026-10-28。开发验证环境：Linux、Node.js 24.22.1、Python 3.12.14、Pillow 12.3.0。

## 已执行

| 检查 | 结果 |
|---|---|
| TypeScript 严格类型检查 | 通过 |
| TypeScript 编译及 dist 生成 | 通过 |
| HTTP/队列/Worker 集成测试 | 13 项通过 |
| Python adapter 单元测试 | 4 项通过 |
| 精确上游 0.47.1 wheel 的静态调用签名检查 | 通过 |
| Shell 部署脚本语法检查 | 通过 |

HTTP/集成测试实际启动 Python mock Worker、本地 HTTP 源站，JS 客户端使用真实 HTTP 请求；并非只检查函数返回值。覆盖：

- multipart 直接上传、URL 下载、URL 重定向。
- 鉴权、参数校验、图片完整解码、字节/像素限制。
- 内网/环回/link-local/IPv4-mapped IPv6 地址阻断、协议/端口检查、重定向再次检查。
- chunked 超大下载、下载超时、404 源站、失败临时目录清理。
- 并发 2 的实际并行运行、FIFO 分派、排队容量上限。
- 幂等请求复用、内容冲突。
- Worker 崩溃、初始化失败、任务超时、运行失败、错误尺寸输出。
- 排队取消、运行取消、取消一个 Worker 不影响另一个。
- 相同引擎配置复用 PID、不同配置重启 PID。
- drain 继续完成已接收队列，同时拒绝新任务。
- 下载、SHA-256 校验、显式 ack、safe_to_stop。
- EXIF 旋转尺寸、PNG 输出。
- TTL 到期、记录删除、服务重启后旧任务 ID 404。
- 不就绪时返回 503，排队等待超过时限明确失败。

Python adapter 测试通过模型模块替身验证：引擎只初始化一次、参数映射、vendor 自动读取及显式覆盖、force=false 无信号分支、版本不匹配拒绝启动。上游静态检查读取真实 0.47.1 wheel，不导入 Torch。

## 未执行，必须在目标 GPU 验证

本开发环境没有 nvidia-smi 和 Docker 可执行程序，未运行真实 CUDA 扩散，也未构建 Docker 镜像。mock 只复制图片，不改变水印。

因此没有声称以下内容已经验证：

- 真实 SDXL/Qwen/Chroma 推理效果和每张耗时。
- 目标 GPU 上并发 2 或更高的显存容量。
- 人脸路径、实验文字修复的真实模型处理。
- Docker recipe 的依赖完整兼容性、镜像构建及 CUDA 运行。
- 原生 2K 的性能或文字无损保留。
- SynthID 或其他厂商验证器返回阴性。

用户此前 CLI 约 20.14 秒的成功记录属于已有部署，不是本服务的实测成绩。

## 目标实例验收步骤

1. 复用现有 Python 环境和缓存，完成 Node 服务安装，等待 `/health/ready` 为 true。
2. 使用当前 input.png 跑 `npm run smoke`，检查图像可读取、尺寸及实际效果。
3. 再测原生 2K、有文字、有人脸的真实图片。人脸模型需提前准备。
4. 连续处理至少 5 张，确认后续任务复用 Worker，显存没有异常增长。
5. 先保持 WORKER_CONCURRENCY=1；需要提升并发时单独测峰值显存和吞吐。
6. 下载、hash 检查、ack、drain，确认 safe_to_stop 行为。
7. 制作私有镜像后，在新实例验证自动启动、离线缓存、端口和一次完整任务。
8. 若需要判断水印状态，用对应厂商验证器检查最终文件；不要把任务 succeeded 当作检测结论。

## 复跑

```bash
npm ci
npm run check
npm run build
npm test
npm audit --audit-level=low
for script in scripts/*.sh; do bash -n "$script" || exit 1; done
```

可选上游源接口检查：

```bash
python3 -m pip download --no-deps --only-binary=:all: remove-ai-watermarks==0.47.1 -d /tmp/raiw-wheel
python3 scripts/check-upstream-contract.py --wheel /tmp/raiw-wheel/remove_ai_watermarks-0.47.1-py3-none-any.whl
```

mock 测试需要可执行的 python3 与 Pillow，真实服务使用 `.env` 中的 PYTHON_BIN。安装/模型下载耗时不属于单张处理耗时。
