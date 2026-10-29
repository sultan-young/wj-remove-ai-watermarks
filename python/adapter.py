"""Thin adapter for the exact remove-ai-watermarks 0.47.1 Python interface."""
import hashlib
import importlib.metadata
import json
import os
import shutil
import time
from pathlib import Path
from PIL import Image, ImageOps


class AdapterError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def inspect_image(path):
    Image.MAX_IMAGE_PIXELS = int(os.environ.get("MAX_IMAGE_PIXELS", "16777216"))
    with Image.open(path) as image:
        if image.format not in ("PNG", "JPEG", "WEBP") or getattr(image, "n_frames", 1) != 1:
            raise AdapterError("INVALID_IMAGE", "Unsupported image")
        if image.width * image.height > Image.MAX_IMAGE_PIXELS:
            raise AdapterError("INVALID_IMAGE", "Image pixel limit exceeded")
        image.load()
        return ImageOps.exif_transpose(image).size


def source_pixel_sha256(image):
    """与上游 text_restoration.source_pixel_sha256 相同：宽、高各 8 字节大端，再加 RGB 像素。"""
    rgb = image.convert("RGB")
    digest = hashlib.sha256()
    digest.update(rgb.width.to_bytes(8, "big"))
    digest.update(rgb.height.to_bytes(8, "big"))
    digest.update(rgb.tobytes())
    return digest.hexdigest()


def bind_text_manifest(source, manifest_path):
    """文字框按进入隐式重建的那张图重新绑定像素哈希。完整处理时这张图已经清过可见水印。"""
    if not manifest_path:
        return None
    path = Path(manifest_path)
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise AdapterError("INVALID_MANIFEST", "Text manifest must be an object")
    raw_lines = payload.get("lines")
    if not isinstance(raw_lines, list) or not raw_lines:
        raise AdapterError("INVALID_MANIFEST", "Text manifest lines must be a non-empty list")
    with Image.open(source) as image:
        rgb = ImageOps.exif_transpose(image).convert("RGB")
        width, height = rgb.size
        lines = []
        for index, item in enumerate(raw_lines):
            box = item.get("box") if isinstance(item, dict) else None
            if not isinstance(box, list) or len(box) != 4 or any(isinstance(value, bool) or not isinstance(value, int) for value in box):
                raise AdapterError("INVALID_MANIFEST", f"Text manifest line {index} box must contain four integers")
            x1, y1, x2, y2 = box
            if not (0 <= x1 < x2 <= width and 0 <= y1 < y2 <= height):
                raise AdapterError("INVALID_MANIFEST", f"Text manifest line {index} box is outside the source")
            lines.append({"box": [x1, y1, x2, y2]})
        lines.sort(key=lambda line: (line["box"][1], line["box"][0]))
        payload = {
            "schema_version": 2,
            "verified": True,
            "width": width,
            "height": height,
            "source_pixel_sha256": source_pixel_sha256(rgb),
            "lines": lines,
        }
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def stage_from_message(message):
    lower = message.lower()
    if "loading" in lower:
        return "loading_models"
    if "detecting faces" in lower:
        return "detecting_faces"
    if "face" in lower and any(word in lower for word in ("running", "repair", "regenerat")):
        return "face_pass"
    if any(word in lower for word in ("polish", "sharpen", "upscal", "grain")):
        return "postprocessing"
    if "running" in lower and "pass" in lower:
        return "global_pass"
    return None


def probe_optional_capabilities():
    """可见水印和神经填充是可选安装。探测失败时只保留不会因为缺包而报错的选项。"""
    visible = False
    try:
        import remove_ai_watermarks as raiw
        visible = callable(getattr(raiw, "remove_visible_detailed", None))
    except Exception:
        return False, ["auto"]
    backends = ["auto"]
    try:
        import importlib.util
        if importlib.util.find_spec("cv2"):
            backends.append("cv2")
        for backend, modules in (("migan", ("migan",)), ("lama", ("simple_lama_inpainting", "lama_inpainting"))):
            if any(importlib.util.find_spec(name) for name in modules):
                backends.append(backend)
    except Exception:
        pass
    return visible, backends


