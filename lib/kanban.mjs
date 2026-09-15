const clean = (value) => String(value ?? '').trim();
const norm = (value) => clean(value).toLowerCase();

export class KanbanToolError extends Error {
  constructor(message, details = undefined) {
    super(message);
    this.name = 'KanbanToolError';
    this.details = details;
  }
}

export class KanbanToolClient {
  constructor({ domain, token, defaultBoardId } = {}) {
    if (!clean(domain)) throw new Error('KANBAN_DOMAIN is required.');
    if (!clean(token)) throw new Error('KANBAN_API_TOKEN is required.');

    let host = clean(domain)
      .replace(/^https?:\/\//i, '')
      .replace(/\/$/, '');
    if (!host.includes('.')) host = `${host}.kanbantool.com`;

    this.host = host;
    this.baseUrl = `https://${host}/api/v3`;
    this.token = clean(token);
    this.defaultBoardId = clean(defaultBoardId) || null;
    this._currentUserCache = null;
    this._boardPreloadCache = new Map();
  }

  async request(method, path, { query, body } = {}) {
    const url = new URL(`${this.baseUrl}/${String(path).replace(/^\//, '')}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
      }
    }

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });

    const text = await response.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = text; }
    }

    if (!response.ok) {
      const detail = typeof data === 'string' ? data : JSON.stringify(data);
      throw new KanbanToolError(
        `KanbanTool API ${method} ${url.pathname} failed (${response.status}).${detail ? ` ${detail}` : ''}`,
        { status: response.status, data }
      );
    }
    return data;
  }

  async currentUser({ refresh = false } = {}) {
    if (!refresh && this._currentUserCache) return this._currentUserCache;
    this._currentUserCache = await this.request('GET', 'users/current.json');
    return this._currentUserCache;
  }

  async listBoards() {
    const user = await this.currentUser();
    return (user.boards ?? []).map((b) => ({
      id: b.id,
      name: b.name,
      folder: b.folder ?? null,
      permissions: b.permissions ?? [],
      last_activity_on: b.last_activity_on ?? null
    }));
  }

  async resolveBoard(selector) {
    const boards = await this.listBoards();
    let raw = clean(selector);
    if (!raw && this.defaultBoardId) raw = this.defaultBoardId;
    if (!raw) {
      if (boards.length === 1) return boards[0];
      throw new KanbanToolError('Board is required because more than one board is accessible.', { boards });
    }

    if (/^\d+$/.test(raw)) {
      const id = Number(raw);
      const found = boards.find((b) => Number(b.id) === id);
      if (!found) throw new KanbanToolError(`Board ID ${id} is not accessible.`, { boards });
      return found;
    }

    const exact = boards.filter((b) => norm(b.name) === norm(raw));
    if (exact.length === 1) return exact[0];
    const partial = boards.filter((b) => norm(b.name).includes(norm(raw)));
    if (partial.length === 1) return partial[0];
    throw new KanbanToolError(`Could not uniquely resolve board "${raw}".`, { matches: partial, boards });
  }

  async preloadBoard(boardSelector, { refresh = false } = {}) {
    const board = await this.resolveBoard(boardSelector);
    const key = String(board.id);
    if (!refresh && this._boardPreloadCache.has(key)) return this._boardPreloadCache.get(key);
    const payload = await this.request('GET', `boards/${board.id}/preload.json`);
    this._boardPreloadCache.set(key, payload);
    return payload;
  }

  async boardDetails(boardSelector) {
    const board = await this.resolveBoard(boardSelector);
    return this.request('GET', `boards/${board.id}.json`);
  }

  ensurePermission(board, permission) {
    const permissions = board.permissions ?? [];
    if (!permissions.includes(permission)) {
      throw new KanbanToolError(`The connected KanbanTool user does not have ${permission} permission on board "${board.name}".`, { permissions });
    }
  }

  _resolveNamed(items, selector, kind, { allowNull = false } = {}) {
    if ((selector === null || selector === undefined || clean(selector) === '') && allowNull) return null;
    const raw = clean(selector);
    if (!raw) throw new KanbanToolError(`${kind} is required.`);
    if (/^\d+$/.test(raw)) {
      const id = Number(raw);
      const match = items.find((x) => Number(x.id) === id);
      if (match) return match;
      throw new KanbanToolError(`${kind} ID ${id} was not found.`, { choices: items.map(({ id, name }) => ({ id, name })) });
    }
    const exact = items.filter((x) => norm(x.name) === norm(raw) || (x.initials && norm(x.initials) === norm(raw)));
    if (exact.length === 1) return exact[0];
    const partial = items.filter((x) => norm(x.name).includes(norm(raw)) || (x.initials && norm(x.initials).includes(norm(raw))));
    if (partial.length === 1) return partial[0];
    throw new KanbanToolError(`Could not uniquely resolve ${kind} "${raw}".`, {
      matches: partial.map(({ id, name, initials }) => ({ id, name, initials })),
      choices: items.map(({ id, name, initials }) => ({ id, name, initials }))
    });
  }

  async resolveStage(boardSelector, stageSelector, { requireLeaf = false } = {}) {
    const board = await this.preloadBoard(boardSelector);
    const stages = board.workflow_stages ?? [];
    const stage = this._resolveNamed(stages, stageSelector, 'workflow stage');
    const children = stages.filter((s) => Number(s.parent_id) === Number(stage.id));
    if (requireLeaf && children.length) {
      throw new KanbanToolError(`"${stage.name}" is a grouped stage. Choose one of its child stages for a move/create action.`, {
        children: children.map(({ id, name }) => ({ id, name }))
      });
    }
    return stage;
  }

  descendantStageIds(stages, rootId) {
    const result = new Set([Number(rootId)]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const stage of stages) {
        if (stage.parent_id != null && result.has(Number(stage.parent_id)) && !result.has(Number(stage.id))) {
          result.add(Number(stage.id));
          changed = true;
        }
      }
    }
    return result;
  }

  async resolveSwimlane(boardSelector, selector) {
    const board = await this.preloadBoard(boardSelector);
    return this._resolveNamed(board.swimlanes ?? [], selector, 'swimlane');
  }

  async resolveAssignee(boardSelector, selector, { allowNull = false } = {}) {
    if (allowNull && (selector === null || selector === undefined || clean(selector) === '')) return null;
    const board = await this.preloadBoard(boardSelector);
    return this._resolveNamed(board.collaborators ?? [], selector, 'assignee', { allowNull });
  }

  async resolveCardType(boardSelector, selector) {
    const board = await this.preloadBoard(boardSelector);
    return this._resolveNamed(board.card_types ?? [], selector, 'card type');
  }

  async resolveTask(boardSelector, taskSelector) {
    const board = await this.resolveBoard(boardSelector);
    const raw = clean(taskSelector);
    if (!raw) throw new KanbanToolError('task_id_or_name is required.');

    if (/^\d+$/.test(raw)) {
      const task = await this.request('GET', `tasks/${Number(raw)}/preload.json`);
      if (Number(task.board_id) !== Number(board.id)) {
        throw new KanbanToolError(`Task ${raw} is not on board "${board.name}".`);
      }
      return task;
    }

    const details = await this.boardDetails(board.id);
    const tasks = (details.tasks ?? []).filter((t) => !t.deleted_at && !t.archived_at);
    const exact = tasks.filter((t) => norm(t.name) === norm(raw));
    if (exact.length === 1) return exact[0];
    const partial = tasks.filter((t) => norm(t.name).includes(norm(raw)));
    if (partial.length === 1) return partial[0];
    throw new KanbanToolError(`Could not uniquely resolve task "${raw}". No write was made.`, {
      matches: partial.slice(0, 20).map(({ id, name }) => ({ id, name }))
    });
  }

  async structure(boardSelector) {
    const summary = await this.resolveBoard(boardSelector);
    const board = await this.preloadBoard(summary.id, { refresh: true });
    return {
      board: { id: summary.id, name: summary.name, permissions: summary.permissions },
      workflow_stages: (board.workflow_stages ?? []).map(({ id, name, parent_id, position, lane_type, archive_enabled }) => ({ id, name, parent_id, position, lane_type, archive_enabled })),
      swimlanes: (board.swimlanes ?? []).map(({ id, name, position }) => ({ id, name, position })),
      collaborators: (board.collaborators ?? []).map(({ id, name, initials, active }) => ({ id, name, initials, active })),
      card_types: (board.card_types ?? []).map(({ id, name, position, is_disabled, color_ref }) => ({ id, name, position, is_disabled, color_ref }))
    };
  }

  _decorateTasks(tasks, board) {
    const stageMap = new Map((board.workflow_stages ?? []).map((x) => [Number(x.id), x.name]));
    const swimlaneMap = new Map((board.swimlanes ?? []).map((x) => [Number(x.id), x.name]));
    const userMap = new Map((board.collaborators ?? []).map((x) => [Number(x.id), x.name]));
    return tasks.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description ?? null,
      stage: stageMap.get(Number(t.workflow_stage_id)) ?? null,
      stage_id: t.workflow_stage_id,
      swimlane: swimlaneMap.get(Number(t.swimlane_id)) ?? null,
      swimlane_id: t.swimlane_id,
      assignee: t.assigned_user_id == null ? null : userMap.get(Number(t.assigned_user_id)) ?? null,
      assigned_user_id: t.assigned_user_id ?? null,
      due_date: t.due_date ?? null,
      priority: t.priority ?? 0,
      tags: t.tags ?? '',
      position: t.position ?? null,
      updated_at: t.updated_at ?? null
    }));
  }

  async listTasks({ board: boardSelector, stage, assignee, includeChildStages = true } = {}) {
    const summary = await this.resolveBoard(boardSelector);
    this.ensurePermission(summary, 'read_tasks');
    const details = await this.boardDetails(summary.id);
    let tasks = (details.tasks ?? []).filter((t) => !t.deleted_at && !t.archived_at);

    if (stage) {
      const resolved = this._resolveNamed(details.workflow_stages ?? [], stage, 'workflow stage');
      const ids = includeChildStages
        ? this.descendantStageIds(details.workflow_stages ?? [], resolved.id)
        : new Set([Number(resolved.id)]);
      tasks = tasks.filter((t) => ids.has(Number(t.workflow_stage_id)));
    }

    if (assignee) {
      const resolved = this._resolveNamed(details.collaborators ?? [], assignee, 'assignee');
      tasks = tasks.filter((t) => Number(t.assigned_user_id) === Number(resolved.id));
    }

    tasks.sort((a, b) => (a.position ?? 999999) - (b.position ?? 999999));
    return {
      board: { id: summary.id, name: summary.name },
      count: tasks.length,
      tasks: this._decorateTasks(tasks, details)
    };
  }

  async searchTasks({ query = '', board: boardSelector, limit = 50 } = {}) {
    let board = null;
    if (boardSelector || this.defaultBoardId) board = await this.resolveBoard(boardSelector);
    const payload = await this.request('GET', 'tasks/search.json', {
      query: { q: query, limit: Math.min(Math.max(Number(limit) || 50, 1), 100), board_id: board?.id }
    });
    return { board: board ? { id: board.id, name: board.name } : null, results: payload };
  }

  async createTask({ board: boardSelector, name, description, stage, swimlane, assignee, due_date, priority = 0, tags, card_type, position } = {}) {
    const board = await this.resolveBoard(boardSelector);
    this.ensurePermission(board, 'create_tasks');
    if (!clean(name)) throw new KanbanToolError('name is required.');

    const body = { board_id: board.id, name: clean(name), priority: Number(priority) };
    if (description != null) body.description = String(description);
    if (due_date) body.due_date = String(due_date);
    if (tags != null) body.tags = String(tags);
    if (position != null) body.position = Number(position);
    if (stage) body.workflow_stage_id = (await this.resolveStage(board.id, stage, { requireLeaf: true })).id;
    if (swimlane) body.swimlane_id = (await this.resolveSwimlane(board.id, swimlane)).id;
    if (assignee) body.assigned_user_id = (await this.resolveAssignee(board.id, assignee)).id;
    if (card_type) body.card_type_id = (await this.resolveCardType(board.id, card_type)).id;

    const task = await this.request('POST', 'tasks.json', { body });
    return this.describeTask(task, board.id);
  }

  async updateTask({ board: boardSelector, task_id_or_name, name, description, assignee, clear_assignee = false, due_date, clear_due_date = false, priority, tags, card_type } = {}) {
    const board = await this.resolveBoard(boardSelector);
    this.ensurePermission(board, 'update_tasks');
    const task = await this.resolveTask(board.id, task_id_or_name);
    const body = {};
    if (name != null) body.name = String(name);
    if (description != null) body.description = String(description);
    if (priority != null) body.priority = Number(priority);
    if (tags != null) body.tags = String(tags);
    if (clear_due_date) body.due_date = null;
    else if (due_date != null) body.due_date = String(due_date);
    if (clear_assignee) body.assigned_user_id = null;
    else if (assignee != null) body.assigned_user_id = (await this.resolveAssignee(board.id, assignee)).id;
    if (card_type != null) body.card_type_id = (await this.resolveCardType(board.id, card_type)).id;
    if (!Object.keys(body).length) throw new KanbanToolError('No update fields were supplied.');

    const updated = await this.request('PATCH', `tasks/${task.id}.json`, { body });
    return this.describeTask(updated, board.id);
  }

  async moveTask({ board: boardSelector, task_id_or_name, target_stage, target_swimlane, position } = {}) {
    const board = await this.resolveBoard(boardSelector);
    this.ensurePermission(board, 'move_tasks');
    const task = await this.resolveTask(board.id, task_id_or_name);
    const body = {};
    if (target_stage) body.workflow_stage_id = (await this.resolveStage(board.id, target_stage, { requireLeaf: true })).id;
    if (target_swimlane) body.swimlane_id = (await this.resolveSwimlane(board.id, target_swimlane)).id;
    if (position != null) body.position = Math.max(1, Number(position));
    if (!Object.keys(body).length) throw new KanbanToolError('target_stage, target_swimlane, or position is required.');

    const moved = await this.request('PATCH', `tasks/${task.id}.json`, { body });
    return this.describeTask(moved, board.id);
  }

  async addComment({ board: boardSelector, task_id_or_name, content } = {}) {
    const board = await this.resolveBoard(boardSelector);
    this.ensurePermission(board, 'update_tasks');
    const task = await this.resolveTask(board.id, task_id_or_name);
    if (!clean(content)) throw new KanbanToolError('content is required.');
    const result = await this.request('POST', `tasks/${task.id}/comments.json`, { body: { content: String(content) } });
    return { task: { id: task.id, name: task.name }, comment: result?.comment ?? result };
  }

  async archiveTask({ board: boardSelector, task_id_or_name } = {}) {
    const board = await this.resolveBoard(boardSelector);
    this.ensurePermission(board, 'update_tasks');
    const task = await this.resolveTask(board.id, task_id_or_name);
    const result = await this.request('PATCH', `tasks/${task.id}.json`, { body: { _action: 'archive' } });
    return { archived: true, task: { id: result.id, name: result.name } };
  }

  async describeTask(task, boardSelector) {
    const board = await this.preloadBoard(boardSelector);
    return this._decorateTasks([task], board)[0];
  }
}
