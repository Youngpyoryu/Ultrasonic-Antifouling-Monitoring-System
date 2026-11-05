/* AI 이상 감지 (Isolation Forest) — 대시보드 연동
 *
 * 학습: sensor_history.csv 전체(30개 수조 × 7일)를 읽은 뒤 브라우저에서 바로 학습 (서버·API 키 불필요)
 * 특징값: 수온·수위·탁도·전력 4개를 "수조마다 자기 평소 값" 기준으로 정규화한 값 (robust z)
 *     z = (값 − 그 수조의 중앙값) ÷ (그 수조의 MAD × 1.4826)
 *   → 수조마다 크기·설정이 달라도 "평소와 얼마나 다른가"를 하나의 모델로 비교
 * 모델: iforest.js (나무 200그루, 나무당 표본 256개, 범위 검사 포함), seed 고정 → 새로고침해도 같은 결과
 * 판정: 점수 ≥ 0.70 이상, ≥ 0.62 관찰 (원본 7일 기록 검증으로 정한 값)
 *   - 원본 기록 검증: 규칙(thresholds.json) 경고 39개 시점 모두 0.70 이상 (최저 약 0.74), 정상 시점의 99.9%는 0.65 미만
 *   - 규칙은 정상인데 0.70 을 넘은 시점은 모두 규칙 경고 직전의 상승 구간 → 조기 감지
 * 실시간: 새 측정값은 같은 모델로 바로 채점(재학습은 '다시 학습' 버튼). 통신 끊김 시점은 판단 불가.
 */
