"""Thin adapter for the exact remove-ai-watermarks 0.47.1 Python interface."""
import importlib.metadata
import os
import shutil
import time
from pathlib import Path
from PIL import Image, ImageOps


_UNRESOLVED = object()


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
    marks = ["auto"]
    try:
        import remove_ai_watermarks as raiw
        visible = callable(getattr(raiw, "remove_visible_detailed", None))
    except Exception:
        return False, ["auto"], ["auto"]
    try:
        from remove_ai_watermarks import watermark_registry
        marks = ["auto", *watermark_registry.mark_keys()]
    except Exception:
        pass
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
    return visible, backends, marks


class RealAdapter:
    def __init__(self, config, progress):
        version = importlib.metadata.version("remove-ai-watermarks")
        if version != "0.47.1":
            raise AdapterError("LIBRARY_VERSION_MISMATCH", f"Expected 0.47.1, found {version}")
        self.progress = progress
        self.config = config
        self.engine = None
        visible, backends, marks = probe_optional_capabilities()
        self.info = {
            "mode": "real", "library_version": version,
            "engine": None, "preload": None,
            "visible_available": visible, "visible_backends": backends, "visible_marks": marks,
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
            controlnet_conditioning_scale=self.config["controlnet_conditioning_scale"],
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
            report = self._visible(source, output, p, keep_original_when_absent=False)
            return {"mode": "visible", "verification": "not_performed", **report}
        if mode == "all":
            return self._all(source, output, p, job.get("manifest"))
        if mode != "invisible":
            raise AdapterError("INVALID_MODE", "Unsupported processing mode")
        return self._invisible(source, output, p, job.get("manifest"))

    def _visible(self, source, output, processing, *, keep_original_when_absent):
        """keep_original_when_absent 只给 all 的中间图。单独的 visible 与上游一样：没去掉标记就不写结果。"""
        import remove_ai_watermarks as raiw
        sensitivity = str(processing.get("sensitivity") or "auto").strip().lower()
        if sensitivity not in ("auto", "strict"):
            raise AdapterError("INVALID_OPTIONS", "sensitivity must be auto or strict")
        mark = str(processing.get("mark") or "auto").strip().lower()
        detect = bool(processing.get("detect", True))
        if processing.get("mode") == "all" and (mark != "auto" or not detect):
            raise AdapterError("INVALID_OPTIONS", "all mode only runs the upstream auto visible pass")
        backend = processing.get("backend") or "auto"
        self.progress("visible")
        try:
            if mark == "auto" and detect:
                if not hasattr(raiw, "remove_visible_detailed"):
                    raise AdapterError("UPSTREAM_UNAVAILABLE", "Visible removal is not available in this install")
                return self._visible_auto(raiw, source, output, sensitivity, backend, keep_original_when_absent)
            # 上游 --no-detect 且 --mark auto 时，显式路径回落到 gemini。
            return self._visible_explicit(source, output, sensitivity, "gemini" if mark == "auto" else mark, detect, backend)
        except ImportError as error:
            raise AdapterError("UPSTREAM_UNAVAILABLE", "Visible removal dependencies are not installed") from error

    def _visible_auto(self, raiw, source, output, sensitivity, backend, keep_original_when_absent):
        kwargs = {"strip_metadata": True, "write_noop": keep_original_when_absent, "sensitivity": sensitivity}
        if backend != "auto":
            kwargs["backend"] = backend
        report = raiw.remove_visible_detailed(str(source), str(output), **kwargs)
        marks = self._visible_labels(report)
        if not marks and not keep_original_when_absent:
            output.unlink(missing_ok=True)
            raise AdapterError("NO_VISIBLE_MARK", "No known visible mark detected")
        if not output.exists() and keep_original_when_absent:
            shutil.copyfile(source, output)
        self._force_png(source, output)
        return {
            "visible_status": str(getattr(report, "status", "") or ""),
            "visible_marks": marks,
        }

    def _visible_explicit(self, source, output, sensitivity, mark, detect, backend):
        """与上游 visible --mark 相同：先检测命名标记；detect=false 时按该标记的固定足迹强制填充。"""
        import remove_ai_watermarks as raiw
        watermark_registry = raiw.watermark_registry
        if mark not in set(watermark_registry.mark_keys()):
            raise AdapterError("INVALID_OPTIONS", "Unknown visible mark")
        image_io = raiw.image_io
        visible_provenance = raiw.api.visible_provenance
        image, alpha = image_io.read_bgr_and_alpha(str(source))
        if image is None:
            raise AdapterError("INVALID_IMAGE", "Failed to read image")
        chosen = watermark_registry.get_mark(mark)
        provenance = visible_provenance(source)
        trust = watermark_registry.resolve_trust(
            chosen.key, sensitivity=sensitivity, provenance=provenance, strict_keys=set(),
        )
        relax = trust != "strict"
        detection = chosen.detect(image, provenance=relax)
        if detect and not detection.detected:
            output.unlink(missing_ok=True)
            raise AdapterError("NO_VISIBLE_MARK", f"{chosen.label} not detected")
        result, _region = chosen.remove(
            image, backend=backend, provenance=relax, force=not detect, detection=detection,
        )
        if not image_io.write_bgr_with_alpha(str(output), result, alpha, display_tags_from=source):
            raise AdapterError("OUTPUT_WRITE_FAILED", "Failed to write visible removal output")
        self._strip_written_metadata(output)
        self._force_png(source, output)
        return {"visible_status": None, "visible_marks": [str(chosen.label)]}

    def _visible_labels(self, report):
        marks = []
        for label in getattr(report, "labels", None) or []:
            if label:
                marks.append(str(label))
        for item in getattr(report, "marks", None) or getattr(report, "visible_marks", None) or []:
            label = item if isinstance(item, str) else getattr(item, "label", None)
            if label and str(label) not in marks:
                marks.append(str(label))
        return marks

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

    def _vendor_for_engine(self, source, processing):
        """与上游 invisible 命令相同：auto 先变成 None；显式 vendor 或 force 才跳过无信号检查。传给引擎的是解析后的 cohort。"""
        requested = processing.get("vendor") or "auto"
        resolved = None if requested == "auto" else requested
        if not processing.get("force") and resolved is None:
            from remove_ai_watermarks.identify import has_invisible_target
            if not has_invisible_target(source):
                raise AdapterError("NO_SIGNAL", "No supported local signal; explicit vendor or force is required")
        from remove_ai_watermarks._internal.watermark_profiles import vendor_for_strength
        detected = vendor_for_strength(source) if resolved is None else None
        return resolved or detected

    def _all(self, source, output, processing, manifest):
        """可见水印不依赖隐形信号。没有本地信号时仍返回可见处理结果，并标明隐形重建未执行。"""
        visible_path = output.with_name(output.name + ".visible.png")
        try:
            visible = self._visible(source, visible_path, processing, keep_original_when_absent=True)
            try:
                # 来源和有无信号按原图判断，不用已经清过可见水印的中间图。
                vendor = self._vendor_for_engine(source, processing)
            except AdapterError as error:
                if error.code != "NO_SIGNAL":
                    raise
                shutil.copyfile(visible_path, output)
                self._strip_written_metadata(output)
                return {**visible, "mode": "all", "invisible": "no-signal", "reason": "NO_SIGNAL", "verification": "not_performed"}
            invisible = self._invisible(visible_path, output, processing, manifest, vendor)
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

    def _invisible(self, source, output, p, manifest_path, vendor=_UNRESOLVED):
        from remove_ai_watermarks._internal.watermark_profiles import resolve_strength, resolve_effective_profile
        if vendor is _UNRESOLVED:
            vendor = self._vendor_for_engine(source, p)
        manifest = Path(manifest_path) if manifest_path else None
        width, height = inspect_image(source)
        profile = resolve_effective_profile(p["pipeline"], vendor)
        strength = resolve_strength(p["strength"], vendor, p["pipeline"], size=(width, height))
        self.progress("processing")
        self._ensure_engine().remove_watermark(
            image_path=source, output_path=output,
            strength=p["strength"], seed=p["seed"], vendor=vendor,
            max_resolution=p["max_resolution"], humanize=p["humanize"], unsharp=p["unsharp"],
            adaptive_polish=p.get("adaptive_polish"),
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
            "visible_marks": ["auto"],
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
