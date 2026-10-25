# images by digest as well as tag: a tag can be moved to other content, a digest can not (Dependabot keeps both current)
FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun --bun run build

# the runtime stage is the -slim variant: same Debian packages the app needs (setpriv, chown, stat, awk for the entrypoint),
# about 70 MB less to ship and to scan. Distroless was not used: the entrypoint needs a shell for its one-time chown + setpriv.
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4
# Debian's security updates that came out after the base image was made (the image scan in CI found 17 HIGH/CRITICAL
# fixed ones in perl-base, pcre2, sqlite, openssl and gzip). APT_UPGRADE=false only for machines with no Debian mirror.
ARG APT_UPGRADE=true
RUN if [ "$APT_UPGRADE" = "true" ]; then \
      apt-get update && apt-get upgrade -y --no-install-recommends && apt-get clean && rm -rf /var/lib/apt/lists/*; \
    fi
# Thumbnails (src/thumbs.ts): libvips-tools for pictures, poppler-utils for the first page of a PDF, a font for PDF text that
# is not embedded, and ffmpeg for a frame of a video. They are system tools, not part of the app bundle, so a web update does
# not bring them: after updating from the web run "docker compose up -d --build" once to get them. Without them the file
# list just shows icons. ffmpeg is the heavy one (about 350 MB installed): THUMB_VIDEO=false leaves it out (no video
# thumbnails). THUMB_TOOLS=false leaves out everything, only for machines with no Debian mirror (same reason as APT_UPGRADE).
ARG THUMB_TOOLS=true
ARG THUMB_VIDEO=true
RUN pkgs=""; \
    if [ "$THUMB_TOOLS" = "true" ]; then pkgs="libvips-tools poppler-utils fonts-dejavu-core"; \
      if [ "$THUMB_VIDEO" = "true" ]; then pkgs="$pkgs ffmpeg"; fi; fi; \
    if [ -n "$pkgs" ]; then \
      apt-get update && apt-get install -y --no-install-recommends $pkgs && apt-get clean && rm -rf /var/lib/apt/lists/*; \
    fi
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
