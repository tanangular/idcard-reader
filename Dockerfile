# Vercel Container runtime builds this file on linux/amd64.
# Bun 1.4.4 is pinned to match the local toolchain and bun.lock.

FROM oven/bun:1.4.4 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.4 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1.4.4 AS runtime
WORKDIR /app

# Vercel routes to port 80 by default. HOST must be 0.0.0.0 inside a
# container; the local default stays 127.0.0.1. SQLite lives in /tmp because
# the container filesystem is ephemeral.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=80 \
    AUDIT_DB=/tmp/idcard-audit.db

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY src/server ./src/server
COPY src/shared ./src/shared

EXPOSE 80
CMD ["bun", "src/server/main.ts"]
