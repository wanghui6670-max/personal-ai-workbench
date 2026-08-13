FROM node:22-alpine
RUN apk add --no-cache git
WORKDIR /app

COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node scripts ./scripts

# Runtime state is initialized by the app in /data. Keep it outside the image.
RUN mkdir -p /data /workspace \
    && chown -R node:node /data /workspace

ENV HOST=0.0.0.0 PORT=4173 DATA_DIR=/data WORKSPACE_ROOT=/workspace
VOLUME ["/data", "/workspace"]
EXPOSE 4173

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT || 4173}/api/health`).then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"]

CMD ["node", "src/server.mjs"]
