# Agentra MailSense

> AI-powered agentic email automation — classifies, archives, and auto-replies to your Gmail using a local LLM (Ollama).

---

## Project Structure

```
agentra-mailsense/
├── backend/
│   ├── server.js              ← Express entry point  (port 3000)
│   ├── db.js                  ← SQLite schema + prepared statements
│   ├── gmail.js               ← Google OAuth2 + Gmail API helpers
│   ├── mailer.js              ← Nodemailer OTP sender
│   ├── ollama.js              ← Ollama classify + reply generation
│   ├── middleware/
│   │   └── auth.js            ← JWT sign + requireAuth middleware
│   ├── routes/
│   │   ├── auth.js            ← /api/login, signup-*, forgot-*
│   │   └── gmail.js           ← /api/gmail-*, /api/oauth2callback
│   ├── package.json
│   ├── .env.example           ← Copy → .env and fill in values
│   └── .gitignore
└── public/
    ├── index.html             ← Sign-in / Sign-up page
    └── dashboard.html         ← React dashboard (served at /dashboard.html)
```

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | ≥ 18 | https://nodejs.org |
| Ollama | latest | https://ollama.ai |
| Git | any | https://git-scm.com |

---

## Step 1 — Clone / create the project

```bash
# If you received this as a zip, just extract it.
# Otherwise clone your repo:
git clone <your-repo-url>
cd agentra-mailsense
```

---

## Step 2 — Install dependencies

```bash
cd backend
npm install
```

---

## Step 3 — Configure environment variables

```bash
# Inside backend/
cp .env.example .env
```

Now open `backend/.env` and fill in every value:

```
PORT=3000
NODE_ENV=development

# 1. Generate a strong random string (e.g. openssl rand -hex 32)
JWT_SECRET=your_jwt_secret_here

# 2. Google OAuth2 — see "Google Cloud Setup" section below
GOOGLE_CLIENT_ID=your_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your_secret
GOOGLE_REDIRECT_URI=http://localhost:3000/api/oauth2callback
APP_URL=http://localhost:3000

# 3. SMTP for OTP emails — Gmail App Password recommended
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=youremail@gmail.com
SMTP_PASS=your_gmail_app_password
SMTP_FROM=Agentra MailSense <youremail@gmail.com>

# 4. Ollama (local LLM)
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=llama3

# 5. SQLite file path
DB_PATH=./mailsense.db
```

---

## Step 4 — Google Cloud Setup (Gmail OAuth2)

1. Go to https://console.cloud.google.com
2. Create a new project (e.g. "Agentra MailSense")
3. **Enable APIs**: search for "Gmail API" → Enable it
4. **OAuth Consent Screen**:
   - User type: External
   - App name: Agentra MailSense
   - Add scopes: `gmail.readonly`, `gmail.send`, `gmail.modify`, `mail.google.com`
   - Add your email as a **Test User**
5. **Credentials** → Create → OAuth 2.0 Client ID
   - Application type: Web application
   - Authorized redirect URIs: `http://localhost:3000/api/oauth2callback`
6. Copy **Client ID** and **Client Secret** into your `.env`

> For production, add your production domain to the redirect URIs and update `GOOGLE_REDIRECT_URI` and `APP_URL`.

---

## Step 5 — Set up Gmail App Password (for OTP sending)

1. Go to https://myaccount.google.com/security
2. Enable **2-Step Verification** if not already on
3. Search for "App passwords" → create one for "Mail"
4. Paste the 16-character password into `SMTP_PASS` in your `.env`

> **Dev tip:** If you skip SMTP setup, the server will print the OTP in the API response body (`dev_otp` field) so you can still test signup/forgot-password without email.

---

## Step 6 — Install and start Ollama (local LLM)

```bash
# Install Ollama from https://ollama.ai
# Then pull a model:
ollama pull llama3        # ~4.7GB, recommended
# OR lighter alternative:
ollama pull mistral       # ~4.1GB
# OR tiny/fast:
ollama pull phi3:mini     # ~2.2GB

# Start Ollama (it usually auto-starts, but to be sure):
ollama serve
```

> **No Ollama?** The app works without it. It automatically falls back to rule-based classification (keyword matching). You won't need Ollama running for basic functionality.

---

## Step 7 — Run the server

```bash
# Inside backend/
npm run dev        # Development (auto-restart with nodemon)
# OR
npm start          # Production
```

You should see:
```
  ╔══════════════════════════════════════════╗
  ║   Agentra MailSense  –  Server Running   ║
  ║   http://localhost:3000                  ║
  ╚══════════════════════════════════════════╝

  ▸ Frontend    : http://localhost:3000/
  ▸ Dashboard   : http://localhost:3000/dashboard.html
  ▸ Health      : http://localhost:3000/api/health
```

---

## Step 8 — Open in browser

| Page | URL |
|------|-----|
| Sign in / Sign up | http://localhost:3000 |
| Dashboard | http://localhost:3000/dashboard.html |
| Health check | http://localhost:3000/api/health |

---

## Full User Flow

