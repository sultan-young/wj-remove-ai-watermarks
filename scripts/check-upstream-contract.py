#!/usr/bin/env python3
"""Check adapter keyword arguments against upstream source without importing Torch."""
import argparse
import ast
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('--wheel', required=True)
args = parser.parse_args()
with zipfile.ZipFile(args.wheel) as archive:
    source = ast.parse(archive.read('remove_ai_watermarks/invisible_engine.py'))
    metadata = archive.read('remove_ai_watermarks-0.47.1.dist-info/METADATA').decode()
    assert '\nVersion: 0.47.1\n' in metadata
    methods = {node.name: node for node in ast.walk(source) if isinstance(node, ast.FunctionDef)}
    expected = {
        '__init__': {'pipeline', 'controlnet_conditioning_scale', 'cpu_offload', 'progress_callback'},
        'preload': {'global_only'},
        'remove_watermark': {'image_path', 'output_path', 'strength', 'seed', 'vendor', 'max_resolution', 'humanize', 'unsharp',
                             'adaptive_polish', 'tile', 'tile_size', 'tile_overlap', 'text_manifest', 'fidelity_anchor'},
    }
    for name, used in expected.items():
        method = methods[name]
        accepted = {a.arg for a in method.args.args + method.args.kwonlyargs}
        assert used <= accepted, (name, used - accepted)
    profiles = ast.parse(archive.read('remove_ai_watermarks/_internal/watermark_profiles.py'))
    names = {node.name for node in ast.walk(profiles) if isinstance(node, ast.FunctionDef)}
    assert {'vendor_for_strength', 'resolve_strength', 'resolve_effective_profile'} <= names
print('PASS: adapter calls match exact 0.47.1 wheel signatures (no GPU inference performed)')
