# IMAP API — Deployment Guide for Plesk (imap-api.gr8cloud.com)

## Overview

This is a customised fork of the original IMAP API, extended with:

- **`POST /v1/account/{account}/draft`** — Save a composed email as a draft directly to the IMAP Drafts folder (visible in Outlook, Thunderbird, any IMAP client)
- **`GET /v1/inbox`** — Unified inbox: returns latest emails from **all registered accounts** combined, sorted by date
- **API Key Authentication** — Protect the API with a Bearer token; set `API_KEY` environment variable

---

## Prerequisites on Plesk Server

1. **Node.js** — already enabled on `imap-api.gr8cloud.com` (v25.7.0) ✅
2. **Redis** — must be installed on the server

### Install Redis on Plesk (run via SSH):
```bash
sudo apt-get update && sudo apt-get install -y redis-server
sudo systemctl enable redis-server
sudo systemctl start redis-server
# Verify:
redis-cli ping   # should return PONG
```

---

## Deployment Steps

### 1. Connect GitHub repo to Plesk via Git

In Plesk → `imap-api.gr8cloud.com` → Git:
- Repository URL: `https://github.com/andrejstvolo/imap-api.git`
- Branch: `main`
- Deploy path: `/imap-api.gr8cloud.com`
- Click **Pull** to deploy

### 2. Install dependencies via Plesk Node.js panel

In Plesk → `imap-api.gr8cloud.com` → Node.js:
- Click **NPM install** button
- This runs `npm install --production`

### 3. Set environment variables

In Plesk → `imap-api.gr8cloud.com` → Node.js → **Custom environment variables**:

| Variable | Value |
|---|---|
| `API_KEY` | Your secret key (e.g. `openssl rand -hex 32`) |
| `NODE_ENV` | `production` |

### 4. Set startup file

In Plesk → Node.js settings:
- **Application Startup File**: `app.js`

### 5. Restart the app

Click **Restart App** in Plesk Node.js panel.

---

## Verify Deployment

Visit `http://imap-api.gr8cloud.com/` — you should see the IMAP API dashboard.

API docs: `http://imap-api.gr8cloud.com/docs`

---

## Register Your 12 Email Accounts

Run this once per account (replace values):

```bash
curl -X POST http://imap-api.gr8cloud.com/v1/account \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "account": "videosportas-info",
    "name": "info@videosportas.lt",
    "imap": {
      "host": "mail.videosportas.lt",
      "port": 993,
      "secure": true,
      "auth": {
        "user": "info@videosportas.lt",
        "pass": "YOUR_PASSWORD"
      }
    },
    "smtp": {
      "host": "mail.videosportas.lt",
      "port": 465,
      "secure": true,
      "auth": {
        "user": "info@videosportas.lt",
        "pass": "YOUR_PASSWORD"
      }
    }
  }'
```

Repeat for all 12 accounts with these IDs:

| Account ID | Email |
|---|---|
| `arenahd` | `andrej@arenahd.tv` |
| `arenamedia` | `info@arenamediagroup.eu` |
| `homebyalex` | `hi@homebyalex.lt` |
| `videosportas-info` | `info@videosportas.lt` |
| `videosportas-andrius` | `andrius@videosportas.lt` |
| `idarbinkveja` | `info@idarbinkveja.lt` |
| `taikos98` | `info@taikos98.lt` |
| `zeroscore` | `info@zeroscore.app` |
| `antvisko` | `info@antvisko.lt` |
| `sventesiranga` | `info@sventesiranga.lt` |
| `huddleos` | `info@huddleos.app` |
| `colorwall` | `info@colorwall.app` |

---

## API Reference (Custom Endpoints)

### Save Draft
```
POST /v1/account/{accountId}/draft
Authorization: Bearer YOUR_API_KEY
Content-Type: application/json

{
  "from": { "name": "Info Videosportas", "address": "info@videosportas.lt" },
  "to": [{ "address": "client@example.com" }],
  "subject": "Re: Your inquiry",
  "text": "Hello,\n\nThank you for reaching out.",
  "html": "<p>Hello,</p><p>Thank you for reaching out.</p>"
}
```
→ Draft appears in Outlook / any IMAP client Drafts folder immediately.

### Unified Inbox (all accounts)
```
GET /v1/inbox?pageSize=10
Authorization: Bearer YOUR_API_KEY
```
→ Returns latest emails from all 12 accounts combined, sorted by date.

### Send Email
```
POST /v1/account/{accountId}/submit
Authorization: Bearer YOUR_API_KEY
Content-Type: application/json

{
  "from": { "address": "info@videosportas.lt" },
  "to": [{ "address": "client@example.com" }],
  "subject": "Hello",
  "text": "Message body"
}
```

### List Emails
```
GET /v1/account/{accountId}/messages?path=INBOX&page=0
Authorization: Bearer YOUR_API_KEY
```

---

## AI Agent Integration

Any AI agent (Manus, Claude Code, Kimi Claw) can access all 12 inboxes via:

```
Base URL: http://imap-api.gr8cloud.com
Auth:     Authorization: Bearer YOUR_API_KEY
```

Share the API key with each agent. They can then:
- Read emails from any account
- Save drafts for your review
- Send emails from the correct address
- Access the unified inbox across all businesses
