# Stage 1: Build Zoekt binaries
FROM golang:1.21 AS zoekt-builder
RUN go install github.com/sourcegraph/zoekt/cmd/zoekt-index@latest && \
    go install github.com/sourcegraph/zoekt/cmd/zoekt-webserver@latest

# Stage 2: Node.js runtime
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=zoekt-builder /go/bin/zoekt-index /usr/local/bin/
COPY --from=zoekt-builder /go/bin/zoekt-webserver /usr/local/bin/

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV DOCKER=1

EXPOSE 3847 6070

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:3847/health || exit 1

CMD ["node", "src/service/index.js"]
