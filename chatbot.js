/* 데이터 질문 챗봇 (규칙 기반, API 키 없음)
 * ultra-dashboard.html 의 전역 state·함수(state, METRICS, energyKwh, dailyEnergy, ...)를 그대로 사용합니다.
 * 질문에서 수조 이름·측정 항목·기간·집계 방식을 찾아 현재 불러온 데이터로 계산해 답합니다.
 * 날짜 표현(오늘·어제·최근 N시간)은 실제 시계가 아니라 '데이터의 가장 최근 시각' 기준입니다.
 */
(() => {
  // ---------------- 화면 ----------------
  const css = `
  .cb-fab { position: fixed; right: 20px; bottom: 20px; z-index: 50; border: none; border-radius: 999px; padding: 12px 18px;
    background: var(--blue); color: #fff; font-size: 13px; font-weight: 600; cursor: pointer; box-shadow: 0 8px 24px rgba(0,0,0,.4); }
  .cb-fab:hover { filter: brightness(1.1); }
  .cb-panel { position: fixed; right: 20px; bottom: 20px; z-index: 51; width: min(420px, calc(100vw - 32px)); height: min(620px, calc(100vh - 40px));
    background: var(--panel); border: 1px solid var(--line-2); border-radius: 14px; display: none; flex-direction: column;
    box-shadow: 0 16px 48px rgba(0,0,0,.5); overflow: hidden; }
  .cb-panel.open { display: flex; }
  .cb-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid var(--line); }
  .cb-head b { font-size: 14px; }
  .cb-head span { font-size: 11px; color: var(--muted); margin-left: 6px; }
  .cb-close { background: none; border: none; color: var(--muted); font-size: 18px; cursor: pointer; line-height: 1; }
  .cb-log { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
  .cb-msg { max-width: 92%; font-size: 12.5px; line-height: 1.6; padding: 9px 12px; border-radius: 12px; overflow-wrap: anywhere; }
  .cb-msg.user { align-self: flex-end; background: var(--blue); color: #fff; border-bottom-right-radius: 4px; }
  .cb-msg.bot { align-self: flex-start; background: var(--bg-deep); border: 1px solid var(--line); border-bottom-left-radius: 4px; }
  .cb-msg p { margin: 0 0 6px; } .cb-msg p:last-child { margin-bottom: 0; }
  .cb-msg ul { margin: 4px 0 6px; padding-left: 18px; }
  .cb-msg .muted { color: var(--muted); font-size: 11px; }
  .cb-msg .warn { color: var(--warning); font-weight: 600; } .cb-msg .crit { color: var(--critical); font-weight: 600; }
  .cb-table { border-collapse: collapse; width: 100%; margin: 4px 0 6px; font-size: 11.5px; }
  .cb-table th, .cb-table td { padding: 4px 6px; border-top: 1px solid var(--line); text-align: right; white-space: nowrap; }
  .cb-table th { color: var(--muted); font-weight: 500; }
  .cb-table .l { text-align: left; }
  .cb-tank { color: #93c5fd; cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
  .cb-chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 12px 0; }
  .cb-chip { font-size: 11px; padding: 4px 9px; border-radius: 999px; border: 1px solid var(--line-2); background: var(--bg-deep);
    color: var(--soft); cursor: pointer; }
  .cb-chip:hover { border-color: var(--blue); color: var(--text); }
  .cb-form { display: flex; gap: 8px; padding: 10px 12px 12px; }
  .cb-form input { flex: 1; min-width: 0; background: var(--bg-deep); border: 1px solid var(--line-2); border-radius: 8px;
    color: var(--text); padding: 9px 10px; font-size: 13px; }
  .cb-form input:focus { outline: none; border-color: var(--blue); }
  .cb-form button { background: var(--blue); border: none; color: #fff; border-radius: 8px; padding: 0 14px; font-weight: 600; cursor: pointer; }
  @media (max-width: 760px) { .cb-fab { right: 12px; bottom: 12px; } .cb-panel { right: 16px; bottom: 16px; } }`;
  document.head.insertAdjacentHTML("beforeend", `<style>${css}</style>`);
  document.body.insertAdjacentHTML("beforeend", `
    <button class="cb-fab" id="cbFab" type="button">💬 데이터에 질문하기</button>
    <section class="cb-panel" id="cbPanel" aria-label="데이터 질문 챗봇">
      <div class="cb-head"><div><b>데이터 질문</b><span>규칙 기반 · 현재 불러온 데이터로 계산</span></div>
        <button class="cb-close" id="cbClose" type="button" aria-label="닫기">×</button></div>
      <div class="cb-log" id="cbLog"></div>
      <div class="cb-chips" id="cbChips"></div>
      <form class="cb-form" id="cbForm"><input id="cbInput" autocomplete="off" placeholder="예) 패류 수조 어제 전력량" /><button>보내기</button></form>
    </section>`);

  const EXAMPLES = ["지금 이상 있는 수조", "총 전력량", "수온 가장 높은 수조", "패류 수조 상태",
                    "산호 전시 수족관 최근 6시간 수온", "어제 전력량 많은 수조", "진행 중 경고", "AI 이상 점수", "우선 점검 대상", "로비 수족관 vs 메인 전시 수족관"];
  const $ = id => document.getElementById(id);
  const log = $("cbLog");

  function addMsg(html, who) {
    const el = document.createElement("div");
    el.className = "cb-msg " + who;
    el.innerHTML = html;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
  }
  function ask(q) {
    q = q.trim();
    if (!q) return;
    addMsg(esc(q), "user");
    let html;
    try { html = answer(q); }
    catch (e) { html = `<p>계산 중 오류가 났습니다: ${esc(e.message)}</p>`; }
    addMsg(html, "bot");
  }
  $("cbChips").innerHTML = EXAMPLES.map(e => `<button type="button" class="cb-chip">${esc(e)}</button>`).join("");
  $("cbChips").onclick = e => { const b = e.target.closest(".cb-chip"); if (b) ask(b.textContent); };
  $("cbForm").onsubmit = e => { e.preventDefault(); ask($("cbInput").value); $("cbInput").value = ""; };
  $("cbFab").onclick = () => {
    $("cbPanel").classList.add("open"); $("cbFab").style.display = "none"; $("cbInput").focus();
    if (!log.children.length) addMsg(helpHtml(true), "bot");
  };
  $("cbClose").onclick = () => { $("cbPanel").classList.remove("open"); $("cbFab").style.display = ""; };
  log.addEventListener("click", e => {
    const a = e.target.closest(".cb-tank");
    if (a) selectTank(a.dataset.id);
    const r = e.target.closest("[data-report]");
    if (r) window.openReport?.(r.dataset.report ? r.dataset.report.split(",") : undefined);
  });

  // ---------------- 공통 도우미 ----------------
  const tankLink = t => `<span class="cb-tank" data-id="${esc(t.tank_id)}">${esc(t.tank_name)}</span>`;
  const M = key => METRICS.find(m => m.key === key);
  const fmtV = (key, v) => isNum(v) ? `${v.toFixed(M(key).digits)} ${M(key).unit}` : "미수신";
  const lvClass = (key, v) => { const lv = isNum(v) ? metricLevel(key, v) : "normal"; return lv === "critical" ? "crit" : lv === "warning" ? "warn" : ""; };
  const valHtml = (key, v) => { const c = lvClass(key, v); return c ? `<span class="${c}">${fmtV(key, v)}</span>` : fmtV(key, v); };
  const kstDate = ms => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);
  const norm = s => s.replace(/\s+/g, "").toLowerCase();
  // 받침에 맞는 조사: josa("수온","이가") → "수온이", josa("수위","이가") → "수위가"
  const josa = (word, pair) => {
    const c = word.charCodeAt(word.length - 1) - 0xAC00;
    const has = c >= 0 && c <= 11171 && c % 28 !== 0;
    return word + (has ? pair[0] : pair[1]);
  };

  function latestTs() {
    let last = null;
    if (state.history) for (const rows of state.history.values()) { const r = rows[rows.length - 1]; if (r && (!last || r.ts > last)) last = r.ts; }
    return last || state.snapshot;
  }
  function needHistory() {
    if (state.history) return null;
    return `<p>시간별 기록(sensor_history.csv)을 아직 불러오는 중입니다. 잠시 후 다시 물어봐 주세요.</p>`;
  }

  // ---------------- 질문 해석 ----------------
  const METRIC_WORDS = [
    ["energy", /전력량|kwh|킬로와트시|에너지|누적\s*전력|전기\s*사용량|소비량/i],
    ["temperature_c", /수온|온도|기온|℃|도씨/],
    ["water_level_pct", /수위|물\s*높이|물\s*양|수량/],
    ["turbidity_ntu", /탁도|ntu|탁해|흐림|맑기/i],
    ["power_w", /전력|소비\s*전력|와트|\d\s*w\b|사용량|전기/i],
  ];
  function parseMetric(q) {
    for (const [k, re] of METRIC_WORDS) if (re.test(q)) return k;
    return null;
  }
  function parseAgg(q) {
    if (/최고|최대|가장\s*높|제일\s*높|가장\s*많|제일\s*많|높은\s*순|많은\s*순|가장\s*큰|많이\s*쓴|top|상위/i.test(q)) return "max";
    if (/최저|최소|가장\s*낮|제일\s*낮|가장\s*적|제일\s*적|낮은\s*순|적은\s*순|가장\s*작|하위/.test(q)) return "min";
    if (/평균/.test(q)) return "avg";
    if (/합계|총|합산|전체\s*합/.test(q)) return "sum";
    return null;
  }
  function parseTopN(q) {
    const m = q.match(/(?:상위|하위|top)\s*(\d+)|(\d+)\s*(?:개|곳|위)(?!\s*월)/i);
    return m ? Math.min(30, +(m[1] || m[2])) : null;
  }
  // 기간: {label, test(row)} 또는 null(=현재값)
  function parsePeriod(q) {
    const last = latestTs();
    if (!last) return null;
    const lastMs = Date.parse(last), today = last.slice(0, 10);
    const byDate = (key, label) => ({ label: `${label} (${key.slice(5).replace("-", "/")})`, key, test: r => r.ts.slice(0, 10) === key });
    const since = (ms, label) => ({ label, since: lastMs - ms, test: r => Date.parse(r.ts) > lastMs - ms });
    let m;
    if ((m = q.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/)) || (m = q.match(/\b(\d{1,2})\/(\d{1,2})\b/))) {
      const key = `${today.slice(0, 4)}-${String(m[1]).padStart(2, "0")}-${String(m[2]).padStart(2, "0")}`;
      return byDate(key, `${+m[1]}월 ${+m[2]}일`);
    }
    if (/그제|그저께/.test(q)) return byDate(kstDate(Date.parse(today + "T00:00:00+09:00") - 2 * 86400e3 + 1), "그저께");
    if (/어제/.test(q)) return byDate(kstDate(Date.parse(today + "T00:00:00+09:00") - 86400e3 + 1), "어제");
    if (/오늘/.test(q)) return byDate(today, "오늘");
    if ((m = q.match(/(\d+)\s*분/))) return since(+m[1] * 60e3, `최근 ${m[1]}분`);
    if ((m = q.match(/(\d+)\s*시간/))) return since(+m[1] * 3600e3, `최근 ${m[1]}시간`);
    if (/하루|(?<!\d)1\s*일/.test(q)) return since(86400e3, "최근 24시간");
    if (/일주일|(?<!\d)1\s*주|이번\s*주|(?<!\d)7\s*일|전체|누적|모든\s*기록|지금까지/.test(q)) return { label: "전체 기록 (7일)", all: true, test: () => true };
    if ((m = q.match(/(\d+)\s*일/))) return since(+m[1] * 86400e3, `최근 ${m[1]}일`);
    return null;
  }
  // 질문에서 수조 찾기. 반환: {tanks:[...], ambiguous:[...]}
  const STOP = new Set(["수조", "수족관", "탱크", "전시", "상태", "전력", "전력량", "수온", "수위", "탁도", "지금", "현재", "가장", "최근", "평균",
                        "어제", "오늘", "경고", "이상", "관리", "예비", "내부", "생태", "그래프", "기록", "수질", "전체", "모든",
                        "진행", "이력", "비교", "일별", "기준", "판정", "통신", "정지", "높은", "낮은", "많은", "적은"]);
  function parseTanks(q) {
    const tanks = state.tanks;
    const nq = norm(q);
    // ID: TANK-006, US-006, 6번
    const ids = new Set();
    for (const m of q.matchAll(/(?:tank|us)\s*-?\s*0*(\d{1,3})/gi)) ids.add(`TANK-${m[1].padStart(3, "0")}`);
    for (const m of q.matchAll(/(\d{1,3})\s*번(?!\s*째)/g)) ids.add(`TANK-${m[1].padStart(3, "0")}`);
    let found = tanks.filter(t => ids.has(t.tank_id));
    // 전체 이름
    // 사용자가 '수조', 'A' 같은 짧거나 흔한 이름으로 등록한 장비가 질문을 가로채지 않도록 제외
    const named = tanks.filter(t => { const n = norm(t.tank_name); return n.length >= 2 && !STOP.has(n) && nq.includes(n); })
      .filter((t, _, arr) => !arr.some(o => o !== t && norm(o.tank_name).includes(norm(t.tank_name))));
    found = [...new Set([...found, ...named])];
    if (found.length) return { tanks: sortByPosition(found, nq) };
    // 이름 일부 (예: "패류", "해파리")
    const words = q.split(/[\s,·?!.~]+/).map(w => w.replace(/(은|는|이|가|을|를|의|에|에서|도|와|과|랑|하고|이랑|만|좀|요)$/, "")).filter(w => w.length >= 2 && !STOP.has(w));
    const hits = new Map();
    for (const w of words) {
      const cand = tanks.filter(t => norm(t.tank_name).includes(norm(w)));
      if (cand.length === 1) hits.set(cand[0].tank_id, cand[0]);
      else if (cand.length > 1 && cand.length <= 6) return { tanks: [], ambiguous: cand, word: w };
    }
    if (hits.size) return { tanks: sortByPosition([...hits.values()], nq) };
    if (/이\s*수조|이\s*수족관|선택한|보고\s*있는|지금\s*보는/.test(q) && state.selectedId) {
      const t = tanks.find(x => x.tank_id === state.selectedId);
      if (t) return { tanks: [t] };
    }
    return { tanks: [] };
  }
  function sortByPosition(list, nq) {
    const pos = t => { const i = nq.indexOf(norm(t.tank_name)); return i < 0 ? 999 : i; };
    return list.slice().sort((a, b) => pos(a) - pos(b));
  }

  // ---------------- 답변 ----------------
  function answer(q) {
    const nq = q.toLowerCase();
    if (/^(도움말?|help|\?)\s*[?!.]*$|뭘\s*물어|무엇을\s*물어|뭐\s*물어|사용법|어떻게\s*(써|사용)/.test(nq)) return helpHtml(false);
    if (/^(안녕|하이)|^(hello|hi)\b/.test(nq)) return `<p>안녕하세요! 수조 상태, 측정값, 전력량, 경고에 대해 물어보세요.</p>` + helpHtml(false, true);

    const { tanks, ambiguous, word } = parseTanks(q);
    if (ambiguous) return `<p>'${esc(word)}'(이)가 들어간 수조가 여러 개입니다. 어느 수조인가요?</p><ul>${ambiguous.map(t => `<li>${tankLink(t)}</li>`).join("")}</ul>`;
    // AI 장비 관리 리포트 (report.js)
    if (/리포트|보고서|관리\s*(현황|등급|점수)|점검\s*(대상|순서|우선)|우선\s*(조치|순위|점검)|무엇부터|뭐부터/.test(q) && !/엑셀|csv|내보내/i.test(q)) return reportHtml(tanks);
    // AI(Isolation Forest) 판단 — '이상 있는 수조'(규칙 판정)와 구분해 AI·점수·이상치를 말한 경우만
    //   '이상 탐지 기준'·'AI 경고'처럼 기준·경고를 묻는 질문은 기존 답변으로
    if (/(?<![a-z])ai(?![a-z])|인공\s*지능|머신\s*러닝|isolation|아이솔레이션|iforest|이상\s*점수|이상치|이상\s*탐지|평소와\s*다른/i.test(q)
        && !/기준|임계|경고|알림|알람/.test(q)) return aiHtml(tanks);
    const metric = parseMetric(q);
    const period = parsePeriod(q);
    const agg = parseAgg(q);

    // '기준'은 '어제 기준'처럼 흔히 쓰이므로 판정 기준을 묻는 경우만
    if (/판정\s*기준|임계|기준값|기준치|threshold/i.test(q) || (/기준/.test(q) && !period && !agg && !/시각|시점|현재|지금/.test(q))) return thresholdsHtml(metric);
    if (/경고|알림|알람|이벤트/.test(q) || (/이력/.test(q) && !metric)) return alertsHtml(tanks, /이력|지난|해제|끝난|모든|전체|과거/.test(q) || !!period);
    if (/일별|날짜별|하루하루|매일/.test(q) && (metric === "energy" || metric === "power_w" || !metric)) return dailyHtml(tanks);

    if (tanks.length >= 2) return compareHtml(tanks, metric, period);
    if (tanks.length === 1) {
      if (!metric) return tankStatusHtml(tanks[0]);
      if (metric === "energy") return tankEnergyHtml(tanks[0], period);
      if (!period && !agg) return tankCurrentHtml(tanks[0], metric);
      return tankMetricPeriodHtml(tanks[0], metric, period || parsePeriod("24시간"), agg);
    }
    // 수조 지정 없음
    if (metric === "energy") return totalEnergyHtml(period, agg, parseTopN(q));
    if (metric) return metricAllHtml(metric, period, agg, parseTopN(q));
    if (/이상|문제|위험|주의|통신|끊김|정지|몇\s*대|상태|요약|현황|어때|괜찮|정상/.test(q)) return overviewHtml(q);
    if (/수조|수족관|목록|리스트|몇\s*개/.test(q)) return listHtml();
    return `<p>질문을 이해하지 못했어요. 수조 이름, 측정 항목(수온·수위·탁도·전력·전력량), 기간(오늘·어제·최근 6시간·7일)을 넣어 물어봐 주세요.</p>` + helpHtml(false, true);
  }

  function reportHtml(tanks) {
    if (!window.reportSummary || !window.anomalyAI?.ready()) return `<p>리포트에 필요한 기록을 아직 불러오는 중이에요. 잠시 후 다시 물어봐 주세요.</p>`;
    const all = window.reportSummary();
    const pick = tanks.length ? all.filter(x => tanks.some(t => t.tank_id === x.t.tank_id)) : all.filter(x => x.urgency !== "정기").slice(0, 5);
    const row = x => `<li>${tankLink(x.t)} — <b>${x.grade}등급 ${x.score}점</b> · 조치 ${esc(x.urgency)}${x.issues.length ? ` · ${esc(x.issues[0])}` : ""}<br><span class="muted">권고: ${esc(x.advice[0])}</span></li>`;
    const head = tanks.length ? `<p>장비 관리 진단입니다.</p>`
      : pick.length ? `<p>우선 점검할 장비 ${pick.length}대입니다 (관리 점수 낮은 순).</p>` : `<p>지금은 우선 조치할 장비가 없습니다. 모든 장비가 정기 점검 대상입니다.</p>`;
    return head + (pick.length ? `<ul>${pick.map(row).join("")}</ul>` : "") +
      `<p><button type="button" class="cb-chip" data-report="${esc(tanks.map(t => t.tank_id).join(","))}">📋 ${tanks.length === 1 ? "이 장비" : "전체"} 리포트 열기</button></p>` +
      `<p class="muted">관리 점수 = 현재 상태·AI 판단·기간 내 경고·수신률·추세 변화를 반영한 100점 감점식 · 리포트는 인쇄·PDF 저장 가능</p>`;
  }

  function aiHtml(tanks) {
    const A = window.anomalyAI;
    if (!A || !A.ready()) return `<p>AI 모델이 아직 준비되지 않았어요. 시간별 기록을 불러온 뒤 다시 물어봐 주세요.</p>`;
    const L = A.LEVEL;
    const row = x => `<li>${tankLink(x.t)} — 점수 <b>${x.score == null ? "—" : x.score.toFixed(3)}</b> (${A.AI_LABEL[x.level]})` +
      `${x.reason ? ` · ${esc(x.reason.text)} <span class="muted">(${esc(x.reason.detail)})</span>` : ""}` +
      `${x.compare === "early" ? " · <b>규칙 기준은 정상인데 AI는 평소와 다르다고 봄</b> (경고 직전이거나 회복 중일 수 있음)" : x.compare === "miss" ? " · 규칙만 경고" : ""}</li>`;
    const foot = `<p class="muted">Isolation Forest · 수조마다 평소 값과 비교 · 점수 ≥ ${L.alert} 이상, ≥ ${L.watch} 관찰</p>`;
    if (tanks.length) return `<p>AI 판단입니다.</p><ul>${tanks.map(t => row(A.assess(t))).join("")}</ul>${foot}`;
    const all = A.all().filter(x => x.score != null).sort((a, b) => b.score - a.score);
    const flagged = all.filter(x => x.level !== "normal");
    const v = A.validation();
    return (flagged.length
        ? `<p>AI가 평소와 다르다고 본 수조 <b>${flagged.length}</b>대입니다.</p><ul>${flagged.map(row).join("")}</ul>`
        : `<p>AI가 보기에 지금은 모든 수조가 평소 범위입니다. 점수가 가장 높은 수조:</p><ul>${all.slice(0, 3).map(row).join("")}</ul>`) +
      (v ? `<p class="muted">원본 기록 검증: 규칙 경고 ${v.rulePts}개 시점 중 ${v.hitPts}개 감지 · 경고 사건 ${v.events}건 중 ${v.early}건을 평균 ${v.early ? Math.round(v.leadSum / v.early) : 0}분 먼저 감지</p>` : "") + foot;
  }

  function helpHtml(first, short) {
    const ex = `<ul>
      <li><b>상태</b>: 지금 이상 있는 수조 / 패류 수조 상태 / 통신 끊긴 수조</li>
      <li><b>측정값</b>: 수온 가장 높은 수조 / 탁도 상위 5개 / 평균 수위</li>
      <li><b>기간</b>: 산호 전시 수족관 최근 6시간 수온 / 어제 평균 탁도 / 11월 2일 수온 최고</li>
      <li><b>전력량</b>: 총 전력량 / 어제 전력량 많은 수조 / 로비 수족관 일별 전력량</li>
      <li><b>경고</b>: 진행 중 경고 / 패류 수조 경고 이력</li>
      <li><b>비교</b>: 로비 수족관 vs 메인 전시 수족관 수온</li>
      <li><b>기준</b>: 수온 판정 기준</li>
      <li><b>AI</b>: AI 이상 점수 / 패류 수조 AI 판단</li>
      <li><b>리포트</b>: 우선 점검 대상 / 패류 수조 관리 리포트</li></ul>`;
    if (short) return ex;
    return `${first ? "<p>안녕하세요! 대시보드 데이터에 대해 물어보세요.</p>" : ""}<p>이렇게 물어볼 수 있어요.</p>${ex}
      <p class="muted">'오늘·어제·최근 N시간'은 데이터의 가장 최근 시각(${esc(fmtTime(latestTs()))}) 기준입니다. 수조 이름을 누르면 상세 화면으로 이동합니다.</p>`;
  }

  function overviewHtml(q) {
    const s = computeSummary();
    let want = null;
    if (/통신|끊김|오프라인/.test(q)) want = ["offline"];
    else if (/위험|심각/.test(q)) want = ["critical"];
    else if (/주의/.test(q)) want = ["warning"];
    else if (/정지/.test(q)) want = "stopped";
    const list = want === "stopped" ? state.tanks.filter(t => t.device_state === "stopped")
      : state.tanks.filter(t => (want || ["warning", "critical", "offline"]).includes(t.status));
    const noData = state.tanks.filter(t => t.status === "nodata").length;
    const head = `<p>기준 시각 ${esc(fmtTime(state.snapshot))} · 장비 ${s.total}대 중 정상 ${state.tanks.filter(t => t.status === "normal").length}대,
      주의 ${s.warning}대, 위험 ${s.critical}대, 통신 끊김 ${s.offline}대${noData ? `, 데이터 없음(새로 등록) ${noData}대` : ""}입니다.</p>`;
    if (!list.length) return head + `<p>${want ? "해당 상태의 수조가 없습니다." : "이상이 있는 수조가 없습니다. 모두 정상입니다."}</p>`;
    return head + `<p>${want ? "해당" : "이상"} 수조 ${list.length}곳:</p><ul>${list.map(t => {
      const codes = t.alert_codes ? t.alert_codes.split("|").map(c => ALERT_LABEL[c] ?? c).join(", ") : "";
      return `<li>${tankLink(t)} ${badgeHtml(t.status)} ${esc(codes)}</li>`;
    }).join("")}</ul>`;
  }

  function listHtml() {
    return `<p>등록된 수조는 ${state.tanks.length}곳입니다.</p><table class="cb-table"><tr><th class="l">수조</th><th class="l">위치</th><th class="l">상태</th></tr>
      ${state.tanks.map(t => `<tr><td class="l">${tankLink(t)}</td><td class="l">${esc(t.location)}</td><td class="l">${badgeHtml(t.status)}</td></tr>`).join("")}</table>`;
  }

  function tankStatusHtml(t) {
    const keys = ["temperature_c", "water_level_pct", "turbidity_ntu", "power_w"];
    const act = state.alerts.filter(a => a.tank_id === t.tank_id);
    const e = state.history?.get(t.tank_id) ? energyKwh(state.history.get(t.tank_id)) : null;
    return `<p>${tankLink(t)} ${badgeHtml(t.status)} · ${esc(t.location)}</p>
      <table class="cb-table">${keys.map(k => `<tr><td class="l">${M(k).label}</td><td>${valHtml(k, t[k])}</td></tr>`).join("")}
      ${e != null ? `<tr><td class="l">누적 전력량 (7일)</td><td>${e.toFixed(2)} kWh</td></tr>` : ""}</table>
      <p>${act.length ? "진행 중 경고: " + act.map(a => `<span class="warn">${esc(ALERT_LABEL[a.alert_code] ?? a.alert_code)}</span> (${fmtShort(a.started_at)}부터)`).join(", ") : "진행 중인 경고가 없습니다."}</p>
      <p class="muted">측정 ${esc(fmtTime(t.timestamp))} · 마지막 통신 ${esc(fmtTime(t.last_seen))}</p>`;
  }

  function tankCurrentHtml(t, key) {
    const v = t[key];
    const lv = isNum(v) ? metricLevel(key, v) : null;
    return `<p>${tankLink(t)}의 현재 ${josa(M(key).label, "은는")} <b>${valHtml(key, v)}</b>입니다${lv && lv !== "normal" ? ` (${STATUS_LABEL[lv]})` : ""}.</p>
      <p class="muted">측정 ${esc(fmtTime(t.timestamp))}. 기간을 붙이면(예: 최근 6시간, 어제) 평균·최고·최저를 알려드려요.</p>`;
  }

  function periodRows(t, period) {
    return (state.history?.get(t.tank_id) || []).filter(period.test);
  }
  function stats(rows, key) {
    const vals = rows.filter(r => isNum(r[key]));
    if (!vals.length) return null;
    let mx = vals[0], mn = vals[0], sum = 0;
    for (const r of vals) { if (r[key] > mx[key]) mx = r; if (r[key] < mn[key]) mn = r; sum += r[key]; }
    return { avg: sum / vals.length, max: mx, min: mn, n: vals.length, total: rows.length };
  }

  function tankMetricPeriodHtml(t, key, period, agg) {
    const wait = needHistory(); if (wait) return wait;
    const rows = periodRows(t, period);
    const s = stats(rows, key);
    if (!s) return `<p>${tankLink(t)}의 ${esc(period.label)} ${M(key).label} 기록이 없습니다.</p>`;
    const line = { max: `최고 <b>${valHtml(key, s.max[key])}</b> (${fmtShort(s.max.ts)})`,
                   min: `최저 <b>${valHtml(key, s.min[key])}</b> (${fmtShort(s.min.ts)})`,
                   avg: `평균 <b>${fmtV(key, s.avg)}</b>` };
    const main = agg && line[agg] ? `<p>${tankLink(t)}의 ${esc(period.label)} ${M(key).label} ${line[agg]}입니다.</p>` : `<p>${tankLink(t)}의 ${esc(period.label)} ${M(key).label}</p>`;
    return main + `<table class="cb-table"><tr><td class="l">평균</td><td>${fmtV(key, s.avg)}</td></tr>
      <tr><td class="l">최고</td><td>${valHtml(key, s.max[key])} · ${fmtShort(s.max.ts)}</td></tr>
      <tr><td class="l">최저</td><td>${valHtml(key, s.min[key])} · ${fmtShort(s.min.ts)}</td></tr>
      <tr><td class="l">기록</td><td>${s.n}/${s.total}개 시점${s.n < s.total ? " (일부 수신 없음)" : ""}</td></tr></table>
      ${key === "power_w" ? `<p>이 기간 전력량은 <b>${energyKwh(rows).toFixed(3)} kWh</b>입니다.</p>` : ""}`;
  }

  function tankEnergyHtml(t, period) {
    const wait = needHistory(); if (wait) return wait;
    period = period || { label: "전체 기록 (7일)", all: true, test: () => true };
    const rows = periodRows(t, period);
    if (!rows.length) return `<p>${tankLink(t)}의 ${esc(period.label)} 기록이 없습니다.</p>`;
    const e = energyKwh(rows);
    const days = dailyEnergy(rows);
    return `<p>${tankLink(t)}의 ${esc(period.label)} 전력량은 <b>${e.toFixed(3)} kWh</b>입니다.</p>
      ${days.length > 1 ? dailyTable(days) : ""}
      <p class="muted">${rows.length}개 시점 · Σ power_w × (5/60) ÷ 1000 · 수신 없는 시점은 0으로 계산</p>`;
  }
  function dailyTable(days) {
    return `<table class="cb-table"><tr><th class="l">날짜</th><th>시점</th><th>kWh</th></tr>${days.slice().reverse().map(d =>
      `<tr><td class="l">${d.date}${d.points < 288 ? " (일부)" : ""}</td><td>${d.points}</td><td>${d.kwh.toFixed(3)}</td></tr>`).join("")}</table>`;
  }
  function dailyHtml(tanks) {
    const wait = needHistory(); if (wait) return wait;
    if (tanks.length >= 1) {
      return tanks.map(t => `<p>${tankLink(t)}의 일별 전력량입니다.</p>${dailyTable(dailyEnergy(state.history.get(t.tank_id) || []))}`).join("");
    }
    const all = [];
    for (const rows of state.history.values()) all.push(...rows);
    const days = dailyEnergy(all).map(d => ({ ...d, points: Math.round(d.points / state.history.size) }));
    return `<p>전체 ${state.history.size}개 수조의 일별 전력량 합계입니다.</p>${dailyTable(days)}<p class="muted">시점 = 수조당 기록 수</p>`;
  }

  function totalEnergyHtml(period, agg, topN) {
    const wait = needHistory(); if (wait) return wait;
    period = period || { label: "전체 기록 (7일)", all: true, test: () => true };
    const per = state.tanks.filter(t => state.history.has(t.tank_id))
      .map(t => ({ t, e: energyKwh(periodRows(t, period)) }));
    const total = per.reduce((a, x) => a + x.e, 0);
    const n = topN || 5;
    const sorted = per.slice().sort((a, b) => agg === "min" ? a.e - b.e : b.e - a.e).slice(0, n);
    return `<p>${esc(period.label)} 전체 ${per.length}개 수조 전력량 합계는 <b>${total.toFixed(2)} kWh</b>입니다.</p>
      <p>${agg === "min" ? "적은" : "많은"} 순 ${sorted.length}곳:</p>
      <table class="cb-table"><tr><th class="l">#</th><th class="l">수조</th><th>kWh</th><th>비중</th></tr>${sorted.map((x, i) =>
        `<tr><td class="l">${i + 1}</td><td class="l">${tankLink(x.t)}</td><td>${x.e.toFixed(3)}</td><td>${total ? (x.e / total * 100).toFixed(1) : 0}%</td></tr>`).join("")}</table>
      <p class="muted">Σ power_w × (5/60) ÷ 1000</p>`;
  }

  function metricAllHtml(key, period, agg, topN) {
    const m = M(key);
    let items, label;
    if (period) {
      const wait = needHistory(); if (wait) return wait;
      label = period.label;
      items = state.tanks.filter(t => state.history.has(t.tank_id)).map(t => {
        const s = stats(periodRows(t, period), key);
        return { t, v: s ? (agg === "max" ? s.max[key] : agg === "min" ? s.min[key] : s.avg) : null, at: s && (agg === "max" ? s.max.ts : agg === "min" ? s.min.ts : null) };
      });
    } else {
      label = "현재";
      items = state.tanks.map(t => ({ t, v: t[key] }));
    }
    const valid = items.filter(x => isNum(x.v));
    if (!valid.length) return `<p>${m.label} 데이터가 없습니다.</p>`;
    const mean = valid.reduce((a, x) => a + x.v, 0) / valid.length;
    if (agg === "avg" || agg === "sum") {
      const isSum = agg === "sum" && key === "power_w";
      const v = isSum ? valid.reduce((a, x) => a + x.v, 0) : mean;
      return `<p>${esc(label)} ${valid.length}개 수조의 ${m.label} ${isSum ? "합계는" : "평균은"} <b>${fmtV(key, v)}</b>입니다.</p>
        <p class="muted">수신 없는 수조 ${items.length - valid.length}곳 제외${isSum ? "" : " · 단순 평균"}</p>`;
    }
    const desc = agg !== "min";
    const sorted = valid.slice().sort((a, b) => desc ? b.v - a.v : a.v - b.v);
    const n = topN || (agg ? 5 : 3);
    const top = sorted[0];
    const head = agg
      ? `<p>${esc(label)} ${josa(m.label, "이가")} 가장 ${desc ? "높은" : "낮은"} 수조는 ${tankLink(top.t)} <b>${valHtml(key, top.v)}</b>${top.at ? ` (${fmtShort(top.at)})` : ""}입니다.</p>`
      : `<p>${esc(label)}${period ? " 기간 평균 기준" : ""} ${m.label} 평균은 <b>${fmtV(key, mean)}</b>입니다. 최고 ${tankLink(sorted[0].t)} ${valHtml(key, sorted[0].v)}, 최저 ${tankLink(sorted[sorted.length - 1].t)} ${valHtml(key, sorted[sorted.length - 1].v)}.</p>`;
    const flagged = valid.filter(x => metricLevel(key, x.v) !== "normal");
    return head + `<table class="cb-table"><tr><th class="l">#</th><th class="l">수조</th><th>${m.label} (${m.unit})</th></tr>${sorted.slice(0, n).map((x, i) =>
      `<tr><td class="l">${i + 1}</td><td class="l">${tankLink(x.t)}</td><td>${valHtml(key, x.v).replace(" " + m.unit, "")}</td></tr>`).join("")}</table>
      ${!period && flagged.length ? `<p>판정 기준을 벗어난 수조: ${flagged.map(x => `${tankLink(x.t)} ${valHtml(key, x.v)}`).join(", ")}</p>` : ""}`;
  }

  function compareHtml(tanks, key, period) {
    const keys = key && key !== "energy" ? [key] : ["temperature_c", "water_level_pct", "turbidity_ntu", "power_w"];
    if (period || key === "energy") {
      const wait = needHistory(); if (wait) return wait;
    }
    const p = period || (key === "energy" ? { label: "전체 기록 (7일)", test: () => true } : null);
    const head = `<tr><th class="l">항목</th>${tanks.map(t => `<th>${tankLink(t)}</th>`).join("")}</tr>`;
    let body = `<tr><td class="l">상태</td>${tanks.map(t => `<td>${badgeHtml(t.status)}</td>`).join("")}</tr>`;
    body += keys.map(k => `<tr><td class="l">${M(k).label}${p ? " 평균" : ""}</td>${tanks.map(t => {
      if (!p) return `<td>${valHtml(k, t[k])}</td>`;
      const s = stats(periodRows(t, p), k);
      return `<td>${s ? fmtV(k, s.avg) : "—"}</td>`;
    }).join("")}</tr>`).join("");
    if (state.history) {
      const pe = p || { label: "전체 기록 (7일)", test: () => true };
      body += `<tr><td class="l">전력량</td>${tanks.map(t => `<td>${energyKwh(periodRows(t, pe)).toFixed(2)} kWh</td>`).join("")}</tr>`;
    }
    return `<p>${tanks.map(tankLink).join(" vs ")} 비교${p ? ` · ${esc(p.label)}` : " · 현재값"}</p>
      <div style="overflow-x:auto"><table class="cb-table">${head}${body}</table></div>
      ${!p ? `<p class="muted">전력량은 전체 기록(7일) 기준입니다.</p>` : ""}`;
  }

  function alertsHtml(tanks, includeEnded) {
    const src = includeEnded ? (state.alertLog || state.alerts) : state.alerts;
    let list = src.filter(a => includeEnded || a.is_active);
    if (tanks.length) list = list.filter(a => tanks.some(t => t.tank_id === a.tank_id));
    list = list.slice().sort((a, b) => a.started_at < b.started_at ? 1 : -1);
    const who = tanks.length ? tanks.map(tankLink).join(", ") + "의 " : "";
    if (!list.length) return `<p>${who}${includeEnded ? "경고 이력이" : "진행 중인 경고가"} 없습니다.</p>`;
    const nowMs = Date.parse(state.snapshot);
    const byId = Object.fromEntries(state.tanks.map(t => [t.tank_id, t]));
    const shown = list.slice(0, 15);
    return `<p>${who}${includeEnded ? "경고 이력" : "진행 중 경고"} ${list.length}건${list.length > shown.length ? ` (최근 ${shown.length}건 표시)` : ""}</p>
      <table class="cb-table"><tr>${tanks.length === 1 ? "" : `<th class="l">수조</th>`}<th class="l">내용</th><th class="l">시작</th><th>지속</th></tr>${shown.map(a => {
        const t = byId[a.tank_id];
        const dur = durationText((a.is_active ? nowMs : Date.parse(a.ended_at)) - Date.parse(a.started_at));
        return `<tr>${tanks.length === 1 ? "" : `<td class="l">${t ? tankLink(t) : esc(a.tank_id)}</td>`}
          <td class="l"><span class="${a.severity === "critical" ? "crit" : "warn"}">${esc(ALERT_LABEL[a.alert_code] ?? a.alert_code)}</span></td>
          <td class="l">${fmtShort(a.started_at)}</td><td>${a.is_active ? "진행 중 · " : ""}${dur}</td></tr>`;
      }).join("")}</table>
      ${includeEnded ? "" : `<p class="muted">해제된 경고까지 보려면 '경고 이력'이라고 물어보세요.</p>`}`;
  }

  function thresholdsHtml(key) {
    const th = state.thresholds || {};
    const rows = [];
    const add = (k, w, c) => (!key || key === k || (key === "energy" && k === "power_w")) && rows.push(`<tr><td class="l">${M(k).label}</td><td class="l">${w}</td><td class="l">${c}</td></tr>`);
    const T = th.temperature_c, L = th.water_level_pct, U = th.turbidity_ntu, P = th.power_w;
    if (T) add("temperature_c", `${T.warning_below}℃ 미만 또는 ${T.warning_above}℃ 초과`, `${T.critical_below_or_equal}℃ 이하 또는 ${T.critical_above_or_equal}℃ 이상`);
    if (L) add("water_level_pct", `${L.warning_below}% 미만`, `${L.critical_below}% 미만`);
    if (U) add("turbidity_ntu", `${U.warning_above} NTU 초과`, `${U.critical_above_or_equal} NTU 이상`);
    if (P) add("power_w", `${P.warning_below} W 미만 또는 ${P.warning_above} W 초과`, `${P.critical_above_or_equal} W 이상 또는 0 W(장비 정지)`);
    return `<p>판정 기준 (thresholds.json)</p><table class="cb-table"><tr><th class="l">항목</th><th class="l">주의</th><th class="l">위험</th></tr>${rows.join("")}</table>
      <p class="muted">교육용 임의 기준입니다. 센서 패킷이 없으면 '통신 끊김'으로 판정합니다.</p>`;
  }

  // 테스트·디버깅용
  window.chatbotAnswer = answer;
})();
