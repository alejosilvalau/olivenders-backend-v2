FROM node:20-slim

WORKDIR /usr/src/app

RUN corepack enable
RUN npm install --global corepack@latest
RUN corepack prepare pnpm@latest --activate

COPY pnpm-lock.yaml ./
COPY package*.json ./
RUN pnpm install

COPY . .
RUN npm run build

EXPOSE 3000

CMD ["pnpm", "start"]
