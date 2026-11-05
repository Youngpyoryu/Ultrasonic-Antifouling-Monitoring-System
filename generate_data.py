"""표준 Python만 사용. python generate_data.py 실행 시 같은 폴더에 데이터 재생성."""
import csv, json, math, random
from pathlib import Path
from datetime import datetime, timedelta, timezone
from collections import Counter

OUT = Path(__file__).resolve().parent
R = random.Random(42)
KST = timezone(timedelta(hours=9))
END = datetime(2026,11,3,16,0,tzinfo=KST)
N = 7*24*12
names = ['로비 수족관','메인 전시 수족관','유어 전시관','해수 수족관','터널 수족관','산호 전시 수족관','치료/격리 수조','새우/게 전시 수조','연구실 실험 수조','백업 예비 수조','생태 수조 1','생태 수조 2','생태 수조 3','생태 수조 4','내부 관리 수조 A','내부 관리 수조 B','해파리 수조','열대어 수조','담수 수조','야간 전시 수조','산호 증식 수조','치어 사육 수조','해마 수조','패류 수조','양서류 수조','수질 관리 수조','검역 수조','교육 체험 수조','특별 전시 수조','예비 수조 C']
def save_csv(name, rows):
    with (OUT/name).open('w',encoding='utf-8-sig',newline='') as f:
        w=csv.DictWriter(f,fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)
def save_json(name, obj):
    (OUT/name).write_text(json.dumps(obj,ensure_ascii=False,indent=2,allow_nan=False),encoding='utf-8')

# 임의의 교육용 기준. 실제 장비/생물종별 운영 기준이 아님.
rules = {
 'temperature_c': {'warning_below':20,'warning_above':28,'critical_below_or_equal':18,'critical_above_or_equal':30},
 'water_level_pct': {'warning_below':60,'critical_below':40},
 'turbidity_ntu': {'warning_above':5,'critical_above_or_equal':10},
 'power_w': {'warning_below':15,'warning_above':130,'critical_above_or_equal':150},
 'offline': {'missing_sensor_packet':True},
}
def classify(row):
    if not row['is_online']: return 'offline',['communication_lost']
    t,l,u,p=[row[k] for k in ['temperature_c','water_level_pct','turbidity_ntu','power_w']]
    flags=[]; critical=False
    if t<20 or t>28: flags.append('temperature_out_of_range'); critical |= t<=18 or t>=30
    if l<60: flags.append('low_water_level'); critical |= l<40
    if u>5: flags.append('high_turbidity'); critical |= u>=10
    if p<15 or p>130: flags.append('power_out_of_range'); critical |= p>=150
    return ('critical' if critical else 'warning' if flags else 'normal'),flags

