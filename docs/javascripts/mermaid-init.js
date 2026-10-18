// Renders the ```mermaid fences on the published site. mkdocs.yml turns each fence into
// <div class="mermaid">source</div> (pymdownx.superfences fence_div_format) and loads the pinned
// mermaid build from jsDelivr just before this file; both scripts are deferred, so the DOM is parsed
// by the time this runs. The dracula theme is dark, hence the dark Mermaid theme.
(function () {
  if (typeof mermaid === 'undefined') { return; }
  mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' });
  mermaid.run({ querySelector: '.mermaid' });
})();
