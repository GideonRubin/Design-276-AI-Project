import { z } from 'zod'

// ---------- palette ----------

export const INK = '#1B1B1B'
export const PAPER = '#FAF7F0'

export const ACCENTS = {
  marigold: '#FFC83D',
  coral: '#FF6B5B',
  teal: '#1FA59A',
  lilac: '#9C84F5',
  sky: '#4DA8F0',
} as const

/** Portrait inks: the accents, darkened slightly so strokes read on paper. */
export const PORTRAIT_COLORS = ['#F2A900', '#FF5A47', '#1FA59A', '#8B6CF0', '#3A96E0', '#E0559A'] as const

export const NOTE_COLORS = {
  yellow: '#FFE58A',
  pink: '#FFC1BA',
  mint: '#B8EBD9',
  lilac: '#DCD2FF',
  sky: '#BFE1FF',
} as const
export type NoteColor = keyof typeof NOTE_COLORS

/** Section tints (soft backgrounds behind groups). */
export const SECTION_COLORS = {
  gray: '#EFEBE1',
  yellow: '#FFF3C4',
  pink: '#FFE3DF',
  mint: '#DDF4EC',
  lilac: '#ECE6FF',
  sky: '#DDEEFC',
} as const
export type SectionColor = keyof typeof SECTION_COLORS

// ---------- primitives ----------

export const AuthorType = z.enum(['human', 'agent'])
export type AuthorType = z.infer<typeof AuthorType>

const Author = {
  authorId: z.string().nullable().default(null),
  authorName: z.string().default('Someone'),
  authorType: AuthorType.default('human'),
}

export const ShapeKind = z.enum(['rect', 'ellipse', 'diamond', 'line', 'arrow', 'pen'])
export type ShapeKind = z.infer<typeof ShapeKind>

export const ElementKind = z.enum(['shape', 'text', 'note'])
export type ElementKind = z.infer<typeof ElementKind>

export const Point = z.tuple([z.number(), z.number()])
export type Point = z.infer<typeof Point>

export const Style = z.object({
  stroke: z.string().default(INK),
  fill: z.string().nullable().default(null),
  color: z.string().nullable().default(null), // note color key / text color
  strokeWidth: z.number().default(4),
  fontSize: z.number().nullable().default(null),
})
export type Style = z.infer<typeof Style>

// ---------- entities ----------

export const Element = z.object({
  id: z.string().min(1),
  kind: ElementKind,
  shape: ShapeKind.nullable().default(null),
  x: z.number(),
  y: z.number(),
  w: z.number().default(0),
  h: z.number().default(0),
  rotation: z.number().default(0),
  z: z.number().default(0),
  style: Style.default(Style.parse({})),
  text: z.string().default(''),
  /** For line/arrow/pen: points relative to (x, y). */
  points: z.array(Point).default([]),
  seed: z.number().int().default(1),
  /** 'section': a titled frame drawn around a group; it sits beneath everything and carries its contents when moved. */
  role: z.enum(['section']).nullable().default(null),
  /** Arrows/lines: ids of the elements each end is attached to (the arrow follows them). */
  bindings: z
    .object({
      start: z.string().nullable().default(null),
      end: z.string().nullable().default(null),
      /** Where on the element each end is pinned (offset from its top-left). null = route edge-to-edge. */
      startAt: Point.nullable().default(null),
      endAt: Point.nullable().default(null),
    })
    .default({ start: null, end: null, startAt: null, endAt: null }),
  ...Author,
  createdAt: z.number().default(() => Date.now()),
  updatedAt: z.number().default(() => Date.now()),
  version: z.number().int().default(0),
  deleted: z.boolean().default(false),
})
export type Element = z.infer<typeof Element>

export const Anchor = z.discriminatedUnion('type', [
  z.object({ type: z.literal('point'), x: z.number(), y: z.number() }),
  z.object({
    type: z.literal('element'),
    elementId: z.string(),
    /** Offset from the element's top-left, so the tail follows it when it moves. */
    dx: z.number(),
    dy: z.number(),
  }),
])
export type Anchor = z.infer<typeof Anchor>

