// incomplete-emphases.ts
//
// Extended emphasis parsing that handles incomplete (unclosed) emphasis delimiters.
// This parser allows emphasis like `*text` to be parsed even without a closing
// delimiter, with the emphasis extending to the end of the inline context.
//
// Key differences from standard emphasis parsing:
// - Incomplete emphasis: Unmatched openers create emphasis extending to block end
// - Atomic matching: `**` is treated atomically (won't split into `*` for italic)
// - Max 3 asterisks: Delimiter consumption is limited to 3 asterisks
// - Overlap splitting: When emphasis spans overlap, they are split at boundaries
//
// Implementation follows the same single-pass algorithm as the official
// resolveMarkers in @lezer/markdown, with atomic matching and overlap handling.
// This maintains incremental parsing performance.
//
// Example: `For *italics and **italics-bold* bold only**`
// Results in: Emphasis wrapping "italics and **italics-bold", with StrongEmphasis
// starting inside the Emphasis and continuing after it (split at the boundary).

import { InlineContext, MarkdownConfig, Element } from "@lezer/markdown"

/// Punctuation characters used for flanking checks (CommonMark spec).
export let Punctuation = /[!"#$%&'()*+,\-.\/:;<=>?@\[\\\]^_`{|}~\xA1\u2010-\u2027]/
try { Punctuation = new RegExp("[\\p{S}|\\p{P}]", "u") } catch (_) {}

const enum Mark { Open = 1, Close = 2 }

/// Delimiter type for emphasis markers.
interface DelimiterType {
  resolve?: string
  mark?: string
}

const EmphasisUnderscore: DelimiterType = { resolve: "Emphasis", mark: "EmphasisMark" }
const EmphasisAsterisk: DelimiterType = { resolve: "Emphasis", mark: "EmphasisMark" }

/// Represents an inline delimiter that may open or close emphasis.
class InlineDelimiter {
  constructor(
    readonly type: DelimiterType,
    public from: number,
    public to: number,
    public side: Mark
  ) {}
}

/// Intermediate representation of an emphasis segment before tree building.
/// Unlike Element, segments can be split when they overlap with other segments.
interface Segment {
  type: string
  from: number
  to: number
  markSizeOpen: number   // Size of opening mark (0 if incomplete/split)
  markSizeClose: number  // Size of closing mark (0 if incomplete/split)
}

/// Incomplete emphasis extension. Parses emphasis delimiters and handles
/// cases where delimiters are not properly closed, extending the emphasis
/// to the end of the block.
///
/// This is a MarkdownExtension that can be passed to the markdown parser's
/// configure method.
export const IncompleteEmphasis: MarkdownConfig = {
  parseInline: [{
    name: "IncompleteEmphasis",
    parse(cx, _next, start) {
      let delims: InlineDelimiter[] = []

      // Phase 1: Collect all emphasis delimiters in the inline context.
      // This follows the same flanking rules as CommonMark.
      while (start <= cx.end) {
        let ch = cx.char(start)
        if (ch != 95 /* '_' */ && ch != 42 /* '*' */) { start++; continue }

        let pos = start + 1
        while (cx.char(pos) == ch) pos++

        let before = cx.slice(start - 1, start), after = cx.slice(pos, pos + 1)
        let pBefore = Punctuation.test(before), pAfter = Punctuation.test(after)
        let sBefore = /\s|^$/.test(before), sAfter = /\s|^$/.test(after)

        // CommonMark flanking rules
        let leftFlanking = !sAfter && (!pAfter || sBefore || pBefore)
        let rightFlanking = !sBefore && (!pBefore || sAfter || pAfter)

        let canOpen = leftFlanking && (ch == 42 || !rightFlanking || pBefore)
        let canClose = rightFlanking && (ch == 42 || !leftFlanking || pAfter)

        delims.push(new InlineDelimiter(
          ch == 95 ? EmphasisUnderscore : EmphasisAsterisk,
          start, pos,
          (canOpen ? Mark.Open : 0) | (canClose ? Mark.Close : 0)
        ))
        start = pos
      }

      // Phase 2: Resolve markers and collect segments
      let segments = collectSegments(delims, cx.end)

      // Phase 3: Build tree with overlap splitting
      let elements = buildTree(segments, cx)

      // Sort elements by position (from ascending, to descending for nesting)
      elements.sort((a, b) => a.from - b.from || b.to - a.to)
      for (let elt of elements) {
        cx.addElement(elt)
      }

      return start
    },
    before: "Emphasis"
  }]
}

// For backwards compatibility
export const IncompleteEmp = IncompleteEmphasis

/// Collect segments by matching delimiters. This is a single-pass algorithm that:
/// 1. Scans forward looking for closing tokens
/// 2. For each closer, finds the nearest matching opener
/// 3. Creates segments and shrinks remaining delimiters
/// 4. Handles incomplete (unmatched) openers at the end
function collectSegments(delims: InlineDelimiter[], blockEnd: number): Segment[] {
  let segments: Segment[] = []
  
  // Make a copy so we can mutate during matching
  let parts = delims.map(d => new InlineDelimiter(d.type, d.from, d.to, d.side))

  // Single pass: scan forward looking for closing tokens
  for (let i = 0; i < parts.length; i++) {
    let close = parts[i]
    if (!close || !(close.side & Mark.Close)) continue

    let closeSize = close.to - close.from
    if (closeSize == 0) continue

    // Scan backwards for a matching opener
    let openIdx = -1
    for (let j = i - 1; j >= 0; j--) {
      let open = parts[j]
      if (!open || !(open.side & Mark.Open) || open.type != close.type) continue

      let openSize = open.to - open.from
      if (openSize == 0) continue

      // Determine size to consume: minimum of 2, openSize, closeSize
      let size = Math.min(2, openSize, closeSize)

      // Atomic matching: if size would be 1 but either delimiter is exactly 2,
      // skip this match. This ensures `**` is treated as a single unit for bold
      // and won't partially match with `*` for italic.
      if (size == 1 && (openSize == 2 || closeSize == 2)) continue

      // CommonMark Rule 14: when both delimiters can open and close,
      // the sum of lengths must not be multiple of 3 unless both are.
      if ((open.side & Mark.Close || close.side & Mark.Open) &&
          (openSize + closeSize) % 3 == 0 && (openSize % 3 || closeSize % 3)) continue

      openIdx = j
      break
    }

    if (openIdx == -1) continue

    let open = parts[openIdx]
    let openSize = open.to - open.from
    let size = Math.min(2, openSize, closeSize)

    // Create segment
    let type = size == 1 ? "Emphasis" : "StrongEmphasis"
    let start = open.to - size
    let end = close.from + size

    segments.push({
      type,
      from: start,
      to: end,
      markSizeOpen: open.to - open.from,  // Full original mark size
      markSizeClose: close.to - close.from
    })

    // Shrink delimiters, limiting to max 1 additional asterisk (total max 3)
    let remainingOpen = openSize - size
    if (remainingOpen > 0) {
      let newFrom = Math.max(open.from, start - 1)  // Limit to 1 extra char
      open.to = start
      open.from = newFrom
      if (open.to <= open.from) parts[openIdx] = null!
    } else {
      parts[openIdx] = null!
    }

    let remainingClose = closeSize - size
    if (remainingClose > 0) {
      let newTo = Math.min(close.to, end + 1)  // Limit to 1 extra char
      close.from = end
      close.to = newTo
      if (close.to <= close.from) parts[i] = null!
      else i--  // Reprocess remaining closer
    } else {
      parts[i] = null!
    }
  }

  // Handle incomplete: remaining openers extend to block end
  for (let d of parts) {
    if (!d || !(d.side & Mark.Open)) continue

    let remaining = d.to - d.from
    while (remaining > 0) {
      let size = remaining >= 2 ? 2 : 1
      let type = size == 1 ? "Emphasis" : "StrongEmphasis"

      segments.push({
        type,
        from: d.to - remaining,
        to: blockEnd,
        markSizeOpen: d.to - d.from,
        markSizeClose: 0  // No closing mark (incomplete)
      })

      remaining -= size
    }
  }

  return segments
}

/// Build a properly nested tree from segments, splitting overlapping segments
/// at boundaries. When segment A contains the start of segment B but B extends
/// beyond A, B is split into two parts: one nested inside A (incomplete) and
/// one as a sibling after A (also incomplete).
function buildTree(segments: (Segment | null)[], cx: InlineContext): Element[] {
  let result: Element[] = []

  // Sort by position: from ascending, then to descending (larger spans first)
  segments.sort((a, b) => {
    if (!a || !b) return 0
    return a.from - b.from || b.to - a.to
  })

  let pos = 0
  for (let i = 0; i < segments.length; i++) {
    let s = segments[i]
    if (!s || s.from < pos) continue

    // Collect children: segments that start within this segment
    let inner: (Segment | null)[] = []
    for (let j = i + 1; j < segments.length; j++) {
      let other = segments[j]
      if (!other || other.from >= s.to) break

      if (other.to > s.to) {
        // Overlapping! Split the segment at s.to
        // Inner part: truncated to s.to with no close mark
        inner.push({
          ...other,
          to: s.to,
          markSizeClose: 0
        })
        // Outer remainder: from s.to to original end with no open mark
        segments[j] = {
          ...other,
          from: s.to,
          markSizeOpen: 0
        }
      } else {
        // Fully contained
        inner.push(other)
        segments[j] = null
      }
    }

    // Build children for this segment
    let children: Element[] = []
    
    // Add EmphasisMark for opening if present
    if (s.type !== "EmphasisMark" && s.markSizeOpen > 0) {
      children.push(cx.elt("EmphasisMark", s.from, s.from + s.markSizeOpen))
    }

    // Recursively build inner segments
    if (inner.length > 0) {
      children.push(...buildTree(inner, cx))
    }

    // Add EmphasisMark for closing if present
    if (s.type !== "EmphasisMark" && s.markSizeClose > 0) {
      children.push(cx.elt("EmphasisMark", s.to - s.markSizeClose, s.to))
    }

    result.push(cx.elt(s.type, s.from, s.to, children))
    pos = s.to
  }

  return result
}
