import 'dotenv/config';
import { KanbanToolClient } from '../lib/kanban.mjs';

const client = new KanbanToolClient({
  domain: process.env.KANBAN_DOMAIN,
  token: process.env.KANBAN_API_TOKEN,
  defaultBoardId: process.env.KANBAN_DEFAULT_BOARD_ID
});

try {
  const boards = await client.listBoards();
  console.log(`KANBAN_CHECK_OK boards=${boards.length}`);
  for (const board of boards) {
    console.log(`BOARD id=${board.id} name=${JSON.stringify(board.name)} permissions=${JSON.stringify(board.permissions ?? [])}`);
    try {
      const structure = await client.structure(String(board.id));
      console.log(`STAGES board=${board.id} ${JSON.stringify(structure.workflow_stages.map(s => ({id:s.id,name:s.name,parent_id:s.parent_id})) )}`);
      console.log(`USERS board=${board.id} ${JSON.stringify(structure.collaborators.map(u => ({id:u.id,name:u.name,initials:u.initials,active:u.active})) )}`);
    } catch (e) {
      console.error(`STRUCTURE_CHECK_FAILED board=${board.id} ${e.message}`);
    }
  }

  if (process.env.KANBAN_DEFAULT_BOARD_ID && process.env.KANBAN_DESIGN_STAGE_NAME) {
    const design = await client.listTasks({
      board: process.env.KANBAN_DEFAULT_BOARD_ID,
      stage: process.env.KANBAN_DESIGN_STAGE_NAME,
      includeChildStages: true
    });
    console.log(`DESIGN_QUEUE board=${design.board.id} count=${design.count}`);
    for (const task of design.tasks) {
      console.log(`DESIGN_TASK id=${task.id} name=${JSON.stringify(task.name)} assignee=${JSON.stringify(task.assignee)} due_date=${JSON.stringify(task.due_date)} position=${JSON.stringify(task.position)}`);
    }
  }
} catch (e) {
  console.error('KANBAN_CHECK_FAILED', e?.message || String(e));
  process.exit(1);
}
