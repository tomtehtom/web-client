import { defineConfig }  from 'vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import pathBrowserify    from 'path-browserify'
import { resolve }       from 'path'

export default defineConfig({
  build: { target: 'es2020',
        rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        voxelRenderBenchmark: resolve(__dirname, 'scripts/voxel-render-benchmark.html'),
     }
    }
   },

  plugins: [ nodePolyfills() ],

  resolve: { alias: { path: pathBrowserify } },

  define: {                //  ←   ONLY literals here
    global: 'globalThis',
    '__dirname': '"./"', //  optional – can omit
  },

  optimizeDeps: {
    esbuildOptions: { target: 'es2020' }
  },

server: {
  allowedHosts: true,
  proxy: {
    '/earth-tiles': {
      target: 'https://edu.voxelearth.org',
      changeOrigin: true,
      rewrite: path => path.replace(/^\/earth-tiles/, ''),
    },
  },
}
})
