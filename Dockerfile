# Cumulus://Mail as a plain Node server, for the Russia copy on Yandex Cloud
# (ru.mail.cumuluscloud.app). See docs/deploy/yandex-ru.md. The US copy runs on
# Cloudflare Workers and does not use this image.
#
#   docker build -t cumulus-mail-ru .
#   docker run -p 8080:8080 --env-file ru.env cumulus-mail-ru
#
# No secret is baked into the image: every setting comes from the environment
# at run time (Serverless Container / VM env, Lockbox secrets).

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# Sign-in is on in the built client (production); the dev user exists only
# when VITE_AUTH_ENABLED=false is set at build AND no DATABASE_URL at run time.
ARG VITE_AUTH_ENABLED=true
ENV VITE_AUTH_ENABLED=${VITE_AUTH_ENABLED}
# Short commit for /api/health (passed by deploy/yandex/deploy.sh); not a secret.
ARG APP_COMMIT=""
ENV APP_COMMIT=${APP_COMMIT}
RUN npm run build:node

FROM node:22-bookworm-slim AS run
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0
COPY --from=build /app/.output ./.output
# PGLite is loaded at run time only when DATABASE_URL is unset (local smoke
# tests); production uses Postgres. Copied so that mode still works.
COPY --from=build /app/node_modules/@electric-sql ./node_modules/@electric-sql
COPY --from=build /app/migrations ./migrations
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/auth/get-session').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", ".output/server/index.mjs"]
