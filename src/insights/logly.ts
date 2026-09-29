import { sanitizeErrorMessage } from "../archive/errors.js";
import type { LoglyInsight } from "./sports.js";

const PROJECTS_PATH = "/api/v1/projects";
const INSIGHT_PATH = "/api/v1/insight";

export async function publishLoglyInsights(
  insights: LoglyInsight[],
  options: { baseUrl: string; token: string; projectName: string; fetchImpl?: typeof fetch }
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const first = await postJson(fetchImpl, `${baseUrl}${INSIGHT_PATH}`, options.token, { insights });
  if (first.response.ok) return;
  if (isMissingProject(first.response.status, first.body)) {
    const created = await postJson(fetchImpl, `${baseUrl}${PROJECTS_PATH}`, options.token, {
      name: options.projectName,
    });
    if (!created.response.ok && created.response.status !== 422) {
      throw loglyError(created.response.status, created.body);
    }
    const retry = await postJson(fetchImpl, `${baseUrl}${INSIGHT_PATH}`, options.token, { insights });
    if (!retry.response.ok) throw loglyError(retry.response.status, retry.body);
    return;
  }
  throw loglyError(first.response.status, first.body);
}

function isMissingProject(status: number, body: string): boolean {
  return status === 404 && /project not found/i.test(body);
}

function loglyError(status: number, body: string): Error {
  return new Error(sanitizeErrorMessage(new Error(`Logly HTTP ${status}: ${body}`)));
}

async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
  payload: unknown
): Promise<{ response: Response; body: string }> {
  const response = await fetchImpl(url, {
    method: "POST",
    redirect: "error",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const body = await response.text();
  return { response, body };
}
