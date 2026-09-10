export const usageText = "Usage: mdreview <command> [arguments] [flags]\nRun `mdreview <command> --help` for command-specific help.";

export class CliUsageError extends Error {
  constructor(message = usageText) {
    super(message);
    this.name = "CliUsageError";
  }
}

export function usage(message?: string): never {
  throw new CliUsageError(message ? `${message} ${usageText}` : usageText);
}

type FlagSpec = { value?: true };
type CommandSpec = {
  name: string;
  usage: string;
  min: number;
  max: number;
  flags?: Record<string, FlagSpec>;
  required?: string[];
};

type ParsedCommand = {
  spec: CommandSpec;
  positionals: string[];
  flags: Map<string, string | true>;
  help: boolean;
};

const focusFlags = { "--focus": {}, "--no-focus": {}, "--host": { value: true } } as const;
const actorFlags = { "--actor": { value: true }, "--consumer": { value: true } } as const;
const budgetFlags = { "--max-bytes": { value: true }, "--continuation": { value: true } } as const;
const mutationActorFlags = { "--actor": { value: true } } as const;
const operationFlags = { "--operation-id": { value: true }, "--expected-thread-sequence": { value: true } } as const;
export const commandSpecs: Record<string, CommandSpec> = {
  setup: { name: "setup", usage: "tether setup [--host auto|browser|wave|cmux] [--wave] [--agent-directory <skills-directory>] [--no-open]", min: 0, max: 0, flags: { "--host": { value: true }, "--wave": {}, "--agent-directory": { value: true }, "--no-open": {} } },
  doctor: { name: "doctor", usage: "tether doctor", min: 0, max: 0 },
  backup: { name: "backup", usage: "tether backup --output <new-directory>", min: 0, max: 0, flags: { "--output": { value: true } }, required: ["--output"] },
  restore: { name: "restore", usage: "tether restore --source <backup-directory> --directory <new-directory>", min: 0, max: 0, flags: { "--source": { value: true }, "--directory": { value: true } }, required: ["--source", "--directory"] },
  update: { name: "update", usage: "tether update [--version <vX.Y.Z>]", min: 0, max: 0, flags: { "--version": { value: true } } },
  uninstall: { name: "uninstall", usage: "tether uninstall --confirm", min: 0, max: 0, flags: { "--confirm": {} }, required: ["--confirm"] },
  open: { name: "open", usage: "mdreview open <file> [--focus|--no-focus]", min: 1, max: 1, flags: focusFlags },
  recent: { name: "recent", usage: "mdreview recent <1|2|3> [--focus|--no-focus]", min: 1, max: 1, flags: focusFlags },
  recents: { name: "recents", usage: "mdreview recents [--focus|--no-focus]", min: 0, max: 0, flags: focusFlags },
  "recents.add": { name: "recents.add", usage: "mdreview recents add <file>", min: 1, max: 1 },
  "daemon.status": { name: "daemon.status", usage: "mdreview daemon status", min: 0, max: 0 },
  "daemon.stop": { name: "daemon.stop", usage: "mdreview daemon stop", min: 0, max: 0 },
  "cmux.status": { name: "cmux.status", usage: "mdreview cmux status", min: 0, max: 0 },
  "wave.status": { name: "wave.status", usage: "mdreview wave status", min: 0, max: 0 },
  "wave.install": { name: "wave.install", usage: "mdreview wave install", min: 0, max: 0 },
  "wave.uninstall": { name: "wave.uninstall", usage: "mdreview wave uninstall", min: 0, max: 0 },
  "document.move": { name: "document.move", usage: "mdreview document move <source> <destination>", min: 2, max: 2 },
  "document.outline": { name: "document.outline", usage: "mdreview document outline <file> [--offset <count>] [--max-bytes <bytes>]", min: 1, max: 1, flags: { "--max-bytes": { value: true }, "--offset": { value: true } } },
  "document.context": { name: "document.context", usage: "mdreview document context <file> <thread-id> [--max-bytes <bytes>]", min: 2, max: 2, flags: { "--max-bytes": { value: true } } },
  "document.diff": { name: "document.diff", usage: "mdreview document diff <file> --from-revision <revision> [--max-bytes <bytes>]", min: 1, max: 1, flags: { "--max-bytes": { value: true }, "--from-revision": { value: true } }, required: ["--from-revision"] },
  edit: { name: "edit", usage: "mdreview edit <file> <thread-id> <target-id> --actor <actor> --body-file <file|-> --operation-id <id> [--expected-thread-sequence <seq>]", min: 3, max: 3, flags: { ...mutationActorFlags, ...operationFlags, "--body-file": { value: true } }, required: ["--actor", "--body-file", "--operation-id"] },
  delete: { name: "delete", usage: "mdreview delete <file> <thread-id> <target-id> --actor <actor> --operation-id <id> [--expected-thread-sequence <seq>]", min: 3, max: 3, flags: { ...mutationActorFlags, ...operationFlags }, required: ["--actor", "--operation-id"] },
  "quote-candidates": { name: "quote-candidates", usage: "mdreview quote-candidates <file> --quote <text> [--limit <count>] [--max-bytes <bytes>]", min: 1, max: 1, flags: { "--quote": { value: true }, "--limit": { value: true }, "--max-bytes": { value: true } }, required: ["--quote"] },
  operation: { name: "operation", usage: "mdreview operation <file> --operation-id <id>", min: 1, max: 1, flags: { "--operation-id": { value: true } }, required: ["--operation-id"] },
  event: { name: "event", usage: "mdreview event <file> <event-id> [--offset <count>] [--max-bytes <bytes>]", min: 2, max: 2, flags: { "--offset": { value: true }, "--max-bytes": { value: true } } },
  "folio.sync": { name: "folio.sync", usage: "mdreview folio sync", min: 0, max: 0 },
  "document.read": { name: "document.read", usage: "mdreview document read <file>", min: 1, max: 1 },
  "document.save": { name: "document.save", usage: "mdreview document save <file> --expected-body-revision <revision> --body-file <file|->", min: 1, max: 1, flags: { "--expected-body-revision": { value: true }, "--body-file": { value: true } }, required: ["--expected-body-revision", "--body-file"] },
  pending: { name: "pending", usage: "mdreview pending <file> --actor <actor> [--consumer <consumer>] [--limit <count>] [--max-bytes <bytes>] [--continuation <token>]", min: 1, max: 1, flags: { ...actorFlags, ...budgetFlags, "--limit": { value: true }, "--continuation": { value: true } }, required: ["--actor"] },
  thread: { name: "thread", usage: "mdreview thread <file> <thread-id> [--before-sequence <seq>] [--limit <count>] [--max-bytes <bytes>] [--continuation <token>]", min: 2, max: 2, flags: { ...budgetFlags, "--before-sequence": { value: true }, "--limit": { value: true } } },
  threads: { name: "threads", usage: "mdreview threads <file> [--status <open|resolved>] [--before-sequence <seq>] [--limit <count>] [--max-bytes <bytes>] [--continuation <token>]", min: 1, max: 1, flags: { ...budgetFlags, "--status": { value: true }, "--before-sequence": { value: true }, "--limit": { value: true } } },
  reply: { name: "reply", usage: "mdreview reply <file> <thread-id> --actor <actor> --body-file <file|-> --operation-id <id> [--expected-thread-sequence <seq>]", min: 2, max: 2, flags: { ...mutationActorFlags, ...operationFlags, "--body-file": { value: true } }, required: ["--actor", "--body-file", "--operation-id"] },
  resolve: { name: "resolve", usage: "mdreview resolve <file> <thread-id> --actor <actor> --operation-id <id> [--expected-thread-sequence <seq>]", min: 2, max: 2, flags: { ...mutationActorFlags, ...operationFlags }, required: ["--actor", "--operation-id"] },
  reopen: { name: "reopen", usage: "mdreview reopen <file> <thread-id> --actor <actor> --operation-id <id> [--expected-thread-sequence <seq>]", min: 2, max: 2, flags: { ...mutationActorFlags, ...operationFlags }, required: ["--actor", "--operation-id"] },
  acknowledge: { name: "acknowledge", usage: "mdreview acknowledge <file> --actor <actor> --cursor <cursor> --operation-id <id> [--consumer <consumer>]", min: 1, max: 1, flags: { ...actorFlags, "--cursor": { value: true }, "--operation-id": { value: true } }, required: ["--actor", "--cursor", "--operation-id"] },
  comment: { name: "comment", usage: "mdreview comment <file> --actor <actor> --quote <exact text> --body-file <file|-> --operation-id <id> [--candidate-id <id> --expected-body-revision <revision>]", min: 1, max: 1, flags: { "--candidate-id": { value: true }, "--expected-body-revision": { value: true }, "--actor": { value: true }, "--quote": { value: true }, "--body-file": { value: true }, "--operation-id": { value: true } }, required: ["--actor", "--quote", "--body-file", "--operation-id"] },
  folio: { name: "folio", usage: "mdreview folio [--focus|--no-focus]", min: 0, max: 0, flags: focusFlags },
  "folio.list": { name: "folio.list", usage: "mdreview folio list [--view <active|archive>] [--sort <sort>] [--open-threads] [--missing] [--query <text>] [--directory <path>] [--repository <path>]", min: 0, max: 0, flags: { "--view": { value: true }, "--sort": { value: true }, "--open-threads": {}, "--needs-attention": {}, "--missing": {}, "--query": { value: true }, "--directory": { value: true }, "--repository": { value: true } } },
  "folio.add": { name: "folio.add", usage: "mdreview folio add <file>...", min: 1, max: Infinity },
  "folio.archive": { name: "folio.archive", usage: "mdreview folio archive <file>... [--confirm]", min: 1, max: Infinity, flags: { "--confirm": {} } },
  "folio.restore": { name: "folio.restore", usage: "mdreview folio restore <file>...", min: 1, max: Infinity },
  "folio.pin": { name: "folio.pin", usage: "mdreview folio pin <file>... [--off]", min: 1, max: Infinity, flags: { "--off": {} } },
  "folio.locate": { name: "folio.locate", usage: "mdreview folio locate <file> --new-path <file>", min: 1, max: 1, flags: { "--new-path": { value: true } }, required: ["--new-path"] },
  "folio.settings": { name: "folio.settings", usage: "mdreview folio settings [--retention <days|forever|immediate> --confirm]", min: 0, max: 0, flags: { "--retention": { value: true }, "--confirm": {} } },
  "folio.export": { name: "folio.export", usage: "mdreview folio export <file>... --output <package.tether> [--overwrite]", min: 1, max: Infinity, flags: { "--output": { value: true }, "--overwrite": {} }, required: ["--output"] },
  "folio.import": { name: "folio.import", usage: "mdreview folio import --package <package.tether> --directory <directory>", min: 0, max: 0, flags: { "--package": { value: true }, "--directory": { value: true } }, required: ["--package", "--directory"] },
};

