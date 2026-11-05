"""실시간 가상 데이터 시뮬레이터 (표준 Python만 사용).

실행:  python live_simulator.py            # 5초마다 5분치 측정값 1회 추가
       python live_simulator.py --interval 2 --seed 7

동작 (매 회차):
  1. 마지막 기록 다음 시각(+5분)의 측정값을 30개 수조 모두 생성
  2. sensor_history.csv 끝에 추가 (최근 7일치만 유지)
  3. current_status.csv, alerts.csv, dashboard_data.json 을 새 값으로 다시 저장
     dashboard_data.json 의 recent_history 에 최근 기록을 함께 넣어
     대시보드가 큰 CSV를 다시 받지 않고 새 행만 이어 붙일 수 있게 함

수조마다 평소 기준값(기록 앞부분 평균) 주변에서 움직이고, 가끔 이상 상황
(고수온·저수위·고탁도·장비 정지·통신 끊김)이 생겼다가 일정 시간 뒤 회복됩니다.
처음 실행 시 기존 이상 상황 5건은 이어서 진행되다가 회복됩니다.

원래 데이터로 되돌리기:  python generate_data.py
모든 값은 교육용 합성 데이터입니다.
"""
import argparse, csv, json, os, random, time
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path

OUT = Path(__file__).resolve().parent
STEP = timedelta(minutes=5)
KEEP_TICKS = 7 * 24 * 12          # 7일치 (5분 간격)
RECENT_TICKS = 24                 # dashboard_data.json 에 넣는 최근 기록 (2시간)
TRIM_EVERY = 120                  # 이 횟수마다 CSV 를 7일치로 다시 저장
SENSORS = ['temperature_c', 'water_level_pct', 'turbidity_ntu', 'power_w']
DIGITS = {'temperature_c': 1, 'water_level_pct': 1, 'turbidity_ntu': 2, 'power_w': 1}
HIST_FIELDS = ['timestamp', 'tank_id', 'device_id', *SENSORS, 'is_online', 'device_state',
               'status', 'alert_codes', 'last_seen', 'is_synthetic']
TANK_FIELDS = ['tank_id', 'device_id', 'tank_name', 'floor', 'zone', 'location', 'description',
               'capacity_l', 'rated_power_w', 'ultrasonic_frequency_khz', 'is_synthetic']
ALERT_FIELDS = ['event_id', 'tank_id', 'device_id', 'alert_code', 'severity', 'started_at',
                'ended_at', 'is_active', 'is_synthetic']
# 이상 상황 종류 → (센서, 목표값 범위)
INCIDENTS = {
    'temperature_out_of_range': ('temperature_c', (28.6, 30.4)),
    'low_water_level': ('water_level_pct', (38, 58)),
    'high_turbidity': ('turbidity_ntu', (5.5, 11)),
    'device_stopped': ('power_w', (0, 0)),
    'communication_lost': (None, None),
}


# ---------------- 파일 입출력 ----------------
def read_csv(name):
    with (OUT / name).open(encoding='utf-8-sig', newline='') as f:
        return list(csv.DictReader(f))

def num(s):
    return None if s in ('', None) else float(s)

def to_bool(s):
    return s is True or s == 'True'

def csv_value(v):
    return '' if v is None else v

def replace_file(path, write):
    """임시 파일에 쓴 뒤 교체. 웹 서버가 읽는 중이면 잠시 후 재시도 (Windows)."""
    tmp = path.with_name(path.name + '.tmp')
    write(tmp)
    for _ in range(20):
        try:
            os.replace(tmp, path); return
        except PermissionError:
            time.sleep(0.1)
    os.replace(tmp, path)

def write_csv(name, fields, rows):
    def w(p):
        with p.open('w', encoding='utf-8-sig', newline='') as f:
            wr = csv.DictWriter(f, fieldnames=fields)
            wr.writeheader()
            wr.writerows({k: csv_value(r.get(k)) for k in fields} for r in rows)
    replace_file(OUT / name, w)

