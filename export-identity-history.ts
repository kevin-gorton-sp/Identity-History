/**
 * Export one SailPoint ISC identity's history to CSV.
 *
 * Uses sailpoint-api-client (the SailPoint TypeScript SDK):
 *   IdentityHistoryApi.listIdentitySnapshotsV1
 *   IdentityHistoryApi.getIdentitySnapshotV1
 *   IdentityHistoryApi.listIdentitySnapshotAccessItemsV1
 *   IdentityHistoryApi.getHistoricalIdentityEventsV1
 *   SourcesApi.listSourcesV1
 *
 * The SDK calls /historical-identities/v1/... and /sources/v1. Identity
 * History is experimental, so configuration.experimental is set and the SDK
 * sends X-SailPoint-Experimental: true. The token needs idn:identity-history:read.
 *
 * Credentials, first match wins:
 *   SAIL_BASE_URL, SAIL_CLIENT_ID, SAIL_CLIENT_SECRET
 *   ./config.json with ClientId, ClientSecret, BaseURL
 *   ~/.sailpoint/config.yaml written by the SailPoint CLI
 *
 * `start` and `interval` are not sent on the snapshot list (start returns 400
 * on the historical-identities API). `from` is not sent on events (that filter
 * comes back empty). Dates are filtered in this script.
 * accessItemCount is a dictionary. Inventory counts come from the access-items
 * call. Snapshots have no identity profile, so profile fields are not reported.
 *
 * The identity id is requested at the prompt. It is not a command-line flag.
 *
 *   npx tsx export-identity-history.ts
 *   npx tsx export-identity-history.ts --start all --out ./out --workers 4
 *   npx tsx export-identity-history.ts --self-test
 */

import { createRequire } from "node:module";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { IdentityHistoryApi, SourcesApi } from "sailpoint-api-client";

// sailpoint-api-client 2.1.28 publishes a broken ESM entry, so load the CommonJS build.
const require = createRequire(import.meta.url);
const sailpoint = require("sailpoint-api-client") as typeof import("sailpoint-api-client");

const PAGE_LIMIT = 250;
const REQUEST_TIMEOUT_MS = positiveInt(process.env.SAIL_TIMEOUT_MS, 120_000);
const MAX_ATTEMPTS = 6;
const DEFAULT_START = "2026-03-01";
const DEFAULT_WORKERS = 4;

const SKIPPED_ATTRIBUTES = new Set([
  "modified",
  "lastrefresh",
  "processingdetails",
  "triggersnapshots",
  "lastsyncdate",
  "processingstate",
  "cloudstatus",
  "cloudlifecyclestate",
  "cloudauthoritativesource",
]);

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

type StartBound =
  | { mode: "all" }
  | { mode: "date"; iso: string; ms: number };

type Options = {
  start: StartBound;
  out: string;
  workers: number;
  selfTest: boolean;
};

type AccessItem = {
  accessType: string;
  id: string;
  name: string;
  sourceName: string;
  sourceId: string;
  nativeIdentity: string;
  entitlementCount: string;
};

type LoadedSnapshot = {
  date: string;
  time: number;
  attributes: Record<string, unknown>;
  items: AccessItem[];
  detail: unknown;
  sampleItem: unknown;
};

type SourceCatalog = {
  byId: Map<string, string>;
  byName: Map<string, string>;
};

type TimelineRow = {
  date: string;
  time: number;
  category: string;
  action: string;
  name: string;
  id: string;
  type: string;
  source: string;
  from: string;
  to: string;
  detail: string;
};

type Report = {
  correlation: string[][];
  accessItems: string[][];
  accounts: string[][];
  lifecycle: string[][];
  authoritativeSource: string[][];
  attributes: string[][];
  events: string[][];
  eventAttributes: string[][];
  inventory: string[][];
  timeline: string[][];
};

type SdkClients = {
  history: IdentityHistoryApi;
  sources: SourcesApi;
};

type SdkFailure = {
  status: number | null;
  code: string;
  data: unknown;
  message: string;
};

class SailHttpError extends Error {
  constructor(
    readonly status: number,
    readonly bodyText: string,
  ) {
    super(`SailPoint API returned HTTP ${status}: ${clip(bodyText, 500)}`);
    this.name = "SailHttpError";
  }
}

class SailCallError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "SailCallError";
  }
}

const warned = new Set<string>();

function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.error(`warning: ${message}`);
}

