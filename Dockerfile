# Optional deployment recipe for Docker-capable NVIDIA GPU hosts.
# Current CompShare container users should use scripts/install.sh + private image.
ARG NODE_IMAGE=node:24.22.1-bookworm-slim
FROM ${NODE_IMAGE} AS node-build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM nvidia/cuda:12.8.1-cudnn-runtime-ubuntu24.04
ARG TORCH_VERSION=2.7.1
ARG TORCHVISION_VERSION=0.22.1
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates libglib2.0-0 libgl1 util-linux \
    && rm -rf /var/lib/apt/lists/*
COPY --from=node-build /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=node-build /app/dist ./dist
COPY --from=node-build /app/node_modules ./node_modules
COPY --from=node-build /app/package.json ./package.json
COPY python ./python
COPY scripts ./scripts
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --upgrade pip \
    && /opt/venv/bin/pip install torch==${TORCH_VERSION} torchvision==${TORCHVISION_VERSION} --index-url https://download.pytorch.org/whl/cu128 \
    && printf 'torch==%s+cu128\ntorchvision==%s+cu128\n' "$TORCH_VERSION" "$TORCHVISION_VERSION" > /tmp/torch-constraints.txt \
    && /opt/venv/bin/pip install -c /tmp/torch-constraints.txt -r python/requirements.txt \
    && /opt/venv/bin/pip freeze > /app/python-build-freeze.txt
ENV PYTHON_BIN=/opt/venv/bin/python HF_HOME=/models DATA_DIR=/data MODEL_OFFLINE=true WORKER_MODE=real
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8000/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
