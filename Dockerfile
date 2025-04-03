FROM node:20-alpine AS builder

WORKDIR /app

# Copy only the essential files (package.json, package-lock.json, tsconfig, and source)
COPY package.json package-lock.json /app/
COPY tsconfig.json /app/
COPY index.ts /app/

# Install dependencies
RUN npm ci

# Build the code
RUN npx tsc --project tsconfig.json && chmod +x /app/index.js || true

FROM node:20-alpine AS release

WORKDIR /app

# Copy built files from builder
COPY --from=builder /app/package.json /app/package-lock.json /app/
COPY --from=builder /app/index.js /app/index.js

# We'll install only production deps
RUN npm ci --omit=dev

ENV NODE_ENV=production
ENV AWS_REGION=us-west-2

ENTRYPOINT ["node", "/app/index.js"]
