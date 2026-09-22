import type { Comparison } from "../types.ts";

/**
 * Share of ALL runs (0-100) that called `tool` on `side`, across every test.
 * The denominator is every run of every test — not just the tests where the
 * tool happened to fire — so a tool used in one of seven scenarios reads low,
 * not 100%.
 */
function toolRatePct(c: Comparison, side: "old" | "new", tool: string): number {
  let called = 0;
  let of = 0;
  for (const t of c.tests) {
    of += t[side].runs;
    called += t[side].toolCallRate[tool]?.called ?? 0;
  }
  return of ? Math.round((called / of) * 100) : 0;
}

/**
 * A QuickChart radar image URL: the agent's behavioral "shape" — the % of runs
 * that call each tool — drawn before vs after on one plot. QuickChart renders
 * the Chart.js (v2) config to a PNG that GitHub embeds directly, so the comment
 * opens with a picture of what actually changed instead of a wall of numbers.
 * Styled dark to match the docs. Returns null when there aren't enough tools to
 * make a shape (the report then degrades to text).
 */
export function chartUrl(c: Comparison): string | null {
  const tools = new Set<string>();
  for (const t of c.tests) {
    t.mustCallTools.forEach((x) => tools.add(x));
    Object.keys(t.old.toolCallRate).forEach((x) => tools.add(x));
    Object.keys(t.new.toolCallRate).forEach((x) => tools.add(x));
  }
  // Keep the plot legible: at most 8 axes, the busiest tools first.
  const axes = [...tools]
    .map((tool) => ({ tool, peak: Math.max(toolRatePct(c, "old", tool), toolRatePct(c, "new", tool)) }))
    .filter((x) => x.peak > 0)
    .sort((a, b) => b.peak - a.peak)
    .slice(0, 8)
    .map((x) => x.tool);
  if (axes.length < 3) return null;

  const line = "rgba(255,255,255,0.14)";
  const green = "#4ade80";
  const red = "#f43f5e";
  const label = (s: string) => s.replace(/_/g, " ");
  const config = {
    type: "radar",
    data: {
      labels: axes.map(label),
      datasets: [
        {
          label: "before",
          data: axes.map((t) => toolRatePct(c, "old", t)),
          borderColor: green,
          backgroundColor: "rgba(74,222,128,0.12)",
          borderWidth: 2,
          pointBackgroundColor: green,
          pointRadius: 3,
        },
        {
          label: "after",
          data: axes.map((t) => toolRatePct(c, "new", t)),
          borderColor: red,
          backgroundColor: "rgba(244,63,94,0.14)",
          borderWidth: 2,
          pointBackgroundColor: red,
          pointRadius: 3,
        },
      ],
    },
    options: {
      title: {
        display: true,
        text: "what the agent does · % of runs calling each tool",
        fontColor: "#e5e7eb",
        fontSize: 16,
      },
      legend: { position: "bottom", labels: { fontColor: "#e5e7eb", fontSize: 13 } },
      scale: {
        ticks: {
          min: 0,
          max: 100,
          stepSize: 25,
          backdropColor: "rgba(0,0,0,0)",
          fontColor: "#6b7280",
          showLabelBackdrop: false,
        },
        gridLines: { color: line },
        angleLines: { color: line },
        pointLabels: { fontColor: "#e5e7eb", fontSize: 13 },
      },
    },
  };
  // encodeURIComponent leaves ( and ) literal (so does the palette's rgba());
  // a literal ) would end the markdown image early, so percent-encode them.
  const encoded = encodeURIComponent(JSON.stringify(config)).replace(/\(/g, "%28").replace(/\)/g, "%29");
  return `https://quickchart.io/chart?bkg=%23000000&w=760&h=480&c=${encoded}`;
}
