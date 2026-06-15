# EAgent container image
#
# Security posture (see SECURITY.md):
#   - Runs as the non-root `node` user that ships with the official image.
#   - WORKDIR /workspace doubles as EAGENT_WORKSPACE: the read/write/edit tools
#     are confined to this root and reject `../` traversal, so mount only what
#     the agent should touch here.
#   - The capability default policy is *ask* (it prompts a human before any
#     privileged tool runs). A container is non-interactive, so an unattended
#     deployment must grant authority deliberately — pass `--yolo` to the CLI
#     (fallback *allow*) or grant specific capabilities. The HTTP server front
#     end (the default CMD below) already runs with yolo enabled.
#   - In-process extensions run with full Node privileges by design; do not load
#     untrusted extensions. Pair this image with a scoped network policy and no
#     real secrets in the process environment.

# ---- Stage 1: build -------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app

# Install all deps (incl. dev) for the TypeScript build, with a reproducible
# install from the lockfile.
COPY package.json package-lock.json ./
RUN npm ci

# Compile src/ -> dist/ (tsc, per package.json "build" script).
COPY . .
RUN npm run build

# ---- Stage 2: runtime -----------------------------------------------------
FROM node:22-slim AS runtime
ENV NODE_ENV=production

WORKDIR /app

# Production deps only. The kernel's sole runtime dependency is `jiti`
# (used to load extensions as TypeScript at runtime). --ignore-scripts avoids
# running any package lifecycle scripts during install.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# Ship both the compiled output and the TypeScript sources: extensions are
# loaded from src/ via jiti at runtime, so src/ is required, not optional.
COPY --from=build /app/dist ./dist
COPY --from=build /app/src ./src

# Run unprivileged inside a confined workspace.
ENV EAGENT_WORKSPACE=/workspace
RUN mkdir -p /workspace && chown -R node:node /workspace
USER node
WORKDIR /workspace

# HTTP server front end: GET /health, POST /run. PORT defaults to 8787.
EXPOSE 8787
CMD ["node", "/app/dist/server.js"]
