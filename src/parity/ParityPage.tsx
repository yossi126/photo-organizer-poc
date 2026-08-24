/**
 * ParityPage — dev-only page (open with ?parity=1) used by the render-parity
 * harness (tests/parity/capture.mjs). Renders each fixture × preset through
 * the WebGL PhotoRenderer and exposes window.__runParity() returning
 * { "<fixture>__<preset>": <base64 png> }.
 */

import { useEffect, useState } from "react";
import { PhotoRenderer } from "../lib/render/renderer";
import { DEFAULT_EDIT_SETTINGS } from "../lib/constants";
import type { EditSettings } from "../types/photo";

import presets from "../../tests/parity/presets.json";

const FIXTURES = ["gradient", "hues", "detail"];

declare global {
  interface Window {
    __runParity?: () => Promise<Record<string, string>>;
    __parityReady?: boolean;
  }
}

async function canvasToBase64Png(canvas: HTMLCanvasElement): Promise<string> {
  const blob: Blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png")
  );
  const buf = await blob.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

export function ParityPage() {
  const [status, setStatus] = useState("initializing");

  useEffect(() => {
    window.__runParity = async () => {
      const canvas = document.createElement("canvas");
      const renderer = new PhotoRenderer(canvas, {
        maxDim: 4096,
        preserveDrawingBuffer: true,
      });
      const results: Record<string, string> = {};
      try {
        for (const fixture of FIXTURES) {
          await renderer.setImage(`/parity/${fixture}.jpg`);
          for (const [presetName, overrides] of Object.entries(presets)) {
            const settings: EditSettings = {
              ...DEFAULT_EDIT_SETTINGS,
              ...(overrides as Partial<EditSettings>),
            };
            renderer.render(settings);
            const gl = canvas.getContext("webgl2");
            gl?.finish();
            results[`${fixture}__${presetName}`] = await canvasToBase64Png(canvas);
            setStatus(`rendered ${fixture}__${presetName}`);
          }
        }
      } finally {
        renderer.dispose();
      }
      setStatus("done");
      return results;
    };
    window.__parityReady = true;
    setStatus("ready");
    return () => {
      delete window.__runParity;
      window.__parityReady = false;
    };
  }, []);

  return (
    <div style={{ padding: 24, fontFamily: "monospace", color: "#ccc", background: "#111", height: "100vh" }}>
      <h1>Render parity harness</h1>
      <p data-testid="parity-status">{status}</p>
    </div>
  );
}
