# Incomplete Emphasis Extension

This extension parses emphasis delimiters (`*` and `_`) and extends unclosed markers to the end of the block, enabling "incomplete emphasis" styling for rich markdown editing.

## Usage

```typescript
import { parser } from "@lezer/markdown"
import { IncompleteEmphasis } from "./incomplete-emphases"

const mdParser = parser.configure([IncompleteEmphasis])
```

## Behavior

| Input | Standard Parser | Incomplete Emphasis |
|-------|----------------|---------------------|
| `*hello*` | Emphasis | Emphasis |
| `*hello` | Plain text | Emphasis (extends to block end) |
| `**hello` | Plain text | StrongEmphasis (extends to block end) |
| `*a **b** c*` | Nested emphasis | Nested emphasis |
| `*italic **bold* text**` | Complex overlap | Split overlapping spans |

## Architecture

The implementation consists of three phases:

### Phase 1: Delimiter Parsing (`parseInline`)

Scans for `*` and `_` characters and creates `InlineDelimiter` objects with:
- Position (`from`, `to`)
- Type (asterisk vs underscore - prevents cross-matching)
- Side flags (can open, can close) based on CommonMark flanking rules

### Phase 2: Delimiter Matching (`matchDelimiters`)

Matches closers with openers using the CommonMark algorithm:
1. For each closer, scan backwards for a compatible opener
2. Apply the "mod 3" rule for ambiguous delimiters
3. **Prefer same-size matches** - if sizes differ, check for a better match later
4. Consume characters from delimiter edges, re-process if characters remain
5. Extend any remaining openers to block end as incomplete emphasis

### Phase 3: Tree Building (`buildNestedElements`)

Converts flat spans into properly nested elements:
1. Sort by start position, then by length (longer first)
2. For overlapping spans, clip to content area and create continuations
3. Recursively build child elements
4. Create `EmphasisMark` nodes for opener/closer positions

## Performance

| Aspect | Complexity | Notes |
|--------|-----------|-------|
| Delimiter parsing | O(n) | Single pass through text |
| Matching algorithm | O(n²) worst case | Backward scan per closer (same as standard) |
| Same-size preference | O(n) per mismatch | Lookahead for better match |
| Tree building | O(n log n) | Sort + linear traversal |

The implementation follows the same performance pattern as the standard `resolveMarkers` in `@lezer/markdown`.

## Why Overlapping Emphasis Requires Span Abstraction

Consider: `*italics and **italics-bold* bold only**`

This creates two overlapping spans:
- `Emphasis(0-28)` from `*...*`
- `StrongEmphasis(13-40)` from `**...**`

These must be split at their intersection:
- `Emphasis(0-28)` containing partial `StrongEmphasis(13-27)`
- `StrongEmphasis(28-40)` as continuation

An in-place approach cannot handle this because when we match `*...*`, we don't yet know about the outer `**` closer. The span abstraction allows:
1. Collecting all matches first
2. Detecting overlaps
3. Splitting overlapping spans correctly

## Key Differences from Standard Emphasis

| Feature | Standard | Incomplete |
|---------|----------|------------|
| Unmatched openers | Become plain text | Extend to block end |
| Overlapping emphasis | Not handled | Split at intersections |
| Same-size preference | First match wins | Prefers exact matches |

## Files

- `incomplete-emphases.ts` - Main implementation (259 lines)
- `incomplete-emphases.md` - This documentation
