export { parseWaExport, type WaParseOptions, type WaParseResult, type WaParsedMessage } from "./adapters/parseWaExport.js";
export { parseTgExport, type TgParseOptions, type TgParseResult, type TgParsedMessage } from "./adapters/parseTgExport.js";
export { Wa1Adapter } from "./adapters/wa1.js";
export { Wa2Adapter } from "./adapters/wa2.js";
export { Tg1Adapter } from "./adapters/tg1.js";
export { Tg2Adapter } from "./adapters/tg2.js";
export {
  UnsupportedOperationError,
  type AdapterCapabilities,
  type AdapterState,
  type SourceAdapter,
} from "./contracts/adapter.js";
export type { RawMessageEvent, MediaRef, MessageDirection } from "./contracts/events.js";
export { IngestStore, naturalKey, type IngestEvent, type IngestResult, type StoredMessage, type Revision } from "./core/ingest.js";
export { PersonStore, PersonLinkError, type Person, type PersonLink, type SplitLogEntry } from "./core/persons.js";
export {
  money, add, sub, mul, negate, equals, compare, isZero, format,
  CurrencyMismatchError, type Money,
} from "./core/money.js";
export {
  Ledger, balanceLineAmount,
  type FinancialEvent, type FinancialEventType, type ConfirmationState, type Balance, type BalanceLine,
} from "./core/settlements.js";
export { Scheduler, isQuietTime, quietWindowEnd, type ScheduledTask, type QuietHours, type TaskResult } from "./core/scheduler.js";
export { Allowlist, RecipientNotAllowedError } from "./core/channels/allowlist.js";
export {
  tools, TOOL_NAMES, validateToolInput, validateToolOutput, UnknownToolError,
  type ToolName, type ToolInput, type ToolOutput,
} from "./core/agent/tools.js";
