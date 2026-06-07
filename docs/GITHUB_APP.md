# clagentic:triage — GitHub Integration Guide

clagentic:triage can connect to GitHub two ways: a **personal access token (PAT)**
for quick local testing, or a **GitHub App** for production deployments. This
document covers both, when to use each, and the full setup for the GitHub App path.

---

## Quick comparison

| | Personal Access Token | GitHub App |
|---|---|---|
| Setup | Paste token in env var | Create app, install to org, run as app |
| Auth | One token, all repos | Short-lived installation tokens per org |
| Token rotation | Manual | Automatic (GitHub rotates; app fetches fresh) |
| Webhook secret | One secret, all repos | One secret per app installation |
| Rate limits | Per-user (5,000 req/hr) | Per-installation (15,000 req/hr) |
| Audit trail | Shows as your user | Shows as `your-app[bot]` |
| Repo scope | Any repo your user can see | Only repos the app is installed on |
| Suitable for | Dev/testing | Production, multi-org, multi-repo |

---

## Mode 1: Personal Access Token (PAT)

The simplest path. Good for a single repo, local testing, or a private org where
you control everything.

### Steps

1. Go to **GitHub → Settings → Developer settings → Personal access tokens →
   Fine-grained tokens → Generate new token**.
2. Set a name and expiry.
3. Under **Repository access**, select the repos clagentic:triage should watch.
4. Under **Permissions**, grant:

   | Permission | Level | Why |
   |---|---|---|
   | Issues | Read | List and read issues |
   | Pull requests | Read + Write | List PRs; post comments, request changes, approve, close |
   | Metadata | Read | Required by GitHub for all fine-grained tokens |
   | Contents | Read | Fetch intent file and repo context files |

   If you need to apply labels: add **Issues → Write** (already implied by Read+Write above).

5. Copy the token.
6. Set the env var:
   ```
   export CLAGENTIC_TRIAGE_GITHUB_TOKEN=github_pat_...
   ```
7. Run `clagentic-triage run` or `clagentic-triage watch`.

> **Note:** Classic tokens (`ghp_*`) work too but are broader by design — they grant
> access to all repos your account can see. Prefer fine-grained tokens scoped to the
> specific repos you intend to watch.

---

## Mode 2: GitHub App (recommended for production)

A GitHub App is the right choice when you are deploying clagentic:triage as a
service, watching multiple orgs or repos, or want the bot's actions to appear under
a named app identity rather than your personal account.

### Overview of the pieces

```
Your server running clagentic-triage
  ├── GitHub App credentials (App ID + private key)
  ├── Generates short-lived installation tokens on demand
  ├── Receives webhooks from GitHub (signed with HMAC-SHA256)
  └── Makes API calls as the app installation
```

### Step 1: Create the GitHub App

