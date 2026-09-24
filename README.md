# DESIGN 276 · Whiteboard

A virtual whiteboard for the d.school: sketchy shapes, tilted sticky notes, and yellow speech-bubble comments with threads.
It also has a structured REST API so AI agents can read the board and contribute alongside humans.

- **Front end:** React + custom SVG/DOM canvas (Vite) in [`client/`](client)
- **Back end:** Hono REST API in [`server/`](server), deployed as one Vercel Function via [`api/index.ts`](api/index.ts)
- **Database:** SQLite locally (a file, no setup needed); Turso (hosted libSQL) in production
- **Shared:** data schemas + datafile format in [`shared/`](shared), used by both sides
- **Agents:** see [`AGENTS.md`](AGENTS.md)

---

## Quick start

```bash
npm install
npm run dev          # web on http://localhost:5173, API on :8787 (proxied under /api)
```

Other scripts:

| Command | What it does |
|---|---|
| `npm test` | API tests (vitest, in-memory database) |
| `npm run typecheck` | TypeScript across client, server and shared |
| `npm run build` | Typecheck + production build to `dist/` |
| `npm run db:migrate` | Create or upgrade tables (runs automatically on first request anyway) |
| `npm run seed -- examples/demo.board.json demo` | Load a datafile into board `demo` |

Local data lives in `data/local.db` (gitignored). Delete it to start fresh.

## Project layout

```
client/                 React app (Vite root)
  index.html
  src/
    main.tsx            routes: /  (onboarding) · /b/:id  (board)
    BoardPage.tsx       loads a board, starts sync, lays out the panels
    onboarding/         three full-screen steps: name → draw yourself → pick board
    canvas/             Canvas.tsx (camera, tools, pointer + keyboard), SelectionOverlay
    elements/           ElementView (notes/text/shapes), Shape (roughjs), Comments (bubbles + tails), Avatar
    panels/             Header, InviteDialog, Toolbar, StyleBar, ThreadPanel, PresenceCorner, ZoomControls
    store/              board.ts (zustand state, undo/redo), sync.ts (autosave + polling)
    lib/                api client, profile (localStorage), Portrait renderer, people cache
    styles/             tokens.css (palette, type, motion), board.css
server/
  src/
    app.ts              Hono app: routes, error handling, /api/docs
    db.ts               libSQL client, migrations, versioned writes, presence
    routes/boards.ts    client routes: snapshot, ops, changes, export/import
    routes/agent.ts     agent routes: summary, notes, comments, replies, resolve
    routes/participants.ts
    invites.ts          agent invite tokens, host-tab heartbeats, auth middleware
    events.ts           agent inbox: who to prompt, long-poll, acks, status for the UI
    reports.ts          agent-written board reports (request, deliver, store)
    summarize.ts        LLM-friendly board summary + note auto-placement
    openapi.ts          OpenAPI 3.1 spec
    dev.ts / migrate.ts / seed.ts
  test/api.test.ts
shared/                 schema.ts (zod), datafile.ts, ids.ts, connectors.ts (attached-arrow routing), sections.ts (topics)
api/index.ts            Vercel entry point (must live at repo root), re-exports server/src/app
examples/               sample .board.json
```

## Deploying to Vercel (free tier)

