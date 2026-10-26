/* Workbar renderer — no framework, no build step. */
(() => {
  "use strict";

  const TAURI = window.__TAURI__ || null;
  const invoke = TAURI && TAURI.core ? TAURI.core.invoke : null;
  const listen = TAURI && TAURI.event ? TAURI.event.listen : null;

  const RING_LEN = 2 * Math.PI * 18;
  const MAX_VISIBLE_TASKS = 4;
  const TASK_COLOR_COUNT = 4;

  const $ = (id) => document.getElementById(id);
  const el = {
    stage: $("stage"),
    bar: $("bar"),
    viewport: $("taskViewport"),
    units: $("units"),
    previous: $("previousTasks"),
    next: $("nextTasks"),
    tail: document.querySelector(".tail"),
    collapse: $("collapse"),
    slim: $("slim"),
    slimBar: $("slimBar"),
    slimLine: $("slimLine"),
  };

  let plan = { date: "", tasks: [] };
  let lastSnapshot = "";
  let lastTickAt = Date.now();
  // Fractional seconds waiting to be written into spent_sec, per running task.
  // Two tick drivers (JS interval + native clock) can each deliver < 1s, and
  // flooring a single sub-second delta every time would throw the time away.
  const carryByTask = new Map();
  let slimSignature = "";
  let unitNodes = [];
  let sinceSave = 0;
  let saving = false;
  let saveQueued = false;
  let externalQueued = false;
  let collapsed = false;
  let windowStart = 0;
  let windowAnchor = null;
  let visibleIds = [];
  let windowCapacity = MAX_VISIBLE_TASKS;
  let viewportMotion = null;
  const leavingUnits = new Map();

  // ------------------------------------------------------------------ time

  const pad2 = (n) => String(n).padStart(2, "0");

  function todayString() {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function nowMinutes() {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  }

  function hhmmToMin(value) {
    if (!value) return null;
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(value).trim());
    if (!match) return null;
    const h = Number(match[1]);
    const m = Number(match[2]);
    if (h > 23 || m > 59) return null;
    return h * 60 + m;
  }

  function formatClock(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
  }

  function formatEstimate(minutes) {
    const m = Math.max(1, Math.round(minutes || 0));
    if (m >= 60) {
      const h = Math.floor(m / 60);
      const rest = m % 60;
      return rest ? `${h}小时${rest}分` : `${h}小时`;
    }
    return `${m}分钟`;
  }

  function taskWindowLabel(task) {
    if (task.start && task.end) return `${task.start}–${task.end}`;
    if (task.start) return `${task.start} 开始`;
    if (task.end) return `${task.end} 前`;
    return "";
  }

  /** Friendly "starts soon" hint: coarser buckets as the start gets closer. */
  function startHint(remainMin) {
    if (remainMin < 5) return "不到 5 分钟";
    if (remainMin < 10) return "不到 10 分钟";
    if (remainMin < 15) return "不到 15 分钟";
    if (remainMin < 30) return "不到 30 分钟";
    if (remainMin < 60) return "不到 1 小时";
    return "";
  }

  /** "down" = countdown against est_min; "up" = open-ended stopwatch. */
  function timerModeOf(task) {
    if (!task) return "down";
    if (task.timer === "up" || task.timer === "down") return task.timer;
    return Number(task.est_min) > 0 ? "down" : "up";
  }

  // ------------------------------------------------------------------ view

  function hasStarted(task) {
    return !!task.running || !!task.paused || Number(task.spent_sec) > 0;
  }

  /** Task ids are assigned at creation. Hash only that immutable identity so
   *  list order, completion, pagination and reloads never change the colour. */
  function taskColorIndex(task) {
    let hash = 2166136261;
    for (const character of task.id) {
      hash = Math.imul(hash ^ character.codePointAt(0), 16777619);
    }
    return (hash >>> 0) % TASK_COLOR_COUNT;
  }

  function computeView() {
    const tasks = plan.tasks || [];
    const pending = tasks.filter((t) => !t.done);
    const view = {
      state: "active",
      doneCount: tasks.filter((t) => t.done).length,
      total: tasks.length,
      pendingCount: pending.length,
    };

    if (plan.date !== todayString() || tasks.length === 0) {
      view.state = "empty";
      return view;
    }

    if (pending.length === 0) {
      view.state = "complete";
      return view;
    }

    // Every scheduled task starts independently. Explicit running/paused state
    // wins over the clock, including a pause made before the first second.
    const now = nowMinutes();
    let startedByClock = false;
    for (const task of pending) {
      if (hasStarted(task)) continue;
      const start = hhmmToMin(task.start);
      const end = hhmmToMin(task.end);
      if (start !== null && now >= start && (end === null || now < end)) {
        task.running = true;
        startedByClock = true;
      }
    }
    if (startedByClock) saveNow();

    return view;
  }

  // ----------------------------------------------------------------- render

  function reducedMotion() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function animateUnitTitle(node, text, immediate) {
    if (immediate || reducedMotion() || !node.animate) {
      node.textContent = text;
      return;
    }
    node.animate(
      [
        { opacity: 0, transform: "translateY(-6px)", filter: "blur(3px)" },
        { opacity: 1, transform: "translateY(0)", filter: "blur(0)" },
      ],
      { duration: 300, easing: "cubic-bezier(.16,1,.3,1)" }
    );
    node.textContent = text;
  }

  /** Each task keeps its own controls when it changes position. */
  function createUnit() {
    const root = document.createElement("div");
    root.className = "unit";
    root.innerHTML = [
      '<button class="ring" type="button" title="暂停 / 继续计时" aria-label="暂停或继续计时">',
      '  <svg class="ring-svg" viewBox="0 0 44 44" aria-hidden="true">',
      '    <circle class="ring-track" cx="22" cy="22" r="18"></circle>',
      '    <circle class="ring-fill" cx="22" cy="22" r="18"></circle>',
      "  </svg>",
      '  <span class="ring-glyph" aria-hidden="true">',
      '    <svg viewBox="0 0 12 14" class="glyph-play"><path d="M1.6 1.2 10.4 7 1.6 12.8Z"></path></svg>',
      '    <svg viewBox="0 0 12 14" class="glyph-pause"><path d="M2 1.5h2.6v11H2zM7.4 1.5H10v11H7.4z"></path></svg>',
      "  </span>",
      "</button>",
      '<div class="now">',
      '  <div class="now-head"><h1 class="title"></h1><span class="pulse" aria-hidden="true"></span></div>',
      '  <div class="now-sub"><span class="elapsed">--:--</span><span class="slash">/</span><span class="estimate">--</span><span class="status"></span></div>',
      "</div>",
      '<button class="done" type="button" title="完成这一项" aria-label="完成">',
      '  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.8 12.6 9.6 17.4 19.2 6.9"></path></svg>',
      "</button>",
    ].join("");
    const refs = {
      root,
      ring: root.querySelector(".ring"),
      fill: root.querySelector(".ring-fill"),
      pulse: root.querySelector(".pulse"),
      title: root.querySelector(".title"),
      elapsed: root.querySelector(".elapsed"),
      slash: root.querySelector(".slash"),
      estimate: root.querySelector(".estimate"),
      status: root.querySelector(".status"),
      done: root.querySelector(".done"),
      taskId: null,
      titleText: "",
      key: "",
      motion: null,
    };
    // only the ring starts / pauses the timer
    refs.ring.addEventListener("click", () => {
      if (refs.taskId) toggleTaskPause(refs.taskId);
    });
    refs.done.addEventListener("click", () => {
      if (refs.taskId) completeTask(refs.taskId);
    });
    return refs;
  }

  function stopCardMotion() {
    for (const refs of unitNodes) {
      refs.motion?.cancel();
      refs.motion = null;
    }
    viewportMotion?.cancel();
    viewportMotion = null;
    for (const [node, animation] of leavingUnits) {
      animation.cancel();
      node.remove();
    }
    leavingUnits.clear();
  }

  function animateCard(refs, frames) {
    const animation = refs.root.animate(frames, {
      duration: 320,
      delay: 35,
      easing: "cubic-bezier(.16,1,.3,1)",
      fill: "backwards",
    });
    refs.motion = animation;
    const release = () => {
      if (refs.motion === animation) refs.motion = null;
    };
    animation.finished.then(release, release);
  }

  function exitUnit(refs, rect, origin, opacity) {
    const node = refs.root;
    delete node.dataset.id;
    node.classList.add("unit-exit");
    node.inert = true;
    node.setAttribute("aria-hidden", "true");
    node.style.left = `${rect.left - origin.left}px`;
    node.style.top = `${rect.top - origin.top}px`;
    el.viewport.append(node);
    const animation = node.animate([
      { opacity, transform: "translateX(0) scale(1)" },
      { opacity: 0, transform: "translateX(-12px) scale(.96)" },
    ], { duration: 150, easing: "ease-out" });
    leavingUnits.set(node, animation);
    const release = () => {
      node.remove();
      leavingUnits.delete(node);
    };
    animation.finished.then(release, release);
  }

  function ensureUnits(tasks, immediate, previousWidth) {
    const ids = tasks.length ? tasks.map((task) => task.id) : [null];
    const animate = !immediate && !collapsed && !reducedMotion()
      && typeof el.units.animate === "function" && unitNodes.length > 0;
    if (ids.length === unitNodes.length && ids.every((id, index) => unitNodes[index].taskId === id)) {
      if (!animate) stopCardMotion();
      return unitNodes;
    }

    // Read the currently painted positions before cancelling an earlier move,
    // so a second completion can continue smoothly from the middle of it.
    const before = new Map(unitNodes.map((refs) => [refs.taskId, refs.root.getBoundingClientRect()]));
    const opacity = new Map(unitNodes.map((refs) => [refs.taskId, Number(getComputedStyle(refs.root).opacity)]));
    const previous = new Map(unitNodes.map((refs) => [refs.taskId, refs]));
    if (!animate) stopCardMotion();
    else {
      for (const refs of unitNodes) {
        refs.motion?.cancel();
        refs.motion = null;
      }
      viewportMotion?.cancel();
      viewportMotion = null;
    }
    const next = ids.map((id) => {
      const refs = previous.get(id) || createUnit();
      refs.taskId = id;
      return refs;
    });
    const origin = el.viewport.getBoundingClientRect();
    for (const refs of unitNodes) {
      if (ids.includes(refs.taskId)) continue;
      if (animate) exitUnit(refs, before.get(refs.taskId), origin, opacity.get(refs.taskId));
      else refs.root.remove();
    }
    next.forEach((refs, index) => {
      const current = el.units.children[index];
      if (current !== refs.root) el.units.insertBefore(refs.root, current || null);
    });
    unitNodes = next;
    if (!animate) return next;

    const after = new Map(next.map((refs) => [refs.taskId, refs.root.getBoundingClientRect()]));
    const shifts = next.filter((refs) => before.has(refs.taskId))
      .map((refs) => before.get(refs.taskId).left - after.get(refs.taskId).left);
    const entryOffset = shifts.find((shift) => Math.abs(shift) > 0.5)
      || parseFloat(getComputedStyle(el.units).getPropertyValue("--card-width"));
    for (const refs of next) {
      const old = before.get(refs.taskId);
      const target = after.get(refs.taskId);
      if (old) {
        const dx = old.left - target.left;
        const dy = old.top - target.top;
        const alpha = opacity.get(refs.taskId);
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5 || alpha < 0.999) {
          animateCard(refs, [
            { transform: `translate(${dx}px, ${dy}px)`, opacity: alpha },
            { transform: "translate(0, 0)", opacity: 1 },
          ]);
        }
      } else {
        animateCard(refs, [
          { transform: `translateX(${refs.taskId === null ? 16 : entryOffset}px)`, opacity: 0.55 },
          { transform: "translateX(0)", opacity: 1 },
        ]);
      }
    }
    const width = parseFloat(el.viewport.style.width);
    if (Math.abs(previousWidth - width) > 0.5) {
      const animation = el.viewport.animate([{ width: `${previousWidth}px` }, { width: `${width}px` }], {
        duration: 320, delay: 35, easing: "cubic-bezier(.16,1,.3,1)", fill: "backwards",
      });
      viewportMotion = animation;
      const release = () => {
        if (viewportMotion === animation) viewportMotion = null;
      };
      animation.finished.then(release, release);
    }
    return next;
  }

  function pendingTasks() {
    // Persisted array order is the queue, including explicit user moves.
    return (plan.tasks || []).filter((task) => !task.done);
  }

  /** Keep card dimensions fixed; smaller screens show fewer whole cards. */
  function cardLayout(total) {
    const cardWidth = parseFloat(getComputedStyle(el.units).getPropertyValue("--card-width"));
    if (collapsed) return { cardWidth, capacity: windowCapacity };
    const barStyle = getComputedStyle(el.bar);
    const tailStyle = getComputedStyle(el.tail);
    const gap = parseFloat(barStyle.columnGap) || 0;
    const available = el.bar.clientWidth
      - parseFloat(barStyle.paddingLeft) - parseFloat(barStyle.paddingRight)
      - el.collapse.offsetWidth - parseFloat(tailStyle.paddingLeft)
      - parseFloat(tailStyle.paddingRight) - gap * 2;
    let capacity = Math.max(1, Math.min(MAX_VISIBLE_TASKS, Math.floor(available / cardWidth)));
    if (total > capacity) {
      const navigationWidth = parseFloat(getComputedStyle(el.previous).width) * 2
        + (parseFloat(tailStyle.columnGap) || 0) * 2;
      capacity = Math.max(1, Math.min(MAX_VISIBLE_TASKS, Math.floor((available - navigationWidth) / cardWidth)));
    }
    return { cardWidth, capacity };
  }

  /** Preserve the visible task when other tasks are added, removed or finished. */
  function computeUnits(pending) {
    const { cardWidth, capacity } = cardLayout(pending.length);
    windowCapacity = capacity;
    const indices = new Map(pending.map((task, index) => [task.id, index]));
    if (indices.has(windowAnchor)) {
      windowStart = indices.get(windowAnchor);
    } else {
      const survivor = visibleIds.find((id) => indices.has(id));
      windowStart = survivor === undefined
        ? 0
        : indices.get(survivor);
    }
    windowStart = Math.max(0, Math.min(windowStart, pending.length - capacity));
    const list = pending.slice(windowStart, windowStart + capacity);
    windowAnchor = list[0]?.id || null;
    visibleIds = list.map((task) => task.id);
    el.viewport.style.width = `${Math.max(1, list.length) * cardWidth}px`;
    const canBrowse = pending.length > capacity;
    el.previous.hidden = !canBrowse;
    el.next.hidden = !canBrowse;
    el.previous.disabled = windowStart === 0;
    el.next.disabled = windowStart + capacity >= pending.length;
    return list;
  }

  function moveTaskWindow(direction) {
    const pending = pendingTasks();
    windowStart = Math.max(0, Math.min(windowStart + direction, pending.length - windowCapacity));
    windowAnchor = pending[windowStart]?.id || null;
    render(computeView(), true);
  }

  function unitTarget(view, task) {
    if (!task) {
      const complete = view.state === "complete";
      return {
        title: complete ? "今天的工作都完成了" : "今天还没有计划",
        elapsed: "",
        estimate: complete ? `完成 ${view.doneCount} 项` : "等待 AI 排计划",
        status: complete ? "休息一下" : "用 AI 说一句就能排",
        statusClass: "",
        overdue: false,
        progress: complete ? 1 : 0,
        mode: "idle",
        pulse: false,
        showProgress: complete,
      };
    }

    const up = timerModeOf(task) === "up";
    const est = up ? 0 : Math.max(1, Number(task.est_min || 25) * 60);
    const spent = Number(task.spent_sec || 0);
    const overdue = up ? 0 : Math.max(0, Math.floor((spent - est) / 60));
    // countdown: progress against the estimate; stopwatch: one ring lap per hour
    const progress = up
      ? (spent % 3600) / 3600
      : Math.min(1, Math.max(0, spent / est));
    const started = hasStarted(task);
    const startMin = hhmmToMin(task.start);
    const now = nowMinutes();

    // ring mode drives the hover glyph: running -> pause, paused -> play,
    // idle (never started) -> play on hover
    if (!started) {
      // not started yet: only say when it starts, plus a friendlier hint as it approaches
      let status = "";
      let statusClass = "";
      if (startMin !== null && startMin > now) {
        const hint = startHint(startMin - now);
        if (hint) {
          status = hint;
          statusClass = "strong";
        }
      }
      return {
        title: task.title || "未命名任务",
        elapsed: "",
        estimate: startMin === null ? "待开始" : `${task.start} 开始`,
        status,
        statusClass,
        overdue: false,
        progress: 0,
        mode: "idle",
        pulse: false,
        showProgress: false,
      };
    }

    const mode = task.running ? "running" : "paused";
    const isOverdue = !up && mode === "running" && overdue > 0;
    // already timed (running or paused): elapsed / estimate, nothing else
    return {
      title: task.title || "未命名任务",
      elapsed: formatClock(spent),
      estimate: up ? "" : formatEstimate(task.est_min),
      status: "",
      statusClass: "",
      overdue: isOverdue,
      progress,
      mode,
      pulse: !!task.running,
      showProgress: progress > 0 || !!task.running,
    };
  }

  function renderUnits(view, pending, immediate) {
    const previousWidth = el.viewport.getBoundingClientRect().width;
    const list = computeUnits(pending);
    const nodes = ensureUnits(list, immediate, previousWidth);
    nodes.forEach((refs, index) => {
      const task = list[index] || null;
      refs.taskId = task ? task.id : null;
      refs.root.classList.toggle("idle", !task);
      refs.root.dataset.id = task ? task.id : "";
      refs.root.dataset.color = String(task ? taskColorIndex(task) : 0);
      const target = unitTarget(view, task);
      refs.root.classList.toggle("overdue", target.overdue);
      if (refs.titleText !== target.title) {
        const firstTitle = refs.titleText === "";
        refs.titleText = target.title;
        refs.title.title = target.title;
        animateUnitTitle(refs.title, target.title, immediate || firstTitle);
      }
      const key = `${target.elapsed}|${target.estimate}|${target.status}|${target.statusClass}|${target.mode}|${target.progress.toFixed(4)}`;
      if (refs.key !== key) {
        refs.key = key;
        refs.elapsed.textContent = target.elapsed;
        refs.elapsed.hidden = !target.elapsed;
        refs.estimate.textContent = target.estimate;
        refs.estimate.hidden = !target.estimate;
        refs.slash.hidden = !target.elapsed || !target.estimate;
        refs.status.textContent = target.status;
        refs.status.hidden = !target.status;
        refs.status.className = `status ${target.statusClass}`.trim();
        refs.fill.style.strokeDashoffset = String(RING_LEN * (1 - target.progress));
        refs.fill.style.opacity = target.showProgress ? "" : "0";
        refs.ring.dataset.mode = target.mode;
      }
      refs.pulse.classList.toggle("on", target.pulse);
      refs.done.disabled = !task;
    });
    return list;
  }

  function render(view, immediate) {
    const { bar } = el;
    bar.dataset.state = view.state;
    bar.classList.toggle("complete", view.state === "complete");

    const pending = pendingTasks();
    renderUnits(view, pending, immediate);
    renderSlim(view, pending);

    return view;
  }

  /** Collapsed strip: only tasks that actually started are shown, no matter if
   *  they are running or paused. One started task keeps the familiar single
   *  line; several become coloured segments (colour = task identity,
   *  brightness = running / paused). Browsing cards never hides a running strip. */
  function renderSlim(view, pending) {
    const started = pending.filter(hasStarted);

    const multi = started.length > 1;
    // Keep the strip clickable even when no task has started and no line is drawn.
    el.slimBar.hidden = multi;
    el.slimLine.hidden = !multi;

    if (started.length === 0) {
      el.stage.dataset.lineState = view.state === "complete" ? "complete" : "none";
      slimSignature = "";
      el.slimLine.replaceChildren();
      el.slimBar.classList.remove("up");
      delete el.slimBar.dataset.color;
      el.slimBar.style.setProperty("--p", "0");
      return;
    }

    if (!multi) {
      slimSignature = "";
      el.slimLine.replaceChildren();
      const task = started[0];
      const up = timerModeOf(task) === "up";
      const target = unitTarget(view, task);
      el.slimBar.dataset.color = String(taskColorIndex(task));
      el.stage.dataset.lineState = target.overdue ? "overdue" : task.running ? "active" : "paused";
      el.slimBar.classList.toggle("up", up);
      // a stopwatch fills the whole line (CSS drops the retraction transform);
      // only a countdown tracks progress
      if (!up) {
        const p = Math.min(
          1,
          Math.max(0, Number(task.spent_sec || 0) / Math.max(1, Number(task.est_min || 25) * 60))
        );
        el.slimBar.style.setProperty("--p", String(p));
      }
      return;
    }

    el.slimBar.classList.remove("up");
    el.stage.dataset.lineState = "active";
    const signature = started.map((task) => task.id).join("|");
    if (signature !== slimSignature) {
      slimSignature = signature;
      el.slimLine.replaceChildren();
      started.forEach((task) => {
        const seg = document.createElement("i");
        seg.className = "slim-seg";
        seg.dataset.id = task.id;
        el.slimLine.append(seg);
      });
    }

    Array.from(el.slimLine.children).forEach((seg) => {
      const task = started.find((t) => t.id === seg.dataset.id);
      if (!task) return;
      seg.dataset.color = String(taskColorIndex(task));
      const up = timerModeOf(task) === "up";
      seg.classList.toggle("up", up);
      if (!up) {
        const est = Math.max(1, Number(task.est_min || 25) * 60);
        const p = Math.min(1, Math.max(0, Number(task.spent_sec || 0) / est));
        seg.style.setProperty("--p", String(p));
      }
      seg.dataset.state = task.running ? "running" : "paused";
    });
  }

  // ------------------------------------------------------------------ save

  function serialize() {
    return JSON.stringify(plan);
  }

  async function saveNow() {
    if (!invoke) return;
    saveQueued = true;
    if (saving) return;
    saving = true;
    try {
      while (saveQueued) {
        saveQueued = false;
        const snapshot = serialize();
        await invoke("save_plan", { plan: JSON.parse(snapshot) });
        lastSnapshot = snapshot;
      }
    } catch (err) {
      console.warn("[workbar] save failed", err);
    } finally {
      saving = false;
      if (externalQueued) {
        externalQueued = false;
        externalChange();
      }
    }
  }

  function maybeSave(force) {
    sinceSave += 1;
    const hasRunningTasks = (plan.tasks || []).some((t) => t.running && !t.done);
    if (force || (hasRunningTasks && sinceSave >= 12)) {
      sinceSave = 0;
      saveNow();
    }
  }

  // ---------------------------------------------------------------- actions

  function toggleTaskPause(id) {
    settleTimers();
    const view = computeView();
    if (view.state === "empty" || view.state === "complete") return;
    const task = (plan.tasks || []).find((t) => t.id === id);
    if (!task || task.done) return;
    task.running = !task.running;
    task.paused = !task.running;
    carryByTask.delete(task.id);
    render(computeView());
    saveNow();
  }

  function completeTask(id) {
    settleTimers();
    const task = (plan.tasks || []).find((t) => t.id === id);
    if (!task || task.done) return;
    const refs = unitNodes.find((node) => node.taskId === id);
    if (refs) burst(refs.done);
    task.done = true;
    task.running = false;
    task.paused = false;
    carryByTask.delete(task.id);
    render(computeView());
    saveNow();
  }

  function burst(button) {
    const buttonRect = button.getBoundingClientRect();
    const barRect = el.bar.getBoundingClientRect();
    const origin = document.createElement("div");
    origin.className = "burst";
    origin.setAttribute("aria-hidden", "true");
    origin.style.left = `${buttonRect.left + buttonRect.width / 2 - barRect.left}px`;
    origin.style.top = `${buttonRect.top + buttonRect.height / 2 - barRect.top}px`;
    el.bar.append(origin);
    const count = 9;
    for (let i = 0; i < count; i += 1) {
      const particle = document.createElement("i");
      const angle = (Math.PI * 2 * i) / count + Math.random() * 0.4;
      const distance = 18 + Math.random() * 16;
      particle.style.setProperty("--dx", `${Math.cos(angle) * distance}px`);
      particle.style.setProperty("--dy", `${Math.sin(angle) * distance}px`);
      particle.style.animationDelay = `${Math.random() * 60}ms`;
      origin.append(particle);
    }
    setTimeout(() => origin.remove(), 1000);
  }

  // Trace timestamps go to trace.log via Rust; Date.now() in the message keeps
  // the JS wall clock so IPC delivery delay stays measurable.
  function trace(text) {
    if (invoke) invoke("trace_js", { msg: `${Date.now()} ${text} hidden=${document.hidden}` }).catch(() => {});
  }

  function collapse(requestResize = true) {
    if (collapsed) return;
    stopCardMotion();
    collapsed = true;
    trace("collapse start");
    el.stage.classList.remove("expanding");
    el.stage.classList.add("collapsed");
    // CSS reveals the line when the viewport actually becomes 4px tall. A
    // delayed completion event or animation frame must not leave it invisible.
    if (requestResize && invoke) invoke("set_collapsed", { collapsed: true }).catch(err => console.warn("[workbar] collapse failed", err));
  }

  function expand(requestResize = true) {
    if (!collapsed) return;
    collapsed = false;
    trace("expand start");
    // Fade the line while the window is still thin. Native code already waits
    // 180ms before expanding; it must not wait for a JS animation callback.
    el.stage.classList.add("expanding");
    // The small-viewport CSS keeps the capsule hidden until the window grows.
    el.stage.classList.remove("collapsed");
    if (requestResize && invoke) invoke("set_collapsed", { collapsed: false }).catch(err => console.warn("[workbar] expand failed", err));
  }

  // ------------------------------------------------------------------ load

  function normalizePlan(raw) {
    const next = raw && typeof raw === "object" ? raw : {};
    return {
      date: typeof next.date === "string" ? next.date : "",
      intro: next.intro || undefined,
      tasks: Array.isArray(next.tasks)
        ? next.tasks.map((task) => ({
            id: String(task.id || ""),
            title: String(task.title || ""),
            start: task.start || undefined,
            end: task.end || undefined,
            est_min: Math.max(0, Math.floor(Number(task.est_min) || 0)),
            timer: task.timer === "up" ? "up" : task.timer === "down" ? "down" : undefined,
            spent_sec: Math.max(0, Math.floor(Number(task.spent_sec) || 0)),
            running: !!task.running && !task.done,
            paused: !!task.paused && !task.running && !task.done,
            done: !!task.done,
            source: task.source || undefined,
            note: task.note || undefined,
          }))
        : [],
    };
  }

  /** A plan left over from an earlier day rolls into today. Without this the
   *  stale date drops computeView into the "empty" state, which hides the
   *  finish button and blocks pausing while the task units still render —
   *  the leftover work becomes impossible to control. */
  function rollPlanDate() {
    const today = todayString();
    if (plan.date !== today) {
      plan.date = today;
      saveNow();
    }
  }

  async function loadPlan(immediate) {
    if (invoke) {
      try {
        plan = normalizePlan(await invoke("get_plan"));
      } catch (err) {
        console.warn("[workbar] load failed", err);
        plan = normalizePlan({});
      }
    } else {
      plan = normalizePlan(demoPlan());
    }
    rollPlanDate();
    lastSnapshot = serialize();
    render(computeView(), immediate !== false);
  }

  async function externalChange() {
    if (!invoke) return;
    if (saving) {
      externalQueued = true;
      return;
    }
    let fresh;
    try {
      fresh = normalizePlan(await invoke("get_plan"));
    } catch {
      return;
    }
    if (saving) {
      externalQueued = true;
      return;
    }
    const freshSnapshot = JSON.stringify(fresh);
    if (freshSnapshot === lastSnapshot) return;

    settleTimers();
    // Keep elapsed time while respecting each task's externally supplied state.
    const localById = new Map((plan.tasks || []).map((t) => [t.id, t]));
    for (const task of fresh.tasks) {
      const local = localById.get(task.id);
      if (!local) continue;
      task.spent_sec = Math.max(task.spent_sec, local.spent_sec);
      if (local.running !== task.running || task.done) carryByTask.delete(task.id);
    }
    plan = fresh;
    rollPlanDate();
    lastSnapshot = serialize();
    render(computeView(), false);
  }

  // ------------------------------------------------------------------- demo

  function demoPlan() {
    return {
      date: todayString(),
      intro: "demo",
      tasks: [
        { id: "t1", title: "写周报", start: "09:30", end: "10:00", est_min: 30, spent_sec: 0 },
        { id: "t2", title: "修登录 bug", start: "10:00", end: "11:00", est_min: 60, spent_sec: 0 },
        { id: "t3", title: "回复邮件", start: "11:00", end: "11:30", est_min: 30, spent_sec: 0 },
      ],
    };
  }

  // ------------------------------------------------------------------- tick

  function settleTimers() {
    const nowMs = Date.now();
    const delta = Math.max(0, (nowMs - lastTickAt) / 1000);
    lastTickAt = nowMs;

    const running = (plan.tasks || []).filter((t) => !t.done && t.running);
    let changed = false;
    for (const task of running) {
      const carry = (carryByTask.get(task.id) || 0) + delta;
      const whole = Math.floor(carry);
      carryByTask.set(task.id, carry - whole);
      if (whole > 0) {
        task.spent_sec = Math.floor(Number(task.spent_sec || 0)) + whole;
        changed = true;
      }
    }
    // Forget carries of tasks that stopped running.
    for (const id of Array.from(carryByTask.keys())) {
      if (!running.some((task) => task.id === id)) carryByTask.delete(id);
    }
    return changed;
  }

  function tick() {
    try {
      // running across midnight must not leave the plan stale for a day
      rollPlanDate();
      const changed = settleTimers();
      const view = computeView();
      if (changed) maybeSave(false);
      render(view, false);
    } catch (err) {
      console.error("[workbar] tick failed", err);
    }
  }

  // ------------------------------------------------------------------- wire

  function wire() {
    el.previous.addEventListener("click", () => moveTaskWindow(-1));
    el.next.addEventListener("click", () => moveTaskWindow(1));
    el.collapse.addEventListener("click", () => collapse());
    el.slim.addEventListener("click", () => expand());
    document.addEventListener("contextmenu", (event) => event.preventDefault());
    window.addEventListener("resize", () => {
      // Cleanup only: tall-viewport CSS hides the line even if this is late.
      if (window.innerHeight > 8) el.stage.classList.remove("expanding");
      if (!collapsed) render(computeView(), true);
    });
    document.addEventListener("visibilitychange", () => {
      trace(`visibility ${document.visibilityState}`);
      if (!document.hidden) tick();
    });
    const slimViewport = window.matchMedia("(max-height: 8px)");
    slimViewport.addEventListener("change", () => {
      const size = `${window.innerWidth}x${window.innerHeight}`;
      trace(`viewport slim=${slimViewport.matches} size=${size}`);
      // Diagnostic only: neither visual state waits for this callback.
      requestAnimationFrame(() => trace(`viewport frame size=${size}`));
    });
    if (typeof PerformanceObserver === "function"
        && PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration >= 100) trace(`longtask start=${Math.round(performance.timeOrigin + entry.startTime)} duration=${Math.round(entry.duration)}ms`);
        }
      }).observe({ type: "longtask" });
    }

    if (listen) {
      // native 1s tick: keeps the clock moving even when Chromium throttles JS timers
      listen("clock-tick", () => tick());
      listen("plan-changed", () => externalChange());
      listen("bar-shown", () => {
        if (collapsed) expand();
      });
      // Hotkey / tray already schedules the native resize. Update the visuals
      // without submitting a second operation and a second completion event.
      listen("bar-toggle", (event) => {
        if (!event || typeof event.payload !== "boolean") return;
        trace(`recv bar-toggle ${event.payload}`);
        if (event.payload) collapse(false);
        else expand(false);
      });
      // Completion events are diagnostic acknowledgements, not visual gates:
      // WebView2 can deliver them late or after a newer toggle.
      listen("bar-resized", (event) => {
        if (!event || typeof event.payload !== "boolean") return;
        trace(`recv bar-resized ${event.payload}`);
      });
      // Rust already expanded/resized the window (recovery from hidden)
      listen("mode-changed", (event) => {
        if (event && event.payload === false) {
          collapsed = false;
          el.stage.classList.remove("collapsed", "expanding");
        }
      });
    }
  }

  async function boot() {
    wire();
    await loadPlan(true);
    lastTickAt = Date.now();
    setInterval(tick, 1000);
  }

  boot().catch((err) => {
    console.error("[workbar] boot failed", err);
  });
})();
