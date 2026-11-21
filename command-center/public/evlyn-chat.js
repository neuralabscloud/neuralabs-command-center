// Evlyn op de overview: hetzelfde gesprek als in Telegram.
// Tekst, spraak (opnemen → Whisper op de server → tekst in de invulbalk) en afbeeldingen
// (slepen, plakken, kiezen). Alleen voor de eigenaar; de server weigert teamgebruikers.
(function () {
  "use strict";
  const root = document.getElementById("evlyn-chat");
  if (!root) return;

  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // Lichte opmaak op al ge-escapete tekst: vet, code, links (alleen http/https).
  function rich(text) {
    let h = esc(text);
    h = h.replace(/```([\s\S]*?)```/g, (_, c) => `<pre>${c.replace(/^\n/, "")}</pre>`);
    h = h.replace(/`([^`\n]+)`/g, "<code>$1</code>");
    h = h.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, "$1<strong>$2</strong>");
    h = h.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
    return h;
  }
  const ICON = {
    clip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="M21 16l-5-5-9 9"/></svg>',
    mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v3"/></svg>',
    stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
    tg: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 4L3 11l5 2 2 6 3-4 5 4 3-15z"/></svg>',
  };

  root.innerHTML = `
    <div class="ev-head">
      <div class="ev-id">
        <span class="ev-orb" aria-hidden="true"></span>
        <div>
          <div class="ev-name" id="ev-name">Evlyn</div>
          <div class="ev-sub" id="ev-sub">Connecting</div>
        </div>
      </div>
      <button class="ev-ghost" id="ev-clear" type="button">Clear conversation</button>
    </div>
    <div class="ev-thread" id="ev-thread" aria-live="polite"></div>
    <div class="ev-strip" id="ev-strip" hidden></div>
    <form class="ev-bar" id="ev-form">
      <button class="ev-ic" id="ev-attach" type="button" aria-label="Add image" title="Add image">${ICON.clip}</button>
      <textarea id="ev-input" rows="1" placeholder="Message Evlyn" aria-label="Message Evlyn"></textarea>
      <button class="ev-ic" id="ev-mic" type="button" aria-label="Record voice message" title="Record voice message">${ICON.mic}</button>
      <button class="ev-send" id="ev-send" type="submit" aria-label="Send message">${ICON.send}</button>
      <input id="ev-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden>
    </form>
    <div class="ev-note" id="ev-note" role="status"></div>
    <div class="ev-drop" aria-hidden="true">Drop the image to add it</div>`;

  const $ = id => document.getElementById(id);
  const thread = $("ev-thread"), input = $("ev-input"), strip = $("ev-strip"), note = $("ev-note");
  let cursor = 0, loaded = false, busy = false, sending = false, name = "Evlyn";
  let files = []; // {file, url}
  let noteTimer = null;

  function say(text, isError) {
    note.textContent = text || "";
    note.classList.toggle("ev-err", !!isError);
    clearTimeout(noteTimer);
    if (text && !isError) noteTimer = setTimeout(() => { note.textContent = ""; }, 5000);
  }
  const time = ts => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const nearBottom = () => thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
  const toBottom = () => { thread.scrollTop = thread.scrollHeight; };

  function actionCard(m) {
    const a = m.action || {};
    const label = { pending: "Waiting for your approval", done: "Done", failed: "Failed", cancelled: "Cancelled" }[a.status] || a.status;
    const buttons = a.status === "pending"
      ? `<div class="ev-act-btns"><button type="button" class="ev-run" data-act="${esc(a.id)}" data-ok="1">Run ${esc(a.action)}</button><button type="button" class="ev-ghost" data-act="${esc(a.id)}">Cancel</button></div>` : "";
    return `<div class="ev-act ev-act-${esc(a.status)}">
      <div class="ev-act-top"><span class="ev-act-verb">${esc(a.action)}</span><code>${esc(a.unit)}</code><span class="ev-act-state">${esc(label)}</span></div>
      ${m.text ? `<div class="ev-act-why">${esc(m.text)}</div>` : ""}
      ${a.detail ? `<div class="ev-act-why">${esc(a.detail)}</div>` : ""}
      ${buttons}</div>`;
  }

  function node(m) {
    const el = document.createElement("div");
    el.dataset.id = m.id;
    if (m.role === "system") { el.className = "ev-row ev-sys"; el.innerHTML = actionCard(m); return el; }
    const mine = m.role === "user";
    el.className = "ev-row " + (mine ? "ev-me" : "ev-her");
    const imgs = (m.images || []).filter(n => /^[a-f0-9]{20}\.jpg$/.test(n))
      .map(n => `<a href="/evlyn/media/${n}" target="_blank" rel="noopener"><img src="/evlyn/media/${n}" alt="Shared image" loading="lazy"></a>`).join("");
    const via = mine ? (m.source === "telegram" ? `<span class="ev-via ev-via-tg">${ICON.tg}Telegram</span>` : `<span class="ev-via">Overview</span>`) : `<span class="ev-via">${esc(name)}</span>`;
    el.innerHTML = `<div class="ev-bubble">${imgs ? `<div class="ev-imgs">${imgs}</div>` : ""}${m.text ? `<div class="ev-text">${rich(m.text)}</div>` : ""}</div>
      <div class="ev-meta">${via}${m.voice ? "<span>Voice</span>" : ""}<span>${time(m.ts)}</span></div>`;
    return el;
  }

  function render(list, total) {
    if (total === 0 && thread.querySelector(".ev-row")) thread.innerHTML = "";
    const stick = !loaded || nearBottom();
    for (const m of list) {
      const old = thread.querySelector(`.ev-row[data-id="${m.id}"]`);
      const el = node(m);
      if (old) old.replaceWith(el); else thread.insertBefore(el, thread.querySelector(".ev-typing"));
    }
    const empty = !thread.querySelector(".ev-row");
    let hint = thread.querySelector(".ev-empty");
    if (empty && !hint) {
      hint = document.createElement("div");
      hint.className = "ev-empty";
      hint.textContent = "Ask a question, record a voice message or drop in a screenshot. What you send here also shows up in Telegram, and the other way around.";
      thread.prepend(hint);
    } else if (!empty && hint) hint.remove();
    let typing = thread.querySelector(".ev-typing");
    if (busy && !typing) {
      typing = document.createElement("div");
      typing.className = "ev-typing";
      typing.innerHTML = "<i></i><i></i><i></i>";
      thread.appendChild(typing);
    } else if (!busy && typing) typing.remove();
    if (stick && (list.length || busy)) toBottom();
  }

  async function poll() {
    try {
      const r = await fetch("/evlyn/messages?after=" + cursor, { credentials: "same-origin" });
      if (r.status === 403 || r.status === 401) { root.closest("section").hidden = true; return; }
      if (!r.ok) throw new Error();
      const d = await r.json();
      name = d.name || "Evlyn";
      $("ev-name").textContent = name;
      input.placeholder = "Message " + name;
      $("ev-sub").textContent = d.telegram ? "Same conversation as Telegram" : "Telegram is not connected";
      $("ev-sub").classList.toggle("ev-off", !d.telegram);
      root.classList.toggle("ev-busy", !!d.busy);
      busy = !!d.busy;
      cursor = Math.max(cursor, d.cursor || 0);
      render(d.messages || [], (d.messages || []).length ? null : d.total);
      loaded = true;
    } catch {
      $("ev-sub").textContent = "Connection lost. Trying again";
      $("ev-sub").classList.add("ev-off");
    }
  }
  function loop() {
    poll().finally(() => setTimeout(loop, document.hidden ? 15000 : busy ? 1500 : 3000));
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });

  // ── Afbeeldingen ──
  const OK_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
  function addFiles(list) {
    for (const f of list) {
      if (!OK_TYPES.includes(f.type)) { say("Only PNG, JPEG, WebP or GIF images can be added.", true); continue; }
      if (f.size > 12 * 1024 * 1024) { say("That image is larger than 12 MB.", true); continue; }
      if (files.length >= 4) { say("You can add up to 4 images per message.", true); break; }
      files.push({ file: f, url: URL.createObjectURL(f) });
    }
    drawStrip();
  }
  function drawStrip() {
    strip.hidden = !files.length;
    strip.innerHTML = files.map((f, i) => `<div class="ev-thumb"><img src="${f.url}" alt="Image to send"><button type="button" data-rm="${i}" aria-label="Remove image">×</button></div>`).join("");
  }
  strip.addEventListener("click", e => {
    const b = e.target.closest("[data-rm]");
    if (!b) return;
    const [gone] = files.splice(Number(b.dataset.rm), 1);
    if (gone) URL.revokeObjectURL(gone.url);
    drawStrip();
  });
  $("ev-attach").addEventListener("click", () => $("ev-file").click());
  $("ev-file").addEventListener("change", e => { addFiles(e.target.files); e.target.value = ""; });
  input.addEventListener("paste", e => {
    const imgs = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith("image/"));
    if (imgs.length) { e.preventDefault(); addFiles(imgs); }
  });
  let dragDepth = 0;
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes("Files");
  root.addEventListener("dragenter", e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; root.classList.add("ev-dragging"); });
  root.addEventListener("dragover", e => { if (hasFiles(e)) e.preventDefault(); });
  root.addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) root.classList.remove("ev-dragging"); });
  root.addEventListener("drop", e => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; root.classList.remove("ev-dragging");
    addFiles(e.dataTransfer.files);
    input.focus();
  });

  // ── Versturen ──
  function grow() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 160) + "px"; }
  input.addEventListener("input", grow);
  input.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("ev-form").requestSubmit(); }
  });
  $("ev-form").addEventListener("submit", async e => {
    e.preventDefault();
    const text = input.value.trim();
    if (sending || (!text && !files.length)) return;
    sending = true; $("ev-send").disabled = true; say("");
    const fd = new FormData();
    fd.append("text", text);
    for (const f of files) fd.append("images", f.file, f.file.name || "image");
    try {
      const r = await fetch("/evlyn/message", { method: "POST", body: fd, credentials: "same-origin" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "The message was not sent. Try again.");
      input.value = ""; grow();
      files.forEach(f => URL.revokeObjectURL(f.url)); files = []; drawStrip();
      busy = true;
      await poll(); toBottom();
    } catch (err) {
      say(err.message, true);
    } finally {
      sending = false; $("ev-send").disabled = false; input.focus();
    }
  });

  // ── Spraak ──
  let rec = null, chunks = [], recTimer = null, recStart = 0;
  const mic = $("ev-mic");
  function micState(on) {
    mic.classList.toggle("ev-rec", on);
    mic.innerHTML = on ? ICON.stop : ICON.mic;
    mic.setAttribute("aria-label", on ? "Stop recording" : "Record voice message");
    mic.title = on ? "Stop recording" : "Record voice message";
  }
  async function startRec() {
    if (!navigator.mediaDevices || !window.MediaRecorder) { say("This browser cannot record audio.", true); return; }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { say("Microphone access was blocked. Allow it in the browser to record.", true); return; }
    chunks = [];
    rec = new MediaRecorder(stream);
    rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      clearInterval(recTimer); micState(false);
      const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
      rec = null;
      if (blob.size < 800) { say("That recording was too short."); return; }
      mic.disabled = true; say("Transcribing your recording");
      try {
        const fd = new FormData();
        fd.append("audio", blob, "voice");
        const r = await fetch("/evlyn/voice", { method: "POST", body: fd, credentials: "same-origin" });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || "The recording could not be transcribed.");
        if (!d.text) { say("No speech was heard in the recording."); return; }
        input.value = (input.value ? input.value.replace(/\s*$/, " ") : "") + d.text;
        grow(); input.focus();
        say("Check the text and press Enter to send.");
      } catch (err) { say(err.message, true); }
      finally { mic.disabled = false; }
    };
    rec.start();
    recStart = Date.now(); micState(true);
    const tick = () => {
      const s = Math.floor((Date.now() - recStart) / 1000);
      say(`Recording ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}. Press the button again to stop.`);
      if (s >= 180 && rec) rec.stop();
    };
    tick(); recTimer = setInterval(tick, 1000);
  }
  mic.addEventListener("click", () => { if (rec) rec.stop(); else startRec(); });

  // ── Acties en wissen ──
  thread.addEventListener("click", async e => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    b.closest(".ev-act-btns").querySelectorAll("button").forEach(x => { x.disabled = true; });
    try {
      const r = await fetch("/evlyn/actions/" + encodeURIComponent(b.dataset.act), {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approve: b.dataset.ok === "1" }),
      });
      if (r.status === 410) say("This request expired or was already handled.", true);
    } catch { say("The action could not be sent. Try again.", true); }
    poll();
  });
  $("ev-clear").addEventListener("click", async () => {
    if (!confirm("Clear the conversation here and in Evlyn's memory? Messages already in Telegram stay there.")) return;
    try {
      const r = await fetch("/evlyn/messages", { method: "DELETE", credentials: "same-origin" });
      if (!r.ok) throw new Error();
      thread.innerHTML = ""; await poll();
    } catch { say("The conversation was not cleared. Try again.", true); }
  });

  loop();
})();
