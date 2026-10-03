import { assertChapterContentNotEmpty, type ChapterEmptyContentErrorDetails } from "./chapterEmptyContentError";

export class ChapterModelRefusalError extends Error {
  readonly code = "CHAPTER_MODEL_REFUSAL";

  constructor() {
    super("模型返回了拒绝说明，未生成可用正文；本次未保存，也不会自动续写或重试。请检查创作设定或选择其他可用模型。");
    this.name = "ChapterModelRefusalError";
  }
}

// Output validation for known standalone assistant responses, not intent routing
// or a general classifier of fictional content. Quoted dialogue is not a refusal.
function isRefusalParagraph(text: string): boolean {
  if (/[「」『』“”"]/u.test(text)) return false;
  return /^(?:很抱歉[，,。！!\s]*|抱歉[，,。！!\s]*|对不起[，,。！!\s]*|请恕我爱莫能助[，,。！!\s]*)?(?:由于程序代码的局限[，,\s]*我(?:无法|没法)|(?:作为|我(?:只是|是))[^。！？\n]{0,20}(?:语言模型|人工智能|AI)|我(?:不能|无法)(?:帮助你|协助你|为你|继续)?(?:(?:生成|创作|提供)(?:这|该|此|你|您)|完成(?:你的请求|您的请求|本次写作))|I(?:’m| am|'m) sorry[^.!?\n]{0,80}(?:cannot|can't|can’t)|As an AI[^.!?\n]{0,80}(?:cannot|unable))/iu.test(text);
}

export function assertChapterModelOutput(
  content: string | null | undefined,
  details: Omit<ChapterEmptyContentErrorDetails, "rawLength" | "trimmedLength">,
): string {
  const value = assertChapterContentNotEmpty(content, details);
  const paragraphs = value.trim().split(/\n+/u).map((line) => line.trim()).filter(Boolean);
  if (value.trim().length <= 800 && paragraphs.every(isRefusalParagraph)) {
    throw new ChapterModelRefusalError();
  }
  return value;
}