function info(message: string): void {
  console.error(message);
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function clip(value: string, max: number): string {
  const redacted = value.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").trim();
  if (redacted.length <= max) return redacted;
  return `${redacted.slice(0, max)}...(truncated)`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isRecord(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) sorted[key] = sortValue(value[key]);
  return sorted;
}

function sameValue(left: unknown, right: unknown): boolean {
  return formatValue(left) === formatValue(right);
}

function isRetryableHttpStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

function isRetryableCode(code: string): boolean {
  return /ECONNABORTED|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|ERR_NETWORK|EPIPE|EHOSTUNREACH/i.test(code);
}

function readSdkFailure(err: unknown): SdkFailure {
  if (err instanceof Error) {
    const extra = err as Error & { status?: unknown; code?: unknown; data?: unknown };
    return {
      status: typeof extra.status === "number" ? extra.status : null,
      code: typeof extra.code === "string" ? extra.code : "",
      data: extra.data,
      message: err.message,
    };
  }
  return { status: null, code: "", data: undefined, message: String(err) };
}

function failureText(failure: SdkFailure): string {
  const body = failure.data === undefined ? failure.message : formatValue(failure.data) || failure.message;
  return clip(`${failure.message} ${body}`, 800);
}

function isAuthFailure(failure: SdkFailure): boolean {
  if (failure.status === 401 || failure.status === 403) return true;
  return /unauthorized|forbidden|invalid_client|client_secret|access token|oauth\/token/i.test(
    `${failure.message} ${failureText(failure)}`,
  );
}

let pauseUntil = 0;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPause(): Promise<void> {
  const remaining = pauseUntil - Date.now();
  if (remaining > 0) await sleep(remaining);
}

function tripPause(ms: number): void {
  pauseUntil = Math.max(pauseUntil, Date.now() + ms);
}

function backoffMs(attempt: number): number {
  const base = Math.min(30_000, 500 * 2 ** attempt);
  return base + Math.floor(Math.random() * 250);
}

function silenceExperimentalLog(): void {
  const original = console.log.bind(console) as (...args: unknown[]) => void;
  console.log = (...args: unknown[]) => {
    if (args.length === 1 && args[0] === "Warning: You are using Experimental APIs") return;
    original(...args);
  };
}

function createClients(): SdkClients {
  const configuration = new sailpoint.Configuration();
  if (!configuration.basePath || !configuration.clientId || !configuration.clientSecret) {
    throw new SailCallError(
      "No SailPoint credentials found. Set SAIL_BASE_URL, SAIL_CLIENT_ID, and SAIL_CLIENT_SECRET, or create config.json with ClientId, ClientSecret, and BaseURL. The SDK also reads ~/.sailpoint/config.yaml.",
      false,
    );
  }
  configuration.experimental = true;
  configuration.axiosInstance.interceptors.request.clear();
  configuration.axiosInstance.interceptors.response.clear();
  configuration.axiosInstance.defaults.timeout = REQUEST_TIMEOUT_MS;
  silenceExperimentalLog();
  info(`Using SailPoint TypeScript SDK against ${configuration.basePath}. Each request times out after ${REQUEST_TIMEOUT_MS}ms.`);
  return {
    history: new sailpoint.IdentityHistoryApi(configuration),
    sources: new sailpoint.SourcesApi(configuration),
  };
}

async function callSdk<T>(label: string, request: () => Promise<{ data: T }>): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await waitForPause();
    try {
      const response = await request();
      return response.data;
    } catch (err) {
      if (err instanceof SailCallError && !err.retryable) throw err;
      const failure = readSdkFailure(err);
      const text = failureText(failure);
      if (isAuthFailure(failure)) {
        throw new SailCallError(`SailPoint authentication failed during ${label}. ${text}`, false);
      }
      const retryable =
        (failure.status !== null && isRetryableHttpStatus(failure.status)) ||
        (failure.status === null && isRetryableCode(`${failure.code} ${failure.message}`));
      const wrapped =
        failure.status !== null
          ? new SailHttpError(failure.status, text)
          : new SailCallError(`${label} failed: ${text}`, retryable);
      if (!retryable) throw wrapped;
      lastError = wrapped;
      const delay = backoffMs(attempt);
      info(`Retryable failure on ${label} (attempt ${attempt + 1} of ${MAX_ATTEMPTS}): ${wrapped.message} Waiting ${delay}ms.`);
      tripPause(delay);
      await sleep(delay);
    }
  }
  throw lastError ?? new Error(`${label} failed`);
}

function coerceList(body: unknown, endpoint: string): unknown[] {
  if (Array.isArray(body)) return body;
  if (isRecord(body)) {
    for (const key of ["items", "data", "results", "objects", "snapshots", "events", "sources"]) {
      if (Array.isArray(body[key])) {
        warnOnce(`${endpoint} returned an object. Using the ${key} array.`);
        return body[key] as unknown[];
      }
    }
  }
  throw new Error(`${endpoint} did not return a JSON array. Body starts: ${clip(JSON.stringify(body), 400)}`);
}

async function paginate(label: string, fetchPage: (offset: number) => Promise<unknown[]>): Promise<unknown[]> {
  const all: unknown[] = [];
  let offset = 0;
  let previousSignature = "";
  for (;;) {
    const page = await fetchPage(offset);
    if (page.length === 0) break;
    const signature = JSON.stringify(page);
    if (signature === previousSignature) {
      warnOnce(`${label} repeated a page at offset ${offset}. Stopping so results are not duplicated.`);
      break;
    }
    previousSignature = signature;
    all.push(...page);
    if (page.length !== PAGE_LIMIT) {
      if (page.length > PAGE_LIMIT) {
        warnOnce(`${label} returned ${page.length} rows, more than limit ${PAGE_LIMIT}. Treating that response as the full list.`);
      }
      break;
    }
    offset += page.length;
  }
  return all;
}

async function listSnapshots(clients: SdkClients, id: string): Promise<unknown[]> {
  return paginate("snapshots", async (offset) => {
    const data = await callSdk(`listIdentitySnapshotsV1 offset ${offset}`, () =>
      clients.history.listIdentitySnapshotsV1({
        id,
        limit: PAGE_LIMIT,
        offset,
        xSailPointExperimental: "true",
      }),
    );
    return coerceList(data, "listIdentitySnapshotsV1");
  });
}

async function listEvents(clients: SdkClients, id: string): Promise<unknown[]> {
  return paginate("events", async (offset) => {
    const data = await callSdk(`getHistoricalIdentityEventsV1 offset ${offset}`, () =>
      clients.history.getHistoricalIdentityEventsV1({
        id,
        limit: PAGE_LIMIT,
        offset,
        xSailPointExperimental: "true",
      }),
    );
    return coerceList(data, "getHistoricalIdentityEventsV1");
  });
}

async function listSnapshotAccessItems(clients: SdkClients, id: string, date: string): Promise<unknown[]> {
  try {
    return await paginate(`access items ${date}`, async (offset) => {
      const data = await callSdk(`listIdentitySnapshotAccessItemsV1 ${date} offset ${offset}`, () =>
        clients.history.listIdentitySnapshotAccessItemsV1(
          { id, date, xSailPointExperimental: "true" },
          { params: { limit: PAGE_LIMIT, offset } },
        ),
      );
      return coerceList(data, "listIdentitySnapshotAccessItemsV1");
    });
  } catch (err) {
    const pagingRejected =
      err instanceof SailHttpError && err.status === 400 && /limit|offset|pagination/i.test(err.bodyText);
    if (!pagingRejected) throw err;
    warnOnce(`Access items for ${date} rejected limit/offset (HTTP 400). Requesting the snapshot once without paging parameters.`);
    const data = await callSdk(`listIdentitySnapshotAccessItemsV1 ${date}`, () =>
      clients.history.listIdentitySnapshotAccessItemsV1({ id, date, xSailPointExperimental: "true" }),
    );
    return coerceList(data, "listIdentitySnapshotAccessItemsV1");
  }
}

async function getSnapshotDetail(clients: SdkClients, id: string, date: string): Promise<unknown> {
  return callSdk(`getIdentitySnapshotV1 ${date}`, () =>
    clients.history.getIdentitySnapshotV1({ id, date, xSailPointExperimental: "true" }),
  );
}

