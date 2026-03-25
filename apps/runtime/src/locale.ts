import {
  DEFAULT_LOCALE,
  normalizeLocale,
  resolveLocaleFromHeader,
  type SupportedLocale
} from "../../../modules/contracts/src/index.js";

export interface RuntimeErrorPayload {
  error: {
    code: string;
    message: string;
  };
}

export function resolveRequestLocale(input: {
  header?: string | string[] | null;
  bodyLocale?: unknown;
}): SupportedLocale {
  if (typeof input.bodyLocale === "string" && input.bodyLocale.trim().length > 0) {
    return normalizeLocale(input.bodyLocale);
  }

  const headerValue = Array.isArray(input.header)
    ? input.header.join(",")
    : input.header;

  if (typeof headerValue === "string" && headerValue.trim().length > 0) {
    return resolveLocaleFromHeader(headerValue);
  }

  return DEFAULT_LOCALE;
}

export function createRuntimeErrorPayload(
  code: string,
  locale: SupportedLocale
): RuntimeErrorPayload {
  return {
    error: {
      code,
      message: translateRuntimeError(code, locale)
    }
  };
}

export function translateRuntimeError(code: string, locale: SupportedLocale): string {
  const messages: Record<string, { "zh-CN": string; en: string }> = {
    INVALID_REQUEST: {
      "zh-CN": "请求无效。",
      en: "Invalid request."
    },
    PAYLOAD_TOO_LARGE: {
      "zh-CN": "请求体过大。",
      en: "Payload too large."
    },
    NOT_FOUND: {
      "zh-CN": "资源不存在。",
      en: "Not found."
    }
  };

  const message = messages[code];
  if (!message) {
    return locale === "en" ? "Unexpected runtime error." : "运行时发生意外错误。";
  }

  return locale === "en" ? message.en : message["zh-CN"];
}

export function createLocaleSystemInstruction(locale: SupportedLocale): string {
  return locale === "en"
    ? "Respond in English. Keep command results, prompts, and interactive blocks in English."
    : "请使用简体中文回复，并将命令结果、提示和交互块都生成为简体中文。";
}

export function translateCommandDescription(
  commandName: string,
  fallbackDescription: string,
  locale: SupportedLocale
): string {
  const localized = commandDescriptionMap[commandName];
  if (!localized) {
    return fallbackDescription;
  }

  return locale === "en" ? localized.en : localized["zh-CN"];
}

const commandDescriptionMap: Record<string, { "zh-CN": string; en: string }> = {
  archive: {
    "zh-CN": "创建、查看并恢复归档。",
    en: "Create, inspect, and restore archives."
  },
  guide: {
    "zh-CN": "生成引导选择块。",
    en: "Generate a guide block."
  },
  help: {
    "zh-CN": "列出可用命令。",
    en: "List available commands."
  },
  memory: {
    "zh-CN": "查看或重建记忆状态。",
    en: "Inspect or reindex memory state."
  },
  packages: {
    "zh-CN": "查看已启用的扩展包。",
    en: "Inspect enabled packages."
  },
  presets: {
    "zh-CN": "查看当前运行时预设状态。",
    en: "Inspect the active runtime preset state."
  },
  session: {
    "zh-CN": "查看当前会话状态。",
    en: "Inspect the current session state."
  },
  trace: {
    "zh-CN": "查看最近的追踪输出。",
    en: "Inspect the latest trace output."
  }
};
