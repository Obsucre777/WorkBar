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

const dataDir = process.env.WORKBAR_DATA_DIR || path.join(root, '.devdata');
fs.mkdirSync(dataDir, { recursive: true });

if (!fs.existsSync(exe)) {
  console.error(`workbar-mcp not found: ${exe}\nRun: cargo build -p workbar-mcp`);
  process.exit(1);
}

const child = spawn(exe, [], {
  env: { ...process.env, WORKBAR_DATA_DIR: dataDir },
  stdio: ['pipe', 'pipe', 'inherit'],
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
    check('tools/list has 10 tools', names.length === 10, names.join(','));

    const plan = await request('tools/call', {
      name: 'workbar_plan_day',
      arguments: {
        intro: 'smoke test day',
        tasks: [
          { title: '写周报', start: '09:30', end: '10:00' },
          { title: '修 bug', start: '10:00', end: '11:00', est_min: 40 },
        ],
      },
    });
    const planText = textOf(plan);
    check('plan_day creates 2 tasks', planText.includes('2/0') || planText.includes('0/2'), '');

    const got = await request('tools/call', { name: 'workbar_get_today', arguments: {} });
    const gotText = textOf(got);
    check('get_today returns tasks', gotText.includes('写周报') && gotText.includes('修 bug'));

    const idMatch = /- \[ \] (t[0-9a-f]{8})/.exec(gotText);
    const taskId = idMatch && idMatch[1];
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
      check('complete_task', !complete.error && textOf(complete).includes('[x]'));

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
        !started.error && startedText.includes('AI 冒烟工作') && startedText.includes('正计时')
      );

      const finished = await request('tools/call', {
        name: 'workbar_finish_work',
        arguments: {},
      });
      check(
        'finish_work closes the session',
        !finished.error && /\[x\][^\n]*AI 冒烟工作/.test(textOf(finished))
      );

      const cleared = await request('tools/call', { name: 'workbar_clear_day', arguments: {} });
      check('clear_day', !cleared.error && textOf(cleared).includes('(no tasks yet'));
    }

    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'plan.json'), 'utf8'));
    check('plan.json is valid JSON with date', typeof raw.date === 'string' && raw.date.length === 10);
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