async function listSourcePage(clients: SdkClients, offset: number): Promise<unknown[]> {
  const data = await callSdk(`listSourcesV1 offset ${offset}`, () =>
    clients.sources.listSourcesV1({ limit: PAGE_LIMIT, offset }),
  );
  return coerceList(data, "listSourcesV1");
}


function snapshotDate(entry: unknown): string {
  if (typeof entry === "string") return entry.trim();
  if (!isRecord(entry)) return "";
  const value = entry.snapshot ?? entry.date ?? entry.dateTime;
  return typeof value === "string" ? value.trim() : "";
}

function parseInstant(value: string, label: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`${label} is not a parseable date: ${value}`);
  }
  return ms;
}

function assertIdentityId(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) throw new Error("Identity ID is required.");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,200}$/.test(trimmed)) {
    throw new Error(
      "Identity ID contains unsupported characters. Expected the ISC identity id (letters, digits, hyphen).",
    );
  }
  return trimmed;
}

function parseStart(value: string): StartBound {
  if (value.toLowerCase() === "all") return { mode: "all" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`--start must be YYYY-MM-DD or "all". Received: ${value}`);
  }
  const iso = `${value}T00:00:00.000Z`;
  const ms = Date.parse(iso);
  const parsed = new Date(ms);
  const [year, month, day] = value.split("-").map(Number);
  if (
    Number.isNaN(ms) ||
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() + 1 !== month ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error(`--start is not a real calendar date: ${value}`);
  }
  return { mode: "date", iso, ms };
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    start: parseStart(DEFAULT_START),
    out: "",
    workers: DEFAULT_WORKERS,
    selfTest: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} needs a value.`);
      return value;
    };
    if (arg === "--self-test") options.selfTest = true;
    else if (arg === "--id" || arg.startsWith("--id=")) {
      throw new Error("The identity id is collected at the prompt. Remove --id and run the command again.");
    }
    else if (arg === "--start") options.start = parseStart(next());
    else if (arg.startsWith("--start=")) options.start = parseStart(arg.slice("--start=".length));
    else if (arg === "--out") options.out = next();
    else if (arg.startsWith("--out=")) options.out = arg.slice("--out=".length);
    else if (arg === "--workers") options.workers = parseWorkers(next());
    else if (arg.startsWith("--workers=")) options.workers = parseWorkers(arg.slice("--workers=".length));
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function parseWorkers(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 32) {
    throw new Error("--workers must be an integer from 1 to 32.");
  }
  return parsed;
}

function printHelp(): void {
  console.log(`Usage: npx tsx export-identity-history.ts [--start <YYYY-MM-DD|all>] [--out <dir>] [--workers <n>]

