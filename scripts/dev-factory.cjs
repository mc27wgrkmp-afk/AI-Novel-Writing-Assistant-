const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const runtime = process.env.FACTORY_NODE_BIN || process.execPath;
const apiPort = process.env.FACTORY_API_PORT || "8012";
const webPort = process.env.FACTORY_WEB_PORT || "5175";
const dataRoot = path.join(root, ".local-data");
fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
const environment = {
  ...process.env,
  PATH: `${path.dirname(runtime)}${path.delimiter}${process.env.PATH || ""}`,
  AI_NOVEL_RUNTIME: "desktop",
  AI_NOVEL_APP_DATA_DIR: dataRoot,
  DATABASE_URL: process.env.DATABASE_URL || `file:${path.join(dataRoot, "factory.sqlite3")}`,
  HOST: "127.0.0.1", PORT: apiPort, ALLOW_LAN: "false",
  CORS_ORIGIN: `http://127.0.0.1:${webPort},http://localhost:${webPort}`,
  VITE_API_BASE_URL: `http://127.0.0.1:${apiPort}/api`, RAG_ENABLED: "false",
  AI_NOVEL_SIWC_SDK_ENTRY: path.join(root, ".local", "siwc-devkit", "packages", "local", "dist", "index.js"),
};
const siwcPrepared = spawnSync(runtime, [path.join(root, "scripts", "setup-chatgpt-sdk.cjs")], { cwd: root, env: environment, stdio: "inherit" });
if (siwcPrepared.status !== 0) console.error("ChatGPT 方案连接未能准备；其余本地工作台功能继续启动。");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const built = spawnSync(pnpm, ["--filter", "@ai-novel/shared", "build"], { cwd: root, env: environment, stdio: "inherit" });
if (built.status !== 0) process.exit(built.status || 1);
const generated = spawnSync(pnpm, ["--filter", "@ai-novel/server", "prisma:generate"], { cwd: root, env: environment, stdio: "inherit" });
if (generated.status !== 0) process.exit(generated.status || 1);
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    try {
      if (process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
      else if (!child.killed) child.kill("SIGTERM");
    } catch (error) { if (error.code !== "ESRCH") console.error("停止子进程失败，请检查本地服务。"); }
  }
  const timer = setTimeout(() => process.exit(code), 1500);
  timer.unref();
}
function launch(args) {
  const child = spawn(pnpm, args, { cwd: root, env: environment, stdio: "inherit", detached: process.platform !== "win32" });
  children.push(child);
  child.on("error", () => { console.error("启动失败，请检查依赖与端口。"); stop(1); });
  child.on("exit", code => { if (!stopping) stop(code || 0); });
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
launch(["--filter", "@ai-novel/server", "exec", "ts-node-dev", "--respawn", "--transpile-only", "src/app.ts"]);
launch(["--filter", "@ai-novel/client", "exec", "vite", "--host", "127.0.0.1", "--port", webPort, "--strictPort"]);
console.log(`章节生产页：http://127.0.0.1:${webPort}/factory`);
console.log("正文服务与审核模型请在模型配置页填写；点击生成后才会发送故事材料。");
