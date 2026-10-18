from __future__ import annotations
import math
from datetime import datetime, timezone

DEMO_PATH=[
    (3.13900,101.68685),(3.13925,101.68720),(3.13955,101.68765),(3.13990,101.68815),
    (3.14030,101.68855),(3.14070,101.68890),(3.14110,101.68920),(3.14148,101.68955),
    (3.14180,101.68995),(3.14205,101.69035),(3.14228,101.69080),(3.14245,101.69125),
    (3.14260,101.69170),(3.14278,101.69210),(3.14305,101.69248),(3.14335,101.69280),
]

def demo_payload(step:int):
    hard_phase=step%28
    speed=max(6.0,52+8*math.sin(step/7))
    if hard_phase in (0,1):
        peak=-6.2 if hard_phase==0 else -4.8; mean=peak*0.67; dur=1.5; drop=min(speed,abs(mean)*dur*3.6); jerk=peak/0.38
    else:
        peak=-(0.45+0.55*abs(math.sin(step/5))); mean=peak*0.62; dur=1.1; drop=min(speed,abs(mean)*dur*3.6); jerk=peak/0.65
    post=max(0.0,speed-drop)
    lat,lon=DEMO_PATH[step%len(DEMO_PATH)]
    weather='light_rain' if (step//45)%2 else 'clear'; surface='wet_asphalt' if weather!='clear' else 'dry_asphalt'
    now=datetime.now(timezone.utc).isoformat()
    telemetry={'pre_event_speed_kmh':round(speed,2),'post_event_speed_kmh':round(post,2),'speed_drop_kmh':round(drop,2),
               'peak_deceleration_mps2':round(peak,3),'mean_deceleration_mps2':round(mean,3),'max_jerk_mps3':round(jerk,3),
               'event_duration_sec':dur,'gps_quality':'high','sensor_quality':'high','timestamp_start':now}
    gps={'lat':lat,'lon':lon,'speed_kmh':round(speed,2),'heading_deg':(step*17)%360,'timestamp':now}
    context={'vehicle_type':'passenger_car','road_type':'urban','traffic_density':'medium','weather':weather,'road_surface':surface,'road_grade_ratio':0.0}
    return telemetry,gps,context
