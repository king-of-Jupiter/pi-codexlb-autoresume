// Marketplace entry point (omp `/marketplace add <owner>/pi-codexlb-autoresume`).
//
// omp loads marketplace plugins through its Claude-plugins provider, which has no
// `extensions/` loader. It does load every `hooks/pre/*.ts` file as an extension
// module, so this file is how the extension reaches a marketplace install.
// The npm package (`omp install npm:pi-codexlb-autoresume`) uses ./index.ts via
// package.json "pi"/"omp".extensions instead.
export { default } from "../../index.ts";
