// Browser-side benchmark used by compare-diagram-renderers.ts.
import mermaid from "mermaid";
import { render } from "pele";

type Sample = { title: string; source: string };
const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

(window as any).diagramBench = async (samples: Sample[], runs = 7) => {
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict", htmlLabels: false, theme: "base", suppressErrorRendering: true });
  let id = 0;
  const rows = [];
  for (const sample of samples) {
    const times = { mermaid: [] as number[], pele: [] as number[] };
    let mermaidOk = true, peleOk = true;
    for (let i = 0; i < runs; i++) {
      let start = performance.now();
      try { await mermaid.render(`bench-${++id}`, sample.source); } catch { mermaidOk = false; }
      times.mermaid.push(performance.now() - start);
      start = performance.now();
      try { render(sample.source); } catch { peleOk = false; }
      times.pele.push(performance.now() - start);
    }
    rows.push({ title: sample.title, mermaid: { first: +times.mermaid[0]!.toFixed(2), median: +median(times.mermaid.slice(1)).toFixed(2), ok: mermaidOk }, pele: { first: +times.pele[0]!.toFixed(2), median: +median(times.pele.slice(1)).toFixed(2), ok: peleOk } });
  }
  return rows;
};
