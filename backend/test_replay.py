from app.replay import build_replay_payload, list_scenarios
from app.models import ModelHub
from app.physics import physics_calculation


def run():
    hub = ModelHub()
    for info in list_scenarios():
        scenario = info['key']
        hi = info['harshInjectionIndex']
        normal = build_replay_payload(scenario, max(1, hi - 2), harsh_demo=False)
        harsh = build_replay_payload(scenario, hi, harsh_demo=True)

        assert normal['raw_api_output']['deviceId'] == info['deviceId']
        assert normal['raw_api_output']['isReplay'] is True
        assert harsh['harsh_event'] and harsh['harsh_event']['isHarshBraking'] is True

        normal_event = {**normal['telemetry'], **normal['context']}
        harsh_event = {**harsh['telemetry'], **harsh['context']}
        assert physics_calculation(normal_event)['physics_harsh_or_severe'] is False
        assert physics_calculation(harsh_event)['physics_harsh_or_severe'] is True
        assert hub.new_ai(normal_event, 'balanced')['harsh_or_severe'] is False
        assert hub.new_ai(harsh_event, 'balanced')['harsh_or_severe'] is True
        assert hub.friend_gbm(normal_event)['harsh_or_severe'] is False
        assert hub.friend_gbm(harsh_event)['harsh_or_severe'] is True
        print(f"PASS {scenario}: {info['points']} points; harsh at {hi}")


if __name__ == '__main__':
    run()
