// Color math for subject colors: contrast (WCAG) and perceptual distance (OKLab).
import { DARK_BG, LIGHT_BG } from "./config.js";

export function hexToRgb(hex) {
  const m = String(hex).trim().match(/^#?([0-9a-f]{6}|[0-9a-f]{3})$/i);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

export function rgbToHex(rgb) {
  return "#" + rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("");
}

const toLinear = (c) => {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const fromLinear = (c) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

function luminance(rgb) {
  const [r, g, b] = rgb.map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const la = luminance(hexToRgb(a)), lb = luminance(hexToRgb(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function toOklab(rgb) {
  const [r, g, b] = rgb.map(toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  ];
}

function fromOklab([L, a, b]) {
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  ];
  if (lin.some((v) => v < -0.001 || v > 1.001)) return null; // outside what screens can show
  return lin.map((v) => fromLinear(Math.min(1, Math.max(0, v))));
}

// How different two colors look (0 = identical; under ~8 looks very similar).
export function distance(a, b) {
  const x = toOklab(hexToRgb(a)), y = toOklab(hexToRgb(b));
  return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

// Nudge a color's lightness (keeping its hue) until text in it is readable
// on the given background. Lowers the saturation if needed to stay on screen.
function readableOn(hex, bg, darker) {
  const [L0, a0, b0] = toOklab(hexToRgb(hex));
  const C0 = Math.hypot(a0, b0), hue = Math.atan2(b0, a0);
  for (let step = 0; step <= 100; step++) {
    const L = Math.min(0.98, Math.max(0.02, L0 + (darker ? -1 : 1) * step * 0.01));
    for (let C = C0; C >= 0; C -= 0.01) {
      const rgb = fromOklab([L, C * Math.cos(hue), C * Math.sin(hue)]);
      if (!rgb) continue;
      const out = rgbToHex(rgb);
      if (contrast(out, bg) >= 4.6) return out;
      break;
    }
  }
  return darker ? "#1f1d1a" : "#ece6dc";
}

// From any color, make the pair a subject needs: readable in light and dark.
export function subjectColors(hex) {
  const base = hexToRgb(hex) ? hex : "#6b645b";
  const [L, a, b] = toOklab(hexToRgb(base));
  const light = contrast(base, LIGHT_BG) >= 4.6 ? rgbToHex(hexToRgb(base)) : readableOn(base, LIGHT_BG, true);
  const lifted = fromOklab([Math.max(L, 0.66), a, b]);
  const dark = readableOn(lifted ? rgbToHex(lifted) : base, DARK_BG, false);
  return { color: light, colorDark: dark };
}