(() => {
  const FEATURES = ["temperature_c", "water_level_pct", "turbidity_ntu", "power_w"];
  const LABEL = { temperature_c: "수온", water_level_pct: "수위", turbidity_ntu: "탁도", power_w: "전력" };
  const UNIT = { temperature_c: "℃", water_level_pct: "%", turbidity_ntu: "NTU", power_w: "W" };
  const DIGITS = { temperature_c: 1, water_level_pct: 1, turbidity_ntu: 2, power_w: 1 };
  // 값이 거의 변하지 않는 항목에서 z 가 터지지 않도록 하는 최소 척도 (센서 표시 단위 수준)
  const MIN_SCALE = { temperature_c: 0.05, water_level_pct: 0.1, turbidity_ntu: 0.02, power_w: 0.5 };
  const LEVEL = { alert: 0.70, watch: 0.62 };
  const OPTIONS = { nTrees: 200, sampleSize: 256, seed: 42 };
  const AI_LABEL = { alert: "이상", watch: "관찰", normal: "정상", na: "판단 불가" };
  const AI_BADGE = { alert: "critical", watch: "warning", normal: "normal", na: "offline" };

  // src = 학습에 쓴 기록 Map (기록을 통째로 다시 읽으면 바뀜 → 자동 재학습), failKey = 기록 부족으로 학습 실패한 상태
  const ai = { model: null, src: null, failKey: null, stats: new Map(), cache: new Map(), info: null, validation: null, validating: false, version: 0 };

  const css = `
    #aiPanel .ai-head { display:flex; flex-wrap:wrap; gap:6px 14px; align-items:center; padding:0 14px 8px; font-size:12px; color:var(--soft); }
    #aiPanel .ai-head b { color:var(--text); }
    #aiPanel .ai-head .bad { color:var(--critical); } #aiPanel .ai-head .warn { color:var(--warning); }
    .ai-note { padding:0 14px 8px; font-size:11px; color:var(--muted); line-height:1.6; }
    .ai-retrain { background:var(--bg-deep); color:var(--soft); border:1px solid var(--line-2); border-radius:6px; padding:3px 9px; font-size:11px; cursor:pointer; }
    .ai-retrain:hover { border-color:var(--blue); color:var(--text); }
    .ai-score { display:inline-flex; align-items:center; gap:6px; justify-content:flex-end; }
    .ai-bar { width:60px; height:6px; border-radius:3px; background:var(--line-2); overflow:hidden; display:inline-block; }
    .ai-bar i { display:block; height:100%; }
    .data-table td.ai-early { color:#a78bfa; font-weight:600; }
    .ai-tag { font-size:10px; padding:1px 6px; border-radius:4px; border:1px solid var(--line-2); color:var(--muted); white-space:nowrap; }
    .ai-tag.early { color:#a78bfa; border-color:rgba(167,139,250,.5); }
    .ai-tag.miss { color:var(--warning); border-color:rgba(245,158,11,.5); }`;
  document.head.insertAdjacentHTML("beforeend", `<style>${css}</style>`);

  // ---------------- 계산 ----------------
  const median = a => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const valid = r => r && FEATURES.every(k => isNum(r[k]));

  function zOf(tid, r) {
    const st = ai.stats.get(tid);
    if (!st || !valid(r)) return null;
    return FEATURES.map((k, j) => (r[k] - st.med[j]) / st.scale[j]);
  }

  function train() {
    const map = state.history;
    if (!map || typeof IForest === "undefined") return false;
    const t0 = performance.now();
    const X = [];
    ai.model = null; ai.src = null;
    ai.stats.clear(); ai.cache.clear();
    ai.version++;                                   // 진행 중인 검증 취소
    let first = null, last = null;
    for (const [tid, rows] of map) {
      const ok = rows.filter(valid);
      if (ok.length < 50) continue;                 // 기록이 너무 적은 수조는 기준을 만들 수 없음
      const med = FEATURES.map(k => median(ok.map(r => r[k])));
      const scale = FEATURES.map((k, j) => Math.max(median(ok.map(r => Math.abs(r[k] - med[j]))) * 1.4826, MIN_SCALE[k]));
      ai.stats.set(tid, { med, scale });
      for (const r of ok) X.push(zOf(tid, r));
      if (!first || ok[0].ts < first) first = ok[0].ts;
      if (!last || ok.at(-1).ts > last) last = ok.at(-1).ts;
    }
    if (X.length < 256) { ai.failKey = sizeKey(map); return false; }
    ai.failKey = null;
    ai.model = IForest.fit(X, OPTIONS);
    ai.src = map;
    ai.info = { rows: X.length, tanks: ai.stats.size, first, last, ms: Math.round(performance.now() - t0), at: new Date() };
    ai.validation = null;
    // 학습 시점의 기록으로 검증 (검증 도중 실시간으로 추가·삭제되는 행의 영향을 받지 않게 복사)
    validateAsync(ai.version, new Map([...ai.stats.keys()].map(tid => [tid, map.get(tid).slice()])));
    return true;
  }
  const sizeKey = map => { let n = 0; for (const r of map.values()) n += r.length; return n + ":" + map.size; };
  function ensureModel() {
    if (!state.history) return false;
    if (ai.model && ai.src === state.history) return true;
    if (!ai.model && ai.failKey === sizeKey(state.history)) return false;   // 기록이 늘지 않았으면 다시 시도하지 않음
    return train();
  }

  // 같은 시점·같은 값이면 다시 채점하지 않음
  function score(tid, r) {
    const z = zOf(tid, r);
    if (!z || !ai.model) return null;
    let c = ai.cache.get(tid);
    if (!c) ai.cache.set(tid, c = new Map());
    const key = r.ts + "|" + FEATURES.map(k => r[k]).join(",");
    let s = c.get(key);
    if (s === undefined) {
      s = ai.model.score(z);
      if (c.size > HISTORY_KEEP * 1.5) c.clear();   // 실시간으로 오래 켜 두어도 메모리가 계속 늘지 않게
      c.set(key, s);
    }
    return s;
  }
  const level = s => s == null ? "na" : s >= LEVEL.alert ? "alert" : s >= LEVEL.watch ? "watch" : "normal";

  // 평소 값에서 가장 많이 벗어난 항목 = 주요 원인
  function explain(tid, r) {
    const z = zOf(tid, r);
    if (!z) return null;
    let j = 0;
    z.forEach((v, i) => { if (Math.abs(v) > Math.abs(z[j])) j = i; });
    const k = FEATURES[j], st = ai.stats.get(tid);
    return { key: k, z: z[j], text: `${LABEL[k]} 평소보다 ${z[j] > 0 ? "높음" : "낮음"}`,
             short: `${LABEL[k]} ${z[j] > 0 ? "↑" : "↓"} ${r[k].toFixed(DIGITS[k])} ${UNIT[k]} · ${Math.abs(z[j]).toFixed(1)}σ`,
             detail: `${r[k].toFixed(DIGITS[k])} ${UNIT[k]} · 평소 ${st.med[j].toFixed(DIGITS[k])} ${UNIT[k]} · ${Math.abs(z[j]).toFixed(1)}σ` };
  }

  function latestRow(t) {
    const rows = state.history?.get(t.tank_id);
    const r = rows?.at(-1);
    if (r && r.ts === t.timestamp) return r;
    return { ts: t.timestamp, ...Object.fromEntries(FEATURES.map(k => [k, t[k]])) };
  }

  // 수조 하나의 현재 AI 판단
  function assess(t) {
    const r = latestRow(t);
    const s = ai.model ? score(t.tank_id, r) : null;
    const rows = state.history?.get(t.tank_id) || [];
    const day = rows.slice(-288);
    let alerts24 = 0;
    for (const x of day) { const v = score(t.tank_id, x); if (v != null && v >= LEVEL.alert) alerts24++; }
    const rule = t.status;
    const aiLv = level(s);
    const ruleBad = rule === "warning" || rule === "critical";
    let compare = "";
    if (aiLv === "na") compare = rule === "offline" ? "수신 없음" : ai.stats.has(t.tank_id) ? "수신 없음" : "학습 기록 없음";
    else if (aiLv === "alert" && !ruleBad) compare = "early";
    else if (aiLv !== "alert" && ruleBad) compare = "miss";
    else compare = "same";
    return { t, score: s, level: aiLv, reason: s != null && aiLv !== "normal" ? explain(t.tank_id, r) : null, alerts24, compare };
  }

  // 원본 기록으로 성능 검증 (화면이 멈추지 않게 수조 하나씩 나눠 계산)
  function validateAsync(ver, snap) {
    ai.validating = true;
    const ids = [...snap.keys()];
    const acc = { rulePts: 0, hitPts: 0, aiOnly: 0, aiOnlyEarly: 0, normalPts: 0, events: 0, detected: 0, early: 0, leadSum: 0, leads: [] };
    let i = 0;
    const step = () => {
      if (ver !== ai.version) return;                 // 그 사이 다시 학습됨
      const tid = ids[i++];
      if (tid) {
        // 수신 없는 행도 그대로 두어(점수 null, 경고 아님) 사건·선행 구간이 그 틈을 넘어 이어지지 않게 함
        const rows = snap.get(tid);
        const sc = rows.map(r => valid(r) ? score(tid, r) : null);
        const bad = rows.map((r, j) => sc[j] != null && (r.status === "warning" || r.status === "critical"));
        for (let j = 0; j < rows.length; j++) {
          if (sc[j] == null) continue;
          const hit = sc[j] >= LEVEL.alert;
          if (bad[j]) { acc.rulePts++; if (hit) acc.hitPts++; }
          else { acc.normalPts++; if (hit) acc.aiOnly++; }
        }
        // 규칙 경고 사건(연속 구간)마다: AI 가 감지했는지, 규칙보다 얼마나 먼저였는지
        for (let j = 0; j < rows.length; j++) {
          if (!bad[j] || (j > 0 && bad[j - 1])) continue;
          let end = j; while (end + 1 < rows.length && bad[end + 1]) end++;
          acc.events++;
          if (sc.slice(j, end + 1).some(v => v >= LEVEL.alert)) acc.detected++;
          let k = j - 1, lead = 0;
          while (k >= 0 && !bad[k] && sc[k] != null && sc[k] >= LEVEL.alert) { lead++; acc.aiOnlyEarly++; k--; }
          if (lead) {
            const min = Math.round((Date.parse(rows[j].ts) - Date.parse(rows[k + 1].ts)) / 60000);   // 실제 시각 차이
            acc.early++; acc.leadSum += min; acc.leads.push({ tid, code: rows[j].status, ts: rows[j].ts, min });
          }
          j = end;
        }
        setTimeout(step, 0);
      } else {
        ai.validation = acc;
        ai.validating = false;
        if (state.view === "global") renderAIPanel();
      }
    };
    setTimeout(step, 0);
  }

  // ---------------- 화면: 중앙 화면 표 ----------------
  function scoreCell(s) {
    if (s == null) return `<td class="na">—</td>`;
    const lv = level(s);
    const color = lv === "alert" ? "var(--critical)" : lv === "watch" ? "var(--warning)" : "var(--normal)";
    return `<td><span class="ai-score"><span class="ai-bar"><i style="width:${Math.round(s * 100)}%;background:${color}"></i></span>${s.toFixed(3)}</span></td>`;
  }
  const aiBadge = lv => `<span class="badge ${AI_BADGE[lv]}">${AI_LABEL[lv]}</span>`;
  const compareTag = c => c === "early" ? `<span class="ai-tag early" title="규칙 기준은 정상이지만 평소 패턴과 다름 — 경고 직전의 변화이거나 회복 중일 수 있음">AI만 감지</span>`
    : c === "miss" ? `<span class="ai-tag miss" title="규칙 기준으로는 경고지만 평소 범위와 크게 다르지 않음">규칙만 경고</span>`
    : c === "same" ? `<span class="ai-tag">일치</span>` : `<span class="ai-tag">${esc(c)}</span>`;

  function renderAIPanel() {
    const wrap = document.getElementById("aiPanel");
    if (!wrap) return;
    if (!state.history) { wrap.innerHTML = `<div class="data-table-title">🤖 AI 이상 감지 <span>${state.historyError ? esc(state.historyError) : "학습용 기록(sensor_history.csv) 불러오는 중…"}</span></div>`; return; }
    if (!ensureModel()) { wrap.innerHTML = `<div class="data-table-title">🤖 AI 이상 감지 <span>학습할 기록이 부족합니다.</span></div>`; return; }
    const list = state.tanks.map(assess).sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    const n = lv => list.filter(x => x.level === lv).length;
    const early = list.filter(x => x.compare === "early").length;
    const miss = list.filter(x => x.compare === "miss").length;
    const v = ai.validation, info = ai.info;
    const valText = v
      ? `원본 기록 검증: 규칙 경고 ${v.rulePts}개 시점 중 <b>${v.hitPts}개 감지 (${v.rulePts ? Math.round(v.hitPts / v.rulePts * 100) : 0}%)</b> · ` +
        `경고 사건 ${v.events}건 중 ${v.early}건을 규칙보다 평균 <b>${v.early ? Math.round(v.leadSum / v.early) : 0}분 먼저</b> 감지 · ` +
        `규칙 정상 ${v.normalPts.toLocaleString()}개 시점 중 AI 이상 ${v.aiOnly}개 (그중 ${v.aiOnlyEarly}개가 경고 직전 구간)`
      : "원본 기록 전체를 채점해 성능을 검증하는 중…";
    wrap.innerHTML = `
      <div class="data-table-title">🤖 AI 이상 감지 · Isolation Forest
        <span>수조마다 평소 값과 비교 · 점수 0~1 (높을수록 평소와 다름) · 이상 ≥ ${LEVEL.alert} · 관찰 ≥ ${LEVEL.watch} · 행 클릭 시 상세</span>
        <button type="button" class="ai-retrain" id="aiRetrain" title="지금까지 쌓인 기록(새 측정값 포함)으로 모델을 다시 만듭니다">다시 학습</button></div>
      <div class="ai-head">
        <span>AI 이상 <b class="${n("alert") ? "bad" : ""}">${n("alert")}</b>대</span>
        <span>관찰 <b class="${n("watch") ? "warn" : ""}">${n("watch")}</b>대</span>
        <span title="규칙 기준은 정상이지만 평소 패턴과 다른 수조">규칙은 정상, AI만 감지 <b style="color:#a78bfa">${early}</b>대</span>
        <span>규칙만 경고 <b>${miss}</b>대</span>
        <span>판단 불가 <b>${n("na")}</b>대</span>
      </div>
      <div class="ai-note">${valText}<br/>
        학습: ${info.tanks}개 수조 ${info.rows.toLocaleString()}개 시점 (${fmtShort(info.first)} ~ ${fmtShort(info.last)}) · 나무 ${OPTIONS.nTrees}그루 · 표본 ${OPTIONS.sampleSize}개 · ${info.ms}ms · ${clock(info.at)} 학습</div>
      <table class="data-table">
        <thead><tr><th class="l">수조</th><th class="l">규칙 판정</th><th>AI 이상 점수</th><th class="l">AI 판정</th><th class="l">주요 원인</th><th>최근 24시간 AI 이상</th><th class="l">비교</th></tr></thead>
        <tbody>${list.map(x => `
          <tr data-id="${esc(x.t.tank_id)}">
            <td class="l">${esc(x.t.tank_name)}</td><td class="l">${badgeHtml(x.t.status)}</td>${scoreCell(x.score)}
            <td class="l">${aiBadge(x.level)}</td>
            <td class="l ${x.compare === "early" ? "ai-early" : ""}" title="${esc(x.reason?.detail ?? "")}">${x.reason ? `${esc(x.reason.text)} <span style="color:var(--muted)">(${esc(x.reason.detail)})</span>` : (x.level === "na" ? "—" : "평소 범위")}</td>
            <td class="${x.alerts24 ? "active-alert" : "zero"}">${x.alerts24}</td>
            <td class="l">${compareTag(x.compare)}</td>
          </tr>`).join("")}
        </tbody>
      </table>`;
    wrap.querySelectorAll("tbody tr").forEach(el => el.onclick = () => selectTank(el.dataset.id));
    document.getElementById("aiRetrain").onclick = () => { ai.model = null; renderAIPanel(); };
  }

  // ---------------- 화면: 상세 (점수 추이 + 이상 시점 표) ----------------
  function renderAIDetail(t, rows) {
    const wrap = document.getElementById("aiDetailTable");
    const note = document.getElementById("aiDetailNote");
    if (!wrap) return;
    charts.aiScore?.destroy(); delete charts.aiScore;
    if (!rows.length || !ensureModel() || !ai.stats.has(t.tank_id)) {
      wrap.innerHTML = `<div class="empty">${t.status === "nodata" ? "신규 등록 장비는 학습 기록이 없어 판단할 수 없습니다." : "AI 점수를 계산할 기록이 없습니다."}</div>`;
      if (note) note.textContent = "";
      return;
    }
    const sc = rows.map(r => score(t.tank_id, r));
    const labels = rows.map(r => fmtShort(r.ts));
    const flat = v => labels.map(() => v);
    charts.aiScore = new Chart(document.getElementById("aiScoreChart"), {
      type: "line",
      data: { labels, datasets: [
        { label: "AI 이상 점수", data: sc.map(v => v == null ? null : +v.toFixed(3)), borderColor: "#a78bfa", backgroundColor: "rgba(167,139,250,.15)",
          borderWidth: 1.5, tension: 0.2, fill: true, spanGaps: false,
          pointRadius: sc.map(v => v != null && v >= LEVEL.alert ? 2.5 : 0),
          pointBackgroundColor: sc.map(v => v != null && v >= LEVEL.alert ? "#ef4444" : "#a78bfa") },
        { label: `이상 ${LEVEL.alert}`, data: flat(LEVEL.alert), borderColor: "rgba(239,68,68,.8)", borderDash: [5, 4], borderWidth: 1, pointRadius: 0, fill: false, _threshold: true },
        { label: `관찰 ${LEVEL.watch}`, data: flat(LEVEL.watch), borderColor: "rgba(245,158,11,.8)", borderDash: [5, 4], borderWidth: 1, pointRadius: 0, fill: false, _threshold: true }
      ] },
      options: baseOptions(`${t.tank_name} AI 이상 점수 (0~1) · 빨간 점 = 이상`, {
        xTicks: { maxTicksLimit: 8, maxRotation: 0 }, y: { min: 0.3, max: 1 },
        tooltip: { callbacks: { label: c => c.raw == null ? " 수신 없음 (판단 불가)" : ` 점수 ${c.raw} · ${AI_LABEL[level(c.raw)]}` } }
      })
    });

    const hits = rows.map((r, i) => ({ r, s: sc[i] })).filter(x => x.s != null && x.s >= LEVEL.watch).reverse();
    const nAlert = hits.filter(x => x.s >= LEVEL.alert).length;
    const early = hits.filter(x => x.s >= LEVEL.alert && x.r.status === "normal").length;
    const okPts = sc.filter(v => v != null).length;
    if (note) note.textContent = `${labels[0]} ~ ${labels.at(-1)} · 채점 ${okPts}개 시점 · 이상 ${nAlert}개 · 관찰 ${hits.length - nAlert}개` +
      (early ? ` · 그중 규칙은 정상인데 AI가 이상으로 본 시점 ${early}개` : "") + (okPts < rows.length ? ` · 수신 없음 ${rows.length - okPts}개 (판단 불가)` : "");
    if (!hits.length) { wrap.innerHTML = `<div class="empty">이 기간에는 AI가 평소와 다르다고 본 시점이 없습니다.</div>`; return; }
    const shown = hits.slice(0, 200);
    wrap.innerHTML = `
      <div class="data-table-title">${esc(t.tank_name)} AI 이상·관찰 시점 <span>최신순 · 빨간 막대 = 이상, 주황 = 관찰 · 보라 글씨 = 규칙은 정상${hits.length > shown.length ? ` · 최근 ${shown.length}개만 표시` : ""}</span></div>
      <table class="data-table">
        <thead><tr><th class="l">측정 시각</th><th>AI 점수</th><th class="l">규칙</th><th class="l">주요 원인</th></tr></thead>
        <tbody>${shown.map(({ r, s }) => { const e = explain(t.tank_id, r); return `
          <tr><td class="l">${fmtShort(r.ts)}</td>${scoreCell(s)}<td class="l">${badgeHtml(r.status)}</td>
            <td class="l ${s >= LEVEL.alert && r.status === "normal" ? "ai-early" : ""}" title="${esc(e.text + " · " + e.detail)}">${esc(e.short)}</td></tr>`; }).join("")}
        </tbody>
      </table>`;
  }

  window.renderAIPanel = renderAIPanel;
  window.renderAIDetail = renderAIDetail;
  // 챗봇 등에서 쓰는 조회 API
  window.anomalyAI = {
    LEVEL, AI_LABEL,
    ready: () => !!state.history && !!ensureModel(),
    assess: t => assess(t),
    all: () => state.tanks.map(assess),
    score: (tid, r) => score(tid, r),          // 한 시점 점수 (수신 없음·학습 기록 없음 → null)
    level,
    explain: (tid, r) => explain(tid, r),
    baseline: tid => { const st = ai.stats.get(tid); return st && Object.fromEntries(FEATURES.map((k, j) => [k, { med: st.med[j], scale: st.scale[j] }])); },
    info: () => ai.info,
    validation: () => ai.validation,
    retrain: () => { ai.model = null; return ensureModel(); }
  };
})();
