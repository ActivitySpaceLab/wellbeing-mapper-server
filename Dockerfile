# Wellbeing Mapper server. Runs as the unprivileged `node` user and keeps all
# its data under /data, which docker-compose.yml mounts from ./data on the
# host so submissions survive rebuilds.
FROM node:24-alpine

WORKDIR /app

# Dependencies first, so source changes do not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./

ENV NODE_ENV=production \
    PORT=3000 \
    STORAGE_DIR=/data/received \
    PARTICIPANT_CODES_FILE=/data/participant_codes.json

RUN mkdir -p /data/received && chown -R node:node /data /app
VOLUME ["/data"]

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

CMD ["node", "server.js"]
