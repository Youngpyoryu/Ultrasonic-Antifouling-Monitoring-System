/* 표 내보내기 (CSV / 엑셀 .xlsx / 전체 보고서)
 * 표 제목 옆 버튼(.export-btns[data-export]) 클릭을 처리합니다.
 * 화면에 표시된 글자가 아니라 원본 숫자로 내보내므로 엑셀에서 바로 계산할 수 있습니다.
 *   global  : 수조별 측정값 (중앙 모니터링)
 *   history : 선택한 수조의 시간별 측정값 (그래프와 같은 기간)
 *   daily   : 선택한 수조의 일별 전력량
 *   alerts  : 선택한 수조의 경고 이력
 *   report  : 엑셀 여러 시트 (수조별 측정값 · 일별 전력량(수조×날짜) · 경고 이력 · 안내)
 * CSV 는 UTF-8 BOM 을 붙여 엑셀에서 한글이 깨지지 않게 합니다.
 * 엑셀 파일은 SheetJS(xlsx 0.18.5)를 처음 쓸 때 CDN 에서 불러옵니다.
 */
(() => {
  const XLSX_URL = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";

  // ---------- 공통 ----------
  const kst = iso => iso ? new Date(Date.parse(iso) + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ") : "";
  const num = (v, d) => isNum(v) ? +v.toFixed(d) : null;
  const statusText = s => STATUS_LABEL[s] ?? s ?? "";
  const alertText = c => ALERT_LABEL[c] ?? c;
  const safeName = s => String(s).replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, "_");
  const stamp = () => kst(state.snapshot).replace(/[-: ]/g, "").replace(/^(\d{8})(\d{4})$/, "$1-$2") || "data";
  const selectedTank = () => state.tanks.find(t => t.tank_id === state.selectedId);
  const rangeLabel = () => ({ 6: "6시간", 24: "24시간", 168: "7일" })[state.rangeHours] || `${state.rangeHours}시간`;

  // ---------- 표 데이터 만들기: { name, sheet, header:[], rows:[[]] } ----------
  function globalTable() {
    const header = ["수조 ID", "장비 ID", "수조", "위치", "상태", "수온(℃)", "수위(%)", "탁도(NTU)", "전력(W)",
                    "누적 전력량(kWh, 7일)", "진행 중 경고 수", "진행 중 경고", "측정 시각", "마지막 통신"];
    const rows = state.tanks.map(t => {
      const act = state.alerts.filter(a => a.tank_id === t.tank_id);
      const h = state.history?.get(t.tank_id);
      return [t.tank_id, t.device_id, t.tank_name, t.location, statusText(t.status),
        num(t.temperature_c, 1), num(t.water_level_pct, 1), num(t.turbidity_ntu, 2), num(t.power_w, 1),
        h ? num(energyKwh(h), 3) : null, act.length, act.map(a => alertText(a.alert_code)).join(", "),
        kst(t.timestamp), kst(t.last_seen)];
    });
    return { name: `수조별_측정값_${stamp()}`, sheet: "수조별 측정값", header, rows };
  }

  function historyTable(t) {
    const all = state.history?.get(t.tank_id) || [];
    const rows = all.slice(-Math.round(state.rangeHours * 12)).slice().reverse();
    return {
      name: `${safeName(t.tank_name)}_시간별_${rangeLabel()}_${stamp()}`, sheet: "시간별 측정값",
      header: ["측정 시각", "상태", "수온(℃)", "수위(%)", "탁도(NTU)", "전력(W)", "전력량(kWh, 5분)"],
      rows: rows.map(r => [kst(r.ts), statusText(r.status), num(r.temperature_c, 1), num(r.water_level_pct, 1),
        num(r.turbidity_ntu, 2), num(r.power_w, 1), isNum(r.power_w) ? +(r.power_w * 5 / 60 / 1000).toFixed(5) : 0])
    };
  }

  function dailyTable(t) {
    const days = dailyEnergy(state.history?.get(t.tank_id) || []).slice().reverse();
    return {
      name: `${safeName(t.tank_name)}_일별_전력량_${stamp()}`, sheet: "일별 전력량",
      header: ["날짜", "하루 전체 기록 여부", "기록 시점", "전력 수신 시점", "평균 전력(W)", "전력량(kWh)"],
      rows: days.map(d => [d.date, d.points >= 288 ? "전체" : "일부", d.points, d.received, num(d.avgW, 1), num(d.kwh, 3)])
    };
  }

  function alertRows(list) {
    const byId = Object.fromEntries(state.tanks.map(t => [t.tank_id, t]));
    const nowMs = Date.parse(state.snapshot);
    return list.slice().sort((a, b) => a.started_at < b.started_at ? 1 : -1).map(a => {
      const end = a.is_active ? nowMs : Date.parse(a.ended_at);
      return [a.event_id, a.tank_id, byId[a.tank_id]?.tank_name ?? "", alertText(a.alert_code), a.alert_code,
        statusText(a.severity), kst(a.started_at), a.is_active ? "" : kst(a.ended_at),
        Math.max(0, Math.round((end - Date.parse(a.started_at)) / 60000)), a.is_active ? "진행 중" : "해제"];
    });
  }
  const ALERT_HEADER = ["이벤트", "수조 ID", "수조", "내용", "경고 코드", "심각도", "시작", "종료", "지속 시간(분)", "상태"];
  function alertsTable(t) {
    const log = (state.alertLog || state.alerts).filter(a => a.tank_id === t.tank_id);
    return { name: `${safeName(t.tank_name)}_경고_이력_${stamp()}`, sheet: "경고 이력", header: ALERT_HEADER, rows: alertRows(log) };
  }

  // 전체 보고서용: 수조 × 날짜 일별 전력량
  function dailyWide() {
    const tanks = state.tanks.filter(t => state.history?.has(t.tank_id));
    const per = tanks.map(t => ({ t, days: new Map(dailyEnergy(state.history.get(t.tank_id)).map(d => [d.date, d])) }));
    const dates = [...new Set(per.flatMap(p => [...p.days.keys()]))].sort();
    const partial = new Set(dates.filter(d => per.some(p => (p.days.get(d)?.points ?? 0) < 288)));
    const header = ["수조 ID", "수조", ...dates.map(d => d + (partial.has(d) ? " (일부)" : "")), "합계(kWh)"];
    // 합계는 반올림 전 값으로 계산 (반올림한 셀을 더하면 오차가 쌓임)
    const raw = (p, d) => p.days.get(d)?.kwh ?? 0;
    const rows = per.map(p => [p.t.tank_id, p.t.tank_name,
      ...dates.map(d => p.days.has(d) ? num(raw(p, d), 3) : null),
      num(dates.reduce((a, d) => a + raw(p, d), 0), 3)]);
    const totals = dates.map(d => per.reduce((a, p) => a + raw(p, d), 0));
    rows.push(["", "합계", ...totals.map(v => num(v, 3)), num(totals.reduce((a, v) => a + v, 0), 3)]);
    return { sheet: "일별 전력량", header, rows };
  }

  // ---------- 파일 만들기 ----------
  function csvText(tb) {
    const cell = v => {
      if (v == null) return "";
      const s = String(v);
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return "﻿" + [tb.header, ...tb.rows].map(r => r.map(cell).join(",")).join("\r\n") + "\r\n";
  }
  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), { href: url, download: filename });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  let xlsxLoading = null;
  function loadXlsx() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (!xlsxLoading) xlsxLoading = new Promise((ok, fail) => {
      const s = document.createElement("script");
      s.src = XLSX_URL;
      s.onload = () => window.XLSX ? ok(window.XLSX) : fail(new Error("엑셀 라이브러리를 읽지 못했습니다."));
      s.onerror = () => { xlsxLoading = null; s.remove(); fail(new Error("엑셀 라이브러리(cdnjs)를 내려받지 못했습니다. 인터넷 연결을 확인하거나 CSV 를 사용하세요.")); };
      document.head.appendChild(s);
    });
    return xlsxLoading;
  }
  function sheetOf(XLSX, tb) {
    const ws = XLSX.utils.aoa_to_sheet([tb.header, ...tb.rows]);
    ws["!cols"] = tb.header.map((h, i) => {
      const w = Math.max(String(h).length * 2, ...tb.rows.slice(0, 300).map(r => r[i] == null ? 0 : String(r[i]).length * (/[가-힣]/.test(String(r[i])) ? 2 : 1)));
      return { wch: Math.min(40, Math.max(8, w + 2)) };
    });
    ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: tb.rows.length, c: tb.header.length - 1 } }) };
    return ws;
  }
  function addSheet(XLSX, wb, tb) {
    XLSX.utils.book_append_sheet(wb, sheetOf(XLSX, tb), tb.sheet.slice(0, 31));
  }

  async function exportOne(tb, fmt) {
    if (!tb.rows.length) { alert("내보낼 데이터가 없습니다."); return; }
    if (fmt === "csv") { download(new Blob([csvText(tb)], { type: "text/csv;charset=utf-8" }), tb.name + ".csv"); return; }
    const XLSX = await loadXlsx();
    const wb = XLSX.utils.book_new();
    addSheet(XLSX, wb, tb);
    XLSX.writeFile(wb, tb.name + ".xlsx");
  }

  async function exportReport() {
    if (!state.history) { alert("시간별 기록을 아직 불러오는 중입니다. 잠시 후 다시 눌러 주세요."); return; }
    const XLSX = await loadXlsx();
    const wb = XLSX.utils.book_new();
    const g = globalTable();
    addSheet(XLSX, wb, g);
    addSheet(XLSX, wb, dailyWide());
    addSheet(XLSX, wb, { sheet: "경고 이력", header: ALERT_HEADER, rows: alertRows(state.alertLog || state.alerts) });
    const s = computeSummary();
    addSheet(XLSX, wb, { sheet: "안내", header: ["항목", "내용"], rows: [
      ["보고서", "초음파 방오 장비 모니터링 — 전체 보고서"],
      ["데이터 기준 시각", kst(state.snapshot)],
      ["내보낸 시각", kst(new Date().toISOString())],
      ["장비 수", s.total], ["수신 장비 수", s.received],
      ["현재 총 전력(W)", num(s.power, 1)],
      ["평균 수온(℃)", num(s.temp, 1)], ["평균 수위(%)", num(s.level, 1)], ["평균 탁도(NTU)", num(s.turb, 2)],
      ["전력량 계산식", "Σ power_w × (5/60) ÷ 1000 (5분 간격, 수신 없는 시점은 0)"],
      ["'(일부)' 표시", "하루 288개 시점을 다 채우지 못한 날"],
      ["주의", "교육용 가상(합성) 데이터입니다. 실제 장비 측정값이 아닙니다."]] });
    XLSX.writeFile(wb, `전체_보고서_${stamp()}.xlsx`);
  }

  // ---------- 버튼 ----------
  document.addEventListener("click", async e => {
    const btn = e.target.closest(".export-btns button");
    if (!btn) return;
    e.stopPropagation();
    const kind = btn.closest(".export-btns").dataset.export, fmt = btn.dataset.fmt;
    const t = selectedTank();
    const make = { global: globalTable, history: () => historyTable(t), daily: () => dailyTable(t), alerts: () => alertsTable(t) }[kind];
    if (!make || (kind !== "global" && !t)) return;
    const old = btn.textContent;
    btn.disabled = true;
    if (fmt !== "csv") btn.textContent = "준비 중…";
    try {
      if (fmt === "report") await exportReport();
      else await exportOne(make(), fmt);
    } catch (err) {
      alert(err.message);
    } finally {
      // 실시간 갱신으로 버튼이 다시 그려졌을 수도 있음
      btn.disabled = false; btn.textContent = old;
    }
  });

  // 테스트·디버깅용
  window.exportTables = { globalTable, historyTable, dailyTable, alertsTable, dailyWide, csvText };
})();
