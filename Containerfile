FROM docker.io/library/node:26-slim@sha256:930557a230abacbc3f4fd9b8648abf8f4bee1e17cb72195dcdfb2f709bc85b33 AS deps
WORKDIR /app
# pnpm 12.9.1, the tarball npm lists with integrity sha512-BrBV//XN…wNbQ==.
ADD --checksum=sha256:44c80447645c2a1d8da9308d3efedcec6ca2db4579183abcb15d8a90a88277d4 \
	https://registry.npmjs.org/pnpm/-/pnpm-12.9.1.tgz /tmp/pnpm.tgz
RUN npm install --global /tmp/pnpm.tgz
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM docker.io/library/node:26-slim@sha256:930557a230abacbc3f4fd9b8648abf8f4bee1e17cb72195dcdfb2f709bc85b33
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY package.json ./
COPY src src
# The deployment mounts its house-agents.config.ts here; state/ lands next to it.
WORKDIR /data
USER node
ENTRYPOINT ["node", "/app/src/main.ts"]