def write_json(name, obj):
    text = json.dumps(obj, ensure_ascii=False, indent=2, allow_nan=False)
    replace_file(OUT / name, lambda p: p.write_text(text, encoding='utf-8'))


# ---------------- 판정 (generate_data.py 와 같은 기준) ----------------
def load_rules():
    return json.loads((OUT / 'thresholds.json').read_text(encoding='utf-8'))

def classify(row, rules):
    if not row['is_online']:
        return 'offline', ['communication_lost']
    if row['power_w'] == 0:
        return 'critical', ['device_stopped']
    t, l, u, p = (row[k] for k in SENSORS)
    T, L, U, P = (rules[k] for k in SENSORS)
    flags, critical = [], False
    if t < T['warning_below'] or t > T['warning_above']:
        flags.append('temperature_out_of_range')
        critical |= t <= T['critical_below_or_equal'] or t >= T['critical_above_or_equal']
    if l < L['warning_below']:
        flags.append('low_water_level'); critical |= l < L['critical_below']
    if u > U['warning_above']:
        flags.append('high_turbidity'); critical |= u >= U['critical_above_or_equal']
    if p < P['warning_below'] or p > P['warning_above']:
        flags.append('power_out_of_range'); critical |= p >= P['critical_above_or_equal']
    return ('critical' if critical else 'warning' if flags else 'normal'), flags


