#!/usr/bin/env python3
"""Commands on stdin; protocol events on FD 3; library output on stdout/stderr."""
import ctypes
import json
import os
import sys
import threading
import traceback
import warnings
from adapter import RealAdapter, MockAdapter, AdapterError


def reparented(spawn_parent, current_parent):
    """父进程号变了才说明监督进程已经退出。容器里 Node 自己是 1 号进程时，这是正常状态。"""
    return current_parent != spawn_parent


def main():
    # Linux deployment: ask the kernel to signal this worker if Node dies.
    if sys.platform == "linux":
        parent = os.getppid()
        ctypes.CDLL(None).prctl(1, 15)
        if reparented(parent, os.getppid()):
            return
    channel = os.fdopen(3, "w", buffering=1)
    lock = threading.Lock()
    current = {"id": None}

    def emit(kind, **payload):
        with lock:
            channel.write(json.dumps({"protocol": 1, "type": kind, **payload}, ensure_ascii=False) + "\n")
            channel.flush()

    def progress(stage, detail=None):
        if not current["id"]:
            return
        payload = {"job_id": current["id"], "stage": stage}
        if detail:
            payload["detail"] = detail
        emit("stage", **payload)

    try:
        config = json.loads(os.environ["WORKER_INIT"])
        mode = os.environ.get("WORKER_MODE", "real")
        if mode not in ("real", "mock"):
            raise ValueError("Unknown worker mode")
        warnings.simplefilter("error", ImageWarning())
        adapter = (MockAdapter if mode == "mock" else RealAdapter)(config, progress)
        emit("ready", info=adapter.info)
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        emit("fatal", message=str(error)[:1000])
        return

    for line in sys.stdin:
        job = None
        try:
            job = json.loads(line)
            if job.get("protocol") != 1 or job.get("type") != "process":
                raise ValueError("Invalid command")
            current["id"] = job["id"]
            emit("started", job_id=job["id"])
            effective = adapter.process(job)
            emit("completed", job_id=job["id"], effective=effective)
        except Exception as error:
            traceback.print_exc(file=sys.stderr)
            code = error.code if isinstance(error, AdapterError) else "PROCESSING_FAILED"
            if "out of memory" in str(error).lower():
                code = "CUDA_OOM"
            emit("failed", job_id=job.get("id") if isinstance(job, dict) else None,
                 code=code, message=str(error)[:1000])
        finally:
            current["id"] = None


def ImageWarning():
    from PIL import Image
    return Image.DecompressionBombWarning


if __name__ == "__main__":
    main()
