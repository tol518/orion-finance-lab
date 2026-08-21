import { lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const excludedDirectories = new Set([
  ".git",
  "coverage",
  "data",
  "dist",
  "node_modules",
  "__pycache__",
]);
const forbiddenNames = [
  /^\.env(?!\.example$)/,
  /^\.venv/i,
  /^twsapi/i,
  /^(?:id_rsa|id_ed25519)$/,
];
const forbiddenExtensions = new Set([
  ".db",
  ".key",
  ".log",
  ".p12",
  ".pem",
  ".pfx",
  ".pyc",
  ".sqlite",
  ".zip",
]);
const secretPatterns = [
  { label: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { label: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/ },
  { label: "OpenAI-style key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { label: "AWS access key", pattern: /\bAKIA[A-Z0-9]{16}\b/ },
  { label: "IBKR paper account identifier", pattern: /\bDU\d{5,}\b/ },
];
const personalPathPrefix = ["/Users", "/"].join("");
const failures = [];

for (const relativePath of candidateFiles(root)) {
  const basename = path.basename(relativePath);
  const extension = path.extname(basename).toLowerCase();
  if (forbiddenNames.some((pattern) => pattern.test(basename)) || forbiddenExtensions.has(extension)) {
    failures.push(`${relativePath}: forbidden release artifact`);
    continue;
  }
  const absolutePath = path.join(root, relativePath);
  const stat = lstatSync(absolutePath);
  if (stat.isSymbolicLink()) {
    failures.push(`${relativePath}: symbolic links are not allowed in the public release`);
    continue;
  }
  if (stat.size > 5_000_000) {
    failures.push(`${relativePath}: file exceeds the 5 MB public-source limit`);
    continue;
  }
  const content = readFileSync(absolutePath, "utf8");
  if (content.includes(personalPathPrefix)) failures.push(`${relativePath}: contains an absolute macOS user path`);
  for (const { label, pattern } of secretPatterns) {
    if (pattern.test(content)) failures.push(`${relativePath}: contains a possible ${label}`);
  }
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|KEY|ACCOUNT_ID))\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const value = match[2].replace(/^['"]|['"]$/g, "").trim();
    const isPlaceholder = !value || /^<[^>]+>$/.test(value) || /^\$\{[^}]+\}$/.test(value);
    if (!isPlaceholder) failures.push(`${relativePath}: ${match[1]} contains a non-placeholder value`);
  }
}

if (failures.length > 0) {
  console.error("Public-release verification failed:\n" + failures.map((item) => `- ${item}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log("Public-release verification passed: no forbidden artifacts or credential patterns found.");
}

function candidateFiles(directory, prefix = "") {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = path.join(prefix, entry.name);
    if (entry.isDirectory()) {
      if (excludedDirectories.has(entry.name) || entry.name.startsWith(".venv")) continue;
      files.push(...candidateFiles(path.join(directory, entry.name), relativePath));
      continue;
    }
    if (entry.isFile() || entry.isSymbolicLink()) files.push(relativePath);
  }
  return files;
}
