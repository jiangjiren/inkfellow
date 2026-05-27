export const HOME_MESSAGES = {
  "en": {
    brand: "inkfellow",
    tagline: "Personal knowledge base powered by LLM Wiki",
    langLabel: "Language",
    langEnglish: "EN",
    langChinese: "中文",
  },
  "zh-CN": {
    brand: "inkfellow",
    tagline: "LLM Wiki 驱动的个人知识库",
    langLabel: "语言",
    langEnglish: "EN",
    langChinese: "中文",
  },
} as const;

export type HomeMessages = (typeof HOME_MESSAGES)["en"];
