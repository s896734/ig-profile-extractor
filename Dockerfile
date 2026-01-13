FROM mcr.microsoft.com/playwright:v1.57.0-jammy

WORKDIR /app
COPY package.json /app/package.json
RUN npm install --omit=dev
COPY server.js /app/server.js

ENV NODE_ENV=production

CMD ["npm", "run", "start"]
