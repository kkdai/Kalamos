FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
RUN npm run build:web && npm prune --omit=dev

FROM node:22-bookworm-slim AS pandoc
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && case "$TARGETARCH" in \
        amd64) sha=c224fab89f827d3623380ecb7c1078c163c769c849a14ac27e8d3bfbb914c9b4 ;; \
        arm64) sha=166a5a37387eb10bd4c4f242a8109beef755ac1e8d4eb039c6b5ebd1d918d8d7 ;; \
        *) exit 1 ;; \
    esac \
    && curl -fsSL --retry 3 "https://github.com/jgm/pandoc/releases/download/3.8.3/pandoc-3.8.3-linux-${TARGETARCH}.tar.gz" -o /tmp/pandoc.tar.gz \
    && echo "$sha  /tmp/pandoc.tar.gz" | sha256sum -c - \
    && tar -xz -C /usr/local/bin --strip-components=2 -f /tmp/pandoc.tar.gz pandoc-3.8.3/bin/pandoc \
    && /usr/local/bin/pandoc --version

FROM node:22-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium chromium-sandbox fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=pandoc /usr/local/bin/pandoc /usr/local/bin/pandoc
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src/editor/image-attrs.ts ./src/editor/image-attrs.ts
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/web/server ./web/server
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "--experimental-strip-types", "web/server/index.ts"]
