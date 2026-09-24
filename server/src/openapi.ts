const author = { type: 'string', description: 'Ignored: the agent name comes from the invite.' }
const boardId = { name: 'id', in: 'path', required: true, schema: { type: 'string' }, example: 'sunny-otter-42' }
const cid = { name: 'cid', in: 'path', required: true, schema: { type: 'string' } }
const json = (schema: object) => ({ required: true, content: { 'application/json': { schema } } })
const ok = (description: string) => ({ description, content: { 'application/json': { schema: { type: 'object' } } } })

export const openapi = {
  openapi: '3.1.0',
  info: {
    title: 'Wall · Agent API',
    version: '1.0.0',
    description:
      'Read a whiteboard in a structured way and add sticky notes, comments and replies. ' +
      'Agents can add notes, arrows, comments and replies, resolve threads, and move elements; they cannot edit text or delete. Everything an agent writes is tagged authorType="agent" and shows a robot badge on the board.\n\n' +
      '**Access is by invite.** A person with the board open clicks "Invite agent" and hands the agent a token. Send it as `Authorization: Bearer <token>`. ' +
      'The token works only for that board, and only while the inviting tab is open: 423 = host stepped away (retry later), 401 = invite revoked/expired, 403 = wrong board.',
  },
  components: { securitySchemes: { invite: { type: 'http', scheme: 'bearer', description: 'Invite token (wb_…) from the board\'s "Invite agent" dialog' } } },
  security: [{ invite: [] }],
  servers: [{ url: '/api' }],
  tags: [{ name: 'Agent' }, { name: 'Boards' }],
  paths: {
    '/agent/session': {
      get: {
        tags: ['Agent'],
        summary: 'Who am I? Board, agent name, and whether the host is present',
        description: 'Works even while the host is away, so you can tell "paused" (host.active=false) from "invalid" (401).',
        responses: { 200: ok('Session info'), 401: ok('Invalid or revoked invite') },
      },
    },
    '/agent/boards/{id}/summary': {
      get: {
        tags: ['Agent'],
        summary: 'Structured, LLM-friendly view of the whole board',
        description:
          'Notes, text, shapes (with labels), and comment threads with what each is anchored to. Each item lists `nearby` item ids (within 120px) as a clustering hint.',
        parameters: [boardId],
        responses: { 200: ok('Board summary'), 404: ok('Board not found') },
      },
    },
    '/agent/boards/{id}/elements': {
      get: {
        tags: ['Agent'],
        summary: 'Raw list of elements',
        parameters: [boardId, { name: 'kind', in: 'query', schema: { type: 'string', enum: ['note', 'text', 'shape'] } }],
        responses: { 200: ok('Elements') },
      },
    },
    '/agent/boards/{id}/comments': {
      get: {
        tags: ['Agent'],
        summary: 'Comment threads with replies',
        parameters: [boardId, { name: 'resolved', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } }],
        responses: { 200: ok('Comments') },
      },
      post: {
        tags: ['Agent'],
        summary: 'Start a comment thread on an element or a point',
        parameters: [boardId],
        requestBody: json({
          type: 'object',
          required: ['body', 'anchor'],
          properties: {
            author,
            body: { type: 'string' },
            anchor: {
              oneOf: [
                { type: 'object', required: ['elementId'], properties: { elementId: { type: 'string' }, dx: { type: 'number' }, dy: { type: 'number' } } },
                { type: 'object', required: ['x', 'y'], properties: { x: { type: 'number' }, y: { type: 'number' } } },
              ],
            },
          },
        }),
        responses: { 201: ok('Created comment'), 404: ok('Board or element not found') },
      },
    },
    '/agent/boards/{id}/comments/{cid}': {
      patch: {
        tags: ['Agent'],
        summary: 'Resolve or reopen a thread',
        parameters: [boardId, cid],
        requestBody: json({ type: 'object', required: ['resolved'], properties: { resolved: { type: 'boolean' } } }),
        responses: { 200: ok('Updated comment') },
      },
    },
    '/agent/boards/{id}/comments/{cid}/replies': {
      post: {
        tags: ['Agent'],
        summary: 'Reply in a thread',
        parameters: [boardId, cid],
        requestBody: json({ type: 'object', required: ['body'], properties: { author, body: { type: 'string' } } }),
        responses: { 201: ok('Created reply') },
      },
    },
    '/agent/boards/{id}/notes': {
      post: {
        tags: ['Agent'],
        summary: 'Add a sticky note',
        description: 'Omit x/y to auto-place: next to `nearElementId` if given, otherwise in open space to the right of existing content.',
        parameters: [boardId],
        requestBody: json({
          type: 'object',
          required: ['text'],
          properties: {
            author,
            text: { type: 'string' },
            color: { type: 'string', enum: ['yellow', 'pink', 'mint', 'lilac', 'sky'], default: 'yellow' },
            x: { type: 'number' },
            y: { type: 'number' },
            nearElementId: { type: 'string' },
          },
        }),
        responses: { 201: ok('Created note') },
      },
    },
    '/agent/boards/{id}/inbox': {
      get: {
        tags: ['Agent'],
        summary: 'Prompts for you: @mentions, replies in your threads, comments on your notes',
        description:
          'Long-poll with `?wait=25`: the request stays open until an event arrives (or 25s pass). Each event includes the full thread, the triggering message, and a suggested reply path. Replying in the thread marks its events answered.',
        parameters: [boardId, { name: 'wait', in: 'query', schema: { type: 'integer', minimum: 0, maximum: 25 } }],
        responses: { 200: ok('{ events: [...], next }') },
      },
    },
    '/agent/boards/{id}/inbox/ack': {
      post: {
        tags: ['Agent'],
        summary: 'Mark events handled without replying',
        parameters: [boardId],
        requestBody: json({ type: 'object', required: ['ids'], properties: { ids: { type: 'array', items: { type: 'integer' } } } }),
        responses: { 200: ok('ok') },
      },
    },
    '/agent/boards/{id}/arrows': {
      post: {
        tags: ['Agent'],
        summary: 'Draw an arrow (or line) between elements or points',
        description: 'Ends given as {elementId} attach to that element; the arrow re-routes when it moves.',
        parameters: [boardId],
        requestBody: json({
          type: 'object',
          required: ['from', 'to'],
          properties: {
            from: { oneOf: [{ type: 'object', properties: { elementId: { type: 'string' } } }, { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } }] },
            to: { oneOf: [{ type: 'object', properties: { elementId: { type: 'string' } } }, { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } }] },
            label: { type: 'string' },
            kind: { type: 'string', enum: ['arrow', 'line'], default: 'arrow' },
          },
        }),
        responses: { 201: ok('Created arrow') },
      },
    },
    '/agent/boards/{id}/text': {
      post: {
        tags: ['Agent'],
        summary: 'Add text: a board title, a heading over a cluster, or a label',
        description: 'Use text (not sticky notes) to name things. Omit x/y to auto-place, or give aboveElementId to sit just above an element.',
        parameters: [boardId],
        requestBody: json({
          type: 'object',
          required: ['text'],
          properties: {
            text: { type: 'string' },
            size: { type: 'string', enum: ['title', 'heading', 'label'], default: 'heading' },
            aboveElementId: { type: 'string' },
            x: { type: 'number' },
            y: { type: 'number' },
          },
        }),
        responses: { 201: ok('Created text') },
      },
    },
    '/agent/boards/{id}/sections': {
      post: {
        tags: ['Agent'],
        summary: 'Draw a titled section (rectangle) around a group',
        description:
          'Give elementIds to frame them (sized to fit, with room for the title), or x/y/w/h. Sections render beneath everything; moving a section via /move carries its contents.',
        parameters: [boardId],
        requestBody: json({
          type: 'object',
          properties: {
            title: { type: 'string' },
            elementIds: { type: 'array', items: { type: 'string' } },
            color: { type: 'string', enum: ['gray', 'yellow', 'pink', 'mint', 'lilac', 'sky'], default: 'gray' },
            x: { type: 'number' },
            y: { type: 'number' },
            w: { type: 'number' },
            h: { type: 'number' },
          },
        }),
        responses: { 201: ok('Created section (with contains[])') },
      },
    },
    '/agent/boards/{id}/move': {
      post: {
        tags: ['Agent'],
        summary: 'Move elements to reorganize (batch)',
        description: 'Each move is {id, x, y} (new top-left) or {id, dx, dy}. Moving a section carries its contents. Attached arrows re-route and comments follow. Attached arrows themselves cannot be moved directly.',
        parameters: [boardId],
        requestBody: json({ type: 'object', required: ['moves'], properties: { moves: { type: 'array', maxItems: 200, items: { type: 'object' } } } }),
        responses: { 200: ok('{ moved, reroutedArrows }') },
      },
    },
    '/boards/{id}': { get: { tags: ['Boards'], summary: 'Full board snapshot', parameters: [boardId], responses: { 200: ok('Snapshot') } } },
    '/boards/{id}/export': {
      get: { tags: ['Boards'], summary: 'Download the board as a .board.json datafile', parameters: [boardId], responses: { 200: ok('Datafile') } },
    },
    '/boards/{id}/import': {
      post: {
        tags: ['Boards'],
        summary: 'Replace the board with a .board.json datafile (creates the board if needed)',
        parameters: [boardId],
        requestBody: json({ type: 'object' }),
        responses: { 200: ok('Imported') },
      },
    },
  },
}
