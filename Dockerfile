# Express API only. In the Docker deployment the SPA is served by the `web`
# image (frontend/Dockerfile), so frontend/dist is absent here and the static
# handler in server.js simply has nothing to serve - nginx never routes a
# non-/api path to this container.
FROM node:22-alpine
WORKDIR /app/backend

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Audit log (backend/logs/audit.log) - mounted as a volume by docker-compose.
RUN mkdir -p logs && chown -R node:node logs
USER node

EXPOSE 8080
CMD ["node", "src/server.js"]
