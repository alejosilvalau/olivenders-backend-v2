FROM node:22.15.0-slim

WORKDIR /usr/src/app

RUN corepack enable && corepack prepare pnpm@10.6.5 --activate

COPY pnpm-lock.yaml ./
COPY package*.json ./
RUN pnpm install

COPY . .

RUN pnpm run build

EXPOSE 3000

CMD ["pnpm", "run", "start:dev"]