class RealAdapter:
    def __init__(self, config, progress):
        version = importlib.metadata.version("remove-ai-watermarks")
        if version != "0.47.1":
            raise AdapterError("LIBRARY_VERSION_MISMATCH", f"Expected 0.47.1, found {version}")
        self.progress = progress
        self.config = config
        self.engine = None
        visible, backends = probe_optional_capabilities()
        self.info = {
            "mode": "real", "library_version": version,
            "engine": None, "preload": None,
            "visible_available": visible, "visible_backends": backends,
        }

    def _ensure_engine(self):
        if self.engine is not None:
            return self.engine
        import torch
        if not torch.cuda.is_available():
            raise AdapterError("CUDA_UNAVAILABLE", "CUDA is not available")
        from remove_ai_watermarks.invisible_engine import InvisibleEngine
        self.engine = InvisibleEngine(
            pipeline=self.config["pipeline"],
            controlnet_conditioning_scale=self.config["controlnet_scale"],
            cpu_offload=self.config["cpu_offload"],
            progress_callback=self._progress,
        )
        self.engine.preload(global_only=True)
        self.info.update({
            "gpu": torch.cuda.get_device_name(0),
            "vram_bytes": torch.cuda.get_device_properties(0).total_memory,
            "torch_version": torch.__version__, "torch_cuda": torch.version.cuda,
            "engine": self.config, "preload": "global_only",
        })
        return self.engine

    def _progress(self, message):
        print(message, flush=True)
        stage = stage_from_message(message)
        if stage:
            self.progress(stage)

    def process(self, job):
        p = job["options"]["processing"]
        mode = p.get("mode") or "invisible"
        source, output = Path(job["input"]), Path(job["output"])
        if mode == "metadata":
            return self._metadata(source, output)
        if mode == "visible":
            report = self._visible(source, output, p)
            return {"mode": "visible", "verification": "not_performed", **report}
        if mode == "all":
            return self._all(source, output, p, job.get("manifest"))
        if mode != "invisible":
            raise AdapterError("INVALID_MODE", "Unsupported processing mode")
        return self._invisible(source, output, p, job.get("manifest"))

    def _visible(self, source, output, processing):
        import remove_ai_watermarks as raiw
        if not hasattr(raiw, "remove_visible_detailed"):
            raise AdapterError("UPSTREAM_UNAVAILABLE", "Visible removal is not available in this install")
        sensitivity = str(processing.get("visible_mark") or "auto").strip().lower()
        if sensitivity not in ("auto", "strict"):
            sensitivity = "auto"
        kwargs = {"strip_metadata": True, "write_noop": True, "sensitivity": sensitivity}
        backend = processing.get("visible_backend") or "auto"
        if backend != "auto":
            kwargs["backend"] = backend
        self.progress("visible")
        try:
            report = raiw.remove_visible_detailed(str(source), str(output), **kwargs)
        except ImportError as error:
            raise AdapterError("UPSTREAM_UNAVAILABLE", "Visible removal dependencies are not installed") from error
        self._force_png(source, output)
        marks = []
        for label in getattr(report, "labels", None) or []:
            if label:
                marks.append(str(label))
        for item in getattr(report, "marks", None) or getattr(report, "visible_marks", None) or []:
            label = item if isinstance(item, str) else getattr(item, "label", None)
            if label and str(label) not in marks:
                marks.append(str(label))
        return {
            "visible_status": str(getattr(report, "status", "") or ""),
            "visible_marks": marks,
        }

    def _metadata(self, source, output):
        try:
            from remove_ai_watermarks.metadata import has_ai_metadata, strip_and_verify
        except (ImportError, AttributeError) as error:
            raise AdapterError("UPSTREAM_UNAVAILABLE", "Metadata removal is not available in this install") from error
        self.progress("metadata")
        if has_ai_metadata(source):
            stripped = output.with_name(output.name + ".stripped")
            written, surviving = strip_and_verify(source, stripped)
            if surviving:
                raise AdapterError("METADATA_REMAINS", str(surviving)[:500])
            shutil.copyfile(written, output)
            metadata = "stripped"
        else:
            shutil.copyfile(source, output)
            metadata = "no_metadata"
        self._force_png(source, output)
        return {"mode": "metadata", "metadata": metadata, "verification": "not_performed"}

    def _processing_for_diffusion(self, source, processing):
        """完整处理会先抹掉可见水印和元数据。来源和有无信号必须在原图上判断。"""
        prepared = dict(processing)
        if prepared.get("vendor") != "auto":
            return prepared
        from remove_ai_watermarks._internal.watermark_profiles import vendor_for_strength
        if not prepared.get("force"):
            from remove_ai_watermarks.identify import has_invisible_target
            if not has_invisible_target(source):
                raise AdapterError("NO_SIGNAL", "No supported local signal; explicit vendor or force is required")
        prepared["vendor"] = vendor_for_strength(source)
        prepared["force"] = True
        return prepared

    def _all(self, source, output, processing, manifest):
        prepared = self._processing_for_diffusion(source, processing)
        visible_path = output.with_name(output.name + ".visible.png")
        try:
            visible = self._visible(source, visible_path, processing)
            invisible = self._invisible(visible_path, output, prepared, manifest)
        finally:
            visible_path.unlink(missing_ok=True)
        self._strip_written_metadata(output)
        return {**invisible, **visible, "mode": "all"}

    def _strip_written_metadata(self, output):
        try:
            from remove_ai_watermarks.metadata import has_ai_metadata, strip_and_verify
        except Exception:
            return
        if not has_ai_metadata(output):
            return
        stripped = output.with_name(output.name + ".meta")
        written, surviving = strip_and_verify(output, stripped)
        if surviving:
            raise AdapterError("METADATA_REMAINS", str(surviving)[:500])
        shutil.copyfile(written, output)
        self._force_png(output, output)

    def _force_png(self, source, output):
        expected = inspect_image(source)
        with Image.open(output) as image:
            current = ImageOps.exif_transpose(image)
            if current.size != expected:
                raise AdapterError("OUTPUT_GEOMETRY_MISMATCH", "Output dimensions changed")
            if current.mode not in ("RGB", "RGBA"):
                current = current.convert("RGBA" if "A" in current.getbands() else "RGB")
            temporary = output.with_name(output.name + ".png-rewrite")
            current.save(temporary, format="PNG")
        temporary.replace(output)

    def _invisible(self, source, output, p, manifest_path):
        from remove_ai_watermarks._internal.watermark_profiles import (
            vendor_for_strength, resolve_strength, resolve_effective_profile,
        )
        manifest = bind_text_manifest(source, manifest_path)
        width, height = inspect_image(source)
        explicit = p["vendor"] != "auto"
        vendor = p["vendor"] if explicit else vendor_for_strength(source)
        if not p["force"] and not explicit:
            from remove_ai_watermarks.identify import has_invisible_target
            if not has_invisible_target(source):
                raise AdapterError("NO_SIGNAL", "No supported local signal; explicit vendor or force is required")
        if manifest and os.environ.get("ENABLE_TEXT_RESTORATION") != "true":
            raise AdapterError("TEXT_RESTORATION_DISABLED", "Text restoration disabled")
        profile = resolve_effective_profile(p["pipeline"], vendor)
        strength = resolve_strength(p["strength"], vendor, p["pipeline"], size=(width, height))
        self.progress("processing")
        self._ensure_engine().remove_watermark(
            image_path=source, output_path=output,
            strength=p["strength"], seed=p["seed"], vendor=vendor,
            max_resolution=p["max_resolution"], humanize=p["humanize"], unsharp=p["unsharp"],
            adaptive_polish={"default": None, "on": True, "off": False}[p["adaptive_polish"]],
            tile=p["tile"], tile_size=p["tile_size"], tile_overlap=p["tile_overlap"],
            text_manifest=manifest, fidelity_anchor=p["fidelity_anchor"],
        )
        if inspect_image(output) != (width, height):
            raise AdapterError("OUTPUT_GEOMETRY_MISMATCH", "Output dimensions changed")
        return {
            "mode": "invisible",
            "pipeline": profile, "vendor": vendor, "strength": strength, "seed": p["seed"],
            "input_width": width, "input_height": height,
            "max_resolution": p["max_resolution"], "tile": p["tile"],
            "resolution_cap_applied": not p["tile"] and p["max_resolution"] > 0 and max(width, height) > p["max_resolution"],
            "text_restoration": bool(manifest), "verification": "not_performed",
        }


class MockAdapter:
    """Transport/testing only. Copies decoded pixels; DOES NOT remove watermarks."""
    def __init__(self, config, progress):
        self.config, self.progress = config, progress
        self.info = {
            "mode": "mock", "gpu": None, "engine": config, "warning": "MOCK: no watermark processing",
            "visible_available": True, "visible_backends": ["auto", "cv2", "migan", "lama"],
        }

    def process(self, job):
        inspect_image(job["input"])
        self.progress("mock_processing")
        time.sleep(int(os.environ.get("MOCK_DELAY_MS", "50")) / 1000)
        mode = ((job.get("options") or {}).get("processing") or {}).get("mode") or "invisible"
        with Image.open(job["input"]) as image:
            result = ImageOps.exif_transpose(image)
            result.save(job["output"], format="PNG", icc_profile=image.info.get("icc_profile"))
        return {"mock": True, "mode": mode, "verification": "not_performed", "warning": "No watermark processing"}
