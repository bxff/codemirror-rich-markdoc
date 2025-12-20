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
            let elements = buildFragmentedTree(segments, 0, cx.end, cx)

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

    // Pass 1: Balanced Pairs (Closer-first)
    for (let i = 0; i < delims.length; i++) {
        let close = delims[i];
        if (!close || !(close.side & Mark.Close)) continue;

        let closeLen = close.to - close.from;
        while (closeLen > 0) {
            let openIdx = -1;
            let size = 0;

            for (let j = i - 1; j >= 0; j--) {
                let open = delims[j];
                if (!open || !(open.side & Mark.Open) || open.type != close.type || (open.to == open.from)) continue;

                let openLen = open.to - open.from;
                let matchSize = (openLen >= 2 && closeLen >= 2) ? 2 : 1;

                if ((open.side & Mark.Close || close.side & Mark.Open) &&
                    (openLen + closeLen) % 3 == 0 && (openLen % 3 || closeLen % 3))
                    continue;

                openIdx = j;
                size = matchSize;
                break;
            }

            if (openIdx == -1) break;

            let open = delims[openIdx];
            segments.push({
                type: size == 1 ? "Emphasis" : "StrongEmphasis",
                from: open.to - size,
                to: close.from + (close.to - close.from - closeLen) + size,
                markSizeOpen: size,
                markSizeClose: size
            });

            // Consume tokens from both
            open.to -= size;
            // Subtract from original closer range so Pass 2 doesn't pick it up
            close.to -= size;
            closeLen -= size;
        }
    }

    // Pass 2: Incomplete Openers
    for (let i = 0; i < delims.length; i++) {
        let d = delims[i];
        while (d && (d.side & Mark.Open) && (d.to > d.from)) {
            let len = d.to - d.from;
            let size = Math.min(2, len);
            segments.push({
                type: size == 1 ? "Emphasis" : "StrongEmphasis",
                from: d.to - size,
                to: blockEnd,
                markSizeOpen: size,
                markSizeClose: 0
            });
            d.to -= size;
        }
    }

    return segments;
}

function buildFragmentedTree(segments: Segment[], from: number, to: number, cx: InlineContext): Element[] {
    let result: Element[] = [];
    segments.sort((a, b) => a.from - b.from || b.to - a.to);

    let pos = from;
    for (let i = 0; i < segments.length; i++) {
        let s = segments[i];
        if (!s || s.from < pos) continue;

        // Boundaries for children: Must be within content range
        let contentStart = s.from + s.markSizeOpen;
        let contentEnd = s.to - s.markSizeClose;

        let inner: Segment[] = [];

        // Find segments that overlap with this node'S WHOLE RANGE [s.from, s.to]
        for (let j = i + 1; j < segments.length; j++) {
            let other = segments[j];
            if (!other || other.from >= s.to) break;

            // Fragment anything that crosses s.to
            if (other.to > s.to) {
                inner.push({ ...other, to: s.to, markSizeClose: 0 });
                segments[j] = { ...other, from: s.to, markSizeOpen: 0 };
            } else {
                inner.push(other);
                segments[j] = null; // Consume
            }
        }

        // Recursively build children
        let innerContent = buildFragmentedTree(inner, contentStart, contentEnd, cx);

        let marks: Element[] = [];
        if (s.markSizeOpen) marks.push(cx.elt("EmphasisMark", s.from, s.from + s.markSizeOpen));
        if (s.markSizeClose) marks.push(cx.elt("EmphasisMark", s.to - s.markSizeClose, s.to));

        result.push(cx.elt(s.type, s.from, s.to, [...marks, ...innerContent]));
        pos = s.to;
    }
    return result;
}
