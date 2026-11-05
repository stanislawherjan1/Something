// The editor's schema: only what a markdown file can hold.
//
// BlockNote's defaults include blocks and styles markdown cannot write
// (underline, colours, toggles, audio/video/file embeds); left in, they would
// let a person make something the next save silently throws away. The
// `rawMarkdown` block holds source the converter has no block for (HTML,
// footnotes, …): shown as code, edited as text, written back byte for byte.
import { BlockNoteSchema, createBlockSpec, defaultBlockSpecs, defaultStyleSpecs } from '@blocknote/core';
import { RAW } from './blocks.js';

export const createRawMarkdownBlock = createBlockSpec(
  { type: RAW, propSchema: { source: { default: '' } }, content: 'none' },
  {
    render: (block, editor) => {
      const dom = document.createElement('div');
      dom.className = 'md-raw';
      dom.contentEditable = 'false';
      const label = document.createElement('span');
      label.className = 'md-raw-label';
      label.textContent = 'Markdown source';
      const area = document.createElement('textarea');
      area.className = 'md-raw-source';
      area.spellcheck = false;
      area.value = block.props.source;
      area.readOnly = !editor.isEditable;
      // As tall as its lines, no more (a lone `</details>` is one line).
      const fit = () => { area.rows = Math.max(1, area.value.split('\n').length); };
      fit();
      // Committed when the field is left: an update re-renders the block, which
      // would drop the caret on every keystroke.
      area.addEventListener('change', () => {
        if (area.value !== block.props.source) editor.updateBlock(block, { props: { source: area.value } });
      });
      area.addEventListener('input', fit);
      // Keys typed here belong to the field, not to the editor around it.
      area.addEventListener('keydown', (e) => e.stopPropagation());
      dom.append(label, area);
      return { dom };
    },
  },
);

const { paragraph, heading, quote, codeBlock, bulletListItem, numberedListItem, checkListItem, table, image, divider } = defaultBlockSpecs;
const { bold, italic, strike, code } = defaultStyleSpecs;

export const markdownSchema = BlockNoteSchema.create({
  blockSpecs: {
    paragraph, heading, quote, codeBlock, bulletListItem, numberedListItem, checkListItem, table, image, divider,
    [RAW]: createRawMarkdownBlock(),
  },
  styleSpecs: { bold, italic, strike, code },
});
