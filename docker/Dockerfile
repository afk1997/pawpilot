# The helpline's one image, built on the VM by docker/docker-compose.yml (see docs/runbooks/deploy.md):
#   app     `node server.js`, the Next.js standalone server (the default command)
#   worker  `node --import tsx src/server/worker/index.ts`: `npm run worker`'s command, run without npm, whose
#           `sh -c` would swallow the SIGTERM of a graceful stop (docker-compose.yml)
# The same image also runs `npm run migrate` and `npm run ingest:ambulances`.
# Everything runs as the unprivileged `node` user. The only path it writes is the worker's Claude home,
# /home/node/claude-home (LLM_HOME_DIR), which the compose file mounts as a named volume.

# --- build: every dependency, then `next build` ----------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# The runtime stage copies `public`; the repo has none yet.
RUN mkdir -p public && npm run build

# --- runtime: production dependencies only ---------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
# CA certificates for outbound TLS (Claude, Interakt).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    LLM_HOME_DIR=/home/node/claude-home
WORKDIR /app
COPY package.json package-lock.json ./
# The worker runs its TypeScript through tsx, unbundled: the Agent SDK stays a real package on disk, since it spawns
# the Claude CLI binary from its platform package. npm installs both Linux builds of that binary; the SDK picks the
# glibc one on this Debian image, so the musl one is removed.
RUN npm ci --omit=dev --no-audit --no-fund \
 && rm -rf node_modules/@anthropic-ai/claude-agent-sdk-linux-*-musl \
 && npm cache clean --force
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
# The app: the standalone server and its build output, with the static assets beside them. It resolves `next` and the
# other packages from the production node_modules above, so the standalone output's traced copy is not needed.
COPY --from=build /app/.next/standalone/server.js ./server.js
COPY --from=build /app/.next/standalone/.next ./.next
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# An empty named volume mounted on the Claude home takes this owner and mode. Next.js may write its cache.
RUN install -d -o node -g node -m 700 /home/node/claude-home \
 && install -d -o node -g node .next/cache
USER node
EXPOSE 3000
CMD ["node", "server.js"]
