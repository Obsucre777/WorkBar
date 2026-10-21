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
    title: $("title"),
    pulse: $("pulse"),
    elapsed: $("elapsed"),
    estimate: $("estimate"),
    status: $("status"),
    ring: $("ring"),
    ringFill: $("ringFill"),
    done: $("done"),
    queue: $("queue"),
    progress: $("progress"),
    collapse: $("collapse"),
    slim: $("slim"),
    slimBar: $("slimBar"),
    burst: $("burst"),
  };

  let plan = { date: "", current_id: null, tasks: [] };
  let lastSnapshot = "";
  let queueSignature = "";
  let titleCache = "";
  let lastTickAt = Date.now();
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
      upNext: [],
    };

    if (!fresh || tasks.length === 0) {
      view.state = "empty";
      view.upNext = tasks.slice(0, 0);
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

    const queue = pending
      .filter((t) => t.id !== current.id)
      .sort((a, b) => {
        const sa = hhmmToMin(a.start);
        const sb = hhmmToMin(b.start);
        if (sa === null && sb === null) return 0;
        if (sa === null) return 1;
        if (sb === null) return -1;
        return sa - sb;
      })
      .slice(0, 3);
    view.upNext = queue;
    return view;
  }

  // ----------------------------------------------------------------- render

  function animateTitle(text, immediate) {
    if (text === titleCache) return;
    titleCache = text;
    if (immediate || !el.title.animate) {
      el.title.textContent = text;
      return;
    }
    el.title.animate(
      [
        { opacity: 0, transform: "translateY(-6px)", filter: "blur(3px)" },
        { opacity: 1, transform: "translateY(0)", filter: "blur(0)" },
      ],
      { duration: 300, easing: "cubic-bezier(.16,1,.3,1)" }
    );
    el.title.textContent = text;
  }

  function render(view, immediate) {
    const { bar } = el;
    bar.dataset.state = view.state;
    bar.classList.toggle("overdue", view.state === "active" && view.overdueMin > 0);
    bar.classList.toggle("complete", view.state === "complete");

    // title
    let title = "今天还没有计划";
    if (view.state === "complete") title = "今天的工作都完成了";
    else if (view.task) title = view.task.title || "未命名任务";
    animateTitle(title, immediate);

    // meta
    const task = view.task;
    if (!task) {
      el.elapsed.textContent = "--:--";
      el.estimate.textContent =
        view.state === "complete" ? `完成 ${view.doneCount} 项` : "等待 AI 排计划";
    } else {
      el.elapsed.textContent =
        view.state === "upcoming" ? "—" : formatClock(task.spent_sec);
      el.estimate.textContent =
        view.state === "upcoming"
          ? `${view.task.start} 开始`
          : formatEstimate(task.est_min);
    }

    // status line
    let status = "";
    let statusClass = "";
    if (view.state === "upcoming") {
      status = `还有 ${view.startsIn} 分钟`;
      statusClass = "strong";
    } else if (view.state === "paused") {
      status = "已暂停 · 点圆环继续";
    } else if (view.state === "complete") {
      status = "休息一下";
    } else if (view.state === "empty") {
      status = "用 AI 说一句就能排";
    } else if (view.overdueMin > 0) {
      status = `超时 ${view.overdueMin} 分钟`;
      statusClass = "warn";
    }
    el.status.textContent = status;
    el.status.className = `status ${statusClass}`.trim();

    // ring
    const estSec = Math.max(1, Number(task && task.est_min ? task.est_min : 25) * 60);
    let progress = 0;
    if (view.state === "complete") progress = 1;
    else if (task) progress = Math.max(0, Math.min(1, Number(task.spent_sec || 0) / estSec));
    el.ringFill.style.strokeDashoffset = String(RING_LEN * (1 - progress));

    let mode = "idle";
    if (view.state === "paused") mode = "paused";
    else if (view.state === "active") mode = "running";
    el.ring.dataset.mode = mode;

    el.pulse.classList.toggle("on", view.state === "active" && view.running);

    // progress counter
    el.progress.textContent = `${view.doneCount} / ${view.total}`;

    // queue
    const signature = view.upNext.map((t) => `${t.id}:${t.title}:${t.start || ""}`).join("|");
    if (signature !== queueSignature) {
      queueSignature = signature;
      el.queue.replaceChildren();
      for (const item of view.upNext) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "chip";
        chip.dataset.id = item.id;
        chip.title = "点一下切换到这项";
        const dot = document.createElement("span");
        dot.className = "dot";
        const label = document.createElement("span");
        label.className = "label";
        label.textContent = item.title;
        chip.append(dot, label);
        if (item.start) {
          const time = document.createElement("span");
          time.className = "time";
          time.textContent = item.start;
          chip.append(time);
        }
        chip.addEventListener("click", () => jumpTo(item.id));
        el.queue.append(chip);
      }
    }

    // collapsed line: progress retracts the line from both ends to the center.
    // "none" / "complete" = no work left -> the strip stays clickable but shows nothing.
    let lineState = "active";
    if (view.state === "complete") lineState = "complete";
    else if (view.state === "empty") lineState = "none";
    else if (view.state === "upcoming") lineState = "idle";
    else if (view.overdueMin > 0) lineState = "overdue";
    else if (view.state === "paused") lineState = "paused";
    el.stage.dataset.lineState = lineState;
    el.slimBar.style.setProperty("--p", String(Math.min(1, Math.max(0, progress))));

    // done button availability is handled by [data-state] css
    return view;
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

  function jumpTo(id) {
    const task = (plan.tasks || []).find((t) => t.id === id);
    if (!task || task.done) return;
    paused.delete(id);
    plan.current_id = id;
    task.running = true;
    render(computeView());
    saveNow();
  }

  function togglePause() {
    const view = computeView();
    if (!view.task || view.state === "empty" || view.state === "complete") return;
    const task = view.task;
    if (task.running) {
      task.running = false;
      paused.add(task.id);
    } else {
      task.running = true;
      paused.delete(task.id);
      plan.current_id = task.id;
    }
    render(computeView());
    saveNow();
  }

  function completeCurrent() {
    if (busy) return;
    const view = computeView();
    if (!view.task || view.state !== "active" && view.state !== "paused") return;
    const task = view.task;
    busy = true;
    el.bar.classList.add("flash", "leaving");
    burst();
    setTimeout(() => {
      task.done = true;
      task.running = false;
      paused.delete(task.id);
      if (plan.current_id === task.id) plan.current_id = null;
      el.bar.classList.remove("flash", "leaving");
      busy = false;
      render(computeView());
      saveNow();
    }, 250);
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
    queueSignature = "";
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

      const runningTask = (plan.tasks || []).find((t) => t.running && !t.done);
      if (runningTask) {
        runningTask.spent_sec = Math.floor(Number(runningTask.spent_sec || 0) + delta);
        maybeSave(false);
      }
      render(computeView(), false);
    } catch (err) {
      console.error("[workbar] tick failed", err);
    }
  }

  // ------------------------------------------------------------------- wire

  function wire() {
    el.done.addEventListener("click", completeCurrent);
    el.ring.addEventListener("click", togglePause);
    el.collapse.addEventListener("click", collapse);
    el.slim.addEventListener("click", expand);
    document.addEventListener("contextmenu", (event) => event.preventDefault());

    if (listen) {
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
    titleCache = "";
    animateTitle("Workbar 启动失败（看控制台）", true);
    el.estimate.textContent = String((err && err.message) || err);
  });
})();
