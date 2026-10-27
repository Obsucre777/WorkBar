/* This window edits one preference. It never reads or writes the task plan. */
(() => {
  "use strict";
  const invoke = window.__TAURI__?.core.invoke;
  const listen = window.__TAURI__?.event.listen;
  const el = Object.fromEntries(["recorder", "keys", "recordingText", "hint", "status", "restore", "cancel", "close", "save"].map(id => [id, document.getElementById(id)]));
  const labels = { Control: "Ctrl", Space: "空格", Backquote: "`", Minus: "−", Equal: "=", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→" };
  const named = new Set(["Space", "Tab", "Enter", "Backspace", "Delete", "Insert", "Home", "End", "PageUp", "PageDown", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Backquote", "Minus", "Equal", "BracketLeft", "BracketRight", "Backslash", "Semicolon", "Quote", "Comma", "Period", "Slash"]);
  let saved, draft = "Alt+W", recording = false, arming = false, busy = false, capture = 0;
  let pending = Promise.resolve();

  function status(text = "", error = false) {
    el.status.textContent = text;
    el.status.classList.toggle("error", error);
  }
  function render() {
    el.keys.replaceChildren();
    if (!recording && !arming) draft.split("+").forEach(key => {
      const cap = document.createElement("kbd");
      cap.textContent = labels[key] || key.replace(/^(Key|Digit)/, "");
      el.keys.append(cap);
    });
    el.recordingText.textContent = arming ? "准备录入…" : recording ? "请按下新快捷键…" : "";
    el.recorder.classList.toggle("recording", recording);
    el.recorder.setAttribute("aria-pressed", String(recording));
    el.recorder.disabled = busy || arming || !saved;
    el.restore.disabled = busy || arming || !saved;
    el.save.disabled = busy || arming || recording || !saved || (draft === saved.shortcut && saved.registered && !saved.error);
    el.save.textContent = busy ? "保存中…" : "保存";
    el.hint.textContent = recording ? "单键或 Ctrl / Alt 组合键均可；Esc 取消录入" : "点击按键区域，直接按下新的快捷键（单键也可以）";
  }
  function setRecording(value) {
    pending = pending.catch(() => {}).then(() => invoke("set_shortcut_recording", { recording: value }));
    return pending;
  }
  function stopRecording() {
    ++capture;
    recording = arming = false;
    render();
    return invoke ? setRecording(false) : Promise.resolve();
  }
  async function startRecording() {
    if (busy || arming || recording || !saved) return;
    const attempt = ++capture;
    arming = true;
    render();
    try {
      await setRecording(true);
      if (attempt !== capture) return;
      arming = false;
      recording = true;
      render();
      el.recorder.focus();
      status("本次按键仅用于录入，保存后生效。");
    } catch (error) {
      if (attempt !== capture) return;
      arming = false;
      render();
      status(String(error), true);
    }
  }
  // These keys are used for typing everywhere; a global single-key hotkey on
  // one of them swallows the key in every app, so warn instead of silently saving.
  const typingKeys = new Set(["Space", "Tab", "Enter", "Backspace", "Quote", "Comma", "Period", "Slash", "Semicolon", "Backslash", "Minus", "Equal", "BracketLeft", "BracketRight", "Backquote"]);
  function accept(shortcut) {
    if (!recording) return;
    draft = shortcut;
    stopRecording().catch(error => status(String(error), true));
    status(!shortcut.includes("+") && (/^[A-Z0-9]$/.test(shortcut) || typingKeys.has(shortcut))
      ? "已录入。注意：这个键单用会在所有程序里触发 WorkBar，打字时会受影响。"
      : "已录入，点击保存后生效。");
  }
  function onKey(event) {
    if (!recording) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    if (event.key === "Escape") { stopRecording().catch(() => {}); status(); return; }
    if (/^(Control|Alt|Shift|Meta)$/.test(event.key)) return;
    if (event.metaKey) { status("不能使用 Windows 键，请换一个键。", true); return; }
    let key = event.code;
    if (/^Key[A-Z]$/.test(key)) key = key.slice(3);
    else if (/^Digit[0-9]$/.test(key)) key = key.slice(5);
    else if (!named.has(key) && !/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) { status("暂不支持这个按键，请换一个组合。", true); return; }
    if (key === "F12") { status("F12 为系统保留按键，请换一个组合。", true); return; }
    accept([event.ctrlKey && "Ctrl", event.altKey && "Alt", event.shiftKey && "Shift", key].filter(Boolean).join("+"));
  }
  async function load() {
    await stopRecording().catch(() => {});
    try {
      if (!invoke) throw new Error("请从 WorkBar 托盘菜单打开此窗口。");
      saved = await invoke("get_shortcut");
      draft = saved.shortcut;
      status(saved.error || "", Boolean(saved.error));
    } catch (error) { status(String(error), true); }
    render();
  }
  async function close() {
    if (busy) return;
    await stopRecording().catch(() => {});
    if (invoke) await invoke("close_shortcut_settings").catch(error => status(String(error), true));
  }
  async function save() {
    if (el.save.disabled || !invoke) return;
    busy = true;
    render();
    try {
      saved = await invoke("save_shortcut", { shortcut: draft });
      draft = saved.shortcut;
      busy = false;
      render();
      if (saved.error) status(saved.error, true);
      else await close();
    } catch (error) { status(String(error), true); }
    finally { busy = false; render(); }
  }
  el.recorder.addEventListener("click", startRecording);
  el.save.addEventListener("click", save);
  el.cancel.addEventListener("click", close);
  el.close.addEventListener("click", close);
  el.restore.addEventListener("click", () => {
    if (!saved || busy) return;
    stopRecording().catch(() => {});
    draft = saved.default_shortcut;
    render();
    status("已填入默认快捷键，点击保存后生效。");
  });
  document.addEventListener("keydown", onKey, true);
  const cancelCapture = () => { if (recording || arming) { stopRecording().catch(() => {}); status(); } };
  window.addEventListener("blur", cancelCapture);
  document.addEventListener("visibilitychange", () => { if (document.hidden) cancelCapture(); });
  async function initialize() {
    if (listen) {
      await listen("shortcut-settings-opened", load);
      await listen("shortcut-recorded", event => { if (typeof event.payload === "string") accept(event.payload); });
      await listen("shortcut-recording-cancelled", cancelCapture);
    }
    await load();
  }
  initialize().catch(error => status(String(error), true));
})();
