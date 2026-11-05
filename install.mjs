// Copies the built plugin into an Obsidian vault.
// Usage: npm run install-plugin -- "/path/to/Vault"
// or set the OBSIDIAN_VAULT environment variable.
import fs from "fs";
import path from "path";

const vault = process.argv[2] || process.env.OBSIDIAN_VAULT;
if (!vault) {
	console.error('Usage: npm run install-plugin -- "/path/to/Vault"  (or set OBSIDIAN_VAULT)');
	process.exit(1);
}

const target = path.join(vault, ".obsidian", "plugins", "reading-zoom");
fs.mkdirSync(target, { recursive: true });
for (const f of ["main.js", "manifest.json", "styles.css"]) {
	fs.copyFileSync(f, path.join(target, f));
}
console.log(`Installed to ${target}`);
