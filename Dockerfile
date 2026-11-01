FROM node:20-bookworm-slim

ENV NODE_ENV=production
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY src ./src
RUN chown -R node:node /app
USER node

EXPOSE 3000
CMD ["npm", "start"]
