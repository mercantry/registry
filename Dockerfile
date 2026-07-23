# Registry v1 — single container serving every surface:
#   /mcp  MCP over Streamable HTTP (remote agents)
#   /v1   REST mirror
#   /     Ops Console (gate with OPS_TOKEN)
# The fulfillment worker runs in-process. SQLite lives on a volume at /data.
FROM node:22-slim

# curl + unzip: the import-release workflow streams release artifacts to the
# machine over presigned URLs and unpacks them next to the live volume.
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# better-sqlite3 ships prebuilt binaries for linux x64/arm64 glibc, so no
# toolchain is needed; if a prebuild is ever missing, add:
#   apt-get update && apt-get install -y python3 make g++
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production \
    PORT=4100 \
    REGISTRY_DB=/data/registry.db \
    DEMO_ACCELERATE=0 \
    TRUST_PROXY=1

VOLUME /data
EXPOSE 4100

# tsx is a runtime dependency of the npm scripts; run the server directly.
CMD ["npx", "tsx", "src/api/server.ts"]
