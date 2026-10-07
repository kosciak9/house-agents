FROM docker.io/library/node:26.10.0-alpine@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80 AS deps
WORKDIR /app
# pnpm 12.9.0, the tarball npm lists with integrity sha512-j2TvoLeS…roMN3Q==.
ADD --checksum=sha256:48e02088b3ac17900b57400918ea400dfe4e35fc3fb98ebd723e769efa06cb8c \
	https://registry.npmjs.org/pnpm/-/pnpm-12.9.0.tgz /tmp/pnpm.tgz
RUN npm install --global /tmp/pnpm.tgz
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM docker.io/library/node:26.10.0-alpine@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY package.json ./
COPY src src
# The deployment mounts its house-agents.config.ts here; state/ lands next to it.
WORKDIR /data
RUN mkdir state && chown node:node state
USER node
ENTRYPOINT ["node", "/app/src/main.ts"]
