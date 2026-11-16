import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Where the Printerials connection is kept: the access token (an hour) and the refresh token
 * (90 days, rotated on every use). Both go together, so every process of this server (one per
 * MCP host: Claude Code, Claude Desktop) uses the same tokens and refreshes as rarely as one.
 */
export interface StoredTokens {
  access_token: string;
  /** Epoch milliseconds. */
  expires_at: number;
  refresh_token: string;
  scope: string;
  /** ISO time of the sign-in. */
  connected_at: string;
}

export interface TokenStore {
  /** For messages: "macOS Keychain", or the file. */
  readonly kind: string;
  /** The lock file that serializes refreshes across processes using this store. */
  readonly lockPath: string;
  read(): Promise<StoredTokens | null>;
  write(tokens: StoredTokens): Promise<void>;
  delete(): Promise<void>;
}

/** The store for this platform: the Keychain on macOS, a file when PRINTERIALS_TOKEN_FILE says so, else none. */
export function defaultTokenStore(origin: string, env: NodeJS.ProcessEnv = process.env): TokenStore | null {
  const file = env.PRINTERIALS_TOKEN_FILE?.trim();
  if (file) return new FileTokenStore(file, origin);
  if (process.platform === "darwin") return new KeychainTokenStore(origin);
  return null;
}

function parseTokens(value: unknown): StoredTokens | null {
  if (!value || typeof value !== "object") return null;
  const t = value as Record<string, unknown>;
  if (typeof t.access_token !== "string" || typeof t.refresh_token !== "string" || !t.refresh_token) return null;
  if (typeof t.expires_at !== "number") return null;
  return {
    access_token: t.access_token,
    expires_at: t.expires_at,
    refresh_token: t.refresh_token,
    scope: typeof t.scope === "string" ? t.scope : "",
    connected_at: typeof t.connected_at === "string" ? t.connected_at : "",
  };
}

const SECURITY = "/usr/bin/security";
const SERVICE = "PrusaSlicerMCP Printerials";
const LABEL = "PrusaSlicer MCP: Printerials connection";
/** security's exit status for "The specified item could not be found in the keychain." */
const NOT_FOUND = 44;

function security(args: string[], input = ""): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(SECURITY, args, { timeout: 15_000, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      if (!error) return resolve({ code: 0, stdout, stderr });
      const code = (error as NodeJS.ErrnoException).code;
      if (typeof code === "number") return resolve({ code, stdout, stderr });
      reject(new Error(`The Keychain could not be used: ${error.killed ? "security timed out" : error.message}`));
    });
    child.stdin?.end(input);
  });
}

/**
 * One generic password in the login Keychain per Printerials origin, written and read by
 * /usr/bin/security, which is then the application the item trusts (no prompt on reading).
 * The secret goes in on stdin (security -i), not as an argument: arguments are visible to every
 * user in ps. It is base64url, so it needs no quoting in security's command language.
 */
export class KeychainTokenStore implements TokenStore {
  readonly kind = "macOS Keychain";
  readonly lockPath: string;
  private readonly account: string;

  constructor(origin: string) {
    if (/["\\\n]/.test(origin)) throw new Error("The Printerials origin cannot be a Keychain account name.");
    this.account = origin;
    // Not in os.tmpdir(): that follows TMPDIR, which one MCP host may pass and another not.
    this.lockPath = join(homedir(), "Library", "Caches", "PrusaSlicerMCP", `printerials-${createHash("sha256").update(origin).digest("hex").slice(0, 12)}.lock`);
  }

  async read(): Promise<StoredTokens | null> {
    const { code, stdout, stderr } = await security(["find-generic-password", "-a", this.account, "-s", SERVICE, "-w"]);
    if (code === NOT_FOUND) return null;
    if (code !== 0) throw new Error(`The Keychain could not be read (security exit ${code}: ${stderr.trim()}).`);
    try {
      return parseTokens(JSON.parse(Buffer.from(stdout.trim(), "base64url").toString("utf8")));
    } catch {
      return null;
    }
  }

  async write(tokens: StoredTokens): Promise<void> {
    const secret = Buffer.from(JSON.stringify(tokens), "utf8").toString("base64url");
    const command = `add-generic-password -U -a "${this.account}" -s "${SERVICE}" -l "${LABEL}" -w ${secret}\n`;
    const { code, stderr } = await security(["-i"], command);
    if (code !== 0) throw new Error(`The Keychain could not be written (security exit ${code}: ${stderr.trim()}).`);
  }

  async delete(): Promise<void> {
    const { code, stderr } = await security(["delete-generic-password", "-a", this.account, "-s", SERVICE]);
    if (code !== 0 && code !== NOT_FOUND) throw new Error(`The Keychain item could not be removed (security exit ${code}: ${stderr.trim()}).`);
  }
}

/**
 * A JSON file, mode 0600, with one entry per origin: for a machine without a Keychain, and for
 * tests. The tokens are in plain text; the file's permissions are all that protects them.
 */
export class FileTokenStore implements TokenStore {
  readonly kind: string;
  readonly lockPath: string;
  private readonly path: string;
  private readonly origin: string;

  constructor(path: string, origin: string) {
    this.path = path;
    this.origin = origin;
    this.kind = `file ${path}`;
    this.lockPath = `${path}.lock`;
  }

  private async all(): Promise<Record<string, unknown>> {
    try {
      const data = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  private async save(all: Record<string, unknown>): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, this.path);
  }

  async read(): Promise<StoredTokens | null> {
    return parseTokens((await this.all())[this.origin]);
  }

  async write(tokens: StoredTokens): Promise<void> {
    await this.save({ ...(await this.all()), [this.origin]: tokens });
  }

  async delete(): Promise<void> {
    const all = await this.all();
    if (!(this.origin in all)) return;
    delete all[this.origin];
    await this.save(all);
  }
}
