-- NEB TLC Knowledge Base Schema — v2 (updated for source citation support)
-- Run this once in the Supabase SQL editor before running scripts/ingest.js
--
-- If you previously ran v1 of this schema, run just the ALTER TABLE statements
-- at the bottom of this file to add the new columns without recreating the table.

-- Enable the pgvector extension (required for embedding storage and search)
create extension if not exists vector;

-- Main knowledge base table
-- Each row is one H2 section from a knowledge base document
create table if not exists knowledge_chunks (
  id              uuid primary key default gen_random_uuid(),
  document_id     text not null,        -- e.g. "learning-science-foundations"
  chunk_index     int  not null,        -- position within the document (0-based)
  tier            int  not null,        -- 1 = foundational, 2 = contextual
  topic           text,                 -- e.g. "learning-science"
  heading         text,                 -- H2 section heading
  content         text not null,        -- full text of the chunk
  source_citation text,                 -- full APA 7th edition citation for this chunk's primary source
  locator         text,                 -- page number, section, or other location in the source (e.g. "p. 33", "Table 2")
  embedding       vector(1024),         -- Voyage AI voyage-3 produces 1024-dim vectors
  metadata        jsonb,                -- title, tags, sources, last_updated, path
  created_at      timestamptz default now(),
  unique(document_id, chunk_index)      -- prevent duplicate chunks on re-ingestion
);

-- Vector similarity search index using IVFFlat (cosine distance)
-- lists=50 is appropriate for a small knowledge base (~100 chunks)
create index if not exists knowledge_chunks_embedding_idx
  on knowledge_chunks using ivfflat (embedding vector_cosine_ops)
  with (lists = 50);

-- Indexes for filtering and lookup
create index if not exists knowledge_chunks_tier_idx
  on knowledge_chunks (tier);

create index if not exists knowledge_chunks_document_idx
  on knowledge_chunks (document_id);

-- Similarity search function called by api/relay.js
-- Returns chunks ordered by cosine similarity to the query embedding
-- filter_tier: pass 1 or 2 to restrict to that tier; pass null for all tiers
create or replace function match_chunks(
  query_embedding  vector(1024),
  match_count      int     default 8,
  filter_tier      int     default null
)
returns table (
  id              uuid,
  document_id     text,
  chunk_index     int,
  tier            int,
  topic           text,
  heading         text,
  content         text,
  source_citation text,
  locator         text,
  similarity      float
)
language sql stable
as $$
  select
    id,
    document_id,
    chunk_index,
    tier,
    topic,
    heading,
    content,
    source_citation,
    locator,
    1 - (embedding <=> query_embedding) as similarity
  from knowledge_chunks
  where
    (filter_tier is null or tier = filter_tier)
    and embedding is not null
  order by embedding <=> query_embedding
  limit match_count;
$$;

-- ── MIGRATION (run these if you already created the table with the v1 schema) ──
-- alter table knowledge_chunks add column if not exists source_citation text;
-- alter table knowledge_chunks add column if not exists locator text;
-- drop function if exists match_chunks(vector, int, int);
-- then re-run the create or replace function above
