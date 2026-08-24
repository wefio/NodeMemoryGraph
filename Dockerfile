# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=22.19.0

FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build


FROM node:${NODE_VERSION}-bookworm-slim AS runtime

ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cu126
ARG BGE_SOURCE_MODEL=BAAI/bge-small-en-v1.5
ARG BGE_REVISION=5c38ec7c405ec4b44b94cc5a9bb96e735b38267a

ENV DEBIAN_FRONTEND=noninteractive \
    NMG_DATA_DIR=/data \
    NMG_DB_PATH=/data/nmg.sqlite \
    NMG_DAEMON_IDLE_TIMEOUT_MS=0 \
    NMG_EMBED_BASE_URL=http://127.0.0.1:8000/v1 \
    NMG_EMBED_MODEL=BAAI/bge-small-en-v1.5 \
    NMG_EMBED_PROFILE=bge-en \
    BGE_MODEL=/opt/models/bge-small-en-v1.5 \
    BGE_PORT=8000 \
    VIRTUAL_ENV=/opt/nmg-embed \
    PATH=/opt/nmg-embed/bin:$PATH

RUN apt-get -o Acquire::Retries=5 update \
    && apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
       ca-certificates \
       python3 \
       python3-pip \
       python3-venv \
       tini \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv "$VIRTUAL_ENV" \
    && pip install --no-cache-dir --upgrade pip setuptools wheel \
    && pip install --no-cache-dir --index-url "$TORCH_INDEX_URL" torch

RUN pip install --no-cache-dir sentence-transformers fastapi "uvicorn[standard]"

RUN BGE_SOURCE_MODEL="$BGE_SOURCE_MODEL" BGE_SOURCE_REVISION="$BGE_REVISION" \
    python -c 'import os; from sentence_transformers import SentenceTransformer; model = SentenceTransformer(os.environ["BGE_SOURCE_MODEL"], revision=os.environ["BGE_SOURCE_REVISION"]); model.save_pretrained("/opt/models/bge-small-en-v1.5")'

ENV HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    NMG_EMBED_AUTO_SYNC=1

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional \
    && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY bin ./bin
COPY evals/omnimemeval/bge-server.py ./evals/omnimemeval/bge-server.py
COPY docker/entrypoint.sh ./docker/entrypoint.sh

RUN chmod +x ./docker/entrypoint.sh \
    && mkdir -p /data

VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3)" \
      && node bin/nmg.mjs daemon status --db "$NMG_DB_PATH" --json \
      | grep -q '"running": true'

ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker/entrypoint.sh"]
