#!/usr/bin/env node
// NEB TLC Knowledge Base Ingestion Pipeline
//
// Reads all active documents from knowledge-base/manifest.json, splits each
// document into chunks at H2 (##) section boundaries, embeds each chunk with
// Voyage AI, and upserts the embeddings into Supabase pgvector.
//
// Run this script whenever you add or update knowledge base documents.
//
// PREREQUISITES
//   node >= 18 (uses built-in fetch)
//   npm install gray-matter @supabase/supabase-js
//   Run scripts/schema.sql in Supabase first
//
// USAGE
//   node scripts/ingest.js
//
// ENVIRONMENT VARIABLES (create a .env file in the project root, or set these
// in your shell — see SETUP.md for where to get each value)
//   VOYAGE_API_KEY       — Voyage AI API key (voyageai.com)
//   SUPABASE_URL         — https://yourproject.supabase.co
//   SUPABASE_SERVICE_KEY — Service role key (Settings > API in Supabase dashboard)
//                          Use the service key, not the anon key — ingest needs write access

'use strict';

const fs   = require('fs');
const path = require('path');

// Load .env file if present (install dotenv with: npm install dotenv)
try { require('dotenv').config(); } catch {}

const VOYAGE_EMBED_URL = 'https://api.voyageai.com/v1/embeddings';
const VOYAGE_MODEL     = 'voyage-3';
const KB_ROOT          = path.join(__dirname, '..', 'knowledge-base');
const MANIFEST_PATH    = path.join(KB_ROOT, 'manifest.json');

// Pause between Voyage AI calls to stay within rate limits
// Free tier: 300 requests/min. 300ms delay = ~200 RPM with headroom.
const EMBED_DELAY_MS = 300;

async function main() {
  const voyageKey    = process.env.VOYAGE_API_KEY;
  const supabaseUrl  = process.env.SUPABASE_URL;
  const supabaseKey  = process.env.SUPABASE_SERVICE_KEY;

  if (!voyageKey || !supabaseUrl || !supabaseKey) {
    console.error(
      '\nMissing environment variables. Required:\n' +
      '  VOYAGE_API_KEY\n  SUPABASE_URL\n  SUPABASE_SERVICE_KEY\n\n' +
      'See SETUP.md for instructions.\n'
    );
    process.exit(1);
  }

  // Dynamic import for ESM-only packages
  const { createClient } = await import('@supabase/supabase-js');
  const matter           = (await import('gray-matter')).default;

  const supabase = createClient(supabaseUrl, supabaseKey);

  // Verify Supabase connection
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

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      process.stdout.write(`  [${i + 1}/${chunks.length}] ${chunk.heading} … `);

      try {
        const embedding = await embedText(chunk.text, voyageKey);

        const { error } = await supabase
          .from('knowledge_chunks')
          .upsert(
            {
              document_id: doc.id,
              chunk_index: i,
              tier:        doc.tier  ?? fm.tier,
              topic:       doc.topic ?? fm.topic,
              heading:     chunk.heading,
              content:     chunk.text,
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
// Each chunk includes the section heading and its content as a single text block.
// The document title is prepended so each chunk is self-contained for retrieval.
function splitIntoChunks(content, docTitle) {
  const lines   = content.split('\n');
  const chunks  = [];
  let heading   = docTitle;
  let bodyLines = [];

  const flushChunk = () => {
    const body = bodyLines.join('\n').trim();
    if (body) {
      chunks.push({
        heading,
        text: `${heading}\n\n${body}`
      });
    }
  };

  for (const line of lines) {
    if (line.startsWith('## ')) {
      flushChunk();
      heading   = line.replace(/^##\s+/, '').trim();
      bodyLines = [];
    } else {
      bodyLines.push(line);
    }
  }
  flushChunk(); // last section

  return chunks;
}

// Call Voyage AI to embed a single text string.
// input_type: "document" for knowledge base content (vs. "query" for search queries)
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
