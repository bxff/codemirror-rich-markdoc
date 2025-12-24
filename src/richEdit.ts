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

      // First pass: collect ALL emphasis nodes in the paragraph
      let allEmphasis: { from: number, to: number }[] = [];
      tree.iterate({
        from, to,
        enter(node) {
          if (node.name === 'Emphasis' || node.name === 'StrongEmphasis') {
            allEmphasis.push({ from: node.from, to: node.to });
          }
        }
      });

      // Find connected chains: nodes that share boundaries or overlap
      function findConnected(nodes: { from: number, to: number }[], start: { from: number, to: number }): Set<string> {
        let connected = new Set<string>();
        let queue = [start];
        while (queue.length > 0) {
          let current = queue.shift()!;
          let key = `${current.from}-${current.to}`;
          if (connected.has(key)) continue;
          connected.add(key);
          // Find nodes that share a boundary or overlap with current
          for (let n of nodes) {
            let nKey = `${n.from}-${n.to}`;
            if (connected.has(nKey)) continue;
            // Connected if: boundaries touch, or one contains the other, or they overlap
            if (n.to === current.from || n.from === current.to || // touching
                (n.from <= current.from && n.to >= current.to) || // n contains current
                (current.from <= n.from && current.to >= n.to) || // current contains n
                (n.from < current.to && n.to > current.from)) {   // overlap
              queue.push(n);
            }
          }
        }
        return connected;
      }

      // Find which emphasis node(s) contain the cursor
      let cursorNodes = allEmphasis.filter(n => cursor.from >= n.from && cursor.to <= n.to);
      
      // Build the connected chain for all cursor nodes
      let activeKeys = new Set<string>();
      for (let cn of cursorNodes) {
        let chain = findConnected(allEmphasis, cn);
        for (let k of chain) activeKeys.add(k);
      }
      
      // Convert keys back to ranges
      let activeRanges = Array.from(activeKeys).map(k => {
        let [f, t] = k.split('-').map(Number);
        return { from: f, to: t };
      });

      tree.iterate({
        from, to,
        enter(node) {
          if (node.name === 'MarkdocTag')
            widgets.push(decorationTag.range(node.from, node.to));

          if (node.name === 'FencedCode')
            widgets.push(decorationCode.range(node.from, node.to));

          // Skip hiding for emphasis in active ranges
          if ((node.name.startsWith('ATXHeading') || tokenElement.includes(node.name)) &&
            cursor.from >= node.from && cursor.to <= node.to)
            return false;

          if (node.name === 'ListMark' && node.matchContext(['BulletList', 'ListItem']) &&
            cursor.from != node.from && cursor.from != node.from + 1)
            widgets.push(decorationBullet.range(node.from, node.to));

          if (node.name === 'HeaderMark')
            widgets.push(decorationHidden.range(node.from, node.to + 1));

          if (tokenHidden.includes(node.name)) {
            // Check if this mark belongs to an active emphasis range
            if (node.name === 'EmphasisMark') {
              let parent = node.node.parent;
              if (parent && (parent.name === 'Emphasis' || parent.name === 'StrongEmphasis')) {
                let isActive = activeRanges.some(r => 
                  r.from === parent.from && r.to === parent.to
                );
                if (isActive) return; // Don't hide this mark
              }
            }
            widgets.push(decorationHidden.range(node.from, node.to));
          }
        }
      });
    }

    return Decoration.set(widgets, true);
  }
}

