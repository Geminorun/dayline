# syntax=docker/dockerfile:1
FROM node:24.19.0-bookworm-slim AS build
WORKDIR /app
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=node:node apps/api/package.json apps/api/package.json
COPY --chown=node:node apps/web/package.json apps/web/package.json
COPY --chown=node:node packages/core/package.json packages/core/package.json
COPY --chown=node:node packages/locales/package.json packages/locales/package.json
COPY --chown=node:node packages/contracts/package.json packages/contracts/package.json
COPY --chown=node:node packages/api-client/package.json packages/api-client/package.json
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm install --global pnpm@11.25.0 --strict-ssl=true && pnpm install --frozen-lockfile --prod=false
COPY --chown=node:node tsconfig.base.json ./
COPY --chown=node:node packages ./packages
COPY --chown=node:node apps/api ./apps/api
COPY --chown=node:node apps/web ./apps/web
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    pnpm db:generate && pnpm build:shared && \
    pnpm --filter @dayline/api build && pnpm --filter @dayline/web build
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    CI=true pnpm --filter @dayline/api deploy --legacy --prod /runtime-api
# The API's production dependencies include the pinned migration CLI.
# Frontend compilers, tests, source and workspace development dependencies stay in build.
FROM node:24.19.0-bookworm-slim AS runtime
WORKDIR /app
COPY --from=build --chown=node:node /runtime-api ./apps/api
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
COPY --chown=node:node scripts/deploy ./scripts/deploy
COPY --chown=node:node infra/container-entrypoint.sh ./infra/container-entrypoint.sh
ENV HOST=0.0.0.0 PORT=3000 WEB_DIST_DIR=/app/apps/web/dist NODE_USE_ENV_PROXY=1
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=6 CMD /bin/sh /app/infra/container-entrypoint.sh node -e "fetch('http://127.0.0.1:3000/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["/bin/sh", "/app/infra/container-entrypoint.sh"]
CMD ["node", "apps/api/dist/main.js"]
