# --- build stage ---
FROM public.ecr.aws/docker/library/node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

# --- runtime stage ---
FROM public.ecr.aws/docker/library/node:24-alpine
ARG VERSION=dev
LABEL org.opencontainers.image.title="tokener" \
      org.opencontainers.image.description="Claude Code to Amazon Bedrock token-optimisation gateway" \
      org.opencontainers.image.vendor="archeon" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.licenses="Proprietary"
# Keep the runtime image current with security patches at build time.
RUN apk upgrade --no-cache
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY ui ./ui
COPY package.json ./
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8080
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/health || exit 1
CMD ["node", "dist/server.js"]
