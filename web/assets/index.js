import { loadSettings } from './client.js';

const address = document.getElementById('connector-url');
loadSettings()
  .then(({ connectorUrl }) => {
    address.textContent = connectorUrl;
  })
  .catch(() => {
    address.textContent = `${window.location.origin}/mcp`;
  });
