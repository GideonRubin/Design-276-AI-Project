import { useBoard } from '../store/board'
import { anchorPoint } from '../elements/Comments'
import { rectOf, unionRect, type Rect } from '../elements/geometry'

const PAD = 80
const MAX_SIDE_PX = 9000 // keep the canvas within browser limits on huge boards
const BUBBLE = { w: 250, h: 90 }

/** Everything that's drawn: elements plus visible comment bubbles. */
function contentBounds(): Rect | null {
  const s = useBoard.getState()
  const rects: Rect[] = Object.values(s.elements).map(rectOf)
  for (const c of Object.values(s.comments)) {
    if (c.resolved && !s.showResolved) continue
    const a = anchorPoint(c, s.elements)
    if (!a) continue
    rects.push({ x: a.x, y: a.y, w: 1, h: 1 }, { x: a.x + c.bubbleDx, y: a.y + c.bubbleDy, ...BUBBLE })
  }
  return unionRect(rects)
}

/** Let React repaint before capturing. Falls back to a timeout because hidden tabs don't run rAF. */
const nextFrame = () =>
  new Promise<void>((r) => {
    const done = () => r()
    requestAnimationFrame(() => requestAnimationFrame(done))
    setTimeout(done, 80)
  })

/** Render the whole board (not just what's on screen) to a PNG. */
export async function renderBoardImage(): Promise<{ png: string; width: number; height: number }> {
  const { toPng } = await import('html-to-image')
  const s = useBoard.getState()
  const world = document.querySelector<HTMLElement>('.world')
  const bounds = contentBounds()
  if (!world || !s.board) throw new Error('Board not ready')
  if (!bounds) throw new Error('The board is empty')

  // Clean capture: no selection handles, editors or open drafts.
  const saved = { selection: s.selection, commentSelection: s.commentSelection, editingId: s.editingId }
  useBoard.setState({ selection: [], commentSelection: [], editingId: null, draftComment: null })
  await nextFrame()

  try {
    const width = Math.ceil(bounds.w + PAD * 2)
    const height = Math.ceil(bounds.h + PAD * 2)
    const pixelRatio = Math.max(0.5, Math.min(2, MAX_SIDE_PX / Math.max(width, height)))
    const png = await toPng(world, {
      width,
      height,
      pixelRatio,
      backgroundColor: '#FAF7F0',
      style: {
        transform: `translate(${PAD - bounds.x}px, ${PAD - bounds.y}px)`,
        transformOrigin: '0 0',
      },
      filter: (node) => !(node instanceof HTMLElement && (node.classList.contains('selection') || node.classList.contains('marquee'))),
    })
    return { png, width, height }
  } finally {
    useBoard.setState(saved)
  }
}

/** The whole board as a PDF download, with a small title header. */
export async function exportBoardPdf(): Promise<void> {
  const [{ jsPDF }, { png, width, height }] = await Promise.all([import('jspdf'), renderBoardImage()])
  const s = useBoard.getState()
  if (!s.board) return
  const header = 56
  const pdf = new jsPDF({
    orientation: width >= height ? 'landscape' : 'portrait',
    unit: 'pt',
    format: [width, height + header],
    compress: true,
  })
  pdf.setFillColor('#FAF7F0')
  pdf.rect(0, 0, width, height + header, 'F')
  pdf.setFont('helvetica', 'bold')
  pdf.setFontSize(20)
  pdf.setTextColor('#1B1B1B')
  pdf.text(s.board.title || 'Untitled wall', PAD / 2, 36)
  pdf.setFont('helvetica', 'normal')
  pdf.setFontSize(11)
  pdf.setTextColor('#8A857A')
  const stamp = new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  pdf.text(`DESIGN 276 · #${s.board.id} · ${stamp}`, width - PAD / 2, 36, { align: 'right' })
  pdf.addImage(png, 'PNG', 0, header, width, height, undefined, 'FAST')
  pdf.save(`${s.board.id}.pdf`)
}
