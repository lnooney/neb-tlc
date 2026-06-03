#!/usr/bin/env node
// NEB TLC — PDF to Knowledge Base Draft Generator
//
// Reads a PDF source document and uses Claude to produce a draft knowledge base
// markdown file following the NEB TLC KB template. The draft includes:
//   - Direct quotes from the paper with page locators where visible
//   - Key findings and implications structured as H2 retrieval chunks
//   - Proper YAML frontmatter
//   - A Review Notes section flagging passages that need human verification
//
// You review and edit the draft before adding it to the knowledge base.
// The draft is NOT automatically ingested — run ingest.js after review.
//
// USAGE
//   node scripts/draft-kb-doc.js <path-to-pdf> [options]
//
//   Options:
//     --tier 1|2        Knowledge base tier (default: 2)
//     --topic <slug>    Topic slug, e.g. "active-learning" (default: inferred)
//     --id <slug>       Document ID slug (default: derived from filename)
//
//   Examples:
//     node scripts/draft-kb-doc.js ~/papers/freeman-2014.pdf --tier 1
//     node scripts/draft-kb-doc.js ~/papers/hattie-2009.pdf --tier 2 --topic feedback
//
// OUTPUT
//   knowledge-base/drafts/<id>.md
//   (create the drafts/ directory if it doesn't exist)
//
// PREREQUISITES
//   node >= 18
//   npm install pdf-parse @anthropic-ai/sdk dotenv
//
// ENVIRONMENT VARIABLES
//   ANTHROPIC_API_KEY — Claude API key

'use strict';

const fs   = require('fs');
const path = require('path');

try { require('dotenv').config(); } catch {}

const DRAFTS_DIR = path.join(__dirname, '..', 'knowledge-base', 'drafts');
const MODEL      = 'claude-opus-4-7';  // Use the most capable model for extraction accuracy

async function main() {
  const args    = process.argv.slice(2);
  const pdfPath = args.find(a => !a.startsWith('--'));

  if (!pdfPath || !fs.existsSync(pdfPath)) {
    console.error('\nUsage: node scripts/draft-kb-doc.js <path-to-pdf> [--tier 1|2] [--topic slug] [--id slug]\n');
    process.exit(1);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('\nMissing ANTHROPIC_API_KEY. Add it to your .env file.\n');
    process.exit(1);
  }

  const tier  = getArg(args, '--tier',  '2');
  const topic = getArg(args, '--topic', '');
  const docId = getArg(args, '--id',    slugify(path.basename(pdfPath, '.pdf')));

  // Ensure drafts directory exists
  if (!fs.existsSync(DRAFTS_DIR)) fs.mkdirSync(DRAFTS_DIR, { recursive: true });

  const outputPath = path.join(DRAFTS_DIR, `${docId}.md`);

  console.log(`\nNEB TLC Draft Generator`);
  console.log(`  PDF:    ${pdfPath}`);
  console.log(`  Output: ${outputPath}`);
  console.log(`  Tier:   ${tier}`);
  console.log('');

  // Step 1: Extract text from PDF
  process.stdout.write('Extracting text from PDF … ');
  let pdfText;
  try {
    const pdfParse = require('pdf-parse');
    const buffer   = fs.readFileSync(pdfPath);
    const data     = await pdfParse(buffer);
    pdfText        = data.text;
    console.log(`ok (${Math.round(pdfText.length / 1000)}k characters extracted)`);
  } catch (err) {
    console.log('ERROR');
    console.error('  Could not extract PDF text:', err.message);
    console.error('  Make sure pdf-parse is installed: npm install pdf-parse');
    process.exit(1);
  }

  // Warn if the extraction looks sparse — may indicate a scanned PDF
  if (pdfText.trim().length < 500) {
    console.warn('\n⚠ WARNING: Very little text was extracted. This PDF may be scanned or image-based.');
    console.warn('  Scanned PDFs require OCR before text extraction is possible.');
    console.warn('  Consider using Adobe Acrobat, ABBYY FineReader, or a similar tool to OCR the PDF first.\n');
  }

  // Truncate to stay within Claude's context window (~180k tokens ≈ ~720k chars)
  // Most academic papers are well within this; flag if we had to truncate.
  const MAX_CHARS = 700000;
  let truncated   = false;
  if (pdfText.length > MAX_CHARS) {
    pdfText   = pdfText.slice(0, MAX_CHARS);
    truncated = true;
    console.warn(`⚠ PDF text truncated to ${MAX_CHARS / 1000}k characters. The draft may not cover the full paper.`);
  }

  // Step 2: Send to Claude for structured extraction
  process.stdout.write('Sending to Claude for extraction … ');

  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });

  const prompt = buildExtractionPrompt(pdfText, { docId, tier, topic, truncated });

  let draft;
  try {
    const response = await client.messages.create({
      model,
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }]
    });
    draft = response.content[0].text;
    console.log('ok');
  } catch (err) {
    console.log('ERROR');
    console.error('  Claude API error:', err.message);
    process.exit(1);
  }

  // Step 3: Save the draft
  fs.writeFileSync(outputPath, draft, 'utf8');

  console.log(`\nDraft saved to: ${outputPath}\n`);
  console.log('Next steps:');
  console.log('  1. Open the draft and review all content carefully');
  console.log('  2. Verify quotes against the original PDF — correct any errors');
  console.log('  3. Add or remove page locators in quotes (format: > "text" (p. X))');
  console.log('  4. Check the ## Review Notes section at the end for flagged items');
  console.log('  5. Remove the ## Review Notes section when review is complete');
  console.log('  6. Add the document to knowledge-base/manifest.json');
  console.log('  7. Run node scripts/ingest.js to embed and load into Supabase\n');
}

