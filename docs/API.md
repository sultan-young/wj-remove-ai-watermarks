# HTTP API v1

除 `/health/live` 外，所有接口都需要 `Authorization: Bearer <API_KEY>`。接口地址是部署后配置的 GPU 服务地址，不是 api.compshare.cn。

## 提交文件

```bash
curl -X POST "$GPU_BASE_URL/v1/jobs" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Idempotency-Key: order-image-unique-id" \
  -F 'file=@/absolute/path/input.png' \
  -F 'options={"processing":{"pipeline":"sdxl-zimage","vendor":"auto","strength":null,"seed":0,"max_resolution":0}}'
```

## 提交 URL

```bash
curl -X POST "$GPU_BASE_URL/v1/jobs" \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: another-unique-id' \
  --data '{"url":"https://storage.example/input.png","options":{"processing":{"max_resolution":0}}}'
```

URL 必须直接返回图片字节，不是分享页面。支持签名查询参数；不转发调用者 Authorization、Cookie 或自定义源站头。默认只允许 HTTP 80、HTTPS 443 端口，只允许公网地址；逐跳检查重定向、校验所有 DNS 结果，并将已检查的目标地址固定到连接，避免 DNS 重绑定。下载有总时限、跳转次数、流式字节上限；文件下载后完整解码验证。URL 不写入公开任务记录。

可信内网存储可显式设置 `URL_ALLOW_PRIVATE=true` 和所需 `URL_ALLOWED_PORTS`；此时调用者能访问服务网络内的这些地址，仅向可信后端提供密钥。

提交返回 202；幂等复用返回 200。请求返回前需完成上传/下载和输入校验，计算异步进行。网络重试必须重复使用原 Idempotency-Key、同一图片字节及参数。同一 key 配不同内容返回 409；保护仅在当前服务会话和记录存续期间有效。手动删除任务会移除对应幂等记录。

## 参数

`options` 是严格对象，未知字段会报错，不会静默忽略。

| processing 字段 | 默认值 | 与上游的对应 |
|---|---|---|
| pipeline | qwen-zimage | `--pipeline`。qwen-zimage / sdxl-zimage / chroma-zimage / auto。没启用的 profile 会拒绝，不会改成别的 |
| vendor | auto | `--vendor`。auto 交给上游从原文件解析；显式值同时表示执行隐形重建 |
| strength | null | `--strength`。null 由上游按 profile 和 vendor 决定 |
| seed | null | `--seed`。null 由上游使用认证种子 0 |
| max_resolution | 0 | `--max-resolution`。0 表示原生尺寸 |
| controlnet_conditioning_scale | 1 | 引擎参数，对应 `--controlnet-scale` |
| adaptive_polish | null | `--adaptive-polish` / `--no-adaptive-polish`。null 表示不覆盖，由 profile 自己决定 |
| humanize | 0 | `--humanize` |
| unsharp | 0 | `--unsharp` |
| tile | false | `--tile` |
| tile_size | 1024 | `--tile-size` |
| tile_overlap | 128 | `--tile-overlap` |
| cpu_offload | false | `--cpu-offload` |
| force | false | `--force`。false 且没有本地隐式信号时，invisible 返回 NO_SIGNAL（显式 vendor 只决定强度 cohort，不再跳过检测）。all 仍返回可见处理结果，`invisible` 为 `no-signal` |
| mark | auto | `visible --mark`。auto 或注册表中的标记。all 只用 auto |
| sensitivity | auto | `--sensitivity`。auto / strict |
| detect | true | `--detect` / `--no-detect`。false 且 mark 为 auto 时与上游一样回落到 gemini |
| backend | auto | `visible --backend`。auto / cv2 / migan / lama |
| fidelity_anchor | false | `--fidelity-anchor` |

`text_manifest` 是顶层 JSON 对象（JSON 提交），或 multipart 普通文本字段中的 JSON。服务按原样写入临时文件再交给上游，不改字段、不重算哈希。需要：

```bash
# 在目标 Python 环境按需安装；不在普通启动阶段执行。
/path/to/python -m pip install 'remove-ai-watermarks[text-restoration]==0.47.1'
```

清单是否合法由上游判断，包括 verified、像素哈希、angle 和与 humanize、unsharp、tile、adaptive_polish 的组合。自动 OCR 结果不等于核验。细节见上游 CLI 文档。

所有图片都是像素重建，原生尺寸不代表无损。服务未实现独立的 --steps、--guidance-scale、--model，因为上游也不支持。HF token 是管理员配置，不是请求参数。

## 查询结果

`GET /v1/jobs/{id}` 返回：

