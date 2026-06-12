# docloom — 브라우저 데모(정적) + HTTP API(server.mjs)를 한 포트(8002)에서 제공.
#
#  - 빌드 산출물(dist=tsc, demo 번들=esbuild)을 이미지에 굽는다(라이브러리라 변경이 잦지 않음).
#  - 런타임에는 prod 의존성 + 산출물만 둔다(devDeps 제외해 이미지 축소).

# 1) build: 전체 의존성 설치 후 dist + demo 번들 생성
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm run demo:build

# 2) runtime: prod 의존성 + 산출물만
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=8002
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/demo ./demo
COPY --from=build /app/server.mjs ./server.mjs
EXPOSE 8002
# server.mjs: GET → demo 정적, POST /preview·/encode·/decode → API
CMD ["node", "server.mjs"]
