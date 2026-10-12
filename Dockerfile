FROM oven/bun:1.4.2 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun --bun run build

FROM oven/bun:1.4.2
WORKDIR /app
ENV NODE_ENV=production \
    STORAGE_DIR=/data/storage \
    DATA_DIR=/data/system
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY src ./src
COPY --from=build /app/web/dist ./web/dist
# the app runs as the user bun (uid 1000) of the base image, not as root: the entrypoint hands /data to bun once
# (a volume of an older install belongs to root), then drops to bun. FC_RUN_AS_ROOT=true keeps root.
# Not /usr/local/bin/docker-entrypoint.sh: that is the base image's own.
COPY --chmod=0755 scripts/docker-entrypoint.sh /usr/local/bin/file-center-entrypoint
# everything that must survive lives under /data: uploaded files (storage) and users, settings, logs, trash (system)
RUN mkdir -p /data && chown bun:bun /data
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=2s --retries=3 \
  CMD bun -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# the launcher runs the app and restarts it onto a new version after an update from the web (and goes back if that fails)
ENTRYPOINT ["/usr/local/bin/file-center-entrypoint"]
CMD ["bun", "src/launcher.ts"]
