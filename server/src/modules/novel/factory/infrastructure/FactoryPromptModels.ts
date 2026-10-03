import type { FactoryModel, FactoryPatch, FactoryReview, FactoryScript } from "@ai-novel/shared/types/factory";
import { runStructuredPrompt, runTextPrompt } from "../../../../prompting/core/promptRunner";
import {
  buildFactoryContextBlocks, compileFactoryPrompt, factoryPlanPrompt,
  factoryWritePrompt, factoryReviewPrompt, factoryPatchPrompt,
} from "../../../../prompting/prompts/factory/factory.prompts";
import type { PromptExecutionMeta } from "../../../../prompting/core/promptTypes";
import type { FactoryModels, FactoryModelResult, FactoryPromptContext } from "../application/FactoryEngine";

function result<T>(output: T, meta: PromptExecutionMeta, model: FactoryModel): FactoryModelResult<T> {
  return {
    output,
    usage: {
      provider: meta.provider ?? model.provider, model: meta.model ?? model.model,
      elapsedMs: meta.latencyMs,
      inputTokens: meta.tokenUsage?.promptTokens ?? null,
      outputTokens: meta.tokenUsage?.completionTokens ?? null,
      source: meta.tokenUsage ? "provider" : "unavailable",
    },
  };
}

export class FactoryPromptModels implements FactoryModels {
  compile(input: FactoryPromptContext): string { return compileFactoryPrompt(input); }

  async plan(input: FactoryPromptContext, model: FactoryModel): Promise<FactoryModelResult<FactoryScript>> {
    const generated = await runStructuredPrompt({ asset: factoryPlanPrompt, promptInput: input,
      contextBlocks: buildFactoryContextBlocks(input), options: { ...model, novelId: input.novelId, entrypoint: "factory", stage: "plan", timeoutMs: 180000, maxTokens: 3000, temperature: 0.4 } });
    return result(generated.output, generated.meta, model);
  }

  async write(input: FactoryPromptContext, model: FactoryModel): Promise<FactoryModelResult<string>> {
    const generated = await runTextPrompt({ asset: factoryWritePrompt, promptInput: input,
      contextBlocks: buildFactoryContextBlocks(input), options: { ...model, novelId: input.novelId, entrypoint: "factory", stage: "draft", timeoutMs: 180000, maxTokens: 10000, temperature: 0.75 } });
    return result(generated.output, generated.meta, model);
  }

  async review(input: FactoryPromptContext, model: FactoryModel): Promise<FactoryModelResult<FactoryReview>> {
    const generated = await runStructuredPrompt({ asset: factoryReviewPrompt, promptInput: input,
      contextBlocks: buildFactoryContextBlocks(input), options: { ...model, novelId: input.novelId, entrypoint: "factory", stage: "review", timeoutMs: 180000, maxTokens: 6000, temperature: 0.15 } });
    return result(generated.output, generated.meta, model);
  }

  async patch(input: FactoryPromptContext, model: FactoryModel): Promise<FactoryModelResult<FactoryPatch>> {
    const generated = await runStructuredPrompt({ asset: factoryPatchPrompt, promptInput: input,
      contextBlocks: buildFactoryContextBlocks(input), options: { ...model, novelId: input.novelId, entrypoint: "factory", stage: "repair", timeoutMs: 180000, maxTokens: 6000, temperature: 0.3 } });
    return result(generated.output, generated.meta, model);
  }
}
