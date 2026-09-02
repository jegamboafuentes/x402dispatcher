# x402dispatcher — Cloud Run / local HTTP MCP
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json .npmrc ./
RUN npm ci --legacy-peer-deps

COPY tsconfig.json ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080
ENV DATA_DIR=/tmp/x402dispatcher-data

RUN mkdir -p /tmp/x402dispatcher-data

EXPOSE 8080

CMD ["npx", "tsx", "src/http.ts"]
