/** Local calendar year for the sport counters. January 1 resets them. */
export const SPORT_TIME_ZONE = "America/Toronto";

/** Daily at 07:00 UTC: 03:00 EDT / 02:00 EST. Must match the cron in wrangler.toml. */
export const SPORT_INSIGHTS_CRON = "0 7 * * *";

export function isSportInsightsCron(cron: string | undefined): boolean {
  return cron === SPORT_INSIGHTS_CRON;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** UTC instant of January 1 00:00 in `timeZone` for the year that `now` falls in. */
export function yearStartIso(now: Date, timeZone = SPORT_TIME_ZONE): string {
  const year = zonedParts(now, timeZone).year;
  let utc = Date.UTC(year, 0, 1, 12, 0, 0);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const offset = timeZoneOffsetMs(new Date(utc), timeZone);
    const next = Date.UTC(year, 0, 1, 0, 0, 0) - offset;
    if (next === utc) return new Date(utc).toISOString();
    utc = next;
  }
  return new Date(utc).toISOString();
}

function timeZoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - instant.getTime();
}

function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "0";
  let year = Number(read("year"));
  let month = Number(read("month"));
  let day = Number(read("day"));
  let hour = Number(read("hour"));
  const minute = Number(read("minute"));
  const second = Number(read("second"));
  if (hour === 24) {
    hour = 0;
    const next = new Date(Date.UTC(year, month - 1, day));
    next.setUTCDate(next.getUTCDate() + 1);
    year = next.getUTCFullYear();
    month = next.getUTCMonth() + 1;
    day = next.getUTCDate();
  }
  return { year, month, day, hour, minute, second };
}
