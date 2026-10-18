# Connecting the Customer's Live Fleet APIs

CALIBR8 is a single-customer workspace that can connect to multiple live API endpoints.

## Workflow

1. Sign in.
2. Click **Manage APIs**.
3. Add API connection 1, 2, 3, etc.
4. Use **Test** to confirm the response can be normalized.
5. Click **Refresh fleet**.
6. Select an API source or view **All connections**.
7. Press **Monitor** on the desired car.

The main dashboard then switches to that vehicle's route, telemetry, physics and AI results.

## Default JSON mapping

No custom mapping is required for an API that returns records like:

```json
{
  "deviceId": "075034653492",
  "dateTime": 1777537773,
  "latitude": 3.0253583,
  "longitude": 101.61429,
  "speed": 10.7,
  "direction": "005.36"
}
```

## Multiple vehicles in one response

If one endpoint returns an array containing multiple `deviceId` values, CALIBR8 groups the rows by device, sorts each group by timestamp, and displays each device as a separate fleet vehicle.

## GPS-only feeds

If the provider does not supply IMU acceleration, CALIBR8 derives an estimated longitudinal acceleration from consecutive speed/timestamp samples. The UI labels this source as `derived_from_gps_speed` rather than treating it as measured IMU data.

## API authentication

Headers may be entered as JSON, for example:

```json
{
  "Authorization": "Bearer YOUR_PROVIDER_TOKEN"
}
```

They are encrypted server-side with `CONNECTION_ENCRYPTION_KEY` before storage. They are never returned to the browser after saving.

## URL security

By default `ALLOW_PRIVATE_API_HOSTS=false`, which blocks loopback, private, link-local, multicast and reserved network targets. This reduces SSRF risk for an internet-facing dashboard.
