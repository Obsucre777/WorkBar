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

function bootstrap(catalogs) {
  const listeners = new Map();
  let language = window.parent.__fixtureLanguage || 'zh-CN';
  const languageInfo = () => ({ preference: language, locale: language, messages: catalogs[language] });
  let shortcut = { shortcut: 'Alt+W', default_shortcut: 'Alt+W', registered: true, error: null };
  const savedShortcuts = [];
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
  if (scene === 'paging') plan.tasks = 'abcdefgh'.split('').map((id) => ({
    ...countdown(id), title: `任务 ${id}：固定长度的卡片与独立计时`,
    running: id !== 'c', paused: id === 'c',
  }));
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
  let blockResizes = false;
  let blockResizeCompletions = false;
  const resizeRequests = [];
  const contentRequests = [];
  const nativeWidthLimit = window.parent.__fixtureNativeWidthLimit;
  let contentWidth = null;
  let appliedContentWidth = null;
  let canvasResizes = 0;
  let contentFitHeld = false;
  let nativeCollapsed = false;
  const pendingSaves = [];
  const actionRequests = [];
  let failRead = false;
  let failAction = false;
  let holdRead = false;
  const pendingReads = [];
  if (window.parent.__fixturePlan) plan = clone(window.parent.__fixturePlan);
  function prepare(next) {
    next = clone(next);
    next.date = today;
    for (const task of next.tasks) {
      task.elapsed_ms = Number.isFinite(task.elapsed_ms) ? task.elapsed_ms : (task.spent_sec || 0) * 1000;
      if (task.running && !task.done) {
        if (!Number.isFinite(task.running_since_ms)) task.running_since_ms = now;
      } else {
        if (Number.isFinite(task.running_since_ms)) task.elapsed_ms += Math.max(0, now - task.running_since_ms);
        task.running_since_ms = null;
      }
      if (!task.running && !task.done && task.elapsed_ms > 0) task.paused = true;
    }
    return next;
  }
  plan = prepare(plan);
  function readBackend() {
    for (const task of plan.tasks) {
      const minute = (value) => value ? Number(value.split(':')[0]) * 60 + Number(value.split(':')[1]) : null;
      const start = minute(task.start);
      const end = minute(task.end);
      const current = new Date().getHours() * 60 + new Date().getMinutes();
      if (!task.running && !task.paused && !task.done && task.elapsed_ms === 0
          && start !== null && current >= start && (end === null || current < end)) {
        task.running = true;
        task.running_since_ms = now;
      }
    }
    const result = clone(plan);
    for (const task of result.tasks) {
      task.spent_sec = Math.floor((task.elapsed_ms + (task.running ? Math.max(0, now - task.running_since_ms) : 0)) / 1000);
    }
    return result;
  }
  function performAction(args) {
    const task = plan.tasks.find((item) => item.id === args.id);
    if (!task) throw new Error('Task not found');
    if (task.running && args.action !== 'start') {
      task.elapsed_ms += Math.max(0, now - task.running_since_ms);
    }
    if (!task.running && args.action === 'start') task.running_since_ms = now;
    if (args.action !== 'start') task.running_since_ms = null;
    task.running = args.action === 'start';
    task.paused = args.action === 'pause';
    task.done = args.action === 'complete';
    return readBackend();
  }
  async function emit(name, payload) {
    for (const handler of listeners.get(name) || []) await handler({ payload });
  }
  function nativeResize(collapsed, dispatchResize = true) {
    nativeCollapsed = collapsed;
    if (Number.isFinite(nativeWidthLimit)) {
      window.frameElement.style.width = `${collapsed ? 1536 : nativeWidthLimit}px`;
      appliedContentWidth = collapsed ? 1536 : contentWidth;
      canvasResizes += 1;
    }
    window.frameElement.style.height = collapsed ? '4px' : '100px';
    if (dispatchResize) window.dispatchEvent(new Event('resize'));
    if (!blockResizeCompletions) queueMicrotask(() => emit('bar-resized', collapsed));
  }
  function applyContentWidth() {
    if (nativeCollapsed || contentWidth === null) return;
    appliedContentWidth = contentWidth;
    if (window.innerWidth !== nativeWidthLimit) {
      window.frameElement.style.width = `${nativeWidthLimit}px`;
      canvasResizes += 1;
      window.dispatchEvent(new Event('resize'));
    }
  }
  window.__smoke = {
    async setLanguage(locale) { language = locale; await emit('language-changed', languageInfo()); },
    savedShortcuts: () => savedShortcuts.slice(),
    async setShortcutError(error) { shortcut.error = error; await emit('shortcut-settings-opened'); },
    getPlan: () => readBackend(),
    actionRequests: () => clone(actionRequests),
    failNextRead: () => { failRead = true; },
    failNextAction: () => { failAction = true; },
    holdNextRead: () => { holdRead = true; },
    releaseRead: () => { const pending = pendingReads.shift(); if (pending) pending.resolve(pending.snapshot); },
    holdSaves: () => { blockSaves = true; },
    holdResizes: () => { blockResizes = true; },
    holdResizeCompletions: () => { blockResizeCompletions = true; },
    resizeRequests: () => resizeRequests.slice(),
    nativeResize,
    contentRequests: () => contentRequests.slice(),
    contentWidth: () => contentWidth,
    appliedContentWidth: () => appliedContentWidth,
    canvasResizes: () => canvasResizes,
    holdContentWidth: () => { contentFitHeld = true; },
    applyContentWidth,
    pendingSaves: () => pendingSaves.length,
    releaseSave() {
      const pending = pendingSaves.shift();
      if (pending) pending.resolve(performAction(pending.args));
    },
    releaseSaves() {
      blockSaves = false;
      while (pendingSaves.length) this.releaseSave();
    },
    async setPlan(next) { plan = prepare(next); await emit('plan-changed'); },
    async setClock(hours, minutes, seconds = 0) {
      now = new RealDate(now).setHours(hours, minutes, seconds, 0);
      await emit('plan-changed');
      await emit('clock-tick');
    },
    emit,
  };
  window.__TAURI__ = {
    core: {
      async invoke(command, args) {
        if (command === 'get_language') return languageInfo();
        if (command === 'get_shortcut') return clone(shortcut);
        if (command === 'save_shortcut') { savedShortcuts.push(args.shortcut); shortcut.shortcut = args.shortcut; return clone(shortcut); }
        if (command === 'set_shortcut_recording' || command === 'close_shortcut_settings') return;
        if (command === 'get_plan') {
          if (failRead) { failRead = false; throw new Error('Simulated database read error'); }
          if (holdRead) {
            holdRead = false;
            return new Promise((resolve) => pendingReads.push({ resolve, snapshot: readBackend() }));
          }
          return readBackend();
        }
        if (command === 'task_action') {
          actionRequests.push(clone(args));
          if (failAction) { failAction = false; throw new Error('Simulated database write error'); }
          if (blockSaves) return new Promise((resolve) => pendingSaves.push({ args: clone(args), resolve }));
          return performAction(args);
        }
        if (command === 'trace_js') return;
        if (command === 'sync_task_count') {
          contentRequests.push(args.count);
          if (!Number.isFinite(nativeWidthLimit)) return {};
          const compact = Math.max(1, Math.min(4, args.count)) * 240 + 70;
          contentWidth = args.count <= 4 && compact <= nativeWidthLimit ? compact
            : Math.max(1, Math.min(4, Math.floor((nativeWidthLimit - 134) / 240))) * 240 + 134;
          if (!contentFitHeld) queueMicrotask(applyContentWidth);
          return { maxWidth: nativeWidthLimit };
        }
        if (command === 'set_collapsed') {
          resizeRequests.push(args.collapsed);
          if (!blockResizes) nativeResize(args.collapsed);
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
  const nativeMatchMedia = window.matchMedia.bind(window);
  const cardMotion = window.parent.__fixtureCardMotion === true;
  window.matchMedia = (query) => query === '(prefers-reduced-motion: reduce)'
    ? { matches: !cardMotion }
    : nativeMatchMedia(query);
  if (!window.parent.__fixtureCssMotion) {
    const style = document.createElement('style');
    style.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; }';
    document.head.append(style);
  }
}

async function runInBrowser() {
  const checks = [];
  let frame;
  const assert = (message, condition) => {
    checks.push({ name: message, ok: Boolean(condition) });
    if (!condition) throw new Error(message);
  };
  async function fixture(scene, restoredPlan = null, clock = null, cardMotion = false, cssMotion = false, nativeWidthLimit = null) {
    if (frame) frame.remove();
    window.__fixturePlan = restoredPlan;
    window.__fixtureClock = clock;
    window.__fixtureCardMotion = cardMotion;
    window.__fixtureCssMotion = cssMotion;
    window.__fixtureNativeWidthLimit = nativeWidthLimit;
    frame = document.createElement('iframe');
    frame.style.cssText = 'width:1128px;height:100px;border:0';
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
    const palette = [identity.a, identity.b, identity.c, 'rgb(110, 231, 183)'];
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
    // Keep real CSS transitions enabled and sample their rendered intermediate
    // opacity. Neither animation completion nor native acknowledgement is used
    // to advance the window, including interrupted/reversed fades.
    let view = await fixture('base', null, null, false, true);
    view.win.__smoke.holdResizes();
    view.win.__smoke.holdResizeCompletions();
    view.doc.getElementById('collapse').click();
    view.win.__smoke.nativeResize(true);
    const line = view.doc.getElementById('slim');
    const lineOpacity = () => Number(view.win.getComputedStyle(line).opacity);
    const lineFade = () => {
      lineOpacity(); // Flush style so a pending CSS transition exists.
      return line.getAnimations().find((animation) => animation.transitionProperty === 'opacity' && animation.playState !== 'finished');
    };
    let fade = lineFade();
    assert('real motion: collapsing starts a line fade-in', Boolean(fade));
    fade.pause();
    const fadeInDuration = Number(fade.effect.getTiming().duration);
    fade.currentTime = fadeInDuration / 2;
    assert('real motion: line fade-in has intermediate visible opacity', lineOpacity() > 0 && lineOpacity() < 1);
    fade.finish();
    assert('real motion: line becomes fully visible without acknowledgement', lineOpacity() === 1);
    view.doc.getElementById('slim').click();
    fade = lineFade();
    assert('real motion: expanding fades the line before resizing', Boolean(fade));
    fade.pause();
    const fadeOutDuration = Number(fade.effect.getTiming().duration);
    assert('real motion: line fade-out fits the native expansion grace', fadeOutDuration > 0 && fadeOutDuration <= 180);
    fade.currentTime = fadeOutDuration / 2;
    assert('real motion: line fade-out has intermediate visible opacity', lineOpacity() > 0 && lineOpacity() < 1);
    // Grow before the fade completes, with JS resize handling also delayed.
    view.win.__smoke.nativeResize(false, false);
    const lineAfterExpand = view.win.getComputedStyle(view.doc.getElementById('slim'));
    assert('real motion: no unfinished fade survives into the tall viewport', lineAfterExpand.opacity === '0' && lineAfterExpand.visibility === 'hidden');
    assert('real motion: the hidden line cannot intercept expanded controls', lineAfterExpand.pointerEvents === 'none');
    view.win.dispatchEvent(new view.win.Event('resize'));
    assert('real motion: resize cleanup releases the expansion phase', !view.doc.getElementById('stage').classList.contains('expanding'));
    view.doc.getElementById('collapse').click();
    view.win.__smoke.nativeResize(true);
    fade = lineFade();
    assert('real motion: a second collapse starts a fresh fade-in', Boolean(fade));
    fade.pause();
    fade.currentTime = Number(fade.effect.getTiming().duration) / 2;
    const interruptedOpacity = lineOpacity();
    view.doc.getElementById('slim').click();
    assert('real motion: reversing a fade never flashes back to full brightness', Math.abs(lineOpacity() - interruptedOpacity) < 0.02);
    view.doc.getElementById('collapse').click();
    fade = lineFade();
    assert('real motion: cancelling expansion returns the line smoothly', Boolean(fade) && !view.doc.getElementById('stage').classList.contains('expanding'));
    fade.finish();
    assert('real motion: cancelled expansion leaves the line visible and clickable', lineOpacity() === 1 && view.win.getComputedStyle(line).pointerEvents === 'auto');

    // Reproduce delayed/dropped completion messages without waiting in real
    // time. Native geometry changes independently of both events and rAF.
    view = await fixture('base');
    view.win.__smoke.holdResizes();
    view.win.__smoke.holdResizeCompletions();
    view.win.requestAnimationFrame = () => 0;
    const slimStyle = () => view.win.getComputedStyle(view.doc.getElementById('slim'));
    const barStyle = () => view.win.getComputedStyle(view.doc.getElementById('bar'));
    assert('expanded viewport hides the line', slimStyle().opacity === '0' && slimStyle().pointerEvents === 'none');
    view.doc.getElementById('collapse').click();
    assert('collapse cannot stretch the line inside the tall viewport', slimStyle().opacity === '0');
    view.win.__smoke.nativeResize(true);
    assert('line appears with no completion event or animation frame', slimStyle().opacity === '1' && slimStyle().display !== 'none');
    assert('collapsed line remains clickable without acknowledgement', slimStyle().pointerEvents === 'auto');
    assert('collapsed viewport hides the capsule', barStyle().visibility === 'hidden');
    view.doc.getElementById('slim').click();
    assert('expanding cannot flash a clipped capsule in the small viewport', barStyle().visibility === 'hidden');
    view.win.__smoke.nativeResize(false);
    assert('capsule returns without a completion event or animation frame', barStyle().visibility === 'visible' && barStyle().opacity === '1');
    assert('expanded viewport cannot leave a stale line visible', slimStyle().opacity === '0' && slimStyle().pointerEvents === 'none');
    await view.win.__smoke.emit('bar-resized', true);
    assert('late collapse completion cannot undo a newer expansion', !view.doc.getElementById('stage').classList.contains('collapsed') && slimStyle().opacity === '0');
    assert('each button action requests exactly one native resize', view.win.__smoke.resizeRequests().join(',') === 'true,false');
    await view.win.__smoke.emit('bar-toggle', true);
    view.win.__smoke.nativeResize(true);
    await view.win.__smoke.emit('bar-toggle', false);
    view.win.__smoke.nativeResize(false);
    assert('native toggles never submit duplicate resize requests', view.win.__smoke.resizeRequests().join(',') === 'true,false');
    assert('native expansion also finishes without acknowledgement', barStyle().opacity === '1' && slimStyle().opacity === '0');
    // Even a delayed JS toggle handler cannot keep the native 4px strip blank.
    view.win.__smoke.nativeResize(true);
    assert('small viewport reveals the line before JS handles the toggle', slimStyle().opacity === '1' && slimStyle().pointerEvents === 'auto');

    view = await fixture('independent-idle');
    for (const id of ['a', 'b', 'c']) idleState(view, id, `idle position ${id}`);
    view = await fixture('independent-legacy');
    for (const id of ['a', 'b', 'c']) idleState(view, id, `legacy selection position ${id}`);
    assert('legacy current id does not highlight a unit', !view.doc.querySelector('.unit.current'));
    view = await fixture('independent-visibility');
    assert('legacy current id does not change the four visible idle tasks', ['a', 'b', 'c', 'd'].every((id) => view.unit(id)));

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

    view = await fixture('independent-idle');
    const race = view.win.__smoke;
    race.holdSaves();
    view.unit('a').querySelector('.ring').click();
    const concurrent = race.getPlan();
    concurrent.tasks.push({ id: 'new-mcp', title: 'added by MCP', timer: 'up', running: false });
    await race.setPlan(concurrent);
    race.releaseSaves();
    await settled();
    assert('a delayed UI action cannot remove a concurrent MCP addition', race.getPlan().tasks.some((task) => task.id === 'new-mcp') && Boolean(view.unit('new-mcp')));
    assert('UI sends only id and action, never a task snapshot', race.actionRequests().every((args) => Object.keys(args).sort().join(',') === 'action,id'));

    view = await fixture('base');
    const stable = view.win.__smoke;
    const runningBaseline = stable.getPlan().tasks.find((task) => task.id === 'a');
    await stable.setClock(12, 5, 17);
    assert('missed timer frames catch up from the persisted timestamp', view.unit('a').querySelector('.elapsed').textContent === '12:06');
    assert('live timer refreshes never submit database writes', stable.actionRequests().length === 0);
    assert('live timer refreshes preserve the persisted elapsed baseline', stable.getPlan().tasks.find((task) => task.id === 'a').elapsed_ms === runningBaseline.elapsed_ms);
    stable.failNextRead();
    await stable.emit('plan-changed');
    assert('a database read failure keeps the last displayed tasks', Boolean(view.unit('a')) && Boolean(view.unit('b')) && stable.actionRequests().length === 0);
    stable.failNextAction();
    view.unit('a').querySelector('.ring').click();
    await settled();
    assert('a failed pause recovers the backend running state', view.unit('a').querySelector('.ring').dataset.mode === 'running' && stable.getPlan().tasks.find((task) => task.id === 'a').running);
    assert('a failed action is surfaced and not blindly replayed', view.doc.getElementById('bar').title.includes('未保存') && stable.actionRequests().length === 1);

    view = await fixture('independent-idle');
    const delayed = view.win.__smoke;
    delayed.holdNextRead();
    const oldRead = delayed.emit('plan-changed');
    view.unit('a').querySelector('.ring').click();
    await settled();
    delayed.holdNextRead();
    delayed.releaseRead();
    await oldRead;
    await settled();
    assert('a read started before an action cannot restore an obsolete idle state', view.unit('a').querySelector('.ring').dataset.mode === 'running');
    delayed.releaseRead();
    await settled();

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
    const reused = view.unit('b');
    const next = view.win.__smoke.getPlan();
    next.current_id = 'b';
    next.tasks = next.tasks.filter((task) => task.id !== 'a');
    next.tasks.push({ id: 'd', title: 'replacement', timer: 'down', est_min: 5, spent_sec: 0, running: false });
    await view.win.__smoke.setPlan(next);
    assert('renderer preserves each task node when an earlier task is removed', view.unit('b') === reused);
    assert('reused node clears obsolete overdue style and keeps its task colour', view.color('b', '.ring-fill', 'stroke') === identity.b && view.color('b', '.elapsed', 'color') === normalTime);
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
    matchingStrip(view, 'b', 1, 'single task keeps cyan after removing an earlier unstarted task');

    view = await fixture('colour-multi');
    matchingStrip(view, 'b', 1, 'cyan segment after an unstarted task');
    matchingStrip(view, 'c', 2, 'pink segment after an unstarted task');
    const reusedSegments = [...view.doc.querySelectorAll('.slim-seg')];
    coloursPlan = view.win.__smoke.getPlan();
    coloursPlan.tasks[0].done = true;
    await view.win.__smoke.setPlan(coloursPlan);
    assert('unchanged started ids reuse the segment nodes', [...view.doc.querySelectorAll('.slim-seg')].every((segment, index) => segment === reusedSegments[index]));
    matchingStrip(view, 'b', 1, 'reused segment keeps cyan after earlier task completion');
    matchingStrip(view, 'c', 2, 'reused second segment keeps pink after earlier task completion');

    view = await fixture('colour-third');
    matchingStrip(view, 'c', 2, 'single running task after two unstarted tasks');
    view = await fixture('colour-pinned');
    matchingStrip(view, 'd', 3, 'fourth running task retains its own identity colour');

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

    // Navigation changes only the viewed window; task state and colours belong
    // to the tasks, including the running tasks outside that window.
    const visibleTasks = () => [...view.doc.querySelectorAll('#units > .unit')].map((node) => node.dataset.id);
    const previousTasks = () => view.doc.getElementById('previousTasks');
    const nextTasks = () => view.doc.getElementById('nextTasks');
    function fixedCards(label) {
      const viewport = view.doc.getElementById('taskViewport').getBoundingClientRect();
      for (const node of view.doc.querySelectorAll('.unit')) {
        const rect = node.getBoundingClientRect();
        const ring = node.querySelector('.ring').getBoundingClientRect();
        const done = node.querySelector('.done').getBoundingClientRect();
        assert(`${label}: ${node.dataset.id} stays 240px wide`, rect.width === 240);
        assert(`${label}: ${node.dataset.id} keeps full-size controls`, ring.width === 38 && done.width === 26);
        assert(`${label}: ${node.dataset.id} controls fit inside the viewport`, ring.left >= viewport.left && done.right <= viewport.right);
      }
    }
    view = await fixture('paging');
    const queueBase = view.win.__smoke.getPlan();
    const queueIds = ['z', 'a', 'm', 'b', 'y'];
    view = await fixture('paging', { ...queueBase, tasks: queueIds.map((id, index) => ({
      id, title: id, timer: 'up', start: index % 2 ? '23:58' : '23:59', spent_sec: 0, running: false,
    })) });
    assert('queue uses input order instead of ids or scheduled times', visibleTasks().join(',') === 'z,a,m,b');
    let queuePlan = view.win.__smoke.getPlan();
    queuePlan.tasks.push(
      { id: '00', title: 'new first in batch', timer: 'up', start: '00:00', paused: true, spent_sec: 0, running: false },
      { id: '01', title: 'new second in batch', timer: 'up', spent_sec: 0, running: false },
    );
    await view.win.__smoke.setPlan(queuePlan);
    assert('adding tasks preserves the current view', visibleTasks().join(',') === 'z,a,m,b');
    for (let index = 0; index < 3; index += 1) nextTasks().click();
    assert('new low-id tasks appear at the tail in input order', visibleTasks().join(',') === 'b,y,00,01');
    for (let index = 0; index < 3; index += 1) previousTasks().click();
    queuePlan = view.win.__smoke.getPlan();
    queuePlan.tasks[0].start = '00:00';
    queuePlan.tasks[0].paused = true;
    await view.win.__smoke.setPlan(queuePlan);
    view.unit('a').querySelector('.ring').click();
    await settled();
    view.unit('a').querySelector('.ring').click();
    await settled();
    assert('time edits and timer toggles never move cards', visibleTasks().join(',') === 'z,a,m,b');
    view.unit('m').querySelector('.done').click();
    await settled();
    assert('completion fills the queue gap without reordering survivors', visibleTasks().join(',') === 'z,a,b,y');
    view = await fixture('paging', view.win.__smoke.getPlan());
    assert('queue order survives a renderer reload', visibleTasks().join(',') === 'z,a,b,y');
    queuePlan = view.win.__smoke.getPlan();
    queuePlan.tasks.reverse();
    view = await fixture('paging', queuePlan);
    assert('an explicitly reordered queue is displayed in its saved order', visibleTasks().join(',') === '01,00,y,b');

    view = await fixture('paging');
    const pagingPlan = view.win.__smoke.getPlan();
    for (const count of [1, 2, 3, 4]) {
      view = await fixture('paging', { ...pagingPlan, tasks: pagingPlan.tasks.slice(0, count) });
      assert(`${count} tasks fit without navigation`, visibleTasks().length === count && previousTasks().hidden && nextTasks().hidden);
      const pill = view.doc.getElementById('bar').getBoundingClientRect();
      assert(`${count} tasks only occupy their own card slots and controls`, Math.abs(pill.width - (count * 240 + 62)) < 0.1);
      assert(`${count} task capsule stays centered`, Math.abs((pill.left + pill.right) / 2 - view.win.innerWidth / 2) < 0.1);
      fixedCards(`${count} visible tasks`);
    }
    for (const count of [0, 1, 2, 3, 4, 5]) {
      view = await fixture('paging', { ...pagingPlan, tasks: pagingPlan.tasks.slice(0, count) }, null, false, false, 1094);
      await settled();
      const expectedWidth = count > 4 ? 1094 : Math.max(1, count) * 240 + 70;
      assert(`native fit ${count}: region trims transparent outer space without resizing the canvas`, view.win.__smoke.appliedContentWidth() === expectedWidth && view.win.innerWidth === 1094 && Math.abs(view.doc.getElementById('bar').getBoundingClientRect().width - (expectedWidth - 8)) < 0.1);
      assert(`native fit ${count}: arrows only appear for overflowing tasks`, previousTasks().hidden === (count <= 4) && nextTasks().hidden === (count <= 4));
    }
    view = await fixture('paging', { ...pagingPlan, tasks: pagingPlan.tasks.slice(0, 1) }, null, false, false, 1094);
    await settled();
    const grownPlan = view.win.__smoke.getPlan();
    grownPlan.tasks = pagingPlan.tasks.slice(0, 5);
    await view.win.__smoke.setPlan(grownPlan);
    await settled();
    assert('a one-card native region can grow back to four cards and arrows', view.win.innerWidth === 1094 && visibleTasks().join('') === 'abcd' && !nextTasks().hidden);
    const fitRequestsBeforeBrowse = view.win.__smoke.contentRequests().length;
    nextTasks().click();
    await settled();
    await view.win.__smoke.setClock(12, 0, 1);
    assert('browsing and clock ticks do not repeatedly resize the native window', view.win.__smoke.contentRequests().length === fitRequestsBeforeBrowse);
    view.unit('e').querySelector('.done').click();
    await settled();
    assert('five-to-four tasks releases the unused arrow width', view.win.__smoke.appliedContentWidth() === 1030 && previousTasks().hidden && visibleTasks().join('') === 'abcd');
    for (const id of ['b', 'c', 'd']) {
      view.unit(id).querySelector('.done').click();
      await settled();
    }
    assert('completion down to one task returns to a compact native region', view.win.__smoke.appliedContentWidth() === 310 && visibleTasks().join('') === 'a');
    view.doc.getElementById('collapse').click();
    await settled();
    const changedWhileCollapsed = view.win.__smoke.getPlan();
    changedWhileCollapsed.tasks.push(...pagingPlan.tasks.slice(5, 8));
    await view.win.__smoke.setPlan(changedWhileCollapsed);
    await settled();
    assert('content changes keep the collapsed line full-width', view.win.innerHeight === 4 && view.win.innerWidth === 1536 && view.win.__smoke.contentWidth() === 1030);
    view.doc.getElementById('slim').click();
    await settled();
    assert('expanding uses the latest task count from the collapsed state', view.win.__smoke.appliedContentWidth() === 1030 && visibleTasks().join('') === 'afgh' && previousTasks().hidden);
    view = await fixture('paging', { ...pagingPlan, tasks: pagingPlan.tasks.slice(0, 3) }, null, false, false, 790);
    await settled();
    assert('narrow screen fits three cards without arrows when all tasks fit', visibleTasks().join('') === 'abc' && view.win.innerWidth === 790 && previousTasks().hidden);
    const narrowOverflow = view.win.__smoke.getPlan();
    narrowOverflow.tasks.push(pagingPlan.tasks[3]);
    await view.win.__smoke.setPlan(narrowOverflow);
    await settled();
    assert('narrow screen reserves navigation only after tasks overflow', visibleTasks().join('') === 'ab' && view.win.__smoke.appliedContentWidth() === 614 && !nextTasks().hidden);

    view = await fixture('paging');
    assert('overflow starts with exactly four tasks', visibleTasks().join('') === 'abcd');
    assert('overflow shows both arrows with a disabled left boundary', !previousTasks().hidden && !nextTasks().hidden && previousTasks().disabled && !nextTasks().disabled);
    assert('collapsed line includes tasks outside the visible window', view.doc.querySelectorAll('.slim-seg').length === 8);
    const pagingBefore = JSON.stringify(view.win.__smoke.getPlan());
    const pagingSegments = [...view.doc.querySelectorAll('.slim-seg')];
    const cyanBefore = view.color('b', '.ring-fill', 'stroke');
    nextTasks().click();
    assert('right arrow advances by one task', visibleTasks().join('') === 'bcde');
    assert('a task keeps its colour after moving to a different slot', view.color('b', '.ring-fill', 'stroke') === cyanBefore);
    assert('browsing does not mutate or save task state', JSON.stringify(view.win.__smoke.getPlan()) === pagingBefore);
    assert('browsing preserves every collapsed segment node', [...view.doc.querySelectorAll('.slim-seg')].every((node, index) => node === pagingSegments[index]));
    fixedCards('after moving right');
    matchingStrip(view, 'd', 3, 'fourth colour survives browsing');
    previousTasks().click();
    assert('left arrow returns to the previous window', visibleTasks().join('') === 'abcd');
    previousTasks().click();
    assert('left boundary cannot advance before the first task', visibleTasks().join('') === 'abcd');
    await view.win.__smoke.setClock(12, 0, 5);
    for (let index = 0; index < 4; index += 1) nextTasks().click();
    assert('last window contains the last four tasks', visibleTasks().join('') === 'efgh');
    assert('right boundary disables the next arrow', nextTasks().disabled && !previousTasks().disabled);
    assert('offscreen task keeps counting while browsing other tasks', view.unit('g').querySelector('.elapsed').textContent === '01:05');
    nextTasks().click();
    assert('right boundary cannot create an empty page', visibleTasks().join('') === 'efgh');
    view.unit('h').querySelector('.done').click();
    await settled();
    assert('finishing a task on the last window fills the remaining four slots', visibleTasks().join('') === 'defg');
    let pagingSaved = view.win.__smoke.getPlan();
    assert('last-window completion only completes its own task', pagingSaved.tasks.find((task) => task.id === 'h').done && pagingSaved.tasks.filter((task) => task.id !== 'h').every((task) => !task.done));
    assert('offscreen running task survives completion on another window', pagingSaved.tasks.find((task) => task.id === 'a').running);
    pagingSaved.tasks = pagingSaved.tasks.filter((task) => !['e', 'f', 'g'].includes(task.id));
    await view.win.__smoke.setPlan(pagingSaved);
    assert('external removals clamp the window and hide unused arrows', visibleTasks().join('') === 'abcd' && previousTasks().hidden && nextTasks().hidden);
    fixedCards('after external removals');

    view = await fixture('paging');
    nextTasks().click();
    const inserted = view.win.__smoke.getPlan();
    inserted.tasks.push({ id: '00', title: '新加的未开始任务', timer: 'up', spent_sec: 0, running: false });
    await view.win.__smoke.setPlan(inserted);
    assert('appending a low-id task preserves the visible anchor', visibleTasks().join('') === 'bcde');
    view.unit('e').querySelector('.ring').click();
    await settled();
    const pausedOnPage = view.win.__smoke.getPlan();
    assert('a reused card button pauses the displayed task', pausedOnPage.tasks.find((task) => task.id === 'e').paused && !pausedOnPage.tasks.find((task) => task.id === 'e').running);
    assert('pausing a displayed task does not start a newly inserted task', !pausedOnPage.tasks.find((task) => task.id === '00').running && pausedOnPage.tasks.find((task) => task.id === 'a').running);
    assert('pausing preserves the viewed task order', visibleTasks().join('') === 'bcde');
    previousTasks().click();
    nextTasks().click();
    assert('paused state survives moving away and back', view.unit('e').querySelector('.ring').dataset.mode === 'paused');
    frame.style.width = '780px';
    view.win.dispatchEvent(new view.win.Event('resize'));
    assert('narrow windows show fewer complete cards', visibleTasks().length === 2 && !previousTasks().hidden && !nextTasks().hidden);
    fixedCards('narrow window');
    frame.style.width = '1128px';
    view.win.dispatchEvent(new view.win.Event('resize'));
    assert('widening restores four complete cards', visibleTasks().length === 4);
    fixedCards('restored window');
    view.doc.getElementById('collapse').click();
    await settled();
    view.doc.getElementById('slim').click();
    await settled();
    assert('collapse and expand preserve the browsed window', visibleTasks().join('') === 'bcde');
    const onlyLastRunning = { ...pagingPlan, tasks: pagingPlan.tasks.map((task) => ({ ...task, running: task.id === 'h', paused: false, spent_sec: task.id === 'h' ? 60 : 0 })) };
    view = await fixture('paging', onlyLastRunning);
    assert('initial window starts at the queue front even when a later task is running', visibleTasks().join('') === 'abcd');
    for (let index = 0; index < 4; index += 1) nextTasks().click();
    assert('navigation can reach the later running task without promoting it', Boolean(view.unit('h')));

    // Reproduce the position-based colour bug with opaque ids, then verify the
    // same identities after completion, deletion, sorting and a full reload.
    const stableIds = ['t9f1e35a0', 't1b22e3c4', '任务-🕘-alpha', 't00445566'];
    view = await fixture('paging', { ...pagingPlan, tasks: stableIds.map((id) => ({
      id, title: id, timer: 'up', spent_sec: 60, running: true,
    })) });
    const stableColours = new Map(stableIds.map((id) => {
      const segment = view.doc.querySelector(`.slim-seg[data-id="${id}"]`);
      return [id, {
        slot: view.unit(id).dataset.color,
        stroke: view.color(id, '.ring-fill', 'stroke'),
        gradient: view.win.getComputedStyle(segment).getPropertyValue('--task-line').trim(),
      }];
    }));
    function unchangedColours(label) {
      const remaining = view.win.__smoke.getPlan().tasks.filter((task) => !task.done && stableColours.has(task.id));
      for (const task of remaining) {
        const expected = stableColours.get(task.id);
        const unit = view.unit(task.id);
        if (unit) {
          assert(`${label}: ${task.id} keeps its expanded colour`, unit.dataset.color === expected.slot && view.color(task.id, '.ring-fill', 'stroke') === expected.stroke);
        }
        const strip = view.doc.getElementById('slimBar').hidden
          ? view.doc.querySelector(`.slim-seg[data-id="${task.id}"]`)
          : view.doc.getElementById('slimBar');
        assert(`${label}: ${task.id} keeps its collapsed colour`, strip.dataset.color === expected.slot && view.win.getComputedStyle(strip).getPropertyValue('--task-line').trim() === expected.gradient);
      }
    }
    const firstCompletedId = visibleTasks()[0];
    view.unit(firstCompletedId).querySelector('.done').click();
    await settled();
    unchangedColours('earlier task completed');
    const nextDeletedId = visibleTasks()[0];
    let fixedPlan = view.win.__smoke.getPlan();
    fixedPlan.tasks = fixedPlan.tasks.filter((task) => ![firstCompletedId, nextDeletedId].includes(task.id));
    await view.win.__smoke.setPlan(fixedPlan);
    unchangedColours('earlier task deleted');
    fixedPlan = view.win.__smoke.getPlan();
    fixedPlan.tasks.reverse();
    fixedPlan.tasks.forEach((task, index) => {
      task.start = index === 0 ? '23:59' : '23:58';
      task.title = `修改后的标题 ${index}`;
      task.note = '改变标题和计划时间不改变任务身份';
    });
    await view.win.__smoke.setPlan(fixedPlan);
    unchangedColours('tasks renamed and reordered');
    view.unit(visibleTasks()[0]).querySelector('.ring').click();
    await settled();
    unchangedColours('task paused');
    view = await fixture('paging', view.win.__smoke.getPlan());
    unchangedColours('full renderer reload');
    fixedPlan = view.win.__smoke.getPlan();
    fixedPlan.tasks.unshift({ id: '000new', title: '新加在前面的任务', timer: 'up', spent_sec: 1, running: true });
    fixedPlan.tasks.push({ id: firstCompletedId, title: '重新打开原来的任务', timer: 'up', spent_sec: 60, running: true });
    await view.win.__smoke.setPlan(fixedPlan);
    unchangedColours('new task inserted and completed task reopened');
    view = await fixture('paging', view.win.__smoke.getPlan());
    unchangedColours('reload after insertion and reopening');
    fixedPlan = view.win.__smoke.getPlan();
    fixedPlan.tasks = fixedPlan.tasks.filter((task) => task.id === firstCompletedId);
    await view.win.__smoke.setPlan(fixedPlan);
    unchangedColours('only one original task remains');

    // Freeze actual Web Animations at explicit timeline positions, rather than
    // sleeping, to inspect completion motion and rapid interruptions reliably.
    function pauseCardAnimations() {
      const animations = view.doc.getAnimations();
      for (const animation of animations) {
        animation.pause();
        animation.currentTime = 0;
      }
      return animations;
    }
    async function finishCardAnimations() {
      const animations = view.doc.getAnimations();
      for (const animation of animations) animation.finish();
      await Promise.all(animations.map((animation) => animation.finished));
      await settled();
    }
    // Native trimming waits for the visual contraction; new additions can
    // reverse that contraction without clipping cards or moving their origin.
    view = await fixture('paging', { ...pagingPlan, tasks: pagingPlan.tasks.slice(0, 5) }, null, true, false, 1094);
    await settled();
    view.win.__smoke.holdContentWidth();
    const widePill = view.doc.getElementById('bar');
    const widePillRect = widePill.getBoundingClientRect();
    const compactB = view.unit('b');
    const compactBRect = compactB.getBoundingClientRect();
    view.unit('a').querySelector('.done').click();
    let compactAnimations = pauseCardAnimations();
    assert('capsule contraction starts at the current width and card positions', Math.abs(widePill.getBoundingClientRect().width - widePillRect.width) < 0.1 && Math.abs(compactB.getBoundingClientRect().left - compactBRect.left) < 0.1);
    for (const animation of compactAnimations) animation.currentTime = Number(animation.effect.getTiming().delay) + Number(animation.effect.getTiming().duration) / 2;
    const contractingWidth = widePill.getBoundingClientRect().width;
    assert('unused arrow space contracts smoothly instead of snapping', contractingWidth > 1022 && contractingWidth < 1086);
    const returnedOverflow = view.win.__smoke.getPlan();
    returnedOverflow.tasks.push(pagingPlan.tasks[5]);
    await view.win.__smoke.setPlan(returnedOverflow);
    pauseCardAnimations();
    assert('adding during contraction continues from the current capsule width', Math.abs(widePill.getBoundingClientRect().width - contractingWidth) < 0.1 && view.win.__smoke.contentWidth() === 1094);
    await finishCardAnimations();
    view.win.__smoke.applyContentWidth();
    assert('a cancelled contraction keeps the full browsing width', Math.abs(widePill.getBoundingClientRect().width - 1086) < 0.1 && view.win.innerWidth === 1094);
    const removeOverflow = view.win.__smoke.getPlan();
    removeOverflow.tasks.find((task) => task.id === 'f').done = true;
    await view.win.__smoke.setPlan(removeOverflow);
    pauseCardAnimations();
    assert('finishing an offscreen fifth task also animates the capsule width', widePill.getAnimations().length > 0 && previousTasks().hidden);
    await finishCardAnimations();
    view.win.__smoke.applyContentWidth();
    const compactC = view.unit('c');
    const compactCRect = compactC.getBoundingClientRect();
    view.unit('b').querySelector('.done').click();
    compactAnimations = pauseCardAnimations();
    assert('shrinking card count keeps surviving cards at their painted positions', view.unit('c') === compactC && Math.abs(compactC.getBoundingClientRect().left - compactCRect.left) < 0.1);
    for (const animation of compactAnimations) animation.currentTime = Number(animation.effect.getTiming().delay) + Number(animation.effect.getTiming().duration) / 2;
    assert('card-count contraction keeps the capsule centered', Math.abs((widePill.getBoundingClientRect().left + widePill.getBoundingClientRect().right) / 2 - view.win.innerWidth / 2) < 0.1);
    await finishCardAnimations();
    view.win.__smoke.applyContentWidth();
    assert('native trimming leaves only the final compact card area', view.win.__smoke.appliedContentWidth() === 790 && view.win.innerWidth === 1094 && Math.abs(widePill.getBoundingClientRect().width - 782) < 0.1 && visibleTasks().join('') === 'cde');
    fixedCards('after compact native trimming');
    // Exact reported case: three visible tasks -> finish one -> two tasks.
    const twoCardSurvivor = view.unit('d');
    const twoCardBefore = twoCardSurvivor.getBoundingClientRect();
    view.unit('c').querySelector('.done').click();
    pauseCardAnimations();
    assert('three-to-two contraction preserves the starting card position', Math.abs(twoCardSurvivor.getBoundingClientRect().left - twoCardBefore.left) < 0.1);
    await finishCardAnimations();
    const beforeNativeTrim = widePill.getBoundingClientRect();
    const canvasResizesBeforeTrim = view.win.__smoke.canvasResizes();
    view.win.__smoke.applyContentWidth();
    assert('three-to-two native trim excludes the unused input area', view.win.__smoke.appliedContentWidth() === 550 && visibleTasks().join('') === 'de' && Math.abs(beforeNativeTrim.width - 542) < 0.1);
    assert('post-animation native trimming never resizes the WebView canvas', view.win.__smoke.canvasResizes() === canvasResizesBeforeTrim);
    assert('post-animation trimming leaves the painted capsule completely unchanged', Math.abs(widePill.getBoundingClientRect().left - beforeNativeTrim.left) < 0.1 && Math.abs(widePill.getBoundingClientRect().width - beforeNativeTrim.width) < 0.1);

    view = await fixture('paging', null, null, true);
    const browsePlan = JSON.stringify(view.win.__smoke.getPlan());
    const browseSegments = [...view.doc.querySelectorAll('.slim-seg')];
    const browseA = view.unit('a');
    const browseB = view.unit('b');
    const browseC = view.unit('c');
    const browseBRect = browseB.getBoundingClientRect();
    nextTasks().click();
    let browseAnimations = pauseCardAnimations();
    let browseMove = browseB.getAnimations()[0];
    assert('browsing right has an immediate horizontal animation', Boolean(browseMove) && browseMove.effect.getTiming().delay === 0 && visibleTasks().join('') === 'bcde');
    assert('browsing reuses surviving cards at their painted positions', view.unit('b') === browseB && Math.abs(browseB.getBoundingClientRect().left - browseBRect.left) < 0.1);
    assert('new browsing cards enter from outside the clipped edge', view.unit('e').getBoundingClientRect().left >= view.doc.getElementById('taskViewport').getBoundingClientRect().right - 0.1);
    assert('browsing never replays title animations or dims entering cards', browseB.querySelector('.title').getAnimations().length === 0 && view.win.getComputedStyle(view.unit('e')).opacity === '1');
    assert('departing browse cards are noninteractive overlays', browseA.inert && browseA.getAttribute('aria-hidden') === 'true' && browseA.classList.contains('unit-exit'));
    for (const animation of browseAnimations) animation.currentTime = Number(animation.effect.getTiming().duration) / 3;
    const browseBMid = browseB.getBoundingClientRect().left;
    const browseCMid = browseC.getBoundingClientRect().left;
    assert('browsing visibly slides through intermediate positions', browseBMid < browseBRect.left && browseBMid > browseBRect.left - 240);
    nextTasks().click();
    browseAnimations = pauseCardAnimations();
    assert('rapid browsing accepts another click without waiting', visibleTasks().join('') === 'cdef');
    assert('rapid browsing continues from the currently painted position', view.unit('c') === browseC && Math.abs(browseC.getBoundingClientRect().left - browseCMid) < 0.1);
    for (const animation of browseAnimations) animation.currentTime = Number(animation.effect.getTiming().duration) / 4;
    const returningBRect = browseB.getBoundingClientRect();
    previousTasks().click();
    pauseCardAnimations();
    await settled();
    assert('reversing direction reclaims the same outgoing card without a jump', view.unit('b') === browseB && Math.abs(browseB.getBoundingClientRect().left - returningBRect.left) < 0.1);
    assert('a reclaimed card survives cancelled-exit cleanup and is interactive', browseB.isConnected && !browseB.inert && !browseB.classList.contains('unit-exit') && !browseB.hasAttribute('aria-hidden'));
    assert('browsing preserves task data and collapsed segment nodes', JSON.stringify(view.win.__smoke.getPlan()) === browsePlan && [...view.doc.querySelectorAll('.slim-seg')].every((node, index) => node === browseSegments[index]));
    await finishCardAnimations();
    const browseBSettledRect = browseB.getBoundingClientRect();
    previousTasks().click();
    pauseCardAnimations();
    assert('browsing left enters from the opposite clipped edge', view.unit('a').getBoundingClientRect().right <= view.doc.getElementById('taskViewport').getBoundingClientRect().left + 0.1);
    assert('browsing left preserves the painted position of surviving cards', view.unit('b') === browseB && Math.abs(browseB.getBoundingClientRect().left - browseBSettledRect.left) < 0.1);
    const browseBMove = browseB.getAnimations()[0];
    view.unit('b').querySelector('.ring').click();
    await settled();
    assert('task controls stay usable while browsing animation is in progress', view.win.__smoke.getPlan().tasks.find((task) => task.id === 'b').paused && browseB.getAnimations()[0] === browseBMove);
    await view.win.__smoke.setClock(12, 0, 1);
    assert('clock updates do not restart browsing motion', browseB.getAnimations()[0] === browseBMove);
    await finishCardAnimations();
    assert('finished browsing removes every outgoing overlay', !view.doc.querySelector('.unit-exit') && view.doc.getAnimations().length === 0);
    fixedCards('after animated browsing');

    const manyTaskIds = Array.from({ length: 40 }, (_, index) => `browse-${index}`);
    view = await fixture('paging', { ...pagingPlan, tasks: manyTaskIds.map((id) => ({ id, title: id, timer: 'up', running: true, spent_sec: 60 })) }, null, true);
    for (let index = 0; index < 30; index += 1) {
      nextTasks().click();
      pauseCardAnimations();
    }
    assert('many rapid clicks reach the requested queue position immediately', visibleTasks().join(',') === manyTaskIds.slice(30, 34).join(','));
    assert('rapid browsing keeps rendered cards bounded instead of accumulating ghosts', view.doc.querySelectorAll('.unit').length <= 8);
    await finishCardAnimations();
    assert('rapid browsing settles with only four active cards', view.doc.querySelectorAll('.unit').length === 4 && !view.doc.querySelector('.unit-exit'));
    fixedCards('after many rapid browse clicks');

    view = await fixture('paging', null, null, true);
    frame.style.width = '520px';
    view.win.dispatchEvent(new view.win.Event('resize'));
    assert('single-card viewport is available for browsing', visibleTasks().length === 1);
    nextTasks().click();
    pauseCardAnimations();
    assert('single-card next navigation slides in from the right', visibleTasks().join('') === 'b' && view.unit('b').getBoundingClientRect().left >= view.doc.getElementById('taskViewport').getBoundingClientRect().right - 0.1);
    await finishCardAnimations();
    previousTasks().click();
    pauseCardAnimations();
    assert('single-card previous navigation slides in from the left', visibleTasks().join('') === 'a' && view.unit('a').getBoundingClientRect().right <= view.doc.getElementById('taskViewport').getBoundingClientRect().left + 0.1);
    frame.style.width = '1128px';
    view.win.dispatchEvent(new view.win.Event('resize'));
    await settled();
    assert('resizing safely cancels browsing motion and restores the layout', visibleTasks().length === 4 && view.doc.getAnimations().length === 0 && !view.doc.querySelector('.unit-exit'));
    view = await fixture('paging');
    nextTasks().click();
    assert('reduced-motion browsing updates immediately without animated overlays', visibleTasks().join('') === 'bcde' && view.doc.getAnimations().length === 0 && !view.doc.querySelector('.unit-exit'));

    const fiveTasks = { ...pagingPlan, tasks: pagingPlan.tasks.slice(0, 5) };
    view = await fixture('paging', fiveTasks, null, true);
    const movingB = view.unit('b');
    const movingC = view.unit('c');
    const bOriginalRect = movingB.getBoundingClientRect();
    const bOriginalStroke = view.color('b', '.ring-fill', 'stroke');
    view.unit('a').querySelector('.done').click();
    pauseCardAnimations();
    const bMove = movingB.getAnimations()[0];
    const eMove = view.unit('e').getAnimations()[0];
    assert('completion updates task state without waiting for motion', view.win.__smoke.getPlan().tasks.find((task) => task.id === 'a').done && !view.unit('a'));
    assert('completion retains the actual following task nodes', view.unit('b') === movingB && view.unit('c') === movingC);
    assert('following cards have a real position animation', Boolean(bMove) && bMove.effect.getKeyframes()[0].transform.includes('240'));
    assert('following card starts at its old painted position', Math.abs(movingB.getBoundingClientRect().left - bOriginalRect.left) < 0.1);
    assert('fifth task enters from beyond the right edge', Boolean(eMove) && view.unit('e').getBoundingClientRect().left >= view.doc.getElementById('taskViewport').getBoundingClientRect().right - 0.1);
    assert('completion does not replay a title fade on following cards', movingB.querySelector('.title').getAnimations().length === 0);
    const exiting = view.doc.querySelector('.unit-exit');
    assert('outgoing card is only a noninteractive visual', Boolean(exiting) && exiting.inert && exiting.getAttribute('aria-hidden') === 'true' && view.win.getComputedStyle(exiting).pointerEvents === 'none');
    bMove.currentTime = bMove.effect.getTiming().delay + Number(bMove.effect.getTiming().duration) / 2;
    const bMidpoint = movingB.getBoundingClientRect().left;
    assert('following card moves continuously through an intermediate position', bMidpoint < bOriginalRect.left && bMidpoint > bOriginalRect.left - 240);
    const cBeforeSecondCompletion = movingC.getBoundingClientRect().left;
    view.unit('b').querySelector('.done').click();
    pauseCardAnimations();
    await settled();
    assert('a second task can finish while the first motion is in progress', view.win.__smoke.getPlan().tasks.filter((task) => ['a', 'b'].includes(task.id)).every((task) => task.done && !task.running));
    assert('interrupted motion continues from the currently painted position', view.unit('c') === movingC && Math.abs(movingC.getBoundingClientRect().left - cBeforeSecondCompletion) < 0.1);
    assert('active cards remain separate from outgoing visuals', visibleTasks().join('') === 'cde');
    await finishCardAnimations();
    assert('all outgoing visuals are cleaned up when motion finishes', !view.doc.querySelector('.unit-exit'));
    assert('width contracts to three fixed cards after consecutive completion', view.doc.getElementById('taskViewport').getBoundingClientRect().width === 720);
    fixedCards('after animated consecutive completion');
    assert('paused task keeps its state during animated reflow', view.unit('c').querySelector('.ring').dataset.mode === 'paused');

    view = await fixture('paging', fiveTasks, null, true);
    const middleA = view.unit('a');
    const middleC = view.unit('c');
    view.unit('b').querySelector('.done').click();
    pauseCardAnimations();
    assert('middle completion preserves every surviving card', view.unit('a') === middleA && view.unit('c') === middleC && visibleTasks().join('') === 'acde');
    assert('a card before the removed card does not animate unnecessarily', middleA.getAnimations().length === 0);
    await finishCardAnimations();
    assert('animated completion keeps the task identity colour', view.color('a', '.ring-fill', 'stroke') === identity.a && bOriginalStroke === identity.b);

    view = await fixture('paging', null, null, true);
    view.unit('a').querySelector('.done').click();
    const interruptedCompletion = pauseCardAnimations();
    const beforeBrowseC = view.unit('c');
    const beforeBrowseCRect = beforeBrowseC.getBoundingClientRect();
    nextTasks().click();
    pauseCardAnimations();
    assert('navigation can interrupt completion motion immediately', visibleTasks().join('') === 'cdef' && view.unit('c') === beforeBrowseC && Math.abs(beforeBrowseC.getBoundingClientRect().left - beforeBrowseCRect.left) < 0.1);
    assert('navigation replaces obsolete completion effects with browsing motion', interruptedCompletion.every((animation) => animation.playState === 'idle') && beforeBrowseC.getAnimations().length > 0);
    view.unit('c').querySelector('.done').click();
    pauseCardAnimations();
    view.doc.getElementById('collapse').click();
    await settled();
    assert('collapse cancels completion overlays and motion safely', !view.doc.querySelector('.unit-exit') && view.doc.getAnimations().length === 0);
    view.doc.getElementById('slim').click();
    await settled();
    assert('expanding after interrupted motion shows the surviving tasks', !view.unit('a') && !view.unit('c') && visibleTasks().length === 4);

    view = await fixture('paging', fiveTasks, null, true);
    const remoteB = view.unit('b');
    const remoteCompleted = view.win.__smoke.getPlan();
    remoteCompleted.tasks.find((task) => task.id === 'a').done = true;
    await view.win.__smoke.setPlan(remoteCompleted);
    pauseCardAnimations();
    assert('external task completion uses the same smooth motion', view.unit('b') === remoteB && remoteB.getAnimations().length > 0);
    await finishCardAnimations();

    view = await fixture('paging', fiveTasks);
    const reducedB = view.unit('b');
    view.unit('a').querySelector('.done').click();
    assert('reduced-motion mode preserves task nodes without animated overlays', view.unit('b') === reducedB && !view.doc.querySelector('.unit-exit') && view.doc.getAnimations().length === 0);

    // Language changes must preserve task identity, timer values and actions.
    view = await fixture('compact');
    const beforeLanguage = view.win.__smoke.getPlan();
    const originalCard = view.unit('a');
    await view.win.__smoke.setLanguage('en');
    assert('English sets document language and navigation labels', view.doc.documentElement.lang === 'en' && view.doc.getElementById('slim').title === 'Expand WorkBar');
    assert('English timer estimates are localized', view.unit('a').querySelector('.estimate').textContent === '10 min' && view.unit('b').querySelector('.estimate').textContent === '1 hr 30 min');
    assert('English task controls are accessible', view.unit('a').querySelector('.ring').getAttribute('aria-label') === 'Pause or resume timer' && view.unit('a').querySelector('.done').title === 'Complete this task');
    assert('language switch preserves task nodes and all task data', view.unit('a') === originalCard && JSON.stringify(view.win.__smoke.getPlan()) === JSON.stringify(beforeLanguage) && view.win.__smoke.actionRequests().length === 0);
    assert('English timer row fits inside its card', [...view.doc.querySelectorAll('.now-sub')].every(node => node.scrollWidth <= node.clientWidth + 1));
    await view.win.__smoke.setLanguage('zh-CN');
    assert('switching back restores Chinese estimates and labels', view.unit('b').querySelector('.estimate').textContent === '1小时30分' && view.doc.getElementById('collapse').getAttribute('aria-label') === '收起');
    const custom = view.win.__smoke.getPlan();
    custom.tasks[0].title = '保留用户任务标题';
    await view.win.__smoke.setPlan(custom);
    await view.win.__smoke.setLanguage('en');
    assert('user task titles are not translated', view.unit('a').querySelector('.title').textContent === '保留用户任务标题');
    view.unit('a').querySelector('.ring').click();
    await settled();
    assert('timer actions continue working in English', view.unit('a').querySelector('.ring').dataset.mode === 'paused');
    view.win.__smoke.failNextAction();
    view.unit('a').querySelector('.ring').click();
    await settled();
    assert('task errors appear in English', view.doc.getElementById('bar').title.startsWith('Task change was not saved:'));
    await view.win.__smoke.setLanguage('zh-CN');
    assert('visible task errors retranslate with the interface', view.doc.getElementById('bar').title.startsWith('任务修改未保存：'));

    view = await fixture('done-empty');
    await view.win.__smoke.setLanguage('en');
    assert('English empty state is localized', view.doc.querySelector('.title').textContent === 'No tasks for today' && view.doc.querySelector('.estimate').textContent === 'Ask AI to plan your day');
    view = await fixture('done-complete');
    await view.win.__smoke.setLanguage('en');
    assert('English completion state is localized', view.doc.querySelector('.title').textContent === 'All done for today' && view.doc.querySelector('.estimate').textContent === '1 completed');
    view = await fixture('independent-idle');
    await view.win.__smoke.setLanguage('en');
    assert('English pending state is localized', view.unit('a').querySelector('.estimate').textContent === 'Not started');
    const upcoming = view.win.__smoke.getPlan();
    upcoming.tasks[0].start = '12:04';
    await view.win.__smoke.setPlan(upcoming);
    assert('English schedule and starts-soon hint are localized', view.unit('a').querySelector('.estimate').textContent === 'Starts 12:04' && view.unit('a').querySelector('.status').textContent === 'In < 5 min');
    assert('English starts-soon row does not overflow', view.unit('a').querySelector('.now-sub').scrollWidth <= view.unit('a').querySelector('.now-sub').clientWidth + 1);

    // Load settings directly in English, then change language with an unsaved draft.
    frame.remove();
    window.__fixtureLanguage = 'en';
    frame = document.createElement('iframe');
    frame.style.cssText = 'width:440px;height:320px;border:0';
    const settingsLoaded = new Promise(resolve => { frame.onload = resolve; });
    frame.src = '/settings';
    document.body.append(frame);
    await settingsLoaded;
    const settingsWin = frame.contentWindow;
    const settingsDoc = settingsWin.document;
    const control = id => settingsDoc.getElementById(id);
    assert('settings open fully in English', settingsDoc.title === 'WorkBar · Shortcut' && control('title').textContent === 'Set shortcut' && control('save').textContent === 'Save' && !control('recorder').disabled);
    assert('English settings fit the window', settingsDoc.querySelector('.settings').scrollHeight <= settingsDoc.querySelector('.settings').clientHeight + 2);
    control('recorder').click();
    await settled();
    settingsDoc.dispatchEvent(new settingsWin.KeyboardEvent('keydown', { key: 'F12', code: 'F12', bubbles: true }));
    assert('shortcut validation appears in English', control('status').textContent === 'F12 is reserved by the system. Choose another shortcut.');
    await settingsWin.__smoke.setLanguage('zh-CN');
    assert('active recording and validation retranslate without resetting', control('status').textContent === 'F12 为系统保留按键，请换一个组合。' && control('recordingText').textContent === '请按下新快捷键…' && control('recorder').getAttribute('aria-pressed') === 'true');
    settingsDoc.dispatchEvent(new settingsWin.KeyboardEvent('keydown', { key: 'j', code: 'KeyJ', ctrlKey: true, bubbles: true }));
    await settled();
    await settingsWin.__smoke.setLanguage('en');
    assert('language change keeps the unsaved shortcut and translated status', control('keys').textContent === 'CtrlJ' && !control('save').disabled && control('status').textContent === 'Recorded. Click Save to apply.');
    control('save').click();
    await settled();
    assert('shortcut can be saved after switching languages', settingsWin.__smoke.savedShortcuts().join() === 'Ctrl+J');
    await settingsWin.__smoke.setLanguage('zh-CN');
    assert('settings restore Chinese title and buttons', settingsDoc.title === 'WorkBar · 快捷键' && control('save').textContent === '保存');
    await settingsWin.__smoke.setShortcutError({ key: 'shortcut.unregistered', detail: null });
    assert('native shortcut errors appear in Chinese', control('status').textContent === '快捷键未生效，可能已被占用；可从托盘重新设置');
    await settingsWin.__smoke.setLanguage('en');
    assert('native shortcut errors retranslate without reopening settings', control('status').textContent.startsWith('The shortcut could not be enabled.'));
    window.__fixtureLanguage = null;
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
      '/bootstrap.js': ['application/javascript', `(${bootstrap.toString()})(${JSON.stringify(Object.fromEntries(['en', 'zh-CN'].map(locale => [locale, JSON.parse(fs.readFileSync(path.join(source, 'locales', `${locale}.json`), 'utf8'))])))});`],
      '/fixture': ['text/html', fs.readFileSync(path.join(source, 'index.html'), 'utf8').replace('<script src="i18n.js">', '<script src="/bootstrap.js"></script><script src="i18n.js">')],
      '/app.js': ['application/javascript', fs.readFileSync(path.join(source, 'app.js'))],
      '/styles.css': ['text/css', fs.readFileSync(path.join(source, 'styles.css'))],
      '/i18n.js': ['application/javascript', fs.readFileSync(path.join(source, 'i18n.js'))],
      '/settings': ['text/html', fs.readFileSync(path.join(source, 'shortcut-settings.html'), 'utf8').replace('<script src="i18n.js">', '<script src="/bootstrap.js"></script><script src="i18n.js">')],
      '/shortcut-settings.js': ['application/javascript', fs.readFileSync(path.join(source, 'shortcut-settings.js'))],
      '/shortcut-settings.css': ['text/css', fs.readFileSync(path.join(source, 'shortcut-settings.css'))],
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
