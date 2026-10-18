"""Read-only deployment checks plus temporary sample evaluation; no live writes."""
import getpass
import sys
from urllib.parse import urlparse
import httpx


def main():
    if len(sys.argv) != 2:
        print('Usage: python scripts/check_deployment.py https://YOUR_SERVICE.onrender.com')
        return 2
    base = sys.argv[1].rstrip('/')
    parsed = urlparse(base)
    if parsed.scheme != 'https' and not (parsed.scheme == 'http' and parsed.hostname in {'127.0.0.1', 'localhost', '::1'}):
        print('Use an HTTPS dashboard URL, or HTTP localhost for development.')
        return 2
    failed = False
    with httpx.Client(base_url=base, timeout=90, follow_redirects=False) as client:
        try:
            health = client.get('/api/health')
            health.raise_for_status()
            if health.json().get('version') != '7.0.0':
                raise ValueError('This service is not running the rebuilt project.')
            print('PASS service and application version')
            email = input('Supabase account email: ').strip()
            password = getpass.getpass('Password (hidden): ')
            response = client.post('/api/auth/login', json={'email': email, 'password': password})
            password = ''
            response.raise_for_status()
            session = client.get('/api/auth/session')
            session.raise_for_status()
            print('PASS sign-in and saved cookie session')
            diagnostics = client.get('/api/diagnostics')
            if diagnostics.is_success and diagnostics.json().get('ok'):
                print('PASS database access and migration')
            else:
                failed = True
                print('FAIL database check. Run the included SQL migration and check Supabase permissions.')
            request = {'run_id': 'deployment-check', 'scenario': 'route_1', 'index': 10}
            sample = client.post('/api/replay/step', json=request)
            sample.raise_for_status()
            frame = sample.json()
            assert frame['schema_version'] == 7 and frame['physics']['a_available_mps2'] > 0
            assert frame['telemetry']['peak_deceleration_mps2'] != 0
            print('PASS sample telemetry, physics and model response')
            harsh = client.post('/api/replay/step', json={**request, 'inject': True})
            harsh.raise_for_status()
            frame = harsh.json()
            assert frame['models']['new_ai']['harsh_or_severe'] and frame['models']['friend_gbm']['harsh_or_severe']
            print('PASS controlled harsh event detected by both models')
        except (httpx.HTTPError, ValueError, KeyError, AssertionError) as exc:
            print('FAIL deployment check:', type(exc).__name__, str(exc)[:200])
            failed = True
        finally:
            try:
                client.post('/api/auth/logout')
            except httpx.HTTPError:
                pass
    return 1 if failed else 0


if __name__ == '__main__':
    raise SystemExit(main())
