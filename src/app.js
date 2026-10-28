/* Workbar renderer — no framework, no build step. */
(() => {
  "use strict";

  const TAURI = window.__TAURI__ || null;
  const invoke = TAURI && TAURI.core ? TAURI.core.invoke : null;
  const listen = TAURI && TAURI.event ? TAURI.event.listen : null;

  const { t } = window.WorkbarI18n;

  const RING_LEN = 2 * Math.PI * 18;
  const MAX_VISIBLE_TASKS = 4;
  const TASK_COLOR_COUNT = 4;
  const CARD_MOTION = { duration: 320, delay: 35, easing: "cubic-bezier(.16,1,.3,1)", fill: "backwards" };
  const BROWSE_MOTION = { duration: 240, delay: 0, easing: "cubic-bezier(.22,1,.36,1)", fill: "backwards" };

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
  let barError = null;
  let lastSnapshot = "";
  let slimSignature = "";
  let unitNodes = [];
  let saving = false;
  let externalQueued = false;
  let loading = false;
  let readGeneration = 0;
  let needsReconcile = false;
  const pendingActions = [];
  let collapsed = false;
  let windowStart = 0;
  let windowAnchor = null;
  let visibleIds = [];
  let windowCapacity = MAX_VISIBLE_TASKS;
  let viewportMotion = null;
  let barWidthMotion = null;
  let nativeWidthLimit = null;
  let reportedTaskCount = null;
  let layoutRequest = null;
  let layoutGeneration = 0;
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
      return rest ? t("time.hoursMinutes", { hours: h, minutes: rest }) : t("time.hours", { count: h });
    }
    return t("time.minutes", { count: m });
  }

  function taskWindowLabel(task) {
    if (task.start && task.end) return `${task.start}–${task.end}`;
    if (task.start) return t("bar.startsAt", { time: task.start });
    if (task.end) return t("bar.endsBy", { time: task.end });
    return "";
  }

  /** Friendly "starts soon" hint: coarser buckets as the start gets closer. */
  function startHint(remainMin) {
    if (remainMin < 5) return t("bar.soonMinutes", { count: 5 });
    if (remainMin < 10) return t("bar.soonMinutes", { count: 10 });
    if (remainMin < 15) return t("bar.soonMinutes", { count: 15 });
    if (remainMin < 30) return t("bar.soonMinutes", { count: 30 });
    if (remainMin < 60) return t("bar.soonHour");
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
      '<button class="ring" type="button">',
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
      '<button class="done" type="button">',
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
    barWidthMotion?.cancel();
    barWidthMotion = null;
    for (const [node, entry] of leavingUnits) {
      entry.animation.cancel();
      node.remove();
    }
    leavingUnits.clear();
  }

  function animateCard(refs, frames, timing = CARD_MOTION) {
    const animation = refs.root.animate(frames, timing);
    refs.motion = animation;
    const release = () => {
      if (refs.motion === animation) refs.motion = null;
    };
    animation.finished.then(release, release);
  }

  function exitUnit(refs, rect, origin, opacity, travel = null) {
    const node = refs.root;
    delete node.dataset.id;
    node.classList.add("unit-exit");
    node.inert = true;
    node.setAttribute("aria-hidden", "true");
    node.style.left = `${rect.left - origin.left}px`;
    node.style.top = `${rect.top - origin.top}px`;
    el.viewport.append(node);
    const frames = travel === null ? [
      { opacity, transform: "translateX(0) scale(1)" },
      { opacity: 0, transform: "translateX(-12px) scale(.96)" },
    ] : [
      { opacity, transform: "translateX(0)" },
      { opacity, transform: `translateX(${travel}px)` },
    ];
    const animation = node.animate(frames, travel === null ? { duration: 150, easing: "ease-out" } : BROWSE_MOTION);
    const entry = { refs, animation };
    leavingUnits.set(node, entry);
    const release = () => {
      // A reversed browse may already have reclaimed this exact card. Its
      // cancelled exit must not remove the live node in a later microtask.
      if (leavingUnits.get(node) !== entry) return;
      node.remove();
      leavingUnits.delete(node);
    };
    animation.finished.then(release, release);
  }

  function ensureUnits(tasks, immediate, snapshot, navigation = 0) {
    const ids = tasks.length ? tasks.map((task) => task.id) : [null];
    const animate = !immediate && !collapsed && !reducedMotion()
      && typeof el.units.animate === "function" && unitNodes.length > 0;
    if (ids.length === unitNodes.length && ids.every((id, index) => unitNodes[index].taskId === id)
        && snapshot.targetWidth === el.viewport.style.width && snapshot.browseHidden === el.previous.hidden) {
      if (!animate) stopCardMotion();
      return unitNodes;
    }

    // Include still-visible outgoing cards: an immediate direction reversal
    // reuses the same nodes and their painted positions, without duplicate
    // ghosts or a jump back to the beginning of the previous animation.
    const { candidates, clip, before, opacity } = snapshot;
    const previous = new Map(candidates.map((refs) => [refs.taskId, refs]));
    if (!animate) stopCardMotion();
    else {
      for (const refs of unitNodes) {
        refs.motion?.cancel();
        refs.motion = null;
      }
      viewportMotion?.cancel();
      viewportMotion = null;
      barWidthMotion?.cancel();
      barWidthMotion = null;
      for (const [node, entry] of leavingUnits) {
        leavingUnits.delete(node);
        entry.animation.cancel();
      }
    }
    const next = ids.map((id) => {
      const refs = previous.get(id) || createUnit();
      refs.taskId = id;
      refs.root.classList.remove("unit-exit");
      refs.root.inert = false;
      refs.root.removeAttribute("aria-hidden");
      refs.root.style.left = "";
      refs.root.style.top = "";
      return refs;
    });
    const outgoing = candidates.filter((refs) => !ids.includes(refs.taskId));
    // Detach departures before measuring the new layout; their painted
    // rectangles above are enough to put visible ones in a temporary overlay.
    for (const refs of outgoing) refs.root.remove();
    next.forEach((refs, index) => {
      const current = el.units.children[index];
      if (current !== refs.root) el.units.insertBefore(refs.root, current || null);
    });
    unitNodes = next;
    if (!animate) return next;

    const origin = el.viewport.getBoundingClientRect();
    const after = new Map(next.map((refs) => [refs.taskId, refs.root.getBoundingClientRect()]));
    const shifts = next.filter((refs) => before.has(refs.taskId))
      .map((refs) => (before.get(refs.taskId).left - clip.left) - (after.get(refs.taskId).left - origin.left));
    const entryOffset = shifts.find((shift) => Math.abs(shift) > 0.5)
      || (navigation || 1) * parseFloat(getComputedStyle(el.units).getPropertyValue("--card-width"));
    const timing = navigation ? BROWSE_MOTION : CARD_MOTION;
    for (const refs of outgoing) {
      const rect = before.get(refs.taskId);
      // Rapid clicks can skip cards that never reached the clipped viewport;
      // keep only departures that still have visible pixels to animate.
      if (rect.right > clip.left + 0.5 && rect.left < clip.right - 0.5) {
        // An interrupted completion may leave an overlay between card slots;
        // its final position must still be completely outside the viewport.
        const travel = !navigation ? null : entryOffset > 0
          ? Math.min(-entryOffset, clip.left - rect.right)
          : Math.max(-entryOffset, clip.right - rect.left);
        exitUnit(refs, rect, clip, opacity.get(refs.taskId), travel);
      }
    }
    for (const refs of next) {
      const old = before.get(refs.taskId);
      const target = after.get(refs.taskId);
      if (old) {
        // The compact capsule itself moves as its width changes. Animate card
        // positions relative to that viewport, so centering cannot cause jumps.
        const dx = (old.left - clip.left) - (target.left - origin.left);
        const dy = (old.top - clip.top) - (target.top - origin.top);
        const alpha = opacity.get(refs.taskId);
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5 || alpha < 0.999) {
          animateCard(refs, [
            { transform: `translate(${dx}px, ${dy}px)`, opacity: alpha },
            { transform: "translate(0, 0)", opacity: 1 },
          ], timing);
        }
      } else {
        animateCard(refs, [
          { transform: `translateX(${refs.taskId === null ? 16 : entryOffset}px)`, opacity: navigation ? 1 : 0.55 },
          { transform: "translateX(0)", opacity: 1 },
        ], timing);
      }
    }
    const width = parseFloat(el.viewport.style.width);
    if (Math.abs(clip.width - width) > 0.5) {
      const animation = el.viewport.animate([{ width: `${clip.width}px` }, { width: `${width}px` }], CARD_MOTION);
      viewportMotion = animation;
      const release = () => {
        if (viewportMotion === animation) viewportMotion = null;
      };
      animation.finished.then(release, release);
    }
    const barStyle = getComputedStyle(el.bar);
    const barWidth = width + el.tail.getBoundingClientRect().width
      + parseFloat(barStyle.paddingLeft) + parseFloat(barStyle.paddingRight)
      + (parseFloat(barStyle.columnGap) || 0);
    if (Math.abs(snapshot.barWidth - barWidth) > 0.5) {
      const animation = el.bar.animate([{ width: `${snapshot.barWidth}px` }, { width: `${barWidth}px` }], CARD_MOTION);
      barWidthMotion = animation;
      const release = () => { if (barWidthMotion === animation) barWidthMotion = null; };
      animation.finished.then(release, release);
    }
    return next;
  }

  function pendingTasks() {
    // Persisted array order is the queue, including explicit user moves.
    return (plan.tasks || []).filter((task) => !task.done);
  }

  function syncWindowTaskCount(count, force = false) {
    if (!invoke) return Promise.resolve();
    if (!force && reportedTaskCount === count) return layoutRequest || Promise.resolve();
    reportedTaskCount = count;
    const generation = ++layoutGeneration;
    layoutRequest = invoke("sync_task_count", { count }).then((layout) => {
      if (generation !== layoutGeneration || !Number.isFinite(layout?.maxWidth)) return;
      const changed = nativeWidthLimit !== null && Math.abs(nativeWidthLimit - layout.maxWidth) > 0.5;
      nativeWidthLimit = layout.maxWidth;
      if (changed && !collapsed) render(computeView(), true);
    }).catch((err) => {
      if (generation === layoutGeneration) reportedTaskCount = null;
      console.warn("[workbar] window width sync failed", err);
    });
    return layoutRequest;
  }

  /** Keep card dimensions fixed; smaller screens show fewer whole cards. */
  function cardLayout(total) {
    const cardWidth = parseFloat(getComputedStyle(el.units).getPropertyValue("--card-width"));
    if (collapsed) return { cardWidth, capacity: windowCapacity };
    const barStyle = getComputedStyle(el.bar);
    const tailStyle = getComputedStyle(el.tail);
    const stageStyle = getComputedStyle(el.stage);
    const gap = parseFloat(barStyle.columnGap) || 0;
    // Use the monitor limit reported by native code, not the already compact
    // capsule. Otherwise adding tasks to a one-card window could never grow it.
    const available = (nativeWidthLimit ?? window.innerWidth)
      - parseFloat(stageStyle.paddingLeft) - parseFloat(stageStyle.paddingRight)
      - parseFloat(barStyle.paddingLeft) - parseFloat(barStyle.paddingRight)
      - el.collapse.offsetWidth - parseFloat(tailStyle.paddingLeft)
      - parseFloat(tailStyle.paddingRight) - gap;
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
    const nextStart = Math.max(0, Math.min(windowStart + direction, pending.length - windowCapacity));
    if (nextStart === windowStart) return;
    windowStart = nextStart;
    windowAnchor = pending[windowStart]?.id || null;
    render(computeView(), false, direction);
  }

  function unitTarget(view, task) {
    if (!task) {
      const complete = view.state === "complete";
      return {
        title: complete ? t("bar.complete") : t("bar.empty"),
        elapsed: "",
        estimate: complete ? t("bar.completedCount", { count: view.doneCount }) : t("bar.planHint"),
        status: complete ? t("bar.rest") : "",
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
        title: task.title || t("bar.untitled"),
        elapsed: "",
        estimate: startMin === null ? t("bar.pending") : t("bar.startsAt", { time: task.start }),
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
      title: task.title || t("bar.untitled"),
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

  function renderUnits(view, pending, immediate, navigation) {
    // Measure before computeUnits changes width or navigation controls.
    const candidates = [...unitNodes, ...Array.from(leavingUnits.values(), (entry) => entry.refs)];
    const snapshot = {
      candidates,
      clip: el.viewport.getBoundingClientRect(),
      before: new Map(candidates.map((refs) => [refs.taskId, refs.root.getBoundingClientRect()])),
      opacity: new Map(candidates.map((refs) => [refs.taskId, Number(getComputedStyle(refs.root).opacity)])),
      barWidth: el.bar.getBoundingClientRect().width,
      targetWidth: el.viewport.style.width,
      browseHidden: el.previous.hidden,
    };
    const list = computeUnits(pending);
    const nodes = ensureUnits(list, immediate, snapshot, navigation);
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
      refs.ring.title = t("bar.timerTitle");
      refs.ring.setAttribute("aria-label", t("bar.timerLabel"));
      refs.done.title = t("bar.doneTitle");
      refs.done.setAttribute("aria-label", t("bar.done"));
      refs.estimate.title = target.estimate;
      refs.status.title = target.status;
      refs.done.disabled = !task;
    });
    return list;
  }

  function render(view, immediate, navigation = 0) {
    const { bar } = el;
    bar.dataset.state = view.state;
    bar.classList.toggle("complete", view.state === "complete");

    const pending = pendingTasks();
    syncWindowTaskCount(pending.length);
    renderUnits(view, pending, immediate, navigation);
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

  // ----------------------------------------------------------- task actions

  function showBarError(key, error) {
    barError = { key, error: String(error) };
    el.bar.title = t(key, { error: barError.error });
  }

  function serialize() {
    return JSON.stringify(plan);
  }

  function applyAction(task, action) {
    const now = Date.now();
    const elapsed = task.elapsed_ms + (task.running && task.running_since_ms !== null
      ? Math.max(0, now - task.running_since_ms) : 0);
    task.elapsed_ms = elapsed;
    task.running_since_ms = action === "start" ? now : null;
    task.running = action === "start";
    task.paused = action === "pause";
    task.done = action === "complete";
    task.spent_sec = Math.floor(elapsed / 1000);
  }

  async function queueAction(id, action) {
    if (!invoke) return;
    pendingActions.push({ id, action });
    needsReconcile = true;
    // Invalidate a read started before this optimistic interaction.
    readGeneration += 1;
    if (saving) return;
    saving = true;
    try {
      while (pendingActions.length) {
        const operation = pendingActions[0];
        try {
          const fresh = await invoke("task_action", operation);
          barError = null;
          el.bar.removeAttribute("title");
          if (pendingActions.length === 1) acceptPlan(fresh);
        } catch (err) {
          console.error("[workbar] task action failed", err);
          showBarError("bar.saveError", err);
        }
        pendingActions.shift();
      }
    } finally {
      saving = false;
      // Always refresh after the queue, including failures. Never persist an
      // optimistic snapshot, and never replay a possibly committed operation.
      externalQueued = false;
      externalChange();
    }
  }

  // ---------------------------------------------------------------- actions

  function toggleTaskPause(id) {
    settleTimers();
    const view = computeView();
    if (view.state === "empty" || view.state === "complete") return;
    const task = (plan.tasks || []).find((t) => t.id === id);
    if (!task || task.done) return;
    const action = task.running ? "pause" : "start";
    applyAction(task, action);
    render(computeView());
    queueAction(id, action);
  }

  function completeTask(id) {
    settleTimers();
    const task = (plan.tasks || []).find((t) => t.id === id);
    if (!task || task.done) return;
    const refs = unitNodes.find((node) => node.taskId === id);
    if (refs) burst(refs.done);
    applyAction(task, "complete");
    render(computeView());
    queueAction(id, "complete");
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
      tasks: Array.isArray(next.tasks)
        ? next.tasks.map((task) => ({
            id: String(task.id || ""),
            title: String(task.title || ""),
            start: task.start || undefined,
            end: task.end || undefined,
            est_min: Math.max(0, Math.floor(Number(task.est_min) || 0)),
            timer: task.timer === "up" ? "up" : task.timer === "down" ? "down" : undefined,
            spent_sec: Math.max(0, Math.floor(Number(task.spent_sec) || 0)),
            elapsed_ms: Math.max(0, Number.isFinite(task.elapsed_ms) ? task.elapsed_ms : Number(task.spent_sec || 0) * 1000),
            running_since_ms: Number.isFinite(task.running_since_ms) ? task.running_since_ms : null,
            plan_date: task.plan_date || next.date || todayString(),
            running: !!task.running && !task.done,
            paused: !!task.paused && !task.running && !task.done,
            done: !!task.done,
            source: task.source || undefined,
            note: task.note || undefined,
          }))
        : [],
    };
  }

  async function loadPlan(immediate) {
    const generation = ++readGeneration;
    if (invoke) {
      try {
        const fresh = await invoke("get_plan");
        if (generation !== readGeneration || saving) return;
        plan = normalizePlan(fresh);
      } catch (err) {
        console.warn("[workbar] load failed", err);
        // Keep the last usable state; a read error is never an empty plan.
        showBarError("bar.readError", err);
        return;
      }
    } else {
      plan = normalizePlan(demoPlan());
    }
    await syncWindowTaskCount((plan.tasks || []).filter((task) => !task.done).length);
    lastSnapshot = serialize();
    settleTimers();
    render(computeView(), immediate !== false);
  }

  function acceptPlan(raw) {
    const fresh = normalizePlan(raw);
    const snapshot = JSON.stringify(fresh);
    if (snapshot === lastSnapshot && !needsReconcile) return;
    plan = fresh;
    needsReconcile = false;
    lastSnapshot = snapshot;
    settleTimers();
    render(computeView(), false);
  }

  async function externalChange() {
    if (!invoke) return;
    if (saving || loading) {
      externalQueued = true;
      return;
    }
    loading = true;
    const generation = ++readGeneration;
    try {
      const fresh = await invoke("get_plan");
      if (generation === readGeneration && !saving) acceptPlan(fresh);
    } catch (err) {
      console.warn("[workbar] refresh failed", err);
    } finally {
      loading = false;
      if (externalQueued && !saving) {
        externalQueued = false;
        externalChange();
      }
    }
  }

  // ------------------------------------------------------------------- demo

  function demoPlan() {
    return {
      date: todayString(),
      tasks: [
        { id: "t1", title: t("demo.report"), start: "09:30", end: "10:00", est_min: 30, spent_sec: 0 },
        { id: "t2", title: t("demo.bug"), start: "10:00", end: "11:00", est_min: 60, spent_sec: 0 },
        { id: "t3", title: t("demo.email"), start: "11:00", end: "11:30", est_min: 30, spent_sec: 0 },
      ],
    };
  }

  // ------------------------------------------------------------------- tick

  function settleTimers() {
    const nowMs = Date.now();
    for (const task of plan.tasks || []) {
      const elapsed = task.elapsed_ms + (task.running && task.running_since_ms !== null
        ? Math.max(0, nowMs - task.running_since_ms) : 0);
      const seconds = Math.floor(elapsed / 1000);
      task.spent_sec = seconds;
    }
  }

  function tick() {
    try {
      if (plan.date !== todayString()) externalChange();
      settleTimers();
      const view = computeView();
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
      const count = (plan.tasks || []).filter((task) => !task.done).length;
      syncWindowTaskCount(count, true);
      if (!collapsed) render(computeView(), cardLayout(count).capacity !== windowCapacity);
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
    await window.WorkbarI18n.ready;
    window.addEventListener("workbar-language-changed", () => {
      render(computeView(), true);
      if (barError) el.bar.title = t(barError.key, { error: barError.error });
    });
    wire();
    await loadPlan(true);
    setInterval(tick, 1000);
  }

  boot().catch((err) => {
    console.error("[workbar] boot failed", err);
  });
})();
