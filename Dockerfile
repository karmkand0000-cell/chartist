FROM node:22-alpine
WORKDIR /app
COPY server/package*.json server/
RUN cd server && npm ci --omit=dev
COPY server server
COPY shared shared
COPY web web
ENV NODE_ENV=production PORT=8080 PGLITE_DIR=/data/pgdata
VOLUME /data
EXPOSE 8080
USER node
CMD ["node", "server/src/server.js"]
