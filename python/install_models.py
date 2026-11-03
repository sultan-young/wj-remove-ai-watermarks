#!/usr/bin/env python3
"""安装 remove-ai-watermarks 0.47.1 的模型权重。

仓库命令：npm run install:model
前提：SDXL、SDXL-Lightning、SDXL VAE、SDXL Canny 和 YuNet 已准备好。
直接运行本文件只查询远端文件列表、统计空间；传 --download 才下载。
npm run install:model 会带上 --download。
不会加载 torch、占用 GPU、启动服务、清理缓存或修改服务配置。
下载后还需要实际推理测试，不代表对应管线已在本机验证可运行。
"""
from __future__ import annotations

import argparse
import fnmatch
import importlib.metadata
import json
import os
from pathlib import Path
import shutil
import time

GB = 1_000_000_000
GIB = 1024 ** 3
COMPONENTS = (
    "model_index.json", "scheduler/*", "tokenizer/*",
    "text_encoder/*.json", "text_encoder/*.safetensors",
    "transformer/*.json", "transformer/*.safetensors",
    "vae/*.json", "vae/*.safetensors",
)


def specs(scope: str) -> list[dict]:
    result = [
        {"repo": "Tongyi-MAI/Z-Image-Turbo", "layout": "diffsynth",
         "patterns": COMPONENTS},
        {"repo": "facebook/sam-vit-base", "layout": "hub",
         "patterns": ("config.json", "preprocessor_config.json", "model.safetensors")},
    ]
    if scope == "all":
        result.extend([
            {"repo": "Qwen/Qwen-Image-2512", "layout": "diffsynth",
             "patterns": COMPONENTS},
            {"repo": "DiffSynth-Studio/Qwen-Image-Blockwise-ControlNet-Canny",
             "layout": "diffsynth", "patterns": ("configuration.json", "model.safetensors")},
            {"repo": "lightx2v/Qwen-Image-2512-Lightning", "layout": "diffsynth",
             "patterns": ("Qwen-Image-2512-Lightning-4steps-V1.0-bf16.safetensors",)},
            {"repo": "lodestones/Chroma1-HD", "layout": "hub",
             "patterns": COMPONENTS},
        ])
    return result


def selected_files(siblings, patterns):
    return [f for f in siblings
            if any(fnmatch.fnmatchcase(f.rfilename, p) for p in patterns)]


def complete(path: Path | None, size: int) -> bool:
    return path is not None and path.is_file() and path.stat().st_size == size


