import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = join(root, "native", "windows-job-helper", "agentpatchcheck-job-helper.cpp");
const outputDirectory = join(root, "dist", "native", "windows");
const helper = join(outputDirectory, "agentpatchcheck-job-helper.exe");
const manifest = join(outputDirectory, "agentpatchcheck-job-helper.manifest.json");
const vswhere = "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe";

if (process.platform !== "win32") {
	const sourceDirectory = process.env.AGENTPATCHCHECK_WINDOWS_JOB_HELPER_SOURCE;
	if (sourceDirectory === undefined) {
		console.log("windows-job-helper: skipped outside Windows");
		process.exit(0);
	}
	await mkdir(outputDirectory, { recursive: true });
	await copyFile(join(sourceDirectory, "agentpatchcheck-job-helper.exe"), helper);
	await copyFile(join(sourceDirectory, "agentpatchcheck-job-helper.manifest.json"), manifest);
	console.log(`windows-job-helper: copied verified release artifact from ${sourceDirectory}`);
	process.exit(0);
}

await access(vswhere);
const installationPath = await new Promise((resolvePath, reject) => {
	let output = "";
	const child = spawn(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], { windowsHide: true });
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => { output += chunk; });
	child.once("error", reject);
	child.once("close", (code) => code === 0 && output.trim() ? resolvePath(output.trim()) : reject(new Error("Visual Studio C++ build tools are unavailable.")));
});
await mkdir(outputDirectory, { recursive: true });
const devCommand = `call "${join(installationPath, "Common7", "Tools", "VsDevCmd.bat")}" -no_logo -arch=x64 && cl.exe /nologo /std:c++20 /O2 /MT /EHsc /DUNICODE /D_UNICODE /Fe:"${helper}" "${source}" /link kernel32.lib`;
await new Promise((resolveBuild, reject) => {
	const child = spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", devCommand], { cwd: root, stdio: "inherit", windowsHide: true, windowsVerbatimArguments: true });
	child.once("error", reject);
	child.once("close", (code) => code === 0 ? resolveBuild() : reject(new Error(`Windows Job helper build failed (${code ?? "unknown"}).`)));
});
const sha256 = createHash("sha256").update(await readFile(helper)).digest("hex");
await writeFile(manifest, `${JSON.stringify({ protocolVersion: 1, helperVersion: "1.0.0", file: "agentpatchcheck-job-helper.exe", sha256 }, null, 2)}\n`, "utf8");
console.log(`windows-job-helper: built ${helper}`);
