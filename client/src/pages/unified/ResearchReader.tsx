import { ContentReader } from "./presentation";

interface ResearchFinding {
  topic: string;
  finding: string;
  evidence: { sourceId: string; quote: string }[];
}

interface ResearchReport {
  summary: string;
  mechanism: string;
  limitations: string[];
  findings: ResearchFinding[];
}

function readReport(content: string): ResearchReport | undefined {
  let value: unknown;
  try { value = JSON.parse(content); } catch { return; }
  if (!value || typeof value !== "object") return;
  const report = value as Record<string, unknown>;
  if (typeof report.summary !== "string" || typeof report.mechanism !== "string" || !Array.isArray(report.limitations) || !report.limitations.every((item) => typeof item === "string") || !Array.isArray(report.findings)) return;
  const findings: ResearchFinding[] = [];
  for (const item of report.findings) {
    if (!item || typeof item !== "object" || typeof item.topic !== "string" || typeof item.finding !== "string" || !Array.isArray(item.evidence)) return;
    const evidence: ResearchFinding["evidence"] = [];
    for (const entry of item.evidence) {
      if (!entry || typeof entry !== "object" || typeof entry.sourceId !== "string" || typeof entry.quote !== "string") return;
      evidence.push({ sourceId: entry.sourceId, quote: entry.quote });
    }
    findings.push({ topic: item.topic, finding: item.finding, evidence });
  }
  return { summary: report.summary, mechanism: report.mechanism, limitations: report.limitations as string[], findings };
}

export default function ResearchReader({ content, sourceNames }: { content: string; sourceNames: Record<string, string> }) {
  const report = readReport(content);
  if (!report) return <ContentReader content={content} />;
  return (
    <div className="space-y-7 text-sm leading-7">
      <div><h5 className="mb-2 font-semibold">研究结论</h5><p className="whitespace-pre-wrap">{report.summary}</p></div>
      {report.mechanism ? <div><h5 className="mb-2 font-semibold">叙事机制与用法</h5><p className="whitespace-pre-wrap text-muted-foreground">{report.mechanism}</p></div> : null}
      <div className="space-y-6">{report.findings.map((finding, index) => <section key={index} className="border-t border-border/60 pt-5"><h5 className="mb-2 font-semibold">{finding.topic}</h5><p className="whitespace-pre-wrap">{finding.finding}</p>{finding.evidence.length ? <div className="mt-4 space-y-3">{finding.evidence.map((evidence, evidenceIndex) => <figure key={evidenceIndex} className="rounded-lg bg-background/65 px-4 py-3"><figcaption className="mb-1 text-xs font-medium text-primary">{sourceNames[evidence.sourceId] ?? "所选研究来源"}</figcaption><blockquote className="whitespace-pre-wrap text-sm leading-7 text-muted-foreground">{evidence.quote}</blockquote></figure>)}</div> : <p className="mt-2 text-xs text-muted-foreground">这条结论没有附带原文引用，请结合研究范围判断。</p>}</section>)}</div>
      {report.limitations.length ? <div className="rounded-lg bg-muted/40 p-4"><h5 className="mb-2 font-semibold">适用边界</h5><ul className="list-disc space-y-2 pl-4 text-muted-foreground">{report.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul></div> : null}
    </div>
  );
}
