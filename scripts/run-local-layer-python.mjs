import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const localPython = process.platform === "win32"
  ? path.join(projectRoot, "processing", "local-layers", ".venv", "Scripts", "python.exe")
  : path.join(projectRoot, "processing", "local-layers", ".venv", "bin", "python");
const executable = process.env.GREENWAVE_LOCAL_PYTHON || (fs.existsSync(localPython) ? localPython : "python");
const result = spawnSync(executable, process.argv.slice(2), { cwd: projectRoot, stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
