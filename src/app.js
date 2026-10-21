/* Workbar renderer — no framework, no build step. */
(() => {
  "use strict";

  const TAURI = window.__TAURI__ || null;
  const invoke = TAURI && TAURI.core ? TAURI.core.invoke : null;
  const listen = TAURI && TAURI.event ? TAURI.event.listen : null;

  const RING_LEN = 2 * Math.PI * 18;

  const $ = (id) => document.getElementById(id);
  const el = {
    stage: $("stage"),
    bar: $("bar"),
    units: $("units"),
    more: $("more"),
    progress: $("progress"),
    collapse: $("collapse"),
    slim: $("slim"),
    slimBar: $("slimBar"),
    slimLine: $("slimLine"),
    burst: $("burst"),
  };

  let plan = { date: "", current_id: null, tasks: [] };
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
  let collapsed = false;
  let busy = false;

  /** Task ids the user explicitly paused (runtime only). */
  const paused = new Set();

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
      return rest ? `预计 ${h} 小时 ${rest} 分` : `预计 ${h} 小时`;
    }
    return `预计 ${m} 分钟`;
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

  // ------------------------------------------------------------------ view

  function computeView() {
    const tasks = plan.tasks || [];
    const pending = tasks.filter((t) => !t.done);
    const today = todayString();
    const fresh = plan.date === today;
    const now = nowMinutes();

    const view = {
      state: "active",
      task: null,
      running: false,
      paused: false,
      overdueMin: 0,
      startsIn: 0,
      doneCount: tasks.filter((t) => t.done).length,
      total: tasks.length,
      pendingCount: tasks.filter((t) => !t.done).length,
    };

    if (!fresh || tasks.length === 0) {
      view.state = "empty";
      return view;
    }

    if (pending.length === 0) {
      view.state = "complete";
      return view;
    }

    let current = null;
    if (plan.current_id) {
      current = pending.find((t) => t.id === plan.current_id) || null;
    }
    if (!current) {
      current = pending.find((t) => {
        const start = hhmmToMin(t.start);
        const end = hhmmToMin(t.end);
        return start !== null && end !== null && now >= start && now < end;
      });
    }
    if (!current) {
      const upcoming = pending
        .filter((t) => {
          const start = hhmmToMin(t.start);
          return start !== null && start > now;
        })
        .sort((a, b) => hhmmToMin(a.start) - hhmmToMin(b.start));
      if (upcoming.length) {
        current = upcoming[0];
        view.state = "upcoming";
        view.startsIn = hhmmToMin(current.start) - now;
      } else {
        current = pending[0];
      }
    }

    if (!current) {
      view.state = "complete";
      return view;
    }

    // Auto-start when the clock reaches a task, unless the user paused it.
    if (view.state === "active" && !current.running && !paused.has(current.id)) {
      current.running = true;
    }
    if (current.running && view.state === "upcoming") {
      current.running = false;
    }

    view.task = current;
    view.running = !!current.running;
    view.paused = paused.has(current.id);
    if (view.paused) view.state = "paused";

    const est = Math.max(1, Number(current.est_min) || 25) * 60;
    const spent = Number(current.spent_sec) || 0;
    view.overdueMin = est > 0 && spent > est ? Math.floor((spent - est) / 60) : 0;

    return view;
  }

  // ----------------------------------------------------------------- render

  function animateUnitTitle(node, text, immediate) {
    if (immediate || !node.animate) {
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

  /** Build (or reuse) one "current task" unit per engaged task. */
  function ensureUnits(count) {
    if (unitNodes.length === count) return unitNodes;
    el.units.replaceChildren();
    unitNodes = [];
    for (let index = 0; index < count; index += 1) {
      const root = document.createElement("div");
      root.className = `unit unit-${index}`;
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
      };
      // only the ring starts / pauses the timer
      refs.ring.addEventListener("click", () => {
        if (refs.taskId) toggleTaskPause(refs.taskId);
      });
      refs.done.addEventListener("click", () => {
        if (refs.taskId) completeTask(refs.taskId);
      });
      el.units.append(root);
      unitNodes.push(refs);
    }
    return unitNodes;
  }

  /** One expanded unit per task, in stable start-time order so clicking a task
   *  never makes it swap places with another one. The current task is always
   *  kept visible even if it starts later than the first three. */
  function computeUnits(view) {
    const pending = (plan.tasks || [])
      .filter((task) => !task.done)
      .sort((a, b) => {
        const sa = hhmmToMin(a.start);
        const sb = hhmmToMin(b.start);
        if (sa === null && sb === null) return a.id.localeCompare(b.id);
        if (sa === null) return 1;
        if (sb === null) return -1;
        return sa - sb;
      });
    const shown = pending.slice(0, 3);
    const current = view.task;
    if (current && !shown.some((task) => task.id === current.id)) {
      shown.pop();
      shown.push(current);
    }
    return shown;
  }

  function unitTarget(view, task, isCurrent) {
    if (!task) {
      const complete = view.state === "complete";
      return {
        title: complete ? "今天的工作都完成了" : "今天还没有计划",
        elapsed: "",
        estimate: complete ? `完成 ${view.doneCount} 项` : "等待 AI 排计划",
        status: complete ? "休息一下" : "用 AI 说一句就能排",
        statusClass: "",
        progress: complete ? 1 : 0,
        mode: "idle",
        pulse: false,
        showProgress: complete,
      };
    }

    const est = Math.max(1, Number(task.est_min || 25) * 60);
    const spent = Number(task.spent_sec || 0);
    const overdue = Math.max(0, Math.floor((spent - est) / 60));
    const progress = Math.min(1, Math.max(0, spent / est));
    const started =
      !!task.running ||
      spent > 0 ||
      (isCurrent && (view.state === "paused" || view.state === "active"));
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
        progress: 0,
        mode: "idle",
        pulse: false,
        showProgress: false,
      };
    }

    const mode = task.running ? "running" : "paused";
    // already timed (running or paused): elapsed / estimate, nothing else
    let status = "";
    let statusClass = "";
    if (mode === "running" && overdue > 0) {
      status = `超时 ${overdue} 分钟`;
      statusClass = "warn";
    }
    return {
      title: task.title || "未命名任务",
      elapsed: formatClock(spent),
      estimate: formatEstimate(task.est_min),
      status,
      statusClass,
      progress,
      mode,
      pulse: !!task.running,
      showProgress: progress > 0 || !!task.running,
    };
  }

  function renderUnits(view, immediate) {
    const list = computeUnits(view);
    const nodes = ensureUnits(Math.max(1, list.length));
    el.units.classList.toggle("multi", nodes.length > 1);
    const currentId = view.task ? view.task.id : null;
    nodes.forEach((refs, index) => {
      const task = list[index] || null;
      const isCurrent = !!task && task.id === currentId;
      refs.taskId = task ? task.id : null;
      refs.root.classList.toggle("current", isCurrent);
      refs.root.classList.toggle("stacked", nodes.length > 1);
      refs.root.classList.toggle("idle", !task);
      refs.root.dataset.id = task ? task.id : "";
      const target = unitTarget(view, task, isCurrent);
      if (refs.titleText !== target.title) {
        refs.titleText = target.title;
        animateUnitTitle(refs.title, target.title, immediate);
      }
      const key = `${target.elapsed}|${target.estimate}|${target.status}|${target.statusClass}|${target.mode}|${target.progress.toFixed(4)}`;
      if (refs.key !== key) {
        refs.key = key;
        refs.elapsed.textContent = target.elapsed;
        refs.elapsed.hidden = !target.elapsed;
        refs.slash.hidden = !target.elapsed;
        refs.estimate.textContent = target.estimate;
        refs.status.textContent = target.status;
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
    bar.classList.toggle("overdue", view.state === "active" && view.overdueMin > 0);
    bar.classList.toggle("complete", view.state === "complete");

    const shownUnits = renderUnits(view, immediate);

    // progress counter
    el.progress.textContent = `${view.doneCount} / ${view.total}`;

    // more pending tasks than fit on the bar: show "+N" (hover lists them)
    const shownIds = new Set(shownUnits.map((task) => task.id));
    const hidden = (plan.tasks || []).filter((task) => !task.done && !shownIds.has(task.id));
    el.more.textContent = hidden.length ? `+${hidden.length}` : "";
    el.more.hidden = hidden.length === 0;
    el.more.title = hidden.length
      ? `还有：${hidden.map((t) => `${t.title}${t.start ? ` ${t.start}` : ""}`).join("、")}`
      : "";

    // collapsed line state: colours/opacity for the single-task line.
    // "none" / "complete" = no work left -> the strip stays clickable but shows nothing.
    let lineState = "active";
    if (view.state === "complete") lineState = "complete";
    else if (view.state === "empty") lineState = "none";
    else if (view.state === "upcoming") lineState = "idle";
    else if (view.overdueMin > 0) lineState = "overdue";
    else if (view.state === "paused") lineState = "paused";
    el.stage.dataset.lineState = lineState;

    const currentProgress = view.task
      ? Math.min(
          1,
          Math.max(
            0,
            Number(view.task.spent_sec || 0) / Math.max(1, Number(view.task.est_min || 25) * 60)
          )
        )
      : 0;
    renderSlim(view, currentProgress);

    return view;
  }

  /** Collapsed strip: only tasks that actually started are shown, no matter if
   *  they are running or paused. One started task keeps the familiar single
   *  line; several become coloured segments (max 3, colour = task identity,
   *  brightness = running / paused). Tasks that never started are not drawn. */
  function renderSlim(view, currentProgress) {
    const started = (plan.tasks || [])
      .filter((task) => !task.done && (task.running || Number(task.spent_sec) > 0))
      .map((task) => ({ task, start: hhmmToMin(task.start) }))
      .sort((a, b) => {
        if (a.start === null && b.start === null) return a.task.id.localeCompare(b.task.id);
        if (a.start === null) return 1;
        if (b.start === null) return -1;
        return a.start - b.start;
      })
      .map((entry) => entry.task)
      .slice(0, 3);

    const multi = started.length > 1;
    el.slimBar.hidden = multi || started.length === 0;
    el.slimLine.hidden = !multi;

    if (started.length === 0) {
      slimSignature = "";
      el.slimLine.replaceChildren();
      el.slimBar.style.setProperty("--p", "0");
      return;
    }

    if (!multi) {
      slimSignature = "";
      el.slimLine.replaceChildren();
      const task = started[0];
      const p = Math.min(
        1,
        Math.max(0, Number(task.spent_sec || 0) / Math.max(1, Number(task.est_min || 25) * 60))
      );
      el.slimBar.style.setProperty("--p", String(p));
      return;
    }

    const signature = started.map((task) => task.id).join("|");
    if (signature !== slimSignature) {
      slimSignature = signature;
      el.slimLine.replaceChildren();
      started.forEach((task, index) => {
        const seg = document.createElement("i");
        seg.className = `slim-seg seg-${index}`;
        seg.dataset.id = task.id;
        el.slimLine.append(seg);
      });
    }

    const currentId = view.task ? view.task.id : null;
    Array.from(el.slimLine.children).forEach((seg) => {
      const task = started.find((t) => t.id === seg.dataset.id);
      if (!task) return;
      const est = Math.max(1, Number(task.est_min || 25) * 60);
      const p = Math.min(1, Math.max(0, Number(task.spent_sec || 0) / est));
      seg.style.setProperty("--p", String(p));
      seg.classList.toggle("current", task.id === currentId);
      seg.dataset.state = task.running ? "running" : "paused";
    });
  }

  // ------------------------------------------------------------------ save

  function serialize() {
    return JSON.stringify(plan);
  }

  async function saveNow() {
    if (!invoke || saving) return;
    saving = true;
    try {
      const snapshot = serialize();
      await invoke("save_plan", { plan });
      lastSnapshot = snapshot;
    } catch (err) {
      console.warn("[workbar] save failed", err);
    } finally {
      saving = false;
    }
  }

  function maybeSave(force) {
    sinceSave += 1;
    const runningTask = (plan.tasks || []).find((t) => t.running && !t.done);
    if (force || (runningTask && sinceSave >= 12)) {
      sinceSave = 0;
      saveNow();
    }
  }

  // ---------------------------------------------------------------- actions

  function toggleTaskPause(id) {
    const view = computeView();
    if (!view.task || view.state === "empty" || view.state === "complete") return;
    const task = (plan.tasks || []).find((t) => t.id === id);
    if (!task || task.done) return;
    const isCurrent = view.task.id === id;
    if (task.running) {
      task.running = false;
      if (isCurrent) paused.add(task.id);
    } else {
      task.running = true;
      if (isCurrent) {
        paused.delete(task.id);
        plan.current_id = task.id;
      }
    }
    render(computeView());
    saveNow();
  }

  function completeTask(id) {
    if (busy) return;
    const view = computeView();
    const task = (plan.tasks || []).find((t) => t.id === id);
    if (!task || task.done) return;
    const isCurrent = !!view.task && view.task.id === id;
    busy = true;
    const finish = () => {
      task.done = true;
      task.running = false;
      paused.delete(task.id);
      if (plan.current_id === task.id) plan.current_id = null;
      el.bar.classList.remove("flash", "leaving");
      busy = false;
      render(computeView());
      saveNow();
    };
    if (isCurrent) {
      el.bar.classList.add("flash", "leaving");
      burst();
      setTimeout(finish, 250);
    } else {
      finish();
    }
  }

  function burst() {
    const count = 9;
    for (let i = 0; i < count; i += 1) {
      const particle = document.createElement("i");
      const angle = (Math.PI * 2 * i) / count + Math.random() * 0.4;
      const distance = 18 + Math.random() * 16;
      particle.style.setProperty("--dx", `${Math.cos(angle) * distance}px`);
      particle.style.setProperty("--dy", `${Math.sin(angle) * distance}px`);
      particle.style.animationDelay = `${Math.random() * 60}ms`;
      el.burst.append(particle);
      setTimeout(() => particle.remove(), 900);
    }
  }

  function collapse() {
    if (collapsed) return;
    collapsed = true;
    // hide the line right away: while the window is still tall it must not be
    // stretched into a translucent rectangle
    el.slim.style.display = "none";
    el.stage.classList.remove("line-ready");
    el.stage.classList.add("collapsed");
    setTimeout(async () => {
      // the user may have toggled back (e.g. hotkey) while the fade was running
      if (!collapsed) return;
      if (invoke) {
        try {
          await invoke("set_collapsed", { collapsed: true });
        } catch (err) {
          console.warn("[workbar] collapse failed", err);
        }
      }
      el.slim.style.display = "";
      requestAnimationFrame(() => el.stage.classList.add("line-ready"));
    }, 260);
  }

  function expand() {
    if (!collapsed) return;
    collapsed = false;
    // two-stage expand: line fades out -> window grows -> capsule eases in
    el.stage.classList.remove("line-ready");
    setTimeout(async () => {
      el.slim.style.display = "none";
      if (invoke) {
        try {
          await invoke("set_collapsed", { collapsed: false });
        } catch (err) {
          console.warn("[workbar] expand failed", err);
        }
      }
      requestAnimationFrame(() => el.stage.classList.remove("collapsed"));
    }, 170);
  }

  // ------------------------------------------------------------------ load

  function normalizePlan(raw) {
    const next = raw && typeof raw === "object" ? raw : {};
    return {
      date: typeof next.date === "string" ? next.date : "",
      intro: next.intro || undefined,
      current_id: next.current_id || null,
      tasks: Array.isArray(next.tasks)
        ? next.tasks.map((task) => ({
            id: String(task.id || ""),
            title: String(task.title || ""),
            start: task.start || undefined,
            end: task.end || undefined,
            est_min: Number(task.est_min) || 25,
            spent_sec: Math.max(0, Math.floor(Number(task.spent_sec) || 0)),
            running: !!task.running,
            done: !!task.done,
            note: task.note || undefined,
          }))
        : [],
    };
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
    lastSnapshot = serialize();
    render(computeView(), immediate !== false);
  }

  async function externalChange() {
    if (!invoke) return;
    let fresh;
    try {
      fresh = normalizePlan(await invoke("get_plan"));
    } catch {
      return;
    }
    const freshSnapshot = JSON.stringify(fresh);
    if (freshSnapshot === lastSnapshot) return;

    // Keep the local timer alive when only the structure changed elsewhere.
    const localById = new Map((plan.tasks || []).map((t) => [t.id, t]));
    for (const task of fresh.tasks) {
      const local = localById.get(task.id);
      if (!local) continue;
      task.spent_sec = Math.max(task.spent_sec, local.spent_sec);
      if (local.running && !task.done) task.running = true;
    }
    plan = fresh;
    lastSnapshot = serialize();
    render(computeView(), true);
  }

  // ------------------------------------------------------------------- demo

  function demoPlan() {
    return {
      date: todayString(),
      intro: "demo",
      current_id: null,
      tasks: [
        { id: "t1", title: "写周报", start: "09:30", end: "10:00", est_min: 30, spent_sec: 0 },
        { id: "t2", title: "修登录 bug", start: "10:00", end: "11:00", est_min: 60, spent_sec: 0 },
        { id: "t3", title: "回复邮件", start: "11:00", end: "11:30", est_min: 30, spent_sec: 0 },
      ],
    };
  }

  // ------------------------------------------------------------------- tick

  function tick() {
    try {
      const nowMs = Date.now();
      const delta = Math.max(0, (nowMs - lastTickAt) / 1000);
      lastTickAt = nowMs;

      const view = computeView();
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
      // forget carries of tasks that stopped running
      for (const id of Array.from(carryByTask.keys())) {
        if (!running.some((task) => task.id === id)) carryByTask.delete(id);
      }
      if (changed) maybeSave(false);
      render(view, false);
    } catch (err) {
      console.error("[workbar] tick failed", err);
    }
  }

  // ------------------------------------------------------------------- wire

  function wire() {
    el.collapse.addEventListener("click", collapse);
    el.slim.addEventListener("click", expand);
    document.addEventListener("contextmenu", (event) => event.preventDefault());
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) tick();
    });

    if (listen) {
      // native 1s tick: keeps the clock moving even when Chromium throttles JS timers
      listen("clock-tick", () => tick());
      listen("plan-changed", () => externalChange());
      listen("bar-shown", () => {
        if (collapsed) expand();
      });
      // Rust already expanded/resized the window (e.g. hotkey while collapsed)
      listen("mode-changed", (event) => {
        if (event && event.payload === false) {
          collapsed = false;
          el.slim.style.display = "none";
          el.stage.classList.remove("line-ready");
          el.stage.classList.remove("collapsed");
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
