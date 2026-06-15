# ============================================
# CLIPMIND DOCKERFILE (Railway)
# ============================================

FROM node:18-bullseye

# ============================================
# INSTALL SYSTEM DEPENDENCIES
# ============================================

RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp
RUN python3 -m pip install yt-dlp

# Install ImageMagick (para watermark)
RUN apt-get update && apt-get install -y \
    imagemagick \
    && rm -rf /var/lib/apt/lists/*

# ============================================
# SETUP NODE APP
# ============================================

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application code
COPY src/ ./src/

# ============================================
# EXPOSE PORT
# ============================================

EXPOSE 8080

# ============================================
# HEALTH CHECK
# ============================================

HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

# ============================================
# START APPLICATION
# ============================================

CMD ["npm", "start"]
