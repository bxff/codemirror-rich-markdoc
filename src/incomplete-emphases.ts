import { Element } from "@lezer/markdown"
import type { MarkdownConfig } from "@lezer/markdown"
import { tags as t } from "@lezer/highlight"

// Punctuation regex for CommonMark flanking checks
export let Punctuation = /[!"#$%&'()*+,\-.\/:;<=>?@\[\\\]^_`{|}~\xA1\u2010-\u2027]/
try { Punctuation = new RegExp("[\\p{S}|\\p{P}]", "u") } catch (_) {}

const enum Mark { Open = 1, Close = 2 }

// Separate objects for underscore vs asterisk prevent cross-matching
const EmphasisUnderscore = { resolve: "Emphasis", mark: "EmphasisMark" }
const EmphasisAsterisk = { resolve: "Emphasis", mark: "EmphasisMark" }
type DelimType = typeof EmphasisUnderscore

class InlineDelimiter {
  constructor(
    readonly type: DelimType,
    public from: number,
    public to: number,
    public side: number
  ) {}
}

// Represents a matched or incomplete emphasis span
interface Span {
  type: string
  from: number
  to: number
  openMark: number  // Size of opening mark (0 if split/continuation)
  closeMark: number // Size of closing mark (0 if incomplete/split)
}

/// Extension that parses emphasis and extends unclosed markers to block end.
export const IncompleteEmphasis: MarkdownConfig = {
  defineNodes: [
    { name: "Emphasis", style: { "Emphasis/...": t.emphasis } },
    { name: "StrongEmphasis", style: { "StrongEmphasis/...": t.strong } },
    { name: "EmphasisMark", style: t.processingInstruction }
  ],
  parseInline: [{
    name: "IncompleteEmphasis",
    parse(cx: any, next: number, start: number) {
      if (next != 95 /* '_' */ && next != 42 /* '*' */) return -1

      let pos = start + 1
      while (cx.char(pos) == next) pos++

      // Compute flanking per CommonMark spec
      let before = cx.slice(start - 1, start), after = cx.slice(pos, pos + 1)
      let pBefore = Punctuation.test(before), pAfter = Punctuation.test(after)
      let sBefore = /\s|^$/.test(before), sAfter = /\s|^$/.test(after)
      let leftFlanking = !sAfter && (!pAfter || sBefore || pBefore)
      let rightFlanking = !sBefore && (!pBefore || sAfter || pAfter)
      let canOpen = leftFlanking && (next == 42 || !rightFlanking || pBefore)
      let canClose = rightFlanking && (next == 42 || !leftFlanking || pAfter)

      return cx.append(new InlineDelimiter(
        next == 95 ? EmphasisUnderscore : EmphasisAsterisk,
        start, pos,
        (canOpen ? Mark.Open : 0) | (canClose ? Mark.Close : 0)
      ))
    },
    before: "Emphasis"
  }],
  delimiterResolvers: [resolveIncompleteEmphasis]
} as any

export const IncompleteEmp = IncompleteEmphasis

function resolveIncompleteEmphasis(cx: any) {
  // Collect our emphasis delimiters
  let delims: InlineDelimiter[] = []
  for (let part of cx.parts) {
    if (part instanceof InlineDelimiter &&
        (part.type == EmphasisUnderscore || part.type == EmphasisAsterisk)) {
      delims.push(part)
    }
  }
  if (!delims.length) return

  let spans = matchDelimiters(delims, cx.end)
  if (!spans.length) return

  let elements = buildNestedElements(spans, cx)

  // Replace delimiters in cx.parts with our elements
  let delimSet = new Set(delims)
  let newParts: any[] = []
  let eltIdx = 0

  for (let part of cx.parts) {
    if (!part || delimSet.has(part)) continue

    // Insert elements that start at or before this part
    while (eltIdx < elements.length && elements[eltIdx].from <= part.from) {
      newParts.push(elements[eltIdx++])
    }

    // Skip parts inside an emphasis element
    let last = newParts[newParts.length - 1]
    if (last instanceof Element) {
      let name = cx.parser.nodeSet.types[last.type]?.name
      if ((name == "Emphasis" || name == "StrongEmphasis") &&
          part.from >= last.from && part.to <= last.to) {
        continue
      }
    }
    newParts.push(part)
  }

  while (eltIdx < elements.length) newParts.push(elements[eltIdx++])
  cx.parts = newParts
}

// Match delimiters and create spans (including incomplete ones)
function matchDelimiters(delims: InlineDelimiter[], blockEnd: number): Span[] {
  let spans: Span[] = []
  // Work on copies so we can mutate positions
  let parts = delims.map(d => ({ type: d.type, from: d.from, to: d.to, side: d.side }))

  // Match closers with openers
  for (let i = 0; i < parts.length; i++) {
    let close = parts[i]
    if (!(close.side & Mark.Close) || close.to <= close.from) continue

    for (let j = i - 1; j >= 0; j--) {
      let open = parts[j]
      if (open.type != close.type || !(open.side & Mark.Open)) continue
      let openSize = open.to - open.from
      if (openSize == 0) continue

      let closeSize = close.to - close.from

      // CommonMark "mod 3" rule for ambiguous delimiters
      if ((close.side & Mark.Open || open.side & Mark.Close) &&
          (openSize + closeSize) % 3 == 0 && (openSize % 3 || closeSize % 3)) continue

      // Atomic matching: only match same-size delimiters
      // This prevents "star stealing" where ** matches with single *
      if (openSize != closeSize) continue

      let size = Math.min(2, openSize, closeSize)
      let start = open.to - size
      let end = close.from + size

      spans.push({
        type: size == 1 ? "Emphasis" : "StrongEmphasis",
        from: start, to: end, openMark: size, closeMark: size
      })

      // Consume delimiter characters
      open.to -= size
      close.from += size

      // Clear incompatible (different type) delimiters between open/close
      for (let k = j + 1; k < i; k++) {
        if (parts[k].type != open.type) parts[k].from = parts[k].to
      }

      // Re-process closer if it still has characters
      if (close.to > close.from) i--
      break
    }
  }

  // Extend remaining openers to block end
  for (let d of parts) {
    if (!(d.side & Mark.Open)) continue
    let remaining = d.to - d.from
    let pos = d.from
    while (remaining > 0) {
      let size = remaining >= 2 ? 2 : 1
      spans.push({
        type: size == 1 ? "Emphasis" : "StrongEmphasis",
        from: pos, to: blockEnd, openMark: size, closeMark: 0
      })
      pos += size
      remaining -= size
    }
  }

  return spans
}

// Build properly nested elements, splitting overlapping spans
function buildNestedElements(spans: Span[], cx: any): Element[] {
  // Sort: earlier start first, then longer spans first (for proper nesting)
  spans.sort((a, b) => a.from - b.from || b.to - a.to)

  let result: Element[] = []
  let processed = 0

  for (let i = 0; i < spans.length; i++) {
    let span = spans[i]
    if (span.from < processed) continue

    // Collect children (spans fully or partially inside this one)
    let children: Span[] = []
    for (let j = i + 1; j < spans.length; j++) {
      let other = spans[j]
      if (other.from >= span.to) break

      let contentStart = span.from + span.openMark
      let contentEnd = span.to - span.closeMark

      if (other.from < contentEnd && other.to > contentStart) {
        // Clip to content area
        let clippedFrom = Math.max(other.from, contentStart)
        let clippedTo = Math.min(other.to, contentEnd)
        if (clippedFrom < clippedTo) {
          children.push({
            ...other,
            from: clippedFrom,
            to: clippedTo,
            openMark: clippedFrom == other.from ? other.openMark : 0,
            closeMark: clippedTo == other.to ? other.closeMark : 0
          })
        }
      }

      // If span continues past parent, create continuation
      if (other.to > span.to) {
        spans[j] = { ...other, from: span.to, openMark: 0 }
      } else {
        spans[j] = { ...other, from: other.to } // Mark as processed
      }
    }

    // Build element with children
    let elChildren: Element[] = []
    if (span.openMark > 0) {
      elChildren.push(cx.elt("EmphasisMark", span.from, span.from + span.openMark))
    }
    if (children.length > 0) {
      elChildren.push(...buildNestedElements(children, cx))
    }
    if (span.closeMark > 0) {
      elChildren.push(cx.elt("EmphasisMark", span.to - span.closeMark, span.to))
    }

    result.push(cx.elt(span.type, span.from, span.to, elChildren))
    processed = span.to
  }

  return result
}
