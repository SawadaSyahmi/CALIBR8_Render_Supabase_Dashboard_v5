-- CALIBR8 7: rerunnable, non-destructive migration for a single organization.
-- Create authorized users manually and disable public sign-up in Supabase Auth.
-- All requests use the signed-in user's JWT. No service-role key is required.
begin;

create table if not exists public.api_connections (
  connection_id text primary key, data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create table if not exists public.live_state (
  vehicle_id text not null, kind text not null, data jsonb not null default '{}'::jsonb,
  server_updated_at timestamptz not null default now(), primary key(vehicle_id, kind)
);
create table if not exists public.trips (
  trip_id text primary key, vehicle_id text not null, data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create table if not exists public.route_points (
  id text primary key, vehicle_id text not null, trip_id text not null,
  timestamp timestamptz not null default now(), server_updated_at timestamptz not null default now(),
  data jsonb not null default '{}'::jsonb
);
create table if not exists public.events (
  event_id text primary key, vehicle_id text not null, trip_id text not null,
  timestamp timestamptz not null default now(), server_updated_at timestamptz not null default now(),
  data jsonb not null default '{}'::jsonb
);
create index if not exists idx_route_points_vehicle_updated on public.route_points(vehicle_id, server_updated_at);
create index if not exists idx_events_trip_time on public.events(trip_id, timestamp desc);

do $$
declare t text;
begin
  foreach t in array array['api_connections','live_state','trips','route_points','events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', 'calibr8 authenticated access', t);
    execute format('drop policy if exists %I on public.%I', 'calibr8 organization access', t);
    execute format('create policy %I on public.%I for all to authenticated using (auth.uid() is not null) with check (auth.uid() is not null)', 'calibr8 organization access', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

create or replace function public.calibr8_commit_frame(p_vehicle_id text, p_frame jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  trip jsonb; previous jsonb; point jsonb; event jsonb; frame jsonb;
  trip_id_value text; point_id text; stamp timestamptz; inserted_count int;
  increment double precision := 0; a double precision;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_frame->>'vehicle_id' is distinct from p_vehicle_id or p_frame->>'schema_version' <> '7' then
    raise exception 'Invalid frame';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('calibr8:' || p_vehicle_id, 0));
  select data into previous from public.live_state where vehicle_id=p_vehicle_id and kind='inference';
  stamp := coalesce((p_frame->'gps'->>'timestamp')::timestamptz, now());
  if previous->>'schema_version' = '7' and (previous->'gps'->>'timestamp')::timestamptz > stamp then
    return previous;
  end if;
  select data into trip from public.live_state where vehicle_id=p_vehicle_id and kind='trip';
  if trip is null or trip->>'active_trip_id' is null then
    trip := jsonb_build_object('active_trip_id', 'trip_' || md5(clock_timestamp()::text || random()::text),
      'distance_km',0,'harsh_events',0,'route_points',0,'started_at',now());
  end if;
  trip_id_value := trip->>'active_trip_id';
  point_id := trip_id_value || ':' || (p_frame->>'frame_id');
  point := p_frame->'route_point' || jsonb_build_object('id',point_id,'trip_id',trip_id_value);
  insert into public.route_points(id,vehicle_id,trip_id,timestamp,server_updated_at,data)
    values(point_id,p_vehicle_id,trip_id_value,stamp,now(),point) on conflict(id) do nothing;
  get diagnostics inserted_count = row_count;
  if inserted_count = 1 then
    if trip->>'last_lat' is not null and trip->>'last_lon' is not null then
      a := power(sin(radians(((point->>'lat')::double precision-(trip->>'last_lat')::double precision)/2)),2)
        + cos(radians((trip->>'last_lat')::double precision))*cos(radians((point->>'lat')::double precision))
        * power(sin(radians(((point->>'lon')::double precision-(trip->>'last_lon')::double precision)/2)),2);
      increment := 12742.0176 * asin(least(1,sqrt(greatest(0,a))));
      if increment > 2 then increment := 0; end if;
    end if;
    trip := trip || jsonb_build_object('distance_km',coalesce((trip->>'distance_km')::double precision,0)+increment,
      'route_points',coalesce((trip->>'route_points')::int,0)+1,'last_lat',point->'lat','last_lon',point->'lon');
  end if;
  event := p_frame->'event';
  if event is not null and event <> 'null'::jsonb then
    event := event || jsonb_build_object('event_id',trip_id_value || ':' || (event->>'event_id'),'trip_id',trip_id_value);
    insert into public.events(event_id,vehicle_id,trip_id,timestamp,server_updated_at,data)
      values(event->>'event_id',p_vehicle_id,trip_id_value,stamp,now(),event) on conflict(event_id) do nothing;
    get diagnostics inserted_count = row_count;
    if inserted_count = 1 then
      trip := trip || jsonb_build_object('harsh_events',coalesce((trip->>'harsh_events')::int,0)+1);
    end if;
  end if;
  trip := trip || jsonb_build_object('updated_at',now(),'last_route_point',point);
  frame := p_frame || jsonb_build_object('trip',trip,'route_point',point,'event',event);
  insert into public.live_state(vehicle_id,kind,data,server_updated_at) values
    (p_vehicle_id,'trip',trip,now()),(p_vehicle_id,'inference',frame,now())
    on conflict(vehicle_id,kind) do update set data=excluded.data,server_updated_at=excluded.server_updated_at;
  insert into public.trips(trip_id,vehicle_id,data,updated_at) values(trip_id_value,p_vehicle_id,trip,now())
    on conflict(trip_id) do update set data=excluded.data,updated_at=excluded.updated_at;
  return frame;
end $$;

create or replace function public.calibr8_reset_vehicle(p_vehicle_id text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare trip jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('calibr8:' || p_vehicle_id, 0));
  trip := jsonb_build_object('active_trip_id','trip_' || md5(clock_timestamp()::text || random()::text),
    'distance_km',0,'route_points',0,'harsh_events',0,'started_at',now());
  delete from public.live_state where vehicle_id=p_vehicle_id and kind='inference';
  insert into public.live_state(vehicle_id,kind,data,server_updated_at) values(p_vehicle_id,'trip',trip,now())
    on conflict(vehicle_id,kind) do update set data=excluded.data,server_updated_at=excluded.server_updated_at;
  insert into public.trips(trip_id,vehicle_id,data,updated_at) values(trip->>'active_trip_id',p_vehicle_id,trip,now());
  return trip;
end $$;
revoke all on function public.calibr8_commit_frame(text,jsonb) from public, anon;
revoke all on function public.calibr8_reset_vehicle(text) from public, anon;
grant execute on function public.calibr8_commit_frame(text,jsonb) to authenticated;
grant execute on function public.calibr8_reset_vehicle(text) to authenticated;
create or replace function public.calibr8_schema_version()
returns integer language sql security invoker set search_path = '' as $$ select 7 $$;
revoke all on function public.calibr8_schema_version() from public, anon;
grant execute on function public.calibr8_schema_version() to authenticated;
commit;