function commandPrefix(argv: string[]): { name: string; start: number } {
  const [first, second] = argv;
  if (["daemon", "cmux", "wave", "document"].includes(first ?? "")) return { name: `${first}.${second ?? ""}`, start: 2 };
  if (first === "recents" && second === "add") return { name: "recents.add", start: 2 };
  if (first === "folio" && second && commandSpecs[`folio.${second}`]) return { name: `folio.${second}`, start: 2 };
  return { name: first ?? "unknown", start: 1 };
}

export function parseCommand(argv: string[]): ParsedCommand {
  const prefix = commandPrefix(argv);
  const spec = commandSpecs[prefix.name];
  if (!spec) usage(`Unknown command: ${prefix.name}.`);
  const rest = argv.slice(prefix.start);
  const boundary = rest.indexOf("--");
  const help = rest.slice(0, boundary < 0 ? rest.length : boundary).includes("--help");
  if (help) {
    if (rest.length !== 1 || rest[0] !== "--help") usage("--help must be the only command argument.");
    return { spec, positionals: [], flags: new Map(), help: true };
  }
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  let literals = false;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (!literals && token === "--") { literals = true; continue; }
    if (!literals && token.startsWith("--")) {
      const flag = spec.flags?.[token];
      if (!flag) usage(`Unknown flag for ${spec.name}: ${token}.`);
      if (flags.has(token)) usage(`Flag may be specified only once: ${token}.`);
      if (flag.value) {
        const value = rest[++index];
        if (!value || value === "--" || value.startsWith("--")) usage(`${token} requires a value.`);
        flags.set(token, value);
      } else flags.set(token, true);
    } else positionals.push(token);
  }
  if (positionals.length < spec.min || positionals.length > spec.max) usage(spec.usage);
  for (const name of spec.required ?? []) if (!flags.has(name)) usage(`${name} is required. ${spec.usage}`);
  if (flags.has("--focus") && flags.has("--no-focus")) usage("--focus and --no-focus cannot be used together.");
  if (flags.has("--candidate-id") && !flags.has("--expected-body-revision")) usage("--candidate-id requires --expected-body-revision.");
  for (const key of ["--expected-body-revision", "--from-revision"]) {
    const value = flags.get(key);
    if (value !== undefined && (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value))) usage(`${key} requires sha256:<64 lowercase hex characters>.`);
  }
  const maxBytes = flags.get("--max-bytes");
  if (typeof maxBytes === "string" && (Number(maxBytes) < 2048 || Number(maxBytes) > 65536)) usage("--max-bytes must be between 2048 and 65536.");
  const status = flags.get("--status");
  if (status !== undefined && status !== "open" && status !== "resolved") usage("--status must be open or resolved.");
  const view = flags.get("--view");
  const host = flags.get("--host");
  if (host !== undefined && !["auto", "browser", "wave", "cmux"].includes(String(host))) usage("--host must be auto, browser, wave, or cmux.");
  if (view !== undefined && view !== "active" && view !== "archive") usage("--view must be active or archive.");
  const sort = flags.get("--sort");
  if (typeof sort === "string" && !["opened", "modified", "activity", "added", "created", "name"].includes(sort)) usage("--sort must be opened, modified, activity, added, created, or name.");
  for (const name of ["--before-sequence", "--limit", "--expected-thread-sequence", "--max-bytes", "--radius"] as const) {
    const value = flags.get(name);
    if (typeof value === "string") positiveInteger(value, name);
  }
  const offset = flags.get("--offset");
  if (typeof offset === "string" && (!Number.isSafeInteger(Number(offset)) || Number(offset) < 0)) usage("--offset must be a nonnegative integer.");
  for (const [flag, value] of flags) {
    if (typeof value === "string" && Buffer.byteLength(value) > (flag === "--quote" ? 65536 : 8192)) usage(`${flag} is too long.`);
  }
  const retention = flags.get("--retention");
  if (typeof retention === "string" && retention !== "forever" && retention !== "immediate") positiveInteger(retention, "--retention");
  return { spec, positionals, flags, help: false };
}

export function requiredFlag(parsed: ParsedCommand, name: string): string {
  const value = parsed.flags.get(name);
  if (typeof value !== "string") usage(`${name} is required. ${parsed.spec.usage}`);
  return value;
}

export function optionalFlag(parsed: ParsedCommand, name: string): string | undefined {
  const value = parsed.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

export function readOptions(parsed: ParsedCommand): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  for (const [flag, key] of [["--max-bytes", "maxBytes"], ["--limit", "limit"], ["--radius", "radius"]]) {
    const value = optionalFlag(parsed, flag!);
    if (value) options[key!] = positiveInteger(value, flag!);
  }
  const offset = optionalFlag(parsed, "--offset");
  if (offset !== undefined) options.offset = Number(offset);
  const continuation = optionalFlag(parsed, "--continuation");
  if (continuation) options.continuation = continuation;
  return options;
}

export function focusPreference(parsed: ParsedCommand): boolean {
  return !parsed.flags.has("--no-focus");
}

export function positiveInteger(value: string, name: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) usage(`${name} must be a positive integer.`);
  return number;
}
