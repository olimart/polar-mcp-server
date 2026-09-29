/** Year-to-date sport buckets published to Logly. */

export const SPORT_PROJECT = "sport";

export type SportId = "running" | "biking" | "cross-country-ski" | "swimming";

export interface SportDefinition {
  id: SportId;
  title: string;
  icon: string;
}

export const SPORTS: readonly SportDefinition[] = [
  { id: "running", title: "Running", icon: "🏃" },
  { id: "biking", title: "Biking", icon: "🚴" },
  { id: "cross-country-ski", title: "Cross-country ski", icon: "🎿" },
  { id: "swimming", title: "Swimming", icon: "🏊" },
];

const RUNNING = new Set([
  "run",
  "trailrun",
  "virtualrun",
  "running",
  "roadrunning",
  "trailrunning",
  "treadmillrunning",
  "jogging",
  "trackrunning",
]);

const BIKING = new Set([
  "ride",
  "mountainbikeride",
  "gravelride",
  "virtualride",
  "ebikeride",
  "emountainbikeride",
  "cycling",
  "roadcycling",
  "roadbiking",
  "mountainbiking",
  "indoorcycling",
  "indoorbiking",
  "biking",
  "gravelcycling",
]);

const CROSS_COUNTRY_SKI = new Set([
  "nordicski",
  "crosscountryskiing",
  "crosscountryski",
  "classiccrosscountryskiing",
  "skatecrosscountryskiing",
]);

const SWIMMING = new Set([
  "swim",
  "openwaterswim",
  "swimming",
  "poolswimming",
  "openwaterswimming",
]);

export interface SportTotals {
  totalMeters: number;
  longestMeters: number;
  activities: number;
}

export type SportSummary = Record<SportId, SportTotals>;

export interface LoglyInsight {
  project: string;
  title: string;
  value: string | number;
  icon: string;
}

export function normalizeActivityType(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function sportForActivityType(activityType: string | null | undefined): SportId | null {
  if (!activityType) return null;
  const key = normalizeActivityType(activityType);
  if (RUNNING.has(key)) return "running";
  if (BIKING.has(key)) return "biking";
  if (CROSS_COUNTRY_SKI.has(key)) return "cross-country-ski";
  if (SWIMMING.has(key)) return "swimming";
  return null;
}

export function emptySportSummary(): SportSummary {
  return {
    running: emptyTotals(),
    biking: emptyTotals(),
    "cross-country-ski": emptyTotals(),
    swimming: emptyTotals(),
  };
}

export function addExercise(
  summary: SportSummary,
  activityType: string | null | undefined,
  distanceMeters: number | null | undefined
): void {
  const sport = sportForActivityType(activityType);
  if (!sport) return;
  const totals = summary[sport];
  totals.activities += 1;
  if (typeof distanceMeters !== "number" || !Number.isFinite(distanceMeters) || distanceMeters < 0) return;
  totals.totalMeters += distanceMeters;
  if (distanceMeters > totals.longestMeters) totals.longestMeters = distanceMeters;
}

/** Kilometers with one decimal, for example `303.1 km`. */
export function formatKilometers(meters: number): string {
  const kilometers = Math.round(meters / 100) / 10;
  return `${kilometers.toFixed(1)} km`;
}

export function sportInsights(summary: SportSummary, project = SPORT_PROJECT): LoglyInsight[] {
  const insights: LoglyInsight[] = [];
  for (const sport of SPORTS) {
    const totals = summary[sport.id];
    insights.push(
      {
        project,
        title: `${sport.title} total distance`,
        value: formatKilometers(totals.totalMeters),
        icon: sport.icon,
      },
      {
        project,
        title: `${sport.title} longest distance`,
        value: formatKilometers(totals.longestMeters),
        icon: sport.icon,
      },
      {
        project,
        title: `${sport.title} activities`,
        value: totals.activities,
        icon: sport.icon,
      }
    );
  }
  return insights;
}

function emptyTotals(): SportTotals {
  return { totalMeters: 0, longestMeters: 0, activities: 0 };
}
