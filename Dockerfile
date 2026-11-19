# Use the official Playwright image — includes all Chromium system dependencies.
# Do NOT swap this for a plain node image; Chromium needs OS-level libs this image provides.
FROM mcr.microsoft.com/playwright:v1.60.0-jammy

WORKDIR /app

# Install dependencies first so Docker layer-caches them separately from source code.
COPY package*.json ./
RUN npm ci --omit=dev

# Browsers ship with the base image; its version MUST match the playwright version in
# package-lock.json (currently 1.60.0). Bump both together.

# Copy application source after deps so a code-only change doesn't re-run npm ci.
COPY src/ ./src/

ENV NODE_ENV=production
ENV PORT=4000

EXPOSE 4000

CMD ["node", "src/server.js"]
