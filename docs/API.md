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

| processing 字段 | 默认值 | 含义 |
|---|---|---|
| pipeline | DEFAULT_PIPELINE | sdxl-zimage / qwen-zimage / chroma-zimage / auto，须被服务启用 |
| vendor | auto | auto / openai / google / microsoft / meta |
| strength | null | null 跟随上游策略；显式 0–1 |
| seed | 0 | 0–4294967295 的整数 |
| max_resolution | 0 | 0 原生；正整数限制内部长边；最终恢复输入显示尺寸 |
| controlnet_scale | 1 | 结构约束，服务允许 0–2；部分 pipeline 不使用 |
| adaptive_polish | default | default / on / off |
| humanize | 0 | 颗粒，服务允许 0–10 |
| unsharp | 0 | 锐化，服务允许 0–5 |
| tile | false | 是否分块 |
| tile_size | 1024 | 256–4096，8 的倍数 |
| tile_overlap | 128 | 0–2048，8 的倍数，小于 tile_size |
| cpu_offload | false | 按上游支持降低显存，通常更慢 |
| force | true | 已知需要处理时强制执行；false 且无本地信号可能 NO_SIGNAL |
| fidelity_anchor | false | 实验性，仅 qwen-zimage 且需要 text_manifest，默认关闭 |

`text_manifest` 是顶层 JSON 对象（JSON 提交），或 multipart 普通文本字段中的 JSON。不是服务器任意路径。需要 ENABLE_TEXT_RESTORATION=true，以及：

```bash
# 在目标 Python 环境按需安装；不在普通启动阶段执行。
/path/to/python -m pip install 'remove-ai-watermarks[text-restoration]==0.47.1'
```

文字标注由操作人核验，必须绑定原图像素 hash。格式沿用上游 schema；服务限制原生尺寸、不分块、humanize/unsharp=0、polish 不为 on。自动 OCR 结果不等于核验。清单细节见上游 CLI 文档。

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
| 任务 NO_SIGNAL | force=false 且本地无目标信号；不代表无水印 |

多张图片每张提交一个任务。无界可以并行提交，但实际计算并发只由服务 WORKER_CONCURRENCY 控制。
