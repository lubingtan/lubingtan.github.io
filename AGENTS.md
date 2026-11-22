# Wiki Schema

This is the schema for an LLM-driven personal wiki. It defines how the LLM maintains and operates on the wiki.

## Architecture

Three layers:

**Raw sources** (`raw/`) — curated source documents (articles, papers, web clippings). These are part of the git repo (commit them alongside wiki changes). The LLM reads from them but never modifies them.

**The wiki** (`src/docs/`) — LLM-maintained markdown files. Summaries, concept pages, notes, cross-references. The LLM owns this layer: creates pages, updates them when new sources arrive, maintains cross-references, and keeps everything consistent.

**The schema** (this file, `AGENTS.md`) — tells the LLM how the wiki is structured, what conventions to follow, and what workflows to use when ingesting sources, answering questions, or maintaining the wiki. Co-evolve this with the LLM over time.

## Directory Structure

```
raw/                          # Raw source documents (immutable, LLM reads only)
src/docs/                     # Wiki pages (LLM-owned)
src/docs/index.md             # Content index (LLM updates on every ingest)
src/docs/log.md               # Chronological operation log (LLM appends to)
src/docs/{category}/{page}.md # Wiki pages organized by domain
src/SUMMARY.md                # Auto-generated mdBook ToC (do not edit manually)
tools/gen-summary.py          # Generates SUMMARY.md from directory structure
```

## Operations

### Ingest

When the user provides a new source (article, paper, podcast notes, etc.):

1. **Place the source** in `raw/` (or note its URL if web-based)
2. **Read the source** and discuss key takeaways with the user
3. **Write a summary page** in `src/docs/` under the appropriate category
4. **Update `index.md`** — add the new page with link and one-line summary
5. **Cross-reference** — update any existing pages that relate to the new content; add backlinks
6. **Append to `log.md`** — record the ingest with date, type, and description
7. **Regenerate ToC** — run `make gen-summary` to update `src/SUMMARY.md`

A single source might touch 10-15 wiki pages as cross-references are added.

### Query

When the user asks a question:

1. **Read `index.md`** first — it's the fastest way to find relevant pages
2. **Read the relevant pages** and synthesize an answer with citations (links to wiki pages)
3. **File good answers back** — if the answer is valuable and not already captured, create or update a wiki page with the synthesis. This way explorations compound in the knowledge base.

### Lint

Periodically health-check the wiki. Look for:

- Contradictions between pages — flag them for the user
- Stale claims that newer sources have superseded
- Orphan pages with no inbound links
- Important concepts mentioned but lacking their own page
- Missing cross-references between related pages
- Data gaps that could be filled with a web search or new sources

Report findings to the user and offer to fix them.

## Page Conventions

- **Language**: Chinese-first (the wiki is primarily Chinese). English terms keep their original casing.
- **Links**: Use relative links between wiki pages (e.g. `../Cloud_Native/Kubernetes/kubelet原理.md`)
- **Headings**: Use `#` for page title, `##` for sections, `###` for subsections. Keep hierarchy clean.
- **Frontmatter**: Not required. Add YAML frontmatter only when the page has metadata worth querying (tags, dates).
- **File names**: Use a short, lowercase English filename with hyphens for new pages (e.g. `production-operator.md`); do not reuse the page title (especially a Chinese title) as the filename. The H1 heading carries the human-readable title. This keeps URLs/SUMMARY paths stable and avoids Chinese punctuation in paths. Existing mixed Chinese/English filenames are grandfathered and need not be renamed just for style.
- **Assets**: Images and attachments go in `src/docs/{category}/{page}.assets/` directories.

## Index and Log

**`index.md`** is content-oriented. Each page listed with a link, a one-line summary, and optionally metadata. Organized by category. The LLM updates it on every ingest and reads it first when answering queries.

**`log.md`** is chronological and append-only. Each entry starts with `## [YYYY-MM-DD] type | description`. Types: `ingest`, `query`, `lint`, `update`. The log gives a timeline of the wiki's evolution.

## Build and Publish

The wiki is published as an mdBook static site:

- `make build` — regenerates SUMMARY.md and builds the static site into `book/`
- `make serve` — serves the book locally for preview
- `make gen-summary` — regenerates `src/SUMMARY.md` from `src/docs/` directory structure

The "Latest updates" page is generated at build time by `tools/blog-preprocessor.py` (it is not a file under `src/docs/`). Its switch lives in `book.toml`:

```toml
[preprocessor.blog]
latest-updates = false   # set to true to show the page again
```

Default is `true`. With `false`, no `latest_updates.html` is generated and the ToC has no such entry; the page itself is never edited, only toggled.

CI (`.github/workflows/gh-pages.yml`) builds and deploys to GitHub Pages on push to main.

**Important**: `index.md` and `log.md` are meta-files excluded from the mdBook ToC. Do not manually edit `src/SUMMARY.md` — it is auto-generated.
