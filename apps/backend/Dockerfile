# apps/backend/Dockerfile — multi-stage pnpm build for sivi-whatsapp-hub's backend.
#
# Build context is the REPO ROOT (pnpm workspace), not this directory — e.g.:
#   docker build -f apps/backend/Dockerfile -t sivi-whatsapp-hub-backend:corte1 .
#
# Migrations are a SEPARATE command (`pnpm migrate`, src/db/migrate.ts) — this
# image only serves the API + the in-process outbox drain loop (main.ts). Run
# migrations against the target database before starting a container from this
# image (see the repo's CLAUDE.md).
#
# Stages:
#   deps      — install the FULL workspace, including devDependencies (pnpm needs
#               every package.json to resolve the lockfile, even for packages this
#               image doesn't ship, e.g. apps/web). Used ONLY to build — never
#               copied into the runner.
#   build     — compile @sivihub/contracts (a workspace dependency of the backend)
#               then the backend itself, using deps' full node_modules (tsc, etc).
#   prod-deps — a SEPARATE, clean `pnpm install --prod` scoped to just the backend
#               + its workspace dependency (@sivihub/contracts), via
#               `--filter "<pkg>..."`. This is what the runner's node_modules come
#               from — NOT the deps/build stage's node_modules, which carries
#               vitest, typescript, drizzle-kit, @testcontainers/postgresql, etc.
#               (`pnpm deploy` was considered instead, but pnpm's default pack-list
#               follows .gitignore in the absence of a "files" field/.npmignore,
#               and dist/ is gitignored here — deploy would silently ship an image
#               missing dist/. A clean `--prod` install stage has no such trap.)
#   runner    — copies ONLY what's needed to run: compiled dist/ (from build),
#               package.json (from build), and the prod-only, Linux-native
#               node_modules produced by prod-deps (never the host's — see
#               .dockerignore). Runs as a non-root user.

# ---------------------------------------------------------------------------
# base
# ---------------------------------------------------------------------------
FROM node:22-alpine AS base
# packageManager in the root package.json pins the exact pnpm version.
RUN corepack enable
WORKDIR /repo

# ---------------------------------------------------------------------------
# deps — install the whole workspace (needs every package.json for the lockfile)
# ---------------------------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# build — compile the workspace dependency first, then the backend
# ---------------------------------------------------------------------------
FROM deps AS build
COPY . .
RUN pnpm --filter @sivihub/contracts build
RUN pnpm --filter @sivihub/whatsapp-hub-backend build

# ---------------------------------------------------------------------------
# prod-deps — clean, PRODUCTION-ONLY install for the backend + its workspace dep.
# `--filter "<pkg>..."` selects the package AND its workspace dependencies
# (here: @sivihub/contracts) without pulling in apps/web. `--prod` (no --legacy
# needed on pnpm 10) skips devDependencies entirely.
# ---------------------------------------------------------------------------
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --prod --frozen-lockfile --filter "@sivihub/whatsapp-hub-backend..."

# ---------------------------------------------------------------------------
# runner — minimal runtime image, non-root, production dependencies ONLY
# ---------------------------------------------------------------------------
FROM base AS runner
ENV NODE_ENV=production
RUN addgroup -S sivihub && adduser -S sivihub -G sivihub

# Mirror the repo's relative layout so pnpm's symlinked node_modules
# (apps/backend/node_modules/@sivihub/contracts -> ../../../packages/contracts)
# keep resolving correctly. node_modules come from prod-deps (prod-only); dist/
# and package.json come from build (the compiled output).
COPY --from=prod-deps /repo/node_modules ./node_modules
COPY --from=prod-deps /repo/apps/backend/node_modules ./apps/backend/node_modules
COPY --from=build /repo/apps/backend/package.json ./apps/backend/package.json
COPY --from=build /repo/apps/backend/dist ./apps/backend/dist
COPY --from=prod-deps /repo/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=build /repo/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build /repo/packages/contracts/dist ./packages/contracts/dist

WORKDIR /repo/apps/backend
USER sivihub

EXPOSE 3001

CMD ["node", "dist/main.js"]
