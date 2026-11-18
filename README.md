# Identity History

Export one SailPoint Identity Security Cloud (ISC) identity's history to CSV. The script reads Identity History and the source catalog through the SailPoint TypeScript SDK (`sailpoint-api-client`) and writes the differences between snapshots, plus the historical events, into a local directory.

Identity History is an experimental API. The script sets `configuration.experimental` so the SDK sends `X-SailPoint-Experimental: true`.

## Install

Install [Node.js 22](https://nodejs.org/), then install this project's dependencies from the repository root:

```bash
npm install
```

Creating `config.json` with the SailPoint CLI also requires the [SailPoint CLI](https://developer.sailpoint.com/docs/tools/cli/) on your `PATH`, already signed in to the tenant. The export itself runs with Node.js.

The personal access token or API client needs `idn:identity-history:read` and `idn:sources:read`. Identity History must be enabled for the identity you export.

## Configure credentials

The export reads tenant credentials from `config.json` in this directory. Create that file with the SailPoint CLI, or write it yourself. `config.json` is gitignored. Do not commit the client secret.

Have these three tenant values ready:

| Value | What to enter |
| --- | --- |
| Client ID | Client id of the personal access token or API client. |
| Client secret | Client secret issued with that client id. |
| Base URL | API base URL for the tenant, such as `https://<tenant>.api.identitynow.com`. |

### Sail CLI

From this directory, write `config.json` from the CLI's active environment:

```bash
sail sdk init config
```

That command copies the active environment's client id, client secret, and API base URL into `config.json`. It does not ask for those values again. If the CLI has more than one environment, name the one to copy:

```bash
sail sdk init config --env <environment>
```

The named environment must already contain the client id, client secret, and API base URL. Set those in the CLI before you run `sail sdk init config`.

### Manual file

Create `config.json` in this directory with the same three values:

```json
{
  "ClientId": "<client id>",
  "ClientSecret": "<client secret>",
  "BaseURL": "https://<tenant>.api.identitynow.com"
}
```

The SDK also accepts the same three values as environment variables, `SAIL_CLIENT_ID`, `SAIL_CLIENT_SECRET`, and `SAIL_BASE_URL`. A complete environment variable set is used before `config.json`. If neither is present, the SDK falls back to `~/.sailpoint/config.yaml`.

## Prompts

Starting the export asks for one value. The date window, output directory, and worker count are flags, not prompts.

### Identity ID

```text
Identity ID:
```

Enter the identity's id in ISC. That is the id stored on the identity, not the display name, email, account name, or username. Open the identity in Identity Security Cloud and copy the id. The same id is the last segment of the identity's admin URL.

The id must start with a letter or digit. The rest may contain letters, digits, `.`, `_`, `:`, and `-`, up to 201 characters. An empty answer or unsupported characters stop the run before any SailPoint call.

`--id` is not accepted. Enter the id at this prompt.

## Run

```bash
npx tsx export-identity-history.ts
```

`npm start` runs the same command and shows the same prompt.

Other options stay on the command line:

```bash
npx tsx export-identity-history.ts --start 2026-03-01 --out ./out --workers 4
```

`--help` or `-h` prints the usage text.

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `--start <YYYY-MM-DD\|all>` | `all` | First snapshot date to report, as UTC midnight. `all` diffs every consecutive snapshot. |
| `--out <dir>` | `identity-history-out` | Directory for the CSV files. Relative paths are resolved from the working directory. |
| `--workers <n>` | `4` | Parallel snapshot loads. An integer from 1 to 32. |
| `--self-test` | | Run the local checks and exit. No prompt and no tenant call. |
| `--help`, `-h` | | Print usage and exit. |

With `all`, the run loads every snapshot and every event. With a date, a snapshot before the start is kept as the baseline for the first diff and is not written as its own inventory or account-state row. If nothing falls on or after the start date, the run stops and names the latest snapshot it found.

Each SDK request times out after 120 seconds. Set `SAIL_TIMEOUT_MS` to change that. Retryable failures (HTTP 408, 429, 500, 502, 503, and 504, plus request timeouts) are tried up to 6 times. An authentication failure stops immediately.

The snapshot list is not filtered with `start` or `interval`, and events are not filtered with `from`. Those query parameters do not return a usable window from this API, so the script downloads the history and applies the start date locally.

## Output

The run creates the output directory and writes these files. `identity-history-out/` and `*.csv` are gitignored.

| File | What it contains |
| --- | --- |
| `snapshot_inventory.csv` | One row per in-range snapshot: date, lifecycle state, authoritative source, access-item count, and account count. |
| `accounts.csv` | Account state on each in-range snapshot (`record_type` `snapshot`), plus accounts added or removed between consecutive snapshots. |
| `identity_correlation.csv` | Accounts that became correlated or uncorrelated between consecutive snapshots. |
| `access_items.csv` | Non-account access (entitlements, roles, and other types) added or removed between consecutive snapshots. |
| `lifecycle_state.csv` | Changes to `cloudLifecycleState`. |
| `authoritative_source.csv` | Changes to `cloudAuthoritativeSource`, with source names filled in from the source catalog when the snapshot stores an id. |
| `attribute_changes.csv` | Other identity attribute changes. Names that differ only by case are one attribute. |
| `events.csv` | Historical events on or after the start date, including the raw event JSON. Events with no parseable date are skipped. |
| `event_attribute_changes.csv` | Attribute changes carried on those events. |
| `timeline_all_changes.csv` | The changes above in one time-ordered file. |

`timeline_all_changes.csv` leaves out snapshot inventory and the per-snapshot account rows, because those are state rather than a change. Account adds and removes appear twice in the timeline: once as a correlation row and once as an account row.

Access-item counts come from the access-items response. The snapshot's `accessItemCount` dictionary is not used. Items with no `accessType` are skipped.

These attribute names are omitted from `attribute_changes.csv`. Lifecycle state and authoritative source are reported in their own files instead.

- `modified`
- `lastRefresh`
- `processingDetails`
- `triggerSnapshots`
- `lastSyncDate`
- `processingState`
- `cloudStatus`
- `cloudLifecycleState`
- `cloudAuthoritativeSource`
- any attribute whose name is `identityProfile` or starts with `identityProfile`

Snapshots do not carry an identity profile, so profile fields are not reported.

When the run finishes, it prints the output directory, a row count for each file, and a two-row sample of each file.

## Checks

Typecheck the script:

```bash
npm run build
```

Run the local self-test. It loads the SDK and checks diff, date-window, and retry behavior without calling a tenant:

```bash
npm run self-test
```

## APIs

The script calls:

- `IdentityHistoryApi.listIdentitySnapshotsV1`
- `IdentityHistoryApi.getIdentitySnapshotV1`
- `IdentityHistoryApi.listIdentitySnapshotAccessItemsV1`
- `IdentityHistoryApi.getHistoricalIdentityEventsV1`
- `SourcesApi.listSourcesV1`

Those map to `/historical-identities/v1/...` and `/sources/v1`.
