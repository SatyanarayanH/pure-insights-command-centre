/** Regenerates the simulated ACCOUNT_USAGE files under data/generated. */
import { DEFAULT_GENERATED_DIR, DEFAULT_RAW_CSV } from '../paths.js';
import { ensureSimulation } from '../warehouse/build.js';

const started = performance.now();
const { manifest } = ensureSimulation(
  process.env.RAW_CSV ?? DEFAULT_RAW_CSV,
  process.env.GENERATED_DIR ?? DEFAULT_GENERATED_DIR,
  undefined,
  true,
);
console.log(JSON.stringify(manifest, null, 2));
console.log(
  `Simulated in ${Math.round(performance.now() - started)} ms -> ${DEFAULT_GENERATED_DIR}`,
);
