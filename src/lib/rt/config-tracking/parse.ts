/**
 * Parsers for the Retellect Zabbix log-item values.
 *
 * `config.ini` item value looks like:
 *   "2026-06-07 20:24:57.981 INFO  config.ini: {'DEFAULT': {}, 'server': {…},
 *    'model': {'version': '20251122_30', 'inference_backend': 'onnx', …},
 *    'video1': {'usb_camera_index': '0', 'capture_width': '960',
 *    'capture_height': '540', …}, 'detector': {…}, …}"
 *
 * We do NOT fully parse the Python-dict (one value — ignore_products_codes —
 * is a messy multi-line blob). Instead we extract only the fields we track,
 * section by section, with targeted regexes. Sections are flat dicts (no
 * nested braces), so "'<section>': { … }" up to the first "}" is safe.
 */
import type { ConfigParamKey } from "./types";

export interface ParsedConfig {
  /** Tracked params, keyed by ConfigParamKey. Missing fields are omitted. */
  params: Partial<Record<ConfigParamKey, string>>;
  /** Lower-priority detector / synthetic fields for the Advanced block. */
  extras: { label: string; value: string }[];
}

/** Pull a flat "'section': { … }" object body out of the raw string. */
function sectionBody(raw: string, name: string): string {
  const anchor = raw.indexOf(`'${name}':`);
  if (anchor < 0) return "";
  const open = raw.indexOf("{", anchor);
  if (open < 0) return "";
  const close = raw.indexOf("}", open);
  if (close < 0) return "";
  return raw.slice(open, close + 1);
}

/** Read a `'key': 'value'` (or numeric) field from a section body. */
function field(body: string, key: string): string | null {
  const q = body.match(new RegExp(`'${key}':\\s*'([^']*)'`));
  if (q) return q[1];
  const n = body.match(new RegExp(`'${key}':\\s*([0-9.]+)`));
  return n ? n[1] : null;
}

/**
 * Parse a config.ini log-item value into tracked params + extras.
 * Returns empty params when the value is blank / unparseable.
 */
export function parseConfigIni(raw: string | null | undefined): ParsedConfig {
  const params: Partial<Record<ConfigParamKey, string>> = {};
  const extras: { label: string; value: string }[] = [];
  if (!raw || !raw.includes("config.ini")) return { params, extras };

  const video = sectionBody(raw, "video1");
  const model = sectionBody(raw, "model");
  const detector = sectionBody(raw, "detector");

  const w = field(video, "capture_width");
  const h = field(video, "capture_height");
  if (w && h) params.resolution = `${w}×${h}`;

  const cam = field(video, "usb_camera_index");
  if (cam !== null) params.cameraSource = `USB ${cam}`;

  const mv = field(model, "version");
  if (mv) params.modelVersion = mv;
  const backend = field(model, "inference_backend");
  if (backend) params.inferenceBackend = backend;
  const providers = field(model, "onnx_providers");
  if (providers) params.onnxProviders = providers.replace(/ExecutionProvider/g, "");
  const enablePred = field(model, "enable_prediction");
  if (enablePred !== null) params.enablePrediction = enablePred;
  const nResults = field(model, "number_of_results");
  if (nResults !== null) params.numberOfResults = nResults;

  // Extras (Advanced block) — operationally interesting but too granular for
  // the headline param set.
  const flip = field(video, "flip_image");
  if (flip !== null) extras.push({ label: "Flip image", value: flip });
  const enableDet = field(detector, "enable_detection");
  if (enableDet !== null) extras.push({ label: "Detection enabled", value: enableDet });
  const predMode = field(detector, "pred_mode");
  if (predMode !== null) extras.push({ label: "Pred mode", value: predMode });
  const diff = field(detector, "diff_threshold");
  if (diff !== null) extras.push({ label: "Diff threshold", value: diff });
  const synthEnabled = field(sectionBody(raw, "server"), "synthetic_start_enabled");
  if (synthEnabled !== null) extras.push({ label: "Synthetic start", value: synthEnabled });

  return { params, extras };
}

/**
 * Normalise a version log-item value. The items usually emit a clean token
 * ("1.68", "26.05.00"); occasionally the raw matched log line. Extract the
 * trailing dotted-number token in that case. Returns null when blank.
 */
export function parseVersion(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^[0-9]+(?:\.[0-9]+)*$/.test(trimmed)) return trimmed;
  const m = trimmed.match(/([0-9]+(?:\.[0-9]+){1,3})\s*$/);
  return m ? m[1] : trimmed || null;
}
