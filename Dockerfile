# syntax=docker/dockerfile:1.7
# Debian (glibc), not Alpine: DuckDB ships prebuilt glibc binaries.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build
# Simulate ACCOUNT_USAGE, run the SQL suite and cache the result, so the container starts
# in about a second. The build fails here if any reconciliation check fails.
RUN npm run warehouse:build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4000 \
    DEMO_MODE=true
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/api/package.json ./apps/api/
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/sql ./sql
COPY --from=build --chown=node:node /app/data ./data
RUN mkdir -p data/runtime && chown -R node:node data
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "apps/api/dist/server.js"]
