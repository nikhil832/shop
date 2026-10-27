import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Keeps function names (React components) in the minified build, so crash reports from browsers (stage 52) say
  // "at QuestionCard" rather than "at Xe".
  esbuild: { keepNames: true },
  server: {
    proxy: { '/api': 'http://localhost:4000' },
  },
});
