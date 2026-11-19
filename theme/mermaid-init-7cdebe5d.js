// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

(() => {
    'use strict';

    // mdBook swaps a theme class on <html>. These are the dark variants; mdBook
    // >= 0.5 also supports an "Auto" theme (class is still a concrete theme) and
    // follows prefers-color-scheme at runtime.
    const DARK_THEMES = ['ayu', 'navy', 'coal'];
    const LIGHT_THEMES = ['light', 'rust'];
    const root = document.documentElement;

    // Diagrams are rendered client-side by mermaid. To follow mdBook's theme we
    // (1) remember the original source of every diagram, (2) render with the
    // matching mermaid theme, and (3) re-render in place when the html class
    // changes (theme menu / "Auto" / OS preference change).
    const diagrams = [];
    let currentIsDark = null;

    function isDarkTheme() {
        const classes = root.classList;
        for (const theme of DARK_THEMES) {
            if (classes.contains(theme)) return true;
        }
        for (const theme of LIGHT_THEMES) {
            if (classes.contains(theme)) return false;
        }
        try {
            const saved = localStorage.getItem('mdbook-theme');
            if (saved && DARK_THEMES.includes(saved)) return true;
            if (saved && LIGHT_THEMES.includes(saved)) return false;
        } catch (e) {
            // localStorage may be unavailable (privacy mode); fall through.
        }
        return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }

    function collectDiagrams() {
        document.querySelectorAll('pre.mermaid').forEach((el) => {
            // Keep the encoded source (innerHTML), which is exactly what mermaid
            // decodes and renders. textContent would lose entity encoding.
            diagrams.push({ el, source: el.innerHTML });
        });
    }

    async function render(isDark) {
        // The bundle is loaded before this script (see book.toml additional-js),
        // so mermaid is defined here. startOnLoad is disabled because we control
        // when rendering happens (also on later theme changes).
        mermaid.initialize({
            startOnLoad: false,
            theme: isDark ? 'dark' : 'default',
        });

        for (const { el, source } of diagrams) {
            el.removeAttribute('data-processed');
            el.innerHTML = source;
        }

        if (diagrams.length > 0) {
            await mermaid.run({ nodes: diagrams.map(({ el }) => el) });
        }
    }

    async function renderForCurrentTheme() {
        const isDark = isDarkTheme();
        if (currentIsDark === isDark) return;
        currentIsDark = isDark;
        try {
            await render(isDark);
        } catch (e) {
            console.error('mermaid: failed to render diagrams', e);
        }
    }

    function start() {
        collectDiagrams();
        renderForCurrentTheme();

        // mdBook updates the theme by changing the class on <html> (both the
        // theme menu and the matchMedia handler for the "Auto" theme do this).
        new MutationObserver(() => {
            renderForCurrentTheme();
        }).observe(root, { attributes: true, attributeFilter: ['class'] });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
})();
