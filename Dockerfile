FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY server ./server
COPY scripts ./scripts
COPY public ./public
ENV NODE_ENV=production PORT=8080 GAME_MODE=live
RUN mkdir -p /app/data && chown -R node:node /app
USER node
VOLUME /app/data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server.js"]
