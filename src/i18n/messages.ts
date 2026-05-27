export const HOME_MESSAGES = {
  "en": {
    brand: "Free Online Image Tools",
    tagline: "Minimalist toolset for fast & private image processing",
    langLabel: "Language",
    langEnglish: "EN",
    langChinese: "中文",
  },
  "zh-CN": {
    brand: "免费在线工具合集",
    tagline: "极简高效的图片处理工具箱 · 无需上传 · 隐私安全",
    langLabel: "语言",
    langEnglish: "EN",
    langChinese: "中文",
  },
} as const;

export type HomeMessages = (typeof HOME_MESSAGES)["en"];