tanks=[]; history=[]; current=[]; events=[]
for i,name in enumerate(names,1):
    tid=f'TANK-{i:03d}'; did=f'US-{i:03d}'
    floor=(i-1)%5+1; rating=R.choice([60,80,100,120])
    tank=dict(tank_id=tid,device_id=did,tank_name=name,floor=floor,zone=i,location=f'{floor}층 구역 {i}',description='초음파 방오 모니터링 교육용 가상 수조',capacity_l=R.choice([500,1000,2000,5000,10000]),rated_power_w=rating,ultrasonic_frequency_khz=40.0,is_synthetic=True)
    tanks.append(tank)
    base_t=R.uniform(22,25.5); base_l=R.uniform(72,94); base_u=R.uniform(.5,3); base_p=rating*R.uniform(.65,.9); phase=R.uniform(0,math.tau)
    last_seen=None; active={}
    for j in range(N):
        ts=END-timedelta(minutes=5*(N-1-j)); wave=math.sin(j*math.tau/288+phase)
        row=dict(timestamp=ts.isoformat(),tank_id=tid,device_id=did,temperature_c=round(base_t+.5*wave+R.gauss(0,.08),1),water_level_pct=round(base_l+1.5*math.sin(j*math.tau/430+phase)+R.gauss(0,.2),1),turbidity_ntu=round(max(.1,base_u+.15*wave+R.gauss(0,.04)),2),power_w=round(max(0,base_p+2*wave+R.gauss(0,1)),1),is_online=True)
        # 마지막 2시간: 고수온, 저수위, 고탁도, 장비 정지, 통신 끊김.
        progress=max(0,(j-(N-25))/24)
        if i==6: row['temperature_c']=round(row['temperature_c']+(29.2-base_t)*progress,1)
        if i==12: row['water_level_pct']=round(row['water_level_pct']+(52-base_l)*progress,1)
        if i==18: row['turbidity_ntu']=round(row['turbidity_ntu']+(7.5-base_u)*progress,2)
        if i==24 and j>=N-12: row['power_w']=0.0
        if i==30 and j>=N-6:
            row['is_online']=False
            for k in ['temperature_c','water_level_pct','turbidity_ntu','power_w']: row[k]=None
        else: last_seen=ts.isoformat()
        row['device_state']='offline' if not row['is_online'] else 'stopped' if row['power_w']==0 else 'running'
        status,flags=classify(row)
        # 장비 정지는 즉각 확인할 수 있도록 critical로 표시.
        if row['device_state']=='stopped': status='critical'; flags=['device_stopped']
        row.update(status=status,alert_codes='|'.join(flags),last_seen=last_seen,is_synthetic=True)
        history.append(row)
        for code in list(active):
            if code not in flags:
                e=active.pop(code); e['ended_at']=ts.isoformat(); e['is_active']=False
        for code in flags:
            if code not in active:
                e=dict(event_id=f'EVT-{len(events)+1:04d}',tank_id=tid,device_id=did,alert_code=code,severity=status,started_at=ts.isoformat(),ended_at=None,is_active=True,is_synthetic=True)
                events.append(e); active[code]=e
        if j==N-1: current.append({**tank,**row})
history.sort(key=lambda r:(r['timestamp'],r['tank_id']))
online=[r for r in current if r['is_online']]
counts=Counter(r['status'] for r in current)
summary=dict(timestamp=END.isoformat(),total_devices=30,online_devices=len(online),offline_devices=30-len(online),normal_devices=counts['normal'],warning_devices=counts['warning'],critical_devices=counts['critical'],abnormal_devices=30-counts['normal'],known_total_power_w=round(sum(r['power_w'] for r in online),1),power_is_partial=len(online)<30,average_temperature_c=round(sum(r['temperature_c'] for r in online)/len(online),1),average_water_level_pct=round(sum(r['water_level_pct'] for r in online)/len(online),1),average_turbidity_ntu=round(sum(r['turbidity_ntu'] for r in online)/len(online),2),valid_sensor_count=len(online),is_synthetic=True)
save_csv('tanks.csv',tanks); save_csv('sensor_history.csv',history); save_csv('current_status.csv',current); save_csv('alerts.csv',events)
save_json('dashboard_data.json',dict(metadata=dict(is_synthetic=True,seed=42,timezone='Asia/Seoul',interval_minutes=5,history_rows=len(history),note='교육용 가상 데이터. 스크린샷 수치를 그대로 복제한 데이터는 아닙니다.'),summary=summary,tanks=current,alerts=events,thresholds=rules))
save_json('thresholds.json',{**rules,'device_stopped':{'power_w_equals':0,'severity':'critical'},'note':'교육용 임의 기준. 실제 설치 기준으로 사용하지 마세요.'})
assert len(history)==60480 and len(current)==30 and len({r['tank_id'] for r in tanks})==30
assert counts=={'normal':25,'warning':3,'critical':1,'offline':1},counts
for r in current:
    assert next(x for x in reversed(history) if x['tank_id']==r['tank_id'])['power_w']==r['power_w']
assert sum(counts.values())==30
print(json.dumps({'rows':len(history),'summary':summary,'events':len(events)},ensure_ascii=False,indent=2))
