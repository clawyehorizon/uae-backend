# =========================================
# Dockerfile — eHorizon Business Setup Backend
# =========================================
# Production image: Node 20 + Puppeteer (Chromium)
#
# Build:   docker build -t ehorizon-biz-setup-backend .
# Run:     docker run -p 3000:3000 --env-file .env ehorizon-biz-setup-backend
# Size:    ~800MB (Chromium is the bulk)
#
# Multi-stage build not used because Puppeteer needs
# Chromium in the final image anyway.

FROM node:20-slim

# =========================================
# System dependencies for Puppeteer/Chromium
# =========================================
# These are required for headless Chrome to run in Docker.
# See: https://pptr.dev/troubleshooting#running-puppeteer-in-docker

RUN apt-get update && apt-get install -y --no-install-recommends \
    # Chromium dependencies
    ca-certificates \
    fonts-liberation \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    wget \
    xdg-utils \
    # Additional fonts for professional PDF rendering
    fonts-noto \
    fonts-noto-cjk \
    fonts-freefont-ttf \
    # Process management
    dumb-init \
    && rm -rf /var/lib/apt/lists/*

# =========================================
# App setup
# =========================================

# Create app directory
WORKDIR /app

# Create a non-root user for security
RUN groupadd -r appuser && useradd -r -g appuser -G audio,video appuser \
    && mkdir -p /home/appuser/Downloads \
    && chown -R appuser:appuser /home/appuser \
    && chown -R appuser:appuser /app

# Copy package files first (better Docker layer caching)
COPY --chown=appuser:appuser package.json package-lock.json* ./

# Install production dependencies only
RUN npm ci --omit=dev --ignore-scripts \
    && npx puppeteer install chromium \
    && npm cache clean --force

# Copy application code
COPY --chown=appuser:appuser . .

# =========================================
# Data and templates directories
# =========================================

# Copy pricing database and templates from parent directories
# These should be mounted or copied during CI/CD
# For now, create placeholder directories
RUN mkdir -p /app/data /app/templates

# =========================================
# Environment
# =========================================

# Run as non-root user
USER appuser

# Puppeteer cache directory
ENV PUPPETEER_CACHE_DIR=/home/appuser/.cache/puppeteer

# Node environment
ENV NODE_ENV=production

# Expose API port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1

# =========================================
# Start
# =========================================

# Use dumb-init to handle PID 1 signal forwarding
# (ensures graceful shutdown of Puppeteer browser)
ENTRYPOINT ["dumb-init", "--"]

CMD ["node", "server.js"]
