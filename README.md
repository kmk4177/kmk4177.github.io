# realtime-balls (deploy-ready)

## Run locally
```bash
npm install
npm start
```
Then open: http://localhost:3000

## Deploy (single service)
This app serves both frontend (public/) and Socket.IO backend from the same origin.

### Deploy with Docker (recommended for many platforms)
Build & run:
```bash
docker build -t realtime-balls .
docker run -p 3000:3000 realtime-balls
```

### Platform notes
- The server listens on `process.env.PORT` (required by most hosts).
- Optional CORS allow-list: set `ALLOWED_ORIGINS` as a comma-separated list if you host the frontend separately.
  Example:
  `ALLOWED_ORIGINS=https://username.github.io`
- Health check endpoint: `/healthz`