# ---------------- 시뮬레이터 ----------------
class Simulator:
    def __init__(self, seed, incident_rate):
        self.R = random.Random(seed)
        self.rate = incident_rate
        self.rules = load_rules()
        self.tanks = read_csv('tanks.csv')
        self.history = read_csv('sensor_history.csv')
        self.alerts = [dict(a, is_active=to_bool(a['is_active']), ended_at=a['ended_at'] or None,
                            is_synthetic=True) for a in read_csv('alerts.csv')]
        self.event_no = max((int(a['event_id'].split('-')[1]) for a in self.alerts), default=0)
        self.ticks = 0

        by_tank = {}
        for r in self.history:
            by_tank.setdefault(r['tank_id'], []).append(r)
        self.base, self.last, self.incident = {}, {}, {}
        for t in self.tanks:
            rows = by_tank.get(t['tank_id'], [])
            early = rows[:288] or rows          # 앞쪽 하루 = 이상 상황 이전의 평소 값
            self.base[t['tank_id']] = {
                k: sum(v for v in (num(r[k]) for r in early) if v is not None) /
                   max(1, sum(1 for r in early if num(r[k]) is not None))
                for k in SENSORS}
            valid = [r for r in rows if num(r['temperature_c']) is not None]
            last_valid = valid[-1] if valid else None
            self.last[t['tank_id']] = {
                **{k: num(last_valid[k]) if last_valid else self.base[t['tank_id']][k] for k in SENSORS},
                'last_seen': rows[-1]['last_seen'] if rows else None}
            # 기존 이상 상황은 이어서 진행
            codes = rows[-1]['alert_codes'].split('|') if rows and rows[-1]['alert_codes'] else []
            for code in codes:
                if code in INCIDENTS:
                    self.start_incident(t['tank_id'], code, keep_current=True)
                    break
        self.now = datetime.fromisoformat(self.history[-1]['timestamp'])

    def start_incident(self, tid, code, keep_current=False):
        key, rng = INCIDENTS[code]
        if key is None:
            target = None
        elif keep_current and code != 'device_stopped':
            target = self.last[tid][key]
        else:
            target = round(self.R.uniform(*rng), DIGITS[key]) if rng[0] != rng[1] else rng[0]
        self.incident[tid] = {'code': code, 'key': key, 'target': target,
                              'remaining': self.R.randint(12, 48)}   # 1~4시간 (가상 시간)

    def step_value(self, tid, key):
        base, prev = self.base[tid][key], self.last[tid][key]
        inc = self.incident.get(tid)
        if inc and inc['key'] == key:
            if key == 'power_w':
                return 0.0
            goal, pull = inc['target'], 0.25        # 이상값 쪽으로 빠르게 이동
        else:
            goal, pull = base, 0.08                 # 평소 값으로 천천히 회복
        if key == 'power_w' and prev == 0:
            prev = base * 0.6                        # 정지 후 재가동
        noise = {'temperature_c': 0.08, 'water_level_pct': 0.25,
                 'turbidity_ntu': 0.05, 'power_w': 1.2}[key]
        v = prev + pull * (goal - prev) + self.R.gauss(0, noise)
        v = {'water_level_pct': min(100, max(0, v)), 'turbidity_ntu': max(0.1, v),
             'power_w': max(0.5, v)}.get(key, v)
        return round(v, DIGITS[key])

    def tick(self):
        self.now += STEP
        ts = self.now.isoformat()
        rows = []
        for t in self.tanks:
            tid = t['tank_id']
            inc = self.incident.get(tid)
            if inc:
                inc['remaining'] -= 1
                if inc['remaining'] < 0:
                    del self.incident[tid]; inc = None
            elif self.R.random() < self.rate:
                self.start_incident(tid, self.R.choice(list(INCIDENTS)))
                inc = self.incident[tid]

            online = not (inc and inc['code'] == 'communication_lost')
            row = {'timestamp': ts, 'tank_id': tid, 'device_id': t['device_id'], 'is_online': online}
            if online:
                for k in SENSORS:
                    row[k] = self.last[tid][k] = self.step_value(tid, k)
                self.last[tid]['last_seen'] = ts
            else:
                row.update({k: None for k in SENSORS})
            row['device_state'] = 'offline' if not online else 'stopped' if row['power_w'] == 0 else 'running'
            status, flags = classify(row, self.rules)
            row.update(status=status, alert_codes='|'.join(flags),
                       last_seen=self.last[tid]['last_seen'], is_synthetic=True)
            self.update_alerts(t, row, flags, status, ts)
            rows.append(row)
        return rows

    def update_alerts(self, tank, row, flags, status, ts):
        tid = tank['tank_id']
        for a in self.alerts:
            if a['tank_id'] == tid and a['is_active'] and a['alert_code'] not in flags:
                a.update(is_active=False, ended_at=ts)
        active = {a['alert_code'] for a in self.alerts if a['tank_id'] == tid and a['is_active']}
        for code in flags:
            if code not in active:
                self.event_no += 1
                self.alerts.append(dict(event_id=f'EVT-{self.event_no:04d}', tank_id=tid,
                                        device_id=tank['device_id'], alert_code=code, severity=status,
                                        started_at=ts, ended_at=None, is_active=True, is_synthetic=True))

    def save(self, rows):
        # 1) 기록 추가 (CSV 먼저 → JSON 나중: 대시보드가 JSON을 보고 CSV를 다시 읽어도 빠짐 없음)
        self.history.extend({k: csv_value(r.get(k)) for k in HIST_FIELDS} for r in rows)
        self.ticks += 1
        if self.ticks % TRIM_EVERY == 0 or len(self.history) > (KEEP_TICKS + TRIM_EVERY) * len(self.tanks):
            self.history = self.history[-KEEP_TICKS * len(self.tanks):]
            write_csv('sensor_history.csv', HIST_FIELDS, self.history)
        else:
            with (OUT / 'sensor_history.csv').open('a', encoding='utf-8', newline='') as f:
                csv.DictWriter(f, fieldnames=HIST_FIELDS).writerows(
                    {k: csv_value(r.get(k)) for k in HIST_FIELDS} for r in rows)

        # 2) 현재 상태
        tank_by_id = {t['tank_id']: t for t in self.tanks}
        current = []
        for r in rows:
            t = tank_by_id[r['tank_id']]
            current.append({
                **{k: t[k] for k in TANK_FIELDS},
                'floor': int(t['floor']), 'zone': int(t['zone']), 'capacity_l': int(t['capacity_l']),
                'rated_power_w': int(t['rated_power_w']),
                'ultrasonic_frequency_khz': float(t['ultrasonic_frequency_khz']), 'is_synthetic': True,
                **r})
        write_csv('current_status.csv', TANK_FIELDS + HIST_FIELDS[0:1] + SENSORS + HIST_FIELDS[7:12],
                  current)
        ended = [a for a in self.alerts if not a['is_active']]
        if len(ended) > 500:                         # 끝난 이벤트는 최근 500건만 보관
            drop = {id(a) for a in ended[:-500]}
            self.alerts = [a for a in self.alerts if id(a) not in drop]
        write_csv('alerts.csv', ALERT_FIELDS, self.alerts)

        # 3) 대시보드용 JSON
        online = [r for r in current if r['is_online']]
        cnt = Counter(r['status'] for r in current)
        avg = lambda k, d: round(sum(r[k] for r in online) / len(online), d) if online else None
        summary = dict(
            timestamp=self.now.isoformat(), total_devices=len(current), online_devices=len(online),
            offline_devices=len(current) - len(online), normal_devices=cnt['normal'],
            warning_devices=cnt['warning'], critical_devices=cnt['critical'],
            abnormal_devices=len(current) - cnt['normal'],
            known_total_power_w=round(sum(r['power_w'] for r in online), 1),
            power_is_partial=len(online) < len(current),
            average_temperature_c=avg('temperature_c', 1), average_water_level_pct=avg('water_level_pct', 1),
            average_turbidity_ntu=avg('turbidity_ntu', 2), valid_sensor_count=len(online), is_synthetic=True)
        recent = self.history[-RECENT_TICKS * len(self.tanks):]
        write_json('dashboard_data.json', dict(
            metadata=dict(is_synthetic=True, live=True, timezone='Asia/Seoul', interval_minutes=5,
                          history_rows=len(self.history), updated_at=datetime.now().astimezone().isoformat(),
                          note='교육용 가상 데이터 (live_simulator.py 실시간 생성).'),
            summary=summary, tanks=current,
            alerts=[a for a in self.alerts if a['is_active']] + [a for a in self.alerts if not a['is_active']][-50:],
            thresholds={k: self.rules[k] for k in [*SENSORS, 'offline']},
            recent_history=[{k: (num(r[k]) if k in SENSORS else r[k]) for k in
                             ['timestamp', 'tank_id', *SENSORS, 'status']} for r in recent]))
        return summary


