FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg imagemagick git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p temp

ENV NODE_ENV=production

EXPOSE 3000

CMD ["npm", "run", "start:baileys"]
