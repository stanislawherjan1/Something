/**
 * A local file an MCP tool is asked to read (an upload, an image to edit) is
 * taken from the project directory only. The path is resolved through
 * symlinks first, so a link planted in the project cannot point the tool at
 * a file elsewhere on the box, and the MCP's own uid is what reads it.
 */
import { realpathSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';

const PROJECT_DIR = process.env.PROJECT_DIR || '/home/coder/project';

let projectReal = null;
function projectRoot() {
  if (projectReal === null) {
    try { projectReal = realpathSync(PROJECT_DIR); } catch { projectReal = resolve(PROJECT_DIR); }
  }
  return projectReal;
}

/** The real path of a regular file under the project directory, or an Error. */
export function projectFile(p) {
  const given = String(p == null ? '' : p).trim();
  if (!given) throw new Error('a file path is required');
  let real;
  try { real = realpathSync(resolve(PROJECT_DIR, given)); }
  catch (err) { throw new Error(`Cannot read ${given}: ${err.message}`); }
  const root = projectRoot();
  if (real !== root && !real.startsWith(root + sep)) {
    throw new Error(`${given} is outside the project directory; only files in the workspace can be used here.`);
  }
  if (!statSync(real).isFile()) throw new Error(`${given} is not a regular file.`);
  return real;
}
