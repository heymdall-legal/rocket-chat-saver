FROM node:22-alpine
RUN apk add --no-cache git
WORKDIR /app
COPY package.json index.js ./
CMD ["node", "index.js", "/config/config.json"]