def retry(label, action):
    for attempt in range(1, 5):
        try:
            return action()
        except Exception as exc:
            # 不打印异常全文，防止库错误信息包含临时签名 URL。
            print(f"{label} 失败：{type(exc).__name__}（第 {attempt}/4 次）", flush=True)
            if attempt == 4:
                raise RuntimeError(f"{label} 失败，请检查网络、访问权限和磁盘后重试") from None
            time.sleep(min(5 * attempt, 15))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scope", choices=("sdxl", "all"), default="all",
                        help="sdxl：共享人脸模型；all：再加 Qwen 和 Chroma 管线")
    parser.add_argument("--hf-home", default="/root/raiw-test/model-cache")
    parser.add_argument("--diffsynth-dir", default="/root/raiw-test/model-cache/diffsynth")
    parser.add_argument("--download", action="store_true")
    args = parser.parse_args()

    version = importlib.metadata.version("remove-ai-watermarks")
    if version != "0.47.1":
        raise RuntimeError(f"此脚本对应 0.47.1，当前安装版本为 {version}")
    hf = Path(args.hf_home).expanduser().resolve()
    ds = Path(args.diffsynth_dir).expanduser().resolve()
    # 必须在导入 SDK 前设置。只影响本次脚本，不修改外部环境或服务。
    os.environ.update(HF_HOME=str(hf), HF_HUB_OFFLINE="0", HF_HUB_DISABLE_XET="1")
    os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "120")
    os.environ.setdefault("HF_HUB_ETAG_TIMEOUT", "60")
    from huggingface_hub import HfApi, hf_hub_download, try_to_load_from_cache
    import fcntl

    hf.mkdir(parents=True, exist_ok=True)
    ds.mkdir(parents=True, exist_ok=True)
    with (hf / "prepare-missing-models.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("已有补齐脚本正在运行，请查看已有日志") from None
        api = HfApi()
        plan = []
        disks = {}
        for spec in specs(args.scope):
            repo = spec["repo"]
            print(f"查询文件列表：{repo}", flush=True)
            info = retry(repo, lambda: api.model_info(repo, files_metadata=True))
            files = selected_files(info.siblings, spec["patterns"])
            if not files or not any(f.rfilename.endswith(".safetensors") for f in files):
                raise RuntimeError(f"{repo} 未找到预期权重，未开始下载")
            root = ds if spec["layout"] == "diffsynth" else hf
            device = root.stat().st_dev
            disk = disks.setdefault(device, {"root": root, "needed": 0})
            needed = total = 0
            rows = []
            for f in files:
                if not isinstance(f.size, int) or f.size < 0:
                    raise RuntimeError(f"无法获取文件大小：{repo}/{f.rfilename}")
                if spec["layout"] == "diffsynth":
                    path = ds / repo / f.rfilename
                else:
                    cached = try_to_load_from_cache(repo, f.rfilename,
                                                   revision=info.sha, cache_dir=hf / "hub")
                    path = Path(cached) if isinstance(cached, str) else None
                exists = complete(path, f.size)
                total += f.size
                needed += 0 if exists else f.size
                rows.append({"name": f.rfilename, "size": f.size,
                             "path": str(path) if path else None})
            disk["needed"] += needed
            plan.append({**spec, "revision": info.sha, "files": rows})
            print(f"  所需文件 {len(files)} 个，合计 {total / GB:.2f} GB，"
                  f"尚需下载约 {needed / GB:.2f} GB", flush=True)

        enough = True
        for disk in disks.values():
            free = shutil.disk_usage(disk["root"]).free
            reserve = max(10 * GIB, int(disk["needed"] * 0.1))
            print(f"\n磁盘：{disk['root']}\n"
                  f"  可用 {free / GIB:.1f} GiB；新增预算 {disk['needed'] / GIB:.1f} GiB；"
                  f"另保留 {reserve / GIB:.1f} GiB", flush=True)
            enough = enough and free >= disk["needed"] + reserve
        if not args.download:
            print("\n仅完成统计，没有下载模型。需要下载时加 --download。", flush=True)
            if not enough:
                print("当前空间不足，完整下载前请先扩容或指定更大的磁盘目录。", flush=True)
            return
        if not enough:
            raise RuntimeError("空间不足，未开始下载。请先扩容，或选择 --scope sdxl")

        for spec in plan:
            for f in spec["files"]:
                path = Path(f["path"]) if f["path"] else None
                if complete(path, f["size"]):
                    print(f"复用：{spec['repo']}/{f['name']}", flush=True)
                    continue
                print(f"下载：{spec['repo']}/{f['name']}（{f['size'] / GB:.3f} GB）", flush=True)
                kwargs = {"repo_id": spec["repo"], "filename": f["name"],
                          "revision": spec["revision"]}
                if spec["layout"] == "diffsynth":
                    kwargs["local_dir"] = str(ds / spec["repo"])
                else:
                    kwargs["cache_dir"] = str(hf / "hub")
                if path is not None and path.exists():
                    kwargs["force_download"] = True
                result = retry(f"下载 {spec['repo']}/{f['name']}",
                               lambda: hf_hub_download(**kwargs))
                if not complete(Path(result), f["size"]):
                    raise RuntimeError(f"下载文件大小不匹配：{spec['repo']}/{f['name']}")
                f["path"] = str(result)
            if spec["layout"] == "hub":
                # 下载固定 commit 不会自动建立 refs/main；离线 from_pretrained
                # 默认查询 main，因此在整仓所需文件完成后再建立该引用。
                refs = hf / "hub" / ("models--" + spec["repo"].replace("/", "--")) / "refs"
                refs.mkdir(parents=True, exist_ok=True)
                temporary = refs / "main.prepare"
                temporary.write_text(spec["revision"], encoding="utf-8")
                temporary.replace(refs / "main")

        record = {"upstream_version": version, "scope": args.scope,
                  "hf_home": str(hf), "diffsynth_dir": str(ds), "models": plan,
                  "validation": "file sizes checked; inference not tested"}
        destination = hf / f"prepared-missing-{args.scope}.json"
        tmp = destination.with_suffix(".tmp")
        tmp.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(destination)
        print(f"\n下载完成，文件大小检查通过。清单：{destination}", flush=True)
        print("尚未测试真实推理。服务还需设置：", flush=True)
        print(f"HF_HOME={hf}\nDIFFSYNTH_MODEL_BASE_PATH={ds}\n"
              "DIFFSYNTH_DOWNLOAD_SOURCE=huggingface\nDIFFSYNTH_SKIP_DOWNLOAD=True", flush=True)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n已停止；完整文件保留。重跑可复用完整文件，未完成文件不保证跨进程续传。",
              flush=True)
        raise SystemExit(130)
    except Exception as exc:
        print(f"\n错误：{type(exc).__name__}: {exc}", flush=True)
        raise SystemExit(1)
