FROM mcr.microsoft.com/playwright:v1.47.2-jammy

WORKDIR /app
COPY package.json /app/package.json
RUN npm install --omit=dev
COPY server.js /app/server.js

ENV NODE_ENV=production
ENV PORT=3000

CMD ["npm", "run", "start"]
