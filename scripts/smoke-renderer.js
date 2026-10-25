#!/usr/bin/env node
/**
 * Real-browser renderer regression, using only Node built-ins.
 * Run from the repository root: node scripts/smoke-renderer.js [browser-path]
 * WORKBAR_RENDERER_SOURCE_DIR optionally selects another renderer directory.
 * Uses a temporary browser profile and in-memory plans; never opens Workbar.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');

const source = path.resolve(process.env.WORKBAR_RENDERER_SOURCE_DIR || 'src');
const browser = [
  process.argv[2],
  process.env.CHROME_PATH,
  ...[process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
    .filter(Boolean)
    .flatMap((base) => ['Google/Chrome/Application/chrome.exe', 'Microsoft/Edge/Application/msedge.exe']
      .map((relative) => path.join(base, relative))),
].find((candidate) => candidate && fs.existsSync(candidate));

if (!browser) {
  console.error('Chrome/Edge not found. Pass its executable path as the first argument.');
  process.exit(1);
}

function bootstrap() {
  const listeners = new Map();
  const date = new Date();
  const today = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const countdown = (id, spent_sec = 60) => ({ id, title: id, timer: 'down', est_min: 5, spent_sec, running: true });
  let plan = {
    date: today,
    current_id: 'a',
    tasks: [countdown('a', 409), { id: 'b', title: 'stopwatch', timer: 'up', est_min: 0, spent_sec: 2039, running: true },
      { id: 'c', title: 'not started', timer: 'down', est_min: 5, spent_sec: 0, running: false }],
  };
  const scene = new URL(location.href).searchParams.get('scene');
  if (scene === 'second') plan.tasks = [countdown('a'), countdown('b', 409), countdown('c')];
  if (scene === 'third') plan.tasks = [countdown('a'), countdown('b'), countdown('c', 409)];
  if (scene === 'single') plan.tasks = [countdown('a', 409)];
  if (scene === 'reuse') plan.tasks[2] = countdown('c');
  const clone = (value) => JSON.parse(JSON.stringify(value));
  async function emit(name, payload) {
    for (const handler of listeners.get(name) || []) await handler({ payload });
  }
  window.__smoke = {
    getPlan: () => clone(plan),
    async setPlan(next) { plan = clone(next); await emit('plan-changed'); },
    emit,
  };
  window.__TAURI__ = {
    core: {
      async invoke(command, args) {
        if (command === 'get_plan') return clone(plan);
        if (command === 'save_plan') { plan = clone(args.plan); return; }
        if (command === 'trace_js') return;
        if (command === 'set_collapsed') {
          queueMicrotask(() => emit('bar-resized', args.collapsed));
          return;
        }
        throw new Error(`Unexpected command: ${command}`);
      },
    },
    event: {
      async listen(name, handler) {
        listeners.set(name, [...(listeners.get(name) || []), handler]);
        return () => {};
      },
    },
  };
  // Keep test fixtures deterministic; native events remain available explicitly.
  window.setInterval = () => 0;
  const style = document.createElement('style');
  style.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; }';
  document.head.append(style);
}

async function runInBrowser() {
  const checks = [];
  let frame;
  const assert = (message, condition) => {
    checks.push({ name: message, ok: Boolean(condition) });
    if (!condition) throw new Error(message);
  };
  async function fixture(scene) {
    if (frame) frame.remove();
    frame = document.createElement('iframe');
    frame.style.cssText = 'width:980px;height:100px;border:0';
    const loaded = new Promise((resolve, reject) => {
      frame.onload = resolve;
      frame.onerror = reject;
    });
    frame.src = `/fixture?scene=${scene}`;
    document.body.append(frame);
    await loaded;
    const win = frame.contentWindow;
    const doc = win.document;
    assert(`${scene}: renderer loaded`, doc.querySelectorAll('.unit').length > 0);
    return {
      win, doc,
      unit: (id) => doc.querySelector(`.unit[data-id="${id}"]`),
      color: (id, selector, property) => win.getComputedStyle(doc.querySelector(`.unit[data-id="${id}"] ${selector}`))[property],
    };
  }
  const warn = 'rgb(255, 196, 107)';
  const normalTime = 'rgb(200, 203, 230)';
  const identity = { a: 'rgb(143, 162, 255)', b: 'rgb(34, 211, 238)', c: 'rgb(251, 113, 133)' };
  function normal(view, id) {
    assert(`${id}: identity ring colour`, view.color(id, '.ring-fill', 'stroke') === identity[id]);
    assert(`${id}: normal elapsed colour`, view.color(id, '.elapsed', 'color') === normalTime);
  }
  function overdue(view, id) {
    assert(`${id}: overdue ring colour`, view.color(id, '.ring-fill', 'stroke') === warn);
    assert(`${id}: overdue elapsed colour`, view.color(id, '.elapsed', 'color') === warn);
    assert(`${id}: overdue text`, view.unit(id).querySelector('.status').textContent === '超时 1 分钟');
  }
  try {
    let view = await fixture('base');
    overdue(view, 'a');
    normal(view, 'b');
    assert('unstarted task remains idle', view.unit('c').querySelector('.ring').dataset.mode === 'idle');
    assert('unstarted ring stays hidden', view.win.getComputedStyle(view.unit('c').querySelector('.ring-fill')).opacity === '0');
    const gradients = () => [...view.doc.querySelectorAll('.slim-seg')].map((node) => view.win.getComputedStyle(node).backgroundImage);
    const before = gradients();
    assert('collapsed segments retain distinct identity gradients', before.length === 2 && before[0].includes('rgb(110, 123, 255)') && before[1].includes('rgb(34, 211, 238)'));
    view.doc.getElementById('collapse').click();
    await Promise.resolve();
    assert('collapse preserves segment colours', view.doc.getElementById('stage').classList.contains('collapsed') && JSON.stringify(gradients()) === JSON.stringify(before));
    view.doc.getElementById('slim').click();
    await Promise.resolve();
    assert('expand preserves segment colours', !view.doc.getElementById('stage').classList.contains('collapsed') && JSON.stringify(gradients()) === JSON.stringify(before));
    overdue(view, 'a');
    normal(view, 'b');
    view.unit('a').querySelector('.ring').click();
    normal(view, 'a');
    normal(view, 'b');
    assert('pause removes only its own warning', view.unit('a').querySelector('.status').textContent === '' && view.unit('b').querySelector('.ring').dataset.mode === 'running');
    view.unit('a').querySelector('.ring').click();
    overdue(view, 'a');
    normal(view, 'b');

    for (const [scene, id] of [['second', 'b'], ['third', 'c']]) {
      view = await fixture(scene);
      overdue(view, id);
      for (const other of ['a', 'b', 'c'].filter((candidate) => candidate !== id)) normal(view, other);
      view.unit(id).querySelector('.ring').click();
      normal(view, id);
      view.unit(id).querySelector('.ring').click();
      overdue(view, id);
    }

    view = await fixture('reuse');
    const reused = view.unit('a');
    const next = view.win.__smoke.getPlan();
    next.current_id = 'b';
    next.tasks = next.tasks.filter((task) => task.id !== 'a');
    next.tasks.push({ id: 'd', title: 'replacement', timer: 'down', est_min: 5, spent_sec: 0, running: false });
    await view.win.__smoke.setPlan(next);
    assert('renderer reuses task nodes', view.unit('b') === reused);
    assert('reused node clears obsolete overdue style', view.color('b', '.ring-fill', 'stroke') === identity.a && view.color('b', '.elapsed', 'color') === normalTime);
    assert('reused node clears obsolete overdue text', view.unit('b').querySelector('.status').textContent === '');

    view = await fixture('single');
    overdue(view, 'a');
    assert('single collapsed bar retains overdue gradient', view.win.getComputedStyle(view.doc.getElementById('slimBar')).backgroundImage.includes('rgb(255, 178, 87)'));
  } catch (error) {
    checks.push({ name: error.stack || String(error), ok: false });
  }
  await fetch('/result', { method: 'POST', body: JSON.stringify(checks) });
  document.body.textContent = JSON.stringify(checks);
}

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'workbar-renderer-smoke-'));
  let child;
  let timer;
  let log = '';
  let resolveResult;
  const result = new Promise((resolve) => { resolveResult = resolve; });
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/result' && request.method === 'POST') {
      let body = '';
      request.on('data', (part) => { body += part; });
      request.on('end', () => {
        response.end('ok');
        try { resolveResult(JSON.parse(body)); } catch (error) { resolveResult([{ name: String(error), ok: false }]); }
      });
      return;
    }
    const routes = {
      '/': ['text/html', '<!doctype html><html><head><title>Workbar renderer regression</title></head><body><script src="/runner.js"></script></body></html>'],
      '/runner.js': ['application/javascript', `(${runInBrowser.toString()})();`],
      '/bootstrap.js': ['application/javascript', `(${bootstrap.toString()})();`],
      '/fixture': ['text/html', fs.readFileSync(path.join(source, 'index.html'), 'utf8').replace('<script src="app.js">', '<script src="/bootstrap.js"></script><script src="app.js">')],
      '/app.js': ['application/javascript', fs.readFileSync(path.join(source, 'app.js'))],
      '/styles.css': ['text/css', fs.readFileSync(path.join(source, 'styles.css'))],
    };
    const route = routes[url.pathname];
    response.writeHead(route ? 200 : 404, { 'Content-Type': route ? `${route[0]}; charset=utf-8` : 'text/plain' });
    response.end(route ? route[1] : 'Not found');
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    child = spawn(browser, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${profile}`, '--dump-dom', '--virtual-time-budget=10000', `http://127.0.0.1:${port}/`],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.on('data', (data) => { log = (log + data).slice(-20000); });
    child.stderr.on('data', (data) => { log = (log + data).slice(-20000); });
    child.once('error', (error) => resolveResult([{ name: `Browser failed: ${error.message}`, ok: false }]));
    child.once('exit', (code) => resolveResult([{ name: `Browser exited before reporting (code ${code})`, ok: false }]));
    timer = setTimeout(() => resolveResult([{ name: 'Browser regression timed out after 30 seconds', ok: false }]), 30000);
    const checks = await result;
    for (const check of checks) console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.name}`);
    const failed = checks.some((check) => !check.ok);
    console.log(`${checks.filter((check) => check.ok).length}/${checks.length} browser checks passed.`);
    if (failed) { console.error(log); process.exitCode = 1; }
  } finally {
    clearTimeout(timer);
    if (child && child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 3000).unref(); });
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
    catch (error) { console.error(`Temporary browser profile could not be removed: ${error.message}`); }
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
