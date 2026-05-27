#!/usr/bin/env node
// NEB TLC Knowledge Base Ingestion Pipeline
//
// Reads all active documents from knowledge-base/manifest.json, splits each
// document into chunks at H2 (##) section boundaries, embeds each chunk with
// Voyage AI, and upserts the embeddings and source citations into Supabase.
//
// Run this script whenever you add or update knowledge base documents.
//
// PREREQUISITES
//   node >= 18 (uses built-in fetch)
//   npm install gray-matter @supabase/supabase-js dotenv
//   Run scripts/schema.sql in Supabase first
//
// USAGE
//   node scripts/ingest.js
//
// ENVIRONMENT VARIABLES (create a .env file in the project root)
//   VOYAGE_API_KEY       — Voyage AI API key (voyageai.com)
//   SUPABASE_URL         — https://yourproject.supabase.co
//   SUPABASE_SERVICE_KEY — Service role key (Settings > API in Supabase dashboard)

'use strict';

const fs   = require('fs');
const path = require('path');

try { require('dotenv').config(); } catch {}

const VOYAGE_EMBED_URL = 'https://api.voyageai.com/v1/embeddings';
const VOYAGE_MODEL     = 'voyage-3';
const KB_ROOT          = path.join(__dirname, '..', 'knowledge-base');
const MANIFEST_PATH    = path.join(KB_ROOT, 'manifest.json');

// Pause between Voyage AI calls to stay within rate limits (free tier: 300 RPM)
const EMBED_DELAY_MS = 300;

async function main() {
  const voyageKey   = process.env.VOYAGE_API_KEY;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  if (!voyageKey || !supabaseUrl || !supabaseKey) {
    console.error(
      '\nMissing environment variables. Required:\n' +
      '  VOYAGE_API_KEY\n  SUPABASE_URL\n  SUPABASE_SERVICE_KEY\n\n' +
      'See SETUP.md for instructions.\n'
    );
    process.exit(1);
  }

  const { createClient } = await import('@supabase/supabase-js');
  const matter           = (await import('gray-matter')).default;

  const supabase = createClient(supabaseUrl, supabaseKey);

  const { error: pingErr } = await supabase.from('knowledge_chunks').select('id').limit(1);
  if (pingErr) {
    console.error('\nCannot reach Supabase table "knowledge_chunks".');
    console.error('Make sure you have run scripts/schema.sql first.\n');
    console.error('Supabase error:', pingErr.message);
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const docs = manifest.documents.filter(d => d.status === 'active');
  console.log(`\nNEB TLC Ingestion — ${docs.length} active documents\n`);

  let totalChunks = 0;
  let totalErrors = 0;

  for (const doc of docs) {
    const filePath = path.join(KB_ROOT, doc.path);

    if (!fs.existsSync(filePath)) {
      console.warn(`[SKIP] Not found: ${doc.path}`);
      continue;
    }

    const raw    = fs.readFileSync(filePath, 'utf8');
    const parsed = matter(raw);
    const fm     = parsed.data;
    const chunks = splitIntoChunks(parsed.content, fm.title || doc.id);

    console.log(`${doc.id}  (${chunks.length} chunks)`);

    // Determine the primary source citation and URL for this document.
    // If the document has one source, every chunk uses it.
    // If it has multiple sources, chunks use a per-section source if tagged,
    // or fall back to listing all sources.
    const primaryCitation = buildPrimaryCitation(fm.sources);
    const primaryUrl      = buildPrimaryUrl(fm.sources);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      process.stdout.write(`  [${i + 1}/${chunks.length}] ${chunk.heading} … `);

      try {
        const embedding = await embedText(chunk.text, voyageKey);

        // Use section-level source if tagged in the heading, else document-level
        const sourceCitation = chunk.sourceCitation || primaryCitation;
        const sourceUrl      = chunk.sourceUrl      || primaryUrl;

        const { error } = await supabase
          .from('knowledge_chunks')
          .upsert(
            {
              document_id:     doc.id,
              chunk_index:     i,
              tier:            doc.tier  ?? fm.tier,
              topic:           doc.topic ?? fm.topic,
              heading:         chunk.heading,
              content:         chunk.text,
              source_citation: sourceCitation,
              source_url:      sourceUrl      || null,
              locator:         chunk.locator  || null,
              embedding,
              metadata: {
                title:        fm.title,
                tags:         fm.tags         || [],
                sources:      fm.sources      || [],
                last_updated: fm.last_updated,
                path:         doc.path
              }
            },
            { onConflict: 'document_id,chunk_index' }
          );

        if (error) {
          console.log('ERROR');
          console.error('    ', error.message);
          totalErrors++;
        } else {
          console.log('ok');
          totalChunks++;
        }
      } catch (err) {
        console.log('ERROR');
        console.error('    ', err.message);
        totalErrors++;
      }

      await sleep(EMBED_DELAY_MS);
    }
  }

  console.log(`\nDone. ${totalChunks} chunks ingested, ${totalErrors} errors.\n`);
  if (totalErrors > 0) process.exit(1);
}

// Split markdown content into chunks at H2 (##) section boundaries.
// Each chunk includes the section heading and its full content.
//
// Supports optional per-section source tagging in the heading line:
//   ## Section Title  [Source: Author et al., Year]
// This allows multi-source documents to attribute each section correctly.
function splitIntoChunks(content, docTitle) {
  const lines   = content.split('\n');
  const chunks  = [];
  let heading         = docTitle;
  let sourceCitation  = null;
  let locator         = null;
  let bodyLines       = [];

  const flushChunk = () => {
    const body = bodyLines.join('\n').trim();
    if (body) {
      chunks.push({ heading, text: `${heading}\n\n${body}`, sourceCitation, locator });
    }
  };

  for (const line of lines) {
    if (line.startsWith('## ')) {
      flushChunk();
      bodyLines      = [];
      sourceCitation = null;
      locator        = null;

      // Parse optional inline source tag: ## Heading  [Source: Full citation]
      const sourceMatch = line.match(/\[Source:\s*(.+?)\]/);
      const locatorMatch = line.match(/\[Locator:\s*(.+?)\]/);
      heading        = line.replace(/^##\s+/, '').replace(/\[Source:[^\]]+\]/, '').replace(/\[Locator:[^\]]+\]/, '').trim();
      if (sourceMatch)  sourceCitation = sourceMatch[1].trim();
      if (locatorMatch) locator        = locatorMatch[1].trim();
    } else {
      bodyLines.push(line);
    }
  }
  flushChunk();

  return chunks;
}

// Build a primary citation string from the sources array in frontmatter.
// For single-source documents, returns the one citation.
// For multi-source documents, returns a semicolon-separated list of short refs.
function buildPrimaryCitation(sources) {
  if (!sources || sources.length === 0) return null;
  if (sources.length === 1) return sources[0].citation;
  return sources.map(s => s.short).join('; ');
}

// Build a primary URL from the sources array.
// Returns the URL of the first source that has one, or null.
// For multi-source documents, per-section [Source:] tags should carry their own URLs.
function buildPrimaryUrl(sources) {
  if (!sources || sources.length === 0) return null;
  const withUrl = sources.find(s => s.url);
  return withUrl ? withUrl.url : null;
}

async function embedText(text, apiKey) {
  const resp = await fetch(VOYAGE_EMBED_URL, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      input:      [text],
      model:      VOYAGE_MODEL,
      input_type: 'document'
    })
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Voyage AI ${resp.status}: ${body}`);
  }

  const data = await resp.json();
  return data.data[0].embedding;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
