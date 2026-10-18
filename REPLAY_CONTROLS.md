# Replay Controls

The built-in sample routes are retained for demonstration and model testing.

- **Start** — resume replay.
- **Pause** — stop advancing points.
- **Restart** — reset the route cursor and start a new Supabase trip.
- **1x / 5x / 10x / 30x** — scale recorded timestamp spacing.
- **Compress long gaps** — caps long source gaps before speed scaling.
- **Inject Harsh Event Now** — creates a controlled harsh-braking event at the current route location and immediately evaluates physics, New CALIBR8-AI and Friend GBM.

A 150 ms minimum delay prevents overlapping high-rate requests to Render/Supabase during accelerated replay.
