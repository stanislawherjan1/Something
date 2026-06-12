FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY index.js whitelist.js ./
EXPOSE 3002
CMD ["node", "index.js"]
