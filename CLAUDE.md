# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

NEB TLC (New Evidence-Based Teaching and Learning Coach) is a single-page web app for Boston University's Institute for Excellence in Teaching & Learning. It's a chat tool that gives faculty evidence-based teaching strategy recommendations, grounded in a large embedded knowledge base and Boston University policy content.

The entire application — markup, CSS, and JavaScript — lives in one file: `index.html`. There is no build step, package manager, bundler, or test suite. It's deployed as a static file on GitHub Pages, served exactly as committed.

## Commands

There is no build/lint/test tooling in this repo — it's a single static HTML file.

- **Preview locally**: open `index.html` directly in a browser, or serve it (`python3 -m http.server` from the repo root) if you need to test file drag-and-drop or other same-origin behavior.
- **Validate the embedded `<script>` block after editing** (there's no linter, so this is the practical syntax check before committing):
  ```
  node -e "
  const fs = require('fs');
  const html = fs.readFileSync('index.html','utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  new Function(m[1]);
  console.log('script parses OK');
  "
  ```

## Architecture

### Split between this repo and the relay
The client (`index.html`) never talks to the Anthropic API directly. Every request goes to a `RELAY` constant (a val.town HTTP endpoint, defined near the top of the `<script>` block) which holds the actual API key and proxies the request through. **The relay script itself is not in this repo** — it lives on val.town, outside Claude Code's reach in a typical session (network egress to `*.web.val.run` is commonly blocked, so ask the user to paste its source if you need to re-check it).

As of the most recent check (2026-09-23), the relay is a bare pass-through: it reads `ANTHROPIC_API_KEY` from its own environment, forwards the client's JSON body **unmodified** to `https://api.anthropic.com/v1/messages` with a hardcoded `anthropic-version: 2023-06-01` header, and returns the response as-is. It does not inject or override `temperature`, `top_p`, `top_k`, a thinking-budget field, or `max_tokens` — whatever `index.html` sends is exactly what reaches the API. Since the relay isn't version-controlled here, it can change without this file knowing — don't assume this still holds without reconfirming if something about a model swap or request shape starts failing unexpectedly.

The `MODEL` constant is the single source of truth for which Claude model is called; both fetch calls (`callNEB()` for chat, `openSum()` for the summary) reference it rather than hardcoding a model string.

### System prompt assembly
There's no server-side session — `history` (the raw Anthropic messages array, sent verbatim on every call) and `displayLog` (a parallel array used only for rendering) are held in browser memory and rebuilt from scratch each session.

The system prompt is reconstructed on every call via `buildSys()`, which concatenates:
1. `buildBasePrompt(today)` — persona/tone rules, the mandatory Recommendation Format, global Behavioral Rules, the full Knowledge Base (Tiers 1–3), and the mandatory Closing Statement.
2. `buildQuickFixPrompt()` or `buildExplorePrompt()`, depending on `currentMode` — the two consultation modes have different conversation flows (Quick Fix: one strategy, minimal back-and-forth; Explore Solutions: up to two strategies, Socratic clarifying questions).
3. A `Teaching Context` block built from whatever the faculty member filled in (`teachingContext`), if anything.

`buildSumReq()` is a separate prompt (not part of `buildSys()`) sent as an extra user turn to `openSum()` to generate the printable consultation summary from the existing `history`.

### Knowledge Base conventions
The Knowledge Base inside `buildBasePrompt()` is organized into three tiers with a consistent internal convention — preserve it when adding content:
- **Tier 1 (Foundational)** — consulted for every query (learning science principles, assessment, syllabus design).
- **Tier 2 (Contextual)** — organized by topic (inclusive pedagogy/UDL, video, gamification, guided notes, experiential learning/HIPs, AI in teaching).
- **Tier 3 (BU-specific)** — institutional policies and referral information, organized into lettered subsections (A–L).

Each source block starts with a `Source:`/`Sources:` line (full citation, no DOIs — the prompt's own Behavioral Rules explicitly forbid DOIs in output), followed by an ALL-CAPS block header naming the source in-line, e.g. `SEVEN PRINCIPLES FOR GOOD PRACTICE (Chickering & Gamson, 1987):`. `**bold**` is used sparingly for key terms within bullets. When asked to add knowledge base content, insert supplied/reviewed text directly rather than re-summarizing — this content is treated as pre-vetted, citation-checked material, not something to paraphrase.

### Recommendation format is a contract with the renderer
`buildBasePrompt()` mandates a strict per-strategy output structure (Strategy Overview, Best Fit, Time Required, Complexity, Technology Support, Instructions, Educational Benefits, Equity & Inclusion Notes, References). The client's lightweight markdown renderer (`md()` / `inl()`, near the bottom of the script) pattern-matches on this exact structure — e.g. a line matching `**STRATEGY: Name**` becomes an `<h2>`, a lone `**bold**` line becomes an `<h3>`. If the prompt's format instructions change, `md()` needs matching updates or the rendered chat/summary will misformat.

### UI/mode flow
`selectMode()` drives the top-level UI state machine: hides the welcome screen, reveals the input box, sets the mode badge, and — if context hasn't been submitted yet — calls `showContextWidget()`, which shows the four-field Teaching Context widget (discipline/size/modality/level) together with the already-visible input box in one combined step (no separate "Continue" step). `send()` reads those four field values inline on first submission (before handling the typed message), builds the teaching-context summary as a synthetic user turn, sets `contextSubmitted = true`, and removes the widget — then proceeds with the actual question and the API call in the same click. `newConsult()` resets all module-level state (including `contextSubmitted`, so the widget will reappear next time) and re-renders the welcome screen's markup inline (kept in sync with the initial HTML — if you change the welcome markup, update both copies).

`goDeeper()` (wired to a "Go deeper: Explore Solutions" button that appears in the summary bar once Quick Fix has delivered a recommendation) switches `currentMode` to `'explore'` without resetting `history`/`displayLog`/`teachingContext`/`contextSubmitted` — since `buildSys()` reads `currentMode` fresh on every call, the next API call picks up the Explore Solutions system prompt while carrying the full existing conversation forward. This is the one supported way to move from Quick Fix into Explore Solutions without losing context; `newConsult()` remains the only full reset.

### Attachments
File attachments (PDF/text/image, ≤15MB) are handled entirely client-side in `handleFile()`: text files are read as raw text and appended to the user message; PDFs/images are base64-encoded and sent as Anthropic `document`/`image` content blocks alongside the text. Nothing is persisted server-side.

### Known unwired scaffold
`SK` (a `localStorage` key constant) and the header's `pChip`/`pChipTxt` "Profile" chip are defined but never read or written anywhere else in the file — this looks like a planned persistent-profile feature that was never completed. Don't assume it works; don't "fix" it without checking with the user first, since it may be intentionally dormant.
