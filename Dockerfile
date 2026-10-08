FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json ./
RUN bun install
COPY . .
RUN bun --bun run build

FROM oven/bun:1
WORKDIR /app
ENV NODE_ENV=production \
    STORAGE_DIR=/data/storage \
    DATA_DIR=/data/system
COPY package.json ./
RUN bun install --production
COPY src ./src
COPY --from=build /app/web/dist ./web/dist
# everything that must survive lives under /data: uploaded files (storage) and users, settings, logs, trash (system)
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD bun -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "src/index.ts"]