```json
{
  "id": "实际 UUID",
  "status": "succeeded",
  "stage": "completed",
  "progress": null,
  "source": "url",
  "options": {"processing": {}},
  "effective": {"pipeline":"sdxl-zimage","vendor":"openai","strength":0.15,"verification":"not_performed"},
  "input": {"width":2048,"height":2048,"format":"png"},
  "elapsed_seconds": 20.0,
  "error": null,
  "result": {
    "width":2048,"height":2048,"format":"png","bytes":123456,
    "sha256":"实际文件的 SHA-256",
    "expired":false,"downloaded_at":null,"acknowledged_at":null,
    "download_path":"/v1/jobs/实际UUID/result"
  },
  "worker_mode":"real"
}
```

此处参数/耗时只是格式示例，不是性能承诺。elapsed_seconds 从调度执行开始计时，包含任务触发的模型切换及输出校验，不包含排队、初始上传和 URL 下载。首次启动的预加载时间由 readiness 单独反映。

状态：queued / running / succeeded / failed / cancelled。运行阶段来自 Worker 的真实回调；不把阶段拼成虚假的百分比。

`GET /v1/jobs/{id}/result` 返回 PNG 二进制，带 `X-Worker-Mode: real|mock`。未完成返回 409，过期 410，会话丢失或记录删除后 404。已完成结果可重复下载。

## 保存确认与安全关机

```http
POST /v1/jobs/{id}/ack
Content-Type: application/json

{"sha256":"你下载并保存的原始结果文件的SHA256"}
```

只有 hash 与结果相同才成功。调用方应先完成本地/对象存储保存，再 ack；后续 EXIF 处理会改变文件 hash，因此用下载原始结果的 hash ack。ack 可重复调用，不重新计算。

```http
POST /v1/drain
Content-Type: application/json

{"enabled":true}
```

关闭新任务入口，但继续执行已接受的排队任务、正在上传/下载进入系统的请求。`enabled:false` 恢复接单。

`GET /v1/status` 的 `safe_to_stop` 在 drain 已开启、没有 intake/排队/运行/下载、没有仍在保留期内且未确认的成功结果时为 true。关机由无界后端调用云平台管理 API；本服务不保存云平台公私钥、不提供开机接口。

## 其他接口

| 接口 | 说明 |
|---|---|
| GET /health/live | 无认证存活检查 |
| GET /health/ready | 200 至少一个 Worker 就绪且未 drain；否则 503 |
| GET /v1/capabilities | 版本、输入限制、JSON Schema、GPU/Worker 信息；不是动态模型下载接口 |
| GET /v1/jobs | 本会话任务列表，数量由 MAX_TASK_RECORDS 限制 |
| POST /v1/jobs/{id}/cancel | 排队立即取消；运行中结束对应 Worker，查询终态确认 |
| DELETE /v1/jobs/{id} | 删除已终结且没有正在下载的任务、文件、幂等记录；成功 204 |

## 常见错误

统一结构：`{"error":{"code":"...","message":"..."}}`。任务执行失败则在任务记录的 error 中返回 code 和简要信息，细节查服务器日志。

| HTTP / 任务错误 | 含义 |
|---|---|
| 400 INVALID_OPTIONS / INVALID_JSON | 参数错误，不创建任务 |
| 400 URL_ADDRESS_BLOCKED | URL 指向非公网地址 |
| 401 UNAUTHORIZED | 密钥缺失或错误 |
| 409 IDEMPOTENCY_CONFLICT | 幂等键与内容冲突 |
| 413 IMAGE_TOO_LARGE | 图片或字段超出限制 |
| 422 INVALID_IMAGE | 图片损坏、动画、不支持的格式或超像素限制 |
| 429 QUEUE_FULL / TASK_RECORD_LIMIT | 排队/记录已达上限 |
| 502 URL_FETCH_FAILED / URL_HTTP_ERROR | 源站不可达、超时或非 200 |
| 503 DRAINING | 暂停接单 |
| 任务 CUDA_OOM | 显存不足，降低并发或图片大小，必要时启用 offload/tile 后重新验证效果 |
| 任务 WORKER_EXITED / TASK_TIMEOUT | Worker 中断或任务超时 |
| 任务 NO_SIGNAL | invisible 模式下 force=false、vendor=auto 且本地无目标信号；不代表无水印。all 模式成功，effective.invisible 为 no-signal |
| 任务 NO_VISIBLE_MARK | mode=visible 没有去掉已知可见标记。不把原图当作处理结果。all 模式没有可见标记时继续后面的阶段 |

多张图片每张提交一个任务。无界可以并行提交，但实际计算并发只由服务 WORKER_CONCURRENCY 控制。
