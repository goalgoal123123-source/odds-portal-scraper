# Playwright official image: Node 20 + Chromium preinstalled (matches playwright 1.55.x)
FROM mcr.microsoft.com/playwright:v1.55.0-jammy

WORKDIR /app

# Install deps first for better layer caching
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Copy the app (server.js wrapper + scraper lib)
COPY . .

ENV NODE_ENV=production \
    LOG_LEVEL=info

# Render injects $PORT (default 10000); server.js reads it
EXPOSE 10000

CMD ["node", "server.js"]
