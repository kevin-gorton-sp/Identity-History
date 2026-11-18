/**
 * Bundle the export and inject it into official Node.js binaries.
 * One run writes macOS, Windows, and Linux executables under dist/.
 * The blob is produced by the same Node version that is injected, and
 * code cache and snapshots stay off so a Linux build can target other OSes.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const NODE_VERSION = "22.23.4";
const FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const cache = path.join(dist, "cache");
const bundlePath = path.join(cache, "bundle.cjs");
const blobPath = path.join(cache, "sea-prep.blob");
const seaConfigPath = path.join(cache, "sea-config.json");

const targets = [
  { id: "darwin-arm64", archive: "tar.gz", binary: "bin/node", output: "identity-history-macos-arm64", macho: true },
  { id: "darwin-x64", archive: "tar.gz", binary: "bin/node", output: "identity-history-macos-x64", macho: true },
  { id: "linux-x64", archive: "tar.gz", binary: "bin/node", output: "identity-history-linux-x64", macho: false },
  { id: "linux-arm64", archive: "tar.gz", binary: "bin/node", output: "identity-history-linux-arm64", macho: false },
  { id: "win-x64", archive: "zip", binary: "node.exe", output: "identity-history-windows-x64.exe", macho: false },
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}`);
  }
}

async function bundle() {
  await esbuild.build({
    entryPoints: [path.join(root, "export-identity-history.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    outfile: bundlePath,
    absWorkingDir: root,
    mainFields: ["main"],
    conditions: ["node", "require", "default"],
    legalComments: "none",
    logLevel: "info",
    plugins: [
      {
        name: "bundle-sailpoint-cjs",
        setup(build) {
          build.onLoad({ filter: /export-identity-history\.ts$/ }, async (args) => {
            const source = await readFile(args.path, "utf8");
            const replaced = source
              .replace('import { createRequire } from "node:module";\n', "")
              .replace(
                'const require = createRequire(import.meta.url);\nconst sailpoint = require("sailpoint-api-client") as typeof import("sailpoint-api-client");\n',
                'import * as sailpoint from "sailpoint-api-client";\n',
              );
            if (replaced === source) {
              throw new Error("Could not rewrite the SailPoint SDK load for the executable bundle.");
            }
            return { contents: replaced, loader: "ts" };
          });
        },
      },
    ],
  });
}

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}) for ${url}`);
  }
  await pipeline(response.body, createWriteStream(destination));
}

async function sha256(file) {
  const hash = createHash("sha256");
  hash.update(await readFile(file));
  return hash.digest("hex");
}

async function nodeBinary(target) {
  const folder = `node-v${NODE_VERSION}-${target.id}`;
  const archiveName = `${folder}.${target.archive}`;
  const archivePath = path.join(cache, archiveName);
  const extractDir = path.join(cache, target.id);
  const binaryPath = path.join(extractDir, folder, target.binary);
  if (await exists(binaryPath)) return binaryPath;

  const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
  const sumsResponse = await fetch(`${base}/SHASUMS256.txt`);
  if (!sumsResponse.ok) {
    throw new Error(`Node.js ${NODE_VERSION} checksum list was not found. This build pins that version.`);
  }
  const sums = new Map(
    (await sumsResponse.text())
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sum, name] = line.trim().split(/\s+/);
        return [name, sum];
      }),
  );
  const expected = sums.get(archiveName);
  if (!expected) throw new Error(`No checksum published for ${archiveName}`);

  console.log(`Downloading ${archiveName}`);
  await download(`${base}/${archiveName}`, archivePath);
  const actual = await sha256(archivePath);
  if (actual !== expected) {
    throw new Error(`Checksum mismatch for ${archiveName}`);
  }

  await rm(extractDir, { recursive: true, force: true });
  await mkdir(extractDir, { recursive: true });
  if (target.archive === "zip") {
    run("unzip", ["-q", archivePath, "-d", extractDir]);
  } else {
    run("tar", ["-xzf", archivePath, "-C", extractDir]);
  }
  if (!(await exists(binaryPath))) throw new Error(`Node binary missing at ${binaryPath}`);
  return binaryPath;
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch (err) {
    if (err && err.code === "ENOENT") return false;
    throw err;
  }
}

async function prepareBlob(linuxNode) {
  await writeFile(
    seaConfigPath,
    `${JSON.stringify(
      {
        main: bundlePath,
        output: blobPath,
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
        useCodeCache: false,
      },
      null,
      2,
    )}\n`,
  );
  run(linuxNode, ["--experimental-sea-config", seaConfigPath]);
}

function inject(binary, macho) {
  const postject = path.join(root, "node_modules", "postject", "dist", "cli.js");
  const args = [postject, binary, "NODE_SEA_BLOB", blobPath, "--sentinel-fuse", FUSE];
  if (macho) args.push("--macho-segment-name", "NODE_SEA");
  run(process.execPath, args);
}

async function main() {
  await mkdir(cache, { recursive: true });
  console.log("Bundling export-identity-history.ts");
  await bundle();

  const linuxNode = await nodeBinary(targets.find((target) => target.id === "linux-x64"));
  await chmod(linuxNode, 0o755);
  console.log(`Preparing the Node ${NODE_VERSION} executable blob`);
  await prepareBlob(linuxNode);

  for (const target of targets) {
    const source = await nodeBinary(target);
    const output = path.join(dist, target.output);
    await copyFile(source, output);
    if (target.id !== "win-x64") await chmod(output, 0o755);
    console.log(`Injecting ${target.output}`);
    inject(output, target.macho);
    if (target.id !== "win-x64") await chmod(output, 0o755);
  }

  console.log(`Wrote ${targets.length} executables to ${dist}`);
  for (const target of targets) console.log(`  ${target.output}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
