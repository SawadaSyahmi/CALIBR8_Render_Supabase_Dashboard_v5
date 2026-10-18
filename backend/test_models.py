from app.models import ModelHub
from app.physics import physics_calculation

def main():
    event={'pre_event_speed_kmh':60,'post_event_speed_kmh':42,'speed_drop_kmh':18,'peak_deceleration_mps2':-5.8,'mean_deceleration_mps2':-4.0,'max_jerk_mps3':-9.0,'event_duration_sec':1.5,'vehicle_type':'passenger_car','road_type':'urban','traffic_density':'medium','weather':'clear','road_surface':'dry_asphalt','road_grade_ratio':0.0,'gps_quality':'high','sensor_quality':'high','speed_regime':'medium','timestamp_start':'2026-10-04T12:00:00Z'}
    hub=ModelHub(); print('physics:',physics_calculation(event)); print('new_ai:',hub.new_ai(event)); print('friend_gbm:',hub.friend_gbm(event))
if __name__=='__main__': main()
