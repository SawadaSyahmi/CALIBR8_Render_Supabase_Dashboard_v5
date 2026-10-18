from app.connections import latest_by_vehicle, telemetry_from_points, DEFAULT_MAPPING


def main():
    connection={
        'field_mapping':dict(DEFAULT_MAPPING),
        'timestamp_format':'epoch_seconds',
        'speed_unit':'kmh',
        'root_path':None,
    }
    payload=[
        {'deviceId':'CAR-1','dateTime':1000,'latitude':3.0,'longitude':101.0,'speed':50,'direction':'90'},
        {'deviceId':'CAR-2','dateTime':1001,'latitude':3.1,'longitude':101.1,'speed':25,'direction':'20'},
        {'deviceId':'CAR-1','dateTime':1002,'latitude':3.01,'longitude':101.01,'speed':32,'direction':'90'},
    ]
    groups=latest_by_vehicle(payload,connection)
    assert set(groups)=={'CAR-1','CAR-2'}
    assert groups['CAR-1'][-1]['speed_kmh']==32
    t=telemetry_from_points(groups['CAR-1'][-1],groups['CAR-1'][-2])
    assert t['speed_drop_kmh']==18
    assert t['peak_deceleration_mps2']<0
    print('PASS customer connection adapter:',len(groups),'vehicles; derived decel',round(t['peak_deceleration_mps2'],3))

if __name__=='__main__': main()
