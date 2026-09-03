import { defineConfig } from "vite";

export default defineConfig({
	esbuild: { jsx: "automatic" },
	server: { host: "127.0.0.1", port: 4174, strictPort: true },
});
