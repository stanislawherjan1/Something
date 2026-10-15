FROM node:20-alpine
WORKDIR /app
COPY package.json ./
# TODO: no package-lock.json yet; add one and switch to `npm ci --omit=dev`
# (deploy.sh already ships the lockfile once it exists).
RUN npm install --production
COPY index.js whitelist.js ./
EXPOSE 3002
CMD ["node", "index.js"]
