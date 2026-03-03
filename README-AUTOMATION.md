# IMAP Email Automation System

**AI-Powered Email Management for Multi-Business Owners**

Run 11+ businesses from a single dashboard. AI agents handle emails, draft replies, and you approve with one click.

---

## Quick Start

```bash
# 1. Clone and setup
git clone https://github.com/andrejstvolo/imap-api.git
cd imap-api
cp .env.example .env

# 2. Configure your 11 business emails in config/accounts.json

# 3. Start everything
docker-compose up -d

# 4. Open dashboard
open http://localhost:3000/dashboard
```

---

## What You Get

| Feature | Description |
|---------|-------------|
| **Unified Inbox** | All 11 business emails in one place |
| **AI Drafting** | OpenClaw, Manus, Claude Code read and draft replies |
| **One-Click Approval** | Approve/Discard/Edit from dashboard or mobile |
| **Autopilot Mode** | AI handles routine emails automatically |
| **Real-Time Dashboard** | See what AI is doing live |
| **Multi-Channel Alerts** | Get notified on Discord/WhatsApp/Telegram |

---

## Configuration

### 1. Environment Variables (.env)

```env
# Security
API_KEY=your-secure-api-key-here
JWT_SECRET=your-jwt-secret-here
ENCRYPTION_KEY=your-encryption-key-here

# AI Services
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...

# Database
REDIS_PASSWORD=your-redis-password
DB_PASSWORD=your-postgres-password

# Autopilot
AUTOPILOT_ENABLED=true
AUTOPILOT_CONFIDENCE_THRESHOLD=0.85
AUTOPILOT_RATE_LIMIT=20
```

### 2. Business Accounts (config/accounts.json)

```json
{
  "accounts": [
    {
      "id": "business-01",
      "name": "My First Company",
      "imap": {
        "host": "imap.gmail.com",
        "port": 993,
        "secure": true,
        "auth": {
          "user": "company1@gmail.com",
          "pass": "app-specific-password"
        }
      },
      "smtp": {
        "host": "smtp.gmail.com",
        "port": 465,
        "secure": true,
        "auth": {
          "user": "company1@gmail.com",
          "pass": "app-specific-password"
        }
      },
      "autopilot": {
        "enabled": true,
        "confidence_threshold": 0.85,
        "auto_reply_domains": ["newsletter", "noreply"],
        "escalate_keywords": ["urgent", "contract", "invoice", "payment"]
      }
    }
  ]
}
```

---

## AI Agent Integration

I (OpenClaw) access emails via the Agent Bridge API:

```javascript
// Get pending emails
GET http://localhost:3001/api/emails/pending

// Draft a reply
POST http://localhost:3001/api/drafts/create
{
  "account": "business-01",
  "replyTo": "message-id-123",
  "content": { "tone": "professional" }
}

// Check approval status
GET http://localhost:3001/api/drafts/status
```

---

## Dashboard

| Service | URL | Purpose |
|---------|-----|---------|
| Main Dashboard | http://localhost:3000/dashboard | Real-time view |
| API Docs | http://localhost:3000/docs | Swagger UI |
| Queue Monitor | http://localhost:3003 | Bull Board |
| Metrics | http://localhost:3004 | Grafana |
| Webmail | http://localhost:8888 | SnappyMail |

---

## Notifications

I handle notifications via your existing channels:

| Priority | Event | Channel |
|----------|-------|---------|
| High | Draft waiting >30 min | WhatsApp + Telegram |
| High | Connection failure | Discord + WhatsApp |
| Medium | Daily summary (9 AM) | Telegram |
| Medium | Weekly stats | Discord |

---

## Autopilot Modes

**Conservative** — AI drafts all, you approve everything
**Moderate** — AI sends routine, drafts important
**Aggressive** — AI handles 80%, escalates only contracts/payments

---

## Services

| Service | Port | Description |
|---------|------|-------------|
| IMAP API | 3000 | Core email handling |
| Agent Bridge | 3001 | AI agent API |
| Approval Queue | 3002 | Draft management |
| Bull Board | 3003 | Queue monitoring |
| Grafana | 3004 | Metrics dashboard |
| SnappyMail | 8888 | Webmail UI |
| Redis | 6379 | Queue/cache |
| PostgreSQL | 5432 | Data persistence |

---

## License

AGPL-3.0
