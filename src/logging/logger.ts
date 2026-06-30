import pino from "pino";
import { env } from "../config/env";

// Default pino (JSON to stdout). bigints are not JSON-serializable, so always
// convert them to string/number at the log call-site.
export const logger = pino({ level: env.LOG_LEVEL });
