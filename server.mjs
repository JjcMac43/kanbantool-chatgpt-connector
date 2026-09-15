import 'dotenv/config';
import http from 'node:http';
import crypto from 'node:crypto';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import * as z from 'zod/v4';
import { KanbanToolClient } from './lib/kanban.mjs';

const PORT = Number(process.env.PORT || 3000);
const CONNECTOR_AUTH_TOKEN = String(process.env.CONNECTOR_AUTH_TOKEN || '').trim();

function client() {
  return new KanbanToolClient({
    domain: process.env.KANBAN_DOMAIN,
    token: process.env.KANBAN_API_TOKEN,
    defaultBoardId: process.env.KANBAN_DEFAULT_BOARD_ID
  });
}

function result(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data
  };
}

function errorResult(err) {
  const payload = {
    error: err?.message || String(err),
    ...(err?.details ? { details: err.details } : {})
  };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload
  };
}

const boardSelector = z.string().optional().describe('Board name or numeric board ID. Omit to use KANBAN_DEFAULT_BOARD_ID.');
const taskSelector = z.union([z.string(), z.number()]).describe('Exact task/card ID or task name. Names are used only when uniquely resolvable; ambiguous names will not be modified.');

function buildMcpServer() {
  const server = new McpServer(
    { name: 'signarama-kanbantool', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions: 'Use this server to read and manage the Signarama KanbanTool board. Prefer task IDs after reading a queue. Never guess when a task, board, stage, swimlane, or assignee is ambiguous.'
    }
  );

  server.registerTool('list_boards', {
    description: 'List KanbanTool boards available to the connected account and the create/read/update/delete/move permissions for each board.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  }, async () => {
    try { return result(await client().listBoards()); } catch (e) { return errorResult(e); }
  });

  server.registerTool('get_board_structure', {
    description: 'Get workflow stage/column names, swimlanes, collaborators/assignees, card types, and IDs for one board. Use this before writes when names are uncertain.',
    inputSchema: z.object({ board: boardSelector }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  }, async ({ board }) => {
    try { return result(await client().structure(board)); } catch (e) { return errorResult(e); }
  });

  server.registerTool('list_boxes', {
    description: 'List active boxes/cards on a board, optionally filtered by workflow stage/column and/or assignee. Parent stage names include child stages by default.',
    inputSchema: z.object({
      board: boardSelector,
      stage: z.string().optional(),
      assignee: z.string().optional(),
      include_child_stages: z.boolean().default(true).optional()
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  }, async ({ board, stage, assignee, include_child_stages }) => {
    try { return result(await client().listTasks({ board, stage, assignee, includeChildStages: include_child_stages ?? true })); } catch (e) { return errorResult(e); }
  });

  server.registerTool('get_design_queue', {
    description: 'Signarama shortcut: list all active boxes/cards in the Design workflow stage, in board position order. Uses KANBAN_DESIGN_STAGE_NAME, defaulting to Design.',
    inputSchema: z.object({ board: boardSelector }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  }, async ({ board }) => {
    try {
      const stage = process.env.KANBAN_DESIGN_STAGE_NAME || 'Design';
      return result(await client().listTasks({ board, stage, includeChildStages: true }));
    } catch (e) { return errorResult(e); }
  });

  server.registerTool('search_boxes', {
    description: 'Search KanbanTool boxes/cards by text and KanbanTool query syntax. Can be limited to a board.',
    inputSchema: z.object({
      query: z.string().default('').optional(),
      board: boardSelector,
      limit: z.number().int().min(1).max(100).default(50).optional()
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  }, async ({ query, board, limit }) => {
    try { return result(await client().searchTasks({ query: query ?? '', board, limit: limit ?? 50 })); } catch (e) { return errorResult(e); }
  });

  server.registerTool('create_box', {
    description: 'Create a new KanbanTool box/card. Human-readable stage, swimlane, assignee, and card type names are resolved to IDs. If a name is ambiguous, no card is created.',
    inputSchema: z.object({
      board: boardSelector,
      name: z.string().min(1),
      description: z.string().optional(),
      stage: z.string().optional(),
      swimlane: z.string().optional(),
      assignee: z.string().optional(),
      due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD'),
      priority: z.enum(['low', 'normal', 'high']).default('normal').optional(),
      tags: z.string().optional(),
      card_type: z.string().optional(),
      position: z.number().int().min(1).optional()
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  }, async (args) => {
    try {
      const priorityMap = { low: -1, normal: 0, high: 1 };
      return result(await client().createTask({ ...args, priority: priorityMap[args.priority ?? 'normal'] }));
    } catch (e) { return errorResult(e); }
  });

  server.registerTool('move_box', {
    description: 'Move/reorder a KanbanTool box/card to a workflow stage/column, swimlane, or position. This is the main tool for commands like “move ABC to Production” or “put it at the top of Design”.',
    inputSchema: z.object({
      board: boardSelector,
      task_id_or_name: taskSelector,
      target_stage: z.string().optional(),
      target_swimlane: z.string().optional(),
      position: z.number().int().min(1).optional().describe('1 puts the box at the top of its destination cell.')
    }).refine((v) => v.target_stage || v.target_swimlane || v.position, { message: 'Provide target_stage, target_swimlane, or position.' }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  }, async (args) => {
    try { return result(await client().moveTask(args)); } catch (e) { return errorResult(e); }
  });

  server.registerTool('update_box', {
    description: 'Edit fields on an existing KanbanTool box/card: title, description, assignee, due date, priority, tags, or card type. Use move_box for workflow position changes.',
    inputSchema: z.object({
      board: boardSelector,
      task_id_or_name: taskSelector,
      name: z.string().min(1).optional(),
      description: z.string().optional(),
      assignee: z.string().optional(),
      clear_assignee: z.boolean().default(false).optional(),
      due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      clear_due_date: z.boolean().default(false).optional(),
      priority: z.enum(['low', 'normal', 'high']).optional(),
      tags: z.string().optional(),
      card_type: z.string().optional()
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  }, async (args) => {
    try {
      const priorityMap = { low: -1, normal: 0, high: 1 };
      return result(await client().updateTask({ ...args, priority: args.priority == null ? undefined : priorityMap[args.priority] }));
    } catch (e) { return errorResult(e); }
  });

  server.registerTool('add_box_comment', {
    description: 'Add a comment to an existing KanbanTool box/card.',
    inputSchema: z.object({ board: boardSelector, task_id_or_name: taskSelector, content: z.string().min(1) }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  }, async (args) => {
    try { return result(await client().addComment(args)); } catch (e) { return errorResult(e); }
  });

  server.registerTool('archive_box', {
    description: 'Archive a KanbanTool box/card. This removes it from the active board without deleting it. Use only when the user explicitly asks to archive/close it.',
    inputSchema: z.object({ board: boardSelector, task_id_or_name: taskSelector }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
  }, async (args) => {
    try { return result(await client().archiveTask(args)); } catch (e) { return errorResult(e); }
  });

  return server;
}

const mcpHandler = createMcpHandler(buildMcpServer);
const nodeMcpHandler = toNodeHandler(mcpHandler);

function secureEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function authorized(req) {
  if (!CONNECTOR_AUTH_TOKEN) return true;
  const header = String(req.headers.authorization || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  return Boolean(match && secureEqual(match[1], CONNECTOR_AUTH_TOKEN));
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'signarama-kanbantool-mcp' }));
    return;
  }

  if (url.pathname !== '/mcp') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  if (!authorized(req)) {
    res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer realm="kanbantool-mcp"' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  return nodeMcpHandler(req, res);
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Signarama KanbanTool MCP listening on :${PORT}`);
  console.log(`MCP endpoint: /mcp | health: /health | auth: ${CONNECTOR_AUTH_TOKEN ? 'bearer token required' : 'NONE (set CONNECTOR_AUTH_TOKEN before public deployment)'}`);
});

async function shutdown() {
  try { await mcpHandler.close?.(); } catch {}
  httpServer.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
