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
  const RealDate = Date;
  const clock = window.parent.__fixtureClock || [12, 0, 0];
  let now = new RealDate().setHours(...clock, 0);
  window.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  };
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
  if (scene === 'compact') plan.tasks = [
    { ...countdown('a', 951), est_min: 10 },
    { ...countdown('b'), est_min: 90 },
    { ...countdown('c'), est_min: 60 },
  ];
  if (scene === 'boundary') plan.tasks = [countdown('a', 300), countdown('b', 359), countdown('c', 360)];
  const idle = (id, start) => ({ ...countdown(id, 0), start, running: false });
  const stopwatch = (id) => ({ id, title: id, timer: 'up', est_min: 0, spent_sec: 674, running: true });
  if (scene === 'colour-single' || scene === 'colour-multi') {
    plan.current_id = 'b';
    plan.tasks = [idle('a', '23:59'), stopwatch('b')];
    if (scene === 'colour-multi') plan.tasks.push(countdown('c'));
  }
  if (scene === 'colour-third' || scene === 'colour-pinned') {
    plan.current_id = scene === 'colour-third' ? 'c' : 'd';
    plan.tasks = [idle('a', '23:57'), idle('b', '23:58'), stopwatch('c')];
    if (scene === 'colour-pinned') plan.tasks = [idle('a', '23:57'), idle('b', '23:58'), idle('c', '23:59'), stopwatch('d')];
  }
  if (scene === 'done-upcoming' || scene === 'done-upcoming-only') {
    plan.current_id = null;
    plan.tasks = [idle('a', '23:57'), idle('b', '23:58')];
    if (scene === 'done-upcoming') plan.tasks.push({ ...countdown('c', 79), est_min: 30 });
  }
  if (scene === 'done-empty') { plan.current_id = null; plan.tasks = []; }
  if (scene === 'done-complete') { plan.current_id = null; plan.tasks = [{ ...countdown('a'), done: true, running: false }]; }
  if (scene === 'independent-idle' || scene === 'independent-legacy' || scene === 'independent-visibility') {
    plan.current_id = scene === 'independent-idle' ? null : 'b';
    plan.tasks = ['a', 'b', 'c'].map((id) => idle(id));
    if (scene === 'independent-visibility') { plan.tasks.push(idle('d')); plan.current_id = 'd'; }
  }
  if (scene === 'independent-equal' || scene === 'independent-complete') {
    plan.current_id = scene === 'independent-equal' ? 'b' : 'a';
    plan.tasks = ['a', 'b', 'c'].map((id) => countdown(id));
  }
  if (scene === 'independent-schedule') {
    plan.current_id = 'c';
    plan.tasks = [
      { ...idle('a', '16:00'), end: '16:30' },
      idle('b', '16:00'),
      { ...stopwatch('c'), start: '17:00', end: '17:30' },
    ];
  }
  if (scene === 'independent-paused') {
    plan.current_id = 'a';
    plan.tasks = [
      { ...idle('a', '11:00'), end: '13:00', paused: true },
      { ...idle('b', '11:00'), end: '13:00', spent_sec: 30 },
      { ...stopwatch('c'), start: '14:00', end: '15:00', spent_sec: 0 },
    ];
  }
  const clone = (value) => JSON.parse(JSON.stringify(value));
  let blockSaves = false;
  const pendingSaves = [];
  if (window.parent.__fixturePlan) plan = clone(window.parent.__fixturePlan);
  async function emit(name, payload) {
    for (const handler of listeners.get(name) || []) await handler({ payload });
  }
  window.__smoke = {
    getPlan: () => clone(plan),
    holdSaves: () => { blockSaves = true; },
    pendingSaves: () => pendingSaves.length,
    releaseSave() {
      const pending = pendingSaves.shift();
      if (pending) { plan = clone(pending.plan); pending.resolve(); }
    },
    releaseSaves() {
      blockSaves = false;
      while (pendingSaves.length) this.releaseSave();
    },
    async setPlan(next) { plan = clone(next); await emit('plan-changed'); },
    async setClock(hours, minutes, seconds = 0) {
      now = new RealDate(now).setHours(hours, minutes, seconds, 0);
      await emit('clock-tick');
    },
    emit,
  };
  window.__TAURI__ = {
    core: {
      async invoke(command, args) {
        if (command === 'get_plan') return clone(plan);
        if (command === 'save_plan') {
          if (blockSaves) await new Promise((resolve) => pendingSaves.push({ plan: clone(args.plan), resolve }));
          else plan = clone(args.plan);
          return;
        }
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
  async function fixture(scene, restoredPlan = null, clock = null) {
    if (frame) frame.remove();
    window.__fixturePlan = restoredPlan;
    window.__fixtureClock = clock;
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
  const running = 'rgb(110, 231, 183)';
  const normalTime = 'rgb(200, 203, 230)';
  const identity = { a: 'rgb(143, 162, 255)', b: 'rgb(34, 211, 238)', c: 'rgb(251, 113, 133)' };
  function normal(view, id) {
    assert(`${id}: identity ring colour`, view.color(id, '.ring-fill', 'stroke') === identity[id]);
    assert(`${id}: normal elapsed colour`, view.color(id, '.elapsed', 'color') === normalTime);
    assert(`${id}: normal status dot stays green`, view.color(id, '.pulse', 'backgroundColor') === running);
    const isRunning = view.unit(id).querySelector('.ring').dataset.mode === 'running';
    assert(`${id}: expanded ring follows running brightness`, view.color(id, '.ring-fill', 'opacity') === (isRunning ? '1' : '0.45'));
    assert(`${id}: status dot follows running state`, view.color(id, '.pulse', 'opacity') === (isRunning ? '1' : '0'));
    if (!isRunning) {
      assert(`${id}: paused play glyph stays clear`, view.color(id, '.glyph-play', 'opacity') === '0.95');
      usableDone(view, id, `${id}: paused task`);
    }
  }
  function overdue(view, id) {
    assert(`${id}: overdue ring colour`, view.color(id, '.ring-fill', 'stroke') === warn);
    assert(`${id}: overdue running ring stays bright`, view.color(id, '.ring-fill', 'opacity') === '1');
    assert(`${id}: overdue elapsed colour`, view.color(id, '.elapsed', 'color') === warn);
    assert(`${id}: overdue status dot matches ring`, view.color(id, '.pulse', 'backgroundColor') === warn);
    assert(`${id}: overdue status dot stays visible`, view.color(id, '.pulse', 'opacity') === '1');
    const status = view.unit(id).querySelector('.status');
    assert(`${id}: no extra overdue wording`, status.textContent === '' && status.hidden);
  }
  function matchingStrip(view, id, slot, label) {
    const palette = [identity.a, identity.b, identity.c];
    const single = !view.doc.getElementById('slimBar').hidden;
    const strip = single ? view.doc.getElementById('slimBar') : view.doc.querySelector(`.slim-seg[data-id="${id}"]`);
    assert(`${label}: expanded task has the expected identity colour`, view.color(id, '.ring-fill', 'stroke') === palette[slot]);
    assert(`${label}: collapsed task strip exists`, Boolean(strip));
    const gradient = view.win.getComputedStyle(strip).backgroundImage;
    const matches = slot === 0
      ? ['rgb(110, 123, 255)', 'rgb(127, 144, 255)'].some((colour) => gradient.includes(colour))
      : gradient.includes(palette[slot]);
    assert(`${label}: collapsed strip matches the expanded task colour`, matches);
  }
  function usableDone(view, id, label) {
    const button = view.unit(id).querySelector('.done');
    const style = view.win.getComputedStyle(button);
    assert(`${label}: done button is enabled`, !button.disabled);
    assert(`${label}: done button is visible`, Number(style.opacity) > 0);
    assert(`${label}: done button accepts pointer input`, style.pointerEvents !== 'none');
  }
  async function settled() { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }
  function idleState(view, id, label) {
    const unit = view.unit(id);
    assert(`${label}: task stays idle`, unit.querySelector('.ring').dataset.mode === 'idle');
    assert(`${label}: no artificial elapsed time`, unit.querySelector('.elapsed').hidden);
    assert(`${label}: unstarted wording`, unit.querySelector('.estimate').textContent === '待开始');
    usableDone(view, id, label);
  }
  function siblingsUnchanged(view, selected, label) {
    const siblings = view.win.__smoke.getPlan().tasks.filter((task) => task.id !== selected);
    assert(`${label}: sibling state and elapsed time remain untouched`, siblings.every((task) =>
      !task.running && !task.paused && !task.done && task.spent_sec === 0));
  }
  try {
    let view = await fixture('independent-idle');
    for (const id of ['a', 'b', 'c']) idleState(view, id, `idle position ${id}`);
    view = await fixture('independent-legacy');
    for (const id of ['a', 'b', 'c']) idleState(view, id, `legacy selection position ${id}`);
    assert('legacy current id does not highlight a unit', !view.doc.querySelector('.unit.current'));
    view = await fixture('independent-visibility');
    assert('legacy current id cannot displace an equally idle task', Boolean(view.unit('a') && view.unit('b') && view.unit('c')) && !view.unit('d'));

    for (const id of ['a', 'b', 'c']) {
      view = await fixture('independent-idle');
      view.unit(id).querySelector('.ring').click();
      await settled();
      let task = view.win.__smoke.getPlan().tasks.find((item) => item.id === id);
      assert(`start position ${id}: only selected task starts`, task.running && !task.paused);
      siblingsUnchanged(view, id, `start position ${id}`);
      view.unit(id).querySelector('.ring').click();
      await settled();
      task = view.win.__smoke.getPlan().tasks.find((item) => item.id === id);
      assert(`pause position ${id}: explicit zero-second pause is persisted`, !task.running && task.paused && task.spent_sec === 0);
      assert(`pause position ${id}: paused appearance does not require elapsed time`, view.unit(id).querySelector('.ring').dataset.mode === 'paused');
      siblingsUnchanged(view, id, `pause position ${id}`);
      const saved = view.win.__smoke.getPlan();
      view = await fixture('restored', saved);
      assert(`reload position ${id}: explicit pause survives reload`, view.unit(id).querySelector('.ring').dataset.mode === 'paused');
      view.unit(id).querySelector('.ring').click();
      await settled();
      await view.win.__smoke.setClock(12, 0, 5);
      await settled();
      assert(`resume position ${id}: elapsed time advances independently`, view.unit(id).querySelector('.elapsed').textContent === '00:05');
      siblingsUnchanged(view, id, `resume position ${id}`);
      view.unit(id).querySelector('.done').click();
      assert(`complete position ${id}: task is removed without a special delay`, !view.unit(id));
      await settled();
      task = view.win.__smoke.getPlan().tasks.find((item) => item.id === id);
      assert(`complete position ${id}: selected task stops and completes`, task.done && !task.running && !task.paused);
      siblingsUnchanged(view, id, `complete position ${id}`);
      for (const sibling of ['a', 'b', 'c'].filter((other) => other !== id)) idleState(view, sibling, `after completing ${id}: ${sibling}`);
    }

    view = await fixture('independent-equal');
    assert('equally running strips have equal full brightness', [...view.doc.querySelectorAll('.slim-seg')].every((node) => view.win.getComputedStyle(node).opacity === '1'));
    assert('legacy selection cannot highlight a strip', !view.doc.querySelector('.slim-seg.current'));
    for (const id of ['a', 'c']) { view.unit(id).querySelector('.ring').click(); await settled(); }
    assert('equally paused strips have equal dim brightness', ['a', 'c'].every((id) => view.win.getComputedStyle(view.doc.querySelector(`.slim-seg[data-id="${id}"]`)).opacity === '0.45'));
    assert('pausing siblings preserves the running strip brightness', view.win.getComputedStyle(view.doc.querySelector('.slim-seg[data-id="b"]')).opacity === '1');

    view = await fixture('independent-schedule', null, [15, 59, 59]);
    assert('explicit running task is not stopped by its future schedule', view.unit('c').querySelector('.ring').dataset.mode === 'running');
    assert('scheduled tasks wait for their own start time', ['a', 'b'].every((id) => view.unit(id).querySelector('.ring').dataset.mode === 'idle'));
    await view.win.__smoke.setClock(16, 0);
    assert('all due tasks start, including start-only task beside another running task', ['a', 'b', 'c'].every((id) => view.unit(id).querySelector('.ring').dataset.mode === 'running'));
    view.unit('a').querySelector('.ring').click();
    await settled();
    await view.win.__smoke.setClock(16, 1);
    assert('scheduled task stays paused during its time window', view.unit('a').querySelector('.ring').dataset.mode === 'paused');
    assert('other due tasks keep running after one pauses', ['b', 'c'].every((id) => view.unit(id).querySelector('.ring').dataset.mode === 'running'));
    const scheduledPause = view.win.__smoke.getPlan();
    view = await fixture('restored', scheduledPause, [16, 2, 0]);
    assert('scheduled pause survives reloading inside the active window', view.unit('a').querySelector('.ring').dataset.mode === 'paused');

    view = await fixture('independent-paused');
    assert('due zero-second explicit pause is not auto-started', view.unit('a').querySelector('.ring').dataset.mode === 'paused');
    assert('previously timed legacy pause is not auto-started', view.unit('b').querySelector('.ring').dataset.mode === 'paused');
    assert('AI running future task remains running', view.unit('c').querySelector('.ring').dataset.mode === 'running');
    let remote = view.win.__smoke.getPlan();
    remote.tasks.find((task) => task.id === 'c').running = false;
    remote.tasks.find((task) => task.id === 'c').paused = true;
    await view.win.__smoke.setPlan(remote);
    assert('external explicit pause is not overwritten by local running state', view.unit('c').querySelector('.ring').dataset.mode === 'paused');
    remote = view.win.__smoke.getPlan();
    remote.tasks.find((task) => task.id === 'b').running = true;
    remote.tasks.find((task) => task.id === 'b').paused = false;
    await view.win.__smoke.setPlan(remote);
    assert('external explicit start resumes only its target', view.unit('b').querySelector('.ring').dataset.mode === 'running' && ['a', 'c'].every((id) => view.unit(id).querySelector('.ring').dataset.mode === 'paused'));

    view = await fixture('independent-complete');
    view.unit('a').querySelector('.done').click();
    assert('first completion removes its own unit immediately', !view.unit('a'));
    view.unit('b').querySelector('.done').click();
    assert('another task can complete immediately without a global busy lock', !view.unit('b'));
    await settled();
    const consecutive = view.win.__smoke.getPlan().tasks;
    assert('consecutive completion saves both target tasks', consecutive.filter((task) => ['a', 'b'].includes(task.id)).every((task) => task.done && !task.running));
    assert('consecutive completion does not stop the remaining task', consecutive.find((task) => task.id === 'c').running && !consecutive.find((task) => task.id === 'c').done);

    view = await fixture('independent-idle');
    const slow = view.win.__smoke;
    slow.holdSaves();
    view.unit('a').querySelector('.ring').click();
    view.unit('b').querySelector('.ring').click();
    view.unit('a').querySelector('.ring').click();
    await slow.emit('plan-changed');
    assert('slow save does not block independent task changes', view.unit('a').querySelector('.ring').dataset.mode === 'paused' && view.unit('b').querySelector('.ring').dataset.mode === 'running');
    assert('only one save is in flight', slow.pendingSaves() === 1);
    slow.releaseSave();
    await settled();
    await slow.emit('plan-changed');
    assert('old save echo cannot restore stale task states', view.unit('a').querySelector('.ring').dataset.mode === 'paused' && view.unit('b').querySelector('.ring').dataset.mode === 'running');
    slow.releaseSaves();
    await settled();
    const latest = slow.getPlan().tasks;
    assert('queued save preserves the final pause and sibling start', latest.find((task) => task.id === 'a').paused && !latest.find((task) => task.id === 'a').running && latest.find((task) => task.id === 'b').running);
    assert('queued save leaves idle siblings untouched', latest.find((task) => task.id === 'c').spent_sec === 0 && !latest.find((task) => task.id === 'c').running);

    view = await fixture('base');
    overdue(view, 'a');
    normal(view, 'b');
    assert('countdown estimate drops the prefix and spaces', view.unit('a').querySelector('.estimate').textContent === '5分钟');
    assert('stopwatch has no estimate or divider', view.unit('b').querySelector('.estimate').hidden && view.unit('b').querySelector('.slash').hidden);
    assert('unstarted task remains idle', view.unit('c').querySelector('.ring').dataset.mode === 'idle');
    assert('unstarted ring stays hidden', view.win.getComputedStyle(view.unit('c').querySelector('.ring-fill')).opacity === '0');
    assert('unstarted task has no status dot', view.color('c', '.pulse', 'opacity') === '0');
    const gradients = () => [...view.doc.querySelectorAll('.slim-seg')].map((node) => view.win.getComputedStyle(node).backgroundImage);
    const before = gradients();
    assert('collapsed segments retain distinct identity gradients', before.length === 2 && before[0].includes('rgb(110, 123, 255)') && before[1].includes('rgb(34, 211, 238)'));
    view.doc.getElementById('collapse').click();
    await settled();
    assert('collapse preserves segment colours', view.doc.getElementById('stage').classList.contains('collapsed') && JSON.stringify(gradients()) === JSON.stringify(before));
    view.doc.getElementById('slim').click();
    await settled();
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
    assert('reused node clears obsolete warning dot', view.color('b', '.pulse', 'backgroundColor') === running && view.color('b', '.pulse', 'opacity') === '1');
    assert('reused running node has full ring brightness', view.color('b', '.ring-fill', 'opacity') === '1');
    assert('reused node has no extra status wording', view.unit('b').querySelector('.status').textContent === '' && view.unit('b').querySelector('.status').hidden);

    view = await fixture('compact');
    overdue(view, 'a');
    assert('10-minute estimate stays compact', view.unit('a').querySelector('.estimate').textContent === '10分钟');
    assert('mixed-hour estimate stays compact', view.unit('b').querySelector('.estimate').textContent === '1小时30分');
    assert('whole-hour estimate stays compact', view.unit('c').querySelector('.estimate').textContent === '1小时');

    view = await fixture('boundary');
    normal(view, 'a');
    normal(view, 'b');
    overdue(view, 'c');

    view = await fixture('single');
    overdue(view, 'a');
    assert('single collapsed bar retains overdue gradient', view.win.getComputedStyle(view.doc.getElementById('slimBar')).backgroundImage.includes('rgb(255, 178, 87)'));
    view = await fixture('colour-single');
    matchingStrip(view, 'b', 1, 'single running task after an unstarted task');
    view.doc.getElementById('collapse').click();
    await settled();
    matchingStrip(view, 'b', 1, 'collapsed single running task');
    view.doc.getElementById('slim').click();
    await settled();
    matchingStrip(view, 'b', 1, 'expanded single running task');
    view.unit('b').querySelector('.ring').click();
    matchingStrip(view, 'b', 1, 'paused cyan single task');
    normal(view, 'b');
    view.unit('b').querySelector('.ring').click();
    matchingStrip(view, 'b', 1, 'resumed cyan single task');
    normal(view, 'b');
    await settled();
    let coloursPlan = view.win.__smoke.getPlan();
    coloursPlan.tasks.push({ id: 'c', title: 'c', timer: 'down', est_min: 5, spent_sec: 60, running: true });
    await view.win.__smoke.setPlan(coloursPlan);
    assert('adding a started task switches to multiple strips', view.doc.getElementById('slimBar').hidden);
    matchingStrip(view, 'b', 1, 'cyan task after single-to-multiple transition');
    matchingStrip(view, 'c', 2, 'pink task after single-to-multiple transition');
    coloursPlan = view.win.__smoke.getPlan();
    coloursPlan.tasks = coloursPlan.tasks.filter((task) => task.id !== 'c');
    await view.win.__smoke.setPlan(coloursPlan);
    assert('removing the second started task restores the single strip', !view.doc.getElementById('slimBar').hidden);
    matchingStrip(view, 'b', 1, 'cyan task after multiple-to-single transition');
    coloursPlan = view.win.__smoke.getPlan();
    coloursPlan.tasks = coloursPlan.tasks.filter((task) => task.id !== 'a');
    await view.win.__smoke.setPlan(coloursPlan);
    matchingStrip(view, 'b', 0, 'single task after removing an earlier unstarted task');

    view = await fixture('colour-multi');
    matchingStrip(view, 'b', 1, 'cyan segment after an unstarted task');
    matchingStrip(view, 'c', 2, 'pink segment after an unstarted task');
    const reusedSegments = [...view.doc.querySelectorAll('.slim-seg')];
    coloursPlan = view.win.__smoke.getPlan();
    coloursPlan.tasks[0].done = true;
    await view.win.__smoke.setPlan(coloursPlan);
    assert('unchanged started ids reuse the segment nodes', [...view.doc.querySelectorAll('.slim-seg')].every((segment, index) => segment === reusedSegments[index]));
    matchingStrip(view, 'b', 0, 'reused segment after earlier task completion');
    matchingStrip(view, 'c', 1, 'reused second segment after earlier task completion');

    view = await fixture('colour-third');
    matchingStrip(view, 'c', 2, 'single running task after two unstarted tasks');
    view = await fixture('colour-pinned');
    matchingStrip(view, 'd', 2, 'running task kept visible by the common started-task rule');

    view = await fixture('single');
    view.unit('a').querySelector('.ring').click();
    matchingStrip(view, 'a', 0, 'paused overdue single task');
    normal(view, 'a');
    assert('paused overdue single strip becomes dim', view.win.getComputedStyle(view.doc.getElementById('slimBar')).opacity === '0.45');
    view.unit('a').querySelector('.ring').click();
    overdue(view, 'a');
    assert('resumed overdue single strip becomes amber again', view.win.getComputedStyle(view.doc.getElementById('slimBar')).backgroundImage.includes('rgb(255, 178, 87)'));

    view = await fixture('done-upcoming');
    assert('pending tasks use an aggregate state rather than one selected task state', view.doc.getElementById('bar').dataset.state === 'active');
    usableDone(view, 'c', 'running task beside future tasks');
    assert('future tasks do not dim the running progress ring', view.color('c', '.ring-fill', 'opacity') === '1');
    usableDone(view, 'a', 'future task beside a running task');
    view.unit('c').querySelector('.ring').click();
    await settled();
    assert('background task pauses without selecting a future task', view.unit('c').querySelector('.ring').dataset.mode === 'paused');
    normal(view, 'c');
    usableDone(view, 'c', 'paused task beside future tasks');
    view.unit('c').querySelector('.ring').click();
    await settled();
    normal(view, 'c');
    view.unit('c').querySelector('.done').click();
    await settled();
    let finished = view.win.__smoke.getPlan();
    assert('done completes only the clicked running task and stops its timer', finished.tasks.find((task) => task.id === 'c').done && !finished.tasks.find((task) => task.id === 'c').running);
    assert('finishing a background task preserves future tasks', finished.tasks.filter((task) => task.id !== 'c').every((task) => !task.done && !task.running));
    assert('completed background task leaves the expanded bar', !view.unit('c'));

    view = await fixture('done-upcoming-only');
    usableDone(view, 'a', 'future task without running tasks');
    view.unit('b').querySelector('.done').click();
    await settled();
    finished = view.win.__smoke.getPlan();
    assert('future task can finish without starting either timer', finished.tasks.find((task) => task.id === 'b').done && finished.tasks.every((task) => !task.running));
    assert('completing a future task leaves the other pending', !finished.tasks.find((task) => task.id === 'a').done);
    for (const [scene, state] of [['done-empty', 'empty'], ['done-complete', 'complete']]) {
      view = await fixture(scene);
      const button = view.doc.querySelector('.unit .done');
      const style = view.win.getComputedStyle(button);
      assert(`${state}: placeholder has no usable done button`, view.doc.getElementById('bar').dataset.state === state && button.disabled && style.opacity === '0' && style.pointerEvents === 'none');
    }
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
