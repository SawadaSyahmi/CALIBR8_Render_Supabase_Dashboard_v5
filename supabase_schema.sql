-- CALIBR8 Render + Supabase schema
-- Run once in Supabase Dashboard -> SQL Editor.

create extension if not exists pgcrypto;

create table if not exists public.workspace (
  workspace_id text primary key,
  email text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.api_connections (
  connection_id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.fleet (
  vehicle_id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.live_state (
  vehicle_id text not null,
  kind text not null,
  data jsonb not null default '{}'::jsonb,
  server_updated_at timestamptz not null default now(),
  primary key (vehicle_id, kind)
);

create table if not exists public.trips (
  trip_id text primary key,
  vehicle_id text not null,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.route_points (
  id text primary key,
  vehicle_id text not null,
  trip_id text not null,
  timestamp timestamptz not null default now(),
  server_updated_at timestamptz not null default now(),
  data jsonb not null default '{}'::jsonb
);
create index if not exists idx_route_points_trip_updated on public.route_points(trip_id, server_updated_at);
create index if not exists idx_route_points_vehicle_updated on public.route_points(vehicle_id, server_updated_at);

create table if not exists public.events (
  event_id text primary key,
  vehicle_id text not null,
  trip_id text not null,
  timestamp timestamptz not null default now(),
  server_updated_at timestamptz not null default now(),
  data jsonb not null default '{}'::jsonb
);
create index if not exists idx_events_trip_time on public.events(trip_id, timestamp desc);
create index if not exists idx_events_vehicle_time on public.events(vehicle_id, timestamp desc);

-- Dashboard users may read operational data only after Supabase Auth login.
-- API connection secrets remain backend-only: there is intentionally no SELECT policy
-- for api_connections or workspace.
alter table public.workspace enable row level security;
alter table public.api_connections enable row level security;
alter table public.fleet enable row level security;
alter table public.live_state enable row level security;
alter table public.trips enable row level security;
alter table public.route_points enable row level security;
alter table public.events enable row level security;

-- Drop/recreate read policies so rerunning this script is safe.
drop policy if exists "authenticated read fleet" on public.fleet;
create policy "authenticated read fleet" on public.fleet for select to authenticated using (true);

drop policy if exists "authenticated read live state" on public.live_state;
create policy "authenticated read live state" on public.live_state for select to authenticated using (true);

drop policy if exists "authenticated read trips" on public.trips;
create policy "authenticated read trips" on public.trips for select to authenticated using (true);

drop policy if exists "authenticated read route points" on public.route_points;
create policy "authenticated read route points" on public.route_points for select to authenticated using (true);

drop policy if exists "authenticated read events" on public.events;
create policy "authenticated read events" on public.events for select to authenticated using (true);

-- Add the live tables to the Supabase Realtime publication if not already present.
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='live_state') then
    alter publication supabase_realtime add table public.live_state;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='route_points') then
    alter publication supabase_realtime add table public.route_points;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='events') then
    alter publication supabase_realtime add table public.events;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='fleet') then
    alter publication supabase_realtime add table public.fleet;
  end if;
end $$;