def main():
    ap = argparse.ArgumentParser(description='실시간 가상 센서 데이터 생성')
    ap.add_argument('--interval', type=float, default=5, help='실제 대기 시간(초). 회차마다 가상 시간 5분 진행')
    ap.add_argument('--incident-rate', type=float, default=0.004, help='회차·수조당 새 이상 상황 발생 확률')
    ap.add_argument('--seed', type=int, default=None, help='난수 seed (지정 시 같은 흐름 재현)')
    ap.add_argument('--ticks', type=int, default=0, help='이 횟수만큼 실행 후 종료 (0 = 계속)')
    args = ap.parse_args()

    sim = Simulator(args.seed, args.incident_rate)
    print(f'시작: {sim.now.isoformat()} 이후부터 {args.interval}초마다 5분치 추가. 중지: Ctrl+C')
    n = 0
    try:
        while True:
            s = sim.save(sim.tick())
            n += 1
            print(f"[{datetime.now():%H:%M:%S}] {s['timestamp']}  전력 {s['known_total_power_w']} W  "
                  f"수온 {s['average_temperature_c']}  이상 {s['abnormal_devices']}대", flush=True)
            if args.ticks and n >= args.ticks:
                break
            time.sleep(args.interval)
    except KeyboardInterrupt:
        print('\n중지했습니다.')


if __name__ == '__main__':
    main()
