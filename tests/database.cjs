/* Execute the actual migration and RPC functions in an embedded PostgreSQL engine. */
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
async function run() {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated;
    create schema auth; grant usage on schema auth to authenticated,anon;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant execute on function auth.uid() to authenticated,anon;`);
    const sql = fs.readFileSync(
      path.join(__dirname, "../supabase_schema.sql"),
      "utf8",
    );
    await db.exec(sql);
    await db.exec(sql);
    console.log("PASS migration installs and reruns without deleting data");
    await db.exec(
      `set role authenticated; set request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';`,
    );
    const fixture = JSON.parse(
      fs.readFileSync(
        process.env.CALIBR8_TEST_FIXTURES ||
          path.join(__dirname, "fixtures.json"),
        "utf8",
      ),
    );
    const frame = structuredClone(fixture.harsh);
    frame.vehicle_id = "sql_vehicle";
    frame.source = "fleet";
    frame.frame_id = "point-one";
    frame.event.event_id = "event-one";
    frame.route_point.id = "point-one";
    const commit = async (f) =>
      (
        await db.query(
          "select public.calibr8_commit_frame($1,$2::jsonb) as frame",
          ["sql_vehicle", JSON.stringify(f)],
        )
      ).rows[0].frame;
    const first = await commit(frame),
      duplicate = await commit(frame);
    assert.equal(first.trip.route_points, 1);
    assert.equal(duplicate.trip.route_points, 1);
    assert.equal(duplicate.trip.harsh_events, 1);
    assert.equal(
      (await db.query("select count(*)::int as count from public.events"))
        .rows[0].count,
      1,
    );
    console.log(
      "PASS atomic frame write and retry deduplication for route points and harsh events",
    );
    const next = structuredClone(frame);
    next.frame_id = next.route_point.id = "point-two";
    next.event = null;
    next.gps.timestamp = "2099-01-01T00:00:00Z";
    next.route_point.lat += 0.0001;
    next.gps.lat = next.route_point.lat;
    const second = await commit(next);
    assert.equal(second.trip.route_points, 2);
    assert.ok(second.trip.distance_km > 0);
    assert.equal(second.trip.harsh_events, 1);
    const stale = await commit(frame);
    assert.equal(stale.frame_id, "point-two");
    assert.equal(stale.trip.route_points, 2);
    console.log(
      "PASS distance accumulation and older frames cannot overwrite newer readings",
    );
    const before = (
      await db.query("select count(*)::int as count from public.route_points")
    ).rows[0].count;
    const invalid = structuredClone(next);
    invalid.vehicle_id = "other";
    await assert.rejects(commit(invalid));
    assert.equal(
      (await db.query("select count(*)::int as count from public.route_points"))
        .rows[0].count,
      before,
    );
    await db.query("select public.calibr8_reset_vehicle($1)", ["sql_vehicle"]);
    assert.equal(
      (
        await db.query(
          "select count(*)::int as count from public.live_state where kind='inference'",
        )
      ).rows[0].count,
      0,
    );
    assert.equal(
      (await db.query("select count(*)::int as count from public.events"))
        .rows[0].count,
      1,
    );
    const restarted = await commit(frame);
    assert.equal(restarted.trip.route_points, 1);
    assert.equal(restarted.trip.harsh_events, 1);
    assert.equal(
      (await db.query("select count(*)::int as count from public.events"))
        .rows[0].count,
      2,
    );
    assert.equal(
      (await db.query("select public.calibr8_schema_version() as version"))
        .rows[0].version,
      7,
    );
    console.log(
      "PASS invalid writes roll back and new-trip reset preserves existing event history",
    );
    await db.exec("reset role; set role anon;");
    await assert.rejects(db.query("select public.calibr8_schema_version()"));
    await assert.rejects(commit(frame));
    console.log("PASS anonymous callers cannot execute the database functions");
  } finally {
    await db.close();
  }
}
run().catch((error) => {
  console.error(error);
  process.exit(1);
});
