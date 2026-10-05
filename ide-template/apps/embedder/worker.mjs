/**
 * embedder — memory v4's sentence vectors, in a process of its own.
 *
 * workspace-api forks this (lib/embedder-client.js) and talks to it over the
 * fork's IPC channel: { id, mode: 'query' | 'passage', texts } in,
 * { id, vectors } or { id, error } out. A crash or an out-of-memory here ends
 * this process only; search carries on with BM25 until the next fork.
 *
 * Model: multilingual-e5-small, int8 ONNX, pinned by revision and sha256 and
 * fetched on the deploy host (deploy.sh) — nothing is downloaded at run time
 * (allowRemoteModels = false). The e5 recipe as measured: "query: " / "passage: "
 * prefixes, mean pooling, unit-length vectors. It loads on the first request and
 * exits after 30 idle minutes to give the memory back.
 */
import { pipeline, env } from '@huggingface/transformers';

const MODEL = 'Xenova/multilingual-e5-small';
const IDLE_MS = Number(process.env.EMBEDDER_IDLE_MS) || 30 * 60_000;
env.allowRemoteModels = false;
env.useFSCache = false;   // the model is local and the image is read-only to this user: nothing to cache
env.localModelPath = process.env.EMBEDDER_MODEL_DIR || '/opt/ide/models';

let extractor = null;
let lastUse = Date.now();

async function load() {
  if (!extractor) extractor = await pipeline('feature-extraction', MODEL, { dtype: 'q8' });
  return extractor;
}

process.on('message', async (msg) => {
  lastUse = Date.now();
  const { id, mode, texts } = msg || {};
  try {
    if (!Array.isArray(texts) || texts.length > 128) throw new Error('bad request');
    const ex = await load();
    const prefix = mode === 'query' ? 'query: ' : 'passage: ';
    const out = await ex(texts.map(t => prefix + String(t)), { pooling: 'mean', normalize: true });
    process.send({ id, vectors: out.tolist() });
  } catch (err) {
    process.send({ id, error: String(err?.message || err).slice(0, 300) });
  }
});

setInterval(() => { if (Date.now() - lastUse > IDLE_MS) process.exit(0); }, 60_000).unref();
process.on('disconnect', () => process.exit(0));
