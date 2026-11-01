FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install

COPY . .

RUN mkdir -p temp

ENV NODE_ENV=production

EXPOSE 3000

CMD ["npm", "start"]
