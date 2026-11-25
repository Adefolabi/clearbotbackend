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

## Tests

```bash
npm test
```

Uses Node's built-in test runner (no extra dependencies). Mongo, Paystack and the Playwright bot are
stubbed in `test/helpers.js`, so tests need no database, network or browser. Covered: `/api/assessment/start`
(validation, payment gate, locking, capacity, failure paths) and `/api/payment/*` (initiate, status,
webhook signature and amount checks, admin recover).

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
| `campus` | string | yes | `"Iwo Campus"` or `"Ogbomosho Campus"` |
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

## Deploying to Railway

Railway builds directly from the `Dockerfile` (Chromium's system dependencies come from the
base image, no extra install step) and `railway.json` configures the build and health check.

1. Push this repository to GitHub.
2. In Railway, **New Project → Deploy from GitHub repo** → select this repo.
   Railway detects `railway.json` and the `Dockerfile` automatically; no build/start command
   needed.
3. Set **Variables** (Railway dashboard → your service → Variables tab):
   - `NODE_ENV` → `production`
   - `MONGODB_URI` → your Atlas connection string
   - `FRONTEND_URL` → your deployed frontend URL
   - `PAYSTACK_SECRET_KEY` → your Paystack secret key (required in production — `/start`
     refuses requests with a 503 if this is unset while `NODE_ENV=production`)
   - `ADMIN_SECRET` → a long random string, used by the admin `/api/payment/recover` endpoint
   - `CURRENT_SEMESTER` → e.g. `2026_2027_1st`. Change it each semester; see below.
   - Do **not** set `PORT` — Railway injects its own and the app already reads `process.env.PORT`.
4. Under **Settings → Networking**, generate a public domain and confirm the health check path
   shows `/api/health` (already set via `railway.json`).
5. Pick an instance size with **at least 1 GB RAM**: headless Chromium crashes below that.
6. Under **Settings → Deploy**, enable **Wait for CI** so a failing run of the GitHub Actions
   tests (`.github/workflows/ci.yml`) blocks the deploy. Railway auto-deploys on every push to
   the connected branch; this repo has no deploy workflow of its own.
7. After the first deploy, check the logs for `Active semester: …`, then hit the API from your
   frontend and confirm rate limiting works per user. If every user shares one limit, set
   `TRUST_PROXY_HOPS` to the number of proxies in front of the app (default `1`).

### Changing semester

Payments are tracked per student per semester, so a paid student stays "paid" until the
semester value changes. At the start of each semester, update `CURRENT_SEMESTER` in Railway
(format `YYYY_YYYY_1st` or `YYYY_YYYY_2nd`) and redeploy. A malformed value stops the server
from starting. If the variable is unset, the semester is derived from today's date
(Aug–Jan = 1st, Feb–Jul = 2nd).

### Free testers

Matric numbers on the free-tester list skip payment: `/api/payment/initiate` returns
`{ alreadyPaid: true }` (the frontend goes straight to the rating screen) and `/start` skips the
payment check. Testers are stored in MongoDB, so adding or removing one takes effect immediately,
with no redeploy. All admin calls need the `X-Admin-Secret` header set to `ADMIN_SECRET`.

```bash
API=https://<your-backend-domain>
# add
curl -X POST "$API/api/admin/testers" -H "X-Admin-Secret: $ADMIN_SECRET" \
     -H "Content-Type: application/json" -d '{"matricNumber":"BU22CSC1081","note":"owner"}'
# list
curl "$API/api/admin/testers" -H "X-Admin-Secret: $ADMIN_SECRET"
# remove
curl -X DELETE "$API/api/admin/testers/BU22CSC1081" -H "X-Admin-Secret: $ADMIN_SECRET"
```

`FREE_MATRICS` (comma-separated env var) also grants free access and works even if the database
is down. Changing it needs a redeploy. If the database lookup fails, the student is treated as
not free, so an outage never gives away free runs.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | no | Server port (default: `4000`). Render/Railway inject their own — do not set this yourself on those platforms. |
| `CURRENT_SEMESTER` | recommended | Active semester, e.g. `2026_2027_1st`. Falls back to a date-based value if unset. Malformed values stop startup. |
| `TRUST_PROXY_HOPS` | no | Number of reverse proxies in front of the app (default `1`). Controls how the client IP is read for rate limiting. |
| `NODE_ENV` | no | `development` or `production`. In `production`, `/start` requires `PAYSTACK_SECRET_KEY` to be set and fails closed (503) otherwise. |
| `FRONTEND_URL` | yes (prod) | Frontend origin for CORS (e.g. `https://clearbot.vercel.app`) |
| `MONGODB_URI` | yes | MongoDB Atlas connection string |
| `PAYSTACK_SECRET_KEY` | yes (prod) | Paystack secret key — gates payment verification on `/start` and `/payment/*` |
| `ADMIN_SECRET` | yes (for admin endpoints) | Shared secret for `/api/payment/recover` and `/api/admin/testers`. Use a long random value; it is compared with a timing-safe check. Admin endpoints are disabled when unset. |
| `PAYMENTS_PAUSED` | no | Set to `true` to make every run free (no Paystack step). Remove it or set `false` to turn payment back on. Keep `PAYSTACK_SECRET_KEY` set either way. |
| `FREE_MATRICS` | no | Comma-separated matric numbers that skip payment (fallback to the database tester list — see "Free testers"). |
