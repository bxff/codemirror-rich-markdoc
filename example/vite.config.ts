import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
    resolve: {
        alias: {
            '@codemirror/state': path.resolve(__dirname, 'node_modules/@codemirror/state'),
            '@codemirror/view': path.resolve(__dirname, 'node_modules/@codemirror/view'),
            '@codemirror/language': path.resolve(__dirname, 'node_modules/@codemirror/language'),
            '@codemirror/commands': path.resolve(__dirname, 'node_modules/@codemirror/commands'),
            '@lezer/common': path.resolve(__dirname, '../node_modules/@lezer/common'),
            '@lezer/lr': path.resolve(__dirname, '../node_modules/@lezer/lr'),
            '@lezer/markdown': path.resolve(__dirname, 'node_modules/@lezer/markdown'),
            '@lezer/highlight': path.resolve(__dirname, '../node_modules/@lezer/highlight'),
        },
    },

    server: {
        port: 8000,
    },
    optimizeDeps: {
        exclude: ['@lezer/markdown'],
    },
});
