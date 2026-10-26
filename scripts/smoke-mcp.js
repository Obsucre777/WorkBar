#!/usr/bin/env node
/**
 * Smoke test for workbar-mcp: speaks raw JSON-RPC 2.0 over stdio.
 *
 *   node scripts/smoke-mcp.js [path-to-workbar-mcp.exe]
 *
 * Uses WORKBAR_DATA_DIR (default: ./.devdata) so it never touches your real plan.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const exe =
  process.argv[2] ||
  path.join(root, 'target', process.platform === 'win32' ? 'debug' : 'debug', `workbar-mcp${process.platform === 'win32' ? '.exe' : ''}`);

const dataDir = process.env.WORKBAR_DATA_DIR || path.join(root, '.devdata', `mcp-sqlite-${Date.now()}`);
fs.mkdirSync(dataDir, { recursive: true });

if (!fs.existsSync(exe)) {
  console.error(`workbar-mcp not found: ${exe}\nRun: cargo build -p workbar-mcp`);
  process.exit(1);
}

const child = spawn(exe, [], {
  env: { ...process.env, WORKBAR_DATA_DIR: dataDir },
  stdio: ['pipe', 'pipe', 'inherit'],
  windowsHide: true,
});

let buffer = '';
const pending = new Map();
let nextId = 1;

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      console.error('non-JSON output:', line);
      continue;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  }
});

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 10000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

function textOf(response) {
  const content = response && response.result && response.result.content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => part.text || '').join('\n');
}

function dataOf(response) { return JSON.parse(textOf(response)); }

function independentClient(calls) {
  return new Promise((resolve, reject) => {
    const worker = spawn(exe, [], { env: { ...process.env, WORKBAR_DATA_DIR: dataDir }, windowsHide: true });
    let output = '';
    let errors = '';
    const timer = setTimeout(() => { worker.kill(); reject(new Error('Independent MCP client timed out')); }, 20000);
    worker.stdout.on('data', (part) => { output += part; });
    worker.stderr.on('data', (part) => { errors += part; });
    worker.on('error', (error) => { clearTimeout(timer); reject(error); });
    worker.on('close', (code) => {
      clearTimeout(timer);
      try {
        const replies = output.trim().split('\n').map((line) => JSON.parse(line));
        if (code !== 0 || replies.length !== calls.length + 1 || replies.some((reply) => reply.error || reply.result?.isError)) {
          throw new Error(`Independent MCP client failed: ${output} ${errors}`);
        }
        resolve(replies.slice(1));
      } catch (error) { reject(error); }
    });
    const messages = [{ jsonrpc: '2.0', id: 0, method: 'initialize', params: {
      protocolVersion: '2024-11-05', clientInfo: { name: 'parallel-smoke', version: '1' },
    } }, ...calls.map((call, index) => ({ jsonrpc: '2.0', id: index + 1, method: 'tools/call', params: call }))];
    worker.stdin.end(messages.map((message) => JSON.stringify(message)).join('\n') + '\n');
  });
}

(async () => {
  try {
    const init = await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke', version: '0' },
    });
    check('initialize', !init.error && !!init.result, init.error && init.error.message);
    notify('notifications/initialized', {});

    const tools = await request('tools/list', {});
    const names = (tools.result && tools.result.tools ? tools.result.tools : []).map((t) => t.name);
    check('tools/list has 11 tools including explicit reordering', names.length === 11 && names.includes('workbar_reorder_tasks'), names.join(','));

    const plan = await request('tools/call', {
      name: 'workbar_plan_day',
      arguments: {
        tasks: [
          { title: '写周报', start: '09:30', end: '10:00' },
          { title: '修 bug', start: '10:00', end: '11:00', est_min: 40 },
        ],
      },
    });
    check('plan_day creates 2 tasks', dataOf(plan).tasks.length === 2);

    const got = await request('tools/call', { name: 'workbar_get_today', arguments: {} });
    const gotText = textOf(got);
    check('get_today returns tasks', gotText.includes('写周报') && gotText.includes('修 bug'));

    const taskId = dataOf(got).tasks[0]?.id;
    check('get_today exposes ids', !!taskId, taskId || 'none');

    if (taskId) {
      const add = await request('tools/call', {
        name: 'workbar_add_tasks',
        arguments: { tasks: [{ title: '晚上运动', start: '20:00', end: '20:30' }] },
      });
      check('add_tasks', !add.error && textOf(add).includes('晚上运动'));

      const complete = await request('tools/call', {
        name: 'workbar_complete_task',
        arguments: { id: taskId },
      });
      check('complete_task', !complete.error && dataOf(complete).done === true && dataOf(complete).id === taskId);

      const bad = await request('tools/call', {
        name: 'workbar_update_task',
        arguments: { id: taskId, start: '25:99' },
      });
      check('rejects invalid HH:mm', bad.result && bad.result.isError === true);

      const missing = await request('tools/call', {
        name: 'workbar_update_task',
        arguments: { id: 'nope' },
      });
      check('rejects unknown id', missing.result && missing.result.isError === true);

      const started = await request('tools/call', {
        name: 'workbar_start_work',
        arguments: { title: 'AI 冒烟工作' },
      });
      const startedText = textOf(started);
      check(
        'start_work adds a running stopwatch',
        !started.error && startedText.includes('AI 冒烟工作') && dataOf(started).timer === 'up' && dataOf(started).running
      );

      const finished = await request('tools/call', {
        name: 'workbar_finish_work',
        arguments: {},
      });
      check(
        'finish_work closes the session',
        !finished.error && dataOf(finished).done && dataOf(finished).id === dataOf(started).id
      );

      const cleared = await request('tools/call', { name: 'workbar_clear_day', arguments: {} });
      check('clear_day', !cleared.error && dataOf(cleared).cleared === true);
    }

    let latestPlan = { tasks: [] };
    const refresh = async () => { latestPlan = dataOf(await request('tools/call', { name: 'workbar_get_today', arguments: {} })); };
    const readPlan = () => JSON.parse(JSON.stringify(latestPlan));
    const titles = () => readPlan().tasks.map((task) => task.title).join('|');
    const ids = () => readPlan().tasks.map((task) => task.id);
    const idOf = (title) => readPlan().tasks.find((task) => task.title === title).id;
    const taskStates = () => JSON.stringify(readPlan().tasks.slice().sort((a, b) => a.id.localeCompare(b.id)));
    const call = async (name, args) => {
      const result = await request('tools/call', { name, arguments: args });
      if (result.error || result.result?.isError) throw new Error(`${name}: ${textOf(result)}`);
      await refresh();
      return result;
    };
    const rejectsUnchanged = async (name, args, label) => {
      const before = JSON.stringify(readPlan());
      const result = await request('tools/call', { name, arguments: args });
      await refresh();
      check(label, result.result?.isError === true && JSON.stringify(readPlan()) === before);
    };

    await call('workbar_plan_day', { tasks: [
      { title: 'late', start: '23:59', paused: true },
      { title: 'early', start: '00:01', paused: true },
      { title: 'loose-z' }, { title: 'loose-a' },
    ] });
    check('plan preserves supplied queue order regardless of schedule', titles() === 'late|early|loose-z|loose-a');
    await call('workbar_add_tasks', { tasks: [
      { title: 'batch-first', start: '00:00', paused: true }, { title: 'batch-second' },
    ] });
    const appended = titles();
    check('batch addition appends in input order even with an earlier start', appended === 'late|early|loose-z|loose-a|batch-first|batch-second');
    await call('workbar_update_task', { id: idOf('late'), start: '00:02', running: false });
    await call('workbar_set_current', { id: idOf('loose-a') });
    await call('workbar_update_task', { id: idOf('loose-a'), running: false });
    check('changing schedule, starting and pausing preserve queue order', titles() === appended);
    await call('workbar_complete_task', { id: idOf('early') });
    check('completion preserves surviving queue order', readPlan().tasks.filter((task) => !task.done).map((task) => task.title).join('|') === 'late|loose-z|loose-a|batch-first|batch-second');
    await call('workbar_update_task', { id: idOf('early'), done: false });
    check('reopening a task restores its previous queue position', titles() === appended);
    await call('workbar_start_work', { title: 'queue-session' });
    check('AI work sessions also append at the end', readPlan().tasks.at(-1).title === 'queue-session');
    await call('workbar_finish_work', { id: idOf('queue-session') });
    await call('workbar_add_tasks', { tasks: [{ title: 'front-one' }, { title: 'front-two' }], position: 'first' });
    check('explicit front insertion preserves batch order', titles().startsWith('front-one|front-two|'));
    await call('workbar_add_tasks', { tasks: [{ title: 'middle-one' }, { title: 'middle-two' }], after_id: idOf('loose-z') });
    check('explicit after insertion keeps a batch consecutive', titles().includes('loose-z|middle-one|middle-two|loose-a'));
    const beforeMove = taskStates();
    await call('workbar_update_task', { id: idOf('batch-second'), position: 'first' });
    await call('workbar_update_task', { id: idOf('front-one'), after_id: idOf('front-two') });
    await call('workbar_update_task', { id: idOf('front-two'), position: 'last' });
    check('explicit front, after and end moves preserve every task state', readPlan().tasks[0].title === 'batch-second' && readPlan().tasks.at(-1).title === 'front-two' && taskStates() === beforeMove);
    await rejectsUnchanged('workbar_add_tasks', { tasks: [{ title: 'invalid' }], after_id: 'missing' }, 'invalid insertion leaves plan untouched');
    await rejectsUnchanged('workbar_update_task', { id: idOf('late'), title: 'invalid rename', after_id: 'missing' }, 'invalid move rolls back other edits');
    await rejectsUnchanged('workbar_update_task', { id: idOf('late'), after_id: idOf('late') }, 'reject moving a task after itself');
    await rejectsUnchanged('workbar_update_task', { id: idOf('late'), position: 'first', after_id: idOf('early') }, 'reject conflicting placement options');
    await rejectsUnchanged('workbar_reorder_tasks', { task_ids: [idOf('late'), idOf('late')] }, 'reject duplicate reorder ids');
    await rejectsUnchanged('workbar_reorder_tasks', { task_ids: ['missing'] }, 'reject unknown reorder ids');
    await rejectsUnchanged('workbar_reorder_tasks', { task_ids: [] }, 'reject empty reorder list');
    await rejectsUnchanged('workbar_reorder_tasks', { task_ids: [idOf('late')], by: 'start_time' }, 'reject conflicting reorder options');
    const beforeReorder = ids();
    const requested = [idOf('batch-first'), idOf('early')];
    await call('workbar_reorder_tasks', { task_ids: requested });
    check('explicit id ordering preserves the relative order of unlisted tasks', JSON.stringify(ids()) === JSON.stringify([...requested, ...beforeReorder.filter((id) => !requested.includes(id))]));
    const beforeTimeSort = readPlan().tasks;
    const minutes = (task) => task.start ? Number(task.start.split(':')[0]) * 60 + Number(task.start.split(':')[1]) : 1441;
    const expectedTimeSort = beforeTimeSort.slice().sort((a, b) => minutes(a) - minutes(b)).map((task) => task.id);
    await call('workbar_reorder_tasks', { by: 'start_time' });
    check('time sorting happens only when explicitly requested and keeps ties stable', JSON.stringify(ids()) === JSON.stringify(expectedTimeSort) && taskStates() === beforeMove);
    await call('workbar_add_tasks', { tasks: [{ title: 'new-after-sort', start: '00:00', paused: true }] });
    check('adding after an explicit time sort still appends normally', readPlan().tasks.at(-1).title === 'new-after-sort');
    await call('workbar_clear_day', {});
    const raw = readPlan();
    check('SQLite is the storage file', fs.readFileSync(path.join(dataDir, 'workbar.db')).subarray(0, 16).toString() === 'SQLite format 3\0');
    check('no plan.json is created', !fs.existsSync(path.join(dataDir, 'plan.json')));
    check('empty database still returns today', typeof raw.date === 'string' && raw.date.length === 10);

    await call('workbar_plan_day', { tasks: Array.from({ length: 200 }, (_, index) => ({ title: `unrelated-${index}`, paused: true })) });
    const smallStart = await call('workbar_start_work', { title: 'compact-result' });
    const own = dataOf(smallStart);
    check('start response contains only its new task even with 200 existing tasks', own.id && own.running && textOf(smallStart).length < 400 && !textOf(smallStart).includes('unrelated-'));
    const smallFinish = await call('workbar_finish_work', { id: own.id });
    check('finish response contains only its completed task', dataOf(smallFinish).done && dataOf(smallFinish).id === own.id && textOf(smallFinish).length < 400 && !textOf(smallFinish).includes('unrelated-'));
    const onlyAdded = await call('workbar_add_tasks', { tasks: [{ title: 'one-new-task' }] });
    check('addition response contains only the added task', dataOf(onlyAdded).tasks.length === 1 && dataOf(onlyAdded).tasks[0].title === 'one-new-task');
    const onlyUpdated = await call('workbar_update_task', { id: own.id, title: 'renamed-session' });
    check('update response contains only the target task', dataOf(onlyUpdated).id === own.id && !textOf(onlyUpdated).includes('unrelated-'));
    const removedId = dataOf(onlyAdded).tasks[0].id;
    const removed = await call('workbar_remove_task', { id: removedId });
    check('remove returns only its target id and deletes only that task', dataOf(removed).id === removedId && dataOf(removed).removed && latestPlan.tasks.length === 201 && !latestPlan.tasks.some((task) => task.id === removedId));
    await call('workbar_clear_day', {});

    const base = dataOf(await call('workbar_start_work', { title: 'parallel-base' }));
    await Promise.all([
      ...Array.from({ length: 4 }, (_, worker) => independentClient(Array.from({ length: 8 }, (_, index) => ({
        name: 'workbar_add_tasks', arguments: { tasks: [{ title: `client-${worker}-${index}` }] },
      })))),
      (async () => {
        for (let index = 0; index < 8; index += 1) {
          await call('workbar_update_task', { id: base.id, running: false });
          await call('workbar_update_task', { id: base.id, running: true });
        }
      })(),
    ]);
    await refresh();
    check('four independent MCP processes and simultaneous state changes lose no tasks', latestPlan.tasks.length === 33);
    check('parallel writes leave every independent task idle', latestPlan.tasks.filter((task) => task.id !== base.id).every((task) => !task.running && !task.done));
    const reopened = await independentClient([{ name: 'workbar_get_today', arguments: {} }]);
    check('a newly started MCP process reads persisted tasks and the running timer', dataOf(reopened[0]).tasks.length === 33 && dataOf(reopened[0]).tasks.find((task) => task.id === base.id).running);
    await call('workbar_clear_day', {});
  } catch (err) {
    console.error('ERROR', err.message);
    checks.push({ name: 'no crash', ok: false });
  } finally {
    child.kill();
    const failed = checks.filter((c) => !c.ok);
    console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
    process.exit(failed.length ? 1 : 0);
  }
})();
