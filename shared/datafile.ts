import { z } from 'zod'
import { Board, Comment, Element, Reply, type BoardSnapshot } from './schema.js'

export const DATAFILE_FORMAT = 'dschool-whiteboard'
export const DATAFILE_VERSION = 1

const FileComment = Comment.extend({ replies: z.array(Reply).default([]) })

export const Datafile = z.object({
  format: z.literal(DATAFILE_FORMAT),
  schemaVersion: z.literal(DATAFILE_VERSION),
  exportedAt: z.number().optional(),
  board: Board.pick({ id: true, title: true, createdAt: true }).partial({ createdAt: true }),
  elements: z.array(Element).default([]),
  comments: z.array(FileComment).default([]),
})
export type Datafile = z.infer<typeof Datafile>

/** Live snapshot → portable file. Tombstones are dropped; versions are reset on import. */
export function toDatafile(snap: BoardSnapshot): Datafile {
  const replies = snap.replies.filter((r) => !r.deleted)
  return {
    format: DATAFILE_FORMAT,
    schemaVersion: DATAFILE_VERSION,
    exportedAt: Date.now(),
    board: { id: snap.board.id, title: snap.board.title, createdAt: snap.board.createdAt },
    elements: snap.elements.filter((e) => !e.deleted),
    comments: snap.comments
      .filter((c) => !c.deleted)
      .map((c) => ({ ...c, replies: replies.filter((r) => r.commentId === c.id) })),
  }
}

export function parseDatafile(input: unknown): { ok: true; file: Datafile } | { ok: false; error: string } {
  const res = Datafile.safeParse(input)
  if (res.success) return { ok: true, file: res.data }
  return { ok: false, error: z.prettifyError(res.error) }
}
