import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, LoaderCircle, LogIn, LogOut, RefreshCw, ShieldCheck } from "lucide-react";
import type { APIKeyStatus } from "@/api/settings";
import {
  connectChatGPTPlan,
  disconnectChatGPTPlan,
  getChatGPTPlanModels,
  getChatGPTPlanStatus,
  saveAPIKeySetting,
} from "@/api/settings";
import type { ChatGPTPlanSession } from "@/api/settings";
import { queryKeys } from "@/api/queryKeys";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

function connectionLabel(session?: ChatGPTPlanSession): string {
  if (!session) return "正在读取连接状态…";
  if (session.status === "connecting") return "正在连接 ChatGPT…";
  if (session.status === "reauth_required") return "需要重新登录";
  if (session.status === "connected" && session.sharing) return "ChatGPT 方案使用已授权";
  if (session.status === "connected") return "账号已登录，尚未授权方案使用";
  return "尚未连接 ChatGPT";
}

export default function ChatGPTPlanConnection(props: {
  provider?: APIKeyStatus;
  onUseForCreation?: (model: string) => void;
  usingForCreation?: boolean;
}) {
  const { provider } = props;
  const queryClient = useQueryClient();
  const [selectedModel, setSelectedModel] = useState("");
  const statusQuery = useQuery({
    queryKey: queryKeys.settings.chatgptPlan,
    queryFn: getChatGPTPlanStatus,
    refetchOnWindowFocus: false,
  });
  const session = statusQuery.data?.data?.session;
  const hasPlanAccess = session?.status === "connected" && session.sharing;
  const modelsQuery = useQuery({
    queryKey: queryKeys.settings.chatgptPlanModels,
    queryFn: getChatGPTPlanModels,
    enabled: Boolean(hasPlanAccess),
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 30_000,
  });
  const models = modelsQuery.data?.data ?? [];
  const model = useMemo(() => {
    if (models.some((item) => item.slug === selectedModel)) return selectedModel;
    if (models.some((item) => item.slug === provider?.currentModel)) return provider?.currentModel ?? "";
    return models[0]?.slug ?? "";
  }, [models, provider?.currentModel, selectedModel]);

  const refreshSettings = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.chatgptPlan }),
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.chatgptPlanModels }),
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.apiKeys }),
      queryClient.invalidateQueries({ queryKey: queryKeys.llm.providers }),
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.quickSetup }),
    ]);
  };

  const connectMutation = useMutation({
    mutationFn: async (reconsent: boolean) => {
      const response = await connectChatGPTPlan(reconsent);
      const connected = response.data?.session.status === "connected" && response.data.session.sharing;
      const availableModels = response.data?.models ?? [];
      if (connected && availableModels.length) {
        const savedModel = availableModels.some((item) => item.slug === provider?.currentModel)
          ? provider?.currentModel
          : availableModels[0]?.slug;
        if (savedModel) {
          await saveAPIKeySetting("chatgpt_plus", { model: savedModel, isActive: true });
        }
      }
      if (response.data) {
        queryClient.setQueryData(queryKeys.settings.chatgptPlanModels, {
          success: true,
          data: availableModels,
          message: "可用模型列表已更新。",
        });
      }
      return response;
    },
    onSettled: refreshSettings,
  });

  const modelMutation = useMutation({
    mutationFn: (nextModel: string) => saveAPIKeySetting("chatgpt_plus", { model: nextModel, isActive: true }),
    onSuccess: refreshSettings,
    onError: () => setSelectedModel(provider?.currentModel ?? ""),
  });

  const disconnectMutation = useMutation({
    mutationFn: disconnectChatGPTPlan,
    onSuccess: refreshSettings,
  });

  const status = statusQuery.data?.data;
  const busy = connectMutation.isPending || disconnectMutation.isPending;
  const reconsent = session?.status === "connected" && !session.sharing;
  const accessReady = Boolean(provider?.isConfigured && provider.isActive);

  return (
    <section className="rounded-xl bg-muted/25 p-4 md:col-span-2" aria-labelledby="chatgpt-plan-title">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary" aria-hidden="true" />
            <h3 id="chatgpt-plan-title" className="font-semibold">ChatGPT Plus / Pro 方案</h3>
            <Badge variant={accessReady ? "default" : "outline"}>
              {accessReady ? "可用于创作" : connectionLabel(session)}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            授权后可直接选择当前账号可用的文本模型，不需要填写 API Key。
          </p>
          {session?.identity?.email || session?.identity?.name ? (
            <p className="text-sm text-muted-foreground">
              已连接账号：{session.identity.email ?? session.identity.name}
            </p>
          ) : null}
          {status?.available ? (
            <p className="text-xs text-muted-foreground">
              登录凭据由 Mac 钥匙串保护。此连接只用于文本生成；温度与输出长度由 ChatGPT 服务决定。官方登录组件目前仅许可个人非商业用途。
            </p>
          ) : null}
          {!status?.available && status?.message ? (
            <p className="text-sm text-amber-700">{status.message}</p>
          ) : null}
          {statusQuery.isError ? (
            <p className="text-sm text-destructive">{statusQuery.error instanceof Error ? statusQuery.error.message : "读取 ChatGPT 连接状态失败。"}</p>
          ) : null}
          {session?.error?.message ? (
            <p className="text-sm text-destructive">{session.error.message}</p>
          ) : null}
          {disconnectMutation.data && !disconnectMutation.data.data?.remoteRevocationConfirmed ? (
            <p className="text-sm text-amber-700">{disconnectMutation.data.message}</p>
          ) : null}
          {connectMutation.data?.data?.modelError ? (
            <p className="text-sm text-amber-700">{connectMutation.data.data.modelError}</p>
          ) : null}
          {connectMutation.isError ? (
            <p className="text-sm text-destructive">{connectMutation.error instanceof Error ? connectMutation.error.message : "ChatGPT 连接失败，请重试。"}</p>
          ) : null}
          {disconnectMutation.isError ? (
            <p className="text-sm text-destructive">{disconnectMutation.error instanceof Error ? disconnectMutation.error.message : "ChatGPT 断开失败，请重试。"}</p>
          ) : null}
          {modelMutation.isError ? (
            <p className="text-sm text-destructive">{modelMutation.error instanceof Error ? modelMutation.error.message : "保存 ChatGPT 模型失败。"}</p>
          ) : null}
          {modelsQuery.isError ? (
            <p className="text-sm text-destructive">{modelsQuery.error instanceof Error ? modelsQuery.error.message : "读取模型列表失败。"}</p>
          ) : null}
        </div>

        {status?.available ? (
          <div className="flex shrink-0 flex-wrap gap-2">
            {hasPlanAccess ? (
              <a
                href={status.usageUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-sm text-primary hover:bg-primary/5"
              >
                查看方案用量 <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
            ) : null}
            {!hasPlanAccess && session?.status === "connected" ? (
              <Button
                size="sm"
                onClick={() => connectMutation.mutate(Boolean(reconsent))}
                disabled={busy || statusQuery.isLoading}
              >
                {connectMutation.isPending
                  ? <LoaderCircle className="h-4 w-4 animate-spin" />
                  : reconsent ? <RefreshCw className="h-4 w-4" /> : <LogIn className="h-4 w-4" />}
                {connectMutation.isPending ? "等待浏览器授权…" : reconsent ? "重新授权方案使用" : "连接 ChatGPT"}
              </Button>
            ) : null}
            {session?.status !== "connected" ? (
              <Button
                size="sm"
                onClick={() => connectMutation.mutate(false)}
                disabled={busy || statusQuery.isLoading}
              >
                {connectMutation.isPending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
                {connectMutation.isPending ? "等待浏览器授权…" : "连接 ChatGPT"}
              </Button>
            ) : null}
            {session?.status === "connected" ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => disconnectMutation.mutate()}
                disabled={busy}
              >
                {disconnectMutation.isPending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
                断开
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {hasPlanAccess ? (
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <Select
              value={model}
              onValueChange={(nextModel) => {
                setSelectedModel(nextModel);
                modelMutation.mutate(nextModel);
              }}
              disabled={!models.length || modelMutation.isPending || modelsQuery.isLoading}
            >
              <SelectTrigger>
                <SelectValue placeholder={modelsQuery.isLoading ? "读取可用模型…" : "选择 ChatGPT 模型"} />
              </SelectTrigger>
              <SelectContent>
                {models.map((item) => (
                  <SelectItem key={item.slug} value={item.slug}>
                    {item.displayName || item.slug}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void modelsQuery.refetch()}
            disabled={modelsQuery.isFetching || !hasPlanAccess}
          >
            {modelsQuery.isFetching ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            刷新模型
          </Button>
          {props.onUseForCreation ? (
            <Button
              size="sm"
              disabled={!model || busy || modelMutation.isPending || modelsQuery.isFetching || props.usingForCreation}
              onClick={() => props.onUseForCreation?.(model)}
            >
              {props.usingForCreation ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
              检测并用于创作
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
