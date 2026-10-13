import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  DEFAULT_SIMULATION_PARAMS,
  SIMULATOR_VERSION,
  type SimulationManifest,
  type SimulationParams,
  sha256,
  simulateAccountUsage,
} from './simulator.js';

const MANIFEST_FILE = 'sim_manifest.json';
const GZIPPED = new Set(['query_history.csv', 'query_attribution_history.csv', 'warehouse_metering_history.csv']);

export interface EnsureSimulationResult {
  manifest: SimulationManifest;
  regenerated: boolean;
}

/** Writes the simulated ACCOUNT_USAGE files unless an up-to-date set already exists. "Up to
 *  date" means same simulator version, same parameters and the same input file hash. */
export function ensureSimulation(
  rawCsvPath: string,
  outDir: string,
  params: SimulationParams = DEFAULT_SIMULATION_PARAMS,
  force = false,
): EnsureSimulationResult {
  const rawCsv = readFileSync(rawCsvPath, 'utf8');
  const manifestPath = join(outDir, MANIFEST_FILE);

  if (!force && existsSync(manifestPath)) {
    const existing = JSON.parse(readFileSync(manifestPath, 'utf8')) as SimulationManifest;
    const current =
      existing.simulatorVersion === SIMULATOR_VERSION &&
      existing.inputSha256 === sha256(rawCsv) &&
      JSON.stringify(existing.params) === JSON.stringify(params);
    if (current) return { manifest: existing, regenerated: false };
  }

  const simulation = simulateAccountUsage(rawCsv, params);
  mkdirSync(outDir, { recursive: true });
  for (const [name, content] of Object.entries(simulation.files)) {
    if (GZIPPED.has(name)) writeFileSync(join(outDir, `${name}.gz`), gzipSync(content, { level: 6 }));
    else writeFileSync(join(outDir, name), content);
  }
  writeFileSync(manifestPath, `${JSON.stringify(simulation.manifest, null, 2)}\n`);
  return { manifest: simulation.manifest, regenerated: true };
}
