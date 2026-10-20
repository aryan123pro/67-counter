# 67 Counter — Node server for Fly.io (serves the game + API; data in Neon Postgres)
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public
USER node
EXPOSE 8080
CMD ["node", "server/index.js"]
