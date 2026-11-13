import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { launchGame } from '../scripts/lib/pt_harness.mjs';
export const trackPath = (name) => fileURLToPath(new URL(`../scripts/data/${name}.txt`, import.meta.url));
export async function openGame(name = 'slalom_mini') {
  return launchGame({ exposeTrack: true, mainVirtual: true, customTrack: fs.readFileSync(trackPath(name), 'utf8').trim() });
}
