import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownToLine, ArrowUpRight, BookOpenText, Library, RefreshCw } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { getUnifiedOverview } from "@/api/unified";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import ImportPanel from "./ImportPanel";
import LibraryPanel from "./LibraryPanel";
import WritingWorkbench from "./WritingWorkbench";
import { ErrorState, LoadingState, unifiedKeys } from "./presentation";

type View = "import" | "library" | "write";

export default function UnifiedPlatformPage() {
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const requestedView = params.get("view");
  const view: View = requestedView === "import" || requestedView === "library" ? requestedView : "write";
  const overviewQuery = useQuery({
    queryKey: unifiedKeys.overview,
    queryFn: getUnifiedOverview,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const overview = overviewQuery.data;
  const pendingCount = overview?.sources.filter((source) => !source.imported).length ?? 0;
  const referenceCount = overview?.imports.filter((entry) => entry.kind === "reference").length ?? 0;
  const selectView = (next: View, novelId?: string) => {
    setParams((current) => {
      const nextParams = new URLSearchParams(current);
      nextParams.set("view", next);
      if (novelId) nextParams.set("novel", novelId);
      return nextParams;
    });
  };

  return (
    <div className="mx-auto w-full max-w-[1500px] space-y-8 pb-10 sm:px-2 sm:pt-2 lg:px-5">
      <header className="flex flex-wrap items-start justify-between gap-5">
        <div>
          <p className="mb-3 text-xs font-medium tracking-[0.16em] text-primary">作品 · 研究 · 写作</p>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">我的小说书房</h1>
          <p className="mt-3 max-w-xl text-sm leading-7 text-muted-foreground">找到你的作品，带着研究与设定，接着写下一章。</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button asChild variant="ghost" size="sm"><Link to="/settings/models">模型连接<ArrowUpRight className="h-3.5 w-3.5" /></Link></Button>
          <Button variant="outline" size="sm" disabled={overviewQuery.isFetching} onClick={() => { void queryClient.invalidateQueries({ queryKey: ["unification"] }); }}><RefreshCw className={cn("h-3.5 w-3.5", overviewQuery.isFetching && "animate-spin")} />刷新书房</Button>
        </div>
      </header>

      {overview ? <div className="flex flex-wrap gap-x-8 gap-y-3 text-xs text-muted-foreground"><span><strong className="mr-1.5 text-lg font-semibold tabular-nums text-foreground">{overview.novels.length}</strong>部作者作品</span><span><strong className="mr-1.5 text-lg font-semibold tabular-nums text-foreground">{referenceCount}</strong>份参考研究</span><span><strong className="mr-1.5 text-lg font-semibold tabular-nums text-foreground">{pendingCount}</strong>份待导入资料</span></div> : null}

      <nav className="flex gap-1 overflow-x-auto border-b border-border/70" aria-label="书房功能">
        {([{ key: "import", label: "资料导入", icon: ArrowDownToLine, count: pendingCount }, { key: "library", label: "作品与研究", icon: Library, count: undefined }, { key: "write", label: "写作与审稿", icon: BookOpenText, count: undefined }] as const).map((item) => <button type="button" key={item.key} onClick={() => selectView(item.key)} aria-current={view === item.key ? "page" : undefined} className={cn("relative flex shrink-0 items-center gap-2 px-4 pb-4 pt-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-5", view === item.key ? "font-semibold text-primary" : "text-muted-foreground hover:text-foreground")}><item.icon className="h-4 w-4" />{item.label}{item.count ? <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">{item.count}</span> : null}{view === item.key ? <span className="absolute inset-x-4 bottom-0 h-0.5 rounded-t-full bg-primary" /> : null}</button>)}
      </nav>

      {overviewQuery.isLoading ? <LoadingState label="正在读取书房、作品与研究资料…" /> : overviewQuery.isError ? <ErrorState error={overviewQuery.error} retry={() => { void overviewQuery.refetch(); }} /> : overview ? (
        view === "import" ? <ImportPanel sources={overview.sources} onOpenLibrary={() => selectView("library")} /> : view === "library" ? <LibraryPanel overview={overview} onOpenNovel={(id) => selectView("write", id)} onOpenImport={() => selectView("import")} /> : <WritingWorkbench novels={overview.novels} novelId={params.get("novel") ?? ""} onSelectNovel={(id) => selectView("write", id)} onOpenImport={() => selectView("import")} />
      ) : null}
    </div>
  );
}
