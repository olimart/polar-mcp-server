# Archive architecture

The D1 archive stores training history in a **canonical** shape. Polar AccessLink is one provider. A later Garmin or Strava adapter can write the same columns without a schema change.

```
POST /webhook
  → provider adapter (verify signature, parse envelope)
  → repository upsert (canonical key, pending)
  → 200
  → adapter fetch + mapper (provider JSON → NormalizedRecord)
  → packer (row size)
  → repository save (generic columns only)
```

HTTP entry: `src/webhook/handle.ts` (thin Polar wiring) and `src/archive/ingest.ts` (no provider field names).  
Polar adapter: `src/providers/polar/adapter.ts`.  
Polar mapper: `src/providers/polar/mapper.ts`.  
Strava backfill: `src/providers/strava/mapper.ts` (`adaptStravaActivity`) then `archiveMapped` in `src/archive/apply.ts`.  
Repository: `src/archive/repository.ts`.  
Webhook providers are registered in `src/providers/registry.ts`.

OAuth tokens stay in `OAUTH_KV`. The archive never stores access tokens.

## Canonical columns (`activities`)

| Column | Meaning |
| --- | --- |
| `source` | Provider id. Polar rows use `polar`. Strava rows use `strava`. |
| `source_user_id` | User id in that provider. |
| `source_entity_id` | Stable id for the entity (exercise id, calendar date, or `from_to`). |
| `event_kind` | Lowercase kind: `exercise`, `sleep`, `activity_summary`, `continuous_heart_rate`, `physical_information`, `sleep_wise_alertness`, `sleep_wise_circadian_bedtime`. |
| `occurred_at` | When the provider says the event was delivered (webhook timestamp). |
| `source_url` | Provider URL from the envelope. Not used as a fetch target when a canonical path exists. |
| `raw_envelope` | Unmodified webhook body. |
| `raw_payload` | Unmodified provider entity JSON, when it fits. |
| `raw_status` | `complete`, `trimmed` (bulky keys dropped), or `truncated` (replaced with `{truncated:true}`). |
| `normalized` | Canonical JSON document (the scalars below, plus `extras`). |
| `started_at` / `ended_at` | Start and end. UTC ISO-8601 when a zone or offset is known; otherwise the provider's local clock string. |
| `duration_sec` | Duration in seconds. |
| `activity_type` | Sport or activity label chosen by the mapper. |
| `distance` | Distance in meters. |
| `calories` | Energy, provider units (Polar: kilocalories). |
| `avg_hr` / `max_hr` | Heart rate, beats per minute. |
| `avg_speed` / `max_speed` | Speed in km/h. Null when the provider did not record a speed series. |
| `min_elevation` / `max_elevation` | Altitude in meters. |
| `ascent` / `descent` | Meters climbed and descended, summed from successive altitude samples. |
| `title` | Session title when the provider has one. |
| `artifacts_json` | Optional files: `{kind, encoding, status, body}`. Polar exercises use `fit` (base64), `tcx`, and `gpx`. |
| `status` | `pending`, `archived`, `failed`, or `missing_token`. |
| `error`, `attempts`, `created_at`, `updated_at` | Fetch bookkeeping. |

Unique key: `(source, source_user_id, event_kind, source_entity_id)`.

Polar-only names (`entity_id`, `sport`, `start_time`, `heart_rate`, `fit_base64`, …) are not columns. They live in `raw_payload` or are mapped into the fields above.

## Polar mapping

Webhook `event` values become `event_kind` in `src/providers/polar/mapper.ts` (`EXERCISE` → `exercise`, and so on). Unknown names are lowercased.

| Canonical field | Polar JSON |
| --- | --- |
| `source_user_id` | webhook `user_id` |
| `source_entity_id` | `entity_id`, else `date`, else `from` + `to` |
| `occurred_at` | webhook `timestamp` |
| `activity_type` | `detailed_sport_info` / `detailed-sport-info`, unless `UNKNOWN`; else `sport` |
| `started_at` | `start_time` or `start-time`. With `start_time_utc_offset` (minutes) the local clock is converted to UTC. A daily `date` becomes `YYYY-MM-DDT00:00:00.000Z`. |
| `ended_at` | `started_at` + `duration` |
| `duration_sec` | ISO-8601 `duration` (`PT45M` → 2700) |
| `distance` | `distance` (meters) |
| `calories` | `calories` |
| `avg_hr` / `max_hr` | `heart_rate.average` / `maximum`, or kebab-case `heart-rate` |
| `avg_speed` / `max_speed` | Speed sample series, type `1`, unit km/h. The exercise summary has no speed stats. Heart-rate zones, route points, and `running-index` are not speeds. A `speed.average` / `speed.maximum` object is used if a payload includes one. |
| `min_elevation` / `max_elevation` / `ascent` / `descent` | Altitude sample series, type `3`, unit meters. Route points have no altitude. Ascent and descent are the sums of upward and downward steps in that series. FIT, TCX, and GPX are not parsed. |
| `title` | `title` or `name` |
| `normalized.extras` | `device`, `upload_time`, `has_route`, `training_load`, `steps`, `active_steps`, `calendar_date` |

`samples` and `route` stay inside `raw_payload` until the row would exceed D1's size limit. The packer then drops those keys and sets `raw_status` to `trimmed`.

Exercise fetch URLs are built from the entity id (`/v3/exercises/{id}`), not from the webhook `url`, so a signed body cannot point the worker at another host. Daily activity, sleep, and continuous heart rate use the AccessLink date path when the entity id is `YYYY-MM-DD`.

The AccessLink subscription API still uses Polar's uppercase event names (`EXERCISE`). That is the partner webhook API, not the archive schema. MCP archive tools accept either form and store the canonical kind.

## Strava mapping

`adaptStravaActivity` in `src/providers/strava/mapper.ts` turns one Strava activity into the same columns. `npm run strava:import` pages through `GET /athlete/activities` and writes each row with `archiveMapped`. Polar does not provide history from before the user registered with this client, so this backfill is the historic copy.

| Canonical field | Strava activity |
| --- | --- |
| `source` | `strava` |
| `source_user_id` | `athlete.id` |
| `source_entity_id` | `id` |
| `event_kind` | `exercise` |
| `started_at` | `start_date` (UTC) |
| `ended_at` | `start_date` + `elapsed_time` |
| `duration_sec` | `elapsed_time` (falls back to `moving_time`) |
| `activity_type` | `sport_type`, else `type` |
| `distance` | `distance` (meters) |
| `calories` | `calories` when present, otherwise `kilojoules / 4.184` |
| `avg_hr` / `max_hr` | `average_heartrate` / `max_heartrate` |
| `avg_speed` / `max_speed` | `average_speed` / `max_speed` converted from m/s to km/h |
| `min_elevation` / `max_elevation` | `elev_low` / `elev_high` (meters) |
| `ascent` | `total_elevation_gain` (meters). Strava summaries have no descent. |
| `title` | `name` |
| `normalized.extras` | `moving_time`, `elapsed_time`, `kilojoules`, `commute`, `trainer`, `manual`, `gear_id`, `timezone`, `start_date_local`, `has_heartrate` |

The unmodified activity JSON is `raw_payload`. Map polylines and lap arrays are bulky keys the packer may drop. FIT, TCX, and GPX are not downloaded for Strava.
