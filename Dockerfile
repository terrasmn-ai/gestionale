FROM node:22-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY web web
RUN npm -w web run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production WEB_DIR=/app/web/dist
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --workspace=server --include-workspace-root=false
COPY server server
COPY db db
COPY --from=web /app/web/dist web/dist
WORKDIR /app/server
EXPOSE 3000
CMD ["npx", "tsx", "src/index.ts"]