export const Reply = z.object({
  id: z.string().min(1),
  commentId: z.string().min(1),
  body: z.string().min(1),
  ...Author,
  createdAt: z.number().default(() => Date.now()),
  version: z.number().int().default(0),
  deleted: z.boolean().default(false),
})
export type Reply = z.infer<typeof Reply>

export const Comment = z.object({
  id: z.string().min(1),
  anchor: Anchor,
  /** Where the bubble itself sits, relative to the anchor point. */
  bubbleDx: z.number().default(36),
  bubbleDy: z.number().default(-64),
  body: z.string().min(1),
  resolved: z.boolean().default(false),
  ...Author,
  createdAt: z.number().default(() => Date.now()),
  updatedAt: z.number().default(() => Date.now()),
  version: z.number().int().default(0),
  deleted: z.boolean().default(false),
})
export type Comment = z.infer<typeof Comment>

export const Board = z.object({
  id: z.string(),
  title: z.string().default('Untitled wall'),
  createdAt: z.number().default(() => Date.now()),
  version: z.number().int().default(0),
})
export type Board = z.infer<typeof Board>

/** A stroke is a list of [x, y, pressure] in a 0..1 unit square. */
export const Stroke = z.array(z.tuple([z.number(), z.number(), z.number()]))
export type Stroke = z.infer<typeof Stroke>

export const Participant = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(40),
  color: z.string(),
  sketch: z.array(Stroke).max(200),
  lastSeenAt: z.number().default(0),
  lastBoardId: z.string().nullable().default(null),
})
export type Participant = z.infer<typeof Participant>

export type PresenceEntry = Pick<Participant, 'id' | 'name' | 'color' | 'sketch' | 'lastSeenAt'> & {
  /** Tab open but in the background. */
  away: boolean
}

// ---------- sync ----------

export const Op = z.union([
  z.object({ entity: z.literal('element'), op: z.literal('upsert'), data: Element }),
  z.object({ entity: z.literal('comment'), op: z.literal('upsert'), data: Comment }),
  z.object({ entity: z.literal('reply'), op: z.literal('upsert'), data: Reply }),
  z.object({ entity: z.literal('board'), op: z.literal('upsert'), data: z.object({ title: z.string() }) }),
  z.object({ entity: z.enum(['element', 'comment', 'reply']), op: z.literal('delete'), id: z.string() }),
])
export type Op = z.infer<typeof Op>

export const OpsBody = z.object({ ops: z.array(Op).max(500) })

export interface BoardSnapshot {
  board: Board
  elements: Element[]
  comments: Comment[]
  replies: Reply[]
}

/** An invited agent whose host tab is currently open. */
export interface AgentPresence {
  id: string
  agentName: string
  hostPid: string
  createdAt: number
  lastUsedAt: number | null
  /** Has an inbox request open (or just did): @mentions will reach it right away. */
  listening: boolean
  /** The role it was invited to play, e.g. "Devil's advocate". */
  persona: string | null
  /** Paused by someone on the board: it can't act and gets no prompts until resumed. */
  paused: boolean
  pausedBy: string | null
}

/** A human message that prompted an agent, and whether the agent has picked it up / answered. */
export interface PromptStatus {
  inviteId: string
  agentName: string
  commentId: string
  /** '' when the prompt was the thread's first comment. */
  replyId: string
  status: 'queued' | 'seen' | 'answered'
  at: number
}

/** A board report an agent was asked to write. */
export interface ReportInfo {
  id: string
  agentName: string
  inviteId: string
  requestedBy: string
  status: 'requested' | 'writing' | 'ready'
  createdAt: number
  completedAt: number | null
}

export interface ChangesResponse extends BoardSnapshot {
  presence: PresenceEntry[]
  agents: AgentPresence[]
  prompts: PromptStatus[]
  reports: ReportInfo[]
}
