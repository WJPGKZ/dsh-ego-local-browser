/**
 * Capture the primary screen to a PNG (for verifying "opened in my browser").
 * Usage: node tools/screen-capture.mjs <absolute-png-path>
 * Runs a short PowerShell System.Drawing snippet; no C: writes.
 */
import { spawn } from "node:child_process";

const out = process.argv[2];
if (!out) {
  console.error("usage: node tools/screen-capture.mjs <absolute-png-path>");
  process.exit(2);
}
const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$dir = Split-Path -Parent '${out.replace(/'/g, "''")}'
if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$bmp.Save('${out.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "saved"
`;
const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => (stdout += chunk));
child.stderr.on("data", (chunk) => (stderr += chunk));
child.on("close", (code) => {
  console.log(JSON.stringify({ exit: code, stdout: stdout.trim().slice(0, 200), stderr: stderr.trim().slice(0, 300), path: out }));
});
