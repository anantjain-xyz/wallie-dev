# Typography

Wallie loads Inter Variable and IBM Plex Mono with `next/font`. Both fonts are self-hosted by
Next.js, exposed through `--font-inter` and `--font-ibm-plex-mono`, and use metric-adjusted
fallbacks. Keep font construction at module scope in `src/app/layout.tsx` so every route shares the
same generated font faces.

## Semantic roles

Use the shared roles in `src/app/globals.css` before reaching for a text-size utility:

| Role          | Class                | Intended use                                             |
| ------------- | -------------------- | -------------------------------------------------------- |
| Display       | `type-display`       | Marketing or empty-state statements                      |
| Page title    | `type-page-title`    | One primary heading per page                             |
| Section title | `type-section-title` | Major page sections                                      |
| Body          | `type-body`          | Ordinary interface copy                                  |
| Secondary     | `type-secondary`     | Supporting copy and metadata                             |
| Label         | `type-label`         | Form and compact control labels                          |
| Code          | `type-code`          | Code, logs, branches, identifiers, or aligned timestamps |
| Annotation    | `type-annotation`    | Non-essential counters or annotations only               |

`type-annotation` is the only 11px role. Essential copy, actions, errors, and status text must be at
least 12px. Ordinary labels stay sans-serif. Mono is reserved for identifiers, branches, aligned
timestamps and numbers, code, and logs.

Artifact markdown uses the `artifact-*` roles. Reading text is 15px/24px with a 75ch maximum
measure; headings use distinct 28px, 22px, 18px, and 16px levels. Inline code may wrap at long
tokens, while fenced blocks and tables scroll horizontally inside the available mobile width.

## Utility policy

Standard Tailwind sizes remain available when a semantic role is not appropriate. Do not add
arbitrary `text-[9px]` through `text-[12px]` utilities. ESLint enforces that floor in TypeScript and
TSX source. Use `text-xs` for 12px UI copy or `type-annotation` for genuinely non-essential 11px
metadata. Any new optical tracking must be attached to a specific heading role; code and numeric
data keep normal tracking.
