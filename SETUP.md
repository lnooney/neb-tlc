# NEB TLC v2 — Setup Guide

This guide is for the BU technology team deploying NEB TLC v2. It covers first-time setup of the RAG (Retrieval-Augmented Generation) pipeline that powers the expanded knowledge base.

**Time required:** approximately 1–2 hours for initial setup.

---

## Architecture Overview

```
v2/index.html  →  api/relay.js (Val.town)  →  Claude API (Anthropic)
                       ↓
                  Voyage AI (embeddings)
                       ↓
                  Supabase (pgvector knowledge base)
```

When a faculty member sends a message:
1. The relay embeds the query using Voyage AI
2. The relay searches Supabase for the most relevant knowledge base chunks
3. The relay builds a system prompt with the retrieved content and calls Claude
4. Claude's response is returned to the browser

---

## Accounts and Credentials

You need four credentials. Three are new; one (Anthropic) you already have.

| Credential | Service | Where to get it |
|---|---|---|
| `ANTHROPIC_API_KEY` | Anthropic (Claude) | Already in use — copy from the existing Val.town relay |
| `VOYAGE_API_KEY` | Voyage AI | voyageai.com → sign up → API Keys |
| `SUPABASE_URL` | Supabase | Your project → Settings → API → Project URL |
| `SUPABASE_ANON_KEY` | Supabase | Your project → Settings → API → anon / public key |
| `SUPABASE_SERVICE_KEY` | Supabase | Your project → Settings → API → service_role key |

`SUPABASE_SERVICE_KEY` is only used by the local ingestion script. The relay uses `SUPABASE_ANON_KEY`.

---

## Step 1 — Create a Supabase Project

