export interface Theme {
  canvas: string;
  surface: string;
  ink: string;
  muted: string;
  edge: string;
  router: string;
  switch: string;
  unregistered: string;
  up: string;
  down: string;
  unreachable: string; // outline of a registered device that does not answer
  accent: string;
  select: string; // selected and fresh elements on the canvas
  sans: string; // font families, as CSS lists
  mono: string;
  canvasFont: string;
  ring: number; // node ring width in px
}

/** Read the CSS tokens so the canvas and the DOM always share colors. */
export function readTheme(): Theme {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string) => cs.getPropertyValue(name).trim();
  return {
    canvas: v("--canvas"),
    surface: v("--surface"),
    ink: v("--ink"),
    muted: v("--muted"),
    edge: v("--edge"),
    router: v("--router"),
    switch: v("--switch"),
    unregistered: v("--unregistered"),
    up: v("--up"),
    down: v("--down"),
    unreachable: v("--unreachable"),
    accent: v("--accent"),
    select: v("--select"),
    sans: v("--sans"),
    mono: v("--mono"),
    canvasFont: v("--canvas-font") || v("--sans"),
    ring: Number.parseFloat(v("--ring")) || 2.5,
  };
}

export function initTheme(): void {
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

export function toggleTheme(): void {
  const root = document.documentElement;
  root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
}
