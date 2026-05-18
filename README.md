# CLEARBOT Backend

CLEARBOT is a paid automation service that completes Bowen University's mandatory lecturer assessment forms on behalf of students via the SSHUB student portal. This backend receives student credentials, launches a headless Playwright browser, fills every pending assessment form, and streams real-time progress to the frontend using Server-Sent Events (SSE).

---

## Local Setup

```bash
# 1. Clone the repository
git clone <repo-url>
cd clearbot-backend

# 2. Install dependencies
npm install

# 3. Install the Playwright Chromium browser binary
npx playwright install chromium --with-deps

# 4. Configure environment variables
cp .env.example .env
# Edit .env with your MongoDB URI and frontend URL

# 5. Start the development server (auto-restarts on file changes)
npm run dev
```

---

## API Endpoints

### `POST /api/assessment/start`

Queues a new assessment job. Returns immediately with a `jobId` — the actual browser automation runs in the background.

**Request body:**
```json
{
  "matricNumber": "BU22CSC1081",
  "password":     "studentpassword",
  "campus":       "Iwo Campus",
  "defaultRating": 3,
  "perCourseRatings": {
    "CSC 406": 4,
    "CSC 401": 2
  }
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `matricNumber` | string | yes | Pattern: 2 letters + 2 digits + 3 letters + 4 digits |
| `password` | string | yes | Min 4 characters |
| `campus` | string | yes | `"Iwo Campus"` or `"Abuja Campus"` |
| `defaultRating` | integer | yes | 0–4 (0=Not available, 1=Poor, 2=Average, 3=Good, 4=Excellent) |
| `perCourseRatings` | object | no | Override rating per course code |

**Success response `200`:**
```json
{ "jobId": "550e8400-e29b-41d4-a716-446655440000" }
```

**Validation error `400`:**
```json
{ "error": "Validation failed", "details": ["matricNumber must match..."] }
```

---

### `GET /api/assessment/progress/:jobId`

Server-Sent Events stream. Connect immediately after calling `/start` and listen for progress events.

**Example events:**

```
data: {"type":"log","message":"✅ Login successful","status":"success","timestamp":"..."}

data: {"type":"progress","completed":3,"total":17,"skipped":1}

data: {"type":"log","message":"✅ CSC 406 — all assessments done","status":"complete","courseCode":"CSC 406","timestamp":"..."}

data: {"type":"complete","summary":{"completed":14,"skipped":3,"failed":0},"timestamp":"..."}

data: {"type":"error","message":"Login failed — check your credentials","fatal":true,"timestamp":"..."}
```

| Event type | When emitted |
|---|---|
| `log` | Every meaningful step (login, course done, skip) |
| `progress` | After each course is processed |
| `complete` | When all courses are finished — close the EventSource here |
| `error` | On fatal failures — close the EventSource here |

---

### `GET /api/health`

Returns server and database status. Used by Render health checks.

```json
{
  "status": "ok",
  "db":     "connected",
  "uptime": 3600,
  "ts":     "2025-01-01T00:00:00.000Z"
}
```

---

## How the SSE Stream Works

1. Your frontend calls `POST /api/assessment/start` and receives a `jobId`.
2. It immediately opens an `EventSource` to `GET /api/assessment/progress/:jobId`.
3. The backend streams events as the bot works through each course.
4. On `type: "complete"` or a fatal `type: "error"`, the frontend calls `eventSource.close()`.
5. If the user's tab reloads or the connection drops, `EventSource` reconnects automatically. The backend replays all past events from the beginning so the frontend can rebuild its state.

```javascript
const eventSource = new EventSource(`${API_URL}/api/assessment/progress/${jobId}`);

eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);

  if (data.type === 'log')                  addLogEntry(data);
  if (data.type === 'progress')             updateProgressBar(data.completed, data.total);
  if (data.type === 'complete')           { showCompletionScreen(data.summary); eventSource.close(); }
  if (data.type === 'error' && data.fatal){ showErrorScreen(data.message);      eventSource.close(); }
};
```

---

## Running with Docker (local)

```bash
# Build the image
docker build -t clearbot-backend .

# Run with your .env file mounted
docker run --env-file .env -p 4000:4000 clearbot-backend
```

---

## Deploying to Render

1. Push this repository to GitHub.
2. In Render, create a new **Web Service** → connect your GitHub repo.
3. Set **Build Command:** `npm ci`
4. Set **Start Command:** `node src/server.js`
5. Set **Environment Variables** (Render dashboard → Environment tab):
   - `PORT` → `4000` (Render overrides this automatically)
   - `NODE_ENV` → `production`
   - `MONGODB_URI` → your Atlas connection string
   - `FRONTEND_URL` → your deployed frontend URL
6. Under **Advanced**, add a health check path: `/api/health`

> **Docker on Render:** If you use the Docker deployment method instead, Render will build and run the `Dockerfile` automatically. This is recommended because it includes Playwright's Chromium dependencies.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | no | Server port (default: `4000`) |
| `NODE_ENV` | no | `development` or `production` |
| `FRONTEND_URL` | yes (prod) | Frontend origin for CORS (e.g. `https://clearbot.vercel.app`) |
| `MONGODB_URI` | yes | MongoDB Atlas connection string |
| `PAYSTACK_SECRET_KEY` | Phase 2 | Not active yet |
| `PAYSTACK_PUBLIC_KEY` | Phase 2 | Not active yet |