1. Go to [supabase.com](https://supabase.com) and sign in (or create a free account).
2. Click **New project**.
3. Choose your organization, give the project a name (e.g. `neb-tlc`), set a database password, and select a region close to Boston (e.g. US East).
4. Wait for the project to finish provisioning (~2 minutes).
5. Go to **Settings → API** and copy:
   - **Project URL** → this is `SUPABASE_URL`
   - **anon / public** key → this is `SUPABASE_ANON_KEY`
   - **service_role** key → this is `SUPABASE_SERVICE_KEY` (keep this secret — it bypasses row-level security)

---

## Step 2 — Create the Database Table

1. In your Supabase project, go to **SQL Editor** (left sidebar).
2. Click **New query**.
3. Open `scripts/schema.sql` from this repository and paste the entire contents into the editor.
4. Click **Run** (or press Cmd/Ctrl + Enter).
5. Verify success: go to **Table Editor** and confirm a table named `knowledge_chunks` now exists.

---

## Step 3 — Get a Voyage AI API Key

1. Go to [voyageai.com](https://voyageai.com) and create an account.
2. Navigate to **API Keys** and create a new key.
3. Copy the key — this is `VOYAGE_API_KEY`.

The free tier includes 50 million tokens per month, which is more than sufficient for this pilot. The full knowledge base ingestion uses approximately 50,000 tokens total.

---

## Step 4 — Run the Ingestion Script

The ingestion script reads every document in `knowledge-base/`, splits each one into chunks at section boundaries, embeds each chunk with Voyage AI, and stores the embeddings in Supabase.

**Prerequisites:** Node.js 18 or later installed on your machine.

### Install dependencies

From the project root:

```bash
npm install gray-matter @supabase/supabase-js dotenv
```

### Create a .env file

Create a file named `.env` in the project root (this file is gitignored — do not commit it):

```
VOYAGE_API_KEY=your_voyage_key_here
SUPABASE_URL=https://yourproject.supabase.co
SUPABASE_SERVICE_KEY=your_service_role_key_here
```

### Run the script

```bash
node scripts/ingest.js
```

You will see output like:

```
NEB TLC Ingestion — 9 active documents

learning-science-foundations  (7 chunks)
  [1/7] Principle 1 — Prior Knowledge … ok
  [2/7] Principle 2 — Knowledge Organization … ok
  ...

Done. 52 chunks ingested, 0 errors.
```

**Re-running is safe** — the script uses upsert, so running it again updates existing chunks rather than creating duplicates. Run it any time you add or update knowledge base documents.

---

## Step 5 — Deploy the Relay to Val.town

1. Go to [val.town](https://val.town) and sign in to the account that hosts the existing NEB TLC relay.
2. Create a **new HTTP val**:
   - Click **New val** → choose **HTTP**
   - Give it a name, e.g. `nebtlc_v2_relay`
3. Open `api/relay.js` from this repository and paste the entire contents into the val editor.
4. Click **Save**.

### Set environment variables in Val.town

In Val.town, go to **Settings → Environment Variables** and add:

| Key | Value |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `VOYAGE_API_KEY` | Your Voyage AI API key |
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_ANON_KEY` | Your Supabase anon/public key |
| `LIBRARY_PROXY_URL` | BU EZProxy prefix: `https://ezproxy.bu.edu/login?url=` — source URLs in recommendations will be wrapped with this so faculty reach authenticated full-text access. Omit to use raw DOI URLs instead. |

5. Note the URL of your new val — it will look like `https://yourname--nebtlc_v2_relay.web.val.run`.

---

## Step 6 — Update the Relay URL in v2/index.html

Open `v2/index.html` and find line 330:

```javascript
// v2 relay — update this URL once the RAG-enabled relay (api/relay.js) is deployed
const RELAY = 'https://lnooney--b59323963f5711f1a86342b51c65c3df.web.val.run';
```

Replace the URL with your new Val.town relay URL:

```javascript
const RELAY = 'https://yourname--nebtlc_v2_relay.web.val.run';
```

Commit and push this change.

---

## Step 7 — Test the App

1. Open `v2/index.html` in a browser (or deploy it to your hosting).
2. Select **Quick Fix**, fill in a teaching context, and ask a question.
3. Verify that NEB TLC responds with evidence-based recommendations and proper citations.
4. Check your Val.town val logs for any errors.

If you see a "trouble connecting" error in the app, check:
- Val.town environment variables are all set correctly
- The `knowledge_chunks` table has rows (check Table Editor in Supabase)
- The Supabase `match_chunks` function exists (check Database → Functions in Supabase)

---

## Adding New Knowledge Base Documents

To expand the knowledge base with new research:

### 1. Create a new markdown file

Follow this template and save the file in `knowledge-base/tier1-foundational/` or `knowledge-base/tier2-contextual/` depending on whether the content is foundational (always retrieved) or contextual (retrieved by relevance):

```markdown
---
id: your-document-id
title: "Full Document Title"
tier: 2
topic: topic-slug
sources:
  - citation: "Author, A. (Year). Title. Journal, vol(issue), pages."
    short: "Author, Year"
    type: journal-article
tags:
  - tag1
  - tag2
last_updated: "YYYY-MM"
status: active
---

# Full Document Title

## Section One Heading

Content for this section. Each H2 section (## heading) becomes one retrieval chunk.
Write the content so each section can stand alone — it will be retrieved independently.

## Section Two Heading

Content for section two.
```

### 2. Add it to the manifest

Open `knowledge-base/manifest.json` and add an entry to the `documents` array:

```json
{
  "id": "your-document-id",
  "path": "tier2-contextual/your-document-id.md",
  "tier": 2,
  "topic": "topic-slug",
  "status": "active"
}
```

### 3. Re-run the ingestion script

```bash
node scripts/ingest.js
```

The new document's chunks will be embedded and added to Supabase. No relay changes needed.

---

## File Reference

| File | Purpose |
|---|---|
| `index.html` | v1 app — unchanged, remains fully functional |
| `v2/index.html` | v2 app — uses RAG relay once deployed |
| `knowledge-base/manifest.json` | Registry of all knowledge base documents |
| `knowledge-base/tier1-foundational/` | Foundational documents (always retrieved) |
| `knowledge-base/tier2-contextual/` | Contextual documents (retrieved by relevance) |
| `scripts/schema.sql` | Supabase database schema — run once |
| `scripts/ingest.js` | Ingestion pipeline — run after adding/updating documents |
| `api/relay.js` | Val.town relay with RAG — replace current relay |

---

## Questions and Support

For questions about this setup, contact the IETL team: [excellence@bu.edu](mailto:excellence@bu.edu)
