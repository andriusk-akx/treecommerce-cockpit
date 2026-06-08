import { describe, it, expect } from "vitest";
import { parseConfigIni, parseVersion } from "./parse";

const SAMPLE =
  "2026-06-07 20:24:57.981 INFO     config.ini: {'DEFAULT': {}, " +
  "'server': {'store': 'rimi_outlet_vno', 'name': 'sco_5', 'synthetic_start_enabled': 'True'}, " +
  "'model': {'version': '20251122_30', 'package_version': '20251122_30', 'inference_backend': 'onnx', " +
  "'onnx_providers': 'CPUExecutionProvider', 'enable_prediction': 'True', 'number_of_results': '3'}, " +
  "'detector': {'enable_detection': 'False', 'pred_mode': '1', 'diff_threshold': '80'}, " +
  "'video1': {'usb_camera_index': '0', 'capture_width': '960', 'capture_height': '540', 'flip_image': '-2'}}";

describe("parseConfigIni", () => {
  it("extracts resolution from video1 capture dimensions", () => {
    expect(parseConfigIni(SAMPLE).params.resolution).toBe("960×540");
  });

  it("extracts camera source, model + inference fields", () => {
    const { params } = parseConfigIni(SAMPLE);
    expect(params.cameraSource).toBe("USB 0");
    expect(params.modelVersion).toBe("20251122_30"); // model.version, NOT package_version
    expect(params.inferenceBackend).toBe("onnx");
    expect(params.onnxProviders).toBe("CPU"); // ExecutionProvider stripped
    expect(params.enablePrediction).toBe("True");
    expect(params.numberOfResults).toBe("3");
  });

  it("collects detector / synthetic extras", () => {
    const labels = parseConfigIni(SAMPLE).extras.map((e) => e.label);
    expect(labels).toContain("Detection enabled");
    expect(labels).toContain("Pred mode");
    expect(labels).toContain("Synthetic start");
  });

  it("returns empty params for blank / non-config input", () => {
    expect(parseConfigIni("").params).toEqual({});
    expect(parseConfigIni("some unrelated log line").params).toEqual({});
    expect(parseConfigIni(null).params).toEqual({});
  });
});

describe("parseVersion", () => {
  it("passes through a clean dotted version", () => {
    expect(parseVersion("1.68")).toBe("1.68");
    expect(parseVersion("26.05.00")).toBe("26.05.00");
    expect(parseVersion("  1.68 ")).toBe("1.68");
  });

  it("extracts a trailing version token from a log line", () => {
    expect(parseVersion("INFO Starting server v 1.68")).toBe("1.68");
  });

  it("returns null for blank", () => {
    expect(parseVersion("")).toBe(null);
    expect(parseVersion(undefined)).toBe(null);
  });

  it("returns null (not the raw line) when no version token is present", () => {
    expect(parseVersion("Starting server (no build tag)")).toBe(null);
    expect(parseVersion("evtAppStart begin")).toBe(null);
  });
});
