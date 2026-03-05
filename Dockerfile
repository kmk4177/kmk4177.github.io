# Deploy anywhere with Docker (Render/Fly/VPS)
FROM node:20-alpine

WORKDIR /app
COPY package*.json ./

# Use npm install (not npm ci) because repo may not include a lockfile.
RUN npm install --omit=dev --no-audit --no-fund

COPY . .
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000
CMD ["node", "server.js"]
