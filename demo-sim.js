/* 브라우저 안 실시간 시뮬레이션 (데모 모드)
 * 정적 호스팅(GitHub Pages)에서는 서버가 데이터를 갱신할 수 없으므로,
 * 페이지를 연 브라우저가 live_simulator.py 와 같은 규칙으로 5초마다 다음 5분치 측정값을 만듭니다.
 *   - 수조마다 평소 값(기록 첫날 평균) 주변에서 움직임
 *   - 가끔 이상 상황(고수온·저수위·고탁도·장비 정지·통신 끊김)이 생겼다가 1~4시간(가상) 뒤 회복
 *   - 처음 열 때 진행 중이던 이상 상황은 이어서 진행되다가 회복
 *   - 판정은 thresholds 와 같은 기준, 경고 발생·해제를 경고 이력에 기록
 * 결과는 화면 메모리(state)에만 반영되며 파일은 바뀌지 않습니다. 새로고침하면 원래 데이터부터 다시 시작합니다.
 * 보는 사람마다 서로 다른 상황이 펼쳐집니다.
 *
 * 켜지는 조건: *.github.io 에서 열었거나 주소에 ?demo=1. ?demo=0 이면 끔.
 * 속도: ?speed=2 (2초마다 5분), 기본 5초.
 */
(() => {
  const params = new URLSearchParams(location.search);
  const flag = params.get("demo");
  const enabled = flag === "1" || (flag !== "0" && /\.github\.io$/i.test(location.hostname));
  const intervalMs = Math.max(500, (Number(params.get("speed")) || 5) * 1000);
  const STEP_MS = 5 * 60 * 1000;
  const INCIDENT_RATE = 0.004;          // 회차·수조당 새 이상 상황 확률 (live_simulator.py 기본값과 같음)
  const KEYS = ["temperature_c", "water_level_pct", "turbidity_ntu", "power_w"];
  const DIGITS = { temperature_c: 1, water_level_pct: 1, turbidity_ntu: 2, power_w: 1 };
  const NOISE = { temperature_c: 0.08, water_level_pct: 0.25, turbidity_ntu: 0.05, power_w: 1.2 };
  const INCIDENTS = {
    temperature_out_of_range: ["temperature_c", [28.6, 30.4]],
    low_water_level: ["water_level_pct", [38, 58]],
    high_turbidity: ["turbidity_ntu", [5.5, 11]],
    device_stopped: ["power_w", [0, 0]],
    communication_lost: [null, null],
  };

  const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
  const uniform = (a, b) => a + Math.random() * (b - a);
  const randint = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
  const gauss = (sd) => {                                    // Box-Muller
    let u = 0; while (!u) u = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random()) * sd;
  };
  // +09:00 ISO 문자열 (원본 데이터와 같은 형식)
  const isoKst = ms => new Date(ms + 9 * 3600e3).toISOString().slice(0, 19) + "+09:00";

  // generate_data.py / live_simulator.py 의 classify 와 같은 규칙
  function classify(row) {
    if (!row.is_online) return ["offline", ["communication_lost"]];
    if (row.power_w === 0) return ["critical", ["device_stopped"]];
    const th = state.thresholds;
    const T = th.temperature_c, L = th.water_level_pct, U = th.turbidity_ntu, P = th.power_w;
    const { temperature_c: t, water_level_pct: l, turbidity_ntu: u, power_w: p } = row;
    const flags = []; let critical = false;
    if (t < T.warning_below || t > T.warning_above) { flags.push("temperature_out_of_range"); critical ||= t <= T.critical_below_or_equal || t >= T.critical_above_or_equal; }
    if (l < L.warning_below) { flags.push("low_water_level"); critical ||= l < L.critical_below; }
    if (u > U.warning_above) { flags.push("high_turbidity"); critical ||= u >= U.critical_above_or_equal; }
    if (p < P.warning_below || p > P.warning_above) { flags.push("power_out_of_range"); critical ||= p >= P.critical_above_or_equal; }
    return [critical ? "critical" : flags.length ? "warning" : "normal", flags];
  }

  const sim = { base: {}, last: {}, incident: {}, nowMs: 0, eventNo: 0, timer: null, running: false, ticks: 0 };

  function startIncident(tid, code, keepCurrent) {
    const [key, rng] = INCIDENTS[code];
    let target = null;
    if (key) target = keepCurrent && code !== "device_stopped" ? sim.last[tid][key]
      : rng[0] === rng[1] ? rng[0] : round(uniform(rng[0], rng[1]), DIGITS[key]);
    sim.incident[tid] = { code, key, target, remaining: randint(12, 48) };
  }

  function setup() {
    sim.nowMs = Date.parse(state.snapshot);
    if (!state.alertLog) state.alertLog = state.alerts.map(a => ({ ...a }));
    sim.eventNo = state.alertLog.reduce((m, a) => Math.max(m, parseInt(String(a.event_id).split("-")[1], 10) || 0), 0);
    for (const t of state.tanks) {
      const rows = state.history.get(t.tank_id);
      if (!rows?.length) continue;                       // 화면에서 새로 등록한 장비 등은 건너뜀
      const early = rows.slice(0, 288);
      sim.base[t.tank_id] = Object.fromEntries(KEYS.map(k => {
        const v = early.map(r => r[k]).filter(isNum);
        return [k, v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0];
      }));
      const lastValid = [...rows].reverse().find(r => isNum(r.temperature_c));
      sim.last[t.tank_id] = Object.fromEntries(KEYS.map(k => [k, lastValid ? lastValid[k] : sim.base[t.tank_id][k]]));
      sim.last[t.tank_id].last_seen = t.last_seen;
      const code = (t.alert_codes || "").split("|").find(c => INCIDENTS[c]);
      if (code) startIncident(t.tank_id, code, true);
    }
  }

  function stepValue(tid, key) {
    const base = sim.base[tid][key];
    let prev = sim.last[tid][key];
    const inc = sim.incident[tid];
    let goal = base, pull = 0.08;                          // 평소 값으로 천천히 회복
    if (inc && inc.key === key) {
      if (key === "power_w") return 0;
      goal = inc.target; pull = 0.25;                      // 이상값 쪽으로 빠르게 이동
    }
    if (key === "power_w" && prev === 0) prev = base * 0.6; // 정지 후 재가동
    let v = prev + pull * (goal - prev) + gauss(NOISE[key]);
    if (key === "water_level_pct") v = Math.min(100, Math.max(0, v));
    if (key === "turbidity_ntu") v = Math.max(0.1, v);
    if (key === "power_w") v = Math.max(0.5, v);
    return round(v, DIGITS[key]);
  }

  function updateAlerts(t, flags, status, ts) {
    for (const a of state.alertLog) {
      if (a.tank_id === t.tank_id && a.is_active && !flags.includes(a.alert_code)) { a.is_active = false; a.ended_at = ts; }
    }
    const active = new Set(state.alertLog.filter(a => a.tank_id === t.tank_id && a.is_active).map(a => a.alert_code));
    for (const code of flags) {
      if (active.has(code)) continue;
      sim.eventNo++;
      state.alertLog.push({ event_id: `EVT-${String(sim.eventNo).padStart(4, "0")}`, tank_id: t.tank_id, device_id: t.device_id,
        alert_code: code, severity: status, started_at: ts, ended_at: null, is_active: true, is_synthetic: true });
    }
  }

  function tick() {
    sim.nowMs += STEP_MS;
    const ts = isoKst(sim.nowMs);
    for (const t of state.tanks) {
      const tid = t.tank_id;
      if (!sim.base[tid]) continue;
      let inc = sim.incident[tid];
      if (inc) {
        if (--inc.remaining < 0) { delete sim.incident[tid]; inc = null; }
      } else if (Math.random() < INCIDENT_RATE) {
        const codes = Object.keys(INCIDENTS);
        startIncident(tid, codes[Math.floor(Math.random() * codes.length)], false);
        inc = sim.incident[tid];
      }
      const online = !(inc && inc.code === "communication_lost");
      const row = { is_online: online };
      for (const k of KEYS) row[k] = online ? (sim.last[tid][k] = stepValue(tid, k)) : null;
      if (online) sim.last[tid].last_seen = ts;
      const [status, flags] = classify(row);
      const device_state = !online ? "offline" : row.power_w === 0 ? "stopped" : "running";
      Object.assign(t, row, { timestamp: ts, device_state, status, alert_codes: flags.join("|"), last_seen: sim.last[tid].last_seen });
      updateAlerts(t, flags, status, ts);

      const rows = state.history.get(tid);
      rows.push({ ts, temperature_c: row.temperature_c, water_level_pct: row.water_level_pct,
                  turbidity_ntu: row.turbidity_ntu, power_w: row.power_w, status });
      if (rows.length > HISTORY_KEEP) rows.splice(0, rows.length - HISTORY_KEEP);
    }
    // 끝난 경고는 최근 500건만 보관 (live_simulator.py 와 같음)
    const ended = state.alertLog.filter(a => !a.is_active);
    if (ended.length > 500) {
      const drop = new Set(ended.slice(0, ended.length - 500));
      state.alertLog = state.alertLog.filter(a => !drop.has(a));
    }
    state.alerts = state.alertLog.filter(a => a.is_active);
    state.snapshot = ts;
    sim.ticks++;
  }

  function step() {
    try {
      tick();
      notifyDataListeners();    // 새 경고 알림
      renderKeepScroll();
      status();
    } catch (e) {
      console.error(e);
      stop();
      setLiveStatus("error", "데모 시뮬레이션 오류 · 새로고침해 주세요");
    }
  }
  function status() {
    setLiveStatus("on", `데모 실시간 · ${clock()} 갱신`);
  }
  function start() {
    clearInterval(sim.timer);
    sim.running = true;
    sim.timer = setInterval(step, intervalMs);
    status();
  }
  function stop() {
    clearInterval(sim.timer);
    sim.running = false;
    setLiveStatus("paused", "데모 일시 정지 · 클릭해서 다시 시작");
  }

  // ultra-dashboard.html 이 시작할 때 호출: true 를 돌려주면 파일 폴링 대신 데모를 씀
  window.demoMode = {
    enabled,
    async start() {
      clearInterval(live.timer);                          // 정적 파일 폴링은 쓰지 않음
      const el = document.getElementById("liveStatus");
      el.title = "브라우저가 5초마다 가상 측정값(5분치)을 직접 만듭니다. 보는 사람마다 데이터가 다르고, 새로고침하면 처음부터 다시 시작합니다. 클릭하면 멈추거나 다시 시작합니다.";
      el.onclick = () => sim.running ? stop() : (step(), start());
      setLiveStatus("idle", "데모 실시간 · 기록 불러오는 중…");
      try {
        await loadHistory();
      } catch (e) {
        setLiveStatus("error", "기록을 불러오지 못해 데모를 시작할 수 없습니다");
        return;
      }
      setup();
      start();
    },
    stats: () => ({ ticks: sim.ticks, snapshot: state.snapshot, incidents: { ...sim.incident } })
  };
})();
