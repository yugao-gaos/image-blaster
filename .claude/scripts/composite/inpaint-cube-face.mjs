#!/usr/bin/env node
// inpaint-cube-face.mjs
//
// Synchronous cube-face inpainting via FAL `fal-ai/flux-pro/v1/fill`.
// Blocks until the FAL call completes, downloads the inpainted PNG to --output,
// writes a request sidecar JSON beside the output for provenance, and prints a
// result JSON to stdout. Per the repo's "Generation Scripts Are Synchronous"
// rule, never run this with run_in_background / tail.
//
// Usage:
//   node .claude/scripts/composite/inpaint-cube-face.mjs \
//     --face-png <path> --mask-png <path> --output <path> [--prompt "<text>"]
//     [--dry-run]
//
// Powers the `/__cube-inpaint` middleware contract in vite.config.ts.

import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  callFalQueue,
  collectRemoteFiles,
  downloadFile,
  ensureDir,
  one,
  parseArgs,
  pathExists,
  sanitizeForMetadata,
  toModelInputUrl,
  writeJson
} from "../asset-pipeline/fal-queue.mjs";
import {
  buildRequestSummary,
  parseIndexedName,
  requestPath
} from "../asset-pipeline/request-metadata.mjs";

const ENDPOINT = "fal-ai/flux-pro/v1/fill";

// flux-fill (flux-pro/v1/fill) standard masked-inpaint schema is
// { image_url, mask_url, prompt }. White pixels in the mask mark the region to
// regenerate; black pixels are preserved. Local files are uploaded as data
// URIs via toModelInputUrl so no separate upload round-trip is needed.
async function buildFalInput({ facePng, maskPng, prompt }) {
  if (!(await pathExists(facePng))) {
    throw new Error(`--face-png does not exist: ${facePng}`);
  }
  if (!(await pathExists(maskPng))) {
    throw new Error(`--mask-png does not exist: ${maskPng}`);
  }

  return {
    image_url: await toModelInputUrl(facePng),
    mask_url: await toModelInputUrl(maskPng),
    prompt: prompt ?? ""
  };
}

// Sidecar lives beside --output following the hidden `.N-slug-request.json`
// convention when the output name is indexed (e.g. cube-capture-0-px-inpainted
// style under output/world/). Otherwise fall back to `.<basename>-request.json`
// so provenance still lands next to the artifact regardless of naming.
function sidecarPathFor(outputPath) {
  const dir = path.dirname(outputPath);
  const parsed = parseIndexedName(outputPath);
  if (parsed && !parsed.hidden) {
    return requestPath(dir, parsed.index, parsed.slug, parsed.scope);
  }
  const base = path.basename(outputPath, path.extname(outputPath));
  return path.join(dir, `.${base}-request.json`);
}

function describeForDryRun(input) {
  const describe = (value) =>
    typeof value === "string" && value.startsWith("data:")
      ? `<data-uri len ${value.length}>`
      : value;
  return {
    image_url: describe(input.image_url),
    mask_url: describe(input.mask_url),
    prompt: input.prompt
  };
}

export async function inpaintCubeFace(options) {
  const { facePng, maskPng, output, prompt = "", dryRun = false } = options;

  if (!facePng) throw new Error("--face-png is required.");
  if (!maskPng) throw new Error("--mask-png is required.");
  if (!output) throw new Error("--output is required.");

  const input = await buildFalInput({ facePng, maskPng, prompt });

  if (dryRun) {
    return {
      ok: true,
      dry_run: true,
      endpoint: ENDPOINT,
      output,
      input: describeForDryRun(input)
    };
  }

  await ensureDir(path.dirname(output));
  const metadataPath = sidecarPathFor(output);

  const submittedAt = new Date().toISOString();
  const result = await callFalQueue(ENDPOINT, input, {
    metadataPath,
    metadata: {
      kind: "cube-inpaint",
      provider: ENDPOINT,
      endpoint: ENDPOINT,
      role: "cube-inpaint",
      prompt,
      input: sanitizeForMetadata(input)
    }
  });

  const remoteFiles = collectRemoteFiles(result.data);
  const image = remoteFiles[0]?.file;
  if (!image?.url) {
    throw new Error("FAL flux-fill did not return a downloadable image.");
  }

  await downloadFile(image.url, output);

  const summary = buildRequestSummary({
    kind: "cube-inpaint",
    provider: ENDPOINT,
    endpoint: ENDPOINT,
    metadata: {
      role: "cube-inpaint",
      face_png: facePng,
      mask_png: maskPng,
      // input is sanitized (base64/data-uris stripped) for provenance only.
      input: sanitizeForMetadata(input)
    },
    requestId: result.requestId,
    submittedAt,
    prompt,
    inputFiles: [facePng, maskPng],
    outputFiles: [output],
    downloadedFiles: [{ label: "inpainted", path: output, source: image }],
    result: result.data
  });
  await writeJson(metadataPath, summary);

  return {
    ok: true,
    output,
    model: ENDPOINT,
    request_metadata: metadataPath
  };
}

async function main() {
  const { flags } = parseArgs();
  const facePng = one(flags, "face-png");
  const maskPng = one(flags, "mask-png");
  const output = one(flags, "output");
  const prompt = one(flags, "prompt", "");
  const dryRun = flags["dry-run"] === true;

  if (!facePng || !maskPng || !output) {
    throw new Error(
      'Usage: node .claude/scripts/composite/inpaint-cube-face.mjs --face-png <path> --mask-png <path> --output <path> [--prompt "<text>"] [--dry-run]'
    );
  }

  const result = await inpaintCubeFace({
    facePng,
    maskPng,
    output,
    prompt: prompt === true ? "" : prompt,
    dryRun
  });

  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
