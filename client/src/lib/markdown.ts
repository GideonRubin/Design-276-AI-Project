/**
 * A small, safe Markdown → HTML renderer for agent-written reports.
 * Everything is HTML-escaped first; only the formatting below is produced.
 * Supports: #/##/### headings, paragraphs, - / * / 1. lists, > quotes, **bold**, *italic* / _italic_, `code`, ---.
 */
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function inline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/(^|\W)_([^_\s][^_]*)_(?=\W|$)/g, '$1<em>$2</em>')
}

export function renderMarkdown(md: string): string {
  const out: string[] = []
  let list: 'ul' | 'ol' | null = null
  let para: string[] = []
  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`)
    para = []
  }
  const closeList = () => {
    if (list) out.push(`</${list}>`)
    list = null
  }
  for (const raw of md.replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd()
    let m: RegExpMatchArray | null
    if (!line.trim()) {
      flushPara()
      closeList()
    } else if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
      flushPara()
      closeList()
      out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`)
    } else if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      flushPara()
      closeList()
      out.push('<hr/>')
    } else if ((m = line.match(/^\s*[-*]\s+(.*)$/)) || (m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flushPara()
      const kind = /^\s*\d/.test(line) ? 'ol' : 'ul'
      if (list !== kind) {
        closeList()
        out.push(`<${kind}>`)
        list = kind
      }
      out.push(`<li>${inline(m[1])}</li>`)
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      flushPara()
      closeList()
      out.push(`<blockquote>${inline(m[1])}</blockquote>`)
    } else {
      closeList()
      para.push(line.trim())
    }
  }
  flushPara()
  closeList()
  return out.join('\n')
}
