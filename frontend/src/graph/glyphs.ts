/**
 * Device glyphs drawn inside the node shapes and in Details.
 *
 * Routers and switches use the Affinity "naked" symbols (ecceman/affinity, public domain, The
 * Unlicense; see ./ICONS-LICENSES.md). Unknown devices and links use the app's own line glyphs.
 * Every glyph is drawn in the color it is given: white on filled shapes, the state color otherwise.
 */

// The app's own line glyphs on a 40 x 40 grid.
const CLASSIC: Record<string, string> = {
  router: "M20 10v7M20 23v7M10 20h7M23 20h7M17 13l3-3 3 3M17 27l3 3 3-3M13 17l-3 3 3 3M27 17l3 3-3 3",
  switch: "M11 16h17M24 12l4 4-4 4M29 24H12M16 20l-4 4 4 4",
  unknown: "M20 14a6 6 0 1 1 0 12a6 6 0 1 1 0-12",
  link: "M8 20h24M13 15l-5 5 5 5M27 15l5 5-5 5",
};

// Filled shapes; {c} is replaced by the color.
const AFFINITY: Record<string, { viewBox: string; body: string }> = {
  router: { viewBox: "0 0 235 235", body: "<g transform=\"matrix(1,0,0,1,-9.99444,-10.0277)\"> <path d=\"M138.458,152.273L138.458,202.269L158.915,181.814L158.846,213.18L127.346,244.68L95.912,213.245L95.912,181.769L116.43,202.287L116.43,152.415L138.458,152.273ZM194.491,116.43L244.364,116.43L244.505,138.458L194.509,138.458L214.964,158.915L183.599,158.846L152.099,127.346L183.533,95.912L215.009,95.912L194.491,116.43ZM70.967,158.915L39.49,158.915L60.009,138.397L10.136,138.397L9.994,116.369L59.99,116.369L39.536,95.912L70.901,95.981L102.401,127.481L70.967,158.915ZM116.369,102.434L116.369,52.438L95.912,72.893L95.981,41.527L127.481,10.028L158.915,41.462L158.915,72.938L138.397,52.42L138.397,102.292L116.369,102.434Z\" style=\"fill:{c};\"/> </g>" },
  switch: { viewBox: "0 0 186 159", body: "<g transform=\"matrix(1,0,0,1,-57.2108,-70.8718)\"> <path d=\"M96.579,121.319L150,121.319L150,141.665L96.685,141.665L115.597,160.577L86.307,160.577L57.211,131.481L86.307,102.385L115.513,102.385L96.579,121.319Z\" style=\"fill:{c};\"/> <g transform=\"matrix(1,0,0,1,0,68.5311)\"> <path d=\"M96.579,121.319L150,121.319L150,141.665L96.685,141.665L115.597,160.577L86.307,160.577L57.211,131.481L86.307,102.385L115.513,102.385L96.579,121.319Z\" style=\"fill:{c};\"/> </g> <g transform=\"matrix(-1,0,0,1,300,37.0177)\"> <path d=\"M96.579,121.319L150,121.319L150,141.665L96.685,141.665L115.597,160.577L86.307,160.577L57.211,131.481L86.307,102.385L115.513,102.385L96.579,121.319Z\" style=\"fill:{c};\"/> </g> <g transform=\"matrix(-1,0,0,1,300,-31.5135)\"> <path d=\"M96.579,121.319L150,121.319L150,141.665L96.685,141.665L115.597,160.577L86.307,160.577L57.211,131.481L86.307,102.385L115.513,102.385L96.579,121.319Z\" style=\"fill:{c};\"/> </g> </g>" },
};

function classic(kind: string, color: string, size: number): string {
  const d = CLASSIC[kind] ?? CLASSIC.unknown;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 40 40" fill="none" ` +
    `stroke="${color}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`
  );
}

export function glyphSvg(kind: string, color: string, size = 40): string {
  const g = AFFINITY[kind];
  if (!g) return classic(kind, color, size);
  // Same 20 x 20 area of the 40 x 40 box as the line glyphs.
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 40 40">` +
    `<svg x="10" y="10" width="20" height="20" viewBox="${g.viewBox}" preserveAspectRatio="xMidYMid meet" fill-rule="evenodd">` +
    `${g.body.replaceAll("{c}", color)}</svg></svg>`
  );
}

export function glyphUri(kind: string, color: string): string {
  return "data:image/svg+xml;utf8," + encodeURIComponent(glyphSvg(kind, color));
}
