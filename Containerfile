ARG TARGETARCH

FROM docker.io/library/node:26.10.0-trixie-slim@sha256:930557a230abacbc3f4fd9b8648abf8f4bee1e17cb72195dcdfb2f709bc85b33 AS deps
WORKDIR /app
# pnpm 12.9.0, the tarball npm lists with integrity sha512-j2TvoLeS…roMN3Q==.
ADD --checksum=sha256:48e02088b3ac17900b57400918ea400dfe4e35fc3fb98ebd723e769efa06cb8c \
	https://registry.npmjs.org/pnpm/-/pnpm-12.9.0.tgz /tmp/pnpm.tgz
RUN npm install --global /tmp/pnpm.tgz
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

# Lightpanda 1.0.0, a headless browser for MCP servers the deployment starts
# with `lightpanda mcp`.
FROM docker.io/library/node:26.10.0-trixie-slim@sha256:930557a230abacbc3f4fd9b8648abf8f4bee1e17cb72195dcdfb2f709bc85b33 AS lightpanda-amd64
ADD --checksum=sha256:aa5a4b8ed53d1e38b3c73f5b2647d0a84a82e6744557f45f9a9c85858aa031c3 \
	https://github.com/lightpanda-io/browser/releases/download/1.0.0/lightpanda-x86_64-linux /lightpanda

FROM docker.io/library/node:26.10.0-trixie-slim@sha256:930557a230abacbc3f4fd9b8648abf8f4bee1e17cb72195dcdfb2f709bc85b33 AS lightpanda-arm64
ADD --checksum=sha256:69791924bcee43b13b224af4c845622c5fe66fdbc1b8143bfaa39ca8f85244f5 \
	https://github.com/lightpanda-io/browser/releases/download/1.0.0/lightpanda-aarch64-linux /lightpanda

# Without its debug info it is 40% of the size. It reads the CA certificates
# from the system's bundle.
FROM lightpanda-${TARGETARCH} AS lightpanda
RUN apt-get update && apt-get install --yes --no-install-recommends binutils ca-certificates \
	&& strip /lightpanda && chmod 0755 /lightpanda

FROM docker.io/library/node:26.10.0-trixie-slim@sha256:930557a230abacbc3f4fd9b8648abf8f4bee1e17cb72195dcdfb2f709bc85b33
COPY --from=lightpanda /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=lightpanda /lightpanda /usr/local/bin/
ENV LIGHTPANDA_DISABLE_TELEMETRY=true
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY package.json ./
COPY src src
# The deployment mounts its house-agents.config.ts here; state/ lands next to it.
WORKDIR /data
RUN mkdir state && chown node:node state
USER node
ENTRYPOINT ["node", "/app/src/main.ts"]
