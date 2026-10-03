import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const PROVIDER_ID = "macos-keychain-aesgcm-v1";
const KEYCHAIN_SERVICE = "com.ai-novel-writing-assistant.chatgpt-plan";
const KEYCHAIN_ACCOUNT = "oauth-credential-encryption-key";
const ENVELOPE_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runSecurity(args: string[], stdinText?: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("security", args, { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error, result?: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result!);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("The macOS credential store did not respond."));
    }, 15_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = `${stdout}${chunk}`.slice(0, 8192);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(0, 8192);
    });
    child.once("error", () => finish(new Error("The macOS credential store is unavailable.")));
    child.once("close", (code) => finish(undefined, { code: code ?? 1, stdout, stderr }));
    child.stdin.end(stdinText);
  });
}

function isMissingItem(result: CommandResult): boolean {
  return result.stderr.includes("-25300") || /item could not be found/i.test(result.stderr);
}

async function readKey(): Promise<Buffer | null> {
  const result = await runSecurity([
    "find-generic-password",
    "-a", KEYCHAIN_ACCOUNT,
    "-s", KEYCHAIN_SERVICE,
    "-w",
  ]);
  if (result.code !== 0) {
    if (isMissingItem(result)) return null;
    throw new Error("The macOS credential store could not be read. Unlock Keychain Access, then try again.");
  }
  const key = Buffer.from(result.stdout.trim(), "base64");
  if (key.length !== 32) {
    throw new Error("The saved credential encryption key is invalid. Saved ChatGPT credentials were preserved.");
  }
  return key;
}

async function getOrCreateKey(): Promise<Buffer> {
  const existing = await readKey();
  if (existing) return existing;

  const candidate = randomBytes(32);
  const password = candidate.toString("base64");
  const result = await runSecurity([
    "add-generic-password",
    "-a", KEYCHAIN_ACCOUNT,
    "-s", KEYCHAIN_SERVICE,
    "-w",
  ], `${password}\n${password}\n`);
  if (result.code === 0) return candidate;

  // Another app process may have created the key between our read and write.
  const raced = await readKey();
  if (raced) return raced;
  throw new Error("The credential encryption key could not be saved to macOS Keychain.");
}

export const macOSCredentialEncryption = {
  id: PROVIDER_ID,

  async isAvailable(): Promise<boolean> {
    if (process.platform !== "darwin") return false;
    try {
      return (await runSecurity(["default-keychain"])).code === 0;
    } catch {
      return false;
    }
  },

  async encrypt(plaintext: string): Promise<Uint8Array> {
    const key = await getOrCreateKey();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(PROVIDER_ID));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return Buffer.concat([
      Buffer.from([ENVELOPE_VERSION]),
      iv,
      cipher.getAuthTag(),
      ciphertext,
    ]);
  },

  async decrypt(envelope: Uint8Array): Promise<string> {
    const bytes = Buffer.from(envelope);
    if (bytes.length < 1 + IV_BYTES + TAG_BYTES + 1 || bytes[0] !== ENVELOPE_VERSION) {
      throw new Error("The saved ChatGPT credentials have an unsupported encryption format.");
    }
    const key = await readKey();
    if (!key) {
      throw new Error("The credential encryption key is missing. Saved ChatGPT credentials were preserved.");
    }
    const iv = bytes.subarray(1, 1 + IV_BYTES);
    const tag = bytes.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
    const ciphertext = bytes.subarray(1 + IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(PROVIDER_ID));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  },
};
