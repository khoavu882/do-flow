// Renders the ```mermaid fences on the published site. mkdocs.yml turns each fence into
// <div class="mermaid">source</div> (pymdownx.superfences fence_div_format). Only a page that holds
// a diagram loads the library: the pinned build below, from jsDelivr, with a Subresource Integrity
// hash. When bumping the version, recompute the hash from the bytes jsDelivr serves for it:
//   curl -sSfL <the URL below> | openssl dgst -sha384 -binary | openssl base64 -A
// The dracula theme is dark, hence the dark Mermaid theme.
(function () {
  var MERMAID_URL = 'https://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/mermaid.min.js';
  var MERMAID_SRI = 'sha384-EOXBFmc3gx5mb+vn0vPvvGqACToJD24hhacX5Yx+8NUUQrHIle/Qi5Bg9o3zKwW2';
  if (!document.querySelector('.mermaid')) { return; }
  var script = document.createElement('script');
  script.src = MERMAID_URL;
  script.integrity = MERMAID_SRI;
  script.crossOrigin = 'anonymous';
  script.onload = function () {
    mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' });
    mermaid.run({ querySelector: '.mermaid' });
  };
  document.head.appendChild(script);
})();
