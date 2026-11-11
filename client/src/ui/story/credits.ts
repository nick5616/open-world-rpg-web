// The credits that roll after the ending (CR 035): the game's own lines,
// then every section of the repository's CREDITS.md (textures, code,
// design, audio), read at build time so they never drift. Pure: parseCredits
// is unit-tested.

import creditsMd from '../../../../CREDITS.md?raw';

export interface CreditBlock {
  heading: string;
  lines: string[];
}

/** Markdown links, emphasis and code ticks to plain text. */
function plain(s: string): string {
  return s
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** CREDITS.md -> blocks: "## X" headings, table rows (first and last cells), bullets and paragraphs. */
export function parseCredits(md: string): CreditBlock[] {
  const out: CreditBlock[] = [];
  let cur: CreditBlock | null = null;
  let para = '';
  const flush = () => {
    if (cur && para.trim()) cur.lines.push(plain(para));
    para = '';
  };
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('<!--')) continue;
    if (line.startsWith('## ')) {
      flush();
      cur = { heading: plain(line.slice(3)), lines: [] };
      out.push(cur);
      continue;
    }
    if (!cur || line.startsWith('# ')) continue;
    if (!line) {
      flush();
      continue;
    }
    if (line.startsWith('|')) {
      flush();
      const cells = line.split('|').map((c) => plain(c)).filter((c) => c);
      if (cells.length === 0 || /^-+$/.test(cells[0]) || cells[0] === 'Set') continue;
      cur.lines.push(cells.length > 2 ? `${cells[0]} — ${cells[cells.length - 1]}` : cells.join(' — '));
      continue;
    }
    if (line.startsWith('- ')) {
      flush();
      cur.lines.push(plain(line.slice(2)));
      continue;
    }
    para += ' ' + line;
  }
  flush();
  return out.filter((b) => b.lines.length > 0);
}

/** The whole roll: the game's lines first. Names and lines are proposals for Nicole. */
export function creditRoll(party: string[]): CreditBlock[] {
  const head: CreditBlock[] = [
    { heading: 'Lodestone', lines: ['The Last Song'] },
    { heading: 'Sung by', lines: party.length ? party : ['You'] },
    { heading: 'A game by', lines: ['Nicole Belovoskey'] },
    { heading: 'Design, direction, worlds and music', lines: ['Nicole Belovoskey'] },
    { heading: 'Built with', lines: ['Claude (Anthropic): code, systems and words, at Nicole\'s direction'] },
  ];
  return [...head, ...parseCredits(creditsMd), { heading: 'Thank you for playing', lines: ['The night will come again. So will you.'] }];
}
