FROM docker.io/library/node:26-slim AS deps
WORKDIR /app
RUN npm install --global pnpm@12.9.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM docker.io/library/node:26-slim
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY package.json ./
COPY src src
# The deployment mounts its house-agents.config.ts here; state/ lands next to it.
WORKDIR /data
USER node
ENTRYPOINT ["node", "/app/src/main.ts"]