```
1. Open http://localhost:3000
2. Click "Create account" → fill details → verify OTP email
3. Sign in → Onboarding screen: choose Fast Mode or Safe Mode
4. Dashboard loads → click "Gmail" in sidebar
5. Click "Connect with Google" → Google OAuth consent screen
6. Authorize → redirected back to dashboard (Gmail now connected)
7. Click "Fetch Emails" → emails fetched and classified by AI
8. Click "Run Agent" → auto-replies sent (Fast) or drafts saved (Safe)
9. Use category views (Spam, Promotions, Important) to review
10. Select emails → Move to Bin to delete
```

---

## API Reference

### Auth

| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| POST | `/api/signup-send-otp` | `{first_name, last_name, email, password}` | Register + send OTP |
| POST | `/api/signup-verify-otp` | `{email, otp}` | Verify OTP → create account |
| POST | `/api/login` | `{email, password}` | Login → returns JWT |
| POST | `/api/forgot-send-otp` | `{email}` | Send reset OTP |
| POST | `/api/forgot-verify-otp` | `{email, otp}` | Verify reset OTP |
| POST | `/api/forgot-reset-password` | `{email, password}` | Set new password |
| POST | `/api/delete-account` | `{email}` | Delete account + all data |

### Gmail

| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| GET | `/api/gmail-auth?email=xxx` | — | Redirect to Google OAuth |
| GET | `/api/oauth2callback` | — | OAuth callback (Google redirects here) |
| POST | `/api/gmail-status` | `{email}` | Get connection status + emails + stats |
| POST | `/api/gmail-fetch` | `{email, maxEmails}` | Fetch + classify emails |
| POST | `/api/gmail-reply` | `{userEmail, emailId, mode, replyTemplate}` | Send reply or save draft |
| POST | `/api/gmail-action` | `{userEmail, emailIds, action}` | `trash` or `archive` |
| POST | `/api/gmail-disconnect` | `{email}` | Revoke Gmail access |

---

## Common Errors & Fixes

### `Error: Cannot find module 'better-sqlite3'`
```bash
cd backend && npm install
```

### `EAUTH: Invalid login` (SMTP error)
- Make sure you're using a **Gmail App Password**, not your regular password
- Confirm 2FA is enabled on the Gmail account
- Check `SMTP_USER` and `SMTP_PASS` in `.env`

### `redirect_uri_mismatch` (Google OAuth error)
- In Google Cloud Console → Credentials → your OAuth client
- Add exactly: `http://localhost:3000/api/oauth2callback` to Authorized redirect URIs
- Make sure `GOOGLE_REDIRECT_URI` in `.env` matches exactly

### `Error: invalid_grant` (OAuth token error)
- Tokens have expired. User needs to disconnect and reconnect Gmail
- Or your system clock is out of sync — sync it with NTP

### `Ollama connection refused`
- Start Ollama: `ollama serve`
- Verify: `curl http://localhost:11434/api/tags`
- The app will fall back to rule-based classification automatically

### White screen on dashboard
- Open browser DevTools → Console
- Usually means not logged in → you'll be redirected to `/`
- Or `sessionStorage` was cleared → log in again

### `SQLITE_BUSY` error
- Another process has the DB locked
- Stop all server instances and restart: `npm run dev`

---

## Deployment

### Backend → Render.com (free tier)

1. Push `backend/` folder to a GitHub repo
2. Go to https://render.com → New → Web Service
3. Connect your GitHub repo
4. Settings:
   - **Build command**: `npm install`
   - **Start command**: `node server.js`
   - **Node version**: 18
5. Add all `.env` variables under **Environment**
6. Update `GOOGLE_REDIRECT_URI` to `https://your-app.onrender.com/api/oauth2callback`
7. Update `APP_URL` to `https://your-app.onrender.com`
8. In Google Cloud Console, add the new redirect URI

> For SQLite on Render: use a persistent disk or switch to PostgreSQL with `pg` + `better-sqlite3` replacement.

### Alternative Backend → Railway.app

```bash
# Install Railway CLI
npm i -g @railway/cli
railway login
cd backend
railway init
railway up
railway variables set PORT=3000 JWT_SECRET=xxx ...
```

### Frontend
The frontend (`public/`) is served by the same Express server.
There's **no separate frontend deployment** needed — it's all one server.

---

## Architecture Notes

- **No separate React build step** — the dashboard uses React UMD + Babel standalone loaded from CDN. This means zero build tooling, instant development.
- **SQLite** stores users, tokens, emails, logs, and stats. For production scale, swap in PostgreSQL.
- **Ollama** runs locally on your machine. The server calls `localhost:11434`. For cloud deployment, you'd need a GPU server running Ollama, or replace with OpenAI/Groq API.
- **JWT** tokens are stored in `sessionStorage` (cleared on tab close). For persistent login, move to `localStorage` or httpOnly cookies.

---

## Week 1 Execution Plan (as requested)

| Day | Task |
|-----|------|
| 1 | Set up project, install dependencies, configure `.env`, test `/api/health` |
| 2 | Configure Google Cloud OAuth, test Gmail connect flow end-to-end |
| 3 | Install Ollama + pull model, test email classification endpoint |
| 4 | Test full signup → login → connect Gmail → fetch → classify flow |
| 5 | Test Fast Mode (auto-send) and Safe Mode (draft) replies |
| 6 | Test bulk delete, category filters, agent logs |
| 7 | Deploy to Render, update OAuth redirect URIs, smoke test production |
