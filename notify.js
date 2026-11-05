/* 새 경고 알림
 * 데이터를 새로 읽을 때마다(dataListeners) 진행 중 경고 목록을 이전과 비교해
 *   - 새로 생긴 경고 → 화면 알림(토스트), 브라우저 알림, 소리
 *   - 해제된 경고   → 화면 알림만
 * 페이지를 처음 열 때 이미 있던 경고는 알리지 않습니다(기준선).
 * 설정(화면/브라우저/소리)은 이 브라우저의 localStorage 에만 저장됩니다.
 */
(() => {
  const css = `
  .nt-bell { position: relative; height: 28px; padding: 0 10px; border-radius: 999px; border: 1px solid var(--line-2);
    background: var(--bg-deep); color: var(--soft); font-size: 12px; cursor: pointer; }
  .nt-bell:hover { border-color: var(--blue); color: var(--text); }
  .nt-bell.off { opacity: .55; }
  .nt-count { position: absolute; top: -5px; right: -5px; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 999px;
    background: var(--critical); color: #fff; font-size: 10px; font-weight: 700; line-height: 16px; text-align: center; display: none; }
  .nt-count.show { display: block; }
  .nt-pop { position: fixed; z-index: 45; width: min(340px, calc(100vw - 32px)); max-height: 70vh; overflow-y: auto;
    background: var(--panel); border: 1px solid var(--line-2); border-radius: 12px; box-shadow: 0 12px 36px rgba(0,0,0,.5);
    padding: 12px; font-size: 12px; color: var(--text); display: none; }
  .nt-pop.open { display: block; }
  .nt-pop h5 { margin: 0 0 8px; font-size: 13px; }
  .nt-pop label { display: flex; align-items: center; gap: 8px; padding: 4px 0; cursor: pointer; }
  .nt-pop .hint { font-size: 11px; color: var(--muted); margin: 2px 0 6px 24px; }
  .nt-pop .row { display: flex; justify-content: space-between; gap: 8px; align-items: center; }
  .nt-pop .link { background: none; border: none; color: #93c5fd; font-size: 11px; cursor: pointer; padding: 0; }
  .nt-log { margin-top: 10px; border-top: 1px solid var(--line); padding-top: 8px; }
  .nt-log-item { padding: 6px 0; border-bottom: 1px solid var(--line); cursor: pointer; }
  .nt-log-item:last-child { border-bottom: none; }
  .nt-log-item .t { font-size: 10px; color: var(--muted); }
  .nt-toasts { position: fixed; top: 76px; right: 16px; z-index: 60; display: flex; flex-direction: column; gap: 8px;
    width: min(330px, calc(100vw - 32px)); pointer-events: none; }
  .nt-toast { pointer-events: auto; background: var(--panel); border: 1px solid var(--line-2); border-left: 4px solid var(--warning);
    border-radius: 10px; padding: 10px 12px; box-shadow: 0 10px 30px rgba(0,0,0,.45); font-size: 12px; cursor: pointer;
    animation: ntIn .2s ease-out; }
  .nt-toast.critical { border-left-color: var(--critical); }
  .nt-toast.offline { border-left-color: var(--offline); }
  .nt-toast.resolved { border-left-color: var(--normal); }
  .nt-toast .head { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 3px; }
  .nt-toast .head b { font-size: 13px; }
  .nt-toast .x { background: none; border: none; color: var(--muted); font-size: 16px; cursor: pointer; line-height: 1; }
  .nt-toast .sub { color: var(--muted); font-size: 11px; margin-top: 2px; }
  @keyframes ntIn { from { transform: translateX(20px); opacity: 0; } to { transform: none; opacity: 1; } }`;
  document.head.insertAdjacentHTML("beforeend", `<style>${css}</style>`);

  // ---------- 설정 ----------
  const KEY = "antifouling.notify";
  const settings = { toast: true, browser: false, sound: false };
  try { Object.assign(settings, JSON.parse(localStorage.getItem(KEY) || "{}")); } catch (e) { /* 저장소 사용 불가 */ }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch (e) { /* 무시 */ } };
  const canBrowser = "Notification" in window;
  if (settings.browser && (!canBrowser || Notification.permission !== "granted")) settings.browser = false;

  // ---------- 화면 요소 ----------
  const live = document.getElementById("liveStatus");
  live.insertAdjacentHTML("afterend",
    `<button type="button" class="nt-bell" id="ntBell" title="새 경고 알림 설정과 기록">🔔 알림<span class="nt-count" id="ntCount"></span></button>`);
  document.body.insertAdjacentHTML("beforeend", `
    <div class="nt-pop" id="ntPop" role="dialog" aria-label="경고 알림 설정">
      <h5>새 경고 알림</h5>
      <label><input type="checkbox" id="ntToast"> 화면 알림 (오른쪽 위 카드)</label>
      <label><input type="checkbox" id="ntBrowser"> 브라우저 알림</label>
      <div class="hint" id="ntBrowserHint">다른 탭·창을 보고 있어도 윈도우 알림으로 표시</div>
      <label><input type="checkbox" id="ntSound"> 소리 (위험은 두 번)</label>
      <div class="row" style="margin-top:6px"><span class="hint" style="margin:0">새로 생긴 경고만 알립니다. 해제는 화면 알림만.</span>
        <button type="button" class="link" id="ntTest">테스트</button></div>
      <div class="nt-log"><div class="row"><b>알림 기록</b><button type="button" class="link" id="ntClear">지우기</button></div>
        <div id="ntLog"><div class="hint" style="margin:6px 0 0">아직 알림이 없습니다.</div></div></div>
    </div>
    <div class="nt-toasts" id="ntToasts" aria-live="polite"></div>`);
  const $ = id => document.getElementById(id);
  const bell = $("ntBell"), pop = $("ntPop");

  function syncUi() {
    $("ntToast").checked = settings.toast;
    $("ntBrowser").checked = settings.browser;
    $("ntSound").checked = settings.sound;
    const anyOn = settings.toast || settings.browser || settings.sound;
    bell.classList.toggle("off", !anyOn);
    bell.firstChild.textContent = anyOn ? "🔔 알림" : "🔕 알림 꺼짐";
    let hint = "다른 탭·창을 보고 있어도 윈도우 알림으로 표시";
    if (!canBrowser) hint = "이 브라우저는 알림을 지원하지 않습니다.";
    else if (!window.isSecureContext) hint = "http://localhost 로 열어야 사용할 수 있습니다.";
    else if (Notification.permission === "denied") hint = "브라우저에서 알림이 차단되어 있습니다. 주소창 왼쪽 사이트 설정에서 허용하세요.";
    $("ntBrowserHint").textContent = hint;
  }
  syncUi();

  function placePop() {
    const r = bell.getBoundingClientRect();
    pop.style.top = (r.bottom + 8) + "px";
    pop.style.left = Math.max(16, Math.min(r.left, window.innerWidth - pop.offsetWidth - 16)) + "px";
  }
  bell.onclick = e => {
    e.stopPropagation();
    pop.classList.toggle("open");
    if (pop.classList.contains("open")) { placePop(); unread = 0; updateCount(); }
  };
  document.addEventListener("click", e => { if (!pop.contains(e.target) && e.target !== bell) pop.classList.remove("open"); });
  window.addEventListener("resize", () => pop.classList.contains("open") && placePop());

  $("ntToast").onchange = e => { settings.toast = e.target.checked; save(); syncUi(); };
  $("ntSound").onchange = e => { settings.sound = e.target.checked; if (settings.sound) { ensureAudio(); beep(1); } save(); syncUi(); };
  $("ntBrowser").onchange = async e => {
    if (!e.target.checked) { settings.browser = false; save(); syncUi(); return; }
    if (!canBrowser || !window.isSecureContext) { e.target.checked = false; syncUi(); return; }
    const p = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
    settings.browser = p === "granted";
    save(); syncUi();
  };
  $("ntTest").onclick = () => {
    const t = state.tanks.find(x => x.status !== "nodata") || state.tanks[0];
    if (!t) return;
    announce({ kind: "new", severity: "critical", tank: t, code: "device_stopped", at: state.snapshot, test: true });
  };
  $("ntClear").onclick = () => { history.length = 0; renderLog(); };

  // ---------- 소리 ----------
  let audio = null;
  function ensureAudio() {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === "suspended") audio.resume();
    } catch (e) { audio = null; }
  }
  function beep(times) {
    if (!audio) return;
    for (let i = 0; i < times; i++) {
      const t0 = audio.currentTime + i * 0.28;
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = "sine"; o.frequency.value = times > 1 ? 988 : 784;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
      o.connect(g).connect(audio.destination);
      o.start(t0); o.stop(t0 + 0.24);
    }
  }
  // 브라우저는 사용자가 한 번 클릭한 뒤에만 소리를 허용 → 첫 클릭 때 준비
  document.addEventListener("pointerdown", () => settings.sound && ensureAudio(), { once: true });

  // ---------- 알림 기록 · 카운트 ----------
  const history = [];
  let unread = 0;
  function updateCount() {
    const el = $("ntCount");
    el.textContent = unread > 99 ? "99+" : unread;
    el.classList.toggle("show", unread > 0);
  }
  const label = code => ALERT_LABEL[code] ?? code;
  const sevText = { warning: "주의", critical: "위험", offline: "통신 끊김" };
  function renderLog() {
    $("ntLog").innerHTML = history.length
      ? history.map(h => `<div class="nt-log-item" data-id="${esc(h.tank.tank_id)}">
          ${h.kind === "new" ? badgeHtml(h.severity) : `<span class="badge normal">해제</span>`}
          <b>${esc(h.tank.tank_name)}</b> · ${esc(label(h.code))}${h.test ? " (테스트)" : ""}
          <div class="t">데이터 ${esc(fmtShort(h.at))} · 알림 ${esc(new Date(h.shownAt).toLocaleTimeString("ko-KR", { hour12: false }))}</div></div>`).join("")
      : `<div class="hint" style="margin:6px 0 0">아직 알림이 없습니다.</div>`;
  }
  $("ntLog").addEventListener("click", e => {
    const it = e.target.closest(".nt-log-item");
    if (it) { pop.classList.remove("open"); selectTank(it.dataset.id); }
  });

  // ---------- 알림 표시 ----------
  function toast(ev) {
    const box = $("ntToasts");
    const el = document.createElement("div");
    el.className = "nt-toast " + (ev.kind === "resolved" ? "resolved" : ev.severity);
    el.dataset.id = ev.tank.tank_id;
    el.innerHTML = `<div class="head"><b>${ev.kind === "new" ? (ev.severity === "critical" ? "🚨 " : "⚠️ ") : "✅ "}${esc(ev.tank.tank_name)}</b>
        <button type="button" class="x" aria-label="닫기">×</button></div>
      <div>${ev.kind === "new" ? `${badgeHtml(ev.severity)} ${esc(label(ev.code))}` : `${esc(label(ev.code))} 해제`}${ev.test ? " (테스트)" : ""}</div>
      <div class="sub">${esc(ev.tank.location || "")} · 데이터 ${esc(fmtShort(ev.at))} · 눌러서 상세 보기</div>`;
    el.onclick = e => {
      if (e.target.closest(".x")) { el.remove(); return; }
      el.remove(); selectTank(ev.tank.tank_id);
    };
    box.prepend(el);
    while (box.children.length > 5) box.lastElementChild.remove();
    const ms = ev.kind === "resolved" ? 6000 : ev.severity === "critical" ? 20000 : 10000;
    setTimeout(() => el.remove(), ms);
  }
  function browserNotify(ev) {
    try {
      const n = new Notification(`${ev.severity === "critical" ? "🚨 위험" : "⚠️ " + (sevText[ev.severity] || "경고")} · ${ev.tank.tank_name}`, {
        body: `${label(ev.code)}${ev.test ? " (테스트)" : ""}\n${ev.tank.location || ""} · 데이터 ${fmtShort(ev.at)}`,
        tag: `${ev.tank.tank_id}:${ev.code}`
      });
      n.onclick = () => { window.focus(); selectTank(ev.tank.tank_id); n.close(); };
    } catch (e) { /* 일부 환경은 new Notification 불가 */ }
  }
  function announce(ev) {
    ev.shownAt = Date.now();
    history.unshift(ev);
    if (history.length > 50) history.length = 50;
    if (!pop.classList.contains("open")) unread++;
    updateCount(); renderLog();
    if (settings.toast) toast(ev);
    if (ev.kind !== "new") return;
    if (settings.browser && canBrowser && Notification.permission === "granted") browserNotify(ev);
    if (settings.sound) { ensureAudio(); beep(ev.severity === "critical" ? 2 : 1); }
  }

  // ---------- 변화 감지 ----------
  let prev = null;   // Map<event_id, alert>
  dataListeners.push(() => {
    const now = new Map(state.alerts.map(a => [a.event_id, a]));
    if (prev) {
      const byId = Object.fromEntries(state.tanks.map(t => [t.tank_id, t]));
      const tankOf = a => byId[a.tank_id] || { tank_id: a.tank_id, tank_name: a.tank_id, location: "" };
      const added = [...now.values()].filter(a => !prev.has(a.event_id))
        .sort((a, b) => (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1));
      const resolved = [...prev.values()].filter(a => !now.has(a.event_id));
      // 한 번에 너무 많으면(시뮬레이터 재시작 등) 요약 하나로
      if (added.length > 6) {
        announce({ kind: "new", severity: added.some(a => a.severity === "critical") ? "critical" : "warning",
          tank: { tank_id: added[0].tank_id, tank_name: `새 경고 ${added.length}건`, location: "알림 기록에서 확인" },
          code: added.slice(0, 3).map(a => `${tankOf(a).tank_name} ${label(a.alert_code)}`).join(", ") + " 외", at: state.snapshot });
      } else {
        for (const a of added) announce({ kind: "new", severity: a.severity, tank: tankOf(a), code: a.alert_code, at: a.started_at });
      }
      for (const a of resolved.slice(0, 6)) announce({ kind: "resolved", severity: "normal", tank: tankOf(a), code: a.alert_code, at: state.snapshot });
    }
    prev = now;
  });
})();
