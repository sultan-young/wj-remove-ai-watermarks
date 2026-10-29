"""Test-only fault injection. Not used by service defaults."""
import os
import sys
import time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))
import adapter

original = adapter.MockAdapter.process
def process(self, job):
    seed = job["options"]["processing"]["seed"]
    if seed == 99:
        os._exit(9)
    if seed == 98:
        time.sleep(5)
    if seed == 97:
        from PIL import Image
        Image.new("RGB", (2, 2)).save(job["output"])
        return {"mock": True}
    if seed == 96:
        raise RuntimeError("Simulated model failure")
    return original(self, job)
adapter.MockAdapter.process = process
import worker
worker.main()