1. Go to **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**
   (or your org's settings if this is an org-owned app).

2. Fill in:
   - **GitHub App name:** e.g. `your-org-triage` (must be globally unique on GitHub)
   - **Homepage URL:** your project URL or `https://github.com/clagentic/triage`
   - **Webhook URL:** the public HTTPS URL where clagentic:triage will receive webhooks,
     e.g. `https://triage.example.com/webhook`
   - **Webhook secret:** generate a strong random string (e.g. `openssl rand -hex 32`)
     and copy it — you'll need it in config

3. Under **Permissions → Repository permissions**, set:

   | Permission | Level | Why |
   |---|---|---|
   | Issues | Read + Write | Read issues; post comments, close, label |
   | Pull requests | Read + Write | Read PRs; post comments, request changes, approve, close |
   | Contents | Read | Fetch intent file and repo context files |
   | Metadata | Read | Required by GitHub for all apps |

4. Under **Subscribe to events**, check:
   - `Issues`
   - `Issue comment`
   - `Pull request`
   - `Pull request review`
   - `Pull request review comment`

5. Set **Where can this GitHub App be installed?** to **Only on this account** (if
   single-org) or **Any account** (if you're building a multi-tenant service).

6. Click **Create GitHub App**.

### Step 2: Generate a private key

On the app's settings page, scroll to **Private keys** and click
**Generate a private key**. Download the `.pem` file. Keep it secret — it is the
credential that identifies your app.

Store it somewhere your server can read:
```
/etc/clagentic/triage/app.pem      # systemd service
~/.config/clagentic/triage/app.pem # local operator
```

Note your **App ID** from the top of the app settings page.

### Step 3: Install the app

On the app settings page, click **Install App** and install it on the org(s) or
specific repos you want clagentic:triage to watch.

Note the **Installation ID** from the URL after installing:
`https://github.com/organizations/<org>/settings/installations/<installation_id>`

### Step 4: Configure clagentic:triage for GitHub App auth

clagentic:triage has built-in GitHub App token exchange. Set three config fields (or
the corresponding env vars) and the adapter will mint a fresh installation token on
every poll cycle — no sidecar required.

**Config file (`triage.config.json`):**

```json
{
  "source": {
    "github_app_id": "123456",
    "github_app_installation_id": "78901234"
  }
}
```

**Corresponding env vars:**

```
CLAGENTIC_TRIAGE_GITHUB_APP_ID=123456
CLAGENTIC_TRIAGE_GITHUB_APP_PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----\n...
CLAGENTIC_TRIAGE_GITHUB_APP_INSTALLATION_ID=78901234
```

| Config key | Env var | Description |
|---|---|---|
| `source.github_app_id` | `CLAGENTIC_TRIAGE_GITHUB_APP_ID` | Numeric App ID shown at the top of your App's settings page |
| `source.github_app_private_key_env` | *(not mapped — see note)* | Name of the env var that holds the PEM. Default: `CLAGENTIC_TRIAGE_GITHUB_APP_PRIVATE_KEY`. Change this if you store the key under a different name. |
| `source.github_app_installation_id` | `CLAGENTIC_TRIAGE_GITHUB_APP_INSTALLATION_ID` | Numeric installation ID from the installation URL |

> **Note on the private key:** the PEM is never stored on the config object. Only the
> *name* of the env var is stored (`github_app_private_key_env`). The adapter reads the
> PEM from `process.env[github_app_private_key_env]` at mint time. Set the env var
> whose name is in `github_app_private_key_env` to the full PEM contents (newlines as
> `\n` or literal, depending on your deployment method).

When `github_app_id` is set, the PAT (`CLAGENTIC_TRIAGE_GITHUB_TOKEN`) is ignored.
Use one or the other — not both.

### Step 5: Configure webhooks

Set the env vars or config fields for the webhook server:

```json
{
  "webhooks": {
    "enabled": true,
    "port": 8742,
    "secret": "the-secret-you-generated-in-step-1"
  }
}
```

```
export CLAGENTIC_TRIAGE_WEBHOOK_SECRET=the-secret-you-generated-in-step-1
```

The webhook server binds to `127.0.0.1` by default. Put it behind a reverse proxy
(nginx, Caddy, Cloudflare Tunnel) that terminates TLS and forwards to the local port.
GitHub requires HTTPS for webhook delivery.

### Step 6: Verify

```bash
clagentic-triage watch
```

Open an issue in a watched repo from an external account. You should see:
1. A webhook delivery arrive (check GitHub → App settings → Advanced → Recent deliveries)
2. `[triage]` log output showing the event processed
3. A new entry in `.triage/pending.jsonl`

---

## Reverse proxy setup (webhook ingress)

The webhook server must be reachable at a public HTTPS URL. Minimal nginx config:

```nginx
server {
    listen 443 ssl;
    server_name triage.example.com;

    ssl_certificate     /etc/ssl/triage.example.com.crt;
    ssl_certificate_key /etc/ssl/triage.example.com.key;

    location /webhook {
        proxy_pass http://127.0.0.1:8742/webhook;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

Caddy equivalent:
```
triage.example.com {
    reverse_proxy /webhook 127.0.0.1:8742
}
```

GitHub does not support self-signed certificates for webhook delivery. Use Let's
Encrypt, a Cloudflare-proxied origin, or Cloudflare Tunnel for local development.

---

## Security notes

- **Never commit the private key.** Add `*.pem` to `.gitignore`. If you expose it,
  revoke it immediately on the GitHub App settings page.
- **Rotate the webhook secret** if you ever suspect it was leaked. Update both
  GitHub's app settings and your `CLAGENTIC_TRIAGE_WEBHOOK_SECRET` env var
  simultaneously; a brief gap during rotation may cause webhook delivery failures.
- **Scope the app narrowly.** Install on specific repos rather than the entire org
  when possible. A compromised installation token grants write access to everything
  it is installed on.
- **Bind the webhook server to localhost.** The default `127.0.0.1` bind is
  intentional — only the reverse proxy should reach it. Never set `bind: "0.0.0.0"`
  unless you fully understand the network exposure.
