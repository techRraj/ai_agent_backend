// build.js
import { build } from 'esbuild';
import { nodeExternalsPlugin } from 'esbuild-node-externals';

build({
  entryPoints: ['server.js'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'dist/server.js',
  plugins: [nodeExternalsPlugin({ 
    externals: [
      'express', 'cors', 'dotenv', 'openai', 'googleapis', 'zod', 'node-fetch'
    ] 
  })],
  minify: false,
  sourcemap: true,
  define: { 'process.env.NODE_ENV': '"production"' }
})
.catch(() => process.exit(1));