#!/usr/bin/env python3
"""Explicit online preparation, separate from normal offline service startup."""
import argparse
import json
import os
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--pipeline", choices=["sdxl-zimage", "qwen-zimage", "chroma-zimage"], default="sdxl-zimage")
parser.add_argument("--include-face", action="store_true", help="Also download/load Z-Image/SAM face models")
args = parser.parse_args()
os.environ["HF_HUB_OFFLINE"] = "0"
from remove_ai_watermarks.invisible_engine import InvisibleEngine

engine = InvisibleEngine(pipeline=args.pipeline, progress_callback=print)
engine.preload(global_only=not args.include_face)
home = Path(os.environ.get("HF_HOME", Path.home() / ".cache/huggingface"))
inventory = {p.parent.name: sorted(x.name for x in p.iterdir() if x.is_dir())
             for p in (home / "hub").glob("models--*/snapshots")}
record = {"pipeline": args.pipeline, "face_prepared": args.include_face, "cache_snapshots": inventory}
(home / "prepared-models.json").write_text(json.dumps(record, indent=2))
print("Prepared model inventory:", home / "prepared-models.json")
