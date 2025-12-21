import { Decoration, PluginValue } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';

import type { DecorationSet, EditorView, ViewUpdate } from '@codemirror/view'
import type { Range } from '@codemirror/state';

const tokenElement = [
  'InlineCode',
  'Emphasis',
  'StrongEmphasis',
  'FencedCode',
  'Link',
];

const tokenHidden = [
  'HardBreak',
  'LinkMark',
  'EmphasisMark',
  'CodeMark',
  'CodeInfo',
  'URL',
];

const decorationHidden = Decoration.mark({ class: 'cm-markdoc-hidden' });
const decorationBullet = Decoration.mark({ class: 'cm-markdoc-bullet' });
const decorationCode = Decoration.mark({ class: 'cm-markdoc-code' });
const decorationTag = Decoration.mark({ class: 'cm-markdoc-tag' });

export default class RichEditPlugin implements PluginValue {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = this.process(view);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.viewportChanged || update.selectionSet)
      this.decorations = this.process(update.view);
  }

  process(view: EditorView): DecorationSet {
    let widgets: Range<Decoration>[] = [];
    let [cursor] = view.state.selection.ranges;

    for (let { from, to } of view.visibleRanges) {
      let tree = syntaxTree(view.state);
      let incomplete: { from: number, to: number }[] = [];

      tree.iterate({
        from, to,
        enter(node) {
          if (node.name === 'Paragraph') {
            let paragraphIncomplete = false;
            tree.iterate({
              from: node.from, to: node.to,
              enter(inner) {
                if (inner.name === 'Emphasis' || inner.name === 'StrongEmphasis') {
                  let hasOpen = false;
                  let hasClose = false;
                  let openMark = null;
                  let closeMark = null;
                  for (let cur = inner.node.firstChild; cur; cur = cur.nextSibling) {
                    if (cur.name === 'EmphasisMark') {
                      if (cur.from === inner.from) {
                        hasOpen = true;
                        openMark = cur;
                      }
                      if (cur.to === inner.to) {
                        hasClose = true;
                        closeMark = cur;
                      }
                    }
                  }
                  if (!hasOpen || !hasClose || (openMark && openMark === closeMark)) {
                    paragraphIncomplete = true;
                    return false;
                  }

                  // Fragmented nodes (mismatched mark sizes) are also "incomplete" for visibility purposes
                  if (openMark && closeMark) {
                    let openSize = openMark.to - openMark.from;
                    let closeSize = closeMark.to - closeMark.from;
                    if (openSize !== closeSize) {
                      paragraphIncomplete = true;
                      return false;
                    }
                  }
                }
                return true;
              }
            });
            if (paragraphIncomplete) {
              incomplete.push({ from: node.from, to: node.to });
            }
          }
        }
      });

      tree.iterate({
        from, to,
        enter(node) {
          if (node.name === 'MarkdocTag')
            widgets.push(decorationTag.range(node.from, node.to));

          if (node.name === 'FencedCode')
            widgets.push(decorationCode.range(node.from, node.to));

          if ((node.name.startsWith('ATXHeading') || tokenElement.includes(node.name)) &&
            cursor.from >= node.from && cursor.to <= node.to)
            return false;

          if (node.name === 'ListMark' && node.matchContext(['BulletList', 'ListItem']) &&
            cursor.from != node.from && cursor.from != node.from + 1)
            widgets.push(decorationBullet.range(node.from, node.to));

          if (node.name === 'HeaderMark')
            widgets.push(decorationHidden.range(node.from, node.to + 1));

          if (tokenHidden.includes(node.name)) {
            if (node.name === 'EmphasisMark') {
              let parent = node.node.parent;
              let isAffected = incomplete.some(inc =>
                (node.from >= inc.from && node.to <= inc.to) ||
                (parent && (parent.name === 'Emphasis' || parent.name === 'StrongEmphasis') && (
                  (inc.from >= parent.from && inc.from < parent.to) ||
                  (parent.from >= inc.from && parent.from < inc.to)
                ))
              );
              if (isAffected) return;
            }
            widgets.push(decorationHidden.range(node.from, node.to));
          }
        }
      });
    }

    return Decoration.set(widgets, true);
  }
}

