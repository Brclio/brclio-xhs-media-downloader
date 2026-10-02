FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY . .
RUN node deploy/build-web.mjs

FROM node:24-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 AUTH_STORAGE_DRIVER=sqlite AUTH_SQLITE_PATH=/app/data/accounts.sqlite
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist-web ./dist-web
COPY --from=build --chown=node:node /app/api ./api
COPY --from=build --chown=node:node /app/lib ./lib
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/scripts/migrate-account-storage.mjs ./scripts/migrate-account-storage.mjs
COPY --from=build --chown=node:node /app/deploy/build-web.mjs ./deploy/build-web.mjs
RUN mkdir -p /app/data && chown node:node /app/data && chmod 700 /app/data
USER node
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/standalone/start.mjs"]
