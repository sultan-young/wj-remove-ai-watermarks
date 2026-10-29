"""Contract tests with fake model modules. These do not run CUDA or diffusion."""
import json
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch
from PIL import Image
from adapter import RealAdapter, AdapterError


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.source, self.output = root / "source.png", root / "out.png"
        Image.new("RGB", (32, 24)).save(self.source)
        self.calls = []
        calls = self.calls
        class Engine:
            def __init__(self, **kwargs):
                calls.append(("init", kwargs))
            def preload(self, **kwargs):
                calls.append(("preload", kwargs))
            def remove_watermark(self, **kwargs):
                calls.append(("run", kwargs))
                with Image.open(kwargs["image_path"]) as image:
                    image.save(kwargs["output_path"])
        self.modules = {
            "torch": types.SimpleNamespace(cuda=types.SimpleNamespace(
                is_available=lambda: True, get_device_name=lambda _: "Fake GPU",
                get_device_properties=lambda _: types.SimpleNamespace(total_memory=24000000000)),
                __version__="fake", version=types.SimpleNamespace(cuda="fake")),
            "remove_ai_watermarks": types.ModuleType("remove_ai_watermarks"),
            "remove_ai_watermarks.invisible_engine": types.SimpleNamespace(InvisibleEngine=Engine),
            "remove_ai_watermarks._internal": types.ModuleType("remove_ai_watermarks._internal"),
            "remove_ai_watermarks._internal.watermark_profiles": types.SimpleNamespace(
                vendor_for_strength=lambda _: "openai", resolve_strength=lambda strength, vendor, pipeline, **kw: strength if strength is not None else 0.15,
                resolve_effective_profile=lambda pipeline, vendor: pipeline),
            "remove_ai_watermarks.identify": types.SimpleNamespace(has_invisible_target=lambda _: False),
        }
        self.options = {"pipeline": "sdxl-zimage", "vendor": "auto", "strength": None, "seed": 0,
                        "max_resolution": 0, "humanize": 0, "unsharp": 0, "adaptive_polish": "default",
                        "tile": False, "tile_size": 1024, "tile_overlap": 128, "force": True,
                        "fidelity_anchor": False}

    def tearDown(self):
        self.temp.cleanup()

    def run_with_stubs(self, callback):
        with patch.dict("sys.modules", self.modules), patch("importlib.metadata.version", return_value="0.47.1"):
            return callback(RealAdapter({"pipeline": "sdxl-zimage", "controlnet_scale": 1, "cpu_offload": False}, lambda _: None))

    def job(self):
        return {"input": str(self.source), "output": str(self.output), "options": {"processing": self.options}}

    def test_parameters_provenance_and_engine_reuse(self):
        def execute(adapter):
            first = adapter.process(self.job())
            adapter.process(self.job())
            self.assertEqual(first["vendor"], "openai")
            self.assertEqual(first["strength"], 0.15)
        self.run_with_stubs(execute)
        self.assertEqual(len([x for x in self.calls if x[0] == "init"]), 1)
        self.assertEqual(self.calls[1], ("preload", {"global_only": True}))
        run = next(x[1] for x in self.calls if x[0] == "run")
        self.assertIsNone(run["adaptive_polish"])
        self.assertEqual(run["max_resolution"], 0)
        self.assertEqual(run["vendor"], "openai")

    def test_no_signal_does_not_publish_output(self):
        self.options["force"] = False
        with self.assertRaises(AdapterError) as error:
            self.run_with_stubs(lambda adapter: adapter.process(self.job()))
        self.assertEqual(error.exception.code, "NO_SIGNAL")
        self.assertFalse(self.output.exists())

    def test_explicit_vendor_overrides_gate(self):
        self.options.update(force=False, vendor="google", adaptive_polish="off")
        self.run_with_stubs(lambda adapter: adapter.process(self.job()))
        run = next(x[1] for x in self.calls if x[0] == "run")
        self.assertEqual(run["vendor"], "google")
        self.assertFalse(run["adaptive_polish"])

    def test_visible_mode_does_not_run_diffusion(self):
        self.options["mode"] = "visible"
        self.options["visible_mark"] = "strict"
        self.options["visible_backend"] = "cv2"

        def visible(source, output, **kwargs):
            self.calls.append(("visible", kwargs))
            Image.open(source).save(output, format="PNG")
            return types.SimpleNamespace(status="cleaned", marks=[types.SimpleNamespace(label="gemini")])

        self.modules["remove_ai_watermarks"].remove_visible_detailed = visible

        def execute(adapter):
            result = adapter.process(self.job())
            self.assertEqual(result["mode"], "visible")
            self.assertEqual(result["visible_status"], "cleaned")
            self.assertEqual(result["visible_marks"], ["gemini"])
        self.run_with_stubs(execute)
        self.assertFalse(any(item[0] == "run" for item in self.calls))
        self.assertFalse(any(item[0] == "init" for item in self.calls))
        self.assertEqual(self.calls[-1][0], "visible")
        self.assertEqual(self.calls[-1][1]["sensitivity"], "strict")
        self.assertNotIn("mark", self.calls[-1][1])
        self.assertEqual(self.calls[-1][1]["backend"], "cv2")

    def test_metadata_mode_copies_when_no_ai_metadata(self):
        self.options["mode"] = "metadata"
        metadata = types.ModuleType("remove_ai_watermarks.metadata")
        metadata.has_ai_metadata = lambda _path: False
        metadata.strip_and_verify = lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("strip"))
        self.modules["remove_ai_watermarks.metadata"] = metadata

        def execute(adapter):
            result = adapter.process(self.job())
            self.assertEqual(result["metadata"], "no_metadata")
            self.assertTrue(self.output.exists())
        self.run_with_stubs(execute)
        self.assertFalse(any(item[0] == "run" for item in self.calls))
        self.assertFalse(any(item[0] == "init" for item in self.calls))

    def test_unknown_visible_mark_is_rejected(self):
        self.options.update(mode="visible", visible_mark="loose")

        def visible(*_args, **_kwargs):
            raise AssertionError("visible removal should not run")

        self.modules["remove_ai_watermarks"].remove_visible_detailed = visible
        with self.assertRaises(AdapterError) as error:
            self.run_with_stubs(lambda adapter: adapter.process(self.job()))
        self.assertEqual(error.exception.code, "INVALID_OPTIONS")

    def test_all_mode_without_signal_still_removes_visible_marks(self):
        self.options.update(mode="all", force=False)

        def visible(source, output, **kwargs):
            self.calls.append(("visible", kwargs))
            Image.open(source).save(output, format="PNG")
            return types.SimpleNamespace(status="cleaned", marks=[])

        self.modules["remove_ai_watermarks"].remove_visible_detailed = visible

        def execute(adapter):
            result = adapter.process(self.job())
            self.assertEqual(result["mode"], "all")
            self.assertEqual(result["visible_status"], "cleaned")
            self.assertEqual(result["invisible"], "not_run")
            self.assertEqual(result["reason"], "NO_SIGNAL")
            self.assertTrue(self.output.exists())
        self.run_with_stubs(execute)
        self.assertTrue(any(item[0] == "visible" for item in self.calls))
        self.assertFalse(any(item[0] in ("run", "init") for item in self.calls))

    def test_container_pid_1_is_a_valid_supervisor(self):
        from worker import reparented
        self.assertFalse(reparented(1, 1))
        self.assertTrue(reparented(4321, 1))

    def test_all_mode_runs_visible_then_diffusion(self):
        self.options["mode"] = "all"

        def visible(source, output, **kwargs):
            self.calls.append(("visible", kwargs))
            Image.open(source).save(output, format="PNG")
            return types.SimpleNamespace(status="no_watermark", marks=[])

        self.modules["remove_ai_watermarks"].remove_visible_detailed = visible
        seen = []

        def vendor(path):
            seen.append(str(path))
            return "openai"

        self.modules["remove_ai_watermarks._internal.watermark_profiles"].vendor_for_strength = vendor

        def execute(adapter):
            result = adapter.process(self.job())
            self.assertEqual(result["mode"], "all")
            self.assertEqual(result["visible_status"], "no_watermark")
            self.assertEqual(result["vendor"], "openai")
        self.run_with_stubs(execute)
        self.assertEqual(seen, [str(self.source)])
        self.assertTrue(any(item[0] == "visible" for item in self.calls))
        self.assertTrue(any(item[0] == "run" for item in self.calls))

    def test_text_manifest_is_bound_to_the_image_entering_diffusion(self):
        from adapter import bind_text_manifest
        manifest = self.output.with_name("manifest.json")
        manifest.write_text(json.dumps({
            "lines": [{"box": [0, 10, 8, 20]}, {"box": [1, 1, 4, 6]}],
        }), encoding="utf-8")
        bind_text_manifest(self.source, manifest)
        payload = json.loads(manifest.read_text(encoding="utf-8"))
        self.assertEqual(payload["schema_version"], 2)
        self.assertTrue(payload["verified"])
        self.assertEqual(payload["width"], 32)
        self.assertEqual(payload["height"], 24)
        self.assertEqual(payload["lines"][0]["box"], [1, 1, 4, 6])
        self.assertEqual(len(payload["source_pixel_sha256"]), 64)

    def test_version_guard(self):
        with patch("importlib.metadata.version", return_value="9.0.0"):
            with self.assertRaises(AdapterError):
                RealAdapter({}, print)


if __name__ == "__main__":
    unittest.main()
