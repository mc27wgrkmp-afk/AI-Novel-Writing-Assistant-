const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const sdkRoot = path.join(root, ".local", "siwc-devkit");
const sdkPackage = path.join(sdkRoot, "packages", "local");
const sdkEntry = path.join(sdkPackage, "dist", "index.js");
const repository = "https://github.com/openai/sign-in-with-chatgpt-devkit.git";
const revision = "f723814abdccec135b519c451fb6e1992ee5e933";
const runtime = process.env.FACTORY_NODE_BIN || process.execPath;
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.quiet ? "ignore" : "inherit",
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function commandOutput(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return result.status === 0 ? result.stdout.trim() : "";
}

const runtimeVersion = runtime === process.execPath ? process.versions.node : commandOutput(runtime, ["--version"], root).replace(/^v/, "");
const [major = 0, minor = 0] = runtimeVersion.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  console.log("ChatGPT 方案连接需要 Node.js 22.12 或更新版本；其他模型连接仍可使用。");
  process.exit(0);
}

fs.mkdirSync(path.dirname(sdkRoot), { recursive: true });
if (!fs.existsSync(sdkRoot)) {
  console.log("正在准备 OpenAI 官方 ChatGPT 登录组件…");
  if (run("git", ["clone", "--filter=blob:none", "--no-checkout", repository, sdkRoot]) !== 0) {
    throw new Error("下载 OpenAI ChatGPT 登录组件失败，请检查网络后重启本地工作台。");
  }
  if (run("git", ["fetch", "--depth=1", "origin", revision], { cwd: sdkRoot }) !== 0
      || run("git", ["checkout", "--detach", revision], { cwd: sdkRoot }) !== 0) {
    throw new Error("准备 OpenAI ChatGPT 登录组件失败；已保留下载目录以便排查。");
  }
}

if (!fs.existsSync(path.join(sdkRoot, ".git"))) {
  throw new Error("ChatGPT 登录组件目录不是受支持的官方 Git 工作副本；为保护本地文件，启动流程没有覆盖它。");
}
if (commandOutput("git", ["rev-parse", "HEAD"], sdkRoot) !== revision) {
  throw new Error(`ChatGPT 登录组件版本不匹配。请检查 ${sdkRoot} 后重启。`);
}
const sdkMetadata = JSON.parse(fs.readFileSync(path.join(sdkPackage, "package.json"), "utf8"));
if (sdkMetadata.name !== "@siwc/local") {
  throw new Error("ChatGPT 登录组件的包标识不匹配，已停止安装。");
}

if (!fs.existsSync(path.join(sdkPackage, "node_modules", "jose", "package.json"))
    || !fs.existsSync(path.join(sdkPackage, "node_modules", "proper-lockfile", "package.json"))) {
  console.log("正在安装 ChatGPT 登录组件的本地依赖…");
  if (run(pnpm, ["--dir", sdkPackage, "install", "--ignore-workspace", "--no-frozen-lockfile"]) !== 0) {
    throw new Error("安装 ChatGPT 登录组件依赖失败；其他模型连接仍可使用。");
  }
}

if (!fs.existsSync(sdkEntry)) {
  console.log("正在构建 ChatGPT 登录组件…");
  const typeScript = path.join(root, "node_modules", "typescript", "bin", "tsc");
  if (!fs.existsSync(typeScript)) throw new Error("找不到本地 TypeScript 编译器，无法准备 ChatGPT 登录组件。");
  if (run(runtime, [
    typeScript,
    "-p", path.join(sdkPackage, "tsconfig.json"),
    "--typeRoots", path.join(root, "server", "node_modules", "@types"),
  ]) !== 0) {
    throw new Error("构建 ChatGPT 登录组件失败；其他模型连接仍可使用。");
  }
  if (run(runtime, [path.join(sdkRoot, "scripts", "copy-package-notices.mjs"), path.join(sdkPackage, "dist")]) !== 0) {
    throw new Error("复制 ChatGPT 登录组件的许可说明失败。");
  }
}

console.log("ChatGPT 方案连接组件已准备完成。");
