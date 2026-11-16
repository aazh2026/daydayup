# ---- 构建阶段：构建前端产物 ----
FROM node:24-alpine AS builder

WORKDIR /app

# 先复制依赖清单（利用层缓存）
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/server/package.json packages/server/
COPY web/package.json web/

RUN npm ci --legacy-peer-deps

COPY . .

RUN npm run build --workspace=@daydayup/web

# ---- 运行阶段 ----
#
# Node 24 原生支持 TypeScript 类型剥离（--experimental-strip-types），
# 因此**服务端无需编译步骤**，直接运行 .ts 源码。
# 代码已全部避免使用参数属性等 strip-only 模式不支持的语法。
FROM node:24-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

# 生产依赖（server + contracts）
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/server/package.json packages/server/

RUN npm ci --legacy-peer-deps --omit=dev --workspace=@daydayup/server --workspace=@daydayup/contracts \
    && npm cache clean --force

COPY --from=builder /app/packages/server/src packages/server/src
COPY --from=builder /app/packages/server/data packages/server/data
COPY --from=builder /app/packages/contracts/src packages/contracts/src
COPY --from=builder /app/web/dist web/dist

# 数据目录（运行时可写）
VOLUME ["/app/packages/server/data", "/app/packages/server/backups"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 原生类型剥离运行 TS，无需编译
CMD ["node", "--experimental-strip-types", "packages/server/src/main.ts"]
