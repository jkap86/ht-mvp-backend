# Development Port Assignments

## Services

| Service | Port | Configurable | Notes |
|---------|------|--------------|-------|
| Backend API | 5000 | `PORT` env var | Express + Socket.IO |
| Frontend (Flutter Web) | 3000 | Flutter CLI | Dev server only |
| PostgreSQL | 5432 | `DATABASE_URL` | Default Postgres port |

## Backend Configuration

```bash
# .env
PORT=5000
DATABASE_URL=postgresql://user:pass@localhost:5432/hypetrain
FRONTEND_URL=http://localhost:3000
```

## CORS Configuration

The backend allows requests from:
- `FRONTEND_URL` environment variable
- Credentials included for cookie/token handling

## Socket.IO

- Runs on same port as API (5000)
- Path: `/socket.io`
- CORS matches Express configuration

## Production

In production, typically:
- API runs behind reverse proxy (nginx/Cloudflare)
- Frontend served as static files or separate CDN
- Database on managed service (Supabase, RDS, etc.)
