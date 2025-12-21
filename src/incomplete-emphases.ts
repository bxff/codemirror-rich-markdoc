import { InlineContext, MarkdownConfig, Element } from "@lezer/markdown"

const Punctuation = /[!"#$%&'()*+,\-.\/:;<=>?@\[\\\]^_`{|}~\xA1\u2010-\u2027]/

const EmphasisUnderscore = { resolve: "Emphasis", mark: "EmphasisMark" }
const EmphasisAsterisk = { resolve: "Emphasis", mark: "EmphasisMark" }

export const IncompleteEmp: MarkdownConfig = {
    parseInline: [{
        name: "IncompleteEmp",
        parse(cx, _next, start) {
            let parts: InlineDelimiter[] = []

            while (start <= cx.end) {
                if (cx.char(start) != 95 && cx.char(start) != 42) { start++; continue }
                let pos = start + 1
                while (cx.char(pos) == cx.char(start)) pos++
                let before = cx.slice(start - 1, start), after = cx.slice(pos, pos + 1)

                let pBefore = Punctuation.test(before), pAfter = Punctuation.test(after)
                let sBefore = /\s|^$/.test(before), sAfter = /\s|^$/.test(after)

                let leftFlanking = !sAfter && (!pAfter || sBefore || pBefore)
                let rightFlanking = !sBefore && (!pBefore || sAfter || pAfter)

                let canOpen = leftFlanking && (cx.char(start) == 42 || !rightFlanking || pBefore)
                let canClose = rightFlanking && (cx.char(start) == 42 || !leftFlanking || pAfter)

                parts.push(new InlineDelimiter(cx.char(start) == 95 ? EmphasisUnderscore : EmphasisAsterisk, start, pos,
                    (canOpen ? Mark.Open : 0) | (canClose ? Mark.Close : 0)))
                start = pos
            }

            let segments = collectSegments(parts, cx.end)
            let elements = buildFragmentedTree(segments, 0, cx)

            elements.sort((a, b) => a.from - b.from || b.to - a.to);
            for (let i = 0; i < elements.length; i++) {
                cx.addElement(elements[i])
            }

            return start
        },
        before: "Emphasis"
    }]
}

const enum Mark { Open = 1, Close = 2 }

interface DelimiterType {
    resolve?: string,
    mark?: string
}

class InlineDelimiter {
    constructor(readonly type: DelimiterType,
        public from: number,
        public to: number,
        public side: Mark) { }
}

interface Segment {
    type: string;
    from: number;
    to: number;
    markSizeOpen: number;
    markSizeClose: number;
}

function collectSegments(parts: InlineDelimiter[], blockEnd: number): Segment[] {
    let segments: Segment[] = [];
    let delims = parts.map(p => new InlineDelimiter(p.type, p.from, p.to, p.side));

    // ATOMIC MATCHING: 
    // Pass 1: Strong (Exactly 2 or 3)
    // Pass 2: Emphasis (Exactly 1 or 3)

    for (let pass = 2; pass >= 1; pass--) {
        for (let i = 0; i < delims.length; i++) {
            let close = delims[i];
            if (!close || !(close.side & Mark.Close)) continue;

            let closeLen = close.to - close.from;
            // Strict check: Only consider matching this close token if it has enough stars
            // AND we don't "steal" from a larger token unless it's a bundle (3).
            if (closeLen < pass) continue;
            if (pass == 1 && closeLen == 2) continue; // Atomic: Bold close won't satisfy italics

            let openIdx = -1;
            for (let j = i - 1; j >= 0; j--) {
                let open = delims[j];
                if (!open || !(open.side & Mark.Open) || open.type != close.type || (open.to == open.from)) continue;

                let openLen = open.to - open.from;
                if (openLen < pass) continue;
                if (pass == 1 && openLen == 2) continue; // Atomic: Bold open won't satisfy italics

                // CommonMark Rule 14 parity check
                if ((open.side & Mark.Close || close.side & Mark.Open) &&
                    (openLen + closeLen) % 3 == 0 && (openLen % 3 || closeLen % 3))
                    continue;

                openIdx = j;
                break;
            }

            if (openIdx != -1) {
                let open = delims[openIdx];
                segments.push({
                    type: pass == 1 ? "Emphasis" : "StrongEmphasis",
                    from: open.to - pass,
                    to: close.from + pass,
                    markSizeOpen: pass,
                    markSizeClose: pass
                });
                open.to -= pass;
                close.from += pass;
                // Re-process this closer if it still has parts left
                i--;
            }
        }
    }

    // Pass 3: All remaining fragments as incomplete
    delims.sort((a, b) => a.from - b.from);
    for (let d of delims) {
        if (!d) continue;
        while (d.to > d.from) {
            let len = d.to - d.from;
            // Still prefer Bold (2) for incomplete if 2+ stars left
            let size = len >= 2 ? 2 : 1;
            segments.push({
                type: size == 1 ? "Emphasis" : "StrongEmphasis",
                from: (d.side & Mark.Open) ? d.to - size : d.from,
                to: blockEnd,
                markSizeOpen: size,
                markSizeClose: 0
            });
            if (d.side & Mark.Open) d.to -= size;
            else d.from += size;
        }
    }

    return segments;
}

function buildFragmentedTree(segments: (Segment | null)[], from: number, cx: InlineContext): Element[] {
    let result: Element[] = [];
    segments.sort((a, b) => {
        if (!a || !b) return 0;
        return a.from - b.from || b.to - a.to;
    });

    let pos = from;
    for (let i = 0; i < segments.length; i++) {
        let s = segments[i];
        if (!s || s.from < pos) continue;

        let inner: (Segment | null)[] = [];
        for (let j = i + 1; j < segments.length; j++) {
            let other = segments[j];
            if (!other || other.from >= s.to) break;

            if (other.to > s.to) {
                inner.push({ ...other, to: s.to, markSizeClose: 0 });
                segments[j] = { ...other, from: s.to, markSizeOpen: 0 };
            } else {
                inner.push(other);
                segments[j] = null;
            }
        }

        if (s.type !== "EmphasisMark") {
            if (s.markSizeOpen) {
                inner.push({ type: "EmphasisMark", from: s.from, to: s.from + s.markSizeOpen, markSizeOpen: 0, markSizeClose: 0 });
            }
            if (s.markSizeClose) {
                inner.push({ type: "EmphasisMark", from: s.to - s.markSizeClose, to: s.to, markSizeOpen: 0, markSizeClose: 0 });
            }
        }

        let innerContent = buildFragmentedTree(inner, s.from, cx);
        result.push(cx.elt(s.type, s.from, s.to, innerContent));
        pos = s.to;
    }
    return result;
}
