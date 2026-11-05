/* AI 장비 관리 리포트
 *
 * 상단 '📋 AI 리포트' 버튼(전체) 또는 수족관 상세의 '📋 이 장비 리포트' 버튼으로 새 창에 리포트를 만듭니다.
 * 인쇄(PDF 저장)와 HTML 파일 저장을 지원합니다. 서버·API 키 없이 화면에 읽어 둔 데이터로만 계산합니다.
 *
 * 들어가는 내용
 *   - 핵심 요약: 관리 등급 분포, 현재 이상, AI 이상, 기간 내 경고, 전력량, 수신률, 자동 요약 문장
 *   - 우선 조치 목록: 관리 점수가 낮은 순, 문제와 권고 조치, 긴급도
 *   - 수조별 관리 현황 표, 일별 전력량, 수조별 상세 카드(측정값 통계·AI 점수 추이·경고 이력·권고)
 *   - AI 모델 정보와 검증 결과, 관리 점수 계산 방법
 *
 * 관리 점수(0~100)와 권고 문구는 정해진 규칙으로 만듭니다(생성형 AI 아님). 아래 HEALTH, ADVICE 참고.
 */
(() => {
  const KEYS = ["temperature_c", "water_level_pct", "turbidity_ntu", "power_w"];
  const LABEL = { temperature_c: "수온", water_level_pct: "수위", turbidity_ntu: "탁도", power_w: "전력" };
  const UNIT = { temperature_c: "℃", water_level_pct: "%", turbidity_ntu: "NTU", power_w: "W" };
  const DIGITS = { temperature_c: 1, water_level_pct: 1, turbidity_ntu: 2, power_w: 1 };

  // 관리 점수 감점 규칙 (100점에서 뺌)
  const HEALTH = {
    status: { critical: 40, offline: 25, warning: 20 },     // 현재 규칙 판정
    aiNow: { alert: 15, watch: 5 },                         // 현재 AI 판정
    aiPointsPer: 0.5, aiPointsMax: 15,                      // 기간 내 AI 이상 시점 1개당, 최대
    alertEach: 3, alertMax: 15,                             // 기간 내 경고 1건당, 최대
    receiveMax: 15,                                         // 수신 못 한 비율 1%당 1점, 최대
    drift: 5,                                               // 추세 변화 항목 1개당
    overRated: 10                                           // 평균 전력이 정격의 95% 이상
  };
  // 등급 = 장비 건강 상태 (언제 조치할지는 별도의 '조치' 열: 즉시·금일·이번 주·정기)
  const GRADE = [[90, "A", "양호"], [75, "B", "보통"], [60, "C", "점검 필요"], [0, "D", "집중 관리"]];
  const gradeOf = s => GRADE.find(([min]) => s >= min);
  const DRIFT_SIGMA = 3;     // 첫날 평균 대비 마지막 24시간 평균이 평소 변동폭의 3배 이상 변하면 추세 변화

  const ADVICE = {
    temperature_out_of_range: "히터·냉각기 설정과 동작을 확인하고, 수온 센서 교정 상태를 점검하세요.",
    low_water_level: "급수 밸브·자동 보충 장치와 누수 여부를 점검하고, 수위 센서 위치를 확인하세요.",
    high_turbidity: "여과기·순환 펌프를 점검·청소하고, 방오 장비 출력·작동 주기 상향과 사료 투입량을 검토하세요.",
    device_stopped: "전원·차단기를 확인한 뒤 장비를 재가동하고, 진동자(트랜스듀서) 연결 상태를 점검하세요.",
    communication_lost: "통신 모듈 전원과 네트워크 연결을 확인하고, 현장에서 장비 상태를 육안 점검하세요.",
    power_out_of_range: "구동부·진동자 부하와 설정 주파수를 점검하세요.",
  };
  const AI_ADVICE = {
    temperature_c: "수온", water_level_pct: "수위", turbidity_ntu: "탁도", power_w: "전력"
  };

  const css = `
    .btn-report { background:var(--bg-deep); color:var(--soft); border:1px solid var(--line-2); border-radius:999px; padding:5px 11px; font-size:12px; cursor:pointer; white-space:nowrap; }
    .btn-report:hover { border-color:var(--blue); color:var(--text); }`;
  document.head.insertAdjacentHTML("beforeend", `<style>${css}</style>`);
  document.getElementById("headerSummary").insertAdjacentHTML("beforebegin",
    `<button type="button" class="btn-report" id="btnReport" title="전체 장비의 상태·AI 이상 감지·경고·전력량을 정리한 관리 리포트를 새 창으로 엽니다 (인쇄·PDF 저장 가능)">📋 AI 리포트</button>`);
  document.getElementById("btnReport").onclick = () => openReport();

  // ---------------- 계산 ----------------
  const num = (v, d) => isNum(v) ? v.toFixed(d) : "—";
  const pct = v => isNum(v) ? (v * 100).toFixed(1) + "%" : "—";
  const minutes = ms => Math.max(0, Math.round(ms / 60000));
  const durText = min => min >= 1440 ? `${Math.floor(min / 1440)}일 ${Math.floor(min % 1440 / 60)}시간` : min >= 60 ? `${Math.floor(min / 60)}시간 ${min % 60}분` : `${min}분`;

  function analyzeTank(t, range) {
    const A = window.anomalyAI;
    const rows = state.history?.get(t.tank_id) || [];
    const ok = rows.filter(r => KEYS.every(k => isNum(r[k])));
    const stats = Object.fromEntries(KEYS.map(k => {
      const v = ok.map(r => r[k]);
      return [k, v.length ? { min: Math.min(...v), max: Math.max(...v), avg: v.reduce((a, b) => a + b, 0) / v.length } : null];
    }));
    const receive = rows.length ? ok.length / rows.length : null;
    const kwh = rows.length ? energyKwh(rows) : null;
    const rated = Number(t.rated_power_w) || null;
    const ratio = rated && stats.power_w ? stats.power_w.avg / rated : null;

    // AI: 기간 내 점수, 이상 구간(연속된 이상 시점)
    const aiReady = A?.ready();
    const scores = aiReady ? rows.map(r => A.score(t.tank_id, r)) : [];
    let aiAlertPts = 0, aiWatchPts = 0, maxScore = null, maxAt = null;
    const aiEvents = [];
    let cur = null;
    scores.forEach((s, i) => {
      if (s == null) { cur = null; return; }
      if (maxScore == null || s > maxScore) { maxScore = s; maxAt = i; }
      if (s >= A.LEVEL.alert) {
        aiAlertPts++;
        if (!cur) aiEvents.push(cur = { start: rows[i].ts, end: rows[i].ts, peak: s, peakRow: rows[i] });
        cur.end = rows[i].ts;
        if (s > cur.peak) { cur.peak = s; cur.peakRow = rows[i]; }
      } else {
        if (s >= A.LEVEL.watch) aiWatchPts++;
        cur = null;
      }
    });
    aiEvents.forEach(e => {
      e.min = minutes(Date.parse(e.end) - Date.parse(e.start)) + 5;
      e.cause = A.explain(t.tank_id, e.peakRow);
      e.ruleStatus = e.peakRow.status;
    });
    const now = aiReady ? A.assess(t) : null;

    // 추세 변화: 첫 24시간 평균 → 마지막 24시간 평균 (평소 변동폭 σ 단위)
    const base = aiReady ? A.baseline(t.tank_id) : null;
    const drifts = [];
    if (base && ok.length >= 288 * 2) {
      const avgOf = (arr, k) => { const v = arr.map(r => r[k]).filter(isNum); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
      const first = rows.slice(0, 288), last = rows.slice(-288);
      for (const k of KEYS) {
        const a = avgOf(first, k), b = avgOf(last, k);
        if (a == null || b == null) continue;
        const sig = (b - a) / base[k].scale;
        if (Math.abs(sig) >= DRIFT_SIGMA) drifts.push({ key: k, from: a, to: b, sig });
      }
    }

    // 규칙 경고 (alerts) — 리포트 기간과 겹치는 것
    const nowMs = Date.parse(state.snapshot);
    const alerts = (state.alertLog || state.alerts || []).filter(a => a.tank_id === t.tank_id &&
      (!range.first || (a.is_active || a.ended_at >= range.first))).map(a => ({
        ...a, min: minutes((a.is_active ? nowMs : Date.parse(a.ended_at)) - Date.parse(a.started_at))
      })).sort((a, b) => a.started_at < b.started_at ? 1 : -1);
    const active = alerts.filter(a => a.is_active);
    const offlineEvents = alerts.filter(a => a.alert_code === "communication_lost").length;

    // 관리 점수
    const deductions = [];
    const ded = (pts, why) => { pts = Math.round(pts * 10) / 10; if (pts > 0) deductions.push({ pts, why }); };
    if (t.status === "nodata") return { t, nodata: true, rows, deductions, score: null, grade: null, advice: ["측정 기록이 아직 없습니다. 장비 설치·통신 연결 후 다시 확인하세요."], alerts: [], aiEvents: [], drifts: [] };
    ded(HEALTH.status[t.status] || 0, `현재 ${STATUS_LABEL[t.status] ?? t.status}`);
    if (now) ded(HEALTH.aiNow[now.level] || 0, `현재 AI ${A.AI_LABEL[now.level]} (점수 ${num(now.score, 3)})`);
    ded(Math.min(HEALTH.aiPointsMax, aiAlertPts * HEALTH.aiPointsPer), `기간 내 AI 이상 ${aiAlertPts}개 시점`);
    ded(Math.min(HEALTH.alertMax, alerts.length * HEALTH.alertEach), `기간 내 경고 ${alerts.length}건`);
    if (receive != null) ded(Math.min(HEALTH.receiveMax, (1 - receive) * 100), `수신률 ${pct(receive)}`);
    drifts.forEach(d => ded(HEALTH.drift, `${LABEL[d.key]} 추세 변화 (${d.sig > 0 ? "+" : ""}${d.sig.toFixed(1)}σ)`));
    if (ratio != null && ratio >= 0.95) ded(HEALTH.overRated, `평균 전력이 정격의 ${(ratio * 100).toFixed(0)}%`);
    const score = Math.max(0, Math.round(100 - deductions.reduce((a, d) => a + d.pts, 0)));
    const [, grade, gradeText] = gradeOf(score);

    // 권고
    const advice = [];
    const issues = [];
    for (const a of active) { issues.push(`${ALERT_LABEL[a.alert_code] ?? a.alert_code} 진행 중 (${durText(a.min)})`); if (ADVICE[a.alert_code]) advice.push(ADVICE[a.alert_code]); }
    if (now?.compare === "early" && now.reason) {
      issues.push(`규칙은 정상이나 AI ${A.AI_LABEL[now.level]}: ${now.reason.text}`);
      advice.push(`${AI_ADVICE[now.reason.key]}이(가) 평소와 다릅니다(${now.reason.detail}). 규칙 기준 이내라도 다음 점검 때 우선 확인하고 추세를 지켜보세요.`);
    } else if (now?.level === "watch" && now.reason) {
      issues.push(`AI 관찰: ${now.reason.text}`);
    }
    for (const d of drifts) {
      const dir = d.sig > 0 ? "상승" : "하락";
      issues.push(`${LABEL[d.key]} ${dir} 추세 (${num(d.from, DIGITS[d.key])} → ${num(d.to, DIGITS[d.key])} ${UNIT[d.key]})`);
      if (!active.length) advice.push(`${LABEL[d.key]}이(가) 기간 초보다 ${dir}했습니다. 원인(계절·운영 변경·설비 상태)을 확인하세요.`);
    }
    if (receive != null && receive < 0.99) { issues.push(`수신률 ${pct(receive)} (통신 끊김 ${offlineEvents}회)`); if (!active.some(a => a.alert_code === "communication_lost")) advice.push("통신이 간헐적으로 끊깁니다. 통신 모듈·안테나·네트워크 안정성을 점검하세요."); }
    if (ratio != null && ratio >= 0.95) { issues.push(`평균 전력 정격의 ${(ratio * 100).toFixed(0)}%`); advice.push("평균 전력이 정격에 가깝습니다. 과부하·진동자 상태를 점검하세요."); }
    if (!advice.length) advice.push(alerts.length || aiAlertPts ? "현재는 안정적입니다. 기간 중 있었던 경고·AI 이상 구간을 기록으로 남기고 정기 점검 주기를 유지하세요." : "특이 사항 없음. 정기 점검 주기를 유지하세요.");
    const urgency = active.some(a => a.severity === "critical") || t.status === "critical" || t.status === "offline" ? "즉시"
      : active.length || now?.level === "alert" ? "금일" : grade === "C" || grade === "D" || now?.level === "watch" || drifts.length ? "이번 주" : "정기";

    return { t, rows, ok, stats, receive, kwh, rated, ratio, scores, aiAlertPts, aiWatchPts, maxScore, maxRow: maxAt != null ? rows[maxAt] : null,
      aiEvents, now, drifts, alerts, active, deductions, score, grade, gradeText, advice: [...new Set(advice)], issues, urgency };
  }

  // ---------------- HTML ----------------
  function spark(values, color, lines = []) {
    const w = 640, h = 90, v = values.map(x => x == null ? null : x);
    const ok = v.filter(x => x != null);
    if (!ok.length) return "";
    const lo = Math.min(...ok, ...lines.map(l => l.v)), hi = Math.max(...ok, ...lines.map(l => l.v));
    const y = x => h - 4 - (x - lo) / ((hi - lo) || 1) * (h - 8);
    const x = i => i / Math.max(1, v.length - 1) * w;
    let d = "", pen = false;
    v.forEach((p, i) => { if (p == null) { pen = false; return; } d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(p).toFixed(1)}`; pen = true; });
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" class="spark">${lines.map(l =>
      `<line x1="0" x2="${w}" y1="${y(l.v).toFixed(1)}" y2="${y(l.v).toFixed(1)}" stroke="${l.c}" stroke-dasharray="5 4" stroke-width="1"/>`).join("")}
      <path d="${d}" fill="none" stroke="${color}" stroke-width="1.4" vector-effect="non-scaling-stroke"/></svg>`;
  }
  function bars(items, unit) {
    const max = Math.max(...items.map(i => i.v), 0) || 1;
    return `<div class="bars">${items.map(i => `<div class="bar-row"><span class="bar-l">${esc(i.label)}</span>
      <span class="bar-t"><i style="width:${(i.v / max * 100).toFixed(1)}%;${i.partial ? "opacity:.45" : ""}"></i></span><span class="bar-v">${i.v.toFixed(2)} ${unit}</span></div>`).join("")}</div>`;
  }
  const URG_CLASS = { "즉시": "now", "금일": "today", "이번 주": "week", "정기": "routine" };
  const urgTag = u => `<span class="urg urg-${URG_CLASS[u]}">${esc(u)}</span>`;
  const gradeBadge = g => g ? `<span class="g g-${g}">${g}</span>` : `<span class="g">—</span>`;
  const statusTag = s => `<span class="st st-${esc(s)}">${esc(STATUS_LABEL[s] ?? s)}</span>`;
  const aiTag = (lv, s) => lv ? `<span class="st ai-${lv}">${esc(window.anomalyAI.AI_LABEL[lv])}${s != null ? " " + s.toFixed(3) : ""}</span>` : "—";

  function tankCard(x) {
    const t = x.t;
    if (x.nodata) return `<section class="card"><h3>${esc(t.tank_name)} <small>${esc(t.tank_id)} · ${esc(t.location)}</small></h3><p class="muted">측정 기록 없음 (화면에서 신규 등록한 장비)</p></section>`;
    const A = window.anomalyAI;
    const statRows = KEYS.map(k => x.stats[k] ? `<tr><td class="l">${LABEL[k]} (${UNIT[k]})</td><td>${num(x.stats[k].min, DIGITS[k])}</td><td>${num(x.stats[k].avg, DIGITS[k])}</td><td>${num(x.stats[k].max, DIGITS[k])}</td>
      <td>${num(t[k], DIGITS[k])}</td></tr>` : "").join("");
    return `<section class="card">
      <h3>${gradeBadge(x.grade)} ${esc(t.tank_name)} <small>${esc(t.tank_id)} · ${esc(t.device_id)} · ${esc(t.location)}</small>
        <span class="right">관리 점수 <b>${x.score}</b> · ${esc(x.gradeText)} · 조치 ${esc(x.urgency)}</span></h3>
      <div class="cols">
        <div>
          <table><thead><tr><th class="l">항목</th><th>최저</th><th>평균</th><th>최고</th><th>현재</th></tr></thead><tbody>${statRows}</tbody></table>
          <p class="meta">현재 ${statusTag(t.status)} · AI ${x.now ? aiTag(x.now.level, x.now.score) : "—"} · 수신률 ${pct(x.receive)} · 기간 전력량 ${num(x.kwh, 2)} kWh
            ${x.rated ? `· 평균 전력 ${num(x.stats.power_w?.avg, 1)} W / 정격 ${x.rated} W (${pct(x.ratio)})` : ""}</p>
        </div>
        <div>
          <div class="sp-title">AI 이상 점수 추이 <span class="muted">— 빨강 점선 ${A.LEVEL.alert} 이상 · 주황 ${A.LEVEL.watch} 관찰 · 최고 ${num(x.maxScore, 3)}${x.maxRow ? ` (${esc(fmtShort(x.maxRow.ts))})` : ""}</span></div>
          ${spark(x.scores, "#7c3aed", [{ v: A.LEVEL.alert, c: "#ef4444" }, { v: A.LEVEL.watch, c: "#f59e0b" }])}
          <div class="sp-title">탁도 (NTU)</div>${spark(x.rows.map(r => r.turbidity_ntu), "#d97706")}
        </div>
      </div>
      <div class="cols">
        <div><h4>진단</h4>${x.issues.length ? `<ul>${x.issues.map(i => `<li>${esc(i)}</li>`).join("")}</ul>` : `<p class="muted">특이 사항 없음</p>`}
          <h4>권고 조치</h4><ol>${x.advice.map(a => `<li>${esc(a)}</li>`).join("")}</ol>
          ${x.deductions.length ? `<p class="muted small">감점: ${x.deductions.map(d => `${esc(d.why)} −${d.pts}`).join(" · ")}</p>` : ""}</div>
        <div><h4>AI 이상 구간 (${x.aiEvents.length}건)</h4>${x.aiEvents.length ? `<table><thead><tr><th class="l">시작</th><th>지속</th><th>최고 점수</th><th class="l">주요 원인</th><th class="l">당시 규칙</th></tr></thead><tbody>
            ${x.aiEvents.slice(-8).reverse().map(e => `<tr><td class="l">${esc(fmtShort(e.start))}</td><td>${durText(e.min)}</td><td>${e.peak.toFixed(3)}</td><td class="l">${esc(e.cause?.short ?? "—")}</td><td class="l">${statusTag(e.ruleStatus)}</td></tr>`).join("")}
          </tbody></table>${x.aiEvents.length > 8 ? `<p class="muted small">최근 8건만 표시</p>` : ""}` : `<p class="muted">없음</p>`}
          <h4>경고 이력 (${x.alerts.length}건)</h4>${x.alerts.length ? `<table><thead><tr><th class="l">내용</th><th class="l">심각도</th><th class="l">시작</th><th>지속</th></tr></thead><tbody>
            ${x.alerts.slice(0, 8).map(a => `<tr><td class="l">${esc(ALERT_LABEL[a.alert_code] ?? a.alert_code)}</td><td class="l">${statusTag(a.severity)}</td><td class="l">${esc(fmtShort(a.started_at))}</td><td>${a.is_active ? "진행 중 · " : ""}${durText(a.min)}</td></tr>`).join("")}
          </tbody></table>` : `<p class="muted">없음</p>`}
        </div>
      </div>
    </section>`;
  }

  function buildReport(ids) {
    const A = window.anomalyAI;
    const tanks = ids ? state.tanks.filter(t => ids.includes(t.tank_id)) : state.tanks;
    const range = state.history ? historyRange(state.history) : {};
    const list = tanks.map(t => analyzeTank(t, range));
    const scored = list.filter(x => !x.nodata);
    const single = !!ids && ids.length === 1;
    const info = A.info(), v = A.validation();
    const created = new Date();
    const gradeCount = Object.fromEntries(GRADE.map(([, g]) => [g, scored.filter(x => x.grade === g).length]));
    const ruleBad = scored.filter(x => x.t.status !== "normal");
    const aiBad = scored.filter(x => x.now?.level === "alert");
    const aiOnly = scored.filter(x => x.now?.compare === "early");
    const alertsN = scored.reduce((a, x) => a + x.alerts.length, 0);
    const kwh = scored.reduce((a, x) => a + (x.kwh || 0), 0);
    const recv = scored.length ? scored.reduce((a, x) => a + (x.receive ?? 0), 0) / scored.length : null;
    const priority = scored.filter(x => x.grade === "C" || x.grade === "D" || x.urgency !== "정기").sort((a, b) => a.score - b.score);
    const topEnergy = [...scored].sort((a, b) => (b.kwh || 0) - (a.kwh || 0)).slice(0, 5);
    const drifted = scored.filter(x => x.drifts.length);

    // 일별 전력량 (선택 수조 합계)
    const byDay = new Map();
    for (const x of scored) for (const d of dailyEnergy(x.rows)) {
      const o = byDay.get(d.date) || { kwh: 0, partial: false };
      o.kwh += d.kwh; o.partial ||= d.points < 288; byDay.set(d.date, o);
    }
    const days = [...byDay].sort(([a], [b]) => a < b ? -1 : 1);

    // 자동 요약 문장
    const names = arr => arr.slice(0, 4).map(x => x.t.tank_name).join(", ") + (arr.length > 4 ? ` 외 ${arr.length - 4}대` : "");
    const summary = [];
    const now1 = scored.filter(x => x.urgency === "즉시");
    if (now1.length) summary.push(`<b>즉시 조치</b>가 필요한 장비는 ${now1.length}대입니다: ${esc(names(now1))}.`);
    const today = scored.filter(x => x.urgency === "금일");
    if (today.length) summary.push(`오늘 중 점검할 장비는 ${today.length}대입니다: ${esc(names(today))}.`);
    if (aiOnly.length) summary.push(`규칙 기준으로는 정상이지만 AI가 평소와 다르다고 본 장비가 ${aiOnly.length}대 있습니다(${esc(names(aiOnly))}). 경고로 번지기 전에 확인하세요.`);
    if (drifted.length) summary.push(`기간 초보다 측정값 수준이 크게 바뀐 장비가 ${drifted.length}대입니다(${esc(names(drifted))}).`);
    if (!now1.length && !today.length && !aiOnly.length) summary.push("현재 긴급히 조치할 장비는 없습니다.");
    if (scored.length > 1) summary.push(`기간 전력량은 총 ${kwh.toFixed(1)} kWh이며, 가장 많이 쓴 장비는 ${esc(topEnergy[0]?.t.tank_name ?? "—")}(${num(topEnergy[0]?.kwh, 2)} kWh)입니다.`);
    if (v && !single) summary.push(`AI 모델은 원본 기록에서 규칙 경고 시점의 ${v.rulePts ? Math.round(v.hitPts / v.rulePts * 100) : 0}%를 감지했고, 경고 사건 ${v.events}건 중 ${v.early}건을 평균 ${v.early ? Math.round(v.leadSum / v.early) : 0}분 먼저 감지했습니다.`);

    const title = single ? `${tanks[0].tank_name} 장비 관리 리포트` : "AI 장비 관리 리포트";
    const kpi = (label, value, sub, cls = "") => `<div class="kpi ${cls}"><div class="kl">${label}</div><div class="kv">${value}</div><div class="ks">${sub}</div></div>`;

    return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(fmtShort(state.snapshot))}</title>
<style>
  :root { --ink:#0f172a; --muted:#64748b; --line:#e2e8f0; --bg:#f8fafc; --red:#dc2626; --amber:#d97706; --green:#16a34a; --violet:#7c3aed; --gray:#94a3b8; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:13px/1.55 "Pretendard","Malgun Gothic","Apple SD Gothic Neo",system-ui,sans-serif; }
  .page { max-width:1080px; margin:0 auto; padding:28px 24px 60px; }
  .toolbar { position:sticky; top:0; z-index:2; background:#0f172a; color:#e2e8f0; padding:8px 16px; display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .toolbar button { background:#1e293b; color:#e2e8f0; border:1px solid #334155; border-radius:6px; padding:6px 12px; cursor:pointer; font-size:12px; }
  .toolbar button:hover { border-color:#3b82f6; } .toolbar span { font-size:12px; color:#94a3b8; margin-left:auto; }
  header.rh { border-bottom:3px solid var(--ink); padding-bottom:12px; margin-bottom:18px; }
  header.rh h1 { margin:0 0 4px; font-size:24px; } header.rh p { margin:0; color:var(--muted); }
  h2 { font-size:16px; margin:26px 0 10px; padding-left:8px; border-left:4px solid var(--violet); }
  h3 { font-size:14px; margin:0 0 10px; display:flex; align-items:center; gap:8px; flex-wrap:wrap; } h3 small { color:var(--muted); font-weight:400; }
  h3 .right { margin-left:auto; font-weight:400; color:var(--muted); font-size:12px; } h3 .right b { color:var(--ink); font-size:15px; }
  h4 { margin:12px 0 6px; font-size:12px; color:#334155; }
  .kpis { display:grid; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr)); gap:10px; }
  .kpi { background:#fff; border:1px solid var(--line); border-radius:10px; padding:10px 12px; }
  .kl { font-size:11px; color:var(--muted); } .kv { font-size:22px; font-weight:700; margin:2px 0; } .ks { font-size:11px; color:var(--muted); }
  .kpi.bad .kv { color:var(--red); } .kpi.warn .kv { color:var(--amber); } .kpi.ai .kv { color:var(--violet); }
  .summary { background:#fff; border:1px solid var(--line); border-radius:10px; padding:12px 16px; margin-top:12px; }
  .summary li { margin:3px 0; }
  table { width:100%; border-collapse:collapse; background:#fff; font-size:12px; }
  th, td { padding:5px 8px; border-bottom:1px solid var(--line); text-align:right; vertical-align:top; }
  th { background:#f1f5f9; font-weight:600; color:#334155; white-space:nowrap; } .l { text-align:left; }
  .wrap { border:1px solid var(--line); border-radius:10px; overflow:hidden; }
  .card { background:#fff; border:1px solid var(--line); border-radius:10px; padding:14px 16px; margin:12px 0; break-inside:avoid; }
  .cols { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
  .card table { border:1px solid var(--line); }
  .meta { color:#334155; font-size:12px; margin:8px 0 0; }
  .muted { color:var(--muted); } .small { font-size:11px; }
  .spark { width:100%; height:70px; background:#fafafa; border:1px solid var(--line); border-radius:6px; display:block; }
  .sp-title { font-size:11px; color:#334155; margin:4px 0 3px; font-weight:600; } .sp-title .muted { font-weight:400; }
  .g { display:inline-block; min-width:24px; text-align:center; border-radius:6px; font-weight:800; padding:1px 6px; color:#fff; background:var(--gray); }
  .g-A { background:var(--green); } .g-B { background:#2563eb; } .g-C { background:var(--amber); } .g-D { background:var(--red); }
  .st { display:inline-block; font-size:11px; padding:0 7px; border-radius:999px; border:1px solid currentColor; white-space:nowrap; }
  .st-normal, .ai-normal { color:var(--green); } .st-warning, .ai-watch { color:var(--amber); } .st-critical, .ai-alert { color:var(--red); }
  .st-offline, .st-nodata, .ai-na { color:var(--gray); }
  .urg { font-weight:700; } .urg-now { color:var(--red); } .urg-today { color:var(--amber); } .urg-week { color:#2563eb; } .urg-routine { color:var(--muted); font-weight:400; }
  .bars { background:#fff; border:1px solid var(--line); border-radius:10px; padding:10px 14px; }
  .bar-row { display:grid; grid-template-columns:90px 1fr 90px; gap:8px; align-items:center; font-size:12px; margin:3px 0; }
  .bar-t { background:#f1f5f9; height:12px; border-radius:3px; overflow:hidden; } .bar-t i { display:block; height:100%; background:#ef4444; }
  .bar-v { text-align:right; }
  .two { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
  .note { font-size:11px; color:var(--muted); background:#fff; border:1px dashed var(--line); border-radius:10px; padding:10px 14px; }
  .note li { margin:2px 0; }
  @media (max-width:760px) { .cols, .two { grid-template-columns:1fr; } .page { padding:16px 16px 40px; } .wrap { overflow-x:auto; } }
  @media print {
    body { background:#fff; font-size:11px; } .toolbar { display:none; } .page { max-width:none; padding:0; }
    h2 { break-after:avoid; } .card, .kpi, tr { break-inside:avoid; } .tank-cards { break-before:page; }
    @page { size:A4; margin:12mm; }
  }
</style></head><body>
<div class="toolbar"><button onclick="print()">🖨 인쇄 / PDF로 저장</button><button id="saveHtml">💾 HTML 파일로 저장</button>
  <span>교육용 가상 데이터 기반 · 브라우저에서 생성</span></div>
<div class="page">
<header class="rh">
  <h1>📋 ${esc(title)}</h1>
  <p>기준 시각 ${esc(fmtTime(state.snapshot))} · 분석 기간 ${esc(fmtShort(range.first))} ~ ${esc(fmtShort(range.last))} · 대상 ${tanks.length}대 · 생성 ${esc(created.toLocaleString("ko-KR", { hour12: false }))}</p>
</header>

<h2>1. 핵심 요약</h2>
<div class="kpis">
  ${single
    ? kpi("관리 등급", scored[0] ? `${scored[0].grade} · ${scored[0].score}점` : "—", scored[0]?.gradeText ?? "기록 없음", scored[0]?.grade === "D" ? "bad" : scored[0]?.grade === "C" ? "warn" : "") +
      kpi("현재 상태", esc(STATUS_LABEL[tanks[0].status] ?? tanks[0].status), "규칙(판정 기준) 판정", ruleBad.length ? "bad" : "") +
      kpi("AI 이상 점수", num(scored[0]?.now?.score, 3), scored[0]?.now ? A.AI_LABEL[scored[0].now.level] : "—", "ai")
    : kpi("점검 필요·집중 관리 (C·D 등급)", `${gradeCount.C + gradeCount.D}대`, `A ${gradeCount.A} · B ${gradeCount.B} · C ${gradeCount.C} · D ${gradeCount.D}`, gradeCount.D ? "bad" : gradeCount.C ? "warn" : "") +
      kpi("현재 이상 (규칙)", `${ruleBad.length}대`, `위험 ${ruleBad.filter(x => x.t.status === "critical").length} · 주의 ${ruleBad.filter(x => x.t.status === "warning").length} · 통신 끊김 ${ruleBad.filter(x => x.t.status === "offline").length}`, ruleBad.length ? "bad" : "") +
      kpi("AI 이상", `${aiBad.length}대`, `그중 규칙은 정상 ${aiOnly.length}대`, "ai")}
  ${kpi("기간 내 경고", `${alertsN}건`, `진행 중 ${scored.reduce((a, x) => a + x.active.length, 0)}건`)}
  ${kpi("기간 전력량", `${kwh.toFixed(1)} kWh`, "Σ power_w × 5/60 ÷ 1000")}
  ${kpi("평균 수신률", pct(recv), "측정값을 받은 시점 비율")}
</div>
<div class="summary"><ul>${summary.map(s => `<li>${s}</li>`).join("")}</ul></div>

${single ? "" : `
<h2>2. 우선 조치 대상 (${priority.length}대)</h2>
${priority.length ? `<div class="wrap"><table><thead><tr><th>순위</th><th class="l">장비</th><th>등급·점수</th><th class="l">조치</th><th class="l">현재</th><th class="l">진단</th><th class="l">권고 조치</th></tr></thead><tbody>
${priority.map((x, i) => `<tr><td>${i + 1}</td><td class="l"><b>${esc(x.t.tank_name)}</b><br><span class="muted small">${esc(x.t.location)}</span></td>
  <td>${gradeBadge(x.grade)} ${x.score}</td><td class="l">${urgTag(x.urgency)}</td>
  <td class="l">${statusTag(x.t.status)}<br>${x.now ? aiTag(x.now.level) : ""}</td>
  <td class="l">${x.issues.map(esc).join("<br>") || "—"}</td><td class="l">${esc(x.advice[0])}</td></tr>`).join("")}
</tbody></table></div>` : `<p class="muted">우선 조치 대상이 없습니다.</p>`}

<h2>3. 장비별 관리 현황</h2>
<div class="wrap"><table><thead><tr><th class="l">장비</th><th>등급</th><th>점수</th><th class="l">현재</th><th class="l">AI 현재</th><th>AI 이상 시점</th><th>경고</th><th>수신률</th><th>전력량 kWh</th><th>평균 W / 정격</th><th class="l">조치</th></tr></thead><tbody>
${list.map(x => x.nodata ? `<tr><td class="l">${esc(x.t.tank_name)}</td><td colspan="10" class="l muted">측정 기록 없음 (신규 등록)</td></tr>` : `<tr>
  <td class="l">${esc(x.t.tank_name)} <span class="muted small">${esc(x.t.tank_id)}</span></td><td>${gradeBadge(x.grade)}</td><td>${x.score}</td>
  <td class="l">${statusTag(x.t.status)}</td><td class="l">${x.now ? aiTag(x.now.level, x.now.score) : "—"}</td>
  <td>${x.aiAlertPts}</td><td>${x.alerts.length}</td><td>${pct(x.receive)}</td><td>${num(x.kwh, 2)}</td>
  <td>${num(x.stats.power_w?.avg, 1)} / ${x.rated ?? "—"}</td><td class="l">${urgTag(x.urgency)}</td></tr>`).join("")}
</tbody></table></div>

<h2>4. 전력 사용</h2>
<div class="two">
  <div><h4>일별 전력량 합계 (흐린 막대 = 하루 일부만 기록)</h4>${bars(days.map(([d, o]) => ({ label: d.slice(5).replace("-", "/"), v: o.kwh, partial: o.partial })), "kWh")}</div>
  <div><h4>기간 전력량 상위 5대</h4>${bars(topEnergy.map(x => ({ label: x.t.tank_name, v: x.kwh || 0 })), "kWh")}</div>
</div>`}

<h2>${single ? "2" : "5"}. ${single ? "장비 상세" : "주요 장비 상세"}</h2>
<div class="tank-cards">
${(single ? list : priority).map(tankCard).join("") || `<p class="muted">상세를 표시할 우선 조치 대상이 없습니다.</p>`}
</div>

<h2>${single ? "3" : "6"}. AI 모델과 판단 방법</h2>
<div class="note"><ul>
  <li><b>AI 이상 감지</b>: Isolation Forest(비지도 학습). 수온·수위·탁도·전력을 수조마다 자기 평소 값(중앙값·MAD) 기준으로 정규화한 뒤,
    무작위로 나누기를 반복했을 때 빨리 고립되는 시점일수록 높은 점수(0~1)를 줍니다. ≥ ${A.LEVEL.alert} 이상, ≥ ${A.LEVEL.watch} 관찰.</li>
  ${info ? `<li>학습: ${info.tanks}개 수조 ${info.rows.toLocaleString()}개 시점 (${esc(fmtShort(info.first))} ~ ${esc(fmtShort(info.last))}), 나무 200그루, 표본 256개.</li>` : ""}
  ${v ? `<li>검증(학습 기록): 규칙 경고 ${v.rulePts}개 시점 중 ${v.hitPts}개 감지, 경고 사건 ${v.events}건 중 ${v.early}건을 평균 ${v.early ? Math.round(v.leadSum / v.early) : 0}분 먼저 감지, 규칙 정상 시점 중 AI 이상 ${v.aiOnly}개.</li>` : ""}
  <li><b>관리 점수</b>(100점 감점식): 현재 위험 −${HEALTH.status.critical}, 통신 끊김 −${HEALTH.status.offline}, 주의 −${HEALTH.status.warning} · 현재 AI 이상 −${HEALTH.aiNow.alert}, 관찰 −${HEALTH.aiNow.watch} ·
    기간 내 AI 이상 시점당 −${HEALTH.aiPointsPer}(최대 ${HEALTH.aiPointsMax}) · 경고 1건당 −${HEALTH.alertEach}(최대 ${HEALTH.alertMax}) · 미수신 1%당 −1(최대 ${HEALTH.receiveMax}) ·
    추세 변화 항목당 −${HEALTH.drift}(첫 24시간 대비 마지막 24시간 평균이 평소 변동폭의 ${DRIFT_SIGMA}배 이상) · 평균 전력 정격 95% 이상 −${HEALTH.overRated}.
    등급 A ≥ 90 · B ≥ 75 · C ≥ 60 · D &lt; 60.</li>
  <li><b>조치 시점</b>: 즉시 = 위험·통신 끊김 · 금일 = 경고 진행 중 또는 AI 이상 · 이번 주 = C/D 등급, AI 관찰, 추세 변화 · 정기 = 그 외.</li>
  <li>진단·권고 문구는 정해진 규칙으로 만든 참고 의견입니다(생성형 AI 아님). 판정 기준과 AI 기준은 교육용 가상 데이터로 정한 값이므로 실제 설비에는 그 설비 기록으로 다시 검증해야 합니다.</li>
</ul></div>
</div>
<script>
  document.getElementById("saveHtml").onclick = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["<!doctype html>\\n" + document.documentElement.outerHTML], { type: "text/html" }));
    a.download = ${JSON.stringify(`${title.replace(/\s+/g, "_")}_${(state.snapshot || "").slice(0, 16).replace(/[:T]/g, "")}.html`)};
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
<\/script>
</body></html>`;
  }

  function openReport(ids) {
    if (!state.history) { alert("시간별 기록(sensor_history.csv)을 아직 불러오는 중입니다. 잠시 후 다시 눌러 주세요."); return; }
    if (!window.anomalyAI?.ready()) { alert("AI 모델을 준비하지 못했습니다. 기록을 불러온 뒤 다시 시도하세요."); return; }
    const html = buildReport(ids);
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    const w = window.open(url, "_blank");
    if (!w) {                                   // 팝업 차단 시 파일로 내려받기
      const a = document.createElement("a");
      a.href = url; a.download = "AI_장비_관리_리포트.html"; a.click();
    }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  window.openReport = openReport;
  window.buildReport = buildReport;
  window.reportSummary = () => {                // 챗봇용 요약
    const range = state.history ? historyRange(state.history) : {};
    return state.tanks.map(t => analyzeTank(t, range)).filter(x => !x.nodata).sort((a, b) => a.score - b.score);
  };
})();