Reads Identity History for one identity and writes CSV files.
The identity id is requested at the prompt.
--start defaults to ${DEFAULT_START} and is interpreted as UTC midnight.
--start all diffs every consecutive snapshot.
A snapshot before the start date is the baseline and is not listed as its own inventory row.
Each SDK request times out after ${REQUEST_TIMEOUT_MS}ms. Override that with SAIL_TIMEOUT_MS.
Credentials come from SAIL_BASE_URL, SAIL_CLIENT_ID, and SAIL_CLIENT_SECRET, or from config.json.
`);
}

async function promptIdentityId(): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question("Identity ID: ");
    return answer.trim();
  } finally {
    rl.close();
  }
}

function lookupAttribute(attributes: Record<string, unknown>, name: string): unknown {
  if (Object.prototype.hasOwnProperty.call(attributes, name)) return attributes[name];
  const found = Object.keys(attributes).find((key) => key.toLowerCase() === name.toLowerCase());
  return found ? attributes[found] : undefined;
}

function attributeMap(attributes: Record<string, unknown>): Map<string, { name: string; value: unknown }> {
  const mapped = new Map<string, { name: string; value: unknown }>();
  for (const [name, value] of Object.entries(attributes)) {
    const key = name.toLowerCase();
    const existing = mapped.get(key);
    if (!existing || name === key) mapped.set(key, { name, value });
  }
  return mapped;
}

function skippedAttribute(name: string): boolean {
  const key = name.toLowerCase();
  if (SKIPPED_ATTRIBUTES.has(key)) return true;
  return key === "identityprofile" || key.startsWith("identityprofile");
}

function readAccessItem(raw: unknown): AccessItem | null {
  if (!isRecord(raw)) return null;
  const accessType = formatValue(raw.accessType).trim();
  if (!accessType) {
    warnOnce(`Access item has no accessType. Keys: ${Object.keys(raw).sort().join(", ") || "(none)"}`);
    return null;
  }
  return {
    accessType,
    id: formatValue(raw.id ?? raw.accessItemId ?? ""),
    name: formatValue(raw.displayName ?? raw.name ?? ""),
    sourceName: formatValue(raw.sourceName ?? ""),
    sourceId: formatValue(raw.sourceId ?? ""),
    nativeIdentity: formatValue(raw.nativeIdentity ?? ""),
    entitlementCount: formatValue(raw.entitlementCount ?? ""),
  };
}

function isAccount(item: AccessItem): boolean {
  return item.accessType.toLowerCase() === "account";
}

function accountKey(item: AccessItem): string {
  if (item.id) return `id:${item.id}`;
  return `native:${item.sourceId}|${item.nativeIdentity}|${item.sourceName}|${item.name}`;
}

function accessKey(item: AccessItem): string {
  const type = item.accessType.toLowerCase();
  if (item.id) return `${type}:id:${item.id}`;
  return `${type}:${item.sourceId}:${item.name}`;
}

function diffByKey<T>(before: T[], after: T[], keyOf: (item: T) => string): { added: T[]; removed: T[] } {
  const beforeMap = new Map(before.map((item) => [keyOf(item), item]));
  const afterMap = new Map(after.map((item) => [keyOf(item), item]));
  const added = [...afterMap.entries()].filter(([key]) => !beforeMap.has(key)).map(([, item]) => item);
  const removed = [...beforeMap.entries()].filter(([key]) => !afterMap.has(key)).map(([, item]) => item);
  return { added, removed };
}

function resolveSourceName(sourceId: string, sourceName: string, catalog: SourceCatalog): string {
  if (sourceName) return sourceName;
  return (sourceId && catalog.byId.get(sourceId)) || "";
}

function formatAuthoritative(value: unknown, catalog: SourceCatalog): { label: string; id: string } {
  if (isRecord(value)) {
    const id = formatValue(value.id ?? value.sourceId ?? "").trim();
    const name = formatValue(value.name ?? value.displayName ?? "").trim();
    return labelForSource(name, id, catalog);
  }
  const raw = formatValue(value).trim();
  if (!raw) return { label: "", id: "" };
  const already = raw.match(/^(.+?) \(([0-9a-f-]{32,36})\)$/i);
  if (already) return { label: raw, id: already[2] };
  if (catalog.byId.has(raw)) {
    return { label: `${catalog.byId.get(raw)} (${raw})`, id: raw };
  }
  const idFromName = catalog.byName.get(raw.toLowerCase());
  if (idFromName) {
    const name = catalog.byId.get(idFromName) ?? raw;
    return { label: `${name} (${idFromName})`, id: idFromName };
  }
  if (/^[0-9a-f]{32}$/i.test(raw) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
    warnOnce(`No source name for authoritative source id ${raw}.`);
    return { label: `unknown (${raw})`, id: raw };
  }
  return { label: raw, id: "" };
}

function labelForSource(name: string, id: string, catalog: SourceCatalog): { label: string; id: string } {
  const resolvedName = name || (id ? catalog.byId.get(id) ?? "" : "");
  const resolvedId = id || (name ? catalog.byName.get(name.toLowerCase()) ?? "" : "");
  if (resolvedName && resolvedId) return { label: `${resolvedName} (${resolvedId})`, id: resolvedId };
  if (resolvedId) return { label: `unknown (${resolvedId})`, id: resolvedId };
  return { label: resolvedName, id: "" };
}

function eventInstant(event: Record<string, unknown>): { date: string; time: number } | null {
  const candidates: Array<[string, unknown]> = [
    ["dateTime", event.dateTime],
    ["date", event.date],
    ["created", event.created],
    ["timestamp", event.timestamp],
  ];
  for (const [field, value] of candidates) {
    if (typeof value !== "string" || !value.trim()) continue;
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) continue;
    if (field !== "dateTime") warnOnce(`Event date used ${field} because dateTime was empty or unparseable.`);
    return { date: value, time: ms };
  }
  return null;
}

function readAttributeChange(raw: unknown): { name: string; previous: unknown; next: unknown } | null {
  if (!isRecord(raw)) return null;
  if (raw.previousValue === undefined && raw.oldValue !== undefined) {
    warnOnce("An AttributesChanged entry used oldValue instead of previousValue.");
  }
  if (raw.name === undefined && (raw.attribute !== undefined || raw.attributeName !== undefined)) {
    warnOnce("An AttributesChanged entry used attribute/attributeName instead of name.");
  }
  const name = formatValue(raw.name ?? raw.attribute ?? raw.attributeName ?? "");
  const previous = raw.previousValue !== undefined ? raw.previousValue : raw.oldValue;
  const next = raw.newValue !== undefined ? raw.newValue : raw.value;
  return { name, previous, next };
}

function selectWindow(
  snapshots: LoadedSnapshot[],
  start: StartBound,
): { window: LoadedSnapshot[]; pairs: Array<[LoadedSnapshot, LoadedSnapshot]> } {
  const ordered = [...snapshots].sort((a, b) => a.time - b.time || a.date.localeCompare(b.date));
  if (start.mode === "all") {
    return { window: ordered, pairs: consecutive(ordered) };
  }
  const prior = ordered.filter((snapshot) => snapshot.time < start.ms);
  const window = ordered.filter((snapshot) => snapshot.time >= start.ms);
  const baseline = prior.length > 0 ? prior[prior.length - 1] : null;
  const sequence = baseline ? [baseline, ...window] : window;
  return { window, pairs: consecutive(sequence) };
}

function consecutive(snapshots: LoadedSnapshot[]): Array<[LoadedSnapshot, LoadedSnapshot]> {
  const pairs: Array<[LoadedSnapshot, LoadedSnapshot]> = [];
  for (let i = 1; i < snapshots.length; i++) pairs.push([snapshots[i - 1], snapshots[i]]);
  return pairs;
}

function buildReport(
  snapshots: LoadedSnapshot[],
  events: unknown[],
  start: StartBound,
  catalog: SourceCatalog,
): Report {
  const { window, pairs } = selectWindow(snapshots, start);
  const startMs = start.mode === "all" ? Number.NEGATIVE_INFINITY : start.ms;
  const timeline: TimelineRow[] = [];

  const correlation: string[][] = [];
  const accessItems: string[][] = [];
  const accounts: string[][] = [];
  const lifecycle: string[][] = [];
  const authoritativeSource: string[][] = [];
  const attributes: string[][] = [];
  const inventory: string[][] = [];

  for (const snapshot of window) {
    const accountsHere = snapshot.items.filter(isAccount);
    const lifecycleState = formatValue(lookupAttribute(snapshot.attributes, "cloudLifecycleState"));
    const source = formatAuthoritative(lookupAttribute(snapshot.attributes, "cloudAuthoritativeSource"), catalog);
    inventory.push([
      snapshot.date,
      lifecycleState,
      source.label,
      String(snapshot.items.length),
      String(accountsHere.length),
    ]);
    for (const account of accountsHere.sort(byName)) {
      accounts.push([
        snapshot.date,
        "snapshot",
        account.id,
        accountLabel(account),
        account.nativeIdentity,
        account.sourceId,
        resolveSourceName(account.sourceId, account.sourceName, catalog),
        account.entitlementCount,
      ]);
    }
  }

  for (const [before, after] of pairs) {
    const beforeAccounts = before.items.filter(isAccount);
    const afterAccounts = after.items.filter(isAccount);
    const accountDiff = diffByKey(beforeAccounts, afterAccounts, accountKey);
    for (const account of accountDiff.removed.sort(byName)) {
      const sourceName = resolveSourceName(account.sourceId, account.sourceName, catalog);
      correlation.push([after.date, "uncorrelated", account.id, accountLabel(account), account.nativeIdentity, account.sourceId, sourceName]);
      accounts.push([after.date, "removed", account.id, accountLabel(account), account.nativeIdentity, account.sourceId, sourceName, account.entitlementCount]);
      timeline.push(changeRow(after, "correlation", "uncorrelated", accountLabel(account), account.id, "account", sourceName, "", "", account.nativeIdentity));
      timeline.push(changeRow(after, "account", "removed", accountLabel(account), account.id, "account", sourceName, "", "", account.nativeIdentity));
    }
    for (const account of accountDiff.added.sort(byName)) {
      const sourceName = resolveSourceName(account.sourceId, account.sourceName, catalog);
      correlation.push([after.date, "correlated", account.id, accountLabel(account), account.nativeIdentity, account.sourceId, sourceName]);
      accounts.push([after.date, "added", account.id, accountLabel(account), account.nativeIdentity, account.sourceId, sourceName, account.entitlementCount]);
      timeline.push(changeRow(after, "correlation", "correlated", accountLabel(account), account.id, "account", sourceName, "", "", account.nativeIdentity));
      timeline.push(changeRow(after, "account", "added", accountLabel(account), account.id, "account", sourceName, "", "", account.nativeIdentity));
    }

    const accessDiff = diffByKey(
      before.items.filter((item) => !isAccount(item)),
      after.items.filter((item) => !isAccount(item)),
      accessKey,
    );
    for (const item of accessDiff.removed.sort(byName)) {
      const sourceName = resolveSourceName(item.sourceId, item.sourceName, catalog);
      accessItems.push([after.date, "removed", item.accessType, item.name, item.id, sourceName, item.sourceId]);
      timeline.push(changeRow(after, "access_item", "removed", item.name, item.id, item.accessType, sourceName, "", "", ""));
    }
    for (const item of accessDiff.added.sort(byName)) {
      const sourceName = resolveSourceName(item.sourceId, item.sourceName, catalog);
      accessItems.push([after.date, "added", item.accessType, item.name, item.id, sourceName, item.sourceId]);
      timeline.push(changeRow(after, "access_item", "added", item.name, item.id, item.accessType, sourceName, "", "", ""));
    }

    const fromLife = formatValue(lookupAttribute(before.attributes, "cloudLifecycleState"));
    const toLife = formatValue(lookupAttribute(after.attributes, "cloudLifecycleState"));
    if (fromLife !== toLife) {
      lifecycle.push([after.date, fromLife, toLife]);
      timeline.push(changeRow(after, "lifecycle_state", "changed", "cloudLifecycleState", "", "", "", fromLife, toLife, ""));
    }

    const fromSource = formatAuthoritative(lookupAttribute(before.attributes, "cloudAuthoritativeSource"), catalog);
    const toSource = formatAuthoritative(lookupAttribute(after.attributes, "cloudAuthoritativeSource"), catalog);
    if (fromSource.label !== toSource.label) {
      authoritativeSource.push([after.date, fromSource.label, toSource.label, fromSource.id, toSource.id]);
      timeline.push(changeRow(after, "authoritative_source", "changed", "cloudAuthoritativeSource", toSource.id, "", toSource.label, fromSource.label, toSource.label, ""));
    }

    const beforeAttributes = attributeMap(before.attributes);
    const afterAttributes = attributeMap(after.attributes);
    const names = new Set([...beforeAttributes.keys(), ...afterAttributes.keys()]);
    for (const key of [...names].sort((a, b) => a.localeCompare(b))) {
      if (skippedAttribute(key)) continue;
      const fromAttribute = beforeAttributes.get(key);
      const toAttribute = afterAttributes.get(key);
      if (sameValue(fromAttribute?.value, toAttribute?.value)) continue;
      const name = toAttribute?.name ?? fromAttribute?.name ?? key;
      const fromText = formatValue(fromAttribute?.value);
      const toText = formatValue(toAttribute?.value);
      attributes.push([after.date, name, fromText, toText]);
      timeline.push(changeRow(after, "attribute", "changed", name, "", "", "", fromText, toText, ""));
    }
  }

  const eventRows: string[][] = [];
  const eventAttributeRows: string[][] = [];
  let undated = 0;
  for (const rawEvent of events) {
    if (!isRecord(rawEvent)) continue;
    const when = eventInstant(rawEvent);
    if (!when) {
      undated++;
      continue;
    }
    if (when.time < startMs) continue;
    const access = isRecord(rawEvent.accessItem) ? rawEvent.accessItem : {};
    const accessType = formatValue(rawEvent.accessItemType ?? access.accessType ?? "");
    const accessId = formatValue(access.id ?? "");
    const accessName = formatValue(access.displayName ?? access.name ?? "");
    const sourceName = formatValue(access.sourceName ?? "");
    const eventType = formatValue(rawEvent.eventType ?? "");
    eventRows.push([
      when.date,
      eventType,
      formatValue(rawEvent.identityId ?? ""),
      accessType,
      accessId,
      accessName,
      sourceName,
      JSON.stringify(rawEvent),
    ]);
    timeline.push({
      date: when.date,
      time: when.time,
      category: "event",
      action: eventType,
      name: accessName,
      id: accessId,
      type: accessType,
      source: sourceName,
      from: "",
      to: "",
      detail: clip(JSON.stringify(rawEvent), 500),
    });

    const changes = rawEvent.attributeChanges;
    const changeList = Array.isArray(changes) ? changes : changes && isRecord(changes) ? [changes] : [];
    if (changeList.length > 0 && eventType !== "AttributesChanged") {
      warnOnce(`attributeChanges found on eventType ${eventType || "(blank)"}.`);
    }
    for (const change of changeList) {
      const parsed = readAttributeChange(change);
      if (!parsed) continue;
      const previous = formatValue(parsed.previous);
      const next = formatValue(parsed.next);
      eventAttributeRows.push([when.date, eventType || "AttributesChanged", parsed.name, previous, next]);
      timeline.push({
        date: when.date,
        time: when.time,
        category: "event_attribute",
        action: "changed",
        name: parsed.name,
        id: "",
        type: eventType || "AttributesChanged",
        source: "",
        from: previous,
        to: next,
        detail: "",
      });
    }
  }
  if (undated > 0) warnOnce(`${undated} event(s) had no parseable date and were left out of the CSV files.`);

  accounts.sort((a, b) => Date.parse(a[0]) - Date.parse(b[0]) || a[1].localeCompare(b[1]) || a[3].localeCompare(b[3]));
  eventRows.sort((a, b) => Date.parse(a[0]) - Date.parse(b[0]) || a[1].localeCompare(b[1]));
  eventAttributeRows.sort((a, b) => Date.parse(a[0]) - Date.parse(b[0]) || a[2].localeCompare(b[2]));
  timeline.sort((a, b) => a.time - b.time || a.category.localeCompare(b.category) || a.name.localeCompare(b.name) || a.action.localeCompare(b.action));

  return {
    correlation,
    accessItems,
    accounts,
    lifecycle,
    authoritativeSource,
    attributes,
    events: eventRows,
    eventAttributes: eventAttributeRows,
    inventory,
    timeline: timeline.map((row) => [row.date, row.category, row.action, row.name, row.id, row.type, row.source, row.from, row.to, row.detail]),
  };
}

function accountLabel(account: AccessItem): string {
  return account.name || account.nativeIdentity || account.id;
}

function byName(a: AccessItem, b: AccessItem): number {
  return accountLabel(a).localeCompare(accountLabel(b)) || a.id.localeCompare(b.id);
}

function changeRow(
  snapshot: LoadedSnapshot,
  category: string,
  action: string,
  name: string,
  id: string,
  type: string,
  source: string,
  from: string,
  to: string,
  detail: string,
): TimelineRow {
  return {
    date: snapshot.date,
    time: snapshot.time,
    category,
    action,
    name,
    id,
    type,
    source,
    from,
    to,
    detail,
  };
}

async function mapPool<T, R>(items: T[], workers: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const run = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await task(items[index], index);
    }
  };
  const count = Math.max(1, Math.min(workers, items.length));
  await Promise.all(Array.from({ length: count }, () => run()));
  return results;
}

function inspectShapes(detail: unknown, sampleItem: unknown, events: unknown[], itemCount: number): void {
  if (!isRecord(detail)) {
    info(`Snapshot detail was ${Array.isArray(detail) ? "an array" : typeof detail}, not an object.`);
  } else {
    info(`Snapshot detail keys: ${Object.keys(detail).sort().join(", ") || "(none)"}`);
    const count = detail.accessItemCount;
    const countKind = count === null ? "null" : Array.isArray(count) ? "an array" : typeof count;
    info(
      `accessItemCount is ${countKind}. Inventory access_item_count is ${itemCount}, counted from the access-items response.`,
    );
    if (!isRecord(detail.attributes)) {
      info("Snapshot detail has no attributes object. Lifecycle, authoritative source, and attribute diffs will be empty.");
    } else {
      info(`Attribute keys: ${Object.keys(detail.attributes).sort().join(", ") || "(none)"}`);
    }
  }
  if (isRecord(sampleItem)) info(`Access item keys: ${Object.keys(sampleItem).sort().join(", ")}`);
  else info("Access-items response had no objects to inspect.");
  const firstEvent = events.find(isRecord);
  if (firstEvent) info(`Event keys: ${Object.keys(firstEvent).sort().join(", ")}`);
  else info("Events response had no objects to inspect.");
}

function attributesOf(detail: unknown): Record<string, unknown> {
  if (!isRecord(detail) || !isRecord(detail.attributes)) return {};
  return detail.attributes;
}

async function loadSnapshot(clients: SdkClients, id: string, date: string): Promise<LoadedSnapshot> {
  const [detail, rawItems] = await Promise.all([
    getSnapshotDetail(clients, id, date),
    listSnapshotAccessItems(clients, id, date),
  ]);
  const items = rawItems.map(readAccessItem).filter((item): item is AccessItem => item !== null);
  const dropped = rawItems.length - items.length;
  if (dropped > 0) warnOnce(`${dropped} access item(s) on ${date} had no accessType and were skipped.`);
  return {
    date,
    time: parseInstant(date, `Snapshot ${date}`),
    attributes: attributesOf(detail),
    items,
    detail,
    sampleItem: rawItems.find(isRecord),
  };
}

async function loadSources(clients: SdkClients): Promise<SourceCatalog> {
  const raw = await paginate("sources", (offset) => listSourcePage(clients, offset));
  const byId = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const id = formatValue(entry.id).trim();
    const name = formatValue(entry.name).trim();
    if (!id || !name) continue;
    byId.set(id, name);
    byName.set(name.toLowerCase(), id);
  }
  info(`Loaded ${byId.size} source name(s).`);
  return { byId, byName };
}

function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

async function writeCsv(file: string, headers: string[], rows: string[][]): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const stream = createWriteStream(file, { encoding: "utf8" });
    let failed = false;
    const fail = (err: Error): void => {
      if (failed) return;
      failed = true;
      reject(err);
    };
    const writeChunk = async (chunk: string): Promise<void> => {
      if (failed) return;
      if (!stream.write(chunk)) {
        await new Promise<void>((resume) => stream.once("drain", resume));
      }
    };
    stream.on("error", fail);
    void (async () => {
      try {
        await writeChunk(`${headers.join(",")}\n`);
        for (const row of rows) {
          if (row.length !== headers.length) throw new Error(`Column mismatch writing ${file}`);
          await writeChunk(`${row.map(csvEscape).join(",")}\n`);
        }
        stream.end();
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
        stream.destroy();
      }
    })();
    stream.on("finish", () => {
      if (!failed) resolve();
    });
  });
}

function printSummary(outDir: string, files: Array<{ name: string; headers: string[]; rows: string[][] }>): void {
  console.log(`Output directory: ${outDir}`);
  console.log("YYYY-MM-DD starts at UTC midnight. Snapshot inventory and per-snapshot account rows are state, so they are left out of timeline_all_changes.csv.");
  console.log("Account adds and removes also appear as correlation rows. Both are in the timeline.");
  for (const file of files) {
    console.log(`${file.name}\t${file.rows.length}`);
  }
  console.log("");
  for (const file of files) {
    console.log(`Sample ${file.name}`);
    const header = file.headers.join(",");
    console.log(clip(header, 240));
    if (file.rows.length === 0) {
      console.log("(no rows)");
    } else {
      for (const row of file.rows.slice(0, 2)) {
        console.log(clip(row.map(csvEscape).join(","), 240));
      }
    }
    console.log("");
  }
}

async function exportIdentity(options: Options): Promise<void> {
  const identityId = assertIdentityId(await promptIdentityId());
  const outDir = path.resolve(options.out || "identity-history-out");
  const clients = createClients();

  info(`Listing snapshots for ${identityId}.`);
  let rawSnapshots: unknown[];
  try {
    rawSnapshots = await listSnapshots(clients, identityId);
  } catch (err) {
    if (err instanceof SailHttpError && err.status === 404) {
      throw new Error(
        `No snapshots found for identity ${identityId}. Identity History returned HTTP 404. Check the identity id.`,
      );
    }
    throw err;
  }
  if (rawSnapshots.length === 0) {
    throw new Error(
      `No snapshots found for identity ${identityId}. The snapshots list was empty. Check the identity id, and confirm Identity History is enabled for this identity.`,
    );
  }

  const dates: string[] = [];
  const seen = new Set<string>();
  for (const entry of rawSnapshots) {
    const date = snapshotDate(entry);
    if (!date) {
      throw new Error(
        `A snapshots entry had no snapshot date. First entry: ${clip(JSON.stringify(rawSnapshots[0]), 400)}`,
      );
    }
    parseInstant(date, "Snapshot list date");
    if (seen.has(date)) continue;
    seen.add(date);
    dates.push(date);
  }
  dates.sort((a, b) => Date.parse(a) - Date.parse(b) || a.localeCompare(b));
  info(`Found ${dates.length} snapshot(s), from ${dates[0]} through ${dates[dates.length - 1]}.`);

  const start = options.start;
  let inRange = dates;
  let baselineDate: string | null = null;
  if (start.mode === "date") {
    const startMs = start.ms;
    inRange = dates.filter((date) => Date.parse(date) >= startMs);
    const prior = dates.filter((date) => Date.parse(date) < startMs);
    baselineDate = prior.length > 0 ? prior[prior.length - 1] : null;
  }
  if (inRange.length === 0) {
    const startLabel = start.mode === "all" ? "all" : start.iso;
    throw new Error(
      `No snapshots on or after ${startLabel}. The latest snapshot is ${dates[dates.length - 1]}. Use --start all to include earlier history.`,
    );
  }
  const toLoad = baselineDate ? [baselineDate, ...inRange] : inRange;
  if (baselineDate) info(`Baseline snapshot before the start date: ${baselineDate}`);
  else if (options.start.mode === "date") {
    info("No snapshot exists before the start date. The earliest in-range snapshot has no incoming diff.");
  }

  const [catalog, rawEvents, loaded] = await Promise.all([
    loadSources(clients),
    listEvents(clients, identityId),
    mapPool(toLoad, options.workers, async (date, index) => {
      info(`Loading snapshot ${index + 1} of ${toLoad.length}: ${date}`);
      return loadSnapshot(clients, identityId, date);
    }),
  ]);

  const sample = loaded.find((snapshot) => inRange.includes(snapshot.date)) ?? loaded[0];
  inspectShapes(sample?.detail, sample?.sampleItem, rawEvents, sample?.items.length ?? 0);

  const { window, pairs } = selectWindow(loaded, options.start);
  info(`${window.length} snapshot(s) in range, ${pairs.length} consecutive pair(s), ${rawEvents.length} event(s) before date filtering.`);

  const report = buildReport(loaded, rawEvents, options.start, catalog);
  const files: Array<{ name: string; headers: string[]; rows: string[][] }> = [
    {
      name: "identity_correlation.csv",
      headers: ["date", "action", "account_id", "account_name", "native_identity", "source_id", "source_name"],
      rows: report.correlation,
    },
    {
      name: "access_items.csv",
      headers: ["date", "action", "type", "name", "id", "source_name", "source_id"],
      rows: report.accessItems,
    },
    {
      name: "accounts.csv",
      headers: ["date", "record_type", "account_id", "account_name", "native_identity", "source_id", "source_name", "entitlement_count"],
      rows: report.accounts,
    },
    {
      name: "lifecycle_state.csv",
      headers: ["date", "from", "to"],
      rows: report.lifecycle,
    },
    {
      name: "authoritative_source.csv",
      headers: ["date", "from", "to", "from_id", "to_id"],
      rows: report.authoritativeSource,
    },
    {
      name: "attribute_changes.csv",
      headers: ["date", "attribute", "from", "to"],
      rows: report.attributes,
    },
    {
      name: "events.csv",
      headers: ["date", "event_type", "identity_id", "access_item_type", "access_item_id", "access_item_name", "source_name", "raw_json"],
      rows: report.events,
    },
    {
      name: "event_attribute_changes.csv",
      headers: ["date", "event_type", "name", "previous_value", "new_value"],
      rows: report.eventAttributes,
    },
    {
      name: "snapshot_inventory.csv",
      headers: ["date", "lifecycle_state", "authoritative_source", "access_item_count", "account_count"],
      rows: report.inventory,
    },
    {
      name: "timeline_all_changes.csv",
      headers: ["date", "category", "action", "name", "id", "type", "source", "from", "to", "detail"],
      rows: report.timeline,
    },
  ];

  await mkdir(outDir, { recursive: true });
  for (const file of files) {
    await writeCsv(path.join(outDir, file.name), file.headers, file.rows);
  }
  printSummary(outDir, files);
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(`self-test failed: ${message}`);
}

function selfTest(): void {
  assert(typeof sailpoint.IdentityHistoryApi === "function", "IdentityHistoryApi loaded from the SDK");
  assert(typeof sailpoint.SourcesApi === "function", "SourcesApi loaded from the SDK");
  assert(isRetryableHttpStatus(429) && isRetryableHttpStatus(503), "throttle and gateway errors retry");
  assert(!isRetryableHttpStatus(400) && !isRetryableHttpStatus(404), "client errors do not retry");
  assert(isRetryableCode("ECONNABORTED"), "request timeout retries");
  assert(!isRetryableCode("ERR_BAD_REQUEST"), "a bad request code does not retry");
  const auth = readSdkFailure(Object.assign(new Error("Request failed with status code 401"), { status: 401 }));
  assert(isAuthFailure(auth), "401 is an authentication failure");

  const catalog: SourceCatalog = {
    byId: new Map([
      ["id-1", "HR Source"],
      ["id-2", "Authoritative"],
    ]),
    byName: new Map([
      ["hr source", "id-1"],
      ["authoritative", "id-2"],
    ]),
  };
  const before: LoadedSnapshot = {
    date: "2026-02-01T00:00:00Z",
    time: Date.parse("2026-02-01T00:00:00Z"),
    attributes: {
      cloudLifecycleState: "active",
      cloudAuthoritativeSource: "id-1",
      department: "Sales",
      modified: "2026-02-01T00:00:00Z",
      identityProfile: "Employee",
      lastRefresh: "2026-02-01T00:00:00Z",
    },
    items: [
      { accessType: "account", id: "acct-ad", name: "Ada", sourceName: "", sourceId: "id-1", nativeIdentity: "ada", entitlementCount: "2" },
      { accessType: "entitlement", id: "ent-1", name: "Domain Users", sourceName: "HR Source", sourceId: "id-1", nativeIdentity: "", entitlementCount: "" },
    ],
    detail: { attributes: {}, accessItemCount: { account: 1, entitlement: 1 } },
    sampleItem: { accessType: "account", id: "acct-ad", displayName: "Ada" },
  };
  const after: LoadedSnapshot = {
    date: "2026-03-15T12:00:00Z",
    time: Date.parse("2026-03-15T12:00:00Z"),
    attributes: {
      cloudLifecycleState: "inactive",
      cloudAuthoritativeSource: "id-2",
      department: "Engineering",
      modified: "2026-03-15T12:00:00Z",
      identityProfile: "Contractor",
      processingState: "COMPLETE",
    },
    items: [
      { accessType: "account", id: "acct-az", name: "Ada Azure", sourceName: "Azure", sourceId: "id-9", nativeIdentity: "ada@corp", entitlementCount: "1" },
      { accessType: "role", id: "role-1", name: "Engineer", sourceName: "", sourceId: "", nativeIdentity: "", entitlementCount: "" },
    ],
    detail: { attributes: {}, accessItemCount: { account: 1, role: 1 } },
    sampleItem: { accessType: "role", id: "role-1", displayName: "Engineer" },
  };
  const events = [
    {
      eventType: "AttributesChanged",
      dateTime: "2026-02-15T00:00:00Z",
      identityId: "person-1",
      attributeChanges: [{ name: "department", previousValue: "Old", newValue: "Sales" }],
    },
    {
      eventType: "AttributesChanged",
      dateTime: "2026-03-15T12:00:00Z",
      identityId: "person-1",
      attributeChanges: [{ name: "department", previousValue: "Sales", newValue: "Engineering" }],
    },
    {
      eventType: "AccessItemAssociated",
      dateTime: "2026-03-20T00:00:00Z",
      identityId: "person-1",
      accessItemType: "role",
      accessItem: { id: "role-1", displayName: "Engineer", accessType: "role", sourceName: "ISC" },
    },
  ];
  const report = buildReport([before, after], events, parseStart("2026-03-01"), catalog);
  assert(report.correlation.length === 2, "correlation add and remove");
  assert(report.correlation.some((row) => row[1] === "uncorrelated" && row[2] === "acct-ad" && row[6] === "HR Source"), "uncorrelated source name");
  assert(report.correlation.some((row) => row[1] === "correlated" && row[2] === "acct-az"), "correlated account");
  assert(report.accessItems.some((row) => row[1] === "removed" && row[2] === "entitlement" && row[4] === "ent-1"), "entitlement removed");
  assert(report.accessItems.some((row) => row[1] === "added" && row[2] === "role" && row[3] === "Engineer"), "role added");
  assert(report.accounts.filter((row) => row[1] === "snapshot").length === 1, "account inventory is in-window only");
  assert(report.accounts.some((row) => row[1] === "added" && row[2] === "acct-az"), "account added");
  assert(report.accounts.some((row) => row[1] === "removed" && row[2] === "acct-ad"), "account removed");
  assert(report.lifecycle.length === 1 && report.lifecycle[0][1] === "active" && report.lifecycle[0][2] === "inactive", "lifecycle transition");
  assert(report.authoritativeSource[0]?.[1] === "HR Source (id-1)" && report.authoritativeSource[0]?.[2] === "Authoritative (id-2)", "authoritative source labels");
  assert(report.attributes.length === 1 && report.attributes[0][1] === "department", "only the business attribute change");
  const beforeAttributes = { ...before.attributes };
  delete beforeAttributes.department;
  const folded = buildReport(
    [
      { ...before, attributes: { ...beforeAttributes, Department: "Sales" } },
      after,
    ],
    [],
    parseStart("2026-03-01"),
    catalog,
  );
  assert(
    folded.attributes.filter((row) => row[1].toLowerCase() === "department").length === 1,
    "attribute names that differ only by case are one change",
  );
  assert(!report.attributes.some((row) => row[1].toLowerCase().includes("identityprofile")), "identity profile omitted");
  assert(report.inventory.length === 1 && report.inventory[0][3] === "2" && report.inventory[0][4] === "1", "counts come from access items");
  assert(report.events.length === 2, "event before the start date is excluded");
  assert(report.eventAttributes.length === 1 && report.eventAttributes[0][2] === "department" && report.eventAttributes[0][3] === "Sales", "event attribute change");
  const timelineDates = report.timeline.map((row) => row[0]);
  const sorted = [...timelineDates].sort((a, b) => Date.parse(a) - Date.parse(b));
  assert(timelineDates.join("|") === sorted.join("|"), "timeline sorted by date");
  assert(report.timeline.some((row) => row[1] === "event" && row[2] === "AccessItemAssociated"), "raw event in timeline");

  const allHistory = buildReport([before, after], [], { mode: "all" }, catalog);
  assert(allHistory.inventory.length === 2, "all includes both snapshots");
  assert(allHistory.lifecycle.length === 1, "all still diffs consecutive snapshots");

  const noBaseline = selectWindow([after], parseStart("2026-03-01"));
  assert(noBaseline.pairs.length === 0 && noBaseline.window.length === 1, "single in-range snapshot has no pair");

  let startFailed = false;
  try {
    parseStart("2026-02-31");
  } catch {
    startFailed = true;
  }
  assert(startFailed, "invalid calendar date");
  console.log("self-test passed");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) {
    selfTest();
    return;
  }
  await exportIdentity(options);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exitCode = 1;
});
