import { InlineContext, Element } from "@lezer/markdown"
import type { MarkdownConfig } from "@lezer/markdown"
import { tags as t } from "@lezer/highlight"

/// Punctuation characters used for flanking checks (CommonMark spec).
export let Punctuation = /[!"#$%&'()*+,\-.\/:;<=>?@\[\\\]^_`{|}~\xA1\u2010-\u2027]/
try { Punctuation = new RegExp("[\\p{S}|\\p{P}]", "u") } catch (_) {}

const Mark = { Open: 1, Close: 2 }

/// Delimiter type for emphasis markers.
interface DelimiterType {
  resolve?: string
  mark?: string
}

const EmphasisUnderscore: DelimiterType = { resolve: "Emphasis", mark: "EmphasisMark" }
const EmphasisAsterisk: DelimiterType = { resolve: "Emphasis", mark: "EmphasisMark" }

/// Represents an inline delimiter that may open or close emphasis.
class InlineDelimiter {
  readonly type: DelimiterType
  public from: number
  public to: number
  public side: number
  constructor(type: DelimiterType, from: number, to: number, side: number) {
    this.type = type
    this.from = from
    this.to = to
    this.side = side
  }
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
export const IncompleteEmphasis: MarkdownConfig = {
  defineNodes: [{
    name: "Emphasis",
    style: { "Emphasis/...": t.emphasis }
  }, {
    name: "StrongEmphasis",
    style: { "StrongEmphasis/...": t.strong }
  }, {
    name: "EmphasisMark",
    style: t.processingInstruction
  }],
  parseInline: [{
    name: "IncompleteEmphasis",
    parse(cx: any, next: number, start: number) {
      if (next != 95 /* '_' */ && next != 42 /* '*' */) return -1
      
      // Hook the resolver if not already hooked
      if (cx.resolveMarkers != resolveIncompleteEmphasis) {
        cx.originalResolveMarkers = cx.resolveMarkers
        cx.resolveMarkers = resolveIncompleteEmphasis
      }

      // 1. Scan the current delimiter run (atomic per-position parsing)
      let pos = start + 1
      while (cx.char(pos) == next) pos++
      
      // 2. Check flanking rules (same as CommonMark)
      let before = cx.slice(start - 1, start), after = cx.slice(pos, pos + 1)
      let pBefore = Punctuation.test(before), pAfter = Punctuation.test(after)
      let sBefore = /\s|^$/.test(before), sAfter = /\s|^$/.test(after)
      let leftFlanking = !sAfter && (!pAfter || sBefore || pBefore)
      let rightFlanking = !sBefore && (!pBefore || sAfter || pAfter)
      let canOpen = leftFlanking && (next == 42 || !rightFlanking || pBefore)
      let canClose = rightFlanking && (next == 42 || !leftFlanking || pAfter)

      // 3. Add the delimiter to cx.parts
      return cx.append(new InlineDelimiter(
        next == 95 ? EmphasisUnderscore : EmphasisAsterisk,
        start, pos,
        (canOpen ? Mark.Open : 0) | (canClose ? Mark.Close : 0)
      ))
    },
    before: "Emphasis" 
  }]
}

export const IncompleteEmp = IncompleteEmphasis

function resolveIncompleteEmphasis(this: any, from: number) {
  // 1. Locate all Emphasis delimiters in the current scope (from `from` to end)
  let delims: InlineDelimiter[] = []
  
  for (let i = from; i < this.parts.length; i++) {
    let part = this.parts[i]
    if (part instanceof InlineDelimiter && 
       (part.type == EmphasisUnderscore || part.type == EmphasisAsterisk)) {
      delims.push(part)
    }
  }

  // 2. If no emphasis delimiters, just delegate to original resolver
  if (delims.length == 0) {
    return this.originalResolveMarkers(from)
  }

  // 3. Run the matching algorithm
  let effectiveEnd = this.end
  let segments = collectSegments(delims, effectiveEnd)

  // 4. Build the tree of elements
  let elements = buildTree(segments, this)

  // 5. Replace the delimiters in `this.parts` with the resulting elements, enriched with content
  let emphasisDelims = new Set(delims);
  
  // Helper to fill element children with parts
  function enrichElementWithParts(elt: Element, cx: any) {
     let newChildren: (Element | any)[] = []
     let children = ((elt as any).children as Element[]) || []

     let lastPos = elt.from
     
     for (let child of children) {
        appendParts(newChildren, lastPos, child.from, cx)
        if (child.type !== (cx as any).parser.getNodeType("EmphasisMark").id) {
           enrichElementWithParts(child, cx)
        }
        newChildren.push(child)
        lastPos = child.to
     }
     
     appendParts(newChildren, lastPos, elt.to, cx)
     ;(elt as any).children = newChildren
  }
  
  function appendParts(target: any[], from: number, to: number, cx: any) {
     for (let part of cx.parts) {
       if (!part) continue
       if (part.from >= from && part.to <= to) {
         if (emphasisDelims.has(part as any)) continue
         target.push(part)
       }
     }
  }

  let cx_ = this
  elements.forEach(e => enrichElementWithParts(e, cx_))
  
  let newParts: any[] = []
  let partIdx = from 
  
  elements.sort((a, b) => a.from - b.from)
  
  let currentElementIdx = 0
  
  while (partIdx < this.parts.length) {
     let part = this.parts[partIdx]
     if (!part) { partIdx++; continue }
     
     if (emphasisDelims.has(part as any)) {
       partIdx++
       continue
     }
     
     while (currentElementIdx < elements.length) {
       let elt = elements[currentElementIdx]
       if (elt.from <= part.from) {
         newParts.push(elt)
         currentElementIdx++
       } else {
         break
       }
     }
     
     let inside = false
     if (newParts.length > 0) {
        let last = newParts[newParts.length - 1]
        if (last instanceof Element) {
           let name = (this as any).parser.nodeSet.types[last.type].name
           if (name == "Emphasis" || name == "StrongEmphasis") {
              if (part.from >= last.from && part.to <= last.to) {
                inside = true
              }
           }
        }
     }
     
     if (!inside) {
        newParts.push(part)
     }
     
     partIdx++
  }
  
  while (currentElementIdx < elements.length) {
    newParts.push(elements[currentElementIdx++])
  }
  
  let kept = this.parts.slice(0, from)
  this.parts = kept.concat(newParts)
  
  return this.originalResolveMarkers(from)
}

function collectSegments(delims: InlineDelimiter[], blockEnd: number): Segment[] {
  let segments: Segment[] = []
  let parts = delims.map(d => new InlineDelimiter(d.type, d.from, d.to, d.side))

  for (let i = 0; i < parts.length; i++) {
    let close = parts[i]
    if (!close || !(close.side & Mark.Close)) continue
    let closeSize = close.to - close.from
    if (closeSize == 0) continue

    let openIdx = -1
    for (let j = i - 1; j >= 0; j--) {
      let open = parts[j]
      if (!open || !(open.side & Mark.Open) || open.type != close.type) continue
      let openSize = open.to - open.from
      if (openSize == 0) continue

      let size = Math.min(2, openSize, closeSize)
      if (size == 1 && (openSize == 2 || closeSize == 2)) continue
      if ((open.side & Mark.Close || close.side & Mark.Open) &&
          (openSize + closeSize) % 3 == 0 && (openSize % 3 || closeSize % 3)) continue

      openIdx = j
      break
    }

    if (openIdx == -1) continue

    let open = parts[openIdx]
    let openSize = open.to - open.from
    let size = Math.min(2, openSize, closeSize)
    let type = size == 1 ? "Emphasis" : "StrongEmphasis"
    let start = open.to - size
    let end = close.from + size

    segments.push({
      type, from: start, to: end,
      markSizeOpen: size,
      markSizeClose: size
    })

    let remainingOpen = openSize - size
    if (remainingOpen > 0) {
      open.to = start
      // Keep from as is, the delimiter shrinks from the right
      if (open.to <= open.from) parts[openIdx] = null!
    } else {
      parts[openIdx] = null!
    }

    let remainingClose = closeSize - size
    if (remainingClose > 0) {
      close.from = end
      // Keep to as is, the delimiter shrinks from the left
      if (close.to <= close.from) parts[i] = null!
      else i--
    } else {
      parts[i] = null!
    }
  }

  for (let d of parts) {
    if (!d || !(d.side & Mark.Open)) continue
    let remaining = d.to - d.from
    while (remaining > 0) {
      let size = remaining >= 2 ? 2 : 1
      let type = size == 1 ? "Emphasis" : "StrongEmphasis"
      segments.push({
        type, from: d.to - remaining, to: blockEnd,
        markSizeOpen: size,
        markSizeClose: 0
      })
      remaining -= size
    }
  }
  return segments
}

function buildTree(segments: (Segment | null)[], cx: InlineContext): Element[] {
  let result: Element[] = []
  segments.sort((a, b) => {
    if (!a || !b) return 0
    return a.from - b.from || b.to - a.to
  })

  let pos = 0
  for (let i = 0; i < segments.length; i++) {
    let s = segments[i]
    if (!s || s.from < pos) continue

    let inner: (Segment | null)[] = []
    for (let j = i + 1; j < segments.length; j++) {
      let other = segments[j]
      if (!other || other.from >= s.to) break

      let contentStart = s.from + s.markSizeOpen
      let contentEnd = s.to - s.markSizeClose

      // Part within content
      if (other.from < contentEnd && other.to > contentStart) {
         let start = Math.max(other.from, contentStart)
         let end = Math.min(other.to, contentEnd)
         if (start < end) {
            inner.push({ 
               ...other, 
               from: start, 
               to: end, 
               markSizeClose: end == other.to ? other.markSizeClose : 0, 
               markSizeOpen: start == other.from ? other.markSizeOpen : 0 
            })
         }
      }
      
      // Part continuing after
      if (other.to > s.to) {
         segments[j] = { ...other, from: s.to, markSizeOpen: 0 }
      } else {
         segments[j] = null
      }
    }

    let children: Element[] = []
    if (s.type !== "EmphasisMark" && s.markSizeOpen > 0)
      children.push(cx.elt("EmphasisMark", s.from, s.from + s.markSizeOpen))
    
    if (inner.length > 0) children.push(...buildTree(inner, cx))
    
    if (s.type !== "EmphasisMark" && s.markSizeClose > 0)
      children.push(cx.elt("EmphasisMark", s.to - s.markSizeClose, s.to))

    result.push(cx.elt(s.type, s.from, s.to, children))
    pos = s.to
  }
  return result
}
