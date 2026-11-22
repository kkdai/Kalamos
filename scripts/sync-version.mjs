import { readFileSync, writeFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const cargoVersion = /^(name = "kalamos"\nversion = )"[^"\n]+"/m;

function updateJson(path, update) {
	const source = readFileSync(path, "utf8");
	const data = JSON.parse(source);
	const indent = source.match(/^[ \t]+(?=")/m)?.[0] ?? 2;
	update(data);
	writeFileSync(path, `${JSON.stringify(data, null, indent)}\n`);
}

for (const path of ["src-tauri/Cargo.toml", "src-tauri/Cargo.lock"]) {
	const source = readFileSync(path, "utf8");
	if (!cargoVersion.test(source)) {
		throw new Error(`Cannot find the kalamos package version in ${path}`);
	}
	writeFileSync(path, source.replace(cargoVersion, `$1"${version}"`));
}

updateJson("package-lock.json", (lock) => {
	lock.version = version;
	lock.packages[""].version = version;
});

updateJson("src-tauri/tauri.conf.json", (config) => {
	config.version = version;
});
