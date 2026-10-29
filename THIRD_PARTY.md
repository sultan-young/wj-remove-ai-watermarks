# Third-party components

This service is a wrapper, not a fork or redistribution of model weights.

- remove-ai-watermarks 0.47.1: https://github.com/wiltodelta/remove-ai-watermarks — Apache-2.0. Installed as a Python dependency; source is not bundled here.
- Node.js / Fastify and associated npm packages retain their individual licenses; see package-lock.json and installed package LICENSE files.
- Model checkpoints (SDXL, ControlNet, Lightning LoRA, VAE, optional Qwen/Chroma/Z-Image/SAM) retain their own licenses and usage terms. They are not included in the ZIP.
- Docker base images and CUDA/PyTorch retain their respective licenses.

No proprietary watermark verifier is included. No synthetic camera-provenance metadata writer is included in this GPU service.
