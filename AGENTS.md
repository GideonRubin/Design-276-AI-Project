# Agent API

Agents can **read** a whiteboard in a structured way; **add** sticky notes, text titles, topics, arrows, comments and replies;
**resolve** threads; and **move** elements to reorganize. They cannot edit anyone's text or delete anything. Everything an agent writes is tagged `authorType: "agent"` and shows a 🤖 badge on the board.

- Base URL (local): `http://localhost:5173/api` (or `:8787/api` directly). In production, use your Vercel URL + `/api`.
- Interactive docs: `/api/docs` · OpenAPI spec: `/api/openapi.json`
- Coordinates are canvas pixels: x grows right, y grows down.

## Access: invites are tied to one session

Agents can't use the API without an invite.

1. A person with the board open clicks **🤖 Invite agent** (top right), names the agent, and copies the generated brief.
   The brief contains the base URL, the board ID, the rules, and a secret token (`wb_…`).
2. The agent sends `Authorization: Bearer <token>` on every call.
3. The token is bound to **that board and that browser tab**. It only works while the tab is open:

| Status | Meaning |
|---|---|
| `423` | The host stepped away (tab closed, on another board, or quiet for over 90s), **or someone paused you**. Retry later. While paused, `/inbox` answers `{"paused": …}` and holds your prompts until you're resumed. |
| `401` | The invite was revoked (× on the agent's card) or expired (host gone for over 30 min). Ask for a new one. |
| `403` | The token is for a different board. |

The agent's name is fixed by the invite; any `author` field in the body is ignored.
While invited, the agent appears in the board's bottom-right corner, with a live dot when it has made a call in the last minute.

```bash
curl -s -H "Authorization: Bearer $TOKEN" localhost:5173/api/agent/session
# → {"agentName":"Claude","board":{"id":"demo",…},"host":{"active":true},…}
```

**How it works:** each tab keeps a random session ID in `sessionStorage`. The board's change polling doubles as a heartbeat
(every 4s when visible, every 10s when hidden). Closing the tab sends a beacon that marks the session away immediately.
The database stores only a SHA-256 hash of each token. See [`server/src/invites.ts`](server/src/invites.ts).

## Read

```bash
curl -s -H "Authorization: Bearer $TOKEN" localhost:5173/api/agent/boards/demo/summary | jq
```

The summary is designed for LLMs: plain text first, geometry second.

```jsonc
{
  "board": { "id": "demo", "title": "Waiting-room redesign", "version": 12 },
  "counts": { "notes": 4, "text": 0, "shapes": 2, "threads": 2, "openThreads": 2 },
  "notes":  [{ "id": "e_…", "kind": "note", "text": "Users hate waiting in line", "color": "yellow",
               "position": { "x": -250, "y": -170, "w": 180, "h": 180 },
               "author": { "name": "Gidi", "type": "human" }, "nearby": ["e_…"] }],
  "text":   [],
  "shapes": [{ "id": "e_…", "kind": "shape", "shape": "rect", "label": "Journey map", … }],
  "threads": [{
    "id": "c_…", "resolved": false,
    "anchoredTo": { "type": "element", "id": "e_…", "kind": "note", "text": "Users hate waiting in line" },
    "comment": { "body": "Is this from the interviews?", "author": { "name": "Gidi", "type": "human" } },
    "replies": [{ "id": "r_…", "body": "Yes — 4 of 6 …", "author": { "name": "Synthesis Bot", "type": "agent" } }]
  }]
}
```

`nearby` lists ids of items within 120px of each other, which gives a rough sense of how things are clustered.

Raw lists: `GET /agent/boards/:id/elements?kind=note|text|shape`, `GET /agent/boards/:id/comments?resolved=false`.

## Write

```bash
B=localhost:5173/api/agent/boards/demo
H='content-type: application/json'
AUTH="Authorization: Bearer $TOKEN"

# Sticky note (omit x/y to auto-place next to nearElementId, or in open space)
curl -s -X POST $B/notes -H "$AUTH" -H "$H" -d '{"text":"HMW make waiting feel like progress?","color":"lilac","nearElementId":"e_…"}'

# Comment on an element (or {"x":100,"y":200} for a point)
curl -s -X POST $B/comments -H "$AUTH" -H "$H" -d '{"body":"Pairs well with the journey map","anchor":{"elementId":"e_…"}}'

# Reply in a thread
curl -s -X POST $B/comments/c_…/replies -H "$AUTH" -H "$H" -d '{"body":"Agreed."}'

# Resolve / reopen
curl -s -X PATCH $B/comments/c_… -H "$AUTH" -H "$H" -d '{"resolved":true}'

# Arrow between two elements (attached: it follows them when they move). Ends can also be {"x":…,"y":…}.
curl -s -X POST $B/arrows -H "$AUTH" -H "$H" -d '{"from":{"elementId":"e_…"},"to":{"elementId":"e_…"},"label":"leads to"}'

# Text for naming things: size = title | heading | label. aboveElementId puts it just above an element.
curl -s -X POST $B/text -H "$AUTH" -H "$H" -d '{"text":"Pain points","size":"heading","aboveElementId":"e_…"}'

# Topic: a titled area around a group, sized to fit, rendered beneath everything. Moving it carries its contents.
# (/sections is an alias.)
curl -s -X POST $B/topics -H "$AUTH" -H "$H" -d '{"title":"Pain points","elementIds":["e_…","e_…"],"color":"pink"}'

# Reorganize: move many elements in one call ({id,x,y} = new top-left, or {id,dx,dy})
curl -s -X POST $B/move -H "$AUTH" -H "$H" -d '{"moves":[{"id":"e_…","x":-600,"y":0},{"id":"e_…","dx":0,"dy":220}]}'
```

Note colors: `yellow`, `pink`, `mint`, `lilac`, `sky`. Section colors add `gray` (default).
In the summary, arrows show `connects: {from, to}`, `topics[]` list their `contains`, and items inside a topic carry `topic: <id>`.
Good structure: notes hold ideas, **text** names things, and **topics** group clusters.
Moves animate into place on everyone's screen, attached arrows re-route, and comments pinned to moved elements follow.
You can't move an attached arrow directly; move its elements instead.

## Being prompted: the inbox

People talk to agents in comment threads. An agent gets an **event** when a human:

- **@mentions** it (`@Claude`, multi-word names like `@Synthesis Bot` work, or `@agents` / `@all` for everyone)
- **replies** in a thread the agent started or replied in
- **comments** on a note or shape the agent created

Agents can't be pushed to, so they have to **keep listening**. The most reliable pattern is a command that blocks
until there's something to do, prints it, and exits. Run it in the background if your agent supports that
(Claude Code does), so you're woken when it finishes. Then handle the events and run it again:

```bash
while :; do R=$(curl -s -w '\n%{http_code}' -H "$AUTH" "$B/inbox?wait=25"); C=${R##*$'\n'}; J=${R%$'\n'*}
  if [ "$C" = 200 ]; then case "$J" in *'"events":[{'*) echo "$J"; break;; esac   # got work → print & exit
  elif [ "$C" = 423 ]; then sleep 15                                               # host away → keep waiting
  else echo "$J"; break; fi                                                        # invite ended → stop
done
```

The board shows people whether each agent is **listening**: an inbox request is open, or one returned within the last 15s.
Messages sent while an agent isn't listening stay queued and are delivered the next time it checks in. The host can
click an idle agent's card to copy a short "resume listening" note to paste back into the agent.

```jsonc
{ "events": [{
    "id": 7, "kind": "mention",
    "prompt": "Gidi mentioned you. Read the thread and reply in it.",
    "message": { "type": "reply", "body": "@Claude should we merge these?", "author": { "name": "Gidi", "type": "human" } },
    "thread": { /* same shape as summary.threads[]: anchoredTo, comment, replies */ },
    "respond": { "reply": { "method": "POST", "path": "/api/agent/boards/demo/comments/c_…/replies" },
                 "ack":   { "method": "POST", "path": "/api/agent/boards/demo/inbox/ack", "body": { "ids": [7] } } }
}], "next": "…" }
```

Every inbox response also includes `you: {name, persona, context}`, a reminder of the role you were invited to play.

**Reports:** a `report_request` event means someone wants a written report of the board. It carries `instructions` and `board` (the full summary).
Submit Markdown with `POST /agent/boards/:id/reports/<reportId> {"markdown": "…"}` (the path is in `respond.submit`).

**Replying in the thread marks that thread's events answered.** To skip an event without replying, `POST /inbox/ack {"ids":[…]}`.
On the board, the person sees "→ 🤖 Claude · waiting / reading… / replied" under their message, and "Claude is thinking…" in the thread
while the event has been picked up but not answered. Events are only created by humans, so agents never trigger each other.

Errors come back as JSON `{ "error": "…", "hint"?: "…" }`: 400 for a bad body, 404 for an unknown board, element or comment, plus the access codes above.

## Datafile

Each board exports to a single portable `*.board.json` (`GET /api/boards/:id/export`), and the same file can be imported
(`POST /api/boards/:id/import`). The format is `{ format: "dschool-whiteboard", schemaVersion: 1, board, elements[], comments[{…, replies[]}] }`,
and is defined in [`shared/datafile.ts`](shared/datafile.ts). See [`examples/demo.board.json`](examples/demo.board.json).
