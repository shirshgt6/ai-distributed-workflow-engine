# One image, three roles (chosen by the command):
#   node src/server.js               API
#   node src/worker.js               worker (queue + scheduler + outbox relay + reconciler)
#   node src/consumers/analytics.js  Kafka analytics consumer
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# Dependencies first: this layer is cached until package*.json changes.
# --ignore-scripts: no install scripts from dependencies run during the build.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY src ./src
COPY scripts ./scripts

# Never run as root inside the container.
USER node
EXPOSE 4000
CMD ["node", "src/server.js"]