// ── EXTRACTION PROMPT ─────────────────────────────────────────────────────────

function buildExtractionPrompt(pdfText, { docId, tier, topic, truncated }) {
  const truncatedNote = truncated
    ? '\n\nNOTE: The PDF text was truncated due to length. Focus on the content that was provided.'
    : '';

  return `You are preparing a knowledge base document for NEB TLC, a teaching and learning coaching tool for university faculty at Boston University.

This knowledge base is used by a RAG (retrieval-augmented generation) system. Faculty are academics skeptical of AI — accuracy and traceability are critical. Every significant claim must be traceable to specific text in the source paper.

## YOUR TASK

Convert the academic paper below into a structured NEB TLC knowledge base document. Follow the format exactly.

## FORMAT REQUIREMENTS

1. Each ## section becomes one retrieval chunk. Keep sections focused — one major finding, theme, or framework component per section (roughly 200–500 words each).

2. **Direct quotes:** Mark with blockquote syntax and include page number where visible:
   > "Exact text from the paper as written." (p. X)

   If you cannot find a page number for a quote, write (p. ?) — do NOT omit the quote just because you can't locate the page.

3. **Paraphrases:** Write as regular text. Be conservative — if the source text is precise, quote it rather than paraphrase. Never put your own words in quotation marks.

4. **Uncertainty:** If you are not certain a passage is accurately represented, add [VERIFY] after it. A human reviewer will check these against the original.

5. **Page numbers in PDFs:** Academic PDFs often embed page numbers in headers/footers that appear mid-text in the extraction. Use context clues to identify them.

6. At the end, include a ## Review Notes section listing:
   - Quotes where page numbers were uncertain (p. ?)
   - Any [VERIFY] passages
   - Any important sections you may have missed or found unclear
   - Whether the PDF appeared to be fully extracted or cut off

## OUTPUT FORMAT

Produce a complete markdown file starting with YAML frontmatter, exactly as shown:

\`\`\`markdown
---
id: ${docId}
title: "[Full title of the paper or book]"
tier: ${tier}
topic: ${topic || '[infer from content — use a short hyphenated slug like active-learning or feedback-design]'}
sources:
  - citation: "[Full APA 7th edition citation — author(s), year, title, journal/publisher, volume/issue/pages. No DOI in the citation text itself.]"
    short: "[Author et al., Year]"
    type: [journal-article | book | book-chapter | report]
    url: "[DOI URL if visible in the paper, e.g. https://doi.org/... — leave blank for books without a stable URL]"
tags:
  - [3–8 relevant lowercase hyphenated tags]
last_updated: "[YYYY-MM — use the paper's publication year]"
status: draft
---

# [Full Title]

## [Section Heading — major finding or theme]

[Content for this section. Quotes use blockquote syntax below.]

> "Direct quote from the paper." (p. X)

[Additional context or paraphrase as needed.]

## [Next Section Heading]

[Content...]

## Review Notes

[List items needing human verification before this document is ingested]
\`\`\`

## IMPORTANT GUIDANCE

- Do NOT hallucinate findings. If the paper does not clearly support a claim, do not include it.
- Do NOT import findings from other papers you know about — extract only from the text below.
- The knowledge base is for faculty development. Focus on: key findings, pedagogical implications, practical recommendations, and methodological notes that affect how findings should be interpreted.
- Skip: background literature review sections that merely motivate the study, detailed statistical methodology, acknowledgments, references list, and author bios. Exception: if the paper itself is a systematic review, meta-analysis, or scoping review, the synthesis of findings across studies IS the primary content — extract it fully, including effect sizes, moderating variables, and study-level comparisons that support the conclusions.
- If the paper has an Abstract, Introduction, and Discussion/Conclusion, those sections typically contain the most quotable claims — prioritize them.
- For the `url` field: look for a DOI in the paper header, footer, or first page (it usually appears as "https://doi.org/..." or "DOI: 10.xxxx/..."). Include it exactly as written. If you cannot find one, leave the url field blank — do NOT guess or construct a URL.
${truncatedNote}

## PDF TEXT

${pdfText}`;
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function getArg(args, flag, defaultVal) {
  const i = args.indexOf(flag);
  return (i !== -1 && args[i + 1]) ? args[i + 1] : defaultVal;
}

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
