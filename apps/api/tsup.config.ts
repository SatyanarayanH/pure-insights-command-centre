import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // The contracts workspace ships TypeScript source, so it is bundled; everything else
  // stays external and is resolved from node_modules at runtime.
  noExternal: ['@picc/contracts'],
  // `node:sqlite` only exists under its prefixed name, so the prefix must survive bundling.
  removeNodeProtocol: false,
});
