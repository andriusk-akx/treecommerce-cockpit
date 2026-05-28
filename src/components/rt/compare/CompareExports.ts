/**
 * Export helpers for the Compare-periods sub-view.
 *
 * Two flavours:
 *   - exportHostsCsv() — flattens the host delta table to a CSV blob.
 *   - exportOverlayPng() — serialises the overlay <svg> element to a PNG.
 *
 * Both download via a transient <a download> trick; no external libs.
 */
import type { CompareMeta, CompareHostRow } from "./types";

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
}

function csvCell(v: string | number | null): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  // Quote when value contains any of: quote, comma, newline (LF or CR — CR
  // shows up in Windows-pasted labels and would otherwise break the row).
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function exportHostsCsv(meta: CompareMeta, rows: CompareHostRow[]): void {
  const aLabel = meta.periodA.label || `${meta.periodA.from}_to_${meta.periodA.to}`;
  const bLabel = meta.periodB.label || `${meta.periodB.from}_to_${meta.periodB.to}`;
  const headers = [
    "host",
    "store",
    "cpu_model",
    "cpu_cores",
    `minutes_above_${meta.threshold}_${slug(aLabel)}`,
    `minutes_above_${meta.threshold}_${slug(bLabel)}`,
    "delta_minutes_abs",
    "delta_minutes_pct",
    `mean_cpu_${slug(aLabel)}`,
    `mean_cpu_${slug(bLabel)}`,
    `samples_${slug(aLabel)}`,
    `samples_${slug(bLabel)}`,
    "data_quality",
    "host_scope",
  ];
  const lines: string[] = [headers.map(csvCell).join(",")];
  for (const r of rows) {
    lines.push([
      r.hostName,
      r.storeName,
      r.cpuModel,
      r.cpuCores,
      r.aMinutesAbove,
      r.bMinutesAbove,
      r.deltaMinutesAbs,
      r.deltaMinutesPct,
      r.aMeanCpu,
      r.bMeanCpu,
      r.aSamples,
      r.bSamples,
      r.dataQuality,
      r.hostScope,
    ].map(csvCell).join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const filename = `cpu-compare-hosts-${meta.pilotId}-${meta.periodA.from}-vs-${meta.periodB.from}-${meta.threshold}pct.csv`;
  downloadBlob(blob, filename);
}

/**
 * Render the supplied <svg> element into a PNG by drawing it onto a canvas.
 * The svg must already be in the DOM (so its computed dimensions are known)
 * and ideally have an explicit viewBox. We render at 2x device pixel ratio
 * for crisp screenshots in retina monitors.
 */
export async function exportOverlayPng(svg: SVGSVGElement, meta: CompareMeta): Promise<void> {
  const serializer = new XMLSerializer();
  // Inline computed font / color resolution: copy width/height attrs from
  // bounding box so the rasteriser knows pixel dimensions.
  const rect = svg.getBoundingClientRect();
  const widthPx = Math.max(rect.width, 800);
  const heightPx = Math.max(rect.height, 320);
  // Clone so we can mutate without affecting the rendered chart.
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(widthPx));
  clone.setAttribute("height", String(heightPx));
  // STRIP <foreignObject> nodes from the clone — they cause the rasterised
  // canvas to be marked "tainted" by Chrome/Safari, which then refuses
  // toBlob() with SecurityError. The chart's hover tooltip uses
  // foreignObject; without this strip, an export-after-hover would throw.
  // The exported PNG therefore omits hover state on purpose — viewers
  // never see the tooltip in the static image.
  clone.querySelectorAll("foreignObject").forEach((n) => n.remove());
  const xml = serializer.serializeToString(clone);
  // Wrap in a data URL via blob so browsers handle UTF-8 correctly.
  const svgBlob = new Blob([xml], { type: "image/svg+xml;charset=utf-8" });
  const svgUrl = URL.createObjectURL(svgBlob);
  try {
    const img = await loadImage(svgUrl);
    const dpr = window.devicePixelRatio || 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(widthPx * dpr);
    canvas.height = Math.round(heightPx * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");
    // White background — SVG fills with transparent by default, which looks
    // ugly when pasted into Slack/email.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const pngBlob: Blob = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas.toBlob returned null"))), "image/png");
    });
    const filename = `cpu-compare-overlay-${meta.pilotId}-${meta.periodA.from}-vs-${meta.periodB.from}-${meta.threshold}pct.png`;
    downloadBlob(pngBlob, filename);
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e instanceof ErrorEvent ? e.error : new Error("Image load failed"));
    img.src = src;
  });
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}
