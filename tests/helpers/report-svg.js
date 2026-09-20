export const reportSvg = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="80" height="24" viewBox="0 0 80 24">
  <title>Synthetic vector logo</title>
  <defs><linearGradient id="ink"><stop offset="0" stop-color="#005577"/><stop offset="1" stop-color="#003344"/></linearGradient>
    <rect id="shape" width="80" height="24" rx="2" fill="url(#ink)"/>
  </defs>
  <style>.outline { stroke: #002233; stroke-width: 1; }</style>
  <use xlink:href="#shape" class="outline"/>
</svg>`);
