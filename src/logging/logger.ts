import pino from "pino";
import { env } from "../config/env";

// Pretty (human-readable) logs on a terminal, JSON otherwise (e.g. on Railway).
// Force either way with LOG_PRETTY=true|false. bigints aren't JSON-serializable,
// so always convert them to string/number at the log call-site.
const pretty = env.LOG_PRETTY === "true" || (env.LOG_PRETTY === undefined && Boolean(process.stdout.isTTY));

export const logger = pretty
  ? pino({
      level: env.LOG_LEVEL,
      transport: {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
      },
    })
  : pino({ level: env.LOG_LEVEL });