1. Create a free **Turso** database, either at [turso.tech](https://turso.tech) or through the Vercel Marketplace integration.
2. In the Vercel project, set `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`.
3. Import this repo into Vercel (or run `npx vercel`). [`vercel.json`](vercel.json) already configures the build:
   `vite build` → `dist/`, `/api/*` → the function, everything else → `index.html`.
4. Tables are created automatically on the first request.

Why Turso? Vercel Functions don't keep a writable filesystem between requests, so a local SQLite file can't persist there.
Turso speaks the same SQLite dialect, so the code is identical.

---

## Plan (living document)

Edit this section as decisions change. ✅ = built, 🔜 = ideas for later.

### Context
A d.school course project. The whiteboard should feel design-led (tasteful, a little whimsical, but clear).
Humans draw shapes, add sticky notes and leave threaded comments. AI agents use a REST API to read the board and add
comments, replies and notes. Boards save automatically and can be exported or imported as one JSON datafile.
Everything must run on Vercel's free tier.

### Decisions
- ✅ **Canvas:** custom React + DOM/SVG (no whiteboard SDK) for full control over the look.
  All elements live in one transformed "world" layer, so the stacking order works across shapes and notes.
- ✅ **Stack:** TypeScript everywhere. Hono API as a Vercel Function; libSQL/Turso database; zod schemas in `shared/`.
- ✅ **Boards:** one board per ID.
  - The board step suggests previously used IDs (stored in localStorage).
  - An unknown ID shows "No board called *x*" with **Create it**.
  - **New board** generates a friendly ID like `sunny-otter-42`.
- ✅ **Identity:** full-screen onboarding the first time: **name**, then **draw yourself** in a circle with a random portrait color (🎲 to reroll; Clear to start over).
  Returning visitors are remembered and skip to the board step with "Welcome back".
  Click your card in the bottom-right corner to edit your profile.
- ✅ **Agents (REST only, no MCP for now):**
  - Read everything; add notes, **text titles**, **sections**, **arrows**, comments and replies; resolve threads; **move** elements to reorganize (batch).
  - No editing anyone's text, no deleting.
  - Agent content gets a robot badge and a dashed outline. Moves made by others glide into place.
- ✅ **Prompting agents:**
  - Triggers: @mention an agent (or `@agents`), reply in a thread it's in, or comment on something it made. Each queues an event in its inbox.
  - Agents long-poll `GET /agent/boards/:id/inbox?wait=25`, which returns the full thread and the triggering message; the invite brief tells them to keep this loop running.
  - Replying in the thread marks it answered. The UI shows "→ 🤖 Claude · waiting / reading… / replied" on the message, and "Claude is thinking…" in the thread.
  - The thread composer has one-click **Ask @Agent** chips, and mentions are highlighted.
  - **@ autocomplete:** typing `@` in any comment or reply suggests agents (listening or asleep) and `@agents`. Navigate with ↑/↓, pick with Enter or Tab.
    Mentions match the longest name, so `@Claude Reporter` doesn't also ping `Claude`.
  - **Listening state:** each agent card shows *listening* (an inbox request is open, or one returned within 15s) or *not listening*.
    LLM agents tend to stop polling after their turn ends, which looked like "mentions don't work"; now it's visible, and messages stay queued.
    The invite brief includes a blocking listen command (it exits when there's work, so background-capable agents get woken).
    Agents that aren't listening **fall asleep** in the corner: closed eyes, drifting Zzz, and a badge counting waiting messages.
    Hovering one shows what's waiting and a **wake-up message** to copy and paste back into the agent.
    The message lists the waiting messages and includes the listen command. This tab keeps its own invite tokens in `sessionStorage` for that.
    Other people see who can wake it.
  - Only human actions create events, so agents can't loop on each other. Code: [`server/src/events.ts`](server/src/events.ts).
- ✅ **Topics** (stored as "sections"):
  - A topic is a titled, tinted area (`role: "section"` on a rect). Everything inside it belongs to that topic.
  - Draw one with the Topic tool (B) and type its title, or select items and press **▢ Topic**.
  - Stacking order, bottom to top: sections, then arrows and lines, then everything else.
  - Moving a section (agent `/move` or dragging it by its title) carries whatever sits inside it.
  - People: select items and press **▢ Section** in the style bar. Dragging on a section's background box-selects, and clicking it selects the section.
  - Agents: `POST /topics {title, elementIds}` (alias `/sections`) sizes the frame to fit. `POST /text` adds titles and headings, so labels aren't sticky notes.
    The summary lists `topics[]` with `contains`, and each item carries `topic: <id>`.
- ✅ **Attached arrows:**
  - An arrow can bind each end to an element (`bindings.start/end`), and it re-routes edge-to-edge whenever those elements move.
  - People get this by drawing from or onto an element; agents via `POST /arrows`.
  - The routing lives in shared code ([`shared/connectors.ts`](shared/connectors.ts)), so client and server agree.
  - Arrows and lines always render **underneath** cards, shapes and text (a separate layer); pen strokes stay in normal stacking order.
  - Hand-drawn arrows start and end **exactly where you drag**. An end dropped on an element is pinned to that spot (`bindings.startAt/endAt`) and follows it.
    Agent arrows between elementIds route edge-to-edge.
- ✅ **Agent invites, tied to one session:**
  - **🤖 Invite agent** creates a named invite and a copy-paste brief with a secret token.
  - The token works only for this board, and only while the inviting tab is open.
    Each tab has its own session ID in `sessionStorage` (survives reloads, not closing).
    Polling doubles as the heartbeat; closing the tab sends a "leave" beacon.
  - Responses: host away → `423` (resumes when they return); revoked or expired after 30 min → `401`; wrong board → `403`.
  - Several named agents at once. Each gets a card in the corner (live dot, × to remove, ❚❚/▶ to pause or resume). **Anyone with the board open can remove, pause or resume any agent.**
  - **Paused** agents get `423` on every change, while `/inbox` keeps answering "paused" so they keep listening. Prompts queue up and are delivered on resume.
    The card, the thread indicator and the mention menu all show "paused".
  - **Persona = name:** the invite asks who the agent should be. Pick a simple personality, or **Custom…** to write your own:
    🔍 **Ethnographer** notices what's actually happening, without jumping to fixes.
    ✏️ **Designer** turns a problem into simple ideas to try.
    🧐 **Skeptic** kindly pokes holes and says what would change its mind.
    🧪 **Prototyper** suggests the smallest real test.
    The agent joins as `@Skeptic` (`@Skeptic 2` if one is already there). The personality, plus any extra context, goes into the brief.
    It's stored on the invite and returned to the agent as `you` on every `/session` and `/inbox` call. Edit the personas in [`client/src/lib/personas.ts`](client/src/lib/personas.ts).
  - The database stores only token hashes. Code: [`server/src/invites.ts`](server/src/invites.ts).
  - ⚠️ Human routes are still open (there's no login), so this protects the *agent* API, not the board itself.
- ✅ **No live multi-user.** The client polls every 4s, or every 10s while the tab is hidden (just enough to keep invites and presence alive), to stay within the free tier.

### Sync model
- Local edits mark entities dirty. After 400ms idle, only those are sent: `PATCH /api/boards/:id/ops`. On tab hide, they go via `sendBeacon`.
- Every write bumps the board `version`, and each row records the version it last changed at. Deletes are kept as tombstones.
- Polling calls `GET /changes?since=<version>&pid=<me>&sid=<tab>` and gets back the changed rows, **presence** (people with an open tab on this board) and live **agents**. The call also records this tab's heartbeat.
- Rows with unsent local edits are skipped during a merge, so local wins. A poll response that raced with a save is discarded.
  Agents only ever add rows, so real conflicts are rare.

### Data model
- **Element** (`note | text | shape`): position, size, rotation, z, style `{stroke, fill, color, strokeWidth, fontSize}`, text, points (line/arrow/pen), seed (keeps the roughjs sketchiness stable), author, version, deleted.
- **Comment:** `anchor` is either `{type:"point",x,y}` or `{type:"element",elementId,dx,dy}`. The offset means the tail follows the element when it moves. `bubbleDx/Dy` is where the bubble sits; `resolved`.
- **Reply:** `commentId`, body, author.
- **Participant:** id, name, color, sketch (strokes in a 0–1 square), lastSeenAt, lastBoardId.

### Board features
- ✅ **Tools:** Select V · Hand H or space · then **Sticky note N · Comment C · Topic B** · then Rectangle R · Arrow A · Line L · Text T.
  Ellipse, diamond and pen were removed from the toolbar; existing ones still render.
  Double-click a tool to lock it.
- ✅ **Editing:**
  - Pan with scroll or drag; zoom with pinch or ⌘+scroll.
  - Select by click, shift-click or marquee; move, resize and rotate.
  - Double-click an item to edit its text (shapes get centered labels). **Double-click empty canvas to start a comment** there; inside a topic, the comment is pinned to it.
  - Undo/redo (⌘Z / ⇧⌘Z), duplicate (⌘D), delete, arrow-key nudge, `[` `]` to change stacking order.
    Undo only reverts *your* actions: changes from other people and agents are folded into the history, so undo never deletes an agent's new note.
- ✅ **Style bar:** note colors, ink colors, fill on/off.
  There is **one stroke width** (the thickest), so there's no width picker.
- ✅ **Sticky notes:**
  - Random ±3° tilt that's saved with the note, and a layered soft shadow that lifts on hover.
  - Text auto-shrinks to fit, and new notes drop in with a small bounce.
  - A subtle strip across the top in the **author's portrait color**, or ink for agents.
- ✅ **Comments:**
  - Yellow rounded speech bubbles with a curved tail to the anchor.
  - Draggable; the bubble shows the author's portrait and the reply count.
  - The side thread panel has replies, a resolve/reopen button, and lets you delete your own messages.
  - Resolved threads **disappear** from the canvas entirely, and resolving closes the panel. They stay in the data and in exports.
  - The tail leaves the bubble from its **nearest edge**, measured live, and bubbles don't animate on hover.
  - **Any comment can be selected** (click, shift-click, or box-select) and deleted with ⌫ or the style bar's Delete. Undo restores it along with its replies.
  - Resolved threads **select like elements**: click, shift-click or drag-select, with the same blue ring.
    The style bar then offers **Reopen / Delete**, and ⌫ works too. A resolved thread's panel has 🗑 for anyone. Deleting can be undone, replies included.
- ✅ **Presence corner** (bottom right): sketch-portrait cards in each person's color with their name, plus invited agents.
  It's based on open tabs:
  - **here:** tab visible in the last 15s.
  - **away:** tab open in the background; shown dimmed.
  - **gone:** anything else.
  - Closing or leaving the board sends a goodbye beacon that removes you instantly.
    If the beacon is lost (crash, sleep, some embedded browsers), you drop off within about 15–25s.
    Tabs hidden for more than 4 minutes get about 75s of slack, because browsers throttle them.
  - Each visit has a `run` ID, so a request still in flight when the page closes can't bring someone back.
- ✅ **Export menu:**
  - **Board as PDF:** the whole board, not just the visible part, rendered in the browser with html-to-image and jsPDF (both lazy-loaded), with a title header.
  - **Report by an agent:** pick a connected agent. It gets a `report_request` inbox event with the full summary and instructions
    (overview, then per topic: main points, relationships, open questions; then cross-topic themes and next steps).
    It submits Markdown to `POST /agent/boards/:id/reports/:rid`. The app renders it safely, with Save as PDF, ↓ Markdown and Copy, and a notice tells everyone when it's ready.
  - **Board file** (.board.json).
- ✅ **Header:** "DESIGN 276" brand, editable title, copyable board ID.
  The top-right menu (save status, Invite agent, Export, Import) **collapses** with the chevron; the choice is remembered.
- ✅ **Canvas background:** very subtle warm dot grid that scales with zoom.

### Visual language
- **Colors:**
  - Ink `#1B1B1B` on paper `#FAF7F0`.
  - Accents: marigold, coral, teal, lilac and sky; comment yellow `#FFD84D`.
  - All tokens are in [`client/src/styles/tokens.css`](client/src/styles/tokens.css).
- **Type:** Space Grotesk for the interface; Caveat for notes, labels and comments. Both are self-hosted via `@fontsource`.
- **Shapes:** roughjs at low roughness (hand-drawn but legible). Pen strokes use perfect-freehand.
- **Motion:** short springs (`--spring`) for pop-ins, tool hover wobble, and step transitions.

### Verification checklist
- `npm test`: board CRUD, ops and changes (with deletes), export→import round trip, agent add/comment/reply/resolve, summary anchors, no agent delete/move routes, presence (and leaving).
  Invites: missing or bogus token, invites only from a live tab, token bound to one board with a fixed name, pause/resume/expire on host heartbeat, only the host tab can revoke.
- Manual pass in the browser:
  - onboarding steps
  - unknown ID → Create
  - shapes, notes (tilt, shadow, author strip), comment on a note → thread → reply
  - drag the note → tail follows
  - reload → everything persists
  - agent curl → appears within ~4s with badge
  - second participant → shows in the presence corner
  - undo
  - invite an agent → curl with the token works; leave the board → 423; return → 200; × → 401
  - Ask @Claude in a thread → "reading…" + "thinking…" → the agent's reply appears → "replied"
  - agent draws arrows and moves notes → they glide, arrows re-route; dragging a note by hand also re-routes

### 🔜 Ideas / next steps
- MCP server wrapping the agent API (read_board, add_comment, reply, add_note).
- Live multi-user (WebSockets via a separate host, or Liveblocks/PartyKit) instead of polling.
- Voting dots, frames or sections, image upload (Vercel Blob).
- A built-in "run Claude for me" option: the server calls the Claude API on inbox events, so no external agent loop is needed.
- Per-board access (a share link with a secret, or Stanford SSO).
- Rotated-aware resizing, and grouping.
