# ---- build
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S aga && adduser -S aga -G aga
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY database/seed-data ./database/seed-data
USER aga
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/api/v1/health >/dev/null || exit 1
# migrations run before the API starts; seeding and the first simulation are one-off commands (see README)
CMD ["sh", "-c", "npm run db:migrate:prod && node dist/main.js"]
