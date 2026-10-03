import type { FactoryPromptInput } from "./factory.prompts";

/** Only the manual workbench may use this explicit sample; production never does. */
export function createFactoryWorkbenchSample(): FactoryPromptInput {
  const goal = { title: "城门", goal: "陆沉走到城门寻找避难处", mustDo: ["到达城门"], mustNot: ["获得系统或新能力"], hook: "门后传来敲击声" };
  return {
    setup: { title: "手动测试示例（非生产任务）", constitution: "陆沉是普通人，靠观察和行动解决问题。", lockedFacts: [{ id: "canon.no_system", text: "陆沉不能获得系统。" }], negativeCanon: ["系统奖励", "突降新能力"], style: "用行动和对话推进场景。", initialState: { location: "街口" }, targetWords: 500, goals: [goal], planner: { provider: "sample", model: "sample" }, writer: { provider: "sample", model: "sample" } },
    state: { location: "街口" }, previousSummary: "", order: 1, goal,
    script: { title: goal.title, scenes: ["沿街寻找避难处", "到达城门并听见敲击"], mustDo: goal.mustDo, mustNot: goal.mustNot, hook: goal.hook },
    content: "陆沉沿街走到城门。门后传来敲击声。",
    review: { checks: { script: true, canon: true, continuity: true, character: true, information: true, expansion: true, hook: false }, issues: [{ code: "hook", severity: "blocking", description: "敲击缺少人物反应", evidence: "门后传来敲击声。", repairInstruction: "补充陆沉听见敲击后的即时动作，保持悬念。" }], summary: "陆沉到达城门。", changes: [] },
  };
}
